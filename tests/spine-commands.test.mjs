// Operator slash commands: recognition (Self DM / authorized), lifecycle exits,
// and the loop intercept (a command is never routed to the brain).
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCommands, normalizeAgentsArgs, AGENTS_USAGE, SINGULAR_CMD, PLURAL_OF } from '../src/spine/commands.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { createTranscript } from '../src/spine/transcript.mjs';
import { contextSinceLastTurn } from '../src/transcript-log.mjs';
import { COMMANDS } from '../src/interpreter.mjs';
import { Room } from '../src/room-core.mjs';
import { EGPT_HOME } from '../src/egpt-home.mjs';
import { emptyState, ensureContact, getBeing, getContact, patchContact } from '../src/conversations-state.mjs';

function harness({ config = {}, state = null, brains, io = {}, cdp, launch, clock, resolveConvRoom, onRoomChange, logTranscript } = {}) {
  const sent = [], exits = [], rewinds = [], writes = [], evicts = [], roomChanges = [], logged = [];
  const files = {};   // any command-authored files (e.g. /rooms create's config.yaml)
  let st = state;
  // /chrome launch + clock seams: default to a fake that reports "task not registered"
  // and an advancing fake clock, so NO command test ever runs real schtasks or waits real
  // wall-clock time (both seams are consumed ONLY by /chrome's chromeReport).
  const fakeClock = clock ?? (() => { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms; } }; })();
  const cmds = createCommands({
    getConfig: () => config,
    ...(cdp ? { cdp } : {}),
    launchChromeTask: launch ?? (() => ({ ok: false })),
    now: fakeClock.now,
    sleep: fakeClock.sleep,
    send: async (chatId, text) => sent.push({ chatId, text }),
    exit: (code) => exits.push(code),
    writeRewindTarget: (ref) => rewinds.push(ref),
    loadState: state ? async () => st : null,
    writeState: state ? async (s) => { writes.push(s); st = s; } : null,
    brains: brains ?? { resolve: (name) => ({ name, type: 'ccode', allowed_tools: 'all' }) },
    evictWarm: (key) => evicts.push(key),
    io: { writeFile: async (p, c) => { files[p] = c; }, mkdir: async () => {}, ...io },
    ...(resolveConvRoom ? { resolveConvRoom } : {}),
    // The transcript service's reply writer (boot injects services.transcript.log) — captured
    // by default so a test can assert WHAT was written where, or overridden with a real
    // createTranscript when the BYTES are the claim.
    logTranscript: logTranscript ?? (async (ev, reply) => { logged.push({ ev, reply }); return true; }),
    onRoomChange: (surface, slug) => { roomChanges.push({ surface, slug }); onRoomChange?.(surface, slug); },
  });
  return { cmds, sent, exits, rewinds, writes, evicts, files, roomChanges, logged, getState: () => st };
}

describe('commands.isCommand', () => {
  it('recognizes a slash command in the Self DM', () => {
    const { cmds } = harness({ config: { whatsapp: { chat_id: '!self' } } });
    expect(cmds.isCommand({ body: '/restart', chatId: '!self' })).toBe(true);
  });
  it('recognizes a slash command from an authorized sender / own send anywhere', () => {
    const { cmds } = harness();
    expect(cmds.isCommand({ body: '/restart', chatId: '!group', authorized: true })).toBe(true);
    expect(cmds.isCommand({ body: '/restart', chatId: '!group', isSender: true })).toBe(true);
  });
  it('does NOT recognize a slash command from a random chat/sender', () => {
    const { cmds } = harness({ config: { whatsapp: { chat_id: '!self' } } });
    expect(cmds.isCommand({ body: '/restart', chatId: '!group' })).toBe(false);
  });
  it('recognizes a slash command in the TELEGRAM surface Self DM (per-surface chat_id)', () => {
    const { cmds } = harness({ config: { whatsapp: { chat_id: '!self' }, telegram: { chat_id: '!tg-self' } } });
    expect(cmds.isCommand({ body: '/restart', chatId: '!tg-self', surface: 'telegram' })).toBe(true);
  });
  it('does NOT recognize a slash command from a random telegram chat', () => {
    const { cmds } = harness({ config: { telegram: { chat_id: '!tg-self' } } });
    expect(cmds.isCommand({ body: '/restart', chatId: '!tg-group', surface: 'telegram' })).toBe(false);
  });
  it('the whatsapp Self chat_id does NOT authorize the same id on the telegram surface (namespace)', () => {
    const { cmds } = harness({ config: { whatsapp: { chat_id: '!self' } } });
    expect(cmds.isCommand({ body: '/restart', chatId: '!self', surface: 'telegram' })).toBe(false);
  });
  it('does NOT treat plain text (or @e) as a command', () => {
    const { cmds } = harness();
    expect(cmds.isCommand({ body: 'hola', chatId: '!self', authorized: true })).toBe(false);
    expect(cmds.isCommand({ body: '@e estas?', chatId: '!self', authorized: true })).toBe(false);
  });
});

describe('commands.run', () => {
  it('lifecycle commands exit with the daemon codes', async () => {
    const { cmds, exits } = harness();
    await cmds.run({ body: '/restart', chatId: '!self' });
    await cmds.run({ body: '/upgrade', chatId: '!self' });
    expect(exits).toEqual([43, 42]);
  });
  it('/rewind <ref> writes the target then exits 44', async () => {
    const { cmds, exits, rewinds } = harness();
    await cmds.run({ body: '/rewind deadbeef', chatId: '!self' });
    expect(rewinds).toEqual(['deadbeef']);
    expect(exits).toEqual([44]);
  });
  it('an unwired command is acknowledged (no exit, not leaked to E)', async () => {
    const { cmds, sent, exits } = harness();
    await cmds.run({ body: '/channels', chatId: '!self' });
    expect(exits).toEqual([]);
    // The echoed token is QUOTED (2026-07-25 incident): the catch-all's own reply used to
    // start with the token, so it re-parsed as a command and the two nodes traded it forever.
    expect(sent[0].text).toMatch(/`\/channels`: recognized/);
    expect(sent[0].text.startsWith('/')).toBe(false);
  });

  it('/agents auto <mode> e persists the conversation mode into conversations.yaml', async () => {
    const state = ensureContact(emptyState(), 'whatsapp', '!room', { pushedName: 'fam', slugHint: 'fam' }).state;
    const { cmds, sent, getState } = harness({ state });
    await cmds.run({ body: '/agents auto on e', chatId: '!room', surface: 'whatsapp' });
    expect(getBeing(getState(), 'whatsapp', '!room', 'e').mode).toBe('on');
    expect(sent[0].text).toMatch(/e mode here → on/);
  });

  // The `agents:` override block WINS getBeing's field-wise merge (operator 2026-07-25), so a
  // write into entry[e].mode was invisible — the command answered "✅ … → on" while the
  // effective mode stayed pinned. The write must land where the READ resolves it.
  it('/agents auto <mode> e changes the effective mode even when an agents: block pins it', async () => {
    const state = ensureContact(emptyState(), 'whatsapp', '!room', { pushedName: 'fam', slugHint: 'fam' }).state;
    state.contacts.whatsapp['!room'].agents = { e: { mode: 'mention' } };
    const { cmds, sent, getState } = harness({ state });
    await cmds.run({ body: '/agents auto on e', chatId: '!room', surface: 'whatsapp' });
    expect(getBeing(getState(), 'whatsapp', '!room', 'e').mode).toBe('on');
    expect(sent[0].text).toMatch(/e mode here → on/);
  });

  // Phase 1 (operator 2026-08-14): there is only ONE destination now — every write lands in
  // agents.<being>, first write included, whether or not the conversation ever used it before.
  it('/agents auto <mode> e on a never-before-touched conversation writes into agents.<being> — the only destination now', async () => {
    const state = ensureContact(emptyState(), 'whatsapp', '!room', { pushedName: 'fam', slugHint: 'fam' }).state;
    const { cmds, getState } = harness({ state });
    await cmds.run({ body: '/agents auto on e', chatId: '!room', surface: 'whatsapp' });
    const entry = getState().contacts.whatsapp['!room'];
    expect(entry.agents.e.mode).toBe('on');
    expect(entry.e).toBeUndefined();   // no pre-phase-1 entry[<being>] block is ever written
  });

  it('/agents auto <bad> e is rejected and leaves the mode unchanged', async () => {
    const state = ensureContact(emptyState(), 'whatsapp', '!room', { pushedName: 'fam', slugHint: 'fam' }).state;
    const { cmds, sent, getState } = harness({ state });
    await cmds.run({ body: '/agents auto loud e', chatId: '!room', surface: 'whatsapp' });
    expect(getBeing(getState(), 'whatsapp', '!room', 'e').mode).toBe(null);
    expect(sent[0].text).toMatch(/unknown mode/);
  });

  it('/agents auto accum e is accepted and persisted (accum is a mode again, operator 2026-07-26)', async () => {
    const state = ensureContact(emptyState(), 'whatsapp', '!room', { pushedName: 'fam', slugHint: 'fam' }).state;
    const { cmds, sent, getState } = harness({ state });
    await cmds.run({ body: '/agents auto accum e', chatId: '!room', surface: 'whatsapp' });
    expect(getBeing(getState(), 'whatsapp', '!room', 'e').mode).toBe('accum');
    expect(sent[0].text).toMatch(/e mode here → accum/);
  });

  it('the unknown-mode error offers the WHOLE enum, accum included', async () => {
    const state = ensureContact(emptyState(), 'whatsapp', '!room', { pushedName: 'fam', slugHint: 'fam' }).state;
    const { cmds, sent } = harness({ state });
    await cmds.run({ body: '/agents auto batch e', chatId: '!room', surface: 'whatsapp' });
    expect(sent[0].text).toMatch(/unknown mode "batch"/);
    expect(sent[0].text).toMatch(/on, auto, mute, mention-direct, mention, accum, off/);
  });

  it('/agents=hfm auto <mode> e from Self sets the NAMED chat (not the Self DM)', async () => {
    const state = ensureContact(emptyState(), 'whatsapp', '!hfm:beeper.local', { pushedName: 'HFM', slugHint: 'HFM' }).state;
    const { cmds, sent, getState } = harness({ state });
    await cmds.run({ body: '/agents=hfm auto on e', chatId: '!self', surface: 'whatsapp' });
    expect(getBeing(getState(), 'whatsapp', '!hfm:beeper.local', 'e').mode).toBe('on');   // the NAMED chat
    expect(getBeing(getState(), 'whatsapp', '!self', 'e')).toBe(null);                     // Self DM untouched (not even a contact)
    expect(sent[0].text).toMatch(/HFM.*→ on/);
  });

  it('/agents=<unknown> auto <mode> e reports no match', async () => {
    const state = ensureContact(emptyState(), 'whatsapp', '!hfm:beeper.local', { pushedName: 'HFM', slugHint: 'HFM' }).state;
    const { cmds, sent } = harness({ state });
    await cmds.run({ body: '/agents=zzz auto on e', chatId: '!self', surface: 'whatsapp' });
    expect(sent[0].text).toMatch(/no chat matches/);
  });

  it('/agents=<unknown-jid> auto <mode> e errors and does NOT write state (no false ✅)', async () => {
    const state = ensureContact(emptyState(), 'whatsapp', '!hfm:beeper.local', { pushedName: 'HFM', slugHint: 'HFM' }).state;
    const { cmds, sent, writes } = harness({ state });
    // A verbatim jid E has never seen: patchContact would silently no-op, so the
    // old code replied "✅" for a chat it never touched. Now it must fail loudly.
    await cmds.run({ body: '/agents=!nope:beeper.local auto mute e', chatId: '!self', surface: 'whatsapp' });
    expect(sent[0].text).toMatch(/no chat matches/);
    expect(writes).toHaveLength(0);
  });

  it('/agents=<known-jid> auto <mode> e succeeds and writes state', async () => {
    const state = ensureContact(emptyState(), 'whatsapp', '!hfm:beeper.local', { pushedName: 'HFM', slugHint: 'HFM' }).state;
    const { cmds, sent, writes, getState } = harness({ state });
    await cmds.run({ body: '/agents=!hfm:beeper.local auto mute e', chatId: '!self', surface: 'whatsapp' });
    expect(getBeing(getState(), 'whatsapp', '!hfm:beeper.local', 'e').mode).toBe('mute');
    expect(writes).toHaveLength(1);
    expect(sent[0].text).toMatch(/→ mute/);
  });
});

