// tests/command-audit-merge.test.mjs — the TWO-NODE audit convergence (operator 2026-10-08).
//
// eGPT runs as two co-account spines (node_role primary=kg, secondary=do) that ingest ONE Beeper
// account. Most commands are deduped to one node, but /join, /split, /status <sibling> and /end in a
// one-node side-room are picked by node_role / statusNodeGate instead, so BOTH nodes audit the same
// command EVENT and posted TWO lines to log_to_group. audit-merge.mjs converges them onto ONE message:
// the primary posts (read-free) with a marker derived from ev.msgHash, the secondary staggers, reads
// log_to_group for that marker and EDITS the primary's line — or posts its own when it is alone.
//
// Both nodes' audit calls are modeled against a SHARED FAKE log_to_group chat. The stagger `delay` is
// a no-op so the suite does not wait; production threads the real ~1.5s const (audit-merge.mjs).
import { describe, it, expect } from 'vitest';
import { mergeAudit, auditMarker, AUDIT_STAGGER_MS } from '../src/spine/audit-merge.mjs';

const KEY = 'a'.repeat(64);             // a 64-hex ev.msgHash (crossAccountMsgKey), identical on both nodes
const MARKER = auditMarker(KEY);
const noWait = () => Promise.resolve();  // the secondary's stagger, instant in tests

// A shared fake log_to_group chat both nodes' ops act on. readRecent returns markdown text (the shape
// boot's reader hands mergeAudit after htmlToMarkdown). Ids are assigned on post, as Beeper does.
function fakeChat() {
  let seq = 0;
  const messages = [];
  return {
    messages,
    post: async (text) => { messages.push({ id: `m${++seq}`, text }); return true; },
    readRecent: async () => messages.map((m) => ({ id: m.id, text: m.text })),
    edit: async (id, text) => { const m = messages.find((x) => x.id === id); if (!m) return false; m.text = text; return true; },
  };
}
// One node's audit call against a chat, with an injectable delay.
const audit = (chat, { role, node, text, key = KEY, delay = noWait, ...over }) =>
  mergeAudit({ role, nodeLabel: node, text, key, post: chat.post, readRecent: chat.readRecent, edit: chat.edit, delay, ...over });

describe('two nodes audit the SAME command event → ONE message, both segments', () => {
  it('primary posts, secondary (staggered) finds the marker and EDITS → one message carrying kg AND do', async () => {
    const chat = fakeChat();
    // /end typed in a side-room that exists on only one node: the two nodes reach different outcomes.
    await audit(chat, { role: 'primary',   node: 'kg', text: '/end in favel (mirror) by An → archived favel (mirror)' });
    await audit(chat, { role: 'secondary', node: 'do', text: '/end in conversas con favel by An → no-op — not a /join or /split side channel' });
    expect(chat.messages).toHaveLength(1);                      // converged, not two lines
    const only = chat.messages[0].text;
    expect(only).toContain('kg: /end in favel (mirror) by An → archived favel (mirror)');
    expect(only).toContain('do: /end in conversas con favel by An → no-op');
    expect(only).toContain(MARKER);                             // the marker survives on the first line
  });
});

describe('primary-only audit → one message, primary segment, no edit', () => {
  it('a command only the primary audits: one labeled+marked line, nothing edited', async () => {
    const chat = fakeChat();
    await audit(chat, { role: 'primary', node: 'kg', text: '/tab in RoomA by An' });
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0].text).toBe(`kg: /tab in RoomA by An ${MARKER}`);
    expect(chat.messages[0].text).not.toContain('do:');
  });
});

describe('secondary-only audit (no primary post found) → secondary posts one message', () => {
  it('the secondary is the sole auditor: it reads, finds no marker, and posts its own line', async () => {
    const chat = fakeChat();
    await audit(chat, { role: 'secondary', node: 'do', text: '/status=do in RoomA by An' });
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0].text).toBe(`do: /status=do in RoomA by An ${MARKER}`);
  });

  it('a DIFFERENT command event (different key) is never merged into the primary\'s unrelated line', async () => {
    const chat = fakeChat();
    await audit(chat, { role: 'primary',   node: 'kg', text: '/join in RoomA by An', key: 'b'.repeat(64) });
    await audit(chat, { role: 'secondary', node: 'do', text: '/status=do in RoomB by An', key: KEY });
    expect(chat.messages).toHaveLength(2);                      // two events, two messages — no false merge
    expect(chat.messages[1].text).toBe(`do: /status=do in RoomB by An ${MARKER}`);
  });
});

describe('fail-closed — a broken read/edit never loses the audit and never throws', () => {
  it('readRecent throws → the secondary falls back to a plain post, no throw', async () => {
    const chat = fakeChat();
    await chat.post(`kg: /end … ${MARKER}`);                    // the primary already posted
    const result = await mergeAudit({
      role: 'secondary', nodeLabel: 'do', text: '/end in favel by An → no-op', key: KEY,
      post: chat.post, readRecent: async () => { throw new Error('beeper down'); }, edit: chat.edit, delay: noWait,
    });
    expect(result).toBe(true);
    expect(chat.messages).toHaveLength(2);                      // the primary's line + the secondary's fallback line
    expect(chat.messages[1].text).toBe(`do: /end in favel by An → no-op ${MARKER}`);
  });

  it('edit throws → the secondary falls back to a plain post rather than drop its segment', async () => {
    const chat = fakeChat();
    await audit(chat, { role: 'primary', node: 'kg', text: '/end in favel by An → archived favel' });
    const result = await mergeAudit({
      role: 'secondary', nodeLabel: 'do', text: '/end in favel by An → no-op', key: KEY,
      post: chat.post, readRecent: chat.readRecent, edit: async () => { throw new Error('edit rejected'); }, delay: noWait,
    });
    expect(result).toBe(true);
    expect(chat.messages).toHaveLength(2);
    expect(chat.messages[1].text).toContain('do: /end in favel by An → no-op');
  });

  it('a missing reader/editor (not a secondary bridge) → the secondary just posts its own labeled line', async () => {
    const chat = fakeChat();
    const result = await mergeAudit({ role: 'secondary', nodeLabel: 'do', text: '/tab in RoomA by An', key: KEY, post: chat.post, delay: noWait });
    expect(result).toBe(true);
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0].text).toBe(`do: /tab in RoomA by An ${MARKER}`);
  });
});

describe('single-node deployment / no key → today\'s plain post, byte-identical', () => {
  it('node_role unset: the line is posted plain — no node label, no marker', async () => {
    const chat = fakeChat();
    await audit(chat, { role: undefined, node: 'kg', text: '/end in favel by An → no-op' });
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0].text).toBe('/end in favel by An → no-op');   // exactly the pre-convergence format
  });

  it('a co-account node but a synthetic with NO msgHash (key null): plain post, cannot converge', async () => {
    const chat = fakeChat();
    await audit(chat, { role: 'primary', node: 'kg', text: '/end in favel by An → no-op', key: null });
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0].text).toBe('/end in favel by An → no-op');
  });
});

describe('the marker + the stagger const', () => {
  it('the marker is a compact ⟦<10 hex>⟧ prefix of ev.msgHash, and null without a key', () => {
    expect(MARKER).toBe('⟦aaaaaaaaaa⟧');
    expect(auditMarker('')).toBeNull();
    expect(auditMarker(null)).toBeNull();
  });
  it('the secondary staggers by the module const (~1.5s) before reading', () => {
    expect(AUDIT_STAGGER_MS).toBe(1500);
  });
});
