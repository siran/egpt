// tests/radio-command.test.mjs — /radio [join [<radio>]|leave] (src/spine/commands.mjs
// radio()) and Room.setRadioJoin (src/room-core.mjs). CONFIG + COMMAND ONLY: no uploader,
// no HTTP, no audio handling — this locks the STATE machine (radio.join names a RADIO — a
// key in THIS node's radio_service map — not a node; radio.hosts is operator-maintained
// and this command must never write it) and the config surface (radio_service.<name>.
// relay_password redaction lives in config-command.test.mjs).
//
// Room configs are PER-NODE, so there is no cross-node ownership to guard: /radio join
// <radio> refuses only when <radio> is not a key in THIS node's radio_service map — that
// refusal, naming what IS configured, is the core of the operator's ruling and the first
// lock below. Joining a room already joined to a DIFFERENT radio just switches it.
//
// Harness modeled on tests/rooms-members.test.mjs: a TmpRoom (real fs under a temp dir)
// injected via resolveConvRoom, so /radio exercises the real room-core round-trip.
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

function harness({ config = {} } = {}) {
  const sent = [];
  const room = new TmpRoom(join(base, 'conv'), 'conv-1');
  const resolveConvRoom = async () => room;
  const cmds = createCommands({
    getConfig: () => ({ whatsapp: { chat_id: '!conv-1' }, ...config }),
    send: async (chatId, text) => sent.push({ chatId, text }),
    resolveConvRoom,
  });
  return { cmds, sent, room };
}

const configPath = (room) => join(room.baseDir(), 'config.yaml');

// Seed the room's config.yaml with raw YAML text before a command runs (the room folder
// itself doesn't exist yet after mkdtempSync — only the temp base does).
function seed(room, text) {
  mkdirSync(room.baseDir(), { recursive: true });
  writeFileSync(configPath(room), text, 'utf8');
}

describe('THE LOCK — /radio join <radio> checks THIS node\'s own radio_service map only', () => {
  it("join nosuchradio refuses, names what IS configured, and never touches the room file", async () => {
    const { cmds, sent, room } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true } } },
    });
    await cmds.run({ ...self, body: '/radio join nosuchradio' });
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
    await cmds.run({ ...self, body: '/radio join nosuchradio' });
    expect(sent[0].text).toMatch(/no radio 'nosuchradio' on kg/);
    expect(readFileSync(cfgPath, 'utf8')).toMatch(/join:\s*wildnloyal/);
  });

  it('with nothing configured on this node, names "none"', async () => {
    const { cmds, sent } = harness({ config: { node_name: 'kg' } });
    await cmds.run({ ...self, body: '/radio join nosuchradio' });
    expect(sent[0].text).toMatch(/no radio 'nosuchradio' on kg/);
    expect(sent[0].text).toMatch(/configured: none/);
  });
});

describe('/radio status', () => {
  it('an unjoined room (no radio: block at all) reports not relaying, no crash', async () => {
    const { cmds, sent } = harness({ config: { node_name: 'kg' } });
    await cmds.run({ ...self, body: '/radio' });
    expect(sent[0].text).toMatch(/not relaying/);
  });

  it('reports the joined radio and the host count', async () => {
    const { cmds, sent, room } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true } } },
    });
    seed(room, 'radio:\n  join: wildnloyal\n  hosts:\n    "16468217865": roger\n');
    await cmds.run({ ...self, body: '/radio' });
    expect(sent[0].text).toMatch(/wildnloyal/);
    expect(sent[0].text).toMatch(/1 host mapped/);
  });
});

