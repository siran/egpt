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
 * @property {{ resolve: (ev: InboundEvent) => string }} router          @being → local being target
 * @property {{ mayReceive: (being: string, ev: InboundEvent) => boolean,
 *             mayReply:   (being: string, ev: InboundEvent) => boolean }} gating   per-chat mode + pause + mention
 * @property {{ deliver: (chatId: string, reply: any) => void|Promise<void> }} sender   stream-edit / one-shot delivery
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
  clock = { now: () => Date.now() },
  log = {},
  tickMs = 0,
  setInterval: setIntervalFn = globalThis.setInterval,
  clearInterval: clearIntervalFn = globalThis.clearInterval,
} = {}) {
  for (const [name, dep] of Object.entries({ bridge, brain, identity, router, gating, sender, transcript, heartbeats })) {
    if (!dep) throw new Error(`createSpine: missing required dependency '${name}'`);
  }
  const note = (s) => { try { log.line?.(s); } catch {} };

  // --- the inbound queue (event-driven half). Bridge callbacks push; one async
  //     pump drains serially so handleInbound never interleaves two messages. ---
  const queue = [];
  let pumping = null;
  function enqueue(msg) { queue.push(msg); return pump(); }
  function pump() {
    if (pumping) return pumping;
    pumping = (async () => {
      try { while (queue.length) await handleInbound(queue.shift()); }
      finally { pumping = null; }
    })();
    return pumping;
  }

  // --- the receive → gate → brain → reply → send pipe (§2a). Every branch logs
  //     the inbound to the transcript: a received message is never silently
  //     dropped (C1.2). ---
  async function handleInbound(msg) {
    const ev = identity.build(msg);
    const to = router.resolve(ev);

    // mode gate, layer 1: does this being even RECEIVE this chat? ('off'/'mute'
    // reception). Recorded either way. The log is AWAITED so the transcript write
    // can't race the next message (durability + serial ordering, C1.2).
    if (!gating.mayReceive(to, ev)) { await transcript.log(ev); return; }

    // mesh-target forwarding (gating.isMeshTarget → mesh.forward) is layered in
    // at Phase 4b — a local-being target falls through to the brain here.

    // mode gate, layer 2: mode + absolute pause + mention. Runs BEFORE the brain
    // (C4.1). NOTE (v1): this is the skeleton gate — the richer "invoke for
    // context but withhold fan-out" nuance (auto-mode.fanOutDecision / accum)
    // lands when the real gating service is wired in Phase 3.
    if (!gating.mayReply(to, ev)) { await transcript.log(ev); return; }

    const reply = await brain.turn(to, ev);
    await sender.deliver(ev.chatId, reply);
    await transcript.log(ev, reply);
    await store?.recordThread?.({ ev, reply, being: to });
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

  return { start, stop, tick, handleInbound };
}
