// join-alias-rethread.test.mjs — /agents rethread typed INSIDE a /join side-room (operator 2026-10-16:
// "make sure /rethread works as expected"; a side-room must stay THE SAME conversation as C).
//
//   (a) it acts on C's canonical entry: ONE thread cleared for C and every alias, never a block of
//       the alias's own; C's transcript.md AND every side-room transcript-<key>.md are rolled;
//   (b) the next turn from C or any alias starts the same new thread; the alias still routes to C;
//   (c) the warm session C and its aliases share is replaced, so the old thread stops answering;
//   (d) directives, other files and the folder itself are untouched.
// Real fs under a private EGPT_HOME; the warm pool is the real one over a fake session.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

const _HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-join-alias-rethread-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createCommands } from '../src/spine/commands.mjs';
import { createBrainPool } from '../src/spine/brainpool.mjs';
import { createWarmPool } from '../src/warm-sessions.mjs';
import { createContacts } from '../src/spine/contacts.mjs';
import { Room } from '../src/room-core.mjs';
import { EGPT_HOME } from '../src/egpt-home.mjs';
import { emptyState, ensureContact, getContact, getBeing, patchContact, aliasContact, aliasTargetOf } from '../src/conversations-state.mjs';

const SURFACE = 'whatsapp';
const C = '!grpC';
const SIDE_A = '!sideEmely';
const SIDE_B = '!sideNue';
const KEY_A = 'si-contoso-emely';
const KEY_B = 'si-contoso-nue11';

beforeEach(() => { rmSync(EGPT_HOME, { recursive: true, force: true }); });
afterAll(() => { rmSync(_HOME, { recursive: true, force: true }); });

function seed() {
  let st = ensureContact(emptyState(), SURFACE, C, { pushedName: 'SI Contoso', slugHint: 'si-contoso' }).state;
  st = patchContact(st, SURFACE, C, { agents: { e: { mode: 'mention', threadId: 'thread-old', access_level: 'sandbox' } } });
  const jid = getContact(st, SURFACE, C).jid;
  st = aliasContact(st, SURFACE, SIDE_A, jid, { transcript: KEY_A, join_name: 'emely' });
  st = aliasContact(st, SURFACE, SIDE_B, jid, { transcript: KEY_B });
  return { st, jid, room: Room.forChat(SURFACE, getContact(st, SURFACE, C).slug) };
}

function commands(store) {
  const sent = [];
  const cmds = createCommands({
    getConfig: () => ({}),
    send: async (chatId, text) => sent.push({ chatId, text }),
    loadState: async () => store.st,
    writeState: async (s) => { store.st = s; },
    brains: { resolve: (name) => ({ name, type: 'ccode', allowed_tools: 'all' }) },
    logTranscript: async () => true,
    defaultKey: 'e',
  });
  return { cmds, sent };
}

describe('/agents rethread inside a /join side-room — (a) one thread, every transcript rolled; (d) nothing else touched', () => {
  it('clears C\'s thread (not a block on the alias) and rolls transcript.md plus every transcript-<key>.md', async () => {
    const { st, room } = seed();
    mkdirSync(room.directivesDir, { recursive: true });
    const head = '---\nname: SI Contoso\nthread_id: thread-old\n---\n\n';
    writeFileSync(room.transcriptPath, `${head}An (10:00) #a: hola\n\n`, 'utf8');
    writeFileSync(room.transcriptPathFor(KEY_A), 'Emely (10:01) #b: en el side-room\n\n', 'utf8');
    writeFileSync(room.transcriptPathFor(KEY_B), 'Nue (10:02) #c: otro side-room\n\n', 'utf8');
    writeFileSync(join(room.directivesDir, '10-rules.md'), 'rules\n', 'utf8');
    writeFileSync(join(room.baseDir(), 'notes.md'), 'team notes\n', 'utf8');
    const aliasA = { ...st.contacts.whatsapp[SIDE_A] };
    const aliasB = { ...st.contacts.whatsapp[SIDE_B] };

    const store = { st };
    const { cmds, sent } = commands(store);
    await cmds.run({ chatId: SIDE_A, surface: SURFACE, isSender: true, body: '/agents rethread e' });

    // (a) C's canonical block lost its thread and kept everything else; the aliases are untouched
    expect(getContact(store.st, SURFACE, C).entry.agents.e).toEqual({ mode: 'mention', threadId: null, access_level: 'sandbox' });
    expect(store.st.contacts.whatsapp[SIDE_A]).toEqual(aliasA);
    expect(store.st.contacts.whatsapp[SIDE_B]).toEqual(aliasB);
    for (const id of [C, SIDE_A, SIDE_B]) expect(getBeing(store.st, SURFACE, id, 'e').threadId).toBeNull();
    // …and every transcript in the folder rolled under the retiring thread
    expect(readFileSync(join(room.transcriptsDir, 'thread-old.md'), 'utf8')).toContain('#a: hola');
    expect(readFileSync(join(room.transcriptsDir, `thread-old--${KEY_A}.md`), 'utf8')).toContain('#b: en el side-room');
    expect(readFileSync(join(room.transcriptsDir, `thread-old--${KEY_B}.md`), 'utf8')).toContain('#c: otro side-room');
    expect(readFileSync(room.transcriptPath, 'utf8')).not.toContain('thread-old');
    expect(sent.at(-1)).toMatchObject({ chatId: SIDE_A, text: expect.stringContaining('✅') });
    // (d) directives, other files and the folder stay put; nothing archived
    expect(readFileSync(join(room.directivesDir, '10-rules.md'), 'utf8')).toBe('rules\n');
    expect(readFileSync(join(room.baseDir(), 'notes.md'), 'utf8')).toBe('team notes\n');
    expect(existsSync(join(EGPT_HOME, 'conversations', 'archive'))).toBe(false);
  });
});

