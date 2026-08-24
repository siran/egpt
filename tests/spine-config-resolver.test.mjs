// The config RESOLVER (src/spine/config-resolver.mjs): ONE namespace, THREE rungs,
// nearest the room wins —
//   config/config.yaml  <  config/conversations.yaml (the entry)  <  <entity>/config.yaml
// Combining is NOT uniform, and each rule gets its own test here:
//   heartbeats:  UNION    — every rung CONTRIBUTES; the node's block never loses
//   everything else: OVERRIDE, nearest rung wins, deep-merged so a folder that pins
//                    one leaf does not delete its siblings
//   members:     entity-only in practice (no node/registry rung declares it)
// Every resolved chunk carries `source:` — the profile-relative path of the file the
// winning value was read from. All fakes; the resolver never touches a real profile.
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import * as YAML from 'yaml';
import {
  createConfigResolver, layerInto, mirrorSource, isPlainObject,
  NODE_FILE, REGISTRY_FILE, UNION_KEYS,
} from '../src/spine/config-resolver.mjs';

const HOME = '/profile';
const CONV_DIR = join(HOME, 'conversations', 'whatsapp', 'hfm-2606201530');
const ROOM_DIR = join(HOME, 'rooms', 'lab');
const CONV_FILE = 'config/rooms.yaml';
const ROOM_FILE = 'config/rooms.yaml';

function makeResolver({ node = {}, registry = {}, folders = {}, dirs = null, io } = {}) {
  return createConfigResolver({
    getConfig: () => node,
    loadRegistry: async () => registry,
    listEntityDirs: async () => dirs ?? [
      { dir: CONV_DIR, ns: 'whatsapp/hfm-2606201530' },
      { dir: ROOM_DIR, ns: 'room/lab' },
    ],
    readEntityConfig: async (dir) => folders[dir] ?? {},
    egptHome: HOME,
    io: io ?? { writeFile: async () => {}, mkdir: async () => {} },
  });
}

// a registry whose whatsapp bucket holds ONE conversation whose slug matches CONV_DIR
const registryWith = (entry) => ({ contacts: { whatsapp: { '1@s.whatsapp.net': { slug: 'hfm-2606201530', ...entry } } } });

// ── pure helpers ────────────────────────────────────────────────────────────
describe('config-resolver pure helpers', () => {
  it('isPlainObject: maps yes, arrays/null/scalars no', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject('x')).toBe(false);
  });

  it('mirrorSource builds a provenance tree with the SAME shape as the value', () => {
    expect(mirrorSource(5, 'a.yaml')).toBe('a.yaml');
    expect(mirrorSource({ a: 1, b: { c: 2 } }, 'a.yaml')).toEqual({ a: 'a.yaml', b: { c: 'a.yaml' } });
    expect(mirrorSource([1, 2], 'a.yaml')).toBe('a.yaml');   // a list is ONE value, replaced whole
  });

  it('layerInto deep-merges maps and records the winning file per leaf', () => {
    const config = {}, source = {};
    layerInto(config, source, { tx: { use_config: 'reve', posts_back: true }, n: 1 }, 'node.yaml');
    layerInto(config, source, { tx: { posts_back: false } }, 'folder.yaml');
    expect(config).toEqual({ tx: { use_config: 'reve', posts_back: false }, n: 1 });
    expect(source).toEqual({ tx: { use_config: 'node.yaml', posts_back: 'folder.yaml' }, n: 'node.yaml' });
  });

  it('layerInto skips the UNION blocks at the TOP level only (they are collected, never overridden)', () => {
    expect([...UNION_KEYS]).toEqual(['heartbeats']);
    const config = { heartbeats: { alive: { frequency: '1s' } } }, source = { heartbeats: 'node.yaml' };
    layerInto(config, source, { heartbeats: { daily: { frequency: '1h' } } }, 'folder.yaml', true);
    expect(config.heartbeats).toEqual({ alive: { frequency: '1s' } });   // untouched
    // nested `heartbeats` is an ordinary key, not a union block
    const c2 = {}, s2 = {};
    layerInto(c2, s2, { deep: { heartbeats: 1 } }, 'node.yaml', true);
    expect(c2).toEqual({ deep: { heartbeats: 1 } });
  });
});

