import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

// The extension now uses the shared tools/cdp.mjs and tools/bus.mjs
// directly — no more chrome.debugger shim. cdp.mjs has runtime-only
// dynamic imports for node:fs/path/os, which esbuild can't resolve in
// a browser bundle; mark them external so the bundle keeps the
// import expressions intact (they throw at runtime in the browser
// and the try/catch in cdp.mjs falls through to the no-op default).
//
// The chrome.storage-backed host getter is installed by
// extension/src/cdp-bootstrap.js, which every entry point must
// import first (before any cdpHost() call).

const shared = {
  bundle: true,
  platform: 'browser',
  format: 'esm',
  jsx: 'automatic',
  external: ['node:fs', 'node:path', 'node:os'],
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
};

mkdirSync(resolve(__dirname, 'dist/tab'),      { recursive: true });
mkdirSync(resolve(__dirname, 'dist/settings'), { recursive: true });

await build({
  ...shared,
  entryPoints: [resolve(__dirname, 'src/background.js')],
  outfile: resolve(__dirname, 'dist/background.js'),
  external: [],
});

await build({
  ...shared,
  entryPoints: [resolve(__dirname, 'src/tab/index.jsx')],
  outfile: resolve(__dirname, 'dist/tab/app.js'),
});

await build({
  ...shared,
  entryPoints: [resolve(__dirname, 'src/settings/index.jsx')],
  outfile: resolve(__dirname, 'dist/settings/app.js'),
});

// Copy static assets
for (const [src, dst] of [
  ['src/tab/index.html',      'dist/tab/index.html'],
  ['src/tab/style.css',       'dist/tab/style.css'],
  ['src/settings/index.html', 'dist/settings/index.html'],
  ['src/settings/style.css',  'dist/settings/style.css'],
]) {
  copyFileSync(resolve(__dirname, src), resolve(__dirname, dst));
}

console.log('\nextension/dist built ✓');
console.log('Settings: right-click extension icon → Options');
