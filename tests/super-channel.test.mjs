// tests/super-channel.test.mjs — the SUPER CHANNEL, CHUNK 1 (operator 2026-10-08).
//
// A super channel is the SAME KIND of thing as a /join side-room: an ALIAS of the original
// conversation (shares its folder/thread/transcript — conversations-state aliasOf), NOT a /split
// diverging copy. Chunk 1 builds its config + lifecycle + the manual "…" summon; it does NOT yet
// reroute any replies (chunk 2) or implement respect-exit / mention-reinvite (chunk 3).
//
// WHAT THIS LOCKS:
//   · an inbound "…"/"..." from ANY participant (not operator-only), when config.super.enabled,
//     summons the channel through the EXISTING phraseCommand → runPhrase path;
//   · a first summon CREATES <chat>-super, ALIASES it to the conversation (same alias kind /join
//     writes), INVITES Rodz + the summoner, posts config.super.opener ONCE, and sets the channel's
//     auto-mode to config.super.mode;
//   · a second summon REUSES it (no re-create, no duplicate opener);
//   · super disabled/unset ⇒ the "…" is ordinary chat (phraseCommand returns null);
//   · the mode lands on the SHARED entry (a super channel is an alias; mode resolves THROUGH aliasOf
//     to the primary — there is no per-alias mode slot).
//
// THE HARD CONSTRAINT (as in fork-command.test.mjs): never a real Beeper call. forkBridge is an
// injected fake that only RECORDS the call; state is one in-memory object.
import { describe, it, expect, vi } from 'vitest';

// egpt-home.mjs freezes EGPT_HOME at module load (slugDir reads CONVERSATIONS_ROOT off it), so this
// must run BEFORE the imports — vi.hoisted does that. A private temp profile, never ~/.egpt.
vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  process.env.EGPT_HOME = `${tmp}/egpt-super-channel-home`;
});
import { createCommands, SUPER_SUFFIX_DEFAULT, SUPER_OPENER_DEFAULT } from '../src/spine/commands.mjs';
import { ensureContact, recordThread, getContact, getBeing, aliasTargetOf } from '../src/conversations-state.mjs';
import { sanitizeSlug } from '../src/sanitize.mjs';
import { shortChatId } from '../src/bridges/chat-id.mjs';

const C_CHAT = '!chatC';
// createGroup returns the FULL matrix id; the spine keys every conversation by the SHORT id. The
// alias MUST be keyed short or a short-form incoming misses it (the 2026-10-04 "no context" bug).
const SUPER_CHAT_FULL = '!chatSuper:beeper.local';
const SUPER_CHAT = shortChatId(SUPER_CHAT_FULL);
// The SECONDARY (Rodz) account's own room id for the new group — the opener posts here (FROM RODZ).
const SEC_SUPER_ROOM = '!secSuper';
const AN = '+16468217865';
const RODZ = '+13472576794';
const RODZ_DIGITS = '13472576794';
const RODZ_USER_ID = '@whatsapp_lid-69433129173200:beeper.local';
// The summoner — a plain participant (NOT the operator): their inbound "…" is what summons.
const SUMMONER = '@whatsapp_lid-summoner42:beeper.local';
const CHAT_TITLE = 'Proyecto X';
const SUPER_TITLE = `${CHAT_TITLE}${SUPER_SUFFIX_DEFAULT}`;   // 'Proyecto X-super'

function cfg({ superBlock = { enabled: true }, node_role = 'primary', node_name = 'kg' } = {}) {
  return {
    beeper: { primary: { phone: AN }, secondary: { phone: RODZ } },
    node_name, node_role,
    ...(superBlock === null ? {} : { super: superBlock }),
  };
}

// C's contact with a resident being 'e' holding a thread — a KNOWN conversation to alias.
function seedState() {
  let st = ensureContact({ contacts: {} }, 'whatsapp', C_CHAT, { pushedName: CHAT_TITLE }).state;
  st = recordThread(st, 'whatsapp', C_CHAT, 'src-e-thread', '2026-10-01T00:00:00Z', 'e');
  return st;
}

