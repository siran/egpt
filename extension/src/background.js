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

// Ensure the bus tab exists. The extension hosts bus.html (bundled);
// shell looks it up via /json/list and attaches. If shell starts
// before the extension UI is ever clicked, the bus tab wouldn't
// exist yet and shell would have nothing to find. Open it eagerly
// on every plausible service-worker wake (install, browser startup,
// SW spawn).
async function ensureBusTab() {
  const url = chrome.runtime.getURL(BUS_URL);
  const existing = await chrome.tabs.query({ url });
  if (existing.length === 0) {
    try { await chrome.tabs.create({ url, active: false }); } catch (_) {}
  }
}
chrome.runtime.onInstalled.addListener(ensureBusTab);
chrome.runtime.onStartup.addListener(ensureBusTab);
// Re-spawn the bus tab if the user closes it (or if Chrome killed it
// for memory). Without this, closing the bus tab takes the extension
// off the bus until the next reload — and shell can't find a tab
// to attach to either.
chrome.tabs.onRemoved.addListener(async (closedTabId) => {
  // Only re-create if our bus tab was the one closed. The query
  // happens AFTER the tab is gone — if no bus tab matches, we know
  // the closed one was ours and we need a replacement.
  const url = chrome.runtime.getURL(BUS_URL);
  const remaining = await chrome.tabs.query({ url });
  if (remaining.length === 0) ensureBusTab();
});
ensureBusTab();

// ── Bus relay ────────────────────────────────────────────────────

const _busTabPorts  = new Set();   // ports opened by bus.html
const _subscribers  = new Set();   // ports opened by UI tabs

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
});
