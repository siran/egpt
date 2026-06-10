// src/swallow.mjs — the "nothing is ever truly silent" sink.
//
// For catch sites that are best-effort BY DESIGN (cleanup unlinks,
// optional reads, fire-and-forget pokes) where surfacing every failure
// to the operator would train them to ignore errors — but where a bare
// `catch {}` has already hidden real bugs twice (config load 2026-05-22,
// config overlay 2026-05-27). Instead of dropping the error, write one
// rate-limited line per tag to ~/.egpt/logs/swallowed.log so the next
// post-mortem has a trail:
//
//   try { unlinkSync(p); } catch (e) { swallow('boot.migrate', e); }
//
// `expect` lists error codes that are NORMAL control flow for the site
// (e.g. ENOENT on an optional file) — those are not logged at all:
//
//   catch (e) { swallow('history.load', e, { expect: ['ENOENT'] }); }
//
// Never throws. Rate limit: per tag, at most one line per 5s window;
// repeats inside the window are counted and reported on the tag's next
// written line as "(+N suppressed)".

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// EGPT_HOME env override exists for tests (the rest of the app anchors
// to homedir()/.egpt directly); in production it's unset.
const _logPath = () => join(process.env.EGPT_HOME || join(homedir(), '.egpt'), 'logs', 'swallowed.log');

const WINDOW_MS = 5_000;
const _seen = new Map();   // tag -> { at, suppressed }
let _dirReady = false;

export function swallow(tag, e, { expect = [] } = {}) {
  try {
    if (e?.code && expect.includes(e.code)) return;
    const now = Date.now();
    const rec = _seen.get(tag);
    if (rec && now - rec.at < WINDOW_MS) { rec.suppressed += 1; return; }
    const carried = rec?.suppressed ? ` (+${rec.suppressed} suppressed)` : '';
    _seen.set(tag, { at: now, suppressed: 0 });
    const path = _logPath();
    if (!_dirReady) {
      try { mkdirSync(join(path, '..'), { recursive: true }); } catch { /* appendFileSync below reports */ }
      _dirReady = true;
    }
    const msg = e?.message ?? String(e);
    const code = e?.code ? ` [${e.code}]` : '';
    appendFileSync(path, `${new Date().toISOString()} [${process.pid}] ${tag}: ${msg}${code}${carried}\n`, { mode: 0o600 });
  } catch { /* the sink itself is best-effort — never recurse, never throw */ }
}

// Test hook: clear the per-tag rate-limit state.
export function _resetSwallowForTest() {
  _seen.clear();
  _dirReady = false;
}
