// extension/src/bridges/whatsapp-cdp.js — drive web.whatsapp.com via CDP.
//
// The browser-side counterpart to bridges/whatsapp.mjs (which uses the
// Node-only baileys library). When this bridge is configured, the
// extension can mirror to/from WhatsApp without a shell. baileys is not
// involved.
//
// v1 scope (KISS):
//   - Single-chat: receives + sends in the *currently-active* chat
//     (whichever one is open in WA Web). Multi-chat listening (chat
//     list scrape / Store hook) is v2.
//   - Buffered send (no edit-streaming yet).
//   - Reuses bridges/whatsapp-classify.mjs for self-DM / observed
//     classification — the host call stays identical to the Node
//     bridge's host call.
//
// Transport: a long-lived WebSocket to the WA Web tab's CDP target.
// Inject a MutationObserver that emits new-message events via
// console.log('egpt-wa-cdp', JSON.stringify(...)) (same pattern as
// tools/bus.mjs uses for the bus tab); we subscribe to
// Runtime.consoleAPICalled and route events to onIncoming.
//
// Selectors are heuristic and will drift as WA Web ships UI changes.
// They're all in OBSERVE_SCRIPT and SEND_SCRIPT below — pin updates
// in one place when the bundle moves.

import * as cdp from '../../../tools/cdp.mjs';

// Inject script: install once per tab, scan existing messages to
// populate the "seen" set so we don't replay history, then watch
// for DOM mutations and emit new messages over console.log.
const OBSERVE_SCRIPT = `
(() => {
  if (window.__egptWaCdpInstalled) return 'already';
  window.__egptWaCdpInstalled = true;

  const seen = new Set();
  const emit = (ev) => {
    try { console.log('egpt-wa-cdp', JSON.stringify(ev)); } catch (_) {}
  };

  // WhatsApp Web's message rows expose data-id="<fromMe>_<chatJid>_<msgId>".
  // The JID can itself contain '_' (group ids), so split and reassemble.
  const parseDataId = (id) => {
    if (!id) return null;
    const parts = id.split('_');
    if (parts.length < 3) return null;
    const fromMe = parts[0] === 'true';
    const msgId = parts[parts.length - 1];
    const chatJid = parts.slice(1, -1).join('_');
    return { fromMe, chatJid, msgId };
  };

  const textOf = (row) => {
    // copyable-text holds the visible body for both incoming and outgoing
    // messages; prefer that over generic descendants.
    const el = row.querySelector('.copyable-text, [class*="copyable-text"]');
    if (!el) return '';
    return (el.innerText || '').trim();
  };

  const scan = () => {
    const rows = document.querySelectorAll('[data-id]');
    for (const row of rows) {
      const id = row.getAttribute('data-id');
      if (seen.has(id)) continue;
      const parsed = parseDataId(id);
      if (!parsed) { seen.add(id); continue; }
      const text = textOf(row);
      if (!text) { seen.add(id); continue; }
      seen.add(id);
      emit({
        type: 'message',
        chatId: parsed.chatJid,
        fromMe: parsed.fromMe,
        msgId: parsed.msgId,
        text,
        ts: Date.now(),
      });
    }
  };

  // Initial scan: silence existing messages so a fresh subscribe
  // doesn't flood with history.
  document.querySelectorAll('[data-id]').forEach(r => seen.add(r.getAttribute('data-id')));

  const observer = new MutationObserver(() => scan());
  observer.observe(document.body, { childList: true, subtree: true });

  emit({ type: 'ready', ts: Date.now() });
  return 'installed';
})()
`;

