// Locks the per-ENTITY transcription service config (operator 2026-06-15):
// transcription is a surface-independent ROOM service — enabled=heard, posts_back=spoken.
// They do NOT default alike: `enabled` is opt-OUT (default ON, only an explicit false
// disables), `posts_back` is opt-IN (default OFF, only an explicit true enables) — operator
// 2026-09-13: "postback must default to false, `true` is an 'unsafe' default, as we just
// experienced".
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
  it('absent / empty / malformed / unrelated block → HEARD but SILENT, no delay', () => {
    expect(parseTranscriptionConfig(doc(null))).toEqual(DEFAULTS);
    expect(parseTranscriptionConfig(doc(''))).toEqual(DEFAULTS);
    expect(parseTranscriptionConfig(doc(': : not yaml : :'))).toEqual(DEFAULTS);
    expect(parseTranscriptionConfig(doc('heartbeats:\n  a: {}\n'))).toEqual(DEFAULTS);
    // the RETIRED name is just an unrelated block now — ONE key, and this isn't it, so it
    // can neither disable hearing nor (the half that matters) switch the 👂 echo on
    expect(parseTranscriptionConfig(doc('transcription:\n  posts_back: false\n'))).toEqual(DEFAULTS);
    expect(parseTranscriptionConfig(doc('transcription:\n  posts_back: true\n'))).toEqual(DEFAULTS);
  });

  // THE UNSAFE DEFAULT (operator 2026-09-13: "postback must default to false, `true` is an
  // 'unsafe' default, as we just experienced"). The second profile on the machine carried
  // no `transcription_service:` block at all, auto-enrolled, and posted 👂 transcripts into
  // the operator's real group chats — in fact `[voice note — transcription failed]`, since a
  // profile with no block also has no engine. Written LITERALLY rather than against
  // DEFAULT_SERVICE: this is the lock ON the constant, so it must not move with it.
  it('a config with NO posts_back key yields postsBack:false — and hearing is untouched', () => {
    expect(DEFAULT_SERVICE).toEqual({ enabled: true, postsBack: false });
    for (const yaml of [null, '', 'transcription_service:\n  enabled: true\n',
      'transcription_service:\n  posts_back_delay_ms: 8000\n']) {
      expect(parseTranscriptionConfig(doc(yaml))).toMatchObject({ enabled: true, postsBack: false });
    }
  });

  it('posts_back is OPT-IN: an explicit true still speaks, an explicit false stays quiet', () => {
    expect(parseTranscriptionConfig(doc('transcription_service:\n  posts_back: true\n'))).toEqual({ ...DEFAULTS, postsBack: true });
    expect(parseTranscriptionConfig(doc('transcription_service:\n  posts_back: false\n'))).toEqual({ ...DEFAULTS, postsBack: false });
  });

  it('enabled is OPT-OUT and the ruling did not touch it: only an explicit false disables', () => {
    expect(parseTranscriptionConfig(doc('transcription_service:\n  enabled: false\n'))).toEqual({ ...DEFAULTS, enabled: false });
    expect(parseTranscriptionConfig(doc('transcription_service:\n  enabled: true\n'))).toEqual({ ...DEFAULTS, enabled: true });
  });

  it('both explicit', () => {
    expect(parseTranscriptionConfig(doc('transcription_service:\n  enabled: false\n  posts_back: false\n'))).toEqual({ enabled: false, postsBack: false, postsBackDelayMs: null });
    expect(parseTranscriptionConfig(doc('transcription_service:\n  enabled: true\n  posts_back: true\n'))).toEqual({ enabled: true, postsBack: true, postsBackDelayMs: null });
  });

  // Each test is strict, and each strictness is the FAIL-CLOSED side of its own flag: `yes`
  // and `no` parse as the STRINGS "yes"/"no" under YAML 1.2, so neither switches the echo on
  // nor switches hearing off.
  it('a non-boolean is not a boolean: `yes` does not enable posts_back, `no` does not disable enabled', () => {
    // literal, not DEFAULTS: DEFAULTS follows DEFAULT_SERVICE, and these two assert the
    // FLAG's own reading of a stringy value, not the constant
    expect(parseTranscriptionConfig(doc('transcription_service:\n  posts_back: yes\n')).postsBack).toBe(false);
    expect(parseTranscriptionConfig(doc('transcription_service:\n  enabled: no\n')).enabled).toBe(true);
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

  it('no config.yaml in the folder → the node rung stands (its posts_back: true included)', async () => {
    await withDir('egpt-tsvc-', null, { transcription_service: { posts_back: true, posts_back_delay_ms: 300 } },
      (v) => expect(v).toEqual({ enabled: true, postsBack: true, postsBackDelayMs: 300 }));
  });

  // The other half of the same case: a node rung that opts nobody in leaves every folder
  // that says nothing SILENT — the shape the 2026-09-13 ruling is about.
  it('no config.yaml AND no node posts_back → HEARD but SILENT at the node delay', async () => {
    await withDir('egpt-tsvc-', null, { transcription_service: { posts_back_delay_ms: 300 } },
      (v) => expect(v).toEqual({ enabled: true, postsBack: false, postsBackDelayMs: 300 }));
  });

  it('the folder file BEATS the node rung, leaf by leaf', async () => {
    await withDir('egpt-tsvc-', 'transcription_service:\n  posts_back: false\n',
      { transcription_service: { enabled: true, posts_back: true, posts_back_delay_ms: 300 } },
      (v) => expect(v).toEqual({ enabled: true, postsBack: false, postsBackDelayMs: 300 }));
  });

  it('surface-independent: the same shape works for a room folder', async () => {
    await withDir('egpt-room-', 'transcription_service:\n  enabled: false\n', {},
      (v) => expect(v).toEqual({ enabled: false, postsBack: false, postsBackDelayMs: null }));
  });
});
