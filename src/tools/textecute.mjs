// tools/textecute.mjs — TEXTECUTABLES: a script whose language is plain text and
// whose interpreter is one Claude turn with tools (operator 2026-07-02):
//
//   "textecutables: script.x.md — the idea is to write a script in plain text,
//    AI executes it. For example:
//      1. open chrome over CDP
//      2. open chatgpt on this conversation
//      3. copy the contents of this file into chatgpt click send
//      4. save chatgpt reply as a file"
//
// A `*.x.md` file IS the program; running it = one FRESH `claude` session reads
// the steps and DOES them, working in the script's own folder (relative paths in
// its steps resolve there). Every run is stateless — no --resume, no memory.
//
// THE .x.md EXTENSION IS CONSENT: only a file that DECLARES itself executable by
// ending in `.x.md` will run. A plain `.md` is refused before anything spawns.
// That double-extension is the whole safety convention — a stray markdown note is
// never mistaken for a script.
//
// THREE invocation surfaces, all the same runner:
//   1. CLI, by hand:   node src/tools/textecute.mjs path/to/script.x.md [--model X] [--effort Y] [--tools "..."]
//   2. A HEARTBEAT:    a `command: node src/tools/textecute.mjs <script>` in any
//      config.yaml `heartbeats:` block (node / conversation / room) runs the script
//      on cadence, overlap-guarded by the spine (a still-running previous spawn
//      skips the tick — a browser script legitimately taking minutes won't pile up).
//   3. E itself:       E runs `node src/tools/textecute.mjs <script>` via Bash
//      mid-conversation to execute a plain-text script it (or the operator) wrote.
//
// Trust: `allowedTools` defaults to 'all' (the E / butler precedent — a
// textecutable is operator-authored automation, same trust level as E). NO
// timeout (house rule: no fake timeouts — CDP/browser scripts run minutes; the
// heartbeat overlap guard already prevents cadence pile-up).

import { readFile as fsReadFile, appendFile as fsAppendFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWarmCliSession } from '../warm-cli-session.mjs';
import { readConfigSync } from './config-io.mjs';

// The interpreter framing — lean, no ceremony. Prepended to the verbatim script.
function framePrompt(base, content) {
  return `This file is a TEXTECUTABLE — a script written in plain text. You are its interpreter: EXECUTE its steps in order using your tools, don't discuss them. Work from this directory. If a step fails, say which and why, then stop.\n\n--- ${base} ---\n${content}`;
}

/**
 * Run a textecutable: one fresh, stateless Claude turn that executes the plain-text
 * script, cwd = the script's own directory. Never throws — returns a result object.
 *
 * @param {string} scriptPath                 path to a `*.x.md` file
 * @param {object} [opts]
 * @param {string} [opts.model]               model override (else config.default_brain.model when that brain is claude-typed, else login default)
 * @param {string} [opts.effort]              reasoning effort override (same fallback rule as model)
 * @param {string|string[]} [opts.tools]      allowedTools (default 'all')
 * @param {Function} [opts.makeSession]       session factory (default createWarmCliSession) — inject a fake in tests
 * @param {Function} [opts.readConfig]        config reader (default readConfigSync) — inject in tests
 * @param {{readFile?:Function, appendFile?:Function}} [opts.io]
 * @returns {Promise<{ok:boolean, text?:string, error?:string}>}
 */
export async function textecute(scriptPath, opts = {}) {
  const readFile = opts.io?.readFile ?? fsReadFile;
  const appendFile = opts.io?.appendFile ?? fsAppendFile;
  const makeSession = opts.makeSession ?? createWarmCliSession;
  const readConfig = opts.readConfig ?? readConfigSync;

  // Extension-as-consent: refuse anything that isn't a self-declared `*.x.md`,
  // BEFORE reading or spawning.
  if (!/\.x\.md$/i.test(String(scriptPath ?? ''))) {
    return { ok: false, error: `textecute: not a textecutable (must end in .x.md): ${scriptPath}` };
  }

  let content;
  try {
    content = await readFile(scriptPath, 'utf8');
  } catch (e) {
    return { ok: false, error: `textecute: cannot read ${scriptPath}: ${e?.message ?? e}` };
  }

  // model / effort: opts win, else the node's default brain, else the login default.
  // The default_brain fallback only applies when that brain actually IS the claude
  // CLI — a codex-typed default_brain would leak its model id (gpt-5.4-mini) into
  // the `claude` args and break the spawn. Absent `type` counts as ccode;
  // 'claude-code' is the legacy alias (same acceptance as compact-being.mjs
  // compactableBeings). Any other type falls through to the login default.
  let cfg = {};
  try { cfg = readConfig() ?? {}; } catch { cfg = {}; }
  const db = cfg.default_brain ?? {};
  const dbType = db.type ?? 'ccode';
  const dbIsClaude = dbType === 'ccode' || dbType === 'claude-code';
  const model = opts.model ?? (dbIsClaude ? db.model : undefined);
  const effort = opts.effort ?? (dbIsClaude ? db.effort : undefined);

  const dir = dirname(scriptPath);
  const prompt = framePrompt(basename(scriptPath), content);
  const logPath = `${scriptPath}.log`;

  const session = makeSession({
    cwd: dir,                        // the script's world — relative steps resolve here
    allowedTools: opts.tools ?? 'all',
    model,
    effort,
    sessionId: null,                 // every run is a fresh, stateless session
  });

  try {
    const { text } = await session.turn(prompt);
    await appendFile(logPath, `--- run ${new Date().toISOString()} ---\n${text}\n`);
    return { ok: true, text };
  } catch (e) {
    const error = e?.message ?? String(e);
    try { await appendFile(logPath, `--- run ${new Date().toISOString()} ---\n!! failed: ${error}\n`); } catch { /* log is best-effort */ }
    return { ok: false, error };
  } finally {
    try { session.close(); } catch { /* already closing */ }
  }
}

// Parse the CLI argv (process.argv.slice(2)) into { path, model, effort, tools }.
// Accepts both `--flag value` and `--flag=value`. Pure — unit-tested directly.
export function parseArgs(argv = []) {
  const out = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.match(/^--(model|effort|tools)=(.*)$/s);
    if (eq) { out[eq[1]] = eq[2]; continue; }
    if (a === '--model' || a === '--effort' || a === '--tools') { out[a.slice(2)] = argv[++i]; continue; }
    rest.push(a);
  }
  out.path = rest[0];
  return out;
}

// ── CLI: `node src/tools/textecute.mjs <script.x.md> [--model X] [--effort Y] [--tools "..."]`
const _invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (_invokedDirectly) {
  const { path, model, effort, tools } = parseArgs(process.argv.slice(2));
  if (!path) {
    console.error('textecute: usage: node src/tools/textecute.mjs <script.x.md> [--model X] [--effort Y] [--tools "..."]');
    process.exit(1);
  }
  const r = await textecute(path, { model, effort, tools });
  if (r.ok) {
    process.stdout.write((r.text ?? '') + '\n');
    process.exit(0);
  }
  console.error(r.error ?? 'textecute: failed');
  process.exit(1);
}
