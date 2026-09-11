// agents-cli-store-moves.test.mjs — A RETIRING THREAD'S CLI STORE MOVES WITH ITS RECORD.
//
// THE DEFECT (operator 2026-09-11). 1087b63 gave every sandboxed being its own Claude Code
// session store at ~/.egpt-jsonl/<threadId> — it had to leave the leased pool account's profile,
// which setup/sandbox-logon-launcher.ps1 scrubs on every lease (src/sandbox-cli-session.mjs's
// CONFIG_DIR_ENV note). Nothing then ever moved or removed it. Both verbs that RETIRE a thread
// walked away from one:
//
//   · /agents rethread — rolls transcript.md into transcripts/<retiring thread>.md and mints a
//     new thread. The old store stayed at ~/.egpt-jsonl/<old>.
//   · /agents reset — renames the whole conversation folder into conversations/archive/. Same.
//
// The directory therefore grew monotonically, but the SIZE is the lesser half. An orphan there is
// a bare UUID and NOTHING else — no conversation, no being, no date. You cannot tell whose memory
// it was, so you can neither restore it nor decide to drop it.
//
// THE RULING: MOVE IT, DO NOT DELETE IT. `reset` archives and never deletes, and this file is not
// a copy of transcript.md — it is the MODEL's own memory of the thread, the transcript a resumed
// turn reads. It goes where the record it belongs to went, under the same thread id, in the very
// folder that already holds retired threads:
//
//   rethread → <room>/transcripts/<threadId>.cli/
//   reset    → <archived folder>/transcripts/<threadId>.cli/
//
// AND IT NEVER BREAKS THE VERB. The move runs LAST, after the roll and after the archive rename,
// so the verb's real work is already complete; a store that cannot be moved is reported — in the
// reply and in the log, naming where it was left — and the verb still succeeds.
//
// KNOWN GAP, deliberately not covered here: a store orphaned by brainpool.mjs's own fresh-thread
// retry passes through NEITHER verb, so it is still left behind. Out of scope for this change.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// A PRIVATE profile for this file — egpt-home.mjs freezes EGPT_HOME at module load, so it must be
// set BEFORE the imports below; vi.hoisted is what does that. Private (not the suite's shared
// throwaway) because every case here does REAL fs work in the conversation tree — the whole point
// is that a directory really moved — and files running in parallel would race on it.
const _PRIVATE_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-agents-cli-store-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, mkdtempSync } from 'node:fs';
import { rename as fsRename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommands } from '../src/spine/commands.mjs';
import { Room } from '../src/room-core.mjs';
import { EGPT_HOME } from '../src/egpt-home.mjs';
import { emptyState, ensureContact, getContact, patchContact } from '../src/conversations-state.mjs';

const JID = '1234@s.whatsapp.net';
const SURFACE = 'whatsapp';
const ARCHIVE_ROOT = join(EGPT_HOME, 'conversations', 'archive');

let storeRoot;
const storeRoots = [];
beforeEach(() => {
  rmSync(EGPT_HOME, { recursive: true, force: true });
  // The store root is INJECTED (createCommands' `jsonlStoreRoot`, the same DI convention
  // src/sandbox-cli-session.mjs uses on the write side), so no case here can reach the operator's
  // real ~/.egpt-jsonl.
  storeRoot = mkdtempSync(join(tmpdir(), 'egpt-jsonl-verbs-'));
  storeRoots.push(storeRoot);
});
afterAll(() => {
  delete process.env.EGPT_HOME;
  rmSync(_PRIVATE_HOME, { recursive: true, force: true });
  for (const r of storeRoots) rmSync(r, { recursive: true, force: true });
});

