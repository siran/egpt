// conversation-slugs.test.mjs — a conversation folder is named by its title alone (operator 2026-11-19:
// the -yymmddhhmm suffix was "a cheap, poor man's way of avoiding being scammed by a duplicate group").
// Lookup is by chat id, so the suffix bought no safety, and firstSeen differs per node, so the same chat
// got a different folder on each. A second chat id with a held title gets a suffix from its own id.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createContacts } from '../src/spine/contacts.mjs';
import { renameRoomRow } from '../src/rooms-file.mjs';
import { emptyState, ensureContact, getContact, recordThread, forkContact, conversationPathOf, fixedSlugFor, parse, serialize, recordMemberStat } from '../src/conversations-state.mjs';

const WA = 'whatsapp';
const TITLE = 'eGPT Rodz Lulu An';
const A = 'AAAAAAAAAAAAAAaaa111';   // Beeper short ids: 20 letters/digits
const B = 'BBBBBBBBBBBBBBbbb222';

const onNode = (iso, fn) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(iso)); try { return fn(); } finally { vi.useRealTimers(); } };
afterEach(() => vi.useRealTimers());

describe('reproduce: the slug does not depend on when a node first saw the chat', () => {
  it('two nodes with different firstSeen name the same chat id + title alike', () => {
    const kg = onNode('2026-09-20T14:19:00Z', () => ensureContact(emptyState(), WA, A, { pushedName: TITLE }));
    const nu = onNode('2026-11-02T21:00:00Z', () => ensureContact(emptyState(), WA, A, { pushedName: TITLE }));
    expect(kg.slug).toBe(nu.slug);
    expect(kg.slug).toBe(TITLE);
  });

  it('a second chat id with a held title, over 60 s later, is its own conversation suffixed from its own id', () => {
    const twoChats = (iso) => {
      const a = onNode(iso, () => ensureContact(emptyState(), WA, A, { pushedName: TITLE }));
      const seenA = Date.parse(iso);
      return onNode(new Date(seenA + 61_000).toISOString(), () => ensureContact(a.state, WA, B, { pushedName: TITLE, firstSeenOf: (id) => (id === A ? seenA : undefined) }));
    };
    const st = twoChats('2026-11-19T10:00:30Z');   // the next minute: the old suffixes differed
    expect(st.isNew).toBe(true);
    expect(st.jid).toBe(B);
    expect(st.state.contacts[WA][B].aliasOf).toBeUndefined();
    expect(getContact(st.state, WA, A).slug).toBe(TITLE);
    expect(st.slug).toBe(`${TITLE}-bbb222`);
    // the suffix comes from the id, so a node that saw B another day says the same
    expect(twoChats('2026-12-01T08:00:00Z').slug).toBe(st.slug);
  });
});

describe('the same chat under a second id seconds later (the merge window)', () => {
  const T0 = Date.parse('2026-11-19T10:00:00Z');
  const withA = () => ensureContact(emptyState(), WA, A, { pushedName: TITLE }).state;
  const seenAt = (ms) => (id) => (id === A ? ms : undefined);

  it('within 60 s of the holder\'s first sighting: an alias of it', () => {
    const r = ensureContact(withA(), WA, B, { pushedName: TITLE, firstSeenOf: seenAt(T0), now: T0 + 60_000 });
    expect(r.state.contacts[WA][B]).toEqual({ aliasOf: A });
    expect([r.jid, r.slug, r.isNew]).toEqual([A, TITLE, false]);
  });

  it('after 60 s: its own conversation, suffixed', () => {
    const r = ensureContact(withA(), WA, B, { pushedName: TITLE, firstSeenOf: seenAt(T0), now: T0 + 60_001 });
    expect([r.jid, r.slug, r.isNew]).toEqual([B, `${TITLE}-bbb222`, true]);
  });

  it('a legacy holder is timed by the stamp its slug encodes', () => {
    const legacy = { contacts: { [WA]: { [A]: { slug: `${TITLE}-2611191000`, pushedName: TITLE } } } };
    expect(ensureContact(legacy, WA, B, { pushedName: TITLE, now: T0 + 40_000 }).jid).toBe(A);
    expect(ensureContact(legacy, WA, B, { pushedName: TITLE, now: T0 + 61_000 }).jid).toBe(B);
  });

  it('no first-seen time, or a different title, never merges; an unknown time is asked for', () => {
    const r = ensureContact(withA(), WA, B, { pushedName: TITLE });
    expect([r.jid, r.needsFirstSeen]).toEqual([B, A]);
    const other = ensureContact(withA(), WA, B, { pushedName: TITLE.toLowerCase(), firstSeenOf: seenAt(T0), now: T0 });
    expect([other.jid, other.needsFirstSeen]).toEqual([B, undefined]);
  });
});

