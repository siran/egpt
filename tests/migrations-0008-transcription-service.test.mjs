// tests/migrations-0008-transcription-service.test.mjs — migrations/0008-transcription-service-is-on.mjs.
//
// Fixtures are miniatures of each node's REAL config on 2026-09-16 (tokens replaced), with comment
// lines in front so the block sits on the same lines it does live:
//   kg: CRLF, `transcription_service:` on line 190, `enabled: false` on 191, use_config reve, a -1
//       posts_back_delay_ms, the echo block, and the reve profile routing [ worker, cli ] to dolly.
//   do: LF, `enabled: true` on line 130.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan } from '../migrations/0008-transcription-service-is-on.mjs';
import { runMigrations } from '../setup/migrate.mjs';

const filler = (n, node) => Array.from({ length: n }, (_, i) => `# ${node} config line ${i + 1}`);

const KG = [
  ...filler(189, 'kg'),
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
  "    fallback_order: [ worker, cli ] # dolly's worker first, local whisper-cli second",
  '    worker:',
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
  '      language: auto',
  '',
].join('\r\n');

// do routes its worker rung to itself, so it carries its transcriptor block on (0007 reads it satisfied).
const DO = [
  ...filler(120, 'do'),
  'transcriptor:',
  '  enabled: true',
  '  port: 23390',
  '  server:',
  '    enabled: true',
  'transcription:',
  '  cli:',
  '    model_path: C:\\Users\\an\\bin\\whisper.cpp\\models\\ggml-large-v3.bin',
  'transcription_service:',
  '  enabled: true',
  '  use_config: do',
  '  do:',
  '    fallback_order:',
  '      - worker',
  '      - cli',
  '    worker:',
  '      type: whisper-server-remote',
  '      endpoint: http://127.0.0.1:23390',
  '      token: FIXTURE-TOKEN',
  '    cli:',
  '      type: whisper-cli',
  '',
].join('\n');

function home(config) {
  const h = mkdtempSync(join(tmpdir(), 'egpt-0008-'));
  mkdirSync(join(h, 'config'));
  if (config !== undefined) writeFileSync(join(h, 'config', 'config.yaml'), config);
  return h;
}
const cfgPath = (h) => join(h, 'config', 'config.yaml');
const ctxFor = (h) => ({ egptHome: h, log: () => {}, backup: (f) => { const to = `${f}.bak-0008-test`; writeFileSync(to, readFileSync(f)); return to; } });

describe('0008 on kg - enabled: false with a chain', () => {
  it('plans exactly one line, line 191, and says it takes effect at the next start', async () => {
    const h = home(KG);
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);
    expect(p.changes).toEqual([
      'because transcription_service.reve has the chain [worker, cli], on this node:',
      `${cfgPath(h)}:191`,
      '  -   enabled: false',
      '  +   enabled: true',
      'takes effect at the next spine start (config.yaml is read once, at boot)',
      'backup first, beside it: config.yaml.bak-0008-<timestamp>',
    ]);
  });

  it('apply: byte-identical except that line - CRLF, comments, echo and posts_back_delay_ms kept', async () => {
    const h = home(KG);
    const ctx = ctxFor(h);
    await (await plan(ctx)).apply();
    const after = readFileSync(cfgPath(h), 'utf8');
    expect(after).toBe(KG.replace('transcription_service:\r\n  enabled: false\r\n', 'transcription_service:\r\n  enabled: true\r\n'));
    expect(after).toContain('  posts_back_delay_ms: -1\r\n');
    expect(readFileSync(`${cfgPath(h)}.bak-0008-test`, 'utf8')).toBe(KG);
    expect((await plan(ctx)).satisfied).toBe(true);
  });

  it('per-chat opt-outs in conversations.yaml are deliberate: never read, never touched', async () => {
    const h = home(KG);
    const conv = 'whatsapp:\r\n  "!quiet:beeper.local":\r\n    slug: quiet-2609160000\r\n    transcription_service:\r\n      enabled: false\r\n';
    writeFileSync(join(h, 'config', 'conversations.yaml'), conv);
    await (await plan(ctxFor(h))).apply();
    expect(readFileSync(join(h, 'config', 'conversations.yaml'), 'utf8')).toBe(conv);
    expect(readdirSync(join(h, 'config')).sort()).toEqual(['config.yaml', 'config.yaml.bak-0008-test', 'conversations.yaml']);
  });

  it('refuses to write over a config edited between plan and apply', async () => {
    const h = home(KG);
    const p = await plan(ctxFor(h));
    writeFileSync(cfgPath(h), KG.replace('timeout_ms: 20000', 'timeout_ms: 25000'));
    await expect(p.apply()).rejects.toThrow(/changed since it was planned/);
    expect(readFileSync(cfgPath(h), 'utf8')).toContain('timeout_ms: 25000');
    expect(readFileSync(cfgPath(h), 'utf8')).toContain('  enabled: false\r\n');
  });
});

