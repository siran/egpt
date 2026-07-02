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
// (heartbeats.mjs). The alive-file writer is no longer special-cased NOR a
// `builtin:` action — actions are COMMANDS only now. The alive beat is just the
// DEFAULT command entry (boot's `aliveCommand`, the one-liner `echo beat >
// state/alive.txt`, cwd = EGPT_HOME) injected when the node config declares no
// `alive`. This is the point: the readonly.yaml shows the REAL command for EVERY
// entry, alive included — nothing is hidden behind an opaque builtin label
// (operator 2026-07-02). Liveness is the alive.txt file's MTIME, so any command
// that writes the file is a valid beat and its content is freeform.
//
// TRIGGERS (operator 2026-07-02): an entry declares EITHER `frequency:` (recurring)
// OR `when:` (a ONE-SHOT wall-clock time — fires once at/after it, then never
// again; both set → invalid, skipped + logged). ACTIONS: EITHER `command:` (a
// shell line) OR `ai_run:` (sugar the loader expands to `node <textecute.mjs>
// <script.x.md>`; both set → invalid, skipped + logged). Timezone-less `when:`
// times resolve in config `default_time_zone` (else the machine's local zone).
//
// HOT RELOAD (operator 2026-07-02): the loader also registers ONE internal beat
// (heartbeats-reload) that, when state/heartbeats.readonly.yaml is DELETED,
// re-collects everything (node config once-at-boot, but entity folders re-
// enumerated fresh — so NEW conversations/rooms + edited entity config.yaml ARE
// picked up), re-registers, and rewrites the file. No restart.
//
// Two phases, one module, because of a boot ordering constraint (see boot.mjs):
//   collect()  — pure-ish: read config + entity dirs, parse cadences → { entries,
//                finestMs }. Runs BEFORE createSpine so boot can size the tick to
//                the finest cadence.
//   activate() — bind each entry's command ACTION (the beat reads spine.stats()
//                for the pump env), register them + the internal reload driver,
//                write the readonly.yaml. Runs AFTER createSpine.
//
// Every effectful edge is injected (listEntityDirs / readEntityConfig / spawn /
// io.writeFile / io.mkdir / existsSync / now) so the whole loader is unit-testable
// against fakes and never touches the real profile. Nothing here is fatal: a bad
// frequency, a bad when, a missing dir, a malformed entity config, a non-zero
// command exit, a reload error — all log and carry on. A heartbeat is a deadman
// switch; one broken entry must never take the boot (or its siblings) down.

