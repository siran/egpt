// tests/radio-command.test.mjs — /radio [join [<radio>]|leave [all|<slug>]|say <text>]
// (src/spine/commands.mjs radio()) and Room.setRadioJoin (src/room-core.mjs).
//
// Room configs are PER-NODE, so there is no cross-node ownership to guard: /radio join
// <radio> refuses only when <radio> is not a key in THIS node's radio_service map — that
// refusal, naming what IS configured, is the core of the operator's ruling. Joining a room
// already joined to a DIFFERENT radio just switches it.
//
// BARE `/radio join` fails SILENTLY on its three failure branches (no radio configured /
// ambiguous / unknown target) — an unaddressed sweep across nodes should not hear from a
// node with nothing set up. `/radio=<node> join` was SPECIFICALLY addressed and always
// replies (operator ruling 2026-08-08). Bare `/radio` itself is a NODE-WIDE status report
// (listeners + joined rooms per radio) that resolves NO current room at all.
//
// Harness modeled on tests/rooms-members.test.mjs: TmpRoom subclasses (real fs under a
// temp dir) injected via resolveConvRoom (the current conversation) and roomForName
// (NamedRoom-shaped listEntityDirs entries, for /radio leave all|<slug>).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommands } from '../src/spine/commands.mjs';
import { Room } from '../src/room-core.mjs';

class TmpRoom extends Room {
  constructor(dir, slug) { super(); this._dir = dir; this.slug = slug; }
  baseDir() { return this._dir; }
}

const self = { chatId: '!conv-1', surface: 'whatsapp' };

let base;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'egpt-radio-')); });
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

function harness({ config = {}, uploadNote, gate, listEntityDirs, fetch } = {}) {
  const sent = [];
  const room = new TmpRoom(join(base, 'conv'), 'conv-1');
  const resolveConvRoom = async () => room;
  const uploadCalls = [];
  const uploadNoteFn = uploadNote || (async (o) => { uploadCalls.push(o); return { ok: true, status: 201 }; });
  const gateFn = gate || ((fn) => fn());
  const namedRooms = new Map();
  const roomForName = (name) => {
    if (!namedRooms.has(name)) namedRooms.set(name, new TmpRoom(join(base, 'named', name), name));
    return namedRooms.get(name);
  };
  const cmds = createCommands({
    getConfig: () => ({ whatsapp: { chat_id: '!conv-1' }, ...config }),
    send: async (chatId, text) => sent.push({ chatId, text }),
    resolveConvRoom,
    roomForName,
    uploadNote: uploadNoteFn,
    gate: gateFn,
    ...(listEntityDirs ? { listEntityDirs } : {}),
    ...(fetch ? { fetch } : {}),
  });
  return { cmds, sent, room, uploadCalls, roomForName };
}

const configPath = (room) => join(room.baseDir(), 'config.yaml');

// Seed a room's config.yaml with raw YAML text before a command runs (the room folder
// itself doesn't exist yet after mkdtempSync — only the temp base does).
function seed(room, text) {
  mkdirSync(room.baseDir(), { recursive: true });
  writeFileSync(configPath(room), text, 'utf8');
}

// Seed a NamedRoom-shaped entity dir the harness's default roomForName also resolves to
// (join(base, 'named', name)) — so a /radio leave all|<slug> test can seed it directly and
// have roomFromNs land on the SAME file.
function seedNamed(name, text) {
  const dir = join(base, 'named', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.yaml'), text, 'utf8');
  return dir;
}

describe("THE LOCK — /radio=<node> join <radio> checks THIS node's own radio_service map only", () => {
  it("join nosuchradio refuses, names what IS configured, and never touches the room file", async () => {
    const { cmds, sent, room } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true } } },
    });
    await cmds.run({ ...self, body: '/radio=kg join nosuchradio' });
    expect(sent[0].text).toMatch(/no radio 'nosuchradio' on kg/);
    expect(sent[0].text).toMatch(/configured: wildnloyal/);
    expect(existsSync(configPath(room))).toBe(false);
  });

  it('refusing a bogus name on an already-joined room leaves radio.join untouched', async () => {
    const { cmds, sent, room } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true } } },
    });
    const cfgPath = configPath(room);
    seed(room, 'radio:\n  join: wildnloyal\n');
    await cmds.run({ ...self, body: '/radio=kg join nosuchradio' });
    expect(sent[0].text).toMatch(/no radio 'nosuchradio' on kg/);
    expect(readFileSync(cfgPath, 'utf8')).toMatch(/join:\s*wildnloyal/);
  });

  it('with nothing configured on this node, names "none"', async () => {
    const { cmds, sent } = harness({ config: { node_name: 'kg' } });
    await cmds.run({ ...self, body: '/radio=kg join nosuchradio' });
    expect(sent[0].text).toMatch(/no radio 'nosuchradio' on kg/);
    expect(sent[0].text).toMatch(/configured: none/);
  });
});

