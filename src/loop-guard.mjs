// loop-guard.mjs — the loop guard's SEND rules (config loop_guard.outbound) and the one reader of
// the loop_guard: block (loopGuardConfig). Its TURN rules (loop_guard.inbound) are src/stop-guard.mjs
// createStopGuard.
//
// THE OUTBOUND CEILING (operator 2026-07-26): "this guard must be agnostic to everything, is a
// major loop that counts how many messages in a time window has been sent out to any limb ..."
// / "under no reason must the bridge exceed a normal sending rate. that is a self-regulated
// existance." / "... count outbound messages (completed) sent to beeper. that count cant exceed
// the threshold." (Named loop_guard, operator 2026-10-18.)
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
// REACTIONS COUNT AS NEITHER (react / unreact). They carry no text: a reaction is not a line
// in a chat. There is no third category and they belong in neither counter — do not re-add
// them reasoning "it is still traffic". There are no deletes (operator 2026-10-27).
//
// NOTHING INBOUND IS COUNTED HERE. The send rules wrap the ports' SEND surface only. A peer's
// message arriving at this node is the TURN rules' business (src/stop-guard.mjs, via
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
// Bot↔bot loops are the TURN rules' job now; this ceiling is the catastrophic backstop for a
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
// NEVER THE STOP PATH: a send carrying `{ bypassLoopGuard: true }` skips the gate entirely, and
// keeps skipping it AFTER a trip. A kill switch that cannot get out past the very flood it
// exists to end is not a kill switch — the node could not even announce its own halt.
//
// FILE CONTROLLED: the ceilings come from config loop_guard.outbound (loosen without a deploy)
// and a trip is published to EGPT_HOME/state/loop-guard.json — so "why did egpt stop" is
// answerable with `cat`, not a debugger. The hot path never does IO: the file is written on
// the trip only, once.
//
// ═══ PER CHAT: THE SEND RATE (operator 2026-10-18: "loop guard has to count how many messages
// are sent to beeper. a mere sustained rate of 5msg every 3 secs should be stopped.") ═══
// The same MESSAGES, counted per chat once boot calls bindChats. THREE RULES, each off at <= 0
// (operator, later that day: "one quick burst, even 12 in a second … it MUST" trip; "five equal
// sends or more in 2s"; "just changing a timestamp … should also trip it"):
//   similar   — ≥chatSimilarCount near-identical lines inside chatSimilarWindowMs (equal after
//               foldLine, or text-similarity's overlap ≥ chatSimilarRatio)
//   burst     — ≥chatBurstCount messages of any content inside chatBurstWindowMs
//   sustained — ≥chatMessages in each of the last two chatWindowMs windows
// A trip PAUSES that chat (onTrip → the turn rules' pause, which RESUME clears) instead of
// stopping the node; while paused its new lines are DROPPED — answered as said, so no caller
// re-routes them through another account. Edits and reactions are not counted, as above. Not
// counted, never held: bypassLoopGuard (the stop path) and systemLine (operator/system lines).
import { normalizeTokens, similarity } from './text-similarity.mjs';

const DEFAULTS = {
  messages: 18, windowMs: 10_000, edits: 4_000,
  chatMessages: 5, chatWindowMs: 3_000,
  chatSimilarCount: 5, chatSimilarWindowMs: 2_000, chatSimilarRatio: 0.85,
  chatBurstCount: 10, chatBurstWindowMs: 2_000,
};

// The pre-0044 top-level blocks, read for one release (remove with this constant).
export const LEGACY_BLOCKS = { inbound: 'guard', outbound: 'lasso' };

const isMap = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/**
 * config.yaml's loop_guard: block as { inbound, outbound } (each a plain object, {} when unset).
 * A half missing from loop_guard falls back to its pre-0044 block, logged once via onDeprecated.
 */
export function loopGuardConfig(cfg, { onDeprecated = () => {} } = {}) {
  const lg = isMap(cfg?.loop_guard) ? cfg.loop_guard : {};
  const out = {};
  const old = [];
  for (const [half, legacy] of Object.entries(LEGACY_BLOCKS)) {
    const has = isMap(cfg?.[legacy]);
    if (isMap(lg[half])) { out[half] = lg[half]; if (has) old.push(`${legacy}: ignored, loop_guard.${half} is set`); }
    else if (has) { out[half] = cfg[legacy]; old.push(`${legacy}: read as loop_guard.${half}`); }
    else out[half] = {};
  }
  if (old.length) onDeprecated(`deprecated config.yaml key(s) — ${old.join('; ')}. Migration 0044 moves them under loop_guard:`);
  return out;
}

/** A registry entry's own override of the inbound half: loop_guard.inbound, else its pre-0044 block. */
export function inboundOverrideOf(entry) {
  if (isMap(entry?.loop_guard?.inbound)) return entry.loop_guard.inbound;
  const old = entry?.[LEGACY_BLOCKS.inbound];
  return isMap(old) ? old : null;
}

