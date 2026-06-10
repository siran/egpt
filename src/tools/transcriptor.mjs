// transcriptor.mjs — worker-spine transcription over LAN (operator 2026-06-10).
//
// Topology: ONE main spine (owns all conversation context + every outbound
// send); other machines run the SAME egpt service in a worker role. The
// first worker role is `transcriptor`: a GPU-equipped box that accepts raw
// audio bytes over HTTP and returns whisper text. The main spine uses it
// when config `transcription_endpoint` is non-null, and falls back to its
// LOCAL whisper on any failure or timeout — a dead/asleep worker degrades
// speed, never function.
//
// KISS decisions (operator-confirmed):
//   - Audio BYTES are POSTed, not a Beeper message reference. A voice note
//     is <1MB; shipping it makes the worker stateless and source-agnostic
//     (works for any future bridge, no Beeper sync-timing races, no second
//     account question). The worker holds NO conversation context.
//   - Auth reuses ~/.egpt/bus.key (copy the file from the main spine to
//     the worker once). HMAC-SHA256 over `${ts}.${sha256(body)}` — the key
//     never travels; replays die at the 60s freshness window.
//   - Discovery is static config, not announce: the operator sets
//     `transcription_endpoint: "http://<worker-ip>:23390"` on the main
//     spine and `transcriptor: { enabled: true, bind: "<lan-ip>" }` on the
//     worker. Default bind is 127.0.0.1 — exposing to the LAN is an
//     explicit operator action; never the internet.
//
// Protocol:
//   GET  /v1/health                → 200 { ok, role: 'transcriptor' }   (no auth)
//   POST /v1/transcribe  <bytes>   → 200 { ok, transcript, ms }
//        headers: x-egpt-ts (epoch ms), x-egpt-sig (base64url HMAC)
//        401 bad/missing/stale signature · 413 too big · 422 transcription
//        produced nothing (caller falls back to local whisper)

import { createServer } from 'node:http';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keyFromString } from './bus-sign.mjs';
import { transcribeAudioFile } from './transcribe.mjs';

export const TRANSCRIPTOR_DEFAULT_PORT = 23390;
const MAX_BODY_BYTES = 32 * 1024 * 1024;   // voice notes are <1MB; 32MB is a generous ceiling
const SIG_MAX_AGE_MS = 60_000;
const CLIENT_TIMEOUT_MS = 45_000;          // GPU whisper is seconds; 45s covers a long note

// ── signing (shared by client + server; exported for tests) ──────────
export function signAudio(keyB64, tsMs, bodyBytes) {
  const bodyHash = createHash('sha256').update(bodyBytes).digest('hex');
  return createHmac('sha256', Buffer.from(keyFromString(keyB64)))
    .update(`${tsMs}.${bodyHash}`)
    .digest('base64url');
}

function _sigOk(keyB64, tsMs, bodyBytes, sig) {
  if (!sig || !tsMs) return false;
  if (Math.abs(Date.now() - Number(tsMs)) > SIG_MAX_AGE_MS) return false;
  const expect = Buffer.from(signAudio(keyB64, tsMs, bodyBytes));
  const got = Buffer.from(String(sig));
  return expect.length === got.length && timingSafeEqual(expect, got);
}

