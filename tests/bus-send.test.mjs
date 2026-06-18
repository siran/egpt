import { afterEach, describe, expect, it, vi } from 'vitest';

const { busApi } = vi.hoisted(() => ({
  busApi: {
    loadOrCreateBusKey: vi.fn(),
    setBusKey: vi.fn(),
    findOrOpenBusTab: vi.fn(),
    postEvent: vi.fn(),
  },
}));

vi.mock('../src/tools/bus.mjs', () => busApi);

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  for (const fn of Object.values(busApi)) fn.mockReset();
});

async function loadBusSend() {
  vi.resetModules();
  return import('../src/tools/bus-send.mjs');
}

function mockRunningBus({ targetId = 'target-1', key = 'bus-key' } = {}) {
  busApi.loadOrCreateBusKey.mockResolvedValue(key);
  busApi.findOrOpenBusTab.mockResolvedValue({ targetId });
  busApi.postEvent.mockResolvedValue(undefined);
  return { targetId, key };
}

describe('busSend', () => {
  it('loads the key, finds the running bus tab, posts, and returns the target id', async () => {
    const { targetId, key } = mockRunningBus();
    vi.spyOn(Date, 'now').mockReturnValue(12345);
    const { busSend } = await loadBusSend();

    const result = await busSend({ type: 'slash', cmd: '/identity' }, { from: 'unit-test' });

    expect(busApi.loadOrCreateBusKey).toHaveBeenCalledTimes(1);
    expect(busApi.setBusKey).toHaveBeenCalledWith(key);
    expect(busApi.findOrOpenBusTab).toHaveBeenCalledWith({ open: false });
    expect(busApi.postEvent).toHaveBeenCalledWith(targetId, {
      from: 'unit-test',
      ts: 12345,
      type: 'slash',
      cmd: '/identity',
    });
    expect(result).toEqual({
      targetId,
      posted: { from: 'unit-test', ts: 12345, type: 'slash', cmd: '/identity' },
    });
  });

  it('throws clearly when no daemon-owned bus tab is present', async () => {
    busApi.loadOrCreateBusKey.mockResolvedValue('key');
    busApi.findOrOpenBusTab.mockResolvedValue(null);
    const { busSend } = await loadBusSend();

    await expect(busSend({ type: 'slash', cmd: '/who' })).rejects.toThrow(/no bus tab/);
    expect(busApi.postEvent).not.toHaveBeenCalled();
  });

  it('validates the event shape before touching the bus', async () => {
    const { busSend } = await loadBusSend();

    await expect(busSend(null)).rejects.toThrow(/object with a type/);
    await expect(busSend({})).rejects.toThrow(/object with a type/);
    expect(busApi.loadOrCreateBusKey).not.toHaveBeenCalled();
  });
});

describe('waSend', () => {
  it('posts a wa-send payload and includes to_node when supplied', async () => {
    mockRunningBus({ targetId: 'wa-target' });
    vi.spyOn(Date, 'now').mockReturnValue(67890);
    const { waSend } = await loadBusSend();

    const result = await waSend({
      jid: '123@s.whatsapp.net',
      body: 'hola',
      toNode: 'node-1',
      from: 'unit-test',
    });

    expect(busApi.postEvent).toHaveBeenCalledWith('wa-target', {
      from: 'unit-test',
      ts: 67890,
      type: 'wa-send',
      jid: '123@s.whatsapp.net',
      body: 'hola',
      to_node: 'node-1',
    });
    expect(result.posted).toMatchObject({
      type: 'wa-send',
      jid: '123@s.whatsapp.net',
      body: 'hola',
      to_node: 'node-1',
    });
  });

  it('requires jid and body', async () => {
    const { waSend } = await loadBusSend();

    await expect(waSend({ jid: '123@s.whatsapp.net' })).rejects.toThrow(/jid and body required/);
    await expect(waSend({ body: 'hola' })).rejects.toThrow(/jid and body required/);
    expect(busApi.loadOrCreateBusKey).not.toHaveBeenCalled();
  });
});