// REAL fs throughout — no io seam unless a case is deliberately breaking one call. A test that
// faked rename could not tell a directory that moved from one that did not.
function harness({ state, io = null }) {
  const sent = [], logs = [];
  let st = state;
  const cmds = createCommands({
    getConfig: () => ({}),
    send: async (chatId, text) => sent.push({ chatId, text }),
    loadState: async () => st,
    writeState: async (s) => { st = s; },
    brains: { resolve: (name) => ({ name, type: 'ccode', allowed_tools: 'all' }) },
    jsonlStoreRoot: storeRoot,
    onLog: (m) => logs.push(String(m)),
    logTranscript: async () => true,
    ...(io ? { io } : {}),
  });
  return { cmds, sent, logs, getState: () => st };
}

function seed(agents) {
  let state = ensureContact(emptyState(), SURFACE, JID, { pushedName: 'diego', slugHint: 'diego' }).state;
  state = patchContact(state, SURFACE, JID, { agents });
  const room = Room.forChat(SURFACE, getContact(state, SURFACE, JID).slug);
  return { state, room };
}

// A store shaped like the real one: CLAUDE_CONFIG_DIR relocates the CLI's whole config root, so
// what sits under <threadId>/ is projects/<slug>/<session>.jsonl and friends — a TREE, not a file.
function seedStore(threadId, body) {
  const dir = join(storeRoot, threadId, 'projects', 'C--Users-an--egpt-conv');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${threadId}.jsonl`), body, 'utf8');
  return join(storeRoot, threadId);
}
const storeFileIn = (base, threadId) => join(base, `${threadId}.cli`, 'projects', 'C--Users-an--egpt-conv', `${threadId}.jsonl`);

// A transcript that IS stamped, so rollTranscript genuinely fires and the .cli lands beside a
// .md that really exists.
function seedTranscript(room, threadId) {
  mkdirSync(room.baseDir(), { recursive: true });
  writeFileSync(room.transcriptPath, `---\nname: diego\nthread_id: ${threadId}\n---\n\nAn@[diego].wa (19:55) #a: hola\n\n`, 'utf8');
}

const archivedDir = (slug) => {
  const hit = readdirSync(ARCHIVE_ROOT).find((n) => n.startsWith(`${slug}-archived-`));
  return hit ? join(ARCHIVE_ROOT, hit) : null;
};

