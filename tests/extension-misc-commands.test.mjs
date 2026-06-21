// tests/extension-misc-commands.test.mjs — execution tests for the
// CHROME EXTENSION's misc command set (extension/src/commands/
// misc-commands.js: config, telegram, clear, help). The shell has
// separate slash/{config,telegram,help}.mjs implementations not
// covered here.

import { describe, it, expect } from 'vitest';
import { config, telegram, clear, help, busKey }
  from '../extension/src/commands/misc-commands.js';

function makeStorage(initial = {}) {
  let store = JSON.parse(JSON.stringify(initial));
  return {
    store,
    get: async (key) => key == null ? store : { [key]: store[key] },
    set: async (obj) => { Object.assign(store, obj); },
  };
}

describe('/config', () => {
  it('dumps sync + local when called without args', async () => {
    const sync  = makeStorage({ a: 1 });
    const local = makeStorage({ b: 2 });
    const logs = [];
    await config('', { log: (t) => logs.push(t), storageSync: sync, storageLocal: local });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('"sync"');
    expect(logs[0]).toContain('"a": 1');
    expect(logs[0]).toContain('"b": 2');
  });

  it('sets a string value when JSON parse fails', async () => {
    const sync = makeStorage();
    const local = makeStorage();
    const logs = [];
    await config('userName An', { log: (t) => logs.push(t), storageSync: sync, storageLocal: local });
    expect(sync.store.userName).toBe('An');
    expect(logs[0]).toBe('Set userName = "An"');
  });

  it('parses JSON values', async () => {
    const sync = makeStorage();
    const local = makeStorage();
    await config('whatsapp {"enabled":true}', {
      log: () => {}, storageSync: sync, storageLocal: local,
    });
    expect(sync.store.whatsapp).toEqual({ enabled: true });
  });

  it('triggers onTelegramConfigChange when key is "telegram"', async () => {
    const sync = makeStorage();
    const local = makeStorage();
    let restarts = 0;
    await config('telegram {"bot_token":"abc"}', {
      log: () => {}, storageSync: sync, storageLocal: local,
      onTelegramConfigChange: () => { restarts++; },
    });
    expect(restarts).toBe(1);
    expect(sync.store.telegram).toEqual({ bot_token: 'abc' });
  });

  it('does not call onTelegramConfigChange for other keys', async () => {
    const sync = makeStorage();
    const local = makeStorage();
    let restarts = 0;
    await config('userName An', {
      log: () => {}, storageSync: sync, storageLocal: local,
      onTelegramConfigChange: () => { restarts++; },
    });
    expect(restarts).toBe(0);
  });
});

function makeTgCtx(overrides = {}) {
  const logs = [];
  const errors = [];
  const sync = makeStorage(overrides.initialStorage ?? {});
  const state = {
    nodeId: 'chrome-X',
    polling: false,
    peers: new Map(),
    tid: 'BUS-TID',
    bridgeStartCalls: 0,
    bridgeStopCalls: 0,
    busPosts: [],
  };
  const ctx = {
    log:    (t) => logs.push(t),
    error:  (t) => errors.push(t),
    storageSync: sync,
    getNodeId:    () => state.nodeId,
    getTgPolling: () => state.polling,
    startBridge: async () => { state.bridgeStartCalls++; state.polling = true; },
    stopBridge:  async () => { state.bridgeStopCalls++; state.polling = false; },
    getPeerNodes: () => state.peers,
    busTargetId:  () => state.tid,
    postBusEvent: async (tid, ev) => { state.busPosts.push({ tid, ev }); },
  };
  Object.assign(ctx, overrides.ctxOverrides ?? {});
  return { ctx, logs, errors, state, sync };
}