describe('contacts.resolve times the holder by its stats first_seen', () => {
  const norm = (p) => String(p).replace(/\\/g, '/');
  function node() {
    const files = new Map();
    const stats = {
      readFile: async (p) => { if (!files.has(norm(p))) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files.get(norm(p)); },
      writeFile: async (p, d) => { files.set(norm(p), d); },
      mkdir: async () => {},
      rename: async (a, b) => { files.set(norm(b), files.get(norm(a))); files.delete(norm(a)); },
      existsSync: (p) => files.has(norm(p)),
      readdir: async (dir) => { const pre = `${norm(dir)}/`; return [...files.keys()].filter((k) => k.startsWith(pre)).map((k) => k.slice(pre.length)); },
    };
    let state = emptyState();
    const deps = {
      loadState: async () => parse(serialize(state)), writeState: async (s) => { state = parse(serialize(s)); },
      io: { ...stats, rename: async () => {}, appendFile: async () => {}, renameRoomRow: async () => false },
    };
    // what transcribing a chat's first message writes (spine/transcript.mjs → the stats collector)
    const transcribe = (id, ms) => recordMemberStat(WA, id, '@u', new Date(ms).toISOString(), { io: stats, chatName: TITLE });
    return { deps, transcribe, state: () => state };
  }

  it('back-to-back ids in one process merge before the stats write lands', async () => {
    const n = node();
    const contacts = createContacts(n.deps);
    expect(await contacts.resolve(WA, A, { chatName: TITLE })).toBe(TITLE);
    expect(await contacts.resolve(WA, B, { chatName: TITLE })).toBe(TITLE);
    expect(n.state().contacts[WA][B]).toEqual({ aliasOf: A });
  });

  it('a restart between the two ids still merges within 60 s', async () => {
    const n = node();
    expect(await createContacts(n.deps).resolve(WA, A, { chatName: TITLE })).toBe(TITLE);
    await n.transcribe(A, Date.now());
    expect(await createContacts(n.deps).resolve(WA, B, { chatName: TITLE })).toBe(TITLE);   // a fresh process
    expect(n.state().contacts[WA][B]).toEqual({ aliasOf: A });
  });

  it('after a restart, a holder first seen over 60 s ago, or with no first_seen, is not merged into', async () => {
    const n = node();
    await createContacts(n.deps).resolve(WA, A, { chatName: TITLE });
    await n.transcribe(A, Date.now() - 61_000);
    expect(await createContacts(n.deps).resolve(WA, B, { chatName: TITLE })).toBe(`${TITLE}-bbb222`);
    expect(await createContacts(n.deps).resolve(WA, 'CCCCCCCCCCCCCCccc333', { chatName: TITLE })).toBe(`${TITLE}-ccc333`);
  });
});

