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

import { signEvent, verifyEvent, keyFromString } from '../../../tools/bus-sign.mjs';

export const BUS_PATH = '/bus.html';

// Bus signing key. Loaded from chrome.storage.local.bus_key when set.
// When present, every outgoing event is HMAC-signed and every incoming
// event is verified — invalid sigs are dropped silently. Unsigned
// events still pass through (permissive default for phased rollout).
let _busKeyBytes = null;
export function setBusKey(b64OrNull) {
  _busKeyBytes = b64OrNull ? keyFromString(b64OrNull) : null;
}
export function getBusKey() { return _busKeyBytes; }
// Auto-load from storage on module init. chrome.storage events
// (set elsewhere) update the key so changes take effect without reload.
(async () => {
  try {
    const got = await chrome.storage.local.get('bus_key');
    if (typeof got?.bus_key === 'string' && got.bus_key.trim()) {
      setBusKey(got.bus_key.trim());
    }
  } catch (_) {}
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.bus_key) return;
      const v = changes.bus_key.newValue;
      setBusKey(typeof v === 'string' && v.trim() ? v.trim() : null);
    });
  } catch (_) {}
})();

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
// Highest event timestamp we've delivered. On SW reconnect we replay
// only events strictly newer than this so the same events don't get
// re-rendered every cycle. Initialized to "5 min ago" on first
// subscribe so initial-replay covers recent history.
let _lastSeenTs = 0;
// Dedupe set of event keys we've already passed to handlers. Catches
// the cases where lastSeenTs alone isn't enough — e.g. rapid SW
// cycles where a replay arrives before lastSeenTs has been updated,
// or events arriving out-of-order. Capped to keep memory bounded.
const _seenEventKeys = new Set();
const SEEN_KEYS_CAP = 500;
// Live-flood suppressor. See bus-flood.js for the algorithm; tracks
// per-(from, body) bursts that aren't caught by the ts-based event-
// key dedup. Logs once per flood-window via console.warn so the user
// can spot suppressed peers without per-message noise.
import { FloodTracker } from './bus-flood.js';
const _flood = new FloodTracker({
  onSuppress: (ev, count, threshold, windowMs) => {
    try {
      console.warn(`[bus-flood] suppressing duplicate '${(ev.body ?? '').slice(0, 40)}' from ${ev.from ?? '?'} (>${threshold} in ${windowMs}ms)`);
    } catch (_) {}
  },
});
const checkFlood = (ev) => _flood.check(ev);

function eventKey(ev) {
  // ts + from + type + first 60 chars of body should uniquely
  // identify an event for our dedupe purposes.
  return `${ev.ts ?? 0}:${ev.from ?? ''}:${ev.type ?? ''}:${(ev.body ?? '').slice(0, 60)}`;
}
function trackSeen(ev) {
  if (!ev || typeof ev !== 'object') return false;
  const k = eventKey(ev);
  if (_seenEventKeys.has(k)) return true;   // already seen
  _seenEventKeys.add(k);
  if (_seenEventKeys.size > SEEN_KEYS_CAP) {
    // Trim oldest half (Set iteration is insertion-order)
    const all = [..._seenEventKeys];
    _seenEventKeys.clear();
    for (const k of all.slice(-Math.floor(SEEN_KEYS_CAP / 2))) {
      _seenEventKeys.add(k);
    }
  }
  if (typeof ev.ts === 'number' && ev.ts > _lastSeenTs) _lastSeenTs = ev.ts;
  return false;
}

async function _verify(ev, where) {
  if (!_busKeyBytes) return true;   // permissive when no key configured
  const result = await verifyEvent(ev, _busKeyBytes);
  if (result === 'invalid') {
    try { console.warn(`[bus-sign] dropped event with invalid signature (${where}): ${ev?.type ?? '?'}`); } catch (_) {}
    return false;
  }
  return true;   // 'valid' or 'missing' (permissive)
}

function ensurePort() {
  if (_port) return _port;
  _port = chrome.runtime.connect({ name: 'egpt-bus-subscriber' });
  _port.onMessage.addListener(async (msg) => {
    if (!msg) return;
    if (msg.type === 'event') {
      if (trackSeen(msg.ev)) return;       // already delivered (replay race)
      if (checkFlood(msg.ev)) return;      // peer flooding the bus
      if (!(await _verify(msg.ev, 'live'))) return;
      for (const h of _eventHandlers) {
        try { h(msg.ev); } catch (_) {}
      }
    } else if (msg.type === 'replay') {
      for (const ev of (msg.past ?? [])) {
        if (trackSeen(ev)) continue;
        if (checkFlood(ev)) continue;
        if (!(await _verify(ev, 'replay'))) continue;
        for (const h of _eventHandlers) {
          try { h({ ...ev, _replayed: true }); } catch (_) {}
        }
      }
    }
  });
  _port.onDisconnect.addListener(() => {
    _port = null;
    // Reconnect if anyone still cares — handlers being non-empty
    // means subscribers are alive. Replay-request asks for events
    // STRICTLY NEWER than the last one we've delivered, so a SW
    // idle-cycle doesn't re-flood the UI with the past 5 minutes
    // of already-rendered events.
    if (_eventHandlers.size > 0) {
      setTimeout(() => {
        const p = ensurePort();
        const since = _lastSeenTs > 0 ? _lastSeenTs : (Date.now() - _replaySinceMs);
        try { p.postMessage({ type: 'replay-request', since }); } catch (_) {}
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
  // Sign before sending when a key is configured. Receivers with the
  // same key verify; receivers without (or with a different key) drop
  // as 'invalid' or pass through as 'missing' depending on their
  // permissive flag.
  const toSend = _busKeyBytes ? await signEvent(event ?? {}, _busKeyBytes) : (event ?? {});
  try { port.postMessage({ type: 'post', ev: toSend }); } catch (_) {}
}

export async function subscribeBusEvents(_targetId, onEvent, opts = {}) {
  const { replay = true, replaySinceMs = 5 * 60 * 1000 } = opts;
  _replaySinceMs = replaySinceMs;
  const port = ensurePort();
  _eventHandlers.add(onEvent);
  if (replay) {
    try {
      // Initial replay covers the configured window. Subsequent
      // replays (after SW reconnects) use _lastSeenTs to avoid
      // re-delivering already-seen events.
      const since = _lastSeenTs > 0 ? _lastSeenTs : (Date.now() - replaySinceMs);
      port.postMessage({ type: 'replay-request', since });
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
