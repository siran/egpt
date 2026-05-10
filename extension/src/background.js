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
    return;
  }
  // Collapse duplicates that have accumulated (refreshExtensionPages
  // races, manual reloads, etc.). Keep the first; remove the rest.
  for (let i = 1; i < existing.length; i++) {
    try { await chrome.tabs.remove(existing[i].id); } catch (_) {}
  }
}

// Open the egpt UI tab if it isn't already. Used by the WA-incoming
// path: when an '@e foo' arrives and there's no WA-CDP subscriber,
// we open the tab so the dispatch lands. Returns the tab id.
async function ensureEgptTab() {
  const url = chrome.runtime.getURL(TAB_URL);
  const existing = await chrome.tabs.query({ url });
  if (existing.length > 0) return existing[0].id;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    return tab?.id ?? null;
  } catch (_) {
    return null;
  }
}

// Self-healing extension reload. When the user reloads the extension
// at chrome://extensions (or it auto-updates), the existing bus.html
// and egpt UI tabs are still running OLD background-context-bound
// JS; ports are dead, content scripts in WA Web etc. have stale
// chrome.runtime references. Close + respawn our own pages, and
// reload any open content-script-target tabs so they reinject fresh.
const CONTENT_SCRIPT_HOSTS = [
  /web\.whatsapp\.com/,
  // /web\.telegram\.org/,   // future: when TG-CDP content script ships
];
// Single-flight guard. onInstalled and onStartup can both fire on a
// reload-during-startup, and onRemoved (below) calls ensureBusTab
// which races with a refresh in flight. Without serialization, two
// parallel refreshes each saw "1 bus tab" → each created a new one →
// the user ended up with two bus tabs and the egpt tab missing.
let _refreshInFlight = null;
async function refreshExtensionPages() {
  if (_refreshInFlight) return _refreshInFlight;
  _refreshInFlight = (async () => {
    const tabUrl = chrome.runtime.getURL(TAB_URL);
    const busUrl = chrome.runtime.getURL(BUS_URL);
    let allTabs;
    try { allTabs = await chrome.tabs.query({}); }
    catch { return; }

    const egptTabs = allTabs.filter(t => t.url === tabUrl);
    const busTabs  = allTabs.filter(t => t.url === busUrl);
    const csTabs   = allTabs.filter(t => CONTENT_SCRIPT_HOSTS.some(re => re.test(t.url ?? '')));
    const hadEgpt  = egptTabs.length > 0;

    // Open the new bus tab BEFORE closing old ones. The chrome.tabs.onRemoved
    // listener fires when we remove the old bus and queries for remaining
    // bus tabs; without a live one already present it auto-spawns ANOTHER.
    let freshBus = null;
    try { freshBus = await chrome.tabs.create({ url: busUrl, active: false }); } catch (_) {}
    for (const t of busTabs) {
      if (freshBus && t.id === freshBus.id) continue;
      try { await chrome.tabs.remove(t.id); } catch (_) {}
    }

    // Same dance for the egpt UI — open-then-close so transient empty
    // windows can't trigger any reopen logic. Skip the open on first-
    // install (no prior egpt tab to honor).
    let freshEgpt = null;
    if (hadEgpt) {
      try { freshEgpt = await chrome.tabs.create({ url: tabUrl, active: false }); } catch (_) {}
    }
    for (const t of egptTabs) {
      if (freshEgpt && t.id === freshEgpt.id) continue;
      try { await chrome.tabs.remove(t.id); } catch (_) {}
    }

    // Refresh any content-script tabs so the fresh script binds to
    // the fresh background.
    for (const t of csTabs) {
      try { await chrome.tabs.reload(t.id); } catch (_) {}
    }
  })().finally(() => { _refreshInFlight = null; });
  return _refreshInFlight;
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
const _waContentPorts   = new Set();   // ports from web.whatsapp.com content scripts
const _waCdpSubscribers = new Set();   // ports from the egpt UI tab's WA-CDP bridge

// Echo suppression for WA-CDP. Pure logic in bridges/wa-echo.js so it
// can be unit-tested; we just wrap the singleton here.
import { createEchoTracker } from './bridges/wa-echo.js';
const _echo = createEchoTracker();
const recordSend = (text) => _echo.record(text);
const consumeEcho = (text) => _echo.consume(text);

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
        // Echo suppression: filter our own debugger-sends bouncing
        // back via the WA Web DOM (fromMe=true match within 15s).
        if (msg.fromMe && consumeEcho(msg.text)) return;
        // Auto-open the egpt UI tab when an @e/@egpt arrives but
        // there's no WA-CDP subscriber listening (i.e. user has
        // closed the egpt tab). The egpt tab is what runs
        // handleIncomingWaCdp → runBrain; without it, the message
        // gets republished onto the bus and falls into the void.
        // The freshly-opened tab requests bus replay on connect, so
        // the @e dispatch lands as soon as it boots.
        if (
          _waCdpSubscribers.size === 0 &&
          /(?:^|\s)@(egpt|e)\b/i.test(msg.text ?? '')
        ) {
          ensureEgptTab().catch(() => {});
        }
        // Author scraped by the content script from data-pre-plain-text
        // ("[10:04, 5/9/2026] An: " → "An"). Use it for both the bus
        // user field AND the wa.author passthrough so the egpt UI's
        // bridge subscriber gets the same name. fromMe messages in
        // self-DM still have a real WA-side name (the user's own).
        const author = msg.author || null;
        const ev = {
          type:    'room-utterance',
          ts:      msg.ts ?? Date.now(),
          from:    'wa-cdp-content',
          role:    'wa-cdp',
          client:  'wa-cdp',
          via:     `whatsapp[${msg.chatId ?? '?'}]`,
          user:    author || (msg.fromMe ? 'me' : (msg.chatId?.split('@')[0] ?? 'wa')),
          body:    msg.text,
          wa:      { chatId: msg.chatId, fromMe: msg.fromMe, msgId: msg.msgId, author },
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
      } else if (msg.type === 'channels-list') {
        // Response to a /channels request; fan out to subscribers
        // so the originating bridge promise can resolve.
        for (const s of _waCdpSubscribers) {
          try { s.postMessage({ type: 'channels-list', requestId: msg.requestId, chats: msg.chats }); } catch (_) {}
        }
      } else if (msg.type === 'open-chat') {
        // Content script detected a wake-word notification on a non-
        // active chat. Bring that chat into focus so the row's message
        // DOM mounts and our MutationObserver picks up the text.
        // Best-effort — failures are logged-and-swallowed; the user
        // can still open it manually.
        openChatViaDebugger(port._waTabId, { name: msg.chatName, jid: msg.chatJid })
          .catch(() => {});
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
        const requestId = msg.requestId ?? null;
        sendToFirstWaTab(msg.text, { chatName: msg.chatName, chatJid: msg.chatJid })
          .then((status) => { try { port.postMessage({ type: 'send-ack', requestId, status }); } catch (_) {} })
          .catch((e)    => { try { port.postMessage({ type: 'send-error', requestId, error: e?.message ?? String(e) }); } catch (_) {} });
      } else if (msg.type === 'list-channels') {
        // Forward to any/all WA content scripts; the first one to
        // respond wins (they're usually one).
        for (const cp of _waContentPorts) {
          try { cp.postMessage({ type: 'list-channels', requestId: msg.requestId, limit: msg.limit }); } catch (_) {}
        }
      }
    });
    port.onDisconnect.addListener(() => _waCdpSubscribers.delete(port));
    return;
  }
});

