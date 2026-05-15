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

// Genie face — three eyes, no nose or mouth (operator: "it
// doesn't need a nose or mouth"). The two mortal eyes (👁️) live
// on the bottom row; the third eye of wisdom pulses above them
// on a different rhythm — a pure-ASCII glyph cycle (◯ → ○ → o
// → -) that reads as breathing/scanning regardless of WA's
// emoji rendering quirks. Mortal pair holds steady mostly,
// blinks/winks rarely; third eye pulses constantly. The two
// rhythms aren't aligned, so the eyes feel like independent
// organs rather than one coordinated face.
//
// Third-eye states: '◯' (wide alert), '○' (watching), 'o' (dim),
// '-' (resting).
// Mortal states:    '👁️' (open), '〰️' (closed).
const _face = (top, left, right) => `  ${top}\n ${left} ${right}`;

// Compact summon — bottle → puff → wisdom eye peers out → full
// three-eyed face. ~4.5s total. The peek frame opens the third
// eye first (it's the one of wisdom — it sees you coming); the
// other two follow when the genie fully emerges.
const SUMMON_FRAMES = [
  '🍾',
  '🍾  💨',
  '  ◯\n 🍾',
  _face('◯', '👁️', '👁️'),
];

const THINKING_FRAMES = [
  '🍾  *consulting the books*  📖',
  '🍾  *consulting the books*  📚',
  '🍾  *taking notes*  📝',
  '🍾  *cross-referencing*  📜',
  '🍾  *almost there…*  💡',
];

// Retire — third eye dims first (it saw the end coming), then
// mortal pair closes, then the face recedes into the bottle.
const RETIRE_FRAMES = [
  _face('-', '👁️', '👁️') + '\n\n_your wishes are spent._',
  _face('-', '〰️', '〰️') + '\n\n_farewell._  👋',
  '〰️ 〰️\n  🍾',
  '💨\n🍾',
  '🍾',
  '_(the bottle is empty)_',
];

// Idle cycle. The third eye pulses every frame (◯ → ○ → o → -
// → o → ○) on a 6-beat rhythm; the mortal pair stays open most
// of the time with occasional blink/wink at frames that don't
// line up with the third-eye cycle. Identical-frame skip-edit
// in the bridge keeps actual WA edits to ~one per beat.
function idleFrames(N) {
  const wishes = N === 1 ? '1 wish' : `${N} wishes`;
  const footer = `\n\n*${wishes} remaining*\n_reply with your question_`;
  const f = (top, l, r) => _face(top, l, r) + footer;
  // 12-beat idle. Third-eye column shows the pulse pattern; mortal
  // pair holds 👁️/👁️ except at frames 4 (blink), 7 (wink-L),
  // 10 (wink-R). The two rhythms (6-beat third eye vs 12-beat
  // mortals) are coprime enough to read as independent.
  return [
    f('◯', '👁️', '👁️'),   //  0  full
    f('○', '👁️', '👁️'),   //  1  watching
    f('o', '👁️', '👁️'),   //  2  dim
    f('-', '👁️', '👁️'),   //  3  resting
    f('o', '〰️', '〰️'),   //  4  mortal blink during third's dim
    f('○', '👁️', '👁️'),   //  5  watching
    f('◯', '👁️', '👁️'),   //  6  full
    f('○', '〰️', '👁️'),   //  7  left wink
    f('o', '👁️', '👁️'),   //  8  dim
    f('-', '👁️', '👁️'),   //  9  resting
    f('o', '👁️', '〰️'),   // 10  right wink during third's dim
    f('○', '👁️', '👁️'),   // 11  watching
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
