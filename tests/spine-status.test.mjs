// /status — node health from the operator's chat. One compact message with live
// process-local liveness (pid/uptime), the git version, the alive-beat age, the
// heartbeat count, and the conversation count. Every probe degrades to '?' so the
// command NEVER throws. (Its own file: spine-commands.test.mjs is being edited by
// another agent — avoid the same-file race.)
import { describe, it, expect } from 'vitest';
import { createCommands } from '../src/spine/commands.mjs';
import { emptyState, ensureContact, patchContact, recordThread, slugDir, getContact } from '../src/conversations-state.mjs';

// A readonly.yaml with two heartbeat entries (the shape heartbeat-loader writes).
const READONLY_YAML = `heartbeats:
  - name: alive
    source: config/config.yaml
    frequency: 60s
    frequency_ms: 60000
    action: 'command: echo beat > state/alive.txt'
    cwd: /home/x/.egpt2
  - name: whatsapp/fam:daily
    source: conversations/whatsapp/fam/config.yaml
    frequency: 1h
    frequency_ms: 3600000
    action: 'command: node summarize.js'
    cwd: /home/x/.egpt2/conversations/whatsapp/fam
`;

// Three contacts, ONE an alias → non-alias slugged count = 2.
function threeContacts() {
  let st = emptyState();
  st = ensureContact(st, 'whatsapp', '!fam:beeper.local', { pushedName: 'fam', slugHint: 'fam' }).state;
  st = ensureContact(st, 'whatsapp', '!hfm:beeper.local', { pushedName: 'HFM', slugHint: 'HFM' }).state;
  // Add an alias entry by hand pointing at the fam primary.
  st = { ...st, contacts: { ...st.contacts, whatsapp: { ...st.contacts.whatsapp, '!fam-alt:beeper.local': { aliasOf: '!fam:beeper.local' } } } };
  return st;
}

// cdp defaults to an always-down fake — bare /status now probes cdp.isRunning() for
// its `chrome:` field, and a test that doesn't care about Chrome must never hit the
// real localhost CDP port. Tests targeting the chrome field override this.
function harness({ io, gitOut, loadState, brains, getConfig, onLog, cdp, warmStats, shellConnected, dueFor } = {}) {
  const sent = [];
  const cmds = createCommands({
    getConfig: getConfig ?? (() => ({ whatsapp: { chat_id: '!self' } })),
    send: async (chatId, text) => sent.push({ chatId, text }),
    exit: () => {},
    loadState,
    io,
    gitOut,
    brains,
    onLog,
    cdp: cdp ?? { isRunning: async () => false },
    ...(warmStats ? { warmStats } : {}),
    ...(shellConnected ? { shellConnected } : {}),
    // the compaction probe reads ~/.claude/projects for real — always fake it here
    dueFor: dueFor ?? (() => ({ due: false })),
  });
  return { cmds, sent };
}

// Fake readFile keyed by path SUFFIX (transcript.md / heartbeats.readonly.yaml live at
// different paths but the test doesn't care about EGPT_HOME/slugDir specifics). A
// mapped Error value means "throw" (degrade to '?'/'unknown', matching the real fs).
function readFileBySuffix(map) {
  return async (p) => {
    for (const [suffix, content] of Object.entries(map)) {
      if (String(p).endsWith(suffix)) {
        if (content instanceof Error) throw content;
        return content;
      }
    }
    throw new Error(`no fixture for path ${p}`);
  };
}

describe('/status', () => {
  it('replies ONE message with the pid and the sha (all probes healthy)', async () => {
    const { cmds, sent } = harness({
      io: {
        stat: async () => ({ mtimeMs: Date.now() - 12_000 }),   // 12s ago
        readFile: async () => READONLY_YAML,
      },
      gitOut: (args) => (args.includes('--short') ? 'abc1234' : 'spine /status ops line'),
      loadState: async () => threeContacts(),
    });

    await cmds.run({ body: '/status', chatId: '!self', surface: 'whatsapp' });

    expect(sent).toHaveLength(1);
    const { text } = sent[0];
    expect(text).toContain(`pid: ${process.pid}`);
    expect(text).toContain('abc1234');
    expect(text).toContain('spine /status ops line');
    expect(text).toMatch(/heartbeats: 2/);
    expect(text).toMatch(/conversations: 2/);
    expect(text).toMatch(/beat: \d+s ago/);
    // one message = a single fenced yaml block, no extra sends
    expect(text.startsWith('```yaml\n')).toBe(true);
    expect(text.endsWith('\n```')).toBe(true);
  });

  it('degrades every failing probe to "?" and still replies once', async () => {
    const { cmds, sent } = harness({
      io: {
        stat: async () => { throw new Error('no alive.txt'); },
        readFile: async () => { throw new Error('no readonly file'); },
      },
      gitOut: () => '',                 // no git → sha '?'
      loadState: async () => null,      // no state → conversations '?'
    });

    await cmds.run({ body: '/status', chatId: '!self', surface: 'whatsapp' });

    expect(sent).toHaveLength(1);
    const { text } = sent[0];
    expect(text).toContain(`pid: ${process.pid}`);     // pid always available
    expect(text).toContain('egpt: ?');                 // sha degraded
    expect(text).toMatch(/beat: \? ago/);              // beat age degraded
    expect(text).toMatch(/heartbeats: \?/);            // heartbeat count degraded
    expect(text).toMatch(/conversations: \?/);         // conversation count degraded
  });

  it('never throws even when loadState itself throws', async () => {
    const { cmds, sent } = harness({
      io: { stat: async () => ({ mtimeMs: Date.now() }), readFile: async () => READONLY_YAML },
      gitOut: (args) => (args.includes('--short') ? 'deadbee' : 'subj'),
      loadState: async () => { throw new Error('state read blew up'); },
    });

    await expect(cmds.run({ body: '/status', chatId: '!self', surface: 'whatsapp' })).resolves.toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/conversations: \?/);
  });

  it('truncates the egpt line to ~60 chars + … for a long subject', async () => {
    const longSubject = 'agents: ONE registry for persona + local beings + relay targets and more';
    const { cmds, sent } = harness({
      io: { stat: async () => ({ mtimeMs: Date.now() }), readFile: async () => READONLY_YAML },
      gitOut: (args) => (args.includes('--short') ? '099bd06' : longSubject),
      loadState: async () => threeContacts(),
    });

    await cmds.run({ body: '/status', chatId: '!self', surface: 'whatsapp' });
    const first = sent[0].text.split('\n')[1];   // line after the ```yaml fence
    expect(first).toBe('egpt: 099bd06 · agents: ONE registry for persona + local bei…');
    expect(first.endsWith('…')).toBe(true);
    expect(first.length).toBeLessThanOrEqual(61);   // 60 chars + the …
  });

  it('includes this chat\'s E mode when the contact has one set', async () => {
    let st = ensureContact(emptyState(), 'whatsapp', '!fam:beeper.local', { pushedName: 'fam', slugHint: 'fam' }).state;
    st = { ...st, contacts: { whatsapp: { '!fam:beeper.local': { ...st.contacts.whatsapp['!fam:beeper.local'], agents: { e: { mode: 'mute' } } } } } };   // persona mode lives in agents.e now (phase 1, 2026-08-14)
    const { cmds, sent } = harness({
      io: { stat: async () => ({ mtimeMs: Date.now() }), readFile: async () => READONLY_YAML },
      gitOut: (args) => (args.includes('--short') ? 'abc1234' : 's'),
      loadState: async () => st,
    });

    await cmds.run({ body: '/status', chatId: '!fam:beeper.local', surface: 'whatsapp' });
    expect(sent[0].text).toMatch(/mode: mute/);
  });

  it('/status is intercepted only from an authorized chat (isCommand gate)', () => {
    const { cmds } = harness({});
    expect(cmds.isCommand({ body: '/status', chatId: '!self' })).toBe(true);          // Self DM
    expect(cmds.isCommand({ body: '/status', chatId: '!rando' })).toBe(false);         // random chat
  });

  it('the fallback recognized-list now advertises /status', async () => {
    const { cmds, sent } = harness({});
    await cmds.run({ body: '/channels', chatId: '!self', surface: 'whatsapp' });
    expect(sent[0].text).toMatch(/\/status/);
  });
});

