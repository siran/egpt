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

// Genie face — three eyes (the operator: "the eye of wisdom").
// Two on the bottom row, the third in the center top — classic
// trinetra placement. The idle phase animates by swapping eye
// states (all-open / blink / wink-left / wink-right / wisdom)
// so the face feels alive rather than frozen between questions.
// Same geometry across all idle frames so column widths hold
// edit-to-edit.
//
// State legend (top, left, right):
//   open    : 👁️
//   closed  : 〰️
const _face = (top, left, right) =>
  `  ${top}\n ${left} ${right}\n   ·\n  ╰─╯`;
const FACE_OPEN     = _face('👁️', '👁️', '👁️');           // alert, all three open
const FACE_BLINK    = _face('〰️', '〰️', '〰️');           // momentary blink
const FACE_WINK_L   = _face('👁️', '〰️', '👁️');           // left eye winks
const FACE_WINK_R   = _face('👁️', '👁️', '〰️');           // right eye winks
const FACE_WISDOM   = _face('👁️', '〰️', '〰️');           // bottom two closed, third sees deeper
const FACE_WISDOM_OFF = _face('〰️', '👁️', '👁️');         // mortal eyes open, wisdom rests

// Compact summon — bottle → puff → wisdom eye peers out → full
// three-eyed face. ~4.5s total. The peek frame opens the third
// eye first (it's the one of wisdom — it sees you coming); the
// other two follow when the genie fully emerges.
const SUMMON_FRAMES = [
  '🍾',
  '🍾  💨',
  '  👁️\n  ·\n 🍾',
  FACE_OPEN,
];

const THINKING_FRAMES = [
  '🍾  *consulting the books*  📖',
  '🍾  *consulting the books*  📚',
  '🍾  *taking notes*  📝',
  '🍾  *cross-referencing*  📜',
  '🍾  *almost there…*  💡',
];

// Retire — wisdom eye closes first (it saw the end coming), then
// the mortal pair, then the face fades back into the bottle.
const RETIRE_FRAMES = [
  FACE_WISDOM_OFF + '\n\n_your wishes are spent._',
  FACE_BLINK      + '\n\n_farewell._  👋',
  '〰️ 〰️\n  ·\n  ◯  \n 🍾',
  '💨\n🍾',
  '🍾',
  '_(the bottle is empty)_',
];

// Idle cycle — face mostly alert, occasional blinks/winks, rare
// "wisdom" beat where the mortal pair closes and only the third
// eye stays open (the genie is sensing something). Identical
// consecutive frames are skipped by the bridge's no-change
// optimization, so this is ~6 actual edits per 12-frame cycle.
function idleFrames(N) {
  const wishes = N === 1 ? '1 wish' : `${N} wishes`;
  const footer = `\n\n*${wishes} remaining*\n_reply with your question_`;
  return [
    FACE_OPEN       + footer,
    FACE_OPEN       + footer,
    FACE_BLINK      + footer,
    FACE_OPEN       + footer,
    FACE_OPEN       + footer,
    FACE_WINK_L     + footer,
    FACE_OPEN       + footer,
    FACE_OPEN       + footer,
    FACE_WISDOM     + footer,
    FACE_OPEN       + footer,
    FACE_WINK_R     + footer,
    FACE_OPEN       + footer,
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
      // Register the answer-message key with the oracle so a reply
      // to this answer (the natural UX for "continue the thread")
      // triggers the next round. Without this, only replies to the
      // original spinner matched the intercept, and the 2nd
      // question silently fell through to normal awareness gates.
      if (thinking?.key?.id && oracle?.associatedKeys) {
        oracle.associatedKeys.add(thinking.key.id);
      }
      const answer = await computeBrainTurn(brainName, question);
      const wishesAfter = Math.max(0, (oracle?.questionsLeft ?? questionsLeft) - 1);
      const footer = wishesAfter > 0
        ? `\n\n_${wishesAfter} wish${wishesAfter === 1 ? '' : 'es'} remaining_`
        : '\n\n_(your final wish has been granted)_';
      const finalText = `🧞 ${answer || '(silence)'}${footer}`;
      if (thinking?.key) {
        await wa.editMessage?.({ chatId, key: thinking.key, text: finalText });
      } else {
        const fresh = await wa.replyTo({ chatId, key: replyMsg.key, raw: replyMsg.message, text: finalText });
        if (fresh?.key?.id && oracle?.associatedKeys) {
          oracle.associatedKeys.add(fresh.key.id);
        }
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
