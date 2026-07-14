// tests/integrity.test.mjs — static-source integrity checks for the v2 spine.
//
// Catches the class of bug where config-schema drifts from what the spine reads.
// NOT execution tests — they parse source files as text and assert that read
// config keys have a home in CONFIG_SCHEMA. Cheap, no boot-up, runs with the rest.
//
// The old-spine scans (launcher/spine boundary, EGPT_CONFIG anti-drift, command-
// dispatch coverage — everything reading egpt-spine.mjs) were retired 2026-07-02 with
// the config-legacy excision: they guarded dead code on the v2 path (operator: "no
// baggage"). They come back only if the old spine does — which is a separate deletion.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_SCHEMA } from '../config/config-schema.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('/config schema vs. v2 spine config references', () => {
  // The v2 spine (spine.mjs + src/spine/*.mjs) reads config two ways: boot() holds the
  // raw object as `const cfg = readConfig()` and reads top-level keys as `cfg.<key>`;
  // the services receive `getConfig` and read `getConfig().<key>`. Scan both forms — no
  // static analyzer, just a cheap regex — and hold every top-level key to the schema.
  const SPINE_DIR = join(ROOT, 'src/spine');
  const referencedKeys = new Set();
  // boot's raw-config reads: `cfg.<key>`. Case-sensitive, so it never matches the
  // `getConfig` closure nor capital-C ...Cfg locals (transcribeCfg / tx.cliCfg).
  const BOOT_SRC = readFileSync(join(SPINE_DIR, 'boot.mjs'), 'utf8');
  for (const m of BOOT_SRC.matchAll(/\bcfg\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
    referencedKeys.add(m[1]);
  }
  // service reads: `getConfig().<key>` / `getConfig()?.<key>` across src/spine/*.mjs.
  // The `\??\.` requires a real property access, so `getConfig() ?? {}` (and the
  // `(getConfig() ?? {}).<key>` fallback form) do NOT match — only direct reads.
  for (const f of readdirSync(SPINE_DIR)) {
    if (!f.endsWith('.mjs')) continue;
    const src = readFileSync(join(SPINE_DIR, f), 'utf8');
    for (const m of src.matchAll(/\bgetConfig\(\)\s*\??\.\s*([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
      referencedKeys.add(m[1]);
    }
  }

  it('finds at least the known v2 config references (sanity)', () => {
    expect(referencedKeys.size).toBeGreaterThanOrEqual(4);
  });

  for (const key of [...referencedKeys].sort()) {
    it(`v2 spine config.${key} is registered in CONFIG_SCHEMA`, () => {
      expect(CONFIG_SCHEMA, `${key} read by the v2 spine but not in CONFIG_SCHEMA`).toHaveProperty(key);
    });
  }
});
