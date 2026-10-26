// 0050 — an existing node keeps answering as before the owner default (operator 2026-10-26): every
// agent that states no allowed_users gets conversation_defaults.allowed_users: ['*']; explicit lists,
// chat-level lists and a profile seeded from the new skeleton are left alone; an 'all' being with no
// list is left owners-only rather than opened.
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as YAML from 'yaml';

const bootHome = join(tmpdir(), `egpt-0050-boot-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.EGPT_HOME = bootHome;
let plan;
beforeAll(async () => { ({ plan } = await import('../migrations/0050-beings-without-a-list-stay-open.mjs')); });
afterAll(() => { delete process.env.EGPT_HOME; rmSync(bootHome, { recursive: true, force: true }); });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KG = [
  '# config.yaml',
  'node_name: kg',
  'agents:',
  '  egpt:',
  '    handles: [e, egpt]   # the persona',
  '    name: "E"',
  '  ken:',
  '    handles: [k]',
  '    conversation_defaults:',
  '      access_level: sandbox   # boxed',
  '  boss:',
  '    conversation_defaults:',
  '      allowed_users: ["+1555"]   # only boss',
  '  wren:',
  '    conversation_defaults:',
  '      access_level: all',
  '      allowed_users: ["+1555"]',
  '  dren:',
  '    conversation_defaults:',
  '      access_level: all',
  '  carol: { relay_channel: rodz1, to: don.do }   # relay',
  '  _note: a comment key',
  'networks:',
  '  whatsapp:',
  '    allowed_users: ["+1555"]',
];
const lf = (lines) => lines.map((l) => `${l}\n`).join('');
const crlf = (lines) => lines.map((l) => `${l}\r\n`).join('');

let egptHome;
const cfgFile = () => join(egptHome, 'config', 'config.yaml');
const write = (name, text) => writeFileSync(join(egptHome, 'config', name), text);
const read = () => YAML.parse(readFileSync(cfgFile(), 'utf8'));
const ctx = () => ({ id: '0050', egptHome, log: () => {}, backup: (p) => { copyFileSync(p, `${p}.bak`); return `${p}.bak`; } });
beforeEach(() => { egptHome = mkdtempSync(join(tmpdir(), 'egpt-0050-')); mkdirSync(join(egptHome, 'config'), { recursive: true }); });
afterEach(() => rmSync(egptHome, { recursive: true, force: true }));

describe('0050 — beings without a list stay open', () => {
  for (const [eol, join_] of [['LF', lf], ['CRLF', crlf]]) {
    it(`writes ['*'] on every agent that states no list, and nothing else (${eol})`, async () => {
      write('config.yaml', join_(KG));
      const p = await plan(ctx());
      expect(p.satisfied).toBe(false);
      await p.apply();
      const after = read();
      expect(after.agents.egpt.conversation_defaults).toEqual({ allowed_users: ['*'] });
      expect(after.agents.ken.conversation_defaults).toEqual({ access_level: 'sandbox', allowed_users: ['*'] });
      expect(after.agents.carol).toEqual({ relay_channel: 'rodz1', to: 'don.do', conversation_defaults: { allowed_users: ['*'] } });
      expect(after.agents.boss.conversation_defaults).toEqual({ allowed_users: ['+1555'] });
      expect(after.agents.wren.conversation_defaults).toEqual({ access_level: 'all', allowed_users: ['+1555'] });
      expect(after.agents.dren.conversation_defaults).toEqual({ access_level: 'all' });   // owners only, not opened
      expect(after.networks).toEqual({ whatsapp: { allowed_users: ['+1555'] } });
      const text = readFileSync(cfgFile(), 'utf8');
      for (const l of KG) expect(text).toContain(l.startsWith('  carol') ? '# relay' : l);   // every line, comments included
      expect(text.split('\n').every((l) => (eol === 'CRLF' ? l === '' || l.endsWith('\r') : !l.endsWith('\r')))).toBe(true);
      expect(readFileSync(`${cfgFile()}.bak`, 'utf8')).toBe(join_(KG));
    });
  }

  it('is idempotent: planned again after applying, it is satisfied, the dren note still said', async () => {
    write('config.yaml', lf(KG));
    await (await plan(ctx())).apply();
    const again = await plan(ctx());
    expect(again.satisfied).toBe(true);
    expect(again.notes.join('\n')).toMatch(/agents\.dren runs 'all' by default with no list - left/);
  });

  it('leaves a being some conversation runs `all` without its own list', async () => {
    write('config.yaml', lf(KG));
    write('conversations.yaml', lf(['contacts:', '  whatsapp:', '    "!g":', '      agents:', '        egpt: { access_level: all }']));
    const p = await plan(ctx());
    await p.apply();
    expect(read().agents.egpt).not.toHaveProperty('conversation_defaults');
    expect(p.changes.join('\n')).toMatch(/agents\.egpt runs 'all' in a conversation with no list - left/);
  });

  it('a conversation `all` WITH its own list does not hold the being back', async () => {
    write('config.yaml', lf(KG));
    write('rooms.yaml', lf(['room/acim:', '  agents:', '    egpt: { access_level: all, allowed_users: ["+1555"] }']));
    await (await plan(ctx())).apply();
    expect(read().agents.egpt.conversation_defaults).toEqual({ allowed_users: ['*'] });
  });

  it('a profile seeded from the new skeleton is satisfied: nothing is opened', async () => {
    copyFileSync(join(ROOT, 'config', 'skeletons', 'config.yaml'), cfgFile());
    const p = await plan(ctx());
    expect(p.satisfied).toBe(true);
    expect(p.notes.join()).toMatch(/top-level `conversation_defaults:`/);
  });

  it('no config.yaml, or no agents map: satisfied', async () => {
    expect((await plan(ctx())).satisfied).toBe(true);
    write('config.yaml', lf(['node_name: kg']));
    expect((await plan(ctx())).satisfied).toBe(true);
  });

  it('refuses a config.yaml that does not parse, and a file changed since it was planned', async () => {
    write('config.yaml', 'agents: [\n');
    await expect(plan(ctx())).rejects.toThrow(/0050 refuses: .*does not parse/);
    write('config.yaml', lf(KG));
    const p = await plan(ctx());
    write('config.yaml', lf([...KG, '# edited']));
    await expect(p.apply()).rejects.toThrow(/0050 refuses: .*changed since it was planned/);
  });
});