// Tolerant title comparison. WA Web's header carries trailing
// parenthetical affordances on some chats — most importantly "(You)"
// for self-DM — that the chat-list row's title omits. Without
// stripping these, the post-switch title verify fails and the send
// aborts even though the click correctly switched to the right chat.
// Strips at most ONE trailing "(...)" group; both sides are
// whitespace-collapsed and trimmed.
function titlesEqual(a, b) {
  const norm = (s) => String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*\([^()]*\)\s*$/, '')
    .trim();
  return norm(a) === norm(b);
}

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
// Steal OS-level focus to the WA Web window. Chrome aggressively
// throttles tabs in unfocused windows AND throttles the whole browser
// when Chrome itself isn't the foreground OS app — e.g. clicks via
// chrome.debugger Input.* don't take, MutationObservers run late or
// not at all, the chat-switch silently fails. Page.bringToFront alone
// only reorders within a window; it doesn't lift OS focus. The
// trade-off the user has accepted is: yes, steal focus when WA work
// happens, since the alternative is for inbound @e from phone to
// silently no-op when Chrome is in the background. Also unminimizes
// the window if needed.
async function focusWaWindow(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.windowId == null) return;
    let stateUpdate = {};
    try {
      const win = await chrome.windows.get(tab.windowId);
      if (win.state === 'minimized') stateUpdate = { state: 'normal' };
    } catch (_) {}
    await chrome.windows.update(tab.windowId, { focused: true, ...stateUpdate });
    if (!tab.active) {
      try { await chrome.tabs.update(tabId, { active: true }); } catch (_) {}
    }
  } catch (_) { /* best-effort — debugger work still tries below */ }
}

