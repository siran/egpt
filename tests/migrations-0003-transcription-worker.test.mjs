// tests/migrations-0003-transcription-worker.test.mjs — migrations/0003-transcription-worker-shape.mjs.
//
// The fixtures are miniatures of each node's REAL transcription_service block as read on
// 2026-09-16 (tokens replaced):
//   kg: CRLF, flow list `[ remote, cli ]` with an end-of-line comment, a `remote:` block, enabled
//       false by operator decision - the migration renames the key and the list element, and
//       nothing else, byte for byte.
//   do: LF, block list, `worker:` already (hand-applied 2026-09-15), and a hand-applied
//       ggml-base.bin model - 0003 must call that "already satisfied": its idempotency is about
//       the key name ONLY, and model_path is not its business on either node.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan } from '../migrations/0003-transcription-worker-shape.mjs';
import { runMigrations } from '../setup/migrate.mjs';

const KG = [
  '# --- Services ----------------------------------------------------------------',
  'transcription_service:',
  '  enabled: false',
  '  use_config: reve',
  '  posts_back_delay_ms: -1',
  '  echo:',
  '    method: hrw # rendezvous hash on the audio sha256, so the winner is node-stable',
  '    participants: group-members',
  '    peer_priority: [ do, kg ]',
  '    timeout_ms: 20000 # silent-winner ordered failover',
  '  reve:',
  "    fallback_order: [ remote, cli ] # dolly's worker first, local whisper-cli second",
  '    remote:',
  '      type: whisper-server-remote',
  '      endpoint: http://192.168.1.102:23390',
  '      token: FIXTURE-TOKEN',
  '      connect_timeout_ms: 3000',
  '      timeout_ms: 120000',
  '      cooldown_ms: 30000',
  '    cli:',
  '      type: whisper-cli',
  '      command: C:\\Users\\an\\bin\\whisper.cpp\\whisper-cli.exe',
  '      model_path: C:\\Users\\an\\bin\\whisper.cpp\\models\\ggml-large-v3.bin',
  "      language: auto # NOT absent: whisper.cpp defaults to 'en', and a pinned language makes it mis-hear the other one fluently",
  '      threads: 12',
  '',
  'radio_service:',
  '  wildnloyal:',
  '    enabled: true',
  '',
].join('\r\n');

const DO = `transcription_service:
  enabled: true
  use_config: do
  echo:
    method: hrw
    peer_priority:
      - do
      - kg
  do:
    fallback_order:
      - worker
      - cli
    worker:
      type: whisper-server-remote
      endpoint: http://127.0.0.1:23390
      token: FIXTURE-TOKEN
    cli:
      type: whisper-cli
      # base (142MB), NOT large-v3 (2.9GB): hand-applied operator 2026-09-15.
      model_path: C:\\Users\\an\\bin\\whisper.cpp\\models\\ggml-base.bin
      language: auto   # auto-detect (operator 2026-09-02).
`;

function home(config) {
  const h = mkdtempSync(join(tmpdir(), 'egpt-0003-'));
  mkdirSync(join(h, 'config'));
  if (config !== undefined) writeFileSync(join(h, 'config', 'config.yaml'), config);
  return h;
}
const cfgPath = (h) => join(h, 'config', 'config.yaml');
const ctxFor = (h) => ({ egptHome: h, log: () => {}, backup: (f) => { const to = `${f}.bak-0003-test`; writeFileSync(to, readFileSync(f)); return to; } });

describe('0003 on kg - the remote shape', () => {
  it('plans exactly two line changes: the list element and the key', async () => {
    const h = home(KG);
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);
    expect(p.changes).toEqual([
      `${cfgPath(h)}:12`,
      "  -     fallback_order: [ remote, cli ] # dolly's worker first, local whisper-cli second",
      "  +     fallback_order: [ worker, cli ] # dolly's worker first, local whisper-cli second",
      `${cfgPath(h)}:13`,
      '  -     remote:',
      '  +     worker:',
      'backup first, beside it: config.yaml.bak-0003-<timestamp>',
    ]);
  });

  it('apply: byte-identical except those two lines - CRLF, comments, enabled and model_path all kept', async () => {
    const h = home(KG);
    const ctx = ctxFor(h);
    await (await plan(ctx)).apply();
    const after = readFileSync(cfgPath(h), 'utf8');
    expect(after).toBe(KG.replace('[ remote, cli ]', '[ worker, cli ]').replace('    remote:\r\n', '    worker:\r\n'));
    expect(after).toContain('  enabled: false\r\n');
    expect(after).toContain('ggml-large-v3.bin');
    expect(readFileSync(`${cfgPath(h)}.bak-0003-test`, 'utf8')).toBe(KG);
    expect((await plan(ctx)).satisfied).toBe(true);
  });

  it('never touches model_path, whatever it names', async () => {
    const h = home(KG.replace('ggml-large-v3.bin', 'ggml-medium.bin'));
    const ctx = ctxFor(h);
    await (await plan(ctx)).apply();
    expect(readFileSync(cfgPath(h), 'utf8')).toContain('ggml-medium.bin');
  });

  it('refuses to write over a config edited between plan and apply', async () => {
    const h = home(KG);
    const p = await plan(ctxFor(h));
    writeFileSync(cfgPath(h), KG.replace('threads: 12', 'threads: 8'));
    await expect(p.apply()).rejects.toThrow(/changed since it was planned/);
    expect(readFileSync(cfgPath(h), 'utf8')).toContain('threads: 8');
    expect(readdirSync(join(h, 'config'))).toEqual(['config.yaml']);
  });
});

