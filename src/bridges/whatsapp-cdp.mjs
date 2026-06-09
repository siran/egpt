// whatsapp-cdp.mjs — the WhatsApp LIMB over CDP DOM-control.
//
// Wraps the quarantined anchor layer (tools/wa-web-dom.mjs) in the interface
// the egpt host expects from a bridge: an onIncoming(text, from) afferent
// stream + a send() efferent, plus isAlive/stop. NO WhatsApp anatomy leaks past
// this file — `from.chatId` is an opaque handle (the chat JID from the
// notification), nothing baileys-shaped.
//
// INERT v1 (operator steer): this limb only DELIVERS incoming + SENDS when
// asked. Whether a reply is sent is the host's gate (src/auto-mode.mjs),
// unchanged. Agency (autoresponse/proactive) is future spine policy.
//
// Standalone dry-run of the full inert loop (limb → real gate → reply):
//   node src/bridges/whatsapp-cdp.mjs                       # dry-run: log gate decisions, no sends
//   WA_TEST_CHAT="Rodz" node src/bridges/whatsapp-cdp.mjs   # also LIVE-reply in that ONE chat
import { createWaWebDom } from '../tools/wa-web-dom.mjs';
import { mentionStatus } from '../auto-mode.mjs';

export async function startWhatsAppCdpBridge({
  onIncoming,
  onLog = () => {},
  port = 9221,
  allowedUsers = [],          // reserved; host gate is the primary control
} = {}) {
  const wa = createWaWebDom({ port, log: onLog });
  await wa.attach();

  // jid -> human chat name, learned from notifications, so send() can re-open
  // the chat by the name openChatByName uses.
  const _nameByJid = new Map();

  wa.onNewMessage(async (n) => {
    // n = { chatName, jid, preview, ts }. WA only notifies INCOMING — never our
    // own sends — so this is always someone else's message.
    if (n.chatName && n.jid) _nameByJid.set(n.jid, n.chatName);
    // Open the chat so it renders, then read the actual latest message (the
    // notification preview can be truncated / "Sender: text").
    let text = null, sender = null;
    const opened = await wa.openChatByName(n.chatName);
    if (opened) {
      const msgs = await wa.readLatest(1);
      const last = msgs[msgs.length - 1];
      if (last) { text = last.text; sender = last.sender; }
    }
    if (text == null) {
      // fallback: parse the notification preview "Sender: body"
      const m = String(n.preview || '').match(/^(.*?):\s*([\s\S]*)$/);
      if (m) { sender = m[1]; text = m[2]; } else { text = String(n.preview || ''); }
    }
    const chatType = String(n.jid || '').endsWith('@g.us') ? 'group' : 'private';
    const st = mentionStatus(text || '');
    // replyToBot stays FALSE for now (fail-closed): provable reply-to-persona
    // tracking (the _personaReplyIds model) is a follow-up. So v1 surfaces a
    // reply only on an explicit @e — strictly safe.
    const from = {
      chatId: n.jid,                 // opaque handle (JID)
      chatName: n.chatName,          // for reply routing (open-by-name)
      chatType,
      userId: n.jid,
      username: sender || undefined,
      firstName: sender || undefined,
      senderName: sender || null,
      authorized: true,              // operator's own account context; host gate still applies
      atEStart: st.atEStart,
      atEAnywhere: st.atEAnywhere,
      replyToBot: false,
      isReaction: false,
      isTranscriptFromVoice: false,
      msgKey: null,
    };
    try { await onIncoming?.(text, from); }
    catch (e) { onLog(`wa-cdp: onIncoming threw — ${e?.message ?? e}`); }
  });

  return {
    // Efferent. The host names the target by chatName (carried in `from`) or by
    // a jid we've learned. Opens that chat, then types + clicks send.
    async send(text, { chatId, chatName } = {}) {
      const name = chatName || (chatId && _nameByJid.get(chatId)) || null;
      if (!name) { onLog(`wa-cdp: send DROPPED — no chatName/known jid for ${chatId}`); return null; }
      const opened = await wa.openChatByName(name);
      if (!opened) { onLog(`wa-cdp: send DROPPED — could not open "${name}"`); return null; }
      const r = await wa.sendText(text);
      return r?.ok ? { ok: true, chatName: name } : null;
    },
    isAlive: () => wa.isAlive(),
    stop: () => wa.stop(),
    get chatId() { return null; },
  };
}

// ── standalone dry-run: limb → REAL auto-mode gate → (reply only in test chat) ──
if (process.argv[1]?.endsWith('whatsapp-cdp.mjs')) {
  const { replyAllowed: gateReplyAllowed, mayEmit, DEFAULT_AUTO_MODE } = await import('../auto-mode.mjs');
  const TEST_CHAT = process.env.WA_TEST_CHAT || null;   // the ONE chat we'll actually reply in
  const MODE = process.env.WA_MODE || DEFAULT_AUTO_MODE; // gate mode to simulate (default 'mention')
  console.log(`dry-run: mode=${MODE}  live-reply chat=${TEST_CHAT ? JSON.stringify(TEST_CHAT) : '(none — pure dry-run)'}`);
  const bridge = await startWhatsAppCdpBridge({
    onLog: (m) => console.log('  ', m),
    onIncoming: async (text, from) => {
      const status = { atEStart: from.atEStart, atEAnywhere: from.atEAnywhere, replyToBot: from.replyToBot };
      const allowed = gateReplyAllowed(MODE, status);
      const emit = mayEmit(MODE, { replyAllowed: allowed, isReaction: from.isReaction });
      console.log(`\n📨 [${from.chatName}] ${from.senderName}: ${JSON.stringify((text||'').slice(0,80))}`);
      console.log(`   gate: mode=${MODE} atE=${from.atEAnywhere} → replyAllowed=${allowed} mayEmit=${emit}`);
      if (emit) {
        if (TEST_CHAT && from.chatName === TEST_CHAT) {
          const reply = `🐶 e (cdp inert reply) ${new Date().toISOString().slice(11,19)}`;
          const r = await bridge.send(reply, { chatName: from.chatName });
          console.log(`   → LIVE replied to "${from.chatName}":`, JSON.stringify(r));
        } else {
          console.log(`   → WOULD reply (dry-run; not the test chat)`);
        }
      } else {
        console.log(`   → silent (gate)`);
      }
    },
  });
  console.log(`\nwatching 150s — @e-mention me from another contact (tab backgrounded). Ctrl+C to stop.`);
  setTimeout(() => { bridge.stop(); console.log('\n── dry-run done ──'); process.exit(0); }, 150000);
}
