// split-fork-folder.test.mjs — a /split fork lives in its parent's folder (operator 2026-10-26: "/split
// groups are not using the same folder as main conversation"; "/split gives the context and folder with
// all previous files"). Live: EDW tg:-1004408163350/42 got a folder of its own, so ED there had no files,
// no keys and no history, and its copied thread could not be resumed.
//
//   - the fork's own entry has the parent's slug (conversation_path, cwd, box target), its own thread,
//     its own warm session and its own transcript-<key>.md;
//   - the parent's transcript, folder and thread are untouched by the fork's turns, rolls and verbs;
//   - a fork whose copied thread cannot be resumed answers from a fresh thread, boxed and unboxed.
// Real fs under a private EGPT_HOME; the warm pool is the real one over a fake session.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

const _HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-split-fork-folder-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { promises as fsp, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createCommands } from '../src/spine/commands.mjs';
import { createBrainPool } from '../src/spine/brainpool.mjs';
import { createWarmPool } from '../src/warm-sessions.mjs';
import { createContacts } from '../src/spine/contacts.mjs';
import { chatIdForEntity } from '../src/spine/boot.mjs';
import { Room } from '../src/room-core.mjs';
import { EGPT_HOME } from '../src/egpt-home.mjs';
import { parseFrontMatter } from '../src/transcript-meta.mjs';
import { emptyState, ensureContact, getContact, getBeing, patchContact, patchBeing, recordThread, forkContact, forkKeyOf, isForkEntry, rollTranscript } from '../src/conversations-state.mjs';

const SURFACE = 'telegram';
const P = 'tg:-1004408163350';
const F = 'tg:-1004408163350/42';
const KEY = 'SI+EduWeb-an';

beforeEach(() => { rmSync(EGPT_HOME, { recursive: true, force: true }); });
afterAll(() => { rmSync(_HOME, { recursive: true, force: true }); });

function seed({ boxed = true } = {}) {
  const settings = boxed ? { allowed_users: ['*'], access_level: 'sandbox' } : { allowed_users: ['*'], access_level: 'all', sandboxed: false };
  let st = ensureContact(emptyState(), SURFACE, P, { pushedName: 'EduWeb' }).state;
  st = patchContact(st, SURFACE, P, { agents: { ed: { ...settings, threadId: 'parent-thread' } } });
  st = forkContact(st, SURFACE, F, P, { pushedName: KEY, transcript: KEY });
  st = patchBeing(st, SURFACE, F, 'ed', settings);
  st = recordThread(st, SURFACE, F, 'fork-thread', '2026-10-26T13:00:00Z', 'ed');
  const room = Room.forChat(SURFACE, getContact(st, SURFACE, P).slug);
  mkdirSync(room.baseDir(), { recursive: true });
  return { st, room };
}
const stamped = (path, id, body) => writeFileSync(path, `---\nthread_id: ${id}\n---\n\n${body}\n\n`, 'utf8');

// A session bound to the id it resumed, or — fresh — to the id its first turn mints. `dead` ids fail as
// the CLI does when the --resume target is gone.
function sessions({ dead = [] } = {}) {
  const made = [];
  let n = 0;
  const makeSession = (opts) => {
    const s = {
      opts, closed: false, turns: [], sid: opts.sessionId ?? null,
      get sessionId() { return this.sid; },
      close() { this.closed = true; },
      turn(msg) {
        this.turns.push(msg);
        if (this.sid && dead.includes(this.sid)) {
          return Promise.reject(Object.assign(new Error(`claude: error_during_execution — No conversation found with session ID: ${this.sid}`), { resumeTargetMissing: true }));
        }
        if (!this.sid) this.sid = `thread-new-${++n}`;
        return Promise.resolve({ text: `ok ${this.sid}`, sessionId: this.sid });
      },
    };
    made.push(s);
    return s;
  };
  return { made, makeSession };
}

function brainOver(store, makeSession, logs = []) {
  const loadState = async () => store.st;
  const writeState = async (s) => { store.st = s; };
  return createBrainPool({
    pool: createWarmPool({ makeSession }),
    getConfig: () => ({ agents: { ed: { conversation_defaults: { access_level: 'regular' } } } }),
    contacts: createContacts({ loadState, writeState, io: { mkdir: async () => {} } }),
    loadState, writeState,
    io: fsp,
    resolveConfig: () => ({}),
    loadFeed: async () => 'I am ED.', loadManifest: async () => '',
    loadPermission: () => null,
    seedLayers: async () => [],
    onLog: (m) => logs.push(m),
  });
}
const at = (chatId, chatName) => ({ surface: SURFACE, chatId, chatName, line: `An@[${chatName}].tg (13:39) #m: hola`, body: 'hola' });