// ═══ 1. /agents rethread ════════════════════════════════════════════════════════════════════
describe('/agents rethread files the retiring thread\'s CLI store beside the transcript it rolls', () => {
  // THE REPRODUCTION. Before this change the store simply stayed at ~/.egpt-jsonl/thread-abc
  // while transcript.md went to transcripts/thread-abc.md — the two halves of one finished thread
  // in two places, one of them unlabelled.
  it('~/.egpt-jsonl/<old> is GONE and its tree is at transcripts/<old>.cli/', async () => {
    const { state, room } = seed({ e: { mode: 'mention', threadId: 'thread-abc', access_level: 'all' } });
    seedTranscript(room, 'thread-abc');
    const src = seedStore('thread-abc', '{"type":"user","text":"hola"}\n');

    const { cmds, sent } = harness({ state });
    await cmds.run({ chatId: JID, surface: SURFACE, body: '/agents rethread e' });

    expect(existsSync(src)).toBe(false);                                        // nothing left orphaned
    const moved = storeFileIn(room.transcriptsDir, 'thread-abc');
    expect(existsSync(moved)).toBe(true);                                       // …it MOVED, whole
    expect(readFileSync(moved, 'utf8')).toBe('{"type":"user","text":"hola"}\n');   // byte-for-byte
    // …and it is BESIDE the transcript of the same thread, which is what makes it identifiable.
    expect(existsSync(join(room.transcriptsDir, 'thread-abc.md'))).toBe(true);
    expect(sent.at(-1).text).toContain("e's CLI store moved to transcripts/thread-abc.cli");
  });

  it('/agents rethread all moves EVERY resident being\'s own store, each under its own thread id', async () => {
    const { state, room } = seed({ e: { threadId: 'thread-e' }, wren: { threadId: 'thread-w' } });
    seedTranscript(room, 'thread-e');
    seedStore('thread-e', 'E\n');
    seedStore('thread-w', 'W\n');

    const { cmds } = harness({ state });
    await cmds.run({ chatId: JID, surface: SURFACE, body: '/agents rethread all' });

    expect(readdirSync(storeRoot)).toEqual([]);
    expect(readFileSync(storeFileIn(room.transcriptsDir, 'thread-e'), 'utf8')).toBe('E\n');
    expect(readFileSync(storeFileIn(room.transcriptsDir, 'thread-w'), 'utf8')).toBe('W\n');
  });

  // THE UNCHANGED CASE, and it is the common one: `wren` is `sandboxed: false` and every
  // non-sandboxed being on the node has no store at all. Nothing moves and — deliberately — the
  // reply says nothing, because a line about a store that never existed on every single rethread
  // is noise, not honesty.
  it('a being with NO store moves nothing and the reply is unchanged', async () => {
    const { state, room } = seed({ e: { threadId: 'thread-abc' } });
    seedTranscript(room, 'thread-abc');

    const { cmds, sent, logs } = harness({ state });
    await cmds.run({ chatId: JID, surface: SURFACE, body: '/agents rethread e' });

    expect(sent.at(-1).text).not.toMatch(/CLI store/);
    expect(logs.filter((l) => l.includes('CLI store'))).toEqual([]);
    expect(existsSync(join(room.transcriptsDir, 'thread-abc.md'))).toBe(true);   // the verb still did its work
  });

  // THE FAILURE IS LOUD AND THE VERB STILL SUCCEEDS — the order is what buys that: the roll has
  // already happened by the time the store is touched, so a store that cannot move costs a store,
  // never the rethread.
  it('a store that CANNOT be moved is named in the reply AND the log, and the rethread still succeeds', async () => {
    const { state, room } = seed({ e: { threadId: 'thread-abc' } });
    seedTranscript(room, 'thread-abc');
    const src = seedStore('thread-abc', 'kept\n');

    // Everything renames for real EXCEPT the store — the shape of a locked directory or a
    // cross-volume move, without needing either.
    const { cmds, sent, logs } = harness({
      state,
      io: { rename: async (from, to) => { if (String(to).endsWith('.cli')) throw new Error('EPERM: operation not permitted'); return fsRename(from, to); } },
    });
    await cmds.run({ chatId: JID, surface: SURFACE, body: '/agents rethread e' });

    const reply = sent.at(-1).text;
    expect(reply).toContain('✅');                                              // the verb succeeded…
    expect(reply).toContain('transcript.md moved to transcripts/thread-abc.md');
    expect(reply).toContain("⚠️ e's CLI store was NOT moved");                  // …and did not pretend
    expect(reply).toContain('EPERM');
    expect(reply).toContain(src);                                               // where it was left
    expect(logs.filter((l) => l.includes('CLI store NOT moved'))).toHaveLength(1);
    expect(readFileSync(join(src, 'projects', 'C--Users-an--egpt-conv', 'thread-abc.jsonl'), 'utf8')).toBe('kept\n');
    expect(existsSync(join(room.transcriptsDir, 'thread-abc.md'))).toBe(true);
  });
});

