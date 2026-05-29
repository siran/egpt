// tests/extension-wa-commands.test.mjs — execution-side-effects coverage
// for the CHROME EXTENSION's WA-CDP commands (extension/src/commands/
// wa-commands.js). NOT for the shell's baileys path (slash/whatsapp.mjs)
// — that's still untested. These
// pin: which storage keys are read, which bridge methods are called
// with which args, what user-visible logs/errors fire, and what
// state mutations happen — none of which were covered before, only
// the parsing was.
//
// Pattern: each handler takes (rest, ctx). The ctx is a plain DI bag
// — tests pass mocks/spies and assert on them. The React layer wires
// ctx to the real refs/storage/bridge in App.jsx.

import { describe, it, expect } from 'vitest';
import { channels, join, unjoin, mirror } from '../extension/src/commands/wa-commands.js';

// makeCtx — produces a fresh ctx with sensible defaults plus
// in-memory state buckets for asserting side effects. Override any
// field via the argument.
function makeCtx(overrides = {}) {
  const logs = [];
  const errors = [];
  const state = {
    channels: [],
    joined: null,
    sessions: new Map(),
    lastIncoming: null,
  };
  const bridgeCalls = { listChannels: [], send: [] };
  const brainCalls = { e: [], session: [] };
  const ctx = {
    bridge: {
      listChannels: async (opts) => { bridgeCalls.listChannels.push(opts); return []; },
      send:         async (text, opts) => { bridgeCalls.send.push({ text, opts }); },
    },
    storage: { get: async (_key) => ({}) },
    log:    (text) => logs.push(text),
    error:  (text) => errors.push(text),
    getChannels: () => state.channels,
    setChannels: (c) => { state.channels = c; },
    getJoined:   () => state.joined,
    setJoined:   (v) => { state.joined = v; },
    getSessions: () => state.sessions,
    getLastIncoming: () => state.lastIncoming,
    runBrainE:        async (text, sender) => { brainCalls.e.push({ text, sender }); },
    runBrainSession:  async (name, text, sender) => { brainCalls.session.push({ name, text, sender }); },
    ...overrides,
  };
  return { ctx, logs, errors, state, bridgeCalls, brainCalls };
}

describe('/channels', () => {
  it('errors when bridge is not ready', async () => {
    const t = makeCtx({ bridge: null });
    await channels('', t.ctx);
    expect(t.errors).toEqual(['/channels: WA-CDP bridge not ready (open web.whatsapp.com)']);
    expect(t.logs).toEqual([]);
  });

  it('uses default limit of 10 when no arg, no config', async () => {
    const t = makeCtx({
      bridge: { listChannels: async (o) => { t.bridgeCalls.listChannels.push(o); return [{ name: 'A' }]; } },
    });
    await channels('', t.ctx);
    expect(t.bridgeCalls.listChannels).toEqual([{ limit: 10 }]);
  });

  it('uses arg limit when valid number', async () => {
    const t = makeCtx({
      bridge: { listChannels: async (o) => { t.bridgeCalls.listChannels.push(o); return []; } },
    });
    await channels('25', t.ctx);
    expect(t.bridgeCalls.listChannels).toEqual([{ limit: 25 }]);
  });

  it('uses storage default when no arg', async () => {
    const t = makeCtx({
      storage: { get: async () => ({ whatsapp_cdp: { channels_default: 7 } }) },
      bridge: { listChannels: async (o) => { t.bridgeCalls.listChannels.push(o); return []; } },
    });
    await channels('', t.ctx);
    expect(t.bridgeCalls.listChannels).toEqual([{ limit: 7 }]);
  });

  it('arg limit overrides storage default', async () => {
    const t = makeCtx({
      storage: { get: async () => ({ whatsapp_cdp: { channels_default: 7 } }) },
      bridge: { listChannels: async (o) => { t.bridgeCalls.listChannels.push(o); return []; } },
    });
    await channels('3', t.ctx);
    expect(t.bridgeCalls.listChannels).toEqual([{ limit: 3 }]);
  });

  it('updates the channel cache and formats the listing', async () => {
    const fakeChats = [
      { name: 'Lu Lu',   jid: '5511@c.us', preview: 'hey' },
      { name: 'Group 1', jid: null,         preview: 'hi all' },
    ];
    const t = makeCtx({ bridge: { listChannels: async () => fakeChats } });
    await channels('', t.ctx);
    expect(t.state.channels).toEqual(fakeChats);
    expect(t.logs).toHaveLength(1);
    expect(t.logs[0]).toContain('@wa1  Lu Lu  [5511@c.us]  — hey');
    expect(t.logs[0]).toContain('@wa2  Group 1  [no-jid]  — hi all');
    expect(t.logs[0]).toContain('chats (top 2');
  });

  it('handles empty chat list with a friendly message', async () => {
    const t = makeCtx({ bridge: { listChannels: async () => [] } });
    await channels('', t.ctx);
    expect(t.state.channels).toEqual([]);
    expect(t.logs).toEqual(['/channels: no chats visible (chat list panel not open?)']);
  });

  it('surfaces bridge errors via error()', async () => {
    const t = makeCtx({
      bridge: { listChannels: async () => { throw new Error('connection lost'); } },
    });
    await channels('', t.ctx);
    expect(t.errors).toEqual(['/channels: connection lost']);
    expect(t.state.channels).toEqual([]);
  });
});

