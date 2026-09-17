// tests/migrations-0006-djh-is-off.test.mjs — migrations/0006-djh-is-off.mjs.
//
// Fixtures are miniatures of each node's REAL state on 2026-09-16: do defines djh with
// `mode: mention` and its one conversation block (Radio WnL) sets no mode; kg defines no djh.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan } from '../migrations/0006-djh-is-off.mjs';

const DO = `agents:
  egpt:
    configuration: haiku-low
    handles: [ d, don ]
    default: true
  djh:
    configuration: djhaiku # brain: config/agents/djhaiku.yaml (ccode on haiku, personality dj-son)
    handles: [ djh ] # NOT \`dj\`: address_without_at is true
    name: "DJh"
    mode: mention
    conversation_defaults:
      access_level: all
      sandboxed: false
  pi:
    configuration: pi
    handles: [ pd ]
`;

const DO_CONVERSATIONS = `contacts:
  whatsapp:
    9M8DhdjMm3Qc3hFm3NVy: # Radio WnL
      conversation_path: .egpt/conversations/whatsapp/Radio WnL
      agents:
        djh:
          threadId: 01a0-fixture
`;

const KG = `agents:
  egpt:
    configuration: opus-xhigh
    handles: [ e ]
  wren:
    configuration: wren
    handles: [ wren, w ]
`;

function home(config, conversations) {
  const h = mkdtempSync(join(tmpdir(), 'egpt-0006-'));
  mkdirSync(join(h, 'config'));
  if (config !== undefined) writeFileSync(join(h, 'config', 'config.yaml'), config);
  if (conversations !== undefined) writeFileSync(join(h, 'config', 'conversations.yaml'), conversations);
  return h;
}
const cfgPath = (h) => join(h, 'config', 'config.yaml');
const ctxFor = (h) => ({ egptHome: h, log: () => {}, backup: (f) => { const to = `${f}.bak-0006-test`; writeFileSync(to, readFileSync(f)); return to; } });

describe('0006 on do - djh is mention, and no conversation overrides it', () => {
  it('plans exactly one line: the mode', async () => {
    const h = home(DO, DO_CONVERSATIONS);
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);
    expect(p.changes).toEqual([
      `${cfgPath(h)}:10`,
      '  -     mode: mention',
      '  +     mode: off',
      'backup first, beside it: config.yaml.bak-0006-<timestamp>',
    ]);
  });

  it('apply: byte-identical except that one line - comments, handles and the other agents kept', async () => {
    const h = home(DO, DO_CONVERSATIONS);
    const ctx = ctxFor(h);
    await (await plan(ctx)).apply();
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(DO.replace('    mode: mention\n', '    mode: off\n'));
    expect(readFileSync(`${cfgPath(h)}.bak-0006-test`, 'utf8')).toBe(DO);
    expect((await plan(ctx)).satisfied).toBe(true);
  });

  it('refuses to write over a config edited between plan and apply', async () => {
    const h = home(DO, DO_CONVERSATIONS);
    const p = await plan(ctxFor(h));
    writeFileSync(cfgPath(h), DO.replace('handles: [ pd ]', 'handles: [ pd, pdo ]'));
    await expect(p.apply()).rejects.toThrow(/changed since it was planned/);
    expect(readFileSync(cfgPath(h), 'utf8')).toContain('[ pd, pdo ]');
  });
});

describe('0006 is satisfied where there is nothing to do', () => {
  it('kg defines no djh', async () => {
    const h = home(KG);
    expect(await plan(ctxFor(h))).toEqual({ satisfied: true, notes: ['no agents.djh on this node - nothing to switch off'] });
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(KG);
  });

  it('djh already off, and no conversation overrides it', async () => {
    const h = home(DO.replace('mode: mention', 'mode: off'), DO_CONVERSATIONS);
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(readdirSync(join(h, 'config')).sort()).toEqual(['config.yaml', 'conversations.yaml']);
  });
});

describe('0006 never reports djh off while it still answers somewhere', () => {
  it('refuses, naming the chat, when a conversation overrides the mode in its agents: block', async () => {
    const conv = DO_CONVERSATIONS.replace('          threadId: 01a0-fixture', '          threadId: 01a0-fixture\n          mode: mention');
    const h = home(DO, conv);
    await expect(plan(ctxFor(h))).rejects.toThrow(/0006 refuses: a conversation overrides djh's mode.*9M8DhdjMm3Qc3hFm3NVy\.agents\.djh\.mode = "mention"/);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(DO);
  });

  it('refuses the other per-conversation shape too (<conv>.djh.mode)', async () => {
    const conv = `contacts:\n  whatsapp:\n    9M8DhdjMm3Qc3hFm3NVy:\n      djh:\n        mode: auto\n`;
    const h = home(DO, conv);
    await expect(plan(ctxFor(h))).rejects.toThrow(/9M8DhdjMm3Qc3hFm3NVy\.djh\.mode = "auto"/);
  });

  it('a conversation that sets djh off is not an override - it agrees', async () => {
    const conv = DO_CONVERSATIONS.replace('          threadId: 01a0-fixture', '          threadId: 01a0-fixture\n          mode: off');
    const h = home(DO, conv);
    expect((await plan(ctxFor(h))).satisfied).toBe(false);
  });

  it('refuses a djh with no mode: key rather than inventing a rewrite a splice cannot make', async () => {
    const h = home(DO.replace('    mode: mention\n', ''), DO_CONVERSATIONS);
    await expect(plan(ctxFor(h))).rejects.toThrow(/has no mode: key, and a splice cannot insert one/);
  });
});
