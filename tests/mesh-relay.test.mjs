import { describe, it, expect, vi } from 'vitest';
import { createMeshRelay, encodeMeshTail, parseMeshTail, stripMeshTails } from '../src/mesh/relay.mjs';
import { createMeshSeenCache } from '../src/mesh/envelope.mjs';

// A shared fake route Room observed by both spines, plus a capture of what each
// spine surfaced into its origin chat. No network, no bus - just visible text.
function harness({ donReply = async () => 'yes, here' } = {}) {
  const room = [];
  const surfaced = { reve: [], dolly: [] };
  const routes = { reve: { room: 'R1' }, dolly: { room: 'R1' } };

  const mk = (node, beings, run) => createMeshRelay({
    node,
    send: async (_route, text) => { room.push(text); },
    surface: async (returnTo, text) => { surfaced[node].push({ returnTo, text }); },
    runBeing: run,
    resolveRoute: (n) => routes[n] ?? null,
    isLocalBeing: (name) => beings.includes(name),
    seen: createMeshSeenCache(),
  });

  const reve = mk('reve', [], async () => '');
  const dolly = mk('dolly', ['don'], donReply);

  // Deliver a Room message to BOTH observers, as a real shared Room would.
  async function deliver(text) {
    await reve.onRoomMessage({ route: routes.reve, text });
    await dolly.onRoomMessage({ route: routes.dolly, text });
  }
  return { room, surfaced, reve, dolly, deliver, routes };
}

