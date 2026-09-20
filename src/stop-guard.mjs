// stop-guard.mjs — everything the word STOP means on this node: the KILL SWITCH
// (EGPT_HOME/STOP, below) and the provenance-based bot↔bot loop counter (C7.7).
//
// The spine calls it at the ONE prompt chokepoint (handleFast in src/spine/spine.mjs),
// through which EVERY inbound turn flows — genuine human messages, relay/mesh envelopes,
// and a being's own room fan-out. So a pause here is definite: a stopped channel never
// reaches a brain at all.
//
// THE WHOLE RECOGNISED VOCABULARY IS THREE PHRASES:  STOP | RESUME | RESUME ALL.
//
// TWO SEPARATE THINGS, deliberately not conflated (operator 2026-07-25):
//
//   1. THE SAFE WORD = THE KILL SWITCH. "if i write 'stop' all activity, whatever it is,
//      must stop" / "stop, stops egpt service point blank" / "if a file named STOP exists
//      in .egpt it *also* stops ... STOP in a chat writes this file that inoculates
//      service". So STOP writes EGPT_HOME/STOP and takes the SERVICE down. It is no longer
//      a per-channel pause: `stopAll()`'s old "egpt off without killing the process"
//      meaning is RETIRED, because a word that sometimes only mutes a channel is exactly
//      the ambiguity a safe word cannot have.
//      SCOPE — IT IS A **SELF-CHAT** WORD (operator 2026-07-26: "the 'stop' safeword is
//      super fragile. i don't really like it. is must be a single word message in Self,
//      'stop', case insensitive"). parseStopWord below only says WHAT was typed; WHERE it
//      counts is the spine's gate (src/spine/spine.mjs classify → isSelfChat, wired in
//      boot to networks.whatsapp.chat_ids[0]). In any other chat, group, or on the shell
//      console the same word is ordinary text. RESUME / RESUME ALL are NOT scoped that
//      way — they only clear a loop-counter pause, so they stay usable in the channel
//      that got paused.
//      "STOP ALL" IS UNWIRED (operator 2026-07-26: "unwire 'STOP ALL' i didn't even know
//      it existed"). Not an alias, not a hidden synonym for the kill switch — a phrase the
//      operator does not know cannot be a second name for the most destructive word on the
//      node, so it parses as nothing and reads as ordinary text.
//
//   2. THE LOOP GUARD still pauses a CHANNEL on its own. ONE guard, TWO TRIGGERS (operator
//      2026-09-20, after the "🌴FAMILIA PALMA🌴" outage below):
//        · RATE — `turns` non-human turns inside `window` MINUTES. "a hard limit of turns is
//          only effective on a rapid succession … six spread over a day is the kind of
//          conservatism we must avoid". At two below the hard limit → warn; at it → auto-STOP.
//        · REPETITION — "pause on repetition, not chatter". The same normalized line said
//          `repeats` times by the same author inside `repeatWindow` minutes, or two lines
//          alternating A,B,A,B. Bots that keep saying NEW things never trip it, which is the
//          point: "a chatter between bots is desired, and even encouraged".
//      A human turn resets both, so normal human↔bot talk never trips either. RESUME /
//      RESUME ALL clear the pause — which is why those two words KEEP their old meaning: they
//      are the only way back from an auto-stop short of a restart. RESUME ALL survives the
//      STOP ALL removal on its own merits: the guard can auto-stop SEVERAL channels
//      independently, so clearing them one at a time is not the same job.
//
// THE LOOP THIS GUARD DID NOT CATCH, AND THE ONE IT CAUSED (kg, 2026-09-20). "🌴FAMILIA PALMA🌴"
// was auto-STOPped at 00:35:50 and nobody noticed until 08:21 — eight hours of `stopped — prompt
// suppressed`, the operator's own `@ken @don @e están?` among them. The six turns that filled the
// cap arrived in FIVE SECONDS and were THIS NODE'S OWN BOOKKEEPING: E's `⏳ Thinking…` and
// `⏳ Queued (1 ahead)…` placeholders, posted through the mouth account, came back through Beeper
// carrying this node's own signature and each consumed a slot. Hence THREE changes, all here:
// our own echo is not a turn at all (turnKind), the cap is a rate, and a pause announces itself.
//
// THE CRUX (what makes turn-counter-ONLY safe, closing the 2026-06-19 hole): "human"
// is decided by PROVENANCE, not display name (isHumanTurn). A turn resets the counter
// only when it is a genuine inbound human message — NOT a bot send (wasSentByUs, id-
// based), NOT relay/envelope traffic (isEnvelope), NOT a being's own emit. A mesh
// message posted AS the operator parses as an envelope here, so it is NON-human and
// counts toward the cap instead of resetting it — the exact case the removed flood-
// guard existed for.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EGPT_HOME } from './egpt-home.mjs';
// THE codec, imported — never a second copy of the frame regex here (src/node-signature.mjs
// is the one definition the outbound wrap, the inbound envelope and this gate all share).
import { hasNodeSignature, stripNodeSignature, stripRenderedNodeSignature } from './node-signature.mjs';

