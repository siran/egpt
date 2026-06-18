import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { mockHome } = vi.hoisted(() => ({ mockHome: { current: '' } }));

vi.mock('node:os', async () => {
  const actual = await vi.importActual('node:os');
  return {
    ...actual,
    homedir: () => mockHome.current,
  };
});

const tempHomes = [];

afterEach(() => {
  vi.resetModules();
  while (tempHomes.length) {
    rmSync(tempHomes.pop(), { recursive: true, force: true });
  }
});

async function loadWithTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'egpt-outbox-send-'));
  tempHomes.push(home);
  mockHome.current = home;
  vi.resetModules();
  const mod = await import('../src/tools/outbox-send.mjs');
  return { home, mod };
}

describe('outboxSend', () => {
  it('writes an atomic final event into the mocked EGPT home outbox', async () => {
    const { home, mod } = await loadWithTempHome();

    const result = await mod.outboxSend({ type: 'slash', cmd: '/identity' }, { from: 'test-subproc' });

    const outboxDir = join(home, '.egpt', 'outbox');
    expect(mod.OUTBOX_DIR).toBe(outboxDir);
    expect(result.filename).toMatch(/^\d+-[0-9a-f-]+\.json$/);
    expect(readdirSync(outboxDir).filter((name) => name.startsWith('.tmp-'))).toEqual([]);
    expect(existsSync(join(outboxDir, result.filename))).toBe(true);
    expect(JSON.parse(readFileSync(join(outboxDir, result.filename), 'utf8'))).toEqual(result.posted);
    expect(result.posted).toMatchObject({ from: 'test-subproc', type: 'slash', cmd: '/identity' });
    expect(typeof result.posted.ts).toBe('number');
  });

  it('validates the event shape', async () => {
    const { mod } = await loadWithTempHome();

    await expect(mod.outboxSend(null)).rejects.toThrow(/object with a type/);
    await expect(mod.outboxSend({})).rejects.toThrow(/object with a type/);
  });
});

describe('waSend', () => {
  it('posts a wa-send event with the custom sender', async () => {
    const { home, mod } = await loadWithTempHome();

    const result = await mod.waSend({ jid: '123@s.whatsapp.net', body: 'hola', from: 'unit-test' });

    expect(result.posted).toMatchObject({
      from: 'unit-test',
      type: 'wa-send',
      jid: '123@s.whatsapp.net',
      body: 'hola',
    });
    expect(JSON.parse(readFileSync(join(home, '.egpt', 'outbox', result.filename), 'utf8'))).toEqual(result.posted);
  });

  it('requires jid and body', async () => {
    const { mod } = await loadWithTempHome();

    await expect(mod.waSend({ jid: '123@s.whatsapp.net' })).rejects.toThrow(/jid and body required/);
    await expect(mod.waSend({ body: 'hola' })).rejects.toThrow(/jid and body required/);
  });
});
