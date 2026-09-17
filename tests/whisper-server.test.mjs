// whisper-server transcribe-over-HTTP layer. The ffmpeg conversion is
// injected (convert) so these run without ffmpeg/whisper; the resident
// server lifecycle (spawn/readiness/respawn) is proven by the real-binary
// smoke test (tests-manual/transcriptor-smoke.mjs --server).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  transcribeViaWhisperServer, makeWhisperServerTranscriber, startWhisperServer,
  residentWhisperServer, isStrayWhisperServer, parseWhisperServices,
} from '../src/tools/whisper-server.mjs';

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

  it('reports durationSec via the meta out-param (from the converted WAV)', async () => {
    ({ s: server, url } = await startFakeInference((res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: 'hola' }));
    }));
    // convert yields a 1-second 16kHz mono s16le WAV-sized buffer path stand-in:
    // the function reads the file it gets back, so point it at a sized temp file.
    const wav = join(dir, 'one-sec.wav'); writeFileSync(wav, Buffer.alloc(44 + 32000));
    const meta = {};
    const t = await transcribeViaWhisperServer(audio, { url, convert: async () => wav }, () => {}, meta);
    expect(t).toBe('hola');
    expect(meta.durationSec).toBe(1);
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

// ── ADOPTION (operator 2026-09-02) ───────────────────────────────────────────
// "if installed, spine can monitor whisper. whisper is not sine qua non."
//
// Before this, startWhisperServer ALWAYS reaped the port and spawned. reapPort
// kills whatever holds the port and takes it, so a whisper-server running as a
// Windows service — which restarts on exit — flapped against the spine forever.
// Measured on dolly 2026-09-02: the service came up in Session 0 and the spine
// immediately started its own copy in Session 1.
//
// Now the port is PROBED first: an answer means adopt and monitor, never reap,
// never kill on stop.
describe('startWhisperServer — adoption', () => {
  // A fake proc shaped like child_process.spawn's return, enough for the module.
  function fakeProc() {
    const p = {
      killed: false,
      handlers: {},
      on(ev, cb) { p.handlers[ev] = cb; return p; },
      kill() { p.killed = true; },
      stdout: { on() {} },
      stderr: { on() {} },
    };
    return p;
  }

  it('ADOPTS a server already serving the port — no reap, no spawn', async () => {
    ({ s: server, url } = await startFakeInference((res) => { res.writeHead(200); res.end('{}'); }));
    const port = Number(new URL(url).port);
    const calls = { reap: 0, spawn: 0 };
    const h = await startWhisperServer({
      command: 'whisper-server.exe', model: 'model.bin', host: '127.0.0.1', port,
      readyTimeoutMs: 2000,
      reap: () => { calls.reap++; },
      spawn: () => { calls.spawn++; return fakeProc(); },
    });
    expect(calls.spawn).toBe(0);
    expect(calls.reap).toBe(0);
    expect(h.isAdopted()).toBe(true);
    expect(h.isAlive()).toBe(true);
    expect(h.url).toBe(`http://127.0.0.1:${port}`);
    h.stop();
  });

  // The decisive one: stop() must not kill a server we did not start, or the
  // flap comes straight back on a service-managed box.
  it('stop() does NOT kill an adopted server — it is still serving afterwards', async () => {
    ({ s: server, url } = await startFakeInference((res) => { res.writeHead(200); res.end('{}'); }));
    const port = Number(new URL(url).port);
    const h = await startWhisperServer({
      command: 'whisper-server.exe', model: 'model.bin', host: '127.0.0.1', port,
      readyTimeoutMs: 2000, reap: () => {}, spawn: () => fakeProc(),
    });
    expect(h.isAdopted()).toBe(true);
    h.stop();
    // Still answering: stop() closed nothing it did not open.
    const r = await fetch(`http://127.0.0.1:${port}/`);
    expect(r.status).toBe(200);
  });

  // Back-compat: with NOTHING on the port, the old path is unchanged — reap, then spawn.
  it('with nothing on the port it still reaps and spawns, as before', async () => {
    // A port nobody is on: open one, read its number, close it.
    const probe = createServer(() => {});
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const port = probe.address().port;
    await new Promise((r) => probe.close(r));

    const calls = { reap: 0, spawn: 0 };
    const h = await startWhisperServer({
      command: 'whisper-server.exe', model: 'model.bin', host: '127.0.0.1', port,
      readyTimeoutMs: 300,          // nothing will ever answer; do not wait the real 120s
      reap: () => { calls.reap++; },
      spawn: () => { calls.spawn++; return fakeProc(); },
      serviceFor: async () => null, // no service runs whisper-server here (never the real registry scan)
    });
    expect(calls.reap).toBe(1);
    expect(calls.spawn).toBe(1);
    expect(h.isAdopted()).toBe(false);
    h.stop();
  });

  // The spawn path's reap is GUARDED now: it may clear a stray whisper-server of ours, never a
  // service's, and never a stranger that happens to hold the port.
  it('the pre-spawn reap carries the stray-whisper guard', async () => {
    const probe = createServer(() => {});
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const port = probe.address().port;
    await new Promise((r) => probe.close(r));
    const reaps = [];
    const h = await startWhisperServer({
      command: 'whisper-server.exe', model: 'model.bin', host: '127.0.0.1', port,
      readyTimeoutMs: 100,
      reap: (p, log, opts) => { reaps.push(opts); },
      spawn: () => fakeProc(),
      serviceFor: async () => null,
    });
    h.stop();
    expect(reaps).toHaveLength(1);
    expect(reaps[0].mine).toBe(isStrayWhisperServer);
  });

  // ── A SERVICE OWNS IT (dolly, 2026-09-16) ─────────────────────────────────────────────────
  // dolly runs whisper-server as the WhisperServer service (nssm, Auto, LocalSystem), outside
  // the eGPT profile, on purpose. When the spine arrives while that server is between lives —
  // nssm restarts it 5s after an exit, and large-v3 takes seconds more to load before it
  // listens — the probe finds nothing, and the old code reaped and SPAWNED a second 2.9 GB
  // model, which then fought the service for the port. A service that runs whisper-server on
  // this port means: wait for it, adopt it, never spawn, never reap.
  it('nothing answers yet but a SERVICE runs whisper-server on the port → no reap, no spawn; adopted once it answers', async () => {
    const probe = createServer(() => {});
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const port = probe.address().port;
    await new Promise((r) => probe.close(r));

    const calls = { reap: 0, spawn: 0 }; const logs = [];
    const started = startWhisperServer({
      command: 'whisper-server.exe', model: 'model.bin', host: '127.0.0.1', port,
      readyTimeoutMs: 3000, adoptedProbeMs: 60,
      reap: () => { calls.reap++; },
      spawn: () => { calls.spawn++; return fakeProc(); },
      serviceFor: async (p) => (p === port ? { name: 'WhisperServer', commandLine: `whisper-server.exe --port ${port}` } : null),
      onLog: (m) => logs.push(m),
    });
    // the service's server finishes loading and starts listening on the port
    await new Promise((r) => setTimeout(r, 150));
    server = createServer((req, res) => { res.writeHead(200); res.end('whisper.cpp server'); });
    await new Promise((r) => server.listen(port, '127.0.0.1', r));
    const h = await started;
    expect(calls.spawn).toBe(0);
    expect(calls.reap).toBe(0);
    expect(h.isAdopted()).toBe(true);
    expect(h.isAlive()).toBe(true);
    expect(logs.join('\n')).toContain('WhisperServer');
    h.stop();
  });

  it('adoptOnly: watches the port without a command or model, never spawns, never reaps', async () => {
    ({ s: server, url } = await startFakeInference((res) => { res.writeHead(200); res.end('{}'); }));
    const port = Number(new URL(url).port);
    const calls = { reap: 0, spawn: 0 };
    const h = await startWhisperServer({
      adoptOnly: true, host: '127.0.0.1', port, readyTimeoutMs: 1000,
      reap: () => { calls.reap++; }, spawn: () => { calls.spawn++; return fakeProc(); },
      serviceFor: async () => { throw new Error('a serving port needs no service scan'); },
    });
    expect(h.isAdopted()).toBe(true);
    expect(h.isAlive()).toBe(true);
    expect(calls).toEqual({ reap: 0, spawn: 0 });
    h.stop();
  });

  // "not sine qua non": an adopted server that goes away must report itself dead
  // so the transcription chain falls through to the cli floor, rather than the
  // spine trying to seize the port back from whoever owns it.
  it('an adopted server that goes away flips isAlive to false', async () => {
    ({ s: server, url } = await startFakeInference((res) => { res.writeHead(200); res.end('{}'); }));
    const port = Number(new URL(url).port);
    const h = await startWhisperServer({
      command: 'whisper-server.exe', model: 'model.bin', host: '127.0.0.1', port,
      readyTimeoutMs: 2000, adoptedProbeMs: 60,   // probe fast so the test does not crawl
      reap: () => {}, spawn: () => fakeProc(),
    });
    expect(h.isAlive()).toBe(true);
    await new Promise((r) => server.close(r));
    server = null;
    // Give the monitor a few cycles to notice.
    const deadline = Date.now() + 3000;
    while (h.isAlive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(h.isAlive()).toBe(false);
    h.stop();
  });
});

// ── THE RESIDENT REGISTRY: what the CLI rung asks before it loads a second model ───────────
describe('residentWhisperServer', () => {
  it('names a serving server started or adopted in this process, and forgets it on stop()', async () => {
    ({ s: server, url } = await startFakeInference((res) => { res.writeHead(200); res.end('{}'); }));
    const port = Number(new URL(url).port);
    expect(residentWhisperServer()).toBeNull();
    const h = await startWhisperServer({ adoptOnly: true, host: '127.0.0.1', port, readyTimeoutMs: 1000 });
    expect(residentWhisperServer()).toMatchObject({ url: `http://127.0.0.1:${port}`, adopted: true });
    h.stop();
    expect(residentWhisperServer()).toBeNull();
  });

  it('a registered server that is not answering is not "serving"', async () => {
    const probe = createServer(() => {});
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const port = probe.address().port;
    await new Promise((r) => probe.close(r));
    const h = await startWhisperServer({ adoptOnly: true, host: '127.0.0.1', port, readyTimeoutMs: 100, serviceFor: async () => null });
    expect(h.isAlive()).toBe(false);
    expect(residentWhisperServer()).toBeNull();
    h.stop();
  });
});

describe('isStrayWhisperServer — the whisper reap\'s guard', () => {
  it('only a whisper-server image that NO service owns (service === false) is a stray', () => {
    expect(isStrayWhisperServer({ name: 'whisper-server.exe', service: false })).toBe(true);
    expect(isStrayWhisperServer({ name: 'whisper-server', service: false })).toBe(true);
    // dolly's WhisperServer service process
    expect(isStrayWhisperServer({ name: 'whisper-server.exe', service: 'WhisperServer' })).toBe(false);
    // ownership could not be read → not vouched for → never killed
    expect(isStrayWhisperServer({ name: 'whisper-server.exe', service: null })).toBe(false);
    expect(isStrayWhisperServer({ name: 'whisper-server.exe' })).toBe(false);
    // a stranger on the whisper port is not ours to kill either
    expect(isStrayWhisperServer({ name: 'Beeper.exe', service: false })).toBe(false);
    expect(isStrayWhisperServer({ name: null, service: false })).toBe(false);
  });
});

describe('parseWhisperServices — which service runs whisper-server on a port', () => {
  // The shape the Windows registry scan prints: <service name> TAB <image path + nssm Application + AppParameters>
  const DOLLY = 'WhisperServer\tC:\\Users\\an\\AppData\\Local\\Microsoft\\WinGet\\Links\\nssm.exe C:\\Users\\an\\bin\\whisper.cpp\\Release\\whisper-server.exe -m C:\\Users\\an\\bin\\whisper.cpp\\models\\ggml-large-v3.bin --host 127.0.0.1 --port 8089 -l auto -mc 0 -sns\r\n';
  it('matches the service whose whisper-server listens on the port (measured dolly line)', () => {
    expect(parseWhisperServices(DOLLY, 8089)).toMatchObject({ name: 'WhisperServer' });
    expect(parseWhisperServices(DOLLY, 8090)).toBeNull();
  });
  it('no --port means whisper.cpp\'s own default, 8080', () => {
    const line = 'WS2\tC:\\w\\whisper-server.exe -m model.bin\n';
    expect(parseWhisperServices(line, 8080)).toMatchObject({ name: 'WS2' });
    expect(parseWhisperServices(line, 8089)).toBeNull();
  });
  it('empty / garbage output is no service', () => {
    expect(parseWhisperServices('', 8089)).toBeNull();
    expect(parseWhisperServices(null, 8089)).toBeNull();
    expect(parseWhisperServices('no tab here --port 8089', 8089)).toBeNull();
  });
});
