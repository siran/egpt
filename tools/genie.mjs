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

// Genie face — three rows. Eye-nose-eye on the middle row so
// the nose reads as part of the face instead of floating below
// the eyes; mouth below; third eye of wisdom on top. The third
// eye is a moon phase (🌑→🌒→🌓→🌔→🌕) — full-width so it
// aligns with the nose/mouth centerline, and the lunar cycle
// reads as mystical breathing rather than mechanical pulse.
//
// All rows live inside a triple-backtick monospace block so WA
// preserves leading whitespace exactly. Layout columns:
//   row 1:  "   <top> "         third eye centered at cols 3-4
//   row 2:  "👁️ 👃 👁️"          eyes flanking the nose, 8 cols wide
//   row 3:  "   <mouth>"        mouth centered at cols 3-4
//
// Mortal states: '👁️' (open), '〰️' (closed).
// Mouth states:  '👄' (default), '🫦' (biting lips).
const _face = (top, left, right, mouth = '👄') => [
  '```',
  `   ${top}`,
  `${left} 👃 ${right}`,
  `   ${mouth}`,
  '```',
].join('\n');

// Compact summon — bottle → puff → wisdom moon peers out → full
// face emerges. ~4.5s total. The peek frame opens the third eye
// first (it's the one of wisdom — it sees you coming); the
// other parts follow when the genie fully emerges.
const SUMMON_FRAMES = [
  '🍾',
  '🍾  💨',
  '```\n   🌒\n  🍾\n```',
  _face('🌕', '👁️', '👁️'),
];

const THINKING_FRAMES = [
  '🍾  *consulting the books*  📖',
  '🍾  *consulting the books*  📚',
  '🍾  *taking notes*  📝',
  '🍾  *cross-referencing*  📜',
  '🍾  *almost there…*  💡',
];

// Retire — third eye wanes first (it saw the end coming), then
// mortal pair closes, then the face recedes into the bottle.
const RETIRE_FRAMES = [
  _face('🌒', '👁️', '👁️') + '\n\n_your wishes are spent._',
  _face('🌑', '〰️', '〰️') + '\n\n_farewell._  👋',
  '```\n   🌑\n  🍾\n```',
  '💨\n🍾',
  '🍾',
  '_(the bottle is empty)_',
];

// Idle cycle. Each frame is { text, ms } — the bridge honors the
// per-frame dwell, so blinks and winks flash quickly (~300ms)
// between long open beats (~6s). Holds are deliberately slow:
// WA delivers every edit to every recipient, and although edits
// are supposed to be silent, some clients re-surface the chat in
// the chat list (or render an "edited" indicator) on each one.
// Slowing the cycle to ~10 edits/minute keeps the genie feeling
// alive without flooding anyone's phone — and the bridge caps
// total idle edits per cycle on top of that (see startOracle's
// idleAnimationBudget).
//
// Third eye runs the lunar cycle independently of the mortal
// pair's blinks, so the face feels like a face rather than a
// single coordinated organ.
function idleFrames(N) {
  const wishes = N === 1 ? '1 wish' : `${N} wishes`;
  const footer = `\n\n*${wishes} remaining*\n_reply with your question_`;
  const f = (top, l, r, mouth) => _face(top, l, r, mouth) + footer;
  const HOLD  = 6000;
  const BLINK = 300;
  return [
    { text: f('🌕', '👁️', '👁️'),       ms: HOLD  },   // 0  full alert
    { text: f('🌔', '👁️', '👁️'),       ms: HOLD  },   // 1  gibbous watching
    { text: f('🌓', '👁️', '👁️', '🫦'), ms: HOLD  },   // 2  quarter, bites lip
    { text: f('🌒', '👁️', '👁️'),       ms: HOLD  },   // 3  crescent
    { text: f('🌑', '〰️', '〰️'),       ms: BLINK },   // 4  new moon + blink
    { text: f('🌒', '👁️', '👁️'),       ms: HOLD  },   // 5  crescent waking
    { text: f('🌓', '〰️', '👁️'),       ms: BLINK },   // 6  wink-L
    { text: f('🌔', '👁️', '👁️'),       ms: HOLD  },   // 7  gibbous
    { text: f('🌕', '👁️', '〰️'),       ms: BLINK },   // 8  wink-R
    { text: f('🌕', '👁️', '👁️', '🫦'), ms: HOLD  },   // 9  full alert, bites lip
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
