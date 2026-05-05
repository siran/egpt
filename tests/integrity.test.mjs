// tests/integrity.test.mjs — static-source integrity checks.
//
// Catches the class of bug where the command registry, config schema,
// and dispatch sites drift. These are NOT execution tests — they parse
// source files as text and assert that registered things have a home.
// Cheap, no boot-up, runs in vitest with the rest.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS } from '../interpreter.mjs';
import { CONFIG_SCHEMA } from '../config-schema.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHELL_SRC = readFileSync(join(ROOT, 'egpt.mjs'), 'utf8');
const EXT_SRC   = readFileSync(join(ROOT, 'extension/src/tab/App.jsx'), 'utf8');

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
  // inside a switch. Either form satisfies the check.
  const hasDispatch = (src, cmd) => {
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
          hasDispatch(src, entry.cmd),
          `${entry.cmd} has no "case '${entry.cmd}'" or "cmd === '${entry.cmd}'" in ${file}`,
        ).toBe(true);
      });
    }
  }
});