// /status <fragment> — operator's per-conversation minimum (2026-07-03): target
// resolved through resolveTarget (the same resolver /agents' `=<slug>` binding uses), one
// fenced yaml block with name/surface/slug/conversation_path/mode/agent/personality/thread/members.
describe('/status <target>', () => {
  const NO_HEARTBEATS = new Error('no readonly file');
  const NO_TRANSCRIPT = new Error('ENOENT');

  it('/status: conversation state not wired (loadState absent)', async () => {
    const { cmds, sent } = harness({});
    await cmds.run({ body: '/status hfm', chatId: '!self', surface: 'whatsapp' });
    expect(sent[0].text).toMatch(/conversation state not wired/);
  });

  it('reports no match exactly like /agents=<slug> (resolveTarget) — no state read failure either', async () => {
    const { cmds, sent } = harness({ loadState: async () => emptyState() });
    await cmds.run({ body: '/status zzz', chatId: '!self', surface: 'whatsapp' });
    // Token QUOTED (2026-07-25 incident): this reply used to open with a bare "/status:",
    // which made it a command in its own right — the seed of the two-node flood.
    expect(sent[0].text).toMatch(/^`\/status`: no chat matches "zzz"/);
  });

  it('a NEVER-STARTED conversation with NO brains registry: the live def falls back to the deterministic constants', async () => {
    const { state: created } = ensureContact(emptyState(), 'whatsapp', '!hfm:beeper.local', { pushedName: 'HFM', slugHint: 'HFM' });
    const { cmds, sent } = harness({
      loadState: async () => created,
      io: { readFile: readFileBySuffix({ 'transcript.md': NO_TRANSCRIPT, 'heartbeats.readonly.yaml': NO_HEARTBEATS }) },
    });

    await cmds.run({ body: '/status hfm', chatId: '!self', surface: 'whatsapp' });
    const { text } = sent[0];
    expect(text.startsWith('```yaml\n')).toBe(true);
    expect(text).toMatch(/name: HFM/);
    expect(text).toMatch(/surface: whatsapp/);
    expect(text).toMatch(/slug: HFM-\d{10}/);
    expect(text).toMatch(/conversation_path: .*conversations\/whatsapp\/HFM-\d{10}/);
    expect(text).toMatch(/mode: mention \(default\)/);   // no per-conv mode set → global default, marked
    expect(text).toMatch(/agent: egpt/);
    expect(text).toMatch(/engine: ccode/);
    expect(text).toMatch(/model: sonnet/);               // DETERMINISTIC_MODEL fallback (no brains registry)
    expect(text).toMatch(/effort: high/);                // DETERMINISTIC_EFFORT fallback
    expect(text).toMatch(/allowed_tools: \[Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, Task\]/);   // DEFAULT_ALLOWED_TOOLS
    expect(text).toMatch(/personality: egpt/);
    expect(text).toMatch(/thread_id: not started/);
    expect(text).toMatch(/members: unknown/);            // no transcript yet
    expect(text).not.toMatch(/heartbeats:/);              // omitted, not '?' — matches bare /status's optional `mode` pattern
  });

  it('a NEVER-STARTED conversation WITH a brains registry: shows the resolved default type\'s model/effort/tools/personality', async () => {
    const { state: created } = ensureContact(emptyState(), 'whatsapp', '!hfm:beeper.local', { pushedName: 'HFM', slugHint: 'HFM' });
    const brains = { resolve: (name) => (name === 'egpt' ? { name: 'egpt', type: 'ccode', model: 'opus', effort: 'low', allowed_tools: ['Read'], personality: 'poet' } : null) };
    const { cmds, sent } = harness({
      loadState: async () => created,
      brains,
      io: { readFile: readFileBySuffix({ 'transcript.md': NO_TRANSCRIPT, 'heartbeats.readonly.yaml': NO_HEARTBEATS }) },
    });

    await cmds.run({ body: '/status hfm', chatId: '!self', surface: 'whatsapp' });
    const { text } = sent[0];
    expect(text).toMatch(/agent: egpt/);
    expect(text).toMatch(/engine: ccode/);
    expect(text).toMatch(/model: opus/);
    expect(text).toMatch(/effort: low/);
    expect(text).toMatch(/allowed_tools: \[Read\]/);
    expect(text).toMatch(/personality: poet/);
    expect(text).toMatch(/thread_id: not started/);
  });

  // PHASE 1 (operator 2026-08-14): there is no more freeze — a conversation with a live
  // thread shows the SAME live-resolved agent/model/effort/tools/personality a never-started
  // one does (resolveDefaultBrainDef, the exact function brainpool.mjs's turn() itself calls).
  // Only thread_id/mode/members reflect this conversation's own history.
  it('a conversation WITH a thread: real thread_id/mode/members, but agent/model/effort/tools/personality are the LIVE resolved def (no more freeze)', async () => {
    const first = ensureContact(emptyState(), 'whatsapp', '!hfm:beeper.local', { pushedName: 'HFM', slugHint: 'HFM' });
    const slug = first.slug;
    let state = patchContact(first.state, 'whatsapp', '!hfm:beeper.local', { agents: { e: { mode: 'on' } } });
    state = recordThread(state, 'whatsapp', '!hfm:beeper.local', 'THREAD-1', undefined, 'e');
    const transcript = [
      'An@[HFM].wa (10:00): hola',
      '',
      '@e.kg@[HFM].wa (10:01): hola An',
      '',
      'Ron@[HFM].wa (10:02): que tal',
      '',
    ].join('\n');
    const brains = { resolve: (name) => (name === 'sonnet-high' ? { name, type: 'ccode', model: 'opus', effort: 'high', allowed_tools: ['Read'], personality: 'poet' } : null) };
    const getConfig = () => ({ whatsapp: { chat_id: '!self' }, agents: { egpt: { configuration: 'sonnet-high', handles: ['e', 'egpt'], default: true } } });

    const { cmds, sent } = harness({
      loadState: async () => state,
      brains, getConfig,
      io: { readFile: readFileBySuffix({ 'transcript.md': transcript, 'heartbeats.readonly.yaml': NO_HEARTBEATS }) },
    });

    await cmds.run({ body: '/status hfm', chatId: '!self', surface: 'whatsapp' });
    const { text } = sent[0];
    expect(text).toMatch(new RegExp(`slug: ${slug}`));
    expect(text).toMatch(/mode: on/);
    expect(text).toMatch(/agent: sonnet-high/);
    expect(text).toMatch(/engine: ccode/);
    expect(text).toMatch(/model: opus/);
    expect(text).toMatch(/effort: high/);
    expect(text).toMatch(/allowed_tools: \[Read\]/);
    expect(text).toMatch(/personality: poet/);
    expect(text).toMatch(/thread_id: THREAD-1/);
    // Distinct, first-seen order — and the being's `@` sigil is what keeps `@e.kg` off the
    // HUMAN list now that a being's line and a person's line share one shape (2026-08-28).
    expect(text).toMatch(/members: An, @e\.kg, Ron/);
  });

  it('a resolved type file that omits `personality:` falls back to \'egpt\'; a literal \'all\' is coerced to the explicit list (same as brainpool)', async () => {
    const first = ensureContact(emptyState(), 'whatsapp', '!hfm:beeper.local', { pushedName: 'HFM', slugHint: 'HFM' });
    const brains = { resolve: (name) => (name === 'egpt' ? { name, type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: 'all' } : null) };   // no personality field
    const { cmds, sent } = harness({
      loadState: async () => first.state,
      brains,
      io: { readFile: readFileBySuffix({ 'transcript.md': NO_TRANSCRIPT, 'heartbeats.readonly.yaml': NO_HEARTBEATS }) },
    });

    await cmds.run({ body: '/status hfm', chatId: '!self', surface: 'whatsapp' });
    expect(sent[0].text).toMatch(/personality: egpt/);
    expect(sent[0].text).toMatch(/allowed_tools: \[Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, Task\]/);
  });

  // `source` is the profile-relative RUNG FILE now (operator ruling 2026-07-26 — every
  // resolved chunk names the file it was read from), so the entity match is on `cwd`,
  // which is the entity folder a beat runs in.
  it('this conversation\'s own heartbeat count is included when trivially available (cwd pinned to its convDir)', async () => {
    const first = ensureContact(emptyState(), 'whatsapp', '!hfm:beeper.local', { pushedName: 'HFM', slugHint: 'HFM' });
    const convDir = slugDir('whatsapp', first.slug);
    const { cmds, sent } = harness({
      loadState: async () => first.state,
      io: {
        readFile: readFileBySuffix({
          'transcript.md': NO_TRANSCRIPT,
          'heartbeats.readonly.yaml': `heartbeats:\n  - name: whatsapp/hfm:daily\n    source: conversations/whatsapp/hfm/config.yaml\n    cwd: ${JSON.stringify(convDir)}\n`,
        }),
      },
    });
    await cmds.run({ body: '/status hfm', chatId: '!self', surface: 'whatsapp' });
    expect(sent[0].text).toMatch(/heartbeats: 1/);
  });

  it('renders the richer members line from stats.yaml counters — label preference: alias > member name > raw id', async () => {
    const first = ensureContact(emptyState(), 'whatsapp', '!hfm:beeper.local', { pushedName: 'HFM', slugHint: 'HFM' });
    // stats files are HUMAN-NAMED now (<display name>.yaml, not the chat id), with the chat_id
    // as the in-body identity anchor. /status resolves the file by the display name ('HFM') —
    // existsSync makes the resolver's fast path find HFM.yaml without scanning the dir.
    // 111 has BOTH an alias and a member name (alias wins); 222 has only a member name (name
    // wins over the raw id); 333 has neither (raw id).
    const STATS_YAML = `chat_id: "!hfm:beeper.local"
name: HFM
members:
  "@whatsapp_111:beeper.local":
    name: Andres
    count: 12
    last_seen: "2026-07-03T14:22:00.000Z"
  "@whatsapp_222:beeper.local":
    name: Zoe
    count: 3
    last_seen: "2026-07-02T09:00:00.000Z"
  "@whatsapp_333:beeper.local":
    count: 1
    last_seen: "2026-07-01T08:00:00.000Z"
`;
    const { cmds, sent } = harness({
      loadState: async () => first.state,
      getConfig: () => ({ whatsapp: { chat_id: '!self' }, aliases: { '@whatsapp_111:beeper.local': 'An' } }),
      io: {
        readFile: readFileBySuffix({ 'HFM.yaml': STATS_YAML, 'transcript.md': 'An@[HFM].wa (10:00): hola\n', 'heartbeats.readonly.yaml': NO_HEARTBEATS }),
        existsSync: (p) => String(p).endsWith('HFM.yaml'),
      },
    });

    await cmds.run({ body: '/status hfm', chatId: '!self', surface: 'whatsapp' });
    // alias beats the member name (An not Andres), member name beats the raw id (Zoe), raw id last resort
    expect(sent[0].text).toContain('members: An: 12 (last 2026-07-03T14:22:00.000Z), Zoe: 3 (last 2026-07-02T09:00:00.000Z), @whatsapp_333:beeper.local: 1 (last 2026-07-01T08:00:00.000Z)');
  });

  it('falls back to the transcript-derived members line when stats.yaml is absent/unreadable', async () => {
    const first = ensureContact(emptyState(), 'whatsapp', '!hfm:beeper.local', { pushedName: 'HFM', slugHint: 'HFM' });
    // OLD-SHAPE BACK-COMPAT: months of the operator's history predate the 2026-08-28 unified
    // line shape and are never rewritten, so `[@being (HH:MM)]:` must keep deriving members.
    const transcript = ['An@[HFM].wa (10:00): hola', '', '[@e (10:01)]: hola An', ''].join('\n');
    const { cmds, sent } = harness({
      loadState: async () => first.state,
      // no stats file on disk (existsSync false, empty dir) → resolver returns the fallback path,
      // whose read throws → /status degrades to the transcript-derived members line.
      io: {
        readFile: readFileBySuffix({ 'HFM.yaml': new Error('ENOENT'), 'transcript.md': transcript, 'heartbeats.readonly.yaml': NO_HEARTBEATS }),
        existsSync: () => false,
        readdir: async () => [],
      },
    });

    await cmds.run({ body: '/status hfm', chatId: '!self', surface: 'whatsapp' });
    expect(sent[0].text).toMatch(/members: An, @e/);   // transcript derivation intact (regression)
  });
});

