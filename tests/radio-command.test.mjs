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
import { encodeNodeSignature, renderNodeSignature } from '../src/node-signature.mjs';

class TmpRoom extends Room {
  constructor(dir, slug) { super(); this._dir = dir; this.slug = slug; }
  baseDir() { return this._dir; }
}

const self = { chatId: '!conv-1', surface: 'whatsapp' };

let base;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'egpt-radio-')); });
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

function harness({ config = {}, uploadNote, gate, listEntityDirs, fetch, io } = {}) {
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
  // A live, MUTABLE config object (not a fresh literal per call) — real boot.mjs hands
  // getConfig's closure the SAME object reference every time (`const cfg = readConfig()`),
  // which is the mechanism /radio disable relies on for taking effect with no restart.
  // A `getConfig: () => ({...})` returning a FRESH object each call would silently defeat
  // that and hide a live-mutation bug, so the harness holds one object and returns it.
  const liveConfig = { whatsapp: { chat_id: '!conv-1' }, ...config };
  // /radio disable persists via writeConfigKey — route it at a TEMP file, NEVER the real
  // profile (forbidden: writing under ~/.egpt).
  const configPath = join(base, 'config.yaml');
  const cmds = createCommands({
    getConfig: () => liveConfig,
    send: async (chatId, text) => sent.push({ chatId, text }),
    resolveConvRoom,
    roomForName,
    uploadNote: uploadNoteFn,
    gate: gateFn,
    configPath,
    ...(io ? { io } : {}),
    ...(listEntityDirs ? { listEntityDirs } : {}),
    ...(fetch ? { fetch } : {}),
  });
  return { cmds, sent, room, uploadCalls, roomForName, liveConfig, configPath };
}

const configPath = (room) => join(room.baseDir(), 'config.yaml');

// Seed a room's config.yaml with raw YAML text before a command runs (the room folder
// itself doesn't exist yet after mkdtempSync — only the temp base does).
function seed(room, text) {
  mkdirSync(room.baseDir(), { recursive: true });
  writeFileSync(configPath(room), text, 'utf8');
}

