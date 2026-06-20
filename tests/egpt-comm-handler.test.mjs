import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createInProcessStreamChannel,
  createStreamProxy,
  createStreamRegistry,
  startInboxWatcher,
  startOutboxWatcher,
  writeIpcEvent,
} from '../src/egpt-comm-handler.mjs';

const tempDirs = [];
const stopFns = [];

afterEach(() => {
  while (stopFns.length) {
    try { stopFns.pop()(); } catch {}
  }
  while (tempDirs.length) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function tempDir() {
  const root = mkdtempSync(join(tmpdir(), 'egpt-comm-'));
  const dir = join(root, 'box');
  mkdirSync(dir);
  tempDirs.push(root);
  return dir;
}

function writeEvent(dir, name, payload, { bom = false } = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  writeFileSync(join(dir, name), `${bom ? '\uFEFF' : ''}${body}`);
}

async function waitFor(cond, ms = 2000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('stream registry', () => {
  it('drives bridge streams and reports finish results', async () => {
    const calls = [];
    const bridge = {
      startStreamMessage(initialText, opts) {
        calls.push({ initialText, opts, updates: [], finished: [] });
        const call = calls.at(-1);
        return {
          delivered: true,
          lastError: null,
          update: (text) => call.updates.push(text),
          finish: async (text) => call.finished.push(text),
        };
      },
    };
    const registry = createStreamRegistry(bridge);

    registry.open({ streamId: 's1', chatId: 'chat-1', initialText: 'draft', persona: 'e' });
    registry.open({ streamId: 's1', chatId: 'chat-1', initialText: 'duplicate' });
    registry.update({ streamId: 's1', text: 'draft v2' });
    const result = await registry.finish({ streamId: 's1', text: 'final' });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ initialText: 'draft', opts: { chatId: 'chat-1', persona: 'e' } });
    expect(calls[0].updates).toEqual(['draft v2']);
    expect(calls[0].finished).toEqual(['final']);
    expect(result).toEqual({ streamId: 's1', delivered: true, lastError: null });
    expect(registry.size()).toBe(0);
  });

  it('forwards showThink through to the bridge stream options', () => {
    const calls = [];
    const registry = createStreamRegistry({
      startStreamMessage(initialText, opts) {
        calls.push({ initialText, opts });
        return { update() {}, async finish() {}, delivered: true, lastError: null };
      },
    });

    registry.open({ streamId: 's1', chatId: 'chat-1', initialText: 'draft', persona: 'e', showThink: true });

    expect(calls).toEqual([{
      initialText: 'draft',
      opts: { chatId: 'chat-1', persona: 'e', showThink: true },
    }]);
  });

  it('returns a miss result and cancels pending streams on restart', async () => {
    const registry = createStreamRegistry({
      startStreamMessage() {
        return { update() {}, async finish() {}, delivered: false, lastError: 'bridge failed' };
      },
    });

    expect(await registry.finish({ streamId: 'missing', text: 'x' }))
      .toEqual({ streamId: 'missing', delivered: false, lastError: 'no such stream' });

    registry.open({ streamId: 's2', chatId: 'chat-2', initialText: 'pending' });
    expect(registry.cancelAll('keeper restarted')).toEqual([
      { streamId: 's2', delivered: false, lastError: 'keeper restarted' },
    ]);
    expect(registry.size()).toBe(0);
  });

  it('validates the bridge surface', () => {
    expect(() => createStreamRegistry({})).toThrow(/startStreamMessage missing/);
  });
});

describe('stream proxy and in-process stream channel', () => {
  it('emits immediate updates, finish events, and records the result', async () => {
    const events = [];
    const stream = createStreamProxy({
      streamId: 's1',
      sendEvent: (event) => events.push(event),
      awaitResult: async (streamId, timeoutMs) => ({ streamId, timeoutMs, delivered: true, lastError: null }),
      finishTimeoutMs: 25,
    });

    stream.update('one');
    await stream.finish('done');
    stream.update('ignored');

    expect(events.map((event) => [event.type, event.text])).toEqual([
      ['wa-stream-update', 'one'],
      ['wa-stream-finish', 'done'],
    ]);
    expect(stream.delivered).toBe(true);
    expect(stream.lastError).toBe(null);
    expect(stream.finalized).toBe(true);
  });

  it('coalesces updates when configured', async () => {
    const events = [];
    const stream = createStreamProxy({
      streamId: 's1',
      sendEvent: (event) => events.push(event),
      awaitResult: async () => ({ delivered: true }),
      updateCoalesceMs: 20,
    });

    stream.update('one');
    stream.update('two');
    expect(events).toEqual([]);
    await waitFor(() => events.length === 1);
    expect(events[0]).toMatchObject({ type: 'wa-stream-update', text: 'two' });
  });

  it('round-trips through the in-process stream channel', async () => {
    const started = [];
    const bridge = {
      startStreamMessage(initialText, opts) {
        const call = { initialText, opts, updates: [], finished: [] };
        started.push(call);
        return {
          delivered: true,
          lastError: null,
          update: (text) => call.updates.push(text),
          finish: async (text) => call.finished.push(text),
        };
      },
    };
    const { makeStream, registry } = createInProcessStreamChannel(bridge);

    const stream = makeStream('hello', { chatId: 'chat-1', persona: 'wren', showThink: true }, { finishTimeoutMs: 100 });
    stream.update('partial');
    await stream.finish('final');

    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ initialText: 'hello', opts: { chatId: 'chat-1', persona: 'wren', showThink: true } });
    expect(started[0].updates).toEqual(['partial']);
    expect(started[0].finished).toEqual(['final']);
    expect(stream.delivered).toBe(true);
    expect(stream.lastError).toBe(null);
    expect(registry.size()).toBe(0);
  });

  it('validates proxy inputs', () => {
    expect(() => createStreamProxy()).toThrow(/streamId required/);
    expect(() => createStreamProxy({ streamId: 's' })).toThrow(/sendEvent required/);
    expect(() => createStreamProxy({ streamId: 's', sendEvent() {} })).toThrow(/awaitResult required/);
  });
});