describe('mesh relay - human-first visible Room loop', () => {
  it('relays @don.dolly through the shared Room and surfaces the reply to the origin', async () => {
    const h = harness({ donReply: async (_name, prompt) => `you said: ${prompt}` });
    const id = await h.reve.relayOut({ name: 'don', toNode: 'dolly', body: 'here?', returnTo: { surface: 'whatsapp', chat_id: 'HFM' } });
    expect(id).toBeTruthy();

    // request landed in the Room: human body first, compact tail after
    expect(h.room).toHaveLength(1);
    expect(h.room[0]).toMatch(/^@don\.dolly here\?/);
    expect(h.room[0]).toMatch(/\[egpt-mesh:req:/);

    // both observe; only dolly acts and posts a reply into the SAME Room
    await h.deliver(h.room[0]);
    expect(h.room).toHaveLength(2);
    expect(parseMeshTail(h.room[1]).kind).toBe('reply');
    expect(h.surfaced.reve).toHaveLength(0);

    // both observe the reply; reve correlates and surfaces a CLEAN body to HFM
    await h.deliver(h.room[1]);
    expect(h.surfaced.reve).toEqual([{ returnTo: { surface: 'whatsapp', chat_id: 'HFM' }, text: 'you said: here?' }]);
    expect(h.surfaced.reve[0].text).not.toMatch(/egpt-mesh/);
    expect(h.reve.pending.size).toBe(0);
  });

  it('does not drop the reply although the origin saw its own request (same id)', async () => {
    const h = harness();
    await h.reve.relayOut({ name: 'don', toNode: 'dolly', body: 'ping', returnTo: { surface: 'shell' } });
    await h.deliver(h.room[0]);
    await h.deliver(h.room[1]);
    expect(h.surfaced.reve.map(s => s.text)).toEqual(['yes, here']);
  });

  it('runs the target being once even if the request is re-observed (replay guard)', async () => {
    const run = vi.fn(async () => 'once');
    const h = harness({ donReply: run });
    await h.reve.relayOut({ name: 'don', toNode: 'dolly', body: 'x', returnTo: { surface: 'shell' } });
    await h.deliver(h.room[0]);
    await h.dolly.onRoomMessage({ route: h.routes.dolly, text: h.room[0] });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('replies "not here" when the being is not local on the target node', async () => {
    const h = harness();
    await h.reve.relayOut({ name: 'ghost', toNode: 'dolly', body: 'x', returnTo: { surface: 'shell' } });
    await h.deliver(h.room[0]);
    expect(h.room[1]).toMatch(/ghost\.dolly is not here/);
  });

  it('surfaces a no-route error when the target node has no route', async () => {
    const h = harness();
    const id = await h.reve.relayOut({ name: 'don', toNode: 'nowhere', body: 'x', returnTo: { surface: 'shell' } });
    expect(id).toBeNull();
    expect(h.surfaced.reve[0].text).toMatch(/no route to nowhere/);
  });

  it('drops a request whose ttl has run out (no reply, no being run)', async () => {
    const run = vi.fn(async () => 'should not run');
    const h = harness({ donReply: run });
    const text = `@don.dolly x\n${encodeMeshTail({ kind: 'request', id: 'mesh-x', ttl: 0, target: 'don.dolly' })}`;
    const consumed = await h.dolly.onRoomMessage({ route: h.routes.dolly, text });
    expect(consumed).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(h.room).toHaveLength(0);
  });

  it('times out visibly when no reply comes', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      await h.reve.relayOut({ name: 'don', toNode: 'dolly', body: 'x', returnTo: { surface: 'shell' }, target: 'don.dolly' });
      await vi.advanceTimersByTimeAsync(61_000);
      expect(h.surfaced.reve[0].text).toMatch(/don\.dolly did not answer/);
      expect(h.reve.pending.size).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('consumes (never re-relays) a tailed request addressed to another node', async () => {
    // The loop regression: the origin observes its OWN relayed request (e.g. via
    // a second bridge in the same group). It must consume it, not re-relay.
    const h = harness();
    const text = `@don.dolly hi\n${encodeMeshTail({ kind: 'request', id: 'mesh-z', ttl: 3, target: 'don.dolly' })}`;
    const consumed = await h.reve.onRoomMessage({ route: h.routes.reve, text });
    expect(consumed).toBe(true);          // treated as relay traffic
    expect(h.room).toHaveLength(0);       // reve sent nothing (no re-relay)
    expect(h.surfaced.reve).toHaveLength(0);
  });

  it('ignores ordinary messages and round-trips the tail', () => {
    expect(parseMeshTail('just a normal chat message')).toBeNull();
    expect(parseMeshTail(`hi ${encodeMeshTail({ kind: 'request', id: 'mesh-a', ttl: 3 })}`))
      .toMatchObject({ kind: 'request', id: 'mesh-a', ttl: 3, body: 'hi' });
  });

  // 2026-06-19 storm guard: a re-relayed body that already carries mesh tail(s)
  // must NOT accumulate them (one self-test re-relayed its growing body ~30× in
  // 3s, each pass appending another [egpt-mesh:req:…]).
  it('strips pre-existing mesh tails so a re-relay never accumulates them', async () => {
    expect(stripMeshTails(`hello ${encodeMeshTail({ kind: 'request', id: 'mesh-a', ttl: 3, target: 'don.dolly' })}`)).toBe('hello');
    expect(stripMeshTails(`x ${encodeMeshTail({ kind: 'request', id: 'i1', ttl: 3 })} ${encodeMeshTail({ kind: 'reply', id: 'i2', ttl: 2 })}`)).toBe('x');
    expect(stripMeshTails('plain message')).toBe('plain message');

    const h = harness();
    // body already carries a tail (the storm's re-fed body) — relayOut must emit ONE tail, not two.
    const dirty = `self-test ${encodeMeshTail({ kind: 'request', id: 'old-id', ttl: 3, target: 'don.dolly' })}`;
    await h.reve.relayOut({ name: 'don', toNode: 'dolly', body: dirty, returnTo: { surface: 'shell' } });
    expect(h.room[0].match(/\[egpt-mesh:/g)).toHaveLength(1);   // exactly one tail
    expect(h.room[0]).not.toContain('old-id');                 // the stale tail was stripped
    expect(h.room[0]).toMatch(/^@don\.dolly self-test/);       // clean human body preserved
  });
});
