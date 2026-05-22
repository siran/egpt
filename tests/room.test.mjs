// tests/room.test.mjs — routing-decision tests for room.mjs.
//
// These exercise the decision tree that lives between parseInput and the
// brain calls: who should run? broadcast or single? auto-open? forward via
// bus? error? Pure inputs in, decision out — no I/O, no Ink, no fetch.

import { describe, it, expect } from 'vitest';
import { parseInput } from '../src/interpreter.mjs';
import { resolveRoute, planMirrors } from '../src/room.mjs';

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
// `siblings` mirrors the registry shape — each entry is [name, {kind, aliases?}].
function ctx({ sessions = [], peers = [], activeSessions = [], siblings } = {}) {
  return {
    sessions: new Map(sessions.map(([name, brainName]) => [name, { brainName }])),
    peerSessions: new Map(
      peers.map(([nodeId, list]) => [nodeId, list.map(([n, b]) => ({ name: n, brain: b }))]),
    ),
    brainForName,
    canonicalBrainName,
    activeSessions,
    ...(siblings ? { siblings: new Map(siblings) } : {}),
  };
}

const route = (text, c) => resolveRoute(parseInput(text), text, c);

// ── @egpt persona ──────────────────────────────────────────────────────────

describe('resolveRoute — @egpt persona', () => {
  it('returns kind:"persona" for @egpt with body', () => {
    expect(route('@egpt what is the price of bitcoin?', ctx())).toEqual({
      kind: 'persona', body: 'what is the price of bitcoin?',
    });
  });

  it('uses ? as body when @egpt has no question', () => {
    expect(route('@egpt', ctx())).toEqual({ kind: 'persona', body: '?' });
  });

  it('matches @egpt case-insensitively', () => {
    expect(route('@EGPT hi', ctx())).toEqual({ kind: 'persona', body: 'hi' });
    expect(route('@Egpt hi', ctx())).toEqual({ kind: 'persona', body: 'hi' });
  });

  it('does NOT match @egpt-suffix tokens', () => {
    // @egpt-bot, @egpts etc. are not the persona — fall through to
    // normal session/peer routing (and error if no match).
    const r = route('@egpt-bot hi', ctx());
    expect(r.kind).toBe('error');
  });

  it('persona takes precedence over a session named "egpt"', () => {
    // If somebody named a session "egpt", @egpt still hits the persona,
    // not that session. The persona is reserved.
    const c = ctx({ sessions: [['egpt', 'codex']] });
    expect(route('@egpt hello', c)).toEqual({ kind: 'persona', body: 'hello' });
  });

  it("'@e' is the short alias (/ee/, like 'eel') and routes to the persona", () => {
    expect(route('@e what time is it?', ctx())).toEqual({
      kind: 'persona', body: 'what time is it?',
    });
    expect(route('@e', ctx())).toEqual({ kind: 'persona', body: '?' });
    expect(route('@E hi', ctx())).toEqual({ kind: 'persona', body: 'hi' });
  });

  it("persona alias '@e' takes precedence over a session named 'e'", () => {
    const c = ctx({ sessions: [['e', 'codex']] });
    expect(route('@e hi', c)).toEqual({ kind: 'persona', body: 'hi' });
  });
});

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

  it('returns { kind: "idle" } when sessions exist but no activeSessions set', () => {
    // Plain text never auto-routes; user must @-mention or /use first.
    const c = ctx({ sessions: [['codex1', 'codex'], ['cgpt1', 'chatgpt-cdp']] });
    expect(route('hello room', c)).toEqual({ kind: 'idle' });
  });

  it('returns { kind: "idle" } when one session exists but no activeSessions set', () => {
    const c = ctx({ sessions: [['codex1', 'codex']] });
    expect(route('hello', c)).toEqual({ kind: 'idle' });
  });

  it('routes plain text to a single activeSession (broadcast false)', () => {
    const c = ctx({
      sessions: [['codex1', 'codex'], ['cgpt1', 'chatgpt-cdp']],
      activeSessions: ['cgpt1'],
    });
    expect(route('hello', c)).toEqual({
      kind: 'turn', recipients: ['cgpt1'], payload: 'hello', broadcast: false,
    });
  });

  it('broadcasts plain text to multiple activeSessions', () => {
    const c = ctx({
      sessions: [['cgpt1', 'chatgpt-cdp'], ['claude1', 'claude-cdp'], ['codex1', 'codex']],
      activeSessions: ['cgpt1', 'claude1'],
    });
    expect(route('hello room', c)).toEqual({
      kind: 'turn', recipients: ['cgpt1', 'claude1'], payload: 'hello room', broadcast: true,
    });
  });

  it('drops activeSessions that no longer exist in the room', () => {
    const c = ctx({
      sessions: [['cgpt1', 'chatgpt-cdp']],
      activeSessions: ['cgpt1', 'codex1'],   // codex1 was removed
    });
    expect(route('hello', c)).toEqual({
      kind: 'turn', recipients: ['cgpt1'], payload: 'hello', broadcast: false,
    });
  });

  it('returns { kind: "idle" } when all activeSessions are stale', () => {
    const c = ctx({
      sessions: [['cgpt1', 'chatgpt-cdp']],
      activeSessions: ['codex1'],
    });
    expect(route('hello', c)).toEqual({ kind: 'idle' });
  });

  it('preserves the full text including newlines as the payload when routed', () => {
    const c = ctx({ sessions: [['codex1', 'codex']], activeSessions: ['codex1'] });
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

// ── siblings registry routing ───────────────────────────────────────────────
//
// ctx.siblings (when present) replaces the hardcoded egpt/e/me/wren branches.
// Each entry: { kind: 'persona' | 'sibling', aliases?: [...] }. The
// resolveRoute decision returns kind:'persona' or kind:'meta' (matching the
// existing caller switch) PLUS decision.name so the caller can pick the
// right session_id from the same registry.

describe('resolveRoute — siblings registry', () => {
  const REGISTRY = [
    ['e',    { kind: 'persona' }],
    ['wren', { kind: 'sibling', aliases: ['me'] }],
    ['jay',  { kind: 'sibling' }],
  ];

  it('registry hit on persona returns kind:"persona" + name', () => {
    expect(route('@e hi', ctx({ siblings: REGISTRY }))).toEqual({
      kind: 'persona', body: 'hi', name: 'e',
    });
  });

  it('registry hit on sibling returns kind:"meta" + name', () => {
    expect(route('@wren hi', ctx({ siblings: REGISTRY }))).toEqual({
      kind: 'meta', body: 'hi', name: 'wren',
    });
    expect(route('@jay hi', ctx({ siblings: REGISTRY }))).toEqual({
      kind: 'meta', body: 'hi', name: 'jay',
    });
  });

  it('alias resolves to the canonical name', () => {
    // @me is an alias for wren; decision.name is the canonical 'wren'.
    expect(route('@me hi', ctx({ siblings: REGISTRY }))).toEqual({
      kind: 'meta', body: 'hi', name: 'wren',
    });
  });

  it('alias lookup is case-insensitive', () => {
    expect(route('@ME hi', ctx({ siblings: REGISTRY }))).toEqual({
      kind: 'meta', body: 'hi', name: 'wren',
    });
  });

  it('unknown token falls through to error path (registry replaces legacy)', () => {
    // 'egpt' / 'me' / 'wren' hardcoded fallback is SUPPRESSED when a
    // non-empty registry is provided. An unknown token gets the standard
    // 'no participant @<token>' error, NOT a legacy match.
    const r = route('@egpt hi', ctx({ siblings: REGISTRY }));
    // 'egpt' isn't in the registry above (only 'e' is) — so this should
    // error out, not route to a persona.
    expect(r.kind).toBe('error');
  });

  it('legacy fallback (egpt/e/me/wren) still works when ctx.siblings is absent', () => {
    expect(route('@egpt hi', ctx())).toEqual({ kind: 'persona', body: 'hi' });
    expect(route('@e hi', ctx())).toEqual({ kind: 'persona', body: 'hi' });
    expect(route('@me hi', ctx())).toEqual({ kind: 'meta', body: 'hi' });
    expect(route('@wren hi', ctx())).toEqual({ kind: 'meta', body: 'hi' });
  });

  it('legacy fallback also fires when ctx.siblings is an empty registry', () => {
    expect(route('@e hi', ctx({ siblings: [] }))).toEqual({
      kind: 'persona', body: 'hi',
    });
  });

  it('registry takes precedence over a local session with the same name', () => {
    // Same precedence rule the legacy persona had — a registry hit wins
    // even when a session is also named that.
    const c = ctx({
      sessions: [['wren', 'codex']],
      siblings: REGISTRY,
    });
    expect(route('@wren hi', c)).toEqual({
      kind: 'meta', body: 'hi', name: 'wren',
    });
  });
});