describe('collisions', () => {
  it('is case-insensitive (NTFS and APFS folders are)', () => {
    const a = ensureContact(emptyState(), WA, A, { pushedName: 'Familia' });
    const b = ensureContact(a.state, WA, B, { pushedName: 'familia' });
    expect(b.slug).toBe('familia-bbb222');
  });

  it('a Telegram id is suffixed by its tail (every supergroup id starts tg:-100)', () => {
    const a = ensureContact(emptyState(), 'telegram', 'tg:-1001111234567', { pushedName: 'General' });
    const b = ensureContact(a.state, 'telegram', 'tg:-1002222765432', { pushedName: 'General' });
    expect(b.slug).toBe('General-765432');
  });

  it('a full Beeper id is suffixed by its room part, not the server', () => {
    const a = ensureContact(emptyState(), WA, '!x1y2z3cloudroomAAAA:beeper.com', { pushedName: 'General' });
    const b = ensureContact(a.state, WA, '!x1y2z3cloudroomBBBB:beeper.com', { pushedName: 'General' });
    expect(b.slug).toBe('General-omBBBB');
  });

  it('the suffix grows when the 6-char one is taken too', () => {
    let st = ensureContact(emptyState(), WA, A, { pushedName: TITLE }).state;
    st = ensureContact(st, WA, 'CCCCCCCCCCCCCCCbbb222', { pushedName: `${TITLE}-bbb222` }).state;
    expect(ensureContact(st, WA, B, { pushedName: TITLE }).slug).toBe(`${TITLE}-Bbbb222`);
  });

  it('a long title is cut so the suffix survives the 80-char cap', () => {
    const long = 'x'.repeat(90);
    const a = ensureContact(emptyState(), WA, A, { pushedName: long });
    const b = ensureContact(a.state, WA, B, { pushedName: long });
    expect(a.slug).toBe('x'.repeat(80));
    expect(b.slug).toBe(`${'x'.repeat(73)}-bbb222`);
  });

  it('a nameless chat is `contact`; the next nameless one is suffixed', () => {
    const a = ensureContact(emptyState(), WA, A, {});
    const b = ensureContact(a.state, WA, B, {});
    expect([a.slug, b.slug]).toEqual(['contact', 'contact-bbb222']);
  });

  it('a fixed seat holds its slug: a chat titled like it is suffixed', () => {
    const lobby = ensureContact(emptyState(), 'shell', 'main', {});
    expect(lobby.slug).toBe(fixedSlugFor('shell', 'main'));
    expect(ensureContact(lobby.state, 'shell', B, { pushedName: 'lobby' }).slug).toBe('lobby-bbb222');
  });
});

describe('renames (title tracking) and existing folders', () => {
  const legacy = (slug, pushedName, extra = {}) => ({ slug, conversation_path: conversationPathOf(WA, slug), pushedName, ...extra });
  const stateOf = (bucket) => ({ contacts: { [WA]: bucket } });

  it('a renamed chat takes the new title bare; the thread survives', () => {
    let st = ensureContact(emptyState(), WA, A, { pushedName: TITLE }).state;
    st = recordThread(st, WA, A, 'thread-1', undefined, 'e');
    const r = ensureContact(st, WA, A, { pushedName: 'SI+EduWeb' });
    expect([r.renamedFrom, r.renamedTo]).toEqual([TITLE, 'SI+EduWeb']);
    expect(r.state.contacts[WA][A].conversation_path).toBe(conversationPathOf(WA, 'SI+EduWeb'));
    expect(r.state.contacts[WA][A].agents.e.threadId).toBe('thread-1');
  });

  it('a rename onto a held title is suffixed, never a collision', () => {
    let st = ensureContact(emptyState(), WA, A, { pushedName: TITLE }).state;
    st = ensureContact(st, WA, B, { pushedName: 'otro' }).state;
    expect(ensureContact(st, WA, B, { pushedName: TITLE }).renamedTo).toBe(`${TITLE}-bbb222`);
  });

  it('a legacy -yymmddhhmm folder converges on its next message', () => {
    const r = ensureContact(stateOf({ [A]: legacy(`${TITLE}-2609201419`, TITLE) }), WA, A, { pushedName: TITLE });
    expect([r.renamedFrom, r.renamedTo]).toEqual([`${TITLE}-2609201419`, TITLE]);
  });

  it('…even when that sighting carries no title (the stored one names it)', () => {
    const r = ensureContact(stateOf({ [A]: legacy(`${TITLE}-2609201419`, TITLE) }), WA, A, {});
    expect(r.renamedTo).toBe(TITLE);
    const nameless = ensureContact(stateOf({ [A]: legacy('contact-2606101622', '') }), WA, A, {});
    expect(nameless.renamedTo).toBe('contact');
  });

  it('a legacy holder keeps its title from a newcomer until it converges', () => {
    const st = stateOf({ [A]: legacy(`${TITLE}-2609201419`, TITLE) });
    const b = ensureContact(st, WA, B, { pushedName: TITLE });
    expect(b.slug).toBe(`${TITLE}-bbb222`);
    expect(ensureContact(b.state, WA, A, { pushedName: TITLE }).renamedTo).toBe(TITLE);
  });

  it('steady state: no rename for a suffixed chat while the bare title is held', () => {
    let st = ensureContact(emptyState(), WA, A, { pushedName: TITLE }).state;
    st = ensureContact(st, WA, B, { pushedName: TITLE }).state;
    const r = ensureContact(st, WA, B, { pushedName: TITLE });
    expect(r.changed).toBe(false);
    expect(r.renamedTo).toBe(null);
  });

  it('a /split fork in the parent folder follows the parent\'s rename and never holds a slug', () => {
    let st = ensureContact(emptyState(), WA, A, { pushedName: TITLE }).state;
    st = forkContact(st, WA, B, A, { pushedName: `SI+${TITLE}-rental`, transcript: `SI+${TITLE}-rental` });
    const r = ensureContact(st, WA, A, { pushedName: 'Renamed' });
    expect(r.state.contacts[WA][B].slug).toBe('Renamed');
    expect(r.state.contacts[WA][B].conversation_path).toBe(conversationPathOf(WA, 'Renamed'));
    expect(ensureContact(r.state, WA, B, { pushedName: `SI+${TITLE}-rental` }).slug).toBe('Renamed');
  });

  it('a fork left on a stale slug by an older rename self-heals to its parent\'s', () => {
    const st = stateOf({ [A]: legacy('Renamed', 'Renamed'), [B]: legacy('Old', 'fork', { parent_chat: A, transcript: 'fork' }) });
    const r = ensureContact(st, WA, B, { pushedName: 'fork' });
    expect(r.slug).toBe('Renamed');
    expect(r.renamedTo).toBe(null);   // no folder of its own to move
  });
});