// beeper_accounts REGISTRY (operator 2026-07-08, trusted-network chunk c): a named map of
// this trusted network's Beeper accounts, config.beeper.<name>.{account,token}. v1 is
// REGISTRY + OBSERVABILITY ONLY — /status shows NAME + ACCOUNT, NEVER the token.
describe('/status: beeper_accounts registry', () => {
  const HEALTHY_IO = { stat: async () => ({ mtimeMs: Date.now() }), readFile: async () => READONLY_YAML };
  const HEALTHY_GIT = (args) => (args.includes('--short') ? 'abc1234' : 's');

  it('no beeper block: bare /status is byte-for-byte unchanged (regression lock)', async () => {
    const { cmds, sent } = harness({ io: HEALTHY_IO, gitOut: HEALTHY_GIT, loadState: async () => threeContacts() });
    await cmds.run({ body: '/status', chatId: '!self', surface: 'whatsapp' });
    expect(sent[0].text).not.toMatch(/beeper_accounts/);
  });

  it('beeper block present: beeper_accounts lists each entry\'s name + account, never the token', async () => {
    const { cmds, sent } = harness({
      io: HEALTHY_IO,
      gitOut: HEALTHY_GIT,
      loadState: async () => threeContacts(),
      getConfig: () => ({
        whatsapp: { chat_id: '!self' },
        beeper: {
          dolly: { account: 'dolly.egpt@gmail.com', token: 'ROD-SECRET-TOKEN-1' },
          reve: { account: 'anrodz42@gmail.com', token: 'REVE-SECRET-TOKEN-2' },
        },
      }),
    });

    await cmds.run({ body: '/status', chatId: '!self', surface: 'whatsapp' });
    const { text } = sent[0];
    expect(text).toMatch(/beeper_accounts:\n {2}dolly: dolly\.egpt@gmail\.com\n {2}reve: anrodz42@gmail\.com/);
    expect(text).not.toContain('ROD-SECRET-TOKEN-1');
    expect(text).not.toContain('REVE-SECRET-TOKEN-2');
  });

  it('a malformed entry (missing account) is skipped and logged by name, never crashes boot; valid siblings still show', async () => {
    const logs = [];
    const { cmds, sent } = harness({
      io: HEALTHY_IO,
      gitOut: HEALTHY_GIT,
      loadState: async () => threeContacts(),
      onLog: (m) => logs.push(m),
      getConfig: () => ({
        whatsapp: { chat_id: '!self' },
        beeper: {
          dolly: { account: 'dolly.egpt@gmail.com', token: 'ROD-SECRET-TOKEN-1' },
          broken: { token: 'ORPHAN-TOKEN' },   // missing account
        },
      }),
    });

    await expect(cmds.run({ body: '/status', chatId: '!self', surface: 'whatsapp' })).resolves.toBeUndefined();
    const { text } = sent[0];
    expect(text).toMatch(/beeper_accounts:\n {2}dolly: dolly\.egpt@gmail\.com/);
    expect(text).not.toMatch(/broken/);
    expect(text).not.toContain('ORPHAN-TOKEN');
    expect(logs.some((m) => m.includes('broken') && m.includes('missing account'))).toBe(true);
  });

  it('the reserved "use" selector key is skipped silently (not logged as broken), and a genuinely malformed sibling still warns', async () => {
    const logs = [];
    const { cmds, sent } = harness({
      io: HEALTHY_IO,
      gitOut: HEALTHY_GIT,
      loadState: async () => threeContacts(),
      onLog: (m) => logs.push(m),
      getConfig: () => ({
        whatsapp: { chat_id: '!self' },
        beeper: {
          use: 'main',   // selector, not an account entry — must never warn
          main: { account: 'anrodz42@gmail.com', token: 'MAIN-SECRET-TOKEN' },
          other: { token: 'ORPHAN-TOKEN' },   // genuinely missing account — must still warn
        },
      }),
    });

    await cmds.run({ body: '/status', chatId: '!self', surface: 'whatsapp' });
    expect(logs.some((m) => m.includes('"use"'))).toBe(false);
    expect(logs.some((m) => m.includes('"other"') && m.includes('missing account'))).toBe(true);
    expect(sent[0].text).toMatch(/beeper_accounts:\n {2}main: anrodz42@gmail\.com/);
  });

  it('tokens are optional in v1: an accounts-only entry (no token) still registers', async () => {
    const { cmds, sent } = harness({
      io: HEALTHY_IO,
      gitOut: HEALTHY_GIT,
      loadState: async () => threeContacts(),
      getConfig: () => ({ whatsapp: { chat_id: '!self' }, beeper: { dolly: { account: 'dolly.egpt@gmail.com' } } }),
    });

    await cmds.run({ body: '/status', chatId: '!self', surface: 'whatsapp' });
    expect(sent[0].text).toMatch(/beeper_accounts:\n {2}dolly: dolly\.egpt@gmail\.com/);
  });
});

