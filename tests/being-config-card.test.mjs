// The room's ./directives/config.readonly.yaml (operator 2026-09-24): a being's own configuration,
// rendered from what its turn runs with, written only when it changes, never a node-level key.
// Everything runs against an in-memory io — no file under a real profile is touched.
import { describe, it, expect } from 'vitest';
import * as YAML from 'yaml';
import { renderConfigBlock, mergeConfigCard, writeConfigCard, CONFIG_CARD_FILE } from '../src/spine/being-config-card.mjs';
import { createBrainPool } from '../src/spine/brainpool.mjs';
import { createContacts } from '../src/spine/contacts.mjs';
import { emptyState, patchBeing } from '../src/conversations-state.mjs';

// Node-level values a being must never be shown. Each is unique so a leak is unambiguous.
const SECRETS = {
  sandbox_oauth_token: 'SECRET-OAUTH-0001',
  beeper: { primary: { token: 'SECRET-BEEPER-0002' }, secondary: { token: 'SECRET-BEEPER-0003' } },
  shell: { token: 'SECRET-SHELL-0004' },
  radio_service: { wildnloyal: { relay_password: 'SECRET-RADIO-0005' } },
};
const SECRET_WORDS = ['SECRET-', 'sandbox_oauth_token', 'beeper', 'shell', 'token', 'relay_password'];

const EGPT_TYPE = { type: 'ccode', model: 'opus', effort: 'high', verbose_thinking: true, allowed_paths: { 'C:/Users/an/src/egpt': { allowed_tools: ['Read', 'Glob', 'Grep'] } } };
const baseConfig = () => ({
  node_name: 'kg',
  ...SECRETS,
  compaction: { ratio: 0.25 },
  agents: {
    egpt: { handles: ['e', 'egpt', 'ekg', 'egptkg'], configuration: 'opus-default', conversation_defaults: { access_level: 'sandbox', verbose_thinking: true } },
    ken: { handles: ['ken'], configuration: 'sonnet-high', conversation_defaults: { access_level: 'sandbox' } },
  },
});

function memIo() {
  const files = new Map();
  const writes = [];
  return {
    files, writes,
    mkdir: async () => {},
    readFile: async (p) => (files.has(p) ? files.get(p) : null),
    writeFile: async (p, d) => { writes.push(p); files.set(p, String(d)); },
    rename: async (a, b) => { files.set(b, files.get(a)); files.delete(a); },
  };
}
const cardOf = (io) => [...io.files.entries()].find(([p]) => p.endsWith(CONFIG_CARD_FILE))?.[1] ?? null;
const cardWrites = (io) => io.writes.filter((p) => p.includes(CONFIG_CARD_FILE)).length;

const ev = { surface: 'whatsapp', chatId: '!room:beeper.com', chatName: 'SPOILER', line: 'An@[SPOILER].wa (14:05) #m1: hola', body: 'hola' };

function harness({ config = baseConfig(), types = { 'opus-default': EGPT_TYPE, 'sonnet-high': { type: 'ccode', model: 'sonnet', effort: 'high' } } } = {}) {
  let state = emptyState();
  const io = memIo();
  const logs = [];
  const brain = createBrainPool({
    pool: { run: async () => ({ text: 'ok', sessionId: 'sid-1' }), evict() {}, async steer() { return false; } },
    getConfig: () => config,
    contacts: createContacts({ loadState: async () => state, writeState: async (s) => { state = s; }, io: { mkdir: async () => {} } }),
    loadState: async () => state,
    writeState: async (s) => { state = s; },
    io,
    resolveConfig: () => ({}),
    loadFeed: async () => '',
    loadManifest: async () => '',
    seedLayers: async () => [],
    brains: { resolve: (name) => types[name] ?? null },
    loadPermission: () => null,
    onLog: (m) => logs.push(m),
    platform: 'win32',
  });
  return { brain, io, logs, config, types, getState: () => state, setState: (s) => { state = s; } };
}

