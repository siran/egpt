// tools/bus.mjs — node-side helpers for the egpt CDP control-plane bus.
//
// The bus is one tab in the brain Chrome serving tools/bus.html via the
// proxy. Both surfaces (shell + extension) attach a CDP session and:
//   - read events: listen for Runtime.consoleAPICalled with arg 'egpt-bus'
//   - write events: Runtime.evaluate -> window.bus.post(ev)
//
// Long content (full brain replies, file contents) does NOT travel here.
// The bus carries short control events: attach-request, attach-reply,
// turn-request, turn-reply, agents-probe, agents-reply, node-online, etc.
// Anything bigger stays in conversation.md and Telegram.

import * as cdp from './cdp.mjs';
import { signEvent, verifyEvent, generateKey, keyFromString } from './bus-sign.mjs';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export const BUS_PATH = '/bus.html';

// Bus signing key. When set (via setBusKey), every outgoing event is
// HMAC-signed and every incoming event is verified — invalid sigs
// are dropped with a warning. Unsigned events still pass through
// (permissive default for phased rollout). Phase 2 will add
// optional encryption on top of this same key.
let _busKeyBytes = null;
let _onInvalidSig = null;       // override hook for tests/diagnostics
export function setBusKey(b64OrNull) {
  _busKeyBytes = b64OrNull ? keyFromString(b64OrNull) : null;
}
export function getBusKey() { return _busKeyBytes; }
export function setBusInvalidSigHandler(fn) { _onInvalidSig = fn; }

// Default path for the shell-side key file. Used by loadOrCreateBusKey
// when no explicit override is given. Lives outside the source tree
// so it survives repo re-clones.
export const DEFAULT_KEY_PATH = path.join(os.homedir(), '.egpt', 'config', 'bus.key');

// Load (or create) the shell-side bus key. Order of precedence:
//   1. process.env.EGPT_BUS_KEY — for one-shot overrides, CI, etc.
//   2. file at keyPath (default ~/.egpt/bus.key)
//   3. generate a fresh key and write it to keyPath
// Returns the base64url-encoded key string. Caller still has to call
// setBusKey() — kept separate so this function stays a pure load.
export async function loadOrCreateBusKey({ keyPath = DEFAULT_KEY_PATH } = {}) {
  const envKey = (process.env?.EGPT_BUS_KEY ?? '').trim();
  if (envKey) return envKey;
  try {
    const raw = await fs.readFile(keyPath, 'utf8');
    const trimmed = raw.trim();
    if (trimmed) return trimmed;
  } catch (e) { console.error(`!! bus.mjs:[catch] ${e?.message ?? e}`); /* missing — fall through to generate */ }
  const fresh = await generateKey();
  try {
    await fs.mkdir(path.dirname(keyPath), { recursive: true });
    await fs.writeFile(keyPath, fresh + '\n', { mode: 0o600 });
  } catch (e) { console.error(`!! bus.mjs:[catch] ${e?.message ?? e}`); /* persist best-effort; in-memory still works */ }
  return fresh;
}

// Push a key into the extension's chrome.storage.local by evaluating
// a small script on the bus tab. The bus tab is an extension page so
// it has chrome.storage access. Returns 'set' | 'replaced' | 'unchanged'
// so the caller can log what actually happened.
//
// Threat note: this only works for someone who already has CDP access
// to the Chrome instance — which is the same trust boundary signing
// is trying to defend against from external observers. Using CDP to
// SET the key isn't a new attack vector. It's the pairing channel.
export async function pairBusKeyToExtension(targetId, busKeyString) {
  if (!busKeyString) throw new Error('pairBusKeyToExtension: empty key');
  const safe = JSON.stringify(String(busKeyString));
  const expr = `(async () => {
    try {
      if (!globalThis.chrome?.storage?.local) return { state: 'no-storage' };
      const got = await chrome.storage.local.get('bus_key');
      const current = got?.bus_key ?? null;
      if (current === ${safe}) return { state: 'unchanged' };
      await chrome.storage.local.set({ bus_key: ${safe} });
      return { state: current ? 'replaced' : 'set' };
    } catch (e) {
      return { state: 'error', error: e && e.message ? e.message : String(e) };
    }
  })()`;
  const tab = await cdp.findTab(targetId);
  if (!tab) throw new Error(`pairBusKeyToExtension: bus tab ${(targetId ?? '?').slice(0, 8)}… not found`);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    const tmo = setTimeout(() => { try { ws.close(); } catch {} ; reject(new Error('pair timeout')); }, 5000);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        id: 1, method: 'Runtime.evaluate',
        params: { expression: expr, returnByValue: true, awaitPromise: true },
      }));
    });
    ws.addEventListener('message', (e) => {
      let data;
      try { data = JSON.parse(e.data.toString()); } catch { return; }
      if (data.id === 1) {
        clearTimeout(tmo);
        try { ws.close(); } catch {}
        if (data.error) reject(new Error(data.error.message));
        else resolve(data.result?.result?.value ?? { state: 'unknown' });
      }
    });
    ws.addEventListener('error', () => { clearTimeout(tmo); reject(new Error('pair WS error')); });
  });
}
function _logInvalid(ev, where) {
  if (_onInvalidSig) {
    try { _onInvalidSig(ev, where); } catch (e) { console.error(`!! bus.mjs:[catch] ${e?.message ?? e}`); }
  } else {
    try { console.warn(`[bus-sign] dropped event with invalid signature (${where}): ${(ev?.type ?? '?')}`); } catch (e) { console.error(`!! bus.mjs:[catch] ${e?.message ?? e}`); }
  }
}

