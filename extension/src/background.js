// extension/src/background.js — service worker.
//
// Two roles:
//   1. Open the egpt UI tab when the toolbar action is clicked.
//   2. Bus relay between the bundled bus.html tab and the UI tab(s).
//      Bus.html (loaded as chrome-extension://<id>/bus.html) connects
//      via chrome.runtime.connect({name:'egpt-bus'}); UI tabs connect
//      via name:'egpt-bus-subscriber'. We forward 'event' and 'replay'
//      messages from the bus tab to all subscribers, and 'post' /
//      'replay-request' messages from subscribers to the bus tab.
//      No chrome.debugger involved — extension and shell coexist on
//      the same bus tab without competing for a debugger session.

const TAB_URL = 'tab/index.html';
const BUS_URL = 'bus.html';

chrome.action.onClicked.addListener(async () => {
  const tabUrl = chrome.runtime.getURL(TAB_URL);
  const existing = await chrome.tabs.query({ url: tabUrl });
  if (existing.length > 0) {
    chrome.tabs.update(existing[0].id, { active: true });
    chrome.windows.update(existing[0].windowId, { focused: true });
  } else {
    chrome.tabs.create({ url: tabUrl });
  }
});

// Shared serialization for ALL extension-page tab manipulation
// (bus tab, egpt tab, refreshExtensionPages). Without this, the SW
// spawn fires the bottom-of-file ensureBusTab() AT THE SAME TIME
// chrome.runtime.onInstalled fires refreshExtensionPages — both see
// zero buses (extension pages are in a torn-down state momentarily
// after a reload), both create one, and the user ends up with two
// bus tabs. Same race took out the egpt tab when refreshExtensionPages
// queried tabs before the old egpt page was visible. Single-thread
// it. Each function under this lock observes a stable view and acts
// idempotently.
let _tabLock = Promise.resolve();
function withTabLock(fn) {
  const p = _tabLock.catch(() => {}).then(fn);
  _tabLock = p.catch(() => {});
  return p;
}

// Ensure the bus tab exists, exactly one. Collapses any duplicates.
async function ensureBusTab() {
  return withTabLock(async () => {
    const url = chrome.runtime.getURL(BUS_URL);
    const existing = await chrome.tabs.query({ url });
    if (existing.length === 0) {
      try { await chrome.tabs.create({ url, active: false }); } catch (_) {}
      return;
    }
    for (let i = 1; i < existing.length; i++) {
      try { await chrome.tabs.remove(existing[i].id); } catch (_) {}
    }
  });
}

// Self-healing extension reload. When the user reloads the extension
// at chrome://extensions (or it auto-updates), the existing bus.html
// and egpt UI tabs are still running OLD background-context-bound
// JS; ports are dead, content scripts in WA Web etc. have stale
// chrome.runtime references. Close + respawn our own pages, and
// reload any open content-script-target tabs so they reinject fresh.
const CONTENT_SCRIPT_HOSTS = [
  // /web\.telegram\.org/,   // future: when TG-CDP content script ships
];
async function refreshExtensionPages() {
  return withTabLock(async () => {
    const tabUrl = chrome.runtime.getURL(TAB_URL);
    const busUrl = chrome.runtime.getURL(BUS_URL);
    let allTabs;
    try { allTabs = await chrome.tabs.query({}); }
    catch { return; }

    // url.startsWith catches transient post-reload states where the
    // extension's own pages are still showing the chrome-extension://
    // URL but with a hash or query suffix. Strict equality used to
    // miss them, leaving hadEgpt=false on a reload where the egpt
    // tab WAS open — so refresh dropped the egpt tab.
    const matchUrl = (t, url) => typeof t.url === 'string' && t.url.split('#')[0].split('?')[0] === url;
    const egptTabs = allTabs.filter(t => matchUrl(t, tabUrl));
    const busTabs  = allTabs.filter(t => matchUrl(t, busUrl));
    const csTabs   = allTabs.filter(t => CONTENT_SCRIPT_HOSTS.some(re => re.test(t.url ?? '')));

    // Open the new bus tab BEFORE closing old ones. The chrome.tabs.onRemoved
    // listener fires when we remove the old bus and queries for remaining
    // bus tabs; without a live one already present it auto-spawns ANOTHER.
    let freshBus = null;
    try { freshBus = await chrome.tabs.create({ url: busUrl, active: false }); } catch (_) {}
    for (const t of busTabs) {
      if (freshBus && t.id === freshBus.id) continue;
      try { await chrome.tabs.remove(t.id); } catch (_) {}
    }

    // Always reopen egpt — drop the previous hadEgpt guard. After a
    // reload the user expects the egpt tab to come back; the guard
    // skipped the reopen whenever the post-reload tab query missed
    // the prior egpt tab (URL hash, torn-down state, etc.).
    let freshEgpt = null;
    try { freshEgpt = await chrome.tabs.create({ url: tabUrl, active: false }); } catch (_) {}
    for (const t of egptTabs) {
      if (freshEgpt && t.id === freshEgpt.id) continue;
      try { await chrome.tabs.remove(t.id); } catch (_) {}
    }

    // Refresh any content-script tabs so the fresh script binds to
    // the fresh background.
    for (const t of csTabs) {
      try { await chrome.tabs.reload(t.id); } catch (_) {}
    }

    // End-of-run reconcile: another path may have spawned a duplicate
    // while we were creating ours (the lock prevents this in the
    // current code, but defense-in-depth — keep exactly one of each).
    const finalBuses = await chrome.tabs.query({ url: busUrl });
    for (let i = 1; i < finalBuses.length; i++) {
      try { await chrome.tabs.remove(finalBuses[i].id); } catch (_) {}
    }
    const finalEgpts = await chrome.tabs.query({ url: tabUrl });
    for (let i = 1; i < finalEgpts.length; i++) {
      try { await chrome.tabs.remove(finalEgpts[i].id); } catch (_) {}
    }
  });
}

