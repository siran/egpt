// room-outbox.test.mjs — THE ROOM OUTBOX: the being chooses WHAT leaves the room, never WHERE.
//
// THE CASE (measured 2026-09-22): a sandboxed being running as pool account egpt-sbx-NN finished
// six translation files and could not deliver them to `G:\My Drive\jose-lorenzo\ACIM-ES.v2`. The
// volume reports FAT32 — no ACLs exist on it to grant — and GoogleDriveFS.exe runs as `reve\an`,
// so the drive letter lives in that user's session and the pool account has no `G:` at all. There
// was no permission to grant; the path is simply absent from the being's world. The spine already
// runs as the operator, so the operator ruled a SPINE-SIDE COPY: the being writes into its own
// room's outbox/, the spine drains it to a destination the OPERATOR configured.
//
// WHAT EVERY TEST BELOW IS REALLY GUARDING: the destination never comes from anything the being
// produced. Not from a message, not from a filename, not from a link it planted in the folder. If
// it ever could, a sandboxed account would have a write path onto the operator's disk and the
// sandbox would be worth nothing — so the link/junction/directory cases here are not tidiness,
// they are the sandbox boundary, and "never overwrite" is what keeps a filename (the one thing
// the being DOES choose) from being able to destroy the operator's or Joyce's work.
//
// Real temp dirs (mkdtempSync) where the filesystem behaviour IS the thing under test — a link is
// only refused for real if a real link is refused — and injected `io` seams for the failures a
// temp dir cannot stage honestly (an unwritable folder on Windows).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Room } from '../src/room-core.mjs';
import { drainOutbox, describeDrain, resolveOutboxTarget, createOutboxDrain } from '../src/room-outbox.mjs';

// A Room rooted wherever we say. Room is abstract over exactly one method, so this is the whole
// subclass — and it proves the drain needs nothing from a Room but its own tree.
class TmpRoom extends Room {
  constructor(base) { super(); this._base = base; }
  baseDir() { return this._base; }
}

let TMP, room, OUT, DEST;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'egpt-outbox-'));
  room = new TmpRoom(join(TMP, 'room'));
  OUT = room.outboxDir;
  DEST = join(TMP, 'drive');
  mkdirSync(OUT, { recursive: true });
  mkdirSync(DEST, { recursive: true });
});
afterEach(() => { rmSync(TMP, { recursive: true, force: true }); });

const put = (dir, name, body) => { writeFileSync(join(dir, name), body, 'utf8'); return join(dir, name); };
const read = (dir, name) => readFileSync(join(dir, name), 'utf8');

// A RESOLVED target, as resolveOutboxTarget hands it to the drain: a NAME the operator approved
// and the path their node's `outbox_targets:` map turned it into. The drain is never given a
// bare path, because nothing in the running system ever has one that did not come from the map.
const tgt = (to, key = 'acim-drive') => ({ key, to, unknown: null });

describe('the drain moves what the being handed out', () => {
  it('a clean drain moves EVERY file and leaves the outbox empty', async () => {
    put(OUT, 'acim-01.md', 'chapter one');
    put(OUT, 'acim-02.md', 'chapter two');
    put(OUT, 'acim-03.md', 'chapter three');

    const r = await drainOutbox({ room, target: tgt(DEST) });

    expect(r.refused).toBe(null);
    expect(r.moved).toEqual(['acim-01.md', 'acim-02.md', 'acim-03.md']);
    expect(r.skipped).toEqual([]);
    // MOVED, NOT COPIED — an emptied outbox is how the being and the operator both read what is
    // still pending. A copy would leave every delivered file looking undelivered forever.
    expect(readdirSync(OUT)).toEqual([]);
    expect(readdirSync(DEST).sort()).toEqual(['acim-01.md', 'acim-02.md', 'acim-03.md']);
    expect(read(DEST, 'acim-02.md')).toBe('chapter two');
  });

  it('an EMPTY outbox is silent — a result of null, so nothing is said in the chat', async () => {
    expect(await drainOutbox({ room, target: tgt(DEST) })).toBe(null);
  });

  it('NO outbox folder at all is silent too — and the drain does not create one', async () => {
    const bare = new TmpRoom(join(TMP, 'never-seeded'));
    expect(await drainOutbox({ room: bare, target: tgt(DEST) })).toBe(null);
    expect(existsSync(bare.outboxDir)).toBe(false);
  });
});