// /agents reset <handle>|all — restarts the CURRENT conversation (bare, self-only, unless
// `=<slug>` names a different one): archives the whole folder aside (never delete), wipes
// the TARGET being(s)' registry state, reseeds a pristine tree at the ORIGINAL path. "It
// works the same for rooms and conversations alike" (operator) — ONE shared path, proven
// here by running the identical assertions against a room-surface slug (fixed, no
// timestamp) and an ordinary whatsapp slug (timestamped). Was /e reset, hardcoded to
// defaultKey — "a failure in design" (operator 2026-08-15) once every being resolves
// identically: a sibling resident on the SAME conversation survived a reset meant to cover
// "this conversation" untouched, simply because /e reset could never even NAME it. The
// sibling-survives-reset tests below are the regression lock for exactly that bug.
describe('/agents reset <handle>|all — archive + registry wipe + reseed, one shared path for rooms and ordinary conversations', () => {
  const cases = [
    { label: 'a room-surface conversation (fixed slug)', surface: 'room', jid: 'acim', ctx: {} },
    { label: 'an ordinary whatsapp conversation (timestamped slug)', surface: 'whatsapp', jid: '1234@s.whatsapp.net', ctx: { pushedName: 'diego', slugHint: 'diego' } },
  ];

  function seedResetState(surface, jid, ctx) {
    let state = ensureContact(emptyState(), surface, jid, ctx).state;
    // E has a prior thread + hand-set mode + an access_level pin — and a SIBLING being (d)
    // has its own block, which must SURVIVE the reset untouched.
    state = patchContact(state, surface, jid, {
      agents: {
        e: { mode: 'mention', threadId: 'thread-abc', threadCreatedAt: '2026-08-01T00:00:00Z', access_level: 'all' },
        d: { mode: 'on' },
      },
    });
    return state;
  }

  const archiveRoot = join(EGPT_HOME, 'conversations', 'archive');

  for (const { label, surface, jid, ctx } of cases) {
    it(`archives the old folder (never deletes) into the FLAT conversations/archive/ subtree and reseeds a pristine tree at the ORIGINAL path — ${label}`, async () => {
      const state = seedResetState(surface, jid, ctx);
      const slug = getContact(state, surface, jid).slug;
      const room = Room.forChat(surface, slug);
      const renames = [], mkdirs = [];
      const { cmds, sent, files } = harness({
        state,
        io: {
          rename: async (from, to) => { renames.push([from, to]); },
          mkdir: async (p) => { mkdirs.push(p); },
          rm: async () => { throw new Error('/agents reset must never delete — rm was called'); },
        },
      });
      await cmds.run({ chatId: jid, surface, body: '/agents reset e' });

      // the archive rename actually happened: old baseDir -> conversations/archive/<slug>-archived-<suffix>,
      // NOT `<baseDir>-archived-<suffix>` (the old sibling-of-baseDir location)
      expect(renames).toHaveLength(1);
      expect(renames[0][0]).toBe(room.baseDir());
      const prefix = join(archiveRoot, `${slug}-archived-`);
      expect(renames[0][1].startsWith(prefix)).toBe(true);
      expect(renames[0][1].slice(prefix.length)).toMatch(/^\d{10}$/);
      expect(mkdirs).toContain(archiveRoot);   // the flat archive/ root is mkdir'd before the rename

      // the fresh folder gets ensureTree + seedIdentityLayers at the SAME (original) baseDir
      for (const dir of [room.baseDir(), room.mediaDir, room.filesDir, room.identityDir, room.scriptsDir, room.transcriptsDir]) {
        expect(mkdirs).toContain(dir);
      }
      expect(Object.keys(files).some((p) => p.startsWith(room.identityDir))).toBe(true);

      expect(sent).toHaveLength(1);
      expect(sent[0].text).toMatch(/reset/);
      // operator ruling (2026-08-15): success/failure only — never the archive destination
      expect(sent[0].text).not.toMatch(/archiv/i);
      expect(sent[0].text).not.toMatch(/recognized/);
    });

    it(`wipes e's registry state (threadId/mode gone) but PRESERVES access_level (operator grant) and leaves a SIBLING being's block untouched — ${label}`, async () => {
      const state = seedResetState(surface, jid, ctx);
      const before = getContact(state, surface, jid).entry;
      const { cmds, getState } = harness({
        state,
        io: { rename: async () => {}, mkdir: async () => {} },
      });
      await cmds.run({ chatId: jid, surface, body: '/agents reset e' });

      const reloaded = getState();
      const eAfter = getBeing(reloaded, surface, jid, 'e');
      // present is true again: access_level survives the wipe and is reapplied via patchBeing
      expect(eAfter.present).toBe(true);
      expect(eAfter.threadId).toBeNull();
      expect(eAfter.mode).toBeNull();
      // durable operator grant (operator ruling 2026-08-17): survives reset
      expect(eAfter.accessLevel).toBe('all');
      // allowed_users was never set on this seed — nothing to reapply, stays unset
      expect(eAfter.allowedUsers).toBeNull();

      // a sibling being's own block survives, untouched
      expect(getBeing(reloaded, surface, jid, 'd').mode).toBe('on');

      // the contact-level pointers (slug/conversation_path/pushedName/home_dir) are
      // untouched — the archived folder sits OUTSIDE this slug, so nothing needs to move
      const after = getContact(reloaded, surface, jid).entry;
      expect(after.slug).toBe(before.slug);
      expect(after.conversation_path).toBe(before.conversation_path);
      expect(after.pushedName).toBe(before.pushedName);
      expect(after.home_dir).toBe(before.home_dir);
    });
  }

  // REPRODUCE-FIRST (operator ruling 2026-08-17, live incident in room `acim`): reset used to
  // wipe access_level/allowed_users along with everything else, silently dropping a being back
  // to the node's global access_level default (or refusing it outright, per the STRUCTURAL
  // SAFETY GATES mandatory-access_level work). access_level and allowed_users are durable
  // operator-set GRANTS, not session state, and must survive — everything else (threadId,
  // mode, threadCreatedAt, identityInjectedAt) is wiped exactly as before.
  it('a being with BOTH access_level and allowed_users set survives reset with both intact — threadId/mode/threadCreatedAt/identityInjectedAt still wiped', async () => {
    let state = ensureContact(emptyState(), 'whatsapp', '1234@s.whatsapp.net', { pushedName: 'diego', slugHint: 'diego' }).state;
    state = patchContact(state, 'whatsapp', '1234@s.whatsapp.net', {
      agents: {
        e: {
          mode: 'mention', threadId: 'thread-abc',
          threadCreatedAt: '2026-08-01T00:00:00Z', identityInjectedAt: '2026-08-01T00:00:00Z',
          access_level: 'all', allowed_users: ['123'],
        },
      },
    });
    const { cmds, getState } = harness({ state, io: { rename: async () => {}, mkdir: async () => {} } });
    await cmds.run({ chatId: '1234@s.whatsapp.net', surface: 'whatsapp', body: '/agents reset e' });

    const reloaded = getState();
    const eAfter = getBeing(reloaded, 'whatsapp', '1234@s.whatsapp.net', 'e');
    expect(eAfter.threadId).toBeNull();
    expect(eAfter.mode).toBeNull();
    expect(eAfter.accessLevel).toBe('all');
    expect(eAfter.allowedUsers).toEqual(['123']);

    // threadCreatedAt/identityInjectedAt aren't surfaced by getBeing — check the raw block
    const rawAfter = getContact(reloaded, 'whatsapp', '1234@s.whatsapp.net').entry.agents.e;
    expect(rawAfter.threadCreatedAt).toBeUndefined();
    expect(rawAfter.identityInjectedAt).toBeUndefined();
    expect(rawAfter.threadId).toBeUndefined();
    expect(rawAfter.mode).toBeUndefined();
  });

  it('a being with access_level set but NOT allowed_users survives reset with ONLY access_level restored — allowed_users stays unset, not invented', async () => {
    let state = ensureContact(emptyState(), 'whatsapp', '1234@s.whatsapp.net', { pushedName: 'diego', slugHint: 'diego' }).state;
    state = patchContact(state, 'whatsapp', '1234@s.whatsapp.net', {
      agents: { e: { mode: 'on', threadId: 'thread-abc', access_level: 'regular' } },
    });
    const { cmds, getState } = harness({ state, io: { rename: async () => {}, mkdir: async () => {} } });
    await cmds.run({ chatId: '1234@s.whatsapp.net', surface: 'whatsapp', body: '/agents reset e' });

    const eAfter = getBeing(getState(), 'whatsapp', '1234@s.whatsapp.net', 'e');
    expect(eAfter.accessLevel).toBe('regular');
    expect(eAfter.allowedUsers).toBeNull();
    expect(eAfter.threadId).toBeNull();
  });

  it('a being with allowed_users set but NOT access_level survives reset with ONLY allowed_users restored — access_level stays unset, not invented', async () => {
    let state = ensureContact(emptyState(), 'whatsapp', '1234@s.whatsapp.net', { pushedName: 'diego', slugHint: 'diego' }).state;
    state = patchContact(state, 'whatsapp', '1234@s.whatsapp.net', {
      agents: { e: { mode: 'on', threadId: 'thread-abc', allowed_users: ['999'] } },
    });
    const { cmds, getState } = harness({ state, io: { rename: async () => {}, mkdir: async () => {} } });
    await cmds.run({ chatId: '1234@s.whatsapp.net', surface: 'whatsapp', body: '/agents reset e' });

    const eAfter = getBeing(getState(), 'whatsapp', '1234@s.whatsapp.net', 'e');
    expect(eAfter.allowedUsers).toEqual(['999']);
    expect(eAfter.accessLevel).toBeNull();
    expect(eAfter.threadId).toBeNull();
  });

  it('a being with NEITHER access_level nor allowed_users set is fully wiped by reset — no behavior change from before this fix', async () => {
    let state = ensureContact(emptyState(), 'whatsapp', '1234@s.whatsapp.net', { pushedName: 'diego', slugHint: 'diego' }).state;
    state = patchContact(state, 'whatsapp', '1234@s.whatsapp.net', {
      agents: { e: { mode: 'on', threadId: 'thread-abc' } },
    });
    const { cmds, getState } = harness({ state, io: { rename: async () => {}, mkdir: async () => {} } });
    await cmds.run({ chatId: '1234@s.whatsapp.net', surface: 'whatsapp', body: '/agents reset e' });

    const eAfter = getBeing(getState(), 'whatsapp', '1234@s.whatsapp.net', 'e');
    expect(eAfter.present).toBe(false);
    expect(eAfter.threadId).toBeNull();
    expect(eAfter.mode).toBeNull();
    expect(eAfter.accessLevel).toBeNull();
    expect(eAfter.allowedUsers).toBeNull();
  });

  // THE regression lock for the exact design bug this command retires /e reset to fix: /e
  // reset was HARDCODED to defaultKey ('e') and could never even NAME a different being.
  // This is the mirror image of the "wipes e's ... leaves a SIBLING untouched" test above —
  // here the being actually being reset is the NON-default one, proving the scoping fix
  // wipes whichever handle it's told to, not defaultKey unconditionally.
  it("/agents reset wren wipes ONLY wren's registry block — the persona (e), also resident here, is untouched byte-for-byte", async () => {
    let state = ensureContact(emptyState(), 'whatsapp', '1234@s.whatsapp.net', { pushedName: 'diego', slugHint: 'diego' }).state;
    state = patchContact(state, 'whatsapp', '1234@s.whatsapp.net', {
      agents: {
        e: { mode: 'on', threadId: 'e-thread-abc', access_level: 'all' },
        wren: { mode: 'mention', threadId: 'wren-thread-xyz' },
      },
    });
    const before = getContact(state, 'whatsapp', '1234@s.whatsapp.net').entry.agents.e;
    const { cmds, getState } = harness({ state, io: { rename: async () => {}, mkdir: async () => {} } });
    await cmds.run({ chatId: '1234@s.whatsapp.net', surface: 'whatsapp', body: '/agents reset wren' });

    const reloaded = getState();
    const wrenAfter = getBeing(reloaded, 'whatsapp', '1234@s.whatsapp.net', 'wren');
    expect(wrenAfter.present).toBe(false);
    expect(wrenAfter.threadId).toBeNull();

    const eAfter = getContact(reloaded, 'whatsapp', '1234@s.whatsapp.net').entry.agents.e;
    expect(eAfter).toEqual(before);   // byte-for-byte untouched
  });

  it('/agents reset all wipes EVERY resident being on the entry', async () => {
    let state = ensureContact(emptyState(), 'whatsapp', '1234@s.whatsapp.net', { pushedName: 'diego', slugHint: 'diego' }).state;
    state = patchContact(state, 'whatsapp', '1234@s.whatsapp.net', {
      agents: { e: { mode: 'on' }, wren: { mode: 'mention' }, d: { mode: 'accum' } },
    });
    const { cmds, getState } = harness({ state, io: { rename: async () => {}, mkdir: async () => {} } });
    await cmds.run({ chatId: '1234@s.whatsapp.net', surface: 'whatsapp', body: '/agents reset all' });
    const reloaded = getState();
    for (const h of ['e', 'wren', 'd']) {
      expect(getBeing(reloaded, 'whatsapp', '1234@s.whatsapp.net', h).present).toBe(false);
    }
  });

  it('a missing source folder (never created) does not crash — archive is skipped, reset still completes', async () => {
    const state = seedResetState('whatsapp', '1234@s.whatsapp.net', { pushedName: 'diego', slugHint: 'diego' });
    const { cmds, sent, getState } = harness({
      state,
      io: { rename: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }, mkdir: async () => {} },
    });
    await expect(cmds.run({ chatId: '1234@s.whatsapp.net', surface: 'whatsapp', body: '/agents reset e' })).resolves.toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/reset/);
    // seedResetState pins access_level: 'all' on e, which now survives reset (present stays
    // true) — threadId is the field this test actually cares about: the wipe still ran.
    expect(getBeing(getState(), 'whatsapp', '1234@s.whatsapp.net', 'e').threadId).toBeNull();
  });

  it('a chat with no known contact resolves gracefully — no crash, no archive, no registry write', async () => {
    const state = emptyState();
    const renames = [], mkdirs = [];
    const { cmds, sent, writes } = harness({
      state,
      io: { rename: async (from, to) => { renames.push([from, to]); }, mkdir: async (p) => { mkdirs.push(p); } },
    });
    await cmds.run({ chatId: '9999@s.whatsapp.net', surface: 'whatsapp', body: '/agents reset e' });
    expect(sent[0].text).toMatch(/can't resolve this conversation's room/);
    expect(renames).toHaveLength(0);
    expect(mkdirs).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it('/agents reset e is recognized case-insensitively on the command token + subcommand', async () => {
    for (const body of ['/agents reset e', '/AGENTS e RESET', '/Agents e Reset']) {
      const state = seedResetState('whatsapp', '1234@s.whatsapp.net', { pushedName: 'diego', slugHint: 'diego' });
      const { cmds, sent } = harness({
        state,
        io: { rename: async () => {}, mkdir: async () => {} },
      });
      await cmds.run({ chatId: '1234@s.whatsapp.net', surface: 'whatsapp', body });
      expect(sent[0].text).toMatch(/reset/i);
      expect(sent[0].text).not.toMatch(/recognized/);
    }
  });

  // Regression lock (operator 2026-08-15): the bare (no-slug) confirmation's exact shape —
  // pins the whole string (modulo the timestamped archive suffix, which is real-clock-
  // derived and not a harness seam — same tolerance the archive-suffix assertion above
  // uses). Also the "never echo the archive destination" ruling in one exact-string test.
  it('the bare (no-slug) confirmation text keeps its exact shape — regression lock', async () => {
    const state = seedResetState('whatsapp', '1234@s.whatsapp.net', { pushedName: 'diego', slugHint: 'diego' });
    const slug = getContact(state, 'whatsapp', '1234@s.whatsapp.net').slug;
    const { cmds, sent } = harness({
      state,
      io: { rename: async () => {}, mkdir: async () => {} },
    });
    await cmds.run({ chatId: '1234@s.whatsapp.net', surface: 'whatsapp', body: '/agents reset e' });
    expect(sent[0].text).toBe(`✅ ${slug} reset — e state cleared (access_level/allowed_users preserved), next message starts fresh.`);
    expect(sent[0].text).not.toMatch(/\bfor\b/);
  });

  // `=<slug>` (operator 2026-08-15, mirrors /agents auto's own binding): from Self, name a
  // DIFFERENT known chat to reset it instead of the conversation the command was typed in.
  // resolveTarget (the SAME fuzzy resolver /agents auto uses) does the lookup — these three
  // tests exercise its three outcomes (unique hit / ambiguous / no match).
  it('/agents=hfm reset e resets the NAMED chat while the operator types from Self — Self itself is never touched', async () => {
    const state = seedResetState('whatsapp', '!hfm:beeper.local', { pushedName: 'HFM', slugHint: 'HFM' });
    const slug = getContact(state, 'whatsapp', '!hfm:beeper.local').slug;
    const room = Room.forChat('whatsapp', slug);
    const renames = [], mkdirs = [];
    const { cmds, sent, getState } = harness({
      state,
      io: {
        rename: async (from, to) => { renames.push([from, to]); },
        mkdir: async (p) => { mkdirs.push(p); },
      },
    });
    await cmds.run({ chatId: '!self', surface: 'whatsapp', body: '/agents=hfm reset e' });

    // the NAMED chat got archived + reseeded + registry-wiped, exactly like the bare-case tests
    expect(renames).toHaveLength(1);
    expect(renames[0][0]).toBe(room.baseDir());
    expect(mkdirs).toContain(room.baseDir());
    const reloaded = getState();
    const eAfter = getBeing(reloaded, 'whatsapp', '!hfm:beeper.local', 'e');
    // seedResetState pins access_level: 'all' on e, which survives reset (present stays true)
    expect(eAfter.present).toBe(true);
    expect(eAfter.accessLevel).toBe('all');
    expect(eAfter.threadId).toBeNull();

    // Self DM (where the command was actually typed) is untouched — no contact minted for it
    expect(getBeing(reloaded, 'whatsapp', '!self', 'e')).toBe(null);

    // the confirmation names WHICH conversation just got wiped (destructive — operator must
    // never be left guessing)
    expect(sent[0].text).toMatch(/for HFM/);
  });

  it('/agents=work reset e (ambiguous) reports the same disambiguation error resolveTarget uses — no archive, no write', async () => {
    let state = ensureContact(emptyState(), 'whatsapp', '!a1', { pushedName: 'work-alpha', slugHint: 'work-alpha' }).state;
    state = ensureContact(state, 'whatsapp', '!a2', { pushedName: 'work-beta', slugHint: 'work-beta' }).state;
    const renames = [], mkdirs = [];
    const { cmds, sent, writes } = harness({
      state,
      io: { rename: async (from, to) => { renames.push([from, to]); }, mkdir: async (p) => { mkdirs.push(p); } },
    });
    await cmds.run({ chatId: '!self', surface: 'whatsapp', body: '/agents=work reset e' });
    expect(sent[0].text).toMatch(/matches 2:/);
    expect(renames).toHaveLength(0);
    expect(mkdirs).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it('/agents=zzz reset e (unknown) reports no match — no archive, no write', async () => {
    const state = seedResetState('whatsapp', '1234@s.whatsapp.net', { pushedName: 'diego', slugHint: 'diego' });
    const renames = [], mkdirs = [];
    const { cmds, sent, writes } = harness({
      state,
      io: { rename: async (from, to) => { renames.push([from, to]); }, mkdir: async (p) => { mkdirs.push(p); } },
    });
    await cmds.run({ chatId: '!self', surface: 'whatsapp', body: '/agents=zzz reset e' });
    expect(sent[0].text).toMatch(/no chat matches/);
    expect(renames).toHaveLength(0);
    expect(mkdirs).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it('archives room and whatsapp conversations into the SAME flat directory — not archive/room/... vs archive/whatsapp/...', async () => {
    const roomState = seedResetState('room', 'acim', {});
    const renames1 = [];
    const { cmds: cmds1 } = harness({ state: roomState, io: { rename: async (from, to) => { renames1.push([from, to]); }, mkdir: async () => {} } });
    await cmds1.run({ chatId: 'acim', surface: 'room', body: '/agents reset e' });

    const waState = seedResetState('whatsapp', '1234@s.whatsapp.net', { pushedName: 'diego', slugHint: 'diego' });
    const renames2 = [];
    const { cmds: cmds2 } = harness({ state: waState, io: { rename: async (from, to) => { renames2.push([from, to]); }, mkdir: async () => {} } });
    await cmds2.run({ chatId: '1234@s.whatsapp.net', surface: 'whatsapp', body: '/agents reset e' });

    expect(renames1[0][1].startsWith(archiveRoot)).toBe(true);
    expect(renames2[0][1].startsWith(archiveRoot)).toBe(true);
    expect(renames1[0][1]).not.toMatch(/archive[\\/]room[\\/]/);
    expect(renames2[0][1]).not.toMatch(/archive[\\/]whatsapp[\\/]/);
  });
});

// /agents restart <handle>|all — the NARROWER sibling of reset (operator 2026-08-15,
// decided directly against reset's archive-and-wipe): clears ONLY the target being(s)'
// threadId via patchBeing (a merge, never deleteBeing) — mode/access_level and every other
// field on the block survive, and the conversation folder (transcript.md, media/, files/,
// identity.d/) is never archived or otherwise touched. Matches exactly what already happens
// today when an operator manually clears threadId by hand. Transcript rolling + identity
// reseeding are NOT triggered synchronously here — they already happen lazily, on the
// being's NEXT real turn, via brainpool.mjs's own `fresh = !sessionId` gate. No evictWarm()
// call either: warm-sessions.mjs's run() carries its own SESSION-IDENTITY GUARD (its comment
// names this exact "handle reset nulling the thread" case) that self-evicts + reopens once
// the next turn passes `sessionId: null` for this being — nulling threadId here is what arms
// that guard, so restart needs no eviction call of its own.
describe('/agents restart <handle>|all — clears ONLY threadId, mode/access_level/folder untouched', () => {
  const cases = [
    { label: 'a room-surface conversation', surface: 'room', jid: 'acim', ctx: {} },
    { label: 'an ordinary whatsapp conversation', surface: 'whatsapp', jid: '1234@s.whatsapp.net', ctx: { pushedName: 'diego', slugHint: 'diego' } },
  ];

  // Same shape as reset's own seedResetState above (E has a prior thread + hand-set mode +
  // an access_level pin, plus a sibling being `d`) — deliberately identical so the
  // reset-vs-restart contrast below is a true apples-to-apples comparison.
  function seedRestartState(surface, jid, ctx) {
    let state = ensureContact(emptyState(), surface, jid, ctx).state;
    state = patchContact(state, surface, jid, {
      agents: {
        e: { mode: 'mention', threadId: 'thread-abc', threadCreatedAt: '2026-08-01T00:00:00Z', access_level: 'all' },
        d: { mode: 'on' },
      },
    });
    return state;
  }

  for (const { label, surface, jid, ctx } of cases) {
    it(`/agents restart e clears ONLY threadId — mode/access_level survive, being stays present — ${label}`, async () => {
      const state = seedRestartState(surface, jid, ctx);
      const { cmds, getState } = harness({ state, io: { rename: async () => {}, mkdir: async () => {} } });
      await cmds.run({ chatId: jid, surface, body: '/agents restart e' });

      const eAfter = getBeing(getState(), surface, jid, 'e');
      expect(eAfter.present).toBe(true);
      expect(eAfter.threadId).toBeNull();
      expect(eAfter.mode).toBe('mention');
      expect(eAfter.accessLevel).toBe('all');
    });
  }
  // END TO END, through the real dispatch. Two properties, and the second is the one that
  // would bite: the singular ANSWERS, and it answers WITHOUT acting. A silent alias would
  // have cleared a live thread here and looked identical in the reply.
  for (const { label, surface, jid, ctx } of cases) {
    it(`/agent restart e asks for the plural and changes NOTHING — ${label}`, async () => {
      const state = seedRestartState(surface, jid, ctx);
      const { cmds, sent, getState } = harness({ state, io: { rename: async () => {}, mkdir: async () => {} } });
      await cmds.run({ chatId: jid, surface, body: '/agent restart e' });

      expect(sent.at(-1).text).toMatch(/did you mean `\/agents`\?/);
      expect(getBeing(getState(), surface, jid, 'e').threadId).toBe('thread-abc');   // untouched
    });

    it(`/agents restart e — the plural — does the work — ${label}`, async () => {
      const state = seedRestartState(surface, jid, ctx);
      const { cmds, getState } = harness({ state, io: { rename: async () => {}, mkdir: async () => {} } });
      await cmds.run({ chatId: jid, surface, body: '/agents restart e' });

      const eAfter = getBeing(getState(), surface, jid, 'e');
      expect(eAfter.threadId).toBeNull();
      expect(eAfter.mode).toBe('mention');       // restart stayed narrow
      expect(eAfter.accessLevel).toBe('all');
    });
  }


  // THE CONTRAST PAIR (operator-mandated): the SAME seeded being, reset wipes mode too
  // (regression lock on reset's existing, unchanged behavior) — restart does not. Run back
  // to back so the distinction is provable at a glance, not just asserted in isolation.
  // access_level is now a shared column, not a contrast point (operator ruling 2026-08-17):
  // both reset and restart preserve it, for different reasons — reset because it's a durable
  // grant reapplied after the wipe, restart because it never wipes anything.
  it('CONTRAST — /agents reset e wipes mode (regression lock, unchanged) but PRESERVES access_level, vs /agents restart e leaves mode/access_level intact — same seed, side by side', async () => {
    const resetState = seedRestartState('whatsapp', '1234@s.whatsapp.net', { pushedName: 'diego', slugHint: 'diego' });
    const { cmds: resetCmds, getState: getResetState } = harness({ state: resetState, io: { rename: async () => {}, mkdir: async () => {} } });
    await resetCmds.run({ chatId: '1234@s.whatsapp.net', surface: 'whatsapp', body: '/agents reset e' });
    const eAfterReset = getBeing(getResetState(), 'whatsapp', '1234@s.whatsapp.net', 'e');
    expect(eAfterReset.present).toBe(true);   // access_level survives, so the block is not fully gone
    expect(eAfterReset.mode).toBeNull();
    expect(eAfterReset.accessLevel).toBe('all');
    expect(eAfterReset.threadId).toBeNull();

    const restartState = seedRestartState('whatsapp', '1234@s.whatsapp.net', { pushedName: 'diego', slugHint: 'diego' });
    const { cmds: restartCmds, getState: getRestartState } = harness({ state: restartState, io: { rename: async () => {}, mkdir: async () => {} } });
    await restartCmds.run({ chatId: '1234@s.whatsapp.net', surface: 'whatsapp', body: '/agents restart e' });
    const eAfterRestart = getBeing(getRestartState(), 'whatsapp', '1234@s.whatsapp.net', 'e');
    expect(eAfterRestart.present).toBe(true);
    expect(eAfterRestart.mode).toBe('mention');
    expect(eAfterRestart.accessLevel).toBe('all');
    expect(eAfterRestart.threadId).toBeNull();   // the ONE field restart does change
  });

  // Sibling scoping (mirrors reset's own "wren reset leaves e untouched" regression lock
  // above): restart must NAME the being it clears, never assume defaultKey or spill onto a
  // resident sibling that wasn't targeted.
  it("/agents restart wren clears ONLY wren's threadId — sibling e (also resident here) is untouched byte-for-byte", async () => {
    let state = ensureContact(emptyState(), 'whatsapp', '1234@s.whatsapp.net', { pushedName: 'diego', slugHint: 'diego' }).state;
    state = patchContact(state, 'whatsapp', '1234@s.whatsapp.net', {
      agents: {
        e: { mode: 'on', threadId: 'e-thread-abc', access_level: 'all' },
        wren: { mode: 'mention', threadId: 'wren-thread-xyz' },
      },
    });
    const before = getContact(state, 'whatsapp', '1234@s.whatsapp.net').entry.agents.e;
    const { cmds, getState } = harness({ state });
    await cmds.run({ chatId: '1234@s.whatsapp.net', surface: 'whatsapp', body: '/agents restart wren' });

    const reloaded = getState();
    const wrenAfter = getBeing(reloaded, 'whatsapp', '1234@s.whatsapp.net', 'wren');
    expect(wrenAfter.present).toBe(true);
    expect(wrenAfter.threadId).toBeNull();
    expect(wrenAfter.mode).toBe('mention');

    const eAfter = getContact(reloaded, 'whatsapp', '1234@s.whatsapp.net').entry.agents.e;
    expect(eAfter).toEqual(before);   // byte-for-byte untouched
  });

  // Contrast with reset's own "archives the old folder" test above, which asserts rename/
  // mkdir DO fire: restart must never touch the conversation folder at all.
  it('/agents restart e never touches the conversation folder — rename/mkdir are NEVER called (contrast: reset always calls both)', async () => {
    const state = seedRestartState('whatsapp', '1234@s.whatsapp.net', { pushedName: 'diego', slugHint: 'diego' });
    const renames = [], mkdirs = [];
    const { cmds } = harness({
      state,
      io: {
        rename: async (from, to) => { renames.push([from, to]); },
        mkdir: async (p) => { mkdirs.push(p); },
      },
    });
    await cmds.run({ chatId: '1234@s.whatsapp.net', surface: 'whatsapp', body: '/agents restart e' });
    expect(renames).toHaveLength(0);
    expect(mkdirs).toHaveLength(0);
  });

  it('/agents restart all clears threadId for EVERY resident being, leaving each one\'s own mode intact', async () => {
    let state = ensureContact(emptyState(), 'whatsapp', '1234@s.whatsapp.net', { pushedName: 'diego', slugHint: 'diego' }).state;
    state = patchContact(state, 'whatsapp', '1234@s.whatsapp.net', {
      agents: { e: { mode: 'on', threadId: 'e-t' }, wren: { mode: 'mention', threadId: 'wren-t' }, d: { mode: 'accum', threadId: 'd-t' } },
    });
    const { cmds, getState } = harness({ state });
    await cmds.run({ chatId: '1234@s.whatsapp.net', surface: 'whatsapp', body: '/agents restart all' });
    const reloaded = getState();
    for (const h of ['e', 'wren', 'd']) {
      const b = getBeing(reloaded, 'whatsapp', '1234@s.whatsapp.net', h);
      expect(b.present).toBe(true);
      expect(b.threadId).toBeNull();
    }
    expect(getBeing(reloaded, 'whatsapp', '1234@s.whatsapp.net', 'e').mode).toBe('on');
    expect(getBeing(reloaded, 'whatsapp', '1234@s.whatsapp.net', 'wren').mode).toBe('mention');
    expect(getBeing(reloaded, 'whatsapp', '1234@s.whatsapp.net', 'd').mode).toBe('accum');
  });

  // `=<slug>` target form (mirrors reset's own /agents=hfm reset e test above): from Self,
  // name a DIFFERENT known chat instead of the conversation the command was typed in.
  it('/agents=hfm restart e clears threadId on the NAMED chat while the operator types from Self — Self itself is never touched', async () => {
    const state = seedRestartState('whatsapp', '!hfm:beeper.local', { pushedName: 'HFM', slugHint: 'HFM' });
    const { cmds, sent, getState } = harness({ state });
    await cmds.run({ chatId: '!self', surface: 'whatsapp', body: '/agents=hfm restart e' });

    const eAfter = getBeing(getState(), 'whatsapp', '!hfm:beeper.local', 'e');
    expect(eAfter.threadId).toBeNull();
    expect(eAfter.mode).toBe('mention');
    expect(getBeing(getState(), 'whatsapp', '!self', 'e')).toBe(null);   // Self untouched
    expect(sent[0].text).toMatch(/for HFM/);
  });

  // Locks in the investigation's conclusion (see the describe-block comment above): restart
  // relies on warm-sessions.mjs's own session-identity guard to evict a stale warm process
  // once threadId goes null on the next turn — it must NOT call evictWarm itself (that would
  // duplicate access_level's own, different, reason for evicting).
  it('/agents restart e does NOT call evictWarm — the warm pool\'s own session-identity guard self-evicts once threadId is nulled', async () => {
    const state = seedRestartState('whatsapp', '1234@s.whatsapp.net', { pushedName: 'diego', slugHint: 'diego' });
    const { cmds, evicts } = harness({ state });
    await cmds.run({ chatId: '1234@s.whatsapp.net', surface: 'whatsapp', body: '/agents restart e' });
    expect(evicts).toEqual([]);
  });

  // ── THE ACCUM BOUNDARY (operator ruling 2026-08-29: "the reset should clean next accum, so
  // that the model really starts fresh") ─────────────────────────────────────────────────────
  // REPRODUCE-FIRST, from the live incident: the operator restarted E, asked "sin revisar el
  // historial, recuerdas de qué estábamos hablando?" and got an accurate summary — restart
  // nulled threadId and NOTHING else, so contextSinceLastTurn still found the pre-restart
  // history and handed it to the "fresh" being on turn one. The fix reuses the mechanism
  // already in transcript-log.mjs (a WITHHELD reply line is a valid boundary): restart appends
  // ONE `(not surfaced)` line per restarted being, through the SAME writer every reply goes
  // through (createTranscript.log). Nothing is archived — reset's job, not this one's.
  //
  // Wires the REAL transcript service over an in-memory file map, because the BYTES are the
  // claim here: the line has to be one the real reader accepts as a boundary.
  function memTranscript(getSt) {
    const files = {};
    const transcript = createTranscript({
      contacts: { resolve: async (surface, chatId) => getContact(getSt(), surface, chatId)?.slug ?? chatId },
      io: {
        appendFile: async (p, c) => { files[p] = (files[p] ?? '') + c; },
        mkdir: async () => {},
        existsSync: (p) => files[p] != null,
      },
    });
    return { files, log: transcript.log };
  }
  const HISTORY = (chat) => [
    '---', `name: ${chat}`, '---', '',
    `An@[${chat}].wa (19:55) #a: de qué estábamos hablando`, '',
    `e@[${chat}].wa (20:01): de la especie y su futuro`, '',
    'Pero fijate el precio que pagás', '',
    `An@[${chat}].wa (20:30) #b: dale`, '', '',
  ].join('\n');   // every real append ends '\n\n' — the boundary must land as its OWN block

  it('/agents restart e appends ONE withheld boundary line — the next accum window is EMPTY while the file keeps its history', async () => {
    const surface = 'whatsapp', jid = '1234@s.whatsapp.net';
    const state = seedRestartState(surface, jid, { pushedName: 'diego', slugHint: 'diego' });
    const { files, log } = memTranscript(() => state);
    const fpath = Room.forChat(surface, getContact(state, surface, jid).slug).transcriptPath;
    files[fpath] = HISTORY('diego');
    const before = files[fpath];

    const { cmds } = harness({ state, logTranscript: log });
    await cmds.run({ chatId: jid, surface, body: '/agents restart e' });

    expect(files[fpath].startsWith(before)).toBe(true);                       // append-only: nothing rewritten
    const added = files[fpath].slice(before.length);
    expect(added).toMatch(/^e@\[diego\]\.\S+ \(\d{1,2}:\d{2}\): \(not surfaced\) /);
    expect(added.trim().split(/\n{2,}/)).toHaveLength(1);                     // ONE block, or it leaks its own tail
    expect(contextSinceLastTurn(files[fpath], { being: 'e' }).blocks).toEqual([]);
    // …and the shared record every OTHER reader relies on is untouched (contrast: reset archives)
    expect(files[fpath]).toContain('de qué estábamos hablando');
    expect(contextSinceLastTurn(files[fpath], { being: 'wren' }).blocks.length).toBeGreaterThan(0);
  });

  it("/agents restart wren moves ONLY wren's boundary — e is resident here too and its window is unmoved", async () => {
    const surface = 'whatsapp', jid = '1234@s.whatsapp.net';
    let state = ensureContact(emptyState(), surface, jid, { pushedName: 'diego', slugHint: 'diego' }).state;
    state = patchContact(state, surface, jid, { agents: { e: { threadId: 'e-t' }, wren: { threadId: 'wren-t' } } });
    const { files, log } = memTranscript(() => state);
    const fpath = Room.forChat(surface, getContact(state, surface, jid).slug).transcriptPath;
    files[fpath] = HISTORY('diego');
    const eWindowBefore = contextSinceLastTurn(files[fpath], { being: 'e' }).blocks;

    const { cmds } = harness({ state, logTranscript: log });
    await cmds.run({ chatId: jid, surface, body: '/agents restart wren' });

    expect(contextSinceLastTurn(files[fpath], { being: 'wren' }).blocks).toEqual([]);
    const eWindowAfter = contextSinceLastTurn(files[fpath], { being: 'e' }).blocks;
    expect(eWindowAfter.slice(0, eWindowBefore.length)).toEqual(eWindowBefore);   // e's own boundary never moved
  });

  it('/agents restart all writes ONE boundary line per restarted being, each under its own label', async () => {
    const surface = 'whatsapp', jid = '1234@s.whatsapp.net';
    let state = ensureContact(emptyState(), surface, jid, { pushedName: 'diego', slugHint: 'diego' }).state;
    state = patchContact(state, surface, jid, { agents: { e: { threadId: 'e-t' }, wren: { threadId: 'wren-t' } } });
    const { cmds, logged } = harness({ state });
    await cmds.run({ chatId: jid, surface, body: '/agents restart all' });

    expect(logged.map((l) => l.reply.being)).toEqual(['e', 'wren']);
    for (const l of logged) expect(l.reply.surfaced).toBe(false);
  });

  // The confirmation reply is itself recorded (boot wraps `send` — wrapCommandsForTranscript),
  // so the boundary has to be appended AFTER it or the "fresh" being reads its own restart
  // notice as accumulated context.
  it('the boundary is appended AFTER the confirmation reply, so the ✅ line lands above it', async () => {
    const state = seedRestartState('whatsapp', '1234@s.whatsapp.net', { pushedName: 'diego', slugHint: 'diego' });
    let sentAtLog = null;
    const h = harness({ state, logTranscript: async () => { sentAtLog = h.sent.length; return true; } });
    await h.cmds.run({ chatId: '1234@s.whatsapp.net', surface: 'whatsapp', body: '/agents restart e' });
    expect(sentAtLog).toBe(1);
  });

  it('/agents=hfm restart e writes the boundary into the NAMED chat, not the one the command was typed in', async () => {
    const state = seedRestartState('whatsapp', '!hfm:beeper.local', { pushedName: 'HFM', slugHint: 'HFM' });
    const { cmds, logged } = harness({ state });
    await cmds.run({ chatId: '!self', surface: 'whatsapp', body: '/agents=hfm restart e' });
    expect(logged).toHaveLength(1);
    expect(logged[0].ev.chatId).toBe('!hfm:beeper.local');
    expect(logged[0].ev.surface).toBe('whatsapp');
  });

  // reset's own behaviour is UNCHANGED: it archives the whole folder, which already clears the
  // window — it must not also start writing boundary lines.
  it('CONTRAST — /agents reset e writes NO boundary line (it archives instead; unchanged)', async () => {
    const state = seedRestartState('whatsapp', '1234@s.whatsapp.net', { pushedName: 'diego', slugHint: 'diego' });
    const { cmds, logged } = harness({ state, io: { rename: async () => {}, mkdir: async () => {} } });
    await cmds.run({ chatId: '1234@s.whatsapp.net', surface: 'whatsapp', body: '/agents reset e' });
    expect(logged).toEqual([]);
  });

  it('/agents restart e is recognized case-insensitively on the command token + subcommand', async () => {
    for (const body of ['/agents restart e', '/AGENTS e RESTART', '/Agents e Restart']) {
      const state = seedRestartState('whatsapp', '1234@s.whatsapp.net', { pushedName: 'diego', slugHint: 'diego' });
      const { cmds, sent } = harness({ state });
      await cmds.run({ chatId: '1234@s.whatsapp.net', surface: 'whatsapp', body });
      expect(sent[0].text).toMatch(/restart/i);
      expect(sent[0].text).not.toMatch(/recognized/);
    }
  });
});

// /agents access_level all|regular <handle>|all — a PLAIN TOGGLE (operator: same trust
// model as /rooms delete force, no extra reachability gate) that points the TARGET being's
// `access_level` at config/permissions/all.md or config/permissions/regular.md. NOT a
// freeze (operator 2026-08-14): it writes ONLY the access_level field, merged over the
// being's existing agents.<being> block — mode/threadId survive untouched.
// Agent/type/model/effort/allowed_tools are no longer readable off a being AT ALL (phase 1:
// no more freeze) — brainpool.mjs applies the permissions file live, every turn; that
// live-application is covered in tests/spine-brainpool.test.mjs, not here — this file only
// proves the command writes the right field to the right place and leaves mode/threadId
// alone. Was /e access all|regular, hardcoded to defaultKey; the subcommand keyword is also
// renamed access_level (operator's own example: `/agents access_level all wren`).
describe('/agents access_level all|regular <handle>|all — points access_level at a permissions file, no freeze, one shared path for rooms and ordinary conversations', () => {
  const cases = [
    { label: 'a room-surface conversation', surface: 'room', jid: 'acim', ctx: {} },
    { label: 'an ordinary whatsapp conversation', surface: 'whatsapp', jid: '1234@s.whatsapp.net', ctx: { pushedName: 'diego', slugHint: 'diego' } },
  ];

  function seedAccessState(surface, jid, ctx) {
    let state = ensureContact(emptyState(), surface, jid, ctx).state;
    // A prior thread + hand-set mode must SURVIVE — the contrast with /agents reset
    // (deleteBeing, wipes everything), and proof that access_level touches ONLY that field.
    return patchContact(state, surface, jid, {
      agents: { e: { mode: 'on', threadId: 'thread-abc', threadCreatedAt: '2026-08-01T00:00:00Z' } },
    });
  }

  for (const { label, surface, jid, ctx } of cases) {
    it(`/agents access_level all e sets accessLevel: 'all' and leaves mode/threadId untouched — ${label}`, async () => {
      const state = seedAccessState(surface, jid, ctx);
      const { cmds, sent, getState } = harness({ state });
      await cmds.run({ chatId: jid, surface, body: '/agents access_level all e' });
      const being = getBeing(getState(), surface, jid, 'e');
      expect(being.accessLevel).toBe('all');
      expect(being.mode).toBe('on');
      expect(being.threadId).toBe('thread-abc');
      expect(sent[0].text).toMatch(/e access here → all/);
      expect(sent[0].text).toMatch(/unconfined/);
    });

    it(`/agents access_level regular e sets accessLevel: 'regular' and leaves mode/threadId untouched — ${label}`, async () => {
      const state = seedAccessState(surface, jid, ctx);
      const { cmds, sent, getState } = harness({ state });
      await cmds.run({ chatId: jid, surface, body: '/agents access_level regular e' });
      const being = getBeing(getState(), surface, jid, 'e');
      expect(being.accessLevel).toBe('regular');
      expect(being.mode).toBe('on');
      expect(being.threadId).toBe('thread-abc');
      expect(sent[0].text).toMatch(/e access here → regular/);
      expect(sent[0].text).toMatch(/confined default tools/);
    });

    it(`threadId/mode survive both access_level all and access_level regular — ${label}`, async () => {
      const stateAll = seedAccessState(surface, jid, ctx);
      const { cmds: cmdsAll, getState: getStateAll } = harness({ state: stateAll });
      await cmdsAll.run({ chatId: jid, surface, body: '/agents access_level all e' });
      const afterAll = getBeing(getStateAll(), surface, jid, 'e');
      expect(afterAll.threadId).toBe('thread-abc');
      expect(afterAll.mode).toBe('on');

      const stateRegular = seedAccessState(surface, jid, ctx);
      const { cmds: cmdsRegular, getState: getStateRegular } = harness({ state: stateRegular });
      await cmdsRegular.run({ chatId: jid, surface, body: '/agents access_level regular e' });
      const afterRegular = getBeing(getStateRegular(), surface, jid, 'e');
      expect(afterRegular.threadId).toBe('thread-abc');
      expect(afterRegular.mode).toBe('on');
    });
  }

  it('/agents access_level evicts e the warm session keyed on the FRESH-resolved engine (resolveBeingDef, same function turn() calls)', async () => {
    const state = seedAccessState('whatsapp', '1234@s.whatsapp.net', { pushedName: 'diego', slugHint: 'diego' });
    const { cmds, evicts, getState } = harness({ state });
    await cmds.run({ chatId: '1234@s.whatsapp.net', surface: 'whatsapp', body: '/agents access_level all e' });
    const slug = getContact(getState(), 'whatsapp', '1234@s.whatsapp.net').slug;
    expect(evicts).toEqual([`e:ccode:whatsapp:${slug}`]);
  });

  // THE scoping generalization: access_level is no longer defaultKey-only — `all` writes
  // EVERY resident being's own access_level and evicts EACH being's own warm key.
  it("/agents access_level regular all sets EVERY resident being's accessLevel and evicts each one's own warm key", async () => {
    let state = ensureContact(emptyState(), 'whatsapp', '1234@s.whatsapp.net', { pushedName: 'diego', slugHint: 'diego' }).state;
    state = patchContact(state, 'whatsapp', '1234@s.whatsapp.net', {
      agents: { e: { mode: 'on' }, wren: { mode: 'mention' } },
    });
    const { cmds, evicts, getState } = harness({ state });
    await cmds.run({ chatId: '1234@s.whatsapp.net', surface: 'whatsapp', body: '/agents access_level regular all' });
    const slug = getContact(getState(), 'whatsapp', '1234@s.whatsapp.net').slug;
    expect(evicts).toEqual(expect.arrayContaining([`e:ccode:whatsapp:${slug}`, `wren:ccode:whatsapp:${slug}`]));
    expect(getBeing(getState(), 'whatsapp', '1234@s.whatsapp.net', 'e').accessLevel).toBe('regular');
    expect(getBeing(getState(), 'whatsapp', '1234@s.whatsapp.net', 'wren').accessLevel).toBe('regular');
  });

  it('/agents access_level <bad> e and bare access_level get the usage reply — not silence, not a fallthrough', async () => {
    for (const body of ['/agents access_level foo e', '/agents access_level bad e']) {
      const state = seedAccessState('whatsapp', '1234@s.whatsapp.net', { pushedName: 'diego', slugHint: 'diego' });
      const { cmds, sent } = harness({ state });
      await cmds.run({ chatId: '1234@s.whatsapp.net', surface: 'whatsapp', body });
      expect(sent[0].text).toBe('usage: /agents access_level all|regular <handle>|all');
      expect(sent[0].text).not.toMatch(/recognized/);
    }
  });

  it('/agents access_level all e is recognized case-insensitively on the command token + subcommand (the all|regular value stays case-insensitive too)', async () => {
    for (const body of ['/agents access_level all e', '/AGENTS e ACCESS_LEVEL all', '/Agents e Access_Level ALL']) {
      const state = seedAccessState('whatsapp', '1234@s.whatsapp.net', { pushedName: 'diego', slugHint: 'diego' });
      const { cmds, sent } = harness({ state });
      await cmds.run({ chatId: '1234@s.whatsapp.net', surface: 'whatsapp', body });
      expect(sent[0].text).toMatch(/access.*all/i);
      expect(sent[0].text).not.toMatch(/recognized/);
    }
  });
});

// /agents bare-target default honoring a joined /rooms (operator 2026-08-16 fix): /rooms join
// already made the joined room the natural default target for roomLeave's own bare form, but
// /agents's own bare-target resolution never read currentRoom at all — an operator who joined
// a room and then ran a bare /agents (no explicit `=<slug>`) silently kept writing to their
// own native chat instead of the room. The fix reuses the SAME resolveTarget the explicit
// `=<slug>` branch already used (see the resolution block at the top of agentsCmd).
describe('/agents bare-target default honors a joined /rooms (operator 2026-08-16 fix)', () => {
  it("/rooms join <slug> then a BARE /agents ... access_level writes to the JOINED ROOM, not the caller's own chat", async () => {
    const state = ensureContact(emptyState(), 'room', 'acim', {}).state;
    const { cmds, getState } = harness({ state });
    await cmds.run({ chatId: '!self', surface: 'whatsapp', body: '/rooms join acim' });
    await cmds.run({ chatId: '!self', surface: 'whatsapp', body: '/agents access_level all e' });
    expect(getBeing(getState(), 'room', 'acim', 'e').accessLevel).toBe('all');
    expect(getBeing(getState(), 'whatsapp', '!self', 'e')).toBe(null);
  });

  it("regression: no room joined — bare /agents still targets the caller's own native chat (unchanged)", async () => {
    const state = ensureContact(emptyState(), 'whatsapp', '1234@s.whatsapp.net', { pushedName: 'diego', slugHint: 'diego' }).state;
    const { cmds, getState } = harness({ state });
    await cmds.run({ chatId: '1234@s.whatsapp.net', surface: 'whatsapp', body: '/agents access_level all e' });
    expect(getBeing(getState(), 'whatsapp', '1234@s.whatsapp.net', 'e').accessLevel).toBe('all');
  });

  it('regression: a room IS joined, but an explicit /agents=<slug> wins — the joined-room default does not leak into the explicit branch', async () => {
    let state = ensureContact(emptyState(), 'room', 'acim', {}).state;
    state = ensureContact(state, 'whatsapp', '!other:beeper.local', { pushedName: 'Other', slugHint: 'other' }).state;
    const { cmds, getState } = harness({ state });
    await cmds.run({ chatId: '!self', surface: 'whatsapp', body: '/rooms join acim' });
    await cmds.run({ chatId: '!self', surface: 'whatsapp', body: '/agents=other access_level all e' });
    expect(getBeing(getState(), 'whatsapp', '!other:beeper.local', 'e').accessLevel).toBe('all');
    expect(getBeing(getState(), 'room', 'acim', 'e').accessLevel).toBeNull();
  });
});

// onRoomChange — the hook boot.mjs uses to keep the shell status line live (operator
// 2026-08-16). REPRODUCE-FIRST: before this seam existed, roomJoin/roomLeave/roomDelete only
// ever mutated the in-memory currentRoom map and replied with text — nothing observable told
// a caller the room actually changed, so boot had no way to recompute+push a header. These
// assert the hook fires with the right (surface, slug|null) at every currentRoom mutation site.
describe('onRoomChange — fires at every currentRoom mutation site (roomJoin/roomLeave/roomDelete)', () => {
  it('/rooms join <slug> fires onRoomChange(surface, slug)', async () => {
    const { cmds, roomChanges } = harness();
    await cmds.run({ chatId: 'main', surface: 'shell', body: '/rooms join acim' });
    expect(roomChanges).toEqual([{ surface: 'shell', slug: 'acim' }]);
  });

  it('/rooms leave <slug> (room IS current) fires onRoomChange(surface, null)', async () => {
    const { cmds, roomChanges } = harness();
    await cmds.run({ chatId: 'main', surface: 'shell', body: '/rooms join acim' });
    await cmds.run({ chatId: 'main', surface: 'shell', body: '/rooms leave acim' });
    expect(roomChanges).toEqual([{ surface: 'shell', slug: 'acim' }, { surface: 'shell', slug: null }]);
  });

  it('/rooms leave <slug> when NOT current does NOT fire onRoomChange (nothing changed)', async () => {
    const { cmds, roomChanges } = harness();
    await cmds.run({ chatId: 'main', surface: 'shell', body: '/rooms leave acim' });
    expect(roomChanges).toEqual([]);
  });

  it('bare /rooms leave (current room implied) fires onRoomChange(surface, null)', async () => {
    const { cmds, roomChanges } = harness();
    await cmds.run({ chatId: 'main', surface: 'shell', body: '/rooms join acim' });
    await cmds.run({ chatId: 'main', surface: 'shell', body: '/rooms leave' });
    expect(roomChanges).toEqual([{ surface: 'shell', slug: 'acim' }, { surface: 'shell', slug: null }]);
  });

  it('a non-shell surface joining/leaving still fires onRoomChange — boot.mjs is what filters to shell, not this seam', async () => {
    const { cmds, roomChanges } = harness();
    await cmds.run({ chatId: '!self', surface: 'whatsapp', body: '/rooms join acim' });
    expect(roomChanges).toEqual([{ surface: 'whatsapp', slug: 'acim' }]);
  });

  it('/rooms delete force on a JOINED room clears currentRoom AND fires onRoomChange(surface, null) too', async () => {
    const room = Room.forChat('room', 'acim');
    const { cmds, roomChanges, sent } = harness({
      config: { whatsapp: { chat_id: '!self' } },
      io: {
        stat: async (p) => { if (p === room.baseDir()) return {}; throw new Error('ENOENT'); },
        readdir: async () => { throw new Error('ENOENT'); },
        rm: async () => {},
      },
    });
    await cmds.run({ chatId: 'main', surface: 'shell', body: '/rooms join acim' });
    await cmds.run({ chatId: '!self', surface: 'whatsapp', body: '/rooms delete force acim' });
    expect(sent[sent.length - 1].text).toMatch(/room acim deleted/);
    expect(roomChanges).toEqual([{ surface: 'shell', slug: 'acim' }, { surface: 'shell', slug: null }]);
  });
});

// resolveTarget cross-surface fallback (operator 2026-07-05 live bug): from the whatsapp
// Self DM, "/agents auto on e miss" reported "no chat matches" even though a telegram chat
// "Miss Xinyi" was registered — resolveTarget only ever searched the command's own
// surface. Own-surface hits still win with no ambiguity check against other surfaces;
// only a ZERO own-surface hit falls through to every other surface registered in state.contacts.
describe('/agents=<slug> …: cross-surface resolution', () => {
  it('a TELEGRAM chat targeted by name from the whatsapp Self DM resolves + patches the TELEGRAM entry', async () => {
    const state = ensureContact(emptyState(), 'telegram', '!miss:something', { pushedName: 'Miss Xinyi', slugHint: 'miss-xinyi' }).state;
    const { cmds, sent, getState } = harness({ state });
    await cmds.run({ body: '/agents=miss auto on e', chatId: '!self', surface: 'whatsapp' });
    expect(getBeing(getState(), 'telegram', '!miss:something', 'e').mode).toBe('on');   // the TELEGRAM entry
    expect(getBeing(getState(), 'whatsapp', '!miss:something', 'e')).toBe(null);         // whatsapp has no such being
    expect(sent[0].text).toMatch(/Miss Xinyi.*→ on/);
  });

  it('a same-surface hit wins silently even when another surface ALSO matches the term', async () => {
    let state = ensureContact(emptyState(), 'whatsapp', '!miss-wa:beeper.local', { pushedName: 'Miss Wa', slugHint: 'miss-wa' }).state;
    state = ensureContact(state, 'telegram', '!miss-tg:something', { pushedName: 'Miss Tg', slugHint: 'miss-tg' }).state;
    const { cmds, sent, getState } = harness({ state });
    await cmds.run({ body: '/agents=miss auto on e', chatId: '!self', surface: 'whatsapp' });
    expect(getBeing(getState(), 'whatsapp', '!miss-wa:beeper.local', 'e').mode).toBe('on');   // the OWN-surface hit
    expect(getBeing(getState(), 'telegram', '!miss-tg:something', 'e').mode).toBe(null);       // telegram untouched, no ambiguity check
    expect(sent[0].text).not.toMatch(/be more specific/);
  });

  it('cross-surface ambiguity (own surface 0 hits, two OTHER surfaces match) lists each hit with its surface', async () => {
    let state = ensureContact(emptyState(), 'telegram', '!miss-tg:something', { pushedName: 'Miss Tg', slugHint: 'miss-tg' }).state;
    state = ensureContact(state, 'signal', '!miss-sig:something', { pushedName: 'Miss Sig', slugHint: 'miss-sig' }).state;
    const { cmds, sent, writes } = harness({ state });
    await cmds.run({ body: '/agents=miss auto on e', chatId: '!self', surface: 'whatsapp' });
    expect(sent[0].text).toMatch(/matches 2/);
    expect(sent[0].text).toMatch(/Miss Tg \(telegram\)/);
    expect(sent[0].text).toMatch(/Miss Sig \(signal\)/);
    expect(sent[0].text).toMatch(/be more specific/);
    expect(writes).toHaveLength(0);
  });
});

describe('/status <target>: cross-surface resolution', () => {
  it('/status <cross-surface target> reports the TELEGRAM conversation, not the whatsapp origin', async () => {
    const state = ensureContact(emptyState(), 'telegram', '!miss:something', { pushedName: 'Miss Xinyi', slugHint: 'miss-xinyi' }).state;
    // io.readFile always misses (no transcript/heartbeats fixtures) — every such probe
    // degrades independently (matches the /status <target> degrade tests); this test
    // only cares that the reported conversation is the resolved TARGET surface.
    const { cmds, sent } = harness({ state, io: { readFile: async () => { throw new Error('ENOENT'); } } });
    await cmds.run({ body: '/status miss', chatId: '!self', surface: 'whatsapp' });
    const { text } = sent[0];
    expect(text).toMatch(/name: Miss Xinyi/);
    expect(text).toMatch(/surface: telegram/);       // the resolved TARGET surface, not whatsapp
    expect(text).toMatch(/slug: Miss Xinyi/);
  });
});

describe('loop intercept', () => {
  it('a command is handled, NOT routed to the brain (and is logged)', async () => {
    let cb = null;
    const brain = { calls: [], async turn(b, e) { this.calls.push(e); return { text: 'x' }; } };
    const exits = [];
    const cmds = createCommands({ getConfig: () => ({ whatsapp: { chat_id: '!self' } }), send: async () => {}, exit: (c) => exits.push(c) });
    const transcript = { entries: [], log(ev) { this.entries.push(ev); } };
    const spine = createSpine({
      bridge: { onMessage(fn) { cb = fn; }, send() {}, stop() {} },
      brain, commands: cmds,
      identity: { build: (m) => ({ ...m }) },
      router: { resolve: () => 'e' },
      gating: { decide: async () => ({ mode: 'on', receives: true, mayReply: true, sendToEgpt: 'mode' }), surfaces: () => true },
      sender: { open: () => ({ update() {}, async finish() {} }) },
      transcript, heartbeats: { runDue() {} },
    });
    spine.start();
    await cb({ body: '/restart', chatId: '!self' });
    expect(brain.calls).toHaveLength(0);   // intercepted — not the persona
    expect(exits).toEqual([43]);
    expect(transcript.entries).toHaveLength(1);
  });
});

// The re-point WIZARD that used to arm on bare `/e`/`/e <fragment>` was retired (operator
// 2026-08-14, phase 1): there was no more per-conversation freeze for it to configure —
// engine/model/effort/tools always resolve fresh from config.yaml every turn (brainpool.mjs's
// resolveDefaultBrainDef). The ENTIRE /e/egpt command family was retired next (operator
// 2026-08-15, phase 2) and replaced with /agents, which reaches any resident being in any
// conversation instead of only defaultKey. `/e`/`/egpt` now carry no special meaning at all —
// every form falls straight through to the generic unrecognized-command catch-all, exactly
// like any other unwired token.
describe('/agents <handle>|all — bare status view, usage, and /e/egpt retirement', () => {
  const contact = () => ensureContact(emptyState(), 'whatsapp', '!room', { pushedName: 'fam', slugHint: 'fam' }).state;

  it('/agents (bare, no handle) replies with usage — nothing written', async () => {
    const { cmds, sent, writes } = harness({ state: contact() });
    const ev = { chatId: '!room', surface: 'whatsapp', authorized: true };
    await cmds.run({ ...ev, body: '/agents' });
    expect(sent[0].text).toBe(AGENTS_USAGE);            // verb-first since 2026-08-28
    expect(sent[0].text).toMatch(/^usage: \/agents \[<verb>\] \[<value>\] <handle>/);   // ...verb slot first, target after
    expect(writes).toHaveLength(0);
    // a plain follow-up message is NOT claimed as a command (nothing was armed)
    expect(cmds.isCommand({ chatId: '!room', surface: 'whatsapp', body: '1', authorized: true })).toBe(false);
  });

  it('/agents <handle> <unknown-subcommand> gets a usage-shaped reply, not a fallthrough', async () => {
    const { cmds, sent } = harness({ state: contact() });
    await cmds.run({ chatId: '!room', surface: 'whatsapp', body: '/agents e frobnicate' });
    // The trailing slot after a bare handle is the CONVERSATION now (`/agents e spoiler`),
    // so an unrecognised token is reported as an unresolvable chat rather than a bad verb.
    // The property this test actually guards is unchanged: /agents ANSWERS, never falls through.
    expect(sent[0].text).toMatch(/no chat matches "frobnicate"/);
    expect(sent[0].text).not.toMatch(/recognized/);
  });

  it('/agents e (bare handle) returns a fenced-yaml status block, not a wizard', async () => {
    const state = ensureContact(emptyState(), 'whatsapp', '!room', { pushedName: 'fam', slugHint: 'fam' }).state;
    const { cmds, sent } = harness({ state });
    await cmds.run({ chatId: '!room', surface: 'whatsapp', body: '/agents e' });
    expect(sent[0].text).toMatch(/^```yaml\n/);
    expect(sent[0].text).toMatch(/being: e/);
    expect(sent[0].text).toMatch(/```$/);
  });

  // The LIVENESS proof: /agents' status view resolves resolveBeingDef fresh on EVERY call
  // (no per-conversation freeze, no caching anywhere in the chain) — changing what a fake
  // brains registry resolves between two calls, with NOTHING evicted/reset in between,
  // changes the SECOND call's reported tools. A stale/frozen preview could not do this.
  it("/agents e status is LIVE-resolved — editing config between two calls changes the second call's tools, with nothing evicted in between", async () => {
    const state = ensureContact(emptyState(), 'whatsapp', '!room', { pushedName: 'fam', slugHint: 'fam' }).state;
    let toolSet = ['Read'];
    const brains = { resolve: (name) => ({ name, type: 'ccode', allowed_tools: toolSet }) };
    const config = { agents: { e: { configuration: 'mytype' } } };
    const { cmds, sent } = harness({ state, config, brains });
    await cmds.run({ chatId: '!room', surface: 'whatsapp', body: '/agents e' });
    expect(sent[0].text).toMatch(/allowed_tools: \[Read\]/);
    toolSet = ['Read', 'Write', 'Bash'];   // simulates a config edit between two calls
    await cmds.run({ chatId: '!room', surface: 'whatsapp', body: '/agents e' });
    expect(sent[1].text).toMatch(/allowed_tools: \[Read, Write, Bash\]/);
  });

  it('/agents all (bare) returns ONE fenced-yaml block per resident being, defaultKey first', async () => {
    let state = ensureContact(emptyState(), 'whatsapp', '!room', { pushedName: 'fam', slugHint: 'fam' }).state;
    // inserted wren BEFORE e, to prove the ordering is defaultKey-first by RULE, not by
    // accident of insertion order
    state = patchContact(state, 'whatsapp', '!room', { agents: { wren: { mode: 'mention' }, e: { mode: 'on' } } });
    const { cmds, sent } = harness({ state });
    await cmds.run({ chatId: '!room', surface: 'whatsapp', body: '/agents all' });
    expect(sent[0].text).toMatch(/being: e[\s\S]*\n---\n[\s\S]*being: wren/);
  });

  it('/agents all (bare) with no resident beings reports so, rather than an empty fenced block', async () => {
    const state = ensureContact(emptyState(), 'whatsapp', '!room', { pushedName: 'fam', slugHint: 'fam' }).state;
    const { cmds, sent } = harness({ state });
    await cmds.run({ chatId: '!room', surface: 'whatsapp', body: '/agents all' });
    expect(sent[0].text).toMatch(/no resident beings/);
  });

  it('/e and /egpt carry no special meaning any more — every form falls through to the generic catch-all', async () => {
    const { cmds, sent } = harness({ state: contact() });
    const ev = { chatId: '!room', surface: 'whatsapp', authorized: true };
    for (const body of ['/e', '/e hfm', '/e auto on', '/e reset', '/e access all', '/egpt', '/egpt whatever']) {
      await cmds.run({ ...ev, body });
    }
    expect(sent).toHaveLength(7);
    for (const s of sent) {
      expect(s.text).toMatch(/recognized/);
      expect(s.text).not.toMatch(/^usage: \/e/);
    }
  });
});

// /chrome <node> — ATTACH-ONLY Chrome status, answered ONLY by the addressed node.
// The CDP seam is injected everywhere here: these tests never reach a real Chrome
// and never open a socket. The node gate is the same wake-word principle as the
// mesh's self-set (node_name ∪ node_alias): a non-addressed node says NOTHING, so
// on a shared Beeper account exactly one node answers.
describe('/chrome <node>', () => {
  const self = { chatId: '!self', surface: 'whatsapp' };
  const kg = { node_name: 'kg', whatsapp: { chat_id: '!self' } };
  const reachable = {
    isRunning: async () => true,
    cdpHost: async () => 'localhost:9221',
    listTabs: async () => ([
      { title: 'ChatGPT', url: 'https://chatgpt.com/c/abc' },
      { title: 'Claude', url: 'https://claude.ai/chat/def' },
    ]),
  };
  const unreachable = {
    isRunning: async () => false,
    cdpHost: async () => 'localhost:9221',
    listTabs: async () => { throw new Error('Cannot reach Chrome at localhost:9221'); },
  };

  it('/chrome kg on the kg node with Chrome reachable reports attached + the host + tab info', async () => {
    const { cmds, sent } = harness({ config: kg, cdp: reachable });
    await cmds.run({ ...self, body: '/chrome kg' });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/attached/i);
    expect(sent[0].text).toMatch(/localhost:9221/);
    expect(sent[0].text).toMatch(/tabs: 2/);
    expect(sent[0].text).toMatch(/ChatGPT/);
    expect(sent[0].text).toMatch(/chatgpt\.com/);
  });

  // The whole point of the gate: `do` must not answer a question addressed to `kg`.
  it('/chrome kg on the `do` node replies NOTHING AT ALL (silent — only the addressed node answers)', async () => {
    const { cmds, sent } = harness({ config: { node_name: 'do', whatsapp: { chat_id: '!self' } }, cdp: reachable });
    await cmds.run({ ...self, body: '/chrome kg' });
    expect(sent).toHaveLength(0);
  });

  it('a node_alias matches too (the addressed name is any of node_name ∪ node_alias)', async () => {
    const { cmds, sent } = harness({ config: { node_name: 'kg', node_alias: ['reve'], whatsapp: { chat_id: '!self' } }, cdp: reachable });
    await cmds.run({ ...self, body: '/chrome reve' });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/attached/i);
  });

  it('the node match is case-insensitive', async () => {
    const { cmds, sent } = harness({ config: kg, cdp: reachable });
    await cmds.run({ ...self, body: '/chrome KG' });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/attached/i);
  });

  // NOT an error: no Chrome listening is the normal resting state. The node cannot
  // open one itself (Session 0 service — an invisible browser), so it hands the
  // operator the exact command line to run in THEIR session.
  it('/chrome kg with Chrome NOT reachable reports the launch command line (no throw, not a failure)', async () => {
    const { cmds, sent } = harness({ config: kg, cdp: unreachable });
    await cmds.run({ ...self, body: '/chrome kg' });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/no chrome/i);
    expect(sent[0].text).toMatch(/--remote-debugging-port=9221/);
    expect(sent[0].text).toMatch(/--user-data-dir=/);
    expect(sent[0].text).not.toMatch(/failed|error/i);
    // The reason it can't do it itself must land in the chat, not just in a comment.
    expect(sent[0].text).toMatch(/session/i);
  });

  it('a listTabs failure after a live isRunning degrades to the launch hint, never a throw', async () => {
    const { cmds, sent } = harness({
      config: kg,
      cdp: { ...unreachable, isRunning: async () => true },
    });
    await expect(cmds.run({ ...self, body: '/chrome kg' })).resolves.toBeUndefined();
    expect(sent).toHaveLength(1);
  });

  // Bare /chrome = usage, self-naming. Every node answers this ONE short line (it is
  // the discovery path: it tells the operator the valid args). The expensive status
  // payload stays strictly single-node.
  it('bare /chrome shows a short usage line naming THIS node', async () => {
    const { cmds, sent } = harness({ config: { node_name: 'kg', node_alias: ['reve'], whatsapp: { chat_id: '!self' } }, cdp: reachable });
    await cmds.run({ ...self, body: '/chrome' });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/`\/chrome` <node>/);   // token quoted — the reply is not itself a command
    expect(sent[0].text).toMatch(/kg/);
    expect(sent[0].text).toMatch(/reve/);
    expect(sent[0].text).not.toMatch(/attached/i);   // never the status payload
  });

  // An unknown arg is a NON-MATCH, and a non-match is silent — same rule as `do`
  // ignoring `/chrome kg`. If every node answered "unknown node" the operator would
  // get exactly the double-answer the gate exists to prevent.
  it('/chrome <unknown node> is silent (a non-match is a non-match, on every node)', async () => {
    const { cmds, sent } = harness({ config: kg, cdp: reachable });
    await cmds.run({ ...self, body: '/chrome zzz' });
    expect(sent).toHaveLength(0);
  });

  it('/chrome is gated on the operator exactly like the other commands', () => {
    const { cmds } = harness({ config: kg, cdp: reachable });
    expect(cmds.isCommand({ body: '/chrome kg', chatId: '!self', surface: 'whatsapp' })).toBe(true);
    expect(cmds.isCommand({ body: '/chrome kg', chatId: '!group', surface: 'whatsapp' })).toBe(false);
    expect(cmds.isCommand({ body: '/chrome kg', chatId: '!group', surface: 'whatsapp', authorized: true })).toBe(true);
  });

  it('a non-operator /chrome is never run (no reply, no CDP probe)', async () => {
    let probed = false;
    const { cmds, sent } = harness({
      config: kg,
      cdp: { ...reachable, isRunning: async () => { probed = true; return true; } },
    });
    const ev = { body: '/chrome kg', chatId: '!group', surface: 'whatsapp' };
    expect(cmds.isCommand(ev)).toBe(false);   // the loop never reaches run()
    expect(sent).toHaveLength(0);
    expect(probed).toBe(false);
  });

  // Regression lock: /chrome must not fall through to the "recognized" catch-all.
  it('/chrome kg is NOT answered by the unwired-command catch-all', async () => {
    const { cmds, sent } = harness({ config: kg, cdp: reachable });
    await cmds.run({ ...self, body: '/chrome kg' });
    expect(sent[0].text).not.toMatch(/recognized/);
  });

  // ── LAUNCH (Session-0 → Session-1 scheduled-task hop) ──────────────────────────
  // Unreachable is no longer just a hint: /chrome fires the `egpt-chrome` scheduled
  // task (via the injected launch seam — a fake here, `schtasks /run /tn egpt-chrome`
  // in prod), polls CDP up to ~20s (fake advancing clock → instant), then attaches.

  it('/chrome kg unreachable → fires the launch task, waits, attaches, replies with tabs', async () => {
    const launched = [];
    // isRunning stays false until the launch fires, then comes up on the 2nd poll (proves it WAITS).
    let polls = 0;
    const cdp = {
      isRunning: async () => launched.length > 0 && ++polls >= 2,
      cdpHost: async () => 'localhost:9221',
      listTabs: async () => ([
        { title: 'ChatGPT', url: 'https://chatgpt.com/c/abc' },
        { title: 'Claude', url: 'https://claude.ai/chat/def' },
      ]),
    };
    const launch = () => { launched.push('fire'); return { ok: true }; };
    const { cmds, sent } = harness({ config: kg, cdp, launch });
    await cmds.run({ ...self, body: '/chrome kg' });
    expect(launched).toHaveLength(1);             // the launch task WAS fired (schtasks recorded)
    expect(polls).toBeGreaterThanOrEqual(2);      // it polled CDP, not just checked once
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/attached/i);
    expect(sent[0].text).toMatch(/localhost:9221/);
    expect(sent[0].text).toMatch(/tabs: 2/);
    expect(sent[0].text).toMatch(/ChatGPT/);
    expect(sent[0].text).not.toMatch(/no chrome/i);   // NOT the fallback hint
  });

  it('/chrome kg unreachable + launch task NOT registered (schtasks non-zero) → command-line fallback + setup note, no throw', async () => {
    const launched = [];
    const launch = () => { launched.push('fire'); return { ok: false }; };
    const { cmds, sent } = harness({ config: kg, cdp: unreachable, launch });
    await expect(cmds.run({ ...self, body: '/chrome kg' })).resolves.toBeUndefined();
    expect(launched).toHaveLength(1);                  // it TRIED (fired the task) …
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/no chrome/i);        // … then fell back to the hint
    expect(sent[0].text).toMatch(/--remote-debugging-port=9221/);
    expect(sent[0].text).toMatch(/register-chrome-task\.ps1/);   // the one-line setup note
    expect(sent[0].text).not.toMatch(/failed|error/i);
  });

  it('/chrome kg unreachable, launch fires but Chrome never comes up within the timeout → same graceful fallback', async () => {
    const launched = [];
    const launch = () => { launched.push('fire'); return { ok: true }; };
    // unreachable.isRunning is always false; the advancing fake clock makes the ~20s poll instant.
    const { cmds, sent } = harness({ config: kg, cdp: unreachable, launch });
    await expect(cmds.run({ ...self, body: '/chrome kg' })).resolves.toBeUndefined();
    expect(launched).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/no chrome/i);
    expect(sent[0].text).toMatch(/register-chrome-task\.ps1/);
  });

  it('/chrome kg reachable attaches immediately and NEVER fires the launch task', async () => {
    const launched = [];
    const launch = () => { launched.push('fire'); return { ok: true }; };
    const { cmds, sent } = harness({ config: kg, cdp: reachable, launch });
    await cmds.run({ ...self, body: '/chrome kg' });
    expect(launched).toHaveLength(0);                 // Chrome already up → no launch fired
    expect(sent[0].text).toMatch(/attached/i);
    expect(sent[0].text).toMatch(/tabs: 2/);
  });

  it('/chrome kg on the `do` node fires NO launch and stays silent (gate before any launch)', async () => {
    const launched = [];
    const launch = () => { launched.push('fire'); return { ok: true }; };
    const { cmds, sent } = harness({ config: { node_name: 'do', whatsapp: { chat_id: '!self' } }, cdp: unreachable, launch });
    await cmds.run({ ...self, body: '/chrome kg' });
    expect(sent).toHaveLength(0);
    expect(launched).toHaveLength(0);
  });
});