// ── THREE RUNGS, one key ────────────────────────────────────────────────────
describe('three rungs — node < registry entry < entity folder, nearest wins', () => {
  const KEY = 'transcription_service';
  it('the room rung wins over both, and source names config/rooms.yaml', async () => {
    const r = makeResolver({
      node: { [KEY]: { posts_back_delay_ms: 1000 } },
      registry: registryWith({ [KEY]: { posts_back_delay_ms: 2000 } }),
      folders: { [CONV_DIR]: { [KEY]: { posts_back_delay_ms: 3000 } } },
    });
    await r.collect();
    expect(r.configFor(CONV_DIR)[KEY].posts_back_delay_ms).toBe(3000);
    expect(r.sourceFor(CONV_DIR)[KEY].posts_back_delay_ms).toBe(CONV_FILE);
  });

  it('with no folder rung the REGISTRY entry wins, and source names conversations.yaml', async () => {
    const r = makeResolver({
      node: { [KEY]: { posts_back_delay_ms: 1000 } },
      registry: registryWith({ [KEY]: { posts_back_delay_ms: 2000 } }),
    });
    await r.collect();
    expect(r.configFor(CONV_DIR)[KEY].posts_back_delay_ms).toBe(2000);
    expect(r.sourceFor(CONV_DIR)[KEY].posts_back_delay_ms).toBe(REGISTRY_FILE);
  });

  it('with neither, the NODE rung stands and source names config.yaml', async () => {
    const r = makeResolver({ node: { [KEY]: { posts_back_delay_ms: 1000 } }, registry: registryWith({}) });
    await r.collect();
    expect(r.configFor(CONV_DIR)[KEY].posts_back_delay_ms).toBe(1000);
    expect(r.sourceFor(CONV_DIR)[KEY].posts_back_delay_ms).toBe(NODE_FILE);
  });

  it('OVERRIDE is per-leaf: pinning one key does not delete the node rung siblings', async () => {
    const r = makeResolver({
      node: { [KEY]: { use_config: 'reve', reve: { fallback_order: ['cli'] }, posts_back: true } },
      registry: registryWith({}),
      folders: { [CONV_DIR]: { [KEY]: { posts_back: false } } },
    });
    await r.collect();
    const cfg = r.configFor(CONV_DIR)[KEY];
    expect(cfg).toEqual({ use_config: 'reve', reve: { fallback_order: ['cli'] }, posts_back: false });
    const src = r.sourceFor(CONV_DIR)[KEY];
    expect(src.posts_back).toBe(CONV_FILE);
    expect(src.use_config).toBe(NODE_FILE);
    expect(src.reve.fallback_order).toBe(NODE_FILE);
  });

  it('a room has two rungs (node < its rooms.yaml row) — no registry entry exists for it', async () => {
    const r = makeResolver({
      node: { warm: { idle_ttl: '1h' } },
      registry: registryWith({ warm: { idle_ttl: '5m' } }),
      folders: { [ROOM_DIR]: { warm: { idle_ttl: '30s' } } },
    });
    await r.collect();
    expect(r.configFor(ROOM_DIR).warm.idle_ttl).toBe('30s');
    expect(r.sourceFor(ROOM_DIR).warm.idle_ttl).toBe(ROOM_FILE);
    expect(r.entityFor(ROOM_DIR).kind).toBe('room');
  });
});

// ── COMBINING RULE: heartbeats UNION ────────────────────────────────────────
describe('combining rule — heartbeats UNION (every rung contributes)', () => {
  it('the node block SURVIVES a conversation declaring its own, and both entities contribute', async () => {
    const r = makeResolver({
      node: { heartbeats: { alive: { frequency: '1s' } } },
      registry: registryWith({}),
      folders: {
        [CONV_DIR]: { heartbeats: { daily: { frequency: '1h', command: 'node d.js' } } },
        [ROOM_DIR]: { heartbeats: { sweep: { frequency: '2h', command: 'node s.js' } } },
      },
    });
    const set = await r.collect();
    expect(Object.keys(set.node.config.heartbeats)).toEqual(['alive']);
    expect(Object.keys(set.entities.get(CONV_DIR).heartbeats)).toEqual(['daily']);
    expect(Object.keys(set.entities.get(ROOM_DIR).heartbeats)).toEqual(['sweep']);
    // and the union block NEVER leaks into an entity's resolved config (it is not an override)
    expect(r.configFor(CONV_DIR).heartbeats).toBeUndefined();
  });

  it('the registry entry contributes heartbeats too; a same-named folder entry OVERRIDES it (nearest wins WITHIN one entity)', async () => {
    const r = makeResolver({
      node: { heartbeats: { alive: { frequency: '1s' } } },
      registry: registryWith({ heartbeats: { daily: { frequency: '6h', command: 'node reg.js' }, only_reg: { frequency: '9h', command: 'node r.js' } } }),
      folders: { [CONV_DIR]: { heartbeats: { daily: { frequency: '1h', command: 'node folder.js' } } } },
    });
    const set = await r.collect();
    const e = set.entities.get(CONV_DIR);
    expect(e.heartbeats.daily).toEqual({ frequency: '1h', command: 'node folder.js' });
    expect(e.heartbeats.only_reg).toEqual({ frequency: '9h', command: 'node r.js' });
    expect(e.heartbeatSource.daily).toBe(CONV_FILE);
    expect(e.heartbeatSource.only_reg).toBe(REGISTRY_FILE);
  });
});