import { writeFile as fsWriteFile, mkdir as fsMkdir } from 'node:fs/promises';
import { existsSync as fsExistsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as YAML from 'yaml';
import { EGPT_HOME } from '../egpt-home.mjs';

// The loader owns the ai_run sugar, so it resolves textecute.mjs itself (relative
// to this file: src/spine/ → src/tools/). Absolute path, so the expanded command
// runs from any entity cwd.
const TEXTECUTE_PATH = fileURLToPath(new URL('../tools/textecute.mjs', import.meta.url));

const INTERNAL_RELOAD_NAME = 'heartbeats-reload';
// A `when:` up to this far in the PAST still fires once (a grace window covering a
// slow boot / brief downtime); older than this at load time is stale — skipped so
// a long-dead node doesn't re-fire every past one-shot when it finally comes up.
const _WHEN_GRACE_MS = 2 * 60_000;

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

// ── time zone resolution (pure) ─────────────────────────────────────────────
// A small documented alias table (case-insensitive) on top of full IANA names.
const _TZ_ALIASES = {
  'new york': 'America/New_York',
  et: 'America/New_York', est: 'America/New_York', edt: 'America/New_York',
  ct: 'America/Chicago', cst: 'America/Chicago', cdt: 'America/Chicago',
  mt: 'America/Denver', mst: 'America/Denver', mdt: 'America/Denver',
  pt: 'America/Los_Angeles', pst: 'America/Los_Angeles', pdt: 'America/Los_Angeles',
  utc: 'UTC', gmt: 'UTC',
};

function _isValidZone(tz) {
  try { new Intl.DateTimeFormat(undefined, { timeZone: tz }); return true; }
  catch { return false; }
}

/**
 * Resolve a config `default_time_zone` value to a concrete IANA zone name.
 * A canonical IANA name (validated via Intl) wins; else a case-insensitive alias
 * (ET/EST/EDT → America/New_York, "New York" → America/New_York, UTC/GMT → UTC, …);
 * else (invalid / absent) the machine's local zone (an INVALID value is logged).
 */
export function resolveTimeZone(value, { onLog } = {}) {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  if (value == null || value === '') return local;   // absent → machine local, silently
  const raw = String(value).trim();
  const alias = _TZ_ALIASES[raw.toLowerCase()];
  if (alias) return alias;
  if (_isValidZone(raw)) return raw;
  onLog?.(`default_time_zone: invalid zone ${JSON.stringify(value)} — using machine local ${local}`);
  return local;
}

// How far ahead of UTC (ms) the named zone is at instant `epochMs`. Read back the
// wall-clock the zone shows for that instant and diff it against the instant.
function _offsetMs(epochMs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const map = {};
  for (const p of dtf.formatToParts(new Date(epochMs))) if (p.type !== 'literal') map[p.type] = p.value;
  const asUTC = Date.UTC(+map.year, +map.month - 1, +map.day, +map.hour, +map.minute, +map.second);
  return asUTC - epochMs;
}

/**
 * Convert a WALL-CLOCK time in a named IANA zone to epoch ms, DST-correct, with no
 * date library. Interpret the components as if UTC (the "naive" instant), read the
 * zone's offset there, subtract it, then re-read the offset at the corrected instant
 * (the second pass gets DST-boundary times right). month is 1-12.
 *   e.g. {2026,1,15,12,00} America/New_York → 17:00Z (EST −5)
 *        {2026,7, 2, 8,20} America/New_York → 12:20Z (EDT −4)
 */
export function zonedWallClockToEpoch({ year, month, day, hour, minute, second = 0 }, timeZone) {
  const zone = timeZone || undefined;   // undefined → the machine's local zone (Intl default)
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  try {
    const candidate = naive - _offsetMs(naive, zone);
    return naive - _offsetMs(candidate, zone);
  } catch { return naive; }   // bad zone → treat the wall-clock as UTC (defensive; resolveTimeZone guards the real path)
}

// ── when parser (pure) ──────────────────────────────────────────────────────
// A one-shot wall-clock time in `timeZone`. Accepted forms:
//   • M/D/YYYY H:MMa|p   12-hour, am/pm (a/p/am/pm, optional space): "7/2/2026 8:20a"
//   • M/D/YYYY HH:MM     24-hour:                                    "7/2/2026 08:20"
//   • YYYY-MM-DDTHH:MM   ISO, optional :seconds:                     "2026-07-02T08:20"
// Anything else → null (skipped + logged, never fatal).
function _assemble(year, month, day, hour, minute, second, timeZone) {
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 ||
      minute < 0 || minute > 59 || second < 0 || second > 59) return null;
  return zonedWallClockToEpoch({ year, month, day, hour, minute, second }, timeZone);
}
export function parseWhen(str, { timeZone } = {}) {
  if (typeof str !== 'string') return null;
  const s = str.trim();
  if (!s) return null;

  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);   // ISO
  if (m) return _assemble(+m[1], +m[2], +m[3], +m[4], +m[5], m[6] ? +m[6] : 0, timeZone);

  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*([ap])m?$/i);   // 12-hour am/pm
  if (m) {
    let h = +m[4];
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (/p/i.test(m[6]) ? 12 : 0);
    return _assemble(+m[3], +m[1], +m[2], h, +m[5], 0, timeZone);
  }

  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/);   // 24-hour
  if (m) return _assemble(+m[3], +m[1], +m[2], +m[4], +m[5], 0, timeZone);

  return null;
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

// A both-command-and-ai_run collision returns this sentinel (truthy, so it isn't
// mistaken for "no action") — the entry is invalid and skipped.
const _INVALID_ACTION = Symbol('invalid-action');

// Resolve the ACTION for a raw entry: `command:` (verbatim shell line) or `ai_run:`
// (expanded to `node "<textecute.mjs>" "<script>"`, script relative → the entry cwd).
// Mutually exclusive. `alive` with no explicit action falls back to aliveCommand.
function _resolveAction({ name, raw, isAlive, aliveCommand, cwd, aliveCwd, onLog }) {
  const hasCommand = typeof raw?.command === 'string' && raw.command.trim();
  const hasAiRun = typeof raw?.ai_run === 'string' && raw.ai_run.trim();
  if (hasCommand && hasAiRun) { onLog(`${name}: both command and ai_run set — skipped (use one action)`); return _INVALID_ACTION; }
  if (hasAiRun) {
    const script = raw.ai_run.trim();
    return { kind: 'command', command: `node "${TEXTECUTE_PATH}" "${script}"`, cwd, aiRun: script };
  }
  if (hasCommand) return { kind: 'command', command: raw.command, cwd };
  // The DEFAULT alive one-liner writes state/alive.txt relative to the profile,
  // so it runs with cwd = EGPT_HOME (aliveCwd). Non-alive with no action → null.
  if (isAlive) return { kind: 'command', command: aliveCommand, cwd: aliveCwd };
  return null;
}