// Send script: locate the chat input and the send button, type the text
// via execCommand insertText (so WA's React state updates), click send.
// Returns { ok, error? } via returnByValue.
function buildSendScript(text) {
  return `
(() => {
  const input = document.querySelector('div[contenteditable="true"][data-tab="10"]')
             || document.querySelector('footer div[contenteditable="true"]')
             || document.querySelector('div[contenteditable="true"][role="textbox"]');
  if (!input) return { ok: false, error: 'WA Web input not found — is a chat open?' };
  input.focus();
  // Clear any existing draft.
  document.execCommand('selectAll', false, null);
  document.execCommand('delete',    false, null);
  document.execCommand('insertText', false, ${JSON.stringify(text)});
  // Send button: try a few shapes; modern WA uses span[data-icon="wds-ic-send-filled"]
  // wrapped in a button.
  const sendBtn = document.querySelector('button[aria-label*="Send" i]')
               || document.querySelector('span[data-icon="send"]')?.closest('button')
               || document.querySelector('span[data-icon="wds-ic-send-filled"]')?.closest('button');
  if (sendBtn) { sendBtn.click(); return { ok: true }; }
  // Fallback: simulate Enter.
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  return { ok: true, fallback: 'enter-key' };
})()
`;
}

// One-shot Runtime.evaluate over a fresh WS — same pattern as
// peekTab in tools/cdp.mjs but exported under our own helper because
// peekTab assumes the result is a string.text.
async function evalOnce(targetId, expression, timeoutMs = 5000) {
  const tab = await cdp.findTab(targetId);
  if (!tab) throw new Error(`WA tab ${(targetId ?? '?').slice(0, 8)}… not found`);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    const tmo = setTimeout(() => {
      try { ws.close(); } catch (_) {}
      reject(new Error('eval timeout'));
    }, timeoutMs);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        id: 1, method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true },
      }));
    });
    ws.addEventListener('message', (e) => {
      let data;
      try { data = JSON.parse(e.data.toString()); } catch { return; }
      if (data.id === 1) {
        clearTimeout(tmo);
        try { ws.close(); } catch (_) {}
        if (data.error) reject(new Error(data.error.message));
        else resolve(data.result?.result?.value);
      }
    });
    ws.addEventListener('error', () => { clearTimeout(tmo); reject(new Error('CDP error')); });
  });
}