// /rooms create <name> — the FIRST wired named-room create path (Phase 2). A Room IS a
// folder: `create` makes the standard tree (baseDir + media/files/identity.d/scripts + a minimal
// config.yaml) so the heartbeat/transcription loaders enumerate rooms/<slug>/. All
// fs is routed through the commands io seam, so these run fully in-memory (mkdir recorded,
// writeFile captured) and never touch a real profile. No member roster yet (later work).
//
// 2026-08-09: the room is minted through resolveConvRoom('room', <name>) — the SAME shared
// resolver a Beeper chat goes through — so the harness injects it, exactly as boot does.
describe('/rooms create <name>', () => {
  const self = { chatId: '!self', surface: 'whatsapp' };
  const resolveConvRoom = async (surface, chatId) => Room.forChat(surface, chatId);

  it('/rooms create foo makes the room folder tree and confirms the path', async () => {
    const mkdirs = [];
    const { cmds, sent, files } = harness({
      config: { whatsapp: { chat_id: '!self' } },
      resolveConvRoom,
      io: { mkdir: async (p) => { mkdirs.push(p); }, stat: async () => { throw new Error('ENOENT'); } },
    });
    await cmds.run({ ...self, body: '/rooms create foo' });
    const r = Room.forChat('room', 'foo');
    // the standard tree dirs were created …
    for (const dir of [r.baseDir(), r.mediaDir, r.filesDir, r.identityDir, r.scriptsDir]) expect(mkdirs).toContain(dir);
    // … and NO config file is written into the room folder: the room rung lives
    // in config/rooms.yaml now, and a room with no row resolves to {}.
    expect(Object.keys(files).some((f) => f.endsWith('config.yaml'))).toBe(false);
    // the reply names the EGPT_HOME-relative path — rooms/<slug>/, OUTSIDE the Beeper tree
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/(^|[^\/])rooms\/foo\//);
    expect(sent[0].text).not.toMatch(/conversations/);
    expect(sent[0].text).toMatch(/created/);
    expect(sent[0].text).not.toMatch(/recognized/);   // NOT the unwired catch-all
  });

  it('/rooms create foo again reports it already exists and does NOT clobber (idempotent)', async () => {
    const mkdirs = [];
    const { cmds, sent, files } = harness({
      config: { whatsapp: { chat_id: '!self' } },
      resolveConvRoom,
      io: { mkdir: async (p) => { mkdirs.push(p); }, stat: async () => ({ isDirectory: () => true }) },   // folder present
    });
    await cmds.run({ ...self, body: '/rooms create foo' });
    expect(sent[0].text).toMatch(/already exists/);
    expect(mkdirs).toHaveLength(0);              // nothing created
    expect(Object.keys(files)).toHaveLength(0);  // nothing written → existing content untouched
  });

  it('/rooms create with no name replies usage and creates nothing', async () => {
    const mkdirs = [];
    const { cmds, sent, files } = harness({
      config: { whatsapp: { chat_id: '!self' } },
      resolveConvRoom,
      io: { mkdir: async (p) => { mkdirs.push(p); }, stat: async () => { throw new Error('ENOENT'); } },
    });
    await cmds.run({ ...self, body: '/rooms create' });
    expect(sent[0].text).toMatch(/usage: \/rooms create <name>/);
    expect(mkdirs).toHaveLength(0);
    expect(Object.keys(files)).toHaveLength(0);
  });

  // Bare /rooms LISTS. It absorbed the singular /room, whose bare form showed usage instead
  // (operator 2026-08-29). With nothing to list it still names the verb that makes one, so
  // the command stays self-teaching rather than answering with a dead end.
  it('/rooms (bare) lists rooms, and with none still names the verb that creates one', async () => {
    const { cmds, sent } = harness({ config: { whatsapp: { chat_id: '!self' } } });
    await cmds.run({ ...self, body: '/rooms' });
    expect(sent[0].text).toMatch(/no rooms yet/);
    expect(sent[0].text).toMatch(/\/rooms create/);
    expect(sent[0].text).not.toMatch(/recognized/);
  });

  // Verb-first grammar (Phase 2): the first token must be one of the fixed verbs
  // {create, join, leave, members, delete, help}. Reproduce-first regression for the
  // 2026-08-07 bug fix: an unrecognized first token must NEVER become a room lookup — no
  // roomOnDisk/stat call, nothing room-shaped touched. Proven here by spying on io.stat.
  it('/rooms <unrecognized-verb> <anything> reports the unknown verb and never touches disk', async () => {
    const statCalls = [];
    const { cmds, sent } = harness({
      config: { whatsapp: { chat_id: '!self' } },
      io: { stat: async (p) => { statCalls.push(p); throw new Error('ENOENT'); } },
    });
    await cmds.run({ ...self, body: '/rooms frobnicate acim' });
    expect(sent[0].text).toMatch(/unknown verb/i);
    expect(sent[0].text).toMatch(/frobnicate/);
    expect(statCalls).toEqual([]);   // no roomOnDisk lookup ever ran
  });

  // /rooms delete <room> (verb-first, no force) still reaches the real delete path — proven
  // via the "no room" wording, which only happens if roomOnDisk/roomDelete actually ran.
  it('/rooms delete <room> (no force) reaches roomDelete, not a generic unknown-verb reply', async () => {
    const { cmds, sent } = harness({
      config: { whatsapp: { chat_id: '!self' } },
      io: { stat: async () => { throw new Error('ENOENT'); } },
    });
    await cmds.run({ ...self, body: '/rooms delete acim' });
    expect(sent[0].text).toMatch(/no room 'acim'/);
  });
});

