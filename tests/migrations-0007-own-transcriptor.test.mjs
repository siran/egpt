// tests/migrations-0007-own-transcriptor.test.mjs — migrations/0007-own-transcriptor-is-on.mjs.
//
// Fixtures are miniatures of each node's REAL config on 2026-09-16: do routes its worker rung to
// 127.0.0.1:23390 with both transcriptor flags false; kg routes its worker rung to dolly's address.
// localAddresses is injected as an EMPTY set, so the verdict never depends on which machine runs the
// test (on dolly itself, dolly's LAN address would otherwise read as local).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan } from '../migrations/0007-own-transcriptor-is-on.mjs';

const DO = `transcriptor:
  enabled: false
  bind: 0.0.0.0
  port: 23390
  server:
    enabled: false
    command: C:\\Users\\an\\bin\\whisper.cpp\\Release\\whisper-server.exe
    host: 127.0.0.1
    port: 8089
transcription:
  server:
    token: FIXTURE-TOKEN
  cli:
    command: C:\\Users\\an\\bin\\whisper.cpp\\Release\\whisper-cli.exe
    model_path: C:\\Users\\an\\bin\\whisper.cpp\\models\\ggml-large-v3.bin
transcription_service:
  enabled: true
  use_config: do
  do:
    fallback_order:
      - worker
      - cli
    worker:
      type: whisper-server-remote
      endpoint: http://127.0.0.1:23390
    cli:
      type: whisper-cli
`;

const KG = DO
  .replace('use_config: do', 'use_config: reve')
  .replace('  do:\n', '  reve:\n')
  .replace('http://127.0.0.1:23390', 'http://192.168.1.102:23390');

function home(config) {
  const h = mkdtempSync(join(tmpdir(), 'egpt-0007-'));
  mkdirSync(join(h, 'config'));
  if (config !== undefined) writeFileSync(join(h, 'config', 'config.yaml'), config);
  return h;
}
const cfgPath = (h) => join(h, 'config', 'config.yaml');
const ctxFor = (h) => ({ egptHome: h, log: () => {}, localAddresses: new Set(), backup: (f) => { const to = `${f}.bak-0007-test`; writeFileSync(to, readFileSync(f)); return to; } });

describe('0007 on do - its own worker, both flags off', () => {
  it('plans exactly two lines, both flags, and says it takes effect at the next start', async () => {
    const h = home(DO);
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);
    expect(p.changes).toEqual([
      'because transcription_service.do.worker sends notes to http://127.0.0.1:23390, on this node:',
      `${cfgPath(h)}:2`,
      '  -   enabled: false',
      '  +   enabled: true',
      `${cfgPath(h)}:6`,
      '  -     enabled: false',
      '  +     enabled: true',
      'takes effect at the next spine start (the worker reads these only at boot)',
      'backup first, beside it: config.yaml.bak-0007-<timestamp>',
    ]);
  });

  it('apply: byte-identical except those two lines, and transcription_service.enabled untouched', async () => {
    const h = home(DO);
    const ctx = ctxFor(h);
    await (await plan(ctx)).apply();
    const after = readFileSync(cfgPath(h), 'utf8');
    expect(after).toBe(DO.replace('transcriptor:\n  enabled: false\n', 'transcriptor:\n  enabled: true\n').replace('  server:\n    enabled: false\n', '  server:\n    enabled: true\n'));
    expect(readFileSync(`${cfgPath(h)}.bak-0007-test`, 'utf8')).toBe(DO);
    expect((await plan(ctx)).satisfied).toBe(true);
  });

  it('with only transcriptor.enabled on, it still turns the server on - never one flag without the other', async () => {
    const h = home(DO.replace('transcriptor:\n  enabled: false\n', 'transcriptor:\n  enabled: true\n'));
    const ctx = ctxFor(h);
    const p = await plan(ctx);
    expect(p.satisfied).toBe(false);
    expect(p.changes.filter((l) => l.startsWith('  +'))).toEqual(['  +     enabled: true']);
    await p.apply();
    expect((await plan(ctx)).satisfied).toBe(true);
  });

  it('refuses to write over a config edited between plan and apply', async () => {
    const h = home(DO);
    const p = await plan(ctxFor(h));
    writeFileSync(cfgPath(h), DO.replace('port: 8089', 'port: 8090'));
    await expect(p.apply()).rejects.toThrow(/changed since it was planned/);
    expect(readFileSync(cfgPath(h), 'utf8')).toContain('port: 8090');
  });
});

describe('0007 is satisfied where there is nothing to enable', () => {
  it('kg: its worker rung is dolly, so it is not its own worker - untouched', async () => {
    const h = home(KG);
    expect(await plan(ctxFor(h))).toEqual({ satisfied: true, notes: ['this node does not route notes to its own transcriptor - nothing to enable'] });
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(KG);
  });

  it('a node with no transcription_service at all', async () => {
    const h = home('node_name: zz\n');
    expect((await plan(ctxFor(h))).satisfied).toBe(true);
  });

  it('do with both flags already on', async () => {
    const h = home(DO.replace(/enabled: false/g, 'enabled: true'));
    expect((await plan(ctxFor(h))).satisfied).toBe(true);
  });
});

describe('0007 refuses rather than guess', () => {
  it('its own worker, but no transcriptor block to switch on', async () => {
    const h = home(DO.replace(/^transcriptor:\n(?: {2}.*\n)+/m, ''));
    await expect(plan(ctxFor(h))).rejects.toThrow(/0007 refuses: .*no transcriptor: block/);
  });

  it('its own worker, but no model path anywhere for the worker to name', async () => {
    const h = home(DO.replace('    model_path: C:\\Users\\an\\bin\\whisper.cpp\\models\\ggml-large-v3.bin\n', ''));
    await expect(plan(ctxFor(h))).rejects.toThrow(/0007 refuses: neither transcriptor.server.model nor transcription.cli.model_path/);
  });

  it('a flag that is not a boolean', async () => {
    const h = home(DO.replace('transcriptor:\n  enabled: false\n', 'transcriptor:\n  enabled: maybe\n'));
    await expect(plan(ctxFor(h))).rejects.toThrow(/0007 refuses: transcriptor.enabled is "maybe"/);
  });
});
