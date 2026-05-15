// slash/oracle.mjs — summon a long-running "Oracle" in a WA chat.
//
// The Oracle is a self-editing message that spins indefinitely
// (mystical starfield, hypnotic). Anyone in the chat can reply
// to it with a question; the bridge intercepts the reply, routes
// the question through a brain (default @e), and edits a
// "🔮 thinking…" reply-to-the-question into the brain's answer.
// The spinner retires after answering. Two messages remain: the
// question, and the answer (as a reply to the question).
//
// Multiple Oracles can run in parallel across chats. While the
// brain is processing a question, subsequent replies trigger the
// busy_behavior path:
//   polite   reply "🔮 one query at a time, please" to the new
//            question (default)
//   ignore   silently drop the new reply
//   queued   (pending — answer them in order)

// Five-frame mystical starfield. WA monospace block (```) preserves
// whitespace so the column positions hold across edits.
const ORACLE_FRAMES = (() => {
  const panels = [
    [
      '·  ⋆  .  ✦  .  ⋆  ·',
      ' .  ✦  .  ⋆  .  ✦ ',
      '⋆  .  ✦  🔮 ✦  .  ⋆',
      ' .  ✦  .  ⋆  .  ✦ ',
      '·  ⋆  .  ✦  .  ⋆  ·',
    ],
    [
      '⋆  .  ✦  .  ⋆  .  ✦',
      ' .  ⋆  ✦  .  ✦  ⋆ ',
      '.  ✦  ⋆  🔮 ⋆  ✦  .',
      ' .  ⋆  ✦  .  ✦  ⋆ ',
      '⋆  .  ✦  .  ⋆  .  ✦',
    ],
    [
      '✦  .  ⋆  ·  ⋆  .  ✦',
      ' ⋆  ✦  ·  .  ·  ✦ ',
      '.  ·  ⋆  🔮 ⋆  ·  .',
      ' ⋆  ✦  ·  .  ·  ✦ ',
      '✦  .  ⋆  ·  ⋆  .  ✦',
    ],
    [
      '.  ⋆  ✦  ⋆  ✦  ⋆  .',
      ' ✦  .  ⋆  .  ⋆  . ',
      '·  ⋆  .  🔮 .  ⋆  ·',
      ' ✦  .  ⋆  .  ⋆  . ',
      '.  ⋆  ✦  ⋆  ✦  ⋆  .',
    ],
  ];
  return panels.map(p =>
    '🔮 *The Oracle* 🧞\n\n' +
    '```\n' + p.join('\n') + '\n```\n\n' +
    '_reply with your question_',
  );
})();

export const meta = {
  cmd: '/oracle',
  section: 'ROOM',
  surface: 'shell',
  usage: '/oracle @waN | /oracle stop [@waN] | /oracle list',
  desc:
    'summon a mystical Oracle in a WA chat. Anyone in the chat can ' +
    'reply to it with a question; the brain answers as a reply, the ' +
    'spinner retires. Multiple Oracles run in parallel across chats. ' +
    '/oracle stop @waN retires one; /oracle stop retires all.',
};

