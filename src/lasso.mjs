// lasso.mjs — THE OUTBOUND RATE REGULATOR (operator 2026-07-26): "this guard must be
// agnostic to everything, is a major loop that counts how many messages in a time window
// has been sent out to any limb ... a big lasso that sandboxes egpt" / "under no reason
// must the bridge exceed a normal sending rate. that is a self-regulated existance."
//
// WHY IT EXISTS (2026-07-25 incident, not theory): two nodes traded hundreds of messages
// ~0.7s apart until the service had to be killed. The loop counter (src/stop-guard.mjs)
// never moved — it counts INBOUND non-human turns at the PROMPT chokepoint, and those
// replies never prompted a brain. NOTHING bounded what LEAVES the node. This does, and it
// does it structurally: the bridge cannot exceed the rate no matter what upstream asks of
// it, so no new caller can reintroduce the class.
//
// THROTTLE, NOT TRIP. "Self-regulated existence" is pacing, not dying: an over-rate message
// WAITS its turn — it is not dropped, and the node is not stopped. An ordinary busy moment
// (a voice-note flurry, two agents answering one message, a mesh request + placeholder +
// reply mirror) is slowed by a beat, never lost. A hard trip would kill the node on those.
//
// BOUNDED. An unbounded delay queue is a memory leak and a latency trap, so the queue is
// capped at `maxQueue` messages (≈ maxQueue / messages * windowMs of drain — 33s at the
// defaults). Only a genuine runaway reaches that; past it the excess IS dropped, loudly and
// visibly (state/lasso.json), because a message delivered minutes late is worse than none.
//
// WHAT COUNTS: one committed MESSAGE — send / startStream (its placeholder) / postStatus /
// sendMedia. NEVER stream.update / stream.finish: those EDIT a message already counted. One
// ordinary streamed reply is a placeholder + N edits + a final = ONE message. Counting
// frames instead would throttle the first normal answer to a crawl.
//
// NEVER THE STOP PATH: a send carrying `{ bypassLasso: true }` skips the gate entirely. A
// kill switch that queues behind a flood is not a kill switch.
//
// FILE CONTROLLED: the limits come from the config's `lasso:` block (loosen without a
// deploy) and every state CHANGE is published to EGPT_HOME/state/lasso.json by boot — so
// "why is egpt slow" is answerable with `cat`, not a debugger. The hot path never does IO:
// the file is written on transitions only (engage / release / first drop), at most 1/s.

const DEFAULTS = { messages: 3, windowMs: 5_000, maxQueue: 20 };

/**
 * @param {object} o
 * @param {number} [o.messages]   committed messages allowed per window (<= 0 disables the lasso entirely)
 * @param {number} [o.windowMs]   the sliding window, ms
 * @param {number} [o.maxQueue]   how many messages may WAIT at once; past it they are dropped
 * @param {() => number} [o.now]  clock seam (tests drive it — no real waiting)
 * @param {typeof globalThis.setTimeout} [o.setTimeout]  timer seam (same reason)
 * @param {(m: string) => void} [o.onLog]
 * @param {(s: object) => void} [o.writeState]  best-effort publisher for state/lasso.json (async, fire-and-forget)
 */