// Seed a room's transcript.md with raw entries (rs's bodyForMessageId reads this file).
function seedTranscript(room, text) {
  mkdirSync(room.baseDir(), { recursive: true });
  writeFileSync(room.transcriptPath, text, 'utf8');
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

  it('when nothing is joined, bare stays silent (silence rule, operator ruling 2026-08-08)', async () => {
    const { cmds, sent } = harness({ config: { node_name: 'kg' } });
    await cmds.run({ ...self, body: '/radio leave' });
    expect(sent).toHaveLength(0);
  });

  it('the SAME state, addressed explicitly, replies — does not crash and does not falsely claim success', async () => {
    const { cmds, sent } = harness({ config: { node_name: 'kg' } });
    await cmds.run({ ...self, body: '/radio=kg leave' });
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

  it('/radio leave all with nothing joined anywhere, bare, stays silent', async () => {
    const { cmds, sent } = harness({ config: { node_name: 'kg' }, listEntityDirs: async () => [] });
    await cmds.run({ ...self, body: '/radio leave all' });
    expect(sent).toHaveLength(0);
  });

  it('the SAME state, addressed explicitly, says so plainly, without falsely claiming success', async () => {
    const { cmds, sent } = harness({ config: { node_name: 'kg' }, listEntityDirs: async () => [] });
    await cmds.run({ ...self, body: '/radio=kg leave all' });
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

  it('/radio leave <slug> on a room that exists but is not joined, bare, stays silent and touches nothing', async () => {
    const dirLab = seedNamed('lab', 'members: []\n');
    const { cmds, sent } = harness({
      config: { node_name: 'kg' },
      listEntityDirs: async () => [{ dir: dirLab, ns: 'room/lab' }],
    });
    const before = readFileSync(join(dirLab, 'config.yaml'), 'utf8');
    await cmds.run({ ...self, body: '/radio leave lab' });
    expect(sent).toHaveLength(0);
    expect(readFileSync(join(dirLab, 'config.yaml'), 'utf8')).toBe(before);
  });

  it('the SAME state, addressed explicitly, says so plainly and touches nothing', async () => {
    const dirLab = seedNamed('lab', 'members: []\n');
    const { cmds, sent } = harness({
      config: { node_name: 'kg' },
      listEntityDirs: async () => [{ dir: dirLab, ns: 'room/lab' }],
    });
    const before = readFileSync(join(dirLab, 'config.yaml'), 'utf8');
    await cmds.run({ ...self, body: '/radio=kg leave lab' });
    expect(sent[0].text).not.toMatch(/^left\b/);
    expect(sent[0].text).toMatch(/not joined/);
    expect(readFileSync(join(dirLab, 'config.yaml'), 'utf8')).toBe(before);
  });

  it('/radio leave <slug> for a nonexistent room, bare, stays silent too', async () => {
    const { cmds, sent } = harness({ config: { node_name: 'kg' }, listEntityDirs: async () => [] });
    await cmds.run({ ...self, body: '/radio leave nosuchroom' });
    expect(sent).toHaveLength(0);
  });

  it('the SAME nonexistent-room case, addressed explicitly, says so plainly (one message covers both)', async () => {
    const { cmds, sent } = harness({ config: { node_name: 'kg' }, listEntityDirs: async () => [] });
    await cmds.run({ ...self, body: '/radio=kg leave nosuchroom' });
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

  it('no radio configured at all, bare — silence rule: stays silent (operator ruling 2026-08-08)', async () => {
    const { cmds, sent } = harness({ config: { node_name: 'kg' } });
    await cmds.run({ ...self, body: '/radio' });
    expect(sent).toHaveLength(0);
  });

  it('the SAME state, addressed explicitly — a short plain-text line, not an empty yaml fence', async () => {
    const { cmds, sent } = harness({ config: { node_name: 'kg' } });
    await cmds.run({ ...self, body: '/radio=kg' });
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

  it('not joined, bare — silence rule: stays silent, never uploads (operator ruling 2026-08-08)', async () => {
    const { cmds, sent, uploadCalls } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true, default_speaker: 'egpt' } } },
    });
    await cmds.run({ ...self, senderId: '16468217865', body: '/radio say hola' });
    expect(sent).toHaveLength(0);
    expect(uploadCalls).toHaveLength(0);
  });

  it('the SAME state, addressed explicitly — refuses with the exact string, never uploads', async () => {
    const { cmds, sent, uploadCalls } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true, default_speaker: 'egpt' } } },
    });
    await cmds.run({ ...self, senderId: '16468217865', body: '/radio=kg say hola' });
    expect(sent[0].text).toBe('not relaying — /radio join <radio> first');
    expect(uploadCalls).toHaveLength(0);
  });

  it("joined radio absent from this node's radio_service, bare — stays silent, never uploads", async () => {
    const { cmds, sent, room, uploadCalls } = harness({
      config: { node_name: 'kg', radio_service: {} },
    });
    seed(room, 'radio:\n  join: wildnloyal\n');
    await cmds.run({ ...self, senderId: '16468217865', body: '/radio say hola' });
    expect(sent).toHaveLength(0);
    expect(uploadCalls).toHaveLength(0);
  });

  it("the SAME state, addressed explicitly — refuses, never uploads", async () => {
    const { cmds, sent, room, uploadCalls } = harness({
      config: { node_name: 'kg', radio_service: {} },
    });
    seed(room, 'radio:\n  join: wildnloyal\n');
    await cmds.run({ ...self, senderId: '16468217865', body: '/radio=kg say hola' });
    expect(sent[0].text).toMatch(/wildnloyal/);
    expect(sent[0].text).toMatch(/not configured or disabled/);
    expect(uploadCalls).toHaveLength(0);
  });

  it('radio configured but disabled, bare — THE REPRODUCE-FIRST CASE (operator ruling 2026-08-08): stays silent, never uploads', async () => {
    const { cmds, sent, room, uploadCalls } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: false, default_speaker: 'egpt' } } },
    });
    seed(room, 'radio:\n  join: wildnloyal\n');
    await cmds.run({ ...self, senderId: '16468217865', body: '/radio say hola' });
    expect(sent).toHaveLength(0);
    expect(uploadCalls).toHaveLength(0);
  });

  it('the SAME state, addressed explicitly (/radio=kg say hola) — DOES reply, refuses, never uploads', async () => {
    const { cmds, sent, room, uploadCalls } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: false, default_speaker: 'egpt' } } },
    });
    seed(room, 'radio:\n  join: wildnloyal\n');
    await cmds.run({ ...self, senderId: '16468217865', body: '/radio=kg say hola' });
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

