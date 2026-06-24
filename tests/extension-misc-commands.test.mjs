// tests/extension-misc-commands.test.mjs — execution tests for the
// CHROME EXTENSION's misc command set (extension/src/commands/
// misc-commands.js: config, clear, help). The shell has
// separate slash/{config,help}.mjs implementations not
// covered here.

import { describe, it, expect } from 'vitest';
import { config, clear, help, busKey }
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