// Per-WA-tab serialization queue. chrome.debugger.attach is exclusive
// on a target — two concurrent attaches collide ("Another debugger is
// already attached"). Both outbound sends (sendToFirstWaTab) and
// inbound auto-focus (openChatViaDebugger) attach to the same WA tab,
// so we serialize ALL CDP work on a given tab through one queue.
// Without this, back-to-back '@e' messages from a phone (arriving
// faster than the brain answers) crashed with the 'already attached'
// error mid-pipeline.
const _waTabQueues = new Map();   // tabId → tail Promise
function withWaTabQueue(tabId, fn) {
  const prior = _waTabQueues.get(tabId) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(fn);
  const queueTail = next.catch(() => {});
  _waTabQueues.set(tabId, queueTail);
  queueTail.finally(() => {
    if (_waTabQueues.get(tabId) === queueTail) _waTabQueues.delete(tabId);
  });
  return next;
}

async function sendToFirstWaTab(text, opts = {}) {
  const port = [..._waContentPorts][0];
  if (!port) throw new Error('no WA content script connected');
  const tabId = port._waTabId;
  if (!tabId) throw new Error('content script port has no tab id (sender info missing)');
  return withWaTabQueue(tabId, () => _sendToWaTabImpl(tabId, text, opts));
}

async function _sendToWaTabImpl(tabId, text, opts) {
  // Steal OS focus to Chrome (specifically the WA window) BEFORE the
  // debugger attach. Chrome's throttling of unfocused-app tabs would
  // otherwise let our Input.* clicks fall on the floor.
  await focusWaWindow(tabId);

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
    // Chat-target precedence:
    //   1. opts.chatJid / opts.chatName — explicit overrides from the
    //      caller (e.g. /join active or @waN one-shot). JID is the
    //      stable id; name is the fallback for matching.
    //   2. (none) — sends go to whatever's currently active
    let chatName = (typeof opts.chatName === 'string' && opts.chatName.trim()) ? opts.chatName.trim() : null;
    let chatJid  = (typeof opts.chatJid  === 'string' && opts.chatJid.trim())  ? opts.chatJid.trim()  : null;

    // Bring the WA Web tab to the front so its renderer isn't
    // throttled mid-send and so the user can see what's happening.
    try { await chrome.debugger.sendCommand(target, 'Page.bringToFront'); } catch (_) {}

    // Show the 'egpt is typing for you…' overlay immediately, with
    // pointer-events:none so it doesn't swallow our own chat-switch
    // click. Visible from the start = better feedback (the type/send
    // phase alone is too fast to perceive a flash). After the switch
    // we flip to pointer-events:auto so user clicks during the
    // type/send phase are blocked and can't race with focus.
    await showSendingOverlay(target, { blockEvents: false }).catch(() => {});

    // Standard send workflow, with verification at each step:
    //   1. switch chat (ensureActiveChat clicks the row)
    //   2. verify title — we're on the intended chat
    //   3. type    (Input.insertText)
    //   4. verify body — composer holds exactly the text we typed
    //   5. send    (Enter)
    // Any verification failure aborts before the next step. This is
    // the right shape for browser-driven UI automation; without each
    // check, a single misfire silently writes to the wrong place.

    // 1. switch chat — overlay above is non-blocking so the click
    //    lands on the chat-list row, not the overlay element.
    if (chatName || chatJid) await ensureActiveChat(target, { name: chatName, jid: chatJid });

    // Lock down the overlay now that the click phase is done. The
    // type/send Input.* events are dispatched at the page level
    // (insertText, Enter via dispatchKeyEvent) and don't go through
    // hit-testing, so pointer-events:auto on the overlay doesn't
    // interfere — but it does block any stray user click on the
    // composer or send button.
    await showSendingOverlay(target, { blockEvents: true }).catch(() => {});

    // 2. verify title — header reflects the intended chat. Scope to
    //    #main: WA Web has multiple <header> elements (chat-list,
    //    drawers) that aren't the conversation header. Recent bundles
    //    also dropped the `title` attribute from header spans, so we
    //    read innerText and first-line-normalize.
    const probeTitle = async () => {
      const r = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
        expression: `(() => {
          const norm = (s) => (s ?? '').replace(/\\s+/g, ' ').trim();
          const firstLine = (s) => norm((s || '').split('\\n')[0]);
          const h =
            document.querySelector('#main header [data-testid="conversation-info-header"]') ||
            document.querySelector('#main header') ||
            document.querySelector('header [data-testid="conversation-header"]');
          return firstLine(h?.innerText || h?.getAttribute?.('title') || '');
        })()`,
        returnByValue: true,
      });
      return r?.result?.value ?? '';
    };
    if (chatName) {
      const currentTitle = await probeTitle();
      const expected = chatName.split('\n')[0].trim();
      if (!titlesEqual(currentTitle, expected)) {
        throw new Error(`title check failed: WA header is "${currentTitle}", expected "${expected}". Aborting before typing.`);
      }
    }

    // Focus the composer so insertText lands there.
    await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: `(
        document.querySelector('div[contenteditable="true"][data-tab="10"]') ||
        document.querySelector('footer div[contenteditable="true"]') ||
        document.querySelector('div[contenteditable="true"][role="textbox"]')
      )?.focus()`,
      returnByValue: true,
    });

    // 3. type
    await chrome.debugger.sendCommand(target, 'Input.insertText', { text });

    // 4. verify body — composer contains the text we typed. Catches
    //    cases where insertText silently failed, focus drifted to a
    //    different element, or WA Web rejected the input.
    const probeComposer = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: `(() => {
        const el =
          document.querySelector('div[contenteditable="true"][data-tab="10"]') ||
          document.querySelector('footer div[contenteditable="true"]') ||
          document.querySelector('div[contenteditable="true"][role="textbox"]');
        return (el?.innerText || '').trim();
      })()`,
      returnByValue: true,
    });
    const composerText = (probeComposer?.result?.value ?? '').trim();
    const expectedText = text.trim();
    if (!composerText.includes(expectedText)) {
      throw new Error(
        `body check failed: composer contains "${composerText.slice(0, 80)}", expected to contain "${expectedText.slice(0, 80)}". Aborting before send.`
      );
    }

    // Re-verify title once more — defensive against a chat-switch
    // happening DURING the type step (unlikely but cheap to check).
    if (chatName) {
      const stillTitle = await probeTitle();
      const expected = chatName.split('\n')[0].trim();
      // (titlesEqual handles WA's self-DM "(You)" affordance and
      // similar trailing parenthetical badges that the chat-list row
      // omits but the header carries.)
      if (!titlesEqual(stillTitle, expected)) {
        throw new Error(`title drift after typing: WA header is "${stillTitle}", expected "${expected}". Aborting before send.`);
      }
    }

    // 5. send (real Enter via debugger Input — isTrusted=true)
    recordSend(text);
    const enterParams = {
      type: 'keyDown', key: 'Enter', code: 'Enter',
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      unmodifiedText: '\r', text: '\r',
    };
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', enterParams);
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { ...enterParams, type: 'keyUp' });
    return 'ok';
  } finally {
    await hideSendingOverlay(target).catch(() => {});
    if (attached) {
      try { await chrome.debugger.detach(target); } catch (_) {}
    }
  }
}