describe('bare /radio join silence — reproduce-first (operator ruling 2026-08-08)', () => {
  it('bare /radio join, nothing configured on this node, sends NOTHING', async () => {
    const { cmds, sent } = harness({ config: { node_name: 'kg' } });
    await cmds.run({ ...self, body: '/radio join' });
    expect(sent).toHaveLength(0);
  });

  it('the SAME config, addressed explicitly (/radio=kg join), DOES reply with the refusal', async () => {
    const { cmds, sent } = harness({ config: { node_name: 'kg' } });
    await cmds.run({ ...self, body: '/radio=kg join' });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/no radio configured on kg/);
  });

  it('bare /radio join <unknown target> sends NOTHING', async () => {
    const { cmds, sent } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true } } },
    });
    await cmds.run({ ...self, body: '/radio join nosuchradio' });
    expect(sent).toHaveLength(0);
  });

  it('bare /radio join, ambiguous (2+ configured, no target), sends NOTHING', async () => {
    const { cmds, sent } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true }, otherstation: { enabled: true } } },
    });
    await cmds.run({ ...self, body: '/radio join' });
    expect(sent).toHaveLength(0);
  });

  it("a bare command resolved through dispatch.default_node (raw === '', not a literal =<node>) also stays silent", async () => {
    const { cmds, sent } = harness({
      config: { node_name: 'kg', dispatch: { default_node: 'kg' } },
    });
    await cmds.run({ ...self, body: '/radio join' });
    expect(sent).toHaveLength(0);
  });

  it('a SUCCESSFUL bare join still replies — the write happened', async () => {
    const { cmds, sent, room } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true } } },
    });
    await cmds.run({ ...self, body: '/radio join wildnloyal' });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/^relaying to wildnloyal\./);
    expect(readFileSync(configPath(room), 'utf8')).toMatch(/join:\s*wildnloyal/);
  });
});

describe('/radio=<node> join with no argument', () => {
  it('exactly one radio configured — picks it (success always replies, even bare)', async () => {
    const { cmds, sent, room } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true } } },
    });
    await cmds.run({ ...self, body: '/radio join' });
    expect(sent[0].text).toMatch(/^relaying to wildnloyal\./);
    const after = readFileSync(configPath(room), 'utf8');
    expect(after).toMatch(/join:\s*wildnloyal/);
  });

  it('several radios configured, addressed explicitly — refuses and lists them', async () => {
    const { cmds, sent, room } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true }, otherstation: { enabled: true } } },
    });
    await cmds.run({ ...self, body: '/radio=kg join' });
    expect(sent[0].text).toMatch(/wildnloyal/);
    expect(sent[0].text).toMatch(/otherstation/);
    expect(existsSync(configPath(room))).toBe(false);
  });

  it('none configured, addressed explicitly — says so', async () => {
    const { cmds, sent } = harness({ config: { node_name: 'kg' } });
    await cmds.run({ ...self, body: '/radio=kg join' });
    expect(sent[0].text).toMatch(/no radio configured on kg/);
  });
});

