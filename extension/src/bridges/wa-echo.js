// extension/src/bridges/wa-echo.js — pure echo-suppression for WA-CDP.
//
// When background dispatches a send via chrome.debugger Input.*, the
// resulting WA Web message lands in the page DOM with fromMe=true and
// our content-script MutationObserver catches it. Without a guard,
// background's content-port handler would treat it as user-typed input
// and republish on the bus / route through dispatch — looping.
//
// Strategy: record { text, ts } per send. When a fromMe incoming
// arrives, look for a matching unconsumed entry within a TTL window;
// match found = suppress + consume. Pure logic so it can be unit-
// tested end-to-end and so the rules stay legible.

export const ECHO_TTL_MS = 15_000;

export function createEchoTracker({ ttlMs = ECHO_TTL_MS, now = () => Date.now() } = {}) {
  const sends = [];

  function gc() {
    // Strict boundary: a record exactly TTL old is considered
    // expired (age >= ttlMs → out). Matches the obvious "15s window"
    // mental model and keeps the test pinning explicit.
    const cutoff = now() - ttlMs;
    while (sends.length && sends[0].ts <= cutoff) sends.shift();
  }

  return {
    /** Called when background dispatches a debugger-send. */
    record(text) {
      sends.push({ text, ts: now() });
    },
    /** Called for every fromMe incoming. Returns true if this is an
     *  echo of our own send (caller should drop it); false if it's
     *  genuine user input (caller should process). Consumes the
     *  matching record on a hit so a second arrival of the same text
     *  isn't suppressed. */
    consume(text) {
      gc();
      const idx = sends.findIndex(e => e.text === text);
      if (idx < 0) return false;
      sends.splice(idx, 1);
      return true;
    },
    /** Test/diagnostic: how many records are pending. */
    size() { gc(); return sends.length; },
    /** Test only: clear all. */
    _reset() { sends.length = 0; },
  };
}
