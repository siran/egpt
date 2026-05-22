// tests/integrity.test.mjs — static-source integrity checks.
//
// Catches the class of bug where the command registry, config schema,
// and dispatch sites drift. These are NOT execution tests — they parse
// source files as text and assert that registered things have a home.
// Cheap, no boot-up, runs in vitest with the rest.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS } from '../src/interpreter.mjs';
import { CONFIG_SCHEMA } from '../config/config-schema.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHELL_SRC = readFileSync(join(ROOT, 'egpt.mjs'), 'utf8');
const EXT_SRC   = readFileSync(join(ROOT, 'extension/src/tab/App.jsx'), 'utf8');

// slash/*.mjs file-command registry — collected at test time so the
// dispatch-coverage check accepts commands that migrated out of the
// inline if-chain into their own files. Scans the source statically
// (matches `cmd: '/foo'` lines in each slash/*.mjs file) so the test
// stays a cheap text check, no import-side-effects.
const SLASH_DIR = join(ROOT, 'slash');
const SLASH_CMDS = new Set();
try {
  for (const f of readdirSync(SLASH_DIR)) {
    if (!f.endsWith('.mjs')) continue;
    const src = readFileSync(join(SLASH_DIR, f), 'utf8');
    for (const m of src.matchAll(/\bcmd\s*:\s*['"](\/[a-zA-Z0-9-]+)['"]/g)) {
      SLASH_CMDS.add(m[1]);
    }
  }
} catch (_) { /* slash dir missing — empty set, every cmd must dispatch via inline */ }

// ── /config schema integrity ───────────────────────────────────────────────

describe('/config schema vs. EGPT_CONFIG references', () => {
  // Every top-level key the shell reads off EGPT_CONFIG must be in the
  // schema; otherwise /config rejects the key as 'unknown'. node_name was
  // the case that prompted this test — read at module init but missing
  // from CONFIG_SCHEMA, which made /config node_name unusable.
  const referencedKeys = new Set();
  for (const m of SHELL_SRC.matchAll(/\bEGPT_CONFIG\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
    referencedKeys.add(m[1]);
  }

  it('finds at least the known config references (sanity)', () => {
    expect(referencedKeys.size).toBeGreaterThanOrEqual(4);
  });

  for (const key of [...referencedKeys].sort()) {
    it(`EGPT_CONFIG.${key} is registered in CONFIG_SCHEMA`, () => {
      expect(CONFIG_SCHEMA, `${key} read in egpt.mjs but not in CONFIG_SCHEMA`).toHaveProperty(key);
    });
  }
});

// ── Command dispatch coverage ─────────────────────────────────────────────

describe('every command in COMMANDS has a dispatch site on its surface', () => {
  // Static check: for each registered command, look for a corresponding
  // case in the source file of each surface that's supposed to handle it.
  // The shell uses `if (cmd === '/foo')`; the extension uses `case '/foo':`
  // inside a switch; or, on the shell side, a slash/<file>.mjs that
  // registers the cmd through its meta export (the new file-command
  // route — pilot landed with /pin and /unpin, others will migrate
  // incrementally). Any of these satisfies the check.
  const hasDispatch = (src, cmd, surface) => {
    if (surface === 'shell' && SLASH_CMDS.has(cmd)) return true;
    const escaped = cmd.replace('/', '\\/');
    const ifStyle  = new RegExp(`\\bcmd\\s*===\\s*['"]${escaped}['"]`);
    const caseStyle = new RegExp(`\\bcase\\s+['"]${escaped}['"]`);
    return ifStyle.test(src) || caseStyle.test(src);
  };

  for (const entry of COMMANDS) {
    if (!entry.cmd) continue;
    const surfaces = entry.surface === 'both'
      ? ['shell', 'extension']
      : [entry.surface];

    for (const surface of surfaces) {
      const src = surface === 'shell' ? SHELL_SRC : EXT_SRC;
      const file = surface === 'shell' ? 'egpt.mjs' : 'extension/src/tab/App.jsx';
      it(`${entry.cmd} is dispatched on ${surface} (${file})`, () => {
        expect(
          hasDispatch(src, entry.cmd, surface),
          `${entry.cmd} has no "case '${entry.cmd}'" / "cmd === '${entry.cmd}'" in ${file} and no slash/*.mjs registering it`,
        ).toBe(true);
      });
    }
  }
});

// Bridge-surface coverage. Slash files reach into the WA + TG
// bridges via `waBridgeRef.current.<method>` / `tgBridgeRef.current.
// <method>`; if a refactor drops the method from the bridge's return
// object the access is a runtime TypeError that only fires when an
// operator actually invokes the path. Caught one in production
// (setEgptPin disappeared from the WA return object during an
// unrelated edit, /unpin crashed the daemon at use-time). This test
// statically grep-extracts every `.current.<name>` access in
// slash/*.mjs and asserts the bridge's return object exposes it.
//
// Parsing the return block: balance-count braces from the LAST
// `return {` in the bridge file. Catches plain `name,`, key-value
// `name: x,`, and method shorthand `[async] name(...) { ... },`.
describe('bridge-surface integrity', () => {
  function _extractReturnObject(src, factoryRegex) {
    // Locate the factory's body, then find its `return { ... }` block.
    // The factory's outermost return is at exactly 2-space indent
    // (matching the factory body indent); inner helpers that also
    // return objects sit at deeper indent. Anchor to a newline so
    // we don't match inner-helper `      return {` substrings.
    const fm = src.match(factoryRegex);
    if (!fm) return null;
    // Find '\n  return {' (newline + exactly two spaces + return {).
    // The outer return ends a function body; inner helpers always
    // indent deeper. Scan forward from the factory start.
    const needle = '\n  return {';
    let probe = fm.index;
    let start = -1;
    while ((probe = src.indexOf(needle, probe + 1)) >= 0) {
      // Verify there's no extra indent between the newline and 'return'.
      // src.indexOf already guarantees '\n  return {' exact; that's
      // strictly 2 spaces. Take the first hit after the factory line.
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
    // Matches '  name,' / '  name:' / '  async name(' / '  name('
    // at the start of a line inside the return object.
    for (const m of returnBlock.matchAll(/^\s{2,6}(?:async\s+)?(get\s+)?(\w+)\s*(?:[,:(]|$)/gm)) {
      const kw = m[2];
      // Skip JS keywords that can appear at line start ('return',
      // 'if', 'const', 'let' …) — none should match the indented
      // member pattern, but defensive against false positives.
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
    const src = readFileSync(join(ROOT, 'src/bridges/whatsapp.mjs'), 'utf8');
    const ret = _extractReturnObject(src, /export\s+async\s+function\s+startWhatsAppBridge\b/);
    expect(ret, 'could not extract bridge return object — has the factory shape changed?').toBeTruthy();
    const exposed = _exportedNames(ret);
    const accessed = _surveyAccesses('waBridgeRef');
    const missing = [];
    for (const [method, files] of accessed.entries()) {
      if (!exposed.has(method)) missing.push(`${method} (used in: ${files.join(', ')})`);
    }
    expect(missing, `WA bridge return object is missing methods that slash files call:\n  ${missing.join('\n  ')}`).toEqual([]);
  });

  it('TG bridge exposes every method accessed by slash files', () => {
    const src = readFileSync(join(ROOT, 'src/bridges/telegram.mjs'), 'utf8');
    const ret = _extractReturnObject(src, /export\s+function\s+startTelegramBridge\b/);
    expect(ret, 'could not extract bridge return object — has the factory shape changed?').toBeTruthy();
    const exposed = _exportedNames(ret);
    const accessed = _surveyAccesses('tgBridgeRef');
    const missing = [];
    for (const [method, files] of accessed.entries()) {
      if (!exposed.has(method)) missing.push(`${method} (used in: ${files.join(', ')})`);
    }
    expect(missing, `TG bridge return object is missing methods that slash files call:\n  ${missing.join('\n  ')}`).toEqual([]);
  });
});
