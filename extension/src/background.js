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
    // Stash the tab id so we can target chrome.debugger sends at it
    // later (synthetic events from the content script can't trigger
    // WA Web's send button — it checks event.isTrusted; only events
    // dispatched via Input.* through chrome.debugger pass).
    port._waTabId = port.sender?.tab?.id ?? null;
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
    try { port.postMessage({ type: _waContentPorts.size > 0 ? 'ready' : 'no-content', ts: Date.now() }); } catch (_) {}
    port.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === 'send' && typeof msg.text === 'string') {
        sendToFirstWaTab(msg.text)
          .then((status) => { try { port.postMessage({ type: 'send-ack', status }); } catch (_) {} })
          .catch((e)    => { try { port.postMessage({ type: 'send-error', error: e?.message ?? String(e) }); } catch (_) {} });
      }
    });
    port.onDisconnect.addListener(() => _waCdpSubscribers.delete(port));
    return;
  }
});

// Send a WhatsApp message via chrome.debugger Input.* events. WA Web
// checks event.isTrusted and rejects synthetic DOM events, so the
// only reliable path from an extension is browser-level input
// injection through CDP. Banner ("egpt started debugging this
// browser") shows during the attach window. We attach right before
// each send and detach immediately after to keep the banner exposure
// minimal — flickers briefly per send rather than staying up.
//
// Channel awareness: if chrome.storage.sync.whatsapp_cdp.chat_name is
// set, we ensure that chat is the active one BEFORE typing — switching
// via a real Input.dispatchMouseEvent on the chat list row if needed.
// Without chat_name configured, the message goes to whatever's open
// (loud caveat printed in BRIDGES_CDP_SPEC.md).
async function sendToFirstWaTab(text) {
  const port = [..._waContentPorts][0];
  if (!port) throw new Error('no WA content script connected');
  const tabId = port._waTabId;
  if (!tabId) throw new Error('content script port has no tab id (sender info missing)');

  const target = { tabId };
  let attached = false;
  try {
    await chrome.debugger.attach(target, '1.3');
    attached = true;
  } catch (e) {
    const m = e?.message ?? String(e);
    if (/another debugger/i.test(m)) {
      throw new Error('cannot attach — DevTools is open on the WA tab. Close it and retry.');
    }
    throw new Error('debugger attach failed: ' + m);
  }
  try {
    const { whatsapp_cdp: cfg = {} } = await chrome.storage.sync.get('whatsapp_cdp');
    const chatName = (typeof cfg.chat_name === 'string' && cfg.chat_name.trim()) ? cfg.chat_name.trim() : null;
    if (chatName) await ensureActiveChat(target, chatName);

    // Focus the WA composer so the next Input.insertText lands there.
    // Same selector heuristics as wa-content.js — pin updates in both
    // places when WA Web reships.
    await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: `(
        document.querySelector('div[contenteditable="true"][data-tab="10"]') ||
        document.querySelector('footer div[contenteditable="true"]') ||
        document.querySelector('div[contenteditable="true"][role="textbox"]')
      )?.focus()`,
      returnByValue: true,
    });
    await chrome.debugger.sendCommand(target, 'Input.insertText', { text });
    const enterParams = {
      type: 'keyDown', key: 'Enter', code: 'Enter',
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      unmodifiedText: '\r', text: '\r',
    };
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', enterParams);
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { ...enterParams, type: 'keyUp' });
    return 'ok';
  } finally {
    if (attached) {
      try { await chrome.debugger.detach(target); } catch (_) {}
    }
  }
}

// If the WA Web tab's active conversation isn't `chatName`, find the
// chat list row whose title (or aria-label) matches and dispatch a
// real (Input.dispatchMouseEvent) click on its center. WA Web's click
// handlers fire on both synthetic and real, BUT subsequent send via
// Input.insertText also requires real input — keeping everything on
// the chrome.debugger path makes the whole interaction trusted.
async function ensureActiveChat(target, chatName) {
  // Returns: { state: 'already' | 'found' | 'not-found', x?, y?, activeTitle? }
  const probeExpr = `(() => {
    const norm = (s) => (s ?? '').replace(/\\s+/g, ' ').trim();
    const targetName = ${JSON.stringify(chatName)};
    // Active chat title — try a few common header selectors.
    const header =
      document.querySelector('header [data-testid="conversation-info-header"]') ||
      document.querySelector('header span[dir="auto"][title]') ||
      document.querySelector('header span[dir="auto"]');
    const activeTitle = norm(header?.getAttribute?.('title') || header?.innerText || '');
    if (activeTitle === norm(targetName)) {
      return { state: 'already', activeTitle };
    }
    // Find the chat row in the list. WA Web typically wraps each chat
    // in a [role="listitem"] or [role="row"]; the visible name is in a
    // span[dir="auto"] descendant (sometimes with title= attr).
    const rows = document.querySelectorAll('[role="listitem"], [role="row"], [aria-label="Chat list"] > div > div');
    for (const row of rows) {
      const titleEl = row.querySelector('span[dir="auto"][title]') ||
                      row.querySelector('span[dir="auto"]');
      const title = norm(titleEl?.getAttribute?.('title') || titleEl?.innerText || '');
      if (title === norm(targetName)) {
        const r = row.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return { state: 'found', activeTitle, x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
    }
    return { state: 'not-found', activeTitle };
  })()`;
  const probe = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
    expression: probeExpr, returnByValue: true,
  });
  const v = probe?.result?.value ?? {};
  if (v.state === 'already') return;
  if (v.state === 'not-found') {
    throw new Error(`chat "${chatName}" not found in WA list (active: "${v.activeTitle ?? ''}"). Set whatsapp_cdp.chat_name to the visible chat-list label.`);
  }
  // Real click via debugger Input — isTrusted=true, WA respects it.
  const click = (type) => chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
    type, x: v.x, y: v.y, button: 'left', clickCount: 1,
  });
  await click('mousePressed');
  await click('mouseReleased');
  // Give WA Web a tick to swap the conversation pane in.
  await new Promise(r => setTimeout(r, 300));
}

