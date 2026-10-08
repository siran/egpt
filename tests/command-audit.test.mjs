// tests/command-audit.test.mjs — the per-command audit → log_to_group (operator 2026-10-08).
//
// THE MOTIVATING CASE: the operator typed /end in a plain group ("conversas con favel") and NOTHING
// happened — end() returns SILENTLY when the chat is neither a /join alias nor a /split parent, and
// posts nothing on a successful archive either. The ruling: notify on the no-op; notify on the
// archive; notify on EVERY '/'-command outcome. The audit is emitted from the ONE dispatch chokepoint
// (commands.mjs run()), METADATA ONLY — "/<cmd> in <chat> by <sender> → <outcome?>" — and NEVER any
// part of the reply body, through an injected fail-closed sink (boot wires it to config.log_to_group).
//
// The sink here is a FAKE that records the posted lines. State is in-memory. No real Beeper call.
import { describe, it, expect, vi } from 'vitest';

// egpt-home.mjs freezes EGPT_HOME at module load (conversations-state reads it), so set it BEFORE the
// imports — vi.hoisted does that. A private temp profile, never ~/.egpt.
vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  process.env.EGPT_HOME = `${tmp}/egpt-command-audit-home`;
});
import { createCommands } from '../src/spine/commands.mjs';
import { ensureContact, getContact, aliasContact, patchContact } from '../src/conversations-state.mjs';

const C_CHAT = '!chatC';
const JOIN_CHAT = '!chatJoin';
const SPLIT_CHAT = '!chatSplit';
const CFG = { node_name: 'kg' };

function seedC() { return ensureContact({ contacts: {} }, 'whatsapp', C_CHAT, { pushedName: 'conversas con favel' }).state; }
function stateWithJoin() {
  const st = seedC();
  return aliasContact(st, 'whatsapp', JOIN_CHAT, getContact(st, 'whatsapp', C_CHAT).jid);
}
function stateWithSplit() {
  let st = seedC();
  st = ensureContact(st, 'whatsapp', SPLIT_CHAT, { pushedName: 'split of favel' }).state;
  return patchContact(st, 'whatsapp', SPLIT_CHAT, { parent_chat: C_CHAT });
}

// A createCommands wired with a fake forkBridge (records archives only) and a fake audit sink.
function harness({ config = CFG, state, logToGroup, backlogOf } = {}) {
  let st = state ?? seedC();
  const sent = [];
  const audit = [];
  const calls = { archive: [] };
  const forkBridge = {
    editMessage: async () => true,
    createGroup: async () => null,
    postReply: async () => ({ ok: true }),
    archiveChat: async (chatId) => { calls.archive.push({ chatId }); return true; },
    chatAccountId: async () => 'whatsapp',
    chatTitle: async () => null,
    resolveUserIdByPhone: async () => null,
    resolveSecondaryChatIdByTitle: async () => null,
  };
  const cmds = createCommands({
    getConfig: () => config,
    send: async (chatId, text) => sent.push({ chatId, text }),
    loadState: async () => st,
    writeState: async (s) => { st = s; },
    resolveConvRoom: async () => null,
    defaultKey: 'e',
    forkBridge,
    ...(backlogOf ? { backlogOf } : {}),
    logToGroup: logToGroup ?? (async (text) => { audit.push(text); return true; }),
    onLog: () => {},
  });
  return { cmds, sent, audit, calls, getState: () => st };
}

// A canonical operator ev (slash command typed in a chat).
const ev = (chatId, body, chatName) => ({ chatId, surface: 'whatsapp', msgId: 'm1', chatName, senderName: 'An', body });

describe('/end audit — the motivating case', () => {
  it('/end in a PLAIN group (no /join alias, no /split parent): the chat gets NOTHING, the log group gets a "no-op" audit line', async () => {
    const { cmds, sent, audit, calls } = harness({ state: seedC() });
    await cmds.run(ev(C_CHAT, '/end', 'conversas con favel'));
    expect(calls.archive).toHaveLength(0);                 // nothing archived
    expect(sent).toHaveLength(0);                          // the chat itself still gets nothing (unchanged)
    expect(audit).toHaveLength(1);                         // but the no-op is now VISIBLE in the log group
    expect(audit[0]).toBe('/end in conversas con favel by An → no-op — not a /join or /split side channel');
  });

  it('/end in a /join alias group: archives AND posts an "archived" audit line', async () => {
    const { cmds, sent, audit, calls } = harness({ state: stateWithJoin() });
    await cmds.run(ev(JOIN_CHAT, '/end', 'favel (mirror)'));
    expect(calls.archive).toEqual([{ chatId: JOIN_CHAT }]);
    expect(sent).toHaveLength(0);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toBe('/end in favel (mirror) by An → archived favel (mirror)');
  });

  it('/end in a /split parent group: archives AND posts an "archived" audit line', async () => {
    const { cmds, audit, calls } = harness({ state: stateWithSplit() });
    await cmds.run(ev(SPLIT_CHAT, '/end', 'split of favel'));
    expect(calls.archive).toEqual([{ chatId: SPLIT_CHAT }]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toContain('→ archived');
  });
});

describe('the audit is METADATA ONLY — a reply body can never leak into the log group', () => {
  it('/recap (a sensitive/large reply) posts an audit line with NO part of the reply body', async () => {
    const SECRET = 'SECRET-BACKLOG-BODY-xyz';
    const { cmds, sent, audit } = harness({ backlogOf: () => [{ sender: 'Alice', ts: 0, body: SECRET }] });
    await cmds.run(ev(C_CHAT, '/recap', 'conversas con favel'));
    // the reply (with the sensitive body) went to the CHAT …
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain(SECRET);
    // … and the audit got ONLY the invocation line — no outcome, no body, ever
    expect(audit).toEqual(['/recap in conversas con favel by An']);
    expect(audit[0]).not.toContain(SECRET);
  });
});

describe('the audit is fail-closed — it never changes a command', () => {
  it('log_to_group OFF (the sink returns false): /end still archives and still posts nothing to the chat', async () => {
    const { cmds, sent, calls } = harness({ state: stateWithJoin(), logToGroup: async () => false });
    await cmds.run(ev(JOIN_CHAT, '/end', 'favel'));
    expect(calls.archive).toEqual([{ chatId: JOIN_CHAT }]);   // behavior byte-identical to today
    expect(sent).toHaveLength(0);
  });

  it('a THROWING sink is swallowed — the command still runs to completion', async () => {
    const { cmds, calls } = harness({ state: stateWithJoin(), logToGroup: async () => { throw new Error('beeper down'); } });
    await expect(cmds.run(ev(JOIN_CHAT, '/end', 'favel'))).resolves.toBeUndefined();
    expect(calls.archive).toEqual([{ chatId: JOIN_CHAT }]);
  });
});

describe('what is NOT audited', () => {
  it('a non-"/"-message (reaches the catch-all) is never audited', async () => {
    const { cmds, sent, audit } = harness({ state: seedC() });
    await cmds.run(ev(C_CHAT, 'hola, como estas', 'conversas con favel'));
    expect(audit).toHaveLength(0);                           // not a '/'-command → no audit
    expect(sent).toHaveLength(1);                            // (the catch-all still replied, unchanged)
  });

  it('a command addressed to ANOTHER co-account node (/status=do) is NOT audited here — it audits there', async () => {
    const { cmds, audit, sent } = harness({ state: seedC() });
    await cmds.run(ev(C_CHAT, '/status=do', 'conversas con favel'));
    expect(audit).toHaveLength(0);                           // the node gate stands this node down silently, with no audit
    expect(sent).toHaveLength(0);
  });
});
