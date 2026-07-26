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
//   2. THE LOOP COUNTER (unchanged) still pauses a CHANNEL on its own: per channel, count
//      consecutive NON-HUMAN turns with no genuine human turn between them (a "…" silence
//      still consumes a slot). At the soft limit → warn; at the hard limit (`turns`) →
//      auto-STOP the channel (stopChannel). A human turn resets the count, so normal
//      human↔bot talk never trips it. RESUME / RESUME ALL clear that pause — which is why
//      those two words KEEP their old meaning: they are the only way back from an
//      auto-stop short of a restart. RESUME ALL survives the STOP ALL removal on its own
//      merits: the counter can auto-stop SEVERAL channels independently, so clearing them
//      one at a time is not the same job (it never was STOP ALL's counterpart).
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
//   - fromBrain   : a web-brain MEMBER's own reply re-entering the room (design B, phase 4):
//                   the finalized reply is posted, then re-fed as a synthetic inbound so it
//                   reaches the other brains + E. It is OUR output, so NON-human by provenance
//                   (the flag rides `from`, set by the room relay) — it counts toward the cap,
//                   which is exactly what bounds a two-brain room at guard.turns.
//   - isEnvelope  : relay/provenance-tail traffic (src/spine/mesh.mjs, src/mesh/relay.mjs).
//   - wasSentByUs : one of our OWN bot sends re-entering (id-based, src/bridges/beeper.mjs);
//                   a being's own room fan-out is likewise ours. The bridge already
//                   suppresses most of these upstream — this is the belt.
export function isHumanTurn(ev, { isEnvelope = () => false, wasSentByUs = () => false } = {}) {
  if (!ev || ev.backlog) return false;
  if (ev.fromBrain) return false;
  if (isEnvelope(ev)) return false;
  if (wasSentByUs(ev)) return false;
  return true;
}

// `turns`  — consecutive NON-HUMAN turns that pause the channel (the hard limit). -1/0 = off.
// `window` — MINUTES; optional belt that only counts turns within this span (-1/0 = pure
//            consecutive count). A human turn always resets regardless of the window.
// The soft (warn-once) limit sits a couple below the hard cap. `now` is injected for tests.
export function createStopGuard({ turns = 6, window = -1, now = Date.now, onLog = () => {} } = {}) {
  const counts = new Map();           // channel -> [ts] of consecutive non-human turns
  const stoppedChannels = new Set();  // channels the loop counter auto-stopped

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

    // A NON-HUMAN turn (a real reply OR a '…' silence — both consume a slot, so a silent
    // ping-pong can't run forever). `override` is the channel's per-conversation guard
    // config ({ turns?, window? }) or null for the node defaults. Returns the action:
    // 'warn' once at the soft limit, 'stop' at/after the hard limit, else 'none'. `turns`
    // <= 0 (a -1 disable, global or per-conversation) never trips.
    noteBeing(channel, override = null) {
      const { hard, windowMin } = limitsOf(override);
      if (!(hard > 0)) return 'none';                 // -1 / 0 → disabled
      const soft = Math.max(1, hard - 2);
      const t = now();
      let arr = counts.get(channel) || [];
      if (windowMin > 0) { const span = windowMin * 60_000; arr = arr.filter((x) => t - x < span); }
      arr.push(t);
      counts.set(channel, arr);
      const n = arr.length;
      if (n >= hard) return 'stop';
      if (n === soft) return 'warn';
      return 'none';
    },

    // Current consecutive non-human count for a channel (diagnostics/logging).
    countOf(channel) { return (counts.get(channel) || []).length; },

    stopChannel(channel) { if (channel != null) { stoppedChannels.add(channel); onLog(`STOP ${channel}`); } },
    resumeChannel(channel) { stoppedChannels.delete(channel); counts.set(channel, []); onLog(`RESUME ${channel}`); },
    resumeAll() { stoppedChannels.clear(); counts.clear(); onLog('RESUME ALL'); },

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
