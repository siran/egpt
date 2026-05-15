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

// Genie face — three eyes + nose + mouth. The two mortal eyes
// (👁️) sit on row 2; the third eye of wisdom pulses above them
// on a different rhythm (pure-ASCII ◯ → ○ → o → -, which reads
// as breathing/scanning regardless of WA's emoji rendering
// quirks). 👃 nose stays constant; 👄 mouth occasionally morphs
// into 🫦 (biting lips) for a flicker of expression.
//
// Layout uses a triple-backtick monospace block so WA preserves
// the leading spaces exactly — without the block, leading
// whitespace gets stripped on some clients and the face slides
// out of column. Inside the block, columns are: 4 spaces between
// mortal eyes, 3 leading spaces for the center column (third
// eye, nose, mouth) so they all sit visually centered between
// the eyes.
//
// Third-eye states: '◯' (wide alert), '○' (watching), 'o' (dim),
// '-' (resting).
// Mortal states:    '👁️' (open), '〰️' (closed).
// Mouth states:     '👄' (default), '🫦' (biting lips).
const _face = (top, left, right, mouth = '👄') =>
  '```\n' +
  `   ${top}\n` +
  `${left}    ${right}\n` +
  '   👃\n' +
  `   ${mouth}\n` +
  '```';

// Compact summon — bottle → puff → wisdom eye peers out → full
// face emerges. ~4.5s total. The peek frame opens the third eye
// first (it's the one of wisdom — it sees you coming); the
// other parts follow when the genie fully emerges.
const SUMMON_FRAMES = [
  '🍾',
  '🍾  💨',
  '```\n   ◯\n  🍾\n```',
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
  '```\n〰️    〰️\n  🍾\n```',
  '💨\n🍾',
  '🍾',
  '_(the bottle is empty)_',
];

// Idle cycle. Each frame is { text, ms } — the bridge honors
// the per-frame dwell, so blinks and winks flash quickly (~300ms)
// between long open beats (~3s). That keeps the average edit
// rate well under WA's ceiling while letting the blinks feel
// like actual blinks rather than 3-second eye closures.
//
// Third-eye column shows the pulse pattern; mortal pair holds
// 👁️/👁️ except on the blink/wink beats. Mouth occasionally
// morphs into 🫦 on hold frames. The rhythms aren't aligned, so
// the eyes/mouth feel like independent organs rather than one
// coordinated face.
function idleFrames(N) {
  const wishes = N === 1 ? '1 wish' : `${N} wishes`;
  const footer = `\n\n*${wishes} remaining*\n_reply with your question_`;
  const f = (top, l, r, mouth) => _face(top, l, r, mouth) + footer;
  const HOLD = 3000;
  const BLINK = 300;
  return [
    { text: f('◯', '👁️', '👁️'),       ms: HOLD  },   //  0  wide alert
    { text: f('○', '👁️', '👁️'),       ms: HOLD  },   //  1  watching
    { text: f('o', '👁️', '👁️'),       ms: HOLD  },   //  2  dim
    { text: f('-', '👁️', '👁️'),       ms: HOLD  },   //  3  resting
    { text: f('○', '〰️', '〰️'),       ms: BLINK },   //  4  *blink*
    { text: f('○', '👁️', '👁️', '🫦'), ms: HOLD  },   //  5  watching (bites lip)
    { text: f('◯', '👁️', '👁️'),       ms: HOLD  },   //  6  wide alert
    { text: f('○', '〰️', '👁️'),       ms: BLINK },   //  7  wink-L
    { text: f('o', '👁️', '👁️'),       ms: HOLD  },   //  8  dim
    { text: f('-', '👁️', '👁️', '🫦'), ms: HOLD  },   //  9  resting (bites lip)
    { text: f('○', '👁️', '〰️'),       ms: BLINK },   // 10  wink-R
    { text: f('○', '👁️', '👁️'),       ms: HOLD  },   // 11  watching
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
