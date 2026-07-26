// lasso.mjs — THE OUTBOUND CEILING (operator 2026-07-26): "this guard must be agnostic to
// everything, is a major loop that counts how many messages in a time window has been sent
// out to any limb ... a big lasso that sandboxes egpt" / "under no reason must the bridge
// exceed a normal sending rate. that is a self-regulated existance." / "the lasso count
// outbound messages (completed) sent to beeper. that count cant exceed the threshold."
//
// WHY IT EXISTS (2026-07-25 incident, not theory): two nodes traded hundreds of messages
// ~0.7s apart until the service had to be killed. Nothing bounded what LEAVES the node.
// This does, and it does it structurally: the bridge cannot exceed the ceiling no matter
// what upstream asks of it, so no new caller can reintroduce the class.
//
// TRIP, NOT THROTTLE (operator 2026-07-26, a deliberate reversal of the previous design):
// "oh, by throttle i did actually mean stop. there is probably a bug if there is flooding"
// / "bridge stops looping until human intervention". Sustained flooding is a SYMPTOM OF A
// BUG, and pacing a bug only makes it slower. So there is no queue, no drain, no waiting a
// turn: the message that would exceed the ceiling is not sent late, it STOPS THE NODE.
//
// HOW IT STOPS — THE EXISTING PRIMITIVE, never a second one. `onTrip` is wired in
// src/spine/boot.mjs to the SAME stopSwitch.pull the STOP safe word uses: it writes
// EGPT_HOME/STOP (which explains itself, naming the flood and the rate) and exits with
// CLEAN_EXIT_CODE, so the daemon does not respawn, the file survives a reboot, and
// setup/start-egpt.cmd — a human act — is the only way back. No second exit code, no second
// state file, no second halt path.
//
// ═══ TWO COUNTERS, ONE TRIP ACTION (operator 2026-07-26: "only count outbound messages or
// edits" / "edits have to be counted too, albeit separately, to avoid an infinite-edit
// scenario") ═══
//
//   MESSAGES — a NEW line in someone's chat: send / startStream (its placeholder) /
//     postStatus / sendMedia. Ceiling 18 per window.
//   EDITS    — a PUT into a message ALREADY counted: stream.update, stream.finish,
//     stream.fail, editStatus, editOwn. Ceiling 4000 per window.
//
// They are NOT merged and they are NOT peers, because the harm is not the same (operator:
// "endless edit is not annoying, 100 messages are"). 100 new messages IS the damage — that
// is what 2026-07-25 felt like from the inside — while an endless edit makes ONE line
// flicker and costs nothing but API traffic. So the message ceiling protects a person and
// is deliberately tight; the edit ceiling is only a backstop against a pathological loop
// hammering the API forever, and is deliberately loose. THE ASYMMETRY IS THE DESIGN — do
// not "fix" it by bringing them together.
//
// stream.finish is an EDIT, not a message: it PUTs the final text into the placeholder that
// startStream already counted, so counting it as a message would charge one ordinary reply
// twice. It is counted rather than left out because an uncounted PUT is exactly the seam an
// infinite-edit runaway would sit in.
//
// REACTIONS AND DELETES COUNT AS NEITHER (react / deleteStatus / deleteOwn). They carry no
// text: a reaction is not a line in a chat and a delete removes one. There is no third
// category and they belong in neither counter — do not re-add them reasoning "it is still
// traffic".
//
// NOTHING INBOUND IS COUNTED HERE. The lasso wraps the ports' SEND surface only. A peer's
// message arriving at this node is the LOOP GUARD's business (src/stop-guard.mjs, via
// ev.fromNode). Two mechanisms, cleanly separated.
//
// WHY 18/10000ms — AND WHY THIS IS NOT A LOOSENING (operator 2026-07-26, after a mesh
// reply-mirror was found billing an EDIT as a MESSAGE: "it's ok, it's a matter of raising the
// limits: instead of 6 in 10, 18 in 10?"). The prior 20/5000ms allowed a SUSTAINED rate of 4
// messages/second; 18/10000ms allows 1.8/s — LESS THAN HALF — while widening the WINDOW so a
// legitimate flurry (a voice-note reply flurry, a mesh exchange, two agents answering at once)
// has room to land inside one window instead of straddling two. A longer window smooths a
// burst; it does not raise what a SUSTAINED flood is allowed to do. Do not "fix" the number
// back to 20/5000ms reading it as a bug — the lower rate is the point.
//
// The incident ran at roughly 1.4 outbound/s per node — still well under 1.8/s — so this
// ceiling would NOT have caught it, same as 20/5000ms would not have. It does not have to:
// a64b209 fixed the reason it had to. A peer's message now carries `ev.fromNode`, isHumanTurn
// returns false, and the loop counter finally moves on exactly the traffic it used to miss.
// Bot↔bot loops are the LOOP GUARD's job now; the lasso is the catastrophic backstop for a
// runaway that outruns even that. A tighter number would halt the node on ordinary traffic —
// three quick human lines, a voice-note flurry, a room fan-out — which is worse than none.
//
// WHY THE EDIT CEILING IS SO MUCH LARGER. It is counted HERE, at the port, ABOVE the limb's
// own 400ms edit debounce (src/bridges/beeper.mjs EDIT_MIN_MS) — so what it sees is not API
// PUTs (≤ ~13 per 5s per stream) but `update()` CALLS, and those fire once per streamed
// token delta (src/warm-cli-session.mjs — onUpdate per content_block_delta). One long reply
// is therefore already several hundred per window, and a room fan-out multiplies that by
// the number of brains. 4000/10000ms keeps the SAME rate as the old 2000/5000ms (erring high
// on purpose, not left at the old absolute count, which would have quietly HALVED the rate
// on a window that is now twice as long) — plenty of room while a genuine runaway — which is
// unbounded by definition, with no I/O between iterations — crosses it in milliseconds either
// way. Erring high is the correct trade: a false trip halts the node mid-conversation, a late
// trip costs some wasted API calls on a line nobody is reading twice.
//
// NEVER THE STOP PATH: a send carrying `{ bypassLasso: true }` skips the gate entirely, and
// keeps skipping it AFTER a trip. A kill switch that cannot get out past the very flood it
// exists to end is not a kill switch — the node could not even announce its own halt.
//
// FILE CONTROLLED: the ceilings come from the config's `lasso:` block (loosen without a
// deploy) and a trip is published to EGPT_HOME/state/lasso.json — so "why did egpt stop" is
// answerable with `cat`, not a debugger. The hot path never does IO: the file is written on
// the trip only, once.