chrome.runtime.onInstalled.addListener(refreshExtensionPages);
chrome.runtime.onStartup.addListener(refreshExtensionPages);
// Re-spawn the bus tab if the user closes it manually mid-session.
chrome.tabs.onRemoved.addListener(async () => {
  const url = chrome.runtime.getURL(BUS_URL);
  const remaining = await chrome.tabs.query({ url });
  if (remaining.length === 0) ensureBusTab();
});
// SW cold-spawn safety net (e.g. browser already running, extension
// loaded, SW fires for the first time): make sure the bus exists.
ensureBusTab();

// ── Bus relay ────────────────────────────────────────────────────

const _busTabPorts      = new Set();   // ports opened by bus.html
const _subscribers      = new Set();   // ports opened by UI tabs

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'egpt-bus') {
    _busTabPorts.add(port);
    port.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === 'event') {
        for (const s of _subscribers) {
          try { s.postMessage({ type: 'event', ev: msg.ev }); } catch (_) {}
        }
      } else if (msg.type === 'replay') {
        // Forward the replay-response to whichever subscriber asked
        // most recently. We don't track per-subscriber requests; in
        // practice the burst of replay events is harmless if every
        // subscriber receives a copy (each item arrives with
        // _replayed: true and consumers dedupe by ts/from anyway).
        for (const s of _subscribers) {
          try { s.postMessage({ type: 'replay', past: msg.past }); } catch (_) {}
        }
      }
    });
    port.onDisconnect.addListener(() => _busTabPorts.delete(port));
    return;
  }

  if (port.name === 'egpt-bus-subscriber') {
    _subscribers.add(port);
    port.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === 'post') {
        for (const bp of _busTabPorts) {
          try { bp.postMessage({ type: 'post', ev: msg.ev }); } catch (_) {}
        }
      } else if (msg.type === 'replay-request') {
        // Pick any bus tab port (typically there's one) and ask.
        const [bp] = _busTabPorts;
        if (bp) {
          try { bp.postMessage({ type: 'replay-request', since: msg.since }); }
          catch (_) {}
        }
      }
    });
    port.onDisconnect.addListener(() => _subscribers.delete(port));
    return;
  }

  // ── Brain dispatch (runs in SW so it isn't tab-throttled) ──────
  // Egpt UI tab opens this port per brain call; we run the actual
  // chrome.debugger attach + inject + poll loop here in the service
  // worker. Polling at 250ms holds at full rate regardless of which
  // tab the user is currently looking at.
  if (port.name === 'egpt-brain') {
    let _aborted = false;
    port.onMessage.addListener(async (msg) => {
      if (!msg || _aborted) return;
      if (msg.type === 'run') {
        try {
          const text = await runBrainStreamInSw(
            { targetId: msg.targetId, injectScript: msg.injectScript, pollScript: msg.pollScript, timeoutMs: msg.timeoutMs },
            (partial) => { if (!_aborted) try { port.postMessage({ type: 'update', text: partial }); } catch (_) {} },
          );
          if (!_aborted) try { port.postMessage({ type: 'done', text }); } catch (_) {}
        } catch (e) {
          if (!_aborted) try { port.postMessage({ type: 'error', error: e?.message ?? String(e) }); } catch (_) {}
        }
      } else if (msg.type === 'peek') {
        try {
          const text = await runBrainPeekInSw(msg.targetId, msg.pollScript);
          if (!_aborted) try { port.postMessage({ type: 'peek-result', text }); } catch (_) {}
        } catch (e) {
          if (!_aborted) try { port.postMessage({ type: 'error', error: e?.message ?? String(e) }); } catch (_) {}
        }
      }
    });
    port.onDisconnect.addListener(() => { _aborted = true; });
    return;
  }
});

