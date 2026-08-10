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
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { makeSerialByKey } from '../serial-by-key.mjs';
import { isBrainFailureResult } from '../brain-errors.mjs';
import { replyLine, contextSinceLastTurn, promptWithRecentContext, bodyForMessageId, promptWithQuotedMessage, lastSurfacedBeing, RECENT_CONTEXT_MAX_CHARS } from '../transcript-log.mjs';
import { isHumanTurn, parseStopWord } from '../stop-guard.mjs';
import { mentionHits } from '../auto-mode.mjs';
import { lifecycleExit } from './ingest.mjs';
import { cleanForSpeech } from '../speech-clean.mjs';

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
 * @property {'whatsapp'|'telegram'|'shell'|'signal'} surface  the conversation SURFACE (the slugDir bucket), mapped from the bridge's origin network
 * @property {string} node      entry point the message arrived through — a TRANSPORT tag, never a node name ('wa'|'tg'|'sig'|'sh')
 * @property {string} chatId    stable chat/room id (gating + delivery key — never a display name)
 * @property {string} chatName  the chat's display title (rendering only)
 * @property {string} senderId  stable sender id
 * @property {string|null} senderName  the sender's display name; null when the bridge has none
 * @property {string|null} msgId    stable, addressable message id (#id); null when the surface has none
 * @property {string|null} replyToId  the QUOTED message's id (rendered `re #<id>`); null when this is not a reply
 * @property {number} ts        epoch ms
 * @property {string} body      the message text, node signature already RENDERED to a legible `<node>` (no raw tag bytes reach any downstream reader)
 * @property {'text'|'reaction'|'edit'} kind   an utterance, or a stage-direction (reaction/edit: bracket-wrapped, references its own target in the body)
 * @property {{atEStart: boolean, atEAnywhere: boolean, replyToBot: boolean}} mention  mention status the bridge already computed — the gating service's input
 * @property {boolean} backlog  older than bridge start (a woken node's replay): transcript-logged as backfill, NEVER dispatched
 * @property {boolean} authorized  sender is an allowed_user on this surface — on a shared account every own-account send reads true, so this is NOT a provenance test
 * @property {boolean} isSender    arrived on OUR OWN account (the operator, a peer node, or our own echo)
 * @property {boolean} isVoice     the body is a voice-note transcription
 * @property {string|null} fromBrain  the web-brain member id whose reply this is, re-entered by the room relay; null on every genuine inbound
 * @property {string|null} fromNode   WHICH NODE's spine committed this text. null = UNSIGNED (a human, the ordinary case); '' = SIGNED BY A NODE WE CANNOT NAME; otherwise the node name. Callers test `!= null`, NEVER truthiness
 * @property {string} [line]    the formatted dispatch line every brain sees, built once here (C7.6e)
 * @property {any}    raw       the bridge's original `from` payload
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

// The agent a routed target is GATED as. A LOCAL target is its own being; a MESH (relay) target
// routes with `being: null` — the being it dispatches to is nobody local — but the router carries
// the relay AGENT's name on the mesh descriptor, so THAT is whose mode governs it (operator
// 2026-07-25: `@don` gets its own mode instead of borrowing the persona's). `fallback` stays the
// caller's local being (the turn key / cycle owner), untouched.
const gateAs = (t, fallback) => t?.being ?? t?.mesh?.being ?? fallback;

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
  guard = null,                        // optional §2c stop-guard: the per-channel loop-breaker + RESUME (createStopGuard, boot-wired). Null = pipe runs unguarded (tests).
  stopSwitch = null,                   // optional §2c KILL SWITCH (boot-wired): { present(): does EGPT_HOME/STOP exist, async pull(why): warn in why.chatId (capped, best-effort) + write the file + take the SERVICE down }. Two call sites, both on paths that already exist — tick() (the operator touched the file; no chatId, so nothing to warn) and classify() (the chat safe word, which carries its chat). Null = no kill switch (tests).
  isSelfChat = () => false,            // (ev) => is this message in THE SELF CHAT — the operator's own command channel (boot: networks.whatsapp.chat_ids[0]). The ONLY chat the safe word is honoured in (operator 2026-07-26). Default false = FAIL-CLOSED: an un-wired spine has no chat kill switch at all, which is the safe direction for a switch that takes the service down.
  guardOverride = null,                // optional (surface, chatId) => { turns?, window? } | null — the conversation's per-channel guard override (conversations.yaml). Null = node defaults only.
  // RECENT CONTEXT read seam (operator 2026-07-26) — `(chatId, {chatName, network}) =>
  // Promise<string|null>`, the conversation's transcript.md. THE SAME function boot
  // already wires into the beeper bridge for the voice-note reuse path, handed here
  // rather than re-derived: one resolver, so this can never read a different chat's file.
  // Null (every existing pipe path) = the option cannot engage — byte-identical to before.
  readTranscript = null,
  roomRelay = null,                    // optional §Phase-4 room brain-member fan-out (createRoomRelay, boot-wired): delivers a received room message to each brain member per mode, streams the reply back, and RE-ENTERS it as a non-human turn. Null = no web-brain members (byte-identical to before).
  radioRelay = null,                   // optional (ev) => Promise<void> — air a WhatsApp voice note on the internet radio station its room is joined to (createRadioNoteRelay, boot-wired). Called ONLY for ev.isVoice + humanTurn(ev) (below), fire-and-forget with its own catch — a side effect that must never touch the message path. Null = no radio relay (byte-identical to before).
  synthesize = null,                   // optional (text, voice, log) => Promise<Buffer|null> — voice-reply TTS (createVoiceSynthesis, boot-wired). Null = no voice pipeline wired (byte-identical to today: every reply is text).
  voice = null,                        // optional string — the persona's own voice name (voice_service's active profile.voice). Null = voice-out can never render even if synthesize is set (falls back to text).
  defaultBeing = 'e',                  // the persona: the being an un-addressed message dispatches to, and the turn/cycle owner for a mesh-target message (which is GATED as its own relay agent — see gateAs)
  node_name = null,                    // THIS node's name (config node_name, boot-asserted non-empty) — the ONE thing the quick-reply lookup needs to tell its own rendered signature on the record from a co-account PEER's. Null (tests) = every signed line reads as a peer's, the safe direction.
  timeZone = null,                     // the node's config default_time_zone (boot-resolved) — the zone the CYCLE's reply lines render in, the same clock identity/transcript use so the accumulated prompt never disagrees with the file. null → UTC, unchanged.
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

  // --- GUARD (C7.7): the SINGLE per-channel loop-breaker + human STOP/RESUME, wired at
  //     THIS chokepoint (handleFast) through which every inbound turn flows. Injected, so
  //     a pipe built without it is byte-identical to before. The channel key is the
  //     conversation (surface + chatId). "human" is decided by PROVENANCE (isHumanTurn) —
  //     a mesh envelope posted AS the operator is NON-human, so it counts toward the cap
  //     instead of resetting it (the 2026-06-19 hole a name-based counter missed). ---
  const guardChannel = (ev) => `${ev.surface}:${ev.chatId}`;
  const humanTurn = (ev) => isHumanTurn(ev, {
    isEnvelope: (e) => !!mesh?.isEnvelope?.(e),
    wasSentByUs: (e) => !!bridge.wasSentByUs?.(e.chatId, e.msgId),
  });
  // Is this message a LIFECYCLE command (/restart, /upgrade, /rewind)? The operator's
  // recovery path, exempt from the guard (see classify). Reuses the ONE mapping the command
  // path itself dispatches on — no second list of "which commands are lifecycle" — and is
  // side-effect-free here (no writeRewindTarget passed, so /rewind writes nothing).
  const isLifecycle = (ev) => lifecycleExit(String(ev?.body ?? '').trim()) != null;
  // Count a NON-HUMAN turn toward the loop cap (resolving any per-conversation override)
  // and auto-STOP the channel when the cap trips. The tripping turn still runs; the STOP
  // pauses the NEXT one (blocked() is checked at the top of every dispatch path).
  async function guardCountNonHuman(ev, channel) {
    const override = guardOverride ? await Promise.resolve(guardOverride(ev.surface, ev.chatId)).catch(() => null) : null;
    const action = guard.noteBeing(channel, override);
    if (action === 'stop') { guard.stopChannel(channel); note(`guard: ${channel} auto-STOP — ${guard.countOf(channel)} consecutive non-human turns`); }
    else if (action === 'warn') note(`guard: ${channel} nearing the loop cap (${guard.countOf(channel)})`);
  }

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
  // the whole accumulated burst (`burst`: prompt with the drained lines verbatim — each of
  // them is its own message and was recorded as one at arrival).
  async function fireDwell(turnKey) {
    const entry = dwellBy.get(turnKey);
    if (!entry) return;
    dwellBy.delete(turnKey);
    const { to, ev, mention } = entry;
    let d;
    try { d = await gating.decide(to, ev, mention); }
    catch (e) { note(`dwell ${turnKey}: re-decide failed — ${e?.message ?? e}`); return; }
    if (d.mode !== 'auto' || !d.mayReply) { note(`dwell ${turnKey}: mode ${d.mode} — dwell dropped (no auto reply)`); return; }
    const replyTo = ev.msgId ?? null;                 // quote UNIFORMLY — including auto (see openAndRunReply)
    const ahead = bumpTrain(turnKey);
    const out = sender.open(ev.chatId, { being: to, replyTo, auto: true });
    turnBy(turnKey, () => runReplyTurn({ to, ev, d, out, replyTo, turnKey, queued: ahead > 0, burst: true }));
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

  // --- THE SINGLE INGESTION PATH (operator 2026-07-25: "an agent only replies when
  //     prompted. it is the bridge that adds each message to the transcript when the spine
  //     receives it, not when it prompts the model" / "there must only be one path for
  //     message ingestion, digestion and dispatching").
  //
  //     One message, one record, ONE call site. handleFast CLASSIFIES the message first
  //     (what IS it, and — for ordinary chat — what its gate says), records the inbound line
  //     EXACTLY ONCE right here, and only then runs whatever that classification decided.
  //     Nothing downstream ever appends an inbound line again — a turn appends its REPLY.
  //     That makes the record STRUCTURAL instead of remembered: a new early-return branch
  //     cannot silently lose a message, because no branch does the logging.
  //
  //     It also puts the record in ARRIVAL order. The inbound used to be written at REPLY
  //     time, so anything that answered fast — a second addressed agent, a room fan-out
  //     re-entering — could land its reply line ABOVE the message it was answering (and,
  //     writing the file first, rob transcript.md of its front matter).
  //
  //     The ONE message that is NOT recorded is 'off' — C4: 'off' is not RECEIVED at all,
  //     so there is nothing to record. classify() returns null for exactly that case.
  //
  //     Returns `{ turn }` — the dispatched turn's completion promise wrapped so the pump
  //     does NOT await it (a bare `return turnBy(...)` from this async fn would ADOPT the
  //     promise and re-serialize every turn globally) — or undefined when no turn runs. ---
  async function handleFast(msg) {
    const ev = identity.build(msg);
    // GUARD (C7.7): the channel is the conversation (surface + chatId). Resolved once here
    // for the safe-word + the loop counter inside classify; null when no guard is wired.
    const channel = guard ? guardChannel(ev) : null;
    const act = await classify(ev, channel);
    if (!act) return;                  // 'off' — not received (C4): not recorded, not processed
    await transcript.log(ev);          // ←── THE INGESTION POINT (C1.2). The only one.
    // Radio relay: a genuine inbound voice note, in a room joined to a radio, airs on the
    // station (createRadioNoteRelay owns the rest of the gate — joined+enabled, sender→speaker,
    // dedupe). Fire-and-forget with its own catch, the SAME shape transcript.log uses for its
    // stats side-effect — never awaited, never allowed to affect this message's dispatch.
    // humanTurn(ev) is the identical provenance test the loop-counter/kill-switch use (never
    // re-derived here): NOT this node's own send, NOT a peer node's signed line.
    if (radioRelay && ev.isVoice && humanTurn(ev)) {
      radioRelay(ev).catch((e) => note(`radio relay ${ev.surface}/${ev.chatId}: ${e?.message ?? e}`));
    }
    return act();
  }

  // What IS this message, and what should happen to it? Classification only — plus the
  // readings classification itself needs (the gate, the guard's verdict). It writes NOTHING
  // to the transcript. Returns the action to run once the message is on the record, or null
  // when the message is not received at all ('off').
  async function classify(ev, channel) {
    // BACKLOG BACKFILL (operator 2026-07-08, S3 wake): a message older than bridge start —
    // the node slept and woke to a replay — is transcript-logged (the record stays complete)
    // but NEVER dispatched: no command, no mesh, no gate, no mode:on (the woken node backfills,
    // it does not re-answer stale traffic).
    if (ev.backlog) return () => {};

    // Operator safe-word from an AUTHORIZED sender. Before gating so it lands in any mode;
    // recorded like any inbound (the caller appends it the moment this returns), then NEVER
    // routed to a brain.
    //
    // FIRST of all the dispatch branches (moved above the command intercept 2026-07-25): the
    // safe-word is the operator's RECOVERY path and must always land. An armed `/e` wizard
    // makes isCommand true for ANY operator line (a plain numbered answer), so a bare STOP
    // typed while a wizard happened to be armed was swallowed by the wizard — leaving kill-
    // the-service as the only way out of a flood. STOP/RESUME are reserved words, never
    // wizard answers.
    if (ev.authorized) {
      const word = parseStopWord(ev.body);
      // STOP — THE KILL SWITCH (operator 2026-07-25: "if i write 'stop' all activity,
      // whatever it is, must stop" / "stop, stops egpt service point blank"). Writes
      // EGPT_HOME/STOP with this message's provenance and takes the SERVICE down — it is
      // no longer a per-channel pause. Recoverable by `rm EGPT_HOME/STOP`, nothing else.
      // ("STOP ALL" is unwired since 2026-07-26 — parseStopWord no longer produces it.)
      //
      // AND IT MUST BE A HUMAN WHO SAID IT (operator 2026-07-26: "it is not anyone, only
      // allowed_users"). `authorized` alone is NOT that test on a shared Beeper account:
      // every send from the account arrives isSender:true, which beeper.mjs reads as
      // authorized — so our OWN output, a brain member's re-entered reply and relay traffic
      // all look "authorized" here. Route them out through the SAME provenance predicate
      // the loop counter uses (isHumanTurn): an agent must not be able to pull the kill
      // switch by saying the word. A non-human "stop" is not a control word at all — it
      // falls through and is handled like any other text.
      //
      // AND IT MUST BE SAID IN SELF (operator 2026-07-26: "the 'stop' safeword is super
      // fragile. i don't really like it. is must be a single word message in Self, 'stop',
      // case insensitive"). It used to fire from ANY chat on ANY surface — one stray "stop"
      // in a group, or anyone with the operator console, took the whole service down. Now
      // the word is scoped to the ONE chat that is the operator addressing his own node:
      // isSelfChat (boot: networks.whatsapp.chat_ids[0], the same Self-DM the restart
      // announce posts to). ANYWHERE ELSE — another Beeper chat, a group, the shell console
      // (which hardcodes authorized:true, so scoping is what actually closes it) — "stop" is
      // ORDINARY TEXT and flows on to the normal dispatch.
      if (stopSwitch && word === 'stop' && humanTurn(ev) && isSelfChat(ev)) {
        return async () => {
          note(`STOP from ${ev.senderName ?? ev.senderId ?? '?'} @ ${guardChannel(ev)} — writing the STOP file and stopping the service`);
          // AWAITED: pull warns in this chat before it exits (boot caps that post so it can
          // never wedge the stop). Awaiting keeps the message's turn open until the node
          // has actually left, so a test — and the pump — see the whole sequence.
          await stopSwitch.pull({
            reason: `chat safe word "${String(ev.body ?? '').trim()}"`,
            who: `${ev.senderName ?? 'unknown'} <${ev.senderId ?? '?'}>`,
            where: `${ev.surface} / ${ev.chatName ?? '?'} (${ev.chatId})`,
            // WHERE TO WARN — the chat the STOP came from, carried so boot can post there
            // (writeStopFile ignores these two; it only reads reason/who/where/at).
            surface: ev.surface, chatId: ev.chatId,
          });
        };
      }
      // RESUME / RESUME ALL — unchanged: clear a channel the LOOP COUNTER auto-stopped
      // (the only per-channel pause left). Without these an auto-stopped channel could
      // only be cleared by a restart.
      if (guard && (word === 'resume' || word === 'resume_all')) return () => { guard.applyControl(word, channel); note(`guard: '${word}' @ ${channel}`); };
    }

    // operator slash command (Self DM / authorized) → handled here, NEVER routed
    // to the brain. Recorded like any inbound, then executed (lifecycle exits the
    // process; the daemon respawns). Runs before gating: a /restart works even in
    // a muted/mention chat.
    if (commands?.isCommand?.(ev)) {
      // ALWAYS-AVAILABLE (never blocked, never counted): the lifecycle commands. They are
      // the operator's way back out of a broken node, and a guard that can lock them out
      // turns a flood into an unrecoverable node. Same predicate the command path itself
      // dispatches on (ingest.mjs lifecycleExit), called side-effect-free here.
      if (isLifecycle(ev)) return async () => { await commands.run(ev); };
      // GUARDED (2026-07-25 incident): every OTHER command is a turn like any other. Command
      // turns used to return from classify BEFORE the guard block below, so a command loop was
      // entirely unbounded — a STOPped channel kept answering commands, which is how a flood of
      // command replies could only be ended by killing the service. Same three lines as the
      // chat path: a stopped channel suppresses it, and PROVENANCE decides reset-vs-count (an
      // operator who genuinely typed the command resets, our own output re-entering counts).
      if (guard) {
        if (guard.blocked(channel)) return () => { note(`guard: ${channel} stopped — command suppressed`); };
        if (humanTurn(ev)) guard.noteHuman(channel);
        else await guardCountNonHuman(ev, channel);
      }
      // NODE-ADDRESSED AT ANOTHER NODE (operator 2026-07-26 — egpt as a remote control for the
      // network): `/chrome do` typed on the SHELL can never be heard by do (the shell is
      // node-local — the spine dials the editor on 127.0.0.1), so the command has to TRAVEL. It
      // rides the SAME mesh envelope a `@don` being-prompt rides, the target executes it locally,
      // and the reply mirrors home through the same living mirror. `commands.remoteNode` is the
      // ONE decision — an allowlisted command naming a node that is neither ours nor a
      // co-account peer that already heard this — so a null (every case today) leaves the local
      // command path byte-identical.
      const remote = commands.remoteNode?.(ev);
      if (remote && mesh?.forwardCommand) return async () => { await mesh.forwardCommand(ev, remote); };
      return async () => { await commands.run(ev); };
    }

    // Inbound mesh envelope: a message carrying a provenance tail is relay traffic,
    // not chat — decode + act on it (a request at the responder, a reply/mirror-update
    // at the origin) and stop. Detected EARLY, before gating: an envelope is ADDRESSED
    // traffic, so it bypasses this chat's ambient reply modes (the responder's own
    // being-turn still respects that being's availability, inside mesh.handle). Recorded
    // like any received message (C1.2). A relay envelope is NON-human traffic (it may
    // DISPLAY as the operator — the 2026-06-19 loop), so it counts toward the loop cap;
    // a STOPPED channel suppresses the responder turn entirely.
    if (mesh?.isEnvelope?.(ev)) {
      if (guard) {
        if (guard.blocked(channel)) return () => { note(`guard: ${channel} stopped — mesh turn suppressed`); };
        await guardCountNonHuman(ev, channel);
      }
      return async () => { await mesh.handle(ev); };
    }

    // Advice answer (mode: auto): the operator quote-replied in the advice channel to one
    // of E's /ask questions — route that answer into the ORIGIN conversation instead of
    // treating it as a message in the advice channel. Detected EARLY, before gating, so
    // the operator's reply never triggers a normal E reply where the ask was posted.
    // Recorded like any received message (C1.2). routeAnswer is fire-and-forget.
    if (advice?.isAnswer?.(ev)) return async () => { await advice.routeAnswer(ev); };

    // Router picks EVERY addressed agent + the mention each one's gate should see (operator
    // 2026-07-25: one matcher over the node's whole addressable set — `@e and @don you here?`
    // addresses BOTH). `targets` is that list in text order: the FIRST drives this message's own
    // pipe below (gate, guard, cycle, turn) exactly as the single result always did, and the REST
    // fan out beside it (fanOutExtras). A bare-string or single `{ being, mention }` return
    // (older/other fakes) normalizes to a one-target list, so those callers are unchanged.
    // WHO DOES `r …` ADDRESS? A STATIC LOOKUP ON THE RECORD (operator 2026-07-27: "r is static,
    // it searches the transcript") — the last SURFACED agent reply line in this conversation's
    // transcript.md, through transcript-log.lastSurfacedBeing, which owns the shape. It replaced
    // an in-memory Map whose only real property was that a restart emptied it: E spoke at 23:32,
    // a deploy bounced the node at 23:41, and `r cachifa?` at 00:02 addressed nobody. Nothing is
    // remembered between messages now, so there is no restart hole and no clearing rule — and a
    // human line in between is irrelevant for free.
    //
    // ON A SHARED ACCOUNT THE LAST BOT MESSAGE MAY NOT BE OURS (operator 2026-07-27, LIVE: both
    // nodes answered one `r`). A co-account peer's reply is an INBOUND line here carrying that
    // node's rendered signature, so lastSurfacedBeing weighs it against our own reply lines and
    // returns null when the peer spoke more recently — `node_name` is what lets it tell the peer's
    // signature from our own. Null then means exactly what it always meant: nobody is addressed,
    // `r …` is ordinary text, and the other node answers.
    //
    // THE SAME readTranscript seam the quoted-message/accum lookup in runReplyTurn uses — one
    // reader, so this can never read a different chat's file — and it runs BEFORE the ingestion
    // append (handleFast logs after classify), so the `r …` line itself is never on the record
    // this reads. Unwired seam, unreadable file, or nothing on the record → null → `r …` is
    // ordinary text, exactly as in a chat where no agent has ever spoken.
    //
    // COST: one transcript read per QUICK REPLY, gated on the message actually being one —
    // router.quickReplyOf is THE grammar plus this node's configured token, so ordinary traffic
    // reads nothing.
    let lastSpeaker = null;
    if (readTranscript && router.quickReplyOf?.(ev.body) != null) {
      try {
        const text = await readTranscript(ev.chatId, { chatName: ev.chatName, network: ev.surface });
        if (text) lastSpeaker = lastSurfacedBeing(text, { node: node_name });
      } catch (e) { note(`quick-reply lookup ${ev.chatId}: ${e?.message ?? e}`); }
    }
    const routed = router.resolve(ev, lastSpeaker);
    // QUICK REPLY: the router resolved `r <body>` to the agent that spoke last here, and hands
    // back the body its token was stripped from. That body is what the agent sees — here and in
    // the dispatch line (which ends with it). The RECORD keeps the message as typed: transcript.log
    // runs on the caller's ev, above, which this local rebind does not touch.
    if (routed?.body != null) {
      const line = String(ev.line ?? '');
      ev = { ...ev, body: routed.body, ...(line.endsWith(ev.body) ? { line: line.slice(0, -ev.body.length) + routed.body } : {}) };
    }
    const targets = (Array.isArray(routed?.targets) && routed.targets.length)
      ? routed.targets
      : [typeof routed === 'string' ? { being: routed } : { being: routed?.being, mesh: routed?.mesh ?? null, mention: routed?.mention }];
    const meshTarget = targets[0].mesh ?? null;
    const to = targets[0].being ?? defaultBeing;
    const mention = targets[0].mention ?? ev.mention;

    // ONE conversation-state read resolves this message's policy (mode +
    // send_to_egpt, both from conversations.yaml) and the derived gate flags. The
    // routed mention is passed explicitly (it's the sibling's, not @e's, when a
    // sibling was routed by its own @name), and a RELAY target is gated as its OWN
    // agent (gateAs) rather than borrowing the persona's mode.
    const d = await gating.decide(gateAs(targets[0], to), ev, mention);

    // 'off' → not received: not recorded, not processed (C4). Every OTHER mode IS recorded
    // at the ingestion point — a received message is never silently dropped (C1.2).
    if (!d.receives) return null;

    // GUARD (C7.7): classify this received turn by PROVENANCE + gate a stopped channel. A
    // genuine human message RESETS the loop counter (so normal human↔bot talk never trips);
    // a non-human turn (a being's own room fan-out re-entering, later phases) counts toward
    // the cap. A STOPPED channel is recorded (C1.2) but never prompts — cleared only by RESUME,
    // never by a mere human turn. Runs before the reply/dwell/context branches so every
    // received message resets or counts exactly once.
    if (guard) {
      if (guard.blocked(channel)) return () => { note(`guard: ${channel} stopped — prompt suppressed`); };
      if (humanTurn(ev)) guard.noteHuman(channel);
      else await guardCountNonHuman(ev, channel);
    }

    return () => dispatchChat({ ev, d, to, mention, meshTarget, targets, channel });
  }

  // Ordinary chat, ALREADY on the record: fan out to the other agents this message addressed
  // and take its own branch. Runs strictly AFTER the ingestion append, so every reply line it
  // can produce lands below the inbound line it answers.
  async function dispatchChat({ ev, d, to, mention, meshTarget, targets, channel }) {
    // PHASE 4 — brain-member fan-out (design B: re-entry). Kicked off HERE, concurrently with
    // E's own dispatch below (never blocking E's turn). It delivers this received room message
    // to each brain member whose mode admits it; each member's finalized reply is streamed into
    // the room AND re-enters handleFast as a synthetic NON-human turn (from.fromBrain) — reaching
    // the OTHER brains + E (per E's own mode) and counted EXACTLY ONCE by the guardCountNonHuman
    // above (on re-entry), never here. `blocked` short-circuits a channel the counter just tripped,
    // so a runaway multi-brain room halts at guard.turns. Its completion promise folds into the
    // turn this message resolves on (withRelay), so a caller awaits the fan-out too. Absent roomRelay
    // (every existing pipe path) → null → handleFast is byte-identical to before.
    const relayTurn = (roomRelay && !(guard && guard.blocked(channel)))
      ? roomRelay.fanOut(ev, { blocked: () => !!(guard && guard.blocked(channel)), reenter: handleInbound })
      : null;
    // FAN-OUT (operator 2026-07-25): every OTHER agent this message addressed takes its own path
    // from this ONE message — a local being takes a turn, a relay agent posts an envelope and
    // waits. The two are independent and free: neither sequences the other, and neither touches
    // the inbound line (ingestion already wrote it, above). One target (every existing path)
    // → null → byte-identical to before.
    const extrasTurn = targets.length > 1 ? fanOutExtras(targets.slice(1), ev) : null;
    // Fold the fan-out(s) into whatever this message resolves on: a reply/context turn (Promise.all),
    // a no-turn branch (the fan-out alone), or — no roomRelay, one target — the original value unchanged.
    const sideTurn = (relayTurn && extrasTurn) ? Promise.all([relayTurn, extrasTurn]).then(() => {}) : (relayTurn ?? extrasTurn);
    const withRelay = (turn) => {
      if (!sideTurn) return turn === undefined ? undefined : { turn };
      return { turn: turn ? Promise.all([turn, sideTurn]).then(() => {}) : sideTurn };
    };

    // Per-conversation turn key = the routed being + this conversation. It maps 1:1
    // to the warm-pool key (`<being>:<engine>:<surface>:<slug>`) at the granularity
    // that matters — same being, same chat — so serializing on it is exactly "one
    // turn at a time per warm key". Different chats (or different beings) key apart
    // and run concurrently. Also the CYCLE key: ambient lines accumulate under it so a
    // later queued mention on the same conversation drains exactly this chat's cycle.
    const turnKey = `${to}:${ev.surface}:${ev.chatId}`;

    // mode:auto is an IMPERSONATION of the operator: E replies to OTHER people AS the
    // operator, and the operator's OWN messages (isSender) here NEVER prompt E. Accumulate
    // the line into this conversation's cycle so the NEXT other-person turn is prompted WITH
    // it (full context), and run no turn. Only the operator's genuinely-typed lines reach
    // here — E's own auto replies come back isSender too but are dropped upstream by the
    // bridge's sent-id guard (wasSentByUs), never re-entering the spine.
    if (d.mode === 'auto' && ev.isSender) { pushCycle(turnKey, ev.line ?? ev.body); extendDwell(turnKey); return withRelay(); }

    // Does E actually RUN on this message? It runs when its reply could surface
    // (mayReply), OR when the chat is send_to_egpt:'always' (E stays in context
    // even when it won't reply). Otherwise the message is recorded only — E reads
    // transcript.md for back-context if it later engages ('not contacted yet') — AND
    // the line joins the conversation's cycle, so a queued mention arriving next sees
    // this ambient chatter in its accumulated prompt.
    const runE = d.mayReply || d.sendToEgpt === 'always';
    if (!runE) { pushCycle(turnKey, ev.line ?? ev.body); return withRelay(); }

    // mesh-target forwarding (Phase 4b): an @being.node that lives on ANOTHER node is
    // not a local brain. Once gating has decided this chat is received+replyable, relay
    // the message to the target's node (a visible envelope) and stop — the reply streams
    // back into this chat as a living mirror. A local-being target has meshTarget=null
    // and falls through to the brain below.
    if (meshTarget && mesh && d.mayReply) { await mesh.forward(ev, meshTarget); return withRelay(); }

    // AUTO DWELL (auto chats only): a person messaging an auto chat doesn't get an instant
    // reply — a human reads the burst and wanders back. The message is already on the record
    // (ingestion, in arrival order); accumulate it into this conversation's cycle and
    // ARM/EXTEND a randomized pre-turn dwell; the turn fires ONCE when the dwell expires
    // (fireDwell), draining the whole accumulated burst. Pre-turn, so it's outside the
    // turn-timeout budget. Only auto+mayReply reaches here (isSender auto handled above; a
    // paused auto chat has mayReply=false and falls to the record-only/context branches —
    // no reply to delay).
    if (d.mayReply && d.mode === 'auto') {
      pushCycle(turnKey, ev.line ?? ev.body);
      armDwell(turnKey, { to, ev, mention });
      return withRelay();
    }

    if (d.mayReply) {
      // Reply branch (the reply train). Open THIS message's OWN placeholder NOW, on
      // arrival — the per-message ack + streaming target, quoting the triggering message
      // (operator: "mentions should always be replied to the message" — now EVERY reply,
      // not just mentions; see openAndRunReply). If a train is already in flight for this
      // conversation, the placeholder opens in the QUEUED state and the turn WAITS its turn
      // on turnBy; when it reaches the front it activates and streams.
      const turn = openAndRunReply({ to, ev, d, turnKey });
      return withRelay(turn);
    }

    // Context turn (send_to_egpt:'always', reply won't surface): E runs to stay
    // current, no UI; the reply is recorded but never sent. Serialized on the SAME
    // per-conversation queue as reply turns (it holds the same warm key), so a later
    // mention correctly queues behind it.
    bumpTrain(turnKey);
    const turn = turnBy(turnKey, () => runContextTurn({ to, ev, turnKey }));
    return withRelay(turn);
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
  //
  // The placeholder ALWAYS quotes the message that triggered it (operator 2026-07-15) — every
  // mode, INCLUDING auto. It used to quote only when E was MENTIONED, so a mode:on/auto chat
  // got a PLAIN post and E could not quote what it was answering at all: its main reply was
  // unquoted AND its own /reply limb was discarded as "redundant" against a quote that did not
  // exist. Quoting from the START is also what removes the delete+repost churn for the common
  // case: E's /reply at the message it is answering is now GENUINELY redundant, so it strips
  // instead of tearing the placeholder down and posting a fresh quote in its place.
  function openAndRunReply({ to, ev, d, turnKey }) {
    const replyTo = ev.msgId ?? null;
    const ahead = bumpTrain(turnKey);
    const out = sender.open(ev.chatId, { being: to, replyTo, queued: ahead > 0, queuedAhead: ahead, auto: d.mode === 'auto' });
    return turnBy(turnKey, () => runReplyTurn({ to, ev, d, out, replyTo, turnKey, queued: ahead > 0 }));
  }

  // The spine's FAN-OUT (operator 2026-07-25): dispatch the agents addressed BESIDE the one
  // whose pipe this message is running. Each resolves ITSELF against its own gate — the mention
  // the router minted for it (its real atStart/anywhere) decides its mode, so an agent named
  // mid-sentence in a mention-direct chat stays silent — and then takes the path its kind
  // already has: a RELAY target is forwarded as a mesh envelope, a LOCAL being takes a reply
  // turn on its OWN per-conversation queue (so it runs concurrently with the primary, never
  // behind it). No target re-records the message: ingestion wrote the single inbound line
  // before any of this ran, and every turn appends only its REPLY — one message, one inbound
  // line, N replies. A target that may not reply is simply silent (no context turn, no dwell:
  // it was ADDRESSED, so it either answers or it doesn't). Failures are noted and never break
  // the other targets.
  function fanOutExtras(extras, ev) {
    return Promise.all(extras.map(async (t) => {
      const being = t.being ?? defaultBeing;
      try {
        const d = await gating.decide(gateAs(t, being), ev, t.mention ?? ev.mention);
        if (!d.receives || !d.mayReply) return;
        if (t.mesh) { if (mesh) await mesh.forward(ev, t.mesh); return; }
        await openAndRunReply({ to: being, ev, d, turnKey: `${being}:${ev.surface}:${ev.chatId}` });
      } catch (e) { note(`fan-out ${being}/${ev.chatId}: ${e?.message ?? e}`); }
    })).then(() => {});
  }

  // The reply train's turn body (DEFECT 1 + accumulation FEATURE). Fully guarded: from
  // the moment the placeholder opened, EVERY exit resolves it VISIBLY — the reply, the
  // no-reply marker (surfaced-but-empty or a failure-shaped result), or a failure marker
  // (brain throw / timeout / a fault in delivery). It can never resolve empty-and-silent
  // or stay stuck on "⏳ Thinking…". The reply is RECORDED before delivery (the transcript
  // is the durable record — it swallows its own errors and never throws — so the reply
  // survives even a bridge delivery fault), and E's own delivered reply becomes a cycle line
  // so the next queued turn accumulates it. The MESSAGE is not this function's business: it
  // was written at ingestion, before this turn was ever dispatched.
  //
  // `burst` (the auto-dwell fire): this turn answers a whole accumulated burst, so it prompts
  // with the drained cycle verbatim instead of appending its own trigger line. A PROMPT
  // concern only — it says nothing about the record.
  async function runReplyTurn({ to, ev, d, out, replyTo = null, turnKey, queued, burst = false }) {
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
      // burst (the auto DWELL fire): the whole burst — INCLUDING ev's own line — is already
      // in `pending` (each burst message accumulated at arrival), so prompt with it verbatim
      // and don't re-append ev.line.
      // MODE: ACCUM (operator 2026-07-26, the skin-cells incident): this being's mode in
      // this conversation is 'accum', so prompt with everything recorded SINCE ITS LAST
      // TURN — the messages a send_to_egpt:'mode' chat never handed it — clearly labelled
      // beside the triggering line. Read from transcript.md, which already IS that buffer;
      // there is no second store, and the boundary needs no state because the being's own
      // reply line is IN the file (transcript-log.contextSinceLastTurn). accum gates
      // replies exactly like 'mention' (auto-mode.mjs), so this changes only WHAT this
      // turn is prompted with — never WHEN a turn happens. The 8000-char cap is a
      // CONSTANT, not a knob: the mode is the only switch.
      //
      // It SUPERSEDES the in-memory cycle prepend below rather than adding to it: the
      // cycle is drained at every turn, so its lines are a SUBSET of the same gap, and
      // composing the two would simply duplicate them. The drain still runs (it advances
      // the baseline the next turn's cycle starts from). Anything that goes wrong —
      // no seam, unreadable file, nothing accumulated — falls through to exactly the
      // prompt this chat builds today.
      //
      // THE QUOTED MESSAGE (operator 2026-07-26): this inbound REPLIES to another message, and
      // the transport carries the quoted message's ID ONLY — never its text (src/bridges/
      // beeper.mjs ~L1335). So ` re #<id>` reached the model naked and E answered "No veo el
      // contenido de #177210". The content is on the SAME record this reads, one entry up
      // (transcript-log.bodyForMessageId), so it is resolved here and labelled below.
      // accum CANNOT cover this case: its window starts at the being's last turn, and
      // a reply to an OLD message is by definition outside it.
      let recent = null, quoted = null;
      if (readTranscript && (d.mode === 'accum' || ev.replyToId != null)) {
        try {
          const text = await readTranscript(ev.chatId, { chatName: ev.chatName, network: ev.surface });
          if (text && d.mode === 'accum') {
            const got = contextSinceLastTurn(text, { being: to, maxChars: RECENT_CONTEXT_MAX_CHARS, exclude: ev.line ?? ev.body });
            if (got.blocks.length) recent = got;
          }
          if (text && ev.replyToId != null) {
            const body = bodyForMessageId(text, ev.replyToId);
            if (body) quoted = { id: ev.replyToId, body };
          }
        } catch (e) { note(`prompt-context ${to}/${ev.chatId}: ${e?.message ?? e}`); }
      }
      const prepend = burst || ((queued || d.mode === 'auto') && pending.length);
      const base = ev.line ?? ev.body;
      let line = recent
        ? promptWithRecentContext(base, recent)
        : prepend
          ? (burst && pending.length ? pending : [...pending, base]).join('\n\n')
          : base;
      // NO DUPLICATE: the quoted message may ALREADY be in the prompt — inside the accum
      // gap, or in the drained cycle. Both are transcript lines, so the SAME walk answers it:
      // an entry carrying that id is already there → add nothing. Appending LAST is what makes
      // that one check enough (it sees everything the prompt already holds), and the block's
      // label names the id instead of a position for exactly that reason.
      if (quoted && bodyForMessageId(line, quoted.id) == null) line = promptWithQuotedMessage(line, quoted);
      const promptEv = line === base ? ev : { ...ev, line };
      // STREAM THE PROSE ONLY (operator 2026-07-15). The raw partial used to go straight to
      // the chat, so E's action tokens RENDERED live — the operator watched `/reply #<id> …`
      // appear and then vanish once the completed text was parsed below. partialProse applies
      // the SAME pure split as the parse below (and withholds a trailing INCOMPLETE line that
      // could still become an action, so not even a half-typed "/repl" reaches the chat), which
      // keeps the stream showing exactly what finish() will deliver. With no actions service
      // wired nothing is stripped below either, so the raw partial streams — still a mirror.
      // It takes the SAME quotedId as the parse below: without it the stream would strip a
      // redundant /reply that finish() DEMOTES to prose, and the mirror would break.
      const onPartial = (partial) => out.update(actions?.partialProse ? actions.partialProse(partial, ev, { quotedId: replyTo }) : partial);
      const reply = await runTurnWithTimeout(to, ev, promptEv, onPartial);
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
      // `quotedId`: the message THIS reply is itself posted as a quote of — the honest premise
      // for the /reply redundancy guard (a /reply at what we already quote is the rogue twin).
      const parsed = (actions?.parse && surfaced && !failShaped) ? actions.parse(rawText, ev, { quotedId: replyTo }) : null;
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
      // RECORD FIRST (durable) — reply.text is RAW (action lines kept). ALWAYS the reply
      // alone: the message itself went on the record at ingestion, so however many agents
      // answer it, each appends exactly one reply line under the one inbound line.
      await transcript.log(ev, { ...reply, surfaced: responded });
      if (responded) pushCycle(turnKey, replyLine({ being: to, body: rawText, surfaced: true, now: new Date(), timeZone }));
      await store?.recordThread?.({ ev, reply, being: to });
      // TYPING TIME (auto only): a human takes time to type. Delay the plain post-once send
      // by a typing-speed function of the reply length (capped 90s, outside the turn-timeout
      // budget). ONLY a deliverable prose reply is delayed — an action-only reply (e.g. /ask
      // consulting the operator) has no prose, so it stays undelayed (consulting fast is fine).
      if (d.mode === 'auto' && deliverable) await sleepTyping(proseText);
      // VOICE-OUT (chunk 2, operator 2026-08-09): a voice-triggered turn replies with
      // synthesized voice; an explicit `@ev` text handle FORCES voice-out (with a
      // quoted-text transcript underneath) — `@` required, the bare `ev` form is too
      // easy to false-positive on ordinary prose. Only meaningful when there is prose
      // to speak at all (deliverable); actionOnly/failShaped/non-surfaced turns never
      // reach here with anything to render as audio.
      const evOverride = deliverable && mentionHits(ev.body, ['ev'], { addressWithoutAt: false }).length > 0;
      const wantsVoice = deliverable && (evOverride || ev.isVoice);
      let voiceDelivered = false;
      if (wantsVoice && synthesize && voice) {
        let audio = null;
        // Spoken text is CLEANED (markdown stripped, trailing Sources section
        // dropped) — proseText itself stays raw for the on-screen quote below.
        const speechText = cleanForSpeech(proseText);
        try { audio = await synthesize(speechText, voice, note); } catch (e) { note(`synthesize ${to}/${ev.chatId}: ${e?.message ?? e}`); audio = null; }
        if (audio) {
          const tmpPath = join(tmpdir(), `egpt-voice-reply-${randomBytes(8).toString('hex')}.ogg`);
          try {
            await writeFile(tmpPath, audio);
            let sent = null;
            try {
              sent = await bridge.sendMedia(ev.chatId, tmpPath, {});
              // evOverride ONLY: a separate plain-text send, quoting the just-sent voice
              // message, carrying the SAME proseText (no re-generation). No bodyEmoji/label
              // stamping — this send doesn't go through `out` and that stamping isn't
              // available in this closure; an explicit simplicity-first scope decision.
              if (sent && sent.ok && evOverride) await bridge.send(ev.chatId, proseText, { replyTo: await sent.confirmedId });
            } catch (e) { note(`voice-send ${to}/${ev.chatId}: ${e?.message ?? e}`); sent = null; }
            if (sent && sent.ok) {
              // The "⏳ Thinking…" placeholder is resolved by DELETING it (surface:false) —
              // the actual content already went out as a fresh media message, not an edit
              // of the placeholder.
              await out.finish({ text: '' }, { surface: false });
              voiceDelivered = true;
            }
          } finally { try { await unlink(tmpPath); } catch {} }
        }
      }
      // DELIVER the STRIPPED prose. Action-only → surface:false (delete placeholder);
      // failShaped → blanked → no-reply marker; else the prose (or no-reply marker if empty).
      // Also the voice path's fallback: synthesis declined/threw, or sendMedia failed — the
      // reply is never silently dropped.
      if (!voiceDelivered) await out.finish(failShaped ? { text: '' } : { ...reply, text: proseText }, { surface: actionOnly ? false : surfaced });
      // EXECUTE the limbs AFTER the reply is recorded + delivered: confined to ev.chatId,
      // errors logged, never crash the turn (the record above already captured everything).
      if (parsed && hadActions) { try { await actions.execute(parsed.run, parsed.stripped, ev, { being: to }); } catch (e) { note(`actions ${to}/${ev.chatId}: ${e?.message ?? e}`); } }
    } catch (e) {
      // Any failure once the placeholder is open (brain throw, per-turn timeout, or a
      // delivery fault) → resolve the placeholder VISIBLY. The MESSAGE needs no rescue
      // append here: it was recorded at ingestion, so C1.2 already holds whatever this
      // turn does (that rescue used to double-record the auto-dwell burst, which had
      // been logged at arrival but was invisible to the flag this branch checked).
      try { await out.fail?.(e); } catch { /* best effort */ }
      note(`turn ${to}/${ev.chatId}: ${e?.message ?? e}`);
    } finally { dropTrain(turnKey); }
  }

  async function runContextTurn({ to, ev, turnKey }) {
    try {
      const reply = await runTurnWithTimeout(to, ev, ev, undefined);
      await transcript.log(ev, { ...reply, surfaced: false });   // reply only — the message is already recorded
      await store?.recordThread?.({ ev, reply, being: to });
    } catch (e) {
      note(`brain ${to}/${ev.chatId}: ${e?.message ?? e}`);
    } finally { dropTrain(turnKey); }
  }

  // --- the time-driven half: due heartbeats + accum flush. ---
  // THE KILL SWITCH rides this pulse (operator 2026-07-25): the operator may
  // `touch EGPT_HOME/STOP` from a terminal, and a RUNNING node must notice. Checked HERE —
  // the loop's own tick, which already exists and which every heartbeat rides — so there is
  // no watcher and no second timer. FIRST, and it returns: a node on its way out fires no
  // further beats. pull() does NOT rewrite a file that is already there, so the reason the
  // operator wrote by hand survives.
  function tick() {
    if (stopSwitch?.present()) { note('STOP file present — stopping the service'); stopSwitch.pull({ reason: 'EGPT_HOME/STOP appeared' }); return; }
    heartbeats.runDue(clock.now());
  }

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