const DEFAULTS = { messages: 18, windowMs: 10_000, edits: 4_000 };

/**
 * @param {object} o
 * @param {number} [o.messages]   committed messages allowed per window (<= 0 disables the lasso entirely)
 * @param {number} [o.windowMs]   the sliding window, ms
 * @param {number} [o.edits]      edits allowed per window (<= 0 disables the edit counter only)
 * @param {() => number} [o.now]  clock seam (tests drive it — no real waiting)
 * @param {(m: string) => void} [o.onLog]
 * @param {(s: object) => void} [o.writeState]  best-effort publisher for state/lasso.json (async, fire-and-forget)
 * @param {(t: object) => void} [o.onTrip]      the halt — boot routes it into the STOP file + clean exit
 */
export function createLasso({
  messages = DEFAULTS.messages,
  windowMs = DEFAULTS.windowMs,
  edits = DEFAULTS.edits,
  now = Date.now,
  onLog = () => {},
  writeState = null,
  onTrip = () => {},
} = {}) {
  const on = messages > 0 && windowMs > 0;
  const msgs = [];      // ms timestamps of the committed MESSAGES still inside the window
  const eds = [];       // ms timestamps of the committed EDITS still inside the window
  let tripped = null;   // the trip record — set ONCE, and the node is on its way down

  // THE CEILING. true = it may leave. false = the node is stopping (this call tripped it, or
  // an earlier one did). Synchronous: nothing waits, so there is nothing to await.
  function admit(kind) {
    if (!on) return true;
    if (tripped) return false;
    const isEdit = kind === 'edit';
    const cap = isEdit ? edits : messages;
    if (!(cap > 0)) return true;                       // edits: 0 → that counter is off
    const w = isEdit ? eds : msgs;
    const t = now();
    while (w.length && t - w[0] >= windowMs) w.shift();
    if (w.length < cap) { w.push(t); return true; }
    trip(kind, cap, w.length + 1, t);
    return false;
  }

  // Loudly, and ONCE. The operator must be able to tell a flood-stop from a safe-word stop
  // without reading code, so the cause AND the rate ride the log line, the on-disk state and
  // the STOP file's `reason:` (boot passes it straight through).
  function trip(kind, cap, count, t) {
    const reason = `outbound ${kind} flood — ${count} ${kind}s in ${windowMs}ms (ceiling ${cap})`;
    tripped = { kind, count, limit: cap, window_ms: windowMs, at: new Date(t).toISOString(), reason };
    onLog(`TRIPPED: ${reason} — stopping the node`);
    if (writeState) {
      try {
        writeState({
          at: tripped.at,
          state: 'tripped',
          limit: { messages, edits, window_ms: windowMs },
          messages_in_window: msgs.length,
          edits_in_window: eds.length,
          tripped,
        });
      } catch { /* visibility must never break the stop path */ }
    }
    try { onTrip(tripped); } catch (e) { onLog(`onTrip threw (${e?.message ?? e}) — stopping anyway`); }
  }

  // Run `fn` behind the ceiling — the seam for an emit that is NOT a port method. The 👂 echo
  // is the one such emit: it is posted from INSIDE the beeper limb (src/bridges/beeper.mjs),
  // below the port, so it takes the ceiling directly instead of being missed by it.
  async function gate(fn) {
    if (admit('message')) return fn();
    onLog('refused an in-limb emit — the node is stopping');
    return null;
  }

  const refuse = (what, chat) => { onLog(`refused ${what} → ${chat} — the node is stopping`); };

  // What a refused startStream hands back: the sender writes frames into it without checking,
  // and a null would throw on a node that is merely on its way out.
  const deadStream = () => ({
    update() {}, fail() {},
    async finish() {}, async delete() {},
    delivered: false,
    lastError: 'lasso: outbound ceiling tripped — egpt is stopping',
  });

  // The frames that follow a placeholder EDIT a message already counted, so they spend the
  // EDIT budget and never the message one. A Proxy, not a spread: `delivered` / `lastError`
  // are GETTERS on the real handle and must stay live.
  function gateFrames(h) {
    if (!h) return h;
    const framed = {
      update: (v) => { if (admit('edit')) h.update?.(v); },
      finish: async (v, o) => (admit('edit') ? h.finish?.(v, o) : undefined),
      fail: (e) => { if (admit('edit')) h.fail?.(e); },
    };
    return new Proxy(h, { get: (t, k) => (Object.hasOwn(framed, k) ? framed[k] : Reflect.get(t, k, t)) });
  }

  // Wrap a LIMB PORT — the beeper port AND the shell port, both, from the ONE lasso, so the
  // count is node-wide rather than per-limb (the operator's "any limb"). A Proxy, not a
  // spread: the shell port exposes `isConnected` as a GETTER and a spread would freeze it to
  // its boot-time value. Everything the port has that is not a counted emit passes straight
  // through — react / deleteStatus / deleteOwn included, deliberately (see the header).
  function wrap(port) {
    const gated = {
      // bypassLasso: the STOP path. It must ALWAYS get out — see the module header.
      send: async (chat, text, opts = {}) =>
        (opts?.bypassLasso || admit('message')) ? port.send(chat, text, opts) : (refuse('send', chat), null),
      postStatus: async (chat, text) =>
        admit('message') ? port.postStatus(chat, text) : (refuse('postStatus', chat), null),
      sendMedia: port.sendMedia && (async (chat, filePath, opts = {}) =>
        admit('message') ? port.sendMedia(chat, filePath, opts) : (refuse('sendMedia', chat), false)),
      startStream: port.startStream && ((chat, init, opts = {}) =>
        admit('message') ? gateFrames(port.startStream(chat, init, opts)) : (refuse('startStream', chat), deadStream())),
      editStatus: port.editStatus && ((chat, msgId, text) =>
        admit('edit') ? port.editStatus(chat, msgId, text) : (refuse('editStatus', chat), null)),
      editOwn: port.editOwn && ((chat, msgId, text, opts = {}) =>
        admit('edit') ? port.editOwn(chat, msgId, text, opts) : (refuse('editOwn', chat), null)),
    };
    return new Proxy(port, {
      get: (t, k) => (Object.hasOwn(gated, k) && gated[k] ? gated[k] : Reflect.get(t, k, t)),
    });
  }

  return {
    wrap,
    gate,
    enabled: on,
    stats: () => ({ messages: msgs.length, edits: eds.length, tripped: tripped ? { ...tripped } : null }),
  };
}
