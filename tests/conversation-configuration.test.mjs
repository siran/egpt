// conversation-configuration.test.mjs — `configuration:` PER CONVERSATION (operator 2026-09-17).
//
// "there are these files ~/.egpt/config/agents/opus-high.yaml to configure the agent's
// 'configuration' as we do in config.yaml (we need to honor the key in conversations.yaml)."
//
// THE CASE: E (agent key `egpt`, config.yaml `configuration: sonnet-default`) runs the
// primo-del-dia-contexto heartbeat turn in the WhatsApp group "Reencuentro CRC", and that turn
// spawned `--model sonnet --effort high`. The operator wants E on opus high THERE, and only there:
//
//   contacts.whatsapp["<group>"].agents.egpt.configuration: opus-high
//
// ONE resolver (brainpool.mjs resolveBeingDef) is handed the conversation's value by resolveConv,
// the same two-tier walk accessLevel takes, so it joins the SCOPE and `mode` alone stays with the
// origin. A warm process bakes its model/effort in at spawn, so the pool's guard beside the
// session-identity one is what makes a changed configuration actually reach the next turn.
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { createBrainPool } from '../src/spine/brainpool.mjs';
import { createWarmPool } from '../src/warm-sessions.mjs';
import { createContacts } from '../src/spine/contacts.mjs';
import { createBrains } from '../src/spine/brains.mjs';
import { emptyState, patchBeing } from '../src/conversations-state.mjs';

const GROUP = '120363000000000001@g.us';        // "Reencuentro CRC"
const OTHER = '!otra:beeper.com';                // any other conversation E answers in
const ROOM = 'crc';                              // a room the group is invited into (the scoped case)
const groupEv = { surface: 'whatsapp', chatId: GROUP, chatName: 'Reencuentro CRC', line: 'primo del dia', body: 'primo del dia' };
const otherEv = { surface: 'whatsapp', chatId: OTHER, chatName: 'otra', line: 'hola', body: 'hola' };
const roomEv = { surface: 'room', chatId: ROOM, chatName: ROOM, line: 'en la sala', body: 'en la sala' };

// config.yaml as kg has it for E: a NAMED configuration, the persona.
const CONFIG = { agents: { egpt: { configuration: 'sonnet-default', default: true, name: 'E', conversation_defaults: { access_level: 'regular' } } } };

// config/agents/<name>.yaml, in memory. opus-high is the shipped skeleton byte for byte.
const AGENTS = '/profile/config/agents';
const TYPE_FILES = {
  [join(AGENTS, 'sonnet-default.yaml')]: 'type: ccode\nmodel: sonnet\neffort: high\n',
  [join(AGENTS, 'opus-high.yaml')]: 'type: ccode # engine: ccode | codex | chatgpt-cdp | claude-cdp | llama\nmodel: opus # haiku | sonnet | opus | fable\neffort: high # low | medium | high | xhigh | max\n',
};
const brainsOver = () => createBrains({
  builtinDir: '/shipped/brains', agentsDir: AGENTS,
  exists: (p) => p in TYPE_FILES, readFile: (p) => TYPE_FILES[p],
});

// A fake warm pool: records what each turn was handed.
function fakePool() {
  const calls = [];
  return {
    calls,
    run(key, message, onPartial, opts) { calls.push({ key, message, brainOptions: opts.brainOptions }); return Promise.resolve({ text: 'ok', sessionId: null }); },
    evict() {},
    steer() { return false; },
  };
}

