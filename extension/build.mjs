import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

// The extension uses the shared tools/cdp.mjs and tools/bus.mjs directly
// — no chrome.debugger shim. cdp.mjs has runtime-only dynamic imports
// for node:fs/path/os, which esbuild can't resolve in a browser bundle;
// mark them external so the bundle keeps the import expressions intact
// (they throw at runtime in the browser and the try/catch in cdp.mjs
// falls through to the no-op default until cdp-bootstrap.js installs
// the chrome.storage-backed getter).
//
// We produce two self-contained dists side by side:
//   extension/dist/         — Chrome (manifest.json from manifest.chrome.json)
//   extension/dist-firefox/ — Firefox (manifest.json from manifest.firefox.json)
//
// Both dirs hold the same JS bundles + assets; only the manifest differs.
// Each dist is the load root for its browser:
//   Chrome:  --load-extension=<repo>/extension/dist
//            (or chrome://extensions → Load Unpacked)
//   Firefox: about:debugging → Load Temporary Add-on → pick
//            <repo>/extension/dist-firefox/manifest.json

const shared = {
  bundle: true,
  platform: 'browser',
  format: 'esm',
  jsx: 'automatic',
  external: ['node:fs', 'node:path', 'node:os'],
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
};

// ── Build Chrome dist ───────────────────────────────────────────────
const chromeDist = resolve(__dirname, 'dist');
mkdirSync(resolve(chromeDist, 'tab'),      { recursive: true });
mkdirSync(resolve(chromeDist, 'settings'), { recursive: true });

await build({
  ...shared,
  entryPoints: [resolve(__dirname, 'src/background.js')],
  outfile: resolve(chromeDist, 'background.js'),
});

await build({
  ...shared,
  entryPoints: [resolve(__dirname, 'src/tab/index.jsx')],
  outfile: resolve(chromeDist, 'tab/app.js'),
});

await build({
  ...shared,
  entryPoints: [resolve(__dirname, 'src/settings/index.jsx')],
  outfile: resolve(chromeDist, 'settings/app.js'),
});

const staticAssets = [
  ['src/tab/index.html',      'tab/index.html'],
  ['src/tab/style.css',       'tab/style.css'],
  ['src/settings/index.html', 'settings/index.html'],
  ['src/settings/style.css',  'settings/style.css'],
];
for (const [src, dst] of staticAssets) {
  copyFileSync(resolve(__dirname, src), resolve(chromeDist, dst));
}
copyFileSync(
  resolve(__dirname, 'manifest.chrome.json'),
  resolve(chromeDist, 'manifest.json'),
);

// ── Mirror to Firefox dist (same JS, different manifest) ────────────
const firefoxDist = resolve(__dirname, 'dist-firefox');
mkdirSync(resolve(firefoxDist, 'tab'),      { recursive: true });
mkdirSync(resolve(firefoxDist, 'settings'), { recursive: true });

const builtFiles = [
  'background.js',
  'tab/app.js',
  'tab/index.html',
  'tab/style.css',
  'settings/app.js',
  'settings/index.html',
  'settings/style.css',
];
for (const rel of builtFiles) {
  copyFileSync(resolve(chromeDist, rel), resolve(firefoxDist, rel));
}
copyFileSync(
  resolve(__dirname, 'manifest.firefox.json'),
  resolve(firefoxDist, 'manifest.json'),
);

console.log('\nextension/dist          built ✓  (Chrome  — load extension/dist)');
console.log('extension/dist-firefox  built ✓  (Firefox — load dist-firefox/manifest.json)');
console.log('Settings: right-click extension icon → Options');