// Defect 1 (live incident 2026-08-07): the slug-first grammar defaults an unrecognized
// first token's sub-verb to `members`, so `/rooms help` (or any typo) rendered a fabricated
// "help (0 members)" roster for a room that was never created — nothing on disk backed it.
// A room absent on disk must say so instead of answering as though it exists.
describe('/rooms <slug> — a nonexistent room says so, never a fabricated roster', () => {
  const self = { chatId: '!self', surface: 'whatsapp' };
  const cfg = { whatsapp: { chat_id: '!self' } };
  const noSuchRoom = { stat: async () => { throw new Error('ENOENT'); } };

  it('/rooms help prints the usage line, NOT a "help (0 members)" roster (the live incident, verbatim)', async () => {
    const { cmds, sent } = harness({ config: cfg, io: noSuchRoom });
    await cmds.run({ ...self, body: '/rooms help' });
    expect(sent[0].text).toMatch(/usage/i);
    expect(sent[0].text).not.toMatch(/members\)/);
  });

  // Under verb-first grammar there is no bare-slug-defaults-to-members case anymore — that
  // WAS the bug. "/rooms bogus" has no recognized verb, so it must hit the unknown-verb
  // path, not an implicit "show me room bogus's members" (noRoomMsg).
  it('/rooms <unqualified-token> (no verb) is a bad command, not an implicit members lookup', async () => {
    const { cmds, sent } = harness({ config: cfg, io: noSuchRoom });
    await cmds.run({ ...self, body: '/rooms bogus' });
    expect(sent[0].text).toMatch(/unknown verb/i);
    expect(sent[0].text).not.toMatch(/members\)/);
    expect(sent[0].text).not.toMatch(/no room 'bogus'/);
  });

  it('/rooms members <nonexistent-room> reports "no room"', async () => {
    const { cmds, sent } = harness({ config: cfg, io: noSuchRoom });
    await cmds.run({ ...self, body: '/rooms members bogus' });
    expect(sent[0].text).toMatch(/no room 'bogus'/);
  });

  it('/rooms delete <nonexistent-room> reports "no room" (same wording as the members path)', async () => {
    const { cmds, sent } = harness({ config: cfg, io: noSuchRoom });
    await cmds.run({ ...self, body: '/rooms delete bogus' });
    expect(sent[0].text).toMatch(/no room 'bogus'/);
  });

  it('/rooms join <room> still works against a not-yet-created room (unchanged pre-provisioning)', async () => {
    const { cmds, sent } = harness({ config: cfg, io: noSuchRoom });
    await cmds.run({ ...self, body: '/rooms join future-room' });
    expect(sent[0].text).toMatch(/joined 'future-room'/);
  });
});