export async function run({ arg, ctx }) {
  // ctx keys consumed:
  //   sysOut(text)
  //   waBridgeRef          — WA bridge (exposes startOracle, stopOracle, listOracles, replyTo)
  //   waChannelsCacheRef   — @waN → chat object
  //   computeBrainTurn(routedTo, question) → answer text (compute-only,
  //                          no UI mirroring)
  //   sessions             — to validate the configured brain exists
  //   EGPT_CONFIG          — oracle.brain + oracle.busy_behavior
  const { sysOut, waBridgeRef, waChannelsCacheRef, computeBrainTurn, sessions, EGPT_CONFIG } = ctx;

  const wa = waBridgeRef?.current;
  if (!wa?.startOracle) {
    sysOut('!! /oracle: whatsapp bridge not running');
    return true;
  }

  const tokens = arg.trim().split(/\s+/).filter(Boolean);
  const sub = tokens[0];

  if (sub === 'stop') {
    const targetTok = tokens[1];
    if (!targetTok) {
      const n = await wa.stopAllOracles();
      sysOut(n ? `🔮 retired ${n} oracle${n === 1 ? '' : 's'}` : '🔮 no oracles running');
      return true;
    }
    const m = targetTok.match(/^@wa(\d+)$/i);
    if (!m) { sysOut(`!! /oracle stop: "${targetTok}" isn't @waN`); return true; }
    const chat = waChannelsCacheRef?.current?.[parseInt(m[1], 10) - 1];
    if (!chat) { sysOut(`!! /oracle stop: no chat at ${targetTok}`); return true; }
    const stopped = await wa.stopOracle(chat.jid);
    sysOut(stopped ? `🔮 retired oracle in "${chat.name}"` : `🔮 no oracle in "${chat.name}"`);
    return true;
  }

  if (sub === 'list' || !sub) {
    const list = wa.listOracles?.() ?? [];
    if (!list.length) {
      sysOut('🔮 no oracles running. summon one with /oracle @waN');
      return true;
    }
    const lines = list.map((o, i) => `  ${i + 1}. "${o.name ?? o.chatId}"  (${o.state})`);
    sysOut(`🔮 ${list.length} oracle${list.length === 1 ? '' : 's'} running:\n${lines.join('\n')}`);
    return true;
  }

  // Summon: /oracle @waN
  const m = sub.match(/^@wa(\d+)$/i);
  if (!m) {
    sysOut(`!! /oracle: usage: ${meta.usage}`);
    return true;
  }
  const idx = parseInt(m[1], 10) - 1;
  const chat = waChannelsCacheRef?.current?.[idx];
  if (!chat) {
    sysOut(`!! /oracle: no chat at ${sub} — /recap or /channels first to populate indices`);
    return true;
  }

  // Brain selection — config-driven, with 'e' as the universal default.
  const brainName = EGPT_CONFIG?.oracle?.brain ?? 'e';
  if (!sessions[brainName]) {
    sysOut(`!! /oracle: brain "${brainName}" not in current room. /attach it first, or set oracle.brain in config.`);
    return true;
  }
  const busyBehavior = EGPT_CONFIG?.oracle?.busy_behavior ?? 'polite';
  const frameMs = Number(EGPT_CONFIG?.oracle?.frame_ms) || 1000;

  const handle = await wa.startOracle({
    chatId: chat.jid,
    frames: ORACLE_FRAMES,
    frameMs,
    onReply: async (replyMsg /*, oracle */) => {
      // Extract the question via the bridge's textOf (already imported
      // inside the bridge module; we get the body string off the msg).
      // The bridge's contextInfo decoder set msg.message; we read the
      // user-visible part the same way handleMessage would.
      const question = _extractQuestion(replyMsg);
      if (!question) return;
      // Send "🔮 thinking…" as a reply to the question; capture key.
      const thinking = await wa.replyTo({
        chatId: chat.jid,
        key: replyMsg.key,
        raw: replyMsg.message,
        text: '🔮 thinking…',
      });
      const answer = await computeBrainTurn(brainName, question);
      const finalText = `🔮 ${answer || '(silence)'}`;
      if (thinking?.key) {
        // Edit the thinking placeholder into the final answer.
        await wa.editMessage?.({ chatId: chat.jid, key: thinking.key, text: finalText });
      } else {
        // Fallback: fresh reply-send (thinking placeholder failed).
        await wa.replyTo({ chatId: chat.jid, key: replyMsg.key, raw: replyMsg.message, text: finalText });
      }
    },
    onBusy: async (replyMsg /*, oracle */) => {
      if (busyBehavior === 'ignore' || busyBehavior === 'queued') return;
      // polite (default) — reply to the new question.
      await wa.replyTo({
        chatId: chat.jid,
        key: replyMsg.key,
        raw: replyMsg.message,
        text: '🔮 one query at a time, please',
      });
    },
  });
  if (!handle) {
    sysOut(`!! /oracle: bridge returned no handle — initial send may have failed`);
    return true;
  }
  sysOut(`🔮 oracle summoned in @wa${m[1]} "${chat.name}"  (brain: @${brainName}, busy: ${busyBehavior})`);
  return true;
}

// Pull a user-visible question string out of a baileys message. We
// can't import bridges/whatsapp.mjs's internal textOf from here, so
// re-implement the small subset we need: conversation, extended
// text, and the few captioned variants. Reaction / sticker /
// status replies aren't actual questions, so we return null and
// the oracle just ignores them.
function _extractQuestion(msg) {
  const m = msg?.message ?? {};
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.ephemeralMessage?.message?.conversation) return m.ephemeralMessage.message.conversation;
  if (m.ephemeralMessage?.message?.extendedTextMessage?.text) return m.ephemeralMessage.message.extendedTextMessage.text;
  return null;
}
