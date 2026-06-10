// whisper-server transcribe-over-HTTP layer. The ffmpeg conversion is
// injected (convert) so these run without ffmpeg/whisper; the resident
// server lifecycle (spawn/readiness/respawn) is proven by the real-binary
// smoke test (tests-manual/transcriptor-smoke.mjs --server).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transcribeViaWhisperServer, makeWhisperServerTranscriber } from '../src/tools/whisper-server.mjs';

let server, url, dir, audio, inferenceCalls;
const NOOP_CONVERT = async (p) => p;   // skip ffmpeg; POST the file as-is

async function startFakeInference(handler) {
  inferenceCalls = [];
  const s = createServer((req, res) => {
    if (req.url === '/inference' && req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => { inferenceCalls.push(Buffer.concat(chunks).length); handler(res); });
      return;
    }
    res.writeHead(200); res.end('whisper.cpp server');   // root readiness page
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { s, url: `http://127.0.0.1:${s.address().port}` };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'egpt-whisper-'));
  audio = join(dir, 'note.ogg');
  writeFileSync(audio, Buffer.from('fake-audio-bytes'));
});
afterEach(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('transcribeViaWhisperServer', () => {
  it('POSTs to /inference and returns the json text', async () => {
    ({ s: server, url } = await startFakeInference((res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: '  hola desde el server  ' }));
    }));
    const t = await transcribeViaWhisperServer(audio, { url, convert: NOOP_CONVERT });
    expect(t).toBe('hola desde el server');   // trimmed
    expect(inferenceCalls).toHaveLength(1);
    expect(inferenceCalls[0]).toBeGreaterThan(0);   // multipart body carried the audio
  });

  it('empty text → null', async () => {
    ({ s: server, url } = await startFakeInference((res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: '   ' }));
    }));
    expect(await transcribeViaWhisperServer(audio, { url, convert: NOOP_CONVERT })).toBeNull();
  });

  it('HTTP error throws (so the worker reports 422 / spine falls back)', async () => {
    ({ s: server, url } = await startFakeInference((res) => {
      res.writeHead(500); res.end('model exploded');
    }));
    await expect(transcribeViaWhisperServer(audio, { url, convert: NOOP_CONVERT })).rejects.toThrow(/500/);
  });
});

describe('makeWhisperServerTranscriber', () => {
  it('adapts to (path, cfg, log) and swallows errors to null', async () => {
    ({ s: server, url } = await startFakeInference((res) => { res.writeHead(503); res.end('loading'); }));
    const transcribe = makeWhisperServerTranscriber({ url, convert: NOOP_CONVERT });
    expect(await transcribe(audio, {}, () => {})).toBeNull();   // error → null, not throw
  });

  it('passes through a successful transcript', async () => {
    ({ s: server, url } = await startFakeInference((res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: 'transcrito' }));
    }));
    const transcribe = makeWhisperServerTranscriber({ url, convert: NOOP_CONVERT });
    expect(await transcribe(audio, {}, () => {})).toBe('transcrito');
  });
});