describe('/telegram', () => {
  it('reports status and lists peers when no arg', async () => {
    const t = makeTgCtx();
    t.state.peers.set('shell-A', { role: 'shell', polling: true });
    await telegram('', t.ctx);
    expect(t.logs[0]).toContain('chrome-X  (this extension)  idle');
    expect(t.logs[0]).toContain('shell-A  (shell)  polling');
    expect(t.logs[0]).toContain('/telegram <node>');
  });

  it('disconnect stops the bridge when polling', async () => {
    const t = makeTgCtx();
    t.state.polling = true;
    await telegram('disconnect', t.ctx);
    expect(t.state.bridgeStopCalls).toBe(1);
    expect(t.logs[0]).toBe('telegram: disconnected');
  });

  it('disconnect is a noop when not polling', async () => {
    const t = makeTgCtx();
    await telegram('disconnect', t.ctx);
    expect(t.state.bridgeStopCalls).toBe(0);
    expect(t.logs[0]).toBe('telegram: not polling on this extension');
  });

  it('allow appends a numeric user id to allowed_users', async () => {
    const t = makeTgCtx({ initialStorage: { telegram: { bot_token: 'x', allowed_users: [10] } } });
    await telegram('allow 42', t.ctx);
    expect(t.sync.store.telegram.allowed_users).toEqual([10, 42]);
    expect(t.logs[0]).toBe('telegram: allowed user 42');
  });

  it('allow tolerates leading @ on the id', async () => {
    const t = makeTgCtx({ initialStorage: { telegram: {} } });
    await telegram('allow @42', t.ctx);
    expect(t.sync.store.telegram.allowed_users).toEqual([42]);
  });

  it('allow rejects non-numeric ids', async () => {
    const t = makeTgCtx();
    await telegram('allow not-a-number', t.ctx);
    expect(t.errors[0]).toContain('numeric Telegram id');
  });

  it('revoke removes an existing id', async () => {
    const t = makeTgCtx({ initialStorage: { telegram: { allowed_users: [10, 42] } } });
    await telegram('revoke 10', t.ctx);
    expect(t.sync.store.telegram.allowed_users).toEqual([42]);
    expect(t.logs[0]).toBe('telegram: revoked user 10');
  });

  it('allowed lists ids', async () => {
    const t = makeTgCtx({ initialStorage: { telegram: { allowed_users: [1, 2] } } });
    await telegram('allowed', t.ctx);
    expect(t.logs[0]).toContain('1');
    expect(t.logs[0]).toContain('2');
  });

  it('allowed reports empty list with helpful message', async () => {
    const t = makeTgCtx();
    await telegram('allowed', t.ctx);
    expect(t.logs[0]).toMatch(/no allowed users/);
  });

  it('handoff to self starts the bridge', async () => {
    const t = makeTgCtx();
    await telegram('chrome-X', t.ctx);
    expect(t.state.bridgeStartCalls).toBe(1);
  });

  it('handoff to "chrome" alias starts the bridge', async () => {
    const t = makeTgCtx();
    await telegram('chrome', t.ctx);
    expect(t.state.bridgeStartCalls).toBe(1);
  });

  it('handoff to a known peer posts a bus event', async () => {
    const t = makeTgCtx();
    t.state.peers.set('shell-A', { role: 'shell' });
    await telegram('shell-A', t.ctx);
    expect(t.state.busPosts).toHaveLength(1);
    expect(t.state.busPosts[0].ev.type).toBe('telegram-handoff');
    expect(t.state.busPosts[0].ev.to).toBe('shell-A');
  });

  it('handoff to a role with one match resolves to the node id', async () => {
    const t = makeTgCtx();
    t.state.peers.set('shell-1', { role: 'shell' });
    await telegram('shell', t.ctx);
    expect(t.state.busPosts[0].ev.to).toBe('shell-1');
  });

  it('handoff to ambiguous role errors', async () => {
    const t = makeTgCtx();
    t.state.peers.set('shell-1', { role: 'shell' });
    t.state.peers.set('shell-2', { role: 'shell' });
    await telegram('shell', t.ctx);
    expect(t.errors[0]).toContain('ambiguous role');
    expect(t.state.busPosts).toEqual([]);
  });

  it('handoff to unknown peer errors', async () => {
    const t = makeTgCtx();
    await telegram('nope', t.ctx);
    expect(t.errors[0]).toContain('no peer "nope"');
  });

  it('handoff requires bus to be joined', async () => {
    const t = makeTgCtx({ ctxOverrides: { busTargetId: () => null } });
    await telegram('shell-A', t.ctx);
    expect(t.errors[0]).toBe('bus not joined — handoff requires bus');
  });

  it('handoff stops local polling before posting', async () => {
    const t = makeTgCtx();
    t.state.polling = true;
    t.state.peers.set('shell-A', { role: 'shell' });
    await telegram('shell-A', t.ctx);
    expect(t.state.bridgeStopCalls).toBe(1);
    expect(t.state.busPosts).toHaveLength(1);
  });
});

