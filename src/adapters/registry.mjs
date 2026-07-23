// adapters/registry.mjs — the web-brain ADAPTER registry (Command Surface Phase 2).
//
// An adapter is the per-site driver for a Chrome tab: { name, urlMatch, homeUrl,
// … }. The two shipped adapters live at config/brains/*-cdp.mjs (chatgpt-cdp,
// claude-cdp); each already exports `name`, `urlMatch` (a RegExp), and `homeUrl`.
// A tab can become a `brain` member ONLY when an adapter's urlMatch matches its
// URL — a random tab (Gmail, a news site) has no adapter, so it can't be a brain.
//
// Loading is a dynamic import of each *-cdp.mjs (they carry live inject/poll code
// used later by the relay, phase 4); here we only read the match metadata. Kept a
// pure data layer: matchAdapter() takes the loaded list so it needs no fs/import
// and the command surface can inject a fake list in tests.
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

// The shipped adapters live in the repo's config/brains/ (two levels up from here).
export const ADAPTERS_DIR = fileURLToPath(new URL('../../config/brains/', import.meta.url));

// Load every *-cdp.mjs adapter's match metadata (dynamic import). A broken/partial
// adapter (no name or no urlMatch) is skipped, never fatal; a missing dir → []. The
// full module is imported (so its inject/poll code is available to phase 4), but only
// { name, urlMatch, homeUrl } are surfaced — the match layer needs nothing more.
export async function loadAdapters({ dir = ADAPTERS_DIR } = {}) {
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('-cdp.mjs')); }
  catch { return []; }
  const out = [];
  for (const f of files.sort()) {
    try {
      const mod = await import(pathToFileURL(join(dir, f)).href);
      if (mod?.name && mod?.urlMatch) out.push({ name: mod.name, urlMatch: mod.urlMatch, homeUrl: mod.homeUrl ?? null });
    } catch { /* a broken adapter never blocks the rest */ }
  }
  return out;
}

// Dynamic-import a single adapter module BY NAME (e.g. 'chatgpt-cdp') → the full module
// (its injectScript/pollScript + urlMatch), or null if absent/broken. The room relay (design B,
// phase 4) resolves a brain member's `adapter` this way to DRIVE it; kept beside loadAdapters so
// the dir/path logic lives in one place. Never throws.
export async function loadAdapterModule(name, { dir = ADAPTERS_DIR } = {}) {
  if (!name) return null;
  try { return await import(pathToFileURL(join(dir, `${name}.mjs`)).href); }
  catch { return null; }
}

// The adapter whose urlMatch matches `url`, else null. Pure: `adapters` is the
// already-loaded list (so this stays fs-free + test-injectable). First match wins.
export function matchAdapter(url, adapters = []) {
  const u = String(url ?? '');
  for (const a of adapters) {
    try { if (a?.urlMatch && a.urlMatch.test(u)) return a; } catch { /* a bad regex never throws the match */ }
  }
  return null;
}