// A brainpool over an in-memory registry. `beings` seeds per-conversation blocks:
// { '<surface>/<chatId>': { <being>: { …fields } } }.
async function harness({ beings = {}, pool = fakePool(), resolveScope = null, loadAutoLayer } = {}) {
  let state = emptyState();
  const loadState = async () => state;
  const writeState = async (s) => { state = s; };
  const contacts = createContacts({ loadState, writeState, io: { mkdir: async () => {} } });
  const logs = [];
  for (const [addr, blocks] of Object.entries(beings)) {
    const [surface, chatId] = [addr.slice(0, addr.indexOf('/')), addr.slice(addr.indexOf('/') + 1)];
    await contacts.resolve(surface, chatId);
    for (const [being, fields] of Object.entries(blocks)) state = patchBeing(state, surface, chatId, being, fields);
  }
  const brain = createBrainPool({
    pool, contacts, loadState, writeState,
    getConfig: () => CONFIG,
    brains: brainsOver(),
    defaultKey: 'egpt',
    io: { mkdir: async () => {}, readFile: async () => null, writeFile: async () => {} },
    resolveConfig: () => ({}),
    loadFeed: async () => '', loadManifest: async () => '',
    seedLayers: async () => {},
    loadPermission: () => null,
    platform: 'linux',
    ...(loadAutoLayer ? { loadAutoLayer } : {}),
    ...(resolveScope ? { resolveScope } : {}),
    onLog: (m) => logs.push(String(m)),
  });
  return { brain, pool, logs, setBeing: (surface, chatId, being, fields) => { state = patchBeing(state, surface, chatId, being, fields); } };
}