describe('/join', () => {
  it('errors on missing arg', async () => {
    const t = makeCtx();
    await join('', t.ctx);
    expect(t.errors[0]).toMatch(/usage \/join @waN/);
    expect(t.state.joined).toBeNull();
  });

  it('errors on malformed arg', async () => {
    const t = makeCtx();
    await join('not-a-channel', t.ctx);
    expect(t.errors[0]).toMatch(/usage \/join @waN/);
  });

  it('errors when index is out of range', async () => {
    const t = makeCtx({});
    t.state.channels = [{ name: 'A' }, { name: 'B' }];
    await join('@wa5', t.ctx);
    expect(t.errors[0]).toMatch(/no @wa5 in cached list/);
    expect(t.state.joined).toBeNull();
  });

  it('binds to the right chat (1-indexed) and logs', async () => {
    const t = makeCtx();
    t.state.channels = [
      { name: 'Alice', jid: 'a@c.us' },
      { name: 'Bob',   jid: 'b@c.us' },
    ];
    await join('@wa2', t.ctx);
    expect(t.state.joined).toEqual({ name: 'Bob', jid: 'b@c.us' });
    expect(t.logs[0]).toContain('@wa2 = "Bob"');
  });

  it('case-insensitive on the @WA prefix', async () => {
    const t = makeCtx();
    t.state.channels = [{ name: 'X' }];
    await join('@WA1', t.ctx);
    expect(t.state.joined).toEqual({ name: 'X' });
  });
});

describe('/unjoin', () => {
  it('clears the binding when one was set', async () => {
    const t = makeCtx();
    t.state.joined = { name: 'Bob' };
    await unjoin('', t.ctx);
    expect(t.state.joined).toBeNull();
    expect(t.logs[0]).toBe('/unjoin: released "Bob"');
  });

  it('reports nothing-to-do when not joined', async () => {
    const t = makeCtx();
    await unjoin('', t.ctx);
    expect(t.state.joined).toBeNull();
    expect(t.logs[0]).toBe('/unjoin: nothing was joined');
  });
});

describe('/mirror', () => {
  it('errors when there is no recent inbound to mirror', async () => {
    const t = makeCtx();
    await mirror('@e', t.ctx);
    expect(t.errors[0]).toBe('/mirror: no recent message to mirror');
  });

  it('shows usage when arg is missing or not a @target', async () => {
    const t = makeCtx();
    t.state.lastIncoming = { sender: 'An', text: 'hi' };
    await mirror('', t.ctx);
    expect(t.logs[0]).toMatch(/usage \/mirror @<target>/);
  });

  it('@e dispatches to the dedicated brain with raw text + sender', async () => {
    const t = makeCtx();
    t.state.lastIncoming = { sender: 'An', text: 'hello world' };
    await mirror('@e', t.ctx);
    expect(t.brainCalls.e).toEqual([{ text: 'hello world', sender: 'An' }]);
    expect(t.brainCalls.session).toEqual([]);
  });

  it('@egpt is an alias for @e', async () => {
    const t = makeCtx();
    t.state.lastIncoming = { sender: 'An', text: 'foo' };
    await mirror('@egpt', t.ctx);
    expect(t.brainCalls.e).toHaveLength(1);
  });

  it('@waN sends [sender]: text to the bridge with chatName + chatJid', async () => {
    const t = makeCtx();
    t.state.channels = [{ name: 'Bob', jid: 'b@c.us' }];
    t.state.lastIncoming = { sender: 'An', text: 'check this' };
    await mirror('@wa1', t.ctx);
    expect(t.bridgeCalls.send).toEqual([{
      text: '[An]: check this',
      opts: { chatName: 'Bob', chatJid: 'b@c.us' },
    }]);
    expect(t.logs[0]).toContain('→ /mirror @wa1 (Bob)');
  });

  it('@waN errors when the index is not in the cached list', async () => {
    const t = makeCtx();
    t.state.channels = [{ name: 'Bob' }];
    t.state.lastIncoming = { sender: 'An', text: 'hi' };
    await mirror('@wa5', t.ctx);
    expect(t.errors[0]).toMatch(/not in cached list/);
    expect(t.bridgeCalls.send).toEqual([]);
  });

  it('@waN errors when the bridge is missing', async () => {
    const t = makeCtx({ bridge: null });
    t.state.channels = [{ name: 'Bob', jid: 'b' }];
    t.state.lastIncoming = { sender: 'An', text: 'hi' };
    await mirror('@wa1', t.ctx);
    expect(t.errors[0]).toBe('/mirror: WA-CDP bridge not ready');
  });

  it('@<session> dispatches to the named session preserving case', async () => {
    const t = makeCtx();
    t.state.sessions = new Map([['cgpt1', { brain: 'chatgpt-cdp' }]]);
    t.state.lastIncoming = { sender: 'An', text: 'do thing' };
    await mirror('@cgpt1', t.ctx);
    expect(t.brainCalls.session).toEqual([{ name: 'cgpt1', text: 'do thing', sender: 'An' }]);
  });

  it('unknown @target produces a helpful error', async () => {
    const t = makeCtx();
    t.state.lastIncoming = { sender: 'An', text: 'x' };
    await mirror('@nope', t.ctx);
    expect(t.errors[0]).toMatch(/unknown target @nope/);
  });

  it('@waN failures surface the bridge error', async () => {
    const t = makeCtx({
      bridge: { send: async () => { throw new Error('chat switch failed'); }, listChannels: async () => [] },
    });
    t.state.channels = [{ name: 'Bob', jid: 'b' }];
    t.state.lastIncoming = { sender: 'An', text: 'hi' };
    await mirror('@wa1', t.ctx);
    expect(t.errors[0]).toBe('/mirror @wa1 failed: chat switch failed');
  });
});