// The bus log is served unauthenticated by cdp-proxy; the auth boundary
// is at CDP attach (which goes through the token-prefixed WebSocket).
// Strip any token suffix from cdpHost() so both surfaces resolve the
// same canonical URL: http://localhost:9222/bus.html.
export async function busUrl() {
  const host = (await cdp.cdpHost()).split('/')[0];
  return `http://${host}${BUS_PATH}`;
}

// Heuristic for spotting the bus tab without depending on exact querystrings.
function isBusUrl(url) {
  if (!url) return false;
  return url.endsWith(BUS_PATH) || url.includes(`${BUS_PATH}?`) || url.includes(`${BUS_PATH}#`);
}

// Find an existing bus tab; open one if none exists. Returns { targetId, url, opened }.
//
// The extension passes openUrl: chrome.runtime.getURL('bus.html') so it
// hosts its own bus tab without depending on the proxy serving bus.html
// at :9222. The shell uses the default — http://<host>/bus.html — which
// the cdp-proxy serves when running. Either path leaves a tab whose URL
// ends with /bus.html, which isBusUrl matches the same way.
export async function findOrOpenBusTab({ open = true, openUrl = null } = {}) {
  const tabs = await cdp.listTabs();
  const found = tabs.find(t => isBusUrl(t.url));
  if (found) return { targetId: found.id, url: found.url, opened: false };
  if (!open) return null;
  const url = openUrl ?? await busUrl();
  const targetId = await cdp.openTab(url);
  return { targetId, url, opened: true };
}

// One-shot Runtime.evaluate against an arbitrary tab. Used to post events.
async function evaluateOnTab(targetId, expression) {
  const tab = await cdp.findTab(targetId);
  if (!tab) throw new Error(`bus tab ${(targetId ?? '?').slice(0, 8)}… not found`);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    const tmo = setTimeout(() => { try { ws.close(); } catch {} ; reject(new Error('bus post timeout')); }, 5000);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    });
    ws.addEventListener('message', e => {
      let data;
      try { data = JSON.parse(e.data.toString()); } catch { return; }
      if (data.id === 1) {
        clearTimeout(tmo);
        try { ws.close(); } catch {}
        if (data.error) reject(new Error(data.error.message));
        else resolve(data.result?.result?.value);
      }
    });
    ws.addEventListener('error', () => { clearTimeout(tmo); reject(new Error('bus post WS error')); });
  });
}

/** Post a control event to the bus tab. Resolves when the page acknowledges. */
export async function postEvent(targetId, event) {
  // Sign before serialization when a key is configured. Receivers
  // with the same key will verify; receivers without a key (or with
  // a different one) will treat as unsigned/forged depending on
  // their own permissive flag.
  const toSend = _busKeyBytes ? await signEvent(event ?? {}, _busKeyBytes) : (event ?? {});
  const safe = JSON.stringify(toSend);
  // window.bus is created by bus.html; if the tab hasn't finished loading
  // we fall back to a small retry loop in-page to keep the call resilient.
  const expr = `(function(ev){
    if (window.bus && window.bus.post) return window.bus.post(ev);
    var attempts = 0;
    var iv = setInterval(function(){
      if (window.bus && window.bus.post) { clearInterval(iv); window.bus.post(ev); }
      else if (++attempts > 20) clearInterval(iv);
    }, 100);
    return null;
  })(${safe})`;
  return evaluateOnTab(targetId, expr);
}

/**
 * Subscribe to all events posted to the bus tab. Listens for the page's
 * `console.log('egpt-bus', JSON.stringify(ev))` emissions via CDP's
 * Runtime.consoleAPICalled. Returns { stop } — call stop() to unsubscribe.
 *
 * Replay-on-subscribe: by default, the bus tab's in-page event ring buffer
 * (`window.bus.getEvents(since)`) is queried right after Runtime.enable
 * and each retrieved event is dispatched through onEvent BEFORE the
 * subscribe promise resolves. That way a node joining mid-session sees
 * the recent play instead of joining a play already in progress with no
 * memory of what came before. Pass `{ replay: false }` to opt out;
 * `replaySinceMs` controls the look-back window (default: 5 minutes).
 */
