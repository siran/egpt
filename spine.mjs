// spine.mjs — the true spine (rewrite). One legible loop with explicitly-wired
// layers, replacing the ~7,000-line `startSpineRuntime()` god-closure.
//
//   > egpt is a simple loop that executes heartbeats and receives/sends
//   > messages through a brain.
//
// The whole heart is below: boot wires PORTS (injected interfaces the loop
// depends on) and SERVICES (domain logic), then the loop drains an inbound queue
// and ticks on a timer. See SPINE-REWRITE-PLAN.md §2.
//
// The single discipline that prevents re-drift into a god-closure: every
// dependency is INJECTED via createSpine({...}); the loop wires every
// cross-service call. No service reaches into another through a shared closure.
// That injection is also what makes the whole pipe unit-testable with a fake
// Bridge + fake Brain — no network, no Claude process (tests/spine-pipe.test.mjs).
//
// Phase 1 scope (SPINE-REWRITE-PLAN.md §4, §6): the receive → gate → brain →
// reply → send pipe, proven against fakes. Mesh forwarding, voice/media, and the
// shell/slash console are layered in after v1, each behind its service seam.
import { makeSerialByKey } from './src/serial-by-key.mjs';
import { isBrainFailureResult } from './src/brain-errors.mjs';
import { replyLine } from './src/transcript-log.mjs';

// ---------------------------------------------------------------------------
// Ports — the interfaces the loop depends on (injected, never global). §2b.
// ---------------------------------------------------------------------------
/**
 * @typedef {object} Bridge   A chat surface (WhatsApp/Telegram via Beeper, shell, ext).
 * @property {(cb: (msg: any) => void) => void} onMessage  register inbound handler
 * @property {(chat: string, text: string) => void} send   one-shot outbound
 * @property {() => void} [stop]
 *
 * @typedef {object} Brain   A warm/cold being turn. The warm pool hides behind this.
 * @property {(being: string, ev: InboundEvent, onPartial?: Function, ctx?: object) => Promise<{text: string, sessionId?: string}>} turn
 *
 * @typedef {object} Store   contact ops + thread/state persistence (conversations-state).
 * @property {(rec: {ev: InboundEvent, reply: any, being: string}) => void} [recordThread]
 *
 * @typedef {object} Clock   { now() } — injected for testability.
 * @property {() => number} now
 *
 * @typedef {object} Log     { line, file } — boot/diagnostic output sink.
 * @property {(s: string) => void} [line]
 */

// ---------------------------------------------------------------------------
// The message envelope — the carrier of every spine contract. §3. Built ONCE by
// the identity service (`identity.build`), consumed by all paths (C7.6e).
// ---------------------------------------------------------------------------
/**
 * @typedef {object} InboundEvent
 * @property {string} surface   the bridge surface tag
 * @property {string} node      entry point the message arrived through ('wa'|'kg'|'chrome')
 * @property {string} chatId    stable chat/room id (gating + delivery key — never a display name)
 * @property {string} chatName
 * @property {string} senderId  stable sender id
 * @property {string} senderName
 * @property {string} msgId     stable, addressable message id (#id)
 * @property {number} ts        epoch ms
 * @property {string} body
 * @property {object} [quoted]
 * @property {'text'|'media'|'reaction'|'edit'} kind
 * @property {string} [line]    the formatted dispatch line every brain sees
 * @property {any}    raw       the bridge's original payload
 */

// ---------------------------------------------------------------------------
// Services — domain logic the loop orchestrates (DI-wired at boot). §2c.
// ---------------------------------------------------------------------------
/**
 * @typedef {object} Services
 * @property {{ build: (msg: any) => InboundEvent }} identity            classify + build the dispatch line
 * @property {{ resolve: (ev: InboundEvent) => { being: string, mention?: object } }} router   @being → { local being target, mention ride-along } (a sibling routed by its own @name rides a synthetic mention for its gate)
 * @property {{ decide: (being: string, ev: InboundEvent, mention?: object) => Promise<{mode: string, receives: boolean, mayReply: boolean, sendToEgpt: 'always'|'mode'}>,
 *             surfaces: (decision: object, replyText: string) => boolean }} gating   per-conversation mode + send_to_egpt → run/surface decisions
 * @property {{ open: (chatId: string) => { update: (partial: any) => void, finish: (reply: any) => Promise<void>, fail?: (e: any) => void } }} sender   live-stream delivery (open → update* → finish)
 * @property {{ log: (ev: InboundEvent, reply?: any) => void }} transcript   "file is the conversation"
 * @property {{ runDue: (now: number) => void }} heartbeats               due-heartbeat scan + accum flush
 */