// Phase 2 dispatch recognition: /rooms, /members, /activate are operator-gated commands
// wired BEFORE the catch-all, so they never leak to E. (Behavior lives in
// tests/rooms-members.test.mjs; here we lock only the recognition + non-leak.)
describe('/rooms /members /activate — dispatch recognition', () => {
  const self = { chatId: '!self', surface: 'whatsapp' };
  const cfg = { whatsapp: { chat_id: '!self' } };

  it('are recognized from the Self DM, refused from a random chat', () => {
    const { cmds } = harness({ config: cfg });
    for (const body of ['/rooms', '/members', '/activate chatgpt']) {
      expect(cmds.isCommand({ body, chatId: '!self', surface: 'whatsapp' })).toBe(true);
      expect(cmds.isCommand({ body, chatId: '!group', surface: 'whatsapp' })).toBe(false);
    }
  });

  it('/members replies (not the unwired catch-all) — targets the conversation room now', async () => {
    // No resolveConvRoom / loadState wired in this harness → the default resolver can't resolve
    // → a graceful "can't resolve this conversation's room", NEVER the catch-all or the dropped
    // "no current room" gate. (The real conversation-room behavior lives in rooms-members.test.mjs.)
    const { cmds, sent } = harness({ config: cfg });
    await cmds.run({ ...self, body: '/members' });
    expect(sent[0].text).toMatch(/can't resolve this conversation/i);
    expect(sent[0].text).not.toMatch(/no current room/i);
    expect(sent[0].text).not.toMatch(/recognized/);
  });

  it('/rooms with no saved rooms replies (not the catch-all)', async () => {
    const { cmds, sent } = harness({ config: cfg });
    await cmds.run({ ...self, body: '/rooms' });
    expect(sent[0].text).not.toMatch(/recognized/);
  });
});

// /tabs /open /tab /close — Phase 1 browser command wrappers: thin dispatch over
// cdp.mjs's listTabs/openTab/activateTarget/closeTab, same CDP seam /chrome uses (no
// real Chrome, no real socket in these tests). /tab <n> and /close <n> address a tab by
// the SAME 1-based number /tabs prints, resolved fresh against listTabs() on every call
// — never a stale index carried over from an earlier /tabs (Chrome's own tab order can
// shift between commands).
describe('/tabs /open /tab /close', () => {
  const self = { chatId: '!self', surface: 'whatsapp' };
  const cfg = { whatsapp: { chat_id: '!self' } };
  const twoTabs = [
    { id: 'AAA111', title: 'ChatGPT', url: 'https://chatgpt.com/c/abc' },
    { id: 'BBB222', title: 'Gmail', url: 'https://mail.google.com/mail/u/0' },
  ];

  it('/tabs lists both tabs, numbered, with title + url', async () => {
    const { cmds, sent } = harness({ config: cfg, cdp: { listTabs: async () => twoTabs } });
    await cmds.run({ ...self, body: '/tabs' });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/tabs: 2/);
    expect(sent[0].text).toMatch(/1 · ChatGPT/);
    expect(sent[0].text).toMatch(/chatgpt\.com/);
    expect(sent[0].text).toMatch(/2 · Gmail/);
    expect(sent[0].text).toMatch(/mail\.google\.com/);
  });

  it('/open <url> calls cdp.openTab with that url and names it in the reply', async () => {
    const opened = [];
    const { cmds, sent } = harness({ config: cfg, cdp: { openTab: async (url) => { opened.push(url); return 'NEWID'; } } });
    await cmds.run({ ...self, body: '/open https://example.com' });
    expect(opened).toEqual(['https://example.com']);
    expect(sent[0].text).toMatch(/https:\/\/example\.com/);
  });

  it('/tab 2 activates the 2nd listed tab', async () => {
    const activated = [];
    const cdp = { listTabs: async () => twoTabs, activateTarget: async (id) => { activated.push(id); } };
    const { cmds, sent } = harness({ config: cfg, cdp });
    await cmds.run({ ...self, body: '/tab 2' });
    expect(activated).toEqual(['BBB222']);   // twoTabs[1].id — the SECOND listed tab
    expect(sent[0].text).toMatch(/Gmail/);
  });

  it('/close 2 closes the 2nd listed tab', async () => {
    const closed = [];
    const cdp = { listTabs: async () => twoTabs, closeTab: async (id) => { closed.push(id); } };
    const { cmds, sent } = harness({ config: cfg, cdp });
    await cmds.run({ ...self, body: '/close 2' });
    expect(closed).toEqual(['BBB222']);
    expect(sent[0].text).toMatch(/Gmail/);
  });

  it('/tab <n> past the end of the list reports it instead of throwing', async () => {
    const cdp = { listTabs: async () => twoTabs, activateTarget: async () => {} };
    const { cmds, sent } = harness({ config: cfg, cdp });
    await expect(cmds.run({ ...self, body: '/tab 5' })).resolves.toBeUndefined();
    expect(sent[0].text).toMatch(/no tab 5/);
  });

  it('none of the four fall through to the unwired-command catch-all', async () => {
    const cdp = { listTabs: async () => twoTabs, openTab: async () => 'X', activateTarget: async () => {}, closeTab: async () => {} };
    const { cmds, sent } = harness({ config: cfg, cdp });
    await cmds.run({ ...self, body: '/tabs' });
    await cmds.run({ ...self, body: '/open https://x' });
    await cmds.run({ ...self, body: '/tab 1' });
    await cmds.run({ ...self, body: '/close 1' });
    expect(sent).toHaveLength(4);
    for (const s of sent) expect(s.text).not.toMatch(/recognized/);
  });

  // REGRESSION LOCK (live hang, tools/cdp.mjs fetchJson deadline): a dead Chrome whose
  // port is still LISTENING (zombie PID) makes fetchJson's HTTP probe hang forever with
  // no deadline — tabsReport's `catch { return 'no Chrome to list tabs from …' }` can
  // never fire because a hang is not a rejection. This exercises the REAL cdp.mjs (no
  // injected `cdp:` override) so the fix at the fetchJson chokepoint is what's under
  // test, not a stand-in.
  it('a hung Chrome (port open, never answers) times out — /tabs gets the friendly fallback, not an eternal wait', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((url, opts) => new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener('abort', () => {
        const e = new Error('The operation was aborted');
        e.name = 'AbortError';
        reject(e);
      });
    })));
    try {
      const { cmds, sent } = harness({ config: cfg });   // no cdp override — real cdp.mjs
      const p = cmds.run({ ...self, body: '/tabs' });
      await vi.advanceTimersByTimeAsync(3000);
      await p;
      expect(sent[0].text).toMatch(/no Chrome to list tabs from — try \/chrome first/);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});