// Operator-requested enrichment: node_name/peers/transcription/agents/chrome/warm/shell.
// Every probe is independently guarded — none may throw, none may leak a secret.
describe('/status: enriched fields', () => {
  const HEALTHY_IO = { stat: async () => ({ mtimeMs: Date.now() }), readFile: async () => READONLY_YAML };
  const HEALTHY_GIT = (args) => (args.includes('--short') ? 'abc1234' : 's');
  const TOKEN_SENTINEL = 'TX-SECRET-TOKEN-DO-NOT-LEAK';

  const RICH_CONFIG = {
    whatsapp: { chat_id: '!self' },
    node_name: 'kg',
    account_peers: ['kg', 'do'],
    transcription_service: {
      enabled: true,
      use_config: 'reve',
      reve: {
        fallback_order: ['remote', 'cli'],
        remote: { type: 'whisper-server-remote', endpoint: 'http://192.168.1.102:23390', token: TOKEN_SENTINEL },
        cli: { type: 'whisper-cli', command: '/opt/whisper/whisper-cli.exe', model_path: '/m/large-v3.bin' },
      },
    },
    agents: {
      egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true },
      carol: { relay_channel: 'rodz1', to: 'don.do' },
      wren: { paths: [{ path1: { relay_channel: 'rodz2', to: 'ed.do' } }] },
    },
  };

  it('node_name + peers render inline when configured', async () => {
    const { cmds, sent } = harness({ io: HEALTHY_IO, gitOut: HEALTHY_GIT, loadState: async () => threeContacts(), getConfig: () => RICH_CONFIG });
    await cmds.run({ body: '/status', chatId: '!self', surface: 'whatsapp' });
    const { text } = sent[0];
    expect(text).toMatch(/node_name: kg/);
    expect(text).toMatch(/peers: \[kg, do\]/);
  });

  it('node_name/peers are omitted entirely when unset (no false blanks)', async () => {
    const { cmds, sent } = harness({ io: HEALTHY_IO, gitOut: HEALTHY_GIT, loadState: async () => threeContacts() });
    await cmds.run({ body: '/status', chatId: '!self', surface: 'whatsapp' });
    const { text } = sent[0];
    expect(text).not.toMatch(/node_name:/);
    expect(text).not.toMatch(/peers:/);
  });

  it('transcription block resolves use_config into fallback_order + each engine\'s type/location (self-contained, no config.yaml needed)', async () => {
    const { cmds, sent } = harness({ io: HEALTHY_IO, gitOut: HEALTHY_GIT, loadState: async () => threeContacts(), getConfig: () => RICH_CONFIG });
    await cmds.run({ body: '/status', chatId: '!self', surface: 'whatsapp' });
    const { text } = sent[0];
    expect(text).toMatch(
      /transcription:\n {2}enabled: true\n {2}use_config: reve\n {2}fallback_order: \[remote, cli\]\n {2}remote: whisper-server-remote @ http:\/\/192\.168\.1\.102:23390\n {2}cli: whisper-cli @ whisper-cli\.exe/,
    );
  });

  it('degrades honestly when use_config is missing: no fallback_order/engine lines, never throws', async () => {
    const cfg = { ...RICH_CONFIG, transcription_service: { enabled: true } };
    const { cmds, sent } = harness({ io: HEALTHY_IO, gitOut: HEALTHY_GIT, loadState: async () => threeContacts(), getConfig: () => cfg });
    await expect(cmds.run({ body: '/status', chatId: '!self', surface: 'whatsapp' })).resolves.toBeUndefined();
    const { text } = sent[0];
    expect(text).toMatch(/transcription:\n {2}enabled: true\n {2}use_config: \?/);
    expect(text).not.toMatch(/fallback_order/);
  });

  it('degrades honestly when use_config names a profile that is not defined: fallback_order: ?, never throws', async () => {
    const cfg = { ...RICH_CONFIG, transcription_service: { enabled: true, use_config: 'ghost' } };
    const { cmds, sent } = harness({ io: HEALTHY_IO, gitOut: HEALTHY_GIT, loadState: async () => threeContacts(), getConfig: () => cfg });
    await expect(cmds.run({ body: '/status', chatId: '!self', surface: 'whatsapp' })).resolves.toBeUndefined();
    const { text } = sent[0];
    expect(text).toMatch(/use_config: ghost\n {2}fallback_order: \?/);
  });

  it('degrades honestly when fallback_order is absent/empty on a resolved profile: fallback_order: [], never throws', async () => {
    const cfg = { ...RICH_CONFIG, transcription_service: { enabled: true, use_config: 'reve', reve: {} } };
    const { cmds, sent } = harness({ io: HEALTHY_IO, gitOut: HEALTHY_GIT, loadState: async () => threeContacts(), getConfig: () => cfg });
    await expect(cmds.run({ body: '/status', chatId: '!self', surface: 'whatsapp' })).resolves.toBeUndefined();
    const { text } = sent[0];
    expect(text).toMatch(/use_config: reve\n {2}fallback_order: \[\]/);
  });

  it('degrades honestly when an engine is named in fallback_order but not defined: that line shows ?, siblings still resolve', async () => {
    const cfg = {
      ...RICH_CONFIG,
      transcription_service: {
        enabled: true,
        use_config: 'reve',
        reve: { fallback_order: ['remote', 'ghost-engine'], remote: RICH_CONFIG.transcription_service.reve.remote },
      },
    };
    const { cmds, sent } = harness({ io: HEALTHY_IO, gitOut: HEALTHY_GIT, loadState: async () => threeContacts(), getConfig: () => cfg });
    await expect(cmds.run({ body: '/status', chatId: '!self', surface: 'whatsapp' })).resolves.toBeUndefined();
    const { text } = sent[0];
    expect(text).toMatch(/ {2}remote: whisper-server-remote @ http:\/\/192\.168\.1\.102:23390/);
    expect(text).toMatch(/ {2}ghost-engine: \? @ \?/);
  });

  it('transcription: off when the block is absent', async () => {
    const { cmds, sent } = harness({ io: HEALTHY_IO, gitOut: HEALTHY_GIT, loadState: async () => threeContacts() });
    await cmds.run({ body: '/status', chatId: '!self', surface: 'whatsapp' });
    expect(sent[0].text).toMatch(/^transcription: off$/m);
  });

  it('transcription: off when explicitly disabled (enabled:false)', async () => {
    const cfg = { ...RICH_CONFIG, transcription_service: { ...RICH_CONFIG.transcription_service, enabled: false } };
    const { cmds, sent } = harness({ io: HEALTHY_IO, gitOut: HEALTHY_GIT, loadState: async () => threeContacts(), getConfig: () => cfg });
    await cmds.run({ body: '/status', chatId: '!self', surface: 'whatsapp' });
    expect(sent[0].text).toMatch(/^transcription: off$/m);
  });

  // THE SECURITY-CRITICAL TEST: a naive dump of the transcription block would leak
  // remote.token straight into an operator chat. This must fail on any implementation
  // that surfaces the whole engine config instead of cherry-picking endpoint/host.
  it('SECURITY: the remote transcription token never appears anywhere in /status output', async () => {
    const { cmds, sent } = harness({ io: HEALTHY_IO, gitOut: HEALTHY_GIT, loadState: async () => threeContacts(), getConfig: () => RICH_CONFIG });
    await cmds.run({ body: '/status', chatId: '!self', surface: 'whatsapp' });
    expect(sent[0].text).not.toContain(TOKEN_SENTINEL);
  });

  it('agents: persona shows its handles, a scalar relay shows "name → to", a multipath relay shows its to once', async () => {
    const { cmds, sent } = harness({ io: HEALTHY_IO, gitOut: HEALTHY_GIT, loadState: async () => threeContacts(), getConfig: () => RICH_CONFIG });
    await cmds.run({ body: '/status', chatId: '!self', surface: 'whatsapp' });
    const { text } = sent[0];
    expect(text).toMatch(/agents:\n( {2}.*\n)*/);
    expect(text).toMatch(/ {2}egpt \(e, egpt\)/);
    expect(text).toMatch(/ {2}carol → don\.do/);
    expect(text).toMatch(/ {2}wren → ed\.do/);
  });

  it('agents block is omitted when cfg().agents is absent', async () => {
    const { cmds, sent } = harness({ io: HEALTHY_IO, gitOut: HEALTHY_GIT, loadState: async () => threeContacts() });
    await cmds.run({ body: '/status', chatId: '!self', surface: 'whatsapp' });
    expect(sent[0].text).not.toMatch(/agents:/);
  });

  it('chrome: up · N brain tabs — counts only tabs whose URL matches a loaded adapter', async () => {
    const cdp = {
      isRunning: async () => true,
      listTabs: async () => ([
        { url: 'https://claude.ai/chat/abc' },     // matches claude-cdp adapter
        { url: 'https://chatgpt.com/c/xyz' },      // matches chatgpt-cdp adapter
        { url: 'https://example.com/nope' },       // no adapter
      ]),
    };
    const { cmds, sent } = harness({ io: HEALTHY_IO, gitOut: HEALTHY_GIT, loadState: async () => threeContacts(), cdp });
    await cmds.run({ body: '/status', chatId: '!self', surface: 'whatsapp' });
    expect(sent[0].text).toMatch(/chrome: up · 2 brain tabs/);
  });

  it('chrome: off when Chrome is not running', async () => {
    const { cmds, sent } = harness({ io: HEALTHY_IO, gitOut: HEALTHY_GIT, loadState: async () => threeContacts() });
    await cmds.run({ body: '/status', chatId: '!self', surface: 'whatsapp' });
    expect(sent[0].text).toMatch(/chrome: off/);
  });

  it('warm: shows size/max from the injected warmStats seam', async () => {
    const { cmds, sent } = harness({
      io: HEALTHY_IO, gitOut: HEALTHY_GIT, loadState: async () => threeContacts(),
      warmStats: () => ({ size: 3, max: 6, keys: ['a', 'b', 'c'] }),
    });
    await cmds.run({ body: '/status', chatId: '!self', surface: 'whatsapp' });
    expect(sent[0].text).toMatch(/warm: 3\/6/);
    // warm keys (conversation slugs) are never surfaced — only the count
    expect(sent[0].text).not.toContain('a, b, c');
  });

  it('warm: omitted when warmStats returns null (default seam)', async () => {
    const { cmds, sent } = harness({ io: HEALTHY_IO, gitOut: HEALTHY_GIT, loadState: async () => threeContacts() });
    await cmds.run({ body: '/status', chatId: '!self', surface: 'whatsapp' });
    expect(sent[0].text).not.toMatch(/warm:/);
  });

  it('shell: connected / none from the injected shellConnected seam', async () => {
    const up = harness({ io: HEALTHY_IO, gitOut: HEALTHY_GIT, loadState: async () => threeContacts(), shellConnected: () => true });
    await up.cmds.run({ body: '/status', chatId: '!self', surface: 'whatsapp' });
    expect(up.sent[0].text).toMatch(/shell: connected/);

    const down = harness({ io: HEALTHY_IO, gitOut: HEALTHY_GIT, loadState: async () => threeContacts() });
    await down.cmds.run({ body: '/status', chatId: '!self', surface: 'whatsapp' });
    expect(down.sent[0].text).toMatch(/shell: none/);
  });

  // Reproduce-first for the never-throw discipline: every new seam is fed a throwing
  // (or lying) fake and /status must still reply exactly once, degraded.
  it('never throws when cdp.isRunning/listTabs, warmStats, and shellConnected all throw', async () => {
    const cdp = {
      isRunning: async () => { throw new Error('cdp down'); },
      listTabs: async () => { throw new Error('cdp down'); },
    };
    const { cmds, sent } = harness({
      io: HEALTHY_IO, gitOut: HEALTHY_GIT, loadState: async () => threeContacts(),
      cdp,
      warmStats: () => { throw new Error('pool blew up'); },
      shellConnected: () => { throw new Error('shell port blew up'); },
    });

    await expect(cmds.run({ body: '/status', chatId: '!self', surface: 'whatsapp' })).resolves.toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/chrome: off/);
    expect(sent[0].text).toMatch(/shell: none/);
    expect(sent[0].text).not.toMatch(/warm:/);
  });

  it('never throws when cdp.isRunning reports up but listTabs throws', async () => {
    const cdp = { isRunning: async () => true, listTabs: async () => { throw new Error('json fetch failed'); } };
    const { cmds, sent } = harness({ io: HEALTHY_IO, gitOut: HEALTHY_GIT, loadState: async () => threeContacts(), cdp });
    await expect(cmds.run({ body: '/status', chatId: '!self', surface: 'whatsapp' })).resolves.toBeUndefined();
    expect(sent[0].text).toMatch(/chrome: up · 0 brain tabs/);
  });
});

