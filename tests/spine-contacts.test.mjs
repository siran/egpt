// contacts.resolve: the ONE shared contact-resolver. Registers on first sight,
// re-arms the pushedName/rename self-heal for KNOWN chats (the thing the three
// private resolveSlug copies never did), and carries the v1-parity rename side-
// effect — move the on-disk slug dir old→new + write renames.log. In-memory io +
// conv-state; no disk.
import { describe, it, expect } from 'vitest';
import { createContacts } from '../src/spine/contacts.mjs';
import { emptyState, getContact, ensureContact, recordThread, conversationPathOf } from '../src/conversations-state.mjs';

const SURFACE = 'whatsapp';
const CHAT = '!room:beeper.com';

function harness(seed) {
  let state = seed ?? emptyState();
  let writes = 0;
  const renames = [], appends = [];
  const io = {
    rename: async (from, to) => { renames.push({ from, to }); },
    appendFile: async (p, data) => { appends.push({ p, data }); },
  };
  const contacts = createContacts({
    loadState: async () => state,
    writeState: async (s) => { state = s; writes++; },
    io,
  });
  return { contacts, renames, appends, getState: () => state, writes: () => writes };
}

describe('contacts.resolve', () => {
  it('first sight: registers the contact + returns a slug, state written once', async () => {
    const { contacts, getState, writes } = harness();
    const slug = await contacts.resolve(SURFACE, CHAT, { chatName: 'fam' });
    expect(slug).toBe('fam');
    expect(getContact(getState(), SURFACE, CHAT)?.slug).toBe(slug);
    expect(writes()).toBe(1);
  });

  it('second sight, same title: same slug, NO further write (steady state does not churn)', async () => {
    const { contacts, writes } = harness();
    const first = await contacts.resolve(SURFACE, CHAT, { chatName: 'fam' });
    const second = await contacts.resolve(SURFACE, CHAT, { chatName: 'fam' });
    expect(second).toBe(first);
    expect(writes()).toBe(1);   // one write on creation, none on the steady re-sight
  });

  it('title change: new slug returned, state updated, io.rename old→new, renames.log in the new dir, nested thread survives', async () => {
    // A KNOWN contact WITH a stored thread, so we can prove the rename does NOT
    // reset it (operator ruling: a rename is the SAME conversation under a new name).
    let seed = emptyState();
    const ens = ensureContact(seed, SURFACE, CHAT, { pushedName: 'fam', slugHint: 'fam' });
    seed = recordThread(ens.state, SURFACE, CHAT, 'sess-old', undefined, 'e');
    const oldSlug = ens.slug;

    const { contacts, renames, appends, getState } = harness(seed);
    const newSlug = await contacts.resolve(SURFACE, CHAT, { chatName: 'crew' });

    expect(newSlug).toBe('crew');
    expect(newSlug).not.toBe(oldSlug);

    // fs side-effects: the folder moved + logged its own rename history
    expect(renames).toHaveLength(1);
    expect(renames[0].from).toContain(oldSlug);
    expect(renames[0].to).toContain(newSlug);
    expect(appends).toHaveLength(1);
    expect(appends[0].p).toMatch(/renames\.log$/);
    expect(appends[0].p).toContain(newSlug);
    expect(appends[0].data).toContain(oldSlug);
    expect(appends[0].data).toContain(newSlug);

    // state: slug moved, nested thread intact (a rename does not reset the thread)
    const c = getContact(getState(), SURFACE, CHAT);
    expect(c.slug).toBe(newSlug);
    expect(c.entry.agents.e.threadId).toBe('sess-old');
  });

  it('title change where io.rename throws ENOENT: still succeeds (slug updated, no throw, no renames.log)', async () => {
    let state = emptyState();
    const ens = ensureContact(state, SURFACE, CHAT, { pushedName: 'fam', slugHint: 'fam' });
    state = ens.state;
    const oldSlug = ens.slug;
    const appends = [];
    const io = {
      rename: async () => { const e = new Error('missing'); e.code = 'ENOENT'; throw e; },
      appendFile: async (p, data) => { appends.push({ p, data }); },
    };
    const contacts = createContacts({ loadState: async () => state, writeState: async (s) => { state = s; }, io });

    const newSlug = await contacts.resolve(SURFACE, CHAT, { chatName: 'crew' });
    expect(newSlug).toBe('crew');
    expect(newSlug).not.toBe(oldSlug);
    expect(getContact(state, SURFACE, CHAT).slug).toBe(newSlug);   // state moved despite the fs miss
    expect(appends).toHaveLength(0);   // ENOENT → no folder to log the rename into
  });

  it('title change where io.rename throws EBUSY: entry stays on the OLD folder (slug + path), no renames.log; a later sighting retries', async () => {
    let state = emptyState();
    const ens = ensureContact(state, SURFACE, CHAT, { pushedName: 'fam', slugHint: 'fam' });
    state = ens.state;
    const oldSlug = ens.slug;
    let busy = true, writes = 0;
    const renames = [], appends = [];
    const io = {
      rename: async (from, to) => {
        renames.push({ from, to });
        if (busy) { const e = new Error('resource busy or locked'); e.code = 'EBUSY'; throw e; }
      },
      appendFile: async (p, data) => { appends.push({ p, data }); },
    };
    const contacts = createContacts({ loadState: async () => state, writeState: async (s) => { state = s; writes++; }, io });

    expect(await contacts.resolve(SURFACE, CHAT, { chatName: 'crew' })).toBe(oldSlug);
    const kept = getContact(state, SURFACE, CHAT).entry;
    expect(kept.slug).toBe(oldSlug);
    expect(kept.conversation_path).toBe(conversationPathOf(SURFACE, oldSlug));
    expect(kept.pushedName).toBe('crew');   // the title refresh still lands
    expect(appends).toHaveLength(0);
    expect(writes).toBe(1);

    // still busy: retried, nothing new to write
    expect(await contacts.resolve(SURFACE, CHAT, { chatName: 'crew' })).toBe(oldSlug);
    expect(renames).toHaveLength(2);
    expect(writes).toBe(1);

    // unlocked: the retry moves folder + slug + path together, logged once
    busy = false;
    const newSlug = await contacts.resolve(SURFACE, CHAT, { chatName: 'crew' });
    expect(newSlug).toBe('crew');
    const moved = getContact(state, SURFACE, CHAT).entry;
    expect(moved.slug).toBe(newSlug);
    expect(moved.conversation_path).toBe(conversationPathOf(SURFACE, newSlug));
    expect(appends).toHaveLength(1);
    expect(appends[0].p).toContain(newSlug);
  });

  it('rename succeeds but renames.log append fails: the move still commits (slug follows the folder)', async () => {
    let state = emptyState();
    state = ensureContact(state, SURFACE, CHAT, { pushedName: 'fam', slugHint: 'fam' }).state;
    const io = {
      rename: async () => {},
      appendFile: async () => { const e = new Error('denied'); e.code = 'EPERM'; throw e; },
    };
    const contacts = createContacts({ loadState: async () => state, writeState: async (s) => { state = s; }, io });
    const newSlug = await contacts.resolve(SURFACE, CHAT, { chatName: 'crew' });
    expect(newSlug).toBe('crew');
    expect(getContact(state, SURFACE, CHAT).slug).toBe(newSlug);
  });

  it('unknown/empty chatId → null (unresolvable, no write)', async () => {
    const { contacts, writes } = harness();
    expect(await contacts.resolve(SURFACE, '', { chatName: 'x' })).toBe(null);
    expect(await contacts.resolve(SURFACE, null)).toBe(null);
    expect(writes()).toBe(0);
  });

  it('two DIFFERENT chats resolving concurrently: neither first-turn registration is lost (serialized RMW)', async () => {
    // Two conversations' FIRST turns now run concurrently (per-conversation turn FIFO).
    // Both read-modify-write the ONE shared conversations registry; with a slow read/write
    // gap an UN-serialized pair each load the same empty state and clobber the other's
    // contact (classic lost update). mutateState serializes the whole load→mutate→write so
    // the second resolve reads the first's write. Backed by one shared in-memory var with
    // injected latency (same style as conversations-state's stats-serialize test).
    let state = emptyState();
    const slow = () => new Promise((r) => setTimeout(r, 8));
    const contacts = createContacts({
      loadState: async () => { await slow(); return state; },
      writeState: async (s) => { await slow(); state = s; },
    });
    const CHAT_A = '!rooma:beeper.com';
    const CHAT_B = '!roomb:beeper.com';
    const [slugA, slugB] = await Promise.all([
      contacts.resolve(SURFACE, CHAT_A, { chatName: 'alpha' }),
      contacts.resolve(SURFACE, CHAT_B, { chatName: 'bravo' }),
    ]);
    expect(slugA).toBe('alpha');
    expect(slugB).toBe('bravo');
    // BOTH contacts must survive in the final registry — the race would drop one.
    expect(getContact(state, SURFACE, CHAT_A)?.slug).toBe(slugA);
    expect(getContact(state, SURFACE, CHAT_B)?.slug).toBe(slugB);
  });
});