describe("/radio leave / say — can't resolve this conversation's room ALWAYS replies (the one exception, operator ruling 2026-08-08)", () => {
  it('/radio leave, bare, still replies when the room cannot be resolved', async () => {
    const sent = [];
    const cmds = createCommands({
      getConfig: () => ({ node_name: 'kg' }),
      send: async (chatId, text) => sent.push({ chatId, text }),
      resolveConvRoom: async () => null,
    });
    await cmds.run({ ...self, body: '/radio leave' });
    expect(sent[0].text).toMatch(/can't resolve this conversation's room/);
  });

  it('/radio say, bare, still replies when the room cannot be resolved', async () => {
    const sent = [];
    const cmds = createCommands({
      getConfig: () => ({ node_name: 'kg' }),
      send: async (chatId, text) => sent.push({ chatId, text }),
      resolveConvRoom: async () => null,
    });
    await cmds.run({ ...self, body: '/radio say hola' });
    expect(sent[0].text).toMatch(/can't resolve this conversation's room/);
  });
});

// Fake state/stats/<surface>/*.yaml tree for /radio disable's "contact name" resolution
// step — entries: { <surface>: { <filename.yaml>: { sender_id, name } } }.
function statsIo(entries) {
  return {
    readdir: async (dir) => {
      const last = dir.split(/[\\/]/).pop();
      return last === 'stats' ? Object.keys(entries) : Object.keys(entries[last] ?? {});
    },
    readFile: async (fp) => {
      const parts = fp.split(/[\\/]/);
      const file = parts[parts.length - 1];
      const surface = parts[parts.length - 2];
      const body = entries[surface]?.[file];
      if (!body) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return `sender_id: "${body.sender_id}"\nname: "${body.name}"\n`;
    },
  };
}

