// tests/dynamic-imports.test.mjs — every `await import('./X.mjs')` /
// `import('./X.mjs')` path in the repo must resolve to a real file.
//
// Backstop: Operator 2026-05-22 — the tools/ → src/tools/ move's batch
// sed updated static imports but missed dynamic imports, silently
// breaking config load at boot. EGPT_CONFIG never got populated;
// every chat dispatched as observe-only-SKIP. This test catches that
// class of regression.

import { describe, it, expect } from 'vitest';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'extension/dist', 'extension/dist-firefox', 'attic']);

async function walkMjs(dir, out = []) {
  let entries;
  try { entries = await readdir(dir); }
  catch (e) { return out; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e)) continue;
    const p = join(dir, e);
    let st;
    try { st = await stat(p); }
    catch (e2) { continue; }
    if (st.isDirectory()) await walkMjs(p, out);
    else if (e.endsWith('.mjs')) out.push(p);
  }
  return out;
}

describe('dynamic imports', () => {
  it('every dynamic `import("./X.mjs")` path resolves to a real file', async () => {
    const files = (await walkMjs(REPO_ROOT))
      .filter(p => !p.endsWith('dynamic-imports.test.mjs'))   // skip self (contains the regex examples)
      .filter(p => !relative(REPO_ROOT, p).replace(/\\/g, '/').startsWith('attic/'))
    // Match both `await import('...')` and bare `import('...')` forms,
    // single or double quoted, relative paths only (we don't validate
    // bare-module specifiers like 'node:fs' or 'qrcode-terminal').
    const re = /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;
    const broken = [];
    for (const file of files) {
      const src = await readFile(file, 'utf8');
      for (const m of src.matchAll(re)) {
        const spec = m[1];
        const target = resolve(dirname(file), spec);
        try { await stat(target); }
        catch (e) {
          broken.push({
            file: relative(REPO_ROOT, file).replace(/\\/g, '/'),
            spec,
            resolved: relative(REPO_ROOT, target).replace(/\\/g, '/'),
          });
        }
      }
    }
    if (broken.length) {
      // Print details before assertion so failures are actionable.
      console.error('Broken dynamic imports:', JSON.stringify(broken, null, 2));
    }
    expect(broken).toEqual([]);
  });
});



