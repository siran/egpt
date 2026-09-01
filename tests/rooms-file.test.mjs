import { describe, it, expect } from 'vitest';
import * as YAML from 'yaml';
import {
  readRoomsFile, readRoomConfig, setRoomConfigBlock, setRoomConfigKey, removeRoomRow,
  roomsFilePath, agentsFilePath,
  mergeRoomBeings, persistRoomBeings, mergeAgentBeings, persistAgentBeings,
} from '../src/rooms-file.mjs';

const mkIO = (text) => {
  const store = { text };
  return {
    store,
    path: 'rooms.yaml',
    read: async () => { if (store.text == null) throw new Error('ENOENT'); return store.text; },
    write: async (_p, t) => { store.text = t; },
    ensureDir: async () => {},
  };
};

describe('rooms.yaml — the room rung', () => {
  it('reads the wrapped shape', async () => {
    const io = mkIO('rooms:\n  room/dj-son:\n    heartbeats:\n      dj: false\n');
    expect(await readRoomConfig('room/dj-son', io)).toEqual({ heartbeats: { dj: false } });
  });

  it('tolerates a bare top-level map', async () => {
    const io = mkIO('shell/lobby:\n  members: []\n');
    expect(await readRoomConfig('shell/lobby', io)).toEqual({ members: [] });
  });

  it('returns {} for a missing row or missing file', async () => {
    expect(await readRoomConfig('nope/here', mkIO('rooms:\n'))).toEqual({});
    expect(await readRoomConfig('nope/here', mkIO(null))).toEqual({});
    expect(await readRoomsFile(mkIO(null))).toEqual({});
  });

  it('NO ROOM IS SPECIAL — dj-son is just a row', async () => {
    const io = mkIO('rooms:\n  room/dj-son:\n    heartbeats: {dj: false}\n  room/other:\n    heartbeats: {x: true}\n');
    const all = await readRoomsFile(io);
    expect(Object.keys(all).sort()).toEqual(['room/dj-son', 'room/other']);
  });

  it('writes one block without clobbering other rows or comments', async () => {
    const io = mkIO('# operator notes\nrooms:\n  room/a:\n    heartbeats: {x: true}\n');
    await setRoomConfigBlock('room/b', 'members', [{ kind: 'brain', id: 'c1' }], io);
    expect(io.store.text).toContain('# operator notes');
    expect(await readRoomConfig('room/a', io)).toEqual({ heartbeats: { x: true } });
    expect(await readRoomConfig('room/b', io)).toEqual({ members: [{ kind: 'brain', id: 'c1' }] });
  });

  it('creates the file when absent', async () => {
    const io = mkIO(null);
    await setRoomConfigBlock('room/new', 'heartbeats', { dj: false }, io);
    expect(await readRoomConfig('room/new', io)).toEqual({ heartbeats: { dj: false } });
  });

  it('sets a DOTTED key inside a row', async () => {
    const io2 = mkIO('rooms:\n');
    await setRoomConfigKey('room/dj-son', 'radio_service.wildnloyal.enabled', false, io2);
    expect(await readRoomConfig('room/dj-son', io2))
      .toEqual({ radio_service: { wildnloyal: { enabled: false } } });
  });

  it('never splits ns — a slug with dots and spaces stays ONE key', async () => {
    const io2 = mkIO('rooms:\n');
    const ns = 'whatsapp/HFM - high.frequency-2606300017';
    await setRoomConfigKey(ns, 'radio.join', 'wildnloyal', io2);
    expect(await readRoomConfig(ns, io2)).toEqual({ radio: { join: 'wildnloyal' } });
    expect(Object.keys(await readRoomsFile(io2))).toEqual([ns]);
  });

  it('removes a whole row without touching its siblings', async () => {
    const io2 = mkIO('rooms:\n  room/a:\n    heartbeats: {x: true}\n  room/b:\n    heartbeats: {y: true}\n');
    await removeRoomRow('room/a', io2);
    expect(await readRoomConfig('room/a', io2)).toEqual({});
    expect(await readRoomConfig('room/b', io2)).toEqual({ heartbeats: { y: true } });
  });
});

// ── the SAME rung over a SECOND registry: config/agents.yaml (operator 2026-09-01) ──────
// A being pinned node-wide needs ONE conversation of its own and wren is not a room, so
// `agent/<name>` rows live in config/agents.yaml under an `agents:` root — same block
// shape, same reader, same comment-preserving writer. NOTHING above this module routes:
// the registry is chosen from the NAMESPACE itself, so room-core's loadConfig (which
// passes nothing but this.ns()) reaches the right file for free.
//
// A path-keyed fake fs, so one test can watch BOTH files at once and prove they never cross.
const mkVfs = (seed = {}) => {
  const files = { ...seed };
  return {
    files,
    io: {
      read: async (p) => { if (files[p] == null) throw new Error('ENOENT'); return files[p]; },
      write: async (p, t) => { files[p] = t; },
      ensureDir: async () => {},
    },
  };
};

