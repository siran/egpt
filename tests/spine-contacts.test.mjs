// contacts.resolve: the ONE shared contact-resolver. Registers on first sight,
// re-arms the pushedName/rename self-heal for KNOWN chats (the thing the three
// private resolveSlug copies never did), and carries the v1-parity rename side-
// effect — move the on-disk slug dir old→new + write renames.log. In-memory io +
// conv-state; no disk.
import { describe, it, expect } from 'vitest';
import { createContacts } from '../src/spine/contacts.mjs';
import { emptyState, getContact, ensureContact, recordThread } from '../conversations-state.mjs';

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
    expect(slug).toMatch(/^fam-\d{10}$/);
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

  it('title change: new slug returned, state updated, io.rename old→new, renames.log in the new dir, thread nulled', async () => {
    // A KNOWN contact WITH a stored thread, so we can prove the rename invalidates it.
    let seed = emptyState();
    const ens = ensureContact(seed, SURFACE, CHAT, { pushedName: 'fam', slugHint: 'fam' });
    seed = recordThread(ens.state, SURFACE, CHAT, 'sess-old');
    const oldSlug = ens.slug;

    const { contacts, renames, appends, getState } = harness(seed);
    const newSlug = await contacts.resolve(SURFACE, CHAT, { chatName: 'crew' });

    expect(newSlug).toMatch(/^crew-\d{10}$/);
    expect(newSlug).not.toBe(oldSlug);
    // the -yymmddhhmm suffix is preserved (encodes firstSeen → keeps ordering)
    expect(newSlug.match(/-(\d{10})$/)[1]).toBe(oldSlug.match(/-(\d{10})$/)[1]);

    // fs side-effects: the folder moved + logged its own rename history
    expect(renames).toHaveLength(1);
    expect(renames[0].from).toContain(oldSlug);
    expect(renames[0].to).toContain(newSlug);
    expect(appends).toHaveLength(1);
    expect(appends[0].p).toMatch(/renames\.log$/);
    expect(appends[0].p).toContain(newSlug);
    expect(appends[0].data).toContain(oldSlug);
    expect(appends[0].data).toContain(newSlug);

    // state: slug moved, claude session invalidated (cwd changed under it)
    const c = getContact(getState(), SURFACE, CHAT);
    expect(c.slug).toBe(newSlug);
    expect(c.entry.threadId).toBe(null);
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
    expect(newSlug).toMatch(/^crew-\d{10}$/);
    expect(newSlug).not.toBe(oldSlug);
    expect(getContact(state, SURFACE, CHAT).slug).toBe(newSlug);   // state moved despite the fs miss
    expect(appends).toHaveLength(0);   // ENOENT → no folder to log the rename into
  });

  it('unknown/empty chatId → null (unresolvable, no write)', async () => {
    const { contacts, writes } = harness();
    expect(await contacts.resolve(SURFACE, '', { chatName: 'x' })).toBe(null);
    expect(await contacts.resolve(SURFACE, null)).toBe(null);
    expect(writes()).toBe(0);
  });
});