// THE KILL SWITCH, as a file. Profile ROOT — beside config/ and state/, deliberately
// visible — so `ls ~/.egpt` shows a stopped node at a glance and `rm ~/.egpt/STOP` is the
// whole recovery. Nothing else persists a stopped state (contract (d)): the file IS the
// state, so removing it is sufficient, always.
export const STOP_FILE = join(EGPT_HOME, 'STOP');

// Is the node forbidden to run? Checked at the TOP of boot (before the bridge dials
// anything) and on every spine tick (so a `touch ~/.egpt/STOP` from a terminal halts a
// RUNNING node without a watcher or a second timer). Never throws — an fs fault must not
// be readable as "no STOP file", but it must not crash the boot path either.
export function stopFilePresent(file = STOP_FILE) {
  try { return existsSync(file); } catch { return false; }
}

// Write the STOP file so it EXPLAINS ITSELF: a halted node has no chat to explain itself
// in, so the reason + provenance (who, which surface/chat, when) and the way to undo it
// live in the file. NEVER clobbers an existing one — whoever stopped the node first owns
// the explanation (an operator's hand-written `touch` reason survives a later chat STOP).
// Returns whether it wrote.
export function writeStopFile({ reason = 'STOP', who = 'unknown', where = 'unknown', at = new Date().toISOString() } = {}, file = STOP_FILE) {
  if (existsSync(file)) return false;
  writeFileSync(file, [
    'egpt is STOPPED.',
    '',
    `reason: ${reason}`,
    `who:    ${who}`,
    `where:  ${where}`,
    `when:   ${at}`,
    '',
    'This node refuses to start while this file exists, and a running node halts on its',
    `next tick. Delete this file to let egpt start again:  rm ${file}`,
    '',
  ].join('\n'), 'utf8');
  return true;
}

// Parse an operator control safe-word out of a message body. Exact, case-
// insensitive, trailing punctuation tolerated. Returns the control or null.
// THE COMPLETE SET: 'stop' | 'resume' | 'resume_all'. Anything else — including
// "STOP ALL", which used to be a second name for the kill switch — is null, i.e.
// ordinary text that flows on to the normal dispatch.
//
// THE WHOLE TRIMMED BODY MUST BE THE WORD — "stop it", "please stop", "stopping"
// and "we should stop" are all ordinary text, which is the operator's "single word
// message" requirement (2026-07-26) and the reason it holds. The ONLY latitude is
// TRAILING '.'/'!'/whitespace, kept deliberately: "stop." and "STOP!" are still the
// bare word plus emphasis, they cannot mean anything else, and a safe word that
// fails because the operator hit the exclamation key in an emergency is worse than
// one that tolerates it. Nothing LEADING and nothing internal is stripped.
export function parseStopWord(text) {
  const t = String(text ?? '').trim().toLowerCase().replace(/[.!\s]+$/, '');
  if (t === 'stop') return 'stop';
  if (t === 'resume all' || t === 'resumeall') return 'resume_all';
  if (t === 'resume') return 'resume';
  return null;
}