/**
 * Build the spine. Nothing starts until start(). All deps are injected so the
 * pipe is exercisable end-to-end against fakes.
 *
 * @param {{ bridge: Bridge, brain: Brain, store?: Store, clock?: Clock, log?: Log,
 *           tickMs?: number, setInterval?: Function, clearInterval?: Function } & Services} deps
 */
export function createSpine({
  bridge, brain, store,
  identity, router, gating, sender, transcript, heartbeats,
  commands,                            // optional §2c command intercept (operator slash commands)
  mesh,                                // optional §2c mesh service (Phase 4b cross-node relay)
  actions,                             // optional §2c reply-actions service (E's limbs: react/reply/media/edit/delete emitted in a reply)
  advice,                              // optional §2c advice service (mode: auto — /ask + operator-answer routing)
  defaultBeing = 'e',                  // the persona a mesh-target message is gated as (it's still THIS chat's message)
  clock = { now: () => Date.now() },
  log = {},
  tickMs = 0,
  // DEFECT 2 (operator 2026-07-04, "there should be a bridge timeout?"): a per-turn
  // backstop. 10 min — a genuinely wedged/hung CLI, never a legitimately long
  // tool-heavy turn (WebSearch+WebFetch+deep reasoning finish well under it). On
  // expiry the turn fails VISIBLY, the warm entry is evicted (a hung process must
  // not poison the next turn), and the queue drains on. 0 disables (tests that don't
  // exercise it). The warm pool itself stays timeout-free BY DESIGN (operator
  // 2026-06-12 removed its "fake timeout" that guillotined legit turns) — this is
  // the higher, generous bridge-level guard, not that one.
  turnTimeoutMs = 600_000,
  setInterval: setIntervalFn = globalThis.setInterval,
  clearInterval: clearIntervalFn = globalThis.clearInterval,
  setTimeout: setTimeoutFn = globalThis.setTimeout,
  clearTimeout: clearTimeoutFn = globalThis.clearTimeout,
  // Randomness for the auto-mode humanization (dwell + typing time), injected so
  // tests are deterministic. Defaults to Math.random.
  rng = Math.random,
} = {}) {
  for (const [name, dep] of Object.entries({ bridge, brain, identity, router, gating, sender, transcript, heartbeats })) {
    if (!dep) throw new Error(`createSpine: missing required dependency '${name}'`);
  }
  const note = (s) => { try { log.line?.(s); } catch {} };

  // --- the inbound queue (event-driven half). Bridge callbacks push; ONE async
  //     pump drains the FAST phase serially — identity → command/mesh → route →
  //     gate → open THIS mention's placeholder → dispatch its turn — so arrival
  //     order and conversation-state reads never interleave. The pump does NOT run
  //     the brain turn inline: the turn goes onto a PER-CONVERSATION FIFO queue
  //     (turnBy), so a second mention that arrives while a conversation's train is
  //     still in flight is QUEUED behind it (never dropped, never interrupting,
  //     never concurrent on the same warm key; replies land in order under their
  //     own placeholders), while a DIFFERENT conversation's turn runs FULLY
  //     concurrently. The FAST phase is quick, so the shared pump no longer blocks
  //     one chat behind another chat's slow turn. Each entry carries its enqueue
  //     time so stats() can report the oldest pending message's age. ---
  const queue = [];
  let pumping = null;
  const turnBy = makeSerialByKey();           // per-conversation turn FIFO (the §7 "one turn at a time per key")
  const trains = new Map();                    // convKey -> in-flight+queued turn count (drives the queued placeholder)
  function bumpTrain(key) { const ahead = trains.get(key) ?? 0; trains.set(key, ahead + 1); return ahead; }
  function dropTrain(key) { const n = (trains.get(key) ?? 1) - 1; if (n <= 0) trains.delete(key); else trains.set(key, n); }

  // --- Per-conversation CYCLE accumulation (operator 2026-07-04: "when addressing the
  //     queued messages … it should accumulate messages, even E's own past replies in
  //     the cycle"). While a turn is in flight, ambient lines pile up per conversation:
  //     non-mention chatter (the logged-only branch) AND E's OWN delivered replies. When
  //     a QUEUED turn finally starts it drains that buffer and prompts with the whole
  //     accumulated cycle ENDING with its own mention line — the model sees one coherent
  //     timeline block, not just its lone mention. An IMMEDIATE turn (nothing was ahead)
  //     drains-and-discards it and keeps today's single-line prompt, so the drained
  //     buffer also marks the baseline the NEXT turn's cycle starts from.
  //
  //     Source = THIS in-memory buffer, not a transcript.md re-read: E's own reply is
  //     pushed at the exact turn-completion chokepoint (below), so the buffer CAN'T miss
  //     it (the operator's "can't miss E's own replies" bar), and there is no file
  //     offset/parse/ordering race — the mention's inbound line is itself only written to
  //     transcript.md at turn completion, so a re-read would race it. Bounded (CYCLE_CAP)
  //     so a chat that chatters without ever mentioning E can't grow it without limit.
  const CYCLE_CAP = 40;
  const cycleBy = new Map();                    // convKey -> string[] (ambient lines, arrival/delivery order)
  function pushCycle(key, line) {
    const s = String(line ?? '').trim();
    if (!s) return;
    const arr = cycleBy.get(key) ?? [];
    arr.push(s);
    while (arr.length > CYCLE_CAP) arr.shift();
    cycleBy.set(key, arr);
  }
  function drainCycle(key) { const arr = cycleBy.get(key) ?? []; cycleBy.delete(key); return arr; }

  // --- AUTO-MODE HUMANIZATION (operator 2026-07-05, "it should take time to answer …
  //     they wander off like a normal person"). AUTO CHATS ONLY — every other mode is
  //     byte-for-byte unchanged. Two timers, both PRE/POST the turn (never inside the
  //     turn-timeout budget), both randomized via the injected rng:
  //
  //     1) DWELL (pre-turn): a person messaging an auto chat does NOT get an instant
  //        reply. The message is logged + accumulated into the cycle, and a randomized
  //        dwell is armed; more messages RESET/extend it (a human reads the whole burst,
  //        then answers once). When the dwell expires ONE turn fires, draining the whole
  //        accumulated burst. Bounded by a hard CAP from the first message so a chatty
  //        burst can't starve the reply forever.
  //     2) TYPING TIME (pre-send, in runReplyTurn): the plain post-once send is delayed
  //        by a typing-speed function of the reply length, so the reply doesn't land the
  //        instant the model finishes.
  //
  //     Constants (why these): DWELL 45s floor (a person doesn't pounce) to a 4-min ceiling
  //     for the common uniform window, with a ~15% chance of a longer tail out to 8 min
  //     (the "wandered off" case) — the operator's suggested ~45s–4min "with occasional
  //     longer tails". CAP 10 min from the FIRST message: matches the turn-timeout budget
  //     (the node's "this long = act now" bound) and no human ignores an active chat much
  //     longer before answering the burst; a re-arming burst therefore can't push the reply
  //     past 10 min. Pending dwells are IN-MEMORY: a restart loses them (the next message
  //     re-arms — acceptable).
  const DWELL_MIN_MS = 45_000;
  const DWELL_MAX_MS = 240_000;      // 4 min — top of the common uniform window
  const DWELL_TAIL_MS = 480_000;     // 8 min — ceiling of the occasional long tail
  const DWELL_TAIL_P = 0.15;         // ~15% of arms draw the long tail
  const DWELL_CAP_MS = 600_000;      // 10 min hard cap on TOTAL dwell from the first message
  function dwellDuration() {
    const base = DWELL_MIN_MS + rng() * (DWELL_MAX_MS - DWELL_MIN_MS);            // 45s–4min uniform
    const tail = rng() < DWELL_TAIL_P ? rng() * (DWELL_TAIL_MS - DWELL_MAX_MS) : 0; // occasional +0–4min
    return base + tail;
  }
  // Typing time ≈ 50 wpm (~5.7 chars/word → ~210 ms/char), jittered ±30% (≈40–65 wpm),
  // a 2s floor for a one-liner and a 90s cap so a long reply can never wedge the send.
  const TYPING_MS_PER_CHAR = 210;
  const TYPING_JITTER = 0.3;
  const TYPING_MIN_MS = 2_000;
  const TYPING_CAP_MS = 90_000;
  function typingDelay(text) {
    const base = String(text ?? '').length * TYPING_MS_PER_CHAR;
    const jitter = 1 + (rng() * 2 - 1) * TYPING_JITTER;        // 0.7–1.3
    return Math.min(TYPING_CAP_MS, Math.max(TYPING_MIN_MS, base * jitter));
  }
  async function sleepTyping(text) {
    const ms = typingDelay(text);
    if (!(ms > 0)) return;
    await new Promise((resolve) => { const t = setTimeoutFn(resolve, ms); t?.unref?.(); });
  }

  // Pending dwells, keyed by turnKey. Each holds the LATEST triggering ev (what the fired
  // turn quotes/records) + firstAt (the CAP anchor). The burst content itself lives in the
  // cycle (cycleBy), so a fired dwell just drains it — no separate message buffer.
  const dwellBy = new Map();
  function armDwell(turnKey, ctx) {
    const existing = dwellBy.get(turnKey);
    const firstAt = existing?.firstAt ?? clock.now();
    if (existing?.timer) clearTimeoutFn(existing.timer);
    const remaining = Math.max(0, DWELL_CAP_MS - (clock.now() - firstAt));       // shrinks as the burst runs
    const wait = Math.min(dwellDuration(), remaining);
    const timer = setTimeoutFn(() => { fireDwell(turnKey).catch((e) => note(`dwell ${turnKey}: ${e?.message ?? e}`)); }, wait);
    timer?.unref?.();
    dwellBy.set(turnKey, { ...ctx, timer, firstAt });
  }
  // A message arriving mid-dwell (incl. the operator's own accumulated line) re-arms the
  // timer, keeping the SAME trigger — no-op when no dwell is pending.
  function extendDwell(turnKey) {
    const cur = dwellBy.get(turnKey);
    if (cur) armDwell(turnKey, { to: cur.to, ev: cur.ev, mention: cur.mention });
  }
  // The dwell expired: re-read the gate (a mid-dwell /e flip AWAY from auto cancels the
  // pending dwell cleanly — the timer fires but dispatches NO turn; the accumulated cycle
  // stays for whenever a turn next runs). Robust to any mode change without cross-service
  // wiring. Still auto → dispatch ONE reply turn onto the per-conversation FIFO, draining
  // the whole accumulated burst (preLogged: every burst line was already logged at arrival).
  async function fireDwell(turnKey) {
    const entry = dwellBy.get(turnKey);
    if (!entry) return;
    dwellBy.delete(turnKey);
    const { to, ev, mention } = entry;
    let d;
    try { d = await gating.decide(to, ev, mention); }
    catch (e) { note(`dwell ${turnKey}: re-decide failed — ${e?.message ?? e}`); return; }
    if (d.mode !== 'auto' || !d.mayReply) { note(`dwell ${turnKey}: mode ${d.mode} — dwell dropped (no auto reply)`); return; }
    const m = mention ?? {};
    const replyTo = (m.atEAnywhere || m.atEStart || m.replyToBot) ? ev.msgId : null;
    const ahead = bumpTrain(turnKey);
    const out = sender.open(ev.chatId, { being: to, replyTo, auto: true });
    turnBy(turnKey, () => runReplyTurn({ to, ev, d, out, turnKey, queued: ahead > 0, preLogged: true }));
  }

  // enqueue resolves when THIS message's turn (if any) completes, so a caller — and
  // the pipe tests — can await a message end-to-end even though the pump itself
  // returns as soon as the fast phase has dispatched the turn.
  function enqueue(msg) {
    let settle; const done = new Promise((r) => { settle = r; });
    queue.push({ msg, at: clock.now(), settle });
    pump();
    return done;
  }
  function pump() {
    if (pumping) return pumping;
    pumping = (async () => {
      try {
        while (queue.length) {
          const entry = queue.shift();
          let r;
          try { r = await handleFast(entry.msg); }
          catch (e) { note(`inbound: ${e?.message ?? e}`); }
          // settle the caller's promise when this message's turn (if any) finishes;
          // a message that runs no turn (logged-only / command / off) settles now.
          Promise.resolve(r?.turn).then(entry.settle, entry.settle);
        }
      } finally { pumping = null; }
    })();
    return pumping;
  }
  // Pump observability: depth of the (not-yet-started) FAST queue and how long its
  // oldest entry has waited. 0/0 when empty. Bookkeeping, not machinery.
  function stats() {
    const oldest = queue[0];
    return { queueDepth: queue.length, oldestMs: oldest ? clock.now() - oldest.at : 0 };
  }

  // Process a message end-to-end (fast phase + its turn). Bridge inbound flows
  // through enqueue/pump; direct callers (tests, the mesh seam) use this.
  async function handleInbound(msg) {
    const r = await handleFast(msg);
    if (r?.turn) await r.turn;
  }

  // --- the FAST phase of the receive → gate → route → reply pipe (§2a). Every
  //     RECEIVED message (everything except 'off') is logged to the transcript: a
  //     received message is never silently dropped (C1.2); 'off' is not received at
  //     all. Returns `{ turn }` — the dispatched turn's completion promise wrapped so
  //     the pump does NOT await it (a bare `return turnBy(...)` from this async fn
  //     would ADOPT the promise and re-serialize every turn globally) — or undefined
  //     when the message runs no turn. ---
  async function handleFast(msg) {
    const ev = identity.build(msg);

    // BACKLOG BACKFILL (operator 2026-07-08, S3 wake): a message older than bridge start —
    // the node slept and woke to a replay — is transcript-logged (the record stays complete)
    // but NEVER dispatched: no command, no mesh, no gate, no mode:on (the woken node backfills,
    // it does not re-answer stale traffic).
    if (ev.backlog) { await transcript.log(ev); return; }

    // operator slash command (Self DM / authorized) → handled here, NEVER routed
    // to the brain. Logged like any inbound, then executed (lifecycle exits the
    // process; the daemon respawns). Runs before gating: a /restart works even in
    // a muted/mention chat.
    if (commands?.isCommand?.(ev)) { await transcript.log(ev); await commands.run(ev); return; }

    // Inbound mesh envelope: a message carrying a provenance tail is relay traffic,
    // not chat — decode + act on it (a request at the responder, a reply/mirror-update
    // at the origin) and stop. Detected EARLY, before gating: an envelope is ADDRESSED
    // traffic, so it bypasses this chat's ambient reply modes (the responder's own
    // being-turn still respects that being's availability, inside mesh.handle). Logged
    // like any received message first (C1.2).
    if (mesh?.isEnvelope?.(ev)) { await transcript.log(ev); await mesh.handle(ev); return; }

    // Advice answer (mode: auto): the operator quote-replied in the advice channel to one
    // of E's /ask questions — route that answer into the ORIGIN conversation instead of
    // treating it as a message in the advice channel. Detected EARLY, before gating, so
    // the operator's reply never triggers a normal E reply where the ask was posted.
    // Logged like any received message first (C1.2). routeAnswer is fire-and-forget.
    if (advice?.isAnswer?.(ev)) { await transcript.log(ev); await advice.routeAnswer(ev); return; }

    // Router picks the being + the mention that being's gate should see. The real
    // router returns { being, mention } (with an optional { mesh } target for an
    // @being.node on ANOTHER node); a bare-string return (older/other fakes) is
    // tolerated as the being with ev.mention unchanged.
    const routed = router.resolve(ev);
    const meshTarget = (routed && typeof routed === 'object') ? (routed.mesh ?? null) : null;
    const to = (typeof routed === 'string' ? routed : routed.being) ?? defaultBeing;
    const mention = (typeof routed === 'string' ? null : routed.mention) ?? ev.mention;

    // ONE conversation-state read resolves this message's policy (mode +
    // send_to_egpt, both from conversations.yaml) and the derived gate flags. The
    // routed mention is passed explicitly (it's the sibling's, not @e's, when a
    // sibling was routed by its own @name).
    const d = await gating.decide(to, ev, mention);

    // 'off' → not received: not logged, not processed (C4). Every OTHER mode is
    // logged below — a received message is never silently dropped (C1.2).
    if (!d.receives) return;

    // Per-conversation turn key = the routed being + this conversation. It maps 1:1
    // to the warm-pool key (`<being>:<engine>:<surface>:<slug>`) at the granularity
    // that matters — same being, same chat — so serializing on it is exactly "one
    // turn at a time per warm key". Different chats (or different beings) key apart
    // and run concurrently. Also the CYCLE key: ambient lines accumulate under it so a
    // later queued mention on the same conversation drains exactly this chat's cycle.
    const turnKey = `${to}:${ev.surface}:${ev.chatId}`;

    // mode:auto is an IMPERSONATION of the operator: E replies to OTHER people AS the
    // operator, and the operator's OWN messages (isSender) here NEVER prompt E. Log +
    // accumulate the line into this conversation's cycle so the NEXT other-person turn is
    // prompted WITH it (full context), and run no turn. Only the operator's genuinely-
    // typed lines reach here — E's own auto replies come back isSender too but are dropped
    // upstream by the bridge's sent-ids echo guard (isEcho), never re-entering the spine.
    if (d.mode === 'auto' && ev.isSender) { await transcript.log(ev); pushCycle(turnKey, ev.line ?? ev.body); extendDwell(turnKey); return; }

    // Does E actually RUN on this message? It runs when its reply could surface
    // (mayReply), OR when the chat is send_to_egpt:'always' (E stays in context
    // even when it won't reply). Otherwise the message is logged only — E reads
    // transcript.md for back-context if it later engages ('not contacted yet') — AND
    // the line joins the conversation's cycle, so a queued mention arriving next sees
    // this ambient chatter in its accumulated prompt.
    const runE = d.mayReply || d.sendToEgpt === 'always';
    if (!runE) { await transcript.log(ev); pushCycle(turnKey, ev.line ?? ev.body); return; }

    // mesh-target forwarding (Phase 4b): an @being.node that lives on ANOTHER node is
    // not a local brain. Once gating has decided this chat is received+replyable, relay
    // the message to the target's node (a visible envelope) and stop — the reply streams
    // back into this chat as a living mirror. A local-being target has meshTarget=null
    // and falls through to the brain below.
    if (meshTarget && mesh && d.mayReply) { await transcript.log(ev); await mesh.forward(ev, meshTarget); return; }

    // AUTO DWELL (auto chats only): a person messaging an auto chat doesn't get an instant
    // reply — a human reads the burst and wanders back. Log the message NOW (received =
    // logged, in arrival order), accumulate it into this conversation's cycle, and ARM/EXTEND
    // a randomized pre-turn dwell; the turn fires ONCE when the dwell expires (fireDwell),
    // draining the whole accumulated burst. Pre-turn, so it's outside the turn-timeout budget.
    // Only auto+mayReply reaches here (isSender auto handled above; a paused auto chat has
    // mayReply=false and falls to the logged-only/context branches — no reply to delay).
    if (d.mayReply && d.mode === 'auto') {
      await transcript.log(ev);
      pushCycle(turnKey, ev.line ?? ev.body);
      armDwell(turnKey, { to, ev, mention });
      return;
    }

    if (d.mayReply) {
      // Reply branch (the reply train). Open THIS mention's OWN placeholder NOW, on
      // arrival — the per-message ack + streaming target, quoting the triggering message
      // (operator: "mentions should always be replied to the message"). If a train is
      // already in flight for this conversation, the placeholder opens in the QUEUED state
      // and the turn WAITS its turn on turnBy; when it reaches the front it activates and
      // streams. Uses the ROUTED mention so a sibling's @name reply quotes correctly too.
      const turn = openAndRunReply({ to, ev, d, mention, turnKey });
      return { turn };
    }

    // Context turn (send_to_egpt:'always', reply won't surface): E runs to stay
    // current, no UI; the reply is recorded but never sent. Serialized on the SAME
    // per-conversation queue as reply turns (it holds the same warm key), so a later
    // mention correctly queues behind it.
    bumpTrain(turnKey);
    const turn = turnBy(turnKey, () => runContextTurn({ to, ev, turnKey }));
    return { turn };
  }

  // A brain turn under the per-turn TIMEOUT (DEFECT 2). Races the turn against the
  // bound; on expiry it evicts the wedged warm entry (so the queue drains onto a fresh
  // session) and rejects with a timeout Error the callers resolve VISIBLY. 0 disables.
  async function runTurnWithTimeout(to, ev, promptEv, onPartial) {
    const p = brain.turn(to, promptEv, onPartial);
    if (!(turnTimeoutMs > 0)) return p;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeoutFn(() => reject(new Error(`turn timeout after ${turnTimeoutMs}ms`)), turnTimeoutMs);
      timer?.unref?.();
    });
    try {
      return await Promise.race([p, timeout]);
    } catch (e) {
      if (String(e?.message ?? '').startsWith('turn timeout')) {
        try { await brain.evict?.(to, ev); } catch { /* best effort */ }
        note(`turn ${to}/${ev.chatId}: TIMEOUT after ${turnTimeoutMs}ms — evicted warm entry`);
      }
      throw e;
    } finally { clearTimeoutFn(timer); }
  }

  // Open THIS mention's placeholder + enqueue its reply turn on the per-conversation FIFO.
  // Returns the turn's completion promise.
  function openAndRunReply({ to, ev, d, mention, turnKey }) {
    const m = mention ?? {};
    const replyTo = (m.atEAnywhere || m.atEStart || m.replyToBot) ? ev.msgId : null;
    const ahead = bumpTrain(turnKey);
    const out = sender.open(ev.chatId, { being: to, replyTo, queued: ahead > 0, queuedAhead: ahead, auto: d.mode === 'auto' });
    return turnBy(turnKey, () => runReplyTurn({ to, ev, d, out, turnKey, queued: ahead > 0 }));
  }

  // The reply train's turn body (DEFECT 1 + accumulation FEATURE). Fully guarded: from
  // the moment the placeholder opened, EVERY exit resolves it VISIBLY — the reply, the
  // no-reply marker (surfaced-but-empty or a failure-shaped result), or a failure marker
  // (brain throw / timeout / a fault in delivery). It can never resolve empty-and-silent
  // or stay stuck on "⏳ Thinking…". The reply is RECORDED before delivery (the transcript
  // is the durable record — it swallows its own errors and never throws — so the message
  // and reply survive even a bridge delivery fault), and E's own delivered reply becomes a
  // cycle line so the next queued turn accumulates it.
  async function runReplyTurn({ to, ev, d, out, turnKey, queued, preLogged = false }) {
    let recorded = false;
    try {
      out.activate?.();                                 // queued → live the moment its turn starts
      // Drain the accumulated cycle. A QUEUED turn prompts with it (ending with its own
      // mention line); an IMMEDIATE turn discards it and keeps the single dispatch line —
      // draining either way advances the baseline the next turn's cycle starts from.
      const pending = drainCycle(turnKey);
      // A QUEUED turn prompts with the accumulated cycle (ending with its own line); an
      // IMMEDIATE turn discards it — EXCEPT mode:auto, where the operator's OWN messages
      // accumulated WITHOUT ever running a turn, so an auto turn (immediate OR queued)
      // ALWAYS prepends them: E replies with the full context the operator would have had.
      // preLogged (the auto DWELL fire): the whole burst — INCLUDING ev's own line — is
      // already in `pending` (each burst message logged + accumulated at arrival), so prompt
      // with it verbatim and don't re-append ev.line.
      const prepend = preLogged || ((queued || d.mode === 'auto') && pending.length);
      const promptEv = prepend
        ? { ...ev, line: (preLogged && pending.length ? pending : [...pending, ev.line ?? ev.body]).join('\n\n') }
        : ev;
      const reply = await runTurnWithTimeout(to, ev, promptEv, (partial) => out.update(partial));
      const rawText = reply?.text ?? '';
      const surfaced = gating.surfaces(d, rawText);
      // A failure-SHAPED result string (isBrainFailureResult — the CLI returned an error
      // AS its result text; the brainpool self-heals only overflow/dead-session, not this):
      // do NOT deliver it as a reply. Blank it so the placeholder resolves to the no-reply
      // marker, and record the raw failure UNsurfaced (the record is never lost).
      const failShaped = surfaced && isBrainFailureResult(rawText);
      // Emitted actions (E's LIMBS, ROADMAP §3). Parse own-line action commands out of the
      // reply — but only a reply that WOULD surface acts (a withheld/context reply doesn't
      // emit limbs), and never a failure-shaped result. The STRIPPED prose is delivered; the
      // RAW reply (action lines included) is recorded, so nothing E emitted is ever lost.
      const parsed = (actions?.parse && surfaced && !failShaped) ? actions.parse(rawText, ev) : null;
      const proseText = parsed ? parsed.prose : rawText;
      const hadActions = !!parsed && (parsed.run.length + parsed.stripped.length) > 0;
      // Action-only: the reply is nothing but action lines. The placeholder DELETES (the
      // action IS the response — today's legit-silence path), not a no-reply marker.
      const actionOnly = surfaced && !failShaped && hadActions && !proseText.trim();
      const deliverable = surfaced && !!proseText.trim() && !failShaped;
      const responded = deliverable || actionOnly;   // E answered — with prose and/or a limb
      // Observability (operator: "diagnose WHY it was empty"): a turn that was meant to
      // surface but has nothing to deliver (and did nothing) is noted — the silent swallow is loud.
      if (surfaced && !responded) note(`brain ${to}/${ev.chatId}: no deliverable text (${failShaped ? `failure-shaped: ${rawText.slice(0, 80)}` : 'empty'}) — placeholder resolved with no-reply marker`);
      // RECORD FIRST (durable) — reply.text is RAW (action lines kept). preLogged (auto
      // dwell): the burst inbound lines were already recorded at arrival, so log ONLY the reply.
      await transcript.log(ev, { ...reply, surfaced: responded }, { replyOnly: preLogged });
      recorded = true;
      if (responded) pushCycle(turnKey, replyLine({ being: to, body: rawText, surfaced: true, now: new Date() }));
      await store?.recordThread?.({ ev, reply, being: to });
      // TYPING TIME (auto only): a human takes time to type. Delay the plain post-once send
      // by a typing-speed function of the reply length (capped 90s, outside the turn-timeout
      // budget). ONLY a deliverable prose reply is delayed — an action-only reply (e.g. /ask
      // consulting the operator) has no prose, so it stays undelayed (consulting fast is fine).
      if (d.mode === 'auto' && deliverable) await sleepTyping(proseText);
      // DELIVER the STRIPPED prose. Action-only → surface:false (delete placeholder);
      // failShaped → blanked → no-reply marker; else the prose (or no-reply marker if empty).
      await out.finish(failShaped ? { text: '' } : { ...reply, text: proseText }, { surface: actionOnly ? false : surfaced });
      // EXECUTE the limbs AFTER the reply is recorded + delivered: confined to ev.chatId,
      // errors logged, never crash the turn (the record above already captured everything).
      if (parsed && hadActions) { try { await actions.execute(parsed.run, parsed.stripped, ev, { being: to }); } catch (e) { note(`actions ${to}/${ev.chatId}: ${e?.message ?? e}`); } }
    } catch (e) {
      // Any failure once the placeholder is open (brain throw, per-turn timeout, or a
      // delivery fault) → resolve the placeholder VISIBLY + record the inbound if the
      // reply-log didn't already run (C1.2: the message is never lost).
      try { await out.fail?.(e); } catch { /* best effort */ }
      if (!recorded) { try { await transcript.log(ev); } catch { /* transcript swallows */ } }
      note(`turn ${to}/${ev.chatId}: ${e?.message ?? e}`);
    } finally { dropTrain(turnKey); }
  }

  async function runContextTurn({ to, ev, turnKey }) {
    try {
      const reply = await runTurnWithTimeout(to, ev, ev, undefined);
      await transcript.log(ev, { ...reply, surfaced: false });
      await store?.recordThread?.({ ev, reply, being: to });
    } catch (e) {
      await transcript.log(ev);
      note(`brain ${to}/${ev.chatId}: ${e?.message ?? e}`);
    } finally { dropTrain(turnKey); }
  }

  // --- the time-driven half: due heartbeats + accum flush. ---
  function tick() { heartbeats.runDue(clock.now()); }

  let timer = null;
  function start() {
    bridge.onMessage(enqueue);
    if (tickMs > 0) timer = setIntervalFn(tick, tickMs);
    note(`spine: started (tick ${tickMs}ms)`);
  }
  function stop() {
    if (timer) { clearIntervalFn(timer); timer = null; }
    bridge.stop?.();
    note('spine: stopped');
  }

  return { start, stop, tick, handleInbound, stats };
}