describe('0003 on do - already there', () => {
  it('reports already satisfied, and leaves the file and its hand-applied model alone', async () => {
    const h = home(DO);
    const p = await plan(ctxFor(h));
    expect(p).toEqual({ satisfied: true, notes: ['transcription_service.do: the worker entry is `worker` (fallback_order [worker, cli])'] });
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(DO);
  });

  it('through the runner, on a Windows node already migrated by hand: recorded, file untouched, no backup', async () => {
    const h = home(DO);
    const dir = join(import.meta.dirname, '..', 'migrations');
    // Stub the Windows probes of 0001/0002 to "nothing there", so this exercises 0003 only.
    const ctx = { ps: () => JSON.stringify({ map: [], services: [], from: { exists: false }, to: { exists: false } }) };
    const { exitCode } = await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
    expect(exitCode).toBe(0);
    const ledger = JSON.parse(readFileSync(join(h, 'state', 'migrations-applied.json'), 'utf8'));
    expect(ledger['0003-transcription-worker-shape'].outcome).toBe('already-satisfied');
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(DO);
    expect(readdirSync(join(h, 'config'))).toEqual(['config.yaml']);
  });

  it('through the runner, DRY RUN on kg: prints the two lines and writes nothing at all', async () => {
    const h = home(KG);
    const lines = [];
    const ctx = { ps: () => JSON.stringify({ map: [], services: [], from: { exists: false }, to: { exists: false } }) };
    const { exitCode } = await runMigrations({ dir: join(import.meta.dirname, '..', 'migrations'), egptHome: h, dryRun: true, elevated: false, platform: 'win32', ctx, log: (l) => lines.push(l) });
    expect(exitCode).toBe(0);
    expect(lines.join('\n')).toContain('+     worker:');
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(KG);
    expect(readdirSync(h)).toEqual(['config']);
  });
});

describe('0003 refuses what it does not know, by name', () => {
  const refusal = async (config) => {
    const h = home(config);
    let err;
    try { await plan(ctxFor(h)); } catch (e) { err = e; }
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(config);
    return err?.message ?? 'NOT REFUSED';
  };

  it('a remote block that is not the resident worker type', async () => {
    expect(await refusal(KG.replace('type: whisper-server-remote', 'type: whisper-server-local')))
      .toBe('0003 refuses: transcription_service.reve.remote.type is "whisper-server-local", not whisper-server-remote');
  });

  it('both a remote and a worker block', async () => {
    expect(await refusal(KG.replace('    cli:\r\n', '    worker:\r\n      type: whisper-server-remote\r\n    cli:\r\n')))
      .toMatch(/transcription_service\.reve has BOTH a remote and a worker block/);
  });

  it('a fallback_order that does not name the entry', async () => {
    expect(await refusal(KG.replace('[ remote, cli ]', '[ cli ]'))).toMatch(/fallback_order must name remote exactly once, it is \[cli\]/);
  });

  it('use_config naming no profile', async () => {
    expect(await refusal(KG.replace('use_config: reve', 'use_config: gone'))).toMatch(/use_config \("gone"\) names no profile block/);
  });

  it('a config that does not parse, or is not there', async () => {
    expect(await refusal('transcription_service: [\n')).toMatch(/does not parse/);
    const h = home(undefined);
    await expect(plan(ctxFor(h))).rejects.toThrow(/0003 refuses: there is no .*config\.yaml/);
  });

  it('no transcription_service at all is not a refusal - nothing of this shape exists', async () => {
    const h = home('node_name: zz\n');
    expect((await plan(ctxFor(h))).satisfied).toBe(true);
  });

  // A REFUSAL STOPS THE CHAIN ON EVERY DEPLOY. So a profile that is a valid NODE-SHAPE and simply has
  // nothing for this migration to rename must read satisfied, or that node's migrations stall forever.
  it('a profile with no remote entry (e.g. CLI-only) is not a refusal - nothing to rename', async () => {
    const config = DO.replace(/worker/g, 'gpu');
    const h = home(config);
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes[0]).toMatch(/transcription_service\.do has no `remote` entry - nothing to rename/);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(config);
  });

  it('a worker entry that is a LOCAL whisper-server is already satisfied - the key is all 0003 moves', async () => {
    const config = DO.replace('type: whisper-server-remote', 'type: whisper-server-local');
    const h = home(config);
    expect((await plan(ctxFor(h))).satisfied).toBe(true);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(config);
  });
});
