// Don (@d) agent endpoint: HMAC auth, turn round-trip, error shapes, and the
// spine-side client. The runner is injected (a fake that echoes), so these run
// without the Claude SDK or credentials — the real runner (makeClaudeResumeRunner)
// is exercised live, not in unit tests.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startAgentServer, postAgentTurn, signBody } from '../src/tools/agent-endpoint.mjs';

const KEY = 'YWdlbnQtdGVzdC1rZXktYWdlbnQtdGVzdC1rZXktMDA';
const OTHER_KEY = 'b3RoZXIta2V5LW90aGVyLWtleS1vdGhlci1rZXktMA';

let servers;
beforeEach(() => { servers = []; });
afterEach(() => { for (const s of servers) s.close(); });

async function start(runTurn, extra = {}) {
  const s = await startAgentServer({ port: 0, bind: '127.0.0.1', keyB64: KEY, runTurn, ...extra });
  servers.push(s);
  return { s, endpoint: `http://127.0.0.1:${s.port}` };
}

describe('agent endpoint', () => {
  it('round-trips a turn and returns the reply', async () => {
    const seen = [];
    const { endpoint } = await start(async (msg) => { seen.push(msg); return { text: `echo: ${msg}` }; });
    const reply = await postAgentTurn('hello don', { endpoint, keyB64: KEY });
    expect(reply).toBe('echo: hello don');
    expect(seen).toEqual(['hello don']);   // the runner saw exactly the turn text
  });

  it('health needs no auth and names the agent', async () => {
    const { endpoint } = await start(async () => ({ text: 'x' }), { name: 'don' });
    const j = await (await fetch(`${endpoint}/v1/health`)).json();
    expect(j).toEqual({ ok: true, role: 'agent', name: 'don' });
  });

  it('rejects missing, wrong-key, stale, and tampered signatures', async () => {
    const { endpoint } = await start(async () => ({ text: 'should not run' }));
    const body = Buffer.from(JSON.stringify({ message: 'hi' }), 'utf8');
    const post = (headers) => fetch(`${endpoint}/v1/turn`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });

    expect((await post({})).status).toBe(401);                                              // unsigned
    const ts = Date.now();
    expect((await post({ 'x-egpt-ts': String(ts), 'x-egpt-sig': signBody(OTHER_KEY, ts, body) })).status).toBe(401);   // wrong key
    const stale = Date.now() - 120_000;
    expect((await post({ 'x-egpt-ts': String(stale), 'x-egpt-sig': signBody(KEY, stale, body) })).status).toBe(401);   // stale
    expect((await post({ 'x-egpt-ts': String(ts), 'x-egpt-sig': signBody(KEY, ts, Buffer.from('{"message":"other"}')) })).status).toBe(401);   // tampered
  });

  it('missing message -> 400', async () => {
    const { endpoint } = await start(async () => ({ text: 'x' }));
    const body = Buffer.from(JSON.stringify({ notmessage: 'hi' }), 'utf8');
    const ts = Date.now();
    const res = await fetch(`${endpoint}/v1/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-egpt-ts': String(ts), 'x-egpt-sig': signBody(KEY, ts, body) },
      body,
    });
    expect(res.status).toBe(400);
  });

  it('empty reply -> 422 (client throws)', async () => {
    const { endpoint } = await start(async () => ({ text: '   ' }));
    await expect(postAgentTurn('hi', { endpoint, keyB64: KEY })).rejects.toThrow(/422/);
  });

  it('runner error -> 500 (client throws)', async () => {
    const { endpoint } = await start(async () => { throw new Error('session gone'); });
    await expect(postAgentTurn('hi', { endpoint, keyB64: KEY })).rejects.toThrow(/500/);
  });

  it('refuses to start without a key or runner', async () => {
    await expect(startAgentServer({ port: 0, runTurn: async () => ({ text: 'x' }) })).rejects.toThrow(/keyB64/);
    await expect(startAgentServer({ port: 0, keyB64: KEY })).rejects.toThrow(/runTurn/);
  });
});