describe('/radio disable — Ruling 2 (operator 2026-08-08)', () => {
  it('bare disable disables EVERY radio on this node, live AND persisted, no restart required', async () => {
    const { cmds, sent, liveConfig, configPath } = harness({
      config: {
        node_name: 'kg',
        radio_service: {
          wildnloyal: { enabled: true, default_speaker: 'egpt' },
          otherstation: { enabled: true, default_speaker: 'egpt' },
        },
      },
    });
    await cmds.run({ ...self, body: '/radio disable' });
    expect(sent[0].text).toMatch(/disabled 2 radios on kg/);
    expect(sent[0].text).toMatch(/wildnloyal/);
    expect(sent[0].text).toMatch(/otherstation/);
    // LIVE: the same config object createCommands reads from is mutated in place.
    expect(liveConfig.radio_service.wildnloyal.enabled).toBe(false);
    expect(liveConfig.radio_service.otherstation.enabled).toBe(false);
    // PERSISTED: written to config.yaml (comment-preserving writeConfigKey).
    const onDisk = readFileSync(configPath, 'utf8');
    expect(onDisk).toMatch(/wildnloyal:\s*\n\s*enabled:\s*false/);
    expect(onDisk).toMatch(/otherstation:\s*\n\s*enabled:\s*false/);
  });

  it('THE REPRODUCE-FIRST CASE: a relay attempt made immediately after disable, same session, is refused — no restart', async () => {
    const { cmds, sent, room, uploadCalls } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true, default_speaker: 'egpt' } } },
    });
    seed(room, 'radio:\n  join: wildnloyal\n');
    await cmds.run({ ...self, body: '/radio disable' });
    sent.length = 0;   // clear the disable confirmation; only care about the say attempt below
    await cmds.run({ ...self, senderId: '16468217865', body: '/radio say hola' });
    expect(uploadCalls).toHaveLength(0);   // bare say, now silent — the radio is disabled
    expect(sent).toHaveLength(0);
  });

  it('bare disable with nothing configured on this node stays silent', async () => {
    const { cmds, sent } = harness({ config: { node_name: 'kg' } });
    await cmds.run({ ...self, body: '/radio disable' });
    expect(sent).toHaveLength(0);
  });

  it('the SAME empty state, addressed explicitly, replies', async () => {
    const { cmds, sent } = harness({ config: { node_name: 'kg' } });
    await cmds.run({ ...self, body: '/radio=kg disable' });
    expect(sent[0].text).toMatch(/no radio configured on kg/);
  });

  it("disable <radio> — only that ONE radio, the other stays enabled", async () => {
    const { cmds, sent, liveConfig, configPath } = harness({
      config: {
        node_name: 'kg',
        radio_service: {
          wildnloyal: { enabled: true, default_speaker: 'egpt' },
          otherstation: { enabled: true, default_speaker: 'egpt' },
        },
      },
    });
    await cmds.run({ ...self, body: '/radio disable wildnloyal' });
    expect(sent[0].text).toBe('disabled wildnloyal on kg');
    expect(liveConfig.radio_service.wildnloyal.enabled).toBe(false);
    expect(liveConfig.radio_service.otherstation.enabled).toBe(true);
    expect(readFileSync(configPath, 'utf8')).toMatch(/wildnloyal:\s*\n\s*enabled:\s*false/);
  });

  it("disable <node> acts ONLY on the named node and is silent elsewhere", async () => {
    // On 'kg', naming a DIFFERENT known node ('do', via account_peers) does nothing, silently.
    const onKg = harness({
      config: { node_name: 'kg', account_peers: ['kg', 'do'], radio_service: { wildnloyal: { enabled: true } } },
    });
    await onKg.cmds.run({ ...self, body: '/radio disable do' });
    expect(onKg.sent).toHaveLength(0);
    expect(onKg.liveConfig.radio_service.wildnloyal.enabled).toBe(true);   // untouched

    // On 'do' itself, the SAME bare command (independently heard, no mesh) disables its own radios.
    const onDo = harness({
      config: { node_name: 'do', account_peers: ['kg', 'do'], radio_service: { wildnloyal: { enabled: true } } },
    });
    await onDo.cmds.run({ ...self, body: '/radio disable do' });
    expect(onDo.sent[0].text).toMatch(/disabled 1 radio on do/);
    expect(onDo.liveConfig.radio_service.wildnloyal.enabled).toBe(false);
  });

  it('/radio=do disable affects ONLY do — the existing node-addressed gate filters every other node before radio() is even reached', async () => {
    // On 'kg', addressed to 'do': the top-level node gate (run()) returns before radio()
    // is called at all — total silence, not radio()'s own explicit-refusal wording.
    const onKg = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true } } },
    });
    await onKg.cmds.run({ ...self, body: '/radio=do disable' });
    expect(onKg.sent).toHaveLength(0);
    expect(onKg.liveConfig.radio_service.wildnloyal.enabled).toBe(true);

    // On 'do' itself, the SAME line is addressed to itself — acts, and replies (explicit).
    const onDo = harness({
      config: { node_name: 'do', radio_service: { wildnloyal: { enabled: true } } },
    });
    await onDo.cmds.run({ ...self, body: '/radio=do disable' });
    expect(onDo.sent[0].text).toMatch(/disabled 1 radio on do/);
    expect(onDo.liveConfig.radio_service.wildnloyal.enabled).toBe(false);
  });

  it('disable <speaker-name> — resolves via a room\'s radio.hosts map and blocks that sender id', async () => {
    const dirLab = seedNamed('lab', 'radio:\n  hosts:\n    "16468217865": roger\n');
    const { cmds, sent, liveConfig, configPath } = harness({
      config: { node_name: 'kg' },
      listEntityDirs: async () => [{ dir: dirLab, ns: 'room/lab' }],
    });
    await cmds.run({ ...self, body: '/radio disable roger' });
    expect(sent[0].text).toBe('blocked roger on kg');
    expect(liveConfig.radio_blocked_senders).toEqual(['16468217865']);
    expect(readFileSync(configPath, 'utf8')).toMatch(/radio_blocked_senders:\s*\[\s*"?16468217865"?\s*\]/);
  });

  it('disable <contact-name> — resolves via state/stats/<surface>/<id>.yaml (sender_id + name) and blocks that sender id', async () => {
    const io = statsIo({ whatsapp: { 'Sam.yaml': { sender_id: 'sam-jid-1', name: 'Sam' } } });
    const { cmds, sent, liveConfig } = harness({ config: { node_name: 'kg' }, io });
    await cmds.run({ ...self, body: '/radio disable Sam' });
    expect(sent[0].text).toBe('blocked Sam on kg');
    expect(liveConfig.radio_blocked_senders).toEqual(['sam-jid-1']);
  });

  it('disable <contact-name> matches case-insensitively', async () => {
    const io = statsIo({ whatsapp: { 'Sam.yaml': { sender_id: 'sam-jid-1', name: 'Sam' } } });
    const { cmds, sent } = harness({ config: { node_name: 'kg' }, io });
    await cmds.run({ ...self, body: '/radio disable sam' });
    expect(sent[0].text).toBe('blocked Sam on kg');
  });

  it('an ambiguous contact name (2+ candidates) refuses and lists the candidates', async () => {
    const io = statsIo({
      whatsapp: { 'Sam.yaml': { sender_id: 'sam-jid-1', name: 'Sam' } },
      telegram: { 'Sam.yaml': { sender_id: 'sam-jid-2', name: 'Sam' } },
    });
    const { cmds, sent, liveConfig } = harness({ config: { node_name: 'kg' }, io });
    await cmds.run({ ...self, body: '/radio disable Sam' });
    expect(sent[0].text).toMatch(/'Sam' matches 2:/);
    expect(sent[0].text).toMatch(/Sam \(whatsapp\)/);
    expect(sent[0].text).toMatch(/Sam \(telegram\)/);
    expect(liveConfig.radio_blocked_senders).toBeUndefined();   // refused — nothing blocked
  });

  it('a raw sender id (already id-shaped) is blocked directly when nothing else matches', async () => {
    const { cmds, sent, liveConfig } = harness({ config: { node_name: 'kg' } });
    await cmds.run({ ...self, body: '/radio disable @26087681749235:beeper.local' });
    expect(sent[0].text).toBe('blocked @26087681749235:beeper.local on kg');
    expect(liveConfig.radio_blocked_senders).toEqual(['@26087681749235:beeper.local']);
  });

  it('bare, an unmatched plain word (not id-shaped, no radio/node/speaker/contact hit) stays silent', async () => {
    const { cmds, sent, liveConfig } = harness({ config: { node_name: 'kg' } });
    await cmds.run({ ...self, body: '/radio disable nosuchthing' });
    expect(sent).toHaveLength(0);
    expect(liveConfig.radio_blocked_senders).toBeUndefined();
  });

  it('the SAME unmatched word, addressed explicitly, refuses instead of silently doing nothing', async () => {
    const { cmds, sent } = harness({ config: { node_name: 'kg' } });
    await cmds.run({ ...self, body: '/radio=kg disable nosuchthing' });
    expect(sent[0].text).toMatch(/'nosuchthing' doesn't match/);
  });

  it("a blocked person's /radio say does not upload, and replies (a fully-matched policy refusal, not a mismatch)", async () => {
    const { cmds, sent, room, uploadCalls, liveConfig } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true, default_speaker: 'egpt' } } },
    });
    seed(room, 'radio:\n  join: wildnloyal\n');
    liveConfig.radio_blocked_senders = ['16468217865'];
    await cmds.run({ ...self, senderId: '16468217865', body: '/radio say hola' });
    expect(uploadCalls).toHaveLength(0);
    expect(sent[0].text).toMatch(/blocked/i);
  });

  it('an unblocked sender in the SAME state is unaffected', async () => {
    const { cmds, sent, room, uploadCalls, liveConfig } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true, default_speaker: 'egpt' } } },
    });
    seed(room, 'radio:\n  join: wildnloyal\n');
    liveConfig.radio_blocked_senders = ['someone-else'];
    await cmds.run({ ...self, senderId: '16468217865', body: '/radio say hola' });
    expect(uploadCalls).toHaveLength(1);
    expect(sent[0].text).toBe('said as egpt');
  });
});