function harness({ config, state, resolveSecondaryChatIdByTitle = () => SEC_SUPER_ROOM, rodzUserId = RODZ_USER_ID } = {}) {
  let st = state ?? seedState();
  const sent = [];
  const logs = [];
  const calls = { create: [], post: [], resolve: [], resolveTitle: [] };
  const forkBridge = {
    editMessage: async () => true,
    createGroup: async (opts) => { calls.create.push(opts); return { success: true, chatID: SUPER_CHAT_FULL }; },
    postReply: async (chatId, text, replyToMessageID, opts = {}) => { calls.post.push({ chatId, text, replyToMessageID, via: opts.via ?? null }); return { ok: true }; },
    archiveChat: async () => true,
    chatAccountId: async () => 'whatsapp',
    chatTitle: async () => null,
    resolveUserIdByPhone: async (digits, opts) => { calls.resolve.push({ digits, opts }); return digits === RODZ_DIGITS ? rodzUserId : null; },
    resolveSecondaryChatIdByTitle: async (title, opts) => { calls.resolveTitle.push({ title, opts }); return resolveSecondaryChatIdByTitle(title, opts); },
  };
  const cmds = createCommands({
    getConfig: () => config,
    send: async (chatId, text) => sent.push({ chatId, text }),
    loadState: async () => st,
    writeState: async (s) => { st = s; },
    defaultKey: 'e',
    forkBridge,
    sleep: async () => {},   // instant opener poll
    onLog: (m) => logs.push(m),
  });
  return { cmds, sent, logs, calls, getState: () => st };
}

// An INBOUND message (no `authorized`/`isSender`, chat is not a configured Self-DM ⇒ NOT operator).
const inbound = (body = '…', extra = {}) => ({ chatId: C_CHAT, surface: 'whatsapp', chatName: CHAT_TITLE, senderId: SUMMONER, body, ...extra });

// ── the "…" trigger: ANY sender, gated only on super.enabled ───────────────────────────────────────
describe('phraseCommand — the "…" super summon is any-sender and super.enabled-gated', () => {
  it('an inbound "…"/"..." from a NON-operator returns "super" when super.enabled (trim-tolerant)', () => {
    const { cmds } = harness({ config: cfg() });
    expect(cmds.phraseCommand(inbound('…'))).toBe('super');
    expect(cmds.phraseCommand(inbound('...'))).toBe('super');
    expect(cmds.phraseCommand(inbound('  …  '))).toBe('super');   // whole trimmed body
    expect(cmds.phraseCommand(inbound('……'))).toBe('super');      // a run of ellipsis
  });

  it('super disabled OR unset ⇒ an inbound "…" does NOTHING special (falls through as ordinary chat)', () => {
    expect(harness({ config: cfg({ superBlock: { enabled: false } }) }).cmds.phraseCommand(inbound('…'))).toBe(null);
    expect(harness({ config: cfg({ superBlock: null }) }).cmds.phraseCommand(inbound('…'))).toBe(null);
  });

  it('only a WHOLE deliberate-silence body triggers (never prefix/contains)', () => {
    const { cmds } = harness({ config: cfg() });
    expect(cmds.phraseCommand(inbound('hola'))).toBe(null);
    expect(cmds.phraseCommand(inbound('… y algo más'))).toBe(null);
    expect(cmds.phraseCommand(inbound('..'))).toBe(null);   // two dots is not the silence shape (needs 3+)
  });
});

// ── the summon: create + alias + invite + opener + mode ─────────────────────────────────────────────
describe('ensureSuperChannel via the "…" summon — a first summon with NO existing channel', () => {
  it('creates <chat>-super (Rodz + the summoner, type group, no inline messageText) and ALIASES it to the conversation', async () => {
    const { cmds, calls, getState } = harness({ config: cfg() });
    await cmds.runPhrase(inbound('…'), 'super');

    expect(calls.create).toHaveLength(1);
    const c = calls.create[0];
    expect(c.title).toBe(SUPER_TITLE);
    expect(c.type).toBe('group');
    expect(c.participantIDs).toEqual([RODZ_USER_ID, SUMMONER]);   // Rodz + the summoner
    expect(c.accountID).toBe('whatsapp');
    expect('messageText' in c).toBe(false);

    const st = getState();
    const primaryJid = getContact(st, 'whatsapp', C_CHAT).jid;
    // THE /join alias kind PLUS the one marker chunk 2 adds — { aliasOf, transcript, super: true }.
    // `super: true` is what the reply path (gate + routing) keys on; /join never carries it.
    expect(st.contacts.whatsapp[SUPER_CHAT]).toEqual({ aliasOf: primaryJid, transcript: sanitizeSlug(SUPER_TITLE), super: true });
    expect(aliasTargetOf(st, 'whatsapp', SUPER_CHAT)).toBe(primaryJid);
    expect(getContact(st, 'whatsapp', SUPER_CHAT).slug).toBe(getContact(st, 'whatsapp', C_CHAT).slug);   // shared folder/thread
  });

  it('posts config.super.opener ONCE, FROM the secondary, into the secondary room, {chat}/{group} filled', async () => {
    const { cmds, calls } = harness({ config: cfg() });
    await cmds.runPhrase(inbound('…'), 'super');
    const expected = SUPER_OPENER_DEFAULT.replaceAll('{chat}', CHAT_TITLE).replaceAll('{group}', CHAT_TITLE);
    expect(calls.resolveTitle).toEqual([{ title: SUPER_TITLE, opts: { accountID: 'whatsapp' } }]);
    expect(calls.post).toEqual([{ chatId: SEC_SUPER_ROOM, text: expected, replyToMessageID: null, via: 'secondary' }]);
  });

  it('stores NO mode on summon (CHUNK 2): the origin\'s stored mode is UNCHANGED, the resident thread is intact (the channel\'s mode is intrinsic, read live at the gate)', async () => {
    const { cmds, getState } = harness({ config: cfg() });
    await cmds.runPhrase(inbound('…'), 'super');
    const st = getState();
    // Summoning must mutate NO stored mode — the old chunk-1 patchBeing flipped the SHARED entry
    // (and never reverted on /end). The seed set no mode, so it stays unset (null) on both surfaces.
    expect(getBeing(st, 'whatsapp', C_CHAT, 'e').mode).toBeNull();       // origin mode UNCHANGED
    expect(getBeing(st, 'whatsapp', SUPER_CHAT, 'e').mode).toBeNull();   // alias resolves through → same (none)
    expect(getBeing(st, 'whatsapp', C_CHAT, 'e').threadId).toBe('src-e-thread');   // resident thread intact
  });

  it('without a summoner id, invites only Rodz', async () => {
    const { cmds, calls } = harness({ config: cfg() });
    await cmds.runPhrase(inbound('…', { senderId: undefined }), 'super');
    expect(calls.create[0].participantIDs).toEqual([RODZ_USER_ID]);
  });
});