describe('/radio join with no argument', () => {
  it('exactly one radio configured — picks it', async () => {
    const { cmds, sent, room } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true } } },
    });
    await cmds.run({ ...self, body: '/radio join' });
    expect(sent[0].text).toMatch(/wildnloyal/);
    const after = readFileSync(configPath(room), 'utf8');
    expect(after).toMatch(/join:\s*wildnloyal/);
  });

  it('several radios configured — refuses and lists them', async () => {
    const { cmds, sent, room } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true }, otherstation: { enabled: true } } },
    });
    await cmds.run({ ...self, body: '/radio join' });
    expect(sent[0].text).toMatch(/wildnloyal/);
    expect(sent[0].text).toMatch(/otherstation/);
    expect(existsSync(configPath(room))).toBe(false);
  });

  it('none configured — says so', async () => {
    const { cmds, sent } = harness({ config: { node_name: 'kg' } });
    await cmds.run({ ...self, body: '/radio join' });
    expect(sent[0].text).toMatch(/no radio configured on kg/);
  });
});

describe('/radio join <radio>', () => {
  it('on an unjoined room writes the radio name into radio.join', async () => {
    const { cmds, sent, room } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true } } },
    });
    await cmds.run({ ...self, body: '/radio join wildnloyal' });
    expect(sent[0].text).toMatch(/wildnloyal/);
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
    expect(sent[0].text).toMatch(/switched from wildnloyal to otherstation/);
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

describe('/radio leave', () => {
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

describe('hosts count surfaced in status, never the map itself', () => {
  it('status reports the host count but never a sender id or speaker name', async () => {
    const { cmds, sent, room } = harness({ config: { node_name: 'kg' } });
    seed(room, 'radio:\n  join: wildnloyal\n  hosts:\n    "16468217865": roger\n    "5551234567": ana\n');
    await cmds.run({ ...self, body: '/radio' });
    expect(sent[0].text).toMatch(/2 hosts mapped/);
    expect(sent[0].text).not.toContain('16468217865');
    expect(sent[0].text).not.toContain('roger');
  });
});

describe('radio_service.<name>.enabled — reported per radio', () => {
  it('status notes the joined radio is disabled while still reporting real join state', async () => {
    const { cmds, sent, room } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: false } } },
    });
    seed(room, 'radio:\n  join: wildnloyal\n');
    await cmds.run({ ...self, body: '/radio' });
    expect(sent[0].text).toMatch(/wildnloyal/);
    expect(sent[0].text).toMatch(/disabled in config/);
  });

  it('join still writes real state for real even though the radio reports as disabled', async () => {
    const { cmds, sent, room } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: false } } },
    });
    await cmds.run({ ...self, body: '/radio join wildnloyal' });
    expect(sent[0].text).toMatch(/disabled in config/);
    const after = readFileSync(configPath(room), 'utf8');
    expect(after).toMatch(/join:\s*wildnloyal/);
  });

  it('joined radio absent from this node\'s map — reported as not configured here', async () => {
    const { cmds, sent, room } = harness({ config: { node_name: 'kg', radio_service: {} } });
    seed(room, 'radio:\n  join: wildnloyal\n');
    await cmds.run({ ...self, body: '/radio' });
    expect(sent[0].text).toMatch(/wildnloyal/);
    expect(sent[0].text).toMatch(/not configured on this node/);
  });

  it('radio_service.<name>.enabled: true drops the disabled note', async () => {
    const { cmds, sent, room } = harness({
      config: { node_name: 'kg', radio_service: { wildnloyal: { enabled: true } } },
    });
    seed(room, 'radio:\n  join: wildnloyal\n');
    await cmds.run({ ...self, body: '/radio' });
    expect(sent[0].text).not.toMatch(/disabled in config/);
  });
});

describe("/radio can't resolve this conversation's room", () => {
  it('replies the same message /members uses when resolveConvRoom yields null', async () => {
    const sent = [];
    const cmds = createCommands({
      getConfig: () => ({ node_name: 'kg' }),
      send: async (chatId, text) => sent.push({ chatId, text }),
      resolveConvRoom: async () => null,
    });
    await cmds.run({ ...self, body: '/radio' });
    expect(sent[0].text).toMatch(/can't resolve this conversation's room/);
  });
});