// "egpt is typing for you" overlay — injected via Runtime.evaluate
// during sends. Two phases:
//   blockEvents:false  — visible feedback, pointer-events:none so
//                        our own CDP chat-list click passes through
//   blockEvents:true   — same overlay, pointer-events:auto so user
//                        clicks on composer/send during the type/send
//                        phase don't race with our Input.* sequence
// Re-creates the element on first call; subsequent calls just toggle
// the pointer-events style so there's no flicker between phases.
async function showSendingOverlay(target, { blockEvents = true } = {}) {
  const pe = blockEvents ? 'auto' : 'none';
  await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
    expression: `(() => {
      let el = document.getElementById('__egpt_typing_overlay');
      if (!el) {
        el = document.createElement('div');
        el.id = '__egpt_typing_overlay';
        el.style.cssText = [
          'position:fixed','inset:0','background:rgba(15,20,25,0.55)','color:#fff',
          'font:600 16px system-ui,sans-serif','display:flex','align-items:center',
          'justify-content:center','z-index:2147483647',
          'cursor:wait','user-select:none','-webkit-user-select:none',
        ].join(';');
        el.textContent = 'egpt is typing for you…';
        document.body.appendChild(el);
      }
      el.style.pointerEvents = ${JSON.stringify(pe)};
    })()`,
    returnByValue: true,
  });
}
async function hideSendingOverlay(target) {
  await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
    expression: `document.getElementById('__egpt_typing_overlay')?.remove()`,
    returnByValue: true,
  });
}

