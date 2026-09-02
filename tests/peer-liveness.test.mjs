// peer-liveness — the OBSERVATION that lets a Session 0 spine assume its peer's handle when the
// peer is not there, with no negotiation between them (operator 2026-09-02).
//
// The asymmetry is the safety argument and most of what is tested here: believing the peer is
// alive when it is dead costs silence; believing it is dead when it is alive costs a DOUBLE
// ANSWER in a real chat from two accounts. So yielding takes one probe and claiming takes
// several, and a spine that has not yet looked presumes the peer is alive.
import { describe, it, expect } from 'vitest';
import { createServer } from 'node:net';
import { createPeerLiveness, tcpProbe } from '../src/spine/peer-liveness.mjs';

// A probe whose answers are scripted; the last value repeats once the script runs out.
function scripted(...answers) {
  let i = 0;
  const fn = async () => {
    const v = answers[Math.min(i, answers.length - 1)];
    i++;
    if (v instanceof Error) throw v;
    return v;
  };
  fn.calls = () => i;
  return fn;
}

describe('createPeerLiveness', () => {
  it('presumes the peer is ALIVE before the first probe — a spine that has not looked stays silent', () => {
    const l = createPeerLiveness({ probe: scripted(false) });
    expect(l.isAlive()).toBe(true);
    expect(l.isClaiming()).toBe(false);
    l.stop();
  });

  it('claims only after claimAfter consecutive dead probes', async () => {
    const l = createPeerLiveness({ probe: scripted(false), claimAfter: 3 });
    await l.tick(); expect(l.isClaiming()).toBe(false);   // 1
    await l.tick(); expect(l.isClaiming()).toBe(false);   // 2
    await l.tick(); expect(l.isClaiming()).toBe(true);    // 3 — claimed
    l.stop();
  });

  // YIELD EAGERLY: one live probe hands the handle straight back. This is the direction whose
  // failure costs a double answer, so it must not wait for a streak.
  it('yields on the FIRST live probe, with no streak', async () => {
    const l = createPeerLiveness({ probe: scripted(false, false, false, true), claimAfter: 3 });
    await l.tick(); await l.tick(); await l.tick();
    expect(l.isClaiming()).toBe(true);
    await l.tick();
    expect(l.isClaiming()).toBe(false);   // one probe was enough
    l.stop();
  });

  it('a dead streak RESETS on any live probe — flapping never accumulates into a claim', async () => {
    const l = createPeerLiveness({ probe: scripted(false, false, true, false, false), claimAfter: 3 });
    await l.tick(); await l.tick();       // 2 dead
    await l.tick();                       // live → streak reset
    await l.tick(); await l.tick();       // 2 dead again, still short of 3
    expect(l.isClaiming()).toBe(false);
    l.stop();
  });

  // A throw is an unanswered probe, which is the honest reading of "dead".
  it('a throwing probe counts as dead rather than propagating', async () => {
    const l = createPeerLiveness({ probe: scripted(new Error('ECONNREFUSED')), claimAfter: 2 });
    await l.tick();
    await l.tick();
    expect(l.isClaiming()).toBe(true);
    l.stop();
  });

  it('stop() ends probing — no observation changes the verdict afterwards', async () => {
    const l = createPeerLiveness({ probe: scripted(false), claimAfter: 1 });
    l.stop();
    await l.tick();
    expect(l.isClaiming()).toBe(false);   // still the presumed-alive start state
  });

  it('start() schedules on the injected timer and unrefs it', () => {
    let scheduled = null, cleared = null;
    const fake = { unref() { this.unrefed = true; }, unrefed: false };
    const l = createPeerLiveness({
      probe: scripted(false), everyMs: 1234,
      setIntervalFn: (fn, ms) => { scheduled = { fn, ms }; return fake; },
      clearIntervalFn: (t) => { cleared = t; },
    });
    l.start();
    expect(scheduled.ms).toBe(1234);
    expect(fake.unrefed).toBe(true);
    l.stop();
    expect(cleared).toBe(fake);
  });

  it('an invalid claimAfter falls back to the default rather than claiming instantly', async () => {
    const l = createPeerLiveness({ probe: scripted(false), claimAfter: 0 });
    await l.tick(); await l.tick();
    expect(l.isClaiming()).toBe(false);   // default is 3, so two dead probes are not enough
    await l.tick();
    expect(l.isClaiming()).toBe(true);
    l.stop();
  });
});

describe('tcpProbe — the real observation', () => {
  it('true when something is listening, false when nothing is', async () => {
    const srv = createServer(() => {});
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;

    expect(await tcpProbe({ port })()).toBe(true);

    await new Promise((r) => srv.close(r));
    expect(await tcpProbe({ port, timeoutMs: 500 })()).toBe(false);
  });

  // End to end: a peer that goes away is claimed, and a peer that returns is yielded to.
  it('drives a real claim and a real yield against a real listener', async () => {
    const srv = createServer(() => {});
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;

    const l = createPeerLiveness({ probe: tcpProbe({ port, timeoutMs: 500 }), claimAfter: 2 });
    await l.tick();
    expect(l.isClaiming()).toBe(false);            // peer is up — stay quiet

    await new Promise((r) => srv.close(r));
    await l.tick(); await l.tick();
    expect(l.isClaiming()).toBe(true);             // peer gone — take the handle

    const srv2 = createServer(() => {});
    await new Promise((r) => srv2.listen(port, '127.0.0.1', r));
    await l.tick();
    expect(l.isClaiming()).toBe(false);            // peer back — hand it straight back
    l.stop();
    await new Promise((r) => srv2.close(r));
  });
});
