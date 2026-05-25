// makeSerialByKey: per-key serialization used to keep a chat's voice
// transcriptions from running in parallel (one whisper slot) and out of order.
import { describe, it, expect } from 'vitest';
import { makeSerialByKey } from '../src/serial-by-key.mjs';

const defer = () => { let resolve, reject; const p = new Promise((res, rej) => { resolve = res; reject = rej; }); return { p, resolve, reject }; };
const tick = () => new Promise(r => setTimeout(r, 0));

describe('makeSerialByKey', () => {
  it('runs same-key tasks one at a time, in call order', async () => {
    const serial = makeSerialByKey();
    const order = [];
    const a = defer(), b = defer();
    const p1 = serial('chat', async () => { order.push('a-start'); await a.p; order.push('a-end'); return 1; });
    const p2 = serial('chat', async () => { order.push('b-start'); await b.p; order.push('b-end'); return 2; });

    await tick();
    // Only the first has started — the second is queued behind it.
    expect(order).toEqual(['a-start']);

    a.resolve(); await tick(); await tick();
    expect(order).toEqual(['a-start', 'a-end', 'b-start']);

    b.resolve();
    expect(await p1).toBe(1);
    expect(await p2).toBe(2);
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('lets different keys run concurrently', async () => {
    const serial = makeSerialByKey();
    const order = [];
    const a = defer(), b = defer();
    serial('chatA', async () => { order.push('A-start'); await a.p; order.push('A-end'); });
    serial('chatB', async () => { order.push('B-start'); await b.p; order.push('B-end'); });

    await tick();
    expect(order).toEqual(['A-start', 'B-start']);   // both started — independent keys
    a.resolve(); b.resolve(); await tick();
  });

  it('propagates a task rejection to its own caller but not the next link', async () => {
    const serial = makeSerialByKey();
    const order = [];
    const p1 = serial('chat', async () => { order.push('a'); throw new Error('boom'); });
    const p2 = serial('chat', async () => { order.push('b'); return 'ok'; });

    await expect(p1).rejects.toThrow('boom');
    expect(await p2).toBe('ok');           // chain survived the failure
    expect(order).toEqual(['a', 'b']);
  });

  it('runs sequentially-awaited same-key tasks in order', async () => {
    const serial = makeSerialByKey();
    const out = [];
    await serial('c', async () => { out.push(1); });
    await serial('c', async () => { out.push(2); });
    await serial('c', async () => { out.push(3); });
    expect(out).toEqual([1, 2, 3]);
  });
});