describe('0008 is satisfied where there is nothing to switch on', () => {
  it('do: already enabled - untouched', async () => {
    const h = home(DO);
    expect(await plan(ctxFor(h))).toEqual({ satisfied: true, notes: ['transcription_service.enabled is already true'] });
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(DO);
  });

  it('a node with no transcription_service block at all', async () => {
    const h = home('node_name: zz\n');
    expect(await plan(ctxFor(h))).toEqual({ satisfied: true, notes: ['this node has no transcription_service block - nothing to switch on'] });
  });

  // Satisfied is checked first: an enabled node is not refused over its profile's shape.
  it('already true, even with no chain to name', async () => {
    const h = home(DO.replace('use_config: do', 'use_config: gone'));
    expect((await plan(ctxFor(h))).satisfied).toBe(true);
  });
});

describe('0008 refuses rather than guess, by name', () => {
  const refusal = async (config) => {
    const h = home(config);
    let err;
    try { await plan(ctxFor(h)); } catch (e) { err = e; }
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(config);
    return err?.message ?? 'NOT REFUSED';
  };

  it('use_config naming no profile', async () => {
    expect(await refusal(KG.replace('use_config: reve', 'use_config: gone'))).toBe('0008 refuses: transcription_service.use_config ("gone") names no profile block');
  });

  it('an active profile with no fallback_order, or an empty one', async () => {
    expect(await refusal(KG.replace("    fallback_order: [ worker, cli ] # dolly's worker first, local whisper-cli second\r\n", '')))
      .toBe('0008 refuses: transcription_service.reve has no fallback_order - no chain to switch on');
    expect(await refusal(KG.replace('[ worker, cli ]', '[]'))).toMatch(/transcription_service\.reve has no fallback_order/);
  });

  it('an enabled that is not a boolean', async () => {
    expect(await refusal(KG.replace('  enabled: false', '  enabled: maybe'))).toBe('0008 refuses: transcription_service.enabled is "maybe", not true or false');
  });

  it('no enabled key is not a refusal - the runtime reads it as on, so there is nothing to switch', async () => {
    const h = home(KG.replace('  enabled: false\r\n', ''));
    expect(await plan(ctxFor(h))).toEqual({ satisfied: true, notes: ['transcription_service has no enabled: key, which the runtime reads as on'] });
  });

  it('a config that is not there', async () => {
    const h = home(undefined);
    await expect(plan(ctxFor(h))).rejects.toThrow(/0008 refuses: there is no .*config\.yaml/);
  });
});

describe('0008 through the runner', () => {
  // The Windows probes of 0001/0002/0004/0005 are told "nothing there", and localAddresses is empty so
  // 0007 reads kg's worker rung as dolly's, whichever machine runs the test (as tests/migrations-0003-*).
  const ctx = { ps: () => JSON.stringify({ map: [], services: [], from: { exists: false }, to: { exists: false } }), localAddresses: new Set() };
  const dir = join(import.meta.dirname, '..', 'migrations');

  it('kg: 0008 applies, is recorded, and changes only the enabled line', async () => {
    const h = home(KG);
    const { exitCode } = await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
    expect(exitCode).toBe(0);
    const ledger = JSON.parse(readFileSync(join(h, 'state', 'migrations-applied.json'), 'utf8'));
    expect(ledger['0008-transcription-service-is-on'].outcome).toBe('applied');
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(KG.replace('  enabled: false\r\n', '  enabled: true\r\n'));
    expect(readdirSync(join(h, 'config')).filter((f) => f.includes('.bak-0008-'))).toHaveLength(1);
  });

  it('do: recorded as already satisfied, file untouched, no backup', async () => {
    const h = home(DO);
    const { exitCode } = await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
    expect(exitCode).toBe(0);
    const ledger = JSON.parse(readFileSync(join(h, 'state', 'migrations-applied.json'), 'utf8'));
    expect(ledger['0008-transcription-service-is-on'].outcome).toBe('already-satisfied');
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(DO);
    expect(readdirSync(join(h, 'config'))).toEqual(['config.yaml']);
  });
});