// `/status <node>` — the NODE-FIRST gate (operator ruling 2026-07-25): "since '/status'
// alone is replied by a spine, '/status <node_name>' is a special case so that only that
// node replies... operator can change <slug> if it conflicts with <node_name>".
//
// Same wake-word mechanism /chrome <node> already uses (ownNodeNamesOf = node_name ∪
// node_alias, non-match silent). The anti-flood assertion is the PEER case: `/status do`
// typed on kg must produce NOTHING — before this gate kg ran the conversation-fragment
// search for "do", hit 9 matches, and emitted the ambiguity reply that seeded the
// 2026-07-25 two-node message flood.
describe('/status <node> — node-first gate', () => {
  const HEALTHY_IO = { stat: async () => ({ mtimeMs: Date.now() }), readFile: async () => READONLY_YAML };
  const HEALTHY_GIT = (args) => (args.includes('--short') ? 'abc1234' : 's');
  const KG = { whatsapp: { chat_id: '!self' }, node_name: 'kg', account_peers: ['kg', 'do'] };
  const self = { chatId: '!self', surface: 'whatsapp' };

  // Contacts whose slugs all contain "do" — the live shape that made `/status do`
  // ambiguous on the peer node. Plus one unrelated chat for the fragment regression.
  function doAmbiguousContacts() {
    let st = emptyState();
    for (const [jid, name] of [['!dolly:beeper.local', 'dolly'], ['!dondi:beeper.local', 'dondi'], ['!doctor:beeper.local', 'doctor'], ['!hfm:beeper.local', 'HFM']]) {
      st = ensureContact(st, 'whatsapp', jid, { pushedName: name, slugHint: name }).state;
    }
    return st;
  }

  it('/status kg on the kg node answers with the NODE-HEALTH payload (not a conversation search)', async () => {
    const { cmds, sent } = harness({ io: HEALTHY_IO, gitOut: HEALTHY_GIT, loadState: async () => doAmbiguousContacts(), getConfig: () => KG });
    await cmds.run({ ...self, body: '/status kg' });
    expect(sent).toHaveLength(1);
    const { text } = sent[0];
    expect(text).toContain(`pid: ${process.pid}`);      // the node-health payload
    expect(text).toMatch(/node_name: kg/);
    expect(text).toMatch(/heartbeats: 2/);
    expect(text).not.toMatch(/conversation_path:/);      // NOT the per-conversation report
    expect(text).not.toMatch(/no chat matches/);
  });

  // THE ANTI-FLOOD ASSERTION. kg must not answer a question addressed to do — and must
  // NOT fall through to the fragment search either (that is what emitted the ambiguity
  // reply the sibling node then parsed as a command).
  it('/status do on the kg node replies NOTHING AT ALL — no answer, no "unknown node", no fragment search', async () => {
    const { cmds, sent } = harness({ io: HEALTHY_IO, gitOut: HEALTHY_GIT, loadState: async () => doAmbiguousContacts(), getConfig: () => KG });
    await cmds.run({ ...self, body: '/status do' });
    expect(sent).toHaveLength(0);
  });

  it('/status do on the do node answers with the node-health payload (exactly one node replies)', async () => {
    const cfg = { whatsapp: { chat_id: '!self' }, node_name: 'do', account_peers: ['kg', 'do'] };
    const { cmds, sent } = harness({ io: HEALTHY_IO, gitOut: HEALTHY_GIT, loadState: async () => doAmbiguousContacts(), getConfig: () => cfg });
    await cmds.run({ ...self, body: '/status do' });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain(`pid: ${process.pid}`);
    expect(sent[0].text).toMatch(/node_name: do/);
  });

  it('a node_alias answers like the node name (ownNodeNamesOf covers aliases)', async () => {
    const cfg = { ...KG, node_alias: ['reve'] };
    const { cmds, sent } = harness({ io: HEALTHY_IO, gitOut: HEALTHY_GIT, loadState: async () => doAmbiguousContacts(), getConfig: () => cfg });
    await cmds.run({ ...self, body: '/status reve' });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain(`pid: ${process.pid}`);
    expect(sent[0].text).toMatch(/node_name: kg/);
  });

  it('the node match is case-insensitive (same as /chrome)', async () => {
    const { cmds, sent } = harness({ io: HEALTHY_IO, gitOut: HEALTHY_GIT, loadState: async () => doAmbiguousContacts(), getConfig: () => KG });
    await cmds.run({ ...self, body: '/status KG' });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain(`pid: ${process.pid}`);
  });

  // Precedence is NODE-FIRST per the ruling ("operator can change <slug> if it conflicts
  // with <node_name>") — a colliding slug is the operator's to rename; no disambiguation.
  it('node-first precedence: a conversation slug colliding with this node\'s name loses to the node', async () => {
    let st = emptyState();
    st = ensureContact(st, 'whatsapp', '!kg:beeper.local', { pushedName: 'kg', slugHint: 'kg' }).state;
    const { cmds, sent } = harness({ io: HEALTHY_IO, gitOut: HEALTHY_GIT, loadState: async () => st, getConfig: () => KG });
    await cmds.run({ ...self, body: '/status kg' });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain(`pid: ${process.pid}`);
    expect(sent[0].text).not.toMatch(/conversation_path:/);
  });

  // REGRESSION: an ordinary fragment is untouched — the conversation path still resolves
  // exactly as today, on a node that HAS a node identity configured.
  it('/status <ordinary fragment> still resolves a conversation exactly as today', async () => {
    const { cmds, sent } = harness({
      loadState: async () => doAmbiguousContacts(),
      getConfig: () => KG,
      io: { readFile: readFileBySuffix({ 'transcript.md': new Error('ENOENT'), 'heartbeats.readonly.yaml': new Error('no readonly file') }) },
    });
    await cmds.run({ ...self, body: '/status hfm' });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/name: HFM/);
    expect(sent[0].text).toMatch(/conversation_path: /);
  });

  // REGRESSION: a SOLO node (no node identity at all) is byte-identical to today — the
  // gate can only fire on a configured node name/alias/peer.
  it('a node with no node_name/account_peers falls through to the fragment path unchanged', async () => {
    const { cmds, sent } = harness({ io: HEALTHY_IO, gitOut: HEALTHY_GIT, loadState: async () => doAmbiguousContacts() });
    await cmds.run({ ...self, body: '/status do' });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/^`\/status`: "do" matches 3:/);
  });

  // REGRESSION: bare /status is UNCHANGED — both nodes answer, node payload as today.
  it('bare /status is unchanged on a node with a node identity (both nodes still answer)', async () => {
    const { cmds, sent } = harness({ io: HEALTHY_IO, gitOut: HEALTHY_GIT, loadState: async () => doAmbiguousContacts(), getConfig: () => KG });
    await cmds.run({ ...self, body: '/status' });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain(`pid: ${process.pid}`);
    expect(sent[0].text).toMatch(/node_name: kg/);
    expect(sent[0].text).toMatch(/peers: \[kg, do\]/);
  });
});

