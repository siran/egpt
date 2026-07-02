// heartbeat-loader.mjs — turn heartbeats into DECLARATIVE CONFIG (operator
// 2026-07-01: "at start, the spine reads all heartbeats from conversations and
// rooms, and writes a heartbeats.readonly.yaml. The fundamental heartbeat could
// be a heartbeat subblock in config — the default one — frequency: 1s, command:
// node alive.js").
//
// A heartbeat used to be hand-registered code in boot (the one hardcoded `alive`
// beat). This loader makes them uniform declarative entries collected at boot
// from three sources — the node config.yaml, every conversation's config.yaml,
// and every room's config.yaml — parses their cadence, materializes a spine-
// written readonly view (state/heartbeats.readonly.yaml, the same house pattern
// as the instanced-brain `readonly` block: a snapshot the operator reads but
// edits at the source), and registers each onto the dumb cadence registry
// (heartbeats.mjs). The alive-file writer is no longer special-cased: it is just
// the DEFAULT entry (a `builtin: 'alive'` action) injected when the node config
// declares none.
//
// Two phases, one module, because of a boot ordering constraint (see boot.mjs):
//   collect()  — pure-ish: read config + entity dirs, parse cadences → { entries,
//                finestMs }. Runs BEFORE createSpine so boot can size the tick to
//                the finest cadence.
//   activate() — bind each entry's ACTION (which needs spine.stats() + the
//                injected builtin writers), register them, write the readonly.yaml.
//                Runs AFTER createSpine.
//
// Every effectful edge is injected (listEntityDirs / readEntityConfig / spawn /
// io.writeFile / io.mkdir) so the whole loader is unit-testable against fakes and
// never touches the real profile. Nothing here is fatal: a bad frequency, a
// missing dir, a malformed entity config, a non-zero command exit — all log and
// carry on. A heartbeat is a deadman switch; one broken entry must never take the
// boot (or its siblings) down.

import { writeFile as fsWriteFile, mkdir as fsMkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import * as YAML from 'yaml';
import { EGPT_HOME } from '../egpt-home.mjs';

// ── frequency parser (pure) ─────────────────────────────────────────────────
// A number is taken as milliseconds; a string is `<quantity><unit>` with unit
// ms/s/m/h and an integer or decimal quantity ("500ms", "1s", "30s", "5m",
// "1.5h"). Anything else — a bare unitless string, garbage, zero/negative — is
// invalid and returns null (the entry is skipped + logged, never fatal).
const _UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
export function parseFrequency(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
  if (typeof v !== 'string') return null;
  const m = v.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/);
  if (!m) return null;
  const q = Number(m[1]);
  if (!Number.isFinite(q) || q <= 0) return null;
  return Math.round(q * _UNIT_MS[m[2]]);
}

// ── entity heartbeats block (pure) ──────────────────────────────────────────
// Read an entity's config.yaml text the SAME tolerant way transcription-service
// does (absent/'' /malformed → no heartbeats, never throws) and return its
// `heartbeats:` map, or {} when there is none.
export function parseHeartbeatsBlock(yamlText) {
  let doc = {};
  if (yamlText && yamlText.trim()) {
    try { doc = YAML.parse(yamlText) ?? {}; } catch { doc = {}; }
  }
  const hb = (doc && typeof doc === 'object') ? doc.heartbeats : null;
  return (hb && typeof hb === 'object' && !Array.isArray(hb)) ? hb : {};
}

// Normalize one raw `{ frequency, command?, builtin? }` declaration into a
// registered entry, or null (skipped + logged) when it names no runnable action
// or its cadence won't parse. `isAlive` gives the default builtin its identity:
// an `alive` entry with no command falls back to the in-process writer.
function _normalizeEntry({ name, source, cwd, raw, isAlive, aliveFallbackMs, onLog }) {
  const everyMs = parseFrequency(raw?.frequency);
  // The alive beat is the deadman — never let a bad/absent cadence disable it;
  // fall back to the boot aliveMs (or 60s). Every other entry with an unparseable
  // frequency is skipped so a typo can't fire a command every single tick.
  const ms = everyMs ?? (isAlive ? aliveFallbackMs : null);
  if (ms == null) { onLog(`${name}: invalid frequency ${JSON.stringify(raw?.frequency)} — skipped`); return null; }

  if (typeof raw?.command === 'string' && raw.command.trim()) {
    // A command REPLACES the builtin (operator's prerogative even for alive; the
    // deadman consequences are theirs). Shell line, run as written.
    return { name, source, everyMs: ms, rawFrequency: raw.frequency, action: { kind: 'command', command: raw.command, cwd } };
  }
  const builtin = typeof raw?.builtin === 'string' ? raw.builtin : (isAlive ? 'alive' : null);
  if (builtin) return { name, source, everyMs: ms, rawFrequency: raw.frequency, action: { kind: 'builtin', builtin } };

  onLog(`${name}: no command or builtin — skipped`);
  return null;
}

