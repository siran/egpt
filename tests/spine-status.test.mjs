// /status — node health from the operator's chat. One compact message with live
// process-local liveness (pid/uptime), the git version, the alive-beat age, the
// heartbeat count, and the conversation count. Every probe degrades to '?' so the
// command NEVER throws. (Its own file: spine-commands.test.mjs is being edited by
// another agent — avoid the same-file race.)
import { describe, it, expect } from 'vitest';
import { createCommands } from '../src/spine/commands.mjs';
import { emptyState, ensureContact } from '../conversations-state.mjs';

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

function harness({ io, gitOut, loadState } = {}) {
  const sent = [];
  const cmds = createCommands({
    getConfig: () => ({ whatsapp: { chat_id: '!self' } }),
    send: async (chatId, text) => sent.push({ chatId, text }),
    exit: () => {},
    loadState,
    io,
    gitOut,
  });
  return { cmds, sent };
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
    expect(text).toContain(String(process.pid));
    expect(text).toContain('abc1234');
    expect(text).toContain('spine /status ops line');
    expect(text).toMatch(/2 heartbeats/);
    expect(text).toMatch(/2 conversations/);
    expect(text).toMatch(/beat \d+s ago/);
    // one message = a single \n-joined block, no extra sends
    expect(text.split('\n')).toHaveLength(2);
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
    expect(text).toContain(String(process.pid));       // pid always available
    expect(text).toContain('egpt ?');                  // sha degraded
    expect(text).toMatch(/beat \? ago/);               // beat age degraded
    expect(text).toMatch(/\? heartbeats/);             // heartbeat count degraded
    expect(text).toMatch(/\? conversations/);          // conversation count degraded
  });

  it('never throws even when loadState itself throws', async () => {
    const { cmds, sent } = harness({
      io: { stat: async () => ({ mtimeMs: Date.now() }), readFile: async () => READONLY_YAML },
      gitOut: (args) => (args.includes('--short') ? 'deadbee' : 'subj'),
      loadState: async () => { throw new Error('state read blew up'); },
    });

    await expect(cmds.run({ body: '/status', chatId: '!self', surface: 'whatsapp' })).resolves.toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/\? conversations/);
  });

  it('includes this chat\'s E mode when the contact has one set', async () => {
    let st = ensureContact(emptyState(), 'whatsapp', '!fam:beeper.local', { pushedName: 'fam', slugHint: 'fam' }).state;
    st = { ...st, contacts: { whatsapp: { '!fam:beeper.local': { ...st.contacts.whatsapp['!fam:beeper.local'], mode: 'mute' } } } };
    const { cmds, sent } = harness({
      io: { stat: async () => ({ mtimeMs: Date.now() }), readFile: async () => READONLY_YAML },
      gitOut: (args) => (args.includes('--short') ? 'abc1234' : 's'),
      loadState: async () => st,
    });

    await cmds.run({ body: '/status', chatId: '!fam:beeper.local', surface: 'whatsapp' });
    expect(sent[0].text).toMatch(/mode mute/);
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
