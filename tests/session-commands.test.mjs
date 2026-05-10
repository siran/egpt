// tests/session-commands.test.mjs — execution-side tests for the
// session-management slash commands (/use /sessions /detach /tabs
// /open /attach). Same pattern as wa-commands.test.mjs.

import { describe, it, expect } from 'vitest';
import { use, sessions, detach, tabs, open, attach }
  from '../extension/src/commands/session-commands.js';

function makeCtx(overrides = {}) {
  const logs = [];
  const errors = [];
  const state = {
    sessions: new Map(),
    activeSessions: [],
    peerNodes: new Map(),
    syncs: 0,
  };
  const calls = { listTabs: [], createTab: [], waitForTabLoad: [], resolveTabSpec: [] };
  const brains = {
    'chatgpt-cdp': { name: 'chatgpt-cdp', urlMatch: /chatgpt\.com/, homeUrl: 'https://chatgpt.com/' },
    'claude-cdp':  { name: 'claude-cdp',  urlMatch: /claude\.ai/,   homeUrl: 'https://claude.ai/' },
  };
  const ctx = {
    log:    (text) => logs.push(text),
    error:  (text) => errors.push(text),
    getSessions: () => state.sessions,
    setSession:  (name, value) => {
      if (value == null) state.sessions.delete(name);
      else state.sessions.set(name, value);
    },
    syncSessionsList: () => { state.syncs++; },
    getActiveSessions: () => state.activeSessions,
    setActiveSessions: (arr) => { state.activeSessions = arr; },
    getPeerNodes: () => state.peerNodes,
    listTabs: async (urlMatch) => {
      calls.listTabs.push(urlMatch ?? null);
      const all = state.tabs ?? [];
      return urlMatch ? all.filter(t => urlMatch.test(t.url)) : all;
    },
    createTab: async (opts) => {
      calls.createTab.push(opts);
      const id = state.nextTabId ?? 1001;
      state.nextTabId = id + 1;
      // Simulate the new CDP tab being visible on next listTabs
      state.tabs = [...(state.tabs ?? []), { id, url: opts.url, title: 'New Tab' }];
      return { id };
    },
    waitForTabLoad: async (id) => { calls.waitForTabLoad.push(id); },
    nextSessionName: (brainType) => {
      const used = [...state.sessions.keys()];
      const prefix = brainType.replace(/-cdp$/, '').slice(0, 4);
      let i = 1;
      while (used.includes(`${prefix}${i}`)) i++;
      return `${prefix}${i}`;
    },
    canonicalBrain: (raw) => {
      const m = { gpt: 'chatgpt-cdp', chatgpt: 'chatgpt-cdp', claude: 'claude-cdp' };
      return m[raw] ?? raw;
    },
    brains,
    resolveTabSpec: async (spec, brain) => {
      calls.resolveTabSpec.push({ spec, brainName: brain.name });
      return state.resolveTabSpecResult ?? null;
    },
    sleep: async (_ms) => {},   // no-op so tests don't actually wait
    ...overrides,
  };
  return { ctx, logs, errors, state, calls, brains };
}

describe('/use', () => {
  it('lists active sessions when called without args', async () => {
    const t = makeCtx();
    t.state.activeSessions = ['gpt1', 'cl1'];
    await use('', t.ctx);
    expect(t.logs[0]).toBe('active sessions: gpt1, cl1');
  });

  it('shows "no active" when none + no args', async () => {
    const t = makeCtx();
    await use('', t.ctx);
    expect(t.logs[0]).toMatch(/^no active sessions/);
  });

  it('clears with /use clear', async () => {
    const t = makeCtx();
    t.state.activeSessions = ['gpt1'];
    await use('clear', t.ctx);
    expect(t.state.activeSessions).toEqual([]);
    expect(t.logs[0]).toBe('active sessions cleared');
  });

  it('clears with /use none too', async () => {
    const t = makeCtx();
    t.state.activeSessions = ['gpt1'];
    await use('none', t.ctx);
    expect(t.state.activeSessions).toEqual([]);
  });

  it('errors on unknown sessions', async () => {
    const t = makeCtx();
    t.state.sessions.set('gpt1', {});
    await use('gpt1, gpt2', t.ctx);
    expect(t.errors[0]).toContain('gpt2');
    expect(t.state.activeSessions).toEqual([]);
  });

  it('sets a single active session', async () => {
    const t = makeCtx();
    t.state.sessions.set('gpt1', {});
    await use('gpt1', t.ctx);
    expect(t.state.activeSessions).toEqual(['gpt1']);
    expect(t.logs[0]).toMatch(/^Active session → gpt1$/);
  });

  it('sets multiple sessions for broadcast', async () => {
    const t = makeCtx();
    t.state.sessions.set('a', {});
    t.state.sessions.set('b', {});
    await use('a, b', t.ctx);
    expect(t.state.activeSessions).toEqual(['a', 'b']);
    expect(t.logs[0]).toMatch(/multi-AI broadcast/);
  });
});

