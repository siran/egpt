// extension/src/tools/bus-flood.js — buffered flood detector.
//
// Goal: catch live floods of identical-body bus events WITHOUT ever
// rendering even one of them. The shell once looped and emitted ~30
// identical '> /help' events per second; even seeing one of those
// (as the old admit-N-then-drop design did) is more noise than the
// user wants.
//
// Strategy: brief HOLD on every body event. If a duplicate (same
// floodKey) arrives during the hold, BOTH (the held one + the
// duplicate) are suppressed and the detector enters flooding mode
// until END_QUIET_MS pass without another match. While flooding,
// duplicates are silently counted. On flood end, the detector fires
// onFloodEnd with the total count. If the hold expires with no
// duplicate, the original event is released normally via onRelease.
//
// Net effect: 0 admitted during a flood; one or two status notices
// emitted on the same event channel ('🔇 suppressing…' / '🔇 N
// duplicates… suppressed'); legitimate solo messages cost a
// HOLD_MS delay before delivery.

export const DEFAULT_HOLD_MS = 250;
export const DEFAULT_END_QUIET_MS = 1_500;

export function floodKey(ev) {
  return `${ev?.from ?? '?'}:${(ev?.body ?? '').slice(0, 60)}`;
}

export class HeldFloodDetector {
  constructor({
    holdMs = DEFAULT_HOLD_MS,
    endQuietMs = DEFAULT_END_QUIET_MS,
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
    onRelease,          // called with original ev when no duplicate within holdMs
    onFloodStart,       // ({ fromKey, bodySnippet }) on first detected duplicate
    onFloodEnd,         // ({ fromKey, bodySnippet, totalCount }) endQuietMs after last duplicate
  } = {}) {
    this.holdMs = holdMs;
    this.endQuietMs = endQuietMs;
    this.setTimeout = setTimeoutFn ?? ((cb, ms) => globalThis.setTimeout(cb, ms));
    this.clearTimeout = clearTimeoutFn ?? ((h) => globalThis.clearTimeout(h));
    this.onRelease     = onRelease     ?? (() => {});
    this.onFloodStart  = onFloodStart  ?? (() => {});
    this.onFloodEnd    = onFloodEnd    ?? (() => {});
    this._held = new Map();
  }

  // Submit a bus event. Returns one of:
  //   'pass'    — not a body event; caller should deliver directly
  //   'held'    — held for holdMs; onRelease will fire eventually
  //               unless a duplicate arrives and converts to flooding
  //   'dropped' — duplicate of a held/flooding event; suppressed
  submit(ev) {
    if (!ev || typeof ev !== 'object' || typeof ev.body !== 'string') {
      return 'pass';
    }
    const key = floodKey(ev);
    const held = this._held.get(key);
    if (!held) {
      // First sighting — hold for holdMs. If nothing else arrives,
      // release as a regular event.
      const entry = {
        ev,
        bodySnippet: (ev.body ?? '').slice(0, 60),
        fromKey:     ev.from,
        droppedCount: 0,
        releaseTimer: null,
        endTimer:     null,
      };
      entry.releaseTimer = this.setTimeout(() => {
        this._held.delete(key);
        this.onRelease(entry.ev);
      }, this.holdMs);
      this._held.set(key, entry);
      return 'held';
    }
    // Duplicate — flooding. Cancel the held event's release; it is
    // now part of the flood and will NOT be delivered.
    if (held.releaseTimer) {
      this.clearTimeout(held.releaseTimer);
      held.releaseTimer = null;
    }
    held.droppedCount++;
    if (held.droppedCount === 1) {
      // First confirmed duplicate — emit start notice
      this.onFloodStart({ fromKey: held.fromKey, bodySnippet: held.bodySnippet });
    }
    // Reset / set the end-of-flood timer
    if (held.endTimer) this.clearTimeout(held.endTimer);
    held.endTimer = this.setTimeout(() => {
      // totalCount = 1 originally held + droppedCount duplicates
      const totalCount = held.droppedCount + 1;
      this._held.delete(key);
      this.onFloodEnd({
        fromKey: held.fromKey,
        bodySnippet: held.bodySnippet,
        totalCount,
      });
    }, this.endQuietMs);
    return 'dropped';
  }

  // Drop all held state. Useful for tests or for forcing a clean
  // slate (e.g., after the user runs /clear).
  reset() {
    for (const entry of this._held.values()) {
      if (entry.releaseTimer) this.clearTimeout(entry.releaseTimer);
      if (entry.endTimer)     this.clearTimeout(entry.endTimer);
    }
    this._held.clear();
  }
}