// /help — the spine dispatch (src/interpreter.mjs owns the registry + renderer; this is
// just "resolve the surface, call it, send"). Before this was wired, a bare "help" (the
// editor forwards h/help/? as literal "/help", src/shell/commands.mjs) fell through to
// the unwired-command catch-all — the exact failure this locks against.
describe('/help', () => {
  const self = { chatId: '!self', surface: 'whatsapp' };
  const cfg = { whatsapp: { chat_id: '!self' } };

  it('replies with real help text, not the unwired catch-all', async () => {
    const { cmds, sent } = harness({ config: cfg });
    await cmds.run({ ...self, body: '/help' });
    expect(sent).toHaveLength(1);
    // The catch-all's signature phrase (see run()'s final line) — distinct from this
    // renderer's own "NOT YET WIRED" tail label, which also happens to contain the word
    // "recognized".
    expect(sent[0].text).not.toMatch(/wired in v2 so far/);
    expect(sent[0].text).toMatch(/\/status/);   // a real, wired command shows up
  });

  it('lists an unwired command only in the labelled tail, never as if it worked', async () => {
    const { cmds, sent } = harness({ config: cfg });
    await cmds.run({ ...self, body: '/help' });
    const text = sent[0].text;
    const tailIdx = text.indexOf('NOT YET WIRED');
    const rulesIdx = text.indexOf('/rules');   // registered, but nothing dispatches it
    expect(tailIdx).toBeGreaterThan(-1);
    expect(rulesIdx).toBeGreaterThan(tailIdx);
  });

  it('shows the editor-local commands (theme/exit/clear) even though the spine never dispatches them', async () => {
    const { cmds, sent } = harness({ config: cfg });
    await cmds.run({ ...self, body: '/help' });
    const text = sent[0].text;
    const tailIdx = text.indexOf('NOT YET WIRED');
    for (const usage of ['/theme', '/exit', '/clear']) {
      expect(text.indexOf(usage)).toBeGreaterThan(-1);
      expect(text.indexOf(usage)).toBeLessThan(tailIdx);
    }
  });

  it('is recognized from the Self DM, refused from a random chat (same operator gate as every other command)', () => {
    const { cmds } = harness({ config: cfg });
    expect(cmds.isCommand({ body: '/help', chatId: '!self', surface: 'whatsapp' })).toBe(true);
    expect(cmds.isCommand({ body: '/help', chatId: '!group', surface: 'whatsapp' })).toBe(false);
  });
});

