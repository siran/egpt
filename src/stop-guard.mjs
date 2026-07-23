// stop-guard.mjs — the spine's SINGLE per-channel guard: the human STOP/RESUME
// kill-switch + the provenance-based bot↔bot loop counter (C7.7, re-wired for v2).
//
// Pure state machine. The spine calls it at the ONE prompt chokepoint (handleFast
// in src/spine/spine.mjs), through which EVERY inbound turn flows — genuine human
// messages, relay/mesh envelopes, and (later) a being's own room fan-out. So a STOP
// here is definite: a stopped channel never reaches a brain at all.
//
// STOP is STRONGER than a mode pause: that blocks EMIT (the brain still runs, the
// reply is withheld). STOP blocks PROMPTING — the brain never runs. It is the human
// override that beats the being's own clock, short of killing the service.
//
// Two triggers, one state:
//   - operator safe-word: "STOP" (this channel) / "STOP ALL" (everything — egpt off
//     without killing the process); "RESUME" / "RESUME ALL" clears it.
//   - loop counter: per channel, count consecutive NON-HUMAN turns with no genuine
//     human turn between them (a "…" silence still consumes a slot). At the soft limit
//     → warn the channel; at the hard limit (`turns`) → auto-STOP the channel. A human
//     turn resets the count (so normal human↔bot talk never trips it); a STOP is
//     deliberate and clears only on RESUME.
//
// THE CRUX (what makes turn-counter-ONLY safe, closing the 2026-06-19 hole): "human"
// is decided by PROVENANCE, not display name (isHumanTurn). A turn resets the counter
// only when it is a genuine inbound human message — NOT a bot send (wasSentByUs, id-
// based), NOT relay/envelope traffic (isEnvelope), NOT a being's own emit. A mesh
// message posted AS the operator parses as an envelope here, so it is NON-human and
// counts toward the cap instead of resetting it — the exact case the removed flood-
// guard existed for.

// Parse an operator control safe-word out of a message body. Exact, case-
// insensitive, trailing punctuation tolerated. Returns the control or null.
export function parseStopWord(text) {
  const t = String(text ?? '').trim().toLowerCase().replace(/[.!\s]+$/, '');
  if (t === 'stop all' || t === 'stopall') return 'stop_all';
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
  const stoppedChannels = new Set();  // channels under STOP
  let stoppedAll = false;

  const blocked = (channel) => stoppedAll || stoppedChannels.has(channel);

  // Resolve the effective limits for a channel: a per-conversation override
  // ({ turns?, window? } from conversations.yaml) wins over the node defaults.
  const limitsOf = (override) => ({
    hard: Number.isFinite(override?.turns) ? override.turns : turns,
    windowMin: Number.isFinite(override?.window) ? override.window : window,
  });

  return {
    // Is prompting blocked for this channel? Checked at the top of the chokepoint.
    blocked,
    isStoppedAll: () => stoppedAll,

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
    stopAll() { stoppedAll = true; onLog('STOP ALL — egpt off (process still up)'); },
    resumeChannel(channel) { stoppedChannels.delete(channel); counts.set(channel, []); onLog(`RESUME ${channel}`); },
    resumeAll() { stoppedAll = false; stoppedChannels.clear(); counts.clear(); onLog('RESUME ALL'); },

    // Apply a parsed control word in a channel context.
    applyControl(word, channel) {
      if (word === 'stop_all') this.stopAll();
      else if (word === 'stop') this.stopChannel(channel);
      else if (word === 'resume_all') this.resumeAll();
      else if (word === 'resume') this.resumeChannel(channel);
    },

    status() { return { stoppedAll, stoppedChannels: [...stoppedChannels], counts: Object.fromEntries([...counts].map(([k, v]) => [k, v.length])) }; },
  };
}
