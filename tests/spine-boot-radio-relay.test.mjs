// tests/spine-boot-radio-relay.test.mjs — src/spine/boot.mjs's createRadioNoteRelay: the
// orchestration around src/radio-relay.mjs's uploadNote. Tested directly (like
// shouldReapStrayWhisper / buildNodeIdentity / wrapCommandsForTranscript), never through a
// full boot() — no network (uploadNote is injected), no real download (readFile is
// injected), real fs only for the room's config.yaml (TmpRoom, same harness as
// tests/radio-command.test.mjs).
//
// EGPT_HOME must be set BEFORE boot.mjs is imported (egpt-home.mjs reads it once at module
// load) — same discipline tests/spine-v1-boot.test.mjs uses — even though every fs touch
// here goes through a TmpRoom whose baseDir() is overridden, never the real profile.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
// A PRIVATE profile for this file. The ROOM RUNG is now ONE shared file
// (config/rooms.yaml), so files running in parallel against the suite's shared
// throwaway profile would race on it. egpt-home.mjs freezes EGPT_HOME at module
// load, so this must run BEFORE the imports — vi.hoisted is what does that.
const _PRIVATE_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-spine-boot-radio-relay-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { ROOMS_FILE } from '../src/rooms-file.mjs';
import { rmSync as _rmRooms } from 'node:fs';
import * as YAML from 'yaml';
import { roomsFilePath } from '../src/rooms-file.mjs';