describe('agents.yaml — the same rung, keyed agent/<name>', () => {
  it('routes an agent/ ns to agents.yaml and a room/ ns to rooms.yaml — the two never cross', async () => {
    const vfs = mkVfs();
    await setRoomConfigBlock('agent/wren', 'agents', { wren: { threadId: 'w-1' } }, vfs.io);
    await setRoomConfigBlock('room/dj-son', 'heartbeats', { dj: false }, vfs.io);
    expect(Object.keys(vfs.files).sort()).toEqual([agentsFilePath(), roomsFilePath()].sort());
    expect(YAML.parse(vfs.files[agentsFilePath()]))
      .toEqual({ agents: { 'agent/wren': { agents: { wren: { threadId: 'w-1' } } } } });
    expect(YAML.parse(vfs.files[roomsFilePath()]))
      .toEqual({ rooms: { 'room/dj-son': { heartbeats: { dj: false } } } });
  });

  it('reads an agent row back with no path given, and never finds it in rooms.yaml', async () => {
    const vfs = mkVfs({ [agentsFilePath()]: 'agents:\n  agent/wren:\n    access_level: all\n' });
    expect(await readRoomConfig('agent/wren', vfs.io)).toEqual({ access_level: 'all' });
    expect(await readRoomConfig('room/wren', vfs.io)).toEqual({});
  });

  it('tolerates a bare top-level map in agents.yaml', async () => {
    const io = mkIO('agent/wren:\n  agents:\n    wren:\n      threadId: w-1\n');
    expect(await readRoomConfig('agent/wren', io)).toEqual({ agents: { wren: { threadId: 'w-1' } } });
  });

  it('a missing agents.yaml is not an error — a fresh profile has none', async () => {
    expect(await readRoomConfig('agent/wren', mkIO(null))).toEqual({});
    expect(await readRoomsFile(mkVfs().io)).toEqual({});
  });

  it('an operator comment and the other agent rows survive a single-block edit', async () => {
    const io = mkIO('# operator notes\nagents:\n  agent/wren:\n    access_level: all\n  agent/lyra:\n    agents:\n      lyra:\n        threadId: keep-me\n');
    await setRoomConfigBlock('agent/wren', 'agents', { wren: { threadId: 'w-2' } }, io);
    expect(io.store.text).toContain('# operator notes');
    expect(await readRoomConfig('agent/lyra', io)).toEqual({ agents: { lyra: { threadId: 'keep-me' } } });
    expect(await readRoomConfig('agent/wren', io))
      .toEqual({ access_level: 'all', agents: { wren: { threadId: 'w-2' } } });
  });

  it('setRoomConfigKey and removeRoomRow route by namespace too', async () => {
    const vfs = mkVfs();
    await setRoomConfigKey('agent/wren', 'agents.wren.access_level', 'all', vfs.io);
    expect(Object.keys(vfs.files)).toEqual([agentsFilePath()]);
    expect(await readRoomConfig('agent/wren', vfs.io)).toEqual({ agents: { wren: { access_level: 'all' } } });
    await removeRoomRow('agent/wren', vfs.io);
    expect(await readRoomConfig('agent/wren', vfs.io)).toEqual({});
  });

  it('agentsFilePath is resolved LAZILY, so a test profile is honoured', () => {
    const saved = process.env.EGPT_HOME;
    try {
      process.env.EGPT_HOME = '/tmp/egpt-lazy-profile';
      expect(agentsFilePath().split(/[\\/]/).slice(-3)).toEqual(['egpt-lazy-profile', 'config', 'agents.yaml']);
    } finally { process.env.EGPT_HOME = saved; }
  });
});

describe('the per-being halves, one per registry', () => {
  const agentState = (agents) => ({ contacts: { agent: { wren: { slug: 'wren', agents } } } });

  it('persistAgentBeings writes the block into agents.yaml and strips it from the state', async () => {
    const vfs = mkVfs();
    const out = await persistAgentBeings(agentState({ wren: { threadId: 'w-1', access_level: 'all' } }), vfs.io);
    expect(out.contacts.agent.wren).toEqual({ slug: 'wren' });                    // stripped
    expect(Object.keys(vfs.files)).toEqual([agentsFilePath()]);                   // rooms.yaml untouched
    expect(await readRoomConfig('agent/wren', vfs.io))
      .toEqual({ agents: { wren: { threadId: 'w-1', access_level: 'all' } } });
  });

  it('mergeAgentBeings hydrates from agents.yaml, and an entry with no row keeps its loaded block', async () => {
    const vfs = mkVfs({ [agentsFilePath()]: 'agents:\n  agent/wren:\n    agents:\n      wren:\n        threadId: from-file\n' });
    const state = {
      contacts: {
        agent: {
          wren: { slug: 'wren', agents: { wren: { threadId: 'stale' } } },
          lyra: { slug: 'lyra', agents: { lyra: { threadId: 'legacy-thread' } } },   // read-through: no row yet
        },
      },
    };
    const out = await mergeAgentBeings(state, vfs.io);
    expect(out.contacts.agent.wren.agents.wren.threadId).toBe('from-file');
    expect(out.contacts.agent.lyra.agents.lyra.threadId).toBe('legacy-thread');
  });

  it('the room half is untouched — a room entry still round-trips through rooms.yaml alone', async () => {
    const vfs = mkVfs();
    const state = { contacts: { room: { 'dj-son': { slug: 'dj-son', agents: { egpt: { threadId: 'r-1' } } } } } };
    const out = await persistRoomBeings(state, vfs.io);
    expect(out.contacts.room['dj-son']).toEqual({ slug: 'dj-son' });
    expect(Object.keys(vfs.files)).toEqual([roomsFilePath()]);
    expect(await readRoomConfig('room/dj-son', vfs.io)).toEqual({ agents: { egpt: { threadId: 'r-1' } } });
    const back = await mergeRoomBeings({ contacts: { room: { 'dj-son': { slug: 'dj-son' } } } }, vfs.io);
    expect(back.contacts.room['dj-son'].agents).toEqual({ egpt: { threadId: 'r-1' } });
  });
});