/** How many registry entries (state.contacts) still carry the pre-0044 block. */
export function legacyEntryCount(state) {
  let n = 0;
  for (const bucket of Object.values(state?.contacts ?? {})) {
    for (const entry of Object.values(isMap(bucket) ? bucket : {})) if (isMap(entry?.[LEGACY_BLOCKS.inbound])) n++;
  }
  return n;
}

// Near-identical, folded: case, whitespace, Matrix ids, and every token carrying a digit
// (counters, timestamps, ids) — a loop that only bumps a timestamp is still one line.
const foldLine = (text) => String(text ?? '').toLowerCase()
  .replace(/[!$@][\w-]+:[\w.-]+/g, '#')
  .replace(/[\p{L}\p{N}_-]+/gu, (w) => (/\p{N}/u.test(w) ? '#' : w))
  .replace(/#(?:[\s:.,/]*#)+/g, '#')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * @param {object} o
 * @param {number} [o.messages]   committed messages allowed per window (<= 0 disables the send rules entirely)
 * @param {number} [o.windowMs]   the sliding window, ms
 * @param {number} [o.edits]      edits allowed per window (<= 0 disables the edit counter only)
 * @param {number} [o.chatMessages]  per-chat messages per window, sustained over two windows, that pause the chat (<= 0 off)
 * @param {number} [o.chatWindowMs]  the per-chat window, ms
 * @param {number} [o.chatSimilarCount]     near-identical messages per chatSimilarWindowMs that pause the chat (<= 0 off)
 * @param {number} [o.chatSimilarWindowMs]
 * @param {number} [o.chatSimilarRatio]     token overlap that counts as near-identical (<= 0: the fold alone)
 * @param {number} [o.chatBurstCount]       messages of any content per chatBurstWindowMs that pause the chat (<= 0 off)
 * @param {number} [o.chatBurstWindowMs]
 * @param {() => number} [o.now]  clock seam (tests drive it — no real waiting)
 * @param {(m: string) => void} [o.onLog]
 * @param {(s: object) => void} [o.writeState]  best-effort publisher for state/loop-guard.json (async, fire-and-forget)
 * @param {(t: object) => void} [o.onTrip]      the halt — boot routes it into the STOP file + clean exit
 */
export function createSendGuard({
  messages = DEFAULTS.messages,
  windowMs = DEFAULTS.windowMs,
  edits = DEFAULTS.edits,
  chatMessages = DEFAULTS.chatMessages,
  chatWindowMs = DEFAULTS.chatWindowMs,
  chatSimilarCount = DEFAULTS.chatSimilarCount,
  chatSimilarWindowMs = DEFAULTS.chatSimilarWindowMs,
  chatSimilarRatio = DEFAULTS.chatSimilarRatio,
  chatBurstCount = DEFAULTS.chatBurstCount,
  chatBurstWindowMs = DEFAULTS.chatBurstWindowMs,
  now = Date.now,
  onLog = () => {},
  writeState = null,
  onTrip = () => {},
} = {}) {
  const on = messages > 0 && windowMs > 0;
  const msgs = [];      // ms timestamps of the committed MESSAGES still inside the window
  const eds = [];       // ms timestamps of the committed EDITS still inside the window
  let tripped = null;   // the trip record — set ONCE, and the node is on its way down
  const perChat = new Map();   // chat key -> [{ t, fold, tokens }] inside the longest rule window
  let chats = null;            // bindChats: { keyOf, lineOf?, isPaused, onTrip }
  const live = (n, ms) => n > 0 && ms > 0;
  const similarOn = live(chatSimilarCount, chatSimilarWindowMs);
  const burstOn = live(chatBurstCount, chatBurstWindowMs);
  const sustainedOn = live(chatMessages, chatWindowMs);
  const keepMs = Math.max(similarOn ? chatSimilarWindowMs : 0, burstOn ? chatBurstWindowMs : 0, sustainedOn ? 2 * chatWindowMs : 0);
  const near = (a, b) => a.fold === b.fold || (chatSimilarRatio > 0 && similarity(a.tokens, b.tokens) >= chatSimilarRatio);

  // The rule this message completes, as [rule, the messages that make it], or null.
  function chatRule(w, me) {
    const within = (ms) => w.filter((e) => me.t - e.t < ms);
    if (similarOn && me.fold) {
      const same = within(chatSimilarWindowMs).filter((e) => e.fold && near(e, me));
      if (same.length >= chatSimilarCount) return ['similar', same];
    }
    if (burstOn) {
      const all = within(chatBurstWindowMs);
      if (all.length >= chatBurstCount) return ['burst', all];
    }
    if (sustainedOn) {
      const two = within(2 * chatWindowMs);
      const recent = two.filter((e) => me.t - e.t < chatWindowMs).length;
      if (recent >= chatMessages && two.length - recent >= chatMessages) return ['sustained', two];
    }
    return null;
  }

  // The per-chat verdict for one NEW message: true = it may leave; false = drop it (the chat is
  // paused, or this send completed a rule and paused it).
  function admitChat(chat, text, opts, port) {
    if (!chats || !(keepMs > 0) || opts?.systemLine) return true;
    const key = chats.keyOf(chat);
    if (key == null) return true;
    if (chats.isPaused(key)) { onLog(`dropped a send → ${chat} — the chat is paused`); return false; }
    const t = now();
    const fold = foldLine(chats.lineOf ? chats.lineOf(text) : text);
    const me = { t, fold, tokens: similarOn && chatSimilarRatio > 0 ? normalizeTokens(fold) : null };
    const w = (perChat.get(key) ?? []).filter((e) => t - e.t < keepMs);
    w.push(me);
    const hit = chatRule(w, me);
    if (!hit) { perChat.set(key, w); return true; }
    perChat.delete(key);
    const [rule, run] = hit;
    const spanMs = t - run[0].t;
    const why = `${rule}: ${run.length} ${rule === 'similar' ? 'near-identical ' : ''}messages in ${(spanMs / 1000).toFixed(1)}s`;
    let name = null;
    try { name = port.getChatName?.(chat) || null; } catch { /* the id names it */ }
    onLog(`send-rate TRIPPED on ${chat} — ${why} — pausing the chat`);
    try { chats.onTrip(key, { chat, name, rule, count: run.length, spanMs, why }); } catch (e) { onLog(`chat onTrip threw: ${e?.message ?? e}`); }
    return false;
  }

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
    async finish() {},
    delivered: false,
    lastError: 'loop guard: outbound ceiling tripped — egpt is stopping',
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

  // Wrap a LIMB PORT — the beeper port AND the shell port, both, from the ONE send guard, so the
  // count is node-wide rather than per-limb (the operator's "any limb"). A Proxy, not a
  // spread: the shell port exposes `isConnected` as a GETTER and a spread would freeze it to
  // its boot-time value. Everything the port has that is not a counted emit passes straight
  // through — react / unreact included, deliberately (see the header).
  function wrap(port) {
    // A per-chat drop: answered as said (see the header), never as a failure.
    const ok = (chat, text, opts) => admitChat(chat, text, opts, port);
    const droppedStream = () => ({ ...deadStream(), delivered: true, lastError: null });
    const gated = {
      // bypassLoopGuard: the STOP path. It must ALWAYS get out — see the module header.
      send: async (chat, text, opts = {}) =>
        opts?.bypassLoopGuard ? port.send(chat, text, opts)
          : !ok(chat, text, opts) ? { dropped: true }
          : admit('message') ? port.send(chat, text, opts) : (refuse('send', chat), null),
      postStatus: async (chat, text) =>
        !ok(chat, text) ? null : admit('message') ? port.postStatus(chat, text) : (refuse('postStatus', chat), null),
      // THE MOUTH's verbatim post (beeper-port.postVerbatim, operator 2026-09-05): a PEER SPINE's
      // finished line, said on this account. It leaves this node's limb like any other message —
      // the ceiling is "any limb", and an unwrapped path here would be a hole straight through it
      // — so it is admitted on the same 'message' budget as send(). No bypassLoopGuard: the stop path
      // is send()'s alone, and nothing arriving over the link is a stop.
      postVerbatim: port.postVerbatim && (async (chat, text) =>
        !ok(chat, text) ? { dropped: true } : admit('message') ? port.postVerbatim(chat, text) : (refuse('postVerbatim', chat), null)),
      // THE MOUTH's verbatim STREAM (beeper-port.startStreamVerbatim, operator 2026-09-05): the
      // peer's reply train, said on this account. Gated EXACTLY like startStream below and for the
      // same reason — ONE 'message' for the placeholder that is opened, then every frame that
      // edits it on the 'edit' budget — so a streamed reply arriving over the link costs the same
      // as a streamed reply this node writes itself, and costs it ONCE rather than once per token.
      // Leaving it ungated would be a hole straight through a node-wide ceiling, reachable from
      // another process.
      startStreamVerbatim: port.startStreamVerbatim && ((chat, init) =>
        !ok(chat, init) ? droppedStream() : admit('message') ? gateFrames(port.startStreamVerbatim(chat, init)) : (refuse('startStreamVerbatim', chat), deadStream())),
      sendMedia: port.sendMedia && (async (chat, filePath, opts = {}) =>
        !ok(chat, opts?.caption, opts) ? true : admit('message') ? port.sendMedia(chat, filePath, opts) : (refuse('sendMedia', chat), false)),
      startStream: port.startStream && ((chat, init, opts = {}) =>
        !ok(chat, init, opts) ? droppedStream() : admit('message') ? gateFrames(port.startStream(chat, init, opts)) : (refuse('startStream', chat), deadStream())),
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
    // The per-chat pause owner (boot: the turn rules' createStopGuard). keyOf(chat) → the chat's key, or null = not
    // counted; lineOf(text) → what was said (boot: normalizeLine — a ⏳ placeholder is ''); isPaused(key);
    // onTrip(key, { chat, name, rule, count, spanMs, why }). Unbound ⇒ no per-chat count.
    bindChats(b) { chats = b; },
    enabled: on,
    stats: () => ({ messages: msgs.length, edits: eds.length, tripped: tripped ? { ...tripped } : null }),
  };
}