const tmpHome = join(tmpdir(), `egpt-radio-relay-boot-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.EGPT_HOME = tmpHome;

let createRadioNoteRelay, TmpRoom;
beforeAll(async () => {
  ({ createRadioNoteRelay } = await import('../src/spine/boot.mjs'));
  const { Room } = await import('../src/room-core.mjs');
  TmpRoom = class extends Room {
    constructor(dir, slug) { super(); this._dir = dir; this.slug = slug; }
    baseDir() { return this._dir; }
  };
});
afterAll(() => { delete process.env.EGPT_HOME; });

let base;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'egpt-radio-relay-')); });
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

function seed(room, text) {
  mkdirSync(room.baseDir(), { recursive: true });
  // The ROOM RUNG is config/rooms.yaml keyed by ns (operator 2026-08-24).
  mkdirSync(dirname(roomsFilePath()), { recursive: true });
  let _txt = ''; try { _txt = readFileSync(roomsFilePath(), 'utf8'); } catch { /* new file */ }
  const _doc = YAML.parseDocument(_txt);
  if (_doc.get('rooms') == null) _doc.set('rooms', _doc.createNode({}));
  for (const [k, v] of Object.entries(YAML.parse(text) ?? {})) _doc.setIn(['rooms', room.ns(), k], _doc.createNode(v));
  writeFileSync(roomsFilePath(), String(_doc), 'utf8');
}

// The station's audio meta as bridge.onMedia hands it (beeper.mjs persistMedia) — only the
// fields noteMedia reads.
const audioMeta = (over = {}) => ({
  chatID: 'chat-1', msgId: 'm1', kind: 'audio', localPath: '/tmp/note.ogg',
  mime: 'audio/ogg', fileName: 'note.ogg', ...over,
});

const voiceEv = (over = {}) => ({ surface: 'whatsapp', chatId: 'chat-1', senderId: '16468217865', ts: Date.UTC(2026, 7, 8, 17, 51, 32), msgId: 'm1', ...over });

function harness({ cfg, room, uploadNote, readFile, gate } = {}) {
  const log = [];
  const relay = createRadioNoteRelay({
    resolveConvRoom: async () => room ?? null,
    cfg: cfg ?? {},
    uploadNote: uploadNote ?? vi.fn(async () => ({ ok: true, status: 201 })),
    readFile: readFile ?? (async () => Buffer.from('audio-bytes')),
    ...(gate ? { gate } : {}),
    onLog: (m) => log.push(m),
  });
  return { relay, log };
}

describe('createRadioNoteRelay — the joined+enabled gate', () => {
  it('an unjoined room (no radio.join) uploads nothing', async () => {
    const room = new TmpRoom(join(base, 'conv'), 'conv-1');
    seed(room, 'members: []\n');
    const uploadNote = vi.fn();
    const { relay } = harness({ cfg: { radio_service: { wildnloyal: { enabled: true } } }, room, uploadNote });
    relay.noteMedia(audioMeta());
    await relay.relay(voiceEv());
    expect(uploadNote).not.toHaveBeenCalled();
  });

  it('a room joined to a radio not in THIS node\'s radio_service map uploads nothing', async () => {
    const room = new TmpRoom(join(base, 'conv'), 'conv-1');
    seed(room, 'radio:\n  join: someotherstation\n');
    const uploadNote = vi.fn();
    const { relay } = harness({ cfg: { radio_service: { wildnloyal: { enabled: true } } }, room, uploadNote });
    relay.noteMedia(audioMeta());
    await relay.relay(voiceEv());
    expect(uploadNote).not.toHaveBeenCalled();
  });

  it('a joined radio with enabled:false uploads nothing', async () => {
    const room = new TmpRoom(join(base, 'conv'), 'conv-1');
    seed(room, 'radio:\n  join: wildnloyal\n');
    const uploadNote = vi.fn();
    const { relay } = harness({ cfg: { radio_service: { wildnloyal: { enabled: false, endpoint: 'https://x', default_speaker: 'egpt' } } }, room, uploadNote });
    relay.noteMedia(audioMeta());
    await relay.relay(voiceEv());
    expect(uploadNote).not.toHaveBeenCalled();
  });

  it('a joined + enabled radio uploads, mapping the sender through radio.hosts', async () => {
    const room = new TmpRoom(join(base, 'conv'), 'conv-1');
    seed(room, 'radio:\n  join: wildnloyal\n  hosts:\n    "16468217865": roger\n');
    const uploadNote = vi.fn(async () => ({ ok: true, status: 201 }));
    const readFile = vi.fn(async () => Buffer.from('bytes'));
    const cfg = { radio_service: { wildnloyal: { enabled: true, endpoint: 'https://radio.wildnloyal.org', relay_user: 'egpt', relay_password: 'x', default_speaker: 'default-voice' } } };
    const { relay } = harness({ cfg, room, uploadNote, readFile });
    relay.noteMedia(audioMeta());
    await relay.relay(voiceEv());
    expect(uploadNote).toHaveBeenCalledTimes(1);
    const call = uploadNote.mock.calls[0][0];
    expect(call.speaker).toBe('roger');           // mapped via radio.hosts, not the default
    expect(call.radio).toBe(cfg.radio_service.wildnloyal);
    expect(call.filename).toMatch(/^2026-08-08T17-51-32-000Z-[0-9a-z]{6}\.ogg$/);
    expect(readFile).toHaveBeenCalledWith('/tmp/note.ogg');
  });

  it('a blocked sender (cfg.radio_blocked_senders) uploads nothing — operator ruling 2026-08-08: "/radio disable <person>"', async () => {
    const room = new TmpRoom(join(base, 'conv'), 'conv-1');
    seed(room, 'radio:\n  join: wildnloyal\n');
    const uploadNote = vi.fn();
    const cfg = { radio_service: { wildnloyal: { enabled: true, default_speaker: 'egpt' } }, radio_blocked_senders: ['16468217865'] };
    const { relay, log } = harness({ cfg, room, uploadNote });
    relay.noteMedia(audioMeta());
    await relay.relay(voiceEv());
    expect(uploadNote).not.toHaveBeenCalled();
    expect(log.some((l) => l.includes('blocked'))).toBe(true);
  });

  it('a sender NOT on radio_blocked_senders is unaffected by an unrelated block', async () => {
    const room = new TmpRoom(join(base, 'conv'), 'conv-1');
    seed(room, 'radio:\n  join: wildnloyal\n');
    const uploadNote = vi.fn(async () => ({ ok: true, status: 201 }));
    const cfg = { radio_service: { wildnloyal: { enabled: true, default_speaker: 'egpt' } }, radio_blocked_senders: ['someone-else'] };
    const { relay } = harness({ cfg, room, uploadNote });
    relay.noteMedia(audioMeta());
    await relay.relay(voiceEv());
    expect(uploadNote).toHaveBeenCalledTimes(1);
  });

  it('an unmapped sender falls back to the radio\'s default_speaker', async () => {
    const room = new TmpRoom(join(base, 'conv'), 'conv-1');
    seed(room, 'radio:\n  join: wildnloyal\n');   // no hosts at all
    const uploadNote = vi.fn(async () => ({ ok: true, status: 201 }));
    const cfg = { radio_service: { wildnloyal: { enabled: true, endpoint: 'https://x', default_speaker: 'egpt' } } };
    const { relay } = harness({ cfg, room, uploadNote });
    relay.noteMedia(audioMeta());
    await relay.relay(voiceEv());
    expect(uploadNote.mock.calls[0][0].speaker).toBe('egpt');
  });
});

describe('createRadioNoteRelay — reuses the SAME cached audio, never a second download', () => {
  it('with no cached audio for this note (e.g. download policy excluded it), uploads nothing', async () => {
    const room = new TmpRoom(join(base, 'conv'), 'conv-1');
    seed(room, 'radio:\n  join: wildnloyal\n');
    const uploadNote = vi.fn();
    const { relay } = harness({ cfg: { radio_service: { wildnloyal: { enabled: true } } }, room, uploadNote });
    // noteMedia never called for this chat/msgId — nothing was cached
    await relay.relay(voiceEv());
    expect(uploadNote).not.toHaveBeenCalled();
  });

  it('a non-audio attachment (kind !== "audio") is never cached', async () => {
    const room = new TmpRoom(join(base, 'conv'), 'conv-1');
    seed(room, 'radio:\n  join: wildnloyal\n');
    const uploadNote = vi.fn();
    const { relay } = harness({ cfg: { radio_service: { wildnloyal: { enabled: true } } }, room, uploadNote });
    relay.noteMedia(audioMeta({ kind: 'image' }));
    await relay.relay(voiceEv());
    expect(uploadNote).not.toHaveBeenCalled();
  });
});

// NO DEDUPE-BY-MESSAGE-ID (operator ruling 2026-08-08): only the joined node relays, once, and
// a replay/backfill of an old note arrives with ev.backlog true — humanTurn(ev) already reads
// that as non-human (src/stop-guard.mjs), so spine.mjs's gate never calls relay() for it at all
// (locked in tests/spine-radio-relay.test.mjs, the layer that actually sees ev.backlog). This
// module keeps no memory of what it already relayed.
describe('createRadioNoteRelay — the upload is an outbound message: gated by the SAME lasso every send uses', () => {
  it('routes the upload THROUGH the injected gate, never calling uploadNote directly', async () => {
    const room = new TmpRoom(join(base, 'conv'), 'conv-1');
    seed(room, 'radio:\n  join: wildnloyal\n');
    const order = [];
    const uploadNote = vi.fn(async () => { order.push('upload'); return { ok: true, status: 201 }; });
    const gate = vi.fn(async (fn) => { order.push('gate'); return fn(); });
    const cfg = { radio_service: { wildnloyal: { enabled: true, default_speaker: 'egpt' } } };
    const { relay } = harness({ cfg, room, uploadNote, gate });
    relay.noteMedia(audioMeta());
    await relay.relay(voiceEv());
    expect(gate).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['gate', 'upload']);   // the call happens INSIDE the gate, not beside it
  });

  it('a gate that refuses (the lasso already tripped) is honored — uploadNote is never invoked, and relay() does not throw', async () => {
    const room = new TmpRoom(join(base, 'conv'), 'conv-1');
    seed(room, 'radio:\n  join: wildnloyal\n');
    const uploadNote = vi.fn();
    const gate = vi.fn(async () => null);   // the real lasso.gate's shape when the ceiling is tripped
    const cfg = { radio_service: { wildnloyal: { enabled: true, default_speaker: 'egpt' } } };
    const { relay } = harness({ cfg, room, uploadNote, gate });
    relay.noteMedia(audioMeta());
    await expect(relay.relay(voiceEv())).resolves.toBeUndefined();
    expect(uploadNote).not.toHaveBeenCalled();
  });

  it('with the REAL lasso, a note counts toward the SAME ceiling a send would — a second note past the cap is refused, never reaches uploadNote', async () => {
    const { createLasso } = await import('../src/lasso.mjs');
    const lasso = createLasso({ messages: 1, windowMs: 10_000, now: () => 1000 });   // one message per window, like a busy-room trip
    const room = new TmpRoom(join(base, 'conv'), 'conv-1');
    seed(room, 'radio:\n  join: wildnloyal\n');
    const uploadNote = vi.fn(async () => ({ ok: true, status: 201 }));
    const cfg = { radio_service: { wildnloyal: { enabled: true, default_speaker: 'egpt' } } };
    const { relay } = harness({ cfg, room, uploadNote, gate: lasso.gate });

    relay.noteMedia(audioMeta({ msgId: 'm1' }));
    await relay.relay(voiceEv({ msgId: 'm1' }));
    expect(uploadNote).toHaveBeenCalledTimes(1);
    expect(lasso.stats().messages).toBe(1);   // counted exactly like an outbound send

    relay.noteMedia(audioMeta({ msgId: 'm2' }));
    await relay.relay(voiceEv({ msgId: 'm2' }));
    expect(uploadNote).toHaveBeenCalledTimes(1);   // the SAME shared ceiling refused the second note — never reached uploadNote
  });
});

describe('createRadioNoteRelay — an upload failure does not throw (the surrounding path is untouched)', () => {
  it('uploadNote resolving { ok:false } does not throw, and is logged', async () => {
    const room = new TmpRoom(join(base, 'conv'), 'conv-1');
    seed(room, 'radio:\n  join: wildnloyal\n');
    const uploadNote = vi.fn(async () => ({ ok: false, status: 404, error: 'permanent' }));
    const cfg = { radio_service: { wildnloyal: { enabled: true, default_speaker: 'egpt' } } };
    const { relay, log } = harness({ cfg, room, uploadNote });
    relay.noteMedia(audioMeta());
    await expect(relay.relay(voiceEv())).resolves.toBeUndefined();
    expect(log.some((m) => m.includes('FAILED'))).toBe(true);
  });

  it('a readFile failure (the cached local file vanished) does not throw', async () => {
    const room = new TmpRoom(join(base, 'conv'), 'conv-1');
    seed(room, 'radio:\n  join: wildnloyal\n');
    const uploadNote = vi.fn();
    const readFile = vi.fn(async () => { throw new Error('ENOENT'); });
    const cfg = { radio_service: { wildnloyal: { enabled: true, default_speaker: 'egpt' } } };
    const { relay } = harness({ cfg, room, uploadNote, readFile });
    relay.noteMedia(audioMeta());
    await expect(relay.relay(voiceEv())).resolves.toBeUndefined();
    expect(uploadNote).not.toHaveBeenCalled();
  });
});