// Drift guard: the registry's `wired` marker (src/interpreter.mjs) is a hand-set claim
// about what src/spine/commands.mjs run() actually dispatches. A hand-maintained claim
// with no check is exactly how this went stale before (/help forwarded by the shell,
// never implemented in the spine, and nothing noticed for a release). This reads the
// THREE real source files as text and cross-checks the marker against them mechanically,
// rather than trusting a second hand-written list that could drift the same way.
//
// What this catches: a command marked wired:true whose dispatch regex is renamed/removed
// from commands.mjs; a command actually dispatched there but left unmarked; an
// editor-local marker for a token shell/commands.mjs doesn't actually `case` on.
//
// What this can NOT catch (documented, not silently assumed): whether a dispatched
// command's BEHAVIOR matches its registry `usage`/`desc` text — it would need to execute
// every branch with every argument shape. (The /egpt drift this comment used to flag is
// moot as of 2026-08-15: /e/egpt no longer dispatch anything at all — see the /agents
// retirement — so there is no /egpt registry entry left to drift.)
describe('/help "wired" marker matches src/spine/commands.mjs + src/shell/commands.mjs (drift guard)', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const SPINE_SRC = readFileSync(join(ROOT, 'src', 'spine', 'commands.mjs'), 'utf8');
  const INGEST_SRC = readFileSync(join(ROOT, 'src', 'spine', 'ingest.mjs'), 'utf8');
  const SHELL_SRC = readFileSync(join(ROOT, 'src', 'shell', 'commands.mjs'), 'utf8');

  // Every single-token dispatch in run() is written as `<name>Match = /^\/word...` — a
  // regex literal anchored on the command word. Extract the set MECHANICALLY (rather than
  // hand-copying it) so a renamed/removed dispatch line fails this test instead of the
  // marker silently going stale next to it.
  function tokensDispatchedIn(src) {
    const out = new Set();
    const re = /=\s*\/\^\\\/([a-z][a-z0-9?-]*)/gi;
    let m;
    while ((m = re.exec(src))) out.add(m[1].replace(/\?$/, '').toLowerCase());
    return out;
  }

  const spineTokens = tokensDispatchedIn(SPINE_SRC);
  // Lifecycle (/restart, /upgrade, /rewind) dispatches through an IMPORTED function
  // (lifecycleExit, src/spine/ingest.mjs), not an inline regex in commands.mjs — verified
  // by requiring BOTH the call site here AND the literal token comparisons there.
  if (
    SPINE_SRC.includes('lifecycleExit(line') &&
    INGEST_SRC.includes("'/restart'") && INGEST_SRC.includes("'/upgrade'") && INGEST_SRC.includes("'/rewind'")
  ) { spineTokens.add('restart'); spineTokens.add('upgrade'); spineTokens.add('rewind'); }

  it('every entry marked wired:true has a real dispatch in commands.mjs (or ingest.mjs lifecycle)', () => {
    const offenders = [];
    for (const e of COMMANDS) {
      if (e.wired !== true) continue;
      const tok = e.cmd.replace(/^\//, '').toLowerCase();
      if (!spineTokens.has(tok)) offenders.push(e.cmd);
    }
    expect(offenders).toEqual([]);
  });

  it('every token commands.mjs actually dispatches, that ALSO has a registry entry, is marked wired', () => {
    const offenders = [];
    for (const e of COMMANDS) {
      if (!e.cmd) continue;
      const tok = e.cmd.replace(/^\//, '').toLowerCase();
      if (spineTokens.has(tok) && e.wired !== true) offenders.push(e.cmd);
    }
    expect(offenders).toEqual([]);
  });

  it('every entry marked wired:"editor" is a real `case` in src/shell/commands.mjs\'s router', () => {
    const offenders = [];
    for (const e of COMMANDS) {
      if (e.wired !== 'editor') continue;
      if (!SHELL_SRC.includes(`case '${e.cmd}':`)) offenders.push(e.cmd);
    }
    expect(offenders).toEqual([]);
  });

  it('sanity: the mechanical scan actually found the known dozen (catches a scan that silently matches nothing)', () => {
    for (const tok of ['status', 'chrome', 'tabs', 'open', 'rooms', 'config', 'help', 'agents', 'restart', 'upgrade', 'rewind']) {
      expect(spineTokens.has(tok), `expected "${tok}" in the dispatched-token scan`).toBe(true);
    }
  });

  it('/members has a registry entry, wired true, whose usage covers the same accepted forms as the runtime usage string (no drift)', () => {
    const entry = COMMANDS.find((e) => e.cmd === '/members');
    expect(entry).toBeTruthy();
    expect(entry.wired).toBe(true);
    for (const word of ['add', 'alias', 'remove', 'mode']) {
      expect(entry.usage.toLowerCase()).toMatch(new RegExp(word));
    }
  });
});

// Regression lock (Phase 1): browseTab was a dead export (zero callers anywhere outside
// its own definition in cdp.mjs) evicted alongside /browse. This scans every .mjs/.js
// file under src/ (recursively) for the bare identifier — it FAILS on the pre-eviction
// code (browseTab is defined in src/tools/cdp.mjs) and stays green once it's gone; it
// would also catch a future caller reintroducing it.
describe('browseTab is fully evicted from src/', () => {
  it('no file under src/ references browseTab', () => {
    const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
    const SRC_DIR = join(ROOT, 'src');
    const offenders = [];
    const walk = (dir) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (/\.m?js$/.test(ent.name) && readFileSync(p, 'utf8').includes('browseTab')) offenders.push(p);
      }
    };
    walk(SRC_DIR);
    expect(offenders).toEqual([]);
  });
});

