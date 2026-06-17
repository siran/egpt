// Locks the spine's headless component/hook runtime (src/spine/headless-runtime.mjs).
// This shim lets the legacy App-shaped engine lifecycle run WITHOUT Ink/React, so
// it must faithfully implement the small hook surface the spine relies on:
// useState/useEffect/useRef/useCallback + render lifecycle + useApp/useInput.
// (Spine-no-ink: removing the Ink dependency from the spine.)
import { describe, it, expect, vi } from 'vitest';
import {
  createElement, render, Box, Text, Static,
  useState, useEffect, useRef, useCallback, useInput, useApp,
} from '../src/spine/headless-runtime.mjs';

// setState schedules a re-render via queueMicrotask; a microtask yield flushes it.
const flush = () => new Promise((r) => queueMicrotask(r));

describe('spine headless-runtime — the engine runs without Ink/React', () => {
  it('createElement returns a {type, props:{...,children}} node', () => {
    const el = createElement('frag', { a: 1 }, 'c1', 'c2');
    expect(el.type).toBe('frag');
    expect(el.props.a).toBe(1);
    expect(el.props.children).toEqual(['c1', 'c2']);
  });

  it('Box/Text/Static render to nothing (headless — no UI)', () => {
    expect(Box()).toBeNull();
    expect(Text()).toBeNull();
    expect(Static()).toBeNull();
  });

  it('render runs the component body then flushes effects (synchronously at mount)', () => {
    const order = [];
    const Comp = () => {
      order.push('render');
      useEffect(() => { order.push('effect'); }, []);
      return null;
    };
    render(createElement(Comp));
    expect(order).toEqual(['render', 'effect']);
  });

  it('a [] effect runs once at mount; its cleanup runs on unmount', () => {
    let runs = 0, cleanups = 0;
    const Comp = () => {
      useEffect(() => { runs++; return () => { cleanups++; }; }, []);
      return null;
    };
    const { unmount } = render(createElement(Comp));
    expect(runs).toBe(1);
    unmount();
    expect(cleanups).toBe(1);
  });

  it('useState re-renders on a changed value, bails on an Object.is-equal set, supports functional updates', async () => {
    let renders = 0, set;
    const Comp = () => {
      renders++;
      const [v, setV] = useState(0);
      set = setV;
      void v;
      return null;
    };
    render(createElement(Comp));
    expect(renders).toBe(1);
    set(1); await flush();
    expect(renders).toBe(2);
    set(1); await flush();          // same value → no re-render
    expect(renders).toBe(2);
    set((n) => n + 1); await flush(); // functional update
    expect(renders).toBe(3);
  });

  it('useState initializes lazily from a function', () => {
    let seen;
    const Comp = () => { const [v] = useState(() => 42); seen = v; return null; };
    render(createElement(Comp));
    expect(seen).toBe(42);
  });

  it('useEffect re-runs only when its deps change, cleaning up the prior run first', async () => {
    const log = [];
    let setDep;
    const Comp = () => {
      const [d, setD] = useState('a');
      setDep = setD;
      useEffect(() => { log.push(`run:${d}`); return () => log.push(`cleanup:${d}`); }, [d]);
      return null;
    };
    render(createElement(Comp));
    expect(log).toEqual(['run:a']);
    setDep('a'); await flush();      // unchanged → no re-render, no effect re-run
    expect(log).toEqual(['run:a']);
    setDep('b'); await flush();      // changed → cleanup old, run new
    expect(log).toEqual(['run:a', 'cleanup:a', 'run:b']);
  });

  it('useRef persists the SAME object across renders; useCallback memoizes by deps', async () => {
    let ref, cbFirst, cbLatest, bump;
    const Comp = () => {
      ref = useRef({ n: 0 });
      const [x, setX] = useState(0);
      bump = () => setX(x + 1);
      const cb = useCallback(() => x, []);
      if (!cbFirst) cbFirst = cb;
      cbLatest = cb;
      return null;
    };
    render(createElement(Comp));
    ref.current.n = 5;          // mutate through the ref
    bump(); await flush();      // force a re-render
    expect(ref.current.n).toBe(5);   // same ref survived the re-render
    expect(cbLatest).toBe(cbFirst);  // memoized across renders (deps [])
  });

  it('useApp().exit delegates to process.exit; useInput is inert in a spine', () => {
    const spy = vi.spyOn(process, 'exit').mockImplementation(() => undefined);
    let app;
    const Comp = () => { app = useApp(); useInput(() => { throw new Error('spine has no terminal input'); }); return null; };
    render(createElement(Comp));
    app.exit(0);
    expect(spy).toHaveBeenCalledWith(0);
    spy.mockRestore();
  });

  it('a hook called outside render throws (Rules-of-Hooks guard)', () => {
    expect(() => useState(0)).toThrow(/outside render/);
  });
});
