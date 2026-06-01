import { describe, it, expect, vi } from 'vitest';
import { createOutputChannel } from '../src/engine/output.mjs';

describe('createOutputChannel', () => {
  it('delivers an emitted item to every subscriber', () => {
    const ch = createOutputChannel();
    const a = []; const b = [];
    ch.subscribe(x => a.push(x));
    ch.subscribe(x => b.push(x));
    const item = { id: 1, author: 'system', body: 'hi' };
    const delivered = ch.emit(item);
    expect(delivered).toBe(2);
    expect(a).toEqual([item]);
    expect(b).toEqual([item]);
  });

  it('unsubscribe stops delivery to that listener', () => {
    const ch = createOutputChannel();
    const seen = [];
    const off = ch.subscribe(x => seen.push(x));
    ch.emit('one');
    off();
    ch.emit('two');
    expect(seen).toEqual(['one']);
    expect(ch.size).toBe(0);
  });

  it('isolates a throwing listener — others still receive, emit reports survivors', () => {
    const logger = { error: vi.fn() };
    const ch = createOutputChannel({ logger });
    const good = [];
    ch.subscribe(() => { throw new Error('boom'); });
    ch.subscribe(x => good.push(x));
    const delivered = ch.emit('x');
    expect(good).toEqual(['x']);     // healthy listener unaffected
    expect(delivered).toBe(1);       // only the survivor counts
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('reports the live listener count via size', () => {
    const ch = createOutputChannel();
    expect(ch.size).toBe(0);
    const off1 = ch.subscribe(() => {});
    ch.subscribe(() => {});
    expect(ch.size).toBe(2);
    off1();
    expect(ch.size).toBe(1);
  });

  it('subscribe rejects a non-function', () => {
    const ch = createOutputChannel();
    expect(() => ch.subscribe(null)).toThrow(/requires a function/);
  });
});
