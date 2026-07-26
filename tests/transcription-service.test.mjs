// Locks the per-ENTITY transcription service config (operator 2026-06-15):
// transcription is a surface-independent ROOM service — enabled=heard,
// posts_back=spoken, both default ON (auto-enroll), only explicit false disables.
//
// ONE KEY across THREE RUNGS (operator ruling 2026-07-26): `transcription_service:` is
// the single name, resolved config/config.yaml < config/conversations.yaml < the entity
// folder. This module is now PURE — it reads a resolved doc; the file reading belongs to
// src/spine/config-resolver.mjs, which is why the second block below drives the REAL
// resolver over a REAL temp folder rather than a private reader of its own.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTranscriptionConfig, DEFAULT_SERVICE } from '../src/transcription-service.mjs';
import { createConfigResolver, parseEntityConfig } from '../src/spine/config-resolver.mjs';
import { readFile } from 'node:fs/promises';

const DEFAULTS = { ...DEFAULT_SERVICE, postsBackDelayMs: null };
const doc = (yaml) => parseEntityConfig(yaml);

describe('parseTranscriptionConfig — defaults + explicit-false', () => {
  it('absent / empty / malformed / unrelated block → both flags ON (auto-enroll), no delay', () => {
    expect(parseTranscriptionConfig(doc(null))).toEqual(DEFAULTS);
    expect(parseTranscriptionConfig(doc(''))).toEqual(DEFAULTS);
    expect(parseTranscriptionConfig(doc(': : not yaml : :'))).toEqual(DEFAULTS);
    expect(parseTranscriptionConfig(doc('heartbeats:\n  a: {}\n'))).toEqual(DEFAULTS);
    // the RETIRED name is just an unrelated block now — ONE key, and this isn't it
    expect(parseTranscriptionConfig(doc('transcription:\n  posts_back: false\n'))).toEqual(DEFAULTS);
  });

  it('only explicit false disables a flag; the other stays ON', () => {
    expect(parseTranscriptionConfig(doc('transcription_service:\n  posts_back: false\n'))).toEqual({ ...DEFAULTS, postsBack: false });
    expect(parseTranscriptionConfig(doc('transcription_service:\n  enabled: false\n'))).toEqual({ ...DEFAULTS, enabled: false });
  });

  it('both explicit', () => {
    expect(parseTranscriptionConfig(doc('transcription_service:\n  enabled: false\n  posts_back: false\n'))).toEqual({ enabled: false, postsBack: false, postsBackDelayMs: null });
    expect(parseTranscriptionConfig(doc('transcription_service:\n  enabled: true\n  posts_back: true\n'))).toEqual(DEFAULTS);
  });

  it('non-false truthy values keep the flag ON (default-on semantics)', () => {
    expect(parseTranscriptionConfig(doc('transcription_service:\n  posts_back: yes\n'))).toEqual(DEFAULTS);
  });

  it('posts_back_delay_ms joins the SAME key; a non-number reads as unset', () => {
    expect(parseTranscriptionConfig(doc('transcription_service:\n  posts_back_delay_ms: 8000\n')).postsBackDelayMs).toBe(8000);
    expect(parseTranscriptionConfig(doc('transcription_service:\n  posts_back_delay_ms: -1\n')).postsBackDelayMs).toBe(-1);
    expect(parseTranscriptionConfig(doc('transcription_service:\n  posts_back_delay_ms: soon\n')).postsBackDelayMs).toBeNull();
  });
});

// The file reading lives in the resolver, so this drives the REAL one over a REAL folder:
// the entity file is a RUNG, and what it says beats the node config.
describe('the entity folder as a rung — through the real resolver', () => {
  const withDir = async (prefix, yaml, node, assert) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    try {
      if (yaml != null) writeFileSync(join(dir, 'config.yaml'), yaml);
      const r = createConfigResolver({
        getConfig: () => node,
        listEntityDirs: async () => [{ dir, ns: 'whatsapp/tmp' }],
        readEntityConfig: async (d) => { try { return parseEntityConfig(await readFile(join(d, 'config.yaml'), 'utf8')); } catch { return {}; } },
        egptHome: dir, io: { writeFile: async () => {}, mkdir: async () => {} },
      });
      await r.collect();
      await assert(parseTranscriptionConfig(r.configFor(dir)), r, dir);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };

  it('no config.yaml in the folder → the node rung stands', async () => {
    await withDir('egpt-tsvc-', null, { transcription_service: { posts_back_delay_ms: 300 } },
      (v) => expect(v).toEqual({ enabled: true, postsBack: true, postsBackDelayMs: 300 }));
  });

  it('the folder file BEATS the node rung, leaf by leaf', async () => {
    await withDir('egpt-tsvc-', 'transcription_service:\n  posts_back: false\n',
      { transcription_service: { enabled: true, posts_back: true, posts_back_delay_ms: 300 } },
      (v) => expect(v).toEqual({ enabled: true, postsBack: false, postsBackDelayMs: 300 }));
  });

  it('surface-independent: the same shape works for a room folder', async () => {
    await withDir('egpt-room-', 'transcription_service:\n  enabled: false\n', {},
      (v) => expect(v).toEqual({ enabled: false, postsBack: true, postsBackDelayMs: null }));
  });
});
