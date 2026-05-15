// tools/genie.mjs — genie/oracle summon helper, shared between
// the /oracle slash command (operator types it from the shell) and
// the WA bridge's '@?' wake-word (someone types '@?' inside a
// chat and the bridge summons a genie there).
//
// The animation frames + onReply / onBusy callbacks live here so
// both summon paths render the same way. The caller passes the
// bridge handle + brain-dispatch closure + a sysOut for shell
// echo; everything else (frame phases, wish counting, retire
// orchestration) is encapsulated.

const SUMMON_FRAMES = [
  '🍾',
  '🍾  _the bottle shudders…_',
  '🍾  💨',
  '🍾💨💨',
  '💨💨💨',
  '✨💨💨💨✨',
  '🧞  _emerging…_',
];

const THINKING_FRAMES = [
  '🍾  *consulting the books*  📖',
  '🍾  *consulting the books*  📚',
  '🍾  *taking notes*  📝',
  '🍾  *cross-referencing*  📜',
  '🍾  *almost there…*  💡',
];

const RETIRE_FRAMES = [
  '🧞  _your wishes are spent._',
  '🧞  _farewell._  👋',
  '💨',
  '🍾',
  '_(the bottle is empty)_',
];

function idleFrames(N) {
  const wishes = N === 1 ? '1 wish' : `${N} wishes`;
  return [
    `🧞  *${wishes} remaining*\n\n_reply with your question_`,
    ` 🧞   *${wishes} remaining*\n\n_reply with your question_`,
    `🧞   *${wishes} remaining*\n\n_reply with your question_`,
    ` 🧞  *${wishes} remaining*\n\n_reply with your question_`,
  ];
}

function _extractQuestion(msg) {
  const m = msg?.message ?? {};
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.ephemeralMessage?.message?.conversation) return m.ephemeralMessage.message.conversation;
  if (m.ephemeralMessage?.message?.extendedTextMessage?.text) return m.ephemeralMessage.message.extendedTextMessage.text;
  return null;
}

/**
 * Summon a genie in a WA chat.
 *
 * @param {object} opts
 * @param {object} opts.wa                bridge instance (waBridgeRef.current)
 * @param {string} opts.chatId            target chat JID
 * @param {string} opts.chatName          display name of the chat (for shell echoes)
 * @param {number} opts.questionsLeft     wish budget
 * @param {string} opts.brainName         session name to route through (e.g. 'e')
 * @param {function} opts.computeBrainTurn  (brainName, question) → answer text
 * @param {function} opts.sysOut          shell echo function
 * @param {string} opts.busyBehavior      'polite' | 'ignore' | 'queued'
 * @param {number} opts.frameMs           per-frame edit delay
 * @returns {Promise<object|null>} the bridge oracle handle, or null on failure
 */
export async function summonGenie({
  wa,
  chatId,
  chatName,
  questionsLeft = 1,
  brainName = 'e',
  computeBrainTurn,
  sysOut,
  busyBehavior = 'polite',
  frameMs = 3000,
}) {
  if (!wa?.startOracle) return null;
  return wa.startOracle({
    chatId,
    frameMs,
    questionsLeft,
    phases: {
      summon:   SUMMON_FRAMES,
      thinking: THINKING_FRAMES,
      retire:   RETIRE_FRAMES,
      idleFn:   idleFrames,
    },
    onReply: async (replyMsg, oracle) => {
      const question = _extractQuestion(replyMsg);
      if (!question) return;
      const asker = replyMsg.pushName?.trim() || (replyMsg.key?.fromMe ? 'You' : '?');
      sysOut?.(`🧞 [${chatName}] ${asker} → ${question}`);
      const thinking = await wa.replyTo({
        chatId,
        key: replyMsg.key,
        raw: replyMsg.message,
        text: '🧞 thinking…',
      });
      const answer = await computeBrainTurn(brainName, question);
      const wishesAfter = Math.max(0, (oracle?.questionsLeft ?? questionsLeft) - 1);
      const footer = wishesAfter > 0
        ? `\n\n_${wishesAfter} wish${wishesAfter === 1 ? '' : 'es'} remaining_`
        : '\n\n_(your final wish has been granted)_';
      const finalText = `🧞 ${answer || '(silence)'}${footer}`;
      if (thinking?.key) {
        await wa.editMessage?.({ chatId, key: thinking.key, text: finalText });
      } else {
        await wa.replyTo({ chatId, key: replyMsg.key, raw: replyMsg.message, text: finalText });
      }
      sysOut?.(`🧞 [${chatName}] @${brainName}: ${answer || '(silence)'}`);
    },
    onBusy: async (replyMsg /*, oracle */) => {
      if (busyBehavior === 'ignore' || busyBehavior === 'queued') return;
      const asker = replyMsg.pushName?.trim() || (replyMsg.key?.fromMe ? 'You' : '?');
      const question = _extractQuestion(replyMsg) || '(media)';
      sysOut?.(`🧞 [${chatName}] ${asker} → ${question}  (busy — replied politely)`);
      await wa.replyTo({
        chatId,
        key: replyMsg.key,
        raw: replyMsg.message,
        text: '🧞 patience — one wish at a time',
      });
    },
  });
}