// Bring a chat into focus by CDP-clicking its row in the chat list.
// Triggered by the content script when it spots a wake-word
// notification on a non-active chat — WA Web only mounts message
// DOM for the focused chat, so without this the message stays an
// unread badge and the MutationObserver never sees it.
//
// Best-effort: per-tab dedupe so back-to-back notifications don't
// stack debugger attaches; swallows ensureActiveChat errors (chat
// may have moved out of the rendered window before we got here).
const _openInFlight = new Set();   // tabIds currently being opened
async function openChatViaDebugger(tabId, chat) {
  if (!tabId) return;
  if (_openInFlight.has(tabId)) return;
  _openInFlight.add(tabId);
  try {
    await withWaTabQueue(tabId, async () => {
      // Steal OS focus first (same reasoning as sendToFirstWaTab) —
      // when a phone-typed '@e foo' arrives in WA, Chrome may be
      // backgrounded; without focus the chat-switch click silently
      // no-ops and the message never reaches the brain.
      await focusWaWindow(tabId);
      const target = { tabId };
      let attached = false;
      try {
        await chrome.debugger.attach(target, '1.3');
        attached = true;
        try { await chrome.debugger.sendCommand(target, 'Page.bringToFront'); } catch (_) {}
        await ensureActiveChat(target, chat);
      } catch (_) {
        // swallow — best-effort
      } finally {
        if (attached) {
          try { await chrome.debugger.detach(target); } catch (_) {}
        }
      }
    });
  } finally {
    _openInFlight.delete(tabId);
  }
}

