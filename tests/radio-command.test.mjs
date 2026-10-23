// tests/radio-command.test.mjs — /radio [join [<radio>]|leave [all|<slug>]|say <text>]
// (src/spine/commands.mjs radio()) and Room.setRadioJoin (src/room-core.mjs).
//
// Room configs are PER-NODE, so there is no cross-node ownership to guard: /radio join
// <radio> refuses only when <radio> is not a key in THIS node's radio_service map — that
// refusal, naming what IS configured, is the core of the operator's ruling. Joining a room
// already joined to a DIFFERENT radio just switches it.
//
// A command is addressed to its being's node (`/e radio join`, 2026-10-19), so it always replies,
// success or refusal; the silence rule (operator ruling 2026-08-08) is left to the unaddressed rs
// quick reply. `/radio` with no verb is a NODE-WIDE status report (listeners + joined rooms per
// radio) that resolves NO current room at all.
//
// Harness modeled on tests/rooms-members.test.mjs: a TmpRoom subclass (real fs under a
// temp dir) injected via resolveConvRoom stands in for the current conversation. The OTHER
// entities (/radio leave all|<slug>) are reached through roomFromNs, which is now the plain
// (surface, slug) constructor for every ns including `room/<slug>` — so those are seeded at
// their real Room.forChat path under the SUITE's isolated EGPT_HOME (never the live
// profile; see tests/setup-egpt-home.mjs) and removed again in afterEach.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

// A PRIVATE profile for this file — seedNamed writes real folders under EGPT_HOME (roomFromNs
// is a pure constructor, not a seam), and the suite's SHARED throwaway profile is written by
// other files in parallel. egpt-home.mjs freezes EGPT_HOME at module load, so this must run
// BEFORE the imports below; vi.hoisted is what does that. (os/path are not importable in a
// hoisted block, so the temp root comes from the env — what os.tmpdir() reads anyway.)
const TEST_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-radio-command-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});
import { createCommands } from '../src/spine/commands.mjs';
import { SHELL_SURFACE } from '../src/spine/identity.mjs';
import { Room } from '../src/room-core.mjs';
import { EGPT_HOME } from '../src/egpt-home.mjs';
import * as YAML from 'yaml';
import { ROOMS_FILE } from '../src/rooms-file.mjs';
import { encodeNodeSignature, renderNodeSignature } from '../src/node-signature.mjs';

class TmpRoom extends Room {
  constructor(dir, slug) { super(); this._dir = dir; this.slug = slug; }
  baseDir() { return this._dir; }
}

const self = { chatId: '!conv-1', surface: 'whatsapp' };
// The spine's reading (classify): commandOf, then isCommand, then run. A command names its being
// (2026-10-19): `/e radio …` runs on E's node; another node's handle is no command here.
const typed = async (cmds, ev) => { const c = cmds.commandOf(ev); if (c && !c.commandElsewhere && await cmds.isCommand(c)) await cmds.run(c); return c; };
const KG_AGENTS = { egpt: { handles: ['e', 'egpt'], default: true } };
const DO_AGENTS = { egpt: { handles: ['d', 'don'], default: true } };

let base;
// Every entity dir seedNamed created, removed again after each test.
let namedDirs;
beforeEach(() => {
  // Tripwire: if vi.hoisted ever stops running before the imports, fail loudly here rather
  // than writing into the shared profile.
  expect(join(EGPT_HOME), "EGPT_HOME must be THIS file's private profile — see the vi.hoisted block").toBe(join(TEST_HOME));
  expect(EGPT_HOME).not.toBe(join(homedir(), '.egpt'));
  try { rmSync(ROOMS_FILE, { force: true }); } catch { /* none yet */ }
  base = mkdtempSync(join(tmpdir(), 'egpt-radio-'));
  namedDirs = [];
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  for (const d of namedDirs) rmSync(d, { recursive: true, force: true });
});

