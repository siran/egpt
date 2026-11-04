// A group rename whose folder move fails (EBUSY, 2026-10-15 "Contoso + SI" → "SI+Contoso")
// must not split the conversation: the entry stays on the folder that exists, writers keep
// landing there, no empty folder appears at the new name, and a later message retries.
// Real fs under a private profile; only the rename is faked busy.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

const _PRIVATE_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-reslug-busy-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { rename as fsRename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createContacts } from '../src/spine/contacts.mjs';
import { createTranscript } from '../src/spine/transcript.mjs';
import { createMedia } from '../src/spine/media.mjs';
import { emptyState, ensureContact, getContact, slugDir, conversationPathOf } from '../src/conversations-state.mjs';

const SURFACE = 'whatsapp';
const CHAT = '!contoso:beeper.com';
const OLD_NAME = 'Contoso + SI (super-inteligencia)';
const NEW_NAME = 'SI+Contoso';
const settle = () => new Promise((r) => setTimeout(r, 50));

let state, oldSlug, busyCode;
const logs = [];
function services() {
  const io = {
    rename: async (from, to) => {
      if (busyCode) { const e = new Error(`${busyCode}: rename '${from}' -> '${to}'`); e.code = busyCode; throw e; }
      return fsRename(from, to);
    },
  };
  const contacts = createContacts({ loadState: async () => state, writeState: async (s) => { state = s; }, io, onLog: (l) => logs.push(l) });
  return { contacts, transcript: createTranscript({ contacts }), media: createMedia({ contacts }) };
}
const ev = (body, chatName = NEW_NAME) => ({
  surface: SURFACE, chatId: CHAT, chatName, senderId: '@an:beeper.local', senderName: 'An',
  ts: Date.UTC(2026, 9, 15, 12, 0), line: `An@[${chatName}] (12:00): ${body}`, body,
});
const surfaceDirs = () => readdirSync(dirname(slugDir(SURFACE, oldSlug)));

beforeEach(() => {
  rmSync(_PRIVATE_HOME, { recursive: true, force: true });
  logs.length = 0;
  busyCode = null;
  const ens = ensureContact(emptyState(), SURFACE, CHAT, { pushedName: OLD_NAME });
  state = ens.state;
  oldSlug = ens.slug;
});
afterAll(async () => {
  await settle();
  delete process.env.EGPT_HOME;
  rmSync(_PRIVATE_HOME, { recursive: true, force: true });
});

describe('re-slug: conversation_path follows the folder that exists', () => {
  it('EBUSY: entry keeps the old folder, writes land there, no stub folder; a later message retries and moves both together', async () => {
    mkdirSync(slugDir(SURFACE, oldSlug), { recursive: true });
    writeFileSync(join(slugDir(SURFACE, oldSlug), 'transcript.md'), 'HISTORY\n\n');
    const { transcript, media } = services();

    busyCode = 'EBUSY';
    expect(await transcript.log(ev('after rename'))).toBe(true);
    const pic = join(_PRIVATE_HOME, 'pic.png');
    writeFileSync(pic, 'png');
    const saved = await media.save({ chatID: CHAT, chatName: NEW_NAME, msgId: 'm2', senderName: 'An', ts: Date.now(), kind: 'image', mime: 'image/png', fileName: 'pic.png', localPath: pic });

    const kept = getContact(state, SURFACE, CHAT).entry;
    expect(kept.slug).toBe(oldSlug);
    expect(kept.conversation_path).toBe(conversationPathOf(SURFACE, oldSlug));
    expect(surfaceDirs()).toEqual([oldSlug]);
    const oldTranscript = readFileSync(join(slugDir(SURFACE, oldSlug), 'transcript.md'), 'utf8');
    expect(oldTranscript).toContain('HISTORY');
    expect(oldTranscript).toContain('after rename');
    expect(saved?.startsWith(slugDir(SURFACE, oldSlug))).toBe(true);
    expect(existsSync(join(slugDir(SURFACE, oldSlug), 'renames.log'))).toBe(false);
    expect(logs.some((l) => /failed/.test(l))).toBe(true);

    busyCode = null;
    expect(await transcript.log(ev('retry'))).toBe(true);
    const moved = getContact(state, SURFACE, CHAT).entry;
    expect(moved.slug).not.toBe(oldSlug);
    expect(moved.conversation_path).toBe(conversationPathOf(SURFACE, moved.slug));
    expect(surfaceDirs()).toEqual([moved.slug]);
    const newDir = slugDir(SURFACE, moved.slug);
    const t = readFileSync(join(newDir, 'transcript.md'), 'utf8');
    expect(t).toContain('HISTORY');
    expect(t).toContain('after rename');
    expect(t).toContain('retry');
    expect(existsSync(join(newDir, 'media', 'index.md'))).toBe(true);
    expect(readFileSync(join(newDir, 'renames.log'), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('ENOENT (no folder yet): adopts the new name, writer creates it, no renames.log', async () => {
    const { transcript } = services();
    expect(await transcript.log(ev('first'))).toBe(true);
    const e = getContact(state, SURFACE, CHAT).entry;
    expect(e.slug).not.toBe(oldSlug);
    expect(e.conversation_path).toBe(conversationPathOf(SURFACE, e.slug));
    expect(surfaceDirs()).toEqual([e.slug]);
    expect(existsSync(join(slugDir(SURFACE, e.slug), 'renames.log'))).toBe(false);
  });

  it('rename succeeds: folder, slug and path move together, renames.log written once', async () => {
    mkdirSync(slugDir(SURFACE, oldSlug), { recursive: true });
    writeFileSync(join(slugDir(SURFACE, oldSlug), 'transcript.md'), 'HISTORY\n\n');
    const { transcript } = services();
    expect(await transcript.log(ev('renamed'))).toBe(true);
    const e = getContact(state, SURFACE, CHAT).entry;
    expect(e.slug).not.toBe(oldSlug);
    expect(e.conversation_path).toBe(conversationPathOf(SURFACE, e.slug));
    expect(surfaceDirs()).toEqual([e.slug]);
    const t = readFileSync(join(slugDir(SURFACE, e.slug), 'transcript.md'), 'utf8');
    expect(t).toContain('HISTORY');
    expect(t).toContain('renamed');
    expect(readFileSync(join(slugDir(SURFACE, e.slug), 'renames.log'), 'utf8').trim().split('\n')).toHaveLength(1);
  });
});
