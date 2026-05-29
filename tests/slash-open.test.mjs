// tests/slash-open.test.mjs — regression coverage for the SHELL slash file
// (slash/open.mjs). Mirrors slash-attach.test.mjs; closes the test gap for
// /open after operator (2026-05-29) flagged that these shell commands had
// no safeguarding tests despite being daily-driver UX.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { __cdpTabs } = vi.hoisted(() => ({ __cdpTabs: { current: [] } }));
vi.mock('../src/tools/cdp.mjs', () => ({
  isRunning: async () => true,
  listTabs:  async () => __cdpTabs.current,
  openTab:   async (url) => `opened-${url.slice(0, 12)}`,
}));

import { run } from '../slash/open.mjs';

function makeCtx({
  sessions = {},
  brains = {
    'chatgpt-cdp': { name: 'chatgpt-cdp', urlMatch: /chatgpt\.com/, homeUrl: 'https://chatgpt.com/' },
  },
  currentRoom = 'default',
} = {}) {
  const out = [];
  const roomSessionsMap = { default: { ...sessions }, };
  let liveRoom = currentRoom;
  if (currentRoom !== 'default') roomSessionsMap[currentRoom] = { ...sessions };

  const canonicalBrainName = (s) => (s && brains[s]) ? s : null;
  const brainForName = (n) => brains[n] ?? null;

  const setRoomSessionsMap = (updater) => {
    const next = typeof updater === 'function' ? updater(roomSessionsMap) : updater;
    for (const k of Object.keys(next)) roomSessionsMap[k] = next[k];
  };
  const setSessions = (updater) => {
    const cur = roomSessionsMap[liveRoom] ?? {};
    const next = typeof updater === 'function' ? updater(cur) : updater;
    roomSessionsMap[liveRoom] = next;
  };

  const ctx = {
    sysOut: (s) => out.push(s),
    sessions: roomSessionsMap[liveRoom],
    setSessions,
    roomSessionsMap,
    setRoomSessionsMap,
    getCurrentRoom: () => liveRoom,
    setCurrentRoom: (r) => { liveRoom = r; },
    canonicalBrainName,
    brainForName,
    brainNamesForHelp: () => Object.keys(brains),
    nextName: (brainName, existing) => {
      const prefix = brainName.split('-')[0];
      let n = 1; while (existing[`${prefix}${n}`]) n++;
      return `${prefix}${n}`;
    },
    nextEmoji: () => '🅒',
  };

  return {
    ctx,
    out,
    sessionsAfter: () => roomSessionsMap[liveRoom],
    currentRoomAfter: () => liveRoom,
    roomSessionsMapAfter: () => roomSessionsMap,
  };
}

beforeEach(() => { __cdpTabs.current = []; });

describe('/open', () => {
  it('with no args, prints the brain list', async () => {
    const t = makeCtx({});
    await run({ arg: '', ctx: t.ctx });

    expect(t.out.join('\n')).toMatch(/usage: \/open/);
    expect(t.out.join('\n')).toMatch(/brains: chatgpt-cdp/);
  });

  it('with an unknown brain token, prints the usage hint', async () => {
    // canonicalBrainName returns null for unknown tokens, so /open falls
    // through to the "usage" message rather than printing "unknown brain"
    // (that message only fires when canonicalBrainName succeeds but
    // brainForName fails — a rare edge case).
    const t = makeCtx({});
    await run({ arg: 'not-a-brain', ctx: t.ctx });

    expect(t.out.join('\n')).toMatch(/usage: \/open/);
  });

  it('from the lobby with a CDP brain, auto-creates a room and opens a tab', async () => {
    // Pre-fix this refused with a fictional "/room join <name>" hint (operator
    // 2026-05-28 → commit 644a192).
    const t = makeCtx({ currentRoom: 'default' });
    await run({ arg: 'chatgpt-cdp', ctx: t.ctx });

    // Auto-created a non-default room and switched into it.
    expect(t.currentRoomAfter()).not.toBe('default');
    expect(t.out.join('\n')).toMatch(/auto-created room/);
    expect(t.out.join('\n')).toMatch(/joined room/);

    // Opened a tab and registered a session under the new room.
    const newRoom = t.currentRoomAfter();
    const sessions = t.roomSessionsMapAfter()[newRoom] ?? {};
    expect(Object.keys(sessions).length).toBe(1);
    const s = sessions[Object.keys(sessions)[0]];
    expect(s.brain).toBe('chatgpt-cdp');
    expect(s.options.targetId).toMatch(/^opened-/);
  });

  it('inside a non-default room, opens a session directly', async () => {
    const t = makeCtx({ currentRoom: 'cgpt-room' });
    await run({ arg: 'chatgpt-cdp', ctx: t.ctx });

    // No auto-create line — we were already out of the lobby.
    expect(t.out.join('\n')).not.toMatch(/auto-created room/);
    const sessions = t.sessionsAfter();
    expect(Object.keys(sessions).length).toBe(1);
    expect(sessions[Object.keys(sessions)[0]].brain).toBe('chatgpt-cdp');
  });

  it('refuses to overwrite an existing named session', async () => {
    const t = makeCtx({
      currentRoom: 'cgpt-room',
      sessions: { mychat: { brain: 'chatgpt-cdp', options: { targetId: 'X' }, emoji: '🅒' } },
    });
    await run({ arg: 'chatgpt-cdp mychat', ctx: t.ctx });

    expect(t.out.join('\n')).toMatch(/session "mychat" already exists/);
  });
});
