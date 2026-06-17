// Locks the engine seam (src/engine/index.mjs createEngine) — the first organ
// carved out of the App's component-shaped lifecycle (Phase C): the OUTPUT
// chokepoint + the attach HOST (engine↔surface boundary) + input routing.
import { describe, it, expect, vi } from 'vitest';
import { createEngine } from '../src/engine/index.mjs';
import { mayEmitChat } from '../src/auto-mode.mjs';

// A fake attach host that captures onInput so a test can simulate a limb typing,
// and records pushed output items.
function fakeHostFactory({ port = 12345 } = {}) {
  const pushed = [];
  let onInput = null;
  let closed = false;
  const startAttachHost = vi.fn(async ({ onInput: oi }) => {
    onInput = oi;
    return { port, pushItem: (item) => pushed.push(item), close: async () => { closed = true; } };
  });
  return { startAttachHost, sendInput: (text) => onInput?.({ text }), pushed, isClosed: () => closed };
}

describe('createEngine — output + attach host seam', () => {
  it('emit fans out to every subscriber; subscribe returns an unsubscribe', () => {
    const engine = createEngine({ logger: { error() {} } });
    const a = [], b = [];
    const off = engine.subscribe((i) => a.push(i));
    engine.subscribe((i) => b.push(i));
    engine.emit({ body: 'x' });
    expect(a.map((i) => i.body)).toEqual(['x']);
    expect(b.map((i) => i.body)).toEqual(['x']);
    off();
    engine.emit({ body: 'y' });
    expect(a.map((i) => i.body)).toEqual(['x']);            // unsubscribed
    expect(b.map((i) => i.body)).toEqual(['x', 'y']);
  });

  it('startAttach boots the host, announces its port, and fans emitted items to it', async () => {
    const fake = fakeHostFactory({ port: 5555 });
    const engine = createEngine({ loadBusKey: async () => 'k', startAttachHost: fake.startAttachHost });
    const seen = [];
    engine.subscribe((i) => seen.push(i));
    await engine.startAttach();
    expect(fake.startAttachHost).toHaveBeenCalledOnce();
    expect(engine.attachPort).toBe(5555);
    expect(seen.some((i) => /attach host on 127\.0\.0\.1:5555/.test(i.body))).toBe(true);
    engine.emit({ body: 'to-limb' });
    expect(fake.pushed.some((i) => i.body === 'to-limb')).toBe(true);
  });

  it("a limb's input routes to the registered submit; input before registration is a no-op", async () => {
    const fake = fakeHostFactory();
    const engine = createEngine({ loadBusKey: async () => 'k', startAttachHost: fake.startAttachHost });
    await engine.startAttach();
    expect(() => fake.sendInput('before')).not.toThrow();   // no submit yet → swallowed
    const got = [];
    engine.setSubmit((t) => got.push(t));
    fake.sendInput('hello');
    expect(got).toEqual(['hello']);
  });

  it('engine.submit carries (text, meta) to the registered dispatch entry and isolates throws', () => {
    const engine = createEngine({ logger: { error() {} } });
    const calls = [];
    engine.setSubmit((text, meta) => { calls.push([text, meta]); });
    engine.submit('hola', { surface: 'wa', chatId: 'c1' });
    expect(calls).toEqual([['hola', { surface: 'wa', chatId: 'c1' }]]);
    // a throwing dispatch entry must not escape submit()
    engine.setSubmit(() => { throw new Error('boom'); });
    expect(() => engine.submit('x')).not.toThrow();
  });

  it('startAttach is idempotent (one host)', async () => {
    const fake = fakeHostFactory();
    const engine = createEngine({ loadBusKey: async () => 'k', startAttachHost: fake.startAttachHost });
    await engine.startAttach();
    await engine.startAttach();
    expect(fake.startAttachHost).toHaveBeenCalledOnce();
  });

  it('startAttach without loadBusKey throws (it must be wired)', async () => {
    const engine = createEngine({ startAttachHost: fakeHostFactory().startAttachHost });
    await expect(engine.startAttach()).rejects.toThrow(/loadBusKey/);
  });

  it('a failing host is reported, not thrown, and the engine stays usable', async () => {
    const errs = [];
    const engine = createEngine({
      logger: { error: (m) => errs.push(m) },
      loadBusKey: async () => 'k',
      startAttachHost: async () => { throw new Error('port in use'); },
    });
    const seen = [];
    engine.subscribe((i) => seen.push(i));
    await expect(engine.startAttach()).resolves.toBeNull();
    expect(errs.some((m) => /port in use/.test(m))).toBe(true);
    expect(seen.some((i) => /attach host failed/.test(i.body))).toBe(true);
  });

  it('the emit gate (I4) is fail-CLOSED until configured', () => {
    const engine = createEngine({ logger: { error() {} } });
    // No configureGate yet → resolver defaults to 'off' → autoMayEmitChat denies.
    expect(engine.mayEmit('chatX', { replyAllowed: true })).toBe(false);
  });

  it('engine.mayEmit honors the wired pause source + chat-mode resolver (matches the canonical gate)', () => {
    const logs = [];
    const engine = createEngine({ logger: { error() {} } });
    let paused = false;
    let mode = 'on';
    engine.configureGate({ resolveChatMode: () => mode, isPaused: () => paused, log: (m) => logs.push(m) });

    // Verdict tracks the canonical autoMayEmitChat for the wired mode/pause.
    expect(engine.mayEmit('c', { replyAllowed: true }))
      .toBe(mayEmitChat({ paused: false, mode: 'on', replyAllowed: true }));

    // 'off' mode → hard block, logged with the mode line.
    mode = 'off';
    expect(engine.mayEmit('c', { replyAllowed: true })).toBe(false);
    expect(logs.some((m) => /BLOCKED \(mode=off/.test(m))).toBe(true);

    // paused → absolute kill, logged with the pause line (overrides mode).
    paused = true; mode = 'on';
    expect(engine.mayEmit('c', { replyAllowed: true })).toBe(false);
    expect(logs.some((m) => /auto_e_paused \(global kill\)/.test(m))).toBe(true);
  });

  it('stop() closes the host and stops fanning output to it', async () => {
    const fake = fakeHostFactory();
    const engine = createEngine({ loadBusKey: async () => 'k', startAttachHost: fake.startAttachHost });
    await engine.startAttach();
    await engine.stop();
    expect(fake.isClosed()).toBe(true);
    engine.emit({ body: 'after-stop' });
    expect(fake.pushed.some((i) => i.body === 'after-stop')).toBe(false);
  });
});
