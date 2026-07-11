// tests/bus-key-load.test.mjs — shell-side key bootstrap.
// Pins the precedence env > file > generate-and-save.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadOrCreateBusKey } from '../src/tools/bus.mjs';

let tmpDir;
let keyPath;
const origEnv = process.env.EGPT_BUS_KEY;

async function loadWithoutExistingFile(options) {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const key = await loadOrCreateBusKey(options);
    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('ENOENT'));
    return key;
  } finally {
    consoleError.mockRestore();
  }
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'egpt-buskey-'));
  keyPath = path.join(tmpDir, 'bus.key');
  delete process.env.EGPT_BUS_KEY;
});

afterEach(async () => {
  if (origEnv === undefined) delete process.env.EGPT_BUS_KEY;
  else process.env.EGPT_BUS_KEY = origEnv;
  try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

describe('loadOrCreateBusKey', () => {
  it('returns env var when set, ignoring file + generation', async () => {
    process.env.EGPT_BUS_KEY = 'env-supplied-key';
    // File exists with a different value — env wins
    await fs.writeFile(keyPath, 'file-value');
    const got = await loadOrCreateBusKey({ keyPath });
    expect(got).toBe('env-supplied-key');
  });

  it('trims whitespace from the env var', async () => {
    process.env.EGPT_BUS_KEY = '   spaced  \n';
    const got = await loadOrCreateBusKey({ keyPath });
    expect(got).toBe('spaced');
  });

  it('reads the file when env is unset', async () => {
    await fs.writeFile(keyPath, 'file-key-value\n');
    const got = await loadOrCreateBusKey({ keyPath });
    expect(got).toBe('file-key-value');
  });

  it('ignores an empty file and generates fresh', async () => {
    await fs.writeFile(keyPath, '   \n   ');
    const got = await loadOrCreateBusKey({ keyPath });
    expect(typeof got).toBe('string');
    expect(got.length).toBeGreaterThan(20);   // base64url 32-byte ≈ 43 chars
    // The fresh key got persisted
    const onDisk = (await fs.readFile(keyPath, 'utf8')).trim();
    expect(onDisk).toBe(got);
  });

  it('generates + persists when no file and no env', async () => {
    const got = await loadWithoutExistingFile({ keyPath });
    expect(typeof got).toBe('string');
    expect(got).not.toMatch(/[+/=]/);
    const onDisk = (await fs.readFile(keyPath, 'utf8')).trim();
    expect(onDisk).toBe(got);
  });

  it('creates the parent directory if missing', async () => {
    const deeper = path.join(tmpDir, 'a', 'b', 'bus.key');
    const got = await loadWithoutExistingFile({ keyPath: deeper });
    expect(typeof got).toBe('string');
    const stat = await fs.stat(deeper);
    expect(stat.isFile()).toBe(true);
  });

  it('uses the same value on a second read (idempotent)', async () => {
    const first = await loadWithoutExistingFile({ keyPath });
    const second = await loadOrCreateBusKey({ keyPath });
    expect(second).toBe(first);
  });
});