// ── COMBINING RULE: members is entity-only ──────────────────────────────────
describe('combining rule — members is ENTITY-ONLY', () => {
  it('the roster resolves verbatim and its source is config/rooms.yaml', async () => {
    const members = [{ kind: 'brain', id: 'egpt', state: 'active' }];
    const r = makeResolver({ node: {}, registry: registryWith({}), folders: { [CONV_DIR]: { members } } });
    await r.collect();
    expect(r.configFor(CONV_DIR).members).toEqual(members);
    expect(r.sourceFor(CONV_DIR).members).toBe(CONV_FILE);
    // no node rung exists, so a second entity sees no roster at all (never the neighbour's)
    expect(r.configFor(ROOM_DIR).members).toBeUndefined();
  });

  it('a roster is a LIST — replaced whole, never element-merged', async () => {
    const r = makeResolver({
      node: { members: [{ kind: 'brain', id: 'node-one', state: 'muted' }] },
      registry: registryWith({}),
      folders: { [CONV_DIR]: { members: [{ kind: 'brain', id: 'mine', state: 'active' }] } },
    });
    await r.collect();
    expect(r.configFor(CONV_DIR).members).toEqual([{ kind: 'brain', id: 'mine', state: 'active' }]);
  });
});

// ── the registry rung: config keys only, never the bookkeeping or the residents ──
describe('the registry rung contributes CONFIG, not the registry bookkeeping', () => {
  it('slug / pushedName / conversation_path / agents and the resident being blocks stay OUT of the resolved config', async () => {
    const r = makeResolver({
      node: { agents: { egpt: { default: true } } },
      registry: registryWith({
        pushedName: 'HFM', conversation_path: 'conversations/whatsapp/hfm-2606201530',
        home_dir: '/home/an', agents: { egpt: { mode: 'active' } },
        egpt: { threadId: 'abc', mode: 'mention' },
        warm: { idle_ttl: '5m' },
      }),
    });
    await r.collect();
    const cfg = r.configFor(CONV_DIR);
    expect(cfg.warm).toEqual({ idle_ttl: '5m' });          // the CONFIG key is contributed
    expect(cfg.slug).toBeUndefined();
    expect(cfg.pushedName).toBeUndefined();
    expect(cfg.conversation_path).toBeUndefined();
    expect(cfg.home_dir).toBeUndefined();
    expect(cfg.egpt).toBeUndefined();                       // a resident being is not config
    expect(cfg.agents).toEqual({ egpt: { default: true } }); // the NODE registry, unclobbered
  });
});

// ── the three aggregates ────────────────────────────────────────────────────
describe('the three aggregates live at the PROFILE ROOT (state/ hides too much)', () => {
  it('paths are ~/.egpt/{config,conversations,heartbeats}.readonly.yaml', () => {
    const r = makeResolver({});
    expect(r.paths.config).toBe(join(HOME, 'config.readonly.yaml'));
    expect(r.paths.conversations).toBe(join(HOME, 'conversations.readonly.yaml'));
    expect(r.paths.heartbeats).toBe(join(HOME, 'heartbeats.readonly.yaml'));
    expect(r.paths.heartbeats).not.toContain(join('state', 'heartbeats'));
  });

  it('writeReadonly dumps the node rung to config.readonly.yaml with its source', async () => {
    const writes = [];
    const r = makeResolver({
      node: { node_name: 'kg', warm: { idle_ttl: '1h' } },
      registry: registryWith({}),
      io: { writeFile: async (p, c) => writes.push({ p, c }), mkdir: async () => {} },
    });
    await r.collect();
    await r.writeReadonly();
    const cfgDump = writes.find((w) => w.p === r.paths.config);
    expect(cfgDump.c).toContain('DO NOT EDIT');
    expect(cfgDump.c).toContain(`source: ${NODE_FILE}`);
    expect(cfgDump.c).toContain('node_name: kg');
  });

  it('conversations.readonly.yaml carries every entity, the values its OWN rungs supplied, and a source per value', async () => {
    const writes = [];
    const r = makeResolver({
      node: { node_name: 'kg', warm: { idle_ttl: '1h' }, transcription_service: { use_config: 'reve' } },
      registry: registryWith({ warm: { idle_ttl: '5m' } }),
      folders: { [CONV_DIR]: { transcription_service: { posts_back: false } } },
      io: { writeFile: async (p, c) => writes.push({ p, c }), mkdir: async () => {} },
    });
    await r.collect();
    await r.writeReadonly();
    const dump = writes.find((w) => w.p === r.paths.conversations).c;
    const doc = YAML.parse(dump).entities;
    expect(Object.keys(doc)).toEqual(['whatsapp/hfm-2606201530', 'room/lab']);
    // a TOUCHED block shows the whole resolved chunk, each leaf naming its own rung —
    // that is the point of per-leaf provenance
    expect(doc['whatsapp/hfm-2606201530'].config).toEqual({
      warm: { idle_ttl: '5m' },
      transcription_service: { use_config: 'reve', posts_back: false },
    });
    expect(doc['whatsapp/hfm-2606201530'].source).toEqual({
      warm: { idle_ttl: REGISTRY_FILE },
      transcription_service: { use_config: NODE_FILE, posts_back: CONV_FILE },
    });
    // a key NO entity rung touches is dumped ONCE, in config.readonly.yaml — never here
    expect(dump).not.toContain('node_name');
    // an entity whose rungs supplied nothing still appears, with an empty overlay
    expect(doc['room/lab']).toMatchObject({ kind: 'room', config: {} });
  });
});

