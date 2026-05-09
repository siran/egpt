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
} = {}) {
  let port = null;
  let stopped = false;
  let lastChat = null;
  let chatIdNotified = false;
  let attached = false;

  function connect() {
    if (stopped) return;
    try { port = chrome.runtime.connect({ name: 'egpt-wa-cdp-subscriber' }); }
    catch (e) { onError('whatsapp-cdp: connect failed: ' + (e?.message ?? e)); return; }

    port.onMessage.addListener(async (msg) => {
      if (!msg) return;
      if (msg.type === 'ready') {
        if (!attached) {
          attached = true;
          onLog('whatsapp-cdp: bridge ready (content script in WA Web tab is connected)');
        }
        return;
      }
      if (msg.type === 'no-content') {
        // No web.whatsapp.com tab open yet — wait silently. The
        // background will send 'ready' the moment a content script
        // connects.
        return;
      }
      if (msg.type === 'content-gone') {
        attached = false;
        onLog('whatsapp-cdp: WA Web tab closed (content script disconnected)');
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
      // Background may have idled (MV3 service worker lifecycle); rebuild
      // the port shortly. Idempotent — content scripts stay connected to
      // background across SW cycles via their own reconnect logic.
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
