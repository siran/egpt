// /status — node health from the operator's chat. One compact message with live
// process-local liveness (pid/uptime), the git version, the alive-beat age, the
// heartbeat count, and the conversation count. Every probe degrades to '?' so the
// command NEVER throws. (Its own file: spine-commands.test.mjs is being edited by
// another agent — avoid the same-file race.)
import { describe, it, expect } from 'vitest';
import { createCommands } from '../src/spine/commands.mjs';
import { emptyState, ensureContact, patchContact, recordThread, slugDir } from '../conversations-state.mjs';

// A readonly.yaml with two heartbeat entries (the shape heartbeat-loader writes).
const READONLY_YAML = `heartbeats:
  - name: alive
    source: config
    frequency: 60s
    frequency_ms: 60000
    action: 'command: echo beat > state/alive.txt'
    cwd: /home/x/.egpt2
  - name: whatsapp/fam:daily
    source: /home/x/.egpt2/conversations/whatsapp/fam
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

function harness({ io, gitOut, loadState, brains, getConfig, onLog } = {}) {
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
    st = { ...st, contacts: { whatsapp: { '!fam:beeper.local': { ...st.contacts.whatsapp['!fam:beeper.local'], e: { mode: 'mute' } } } } };   // persona mode is nested now (operator 2026-07-10)
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
// resolved exactly like /e auto's (same resolveTarget), one fenced yaml block with
// name/surface/slug/conversation_path/mode/agent/personality/thread/members.
describe('/status <target>', () => {
  const NO_HEARTBEATS = new Error('no readonly file');
  const NO_TRANSCRIPT = new Error('ENOENT');

  it('/status: conversation state not wired (loadState absent)', async () => {
    const { cmds, sent } = harness({});
    await cmds.run({ body: '/status hfm', chatId: '!self', surface: 'whatsapp' });
    expect(sent[0].text).toMatch(/conversation state not wired/);
  });

  it('reports no match exactly like /e auto (resolveTarget) — no state read failure either', async () => {
    const { cmds, sent } = harness({ loadState: async () => emptyState() });
    await cmds.run({ body: '/status zzz', chatId: '!self', surface: 'whatsapp' });
    expect(sent[0].text).toMatch(/^\/status: no chat matches "zzz"/);
  });

  it('a NEVER-STARTED conversation with NO brains registry: default preview falls back to the deterministic constants, marked `instanced: false`', async () => {
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
    expect(text).toMatch(/instanced: false/);
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

  it('a NEVER-STARTED conversation WITH a brains registry: previews the resolved default type\'s model/effort/tools/personality', async () => {
    const { state: created } = ensureContact(emptyState(), 'whatsapp', '!hfm:beeper.local', { pushedName: 'HFM', slugHint: 'HFM' });
    const brains = { resolve: (name) => (name === 'egpt' ? { name: 'egpt', type: 'ccode', model: 'opus', effort: 'low', allowed_tools: ['Read'], personality: 'poet' } : null) };
    const { cmds, sent } = harness({
      loadState: async () => created,
      brains,
      io: { readFile: readFileBySuffix({ 'transcript.md': NO_TRANSCRIPT, 'heartbeats.readonly.yaml': NO_HEARTBEATS }) },
    });

    await cmds.run({ body: '/status hfm', chatId: '!self', surface: 'whatsapp' });
    const { text } = sent[0];
    expect(text).toMatch(/instanced: false/);
    expect(text).toMatch(/agent: egpt/);
    expect(text).toMatch(/engine: ccode/);
    expect(text).toMatch(/model: opus/);
    expect(text).toMatch(/effort: low/);
    expect(text).toMatch(/allowed_tools: \[Read\]/);
    expect(text).toMatch(/personality: poet/);
    expect(text).toMatch(/thread_id: not started/);
  });

  it('an INSTANCED conversation: frozen agent/model/effort/allowed_tools, personality resolved via the brains registry, thread id, and members from the transcript tail', async () => {
    const first = ensureContact(emptyState(), 'whatsapp', '!hfm:beeper.local', { pushedName: 'HFM', slugHint: 'HFM' });
    const slug = first.slug;
    // instanced brain + mode + thread in the persona's NESTED block (operator 2026-07-10)
    let state = patchContact(first.state, 'whatsapp', '!hfm:beeper.local', {
      e: { mode: 'on', readonly: { agent: 'sonnet-high', type: 'ccode', model: 'opus', effort: 'high', allowed_tools: ['Read'] } },
    });
    state = recordThread(state, 'whatsapp', '!hfm:beeper.local', 'THREAD-1', undefined, 'e');
    const transcript = [
      'An@[HFM].wa (10:00): hola',
      '',
      '[@e (10:01)]: hola An',
      '',
      'Ron@[HFM].wa (10:02): que tal',
      '',
    ].join('\n');
    const brains = { resolve: (name) => (name === 'sonnet-high' ? { name, type: 'ccode', model: 'opus', effort: 'high', personality: 'poet' } : null) };

    const { cmds, sent } = harness({
      loadState: async () => state,
      brains,
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
    expect(text).toMatch(/members: An, @e, Ron/);   // distinct, first-seen order
  });

  it('a resolved type file that omits `personality:` falls back to \'egpt\' (same fallback the brainpool applies)', async () => {
    const first = ensureContact(emptyState(), 'whatsapp', '!hfm:beeper.local', { pushedName: 'HFM', slugHint: 'HFM' });
    let state = patchContact(first.state, 'whatsapp', '!hfm:beeper.local', {
      e: { readonly: { agent: 'egpt', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: 'all' } },
    });
    const brains = { resolve: (name) => (name === 'egpt' ? { name, type: 'ccode', model: 'sonnet', effort: 'high' } : null) };   // no personality field
    const { cmds, sent } = harness({
      loadState: async () => state,
      brains,
      io: { readFile: readFileBySuffix({ 'transcript.md': NO_TRANSCRIPT, 'heartbeats.readonly.yaml': NO_HEARTBEATS }) },
    });

    await cmds.run({ body: '/status hfm', chatId: '!self', surface: 'whatsapp' });
    expect(sent[0].text).toMatch(/personality: egpt/);
    expect(sent[0].text).toMatch(/allowed_tools: all/);
  });

  it('this conversation\'s own heartbeat count is included when trivially available (source pinned to its convDir)', async () => {
    const first = ensureContact(emptyState(), 'whatsapp', '!hfm:beeper.local', { pushedName: 'HFM', slugHint: 'HFM' });
    const convDir = slugDir('whatsapp', first.slug);
    const { cmds, sent } = harness({
      loadState: async () => first.state,
      io: {
        readFile: readFileBySuffix({
          'transcript.md': NO_TRANSCRIPT,
          'heartbeats.readonly.yaml': `heartbeats:\n  - name: whatsapp/hfm:daily\n    source: ${JSON.stringify(convDir)}\n`,
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