export function createLasso({
  messages = DEFAULTS.messages,
  windowMs = DEFAULTS.windowMs,
  maxQueue = DEFAULTS.maxQueue,
  now = Date.now,
  setTimeout: setTimeoutFn = globalThis.setTimeout,
  onLog = () => {},
  writeState = null,
} = {}) {
  const on = messages > 0 && windowMs > 0;
  const sent = [];        // ms timestamps of the committed emits still inside the window
  const waiters = [];     // FIFO — order out is order in (a rate limiter that reorders replies is a bug)
  let timer = null;
  let delayed = 0, dropped = 0;
  let engaged = false, overflowing = false, lastWrite = -Infinity;

  const prune = (t) => { while (sent.length && t - sent[0] >= windowMs) sent.shift(); };

  // Publish the regulator's state to disk. Called ONLY on transitions (engage / release /
  // the first drop of an overflow) and rate-limited to 1/s — never per message.
  function publish(state, force = false) {
    if (!writeState) return;
    const t = now();
    if (!force && t - lastWrite < 1000) return;
    lastWrite = t;
    try {
      writeState({
        at: new Date(t).toISOString(),
        state,                                                     // idle | throttling | dropping
        limit: { messages, window_ms: windowMs, max_queue: maxQueue },
        in_window: sent.length,
        queued: waiters.length,
        delayed_total: delayed,
        dropped_total: dropped,
      });
    } catch { /* visibility must never break the send path */ }
  }

  // Grant as many waiters as the window allows, then arm ONE timer for the next slot.
  function pump() {
    const t = now();
    prune(t);
    while (waiters.length && sent.length < messages) { sent.push(t); waiters.shift()(); }
    if (waiters.length < maxQueue && overflowing) {
      overflowing = false;
      onLog(`queue drained below the bound (${dropped} dropped in total)`);
    }
    if (waiters.length) {
      if (!timer) timer = setTimeoutFn(() => { timer = null; pump(); }, Math.max(1, windowMs - (t - sent[0])));
    } else if (engaged) {
      engaged = false;
      onLog(`released — back under ${messages}/${windowMs}ms (${delayed} delayed in total)`);
      publish('idle', true);
    }
  }

  // THE GATE. Resolves truthy when this message may leave, falsy when the queue is full and
  // the caller must drop it. Returns a plain `true` on the fast path — the common case costs
  // no timer, no allocation, no IO.
  function acquire() {
    if (!on) return true;
    const t = now();
    prune(t);
    if (!waiters.length && sent.length < messages) { sent.push(t); return true; }
    if (waiters.length >= maxQueue) {
      dropped++;
      // Log ONCE per overflow episode (a per-drop line during a runaway is its own flood), but
      // keep the on-disk count fresh — publish is rate-limited to 1/s, so the operator watching
      // state/lasso.json sees the damage grow without the send path hammering the disk.
      if (!overflowing) { overflowing = true; onLog(`QUEUE FULL (${maxQueue}) — dropping outbound messages`); publish('dropping', true); }
      else publish('dropping');
      return false;
    }
    delayed++;
    if (!engaged) { engaged = true; onLog(`throttling — over ${messages}/${windowMs}ms`); publish('throttling', true); }
    const p = new Promise((resolve) => waiters.push(() => resolve(true)));
    pump();
    return p;
  }

  // Run `fn` behind the gate — the seam for an emit that is NOT a port method. The 👂 echo
  // is the one such emit: it is posted from INSIDE the beeper limb (src/bridges/beeper.mjs),
  // below the port, so it takes the regulator directly instead of being missed by it.
  async function gate(fn) {
    if (await acquire()) return fn();
    onLog('dropped an in-limb emit (queue full)');
    return null;
  }

  const dropLog = (what, chat) => { onLog(`dropped ${what} → ${chat} (queue full)`); };

  // Wrap a LIMB PORT — the beeper port AND the shell port, both, from the ONE lasso, so the
  // count is node-wide rather than per-limb (the operator's "any limb"). A Proxy, not a
  // spread: the shell port exposes `isConnected` as a GETTER and a spread would freeze it to
  // its boot-time value. Everything the port has that is not one of the four commit methods
  // passes straight through.
  function wrap(port) {
    const gated = {
      // bypassLasso: the STOP path. It must ALWAYS get out — see the module header.
      send: async (chat, text, opts = {}) =>
        (opts?.bypassLasso || await acquire()) ? port.send(chat, text, opts) : (dropLog('send', chat), null),
      postStatus: async (chat, text) =>
        (await acquire()) ? port.postStatus(chat, text) : (dropLog('postStatus', chat), null),
      sendMedia: port.sendMedia && (async (chat, filePath, opts = {}) =>
        (await acquire()) ? port.sendMedia(chat, filePath, opts) : (dropLog('sendMedia', chat), false)),
      startStream: (chat, init, opts = {}) => lazyStream(port, chat, init, opts),
    };
    return new Proxy(port, {
      get: (t, k) => (Object.hasOwn(gated, k) && gated[k] ? gated[k] : Reflect.get(t, k, t)),
    });
  }

  // startStream must return its handle SYNCHRONOUSLY (the sender streams into it without
  // awaiting), so the gate cannot be awaited here. Open the real stream BEHIND the gate and
  // chain every frame onto it: the PLACEHOLDER — the one committed message — is what waits,
  // and the edits that follow queue behind it exactly as they already queue behind the real
  // port's own async placeholder-id resolution. `delivered` / `lastError` are read only
  // after `await finish()`, by which time the real handle exists.
  function lazyStream(port, chat, init, opts) {
    let h = null, refused = false;
    const opened = Promise.resolve(acquire()).then((ok) => {
      if (!ok) { refused = true; dropLog('startStream', chat); return null; }
      h = port.startStream?.(chat, init, opts) ?? null;
      return h;
    });
    const onOpen = (fn) => opened.then((s) => (s ? fn(s) : undefined));
    return {
      // update/fail are fire-and-forget (the sender never awaits them), so they swallow —
      // an unhandled rejection is not something a live limb should hand the process. finish
      // and delete ARE awaited, so their faults still reach the caller exactly as before.
      update: (t) => { onOpen((s) => s.update?.(t)).catch(() => {}); },
      finish: (t) => onOpen((s) => s.finish?.(t)),
      delete: () => onOpen((s) => s.delete?.()),
      fail: (e) => { onOpen((s) => s.fail?.(e)).catch(() => {}); },
      get delivered() { return h?.delivered ?? false; },
      get lastError() { return h?.lastError ?? (refused ? 'lasso: queue full' : null); },
    };
  }

  return {
    wrap,
    gate,
    enabled: on,
    stats: () => ({ inWindow: sent.length, queued: waiters.length, delayed, dropped }),
  };
}
