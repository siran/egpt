// extension/src/bridges/whatsapp-cdp.js — extension-side WhatsApp Web
// bridge. Talks to extension/src/content/wa-content.js (a content script
// declared in manifest.chrome.json that runs in every web.whatsapp.com
// page) via a chrome.runtime port relayed by background.js.
//
// No CDP, no Chrome launch flags. Tab presence is the on/off switch:
// open web.whatsapp.com → content script auto-loads → bridge attaches.
// Close the tab → content script unloads → bridge surfaces a 'no-content'
// state.
//
// The background relay also republishes incoming messages as
// 'room-utterance' events on the bus, so peers (shell, other extensions)
// see them without going through this bridge module at all. This module
// is mostly the local UI-tab integration: dedicated subscriber port for
// onChatId capture, onIncoming for in-tab rendering, and send()
// command routing.
//
// Wire protocol on the 'egpt-wa-cdp-subscriber' port (background relays
// to/from one or more 'egpt-wa-content' ports):
//   bg → us:  { type: 'ready' }            (a content script is connected)
//   bg → us:  { type: 'no-content' }       (no content script connected)
//   bg → us:  { type: 'incoming', wa: {chatId, fromMe, msgId}, text, ts }
//   bg → us:  { type: 'content-gone' }     (last content script disconnected)
//   us → bg:  { type: 'send', text }       (forwarded to all WA content scripts)

export async function startWhatsAppCdpBridge({
  onIncoming,
  onLog    = () => {},
  onError  = () => {},
  onChatId = null,
  onState  = () => {},   // (state: 'attached' | 'detached') — UI indicator hook
} = {}) {
  let port = null;
  let stopped = false;
  let lastChat = null;
  let chatIdNotified = false;
  let attached = false;
  // Dedupe: only log + onState() callback on TRANSITIONS, not every
  // message arrival. SW idle cycles in MV3 cause the subscriber port
  // to disconnect/reconnect every ~30s; without this guard, every
  // cycle re-fires 'bridge ready' and clutters the UI log.
  let lastReportedState = null;
  function reportState(s) {
    if (lastReportedState === s) return;
    lastReportedState = s;
    if (s === 'attached')       onLog('whatsapp-cdp: bridge ready (content script in WA Web tab is connected)');
    else if (s === 'detached')  onLog('whatsapp-cdp: WA Web tab disconnected (close/reload to recover)');
    try { onState(s); } catch (_) {}
  }

  function connect() {
    if (stopped) return;
    try { port = chrome.runtime.connect({ name: 'egpt-wa-cdp-subscriber' }); }
    catch (e) { onError('whatsapp-cdp: connect failed: ' + (e?.message ?? e)); return; }

    port.onMessage.addListener(async (msg) => {
      if (!msg) return;
      if (msg.type === 'ready') {
        attached = true;
        reportState('attached');
        return;
      }
      if (msg.type === 'no-content') {
        // No web.whatsapp.com tab connected yet at the moment WE
        // (re)subscribed. If we'd been previously attached the user
        // closed/idled the tab; reflect that. If it's truly first
        // boot, this transitions us into the 'detached' state which
        // also lights the red indicator. 'ready' will arrive when
        // the tab + content script appear.
        attached = false;
        reportState('detached');
        return;
      }
      if (msg.type === 'content-gone') {
        attached = false;
        reportState('detached');
        return;
      }
      if (msg.type !== 'incoming') return;

      const wa = msg.wa ?? {};
      const text = msg.text ?? '';
      if (!text) return;

      lastChat = wa.chatId ?? lastChat;
      if (!chatIdNotified && onChatId && wa.chatId) {
        chatIdNotified = true;
        try { onChatId(wa.chatId); } catch (_) {}
      }

      const fromInfo = {
        chatId:    wa.chatId,
        userId:    wa.fromMe ? 'me' : (wa.chatId?.split('@')[0] ?? 'wa'),
        username:  null,
        firstName: wa.fromMe ? 'me' : (wa.chatId?.split('@')[0] ?? 'wa'),
        fromMe:    wa.fromMe,
        msgId:     wa.msgId,
      };
      try {
        if (typeof onIncoming === 'function') await onIncoming(text, fromInfo);
      } catch (err) {
        onError('whatsapp-cdp onIncoming threw: ' + (err?.message ?? err));
      }
    });

    port.onDisconnect.addListener(() => {
      port = null;
      attached = false;
      // SW idle / extension-reload cycle — rebuild the port shortly.
      // Don't mark detached here: the next port might reconnect
      // immediately and find a content script still alive. We only
      // transition to 'detached' if the new connect's first message
      // is 'no-content' / 'content-gone'.
      if (!stopped) setTimeout(connect, 1000);
    });
  }
  connect();
  onLog('whatsapp-cdp: subscribed (waiting for a web.whatsapp.com tab)');

  return {
    async send(text, { chatId } = {}) {
      if (!attached) {
        onError('whatsapp-cdp: no WA Web tab connected — open web.whatsapp.com');
        return;
      }
      if (chatId && lastChat && chatId !== lastChat) {
        onLog(`whatsapp-cdp: send target ${chatId} differs from active chat ${lastChat} — v1 sends to active only`);
      }
      try { port?.postMessage({ type: 'send', text }); }
      catch (e) { onError('whatsapp-cdp send: ' + (e?.message ?? e)); }
    },
    startStreamMessage: null,    // no edit-streaming in v1
    stop() {
      stopped = true;
      try { port?.disconnect(); } catch (_) {}
      port = null;
    },
    get chatId()      { return lastChat; },
    get myJid()       { return null; },
    get myNumber()    { return null; },
    get myLid()       { return null; },
    get myLidNumber() { return null; },
    get selfDmJid()   { return null; },
  };
}