// ── worker side ───────────────────────────────────────────────────────
// Starts the transcriptor HTTP server. `audioCfg` is the worker's OWN
// whatsapp.media.audio_transcribe block (its whisper binary/model — on the
// GPU box this is what makes it fast). Returns { port, close }.
export async function startTranscriptorServer({
  port = TRANSCRIPTOR_DEFAULT_PORT,
  bind = '127.0.0.1',
  keyB64,
  audioCfg = {},
  transcribe = transcribeAudioFile,
  onLog = () => {},
} = {}) {
  if (!keyB64) throw new Error('startTranscriptorServer: keyB64 (bus.key) is required');

  const server = createServer((req, res) => {
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

    if (req.method === 'GET' && req.url === '/v1/health') {
      return json(200, { ok: true, role: 'transcriptor' });
    }
    if (req.method !== 'POST' || req.url !== '/v1/transcribe') {
      return json(404, { ok: false, error: 'not found' });
    }

    const chunks = [];
    let size = 0, overflow = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { overflow = true; req.destroy(); return; }
      chunks.push(c);
    });
    req.on('error', () => { /* destroyed on overflow / client drop — response below or never */ });
    req.on('end', async () => {
      if (overflow) return json(413, { ok: false, error: 'body too large' });
      const body = Buffer.concat(chunks);
      const ts = req.headers['x-egpt-ts'];
      const sig = req.headers['x-egpt-sig'];
      if (!_sigOk(keyB64, ts, body, sig)) {
        onLog(`transcriptor: REJECTED unsigned/stale request from ${req.socket.remoteAddress} (${body.length}b)`);
        return json(401, { ok: false, error: 'bad signature' });
      }
      // Extension is irrelevant — ffmpeg sniffs the container from content.
      const tmp = join(tmpdir(), `egpt-transcriptor-${randomBytes(8).toString('hex')}.audio`);
      const t0 = Date.now();
      try {
        await writeFile(tmp, body);
        const transcript = await transcribe(tmp, audioCfg, onLog);
        const ms = Date.now() - t0;
        if (!transcript) {
          onLog(`transcriptor: transcription EMPTY (${body.length}b, ${ms}ms) — caller will fall back`);
          return json(422, { ok: false, error: 'transcription produced nothing', ms });
        }
        onLog(`transcriptor: ${body.length}b → ${transcript.length}ch in ${ms}ms for ${req.socket.remoteAddress}`);
        return json(200, { ok: true, transcript, ms });
      } catch (e) {
        onLog(`transcriptor: ERROR — ${e?.message ?? e}`);
        return json(500, { ok: false, error: String(e?.message ?? e) });
      } finally {
        try { await unlink(tmp); } catch { /* tmp cleanup is best-effort */ }
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bind, resolve);
  });
  const actualPort = server.address().port;
  onLog(`transcriptor: listening on ${bind}:${actualPort}`);
  return {
    port: actualPort,
    close: () => { try { server.closeAllConnections?.(); } catch { /* node <18.2 */ } server.close(); },
  };
}

// ── main-spine side ───────────────────────────────────────────────────
// POST one audio file to a worker. Returns the transcript string.
// Throws on transport/auth/server errors and on empty transcription —
// every throw is the wrapper's signal to fall back to local whisper.
export async function transcribeViaEndpoint(audioPath, { endpoint, keyB64, timeoutMs = CLIENT_TIMEOUT_MS }, log = () => {}) {
  const body = await readFile(audioPath);
  const ts = Date.now();
  const res = await fetch(`${endpoint.replace(/\/+$/, '')}/v1/transcribe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'x-egpt-ts': String(ts),
      'x-egpt-sig': signAudio(keyB64, ts, body),
    },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok || !j.transcript) {
    throw new Error(`worker ${res.status}: ${j.error ?? 'no transcript'}`);
  }
  log(`transcribe: remote worker → ${j.transcript.length}ch in ${j.ms ?? '?'}ms`);
  return j.transcript;
}

// Drop-in replacement for transcribeAudioFile with remote-first behavior:
// worker when `endpoint` is set and healthy, LOCAL whisper on any failure.
// `getKey` is lazy (async) so callers don't need the bus key at wire-up
// time. Same (path, cfg, log) signature the bridges already use.
export function makeRemoteFirstTranscriber({ endpoint, getKey, timeoutMs = CLIENT_TIMEOUT_MS, local = transcribeAudioFile } = {}) {
  return async function transcribe(audioPath, cfg = {}, log = () => {}) {
    if (endpoint) {
      try {
        const keyB64 = await getKey();
        return await transcribeViaEndpoint(audioPath, { endpoint, keyB64, timeoutMs }, log);
      } catch (e) {
        log(`transcribe: remote worker failed (${e?.message ?? e}) — falling back to local whisper`);
      }
    }
    return local(audioPath, cfg, log);
  };
}