// ═══ 2. /agents reset ═══════════════════════════════════════════════════════════════════════
describe('/agents reset carries every retiring being\'s CLI store into the archived folder', () => {
  // THE REPRODUCTION. reset renames the whole conversation folder into conversations/archive/;
  // before this change the stores stayed behind at ~/.egpt-jsonl/<id>, pointing at a conversation
  // that no longer exists at that path.
  it('every retiring store lands in <archived>/transcripts/<threadId>.cli/, and ~/.egpt-jsonl is left empty', async () => {
    const { state, room } = seed({ e: { mode: 'mention', threadId: 'thread-e', access_level: 'all' }, wren: { threadId: 'thread-w' } });
    const slug = getContact(state, SURFACE, JID).slug;
    seedTranscript(room, 'thread-e');
    seedStore('thread-e', 'E\n');
    seedStore('thread-w', 'W\n');

    const { cmds, sent } = harness({ state });
    await cmds.run({ chatId: JID, surface: SURFACE, body: '/agents reset all' });

    const archived = archivedDir(slug);
    expect(archived).toBeTruthy();
    expect(readdirSync(storeRoot)).toEqual([]);
    expect(readFileSync(storeFileIn(join(archived, 'transcripts'), 'thread-e'), 'utf8')).toBe('E\n');
    expect(readFileSync(storeFileIn(join(archived, 'transcripts'), 'thread-w'), 'utf8')).toBe('W\n');
    // NOT into the pristine tree reseeded at the ORIGINAL path — the store belongs to the thread
    // that just ended, not to the one that starts next.
    expect(existsSync(join(room.transcriptsDir, 'thread-e.cli'))).toBe(false);
    // The reply QUALIFIES which transcripts/ it means — the two verbs mean different folders by
    // the same relative path — without rendering the archive path the 2026-08-15 ruling forbids.
    expect(sent.at(-1).text).toContain("e's CLI store moved to the archived folder's transcripts/thread-e.cli");
    expect(sent.at(-1).text).toContain("wren's CLI store moved to the archived folder's transcripts/thread-w.cli");
    expect(sent.at(-1).text).not.toContain(archived);   // the destination PATH is still never named
  });

  // …and it is a MOVE, never a delete: reset's defining character (operator 2026-08-15, "archive
  // the old folder", never rm) now covers the model's memory too.
  it('nothing is deleted — the store\'s bytes survive the archive', async () => {
    const { state, room } = seed({ e: { threadId: 'thread-e' } });
    const slug = getContact(state, SURFACE, JID).slug;
    seedTranscript(room, 'thread-e');
    seedStore('thread-e', 'the model\'s own memory\n');

    const { cmds } = harness({ state, io: { rm: async () => { throw new Error('/agents reset must never delete — rm was called'); } } });
    await cmds.run({ chatId: JID, surface: SURFACE, body: '/agents reset e' });

    expect(readFileSync(storeFileIn(join(archivedDir(slug), 'transcripts'), 'thread-e'), 'utf8')).toBe('the model\'s own memory\n');
  });

  // NOWHERE TO PUT IT. A contact whose folder was never created has nothing to archive (reset
  // tolerates that and reseeds) — but if a store DOES exist there is then no archived folder to
  // put it beside, and that must be said rather than quietly skipped.
  it('a store with no archived folder to go into is reported, and the reset still succeeds', async () => {
    const { state } = seed({ e: { threadId: 'thread-e' } });
    const src = seedStore('thread-e', 'orphan\n');   // …and NO conversation folder on disk

    const { cmds, sent, logs } = harness({ state });
    await cmds.run({ chatId: JID, surface: SURFACE, body: '/agents reset e' });

    const reply = sent.at(-1).text;
    expect(reply).toContain('✅');
    expect(reply).toContain("⚠️ e's CLI store was NOT moved");
    expect(reply).toContain('the conversation folder was not archived');
    expect(reply).toContain(src);
    expect(logs.filter((l) => l.includes('CLI store NOT moved'))).toHaveLength(1);
    expect(existsSync(src)).toBe(true);
  });

  // The unchanged common case, same reasoning as rethread's: no store, no clause.
  it('a being with NO store leaves the reset reply exactly as it was', async () => {
    const { state, room } = seed({ e: { threadId: 'thread-e' } });
    seedTranscript(room, 'thread-e');

    const { cmds, sent } = harness({ state });
    await cmds.run({ chatId: JID, surface: SURFACE, body: '/agents reset e' });

    expect(sent.at(-1).text).not.toMatch(/CLI store/);
    expect(sent.at(-1).text).not.toMatch(/archiv/i);   // operator 2026-08-15: never the destination
  });
});