// ── /status GAINS PROVENANCE + THREAD SIZE + THE WARM VIEW (operator 2026-07-26) ────
// Three additions, one command:
//  1. RUNG ATTRIBUTION. Every value the config resolver hands out carries `source:` (the
//     profile-relative file it was read from). /status filtered on it and never showed it.
//  2. THREAD SIZE. "show the live context size of the thread and its compaction threshold".
//  3. THE WARM POOL. "must show active threads kept warm, info about them, size from total".
describe('/status — rung attribution, thread size, and the warm pool', () => {
  const CFG = {
    whatsapp: { chat_id: '!self' },
    node_name: 'kg',
    transcription_service: { enabled: true, use_config: 'reve', reve: { fallback_order: ['cli'], cli: { type: 'whisper-cli', command: '/bin/whisper' } } },
    compaction: { ratio: 0.20 },
  };

  const statusOf = async (over = {}) => {
    const { cmds, sent } = harness({
      getConfig: () => CFG,
      io: { stat: async () => ({ mtimeMs: Date.now() }), readFile: readFileBySuffix({ 'transcript.md': new Error('none'), 'heartbeats.readonly.yaml': READONLY_YAML }) },
      gitOut: () => 'abc1234',
      loadState: async () => threeContacts(),
      ...over,
    });
    await cmds.run({ body: '/status', chatId: '!self', surface: 'whatsapp' });
    return sent.at(-1)?.text ?? '';
  };

  it('names the FILE each node-rung value came from', async () => {
    const text = await statusOf();
    // the resolver's node rung is config/config.yaml — /status says so instead of
    // leaving the operator to guess which of the three files set it
    expect(text).toContain('config: config/config.yaml');
  });

  it('reads the heartbeat aggregate from the PROFILE ROOT, never state/', async () => {
    const seen = [];
    await statusOf({
      io: {
        stat: async () => ({ mtimeMs: Date.now() }),
        readFile: async (p) => { seen.push(String(p)); if (String(p).endsWith('heartbeats.readonly.yaml')) return READONLY_YAML; throw new Error('none'); },
      },
    });
    const hb = seen.find((p) => p.endsWith('heartbeats.readonly.yaml'));
    expect(hb).toBeTruthy();
    expect(hb).not.toMatch(/[\/]state[\/]heartbeats\.readonly\.yaml$/);
  });

  it('shows the warm pool as size/max with a line per live entry: tokens, the fraction of the window, and the compaction threshold', async () => {
    // The warm key is derived the way compactionTargets derives it — `<being>:<engine>:
    // <surface>:<slug>`, engine falling back to ccode until the thread is instanced — so
    // this locks that /status joins on the SAME key the pool is actually holding.
    let st = threeContacts();
    st = recordThread(st, 'whatsapp', '!fam:beeper.local', 'sid-fam', undefined, 'egpt');
    const slug = getContact(st, 'whatsapp', '!fam:beeper.local').slug;
    const key = `egpt:ccode:whatsapp:${slug}`;
    const text = await statusOf({
      warmStats: () => ({ size: 2, max: 6, keys: [key, 'sib:wren:sid-w'] }),
      loadState: async () => st,
      dueFor: (t) => (t.sessionId === 'sid-fam' ? { due: false, tokens: 50_000, threshold: 200_000 } : { due: false }),
    });
    expect(text).toContain('warm: 2/6');
    // "size from total" — the tokens AND what they are a fraction of
    expect(text).toMatch(new RegExp(`${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: 50000/200000 tok \\(25% of compact\\)`));
    // a key the pool holds but nothing can measure still LISTS — never dropped silently
    expect(text).toContain('sib:wren:sid-w:');
  });

  it('a warm key with no measurable session still lists, marked — the pool view never lies by omission', async () => {
    const text = await statusOf({
      warmStats: () => ({ size: 1, max: 6, keys: ['egpt:ccode:whatsapp/ghost'] }),
      dueFor: () => ({ due: false }),
    });
    expect(text).toContain('warm: 1/6');
    expect(text).toContain('egpt:ccode:whatsapp/ghost');
  });

  it('/status <fragment> shows the thread context size against the REAL threshold the spine applies', async () => {
    let st = threeContacts();
    st = recordThread(st, 'whatsapp', '!hfm:beeper.local', 'sid-hfm', undefined, 'e');
    const { cmds, sent } = harness({
      getConfig: () => CFG,
      io: { stat: async () => ({ mtimeMs: Date.now() }), readFile: readFileBySuffix({ 'transcript.md': new Error('none'), 'heartbeats.readonly.yaml': READONLY_YAML }) },
      gitOut: () => 'abc1234',
      loadState: async () => st,
      dueFor: (target, opts) => {
        // the ratio /status hands down must be the one the SPINE applies (compaction.ratio
        // = 0.20), NOT compact-being's own 0.25 default parameter
        expect(opts.ratio).toBe(0.20);
        return { due: false, tokens: 12_345, threshold: 200_000 };
      },
    });
    await cmds.run({ body: '/status HFM', chatId: '!self', surface: 'whatsapp' });
    const text = sent.at(-1)?.text ?? '';
    expect(text).toMatch(/context: 12345\/200000/);
  });

  it('/status <fragment> on a thread that never started says so instead of faking a size', async () => {
    const { cmds, sent } = harness({
      getConfig: () => CFG,
      io: { stat: async () => ({ mtimeMs: Date.now() }), readFile: readFileBySuffix({ 'transcript.md': new Error('none'), 'heartbeats.readonly.yaml': READONLY_YAML }) },
      gitOut: () => 'abc1234',
      loadState: async () => threeContacts(),
      dueFor: () => { throw new Error('must not be called for a thread that never started'); },
    });
    await cmds.run({ body: '/status HFM', chatId: '!self', surface: 'whatsapp' });
    expect(sent.at(-1).text).toContain('thread_id: not started');
    expect(sent.at(-1).text).not.toContain('context:');
  });
});
