// 0027 — the relays rest. kg's two relay blocks as they stand, CRLF like the operator's file.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { plan } from '../migrations/0027-the-relays-rest.mjs';
import { receives } from '../src/auto-mode.mjs';

const crlf = (lines) => lines.map((l) => `${l}\r\n`).join('');
const KG = [
  'agents:',
  '  egpt:',
  '    handles: [ egpt, e ]',
  '    conversation_defaults:',
  '      access_level: sandbox',
  '  # Relays: no brain here, they forward to an agent on another node.',
  '  carol:',
  '    handles: [ carol ]',
  '    paths:',
  '      - path1:',
  '          relay_channel: rodz1',
  '          network: whatsapp',
  '          to: don.do',
  '      - path2:',
  '          relay_channel: egpt-mesh-do-kg',
  '          network: telegram',
  '          to: don.do',
  '    conversation_defaults:',
  '      access_level: sandbox',
  '  cara:',
  '    handles: [ cara ]',
  '    relay_channel: rodz1',
  '    to: ed.do',
  '    conversation_defaults:',
  '      access_level: sandbox',
  '  don:',
  '    handles: [ don ]',
  '    relay_channel: rodz1',
  '    to: don.do',
];

let root, egptHome;
const cfgFile = () => join(egptHome, 'config', 'config.yaml');
const ctx = () => ({
  id: '0027', egptHome, platform: 'win32', dryRun: false, log: () => {},
  backup: (p) => { const b = `${p}.bak-0027-test`; writeFileSync(b, readFileSync(p)); return b; },
});
const write = (name, text) => { mkdirSync(join(egptHome, 'config'), { recursive: true }); writeFileSync(join(egptHome, 'config', name), text); };
const agents = () => YAML.parse(readFileSync(cfgFile(), 'utf8')).agents;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'egpt-0027-'));
  egptHome = join(root, '.egpt');
  write('config.yaml', crlf(KG));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('0027 — the relays rest', () => {
  it('REPRODUCE: carol and cara state no mode, so both still forward', async () => {
    const before = agents();
    expect(before.carol.mode).toBeUndefined();
    expect(before.cara.mode).toBeUndefined();
    const p = await plan(ctx());
    expect(p.satisfied).toBe(false);
    expect(p.changes.filter((l) => l.includes('insert `mode: off`')).length).toBe(2);
  });

  it('switches both off with the value the gate reads as "not received"', async () => {
    await (await plan(ctx())).apply();
    const after = agents();
    expect(after.carol.mode).toBe('off');
    expect(after.cara.mode).toBe('off');
    expect(receives(after.carol.mode)).toBe(false);
  });

  it('keeps them on file: every other key of both relays is exactly as it was', async () => {
    const before = agents();
    await (await plan(ctx())).apply();
    const after = agents();
    for (const name of ['carol', 'cara']) {
      const { mode, ...rest } = after[name];
      expect(rest).toEqual(before[name]);
    }
  });

  it('touches no other being - not the persona, not the relay to do that is not named', async () => {
    const before = agents();
    await (await plan(ctx())).apply();
    const after = agents();
    expect(after.egpt).toEqual(before.egpt);
    expect(after.don).toEqual(before.don);
  });

  it('keeps CRLF, writes a backup first, and is satisfied afterwards', async () => {
    await (await plan(ctx())).apply();
    const text = readFileSync(cfgFile(), 'utf8');
    expect(text.split('\n').slice(0, -1).every((l) => l.endsWith('\r'))).toBe(true);
    expect(readdirSync(join(egptHome, 'config')).some((n) => n.includes('bak-0027'))).toBe(true);
    expect((await plan(ctx())).satisfied).toBe(true);
  });

  it('replaces a stated mode as one scalar, keeping its trailing comment', async () => {
    write('config.yaml', crlf(KG.flatMap((l) => (l === '  cara:' ? [l, '    mode: on # forwards everything'] : [l]))));
    await (await plan(ctx())).apply();
    const text = readFileSync(cfgFile(), 'utf8');
    expect(text).toContain('    mode: off # forwards everything');
  });

  it('matches by handle, not by key', async () => {
    write('config.yaml', crlf(['agents:', '  relay1:', '    handles: [ carol ]', '    relay_channel: rodz1', '    to: don.do']));
    await (await plan(ctx())).apply();
    expect(agents().relay1.mode).toBe('off');
  });

  it('a node without these relays is satisfied and told so', async () => {
    write('config.yaml', crlf(['agents:', '  don:', '    handles: [ don ]', '    conversation_defaults:', '      access_level: sandbox']));
    const p = await plan(ctx());
    expect(p.satisfied).toBe(true);
    expect(p.notes.join('\n')).toMatch(/no relay here to rest/);
  });

  it('names a conversation that re-enables one, and does not refuse over it', async () => {
    write('conversations.yaml', ['contacts:', '  whatsapp:', '    chatA:', '      agents:', '        carol:', '          mode: on', ''].join('\n'));
    const p = await plan(ctx());
    expect(p.satisfied).toBe(false);
    expect(p.changes.join('\n')).toMatch(/overrides it at contacts\.whatsapp\.chatA\.agents\.carol\.mode/);
  });
});