describe('renderConfigBlock — what a being is shown', () => {
  const block = () => renderConfigBlock({
    being: 'egpt', config: baseConfig(), configuration: null, def: EGPT_TYPE, engine: 'ccode', model: 'opus', effort: 'high',
    accessLevel: 'sandbox', sandboxed: true, sandboxedRung: 'level', mode: { mode: 'mention', source: 'node' },
    verboseThinking: true, verboseSource: 'agent', allowedUsers: null, compaction: null,
    sources: { accessLevel: 'agent', allowedUsers: 'default', verboseThinking: 'agent', compaction: 'default', outboxTo: 'default' },
    outboxTarget: null, threadId: '53e9e587-384a-4d1b-9795-7e947847292c',
  });

  it('states what the turn runs with, parseable, keyed by the being', () => {
    const data = YAML.parse(block()).egpt;
    expect(data).toMatchObject({
      handles: ['e', 'egpt', 'ekg', 'egptkg'], node: 'kg', configuration: 'opus-default', engine: 'ccode', model: 'opus', effort: 'high',
      access_level: 'sandbox', sandboxed: true, mode: 'mention', verbose_thinking: true,
      allowed_paths: { 'C:/Users/an/src/egpt': ['Read', 'Glob', 'Grep'] }, compaction: { ratio: 0.25 },
      thread: '53e9e587-384a-4d1b-9795-7e947847292c',
    });
  });

  it('says where each value came from', () => {
    const text = block();
    expect(text).toMatch(/configuration: opus-default\s+# agent default \(config\.yaml\)/);
    expect(text).toMatch(/model: opus\s+# type file config\/agents\/opus-default\.yaml/);
    expect(text).toMatch(/sandboxed: true\s+# access_level sandbox forces it/);
    expect(text).toMatch(/mode: mention\s+# node default \(config\.yaml\)/);
  });

  it('never carries a node-level key, however much the config holds', () => {
    const text = block();
    for (const w of SECRET_WORDS) expect(text).not.toContain(w);
  });

  it('in a room, mode is per chat rather than whichever chat spoke last', () => {
    const text = renderConfigBlock({ being: 'egpt', config: baseConfig(), scoped: true, def: {}, mode: { mode: 'on', source: 'conversation' }, sources: {} });
    expect(YAML.parse(text).egpt.mode).toBe('per chat');
  });

  it('a fresh thread says its id is still to come', () => {
    const text = renderConfigBlock({ being: 'egpt', config: baseConfig(), def: {}, sources: {}, threadId: null });
    expect(text).toMatch(/thread: new\s+# its id is assigned on this turn/);
  });
});

describe('mergeConfigCard — one block per being', () => {
  const egpt = 'egpt:\n  model: opus';
  const ken = 'ken:\n  model: sonnet';

  it('adds a block, then replaces only that block', () => {
    const one = mergeConfigCard('', 'egpt', egpt);
    const two = mergeConfigCard(one, 'ken', ken);
    const three = mergeConfigCard(two, 'egpt', 'egpt:\n  model: haiku');
    expect(YAML.parse(three)).toEqual({ egpt: { model: 'haiku' }, ken: { model: 'sonnet' } });
    expect(three.startsWith('# How the beings in this room are configured.')).toBe(true);
  });

  it('the same block gives the same text, so nothing is rewritten', () => {
    const one = mergeConfigCard(mergeConfigCard('', 'egpt', egpt), 'ken', ken);
    expect(mergeConfigCard(one, 'egpt', egpt)).toBe(one);
  });

  it('an unparseable file is started afresh', () => {
    expect(YAML.parse(mergeConfigCard('egpt: [unclosed\n', 'ken', ken))).toEqual({ ken: { model: 'sonnet' } });
  });
});

describe('writeConfigCard', () => {
  const room = { directivesDir: 'X:/room/directives' };

  it('writes when missing, skips when unchanged, never throws', async () => {
    const io = memIo();
    expect(await writeConfigCard(room, 'egpt', 'egpt:\n  model: opus', { io })).toBe(true);
    expect(await writeConfigCard(room, 'egpt', 'egpt:\n  model: opus', { io })).toBe(false);
    const logs = [];
    const broken = { ...io, readFile: async () => { const e = new Error('denied'); e.code = 'EACCES'; throw e; } };
    expect(await writeConfigCard(room, 'egpt', 'egpt:\n  model: opus', { io: broken, onLog: (m) => logs.push(m) })).toBe(false);
    expect(logs.join('\n')).toMatch(/config card: egpt/);
  });
});

describe('brainpool writes the card at the start of every turn', () => {
  it('first turn writes it into the room\'s directives/, before the thread exists', async () => {
    const h = harness();
    await h.brain.turn('egpt', ev);
    const card = cardOf(h.io);
    expect([...h.io.files.keys()].some((p) => /directives[\\/]config\.readonly\.yaml$/.test(p))).toBe(true);
    expect(YAML.parse(card).egpt).toMatchObject({ model: 'opus', effort: 'high', access_level: 'sandbox', sandboxed: true, thread: 'new' });
  });

  it('the recorded thread changes it once; an unchanged turn then does not rewrite it', async () => {
    const h = harness();
    await h.brain.turn('egpt', ev);
    await h.brain.turn('egpt', ev);
    expect(YAML.parse(cardOf(h.io)).egpt.thread).toBe('sid-1');
    const before = cardWrites(h.io);
    await h.brain.turn('egpt', ev);
    expect(cardWrites(h.io)).toBe(before);
  });

  it('a changed model or mode rewrites only that being\'s block; the other being\'s survives', async () => {
    const h = harness();
    await h.brain.turn('egpt', ev);
    await h.brain.turn('ken', ev);
    const kenBefore = YAML.parse(cardOf(h.io)).ken;
    h.types['opus-default'] = { ...EGPT_TYPE, model: 'haiku' };
    h.setState(patchBeing(h.getState(), ev.surface, ev.chatId, 'egpt', { mode: 'on' }));
    await h.brain.turn('egpt', ev);
    const after = YAML.parse(cardOf(h.io));
    expect(after.egpt.model).toBe('haiku');
    expect(after.egpt.mode).toBe('on');
    expect(after.ken).toEqual(kenBefore);
  });

  it('the file never holds a node-level key', async () => {
    const h = harness();
    await h.brain.turn('egpt', ev);
    await h.brain.turn('ken', ev);
    const card = cardOf(h.io);
    for (const w of SECRET_WORDS) expect(card).not.toContain(w);
  });
});