// Normalize one raw declaration into a registered entry, or null (skipped + logged)
// when a trigger/action is missing, unparseable, or the two triggers/actions
// collide. `isAlive` gives the deadman its defaults (aliveFallbackMs + aliveCommand).
function _normalizeEntry({ name, source, cwd, raw, isAlive, aliveFallbackMs, aliveCommand, aliveCwd, timeZone, nowMs, onLog }) {
  const hasFrequency = raw?.frequency != null;
  const hasWhen = raw?.when != null;
  if (hasFrequency && hasWhen) { onLog(`${name}: both frequency and when set — skipped (use one trigger)`); return null; }

  const action = _resolveAction({ name, raw, isAlive, aliveCommand, cwd, aliveCwd, onLog });
  if (action === _INVALID_ACTION) return null;

  // ── when: a one-shot at a wall-clock time ──
  if (hasWhen) {
    if (!action) { onLog(`${name}: no command or ai_run — skipped`); return null; }
    const whenMs = parseWhen(String(raw.when), { timeZone });
    if (whenMs == null) { onLog(`${name}: invalid when ${JSON.stringify(raw.when)} — skipped`); return null; }
    if (nowMs - whenMs > _WHEN_GRACE_MS) { onLog(`${name}: stale when (${raw.when}) — not refiring`); return null; }
    return { name, source, whenMs, rawWhen: raw.when, fired: false, action };
  }

  // ── frequency: recurring (alive's cadence never disarmed by a bad frequency) ──
  const everyMs = parseFrequency(raw?.frequency);
  const ms = everyMs ?? (isAlive ? aliveFallbackMs : null);
  if (ms == null) { onLog(`${name}: invalid frequency ${JSON.stringify(raw?.frequency)} — skipped`); return null; }
  if (!action) { onLog(`${name}: no command — skipped`); return null; }
  return { name, source, everyMs: ms, rawFrequency: raw.frequency, action };
}

/**
 * @param {object} deps
 * @param {() => object} deps.getConfig                 node config (reads config.heartbeats + config.default_time_zone)
 * @param {number} [deps.aliveMs]                       boot's aliveMs; 0 = don't inject the default alive (test contract)
 * @param {string} [deps.aliveCommand]                  the default alive command boot passes in: the one-liner `echo beat > state/alive.txt` (run with cwd = egptHome so the relative state/ resolves into the profile)
 * @param {() => number} [deps.now]                     clock for the stale-`when` check at load time
 * @param {() => Promise<Array<{dir:string, ns:string}>>} deps.listEntityDirs  conversation + room folders (ns = the namespace prefix)
 * @param {(dir:string) => Promise<object>} deps.readEntityConfig              a folder's heartbeats: map ({} when none)
 * @param {(cmd:string, opts:object) => any} deps.spawn                        child_process.spawn seam (shell:true)
 * @param {object} [deps.env]                           base env commands inherit (boot: process.env)
 * @param {string} [deps.egptHome]                      EGPT_HOME (spawn env + readonly path)
 * @param {string} [deps.procCwd]                       cwd for node-level command heartbeats (the checkout)
 * @param {{writeFile?:Function, mkdir?:Function}} [deps.io]                   readonly.yaml IO seam
 * @param {(p:string) => boolean} [deps.existsSync]     readonly-file existence probe for hot reload (injectable)
 * @param {number} [deps.reloadIntervalMs]              how often the internal beat checks for the deleted readonly file (default 15s)
 * @param {(m:string) => void} [deps.onLog]
 */
