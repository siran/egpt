// extension/src/tools/bus-ext.js — drop-in for tools/bus.mjs in the
// extension context. Same exported API as the node module, but uses
// chrome.runtime ports instead of chrome.debugger / raw WebSocket
// for bus event delivery.
//
// Why chrome.runtime ports:
// * No chrome.debugger session means no 'egpt started debugging'
//   banner and no 'Another debugger is already attached' reload
//   conflict.
// * No raw WS attach means no concurrency restriction on
//   chrome-extension://<id>/bus.html (Chrome would reject
//   extension's own WS attach to its own pages, and 'one debugger'
//   semantics apply to debugger sessions only — chrome.runtime
//   ports are an entirely different mechanism).
// * The shell still uses raw WS via the proxy on the SAME bus tab;
//   the two transports coexist freely because Chrome treats them
//   as unrelated. So the extension can self-host its bus.html and
//   the shell, when it later starts, joins as a peer through the
//   proxy without conflict.
//
// The bus tab (bundled at extension/dist/bus.html, served as
// chrome-extension://<id>/bus.html) carries the chrome.runtime
// hook that opens the long-lived port to the extension background.
// background.js is the relay between the bus tab port and any UI
// tabs that connect as 'egpt-bus-subscriber'.

export const BUS_PATH = '/bus.html';

async function busUrl() {
  // Override via chrome.storage.sync.bus_url for advanced setups
  // (e.g. pointing at a remote bus tab through the proxy on a
  // different machine). Default: extension's own bundled bus.html.
  try {
    const got = await chrome.storage.sync.get('bus_url');
    if (typeof got?.bus_url === 'string' && got.bus_url.trim()) {
      return got.bus_url.trim();
    }
  } catch (_) {}
  return chrome.runtime.getURL('bus.html');
}

function isBusUrl(url) {
  if (!url) return false;
  return url.endsWith(BUS_PATH) || url.includes(`${BUS_PATH}?`) || url.includes(`${BUS_PATH}#`);
}

export async function findOrOpenBusTab({ open = true } = {}) {
  const tabs = await chrome.tabs.query({});
  const found = tabs.find(t => isBusUrl(t.url));
  if (found) return { targetId: found.id, url: found.url, opened: false };
  if (!open) return null;
  const url = await busUrl();
  const tab = await chrome.tabs.create({ url, active: false });
  return { targetId: tab.id, url, opened: true };
}

// Singleton subscriber port to the background relay. Multiple
// consumers (UI subscribe handlers) share it: the port carries every
// event broadcast on the bus, and we fan out locally.
//
// Auto-reconnect: when the service worker cycles (idle timeout, or
// user reloads the extension), the port disconnects. We rebuild it
// after a 1s backoff and re-issue the replay-request so the UI sees
// the recent past again. Without this, every SW idle silently kills
// cross-surface event flow until the user reloads the UI tab.
let _port = null;
const _eventHandlers = new Set();
let _replaySinceMs = 5 * 60 * 1000;

function ensurePort() {
  if (_port) return _port;
  _port = chrome.runtime.connect({ name: 'egpt-bus-subscriber' });
  _port.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'event') {
      for (const h of _eventHandlers) {
        try { h(msg.ev); } catch (_) {}
      }
    } else if (msg.type === 'replay') {
      for (const ev of (msg.past ?? [])) {
        if (!ev || typeof ev !== 'object') continue;
        for (const h of _eventHandlers) {
          try { h({ ...ev, _replayed: true }); } catch (_) {}
        }
      }
    }
  });
  _port.onDisconnect.addListener(() => {
    _port = null;
    // Reconnect if anyone still cares — handlers being non-empty
    // means subscribers are alive. Replay-request fires again on the
    // new port so the UI catches up on what flowed during the gap.
    if (_eventHandlers.size > 0) {
      setTimeout(() => {
        const p = ensurePort();
        try { p.postMessage({ type: 'replay-request', since: Date.now() - _replaySinceMs }); } catch (_) {}
      }, 1000);
    }
  });
  return _port;
}

export async function postEvent(_targetId, event) {
  // _targetId is unused with the chrome.runtime path — background
  // relays to whichever bus tab is connected. Kept in the signature
  // for API symmetry with the node module.
  const port = ensurePort();
  try { port.postMessage({ type: 'post', ev: event }); } catch (_) {}
}

export async function subscribeBusEvents(_targetId, onEvent, opts = {}) {
  const { replay = true, replaySinceMs = 5 * 60 * 1000 } = opts;
  _replaySinceMs = replaySinceMs;
  const port = ensurePort();
  _eventHandlers.add(onEvent);
  if (replay) {
    try {
      port.postMessage({ type: 'replay-request', since: Date.now() - replaySinceMs });
    } catch (_) {}
  }
  return {
    stop() {
      _eventHandlers.delete(onEvent);
      // Don't close the port — other handlers may still be using it.
      // Idle ports get GC'd when no handlers remain via a separate
      // timer-based close, but skip that; in practice the extension
      // tab life dominates.
    },
  };
}