// isHumanTurn — the provenance gate. A turn RESETS the loop counter only when it is a
// genuine inbound human message. Provenance, not display name: a mesh envelope posted
// AS the operator (the 2026-06-19 loop) parses as relay traffic here and is NON-human,
// so it counts toward the cap. Signals (each defaults to "not that", so a caller wiring
// only some of them still gets a correct answer):
//   - backlog     : a woken node's replay is not a live human turn.
//   - fromMember  : a turn the ROOM RELAY re-entered, as { id, kind } — WHICH roster member it
//                   came from. A `brain` MEMBER's own reply (design B, phase 4) is posted and then
//                   re-fed as a synthetic inbound so it reaches the other brains + E: that is OUR
//                   output, so NON-human by provenance — it counts toward the cap, which is
//                   exactly what bounds a two-brain room at guard.turns.
//                   THE KIND IS THE TEST, not the mere presence (operator 2026-08-31). The same
//                   re-entry now carries an INVITED GROUP's message into the room it joined, so
//                   the group can trigger the room's agents — and that is a PERSON talking, not
//                   our output. Counting it would auto-STOP the room after guard.turns group
//                   messages and silence the very agents the tunnel exists to wake, so a
//                   non-brain member stays human here and resets the room's counter as any human
//                   turn does. (An escaped echo of one of OUR sends is caught a line below
//                   instead, by fromNode, which the tunnel synthetic carries across.)
//   - isEnvelope  : relay/provenance-tail traffic (src/spine/mesh.mjs, src/mesh/relay.mjs).
//   - wasSentByUs : one of our OWN bot sends re-entering (id-based, src/bridges/beeper.mjs);
//                   a being's own room fan-out is likewise ours. The bridge already
//                   suppresses most of these upstream — this is the belt.
//   - nodeSignature: a SPINE committed this text — whoever the display sender is. The other four
//                   are all NODE-LOCAL: on a shared Beeper account a PEER node's plain post
//                   arrives isSender:true with an id we never sent and no envelope, so all four
//                   said "human" — DOLLY was recorded as the operator AND reset the very loop
//                   counter that exists to stop two nodes talking forever (operator 2026-07-26:
//                   "the mere presence of a non-readable char points to non-human"). PRESENCE is
//                   the whole test: an unknown node name is still not a human. It is the FRAME,
//                   not "any invisible character" — an RGI flag emoji (🏴 + tag letters, same
//                   block, same U+E007F terminator) and a pasted ZWSP/BOM both stay human.
//
//                   READ TWO WAYS, because two kinds of caller ask:
//                     ev.fromNode — the envelope field. THE SPINE'S PATH. identity.build renders
//                       the invisible frame into a legible `<node>` before ANY guard runs
//                       (spine.mjs:375 builds the envelope; all three humanTurn call sites are
//                       below it), so by the time ev.body is readable the frame is gone. The fact
//                       is lifted off the raw text there and carried here. `!= null`, NOT
//                       truthiness: '' means "signed, node unnameable" — still a bridge.
//                     ev.body     — the raw-text path, for any caller holding text that has NOT
//                       been through identity yet. Costs nothing and is the correct predicate
//                       there; it is simply never the one that fires inside the spine.
export function isHumanTurn(ev, { isEnvelope = () => false, wasSentByUs = () => false } = {}) {
  if (!ev || ev.backlog) return false;
  if (ev.fromMember?.kind === 'brain') return false;
  if (ev.fromNode != null) return false;
  if (hasNodeSignature(ev.body)) return false;
  if (isEnvelope(ev)) return false;
  if (wasSentByUs(ev)) return false;
  return true;
}

// turnKind — THREE KINDS OF TURN, because "not human" was one bucket too few (operator
// 2026-09-20). isHumanTurn above answers "may this reset the counter / pull the kill switch",
// and for that a boolean is right. The COUNTER needs a third answer:
//
//   'human' — a genuine inbound person. Resets the count.
//   'echo'  — THIS NODE'S OWN OUTPUT coming back to it: a send the bridge recognises by id
//             (wasSentByUs) or a frame THIS node's spine committed (fromThisNode). It is
//             bookkeeping, not an utterance — so it NEITHER counts toward the cap NOR resets
//             it. This is the whole PALMA bug: E's own ⏳ placeholders, posted through the
//             mouth account and re-entering on the ear, filled the cap in five seconds.
//   'being' — somebody else's machine turn: ANOTHER node's being, a relay envelope, a brain
//             member's reply. That is real chatter and it counts, exactly as before.
//
// `fromThisNode` is injected rather than derived here, for the same reason `isEnvelope` and
// `wasSentByUs` are: "who are we" lives in ONE place (node-names.mjs ownNodeNamesOf, read
// through its fromOtherNode counterpart — boot wires it). Absent ⇒ never our own frame, which
// is byte-identical to the old two-bucket behaviour.
export function turnKind(ev, { isEnvelope = () => false, wasSentByUs = () => false, fromThisNode = () => false } = {}) {
  if (isHumanTurn(ev, { isEnvelope, wasSentByUs })) return 'human';
  if (wasSentByUs(ev) || fromThisNode(ev)) return 'echo';
  return 'being';
}