describe('writeIpcEvent', () => {
  it('writes an atomic final JSON payload', async () => {
    const dir = tempDir();
    const { filename, posted } = await writeIpcEvent({ type: 'wa-inbound', text: 'hi' }, { dir, from: 'keeper-test' });

    expect(filename).toMatch(/^\d+-[0-9a-f-]+\.json$/);
    expect(posted).toMatchObject({ from: 'keeper-test', type: 'wa-inbound', text: 'hi' });
    expect(readdirSync(dir).filter((name) => name.startsWith('.tmp-'))).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, filename), 'utf8'))).toEqual(posted);
  });

  it('validates required inputs', async () => {
    await expect(writeIpcEvent(null, { dir: tempDir() })).rejects.toThrow(/object with a type/);
    await expect(writeIpcEvent({ type: 'x' })).rejects.toThrow(/dir is required/);
  });
});

describe('inbox watcher', () => {
  it('consumes BOM-prefixed JSON events and unlinks the file', async () => {
    const dir = tempDir();
    const file = join(dir, '001.json');
    const events = [];
    writeEvent(dir, '001.json', { type: 'wa-inbound', text: 'hola' }, { bom: true });

    stopFns.push(startInboxWatcher({
      inboxDir: dir,
      onEvent: (event) => { events.push(event); return true; },
    }));

    await waitFor(() => events.length === 1 && !existsSync(file));
    expect(events[0]).toEqual({ type: 'wa-inbound', text: 'hola' });
  });

  it('keeps unconsumed events for retry', async () => {
    const dir = tempDir();
    const file = join(dir, 'retry.json');
    const events = [];
    writeEvent(dir, 'retry.json', { type: 'wa-inbound', text: 'later' });

    stopFns.push(startInboxWatcher({
      inboxDir: dir,
      onEvent: (event) => { events.push(event); return false; },
    }));

    await waitFor(() => events.length === 1);
    expect(existsSync(file)).toBe(true);
  });

  it('drops malformed JSON and logs the parse error', async () => {
    const dir = tempDir();
    const file = join(dir, 'bad.json');
    const logs = [];
    writeEvent(dir, 'bad.json', '{nope');

    stopFns.push(startInboxWatcher({
      inboxDir: dir,
      onEvent: () => true,
      log: (msg) => logs.push(msg),
    }));

    await waitFor(() => logs.length === 1 && !existsSync(file));
    expect(logs[0]).toMatch(/dropping bad\.json/);
  });

  it('validates required inputs', () => {
    expect(() => startInboxWatcher({ inboxDir: tempDir() })).toThrow(/onEvent is required/);
    expect(() => startInboxWatcher({ onEvent() {} })).toThrow(/inboxDir is required/);
  });
});