// ── Brain stream/peek runners (service-worker side) ───────────────
//
// chrome.debugger.attach is exclusive per target — two concurrent
// runs collide ('Another debugger is already attached'). Queue per
// targetId so back-to-back '@e' messages run sequentially. (Same
// queue idea was previously in cdp-debugger.js when this code lived
// in the egpt UI tab; kept here verbatim now that the impl moved.)
const _brainQueues = new Map();
function _enqueueBrain(targetId, fn) {
  const prior = _brainQueues.get(targetId) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(fn);
  const tail = next.catch(() => {});
  _brainQueues.set(targetId, tail);
  tail.finally(() => {
    if (_brainQueues.get(targetId) === tail) _brainQueues.delete(targetId);
  });
  return next;
}

async function runBrainPeekInSw(targetId, pollScript) {
  return _enqueueBrain(targetId, async () => {
    const target = { targetId };
    let attached = false;
    try {
      await chrome.debugger.attach(target, '1.3');
      attached = true;
      const r = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
        expression: pollScript, returnByValue: true,
      });
      if (r?.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval threw');
      return r?.result?.value?.text ?? '';
    } finally {
      if (attached) { try { await chrome.debugger.detach(target); } catch (_) {} }
    }
  });
}

function runBrainStreamInSw({ targetId, injectScript, pollScript, timeoutMs = 180_000 }, onUpdate) {
  return _enqueueBrain(targetId, () => new Promise(async (resolve, reject) => {
    const target = { targetId };
    let attached = false;
    let pollHandle = null;
    let timeoutHandle = null;
    let settled = false;
    const cleanup = async () => {
      if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
      if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
      if (attached) { try { await chrome.debugger.detach(target); } catch (_) {} attached = false; }
    };
    const fail = async (err) => { if (settled) return; settled = true; await cleanup(); reject(err); };
    const done = async (text) => { if (settled) return; settled = true; await cleanup(); resolve(text); };
    const evalOnce = async (expression) => {
      const r = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', { expression, returnByValue: true });
      if (r?.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval threw');
      return r?.result?.value;
    };
    try {
      await chrome.debugger.attach(target, '1.3');
      attached = true;
      try { await chrome.debugger.sendCommand(target, 'Page.bringToFront'); } catch (_) {}

      const initial = await evalOnce(pollScript);
      const initialId = initial?.id ?? null;
      // Retry inject — when @e auto-opens a fresh chatgpt thread,
      // the page can take a second or two for React to mount the
      // composer (#prompt-textarea). The inject script returns false
      // if the textarea isn't there yet. Retry up to ~6s before
      // giving up.
      let sent = false;
      const INJECT_RETRIES = 12;
      const INJECT_RETRY_MS = 500;
      for (let i = 0; i < INJECT_RETRIES; i++) {
        try {
          sent = await evalOnce(injectScript);
          if (sent) break;
        } catch (_) {}
        await new Promise(r => setTimeout(r, INJECT_RETRY_MS));
      }
      if (!sent) return fail(new Error(`Inject script returned falsy after ${INJECT_RETRIES} retries — page may not be ready (selectors not yet rendered).`));

      let lastText = '';
      let textStable = 0;
      let noStreamingCount = 0;
      let sawNew = false;
      let pollErrs = 0;
      const pollStartMs = Date.now();
      const STABLE_TICKS = 4;
      const TEXT_STALE_FALLBACK_TICKS = 20;
      const MIN_POLL_MS = 10_000;

      pollHandle = setInterval(async () => {
        try {
          const v = await evalOnce(pollScript);
          pollErrs = 0;
          if (!v) return;
          if (!sawNew) {
            if (v.id && v.id !== initialId) sawNew = true;
            else return;
          }
          if (v.text !== lastText) {
            lastText = v.text;
            try { onUpdate?.(lastText); } catch (_) {}
            textStable = 0;
          } else if (lastText) {
            textStable++;
          }
          if (!v.streaming) noStreamingCount++; else noStreamingCount = 0;
          if (noStreamingCount >= STABLE_TICKS && textStable >= STABLE_TICKS && lastText) {
            await done(lastText);
            return;
          }
          if (textStable >= TEXT_STALE_FALLBACK_TICKS && lastText &&
              (Date.now() - pollStartMs) >= MIN_POLL_MS) {
            await done(lastText);
          }
        } catch (_) {
          pollErrs++;
          if (pollErrs > 5) await fail(new Error('Repeated poll failures'));
        }
      }, 250);

      timeoutHandle = setTimeout(async () => {
        if (lastText) await done(lastText);
        else await fail(new Error(`Timed out waiting for response (${timeoutMs}ms)`));
      }, timeoutMs);
    } catch (e) {
      await fail(e);
    }
  }));
}

