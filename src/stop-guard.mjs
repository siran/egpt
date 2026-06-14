// stop-guard.mjs — the bridge's DEFINITE kill-switch + bot↔bot loop-guard (C7.7).
//
// Pure state machine. The nucleus calls it at the SINGLE dispatch chokepoint
// (submitInner), through which EVERY prompt now flows — received messages AND
// self-generated ones (heartbeats, room fan-out are routed through the bridge,
// I1 sharpened). So a STOP here is definite: a stopped channel never reaches a
// brain at all.
//
// STOP is STRONGER than `auto_e_paused`: that blocks EMIT (the brain still runs,
// the reply is withheld). STOP blocks PROMPTING — the brain never runs. It is
// the human override that beats the being's own clock, short of killing the
// service. (operator 2026-06-13)
//
// Two triggers, one state:
//   - operator safe-word: "STOP" (this channel) / "STOP ALL" (everything — egpt
//     off without killing the process); "RESUME" / "RESUME ALL" clears it.
//   - loop-guard: per channel, count consecutive BEING turns with no human turn
//     between them (a "…" silence still consumes a slot). At the soft limit →
//     warn the channel; at the hard limit → auto-STOP the channel. A human turn
//     resets the count (so normal human↔bot talk never trips it); a STOP is
//     deliberate and clears only on RESUME.

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

export function createStopGuard({ softLimit = 4, hardLimit = 8, onLog = () => {} } = {}) {
  const counts = new Map();           // channel -> consecutive being turns
  const stoppedChannels = new Set();  // channels under STOP
  let stoppedAll = false;

  const blocked = (channel) => stoppedAll || stoppedChannels.has(channel);

  return {
    // Is prompting blocked for this channel? Checked at the top of submitInner.
    blocked,
    isStoppedAll: () => stoppedAll,

    // A human turn in a channel: reset the loop count so normal human↔bot
    // conversation never trips the guard. Does NOT clear an active STOP — that
    // is a deliberate override, cleared only by RESUME.
    noteHuman(channel) { counts.set(channel, 0); },

    // A being emitted a turn (a real reply OR a '…' silence — both consume a
    // slot, so a silent ping-pong can't run forever). Returns the loop-guard
    // action: 'warn' once at the soft limit, 'stop' at/after the hard limit.
    noteBeing(channel) {
      const n = (counts.get(channel) || 0) + 1;
      counts.set(channel, n);
      if (n >= hardLimit) return 'stop';
      if (n === softLimit) return 'warn';
      return 'none';
    },

    stopChannel(channel) { if (channel != null) { stoppedChannels.add(channel); onLog(`STOP ${channel}`); } },
    stopAll() { stoppedAll = true; onLog('STOP ALL — egpt off (process still up)'); },
    resumeChannel(channel) { stoppedChannels.delete(channel); counts.set(channel, 0); onLog(`RESUME ${channel}`); },
    resumeAll() { stoppedAll = false; stoppedChannels.clear(); counts.clear(); onLog('RESUME ALL'); },

    // Apply a parsed control word in a channel context.
    applyControl(word, channel) {
      if (word === 'stop_all') this.stopAll();
      else if (word === 'stop') this.stopChannel(channel);
      else if (word === 'resume_all') this.resumeAll();
      else if (word === 'resume') this.resumeChannel(channel);
    },

    status() { return { stoppedAll, stoppedChannels: [...stoppedChannels], counts: Object.fromEntries(counts) }; },
  };
}
