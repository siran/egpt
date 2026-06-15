// Locks the per-ENTITY transcription service config (operator 2026-06-15):
// transcription is a surface-independent ROOM service living in the entity's
// own config.yaml — two flags (enabled=heard, posts_back=spoken), both default
// ON (auto-enroll), only explicit false disables.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTranscriptionConfig, readTranscriptionConfig, DEFAULT_SERVICE } from '../src/transcription-service.mjs';

describe('parseTranscriptionConfig — defaults + explicit-false', () => {
  it('absent / empty / malformed → both ON (auto-enroll)', () => {
    expect(parseTranscriptionConfig(null)).toEqual(DEFAULT_SERVICE);
    expect(parseTranscriptionConfig('')).toEqual(DEFAULT_SERVICE);
    expect(parseTranscriptionConfig(': : not yaml : :')).toEqual(DEFAULT_SERVICE);
    expect(parseTranscriptionConfig('heartbeat:\n  enabled: true\n')).toEqual(DEFAULT_SERVICE); // unrelated block
  });

  it('only explicit false disables a flag; the other stays ON', () => {
    expect(parseTranscriptionConfig('transcription:\n  posts_back: false\n')).toEqual({ enabled: true, postsBack: false });
    expect(parseTranscriptionConfig('transcription:\n  enabled: false\n')).toEqual({ enabled: false, postsBack: true });
  });

  it('both explicit', () => {
    expect(parseTranscriptionConfig('transcription:\n  enabled: false\n  posts_back: false\n')).toEqual({ enabled: false, postsBack: false });
    expect(parseTranscriptionConfig('transcription:\n  enabled: true\n  posts_back: true\n')).toEqual({ enabled: true, postsBack: true });
  });

  it('non-false truthy values keep the flag ON (default-on semantics)', () => {
    expect(parseTranscriptionConfig('transcription:\n  posts_back: yes\n')).toEqual(DEFAULT_SERVICE);
  });
});

describe('readTranscriptionConfig — entity folder config.yaml', () => {
  it('no config.yaml in the folder → defaults (both ON)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'egpt-tsvc-'));
    try {
      expect(await readTranscriptionConfig(dir)).toEqual(DEFAULT_SERVICE);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('reads the transcription block from the folder config.yaml', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'egpt-tsvc-'));
    try {
      writeFileSync(join(dir, 'config.yaml'), 'transcription:\n  posts_back: false\n');
      expect(await readTranscriptionConfig(dir)).toEqual({ enabled: true, postsBack: false });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('surface-independent: same shape works for a room folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'egpt-room-'));
    try {
      writeFileSync(join(dir, 'config.yaml'), 'transcription:\n  enabled: false\n');
      expect(await readTranscriptionConfig(dir)).toEqual({ enabled: false, postsBack: true });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
