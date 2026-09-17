// decode-once.test.mjs — the one memory of "already decoded / decoding" (src/tools/decode-once.mjs):
// asked without a decode to start (the worker's lookup), made durable by an injected store (the worker's
// file under state/), and bounded by count and age.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDecodeOnce, fileStore, DURABLE_MAX, DURABLE_TTL_MS } from '../src/tools/decode-once.mjs';

const memStore = (entries = []) => { const s = { saves: [], load: () => entries, save: (e) => { s.saves.push(e); } }; return s; };
const decodes = (value) => { const d = { n: 0 }; d.start = () => { d.n += 1; return { result: Promise.resolve(value) }; }; return d; };
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('decode-once — asked without a decode to start', () => {
  it('unknown: { served: null, job: null } and nothing starts; known: served', async () => {
    const once = createDecodeOnce();
    expect(once('a'.repeat(64))).toEqual({ served: null, job: null });
    const d = decodes({ transcript: 'hola', meta: {} });
    once('a'.repeat(64), d.start);
    expect(once('a'.repeat(64)).served).toBe('running');
    await settle();
    const { served, job } = once('a'.repeat(64));
    expect(served).toBe('recent');
    expect(await job.result).toEqual({ transcript: 'hola', meta: {} });
    expect(d.n).toBe(1);
  });
});

describe('decode-once — a durable memory', () => {
  it('what the store holds is answered at once, with no decode', async () => {
    const store = memStore([['k1', { at: Date.now(), value: { transcript: 'from disk', meta: { durationSec: 3 } } }]]);
    const once = createDecodeOnce({ store });
    const d = decodes({ transcript: 'decoded', meta: {} });
    const { served, job } = once('k1', d.start);
    expect(served).toBe('recent');
    expect(await job.result).toEqual({ transcript: 'from disk', meta: { durationSec: 3 } });
    expect(d.n).toBe(0);
  });

  it('each kept result is saved, oldest first', async () => {
    const store = memStore();
    const once = createDecodeOnce({ store, now: () => 1000 });
    once('k1', decodes({ transcript: 'one', meta: {} }).start);
    once('k2', decodes({ transcript: 'two', meta: {} }).start);
    await settle();
    expect(store.saves.at(-1)).toEqual([['k1', { at: 1000, value: { transcript: 'one', meta: {} } }], ['k2', { at: 1000, value: { transcript: 'two', meta: {} } }]]);
  });

  it('kept DURABLE_TTL_MS; past it the bytes decode again', async () => {
    let clock = 0;
    const once = createDecodeOnce({ store: memStore(), now: () => clock });
    const d = decodes({ transcript: 'hola', meta: {} });
    once('k', d.start); await settle();
    clock = DURABLE_TTL_MS;
    expect(once('k', d.start).served).toBe('recent');
    clock = DURABLE_TTL_MS + 1;
    expect(once('k', d.start).served).toBe(null);
    expect(d.n).toBe(2);
  });

  it('bounded by count: the oldest is pushed out, and no save holds more than DURABLE_MAX', async () => {
    const store = memStore();
    const once = createDecodeOnce({ store, now: () => 5 });
    for (let i = 0; i <= DURABLE_MAX; i++) once(`k${i}`, decodes({ transcript: `t${i}`, meta: {} }).start);
    await settle();
    expect(Math.max(...store.saves.map((s) => s.length))).toBe(DURABLE_MAX);
    expect(once('k0').served).toBe(null);
    expect(once('k1').served).toBe('recent');
    expect(once(`k${DURABLE_MAX}`).served).toBe('recent');
  });

  it('what the store hands back past the bounds is dropped at load', () => {
    const entries = Array.from({ length: DURABLE_MAX + 5 }, (_, i) => [`k${i}`, { at: 100, value: { transcript: `t${i}`, meta: {} } }]);
    const once = createDecodeOnce({ store: memStore(entries), now: () => 100 });
    expect(once('k4').served).toBe(null);
    expect(once('k5').served).toBe('recent');
    const stale = createDecodeOnce({ store: memStore([['old', { at: 0, value: { transcript: 'x', meta: {} } }]]), now: () => DURABLE_TTL_MS + 1 });
    expect(stale('old').served).toBe(null);
  });

  it('an empty, null or thrown result is never saved', async () => {
    const store = memStore();
    const once = createDecodeOnce({ store });
    once('empty', decodes({ transcript: '', meta: {} }).start);
    once('null', decodes(null).start);
    once('threw', () => ({ result: Promise.reject(new Error('whisper crashed')) }));
    await settle(); await settle();
    expect(store.saves).toEqual([]);
    expect(once('empty').served).toBe(null);
    expect(once('threw').served).toBe(null);
  });
});

describe('fileStore — the memory on disk', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'egpt-decode-once-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('what save wrote, load reads back in order; the folder is made if missing', () => {
    const path = join(dir, 'state', 'transcriptor-decoded.json');
    const entries = [['k1', { at: 1, value: { transcript: 'uno', meta: { durationSec: 1.5 } } }], ['k2', { at: 2, value: { transcript: 'dos', meta: {} } }]];
    fileStore(path).save(entries);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(entries);
    const logs = [];
    expect(fileStore(path, (m) => logs.push(m)).load()).toEqual(entries);
    expect(logs).toEqual([]);
  });

  it('missing, corrupt or the wrong shape: starts empty and says so, once per load', () => {
    const cases = { missing: null, corrupt: '[["k", {"at": 1', shape: JSON.stringify({ k: 'v' }), entry: JSON.stringify([['k', { at: 1, value: { transcript: 7 } }]]) };
    for (const [name, text] of Object.entries(cases)) {
      const path = join(dir, `${name}.json`);
      if (text !== null) writeFileSync(path, text);
      const logs = [];
      expect(fileStore(path, (m) => logs.push(m)).load()).toEqual([]);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatch(/starting empty/);
    }
  });
});