// ── /radio say — MULTILINE payload (operator, live: '/radio say hola\na todos' matched neither
// the node-gate nor the /radio dispatch regex, and fell through to the catch-all) ────────────
describe('/radio say — a multi-line payload is not smuggled anywhere and not mangled', () => {
  it('REPRODUCE-FIRST: a two-line say uploads, and the uploaded bytes contain BOTH lines with the newline intact', async () => {
    const { cmds, room, uploadCalls } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true, default_speaker: 'egpt' } } },
    });
    seed(room, 'radio:\n  join: wildnloyal\n');
    await cmds.run({ ...self, senderId: '16468217865', body: '/radio say hola\na todos' });
    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0].bytes.toString('utf8')).toBe('hola\na todos');
  });

  it('=<node> still binds on a multi-line say — addressed to THIS node, it uploads', async () => {
    const { cmds, room, uploadCalls } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true, default_speaker: 'egpt' } } },
    });
    seed(room, 'radio:\n  join: wildnloyal\n');
    await cmds.run({ ...self, senderId: '16468217865', body: '/radio=kg say hola\na todos' });
    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0].bytes.toString('utf8')).toBe('hola\na todos');
  });

  it('=<node> naming a DIFFERENT node on a multi-line say stays silent here (the same node gate every other command uses)', async () => {
    const { cmds, sent, room, uploadCalls } = harness({
      config: { node_name: 'kg', account_peers: ['kg', 'do'], radio_service: { wildnloyal: { enabled: true, default_speaker: 'egpt' } } },
    });
    seed(room, 'radio:\n  join: wildnloyal\n');
    await cmds.run({ ...self, senderId: '16468217865', body: '/radio=do say hola\na todos' });
    expect(sent).toHaveLength(0);
    expect(uploadCalls).toHaveLength(0);
  });

  it('remoteNode resolves the multi-line say to the OTHER node, so it travels rather than being silently dropped', () => {
    const { cmds } = harness({
      config: { node_name: 'kg', account_peers: ['kg', 'do'], radio_service: { wildnloyal: { enabled: true } } },
    });
    expect(cmds.remoteNode({ ...self, surface: 'shell', body: '/radio=do say hola\na todos' })).toBe('do');
  });

  it("LOCK — the 4004d6f smuggling guard still holds for OTHER commands: '/tabs do\\nand more' is still not node-addressed at all", () => {
    const { cmds } = harness({ config: { node_name: 'kg', account_peers: ['kg', 'do'] } });
    expect(cmds.remoteNode({ ...self, surface: 'shell', body: '/tabs do\nand more' })).toBe(null);
  });

  it("LOCK — '/tabs=do\\nand more' (explicit form) is ALSO still not node-addressed: NODE_ADDRESSABLE is untouched for /tabs", () => {
    const { cmds } = harness({ config: { node_name: 'kg', account_peers: ['kg', 'do'] } });
    expect(cmds.remoteNode({ ...self, surface: 'shell', body: '/tabs=do\nand more' })).toBe(null);
  });

  it('a multi-line /radio join is NOT given the same treatment — join/leave/disable stay single-line only', async () => {
    const { cmds, sent, room, uploadCalls } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true } } },
    });
    await cmds.run({ ...self, senderId: '16468217865', body: '/radio join wildnloyal\nand more' });
    // Falls through to the generic catch-all — same as any other unmatched multi-line command.
    expect(sent[0]?.text).toMatch(/recognized/);
    expect(uploadCalls).toHaveLength(0);
    expect(existsSync(configPath(room))).toBe(false);
  });
});