/**
 * @param {object} deps
 * @param {() => object} deps.getConfig                 node config (reads config.heartbeats)
 * @param {number} [deps.aliveMs]                       boot's aliveMs; 0 = don't inject the default alive (test contract)
 * @param {() => Promise<Array<{dir:string, ns:string}>>} deps.listEntityDirs  conversation + room folders (ns = the namespace prefix)
 * @param {(dir:string) => Promise<object>} deps.readEntityConfig              a folder's heartbeats: map ({} when none)
 * @param {(cmd:string, opts:object) => any} deps.spawn                        child_process.spawn seam (shell:true)
 * @param {object} [deps.env]                           base env commands inherit (boot: process.env)
 * @param {string} [deps.egptHome]                      EGPT_HOME (spawn env + readonly path)
 * @param {string} [deps.procCwd]                       cwd for node-level command heartbeats (the checkout)
 * @param {{writeFile?:Function, mkdir?:Function}} [deps.io]                   readonly.yaml IO seam
 * @param {(m:string) => void} [deps.onLog]
 */
export function createHeartbeatLoader({
  getConfig,
  aliveMs = 0,
  listEntityDirs = async () => [],
  readEntityConfig = async () => ({}),
  spawn,
  env = {},
  egptHome = EGPT_HOME,
  procCwd = process.cwd(),
  io = {},
  onLog = () => {},
} = {}) {
  const writeFile = io.writeFile ?? fsWriteFile;
  const mkdir = io.mkdir ?? fsMkdir;
  const aliveFallbackMs = aliveMs > 0 ? aliveMs : 60_000;

  let _entries = null;   // set by collect(), consumed by activate()

  // ── phase 1: collect + parse (no spine.stats yet) ─────────────────────────
  async function collect() {
    const entries = [];
    const nodeBlock = getConfig()?.heartbeats;
    const node = (nodeBlock && typeof nodeBlock === 'object' && !Array.isArray(nodeBlock)) ? nodeBlock : {};

    // 1. Node-level entries (config.heartbeats). `alive` is the default beat's
    //    name: a present `alive` block WINS entirely — its frequency + optional
    //    command replace the injected default. `alive: false` DISABLES the
    //    deadman (documented consequence: daemon-runtime respawn-loops with
    //    escalating backoff "until the service is stopped or the heartbeat
    //    restored" — operator 2026-07-01; src/daemon-runtime.mjs wedge path).
    let aliveDeclared = false;
    for (const [name, raw] of Object.entries(node)) {
      const isAlive = name === 'alive';
      if (isAlive) {
        aliveDeclared = true;
        if (raw === false) { onLog('alive disabled (heartbeats.alive: false) — the supervisor will respawn-loop with backoff until restored'); continue; }
      }
      if (!raw || typeof raw !== 'object') { onLog(`${name}: not a heartbeat block — skipped`); continue; }
      const e = _normalizeEntry({ name, source: 'config', cwd: procCwd, raw, isAlive, aliveFallbackMs, onLog });
      if (e) entries.push(e);
    }

    // 2. Default alive: inject the builtin writer when the node config declares
    //    no `alive` AND boot asked for it (aliveMs > 0). aliveMs === 0 (tests)
    //    means "don't inject" — but an explicit config alive above still loads.
    if (!aliveDeclared && aliveMs > 0) {
      entries.push({ name: 'alive', source: 'config', everyMs: aliveMs, rawFrequency: aliveMs, action: { kind: 'builtin', builtin: 'alive' } });
    }

    // 3. Entity entries: every conversation/room folder's config.yaml heartbeats:
    //    block. Names are namespaced (`<surface>/<slug>:<name>`, `room/<name>:
    //    <name>`) so they can't collide with node-level names. Tolerant: a
    //    missing/malformed config yields no entries.
    let dirs = [];
    try { dirs = await listEntityDirs(); } catch (e) { onLog(`listEntityDirs: ${e?.message ?? e}`); }
    for (const { dir, ns } of dirs) {
      let block = {};
      try { block = (await readEntityConfig(dir)) ?? {}; } catch { block = {}; }
      for (const [name, raw] of Object.entries(block)) {
        if (!raw || typeof raw !== 'object') { onLog(`${ns}:${name}: not a heartbeat block — skipped`); continue; }
        const e = _normalizeEntry({ name: `${ns}:${name}`, source: dir, cwd: dir, raw, isAlive: false, aliveFallbackMs, onLog });
        if (e) entries.push(e);
      }
    }

    _entries = entries;
    const finestMs = entries.length ? Math.min(...entries.map((e) => e.everyMs)) : null;
    return { entries, finestMs };
  }

  // A command action: on each due tick spawn a shell line (operator command lines
  // work as written). OVERLAP GUARD — a still-running previous spawn skips this
  // tick + logs, so a slow command never piles up. Non-zero exit only logs.
  function _makeCommandBeat(entry, stats) {
    let running = false;
    return () => {
      if (running) { onLog(`${entry.name}: previous run still active — skipping`); return; }
      running = true;
      const { queueDepth = 0, oldestMs = 0 } = stats?.() ?? {};
      const childEnv = { ...env, EGPT_HOME: egptHome, EGPT_QUEUE_DEPTH: String(queueDepth), EGPT_QUEUE_OLDEST_MS: String(oldestMs) };
      let child;
      try { child = spawn(entry.action.command, { shell: true, cwd: entry.action.cwd, env: childEnv }); }
      catch (e) { running = false; onLog(`${entry.name}: spawn failed: ${e?.message ?? e}`); return; }
      child?.on?.('error', (e) => { running = false; onLog(`${entry.name}: ${e?.message ?? e}`); });
      child?.on?.('exit', (code) => { running = false; if (code) onLog(`${entry.name}: exited ${code}`); });
    };
  }

  // ── phase 2: bind actions + register + materialize the readonly view ──────
  async function activate({ registry, builtins = {}, stats } = {}) {
    const entries = _entries ?? (await collect()).entries;
    for (const entry of entries) {
      let fn;
      if (entry.action.kind === 'builtin') {
        fn = builtins[entry.action.builtin];
        if (typeof fn !== 'function') { onLog(`${entry.name}: unknown builtin '${entry.action.builtin}' — not registered`); continue; }
      } else {
        fn = _makeCommandBeat(entry, stats);
      }
      registry.register(entry.name, entry.everyMs, fn);
    }
    await _writeReadonly(entries);
    return { entries, finestMs: entries.length ? Math.min(...entries.map((e) => e.everyMs)) : null };
  }

  async function _writeReadonly(entries) {
    const header =
      '# heartbeats.readonly.yaml — spine-written at boot. DO NOT EDIT.\n' +
      '# A read-only snapshot of every heartbeat the spine loaded: the node\n' +
      '# config.yaml heartbeats: block + each conversation/room config.yaml\n' +
      '# heartbeats: block. To change one, edit config.yaml (or the entity\'s own\n' +
      '# config.yaml) and /restart. Regenerated on every boot, overwriting.\n\n';
    const list = entries.map((e) => {
      const row = {
        name: e.name,
        source: e.source,
        frequency: e.rawFrequency,
        frequency_ms: e.everyMs,
        action: e.action.kind === 'builtin' ? `builtin: ${e.action.builtin}` : `command: ${e.action.command}`,
      };
      if (e.action.kind === 'command') row.cwd = e.action.cwd;
      return row;
    });
    const path = join(egptHome, 'state', 'heartbeats.readonly.yaml');
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, header + YAML.stringify({ heartbeats: list }, { lineWidth: 0 }), 'utf8');
    } catch (e) { onLog(`readonly write: ${e?.message ?? e}`); }
  }

  return { collect, activate };
}