describe('/sessions', () => {
  it('reports "no local sessions" when empty', async () => {
    const t = makeCtx();
    await sessions('', t.ctx);
    expect(t.logs[0]).toBe('(no local sessions)');
  });

  it('lists local sessions with brain + tab', async () => {
    const t = makeCtx();
    t.state.sessions.set('gpt1', { brain: { name: 'chatgpt-cdp' }, targetId: 'TAB1' });
    await sessions('', t.ctx);
    expect(t.logs[0]).toContain('gpt1  chatgpt-cdp  tab:TAB1');
  });

  it('appends peer block when peers are present', async () => {
    const t = makeCtx();
    t.state.peerNodes.set('shell-1', {
      role: 'shell', polling: true,
      sessions: [{ name: 'codex', brain: 'codex' }],
    });
    await sessions('', t.ctx);
    expect(t.logs[0]).toContain('peers (zombie sessions)');
    expect(t.logs[0]).toContain('shell-1  (shell)  [polling]');
    expect(t.logs[0]).toContain('codex');
  });
});

describe('/detach', () => {
  it('shows usage when no name given', async () => {
    const t = makeCtx();
    await detach('', t.ctx);
    expect(t.logs[0]).toBe('Usage: /detach <name>');
  });

  it('removes the session and syncs', async () => {
    const t = makeCtx();
    t.state.sessions.set('gpt1', {});
    await detach('gpt1', t.ctx);
    expect(t.state.sessions.has('gpt1')).toBe(false);
    expect(t.state.syncs).toBe(1);
    expect(t.logs[0]).toBe('Detached gpt1');
  });

  it('also drops it from active sessions if present', async () => {
    const t = makeCtx();
    t.state.sessions.set('gpt1', {});
    t.state.activeSessions = ['gpt1', 'cl1'];
    await detach('gpt1', t.ctx);
    expect(t.state.activeSessions).toEqual(['cl1']);
  });
});

describe('/tabs', () => {
  it('reports "No open tabs" when empty', async () => {
    const t = makeCtx();
    t.state.tabs = [];
    await tabs('', t.ctx);
    expect(t.logs[0]).toBe('No open tabs found.');
  });

  it('formats id + url', async () => {
    const t = makeCtx();
    t.state.tabs = [
      { id: 'A', url: 'https://example.com/' },
      { id: 'B', url: 'https://chatgpt.com/c/123' },
    ];
    await tabs('', t.ctx);
    expect(t.logs[0]).toContain('A  https://example.com/');
    expect(t.logs[0]).toContain('B  https://chatgpt.com/c/123');
  });
});

describe('/open', () => {
  it('shows usage when no brain given', async () => {
    const t = makeCtx();
    await open('', t.ctx);
    expect(t.logs[0]).toContain('Usage: /open');
  });

  it('rejects unknown brain', async () => {
    const t = makeCtx();
    await open('frobnitz', t.ctx);
    expect(t.logs[0]).toContain('Unknown brain type "frobnitz"');
  });

  it('refuses to overwrite an existing session name', async () => {
    const t = makeCtx();
    t.state.sessions.set('gpt1', {});
    await open('chatgpt gpt1', t.ctx);
    expect(t.logs[t.logs.length - 1]).toBe('Session "gpt1" already exists.');
  });

  it('opens a new tab, registers session, syncs', async () => {
    const t = makeCtx();
    t.state.tabs = [];
    t.state.nextTabId = 7;
    await open('chatgpt', t.ctx);
    expect(t.calls.createTab).toEqual([{ url: 'https://chatgpt.com/', active: false }]);
    expect(t.calls.waitForTabLoad).toEqual([7]);
    expect(t.state.sessions.size).toBe(1);
    const [name, sess] = [...t.state.sessions.entries()][0];
    expect(name).toBe('chat1');
    expect(sess.targetId).toBe(7);
    expect(t.state.syncs).toBeGreaterThanOrEqual(1);
  });

  it('uses a custom session name when given', async () => {
    const t = makeCtx();
    await open('chatgpt myThread', t.ctx);
    expect(t.state.sessions.has('myThread')).toBe(true);
  });

  it('warns when CDP target never registers', async () => {
    const t = makeCtx({
      // createTab returns a tab but listTabs(urlMatch) never sees it
      createTab: async (opts) => {
        t.calls.createTab.push(opts);
        return { id: 999 };   // chrome.tabs id only; never appears in CDP listTabs
      },
      listTabs: async (_urlMatch) => [],   // CDP never sees the new target
    });
    await open('chatgpt', t.ctx);
    expect(t.logs.some(l => l.includes("couldn't locate its CDP target"))).toBe(true);
    expect(t.state.sessions.size).toBe(0);
  });
});