function harness({ config = {}, uploadNote, gate, listEntityDirs, fetch, io } = {}) {
  const sent = [];
  const room = new TmpRoom(join(base, 'conv'), 'conv-1');
  const resolveConvRoom = async () => room;
  const uploadCalls = [];
  const uploadNoteFn = uploadNote || (async (o) => { uploadCalls.push(o); return { ok: true, status: 201 }; });
  const gateFn = gate || ((fn) => fn());
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
    uploadNote: uploadNoteFn,
    gate: gateFn,
    configPath,
    ...(io ? { io } : {}),
    ...(listEntityDirs ? { listEntityDirs } : {}),
    ...(fetch ? { fetch } : {}),
  });
  return { cmds, sent, room, uploadCalls, liveConfig, configPath };
}

// The ROOM RUNG is config/rooms.yaml keyed `<surface>/<slug>` (operator
// 2026-08-24) — no room keeps a config.yaml of its own any more, so seeding and
// reading both go through that one file.
function seedRow(ns, text) {
  mkdirSync(join(EGPT_HOME, 'config'), { recursive: true });
  let existing = ''; try { existing = readFileSync(ROOMS_FILE, 'utf8'); } catch { /* new */ }
  const doc = YAML.parseDocument(existing || 'rooms:\n');
  if (doc.get('rooms') == null) doc.set('rooms', doc.createNode({}));
  const parsed = YAML.parse(text) ?? {};
  for (const [k, v] of Object.entries(parsed)) doc.setIn(['rooms', ns, k], doc.createNode(v));
  writeFileSync(ROOMS_FILE, String(doc), 'utf8');
}
const nsByDir = new Map();
const nsOf = (dir) => nsByDir.get(dir) ?? dir;
const rowText = (ns) => {
  let t = ''; try { t = readFileSync(ROOMS_FILE, 'utf8'); } catch { return ''; }
  const row = (YAML.parse(t) ?? {}).rooms?.[ns];
  return row ? YAML.stringify(row) : '';
};

function seed(room, text) {
  mkdirSync(room.baseDir(), { recursive: true });
  seedRow(room.ns(), text);
}

// Seed a room's transcript.md with raw entries (rs's bodyForMessageId reads this file).
function seedTranscript(room, text) {
  mkdirSync(room.baseDir(), { recursive: true });
  writeFileSync(room.transcriptPath, text, 'utf8');
}

// Seed an operator-named room's entity dir at the path roomFromNs('room/<name>') resolves
// to — Room.forChat('room', name).baseDir(), under the suite's isolated EGPT_HOME — so a
// /radio leave all|<slug> test seeds and reads the SAME file the command writes.
function seedNamed(name, text) {
  const room = Room.forChat('room', name);
  const dir = room.baseDir();
  nsByDir.set(dir, room.ns());
  namedDirs.push(dir);
  mkdirSync(dir, { recursive: true });
  seedRow(room.ns(), text);
  return dir;
}

describe("THE LOCK — /radio join <radio> checks THIS node's own radio_service map only", () => {
  it("join nosuchradio refuses, names what IS configured, and never touches the room file", async () => {
    const { cmds, sent, room } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true } } },
    });
    await cmds.run({ ...self, body: '/radio join nosuchradio' });
    expect(sent[0].text).toMatch(/no radio 'nosuchradio' on kg/);
    expect(sent[0].text).toMatch(/configured: wildnloyal/);
    expect(rowText(room.ns())).toBe('');   // no row written
  });

  it('refusing a bogus name on an already-joined room leaves radio.join untouched', async () => {
    const { cmds, sent, room } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true } } },
    });
    const cfgNs = room.ns();
    seed(room, 'radio:\n  join: wildnloyal\n');
    await cmds.run({ ...self, body: '/radio join nosuchradio' });
    expect(sent[0].text).toMatch(/no radio 'nosuchradio' on kg/);
    expect(rowText(cfgNs)).toMatch(/join:\s*wildnloyal/);
  });

  it('with nothing configured on this node, names "none"', async () => {
    const { cmds, sent } = harness({ config: { node_name: 'kg' } });
    await cmds.run({ ...self, body: '/radio join nosuchradio' });
    expect(sent[0].text).toMatch(/no radio 'nosuchradio' on kg/);
    expect(sent[0].text).toMatch(/configured: none/);
  });
});