describe("/radio join <radio> — success wording (operator's exact sentence)", () => {
  it('uses radio_service.<name>.name in the reply, and includes listen_url when set', async () => {
    const { cmds, sent, room } = harness({
      config: {
        node_name: 'kg',
        radio_service: { wildnloyal: { enabled: true, name: 'Wild n Loyal radio', listen_url: 'https://radio.wildnloyal.org/' } },
      },
    });
    await cmds.run({ ...self, body: '/radio join wildnloyal' });
    expect(sent[0].text).toBe("relaying to Wild n Loyal radio. you can listen in https://radio.wildnloyal.org/. voice notes are broadcasted to the radio's listeners.");
    expect(readFileSync(configPath(room), 'utf8')).toMatch(/join:\s*wildnloyal/);
  });

  it('falls back to the config key when name is absent', async () => {
    const { cmds, sent } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true } } },
    });
    await cmds.run({ ...self, body: '/radio join wildnloyal' });
    expect(sent[0].text).toMatch(/^relaying to wildnloyal\./);
  });

  it('omits the listen-in sentence entirely when listen_url is absent (never derived from endpoint)', async () => {
    const { cmds, sent } = harness({
      config: {
        node_name: 'kg',
        radio_service: { wildnloyal: { enabled: true, name: 'Wild n Loyal radio', endpoint: 'https://radio.wildnloyal.org' } },
      },
    });
    await cmds.run({ ...self, body: '/radio join wildnloyal' });
    expect(sent[0].text).toBe("relaying to Wild n Loyal radio. voice notes are broadcasted to the radio's listeners.");
    expect(sent[0].text).not.toMatch(/listen in/);
  });

  it("switching from a different radio reports what it switched from, then the pinned sentence for the target", async () => {
    const { cmds, sent, room } = harness({
      config: {
        node_name: 'kg',
        radio_service: {
          wildnloyal: { enabled: true, name: 'Wild n Loyal radio' },
          otherstation: { enabled: true, name: 'Other Station' },
        },
      },
    });
    seed(room, 'radio:\n  join: wildnloyal\n');
    await cmds.run({ ...self, body: '/radio join otherstation' });
    expect(sent[0].text).toBe("switched from Wild n Loyal radio — relaying to Other Station. voice notes are broadcasted to the radio's listeners.");
  });

  it('radioNote (disabled in config) still appends after the pinned sentence', async () => {
    const { cmds, sent } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: false, name: 'Wild n Loyal radio' } } },
    });
    await cmds.run({ ...self, body: '/radio join wildnloyal' });
    expect(sent[0].text).toBe("relaying to Wild n Loyal radio. voice notes are broadcasted to the radio's listeners. — disabled in config");
  });
});

describe('/radio join <radio>', () => {
  it('on an unjoined room writes the radio name into radio.join', async () => {
    const { cmds, sent, room } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true } } },
    });
    await cmds.run({ ...self, body: '/radio join wildnloyal' });
    expect(sent[0].text).toMatch(/relaying to wildnloyal/);
    const after = readFileSync(configPath(room), 'utf8');
    expect(after).toMatch(/radio:\s*\n\s*join:\s*wildnloyal/);
  });

  it('switches an existing join and says what it switched from', async () => {
    const { cmds, sent, room } = harness({
      config: {
        node_name: 'kg',
        radio_service: { wildnloyal: { enabled: true }, otherstation: { enabled: true } },
      },
    });
    seed(room, 'radio:\n  join: wildnloyal\n');
    await cmds.run({ ...self, body: '/radio join otherstation' });
    expect(sent[0].text).toMatch(/^switched from wildnloyal — relaying to otherstation\./);
    const after = readFileSync(configPath(room), 'utf8');
    expect(after).toMatch(/join:\s*otherstation/);
  });

  it('leaves a pre-existing radio.hosts block untouched', async () => {
    const { cmds, room } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true } } },
    });
    const cfgPath = configPath(room);
    seed(room, 'radio:\n  hosts:\n    "16468217865": roger\n');
    await cmds.run({ ...self, body: '/radio join wildnloyal' });
    const after = readFileSync(cfgPath, 'utf8');
    expect(after).toMatch(/hosts:/);
    expect(after).toMatch(/16468217865['"]?:\s*roger/);
    expect(after).toMatch(/join:\s*wildnloyal/);
  });

  it('hosts survives a switch byte-for-byte', async () => {
    const { cmds, room } = harness({
      config: {
        node_name: 'kg',
        radio_service: { wildnloyal: { enabled: true }, otherstation: { enabled: true } },
      },
    });
    const cfgPath = configPath(room);
    seed(room, 'radio:\n  join: wildnloyal\n  hosts:\n    "16468217865": roger\n');
    await cmds.run({ ...self, body: '/radio join otherstation' });
    const after = readFileSync(cfgPath, 'utf8');
    expect(after).toMatch(/hosts:/);
    expect(after).toMatch(/16468217865['"]?:\s*roger/);
  });
});