describe('outbox watcher', () => {
  it('dispatches wa-send and unlinks on success', async () => {
    const dir = tempDir();
    const file = join(dir, 'send.json');
    const seen = [];
    writeEvent(dir, 'send.json', { type: 'wa-send', jid: '123@s.whatsapp.net', body: 'hi' });

    stopFns.push(startOutboxWatcher({
      outboxDir: dir,
      dispatchWaSend: async (payload, src) => { seen.push({ payload, src }); return true; },
    }));

    await waitFor(() => seen.length === 1 && !existsSync(file));
    expect(seen[0]).toMatchObject({ src: 'outbox', payload: { type: 'wa-send', body: 'hi' } });
  });

  it('keeps wa-send files when the bridge cannot consume them yet', async () => {
    const dir = tempDir();
    const file = join(dir, 'send.json');
    let calls = 0;
    writeEvent(dir, 'send.json', { type: 'wa-send', jid: '123@s.whatsapp.net', body: 'hi' });

    stopFns.push(startOutboxWatcher({
      outboxDir: dir,
      dispatchWaSend: async () => { calls += 1; return false; },
    }));

    await waitFor(() => calls === 1);
    expect(existsSync(file)).toBe(true);
  });

  it('dispatches slash and butler-task events through their dedicated handlers', async () => {
    const dir = tempDir();
    const seen = [];
    writeEvent(dir, 'slash.json', { type: 'slash', cmd: '/identity' });
    writeEvent(dir, 'butler.json', { type: 'butler-task', prompt: 'summarize' });

    stopFns.push(startOutboxWatcher({
      outboxDir: dir,
      dispatchWaSend: async () => { throw new Error('unexpected wa-send'); },
      dispatchSlash: async (payload, src) => { seen.push(['slash', src, payload.cmd]); return true; },
      dispatchButlerTask: async (payload, src) => { seen.push(['butler', src, payload.prompt]); return true; },
    }));

    await waitFor(() => seen.length === 2);
    expect(seen).toEqual(expect.arrayContaining([
      ['slash', 'outbox', '/identity'],
      ['butler', 'outbox', 'summarize'],
    ]));
    expect(existsSync(join(dir, 'slash.json'))).toBe(false);
    expect(existsSync(join(dir, 'butler.json'))).toBe(false);
  });

  it('signals daemon restart after unlinking the restart event', async () => {
    const dir = tempDir();
    const file = join(dir, 'restart.json');
    const logs = [];
    const restarts = [];
    writeEvent(dir, 'restart.json', { type: 'daemon-restart', from: 'test' });

    stopFns.push(startOutboxWatcher({
      outboxDir: dir,
      dispatchWaSend: async () => true,
      log: (msg) => logs.push(msg),
      signalRestart: (payload) => restarts.push(payload),
    }));

    await waitFor(() => restarts.length === 1 && !existsSync(file));
    expect(logs[0]).toMatch(/daemon-restart from test/);
    expect(restarts[0]).toMatchObject({ type: 'daemon-restart', from: 'test' });
  });

  it('quarantines unknown event types', async () => {
    const dir = tempDir();
    const logs = [];
    writeEvent(dir, 'mystery.json', { type: 'mystery' });

    stopFns.push(startOutboxWatcher({
      outboxDir: dir,
      dispatchWaSend: async () => true,
      log: (msg) => logs.push(msg),
    }));

    const quarantined = join(dir, '..', 'outbox-quarantine', 'mystery.json');
    await waitFor(() => existsSync(quarantined));
    expect(logs[0]).toMatch(/unknown type mystery/);
    expect(existsSync(join(dir, 'mystery.json'))).toBe(false);
  });

  it('validates required inputs', () => {
    expect(() => startOutboxWatcher({ outboxDir: tempDir() })).toThrow(/dispatchWaSend is required/);
    expect(() => startOutboxWatcher({ dispatchWaSend() {} })).toThrow(/outboxDir is required/);
  });
});
