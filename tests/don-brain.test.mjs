// @d (Don) brain: the REVE->DOLLY half of the egpt<->egpt channel. Drives the
// real `don` brain against the real agent endpoint (injected runner), so this
// locks the contract: @d ships the new turn over HTTP (HMAC-authed) and returns
// Don's reply text — ready for egpt's gated/logged sibling path.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startAgentServer } from '../src/tools/agent-endpoint.mjs';
import * as don from '../config/brains/don.mjs';

const KEY = 'YWdlbnQtdGVzdC1rZXktYWdlbnQtdGVzdC1rZXktMDA';

let servers;
beforeEach(() => { servers = []; });
afterEach(() => { for (const s of servers) s.close(); });

async function start(runTurn, extra = {}) {
  const s = await startAgentServer({ port: 0, bind: '127.0.0.1', keyB64: KEY, runTurn, ...extra });
  servers.push(s);
  return { s, endpoint: `http://127.0.0.1:${s.port}` };
}

describe('don brain (@d)', () => {
  it('is sessionless and ships only the new turn (Don keeps its own session)', async () => {
    expect(don.sessionless).toBe(true);
    const seen = [];
    const { endpoint } = await start(async (msg) => { seen.push(msg); return { text: `don: ${msg}` }; });
    const updates = [];
    const r = await don.stream(
      { history: 'WHOLE CHAT TRANSCRIPT SHOULD BE IGNORED', message: 'what is the repo status?' },
      (t) => updates.push(t),
      { url: endpoint, agentToken: KEY, from: 'reve' },
    );
    expect(r.text).toBe('don: what is the repo status?');   // got Don's reply
    expect(seen).toEqual(['what is the repo status?']);      // sent the TURN, not the history
    expect(updates).toEqual(['don: what is the repo status?']); // surfaced once for the dispatch path
  });

  it('throws a clear error when the url or token is missing', async () => {
    await expect(don.stream({ message: 'hi' }, () => {}, { agentToken: KEY })).rejects.toThrow(/no endpoint url/);
    await expect(don.stream({ message: 'hi' }, () => {}, { url: 'http://127.0.0.1:1' })).rejects.toThrow(/no agent_token/);
  });

  it('surfaces a transport/auth failure (wrong token -> rejected)', async () => {
    const { endpoint } = await start(async () => ({ text: 'should not run' }));
    await expect(don.stream({ message: 'hi' }, () => {}, { url: endpoint, agentToken: 'd3Jvbmcta2V5LXdyb25nLWtleS13cm9uZy1rZXktMDA' }))
      .rejects.toThrow(/agent 401|bad signature/);
  });
});
