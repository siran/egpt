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

const _busTabPorts      = new Set();   // ports opened by bus.html
const _subscribers      = new Set();   // ports opened by UI tabs
const _waContentPorts   = new Set();   // ports from web.whatsapp.com content scripts
const _waCdpSubscribers = new Set();   // ports from the egpt UI tab's WA-CDP bridge

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

  // ── WhatsApp content-script relay ──────────────────────────────
  //
  // Connections from extension/src/content/wa-content.js (one per
  // open web.whatsapp.com tab). Acts as a peer producer on the bus:
  // 'incoming' messages from the page are republished as room-utterance
  // events on the bus, so every subscriber (egpt UI tab, shell, peers)
  // sees them through their existing bus subscription. 'send' commands
  // arriving from any WA-CDP subscriber are forwarded to all WA content
  // scripts (typically one — the active chat receives the text).
  if (port.name === 'egpt-wa-content') {
    _waContentPorts.add(port);
    port.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === 'incoming') {
        const ev = {
          type:    'room-utterance',
          ts:      msg.ts ?? Date.now(),
          from:    'wa-cdp-content',           // distinct producer id on the bus
          role:    'wa-cdp',
          client:  'wa-cdp',
          via:     `whatsapp[${msg.chatId ?? '?'}]`,
          user:    msg.fromMe ? 'me' : (msg.chatId?.split('@')[0] ?? 'wa'),
          body:    msg.text,
          // Extra fields downstream consumers can use without being on the
          // 'standard' room-utterance contract — they're just passed through.
          wa:      { chatId: msg.chatId, fromMe: msg.fromMe, msgId: msg.msgId },
        };
        // Publish to bus tab → broadcast to all bus subscribers.
        for (const bp of _busTabPorts) {
          try { bp.postMessage({ type: 'post', ev }); } catch (_) {}
        }
        // Also fan out to dedicated WA-CDP subscribers — the egpt UI
        // tab uses this for tighter integration (chat_id capture, etc.)
        // even though the same event already rides on the bus.
        for (const s of _waCdpSubscribers) {
          try { s.postMessage({ type: 'incoming', wa: ev.wa, text: msg.text, ts: ev.ts }); } catch (_) {}
        }
      } else if (msg.type === 'ready') {
        for (const s of _waCdpSubscribers) {
          try { s.postMessage({ type: 'ready', ts: msg.ts ?? Date.now() }); } catch (_) {}
        }
      }
    });
    port.onDisconnect.addListener(() => {
      _waContentPorts.delete(port);
      for (const s of _waCdpSubscribers) {
        try { s.postMessage({ type: 'content-gone' }); } catch (_) {}
      }
    });
    return;
  }

  if (port.name === 'egpt-wa-cdp-subscriber') {
    _waCdpSubscribers.add(port);
    // Tell the new subscriber whether any WA content scripts are
    // currently connected — saves it polling for tab presence.
    try { port.postMessage({ type: _waContentPorts.size > 0 ? 'ready' : 'no-content', ts: Date.now() }); } catch (_) {}
    port.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === 'send' && typeof msg.text === 'string') {
        for (const cp of _waContentPorts) {
          try { cp.postMessage({ type: 'send', text: msg.text }); } catch (_) {}
        }
      }
    });
    port.onDisconnect.addListener(() => _waCdpSubscribers.delete(port));
    return;
  }
});

