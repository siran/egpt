import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

// Redirect tools/cdp.mjs → extension's chrome.debugger adapter.
const cdpShim = {
  name: 'cdp-shim',
  setup(b) {
    b.onResolve({ filter: /\/tools\/cdp\.mjs$/ }, () => ({
      path: resolve(__dirname, 'src/tools/cdp-ext.js'),
    }));
  },
};

const shared = {
  bundle: true,
  platform: 'browser',
  format: 'esm',
  jsx: 'automatic',
  plugins: [cdpShim],
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
