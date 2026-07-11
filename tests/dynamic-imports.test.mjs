// tests/dynamic-imports.test.mjs — every literal relative dynamic import in
// maintained project source must resolve to a real file.
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
const SOURCE_DIRS = ['src', 'slash', 'config', 'extension/src'];
const SOURCE_EXTENSIONS = ['.mjs', '.js', '.jsx'];

async function walkSource(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walkSource(path, out);
    else if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) out.push(path);
  }
  return out;
}

async function sourceFiles() {
  const roots = await Promise.all(SOURCE_DIRS.map((dir) => walkSource(join(REPO_ROOT, dir))));
  const rootFiles = (await readdir(REPO_ROOT, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
    .map((entry) => join(REPO_ROOT, entry.name));
  return [...rootFiles, ...roots.flat()];
}

describe('dynamic imports', () => {
  it('every literal relative `import("./X.mjs")` path resolves to a real file', async () => {
    const files = await sourceFiles();
    // Template imports and computed specifiers are intentionally outside this
    // test. Their possible targets cannot be proven by statting one path.
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