describe('NEVER OVERWRITE — a name that is already there stays in the outbox', () => {
  it('leaves the colliding file, names the collision, and the destination copy is BYTE-IDENTICAL to what was already there', async () => {
    const already = 'the operator’s own version — never to be clobbered\n';
    put(DEST, 'shared.md', already);
    put(OUT, 'shared.md', 'the being’s version');
    put(OUT, 'fresh.md', 'this one has no twin');

    const r = await drainOutbox({ room, target: tgt(DEST) });

    expect(r.moved).toEqual(['fresh.md']);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].name).toBe('shared.md');
    expect(r.skipped[0].why).toContain('already at the destination');
    expect(r.skipped[0].why).not.toContain(DEST);      // the room is told WHAT collided, not WHERE
    // THE PROOF: what was in the destination is exactly what is still in the destination.
    expect(readFileSync(join(DEST, 'shared.md'), 'utf8')).toBe(already);
    // …and the being's copy is still in the outbox, unharmed, still pending.
    expect(readdirSync(OUT)).toEqual(['shared.md']);
    expect(read(OUT, 'shared.md')).toBe('the being’s version');
  });

  it('the collision is REPORTED to the operator by name, not swallowed', async () => {
    put(DEST, 'shared.md', 'mine');
    put(OUT, 'shared.md', 'theirs');
    const line = describeDrain(await drainOutbox({ room, target: tgt(DEST) }));
    expect(line).toMatch(/shared\.md is still in the outbox/);
  });
});

describe('the destination is the OPERATOR’s, and a bad one refuses the WHOLE drain', () => {
  const staged = () => { put(OUT, 'a.md', 'a'); put(OUT, 'b.md', 'b'); };

  it('a destination that does not exist refuses, NAMES THE PLACE, and moves nothing — and does not create it', async () => {
    staged();
    const missing = join(TMP, 'no-such-folder');
    const r = await drainOutbox({ room, target: tgt(missing) });
    expect(r.moved).toEqual([]);
    expect(r.refused).toContain('acim-drive');       // the KEY, which is what the room may know
    expect(r.refused).not.toContain(missing);        // never the path
    expect(r.refused).toMatch(/not there/);
    expect(readdirSync(OUT).sort()).toEqual(['a.md', 'b.md']);
    // NEVER CREATED. The operator names a real folder or nothing happens — a drain that made its
    // own destination would happily materialise a typo and quietly file six chapters into it.
    expect(existsSync(missing)).toBe(false);
  });

  it('a destination that is a FILE refuses and moves nothing', async () => {
    staged();
    const notADir = put(TMP, 'a-file-not-a-folder.txt', 'x');
    const r = await drainOutbox({ room, target: tgt(notADir) });
    expect(r.moved).toEqual([]);
    expect(r.refused).toMatch(/is not a folder/);
    expect(r.refused).toContain('acim-drive');
    expect(r.refused).not.toContain(notADir);
    expect(readdirSync(OUT).sort()).toEqual(['a.md', 'b.md']);
  });

  it('a destination that cannot be WRITTEN refuses the whole drain before a single file moves', async () => {
    staged();
    // The one failure a temp dir cannot stage honestly on Windows (a directory's ACL is not what
    // access(W_OK) reads there), so it rides the injected seam — the repo's own convention.
    const copied = [];
    const r = await drainOutbox({
      room, target: tgt(DEST),
      io: {
        access: async () => { const e = new Error('permission denied'); e.code = 'EACCES'; throw e; },
        copyFile: async (...a) => { copied.push(a); },
      },
    });
    expect(r.moved).toEqual([]);
    expect(r.refused).toMatch(/cannot be written to/);
    expect(r.refused).toContain('acim-drive');
    expect(r.refused).not.toContain(DEST);
    expect(copied).toEqual([]);                       // WHOLE drain: not one file was attempted
    expect(readdirSync(OUT).sort()).toEqual(['a.md', 'b.md']);
  });

  it('the destination is not even looked at when the outbox is empty — no stat per turn on a Drive path', async () => {
    let stats = 0;
    const r = await drainOutbox({ room, target: tgt(DEST), io: { stat: async (p) => { stats++; return statSync(p); } } });
    expect(r).toBe(null);
    expect(stats).toBe(0);
  });
});