// THE PERSONA STAMP the bridge puts at the head of a being's post (bridges/persona-wrap.mjs
// personaStamp): "<body_emoji> <label>: ". Stripped so the SAME sentence from two different
// beings compares equal — which is exactly the A,B,A,B case. NARROW ON PURPOSE: the leading
// glyph must be non-letter/non-digit and the label a single bare word, so ordinary prose
// ("nota: mañana", "Juan: dijo que sí") keeps its prefix and two genuinely different messages
// stay different.
const BEING_STAMP = /^\s*[^\p{L}\p{N}\s]{1,4}\s+[\p{L}\p{N}_-]{1,24}\s*[:：]\s*/u;

/**
 * The COMPARABLE LINE of a message body: what was said, with the machinery around it removed.
 * Exactly four operations, and no more — normalization that folds two genuinely different
 * messages together would pause a live conversation for saying two different things:
 *   1. the invisible node frame (stripNodeSignature — the raw wire form), and
 *   2. its RENDERED form `<kg>` (stripRenderedNodeSignature — what identity.build leaves
 *      behind, which is what the guard actually sees), because the same line from two nodes
 *      is one line;
 *   3. the being stamp above, for the same reason;
 *   4. trim + collapse whitespace, so a re-wrapped repeat is still a repeat.
 * NOT stripped: the visible bridge_signature_* decoration, emoji, punctuation, case. Those are
 * constant per node anyway (so they never hide a repeat) and folding them could hide a
 * difference. '' for a message with no text — a silence is not a LINE (see noteBeing).
 */
export function normalizeLine(text) {
  return stripRenderedNodeSignature(stripNodeSignature(String(text ?? '')))
    .replace(BEING_STAMP, '')
    .trim()
    .replace(/\s+/g, ' ');
}