// ── reuse: a second "…" when the channel already exists ──────────────────────────────────────────────
describe('ensureSuperChannel — an existing channel is REUSED', () => {
  it('a second "…" does NOT re-create and does NOT post a duplicate opener', async () => {
    const { cmds, calls } = harness({ config: cfg() });
    await cmds.runPhrase(inbound('…'), 'super');
    await cmds.runPhrase(inbound('…'), 'super');
    expect(calls.create).toHaveLength(1);   // reused, not re-created
    expect(calls.post).toHaveLength(1);     // no duplicate opener
  });
});

// ── config: suffix/opener overrides, and NO stored mode whatever config.super.mode says ───────────────
// The mode is no longer stored on summon (CHUNK 2); its coercion (quoted vs YAML-boolean, invalid →
// default) is unit-tested as superModeOf in auto-mode.test.mjs and applied live at the gate in
// gating-dispatch.test.mjs. Here we only lock the create-time title/opener and that summon stores NOTHING.
describe('config.super — suffix / opener overrides, mode never stored', () => {
  it('config.super.suffix and config.super.opener override the built-in fallbacks', async () => {
    const { cmds, calls } = harness({ config: cfg({ superBlock: { enabled: true, suffix: ' ⭐', opener: 'hola {chat}' } }) });
    await cmds.runPhrase(inbound('…'), 'super');
    expect(calls.create[0].title).toBe(`${CHAT_TITLE} ⭐`);
    expect(calls.post[0].text).toBe(`hola ${CHAT_TITLE}`);
  });

  it('a configured mode (string, YAML-boolean, or invalid) still stores NOTHING — the mode is intrinsic', async () => {
    for (const mode of ['mute', true, false, 'bogus']) {
      const { cmds, getState } = harness({ config: cfg({ superBlock: { enabled: true, mode } }) });
      await cmds.runPhrase(inbound('…'), 'super');
      expect(getBeing(getState(), 'whatsapp', C_CHAT, 'e').mode).toBeNull();       // origin never flipped
      expect(getBeing(getState(), 'whatsapp', SUPER_CHAT, 'e').mode).toBeNull();   // alias resolves through → same
    }
  });
});

// ── gates: node role, known conversation, Rodz ───────────────────────────────────────────────────────
describe('ensureSuperChannel — the create gates (like a nameless /join)', () => {
  it('SILENT on a non-primary-role node (both co-account nodes hear the "…"; only the primary creates)', async () => {
    const { cmds, calls, getState } = harness({ config: cfg({ node_role: 'secondary', node_name: 'do' }) });
    await cmds.runPhrase(inbound('…'), 'super');
    expect(calls.create).toHaveLength(0);
    expect(aliasTargetOf(getState(), 'whatsapp', SUPER_CHAT)).toBe(null);
  });

  it('an UNKNOWN conversation (nothing to alias) creates nothing', async () => {
    const { cmds, calls } = harness({ config: cfg(), state: { contacts: {} } });
    await cmds.runPhrase(inbound('…'), 'super');
    expect(calls.create).toHaveLength(0);
  });

  it('Rodz unresolvable → creates nothing', async () => {
    const { cmds, calls } = harness({ config: cfg(), rodzUserId: null });
    await cmds.runPhrase(inbound('…'), 'super');
    expect(calls.create).toHaveLength(0);
  });
});