describe('conversations.yaml agents.<being>.configuration — one resolver, per conversation', () => {
  it('THE ASK: configuration: opus-high runs E on opus/high in THAT conversation, while another conversation stays on sonnet-default', async () => {
    const { brain, pool } = await harness({ beings: { [`whatsapp/${GROUP}`]: { egpt: { configuration: 'opus-high' } } } });
    await brain.turn('egpt', groupEv);
    await brain.turn('egpt', otherEv);
    expect(pool.calls[0].brainOptions).toMatchObject({ model: 'opus', effort: 'high' });
    expect(pool.calls[1].brainOptions).toMatchObject({ model: 'sonnet', effort: 'high' });
  });

  it('an INLINE map works too — the same second form config.yaml takes', async () => {
    const { brain, pool } = await harness({ beings: { [`whatsapp/${GROUP}`]: { egpt: { configuration: { type: 'ccode', model: 'opus', effort: 'xhigh' } } } } });
    await brain.turn('egpt', groupEv);
    expect(pool.calls[0].brainOptions).toMatchObject({ model: 'opus', effort: 'xhigh' });
  });

  it('a SCOPED room: the ROOM\'s configuration applies to a turn the invited group triggers, as access_level does', async () => {
    const resolveScope = async (_being, surface, chatId) => (surface === 'whatsapp' && chatId === GROUP ? { surface: 'room', chatId: ROOM } : null);
    const { brain, pool } = await harness({
      resolveScope,
      beings: {
        [`room/${ROOM}`]: { egpt: { configuration: 'opus-high' } },
        [`whatsapp/${GROUP}`]: { egpt: { configuration: { type: 'ccode', model: 'haiku', effort: 'low' } } },   // the group's own block is NOT the scope's
      },
    });
    await brain.turn('egpt', groupEv);
    expect(pool.calls[0].key).toBe(`egpt:ccode:room:${ROOM}`);
    expect(pool.calls[0].brainOptions).toMatchObject({ model: 'opus', effort: 'high' });
  });

  it('LOCK — no per-conversation key: exactly today\'s def, and no log line', async () => {
    const { brain, pool, logs } = await harness({ beings: { [`whatsapp/${GROUP}`]: { egpt: { mode: 'on' } } } });
    await brain.turn('egpt', groupEv);
    expect(pool.calls[0].brainOptions).toMatchObject({ model: 'sonnet', effort: 'high' });
    expect(logs.filter((l) => /configuration/.test(l))).toEqual([]);
  });

  it('LOCK — mode still resolves from the ORIGIN chat while configuration follows the scope', async () => {
    const resolveScope = async (_being, surface, chatId) => (surface === 'whatsapp' && chatId === GROUP ? { surface: 'room', chatId: ROOM } : null);
    const loadAutoLayer = async () => 'AUTO-LAYER';
    // The ROOM is in mode auto; the group that triggers the turn is not.
    const fromGroup = await harness({ resolveScope, loadAutoLayer, beings: { [`room/${ROOM}`]: { egpt: { configuration: 'opus-high', mode: 'auto' } } } });
    await fromGroup.brain.turn('egpt', groupEv);
    expect(fromGroup.pool.calls[0].brainOptions).toMatchObject({ model: 'opus', effort: 'high' });
    expect(fromGroup.pool.calls[0].message).not.toContain('AUTO-LAYER');
    // …and a turn IN the room reads the room's own mode.
    const inRoom = await harness({ resolveScope, loadAutoLayer, beings: { [`room/${ROOM}`]: { egpt: { configuration: 'opus-high', mode: 'auto' } } } });
    await inRoom.brain.turn('egpt', roomEv);
    expect(inRoom.pool.calls[0].message).toContain('AUTO-LAYER');
  });

  // conversations.yaml is hand-edited and never checked at boot, so a bad value is refused by the
  // SAME brains.resolve that refuses a bad config.yaml one — but at the point of use, every turn,
  // and without taking the being down: it runs on config.yaml's configuration and says so.
  it('an UNUSABLE value is refused by brains.resolve, logged naming conversations.yaml, and the being runs on config.yaml\'s configuration', async () => {
    for (const bad of [{}, 'here/a/path', ['opus-high'], 42]) {
      const { brain, pool, logs } = await harness({ beings: { [`whatsapp/${GROUP}`]: { egpt: { configuration: bad } } } });
      await expect(brain.turn('egpt', groupEv)).resolves.toMatchObject({ text: 'ok' });
      expect(pool.calls[0].brainOptions).toMatchObject({ model: 'sonnet', effort: 'high' });
      const line = logs.find((l) => /unusable `configuration` in conversations\.yaml/.test(l));
      expect(line, `no refusal logged for ${JSON.stringify(bad)}: ${logs.join(' | ')}`).toBeTruthy();
      expect(line).toMatch(/egpt/);
      expect(line).toMatch(/running on config\.yaml's configuration \(sonnet-default\) instead/);
    }
  });

  it('a NAME with no config/agents/<name>.yaml is refused the same way — never a silent bare def', async () => {
    const { brain, pool, logs } = await harness({ beings: { [`whatsapp/${GROUP}`]: { egpt: { configuration: 'opus-hihg' } } } });
    await brain.turn('egpt', groupEv);
    expect(pool.calls[0].brainOptions).toMatchObject({ model: 'sonnet', effort: 'high' });
    expect(logs.some((l) => /opus-hihg/.test(l) && /conversations\.yaml/.test(l) && /sonnet-default/.test(l))).toBe(true);
  });

  // END TO END through the REAL warm pool: a warm process keeps the model/effort it was spawned
  // with, so without the pool's guard the conversation's new configuration would be ignored for as
  // long as that process stays warm.
  it('a warm IDLE session opened on sonnet is evicted and reopened on opus, resuming the same thread, when the next turn resolves opus-high', async () => {
    const made = [], poolLogs = [];
    const pool = createWarmPool({
      onLog: (m) => poolLogs.push(m),
      makeSession: (opts) => {
        const s = { opts, closed: false, get sessionId() { return opts.sessionId ?? 'sid-crc'; }, close() { this.closed = true; }, turn: async () => ({ text: 'ok', sessionId: 'sid-crc' }) };
        made.push(s);
        return s;
      },
    });
    const { brain, setBeing } = await harness({ pool, beings: { [`whatsapp/${GROUP}`]: { egpt: { mode: 'on' } } } });
    await brain.turn('egpt', groupEv);
    await brain.turn('egpt', groupEv);
    expect(made).toHaveLength(1);                                   // steady state: one warm process
    expect(made[0].opts).toMatchObject({ model: 'sonnet', effort: 'high' });

    setBeing('whatsapp', GROUP, 'egpt', { configuration: 'opus-high' });   // the operator's hand edit
    await brain.turn('egpt', groupEv);
    expect(made).toHaveLength(2);
    expect(made[0].closed).toBe(true);
    expect(made[1].opts).toMatchObject({ model: 'opus', effort: 'high', sessionId: 'sid-crc' });
    expect(poolLogs.some((l) => /evicted .*model sonnet→opus/.test(l))).toBe(true);
  });
});