describe('the fork shape in conversations-state', () => {
  it('its own entry with the parent\'s slug and conversation_path; slug lookups and heartbeats find the parent', () => {
    const { st } = seed();
    const fork = st.contacts[SURFACE][F];
    expect(isForkEntry(fork)).toBe(true);
    expect(forkKeyOf(st, SURFACE, F)).toBe(KEY);
    expect(forkKeyOf(st, SURFACE, P)).toBe(null);
    expect(fork.slug).toBe(st.contacts[SURFACE][P].slug);
    expect(fork.conversation_path).toBe(st.contacts[SURFACE][P].conversation_path);
    expect(getContact(st, SURFACE, F).jid).toBe(F);
    expect(chatIdForEntity(st, `${SURFACE}/${fork.slug}`)).toEqual({ surface: SURFACE, chatId: P });
    const bySlug = patchContact(st, SURFACE, fork.slug, { pushedName: 'renamed by slug' });
    expect([bySlug.contacts[SURFACE][P].pushedName, bySlug.contacts[SURFACE][F].pushedName]).toEqual(['renamed by slug', KEY]);
  });

  it('a fork is never re-slugged by its own title: the folder is its parent\'s', () => {
    const { st } = seed();
    const r = ensureContact(st, SURFACE, F, { pushedName: 'SI+EduWeb-otro nombre' });
    expect(r.slug).toBe(st.contacts[SURFACE][P].slug);
    expect(r.renamedTo ?? null).toBe(null);
  });
});

describe('a fork\'s turns run in the parent\'s folder, on their own thread', () => {
  it('same cwd and box target as the parent; its own warm session and thread; the parent\'s thread untouched', async () => {
    const { st, room } = seed();
    const store = { st };
    const { made, makeSession } = sessions();
    const brain = brainOver(store, makeSession);

    await brain.turn('ed', at(P, 'EduWeb'));
    await brain.turn('ed', at(F, KEY));
    await brain.turn('ed', at(P, 'EduWeb'));
    expect(made).toHaveLength(2);                                   // two warm sessions, one per thread
    expect(made.map((s) => s.opts.sessionId)).toEqual(['parent-thread', 'fork-thread']);
    expect(made[0].turns).toHaveLength(2);
    expect(made[1].opts.pool.key).not.toBe(made[0].opts.pool.key);
    expect(made[1].opts.cwd).toBe(room.baseDir());                  // the parent's folder…
    expect(made[0].opts.cwd).toBe(room.baseDir());
    expect(made[1].opts.sandboxed).toBe(true);                      // …so the box's target (and uid) is the parent's
    expect(getBeing(store.st, SURFACE, P, 'ed').threadId).toBe('parent-thread');
    expect(getBeing(store.st, SURFACE, F, 'ed').threadId).toBe('fork-thread');
  });

  it('its lines go to its own transcript file in the parent\'s folder; the parent\'s stays transcript.md', async () => {
    const { st, room } = seed();
    const store = { st };
    const contacts = createContacts({ loadState: async () => store.st, writeState: async (s) => { store.st = s; }, io: { mkdir: async () => {} } });
    expect((await contacts.transcriptTarget(SURFACE, F, { chatName: KEY })).path).toBe(room.transcriptPathFor(KEY));
    expect((await contacts.transcriptTarget(SURFACE, P, { chatName: 'EduWeb' })).path).toBe(room.transcriptPath);
  });
});

describe('rolls keep the two logs apart', () => {
  it('the parent\'s fresh-thread roll leaves the fork\'s log; the fork\'s roll moves only its own', async () => {
    const { room } = seed();
    stamped(room.transcriptPath, 'parent-thread', 'An (13:00) #a: en el principal');
    stamped(room.transcriptPathFor(KEY), 'fork-thread', 'An (13:39) #b: en el tema');

    await rollTranscript(SURFACE, room.slug, { io: fsp });
    expect(existsSync(join(room.transcriptsDir, 'parent-thread.md'))).toBe(true);
    expect(readFileSync(room.transcriptPathFor(KEY), 'utf8')).toContain('#b: en el tema');

    await rollTranscript(SURFACE, room.slug, { io: fsp, key: KEY });
    expect(readFileSync(join(room.transcriptsDir, `fork-thread--${KEY}.md`), 'utf8')).toContain('#b: en el tema');
    expect(parseFrontMatter(readFileSync(room.transcriptPathFor(KEY), 'utf8')).thread_id ?? null).toBe(null);
    expect(existsSync(join(room.transcriptsDir, 'parent-thread-2.md'))).toBe(false);
  });

  it('an unstamped side-room log (a /join alias) still rolls with the main file, as before', async () => {
    const { room } = seed();
    stamped(room.transcriptPath, 'parent-thread', 'An (13:00) #a: principal');
    writeFileSync(room.transcriptPathFor('side'), 'Emely (13:01) #c: alias\n\n', 'utf8');
    await rollTranscript(SURFACE, room.slug, { io: fsp });
    expect(readFileSync(join(room.transcriptsDir, 'parent-thread--side.md'), 'utf8')).toContain('#c: alias');
  });
});

