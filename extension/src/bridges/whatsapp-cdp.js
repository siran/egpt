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
  // Callback resolving the currently-bound chat name (e.g., from a
  // /join binding in App.jsx). Called per send() to pick the target;
  // explicit opts.chatName takes precedence. Returning null/undefined
  // falls through to whatsapp_cdp.chat_name in background.
  getActiveChat = () => null,
} = {}) {
  let port = null;
  let stopped = false;
  let lastChat = null;
  let chatIdNotified = false;
  let attached = false;
  // Dedupe + debounce. SW idle cycles in MV3 disconnect/reconnect
  // every ~30s; on each reconnect the subscriber port briefly sees
  // 'no-content' before the content port catches up and 'ready'
  // arrives. Without debouncing, every cycle fires a detached →
  // attached log pair and clutters the UI.
  //
  // Strategy: 'attached' is logged immediately on transition; 'detached'
  // is delayed by DETACHED_DEBOUNCE_MS — if 'attached' arrives within
  // that window, we cancel the pending log and don't transition.
  let lastReportedState = null;
  let pendingDetachedTimer = null;
  const DETACHED_DEBOUNCE_MS = 3_000;

  function reportState(s) {
    if (s === 'attached') {
      if (pendingDetachedTimer) { clearTimeout(pendingDetachedTimer); pendingDetachedTimer = null; }
      if (lastReportedState === 'attached') return;
      lastReportedState = 'attached';
      onLog('whatsapp-cdp: bridge ready (content script in WA Web tab is connected)');
      try { onState('attached'); } catch (_) {}
      return;
    }
    if (s === 'detached') {
      if (lastReportedState === 'detached') return;
      if (pendingDetachedTimer) return;   // already pending
      pendingDetachedTimer = setTimeout(() => {
        pendingDetachedTimer = null;
        if (lastReportedState === 'detached') return;
        lastReportedState = 'detached';
        onLog('whatsapp-cdp: WA Web tab disconnected (close/reload to recover)');
        try { onState('detached'); } catch (_) {}
      }, DETACHED_DEBOUNCE_MS);
    }
  }

  // Pending /channels requests, keyed by a per-call requestId. Each
  // resolves when the matching 'channels-list' response arrives.
  const _channelRequests = new Map();
  // Pending send() calls — same shape, keyed by the requestId we
  // attach to each outbound 'send'. Background acks (or errors) with
  // the matching requestId once sendToFirstWaTab settles, so the
  // caller's await actually reflects whether WA received the message
  // (instead of just whether postMessage delivered to the SW).
  const _sendRequests = new Map();
  let _nextRequestId = 1;
  const SEND_TIMEOUT_MS = 30_000;

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
      if (msg.type === 'channels-list') {
        const pending = _channelRequests.get(msg.requestId);
        if (pending) {
          _channelRequests.delete(msg.requestId);
          pending.resolve(msg.chats ?? []);
        }
        return;
      }
      if (msg.type === 'send-ack') {
        const p = _sendRequests.get(msg.requestId);
        if (p) { _sendRequests.delete(msg.requestId); p.resolve(msg.status ?? 'ok'); }
        return;
      }
      if (msg.type === 'send-error') {
        const err = String(msg.error ?? 'send failed');
        const p = _sendRequests.get(msg.requestId);
        if (p) {
          _sendRequests.delete(msg.requestId);
          p.reject(new Error(err));
        } else {
          // No matching pending — most likely a legacy/race ack from
          // an earlier session. Surface so it isn't silently swallowed.
          onError('whatsapp-cdp send: ' + err);
        }
        return;
      }
      if (msg.type !== 'incoming') return;

      const wa = msg.wa ?? {};
      const text = msg.text ?? '';
      if (!text) return;

      // Defensive max-age. Lower layers (content-script `seen` set,
      // history-grace ts filter, queue-drain age cap) already prevent
      // stale messages from reaching here, but if any path slips one
      // through — e.g. the brain dispatch queue blocked for several
      // minutes on a slow brain and the message tail is now stale —
      // drop it instead of dispatching. The ts is when wa-content
      // scraped the row from DOM (Date.now() at scrape).
      const MAX_DISPATCH_AGE_MS = 90_000;
      if (msg.ts && (Date.now() - msg.ts) > MAX_DISPATCH_AGE_MS) {
        onLog(`whatsapp-cdp: dropping stale '${text.slice(0, 40)}…' (${Math.round((Date.now() - msg.ts) / 1000)}s old)`);
        return;
      }

      lastChat = wa.chatId ?? lastChat;
      if (!chatIdNotified && onChatId && wa.chatId) {
        chatIdNotified = true;
        try { onChatId(wa.chatId); } catch (_) {}
      }

      // author scraped by the content script from data-pre-plain-text
      // (WA Web's per-message attribution attribute). Falls through to
      // chatId-derived placeholder when missing (rare — WA usually
      // includes it on every rendered row).
      const fromInfo = {
        chatId:    wa.chatId,
        userId:    wa.fromMe ? 'me' : (wa.chatId?.split('@')[0] ?? 'wa'),
        username:  null,
        firstName: wa.author ?? (wa.fromMe ? 'me' : (wa.chatId?.split('@')[0] ?? 'wa')),
        author:    wa.author ?? null,
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
    async send(text, { chatId, chatName, chatJid } = {}) {
      if (!attached) {
        const err = new Error('whatsapp-cdp: no WA Web tab connected — open web.whatsapp.com');
        onError(err.message);
        throw err;
      }
      // Resolution order: explicit opts (jid/name) → active /join
      // binding via getActiveChat() → null (background sends to
      // whatever's currently active in WA Web). JID + name are paired
      // so the receive end can match by JID first (stable across
      // chat-list reorders), name as fallback.
      let resolvedName = chatName ?? null;
      let resolvedJid  = chatJid  ?? null;
      if (!resolvedName && !resolvedJid) {
        try {
          const active = getActiveChat();
          if (active && typeof active === 'object') {
            resolvedJid  = active.jid  ?? null;
            resolvedName = active.name ?? null;
          } else if (typeof active === 'string') {
            resolvedName = active;
          }
        } catch (_) {}
      }
      const requestId = _nextRequestId++;
      const promise = new Promise((resolve, reject) => {
        const tmo = setTimeout(() => {
          if (_sendRequests.has(requestId)) {
            _sendRequests.delete(requestId);
            reject(new Error(`send timed out after ${SEND_TIMEOUT_MS}ms (no ack from background)`));
          }
        }, SEND_TIMEOUT_MS);
        _sendRequests.set(requestId, {
          resolve: (v) => { clearTimeout(tmo); resolve(v); },
          reject:  (e) => { clearTimeout(tmo); reject(e); },
        });
      });
      try {
        port?.postMessage({ type: 'send', requestId, text, chatName: resolvedName, chatJid: resolvedJid });
      } catch (e) {
        _sendRequests.delete(requestId);
        const err = new Error('whatsapp-cdp send: ' + (e?.message ?? e));
        onError(err.message);
        throw err;
      }
      return promise;
    },
    /** Scrape the WA Web chat list. Resolves with [{ name, preview }, ...]. */
    async listChannels({ limit = 20, timeoutMs = 5_000 } = {}) {
      if (!attached) throw new Error('no WA Web tab connected');
      if (!port) throw new Error('subscriber port not open');
      const requestId = _nextRequestId++;
      return new Promise((resolve, reject) => {
        const tmo = setTimeout(() => {
          _channelRequests.delete(requestId);
          reject(new Error('listChannels timed out'));
        }, timeoutMs);
        _channelRequests.set(requestId, {
          resolve: (chats) => { clearTimeout(tmo); resolve(chats); },
          reject:  (e)     => { clearTimeout(tmo); reject(e); },
        });
        try { port.postMessage({ type: 'list-channels', requestId, limit }); }
        catch (e) {
          _channelRequests.delete(requestId);
          clearTimeout(tmo);
          reject(e);
        }
      });
    },
    startStreamMessage: null,    // no edit-streaming in v1
    stop() {
      stopped = true;
      try { port?.disconnect(); } catch (_) {}
      port = null;
      for (const p of _channelRequests.values()) p.reject(new Error('bridge stopped'));
      _channelRequests.clear();
      for (const p of _sendRequests.values()) p.reject(new Error('bridge stopped'));
      _sendRequests.clear();
    },
    get chatId()      { return lastChat; },
    get myJid()       { return null; },
    get myNumber()    { return null; },
    get myLid()       { return null; },
    get myLidNumber() { return null; },
    get selfDmJid()   { return null; },
  };
}
