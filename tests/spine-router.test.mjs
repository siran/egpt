// router.resolve — local sibling @name routing (v1-parity). A body that STARTS
// with `@<name>` (word-boundary, case-insensitive) for a ROUTABLE sibling (a
// config.siblings entry of type ccode/claude-code, enabled) routes to that
// sibling with a synthetic mention; everything else falls through to E.
import { describe, it, expect } from 'vitest';
import { createRouter } from '../src/spine/router.mjs';

const siblings = {
  wren: { type: 'ccode', name: 'wren', body_emoji: '🐦' },
  don:  { type: 'claude-code', name: 'don' },        // synonym engine — routable
  cx:   { type: 'codex', name: 'cx' },               // non-ccode → NOT routable
  off:  { type: 'ccode', name: 'off', enabled: false }, // disabled → NOT routable
  _note: 'a comment key, never routable',
};
const router = createRouter({ getSiblings: () => siblings });
const ev = (body, mention) => ({
  body,
  mention: mention ?? { atEStart: false, atEAnywhere: false, replyToBot: false },
});

describe('router.resolve — sibling @name routing', () => {
  it('@wren at start routes to wren with a synthetic (its-own) mention', () => {
    const r = router.resolve(ev('@wren do X'));
    expect(r.being).toBe('wren');
    expect(r.mention).toEqual({ atEStart: true, atEAnywhere: true, replyToBot: false });
  });

  it('claude-code type is routable too (synonym of ccode)', () => {
    expect(router.resolve(ev('@don ping')).being).toBe('don');
  });

  it('case-insensitive: @Wren → wren', () => {
    expect(router.resolve(ev('@Wren hey')).being).toBe('wren');
  });

  it('@unknown → e (default), preserving ev.mention', () => {
    const m = { atEStart: true, atEAnywhere: true, replyToBot: false };
    const r = router.resolve(ev('@nobody hi', m));
    expect(r.being).toBe('e');
    expect(r.mention).toBe(m);
  });

  it('a disabled sibling → e', () => {
    expect(router.resolve(ev('@off hi')).being).toBe('e');
  });

  it('a non-ccode (codex) sibling → e', () => {
    expect(router.resolve(ev('@cx hi')).being).toBe('e');
  });

  it('mid-body @wren does NOT route (start-anchored, v1 semantics)', () => {
    expect(router.resolve(ev('please @wren do X')).being).toBe('e');
  });

  it('word-boundary: @wrenny does NOT route to wren', () => {
    expect(router.resolve(ev('@wrenny hi')).being).toBe('e');
  });

  it('no siblings configured → always e', () => {
    const bare = createRouter();
    const r = bare.resolve(ev('@wren do X'));
    expect(r.being).toBe('e');
  });

  it('mesh disabled (default): a qualified @being.node is NOT a mesh target', () => {
    // meshEnabled defaults false → v1 behavior; @don.do falls to local routing (don is
    // a routable sibling, matched on the first segment) — NOT a phantom mesh target.
    const r = router.resolve(ev('@don.do hi'));
    expect(r.mesh).toBeUndefined();
    expect(r.being).toBe('don');
  });
});

describe('router.resolve — cross-node mesh targets (Phase 4b)', () => {
  const sibs = {
    wren: { type: 'ccode', name: 'wren' },              // local
    don:  { node: 'do', name: 'don' },                  // remote (lives at node do)
    proxy:{ to: 'jay.mo', name: 'proxy' },              // relay record → jay.mo
  };
  const mrouter = createRouter({ getSiblings: () => sibs, getNode: () => 'kg', meshEnabled: () => true });

  it('a qualified @being.node on another node → mesh target { being, node }, no local being', () => {
    const r = mrouter.resolve(ev('@don.do do X'));
    expect(r.being).toBeNull();
    expect(r.mesh).toMatchObject({ being: 'don', node: 'do', target: 'don.do' });
    expect(r.mention).toMatchObject({ atEStart: true });     // it IS addressed → gates as a mention
  });

  it('a bare @name mapped to a remote sibling → mesh target', () => {
    const r = mrouter.resolve(ev('@don hola'));
    expect(r.mesh).toMatchObject({ being: 'don', node: 'do' });
  });

  it('a relay-record sibling → mesh target at its mapped being.node', () => {
    const r = mrouter.resolve(ev('@proxy ping'));
    expect(r.mesh).toMatchObject({ being: 'jay', node: 'mo' });
  });

  it('a LOCAL sibling still routes locally (no mesh) even with mesh enabled', () => {
    const r = mrouter.resolve(ev('@wren do X'));
    expect(r.mesh).toBeUndefined();
    expect(r.being).toBe('wren');
  });

  it('a same-node qualified @being.node resolves LOCAL, not mesh', () => {
    const r = mrouter.resolve(ev('@wren.kg do X'));
    expect(r.mesh).toBeUndefined();
    expect(r.being).toBe('wren');
  });

  it('an @being.node whose being is unknown here → falls through to e (no mesh, no phantom)', () => {
    const r = mrouter.resolve(ev('@ghost do X'));    // bare, unknown → missing → e
    expect(r.mesh).toBeUndefined();
    expect(r.being).toBe('e');
  });
});
