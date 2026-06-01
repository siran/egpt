// Surface registry: the fan-out core of the one-nucleus spine. These tests pin
// the contract the WA/TG/shell/ext surfaces all rely on — add/remove lifecycle,
// kind-filtered broadcast, and (critically) per-surface error isolation so one
// wedged client can't stall the mirror to the rest.
import { describe, it, expect } from 'vitest';
import { createSurfaceRegistry, CLIENT_KINDS, TRANSPORT_KINDS } from '../src/nucleus.mjs';

const quiet = () => ({ error() {} });
const mkSurface = (id, kind, sink) => ({ id, kind, send: (env) => sink.push([id, env]) });

describe('createSurfaceRegistry', () => {
  it('add / get / has / list and the unsubscribe handle', () => {
    const reg = createSurfaceRegistry({ logger: quiet() });
    const sink = [];
    const off = reg.add(mkSurface('wa', 'wa', sink));
    reg.add(mkSurface('shell:1', 'shell', sink));
    expect(reg.size).toBe(2);
    expect(reg.has('wa')).toBe(true);
    expect(reg.get('shell:1').kind).toBe('shell');
    expect(reg.list('shell').map(s => s.id)).toEqual(['shell:1']);
    expect(reg.list().length).toBe(2);
    off();                              // unsubscribe handle removes 'wa'
    expect(reg.has('wa')).toBe(false);
    expect(reg.size).toBe(1);
  });

  it('validates required fields', () => {
    const reg = createSurfaceRegistry({ logger: quiet() });
    expect(() => reg.add({})).toThrow(/id/);
    expect(() => reg.add({ id: 'x' })).toThrow(/kind/);
    expect(() => reg.add({ id: 'x', kind: 'shell' })).toThrow(/send/);
  });

  it('mirrorToClients targets shell+ext, honors exceptId, isolates send errors', () => {
    const errors = [];
    const reg = createSurfaceRegistry({ logger: { error: (m) => errors.push(m) } });
    const sink = [];
    reg.add(mkSurface('wa', 'wa', sink));                 // transport: excluded by kind
    reg.add(mkSurface('shell:1', 'shell', sink));         // excluded by exceptId
    reg.add({ id: 'shell:2', kind: 'shell', send: () => { throw new Error('boom'); } });
    reg.add(mkSurface('ext:1', 'ext', sink));             // the only successful delivery

    const n = reg.mirrorToClients({ body: 'hi' }, { exceptId: 'shell:1' });
    expect(sink.map(([id]) => id)).toEqual(['ext:1']);
    expect(n).toBe(1);                                    // only ext:1 delivered ok
    expect(errors.some(e => /shell:2/.test(e))).toBe(true);
  });

  it('deliverTo hits one surface and reports existence/throw', () => {
    const reg = createSurfaceRegistry({ logger: quiet() });
    const sink = [];
    reg.add(mkSurface('wa', 'wa', sink));
    expect(reg.deliverTo('wa', { body: 'x' })).toBe(true);
    expect(reg.deliverTo('nope', { body: 'x' })).toBe(false);
    expect(sink).toEqual([['wa', { body: 'x' }]]);
  });

  it('remove() calls stop() and isolates its errors', () => {
    const errors = [];
    const reg = createSurfaceRegistry({ logger: { error: (m) => errors.push(m) } });
    let stopped = false;
    reg.add({ id: 'a', kind: 'shell', send() {}, stop() { stopped = true; } });
    reg.add({ id: 'b', kind: 'shell', send() {}, stop() { throw new Error('nope'); } });
    expect(reg.remove('a')).toBe(true);
    expect(stopped).toBe(true);
    expect(reg.remove('b')).toBe(true);    // still removed despite stop() throwing
    expect(reg.remove('missing')).toBe(false);
    expect(errors.some(e => /b stop/.test(e))).toBe(true);
  });

  it('exposes the kind groupings', () => {
    expect([...CLIENT_KINDS].sort()).toEqual(['ext', 'shell']);
    expect([...TRANSPORT_KINDS].sort()).toEqual(['tg', 'wa']);
  });
});