describe('/attach', () => {
  it('rescans and attaches matching tabs when called bare', async () => {
    const t = makeCtx();
    t.state.tabs = [
      { id: 'CDP-A', url: 'https://chatgpt.com/' },
      { id: 'CDP-B', url: 'https://claude.ai/chat/abc' },
      { id: 'CDP-C', url: 'https://example.com/' },
    ];
    await attach('', t.ctx);
    expect(t.state.sessions.size).toBe(2);
    expect([...t.state.sessions.values()].map(s => s.targetId).sort()).toEqual(['CDP-A', 'CDP-B']);
    expect(t.logs[0]).toContain('Attached:');
  });

  it('rescan reports no new tabs when nothing matches', async () => {
    const t = makeCtx();
    t.state.tabs = [{ id: 'X', url: 'https://example.com/' }];
    await attach('', t.ctx);
    expect(t.logs[0]).toBe('No new tabs to attach.');
    expect(t.state.sessions.size).toBe(0);
  });

  it('rescan skips tabs already attached', async () => {
    const t = makeCtx();
    t.state.tabs = [{ id: 'CDP-A', url: 'https://chatgpt.com/' }];
    t.state.sessions.set('chat1', { brain: t.brains['chatgpt-cdp'], targetId: 'CDP-A' });
    await attach('', t.ctx);
    expect(t.logs[0]).toBe('No new tabs to attach.');
    expect(t.state.sessions.size).toBe(1);
  });

  it('rejects unknown brain on explicit attach', async () => {
    const t = makeCtx();
    await attach('frobnitz', t.ctx);
    expect(t.logs[0]).toContain('Unknown brain type "frobnitz"');
  });

  it('explicit attach binds to the single matching tab', async () => {
    const t = makeCtx();
    t.state.tabs = [{ id: 'CDP-A', url: 'https://chatgpt.com/c/x' }];
    await attach('chatgpt', t.ctx);
    expect(t.state.sessions.size).toBe(1);
    expect([...t.state.sessions.values()][0].targetId).toBe('CDP-A');
  });

  it('asks user to disambiguate when multiple matching tabs', async () => {
    const t = makeCtx();
    t.state.tabs = [
      { id: 'CDP-A', url: 'https://chatgpt.com/c/a', title: 'Thread A' },
      { id: 'CDP-B', url: 'https://chatgpt.com/c/b', title: 'Thread B' },
    ];
    await attach('chatgpt', t.ctx);
    expect(t.logs[0]).toContain('Multiple chatgpt-cdp tabs');
    expect(t.logs[0]).toContain('CDP-A');
    expect(t.state.sessions.size).toBe(0);
  });

  it('uses resolveTabSpec when a tab spec is given', async () => {
    const t = makeCtx();
    t.state.resolveTabSpecResult = 'CDP-XYZ';
    await attach('chatgpt my-name some-spec', t.ctx);
    expect(t.calls.resolveTabSpec).toEqual([{ spec: 'some-spec', brainName: 'chatgpt-cdp' }]);
    expect([...t.state.sessions.values()][0].targetId).toBe('CDP-XYZ');
    expect(t.state.sessions.has('my-name')).toBe(true);
  });

  it('errors when tab spec fails to resolve', async () => {
    const t = makeCtx();
    t.state.resolveTabSpecResult = null;
    await attach('chatgpt my-name junk', t.ctx);
    expect(t.logs[0]).toContain('Could not resolve "junk"');
    expect(t.state.sessions.size).toBe(0);
  });
});