// ── re-collect picks up changes (the config-refresh-on-message-arrival trigger calls
//    collect() again via heartbeat-loader's reload() — see tests/spine-heartbeat-loader.test.mjs
//    and tests/spine-v1-boot.test.mjs for the end-to-end message-arrival proof) ──────────
describe('collect() re-run picks up changes since the last one', () => {
  it('a re-collect picks up a folder edited (and a folder ADDED) since the last one', async () => {
    let dirs = [{ dir: CONV_DIR, ns: 'whatsapp/hfm-2606201530' }];
    const folders = { [CONV_DIR]: { warm: { idle_ttl: '5m' } } };
    const r = createConfigResolver({
      getConfig: () => ({}), loadRegistry: async () => registryWith({}),
      listEntityDirs: async () => dirs,
      readEntityConfig: async (dir) => folders[dir] ?? {},
      egptHome: HOME, io: { writeFile: async () => {}, mkdir: async () => {} },
    });
    await r.collect();
    expect(r.configFor(CONV_DIR).warm.idle_ttl).toBe('5m');
    folders[CONV_DIR] = { warm: { idle_ttl: '30s' } };
    dirs = [...dirs, { dir: ROOM_DIR, ns: 'room/lab' }];
    folders[ROOM_DIR] = { warm: { idle_ttl: '9m' } };
    await r.collect();
    expect(r.configFor(CONV_DIR).warm.idle_ttl).toBe('30s');
    expect(r.configFor(ROOM_DIR).warm.idle_ttl).toBe('9m');
  });
});

// ── tolerance: nothing here is ever fatal ───────────────────────────────────
describe('tolerance', () => {
  it('an unknown dir resolves to the node rung alone (a folder born since the last collect)', async () => {
    const r = makeResolver({ node: { warm: { idle_ttl: '1h' } }, registry: registryWith({}) });
    await r.collect();
    expect(r.configFor('/nowhere').warm.idle_ttl).toBe('1h');
    expect(r.entityFor('/nowhere')).toBeNull();
  });

  it('a throwing walk / registry / folder read degrades to the node rung, logged, never throws', async () => {
    const logs = [];
    const r = createConfigResolver({
      getConfig: () => ({ warm: { idle_ttl: '1h' } }),
      loadRegistry: async () => { throw new Error('no registry'); },
      listEntityDirs: async () => [{ dir: CONV_DIR, ns: 'whatsapp/hfm-2606201530' }],
      readEntityConfig: async () => { throw new Error('bad folder'); },
      egptHome: HOME, io: { writeFile: async () => {}, mkdir: async () => {} },
      onLog: (m) => logs.push(m),
    });
    const set = await r.collect();
    expect(set.entities.get(CONV_DIR).config.warm.idle_ttl).toBe('1h');
    expect(logs.length).toBeGreaterThan(0);
  });

  it('configFor before any collect returns the node rung rather than throwing', () => {
    const r = makeResolver({ node: { warm: { idle_ttl: '2h' } } });
    expect(r.configFor(CONV_DIR).warm.idle_ttl).toBe('2h');
  });
});