describe('contacts.resolve moves the folder through the one rename path', () => {
  const OLD = `${TITLE}-2609201419`;
  function harness(seed) {
    let state = seed;
    const h = { busy: false, moves: [], rows: [], get: () => state };
    h.contacts = createContacts({
      loadState: async () => state,
      writeState: async (s) => { state = s; },
      io: {
        rename: async (from, to) => { if (h.busy) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); h.moves.push([from, to]); },
        appendFile: async () => {},
        renameRoomRow: async (from, to) => { h.rows.push([from, to]); return true; },
      },
    });
    return h;
  }
  const seeded = () => {
    let st = { contacts: { [WA]: { [A]: { slug: OLD, conversation_path: conversationPathOf(WA, OLD), pushedName: TITLE } } } };
    st = recordThread(st, WA, A, 'thread-1', undefined, 'e');
    return forkContact(st, WA, B, A, { pushedName: 'rental', transcript: 'rental' });
  };

  it('a legacy folder converges: one move, its rooms.yaml row, the thread and the fork come along', async () => {
    const h = harness(seeded());
    expect(await h.contacts.resolve(WA, A, { chatName: TITLE })).toBe(TITLE);
    expect(h.moves).toHaveLength(1);
    expect(h.rows).toEqual([[`${WA}/${OLD}`, `${WA}/${TITLE}`]]);
    expect(h.get().contacts[WA][A].agents.e.threadId).toBe('thread-1');
    expect(h.get().contacts[WA][B].slug).toBe(TITLE);
  });

  it('EBUSY keeps the old folder and row for the chat and its fork; the next sighting retries', async () => {
    const h = harness(seeded());
    h.busy = true;
    expect(await h.contacts.resolve(WA, A, { chatName: TITLE })).toBe(OLD);
    expect(h.get().contacts[WA][A].slug).toBe(OLD);
    expect(h.get().contacts[WA][B].slug).toBe(OLD);
    expect(h.get().contacts[WA][B].conversation_path).toBe(conversationPathOf(WA, OLD));
    expect(h.rows).toEqual([]);
    h.busy = false;
    expect(await h.contacts.resolve(WA, A, { chatName: TITLE })).toBe(TITLE);
    expect(h.get().contacts[WA][B].slug).toBe(TITLE);
    expect(h.rows).toHaveLength(1);
  });
});

