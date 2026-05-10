// extension/src/tools/bus-flood.js — pure flood-tracker.
//
// Different from event-key dedup: this catches LIVE FLOODS where a
// peer posts many distinct events (different ts → different eventKey)
// with the same content in rapid succession. Example: a shell-side
// bug looped and emitted ~30 identical '> /help' events per second.
// Each had a unique ts/_sig (so eventKey didn't suppress them) but
// the burst was obvious to a human as noise.
//
// After FLOOD_THRESHOLD identical (from, body) within FLOOD_WINDOW_MS,
// subsequent matches are dropped until the window closes. Extracted
// as a class so the time source is injectable for testing — bus-ext.js
// passes `() => Date.now()`, tests pass a fake clock.

export const DEFAULT_FLOOD_WINDOW_MS = 5_000;
export const DEFAULT_FLOOD_THRESHOLD = 5;

export function floodKey(ev) {
  return `${ev?.from ?? '?'}:${(ev?.body ?? '').slice(0, 60)}`;
}

export class FloodTracker {
  constructor({
    windowMs = DEFAULT_FLOOD_WINDOW_MS,
    threshold = DEFAULT_FLOOD_THRESHOLD,
    now = () => Date.now(),
    onSuppress = null,
  } = {}) {
    this.windowMs = windowMs;
    this.threshold = threshold;
    this.now = now;
    this.onSuppress = onSuppress;
    this._counts = new Map();   // key → { firstTs, count, warned }
  }

  // Returns true when the event should be DROPPED as a flood.
  check(ev) {
    if (!ev || typeof ev !== 'object') return false;
    if (typeof ev.body !== 'string') return false;
    const k = floodKey(ev);
    const t = this.now();
    const e = this._counts.get(k);
    if (!e || (t - e.firstTs) > this.windowMs) {
      this._counts.set(k, { firstTs: t, count: 1, warned: false });
      return false;
    }
    e.count++;
    if (e.count <= this.threshold) return false;
    if (!e.warned) {
      e.warned = true;
      if (this.onSuppress) {
        try { this.onSuppress(ev, e.count, this.threshold, this.windowMs); } catch (_) {}
      }
    }
    return true;
  }
}
