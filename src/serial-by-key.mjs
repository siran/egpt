// Serialize async work by key. Calls sharing a key run ONE AT A TIME in call
// order; different keys are independent and may overlap. Returns a function
// serial(key, fn) whose result is fn()'s result (awaitable by the caller).
//
// Used to serialize per-chat voice transcription: whisper has a single slot,
// and voice notes in a chat arrive in parallel batches — without this they'd
// fight the slot and scramble transcript order. One failed task doesn't stall
// the chain (errors are swallowed in the internal tail, but propagated to that
// task's own caller via the returned promise). Idle keys are dropped so the
// map doesn't grow unbounded.
export function makeSerialByKey() {
  const chains = new Map();   // key -> tail promise (settles when the chain is idle)
  return function serial(key, fn) {
    const k = key ?? '_';
    const prev = chains.get(k) ?? Promise.resolve();
    const run = prev.then(fn, fn);              // run after prev settles, regardless of its outcome
    const tail = run.then(() => {}, () => {});  // swallow so a rejection doesn't break the next link
    chains.set(k, tail);
    tail.then(() => { if (chains.get(k) === tail) chains.delete(k); });
    return run;                                  // caller gets fn()'s real result/rejection
  };
}
