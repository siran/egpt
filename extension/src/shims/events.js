// Minimal EventEmitter shim for browser.
export class EventEmitter {
  constructor() { this._events = {}; }
  on(event, fn) { (this._events[event] ??= []).push(fn); return this; }
  once(event, fn) {
    const wrapper = (...args) => { this.off(event, wrapper); fn(...args); };
    return this.on(event, wrapper);
  }
  off(event, fn) {
    this._events[event] = (this._events[event] ?? []).filter(f => f !== fn);
    return this;
  }
  emit(event, ...args) {
    (this._events[event] ?? []).slice().forEach(fn => fn(...args));
    return this;
  }
  removeAllListeners(event) {
    if (event) delete this._events[event]; else this._events = {};
    return this;
  }
  listeners(event) { return (this._events[event] ?? []).slice(); }
}
export default EventEmitter;
