// Worker-spine text-to-speech: HMAC auth, voice whitelist (path-traversal guard), the
// piper/ffmpeg failure path, and the client round-trip / error contract. Mirrors
// tests/transcriptor.test.mjs's DI-injection shape — no real python/piper/ffmpeg process
// is spawned and no real port is exposed beyond an ephemeral loopback listener (port: 0).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  startSynthesizerServer, synthesizeViaEndpoint,
} from '../src/tools/synthesizer.mjs';
import { signAudio } from '../src/tools/transcriptor.mjs';

const KEY = 'dGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXktMDA';   // base64url, any 32ish bytes
const OTHER_KEY = 'b3RoZXIta2V5LW90aGVyLWtleS1vdGhlci0wMA';

let voicesDir, server, servers;
beforeEach(() => {
  voicesDir = mkdtempSync(join(tmpdir(), 'egpt-synth-voices-'));
  writeFileSync(join(voicesDir, 'es_MX-claude-high.onnx'), 'fake-model-bytes');
  servers = [];
});
afterEach(() => {
  for (const s of servers) s.close();
  rmSync(voicesDir, { recursive: true, force: true });
});

async function startServer(extra = {}) {
  const calls = [];
  const s = await startSynthesizerServer({
    port: 0, bind: '127.0.0.1', keyB64: KEY,
    pythonPath: 'C:\\fake\\python.exe', voicesDir,
    synthesize: async (text, opts) => { calls.push({ text, ...opts }); return Buffer.from('fake-ogg-bytes'); },
    ...extra,
  });
  servers.push(s);
  return { s, calls, endpoint: `http://127.0.0.1:${s.port}` };
}

describe('synthesizer server', () => {
  it('round-trips text+voice and returns audio bytes', async () => {
    const { calls, endpoint } = await startServer();
    const audio = await synthesizeViaEndpoint('hola mundo', 'es_MX-claude-high', { endpoint, keyB64: KEY });
    expect(Buffer.compare(audio, Buffer.from('fake-ogg-bytes'))).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toBe('hola mundo');
    expect(calls[0].modelPath).toBe(join(voicesDir, 'es_MX-claude-high.onnx'));
  });

  it('rejects missing, wrong-key, and stale signatures', async () => {
    const { endpoint } = await startServer();
    const body = Buffer.from(JSON.stringify({ text: 'hi', voice: 'es_MX-claude-high' }));
    const post = (headers) => fetch(`${endpoint}/v1/synthesize`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });

    expect((await post({})).status).toBe(401);                                   // unsigned

    const ts = Date.now();
    expect((await post({ 'x-egpt-ts': String(ts), 'x-egpt-sig': signAudio(OTHER_KEY, ts, body) })).status).toBe(401);   // wrong key

    const stale = Date.now() - 120_000;
    expect((await post({ 'x-egpt-ts': String(stale), 'x-egpt-sig': signAudio(KEY, stale, body) })).status).toBe(401);   // stale

    // tampered body: signed over different bytes
    expect((await post({ 'x-egpt-ts': String(ts), 'x-egpt-sig': signAudio(KEY, ts, Buffer.from('other')) })).status).toBe(401);
  });

  it('rejects a voice not present in voicesDir → 400, never invokes synthesize', async () => {
    const { calls, endpoint } = await startServer();
    const audio = Buffer.from(JSON.stringify({ text: 'hi', voice: 'not-a-real-voice' }));
    const ts = Date.now();
    const res = await fetch(`${endpoint}/v1/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-egpt-ts': String(ts), 'x-egpt-sig': signAudio(KEY, ts, audio) },
      body: audio,
    });
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('rejects a path-traversal-shaped voice value → 400, never invokes synthesize', async () => {
    const { calls, endpoint } = await startServer();
    const body = Buffer.from(JSON.stringify({ text: 'hi', voice: '../../../../etc/passwd' }));
    const ts = Date.now();
    const res = await fetch(`${endpoint}/v1/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-egpt-ts': String(ts), 'x-egpt-sig': signAudio(KEY, ts, body) },
      body,
    });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('a fake piper/ffmpeg failure → 500 with a JSON error body', async () => {
    const { endpoint } = await startServer({
      synthesize: async () => { throw new Error('piper produced no output file'); },
    });
    const body = Buffer.from(JSON.stringify({ text: 'hi', voice: 'es_MX-claude-high' }));
    const ts = Date.now();
    const res = await fetch(`${endpoint}/v1/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-egpt-ts': String(ts), 'x-egpt-sig': signAudio(KEY, ts, body) },
      body,
    });
    expect(res.status).toBe(500);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.error).toMatch(/piper produced no output file/);
  });
});

describe('synthesizeViaEndpoint (main-spine client side)', () => {
  it('throws with the server error message on a non-audio / failure response', async () => {
    const { endpoint } = await startServer({ synthesize: async () => { throw new Error('boom'); } });
    await expect(synthesizeViaEndpoint('hi', 'es_MX-claude-high', { endpoint, keyB64: KEY })).rejects.toThrow(/500/);
  });

  it('throws on a wrong signing key (server rejects, client sees 401)', async () => {
    const { endpoint } = await startServer();
    await expect(synthesizeViaEndpoint('hi', 'es_MX-claude-high', { endpoint, keyB64: OTHER_KEY })).rejects.toThrow(/401/);
  });

  it('throws on timeout against an unreachable endpoint', async () => {
    await expect(
      synthesizeViaEndpoint('hi', 'es_MX-claude-high', { endpoint: 'http://127.0.0.1:9', keyB64: KEY, timeoutMs: 500 })
    ).rejects.toThrow();
  });
});
