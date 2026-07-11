// tests/extension-build.test.mjs — sanity checks on the built extension.
//
// Catches the class of bug where the manifest references files that
// don't exist (typo, build script forgot to copy, path layout drift).
// The 1d236ef manifest reorg silently shipped with --load-extension
// pointing at a directory that didn't contain manifest.json for years
// before that commit fixed it; a test like this one would have caught
// it the moment the structure went wrong.
//
// Deletes ignored output and performs a fresh dual-target build before checking
// either dist, so stale or absent artifacts cannot pass.

import { beforeAll, describe, it, expect } from 'vitest';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function checkDist(distDir, label) {
  describe(`extension/${label} structure`, () => {
    const distPath = join(ROOT, 'extension', distDir);

    it(`${distDir}/manifest.json exists`, () => {
      expect(existsSync(join(distPath, 'manifest.json'))).toBe(true);
    });

    const manifest = () => JSON.parse(readFileSync(join(distPath, 'manifest.json'), 'utf8'));

    it(`${label}: manifest_version = 3`, () => {
      expect(manifest().manifest_version).toBe(3);
    });

    it(`${label}: every manifest-referenced file exists`, () => {
      const refs = collectFileRefs(manifest());
      const missing = refs.filter(r => !existsSync(join(distPath, r)));
      expect(missing, `missing files: ${missing.join(', ')}`).toEqual([]);
    });

    it(`${label}: referenced bundles are non-empty`, () => {
      const refs = collectFileRefs(manifest()).filter(r => r.endsWith('.js'));
      const empty = refs.filter(r => statSync(join(distPath, r)).size === 0);
      expect(empty, `empty bundles: ${empty.join(', ')}`).toEqual([]);
    });

    it(`${label}: HTML bundle entries reference 'app.js' and 'style.css' siblings`, () => {
      // Each tab/settings index.html is loaded directly by the browser
      // and has plain relative paths (no `dist/` prefix). Catches the
      // self-contained-vs-old-layout regression.
      for (const sub of ['tab', 'settings']) {
        const html = join(distPath, sub, 'index.html');
        if (!existsSync(html)) continue;
        const txt = readFileSync(html, 'utf8');
        expect(txt, `${sub}/index.html app.js`).toContain('src="app.js"');
        expect(txt, `${sub}/index.html style.css`).toContain('href="style.css"');
        expect(txt, `${sub}/index.html no dist/ prefix`).not.toMatch(/dist\//);
      }
    });
  });
}

function collectFileRefs(manifest) {
  const refs = [];
  if (manifest.background?.service_worker) refs.push(manifest.background.service_worker);
  if (Array.isArray(manifest.background?.scripts)) refs.push(...manifest.background.scripts);
  if (manifest.options_ui?.page) refs.push(manifest.options_ui.page);
  if (Array.isArray(manifest.web_accessible_resources)) {
    for (const entry of manifest.web_accessible_resources) {
      if (Array.isArray(entry.resources)) refs.push(...entry.resources);
    }
  }
  // background.js ships next to the manifest, the assets pages need
  // app.js and style.css in their own dirs — these ride along
  // implicitly. The HTML test above catches if those siblings drift.
  return refs;
}

// The build must actually RUN — not just leave well-formed artifacts. The
// checks above validate whatever dist is on disk, so they pass green against a
// STALE dist even when the build is broken (exactly the f2bce8f reorg bug: the
// extension imports + build.mjs asset copies pointed at old root paths, so
// `npm run build:ext` failed with "Could not resolve" / ENOENT on every
// upgrade, while the frozen pre-reorg dist still satisfied the structure
// tests). This runs the real build and asserts it succeeds — a broken import
// path or a missing copied asset fails here instead of rotting until /upgrade.
describe('fresh extension build', () => {
  beforeAll(() => {
    for (const dist of ['dist', 'dist-firefox']) {
      rmSync(join(ROOT, 'extension', dist), { recursive: true, force: true });
    }
    const result = spawnSync(process.execPath, ['extension/build.mjs'], {
      cwd: ROOT, encoding: 'utf8', timeout: 120000,
    });
    const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    expect(out, out).not.toMatch(/Could not resolve/);
    expect(result.status, `build exited ${result.status}:\n${out}`).toBe(0);
  }, 120000);

  checkDist('dist',         'chrome');
  checkDist('dist-firefox', 'firefox');

// ── Firefox-specific assertions ──────────────────────────────────

  describe('firefox manifest specifics', () => {
    const manifest = () => JSON.parse(
      readFileSync(join(ROOT, 'extension', 'dist-firefox', 'manifest.json'), 'utf8'),
    );

    it('declares browser_specific_settings.gecko.id', () => {
      // Firefox refuses to load a Temporary Add-on without this.
      expect(manifest().browser_specific_settings?.gecko?.id).toBeTruthy();
    });

    it('uses background.scripts (not service_worker) for broader compat', () => {
      // Firefox has supported service_worker since 121, but scripts is
      // the more reliable cross-version path. If we ever switch to
      // service_worker, update this test deliberately.
      expect(manifest().background?.scripts).toBeTruthy();
      expect(manifest().background?.service_worker).toBeUndefined();
    });
  });
});
