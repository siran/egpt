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

export const BUS_PATH = '/bus.html';

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
export function postEvent(targetId, event) {
  const safe = JSON.stringify(event ?? {});
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
        try {
          const json = data.result?.result?.value;
          const past = JSON.parse(json ?? '[]');
          for (const ev of past) {
            if (!ev || typeof ev !== 'object') continue;
            try { onEvent({ ...ev, _replayed: true }); }
            catch (_) { /* per-event errors don't abort replay */ }
          }
        } catch (_) { /* malformed replay payload — give up on replay */ }
        finishSubscribe();
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
      try { onEvent(JSON.parse(raw)); }
      catch (_) { /* malformed event; ignore */ }
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
        try { onClose(); } catch (_) {}
      }
    });

    // Safety: resolve even if Runtime.enable's reply gets reordered or
    // the replay request hangs.
    setTimeout(finishSubscribe, 1500);
  });
}