describe('the verbs typed in a fork act on the fork', () => {
  function commands(store) {
    const sent = [];
    const cmds = createCommands({
      getConfig: () => ({}),
      send: async (chatId, text) => sent.push({ chatId, text }),
      loadState: async () => store.st,
      writeState: async (s) => { store.st = s; },
      brains: { resolve: (name) => ({ name, type: 'ccode', allowed_tools: 'all' }) },
      logTranscript: async () => true,
      defaultKey: 'ed',
    });
    return { cmds, sent };
  }

  it('/agents reset is refused: the parent\'s folder is not archived and nothing is wiped', async () => {
    const { st, room } = seed();
    writeFileSync(join(room.baseDir(), 'notes.md'), 'team notes\n', 'utf8');
    const store = { st };
    const { cmds, sent } = commands(store);
    await cmds.run({ chatId: F, surface: SURFACE, isSender: true, body: '/agents reset ed' });
    expect(sent.at(-1)).toMatchObject({ chatId: F, text: expect.stringContaining('shares its parent\'s folder') });
    expect(readFileSync(join(room.baseDir(), 'notes.md'), 'utf8')).toBe('team notes\n');
    expect(existsSync(join(EGPT_HOME, 'conversations', 'archive'))).toBe(false);
    expect(store.st).toBe(st);
  });

  it('/agents rethread clears the fork\'s thread and rolls only its log', async () => {
    const { st, room } = seed();
    stamped(room.transcriptPath, 'parent-thread', 'An (13:00) #a: principal');
    stamped(room.transcriptPathFor(KEY), 'fork-thread', 'An (13:39) #b: tema');
    const store = { st };
    const { cmds } = commands(store);
    await cmds.run({ chatId: F, surface: SURFACE, isSender: true, body: '/agents rethread ed' });
    expect(getBeing(store.st, SURFACE, F, 'ed').threadId).toBe(null);
    expect(getBeing(store.st, SURFACE, P, 'ed').threadId).toBe('parent-thread');
    expect(readFileSync(join(room.transcriptsDir, `fork-thread--${KEY}.md`), 'utf8')).toContain('#b: tema');
    expect(parseFrontMatter(readFileSync(room.transcriptPath, 'utf8')).thread_id).toBe('parent-thread');
  });
});

// Live 2026-10-26 13:39 UTC on EDW: `warm: evicted ed:ccode:telegram:an-2610261304 (the --resume target is
// gone, so no turn ran: … No conversation found with session ID: 5aafb400-…)`. The turn must still answer.
describe('a fork whose thread cannot be resumed answers from a fresh one', () => {
  for (const boxed of [true, false]) {
    it(`${boxed ? 'boxed' : 'unboxed'}: evicted, retried fresh with the identity, the new thread recorded on the fork and named in its log`, async () => {
      const { st, room } = seed({ boxed });
      stamped(room.transcriptPath, 'parent-thread', 'An (13:00) #a: principal');
      const store = { st };
      const logs = [];
      const { made, makeSession } = sessions({ dead: ['fork-thread'] });
      const brain = brainOver(store, makeSession, logs);
      const out = await brain.turn('ed', at(F, KEY));
      expect(out.text).toBe('ok thread-new-1');
      expect(made.map((s) => s.opts.sessionId)).toEqual(['fork-thread', null]);
      expect(made[1].opts.sandboxed === true).toBe(boxed);
      expect(made[1].turns[0]).toContain('I am ED.');
      expect(logs.some((l) => /dead session fork-thread .* retrying fresh/.test(l))).toBe(true);
      expect(getBeing(store.st, SURFACE, F, 'ed').threadId).toBe('thread-new-1');
      expect(getBeing(store.st, SURFACE, P, 'ed').threadId).toBe('parent-thread');
      expect(parseFrontMatter(readFileSync(room.transcriptPathFor(KEY), 'utf8')).thread_id).toBe('thread-new-1');
      expect(parseFrontMatter(readFileSync(room.transcriptPath, 'utf8')).thread_id).toBe('parent-thread');
    });
  }
});