// Switch the WA Web tab's active conversation to the target chat.
// Matching: JID first (stable across chat-list reorders), display
// name as fallback.
//
// Click strategy (verified empirically against the live page via
// CDP probe — see probe-debug.mjs in commit history):
//   - Synthetic events DO NOT WORK on the chat-list row in modern
//     WA Web bundles. row.click(), MouseEvent dispatch, PointerEvent
//     dispatch — all silently fail. The chat-list handler appears to
//     check event.isTrusted (same hardening as the send button).
//   - chrome.debugger Input.dispatchMouseEvent (isTrusted=true) DOES
//     work — confirmed switching from one chat to another.
//
// Sequence:
//   1. Runtime.evaluate to find the row, scrollIntoView({block:'center'})
//      so it's reliably in the viewport, return rect.
//   2. Input.dispatchMouseEvent at rect's center: mouseMoved, mousePressed,
//      mouseReleased.
//   3. Wait, then verify the header changed.
async function ensureActiveChat(target, chat) {
  const { name = null, jid = null } = (typeof chat === 'string') ? { name: chat } : (chat || {});
  if (!name && !jid) return;

  const probeExpr = `(() => {
    const norm = (s) => (s ?? '').replace(/\\s+/g, ' ').trim();
    const firstLine = (s) => norm((s || '').split('\\n')[0]);
    // Strip a single trailing parenthetical badge — e.g. "(You)" on
    // self-DM headers — so the chat-list row name (which omits it)
    // matches the header (which includes it).
    const stripBadge = (s) => firstLine(s).replace(/\\s*\\([^()]*\\)\\s*$/, '').trim();
    const targetJid  = ${JSON.stringify(jid)};
    const targetName = ${JSON.stringify(name)};

    const headerOf = () => {
      const h =
        document.querySelector('#main header [data-testid="conversation-info-header"]') ||
        document.querySelector('#main header') ||
        document.querySelector('header [data-testid="conversation-header"]');
      return firstLine(h?.innerText || h?.getAttribute?.('title') || '');
    };
    const activeTitle = headerOf();
    if (targetName && stripBadge(activeTitle) === stripBadge(targetName)) {
      return { state: 'already', activeTitle };
    }

    const panel =
      document.querySelector('[aria-label="Chat list" i]') ||
      document.querySelector('[role="grid"][aria-label*="Chat" i]');
    const rows = panel
      ? panel.querySelectorAll('[role="listitem"], div[role="row"]')
      : document.querySelectorAll('[role="listitem"], [role="row"]');

    let matchRow = null;
    let matchedBy = null;
    if (targetJid) {
      for (const r of rows) {
        if (r.getAttribute?.('data-id') === targetJid || r.getAttribute?.('data-jid') === targetJid) {
          matchRow = r; matchedBy = 'jid'; break;
        }
        const subEl = r.querySelector?.('[data-id], [data-jid]');
        if (subEl) {
          const v = subEl.getAttribute('data-id') || subEl.getAttribute('data-jid');
          if (v === targetJid) { matchRow = r; matchedBy = 'jid'; break; }
        }
      }
    }
    if (!matchRow && targetName) {
      const tnorm = norm(targetName);
      for (const r of rows) {
        const titleEl = r.querySelector?.('span[dir="auto"][title]') ||
                        r.querySelector?.('span[dir="auto"]');
        const t = norm(titleEl?.getAttribute?.('title') || titleEl?.innerText || '');
        if (t === tnorm) { matchRow = r; matchedBy = 'name'; break; }
      }
    }
    if (!matchRow) {
      return { state: 'not-found', activeTitle, target: targetJid || targetName };
    }

    // Bring into view, then read rect AFTER scroll so coords reflect
    // the row's actual viewport position. Chat list is virtual-
    // scrolled; rect read before scroll can be off.
    try { matchRow.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (_) {}
    const rect = matchRow.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return { state: 'off-screen', activeTitle };
    }
    return {
      state: 'found',
      activeTitle, matchedBy,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  })()`;

  const probe = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
    expression: probeExpr, returnByValue: true,
  });
  const v = probe?.result?.value ?? {};
  if (v.state === 'already') return;
  if (v.state === 'not-found') {
    throw new Error(`chat ${v.target ?? '(unknown)'} not found in WA list (active: "${v.activeTitle ?? ''}"). Run /channels again — the chat may have moved out of the panel's rendered window.`);
  }
  if (v.state === 'off-screen') {
    throw new Error(`chat row is off-screen even after scrollIntoView — chat list may not be the visible panel.`);
  }

  // Real CDP click — isTrusted=true, the only kind WA Web's chat-list
  // handler honors in modern bundles.
  const click = (type) => chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
    type, x: v.x, y: v.y, button: type === 'mouseMoved' ? 'none' : 'left',
    clickCount: type === 'mouseMoved' ? 0 : 1,
  });
  await click('mouseMoved');
  await click('mousePressed');
  await click('mouseReleased');

  // Wait for WA Web's React state to swap the conversation pane in.
  await new Promise(r => setTimeout(r, 700));

  // Verify the switch actually stuck. If the click didn't take (some
  // bundle revisions ignore .click() on the row wrapper), throw with
  // the actual vs expected so the caller can surface a clear error.
  if (name) {
    const verifyExpr = `(() => {
      const norm = (s) => (s ?? '').replace(/\\s+/g, ' ').trim();
      const firstLine = (s) => norm((s || '').split('\\n')[0]);
      const h =
        document.querySelector('#main header [data-testid="conversation-info-header"]') ||
        document.querySelector('#main header') ||
        document.querySelector('header [data-testid="conversation-header"]');
      return firstLine(h?.innerText || h?.getAttribute?.('title') || '');
    })()`;
    const verify = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: verifyExpr, returnByValue: true,
    });
    const newTitle = verify?.result?.value ?? '';
    const expected = name.split('\n')[0].trim();
    if (!titlesEqual(newTitle, expected)) {
      throw new Error(
        `chat switch didn't take — WA header is still "${newTitle}", expected "${expected}". ` +
        `Click the target chat manually in WA Web, then retry — or run /channels again if the chat has shifted in the list.`
      );
    }
  }
}

