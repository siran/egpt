// tests/room.test.mjs — routing-decision tests for room.mjs.
//
// These exercise the decision tree that lives between parseInput and the
// brain calls: who should run? broadcast or single? auto-open? forward via
// bus? error? Pure inputs in, decision out — no I/O, no Ink, no fetch.

import { describe, it, expect } from 'vitest';
import { parseInput } from '../interpreter.mjs';
import { resolveRoute, planMirrors } from '../room.mjs';

// ── Test fixtures ──────────────────────────────────────────────────────────

// A toy brain registry mirroring the shell's BRAINS shape. The only fields
// resolveRoute looks at are `name` and `urlMatch` (presence of `urlMatch`
// distinguishes CDP brains from local operators).
const BRAINS = {
  'codex':         { name: 'codex' },
  'claude-code':   { name: 'claude-code' },
  'chatgpt-cdp':   { name: 'chatgpt-cdp', urlMatch: /chatgpt\.com/ },
  'claude-cdp':    { name: 'claude-cdp',  urlMatch: /claude\.ai/ },
};
const BRAIN_ALIASES = {
  ccode:   'claude-code',
  cgpt:    'chatgpt-cdp',
  chatgpt: 'chatgpt-cdp',
  claude:  'claude-cdp',
  cla:     'claude-cdp',
};

const canonicalBrainName = (n) => BRAIN_ALIASES[n] ?? n;
const brainForName = (n) => BRAINS[canonicalBrainName(n)] ?? null;

// Helper: build a routing context from arrays so each test stays readable.
function ctx({ sessions = [], peers = [], activeSession = null } = {}) {
  return {
    sessions: new Map(sessions.map(([name, brainName]) => [name, { brainName }])),
    peerSessions: new Map(
      peers.map(([nodeId, list]) => [nodeId, list.map(([n, b]) => ({ name: n, brain: b }))]),
    ),
    brainForName,
    canonicalBrainName,
    activeSession,
  };
}

const route = (text, c) => resolveRoute(parseInput(text), text, c);

// ── Slash commands ─────────────────────────────────────────────────────────

describe('resolveRoute — commands', () => {
  it('returns { kind: "command" } for any /command, regardless of room state', () => {
    expect(route('/save test', ctx())).toEqual({
      kind: 'command', cmd: '/save', rest: 'test',
    });
  });

  it('preserves rest for multi-word arguments', () => {
    expect(route('/profile alex https://chatgpt.com/c/abc', ctx())).toEqual({
      kind: 'command', cmd: '/profile', rest: 'alex https://chatgpt.com/c/abc',
    });
  });
});

// ── Direct mentions to local sessions ──────────────────────────────────────

describe('resolveRoute — direct local @-mention', () => {
  it('routes @<exact-session-name> to that single session', () => {
    expect(route('@codex1 hello', ctx({ sessions: [['codex1', 'codex']] }))).toEqual({
      kind: 'turn', recipients: ['codex1'], payload: 'hello', broadcast: false,
    });
  });

  it('uses "?" as payload when @-mention has no body', () => {
    expect(route('@codex1', ctx({ sessions: [['codex1', 'codex']] }))).toEqual({
      kind: 'turn', recipients: ['codex1'], payload: '?', broadcast: false,
    });
  });

  it('exact name takes priority over brain-alias matching', () => {
    // A session named exactly `codex` exists — that beats the @<alias> path.
    const c = ctx({ sessions: [['codex', 'codex'], ['codex2', 'codex']] });
    expect(route('@codex hi', c)).toEqual({
      kind: 'turn', recipients: ['codex'], payload: 'hi', broadcast: false,
    });
  });
});

// ── Mentions to brain types/aliases ────────────────────────────────────────

describe('resolveRoute — @<brain-type> with no exact session match', () => {
  it('auto-opens a local operator (codex) when no codex session exists', () => {
    expect(route('@codex pwd', ctx())).toEqual({
      kind: 'auto-open', brainName: 'codex', payload: 'pwd', originalToken: 'codex',
    });
  });

  it('resolves alias @ccode to canonical brain claude-code', () => {
    expect(route('@ccode hello', ctx())).toEqual({
      kind: 'auto-open', brainName: 'claude-code', payload: 'hello', originalToken: 'ccode',
    });
  });

  it('routes @chatgpt to its only matching CDP session (single match)', () => {
    expect(route('@chatgpt hi', ctx({ sessions: [['cgpt1', 'chatgpt-cdp']] }))).toEqual({
      kind: 'turn', recipients: ['cgpt1'], payload: 'hi', broadcast: false,
    });
  });

  it('errors as ambiguous when @<cdp-brain> has multiple matching sessions', () => {
    const c = ctx({ sessions: [['cgpt1', 'chatgpt-cdp'], ['cgpt2', 'chatgpt-cdp']] });
    const r = route('@chatgpt hi', c);
    expect(r.kind).toBe('error');
    expect(r.message).toMatch(/ambiguous/);
    expect(r.message).toContain('cgpt1');
    expect(r.message).toContain('cgpt2');
  });

  it('errors with "/open" hint when @<cdp-brain> has no matching sessions', () => {
    const r = route('@chatgpt hi', ctx());
    expect(r.kind).toBe('error');
    expect(r.message).toMatch(/no chatgpt session/);
    expect(r.message).toMatch(/\/open chatgpt/);
  });
});

// ── Peer (zombie) routing ──────────────────────────────────────────────────

