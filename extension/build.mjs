import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

// Chrome dist redirects tools/cdp.mjs and tools/bus.mjs to the
// chrome.debugger-based adapters. The extension lives inside Chrome
// and chrome.debugger is the privileged API that lets it attach CDP
// to its own pages (including chrome-extension://<id>/bus.html — raw
// WS upgrades to those are rejected). Same exported names so the
// rest of the extension code is unchanged.
//
// cdp.mjs's Node-only dynamic imports are still marked external so
// the browser bundle doesn't try to resolve node:fs/path/os.
//
// We produce two self-contained dists side by side:
//   extension/dist/         — Chrome (manifest.json from manifest.chrome.json)
//   extension/dist-firefox/ — Firefox (manifest.json from manifest.firefox.json)
//
// Each dist is the load root for its browser:
//   Chrome:  --load-extension=<repo>/extension/dist
//            (or chrome://extensions → Load Unpacked)
//   Firefox: about:debugging → Load Temporary Add-on → pick
//            <repo>/extension/dist-firefox/manifest.json

// Bus shim: redirect tools/bus.mjs to the chrome.runtime-port adapter
// for the Chrome dist. The bus adapter doesn't use chrome.debugger
// at all; it talks to the bus tab via chrome.runtime ports through
// the extension's background relay. Firefox build skips this and
// uses the unified raw-WS bus.mjs (which works fine since Firefox
// extension just needs to attach to a Chrome on the LAN through the
// proxy, not host its own bus tab).
//
// tools/cdp.mjs is NOT shimmed: brain-tab CDP (open/list/close,
// Runtime.evaluate, streaming) goes through the unified raw-WS path
// in both Chrome and Firefox builds. No chrome.debugger anywhere —
// no banner, no 'Another debugger is already attached' on reload.
const busShim = {
  name: 'bus-shim',
  setup(b) {
    b.onResolve({ filter: /\/tools\/bus\.mjs$/ }, () => ({
      path: resolve(__dirname, 'src/tools/bus-ext.js'),
    }));
  },
};

// Redirect tools/cdp.mjs imports to the chrome.debugger-based shim
// in the extension build so streamFromTab + peekTab go through the
// extension-privilege CDP channel (no raw WS, no --remote-allow-
// origins=* requirement). The shim file ITSELF imports from
// ../../../tools/cdp.mjs to re-export the read-only HTTP helpers
// (listTabs etc.); we let that import pass through unredirected.
const cdpShim = {
  name: 'cdp-shim',
  setup(b) {
    const shimPath = resolve(__dirname, 'src/tools/cdp-debugger.js');
    b.onResolve({ filter: /\/tools\/cdp\.mjs$/ }, (args) => {
      if (args.importer === shimPath) return null;          // self-import, pass through
      return { path: shimPath };
    });
  },
};

const baseShared = {
  bundle: true,
  platform: 'browser',
  format: 'esm',
  jsx: 'automatic',
  external: ['node:fs', 'node:path', 'node:os'],
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
};

const chromeShared  = { ...baseShared, plugins: [busShim, cdpShim] };
const firefoxShared = { ...baseShared, plugins: [cdpShim] };

// ── Build Chrome dist ───────────────────────────────────────────────
const chromeDist = resolve(__dirname, 'dist');
mkdirSync(resolve(chromeDist, 'tab'),      { recursive: true });
mkdirSync(resolve(chromeDist, 'settings'), { recursive: true });

await build({
  ...chromeShared,
  entryPoints: [resolve(__dirname, 'src/background.js')],
  outfile: resolve(chromeDist, 'background.js'),
});

// Content scripts (declared in manifest, auto-loaded on matching pages).
mkdirSync(resolve(chromeDist, 'content'), { recursive: true });
await build({
  ...chromeShared,
  entryPoints: [resolve(__dirname, 'src/content/wa-content.js')],
  outfile: resolve(chromeDist, 'content/wa-content.js'),
});

await build({
  ...chromeShared,
  entryPoints: [resolve(__dirname, 'src/tab/index.jsx')],
  outfile: resolve(chromeDist, 'tab/app.js'),
});

await build({
  ...chromeShared,
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
// Bundle bus.html (and its sibling bus.js) in the extension so it can
// host its own bus tab (chrome-extension://<id>/bus.html) without
// depending on the proxy serving it from :9222. The script is in a
// separate file because MV3 CSP disallows inline <script> blocks.
// Source of truth stays at src/tools/{bus.html,bus.js} — same files used
// by cdp-proxy.mjs for shell-only setups.
copyFileSync(
  resolve(__dirname, '../src/tools/bus.html'),
  resolve(chromeDist, 'bus.html'),
);
copyFileSync(
  resolve(__dirname, '../src/tools/bus.js'),
  resolve(chromeDist, 'bus.js'),
);
copyFileSync(
  resolve(__dirname, 'manifest.chrome.json'),
  resolve(chromeDist, 'manifest.json'),
);

// ── Build Firefox dist (separate JS bundle, no cdp-shim) ────────────
// Firefox doesn't have chrome.debugger, so its bundle uses the raw-
// WebSocket path through the unified tools/cdp.mjs and tools/bus.mjs.
// Same source files, different bundle output.
const firefoxDist = resolve(__dirname, 'dist-firefox');
mkdirSync(resolve(firefoxDist, 'tab'),      { recursive: true });
mkdirSync(resolve(firefoxDist, 'settings'), { recursive: true });

await build({
  ...firefoxShared,
  entryPoints: [resolve(__dirname, 'src/background.js')],
  outfile: resolve(firefoxDist, 'background.js'),
});

await build({
  ...firefoxShared,
  entryPoints: [resolve(__dirname, 'src/tab/index.jsx')],
  outfile: resolve(firefoxDist, 'tab/app.js'),
});

await build({
  ...firefoxShared,
  entryPoints: [resolve(__dirname, 'src/settings/index.jsx')],
  outfile: resolve(firefoxDist, 'settings/app.js'),
});

const firefoxStaticAssets = [
  'tab/index.html',
  'tab/style.css',
  'settings/index.html',
  'settings/style.css',
  'bus.html',
  'bus.js',
  'content/wa-content.js',
];
mkdirSync(resolve(firefoxDist, 'content'), { recursive: true });
for (const rel of firefoxStaticAssets) {
  copyFileSync(resolve(chromeDist, rel), resolve(firefoxDist, rel));
}
copyFileSync(
  resolve(__dirname, 'manifest.firefox.json'),
  resolve(firefoxDist, 'manifest.json'),
);

console.log('\nextension/dist          built ✓  (Chrome  — load extension/dist)');
console.log('extension/dist-firefox  built ✓  (Firefox — load dist-firefox/manifest.json)');
console.log('Settings: right-click extension icon → Options');
