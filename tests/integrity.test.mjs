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
const SLASH_DIR = join(ROOT, 'slash');

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

// Bridge-surface coverage. Slash files reach into the WA bridge via
// `waBridgeRef.current.<method>`; if a refactor drops the method from the bridge's
// return object the access is a runtime TypeError that only fires when an operator
// actually invokes the path. Caught one in production (setEgptPin disappeared from the
// WA return object during an unrelated edit, /unpin crashed the daemon at use-time).
// This test statically grep-extracts every `.current.<name>` access in slash/*.mjs and
// asserts the bridge's return object exposes it.
describe('bridge-surface integrity', () => {
  function _extractReturnObject(src, factoryRegex) {
    const fm = src.match(factoryRegex);
    if (!fm) return null;
    const needle = '\n  return {';
    let probe = fm.index;
    let start = -1;
    while ((probe = src.indexOf(needle, probe + 1)) >= 0) {
      start = probe + 1;   // skip the leading newline
      break;
    }
    if (start < 0) return null;
    let depth = 0, i = start + '  return '.length;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    }
    return null;
  }
  function _exportedNames(returnBlock) {
    const names = new Set();
    for (const m of returnBlock.matchAll(/^\s{2,6}(?:async\s+)?(get\s+)?(\w+)\s*(?:[,:(]|$)/gm)) {
      const kw = m[2];
      if (['return', 'if', 'else', 'const', 'let', 'var', 'for', 'while', 'function'].includes(kw)) continue;
      names.add(kw);
    }
    return names;
  }
  function _surveyAccesses(ref) {
    const accessed = new Map();   // method → [file, ...]
    for (const f of readdirSync(SLASH_DIR)) {
      if (!f.endsWith('.mjs')) continue;
      const src = readFileSync(join(SLASH_DIR, f), 'utf8');
      const re = new RegExp(`${ref}\\??\\.current\\??\\.(\\w+)`, 'g');
      for (const m of src.matchAll(re)) {
        const list = accessed.get(m[1]) ?? [];
        list.push(f);
        accessed.set(m[1], list);
      }
    }
    return accessed;
  }

  it('WA bridge exposes every method accessed by slash files', () => {
    // The WA transport is the beeper limb (baileys removed 2026-06-10).
    const src = readFileSync(join(ROOT, 'src/bridges/beeper.mjs'), 'utf8');
    const ret = _extractReturnObject(src, /export\s+async\s+function\s+startBeeperBridge\b/);
    expect(ret, 'could not extract bridge return object — has the factory shape changed?').toBeTruthy();
    const exposed = _exportedNames(ret);
    const accessed = _surveyAccesses('waBridgeRef');
    const missing = [];
    for (const [method, files] of accessed.entries()) {
      if (!exposed.has(method)) missing.push(`${method} (used in: ${files.join(', ')})`);
    }
    expect(missing, `WA bridge return object is missing methods that slash files call:\n  ${missing.join('\n  ')}`).toEqual([]);
  });
});