describe('/agents rethread inside a /join side-room — (b) one new thread for C and its aliases, (c) the warm session is replaced', () => {
  // A session bound to the id it resumed, or — fresh — to the id its first turn mints.
  function sessions() {
    const made = [];
    let n = 0;
    const makeSession = (opts) => {
      const s = {
        opts, closed: false, turns: [], sid: opts.sessionId ?? null,
        get sessionId() { return this.sid; },
        close() { this.closed = true; },
        turn(msg) { this.turns.push(msg); if (!this.sid) this.sid = `thread-new-${++n}`; return Promise.resolve({ text: 'ok', sessionId: this.sid }); },
      };
      made.push(s);
      return s;
    };
    return { made, makeSession };
  }

  it('C and the side-room share one warm process; after a rethread from the side-room both resume ONE new thread', async () => {
    const { st, jid } = seed();
    const store = { st };
    const loadState = async () => store.st;
    const writeState = async (s) => { store.st = s; };
    const { made, makeSession } = sessions();
    const brain = createBrainPool({
      pool: createWarmPool({ makeSession }),
      getConfig: () => ({ agents: { e: { conversation_defaults: { access_level: 'regular' } } } }),
      contacts: createContacts({ loadState, writeState, io: { mkdir: async () => {} } }),
      loadState, writeState,
      io: { mkdir: async () => {}, readFile: async () => null, writeFile: async () => {} },
      resolveConfig: () => ({}),
      loadFeed: async () => '', loadManifest: async () => '',
      loadPermission: () => null,
      seedLayers: async () => [],
    });
    const at = (chatId, chatName) => ({ surface: SURFACE, chatId, chatName, line: `Emely@[${chatName}].wa (10:00) #m: hola`, body: 'hola' });

    await brain.turn('e', at(SIDE_A, 'side emely'));
    await brain.turn('e', at(C, 'SI Contoso'));
    expect(made).toHaveLength(1);                                    // one warm process for the conversation
    expect(made[0].opts.sessionId).toBe('thread-old');

    const { cmds } = commands(store);
    await cmds.run({ chatId: SIDE_A, surface: SURFACE, isSender: true, body: '/agents rethread e' });

    await brain.turn('e', at(C, 'SI Contoso'));                      // (c) the old session is closed, a fresh one opens
    expect(made[0].closed).toBe(true);
    expect(made).toHaveLength(2);
    expect(made[1].opts.sessionId).toBeNull();
    await brain.turn('e', at(SIDE_A, 'side emely'));                // (b) the side-room resumes the SAME new thread
    expect(made).toHaveLength(2);
    expect(made[1].closed).toBe(false);
    expect(made[1].turns).toHaveLength(2);

    for (const id of [C, SIDE_A, SIDE_B]) expect(getBeing(store.st, SURFACE, id, 'e').threadId).toBe('thread-new-1');
    expect(aliasTargetOf(store.st, SURFACE, SIDE_A)).toBe(jid);
    expect(store.st.contacts.whatsapp[SIDE_A].agents).toBeUndefined();
  });
});
