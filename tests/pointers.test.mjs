import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { seedPointers, POINTERS_TEXT } from '../src/pointers.mjs';

const fs = { readFile, writeFile };

describe('seedPointers — per-conversation reference card', () => {
  it('writes ./pointers.md when the folder has none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'egpt-ptr-'));
    try {
      const wrote = await seedPointers(fs, dir);
      expect(wrote).toBe(true);
      const body = readFileSync(join(dir, 'pointers.md'), 'utf8');
      expect(body).toBe(POINTERS_TEXT);
      // the content must reflect the REAL current tools, not the stale CDP-only card
      expect(body).toContain('WebSearch');
      expect(body).toContain('WebFetch');
      expect(body).toContain('./transcript.md');
      expect(body).toMatch(/can.?t access the internet/i);   // the "you CAN" correction
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('does NOT clobber an existing (operator-customized) card', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'egpt-ptr-'));
    try {
      writeFileSync(join(dir, 'pointers.md'), 'MY CUSTOM CARD');
      const wrote = await seedPointers(fs, dir);
      expect(wrote).toBe(false);
      expect(readFileSync(join(dir, 'pointers.md'), 'utf8')).toBe('MY CUSTOM CARD');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('is a safe no-op without fs or dir', async () => {
    expect(await seedPointers(null, '/x')).toBe(false);
    expect(await seedPointers(fs, '')).toBe(false);
  });
});