function makeLocalStorage(initial = {}) {
  let store = { ...initial };
  return {
    store,
    get: async (key) => key == null ? store : { [key]: store[key] },
    set: async (obj) => { Object.assign(store, obj); },
    remove: async (key) => { delete store[key]; },
  };
}

describe('/bus-key', () => {
  it('reports "none configured" when no key set', async () => {
    const local = makeLocalStorage();
    const logs = [];
    await busKey('', { log: (t) => logs.push(t), error: () => {}, storageLocal: local, generateKey: async () => 'fake-key' });
    expect(logs[0]).toMatch(/none configured/);
  });

  it('prints the current key when set', async () => {
    const local = makeLocalStorage({ bus_key: 'AAAA-BBBB-CCCC' });
    const logs = [];
    await busKey('', { log: (t) => logs.push(t), error: () => {}, storageLocal: local, generateKey: async () => '' });
    expect(logs[0]).toContain('AAAA-BBBB-CCCC');
    expect(logs[0]).toMatch(/signing on/);
  });

  it('gen creates + stores + prints a fresh key', async () => {
    const local = makeLocalStorage();
    const logs = [];
    let genCalls = 0;
    await busKey('gen', {
      log: (t) => logs.push(t), error: () => {},
      storageLocal: local,
      generateKey: async () => { genCalls++; return 'NEWKEY-123'; },
    });
    expect(genCalls).toBe(1);
    expect(local.store.bus_key).toBe('NEWKEY-123');
    expect(logs[0]).toContain('NEWKEY-123');
    expect(logs[0]).toContain('generated');
  });

  it('set <key> persists the supplied key', async () => {
    const local = makeLocalStorage();
    const logs = [];
    await busKey('set MANUAL-KEY', {
      log: (t) => logs.push(t), error: () => {},
      storageLocal: local, generateKey: async () => '',
    });
    expect(local.store.bus_key).toBe('MANUAL-KEY');
    expect(logs[0]).toMatch(/Signing on/);
  });

  it('set without a value errors', async () => {
    const local = makeLocalStorage();
    const errors = [];
    await busKey('set', {
      log: () => {}, error: (t) => errors.push(t),
      storageLocal: local, generateKey: async () => '',
    });
    expect(errors[0]).toMatch(/value required/);
    expect(local.store.bus_key).toBeUndefined();
  });

  it('clear removes the key', async () => {
    const local = makeLocalStorage({ bus_key: 'X' });
    const logs = [];
    await busKey('clear', {
      log: (t) => logs.push(t), error: () => {},
      storageLocal: local, generateKey: async () => '',
    });
    expect(local.store.bus_key).toBeUndefined();
    expect(logs[0]).toMatch(/Signing off/);
  });

  it('rejects unknown subcommand with helpful error', async () => {
    const local = makeLocalStorage();
    const errors = [];
    await busKey('rotate', {
      log: () => {}, error: (t) => errors.push(t),
      storageLocal: local, generateKey: async () => '',
    });
    expect(errors[0]).toMatch(/unknown subcommand "rotate"/);
  });
});

describe('/clear', () => {
  it('calls clearMessages', async () => {
    let cleared = 0;
    await clear('', { clearMessages: () => { cleared++; } });
    expect(cleared).toBe(1);
  });
});

describe('/help', () => {
  it('emits formatted help text', async () => {
    const logs = [];
    await help('', {
      log: (t) => logs.push(t),
      getBrainNames: () => ['gpt', 'claude'],
      formatHelp: (names) => `HELP[${names.join(',')}]`,
    });
    expect(logs[0]).toBe('HELP[gpt,claude]');
  });
});