describe('resolveRoute — peer @-mention forwarding', () => {
  it('forwards @<remote-session> to the owning peer when exactly one matches', () => {
    const c = ctx({
      sessions: [],
      peers: [['shell-12345', [['codex1', 'codex']]]],
    });
    expect(route('@codex1 hello', c)).toEqual({
      kind: 'peer-mention', target: 'codex1', toNode: 'shell-12345', body: 'hello',
    });
  });

  it('errors as ambiguous when multiple peers own the same session name', () => {
    const c = ctx({
      peers: [
        ['shell-A', [['codex1', 'codex']]],
        ['shell-B', [['codex1', 'codex']]],
      ],
    });
    const r = route('@codex1 hi', c);
    expect(r.kind).toBe('error');
    expect(r.message).toMatch(/ambiguous across peers/);
    expect(r.message).toContain('shell-A');
    expect(r.message).toContain('shell-B');
  });

  it('local match wins over peer match for the same name', () => {
    const c = ctx({
      sessions: [['codex1', 'codex']],
      peers: [['shell-other', [['codex1', 'codex']]]],
    });
    expect(route('@codex1 hi', c)).toEqual({
      kind: 'turn', recipients: ['codex1'], payload: 'hi', broadcast: false,
    });
  });

  it('errors with /sessions hint when nothing matches anywhere', () => {
    const r = route('@nobody hi', ctx());
    expect(r.kind).toBe('error');
    expect(r.message).toMatch(/no participant @nobody/);
    expect(r.message).toMatch(/\/sessions/);
  });
});

// ── Plain message broadcast ────────────────────────────────────────────────

describe('resolveRoute — plain message', () => {
  it('returns { kind: "empty" } when the room has no local sessions', () => {
    expect(route('hello', ctx())).toEqual({ kind: 'empty' });
  });

  it('returns { kind: "idle" } when sessions exist but no activeSession is set', () => {
    // Plain text never auto-routes; user must @-mention or /use first.
    const c = ctx({ sessions: [['codex1', 'codex'], ['cgpt1', 'chatgpt-cdp']] });
    expect(route('hello room', c)).toEqual({ kind: 'idle' });
  });

  it('returns { kind: "idle" } when one session exists but no activeSession is set', () => {
    const c = ctx({ sessions: [['codex1', 'codex']] });
    expect(route('hello', c)).toEqual({ kind: 'idle' });
  });

  it('routes plain text to activeSession when set and present', () => {
    const c = ctx({
      sessions: [['codex1', 'codex'], ['cgpt1', 'chatgpt-cdp']],
      activeSession: 'cgpt1',
    });
    expect(route('hello', c)).toEqual({
      kind: 'turn', recipients: ['cgpt1'], payload: 'hello', broadcast: false,
    });
  });

  it('returns { kind: "idle" } when activeSession is set but not present in sessions', () => {
    const c = ctx({
      sessions: [['cgpt1', 'chatgpt-cdp']],
      activeSession: 'codex1',  // not in sessions — stale /use
    });
    expect(route('hello', c)).toEqual({ kind: 'idle' });
  });

  it('preserves the full text including newlines as the payload when routed', () => {
    const c = ctx({ sessions: [['codex1', 'codex']], activeSession: 'codex1' });
    const r = route('line one\nline two\nline three', c);
    expect(r.payload).toBe('line one\nline two\nline three');
  });
});

// ── Mirror planning (one-hop CDP-to-CDP) ───────────────────────────────────

describe('planMirrors — one-hop CDP mirroring', () => {
  // sessions: name -> { brainName }
  const sessions = new Map([
    ['cgpt1',   { brainName: 'chatgpt-cdp' }],
    ['claude1', { brainName: 'claude-cdp' }],
    ['codex1',  { brainName: 'codex' }],
  ]);

  it('returns no mirrors when only one CDP recipient', () => {
    const replies = [{ author: 'cgpt1', text: 'hello' }];
    expect(planMirrors(replies, ['cgpt1', 'codex1'], sessions, brainForName)).toEqual([]);
  });

  it('returns no mirrors when there are no replies', () => {
    expect(planMirrors([], ['cgpt1', 'claude1'], sessions, brainForName)).toEqual([]);
  });

  it('mirrors a CDP brain reply to all OTHER CDP recipients', () => {
    const replies = [{ author: 'cgpt1', text: 'hello world' }];
    const out = planMirrors(replies, ['cgpt1', 'claude1'], sessions, brainForName);
    expect(out).toEqual([{ to: 'claude1', message: '[cgpt1]: hello world' }]);
  });

  it('does not mirror replies from a non-CDP author', () => {
    const replies = [{ author: 'codex1', text: 'shell output' }];
    expect(planMirrors(replies, ['cgpt1', 'claude1', 'codex1'], sessions, brainForName)).toEqual([]);
  });

  it('does not mirror a CDP reply back to a non-CDP recipient', () => {
    const replies = [{ author: 'cgpt1', text: 'hi' }];
    const out = planMirrors(replies, ['cgpt1', 'claude1', 'codex1'], sessions, brainForName);
    // codex1 is not a CDP recipient — only claude1 receives the mirror.
    expect(out).toEqual([{ to: 'claude1', message: '[cgpt1]: hi' }]);
  });

  it('never echoes the reply back to its own author', () => {
    const replies = [{ author: 'cgpt1', text: 'hi' }];
    const out = planMirrors(replies, ['cgpt1', 'claude1'], sessions, brainForName);
    expect(out.find(m => m.to === 'cgpt1')).toBeUndefined();
  });
});