describe('renameRoomRow', () => {
  const file = (text) => {
    const box = { text };
    return { box, deps: { path: 'rooms.yaml', read: async () => box.text, write: async (_p, t) => { box.text = t; } } };
  };

  it('re-keys the row in place, comments kept', async () => {
    const { box, deps } = file('rooms:\n  # the family group\n  whatsapp/Fam-2609201419:\n    members: [ a ] # roster\n  room/radio:\n    radio: {}\n');
    expect(await renameRoomRow('whatsapp/Fam-2609201419', 'whatsapp/Fam', deps)).toBe(true);
    expect(box.text).toBe('rooms:\n  # the family group\n  whatsapp/Fam:\n    members: [ a ] # roster\n  room/radio:\n    radio: {}\n');
  });

  it('never onto an existing row, and a missing row or file is a no-op', async () => {
    const text = 'rooms:\n  whatsapp/a: { x: 1 }\n  whatsapp/b: { y: 2 }\n';
    const { box, deps } = file(text);
    expect(await renameRoomRow('whatsapp/a', 'whatsapp/b', deps)).toBe(false);
    expect(await renameRoomRow('whatsapp/zz', 'whatsapp/c', deps)).toBe(false);
    expect(box.text).toBe(text);
    expect(await renameRoomRow('whatsapp/a', 'whatsapp/c', { path: 'x', read: async () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); } })).toBe(false);
  });
});

describe('a chatbox conversation is named by its chatName like any limb\'s chat', () => {
  const H1 = 'http:abc-0000000000000001', H2 = 'http:abc-0000000000000002';
  it('the slug is the chatName (no fixed slug), up to 255 characters', () => {
    expect(fixedSlugFor('http', H1)).toBeNull();
    const r = ensureContact(emptyState(), 'http', H1, { pushedName: 'abc-P-jdoe-Jane Doe' });
    expect(r.slug).toBe('abc-P-jdoe-Jane Doe');
    expect(ensureContact(emptyState(), 'http', H1, { pushedName: 'x'.repeat(400) }).slug).toHaveLength(255);
  });

  it('a new chatName renames the folder (renamedFrom/To) and keeps the entry\'s thread', () => {
    let st = ensureContact(emptyState(), 'http', H1, { pushedName: 'abc-P-jdoe-Jane Doe', seed: { agents: { ed: { threadId: 't-1' } } } }).state;
    const r = ensureContact(st, 'http', H1, { pushedName: 'abc-P-jdoe-Jane Roe' });
    expect(r).toMatchObject({ slug: 'abc-P-jdoe-Jane Roe', renamedFrom: 'abc-P-jdoe-Jane Doe', renamedTo: 'abc-P-jdoe-Jane Roe' });
    expect(r.entry.agents.ed.threadId).toBe('t-1');
  });

  it('two chat ids with one title are two folders, even seconds apart (never merged as one chat)', () => {
    const a = ensureContact(emptyState(), 'http', H1, { pushedName: 'abc' });
    const b = ensureContact(a.state, 'http', H2, { pushedName: 'abc' });
    expect(a.slug).toBe('abc');
    expect(b.slug).not.toBe('abc');
    expect(b.slug).toMatch(/^abc-/);
    expect(b.state.contacts.http[H2].aliasOf).toBeUndefined();
  });

  it('regression: Telegram keeps its slug cap (80), its same-title merge and its clash tail', () => {
    const T1 = 'tg:-1001', T2 = 'tg:-1002';
    expect(ensureContact(emptyState(), 'telegram', T1, { pushedName: 'x'.repeat(400) }).slug).toHaveLength(80);
    const a = ensureContact(emptyState(), 'telegram', T1, { pushedName: 'Family' });
    const b = ensureContact(a.state, 'telegram', T2, { pushedName: 'Family' });
    expect(a.slug).toBe('Family');
    expect(b.slug).toBe('Family-tg1002');   // first seen unknown: a duplicate title takes the id's tail
    const m = ensureContact(a.state, 'telegram', T2, { pushedName: 'Family', firstSeenOf: () => Date.now() });
    expect(m.state.contacts.telegram[T2]).toEqual({ aliasOf: T1 });   // seen seconds ago: the same chat under a second id
  });
});