export async function startWhatsAppCdpBridge({
  targetId,
  onIncoming,
  onLog    = () => {},
  onError  = () => {},
  onChatId = null,
} = {}) {
  if (!targetId) throw new Error('startWhatsAppCdpBridge: targetId required (the web.whatsapp.com tab)');

  // Verify target exists + is a WA Web tab. Minimal check; the full
  // login-state probe is left to the user (open the tab manually,
  // confirm chats are visible, then enable the bridge).
  const tab = await cdp.findTab(targetId);
  if (!tab) throw new Error(`WA tab ${targetId.slice(0, 8)}… not found`);
  if (!/web\.whatsapp\.com/.test(tab.url ?? '')) {
    throw new Error(`tab is not on web.whatsapp.com (url=${tab.url})`);
  }
  onLog('whatsapp-cdp: attaching to ' + tab.url);

  // Install the observer script in the page. evalOnce surfaces the
  // most common WS-open failures (CDP origin restriction, chrome was
  // started without --remote-allow-origins=*, target won't accept WS
  // attach) with a single actionable error before we open the long-
  // lived subscriber socket.
  try {
    await evalOnce(targetId, OBSERVE_SCRIPT);
  } catch (e) {
    throw new Error(
      `attach failed (${e.message}). ` +
      `Make sure Chrome was started with --remote-allow-origins=* ` +
      `(the /chrome command does this; manual launches must include it). ` +
      `Tab URL: ${tab.url}`
    );
  }

  // Long-lived WS for incoming events. Subscribes to
  // Runtime.consoleAPICalled and dispatches messages tagged 'egpt-wa-cdp'.
  const subscribedAt = Date.now() - 1000;
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let stopped = false;
  let lastChat = null;
  let chatIdNotified = false;
  let everConnected = false;
  // Echo suppression: track msgIds of messages we sent so the
  // observer's fromMe=true echo doesn't re-enter the host as a fresh
  // incoming message.
  const _sentMsgIds = new Set();

  ws.addEventListener('open', () => {
    everConnected = true;
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
    onLog('whatsapp-cdp: bridge ready (single-chat mode — open the chat you want monitored)');
  });

  ws.addEventListener('message', async (e) => {
    let data;
    try { data = JSON.parse(e.data.toString()); } catch { return; }
    if (data.method !== 'Runtime.consoleAPICalled') return;
    const cdpTs = data.params?.timestamp;
    if (typeof cdpTs === 'number' && cdpTs < subscribedAt) return;
    const args = data.params?.args ?? [];
    if (args[0]?.value !== 'egpt-wa-cdp') return;
    const raw = args[1]?.value;
    if (typeof raw !== 'string') return;
    let ev;
    try { ev = JSON.parse(raw); } catch { return; }

    if (ev.type === 'ready') return;
    if (ev.type !== 'message') return;
    if (ev.fromMe && _sentMsgIds.has(ev.msgId)) {
      _sentMsgIds.delete(ev.msgId);
      return;
    }

    lastChat = ev.chatId;
    if (!chatIdNotified && onChatId) {
      // Only auto-capture self-DMs as the canonical chat_id.
      // We don't have phone+LID context here without a richer probe,
      // so the host-side classifier still does the validating check
      // before persisting (see bridges/whatsapp-classify.mjs).
      chatIdNotified = true;
      try { onChatId(ev.chatId); } catch (_) {}
    }

    const fromInfo = {
      chatId:    ev.chatId,
      userId:    ev.fromMe ? 'me' : ev.chatId.split('@')[0],
      username:  null,
      firstName: ev.fromMe ? 'me' : ev.chatId.split('@')[0],
      fromMe:    ev.fromMe,
      msgId:     ev.msgId,
    };
    try {
      if (typeof onIncoming === 'function') await onIncoming(ev.text, fromInfo);
    } catch (err) {
      onError('onIncoming threw: ' + (err?.message ?? err));
    }
  });

  ws.addEventListener('error', () => {
    // The browser console will already have logged the WS error in
    // detail; surface a single concise line for the user. If we never
    // even connected, this is almost always the --remote-allow-origins
    // issue — say so explicitly.
    if (!everConnected) {
      onError('whatsapp-cdp: WS attach failed before connect — check Chrome was started with --remote-allow-origins=*');
    } else {
      onError('whatsapp-cdp: WS error mid-stream');
    }
  });
  ws.addEventListener('close', () => {
    if (!stopped) onLog('whatsapp-cdp: WS closed (tab gone? login expired?)');
  });

  return {
    async send(text, { chatId } = {}) {
      // v1: doesn't switch chats — sends to whatever's open. The chatId
      // arg is recorded for future multi-chat support but ignored now.
      // (Mismatch warning surfaces in the log so the user notices.)
      if (chatId && lastChat && chatId !== lastChat) {
        onLog(`whatsapp-cdp: send target ${chatId} differs from active chat ${lastChat} — v1 sends to active only`);
      }
      try {
        const r = await evalOnce(targetId, buildSendScript(text));
        if (!r?.ok) throw new Error(r?.error ?? 'send failed (no detail)');
        // We don't get the new msgId back from execCommand. Future
        // refinement: read it off the most-recent fromMe row after
        // a short delay and rememberSent it. For v1, accept that the
        // observer may briefly re-emit our own messages (host-side
        // dedup via classifier+chat_id will handle it gracefully).
      } catch (err) {
        onError('whatsapp-cdp send: ' + (err?.message ?? err));
        throw err;
      }
    },
    // No edit-streaming in v1. Keep the symbol in case host code probes.
    startStreamMessage: null,
    stop() {
      stopped = true;
      try { ws.close(); } catch (_) {}
    },
    get chatId() { return lastChat; },
    // The Node bridge exposes phone + LID getters; the CDP bridge
    // doesn't have those without a richer page probe. Returning null
    // means classifyWhatsAppChat falls back to chat_id + egpt_chats[]
    // for the egpt-chat decision — adequate for v1.
    get myJid()       { return null; },
    get myNumber()    { return null; },
    get myLid()       { return null; },
    get myLidNumber() { return null; },
    get selfDmJid()   { return null; },
  };
}
