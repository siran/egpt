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
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Durable limb log (the TUI's headless.log is frame-dumps, useless for tracing
// the daemon's WA activity). Mirrors what baileys had in wa-bridge.log.
const _CDP_LOG = join(homedir(), '.egpt', 'logs', 'wa-cdp.log');

export async function startWhatsAppCdpBridge(opts = {}) {
  // Drop-in for startBaileysBridge: accept the host's full opts object and use
  // what applies; ignore baileys-only knobs (media/awareness/maxBacklog/etc.).
  const {
    onIncoming,
    onLog: _onLog = () => {},
    port = 9221,
    cdpPort,                  // optional explicit override (whatsapp.cdp_port)
    allowedUsers = [],        // reserved; host gate is the primary control
  } = opts;
  // Combined logger: durable file + the host's onLog.
  const onLog = (m) => {
    try { appendFileSync(_CDP_LOG, `${new Date().toISOString()} ${m}\n`); } catch { /* ignore */ }
    try { _onLog(m); } catch { /* ignore */ }
  };
  const _port = cdpPort || port || 9221;
  onLog(`startWhatsAppCdpBridge: ENTRY (port=${_port})`);
  const wa = createWaWebDom({ port: _port, log: onLog });
  await wa.attach();
  onLog('attached + watcher arming');

  // Afferent: a DOM WATCHER on the chat list (NOT notifications — those are
  // focus/OS-gated and the operator turns them off). A chat whose unread badge
  // rises = new incoming. The chat NAME is the opaque handle here (the list
  // gives no JID); send()/open use the same name.
  wa.watchChatList(async (n) => {
    // n = { chatName, preview, unread }. Open the chat so it renders, read the
    // actual latest message (the list preview is truncated).
    let text = null, sender = null;
    const opened = await wa.openChatByName(n.chatName);
    if (opened) {
      const msgs = await wa.readLatest(1);
      const last = msgs[msgs.length - 1];
      if (last) { text = last.text; sender = last.sender; }
    }
    if (text == null) {
      const m = String(n.preview || '').match(/^(.*?):\s*([\s\S]*)$/);
      if (m) { sender = m[1]; text = m[2]; } else { text = String(n.preview || ''); }
    }
    const st = mentionStatus(text || '');
    // replyToBot stays FALSE for now (fail-closed): provable reply-to-persona
    // tracking is a follow-up. v1 surfaces a reply only on an explicit @e.
    const from = {
      chatId: n.chatName,            // opaque handle = chat name (no JID from list)
      chatName: n.chatName,
      chatType: 'private',           // TODO detect group from opened chat
      userId: n.chatName,
      username: sender || undefined,
      firstName: sender || undefined,
      senderName: sender || null,
      authorized: true,              // host gate is the real control
      atEStart: st.atEStart,
      atEAnywhere: st.atEAnywhere,
      replyToBot: false,
      isReaction: false,
      isTranscriptFromVoice: false,
      msgKey: null,
    };
    onLog(`wa-cdp: incoming [${n.chatName}] ${sender}: ${JSON.stringify((text || '').slice(0, 60))} (atE=${st.atEAnywhere})`);
    try { await onIncoming?.(text, from); }
    catch (e) { onLog(`wa-cdp: onIncoming threw — ${e?.message ?? e}`); }
  });

  return {
    // Efferent. The host names the target by chatName (carried in `from`) or by
    // a jid we've learned. Opens that chat, then types + clicks send.
    async send(text, { chatId, chatName } = {}) {
      const name = chatName || chatId || null;   // chatId IS the chat name (watcher handle)
      if (!name) { onLog(`wa-cdp: send DROPPED — no chat name for ${chatId}`); return null; }
      const opened = await wa.openChatByName(name);
      if (!opened) { onLog(`wa-cdp: send DROPPED — could not open "${name}"`); return null; }
      const r = await wa.sendText(text);
      return r?.ok ? { ok: true, chatName: name } : null;
    },
    // Non-streaming shim for the host's persona-reply path (streamFactory →
    // makeStream → startStreamMessage). The host's gate has ALREADY decided
    // this reply may emit (streamFactory returns null otherwise), so here we
    // just deliver: ignore the intermediate update() frames (no edit-spam on a
    // social surface) and send the FINAL text on finish(). Streaming/edit is a
    // future nicety; inert v1 sends once. chatId(jid)→name via the learned map.
    startStreamMessage(initialText, { chatId, chatName, persona } = {}) {
      const name = chatName || chatId || null;   // chatId IS the chat name
      let latest = initialText, finished = false, delivered = false, lastError = null;
      const deliver = async (text) => {
        if (text != null) latest = text;
        if (!name) { lastError = 'no target chat'; onLog(`wa-cdp: stream DROPPED — no name for ${chatId}`); return; }
        const opened = await wa.openChatByName(name);
        if (!opened) { lastError = `open failed (${name})`; return; }
        const r = await wa.sendText(latest);
        delivered = !!r?.ok; if (!delivered) lastError = 'send failed';
      };
      return {
        update(text) { if (!finished && text != null) latest = text; },
        async finish(text) { if (finished) return; finished = true; await deliver(text); },
        async cancel() { finished = true; },   // gate said no / silence → never sent
        get delivered() { return delivered; },
        get lastError() { return lastError; },
      };
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