// § VERB-FIRST GRAMMAR (operator 2026-08-28: "better '/cmd subcmd <options>'"). /agents was
// the one command on this surface reading object-then-verb, so `/agents restart p` -- the
// obvious thing to type, and what the operator typed -- parsed `restart` as the being and
// answered `unknown subcommand "p"`, blaming the wrong token. Both orders parse now; the
// pure parser is asserted directly, then end-to-end so it is the real dispatch being proven.
// § COMMAND GRAMMAR — `/<commands> <verb> [<value>] <target> [<scope>]` (operator 2026-08-29:
// "remove legacy ways", "keep only '/agents', '/rooms'", "/members mode <value> <id|slug>").
// The target trails so the being and the conversation sit together; the accepted cost is that
// its slot moves with the verb's arity, which only works because arities are FIXED.
describe('/agents grammar — verb first, target last, no legacy order', () => {
  const parse = (s) => normalizeAgentsArgs(s.split(/\s+/).filter(Boolean));

  it('a 0-arity verb places verb, target, conversation', () => {
    expect(parse('restart p spoiler')).toMatchObject({ args: ['p', 'restart', undefined], slug: 'spoiler', extra: [] });
    expect(parse('restart p')).toMatchObject({ args: ['p', 'restart', undefined], slug: null });
  });

  it('a value-taking verb puts the VALUE before the target, conversation last', () => {
    expect(parse('auto mention p spoiler')).toMatchObject({ args: ['p', 'auto', 'mention'], slug: 'spoiler' });
    expect(parse('auto mention p')).toMatchObject({ args: ['p', 'auto', 'mention'], slug: null });
    expect(parse('access_level all p')).toMatchObject({ args: ['p', 'access_level', 'all'], slug: null });
  });

  it('`all` reads as the target, in either arity, and is never mistaken for a value', () => {
    expect(parse('reset all')).toMatchObject({ args: ['all', 'reset', undefined], slug: null });
    expect(parse('access_level all all')).toMatchObject({ args: ['all', 'access_level', 'all'], slug: null });
  });

  it('no verb = the bare status form, which also takes a trailing conversation', () => {
    expect(parse('p')).toMatchObject({ args: ['p'], slug: null });
    expect(parse('p spoiler')).toMatchObject({ args: ['p'], slug: 'spoiler' });
  });

  it('the RETIRED object-first order is recognised as such — not misparsed, not silently accepted', () => {
    expect(parse('p restart').retired).toMatchObject({ handle: 'p', verb: 'restart' });
    expect(parse('e auto mention').retired).toMatchObject({ handle: 'e', verb: 'auto', rest: ['mention'] });
    expect(parse('p restart').args).toBeUndefined();
  });

  it('a token the grammar cannot place is REPORTED, never silently dropped', () => {
    expect(parse('restart p spoiler junk').extra).toEqual(['junk']);
  });
});

// The singular ASKS rather than aliasing (operator 2026-08-29: "the singular asking you means
// plural?"). Asserted on the pure matcher and then end-to-end, where the point is that it
// answers WITHOUT acting — a silent alias would have cleared the thread.
describe('singular command forms ask for the plural', () => {
  it('matches the three singulars and nothing plural', () => {
    for (const l of ['/agent restart p', '/room join x', '/member mode all 3', '/member=do add tab 3'])
      expect(SINGULAR_CMD.test(l), l).toBe(true);
    for (const l of ['/agents restart p', '/rooms join x', '/members mode all 3', '/agents', '/rooms'])
      expect(SINGULAR_CMD.test(l), l).toBe(false);
  });

  it('names the plural it means', () => {
    expect(PLURAL_OF[SINGULAR_CMD.exec('/agent restart p')[1]]).toBe('agents');
    expect(PLURAL_OF[SINGULAR_CMD.exec('/room join x')[1]]).toBe('rooms');
    expect(PLURAL_OF[SINGULAR_CMD.exec('/member remove z')[1]]).toBe('members');
  });
});
