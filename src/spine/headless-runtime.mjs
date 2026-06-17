// Minimal component/hook runtime for the legacy spine harness.
//
// This is not a UI renderer. It exists only so the current engine lifecycle,
// still shaped like a React component, can run without depending on Ink or
// React. The visible terminal UI is src/shell/ink-limb.mjs.

export const Fragment = Symbol.for('egpt.headless.fragment');

export function createElement(type, props = null, ...children) {
  return { type, props: { ...(props ?? {}), children } };
}

export function Box() { return null; }
export function Text() { return null; }
export function Static() { return null; }

let CURRENT = null;

function depsChanged(prev, next) {
  if (!prev || !next) return true;
  if (prev.length !== next.length) return true;
  for (let i = 0; i < prev.length; i++) {
    if (!Object.is(prev[i], next[i])) return true;
  }
  return false;
}

class HeadlessRunner {
  constructor(element) {
    this.element = element;
    this.hooks = [];
    this.hookIndex = 0;
    this.pendingEffects = [];
    this.scheduled = false;
    this.rendering = false;
    this.stopped = false;
  }

  schedule() {
    if (this.stopped || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.run();
    });
  }

  run() {
    if (this.stopped || this.rendering) return;
    this.rendering = true;
    this.hookIndex = 0;
    this.pendingEffects = [];
    const prev = CURRENT;
    CURRENT = this;
    try {
      if (typeof this.element?.type === 'function') {
        this.element.type(this.element.props ?? {});
      }
    } finally {
      CURRENT = prev;
      this.rendering = false;
    }
    this.flushEffects();
  }

  flushEffects() {
    for (const item of this.pendingEffects) {
      const hook = this.hooks[item.index];
      try {
        if (typeof hook.cleanup === 'function') hook.cleanup();
      } catch (e) {
        console.error(`headless effect cleanup failed: ${e?.message ?? e}`);
      }
      try {
        hook.cleanup = item.effect() ?? null;
      } catch (e) {
        console.error(`headless effect failed: ${e?.message ?? e}`);
      }
    }
  }

  unmount() {
    this.stopped = true;
    for (const hook of this.hooks) {
      if (typeof hook?.cleanup !== 'function') continue;
      try { hook.cleanup(); } catch {}
    }
  }
}

function runner() {
  if (!CURRENT) throw new Error('headless hook called outside render');
  return CURRENT;
}

export function render(element) {
  const r = new HeadlessRunner(element);
  r.run();
  return { unmount: () => r.unmount() };
}

export function useRef(initialValue) {
  const r = runner();
  const i = r.hookIndex++;
  if (!r.hooks[i]) r.hooks[i] = { current: initialValue };
  return r.hooks[i];
}

export function useState(initialValue) {
  const r = runner();
  const i = r.hookIndex++;
  if (!r.hooks[i]) {
    r.hooks[i] = {
      value: typeof initialValue === 'function' ? initialValue() : initialValue,
    };
  }
  const setState = (nextValue) => {
    const hook = r.hooks[i];
    const next = typeof nextValue === 'function' ? nextValue(hook.value) : nextValue;
    if (Object.is(next, hook.value)) return;
    hook.value = next;
    r.schedule();
  };
  return [r.hooks[i].value, setState];
}

export function useEffect(effect, deps) {
  const r = runner();
  const i = r.hookIndex++;
  const prev = r.hooks[i];
  if (!prev) {
    r.hooks[i] = { deps, cleanup: null };
    r.pendingEffects.push({ index: i, effect });
    return;
  }
  if (depsChanged(prev.deps, deps)) {
    prev.deps = deps;
    r.pendingEffects.push({ index: i, effect });
  }
}

export function useCallback(fn, deps) {
  const r = runner();
  const i = r.hookIndex++;
  const prev = r.hooks[i];
  if (!prev || depsChanged(prev.deps, deps)) {
    r.hooks[i] = { deps, fn };
  }
  return r.hooks[i].fn;
}

export function useInput() {
  // A spine has no local terminal input; input arrives over attach surfaces.
}

export function useApp() {
  return { exit: (code = 0) => process.exit(code) };
}