// ── rs — reply to a message with just this token, and it airs (operator 2026-08-08: "replying
// to a message with 'rs' should read the message, equivalent to a '/radio say'") ─────────────
describe('rs — the radio quick reply', () => {
  it('REPRODUCE-FIRST: rs in reply to a message uploads that message\'s body', async () => {
    const { cmds, room, uploadCalls } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true, default_speaker: 'egpt' } } },
    });
    seed(room, 'radio:\n  join: wildnloyal\n');
    seedTranscript(room, 'Bob@[chat].wa (10:00) #msg1: read this out loud\n\n');
    await cmds.run({ ...self, senderId: '16468217865', body: 'rs', replyToId: 'msg1' });
    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0].bytes.toString('utf8')).toBe('read this out loud');
  });

  it('is gated by isCommand exactly like /radio say — an authorized-only chat, self DM: yes; an ordinary chat: no', () => {
    const { cmds } = harness({ config: { node_name: 'kg' } });
    expect(cmds.isCommand({ ...self, body: 'rs' })).toBe(true);
    expect(cmds.isCommand({ chatId: '!other', surface: 'whatsapp', body: 'rs' })).toBe(false);
    expect(cmds.isCommand({ chatId: '!other', surface: 'whatsapp', body: 'rs', authorized: true })).toBe(true);
  });

  it('"rs" must be the WHOLE message — "rs please" is ordinary text, not the quick reply', () => {
    const { cmds } = harness({ config: { node_name: 'kg' } });
    expect(cmds.isCommand({ ...self, body: 'rs please' })).toBe(false);
  });

  it('a multi-line quoted body uploads with its newline intact too — the same payload path as /radio say', async () => {
    const { cmds, room, uploadCalls } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true, default_speaker: 'egpt' } } },
    });
    seed(room, 'radio:\n  join: wildnloyal\n');
    seedTranscript(room, 'Bob@[chat].wa (10:00) #msg1: hola\na todos\n\n');
    await cmds.run({ ...self, senderId: '16468217865', body: 'rs', replyToId: 'msg1' });
    expect(uploadCalls[0].bytes.toString('utf8')).toBe('hola\na todos');
  });

  it('strips the invisible node signature, the visible bridge close, and the persona stamp — none reach the upload', async () => {
    const { cmds, room, uploadCalls } = harness({
      config: {
        node_name: 'kg',
        radio_service: { wildnloyal: { enabled: true, default_speaker: 'egpt' } },
        bridge_signature_open: '🌉',
        bridge_signature_close: '💸',
        agents: { egpt: { default: true, body_emoji: '🐶', name: 'egpt' } },
      },
    });
    seed(room, 'radio:\n  join: wildnloyal\n');
    // A peer node's OWN sent reply, round-tripped back as ordinary inbound text on a shared
    // Beeper account: bridge open, persona stamp, the reply, bridge close, then the (rendered)
    // node signature the far spine appended.
    const core = ['🌉', '🐶 egpt', 'hola desde do', '💸'].join('\n') + encodeNodeSignature('do');
    const wrapped = renderNodeSignature(core);   // identity.build renders it before the transcript is ever written
    seedTranscript(room, `Someone@[chat].wa (10:00) #msg1: ${wrapped}\n\n`);
    await cmds.run({ ...self, senderId: '16468217865', body: 'rs', replyToId: 'msg1' });
    expect(uploadCalls).toHaveLength(1);
    const said = uploadCalls[0].bytes.toString('utf8');
    expect(said).not.toMatch(/💸/);
    expect(said).not.toMatch(/🐶 egpt/);
    expect(said).not.toMatch(/<do>/);
    expect(said).toBe('🌉\nhola desde do');   // bridge_signature_OPEN is untouched — only close is stripped
  });

  it('no reply-to: silent when this node cannot act (no radio joined here)', async () => {
    const { cmds, sent, uploadCalls } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true, default_speaker: 'egpt' } } },
    });
    await cmds.run({ ...self, senderId: '16468217865', body: 'rs' });
    expect(sent).toHaveLength(0);
    expect(uploadCalls).toHaveLength(0);
  });

  it('no reply-to: replies "nothing to read" when this node COULD act (joined + enabled)', async () => {
    const { cmds, sent, room, uploadCalls } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true, default_speaker: 'egpt' } } },
    });
    seed(room, 'radio:\n  join: wildnloyal\n');
    await cmds.run({ ...self, senderId: '16468217865', body: 'rs' });
    expect(sent).toEqual([{ chatId: self.chatId, text: 'nothing to read' }]);
    expect(uploadCalls).toHaveLength(0);
  });

  it('a quoted message that is empty after stripping does not upload silence', async () => {
    const { cmds, sent, room, uploadCalls } = harness({
      config: {
        node_name: 'kg',
        radio_service: { wildnloyal: { enabled: true, default_speaker: 'egpt' } },
        bridge_signature_close: '💸',
        agents: { egpt: { default: true, body_emoji: '🐶', name: 'egpt' } },
      },
    });
    seed(room, 'radio:\n  join: wildnloyal\n');
    seedTranscript(room, 'Someone@[chat].wa (10:00) #msg1: 🐶 egpt\n💸\n\n');
    await cmds.run({ ...self, senderId: '16468217865', body: 'rs', replyToId: 'msg1' });
    expect(uploadCalls).toHaveLength(0);
    expect(sent).toEqual([{ chatId: self.chatId, text: 'nothing to read' }]);
  });

  it('blocked sender — refuses exactly as /radio say does (unconditional reply, never uploads)', async () => {
    const { cmds, sent, room, uploadCalls, liveConfig } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true, default_speaker: 'egpt' } } },
    });
    seed(room, 'radio:\n  join: wildnloyal\n');
    seedTranscript(room, 'Bob@[chat].wa (10:00) #msg1: read this\n\n');
    liveConfig.radio_blocked_senders = ['16468217865'];
    await cmds.run({ ...self, senderId: '16468217865', body: 'rs', replyToId: 'msg1' });
    expect(uploadCalls).toHaveLength(0);
    expect(sent[0].text).toMatch(/blocked/i);
  });

  it('unjoined room — silent, exactly as a BARE /radio say (rs carries no =<node>, so it is always "bare")', async () => {
    const { cmds, sent, uploadCalls } = harness({
      config: { node_name: 'kg', radio_service: {} },
    });
    await cmds.run({ ...self, senderId: '16468217865', body: 'rs', replyToId: 'msg1' });
    expect(sent).toHaveLength(0);
    expect(uploadCalls).toHaveLength(0);
  });

  it('disabled radio — silent, exactly as a BARE /radio say', async () => {
    const { cmds, sent, room, uploadCalls } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: false, default_speaker: 'egpt' } } },
    });
    seed(room, 'radio:\n  join: wildnloyal\n');
    seedTranscript(room, 'Bob@[chat].wa (10:00) #msg1: read this\n\n');
    await cmds.run({ ...self, senderId: '16468217865', body: 'rs', replyToId: 'msg1' });
    expect(sent).toHaveLength(0);
    expect(uploadCalls).toHaveLength(0);
  });

  it('the upload goes through the SAME gate /radio say uses — a tripped gate uploads nothing and never throws', async () => {
    const trippedGate = async () => null;
    const { cmds, sent, room, uploadCalls } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true, default_speaker: 'egpt' } } },
      gate: trippedGate,
    });
    seed(room, 'radio:\n  join: wildnloyal\n');
    seedTranscript(room, 'Bob@[chat].wa (10:00) #msg1: read this\n\n');
    await expect(cmds.run({ ...self, senderId: '16468217865', body: 'rs', replyToId: 'msg1' })).resolves.not.toThrow();
    expect(uploadCalls).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('radio_quick_reply_string: a custom token replaces "rs"', async () => {
    const { cmds, room, uploadCalls } = harness({
      config: {
        node_name: 'kg',
        radio_quick_reply_string: 'leelo',
        radio_service: { wildnloyal: { enabled: true, default_speaker: 'egpt' } },
      },
    });
    seed(room, 'radio:\n  join: wildnloyal\n');
    seedTranscript(room, 'Bob@[chat].wa (10:00) #msg1: read this\n\n');
    expect(cmds.isCommand({ ...self, body: 'rs' })).toBe(false);   // the old default no longer fires
    await cmds.run({ ...self, senderId: '16468217865', body: 'leelo', replyToId: 'msg1' });
    expect(uploadCalls).toHaveLength(1);
  });

  it('radio_quick_reply_string: "" disables the feature — "rs" becomes ordinary text', () => {
    const { cmds } = harness({ config: { node_name: 'kg', radio_quick_reply_string: '' } });
    expect(cmds.isCommand({ ...self, body: 'rs' })).toBe(false);
  });
});