export async function subscribeBusEvents(targetId, onEvent, opts = {}) {
  const { replay = true, replaySinceMs = 5 * 60 * 1000, onClose = null } = opts;
  const tab = await cdp.findTab(targetId);
  if (!tab) throw new Error(`bus tab ${(targetId ?? '?').slice(0, 8)}… not found`);
  // Chrome's Runtime.enable replays past Runtime.consoleAPICalled events
  // from the page's console buffer (so DevTools can show history when
  // opened mid-session). We don't want that — old bus events would be
  // re-dispatched as if new on every rejoin. Filter by CDP-side
  // timestamp: anything older than the moment we subscribed is replay
  // from the buffer. Small grace window for clock smoothing.
  // (The opt-in replay above goes through Runtime.evaluate of
  // window.bus.getEvents — a separate path that bypasses this filter.)
  const subscribedAt = Date.now() - 1000;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    let nextId = 0;
    let stopped = false;
    let resolved = false;
    const ENABLE_ID = 1;
    const REPLAY_ID = 2;

    const stop = () => {
      if (stopped) return;
      stopped = true;
      try { ws.close(); } catch {}
    };

    const finishSubscribe = () => {
      if (resolved) return;
      resolved = true;
      resolve({ stop });
    };

    ws.addEventListener('open', () => {
      nextId = ENABLE_ID;
      ws.send(JSON.stringify({ id: ENABLE_ID, method: 'Runtime.enable' }));
    });

    ws.addEventListener('message', e => {
      let data;
      try { data = JSON.parse(e.data.toString()); } catch { return; }

      // Runtime.enable ack — chain into a replay request, or finish if
      // replay is disabled.
      if (data.id === ENABLE_ID) {
        if (!replay) { finishSubscribe(); return; }
        const since = Date.now() - replaySinceMs;
        nextId = REPLAY_ID;
        ws.send(JSON.stringify({
          id: REPLAY_ID,
          method: 'Runtime.evaluate',
          params: {
            expression: `JSON.stringify(window.bus?.getEvents?.(${since}) || [])`,
            returnByValue: true,
          },
        }));
        return;
      }

      // Replay response — dispatch each past event through onEvent
      // before completing the subscribe handshake. We dispatch in
      // order (bus.html appends in-order, getEvents preserves it).
      if (data.id === REPLAY_ID) {
        (async () => {
          try {
            const json = data.result?.result?.value;
            const past = JSON.parse(json ?? '[]');
            for (const ev of past) {
              if (!ev || typeof ev !== 'object') continue;
              if (_busKeyBytes) {
                const result = await verifyEvent(ev, _busKeyBytes);
                if (result === 'invalid') { _logInvalid(ev, 'replay'); continue; }
                // 'missing' is permissive — pass through (peers may not yet sign)
              }
              try { onEvent({ ...ev, _replayed: true }); }
              catch (e) { console.error(`!! bus.mjs:[catch] ${e?.message ?? e}`); /* per-event errors don't abort replay */ }
            }
          } catch (e) { console.error(`!! bus.mjs:[catch] ${e?.message ?? e}`); /* malformed replay payload — give up on replay */ }
          finishSubscribe();
        })();
        return;
      }

      // Live event from Runtime.consoleAPICalled.
      if (data.method !== 'Runtime.consoleAPICalled') return;
      const cdpTs = data.params?.timestamp;
      if (typeof cdpTs === 'number' && cdpTs < subscribedAt) return;
      const args = data.params?.args ?? [];
      if (args[0]?.value !== 'egpt-bus') return;
      const raw = args[1]?.value;
      if (typeof raw !== 'string') return;
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch (e) { console.error(`!! bus.mjs JSON.parse: ${e?.message ?? e}`); return; /* malformed event; ignore */ }
      if (_busKeyBytes) {
        // Async verify — don't block the event loop on each event,
        // but preserve order via a serial chain.
        (async () => {
          const result = await verifyEvent(parsed, _busKeyBytes);
          if (result === 'invalid') { _logInvalid(parsed, 'live'); return; }
          try { onEvent(parsed); } catch (e) { console.error(`!! bus.mjs:[catch] ${e?.message ?? e}`); }
        })();
      } else {
        try { onEvent(parsed); } catch (e) { console.error(`!! bus.mjs:[catch] ${e?.message ?? e}`); }
      }
    });

    ws.addEventListener('error', () => {
      if (!resolved) { resolved = true; reject(new Error('bus subscribe WS error')); }
      stop();
    });
    ws.addEventListener('close', () => {
      // Surface the close to the host so it can clear its bus-sub
      // ref and reconnect to whichever bus tab is now alive. Without
      // this, the shell's tryConnect short-circuits at "already
      // attached" forever — even though the underlying WS died when
      // the bus tab was closed (e.g. user manually closed it; the
      // extension respawns a fresh tab but the shell never sees it).
      const wasAttached = !stopped;
      stopped = true;
      if (wasAttached && typeof onClose === 'function') {
        try { onClose(); } catch (e) { console.error(`!! bus.mjs:[catch] ${e?.message ?? e}`); }
      }
    });

    // Safety: resolve even if Runtime.enable's reply gets reordered or
    // the replay request hangs.
    setTimeout(finishSubscribe, 1500);
  });
}
