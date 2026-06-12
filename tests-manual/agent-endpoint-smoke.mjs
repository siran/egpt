// agent-endpoint-smoke.mjs — live end-to-end proof of @d on DOLLY: start the
// REAL agent server with the REAL claude-sdk resume runner, POST a turn over
// HMAC, get a reply. Resumes an OLD/INACTIVE session id (argv[2]) — NEVER a
// live one (single-active collision). Read-only tools.
//   node tests-manual/agent-endpoint-smoke.mjs <old-session-id> ["prompt"]
import { startAgentServer, makeClaudeResumeRunner, postAgentTurn } from '../src/tools/agent-endpoint.mjs';

const sessionId = process.argv[2];
const prompt = process.argv[3] || 'Reply with exactly one word: ready';
if (!sessionId) { console.log('usage: node tests-manual/agent-endpoint-smoke.mjs <old-session-id> ["prompt"]'); process.exit(1); }

const KEY = 'c21va2Uta2V5LXNtb2tlLWtleS1zbW9rZS1rZXktMA';   // throwaway, not the real agent_token

const runTurn = makeClaudeResumeRunner({ sessionId, onLog: (m) => console.log('[runner]', m) });
const s = await startAgentServer({ port: 0, bind: '127.0.0.1', keyB64: KEY, runTurn, onLog: (m) => console.log('[server]', m) });
const endpoint = `http://127.0.0.1:${s.port}`;
const t0 = Date.now();
try {
  const reply = await postAgentTurn(prompt, { endpoint, keyB64: KEY, timeoutMs: 120_000 }, (m) => console.log('[client]', m));
  console.log('\nREPLY:', JSON.stringify(reply));
} catch (e) {
  console.log('\nSMOKE RESULT:', e.message);
} finally {
  console.log('round-trip ms:', Date.now() - t0);
  s.close();
  process.exit(0);
}
