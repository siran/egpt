import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

// Redirect tools/cdp.mjs → extension's chrome.debugger adapter.
// Matches any import ending with tools/cdp.mjs regardless of how many
// directory levels up it goes (brains use '../tools/cdp.mjs').
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

mkdirSync(resolve(__dirname, 'dist/tab'), { recursive: true });

await build({
  ...shared,
  entryPoints: [resolve(__dirname, 'src/background.js')],
  outfile: resolve(__dirname, 'dist/background.js'),
  // background SW doesn't need React
  external: [],
});

await build({
  ...shared,
  entryPoints: [resolve(__dirname, 'src/tab/index.jsx')],
  outfile: resolve(__dirname, 'dist/tab/app.js'),
});

// Copy static assets
copyFileSync(
  resolve(__dirname, 'src/tab/index.html'),
  resolve(__dirname, 'dist/tab/index.html'),
);
copyFileSync(
  resolve(__dirname, 'src/tab/style.css'),
  resolve(__dirname, 'dist/tab/style.css'),
);

console.log('\nextension/dist built ✓');
console.log('Load extension: chrome://extensions → Load unpacked → select extension/');
