// tests/slash-attach.test.mjs — regression coverage for the SHELL slash file
// (slash/attach.mjs). Pre-2026-05-29 the shell slash files had zero unit
// tests; only the Chrome extension's session-commands had coverage. This
// closes the gap for /attach. Add similar files per command as we touch them.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock cdp BEFORE importing slash/attach.mjs. Mutable holder so each test can
// set the tabs and the mock reads the current value.
const { __cdpTabs } = vi.hoisted(() => ({ __cdpTabs: { current: [] } }));
vi.mock('../src/tools/cdp.mjs', () => ({
  isRunning: async () => true,
  listTabs:  async () => __cdpTabs.current,
  openTab:   async () => 'opened-tab-id',
}));

import { run } from '../slash/attach.mjs';

function makeCtx({
  sessions = {},
  brains = {
    'chatgpt-cdp': { name: 'chatgpt-cdp', urlMatch: /chatgpt\.com/, homeUrl: 'https://chatgpt.com/' },
    'claude-cdp':  { name: 'claude-cdp',  urlMatch: /claude\.ai/,   homeUrl: 'https://claude.ai/' },
  },
  currentRoom = 'work',
} = {}) {
  const out = [];
  const sysOut = (s) => out.push(s);
  const roomSessionsMap = { default: {}, [currentRoom]: { ...sessions } };
  let liveRoom = currentRoom;

  const canonicalBrainName = (s) => (s && brains[s]) ? s : null;
  const brainForName = (n) => brains[n] ?? null;
  const brainForUrl = (u) => {
    if (!u) return null;
    for (const [name, b] of Object.entries(brains)) if (b.urlMatch?.test(u)) return name;
    return null;
  };

  const setSessions = (updater) => {
    const cur = roomSessionsMap[liveRoom] ?? {};
    const next = typeof updater === 'function' ? updater(cur) : updater;
    roomSessionsMap[liveRoom] = next;
  };
  const setRoomSessionsMap = (updater) => {
    const next = typeof updater === 'function' ? updater(roomSessionsMap) : updater;
    for (const k of Object.keys(next)) roomSessionsMap[k] = next[k];
  };

  const ctx = {
    sysOut,
    sessions: roomSessionsMap[liveRoom],
    setSessions,
    roomSessionsMap,
    setRoomSessionsMap,
    getCurrentRoom: () => liveRoom,
    setCurrentRoom: (r) => { liveRoom = r; },
    setActiveSessions: () => {},
    canonicalBrainName,
    brainForName,
    brainForUrl,
    brainNamesForHelp: () => Object.keys(brains),
    profileDirsText: () => '(none)',
    isInternalUrl: (u) => !!u && u.startsWith('chrome://'),
    nextName: (brainName, existing) => {
      const prefix = brainName.split('-')[0];
      let n = 1; while (existing[`${prefix}${n}`]) n++;
      return `${prefix}${n}`;
    },
    nextEmoji: () => '🅒',
    loadBrainProfile: async () => null,
    attachProfile: async () => {},
    resolveTabId: async (spec) => {
      const norm = String(spec).trim();
      const m = __cdpTabs.current.find(t => t.url === norm || t.url.includes(norm) || t.id === norm);
      return m?.id ?? null;
    },
    spawnChromeWithExtension: async () => {},
  };

  return {
    ctx,
    out,
    sessionsAfter: () => roomSessionsMap[liveRoom],
  };
}

beforeEach(() => { __cdpTabs.current = []; });

describe('/attach <url> — brain + name inferred from the tab', () => {
  it('resolves a URL to a session attached to the matching brain', async () => {
    __cdpTabs.current = [
      { id: 'TAB-CHATGPT-001', url: 'https://chatgpt.com/c/abc-def', title: 'My ChatGPT chat' },
    ];
    const t = makeCtx({});
    await run({ arg: 'https://chatgpt.com/c/abc-def', ctx: t.ctx });

    const sessions = t.sessionsAfter();
    expect(Object.keys(sessions)).toContain('chatgpt1');
    expect(sessions.chatgpt1.brain).toBe('chatgpt-cdp');
    expect(sessions.chatgpt1.options.targetId).toBe('TAB-CHATGPT-001');
    expect(t.out.join('\n')).toMatch(/session "chatgpt1"/);
  });

  it('resolves a UUID embedded in a URL', async () => {
    __cdpTabs.current = [
      { id: 'TAB-X', url: 'https://chatgpt.com/c/6a19c354-d0d8-83ea-a09a-a1fbf8387b4e', title: 't' },
    ];
    const t = makeCtx({});
    await run({ arg: '6a19c354-d0d8-83ea-a09a-a1fbf8387b4e', ctx: t.ctx });

    expect(t.sessionsAfter().chatgpt1?.options.targetId).toBe('TAB-X');
  });

  it('reports "already attached" instead of duplicating', async () => {
    __cdpTabs.current = [
      { id: 'TAB-X', url: 'https://chatgpt.com/c/abc', title: 't' },
    ];
    const t = makeCtx({
      sessions: { chatgpt1: { brain: 'chatgpt-cdp', options: { targetId: 'TAB-X' }, emoji: '🅒' } },
    });
    await run({ arg: 'https://chatgpt.com/c/abc', ctx: t.ctx });

    expect(t.out.join('\n')).toMatch(/already attached/);
  });

  it('rejects a URL with no matching brain', async () => {
    __cdpTabs.current = [
      { id: 'TAB-Y', url: 'https://example.com/whatever', title: 't' },
    ];
    const t = makeCtx({});
    await run({ arg: 'https://example.com/whatever', ctx: t.ctx });

    expect(t.out.join('\n')).toMatch(/no brain recognizes its URL/);
  });

  it('falls through to usage when arg is neither a brain nor a resolvable tab', async () => {
    __cdpTabs.current = [];
    const t = makeCtx({});
    await run({ arg: 'not-a-brain-not-a-url', ctx: t.ctx });

    expect(t.out.join('\n')).toMatch(/usage: \/attach/);
  });
});

describe('/attach <brain> — preserves existing behavior', () => {
  it('attaches an open tab matching the brain via brain-name path', async () => {
    __cdpTabs.current = [
      { id: 'TAB-CG-A', url: 'https://chatgpt.com/c/a', title: 'a' },
    ];
    const t = makeCtx({});
    await run({ arg: 'chatgpt-cdp', ctx: t.ctx });

    const sessions = t.sessionsAfter();
    expect(Object.keys(sessions).length).toBe(1);
    const onlyKey = Object.keys(sessions)[0];
    expect(sessions[onlyKey].brain).toBe('chatgpt-cdp');
    expect(sessions[onlyKey].options.targetId).toBe('TAB-CG-A');
  });
});
