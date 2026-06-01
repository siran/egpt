// src/engine/output.mjs — the engine's single OUTPUT chokepoint.
//
// Everything the engine renders for a surface flows through ONE channel: the
// engine emit()s an output item; surfaces subscribe() and render it. Today the
// only subscriber is the Ink renderer (the App's setItems). Phase D (thin
// clients over the attach transport) adds socket subscribers without the engine
// knowing or caring — that is the whole point of the seam: the engine stops
// calling React's setItems directly and instead emits to a transport-agnostic
// channel.
//
// Framework-free, synchronous, and isolated (one listener throwing never blocks
// the others or the emitter — the same fan-out discipline as the nucleus
// surface registry) so it runs headless and is unit-testable.
//
// See ENGINE-SURFACE-SEPARATION.md (Phase B).

export function createOutputChannel({ logger = console } = {}) {
  const listeners = new Set();

  // Subscribe to every emitted item. Returns an unsubscribe handle.
  function subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new Error('output channel: subscribe(listener) requires a function');
    }
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  // Emit one output item to every subscriber. Per-listener errors are isolated
  // and logged — a wedged renderer must never break delivery to the others.
  // Returns the count of listeners notified without throwing.
  function emit(item) {
    let delivered = 0;
    for (const listener of listeners) {
      try { listener(item); delivered++; }
      catch (e) { logger?.error?.(`output channel: listener threw: ${e?.message ?? e}`); }
    }
    return delivered;
  }

  return { subscribe, emit, get size() { return listeners.size; } };
}