describe('/radio join replies, success or refusal (silence is the rs quick reply\'s alone)', () => {
  it('nothing configured on this node: a command replies with the refusal', async () => {
    const { cmds, sent } = harness({ config: { node_name: 'kg' } });
    await cmds.run({ ...self, body: '/radio join' });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/no radio configured on kg/);
  });

  it('a SUCCESSFUL join replies — the write happened', async () => {
    const { cmds, sent, room } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true } } },
    });
    await cmds.run({ ...self, body: '/radio join wildnloyal' });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/^relaying to wildnloyal\./);
    expect(rowText(room.ns())).toMatch(/join:\s*wildnloyal/);
  });
});

describe('/radio join with no argument', () => {
  it('exactly one radio configured — picks it', async () => {
    const { cmds, sent, room } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true } } },
    });
    await cmds.run({ ...self, body: '/radio join' });
    expect(sent[0].text).toMatch(/^relaying to wildnloyal\./);
    const after = rowText(room.ns());
    expect(after).toMatch(/join:\s*wildnloyal/);
  });

  it('several radios configured — refuses and lists them', async () => {
    const { cmds, sent, room } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true }, otherstation: { enabled: true } } },
    });
    await cmds.run({ ...self, body: '/radio join' });
    expect(sent[0].text).toMatch(/wildnloyal/);
    expect(sent[0].text).toMatch(/otherstation/);
    expect(rowText(room.ns())).toBe('');   // no row written
  });

  it('none configured — says so', async () => {
    const { cmds, sent } = harness({ config: { node_name: 'kg' } });
    await cmds.run({ ...self, body: '/radio join' });
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
    expect(rowText(room.ns())).toMatch(/join:\s*wildnloyal/);
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
    const after = rowText(room.ns());
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
    const after = rowText(room.ns());
    expect(after).toMatch(/join:\s*otherstation/);
  });

  it('leaves a pre-existing radio.hosts block untouched', async () => {
    const { cmds, room } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true } } },
    });
    const cfgNs = room.ns();
    seed(room, 'radio:\n  hosts:\n    "16468217865": roger\n');
    await cmds.run({ ...self, body: '/radio join wildnloyal' });
    const after = rowText(cfgNs);
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
    const cfgNs = room.ns();
    seed(room, 'radio:\n  join: wildnloyal\n  hosts:\n    "16468217865": roger\n');
    await cmds.run({ ...self, body: '/radio join otherstation' });
    const after = rowText(cfgNs);
    expect(after).toMatch(/hosts:/);
    expect(after).toMatch(/16468217865['"]?:\s*roger/);
  });
});

