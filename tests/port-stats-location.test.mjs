// port-stats-location.test.mjs — the core transform of setup/port-stats-location.mjs (the
// one-shot stats relocation). Importing the module does NOT run main() (gated on direct
// invocation). portStatsLocation is exercised against an in-memory fs fake + injectable path
// resolvers, so NO real disk / EGPT_HOME is touched. Covers: move, old+new merge, already-moved
// skip, the cross-chat SUM rollup, the ':'-sender sanitized filename, and idempotence.
import { describe, it, expect } from 'vitest';
import * as YAML from 'yaml';
import { portStatsLocation, backfillStatsIds, renameStatsToNames } from '../setup/port-stats-location.mjs';
import { sanitizeStatKey } from '../conversations-state.mjs';

// A Map-backed fs. readFile throws ENOENT on a miss; rm deletes; existsSync is has().
// Paths are normalized to forward slashes on every access so a caller that builds a path
// with node's path.join (backslashes on Windows) still hits the forward-slash keys — the
// same "both separators work" behavior the real Windows fs has.
function memIo(seed = {}) {
  const norm = (p) => String(p).replace(/\\/g, '/');
  const files = new Map(Object.entries(seed));
  const io = {
    readFile: async (p) => { const k = norm(p); if (!files.has(k)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return files.get(k); },
    writeFile: async (p, d) => { files.set(norm(p), d); },
    mkdir: async () => {},
    rm: async (p) => { files.delete(norm(p)); },
    // resolveStatFilename's rename pass moves a stats file to its human basename (operate on the
    // files Map, normalize both paths — mirrors rm/writeFile).
    rename: async (from, to) => { const f = norm(from), t = norm(to); if (files.has(f)) { files.set(t, files.get(f)); files.delete(f); } },
    // a file exists on an exact key; a directory "exists" iff some file lives under it
    existsSync: (p) => { const k = norm(p); return files.has(k) || [...files.keys()].some((f) => f.startsWith(k + '/')); },
    readdir: async (dir) => {
      const prefix = norm(dir).replace(/\/$/, '') + '/';
      const names = new Set();
      for (const p of files.keys()) {
        if (p.startsWith(prefix)) {
          const rest = p.slice(prefix.length);
          if (!rest.includes('/')) names.add(rest);
        }
      }
      return [...names];
    },
  };
  return { files, io };
}

// String path resolvers (no EGPT_HOME) mirroring the real ones' shapes.
const paths = {
  oldStatsFile: (s, slug) => `OLD/${s}/${slug}/stats.yaml`,
  chatFile: (s, chatId) => `NEW/${s}/${chatId}.yaml`,
  contactFile: (s, senderId) => `NEW/${s}/${sanitizeStatKey(senderId)}.yaml`,
  statsSurfaceDir: (s) => `NEW/${s}`,
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

describe('backfillStatsIds', () => {
  it('stamps chat_id (registry key) + real unsanitized sender_id, leaves an already-stamped file alone', async () => {
    const state = { contacts: { whatsapp: { '!fam': { slug: 'fam' } } } };
    const { files, io } = memIo({
      'NEW/whatsapp/!fam.yaml': y({ name: 'Fam', members: { '@alice:beeper.com': { count: 3, last_seen: 'T' } } }),
      'NEW/whatsapp/@alice~3abeeper.com.yaml': y({ count: 3, last_seen: 'T' }),                       // contact, no sender_id
      'NEW/whatsapp/@bob~3abeeper.com.yaml': y({ sender_id: '@bob:beeper.com', count: 1, last_seen: 'T' }), // already stamped
    });

    const r = await backfillStatsIds(state, { paths, io });
    expect(r).toEqual({ chatsStamped: 1, contactsStamped: 1, skipped: 1 });

    // chat file: chat_id = the registry key (the opaque short room token), body content preserved
    const fam = load(files, 'NEW/whatsapp/!fam.yaml');
    expect(fam.chat_id).toBe('!fam');
    expect(fam.members['@alice:beeper.com']).toEqual({ count: 3, last_seen: 'T' });

    // contact file: sender_id = the REAL unsanitized id, not the sanitized filename form
    const alice = load(files, 'NEW/whatsapp/@alice~3abeeper.com.yaml');
    expect(alice.sender_id).toBe('@alice:beeper.com');
    expect(alice.count).toBe(3);

    // already-stamped file untouched
    const bob = load(files, 'NEW/whatsapp/@bob~3abeeper.com.yaml');
    expect(bob.sender_id).toBe('@bob:beeper.com');
  });

  it('is idempotent: a second run stamps nothing and every file is byte-identical', async () => {
    const state = { contacts: { whatsapp: { '!fam': { slug: 'fam' } } } };
    const { files, io } = memIo({
      'NEW/whatsapp/!fam.yaml': y({ name: 'Fam', members: { '@alice:beeper.com': { count: 3, last_seen: 'T' } } }),
      'NEW/whatsapp/@alice~3abeeper.com.yaml': y({ count: 3, last_seen: 'T' }),
    });
    await backfillStatsIds(state, { paths, io });
    const afterFirst = new Map(files);
    const r2 = await backfillStatsIds(state, { paths, io });
    expect(r2).toEqual({ chatsStamped: 0, contactsStamped: 0, skipped: 2 });
    for (const [p, v] of files) expect(v).toBe(afterFirst.get(p));
    expect([...files.keys()].sort()).toEqual([...afterFirst.keys()].sort());
  });
});

describe('renameStatsToNames (the garbled-filename → human-name pass)', () => {
  it('renames id-based files to their body name; a second run is a byte-identical no-op, no former_names added', async () => {
    // Stamped (backfilled) id-based files: chat carries chat_id + a human `name`; contact carries
    // sender_id + a human `name` (a push name / number). The pass moves each to <name>.yaml.
    const chat = y({ chat_id: '!fam', name: 'Jorge Medina', members: { '@a:beeper.com': { count: 3, last_seen: 'T' } } });
    const contact = y({ sender_id: '@a:beeper.com', name: '+13478703471', count: 3, last_seen: 'T' });
    const { files, io } = memIo({
      'NEW/whatsapp/!fam.yaml': chat,
      'NEW/whatsapp/@a~3abeeper.com.yaml': contact,
    });

    const r = await renameStatsToNames(null, { paths, io });
    expect(r.renamed).toBe(2);

    // moved to human basenames; the id-based basenames are gone
    expect(files.has('NEW/whatsapp/!fam.yaml')).toBe(false);
    expect(files.has('NEW/whatsapp/@a~3abeeper.com.yaml')).toBe(false);
    // PURE fs rename: the body value is byte-identical (same ref) — no re-serialize, NO former_names
    expect(files.get('NEW/whatsapp/Jorge Medina.yaml')).toBe(chat);
    expect(files.get('NEW/whatsapp/+13478703471.yaml')).toBe(contact);
    expect(files.get('NEW/whatsapp/Jorge Medina.yaml')).not.toContain('former_names');

    // second run: every file already at its canonical name → no-op, byte-identical
    const afterFirst = new Map(files);
    const r2 = await renameStatsToNames(null, { paths, io });
    expect(r2.renamed).toBe(0);
    for (const [p, v] of files) expect(v).toBe(afterFirst.get(p));
    expect([...files.keys()].sort()).toEqual([...afterFirst.keys()].sort());
  });

  it('leaves an id-based file with no body name alone (nothing to rename toward)', async () => {
    const noName = y({ chat_id: '!fam', members: { '@a': { count: 1, last_seen: 'T' } } });
    const { files, io } = memIo({ 'NEW/whatsapp/!fam.yaml': noName });
    const r = await renameStatsToNames(null, { paths, io });
    expect(r.renamed).toBe(0);
    expect(files.get('NEW/whatsapp/!fam.yaml')).toBe(noName);   // untouched
  });
});

describe('port move pass tolerates already-renamed (human-name) new files', () => {
  it('merges a reappearing OLD file into the already-renamed human file, never creating a duplicate id-only file', async () => {
    const state = { contacts: { whatsapp: { '!fam': { slug: 'fam' } } } };
    const { files, io } = memIo({
      // an OLD-location file reappears (e.g. a partial earlier run)
      'OLD/whatsapp/fam/stats.yaml': y({ members: { '@a': { count: 2, last_seen: 'T2' } } }),
      // the chat's data ALREADY lives under its human name at the new location (stamped chat_id)
      'NEW/whatsapp/Jorge Medina.yaml': y({ chat_id: '!fam', name: 'Jorge Medina', members: { '@a': { count: 5, last_seen: 'T1' } } }),
    });

    const r = await portStatsLocation(state, { paths, io });
    expect(r).toMatchObject({ merged: 1, moved: 0 });
    // NO duplicate id-only file — the move resolved by body chat_id to the human file
    expect(files.has('NEW/whatsapp/!fam.yaml')).toBe(false);
    // merged into the human-named file (MAX count, LATEST last_seen), old file removed
    const chat = load(files, 'NEW/whatsapp/Jorge Medina.yaml');
    expect(chat.chat_id).toBe('!fam');
    expect(chat.members['@a']).toEqual({ count: 5, last_seen: 'T2' });
    expect(files.has('OLD/whatsapp/fam/stats.yaml')).toBe(false);
  });
});