export function createHeartbeatLoader({
  getConfig,
  aliveMs = 0,
  aliveCommand = '',
  now = () => Date.now(),
  listEntityDirs = async () => [],
  readEntityConfig = async () => ({}),
  spawn,
  env = {},
  egptHome = EGPT_HOME,
  procCwd = process.cwd(),
  io = {},
  existsSync = fsExistsSync,
  reloadIntervalMs = 15_000,
  onLog = () => {},
} = {}) {
  const writeFile = io.writeFile ?? fsWriteFile;
  const mkdir = io.mkdir ?? fsMkdir;
  const aliveFallbackMs = aliveMs > 0 ? aliveMs : 60_000;
  // The default alive one-liner writes state/alive.txt RELATIVE to the profile,
  // so it must run with cwd = EGPT_HOME (not procCwd). Other node-level beats keep
  // procCwd (the checkout).
  const aliveCwd = egptHome;
  const readonlyPath = join(egptHome, 'state', 'heartbeats.readonly.yaml');

  let _entries = null;    // set by collect(), consumed by activate()
  let _registry = null;   // bound in activate() — the registry hot reload replaces entries on
  let _stats = null;      // bound in activate() — the pump-stats source for command env
  let _bootTickMs = 0;    // bound in activate() — the fixed boot tick, for the finer-cadence warning
  let _reloading = false; // reentrancy guard: a reload in flight blocks another

  // finestMs is the min RECURRING cadence — `when:` one-shots ride the tick and
  // must not tighten it (a 30s tick fires them within 30s of the time, which is fine).
  function _finestMs(entries) {
    const ms = entries.filter((e) => e.everyMs != null).map((e) => e.everyMs);
    return ms.length ? Math.min(...ms) : null;
  }

  // ── phase 1: collect + parse (no spine.stats yet) ─────────────────────────
  async function collect() {
    const timeZone = resolveTimeZone(getConfig()?.default_time_zone, { onLog });
    const nowMs = now();
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
      const e = _normalizeEntry({ name, source: 'config', cwd: procCwd, raw, isAlive, aliveFallbackMs, aliveCommand, aliveCwd, timeZone, nowMs, onLog });
      if (e) entries.push(e);
    }

    // 2. Default alive: inject the default alive COMMAND (boot's aliveCommand,
    //    `echo beat > state/alive.txt`, cwd = EGPT_HOME so the relative state/
    //    resolves into the profile) when the node config declares no `alive` AND
    //    boot asked for it (aliveMs > 0). aliveMs === 0 (tests) means "don't
    //    inject" — but an explicit config alive above still loads. No builtin:
    //    the readonly view will show this real command.
    if (!aliveDeclared && aliveMs > 0) {
      entries.push({ name: 'alive', source: 'config', everyMs: aliveMs, rawFrequency: aliveMs, action: { kind: 'command', command: aliveCommand, cwd: aliveCwd } });
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
        const e = _normalizeEntry({ name: `${ns}:${name}`, source: dir, cwd: dir, raw, isAlive: false, aliveFallbackMs, aliveCommand, aliveCwd, timeZone, nowMs, onLog });
        if (e) entries.push(e);
      }
    }

    _entries = entries;
    return { entries, finestMs: _finestMs(entries) };
  }

  // Spawn an entry's command with the pump-stats env. onSettle() fires when the
  // child errors or exits (clears the caller's running/one-shot state).
  function _spawnAction(entry, stats, onSettle) {
    const { queueDepth = 0, oldestMs = 0 } = stats?.() ?? {};
    const childEnv = { ...env, EGPT_HOME: egptHome, EGPT_QUEUE_DEPTH: String(queueDepth), EGPT_QUEUE_OLDEST_MS: String(oldestMs) };
    let child;
    try { child = spawn(entry.action.command, { shell: true, cwd: entry.action.cwd, env: childEnv }); }
    catch (e) { onLog(`${entry.name}: spawn failed: ${e?.message ?? e}`); onSettle?.(); return; }
    child?.on?.('error', (e) => { onLog(`${entry.name}: ${e?.message ?? e}`); onSettle?.(); });
    child?.on?.('exit', (code) => { if (code) onLog(`${entry.name}: exited ${code}`); onSettle?.(); });
  }

  // A recurring command action: on each due tick spawn the shell line. OVERLAP
  // GUARD — a still-running previous spawn skips this tick + logs, so a slow
  // command never piles up. Non-zero exit only logs.
  function _makeCommandBeat(entry, stats) {
    let running = false;
    return () => {
      if (running) { onLog(`${entry.name}: previous run still active — skipping`); return; }
      running = true;
      _spawnAction(entry, stats, () => { running = false; });
    };
  }

  // A one-shot action: fires exactly once, at/after entry.whenMs. `fired` is set
  // BEFORE the spawn so a re-entrant tick can never double-fire it.
  function _makeWhenBeat(entry, stats) {
    return (nowTick) => {
      if (entry.fired) return;
      if (nowTick < entry.whenMs) return;
      entry.fired = true;
      _spawnAction(entry, stats);
    };
  }

  function _registerBeat(entry) {
    if (entry.whenMs != null) {
      // A one-shot rides the tick (everyMs 0 = evaluated every runDue); the beat
      // gates on now >= whenMs && !fired, so it cannot tighten the boot tick.
      _registry.register(entry.name, 0, _makeWhenBeat(entry, _stats));
    } else {
      _registry.register(entry.name, entry.everyMs, _makeCommandBeat(entry, _stats));
    }
  }

  // ── hot reload: rebuild the whole set when the readonly file is deleted ────
  async function _reloadCheck() {
    if (_reloading) return;                    // reentrancy guard — a reload in flight blocks another
    if (existsSync(readonlyPath)) return;      // file present → nothing to do
    _reloading = true;
    try {
      onLog('state/heartbeats.readonly.yaml deleted — reloading heartbeats');
      const { entries, finestMs } = await collect();
      _registry.clear((name) => name === INTERNAL_RELOAD_NAME);   // drop old beats, keep the internal driver
      for (const entry of entries) _registerBeat(entry);
      if (finestMs != null && _bootTickMs > 0 && finestMs < _bootTickMs) {
        onLog(`reloaded cadence ${finestMs}ms finer than the boot tick ${_bootTickMs}ms — restart to honor it`);
      }
      await _writeReadonly(entries);
    } catch (e) {
      onLog(`reload failed: ${e?.message ?? e}`);   // never let a reload error kill the tick
    } finally {
      _reloading = false;
    }
  }

  // ── phase 2: bind command actions + register + materialize the readonly view ──
  async function activate({ registry, stats, tickMs = 0 } = {}) {
    const entries = _entries ?? (await collect()).entries;
    _registry = registry;
    _stats = stats;
    _bootTickMs = tickMs;
    for (const entry of entries) _registerBeat(entry);
    // One internal beat drives hot reload. It's loader infrastructure, not config,
    // so collect() never returns it and clear() keeps it across reloads. Registered
    // AFTER collect(), so its cadence never influences the boot tick sizing.
    registry.register(INTERNAL_RELOAD_NAME, reloadIntervalMs, _reloadCheck);
    await _writeReadonly(entries);
    return { entries, finestMs: _finestMs(entries) };
  }

  function _readonlyRow(e) {
    const row = { name: e.name, source: e.source };
    if (e.whenMs != null) row.when = e.rawWhen;
    else { row.frequency = e.rawFrequency; row.frequency_ms = e.everyMs; }
    // An ai_run entry shows BOTH the sugar and the resolved command; a plain
    // command shows just the command. Neither hides anything behind a label.
    if (e.action.aiRun) { row.action = `ai_run: ${e.action.aiRun}`; row.command = e.action.command; }
    else row.action = `command: ${e.action.command}`;
    row.cwd = e.action.cwd;
    return row;
  }

  async function _writeReadonly(entries) {
    const header =
      '# heartbeats.readonly.yaml — spine-written at boot. DO NOT EDIT.\n' +
      '# A read-only snapshot of every heartbeat the spine loaded: the node\n' +
      '# config.yaml heartbeats: block + each conversation/room config.yaml\n' +
      '# heartbeats: block. To change one, edit config.yaml (or the entity\'s own\n' +
      '# config.yaml) and /restart. DELETE this file to hot-reload every heartbeat\n' +
      '# within ~30s (no restart). Regenerated on every boot + reload, overwriting.\n\n';
    const list = entries.map(_readonlyRow);
    // Everything that ticks is listed (transparency): the internal reload driver too.
    list.push({
      name: INTERNAL_RELOAD_NAME,
      source: 'spine (internal)',
      frequency_ms: reloadIntervalMs,
      action: 'reload heartbeats when this file is deleted',
    });
    try {
      await mkdir(dirname(readonlyPath), { recursive: true });
      await writeFile(readonlyPath, header + YAML.stringify({ heartbeats: list }, { lineWidth: 0 }), 'utf8');
    } catch (e) { onLog(`readonly write: ${e?.message ?? e}`); }
  }

  return { collect, activate };
}