describe('/radio leave (current room, unchanged)', () => {
  it('clears join but leaves radio.hosts byte-for-byte present', async () => {
    const { cmds, sent, room } = harness({ config: { node_name: 'kg' } });
    const cfgNs = room.ns();
    seed(room, 'radio:\n  join: wildnloyal\n  hosts:\n    "16468217865": roger\n');
    await cmds.run({ ...self, body: '/radio leave' });
    expect(sent[0].text).toMatch(/left wildnloyal/);
    const after = rowText(cfgNs);
    expect(after).not.toMatch(/join:\s*wildnloyal/);
    expect(after).toMatch(/hosts:/);
    expect(after).toMatch(/16468217865['"]?:\s*roger/);
  });

  it('when nothing is joined, replies — does not crash and does not falsely claim success', async () => {
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
    expect(rowText(nsOf(dirLab))).not.toMatch(/join:\s*wildnloyal/);
    expect(rowText(nsOf(dirDen))).not.toMatch(/join:\s*otherstation/);
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
    expect(rowText(nsOf(dirLab))).not.toMatch(/join:\s*wildnloyal/);
    expect(rowText(currentRoom.ns())).toMatch(/join:\s*otherstation/);
  });

  it('/radio leave <slug> matches case-insensitively', async () => {
    const dirLab = seedNamed('lab', 'radio:\n  join: wildnloyal\n');
    const { cmds, sent } = harness({
      config: { node_name: 'kg' },
      listEntityDirs: async () => [{ dir: dirLab, ns: 'room/lab' }],
    });
    await cmds.run({ ...self, body: '/radio leave LAB' });
    expect(sent[0].text).toMatch(/left lab/);
    expect(rowText(nsOf(dirLab))).not.toMatch(/join:\s*wildnloyal/);
  });

  it('/radio leave <slug> on a room that exists but is not joined says so plainly and touches nothing', async () => {
    const dirLab = seedNamed('lab', 'members: []\n');
    const { cmds, sent } = harness({
      config: { node_name: 'kg' },
      listEntityDirs: async () => [{ dir: dirLab, ns: 'room/lab' }],
    });
    const before = rowText(nsOf(dirLab));
    await cmds.run({ ...self, body: '/radio leave lab' });
    expect(sent[0].text).not.toMatch(/^left\b/);
    expect(sent[0].text).toMatch(/not joined/);
    expect(rowText(nsOf(dirLab))).toBe(before);
  });

  it('/radio leave <slug> for a nonexistent room says so plainly (one message covers both)', async () => {
    const { cmds, sent } = harness({ config: { node_name: 'kg' }, listEntityDirs: async () => [] });
    await cmds.run({ ...self, body: '/radio leave nosuchroom' });
    expect(sent[0].text).toMatch(/not joined/);
  });
});

describe('hosts survives every /radio leave path byte-for-byte', () => {
  it('leave (current room)', async () => {
    const { cmds, room } = harness({ config: { node_name: 'kg' } });
    const cfgNs = room.ns();
    seed(room, 'radio:\n  join: wildnloyal\n  hosts:\n    "16468217865": roger\n');
    await cmds.run({ ...self, body: '/radio leave' });
    const after = rowText(cfgNs);
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
    const after = rowText(nsOf(dirLab));
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
    const after = rowText(nsOf(dirLab));
    expect(after).toMatch(/hosts:/);
    expect(after).toMatch(/16468217865['"]?:\s*roger/);
  });
});

describe('/radio unknown verb', () => {
  it('replies usage and touches nothing — no file created for a room that never had one', async () => {
    const { cmds, sent, room } = harness({ config: { node_name: 'kg' } });
    await cmds.run({ ...self, body: '/radio bogus' });
    expect(sent[0].text).toMatch(/usage: \/<handle> radio/);
    expect(rowText(room.ns())).toBe('');   // no row written
  });

  it('"/radio help" also replies usage and leaves an existing config.yaml unchanged', async () => {
    const { cmds, sent, room } = harness({ config: { node_name: 'kg' } });
    const cfgNs = room.ns();
    const before = 'radio:\n  join: wildnloyal\n';
    seed(room, before);
    await cmds.run({ ...self, body: '/radio help' });
    expect(sent[0].text).toMatch(/usage: \/<handle> radio/);
    expect(rowText(cfgNs)).toBe(before);
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
    mkdirSync(dirA, { recursive: true }); seedRow('whatsapp/Reencuentro amigos', 'radio:\n  join: wildnloyal\n');
    mkdirSync(dirB, { recursive: true }); seedRow('whatsapp/Note to self', 'radio:\n  join: wildnloyal\n');
    mkdirSync(dirC, { recursive: true }); seedRow('room/lab', 'radio:\n  join: otherstation\n');
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
      config: { node_name: 'kg', agents: KG_AGENTS, radio_service: { wildnloyal: { enabled: true, default_speaker: 'egpt' } } },
    });
    await cmds.run({ ...self, senderId: '16468217865', body: '/radio say hola' });
    expect(sent[0].text).toBe('not relaying — /e radio join <radio> first');
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

  it('radio configured but disabled — replies, refuses, never uploads (REPRODUCE-FIRST, operator ruling 2026-08-08)', async () => {
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
    expect(sent[0].text).toMatch(/^usage: \/<handle> radio/);
    expect(uploadCalls).toHaveLength(0);
  });

  it('whitespace-only text — usage line, never uploads', async () => {
    const { cmds, sent, room, uploadCalls } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true, default_speaker: 'egpt' } } },
    });
    seed(room, 'radio:\n  join: wildnloyal\n');
    await cmds.run({ ...self, senderId: '16468217865', body: '/radio say    ' });
    expect(sent[0].text).toMatch(/^usage: \/<handle> radio/);
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
    expect(uploadCalls).toHaveLength(0);   // the radio is disabled
    expect(sent).toHaveLength(1);          // a command is addressed here, so it says why
    expect(sent[0].text).toMatch(/not configured or disabled on kg/);
  });

  it('disable with nothing configured on this node replies', async () => {
    const { cmds, sent } = harness({ config: { node_name: 'kg' } });
    await cmds.run({ ...self, body: '/radio disable' });
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
    // On 'kg', naming a DIFFERENT known node ('do', via peer_nodes) does nothing, silently.
    const onKg = harness({
      config: { node_name: 'kg', peer_nodes: ['kg', 'do'], radio_service: { wildnloyal: { enabled: true } } },
    });
    await onKg.cmds.run({ ...self, body: '/radio disable do' });
    expect(onKg.sent).toHaveLength(0);
    expect(onKg.liveConfig.radio_service.wildnloyal.enabled).toBe(true);   // untouched

    // On 'do' itself, the SAME bare command (independently heard, no mesh) disables its own radios.
    const onDo = harness({
      config: { node_name: 'do', peer_nodes: ['kg', 'do'], radio_service: { wildnloyal: { enabled: true } } },
    });
    await onDo.cmds.run({ ...self, body: '/radio disable do' });
    expect(onDo.sent[0].text).toMatch(/disabled 1 radio on do/);
    expect(onDo.liveConfig.radio_service.wildnloyal.enabled).toBe(false);
  });

  it('/d radio disable affects ONLY do — on kg it is another node\'s command, radio() is never reached', async () => {
    // On 'kg', typed to do's being: not a command here — total silence, not radio()'s own wording.
    const onKg = harness({
      config: { node_name: 'kg', agents: KG_AGENTS, radio_service: { wildnloyal: { enabled: true } } },
    });
    const c = await typed(onKg.cmds, { ...self, body: '/d radio disable' });
    expect(c.commandElsewhere).toBe('d');
    expect(onKg.sent).toHaveLength(0);
    expect(onKg.liveConfig.radio_service.wildnloyal.enabled).toBe(true);

    // On 'do' itself, the SAME line names its own being — acts, and replies.
    const onDo = harness({
      config: { node_name: 'do', agents: DO_AGENTS, radio_service: { wildnloyal: { enabled: true } } },
    });
    await typed(onDo.cmds, { ...self, body: '/d radio disable' });
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

  it('an unmatched plain word (not id-shaped, no radio/node/speaker/contact hit) refuses instead of silently doing nothing', async () => {
    const { cmds, sent } = harness({ config: { node_name: 'kg' } });
    await cmds.run({ ...self, body: '/radio disable nosuchthing' });
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

  it('typed to THIS node\'s being (/e radio say), a multi-line say uploads with the newline intact', async () => {
    const { cmds, room, uploadCalls } = harness({
      config: { node_name: 'kg', agents: KG_AGENTS, radio_service: { wildnloyal: { enabled: true, default_speaker: 'egpt' } } },
    });
    seed(room, 'radio:\n  join: wildnloyal\n');
    await typed(cmds, { ...self, senderId: '16468217865', body: '/e radio say hola\na todos' });
    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0].bytes.toString('utf8')).toBe('hola\na todos');
  });

  it('typed to ANOTHER node\'s being (/d radio say), a multi-line say stays silent here (no command)', async () => {
    const { cmds, sent, room, uploadCalls } = harness({
      config: { node_name: 'kg', peer_nodes: ['kg', 'do'], agents: KG_AGENTS, radio_service: { wildnloyal: { enabled: true, default_speaker: 'egpt' } } },
    });
    seed(room, 'radio:\n  join: wildnloyal\n');
    const c = await typed(cmds, { ...self, senderId: '16468217865', body: '/d radio say hola\na todos' });
    expect(c.commandElsewhere).toBe('d');
    expect(sent).toHaveLength(0);
    expect(uploadCalls).toHaveLength(0);
  });

  it('LOCK — no smuggling on a later line: a command must OPEN the message', () => {
    const { cmds } = harness({ config: { node_name: 'kg', peer_nodes: ['kg', 'do'], agents: KG_AGENTS } });
    expect(cmds.commandOf({ ...self, body: 'hola\n/e radio say x' })).toBe(null);
    expect(cmds.commandOf({ ...self, body: 'hola\n/d tabs' })).toBe(null);
  });

  it('a multi-line /radio join is NOT given the same treatment — join/leave/disable stay single-line only', async () => {
    const { cmds, sent, room, uploadCalls } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true } } },
    });
    await cmds.run({ ...self, senderId: '16468217865', body: '/radio join wildnloyal\nand more' });
    // Falls through to the generic catch-all — same as any other unmatched multi-line command.
    expect(sent[0]?.text).toMatch(/recognized/);
    expect(uploadCalls).toHaveLength(0);
    expect(rowText(room.ns())).toBe('');   // no row written
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

  it('is gated by isCommand exactly like /radio say — an authorized-only chat, self DM: yes; an ordinary chat: no', async () => {
    const { cmds } = harness({ config: { node_name: 'kg' } });
    expect(await cmds.isCommand({ ...self, body: 'rs' })).toBe(true);
    expect(await cmds.isCommand({ chatId: '!other', surface: 'whatsapp', body: 'rs' })).toBe(false);
    expect(await cmds.isCommand({ chatId: '!other', surface: 'whatsapp', body: 'rs', authorized: true })).toBe(true);
  });

  it('"rs" must be the WHOLE message — "rs please" is ordinary text, not the quick reply', async () => {
    const { cmds } = harness({ config: { node_name: 'kg' } });
    expect(await cmds.isCommand({ ...self, body: 'rs please' })).toBe(false);
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

  it('unjoined room — silent (rs is unaddressed, so the silence rule applies)', async () => {
    const { cmds, sent, uploadCalls } = harness({
      config: { node_name: 'kg', radio_service: {} },
    });
    await cmds.run({ ...self, senderId: '16468217865', body: 'rs', replyToId: 'msg1' });
    expect(sent).toHaveLength(0);
    expect(uploadCalls).toHaveLength(0);
  });

  it('disabled radio — silent (rs is unaddressed, so the silence rule applies)', async () => {
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
    expect(await cmds.isCommand({ ...self, body: 'rs' })).toBe(false);   // the old default no longer fires
    await cmds.run({ ...self, senderId: '16468217865', body: 'leelo', replyToId: 'msg1' });
    expect(uploadCalls).toHaveLength(1);
  });

  it('radio_quick_reply_string: "" disables the feature — "rs" becomes ordinary text', async () => {
    const { cmds } = harness({ config: { node_name: 'kg', radio_quick_reply_string: '' } });
    expect(await cmds.isCommand({ ...self, body: 'rs' })).toBe(false);
  });
});