// A line, clipped for a chat notice / a log line.
const clip = (s, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// TRIGGER 2 — REPETITION. Given this channel's recent non-human turns (already filtered to the
// repeat window), is the channel saying the same thing over and over? Two forms of ONE fact:
//   (a) one author repeating one line `reps` times — the classic stuck bot;
//   (b) two lines alternating A,B,A,B — the two-party form of the same thing, which (a) can
//       never see because each side has only said its line twice.
// Returns the REASON (naming the repeated text, which the channel notice must carry) or null.
// A turn with no text cannot be a repeated LINE, so bodiless entries are skipped entirely.
function repeatReason(entries, reps, windowMin) {
  if (!(reps > 1)) return null;
  const lines = entries.filter((e) => e.line);
  const seen = new Map();
  for (const e of lines) {
    const k = `${e.author.length}:${e.author}${e.line}`;   // length-prefixed: author and line cannot bleed into each other
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    if (n >= reps) return `the same line ${n}× in ${windowMin} min: “${clip(e.line)}”`;
  }
  if (lines.length >= 4) {
    const [a, b, c, d] = lines.slice(-4).map((e) => e.line);
    if (a === c && b === d && a !== b) return `two lines alternating in ${windowMin} min: “${clip(a, 40)}” ↔ “${clip(b, 40)}”`;
  }
  return null;
}

// `turns`        — NON-HUMAN turns inside `window` that pause the channel (the hard limit).
//                  -1/0 = THE WHOLE GUARD OFF for that channel, repetition included.
// `window`       — MINUTES the rate is measured over. DEFAULT 2: six turns in two minutes is the
//                  out-of-control case; six across a day is normal life (operator 2026-09-20).
//                  -1/0 = pure consecutive count, as before.
// `repeats`      — times one line may be repeated inside `repeatWindow` before the channel pauses.
// `repeatWindow` — MINUTES the repetition detector looks back over.
// The soft (warn-once) limit sits a couple below the hard cap. `now` is injected for tests.
// The per-conversation override ({ turns, window } from conversations.yaml) still wins on the
// rate, and `turns: -1` there still disables this guard for that channel — both triggers.
export function createStopGuard({ turns = 6, window = 2, repeats = 3, repeatWindow = 10, now = Date.now, onLog = () => {} } = {}) {
  const counts = new Map();           // channel -> [{ t, line, author }] recent non-human turns
  const stoppedChannels = new Set();  // channels the loop guard auto-stopped
  const reasons = new Map();          // channel -> why the last auto-stop tripped (the notice says it)

  const blocked = (channel) => stoppedChannels.has(channel);

  // Resolve the effective limits for a channel: a per-conversation override
  // ({ turns?, window? } from conversations.yaml) wins over the node defaults.
  const limitsOf = (override) => ({
    hard: Number.isFinite(override?.turns) ? override.turns : turns,
    windowMin: Number.isFinite(override?.window) ? override.window : window,
  });

  return {
    // Is prompting blocked for this channel? Checked at the top of the chokepoint.
    blocked,

    // A human turn in a channel: reset the loop count so normal human↔bot conversation
    // never trips the guard. Does NOT clear an active STOP — that is a deliberate
    // override, cleared only by RESUME.
    noteHuman(channel) { counts.set(channel, []); },

    // A NON-HUMAN turn — SOMEBODY ELSE'S (turnKind 'being'; our own 'echo' must never reach
    // here). A real reply OR a '…' silence: both consume a rate slot, so a silent ping-pong
    // can't run forever, but a silence carries no LINE so it can never trip repetition.
    // `override` is the channel's per-conversation guard config ({ turns?, window? }) or null
    // for the node defaults; `turn` is what was said ({ body, author }) — the repetition
    // detector's whole input, and omitting it simply leaves that trigger silent.
    // Returns 'stop' (either trigger), 'warn' once at the soft rate limit, else 'none'.
    // `turns` <= 0 (a -1 disable, global or per-conversation) turns the whole guard off.
    noteBeing(channel, override = null, { body = '', author = '' } = {}) {
      const { hard, windowMin } = limitsOf(override);
      if (!(hard > 0)) return 'none';                 // -1 / 0 → disabled, both triggers
      const soft = Math.max(1, hard - 2);
      const t = now();
      // ONE history feeds both triggers. Aged out only when the rate has a window of its own
      // (with `window: -1` the count is "consecutive, forever", exactly as it always was), and
      // then by the LONGER of the two spans, so the rate's short window cannot blind the
      // repetition detector to a slow loop.
      const keepMs = windowMin > 0 ? Math.max(windowMin, repeats > 1 ? repeatWindow : 0) * 60_000 : Infinity;
      const arr = (counts.get(channel) || []).filter((e) => t - e.t < keepMs);
      arr.push({ t, line: normalizeLine(body), author: String(author ?? '') });
      counts.set(channel, arr);

      // TRIGGER 1 — REPETITION. First, because it is the one the operator actually asked for:
      // "pause on repetition, not chatter".
      const rep = repeatReason(arr.filter((e) => t - e.t < repeatWindow * 60_000), repeats, repeatWindow);
      if (rep) { reasons.set(channel, rep); return 'stop'; }

      // TRIGGER 2 — RATE. N non-human turns inside the window, not N ever.
      const n = windowMin > 0 ? arr.filter((e) => t - e.t < windowMin * 60_000).length : arr.length;
      if (n >= hard) {
        reasons.set(channel, windowMin > 0 ? `${n} non-human turns in ${windowMin} min` : `${n} consecutive non-human turns`);
        return 'stop';
      }
      if (n === soft) return 'warn';
      return 'none';
    },

    // Current non-human count for a channel, over the node's own rate window (diagnostics/
    // logging; a per-conversation override is the caller's business, not this reading's).
    countOf(channel) {
      const t = now();
      const arr = counts.get(channel) || [];
      return window > 0 ? arr.filter((e) => t - e.t < window * 60_000).length : arr.length;
    },

    // WHY this channel was last auto-stopped — the repeated line, or the rate with its numbers.
    // The log line and the notice the channel gets both say it: a pause nobody can explain is
    // how PALMA stayed silent for eight hours.
    reasonOf(channel) { return reasons.get(channel) ?? 'a loop'; },

    stopChannel(channel) { if (channel != null) { stoppedChannels.add(channel); onLog(`STOP ${channel}`); } },
    resumeChannel(channel) { stoppedChannels.delete(channel); counts.set(channel, []); reasons.delete(channel); onLog(`RESUME ${channel}`); },
    resumeAll() { stoppedChannels.clear(); counts.clear(); reasons.clear(); onLog('RESUME ALL'); },

    // Apply a parsed control word in a channel context. RESUME only: STOP is the KILL
    // SWITCH now (the spine routes it to the STOP file + exit, never here), so the only
    // per-channel pause left is the loop counter's auto-stop — and these clear it.
    applyControl(word, channel) {
      if (word === 'resume_all') this.resumeAll();
      else if (word === 'resume') this.resumeChannel(channel);
    },

    status() { return { stoppedChannels: [...stoppedChannels], counts: Object.fromEntries([...counts].map(([k, v]) => [k, v.length])) }; },
  };
}