describe('/radio leave (current room, unchanged)', () => {
  it('clears join but leaves radio.hosts byte-for-byte present', async () => {
    const { cmds, sent, room } = harness({ config: { node_name: 'kg' } });
    const cfgPath = configPath(room);
    seed(room, 'radio:\n  join: wildnloyal\n  hosts:\n    "16468217865": roger\n');
    await cmds.run({ ...self, body: '/radio leave' });
    expect(sent[0].text).toMatch(/left wildnloyal/);
    const after = readFileSync(cfgPath, 'utf8');
    expect(after).not.toMatch(/join:\s*wildnloyal/);
    expect(after).toMatch(/hosts:/);
    expect(after).toMatch(/16468217865['"]?:\s*roger/);
  });

  it('when nothing is joined, does not crash and does not falsely claim success', async () => {
    const { cmds, sent } = harness({ config: { node_name: 'kg' } });
    await cmds.run({ ...self, body: '/radio leave' });
    expect(sent[0].text).not.toMatch(/^left\b/);
    expect(sent[0].text).toMatch(/nothing to leave/);
  });
});

describe('/radio leave all | <slug> — other rooms on this node, via the shared listEntityDirs enumeration', () => {
  it('/radio leave all clears every joined room on this node and reports the count', async () => {
    const dirLab = seedNamed('lab', 'radio:\n  join: wildnloyal\n');
    const dirDen = seedNamed('den', 'radio:\n  join: otherstation\n');
    const { cmds, sent } = harness({
      config: { node_name: 'kg' },
      listEntityDirs: async () => [
        { dir: dirLab, ns: 'room/lab' },
        { dir: dirDen, ns: 'room/den' },
      ],
    });
    await cmds.run({ ...self, body: '/radio leave all' });
    expect(sent[0].text).toMatch(/left 2 rooms/);
    expect(readFileSync(join(dirLab, 'config.yaml'), 'utf8')).not.toMatch(/join:\s*wildnloyal/);
    expect(readFileSync(join(dirDen, 'config.yaml'), 'utf8')).not.toMatch(/join:\s*otherstation/);
  });

  it('/radio leave all with nothing joined anywhere says so plainly, without falsely claiming success', async () => {
    const { cmds, sent } = harness({ config: { node_name: 'kg' }, listEntityDirs: async () => [] });
    await cmds.run({ ...self, body: '/radio leave all' });
    expect(sent[0].text).not.toMatch(/^left\b/);
    expect(sent[0].text).toMatch(/nothing to leave/);
  });

  it('/radio leave <slug> targets that one room from a DIFFERENT current room/channel than the target', async () => {
    const dirLab = seedNamed('lab', 'radio:\n  join: wildnloyal\n');
    const { cmds, sent, room: currentRoom } = harness({
      config: { node_name: 'kg' },
      listEntityDirs: async () => [{ dir: dirLab, ns: 'room/lab' }],
    });
    // The CURRENT conversation (self) is joined to a DIFFERENT radio — /radio leave lab
    // must not touch it, only the named room 'lab'.
    seed(currentRoom, 'radio:\n  join: otherstation\n');
    await cmds.run({ ...self, body: '/radio leave lab' });
    expect(sent[0].text).toMatch(/left lab/);
    expect(readFileSync(join(dirLab, 'config.yaml'), 'utf8')).not.toMatch(/join:\s*wildnloyal/);
    expect(readFileSync(configPath(currentRoom), 'utf8')).toMatch(/join:\s*otherstation/);
  });

  it('/radio leave <slug> matches case-insensitively', async () => {
    const dirLab = seedNamed('lab', 'radio:\n  join: wildnloyal\n');
    const { cmds, sent } = harness({
      config: { node_name: 'kg' },
      listEntityDirs: async () => [{ dir: dirLab, ns: 'room/lab' }],
    });
    await cmds.run({ ...self, body: '/radio leave LAB' });
    expect(sent[0].text).toMatch(/left lab/);
    expect(readFileSync(join(dirLab, 'config.yaml'), 'utf8')).not.toMatch(/join:\s*wildnloyal/);
  });

  it('/radio leave <slug> on a room that exists but is not joined says so plainly and touches nothing', async () => {
    const dirLab = seedNamed('lab', 'members: []\n');
    const { cmds, sent } = harness({
      config: { node_name: 'kg' },
      listEntityDirs: async () => [{ dir: dirLab, ns: 'room/lab' }],
    });
    const before = readFileSync(join(dirLab, 'config.yaml'), 'utf8');
    await cmds.run({ ...self, body: '/radio leave lab' });
    expect(sent[0].text).not.toMatch(/^left\b/);
    expect(sent[0].text).toMatch(/not joined/);
    expect(readFileSync(join(dirLab, 'config.yaml'), 'utf8')).toBe(before);
  });

  it('/radio leave <slug> for a nonexistent room says so plainly too (one message covers both)', async () => {
    const { cmds, sent } = harness({ config: { node_name: 'kg' }, listEntityDirs: async () => [] });
    await cmds.run({ ...self, body: '/radio leave nosuchroom' });
    expect(sent[0].text).toMatch(/not joined/);
  });
});

describe('hosts survives every /radio leave path byte-for-byte', () => {
  it('leave (current room)', async () => {
    const { cmds, room } = harness({ config: { node_name: 'kg' } });
    const cfgPath = configPath(room);
    seed(room, 'radio:\n  join: wildnloyal\n  hosts:\n    "16468217865": roger\n');
    await cmds.run({ ...self, body: '/radio leave' });
    const after = readFileSync(cfgPath, 'utf8');
    expect(after).toMatch(/hosts:/);
    expect(after).toMatch(/16468217865['"]?:\s*roger/);
  });

  it('leave all', async () => {
    const dirLab = seedNamed('lab', 'radio:\n  join: wildnloyal\n  hosts:\n    "16468217865": roger\n');
    const { cmds } = harness({
      config: { node_name: 'kg' },
      listEntityDirs: async () => [{ dir: dirLab, ns: 'room/lab' }],
    });
    await cmds.run({ ...self, body: '/radio leave all' });
    const after = readFileSync(join(dirLab, 'config.yaml'), 'utf8');
    expect(after).toMatch(/hosts:/);
    expect(after).toMatch(/16468217865['"]?:\s*roger/);
  });

  it('leave <slug>', async () => {
    const dirLab = seedNamed('lab', 'radio:\n  join: wildnloyal\n  hosts:\n    "16468217865": roger\n');
    const { cmds } = harness({
      config: { node_name: 'kg' },
      listEntityDirs: async () => [{ dir: dirLab, ns: 'room/lab' }],
    });
    await cmds.run({ ...self, body: '/radio leave lab' });
    const after = readFileSync(join(dirLab, 'config.yaml'), 'utf8');
    expect(after).toMatch(/hosts:/);
    expect(after).toMatch(/16468217865['"]?:\s*roger/);
  });
});

describe('/radio unknown verb', () => {
  it('replies usage and touches nothing — no file created for a room that never had one', async () => {
    const { cmds, sent, room } = harness({ config: { node_name: 'kg' } });
    await cmds.run({ ...self, body: '/radio bogus' });
    expect(sent[0].text).toMatch(/usage: \/radio/);
    expect(existsSync(configPath(room))).toBe(false);
  });

  it('"/radio help" also replies usage and leaves an existing config.yaml unchanged', async () => {
    const { cmds, sent, room } = harness({ config: { node_name: 'kg' } });
    const cfgPath = configPath(room);
    const before = 'radio:\n  join: wildnloyal\n';
    seed(room, before);
    await cmds.run({ ...self, body: '/radio help' });
    expect(sent[0].text).toMatch(/usage: \/radio/);
    expect(readFileSync(cfgPath, 'utf8')).toBe(before);
  });
});

describe('bare /radio — node-wide YAML status report', () => {
  it('works from Self (or any channel) — never resolves a current room at all', async () => {
    const sent = [];
    let convRoomCalled = false;
    const cmds = createCommands({
      getConfig: () => ({ node_name: 'kg', radio_service: { wildnloyal: { enabled: true } } }),
      send: async (chatId, text) => sent.push({ chatId, text }),
      resolveConvRoom: async () => { convRoomCalled = true; return null; },
      listEntityDirs: async () => [],
    });
    await cmds.run({ chatId: 'self', surface: 'whatsapp', body: '/radio' });
    expect(convRoomCalled).toBe(false);
    expect(sent[0].text).toMatch(/```yaml/);
    expect(sent[0].text).toMatch(/wildnloyal:/);
  });

  it('no radio configured at all — a short plain-text line, not an empty yaml fence', async () => {
    const { cmds, sent } = harness({ config: { node_name: 'kg' } });
    await cmds.run({ ...self, body: '/radio' });
    expect(sent[0].text).toBe('no radio configured on kg');
  });

  it('lists joined rooms grouped correctly per radio, listeners unknown when fetch rejects', async () => {
    const dirA = join(base, 'ent', 'a');
    const dirB = join(base, 'ent', 'b');
    const dirC = join(base, 'ent', 'c');
    mkdirSync(dirA, { recursive: true }); writeFileSync(join(dirA, 'config.yaml'), 'radio:\n  join: wildnloyal\n', 'utf8');
    mkdirSync(dirB, { recursive: true }); writeFileSync(join(dirB, 'config.yaml'), 'radio:\n  join: wildnloyal\n', 'utf8');
    mkdirSync(dirC, { recursive: true }); writeFileSync(join(dirC, 'config.yaml'), 'radio:\n  join: otherstation\n', 'utf8');
    const { cmds, sent } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true }, otherstation: { enabled: true } } },
      listEntityDirs: async () => [
        { dir: dirA, ns: 'whatsapp/Reencuentro amigos' },
        { dir: dirB, ns: 'whatsapp/Note to self' },
        { dir: dirC, ns: 'room/lab' },
      ],
      fetch: async () => { throw new Error('network disabled in tests'); },
    });
    await cmds.run({ ...self, body: '/radio' });
    const text = sent[0].text;
    expect(text).toContain('wildnloyal:');
    expect(text).toContain('otherstation:');
    expect(text).toContain('    - Reencuentro amigos');
    expect(text).toContain('    - Note to self');
    expect(text).toContain('    - lab');
    // an entity not joined to anything contributes nothing, no crash
    expect((text.match(/listeners: unknown/g) || []).length).toBe(2);
  });

  it('empty joined list renders joined: []', async () => {
    const { cmds, sent } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true } } },
      listEntityDirs: async () => [],
    });
    await cmds.run({ ...self, body: '/radio' });
    expect(sent[0].text).toContain('  joined: []');
  });

  it('listeners: sums icestats.source across an array of mounts', async () => {
    const { cmds, sent } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true, listen_url: 'https://radio.example.org/' } } },
      listEntityDirs: async () => [],
      fetch: async () => ({ ok: true, json: async () => ({ icestats: { source: [{ listeners: 3 }, { listeners: 4 }] } }) }),
    });
    await cmds.run({ ...self, body: '/radio' });
    expect(sent[0].text).toContain('  listeners: 7');
  });

  it('listeners: a single mount (icestats.source as an object, not an array) is handled', async () => {
    const { cmds, sent } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true, endpoint: 'https://radio.example.org' } } },
      listEntityDirs: async () => [],
      fetch: async () => ({ ok: true, json: async () => ({ icestats: { source: { listeners: 5 } } }) }),
    });
    await cmds.run({ ...self, body: '/radio' });
    expect(sent[0].text).toContain('  listeners: 5');
  });

  it('prefers listen_url over endpoint for the probe URL', async () => {
    let calledUrl = null;
    const { cmds } = harness({
      config: {
        node_name: 'kg',
        radio_service: { wildnloyal: { enabled: true, listen_url: 'https://listen.example.org/', endpoint: 'https://api.example.org' } },
      },
      listEntityDirs: async () => [],
      fetch: async (url) => { calledUrl = url; return { ok: true, json: async () => ({ icestats: { source: [] } }) }; },
    });
    await cmds.run({ ...self, body: '/radio' });
    expect(calledUrl).toBe('https://listen.example.org/status-json.xsl');
  });

  it('non-2xx response — listeners: unknown, never throws, other radios still render fully', async () => {
    const { cmds, sent } = harness({
      config: {
        node_name: 'kg',
        radio_service: {
          broken: { enabled: true, endpoint: 'https://broken.example.org' },
          fine: { enabled: true, endpoint: 'https://fine.example.org' },
        },
      },
      listEntityDirs: async () => [],
      fetch: async (url) => (String(url).includes('broken')
        ? { ok: false, status: 500, json: async () => ({}) }
        : { ok: true, json: async () => ({ icestats: { source: { listeners: 2 } } }) }),
    });
    await expect(cmds.run({ ...self, body: '/radio' })).resolves.not.toThrow();
    const text = sent[0].text;
    expect(text).toContain('broken:');
    expect(text).toContain('fine:');
    expect(text).toContain('  listeners: 2');
    expect(text.split('broken:')[1].split('fine:')[0]).toContain('listeners: unknown');
  });

  it('bad JSON (json() rejects) — listeners: unknown, never throws', async () => {
    const { cmds, sent } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true, endpoint: 'https://radio.example.org' } } },
      listEntityDirs: async () => [],
      fetch: async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }),
    });
    await expect(cmds.run({ ...self, body: '/radio' })).resolves.not.toThrow();
    expect(sent[0].text).toContain('  listeners: unknown');
  });

  it('no icestats.source at all — listeners: unknown', async () => {
    const { cmds, sent } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true, endpoint: 'https://radio.example.org' } } },
      listEntityDirs: async () => [],
      fetch: async () => ({ ok: true, json: async () => ({}) }),
    });
    await cmds.run({ ...self, body: '/radio' });
    expect(sent[0].text).toContain('  listeners: unknown');
  });

  it('no listen_url and no endpoint — listeners: unknown, fetch is never called', async () => {
    let called = false;
    const { cmds, sent } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true } } },
      listEntityDirs: async () => [],
      fetch: async () => { called = true; throw new Error('should not be called'); },
    });
    await cmds.run({ ...self, body: '/radio' });
    expect(called).toBe(false);
    expect(sent[0].text).toContain('  listeners: unknown');
  });
});

describe('/radio say <text> — uploads through the SAME uploader/gate the voice-note relay uses', () => {
  it('joined to an enabled radio with a mapped speaker: uploads a .md note and replies said as <speaker>', async () => {
    const { cmds, sent, room, uploadCalls } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true, default_speaker: 'egpt' } } },
    });
    seed(room, 'radio:\n  join: wildnloyal\n  hosts:\n    "16468217865": roger\n');
    await cmds.run({ ...self, senderId: '16468217865', body: '/radio say hola' });
    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0].filename).toMatch(/\.md$/);
    expect(uploadCalls[0].bytes.toString('utf8')).toBe('hola');
    expect(uploadCalls[0].speaker).toBe('roger');
    expect(sent[0].text).toBe('said as roger');
  });

  it('not joined — refuses with the exact string, never uploads', async () => {
    const { cmds, sent, uploadCalls } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true, default_speaker: 'egpt' } } },
    });
    await cmds.run({ ...self, senderId: '16468217865', body: '/radio say hola' });
    expect(sent[0].text).toBe('not relaying — /radio join <radio> first');
    expect(uploadCalls).toHaveLength(0);
  });

  it("joined radio absent from this node's radio_service — refuses, never uploads", async () => {
    const { cmds, sent, room, uploadCalls } = harness({
      config: { node_name: 'kg', radio_service: {} },
    });
    seed(room, 'radio:\n  join: wildnloyal\n');
    await cmds.run({ ...self, senderId: '16468217865', body: '/radio say hola' });
    expect(sent[0].text).toMatch(/wildnloyal/);
    expect(sent[0].text).toMatch(/not configured or disabled/);
    expect(uploadCalls).toHaveLength(0);
  });

  it('radio configured but disabled — refuses, never uploads', async () => {
    const { cmds, sent, room, uploadCalls } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: false, default_speaker: 'egpt' } } },
    });
    seed(room, 'radio:\n  join: wildnloyal\n');
    await cmds.run({ ...self, senderId: '16468217865', body: '/radio say hola' });
    expect(sent[0].text).toMatch(/not configured or disabled/);
    expect(uploadCalls).toHaveLength(0);
  });

  it("unmapped sender falls back to the radio's default_speaker", async () => {
    const { cmds, sent, room, uploadCalls } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true, default_speaker: 'egpt' } } },
    });
    seed(room, 'radio:\n  join: wildnloyal\n  hosts:\n    "16468217865": roger\n');
    await cmds.run({ ...self, senderId: 'someone-else', body: '/radio say hola' });
    expect(uploadCalls[0].speaker).toBe('egpt');
    expect(sent[0].text).toBe('said as egpt');
  });

  it('mapped sender uses their own mapped speaker, not the default', async () => {
    const { cmds, sent, room, uploadCalls } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true, default_speaker: 'egpt' } } },
    });
    seed(room, 'radio:\n  join: wildnloyal\n  hosts:\n    "16468217865": roger\n');
    await cmds.run({ ...self, senderId: '16468217865', body: '/radio say hola' });
    expect(uploadCalls[0].speaker).toBe('roger');
    expect(sent[0].text).toBe('said as roger');
  });

  it('no text — usage line, never uploads', async () => {
    const { cmds, sent, room, uploadCalls } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true, default_speaker: 'egpt' } } },
    });
    seed(room, 'radio:\n  join: wildnloyal\n');
    await cmds.run({ ...self, senderId: '16468217865', body: '/radio say' });
    expect(sent[0].text).toMatch(/^usage: \/radio/);
    expect(uploadCalls).toHaveLength(0);
  });

  it('whitespace-only text — usage line, never uploads', async () => {
    const { cmds, sent, room, uploadCalls } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true, default_speaker: 'egpt' } } },
    });
    seed(room, 'radio:\n  join: wildnloyal\n');
    await cmds.run({ ...self, senderId: '16468217865', body: '/radio say    ' });
    expect(sent[0].text).toMatch(/^usage: \/radio/);
    expect(uploadCalls).toHaveLength(0);
  });

  it('filename ends in .md and matches the ISO-timestamp shape', async () => {
    const { cmds, room, uploadCalls } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true, default_speaker: 'egpt' } } },
    });
    seed(room, 'radio:\n  join: wildnloyal\n');
    await cmds.run({ ...self, senderId: '16468217865', body: '/radio say hola' });
    expect(uploadCalls[0].filename).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-.*\.md$/);
  });

  it('a tripped gate (returns null) — never uploads, never throws, no failure message', async () => {
    const trippedGate = async () => null;
    const { cmds, sent, room, uploadCalls } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true, default_speaker: 'egpt' } } },
      gate: trippedGate,
    });
    seed(room, 'radio:\n  join: wildnloyal\n');
    await expect(cmds.run({ ...self, senderId: '16468217865', body: '/radio say hola' })).resolves.not.toThrow();
    expect(uploadCalls).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('a passthrough gate that DOES admit lets the call through normally', async () => {
    const passthroughGate = (fn) => fn();
    const { cmds, sent, room, uploadCalls } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true, default_speaker: 'egpt' } } },
      gate: passthroughGate,
    });
    seed(room, 'radio:\n  join: wildnloyal\n');
    await cmds.run({ ...self, senderId: '16468217865', body: '/radio say hola' });
    expect(uploadCalls).toHaveLength(1);
    expect(sent[0].text).toBe('said as egpt');
  });

  it('text over 500 chars is still uploaded, and the reply explains the length/delay', async () => {
    const longText = 'x'.repeat(501);
    const { cmds, sent, room, uploadCalls } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true, default_speaker: 'egpt' } } },
    });
    seed(room, 'radio:\n  join: wildnloyal\n');
    await cmds.run({ ...self, senderId: '16468217865', body: `/radio say ${longText}` });
    expect(uploadCalls).toHaveLength(1);
    expect(sent[0].text).toMatch(/said as egpt/);
    expect(sent[0].text).toMatch(/501/);
  });

  it('an upload failure is reported distinctly in the reply and does not throw', async () => {
    const failingUpload = async () => ({ ok: false, error: 'permanent', status: 404 });
    const { cmds, sent, room, uploadCalls } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true, default_speaker: 'egpt' } } },
      uploadNote: failingUpload,
    });
    seed(room, 'radio:\n  join: wildnloyal\n');
    await expect(cmds.run({ ...self, senderId: '16468217865', body: '/radio say hola' })).resolves.not.toThrow();
    expect(sent[0].text).toMatch(/radio say failed/);
    expect(sent[0].text).toMatch(/permanent/);
    expect(sent[0].text).toMatch(/404/);
  });
});

describe("/radio join — can't resolve this conversation's room", () => {
  it('replies the same message /members uses when resolveConvRoom yields null (always, regardless of addressing)', async () => {
    const sent = [];
    const cmds = createCommands({
      getConfig: () => ({ node_name: 'kg', radio_service: { wildnloyal: { enabled: true } } }),
      send: async (chatId, text) => sent.push({ chatId, text }),
      resolveConvRoom: async () => null,
    });
    await cmds.run({ ...self, body: '/radio join wildnloyal' });
    expect(sent[0].text).toMatch(/can't resolve this conversation's room/);
  });
});
