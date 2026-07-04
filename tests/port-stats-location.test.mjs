// port-stats-location.test.mjs — the core transform of setup/port-stats-location.mjs (the
// one-shot stats relocation). Importing the module does NOT run main() (gated on direct
// invocation). portStatsLocation is exercised against an in-memory fs fake + injectable path
// resolvers, so NO real disk / EGPT_HOME is touched. Covers: move, old+new merge, already-moved
// skip, the cross-chat SUM rollup, the ':'-sender sanitized filename, and idempotence.
import { describe, it, expect } from 'vitest';
import * as YAML from 'yaml';
import { portStatsLocation } from '../setup/port-stats-location.mjs';
import { sanitizeStatKey } from '../conversations-state.mjs';

// A Map-backed fs. readFile throws ENOENT on a miss; rm deletes; existsSync is has().
function memIo(seed = {}) {
  const files = new Map(Object.entries(seed));
  const io = {
    readFile: async (p) => { if (!files.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return files.get(p); },
    writeFile: async (p, d) => { files.set(p, d); },
    mkdir: async () => {},
    rm: async (p) => { files.delete(p); },
    existsSync: (p) => files.has(p),
  };
  return { files, io };
}

// String path resolvers (no EGPT_HOME) mirroring the real ones' shapes.
const paths = {
  oldStatsFile: (s, slug) => `OLD/${s}/${slug}/stats.yaml`,
  chatFile: (s, chatId) => `NEW/${s}/${chatId}.yaml`,
  contactFile: (s, senderId) => `NEW/${s}/${sanitizeStatKey(senderId)}.yaml`,
};

const y = (o) => YAML.stringify(o);
const load = (files, p) => YAML.parse(files.get(p));

describe('portStatsLocation', () => {
  it('moves each per-chat file old→new and SUMS a shared sender across chats into a per-contact rollup', async () => {
    const state = { contacts: { whatsapp: { '!fam': { slug: 'fam' }, '!work': { slug: 'work' } } } };
    const { files, io } = memIo({
      'OLD/whatsapp/fam/stats.yaml': y({ name: 'fam', threads: [{ id: 'T-fam' }], members: { '@alice:beeper.com': { count: 5, last_seen: '2026-07-01T10:00:00.000Z' }, '@carol:beeper.com': { count: 2, last_seen: '2026-06-15T09:00:00.000Z' } } }),
      'OLD/whatsapp/work/stats.yaml': y({ name: 'work', members: { '@alice:beeper.com': { count: 7, last_seen: '2026-07-03T14:00:00.000Z' } } }),
    });

    const r = await portStatsLocation(state, { paths, io });
    expect(r).toEqual({ moved: 2, merged: 0, skipped: 0, contactsWritten: 2 });

    // old files deleted, new per-chat files written
    expect(files.has('OLD/whatsapp/fam/stats.yaml')).toBe(false);
    expect(files.has('OLD/whatsapp/work/stats.yaml')).toBe(false);
    expect(load(files, 'NEW/whatsapp/!fam.yaml').members['@alice:beeper.com'].count).toBe(5);

    // SUM across the two chats (disjoint tallies): 5 + 7 = 12; last_seen = the LATEST
    const alice = load(files, `NEW/whatsapp/${sanitizeStatKey('@alice:beeper.com')}.yaml`);
    expect(alice).toEqual({ count: 12, last_seen: '2026-07-03T14:00:00.000Z' });
    // ':'-bearing sender id sanitized into the filename (collision-safe), and never a name
    expect(files.has('NEW/whatsapp/@alice~3abeeper.com.yaml')).toBe(true);
    expect(load(files, 'NEW/whatsapp/@carol~3abeeper.com.yaml')).toEqual({ count: 2, last_seen: '2026-06-15T09:00:00.000Z' });
  });

  it('merges conservatively when old AND new both exist: threads unioned, member count MAX / last_seen LATEST', async () => {
    const state = { contacts: { whatsapp: { '!c': { slug: 'c' } } } };
    const { files, io } = memIo({
      'OLD/whatsapp/c/stats.yaml': y({ threads: [{ id: 'T-old' }], members: { '@x': { count: 3, last_seen: '2026-01-01T00:00:00.000Z' } } }),
      'NEW/whatsapp/!c.yaml': y({ threads: [{ id: 'T-new' }], members: { '@x': { count: 5, last_seen: '2026-02-01T00:00:00.000Z' } } }),
    });

    const r = await portStatsLocation(state, { paths, io });
    expect(r.merged).toBe(1);
    expect(r.moved).toBe(0);
    const chat = load(files, 'NEW/whatsapp/!c.yaml');
    expect(chat.threads.map((t) => t.id).sort()).toEqual(['T-new', 'T-old']);   // union by id
    expect(chat.members['@x']).toEqual({ count: 5, last_seen: '2026-02-01T00:00:00.000Z' });   // MAX count, LATEST last_seen
    expect(files.has('OLD/whatsapp/c/stats.yaml')).toBe(false);
  });

  it('skips an already-moved contact (old missing, new present) — new file untouched', async () => {
    const state = { contacts: { whatsapp: { '!c': { slug: 'c' } } } };
    const NEW = y({ members: { '@x': { count: 9, last_seen: 'Z' } } });
    const { files, io } = memIo({ 'NEW/whatsapp/!c.yaml': NEW });
    const r = await portStatsLocation(state, { paths, io });
    expect(r.skipped).toBe(1);
    expect(r.moved).toBe(0);
    expect(files.get('NEW/whatsapp/!c.yaml')).toBe(NEW);   // untouched (byte-identical)
  });

  it('skips aliases and slug-less entries (nothing to move)', async () => {
    const state = { contacts: { whatsapp: { '!a': { aliasOf: '!c' }, '!b': { pushedName: 'x' } } } };
    const { files, io } = memIo({});
    const r = await portStatsLocation(state, { paths, io });
    expect(r).toEqual({ moved: 0, merged: 0, skipped: 0, contactsWritten: 0 });
    expect(files.size).toBe(0);
  });

  it('is idempotent: a second run moves nothing and recomputes the SAME contact bytes', async () => {
    const state = { contacts: { whatsapp: { '!fam': { slug: 'fam' } } } };
    const { files, io } = memIo({
      'OLD/whatsapp/fam/stats.yaml': y({ members: { '@x': { count: 4, last_seen: 'T' } } }),
    });
    await portStatsLocation(state, { paths, io });
    const afterFirst = new Map(files);
    const r2 = await portStatsLocation(state, { paths, io });
    expect(r2.moved).toBe(0);
    expect(r2.merged).toBe(0);
    expect(r2.skipped).toBe(1);
    // every file byte-identical after the second run (recompute → same output)
    for (const [p, v] of files) expect(v).toBe(afterFirst.get(p));
    expect([...files.keys()].sort()).toEqual([...afterFirst.keys()].sort());
  });
});