describe('FILES ONLY, ONE LEVEL — a being must not be able to plant a link that redirects the move', () => {
  it('a directory and a JUNCTION in the outbox are skipped and never followed', async () => {
    const elsewhere = join(TMP, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    put(elsewhere, 'secret.txt', 'must not be delivered');

    mkdirSync(join(OUT, 'a-folder'), { recursive: true });
    put(join(OUT, 'a-folder'), 'nested.md', 'one level only');
    symlinkSync(elsewhere, join(OUT, 'a-junction'), 'junction');
    put(OUT, 'real.md', 'the only real file');

    const r = await drainOutbox({ room, target: tgt(DEST) });

    expect(r.moved).toEqual(['real.md']);
    expect(r.skipped.map((s) => s.name).sort()).toEqual(['a-folder', 'a-junction']);
    expect(r.skipped.find((s) => s.name === 'a-folder').why).toMatch(/folder|link/);
    expect(r.skipped.find((s) => s.name === 'a-junction').why).toMatch(/link/);
    // NOTHING WAS FOLLOWED: no recursion into the folder, nothing pulled through the junction.
    expect(readdirSync(DEST)).toEqual(['real.md']);
    expect(readdirSync(OUT).sort()).toEqual(['a-folder', 'a-junction']);
    expect(read(elsewhere, 'secret.txt')).toBe('must not be delivered');
  });

  it('a FILE SYMLINK is skipped — the file it points at is never the thing that moves', async () => {
    const outside = put(TMP, 'outside.txt', 'not the being’s to hand out');
    let madeIt = true;
    // A file symlink needs Developer Mode / SeCreateSymbolicLinkPrivilege on Windows. Where it
    // cannot be created there is nothing to test with a real link; the seam test below covers the
    // refusal deterministically either way.
    try { symlinkSync(outside, join(OUT, 'link.txt'), 'file'); } catch { madeIt = false; }
    if (!madeIt) return;
    put(OUT, 'real.md', 'ok');

    const r = await drainOutbox({ room, target: tgt(DEST) });
    expect(r.moved).toEqual(['real.md']);
    expect(r.skipped.map((s) => s.name)).toEqual(['link.txt']);
    expect(readdirSync(DEST)).toEqual(['real.md']);
    expect(existsSync(join(OUT, 'link.txt'))).toBe(true);
  });

  it('anything lstat reports as a link is refused BEFORE any copy is attempted (the seam, so this holds on every host)', async () => {
    put(OUT, 'looks-like-a-file.md', 'x');
    const copied = [];
    const r = await drainOutbox({
      room, target: tgt(DEST),
      io: {
        lstat: async () => ({ isSymbolicLink: () => true, isDirectory: () => false, isFile: () => true }),
        copyFile: async (...a) => { copied.push(a); },
      },
    });
    expect(r.moved).toEqual([]);
    expect(r.skipped[0].why).toMatch(/link/);
    expect(copied).toEqual([]);
  });
});

describe('a failure never throws into the turn', () => {
  it('a file that cannot be copied is reported and the REST of the drain still lands', async () => {
    put(OUT, 'good.md', 'g');
    put(OUT, 'bad.md', 'b');
    const r = await drainOutbox({
      room, target: tgt(DEST),
      io: {
        copyFile: async (src, dst, mode) => {
          if (String(src).endsWith('bad.md')) { const e = new Error('device is full'); e.code = 'ENOSPC'; throw e; }
          const { copyFile } = await import('node:fs/promises');
          return copyFile(src, dst, mode);
        },
      },
    });
    expect(r.moved).toEqual(['good.md']);
    expect(r.skipped.map((s) => s.name)).toEqual(['bad.md']);
    expect(r.skipped[0].why).toContain('ENOSPC');      // the CODE is actionable and discloses nothing
    expect(r.skipped[0].why).not.toContain(DEST);
    expect(readdirSync(OUT)).toEqual(['bad.md']);
  });

  it('a copy that lands but cannot be unlinked is NOT counted as delivered', async () => {
    put(OUT, 'stuck.md', 's');
    const r = await drainOutbox({
      room, target: tgt(DEST),
      io: { unlink: async () => { const e = new Error('in use'); e.code = 'EBUSY'; throw e; } },
    });
    expect(r.moved).toEqual([]);
    expect(r.skipped[0].why).toMatch(/could not be taken out of the outbox/);
    expect(existsSync(join(DEST, 'stuck.md'))).toBe(true);
  });

  it('an unforeseen failure returns a refusal instead of throwing', async () => {
    put(OUT, 'x.md', 'x');
    const logs = [];
    const r = await drainOutbox({
      room, target: tgt(DEST),
      io: { stat: async () => { throw Object.assign(new Error('boom'), { code: null }) } , access: async () => {} },
      onLog: (m) => logs.push(m),
    });
    expect(r.moved).toEqual([]);
    expect(r.refused).toBeTruthy();
  });
});

describe('UNSET = OFF — there is no default destination, ever', () => {
  it('no target named is a no-op that creates nothing and touches nothing', async () => {
    put(OUT, 'a.md', 'a');
    const touched = [];
    const spy = new Proxy({}, { get: (_t, k) => async (...a) => { touched.push([k, ...a]); throw new Error(`io.${String(k)} must not be called`); } });
    for (const target of [null, undefined, {}, { key: null, to: DEST }, { key: '', to: DEST }]) {
      expect(await drainOutbox({ room, target, io: spy })).toBe(null);
    }
    expect(touched).toEqual([]);
    expect(readdirSync(OUT)).toEqual(['a.md']);       // still pending, untouched
  });

  it('resolveOutboxTarget answers null at BOTH tiers when neither names one', () => {
    const map = { outbox_targets: { 'acim-drive': 'G:/Drive' } };
    expect(resolveOutboxTarget(null, 'egpt', map)).toBe(null);
    expect(resolveOutboxTarget({ outboxTo: null }, 'egpt', { ...map, agents: { egpt: { conversation_defaults: {} } } })).toBe(null);
    expect(resolveOutboxTarget({ outboxTo: '   ' }, 'egpt', map)).toBe(null);
    expect(resolveOutboxTarget({ outboxTo: 7 }, 'egpt', map)).toBe(null);
  });
});

// ── THE DESTINATION MODEL (operator 2026-09-22): the conversation names a KEY, and the node's
//    `outbox_targets:` map holds the only path. *"we have to configure a map: acim-drive ->
//    G:/My Drive/jose-lorenzo/ACIM-ES.v2 … key -> path/ per conversation"*.
//
//    THE PROPERTY THESE TESTS EXIST FOR: with a raw path, anything that can write the
//    conversation record can name any directory on the operator's disk. With a key it can only
//    SELECT among destinations the operator already approved — so the invariant survives even if
//    a conversation record is one day writable by something that should not be able to write it.
//    The key is a LOOKUP and never a path fragment, which is why a path-shaped value resolves to
//    NOTHING rather than to a sanitised path. ──
describe('WHERE: a key into the node’s approved map, resolved through the tiers that already exist', () => {
  // The same two-tier walk `compaction` takes at src/spine/brainpool.mjs — for a ROOM the
  // per-conversation block is its row in config/rooms.yaml (rooms-file.mergeRoomBeings hydrates
  // it into `entry.agents.<being>`, which is the ONE place getBeing reads). Migration 0022 is the
  // record of why it is per-being INSIDE the room row and not on the row itself: a key on the row
  // is read by nothing.
  const ACIM = 'G:/My Drive/jose-lorenzo/ACIM-ES.v2';
  const cfg = {
    outbox_targets: { 'acim-drive': ACIM, 'scratch': 'D:/scratch' },
    agents: { egpt: { conversation_defaults: { outbox_to: 'scratch' } } },
  };

  it('a known key resolves to EXACTLY the mapped path — the map is the only place a path appears', () => {
    expect(resolveOutboxTarget({ outboxTo: 'acim-drive' }, 'egpt', cfg)).toEqual({ key: 'acim-drive', to: ACIM, unknown: null });
  });

  it('the per-conversation (room row) key WINS over the agent-wide default key', () => {
    expect(resolveOutboxTarget({ outboxTo: 'acim-drive' }, 'egpt', cfg).to).toBe(ACIM);
  });

  it('with nothing on the room row it falls to agents.<being>.conversation_defaults.outbox_to', () => {
    expect(resolveOutboxTarget({ outboxTo: null }, 'egpt', cfg).to).toBe('D:/scratch');
  });

  it('a default belonging to ANOTHER being is not this being’s target', () => {
    expect(resolveOutboxTarget(null, 'wren', cfg)).toBe(null);
  });

  it('whitespace around the KEY is trimmed — it is a name, and a name is matched whole', () => {
    expect(resolveOutboxTarget({ outboxTo: '  acim-drive  ' }, 'egpt', cfg).to).toBe(ACIM);
  });

  it('an UNKNOWN key resolves to NO PATH, and is reported BY NAME rather than behaving like "off"', () => {
    const r = resolveOutboxTarget({ outboxTo: 'acim-drve' }, 'egpt', cfg);
    expect(r.to).toBe(null);
    expect(r.key).toBe('acim-drve');                       // a typo must be visible, not mysterious
    expect(r.unknown).toContain('acim-drve');
    expect(r.unknown).toContain('outbox_targets');
    expect(r.unknown).toContain('acim-drive');             // …and it names what this node DOES have
  });

  it('an ABSENT or unusable map makes every key unknown — it never falls back to a path', () => {
    for (const config of [{}, { outbox_targets: null }, { outbox_targets: [] }, { outbox_targets: 'G:/nope' }]) {
      const r = resolveOutboxTarget({ outboxTo: 'acim-drive' }, 'egpt', config);
      expect(r.to).toBe(null);
      expect(r.unknown).toContain('acim-drive');
    }
  });

  it('a mapped value that is not a usable path is unknown too, never a half-resolved destination', () => {
    for (const bad of [null, '', '   ', 42, {}, ['G:/x']]) {
      const r = resolveOutboxTarget({ outboxTo: 'k' }, 'egpt', { outbox_targets: { k: bad } });
      expect(r.to).toBe(null);
      expect(r.unknown).toContain('k');
    }
  });

  // THE SECURITY PROPERTY, LOCKED EXPLICITLY. Each of these is a value that WOULD have been a
  // real destination under the raw-path model this replaced. None of them can produce a path
  // now: the key is only ever looked up, so anything the map does not hold resolves to nothing.
  // Note there is no sanitiser being tested here — there is nothing to sanitise, which is the
  // point. A lookup cannot be talked into building a path the way a join can.
  it('a conversation value carrying a PATH or a TRAVERSAL resolves to NOTHING, never to a path', () => {
    const attempts = [
      '../../../Windows/System32',
      '..',
      './acim-drive',
      'acim-drive/sub',
      'acim-drive/../../..',
      'acim-drive\\sub',
      'G:/My Drive/jose-lorenzo/ACIM-ES.v2',        // the real path, typed where the KEY goes
      '/etc/passwd',
      'C:\\Users\\an\\.egpt',
      '__proto__',
      'constructor',
      'toString',
    ];
    for (const attempt of attempts) {
      const r = resolveOutboxTarget({ outboxTo: attempt }, 'egpt', cfg);
      expect(r.to, `"${attempt}" must not resolve to a path`).toBe(null);
      expect(r.unknown, `"${attempt}" must be reported, not silently ignored`).toBeTruthy();
    }
  });

  it('the resolved path is the map’s STRING — the key never contributes a fragment or a suffix', () => {
    const r = resolveOutboxTarget({ outboxTo: 'acim-drive' }, 'egpt', cfg);
    expect(r.to).toBe(ACIM);
    expect(r.to).not.toContain('acim-drive/');
    expect(r.to.endsWith('acim-drive')).toBe(false);
  });
});

describe('an UNKNOWN key stops the drain — and says so, by name', () => {
  const unknown = () => resolveOutboxTarget({ outboxTo: 'acim-drve' }, 'egpt', { outbox_targets: { 'acim-drive': 'G:/real' } });

  it('nothing moves, nothing is created, and the report names the key', async () => {
    put(OUT, 'pending.md', 'p');
    const touched = [];
    const r = await drainOutbox({
      room, target: unknown(),
      io: {
        stat: async (...a) => { touched.push(['stat', ...a]); throw new Error('must not look for a destination that was never resolved'); },
        copyFile: async (...a) => { touched.push(['copyFile', ...a]); },
      },
    });
    expect(r.moved).toEqual([]);
    expect(r.to).toBe(null);
    expect(r.refused).toContain('acim-drve');
    expect(touched).toEqual([]);                      // no destination was even looked for
    expect(readdirSync(OUT)).toEqual(['pending.md']); // still pending, still the being's
    expect(describeDrain(r)).toContain('acim-drve');
  });

  it('…but only once something is actually waiting on it — an empty outbox stays silent', async () => {
    expect(await drainOutbox({ room, target: unknown() })).toBe(null);
  });
});

// ── THE KEY GOES IN THE CHAT, THE PATH GOES IN THE LOG (operator 2026-09-22) ─────────────
//    Not a principle argued in the abstract — a measured room. The first room this ships to is
//    room/acim, whose invited wa-group is "perrito traduciones", and JOYCE IS IN THAT GROUP. She
//    is a translation collaborator, not the operator. A refusal line naming the real destination
//    would tell her the operator's filesystem layout, how his Drive is organised and a third
//    party's folder name. It is the ONLY destination configured, so this is the live case.
//
//    THIS IS THE LOCK, and it is deliberately a SWEEP rather than one assertion per message: the
//    failure mode is somebody improving the wording later and putting the path back in for
//    helpfulness. Every outcome the drain can produce is driven through describeDrain, and the
//    temp root — which every path in this file lives under — must be absent from what the room
//    would read. The operator loses nothing; the log half is asserted right below. ──
describe('what a ROOM reads names the key; what the OPERATOR reads names the path', () => {
  // Every outcome the drain can produce, each staging itself into a freshly emptied fixture.
  const OUTCOMES = {
    'a clean delivery': (log) => {
      put(OUT, 'acim-01.md', 'one'); put(OUT, 'acim-02.md', 'two');
      return drainOutbox({ room, target: tgt(DEST), onLog: log });
    },
    'a name collision': (log) => {
      put(DEST, 'shared.md', 'the operator’s'); put(OUT, 'shared.md', 'the being’s');
      return drainOutbox({ room, target: tgt(DEST), onLog: log });
    },
    'a destination that is not there': (log) => {
      put(OUT, 'a.md', 'a');
      return drainOutbox({ room, target: tgt(join(TMP, 'no-such-folder')), onLog: log });
    },
    'a destination that is a file': (log) => {
      put(OUT, 'a.md', 'a');
      return drainOutbox({ room, target: tgt(put(TMP, 'not-a-folder.txt', 'x')), onLog: log });
    },
    'a destination that cannot be written': (log) => {
      put(OUT, 'a.md', 'a');
      return drainOutbox({ room, target: tgt(DEST), onLog: log, io: { access: async () => { throw Object.assign(new Error(`permission denied, access '${DEST}'`), { code: 'EACCES' }); } } });
    },
    'a copy that fails': (log) => {
      put(OUT, 'a.md', 'a');
      return drainOutbox({ room, target: tgt(DEST), onLog: log, io: { copyFile: async () => { throw Object.assign(new Error(`no space, copyfile '${join(DEST, 'a.md')}'`), { code: 'ENOSPC' }); } } });
    },
    'a copy that lands but cannot be unlinked': (log) => {
      put(OUT, 'a.md', 'a');
      return drainOutbox({ room, target: tgt(DEST), onLog: log, io: { unlink: async () => { throw Object.assign(new Error(`busy, unlink '${join(OUT, 'a.md')}'`), { code: 'EBUSY' }); } } });
    },
    'a directory and a junction in the outbox': (log) => {
      mkdirSync(join(OUT, 'a-folder'), { recursive: true });
      symlinkSync(DEST, join(OUT, 'a-junction'), 'junction');
      put(OUT, 'real.md', 'r');
      return drainOutbox({ room, target: tgt(DEST), onLog: log });
    },
    'an unknown target key': (log) => {
      put(OUT, 'a.md', 'a');
      return drainOutbox({ room, target: resolveOutboxTarget({ outboxTo: 'acim-drve' }, 'egpt', { outbox_targets: { 'acim-drive': DEST } }), onLog: log });
    },
    'an unforeseen failure': (log) => {
      put(OUT, 'a.md', 'a');
      return drainOutbox({ room, target: tgt(DEST), onLog: log, io: { stat: async () => { throw new Error(`something broke near ${DEST}`); } } });
    },
  };

  // Each outcome runs against a fresh fixture, since several of them stage conflicting state.
  const each = async (fn) => {
    for (const [what, stage] of Object.entries(OUTCOMES)) {
      rmSync(TMP, { recursive: true, force: true });
      mkdirSync(OUT, { recursive: true });
      mkdirSync(DEST, { recursive: true });
      const logs = [];
      const result = await stage((m) => logs.push(m));
      await fn(what, result, describeDrain(result), logs.join('\n'));
    }
  };

  it('NO resolved path survives into the chat string, for ANY outcome the drain can produce', async () => {
    await each((what, _r, line) => {
      if (line === null) return;
      // TMP is the root every path in this file lives under — DEST, the outbox and the bogus
      // destinations alike — so its absence is the absence of all of them at once.
      expect(line, `${what}: leaked a path — ${line}`).not.toContain(TMP);
      // …and nothing that merely LOOKS like one either, however it got there.
      expect(line, `${what}: leaked something path-shaped — ${line}`).not.toMatch(/[A-Za-z]:[\\/]/);
    });
  });

  it('…and every outcome still says something useful', async () => {
    await each((what, r, line) => {
      expect(line, `${what}: said nothing at all`).toBeTruthy();
      // A DELIVERY or a REFUSAL names the TARGET — the target's own name, or, for the
      // unknown-key line, the name that was typed. A line about ONE FILE that stayed behind
      // names the FILE instead, which is the useful half there: the room already knows which
      // target the room has, and what it needs told is which of its files did not go.
      if (r.moved.length || r.refused) expect(line, `${what}: ${line}`).toMatch(/acim-dr/);
      for (const s of r.skipped) expect(line, `${what}: ${line}`).toContain(s.name);
    });
  });

  it('the OPERATOR loses nothing: every outcome that touched a destination logs the PATH', async () => {
    await each((what, _r, _line, log) => {
      if (!log) return;                      // a clean delivery's detail is logged by the caller
      expect(log, `${what}: the log should carry the path — ${log}`).toContain(TMP);
    });
  });

  it('an fs error carrying the path does NOT reach the chat through the error TEXT', async () => {
    put(OUT, 'a.md', 'a');
    const logs = [];
    // A REAL Node fs error stringifies WITH the path inside it. That is the back door the
    // code-only rule exists to shut: the message goes to the log, the errno code to the chat.
    const boom = Object.assign(new Error(`ENOENT: no such file or directory, stat '${DEST}'`), { code: 'ENOENT' });
    const r = await drainOutbox({ room, target: tgt(DEST), onLog: (m) => logs.push(m), io: { stat: async () => { throw boom; } } });
    expect(describeDrain(r)).not.toContain(DEST);
    expect(describeDrain(r)).toContain('ENOENT');         // the code is actionable and discloses nothing
    expect(logs.join('\n')).toContain(DEST);
  });

  it('the delivery line reads as the operator specified it', async () => {
    put(OUT, 'acim-01.md', 'one');
    expect(describeDrain(await drainOutbox({ room, target: tgt(DEST) })))
      .toBe('📤 outbox → `acim-drive`: delivered 1 file — acim-01.md');
  });

  it('the result still CARRIES the path for the caller that logs it — only the rendering drops it', async () => {
    put(OUT, 'acim-01.md', 'one');
    const r = await drainOutbox({ room, target: tgt(DEST) });
    expect(r.to).toBe(DEST);                              // available to onLog / the service
    expect(r.key).toBe('acim-drive');
    expect(describeDrain(r)).not.toContain(DEST);         // …and never rendered into the chat
  });
});

describe('the after-turn hook — ONE mechanism, fired once, and it cannot cost the turn', () => {
  const TURN = { outbox: { target: tgt('G:\\dest'), surface: 'room', slug: 'acim', being: 'egpt', chatId: '!group' } };

  const svc = (over = {}) => {
    const calls = [];
    const said = [];
    const logs = [];
    const s = createOutboxDrain({
      drain: async (args) => { calls.push(args); return { key: args.target.key, to: args.target.to, moved: ['one.md'], skipped: [], refused: null }; },
      roomFor: (surface, slug) => new TmpRoom(join(TMP, surface, slug)),
      say: async (chatId, text) => { said.push([chatId, text]); },
      onLog: (m) => logs.push(m),
      ...over,
    });
    return { s, calls, said, logs };
  };

  it('fires the drain EXACTLY ONCE per turn, for the room and destination the turn resolved', async () => {
    const { s, calls } = svc();
    await s.afterTurn(TURN);
    expect(calls).toHaveLength(1);
    expect(calls[0].target).toEqual({ key: 'acim-drive', to: 'G:\\dest', unknown: null });
    expect(calls[0].room.outboxDir).toBe(join(TMP, 'room', 'acim', 'outbox'));
  });

  it('does NOT fire at all when the conversation states no destination', async () => {
    const { s, calls, said } = svc();
    await s.afterTurn({});
    await s.afterTurn({ outbox: null });
    await s.afterTurn({ outbox: { target: null, surface: 'room', slug: 'acim', being: 'egpt' } });
    await s.afterTurn({ outbox: { target: { key: null, to: null }, surface: 'room', slug: 'acim', being: 'egpt' } });
    expect(calls).toEqual([]);
    expect(said).toEqual([]);
  });

  // A KEY THE MAP DOES NOT HAVE IS NOT "OFF". It must still reach the drain, because the whole
  // difference between a mysterious silence and a fixable typo is that the name gets said.
  it('still fires for an UNKNOWN key, so the typo is reported instead of vanishing', async () => {
    const { s, calls } = svc();
    await s.afterTurn({ outbox: { target: { key: 'acim-drve', to: null, unknown: 'names no target' }, surface: 'room', slug: 'acim', being: 'egpt', chatId: '!group' } });
    expect(calls).toHaveLength(1);
    expect(calls[0].target.key).toBe('acim-drve');
    expect(calls[0].target.to).toBe(null);
  });

  it('says what it did through the ONE placement, in the chat the turn’s reply went to', async () => {
    const { s, said } = svc();
    await s.afterTurn(TURN);
    expect(said).toHaveLength(1);
    expect(said[0][0]).toBe('!group');
    expect(said[0][1]).toContain('one.md');
  });

  // THE SPLIT, END TO END: the same delivery, said one way and logged another. This is the pair
  // the wording rule exists for — the room learns its files went to `acim-drive`, the operator
  // learns which folder on disk that was.
  it('the CHAT line names the key and the LOG line names the path — one event, two readerships', async () => {
    const { s, said, logs } = svc();
    await s.afterTurn(TURN);
    expect(said[0][1]).toContain('`acim-drive`');
    expect(said[0][1]).not.toContain('G:\\dest');
    expect(logs.join('\n')).toContain('G:\\dest');
    expect(logs.join('\n')).toContain('room/acim (egpt)');
  });

  it('says NOTHING when the drain had nothing to report', async () => {
    const { s, said, logs } = svc({ drain: async () => null });
    await s.afterTurn(TURN);
    expect(said).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('a THROWING drain does not break the turn — it logs, and the hook neither throws nor rejects', async () => {
    const { s, logs } = svc({ drain: async () => { throw new Error('the drive went away'); } });
    // brainpool's call site is exactly `try { afterTurn?.(…) } catch {}` and then it returns the
    // reply, so a rejection here would surface as an UNHANDLED one rather than as a broken turn.
    let threw = false;
    let p = null;
    try { p = s.afterTurn(TURN); } catch { threw = true; }
    expect(threw).toBe(false);
    await expect(p).resolves.toBe(null);
    expect(logs.join('\n')).toContain('the drive went away');
  });

  it('a say that throws is logged and still does not break the turn', async () => {
    const { s, logs } = svc({ say: async () => { throw new Error('bridge is down'); } });
    await expect(s.afterTurn(TURN)).resolves.toBeTruthy();
    expect(logs.join('\n')).toContain('bridge is down');
  });
});

describe('once at boot — what the being handed out while the spine was down', () => {
  const TARGETS = { outbox_targets: { 'acim-drive': 'G:/My Drive/acim', 'scratch': 'D:/scratch' } };
  const stateWith = (block) => ({
    contacts: {
      room: { acim: { slug: 'acim', agents: { egpt: block } } },
      whatsapp: { '1@s.whatsapp.net': { slug: 'joyce', agents: { egpt: {} } } },
    },
  });

  const sweeper = (state, over = {}) => {
    const calls = [];
    const said = [];
    const s = createOutboxDrain({
      getConfig: () => TARGETS,
      drain: async (args) => { calls.push(args.target.to); return { key: args.target.key, to: args.target.to, moved: ['left-behind.md'], skipped: [], refused: null }; },
      roomFor: (surface, slug) => new TmpRoom(join(TMP, surface, slug)),
      say: async (chatId, text) => { said.push([chatId, text]); },
      loadState: async () => state,
      ...over,
    });
    return { s, calls, said };
  };

  it('drains every conversation whose operator config names a target, and no others', async () => {
    const { s, calls } = sweeper(stateWith({ outbox_to: 'acim-drive' }));
    await s.atBoot();
    expect(calls).toEqual(['G:/My Drive/acim']);      // joyce names no target: not one fs call
  });

  it('reads the SAME two tiers AND the SAME map the turn does — one resolver, never two', async () => {
    const { s, calls } = sweeper(stateWith({}), {
      getConfig: () => ({ ...TARGETS, agents: { egpt: { conversation_defaults: { outbox_to: 'scratch' } } } }),
    });
    await s.atBoot();
    expect(calls).toEqual(['D:/scratch', 'D:/scratch']);
  });

  // A TYPO MUST SURFACE AT BOOT TOO, not only on the next turn that room happens to take.
  it('a conversation naming an UNKNOWN key is swept too, so the typo surfaces rather than never', async () => {
    const { s, calls } = sweeper(stateWith({ outbox_to: 'acim-drve' }));
    const out = await s.atBoot();
    expect(calls).toEqual([null]);                    // reached the drain with no path to move to
    expect(out).toHaveLength(1);
  });

  it('with NO target named anywhere it is a complete no-op', async () => {
    const { s, calls, said } = sweeper(stateWith({}));
    expect(await s.atBoot()).toEqual([]);
    expect(calls).toEqual([]);
    expect(said).toEqual([]);
  });

  it('says what it swept in the chat it is given, and only logs when given none', async () => {
    const { s, said } = sweeper(stateWith({ outbox_to: 'acim-drive' }));
    await s.atBoot({ chatId: '!self' });
    expect(said).toEqual([['!self', expect.stringContaining('left-behind.md')]]);

    const quiet = sweeper(stateWith({ outbox_to: 'acim-drive' }));
    await quiet.s.atBoot();
    expect(quiet.said).toEqual([]);
  });

  it('a registry that will not load is logged, never thrown', async () => {
    const logs = [];
    const s = createOutboxDrain({ loadState: async () => { throw new Error('conversations.yaml is gone'); }, onLog: (m) => logs.push(m) });
    await expect(s.atBoot()).resolves.toEqual([]);
    expect(logs.join('\n')).toContain('conversations.yaml is gone');
  });
});

describe('outbox/ is part of the Room tree, for every room and every conversation', () => {
  it('ensureTree creates it, and is idempotent — a second call keeps what is pending', async () => {
    const fresh = new TmpRoom(join(TMP, 'fresh'));
    await fresh.ensureTree();
    expect(statSync(fresh.outboxDir).isDirectory()).toBe(true);
    expect(readdirSync(fresh.outboxDir)).toEqual([]);

    put(fresh.outboxDir, 'pending.md', 'still here');
    await fresh.ensureTree();
    expect(readdirSync(fresh.outboxDir)).toEqual(['pending.md']);
    expect(read(fresh.outboxDir, 'pending.md')).toBe('still here');
  });

  it('it is in treeDirs, so BOTH creation paths get it (a conversation IS a Room)', () => {
    for (const surface of ['room', 'whatsapp', 'agent']) {
      const r = Room.forChat(surface, 'x');
      expect(r.treeDirs()).toContain(r.outboxDir);
      expect(r.outboxDir.endsWith(join('x', 'outbox'))).toBe(true);
    }
  });
});
