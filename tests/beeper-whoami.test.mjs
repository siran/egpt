// beeper-whoami — WHICH Desktop is on which port, and whose account it is (operator 2026-09-03).
// No Beeper and no network: probe and the Windows socket-owner lookup are both injected.
//
// What is locked here is the reasoning the tool exists for. A 401 is a RESULT, not a failure:
// a token belongs to an INSTALL, so it is the 401 from the OTHER connection that proves two
// separate Desktops are answering rather than one. And a connection with no base_url must be
// reported as riding the bridge DEFAULT (23373) rather than as unset, because that default is
// exactly what the spine would ride.
import { describe, it, expect } from 'vitest';
import { connectionsOf, report } from '../src/tools/beeper-whoami.mjs';

const cfg = {
  node_name: 'kg',
  beeper: {
    use: 'main',
    main: { account: 'an@example.com', base_url: 'http://127.0.0.1:23373', token: 'tok-s0' },
    s1: { account: 'an@example.com', base_url: 'http://127.0.0.1:23374', token: 'tok-s1' },
  },
};

// Two installs, one account: each token answers exactly one port.
const fakeProbe = async (baseUrl, token) => {
  const port = Number(new URL(baseUrl).port);
  const owner = { 23373: 'tok-s0', 23374: 'tok-s1' }[port];
  if (!owner) return { ok: false, status: 0, error: 'ECONNREFUSED' };
  if (token !== owner) return { ok: false, status: 401 };
  return { ok: true, status: 200, loginID: '@an:beeper.com', email: 'an@example.com', networks: ['Beeper', 'WhatsApp'] };
};

const fakeOwners = async () => new Map([
  [23373, { pid: 100, session: 0, image: 'Beeper.exe' }],
  [23374, { pid: 200, session: 1, image: 'Beeper.exe' }],
]);

describe('beeper-whoami', () => {
  it('lists the connections in config, excluding `use` (a pointer, not a connection)', () => {
    const conns = connectionsOf(cfg);
    expect(conns.map((c) => c.name)).toEqual(['main', 's1']);
    expect(conns.find((c) => c.name === 'main').isUse).toBe(true);
  });

  it('reports a connection with no base_url as riding the bridge DEFAULT, not as unset', () => {
    const [c] = connectionsOf({ beeper: { use: 'main', main: { token: 't' } } });
    expect(c.baseUrl).toBe('http://127.0.0.1:23373');
  });

  it('names the session that owns each port, and whose account answers there', async () => {
    const out = await report({ cfg, deps: { probe: fakeProbe, localOwners: fakeOwners } });
    expect(out).toMatch(/:23373\s+pid 100, SESSION 0/);
    expect(out).toMatch(/:23374\s+pid 200, SESSION 1/);
    expect(out).toMatch(/main \(use\): 200\s+@an:beeper\.com/);
    expect(out).toMatch(/config beeper\.main → http:\/\/127\.0\.0\.1:23373.*→ SESSION 0/);
    expect(out).toMatch(/config beeper\.s1 → http:\/\/127\.0\.0\.1:23374.*→ SESSION 1/);
  });

  it('reads a 401 as PROOF of a different install, never as a broken token', async () => {
    const out = await report({ cfg, deps: { probe: fakeProbe, localOwners: fakeOwners } });
    expect(out).toMatch(/s1: 401\s+a different install answers here/);
    expect(out).toMatch(/main \(use\): 401\s+a different install answers here/);
  });

  it('says so plainly when a connection carries no token', async () => {
    const noTok = { ...cfg, beeper: { ...cfg.beeper, s1: { ...cfg.beeper.s1, token: '' } } };
    const out = await report({ cfg: noTok, deps: { probe: fakeProbe, localOwners: fakeOwners } });
    expect(out).toMatch(/s1: no token in config — cannot ask/);
  });

  it('survives a node where nothing is listening at all', async () => {
    const out = await report({ cfg, deps: { probe: async () => ({ ok: false, status: 0, error: 'ECONNREFUSED' }), localOwners: async () => new Map() } });
    expect(out).toMatch(/nothing listening/);
    expect(out).toMatch(/→ nobody listening/);
  });
});
