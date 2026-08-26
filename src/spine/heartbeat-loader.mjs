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
// written readonly view (heartbeats.readonly.yaml, the same house pattern
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
// shell line) OR `script_path:` (sugar the loader expands to `node <textecute.mjs>
// <script.x.md>`; both set → invalid, skipped + logged). Timezone-less `when:`
// times resolve in config `default_time_zone` (else the machine's local zone).
//
// THE KEY WAS `ai_run:` UNTIL 2026-08-22. It named neither a path nor its type, while
// house style names paths explicitly (model_path, conversation_path, home_dir) — and now
// that `agent:` carries the "an AI runs this" meaning by naming WHO, the other key only
// has to name WHAT: `command:` is a shell line, `script_path:` is a script file. HARD
// rename, no alias: an entry still carrying `ai_run` is INVALID (skipped + logged naming
// the replacement), never silently actionless — a working beat must not degrade into a
// no-op.
//
// WHERE script_path RESOLVES FROM: the beat's cwd, which is the folder the beat was
// DECLARED in — the entity folder (~/.egpt/conversations/<surface>/<slug>/, a room being
// surface `room`) for an entity beat, the CHECKOUT (procCwd) for a node-level one. NOT a
// scripts/ subfolder: a bare `dj.x.md` is <that folder>/dj.x.md, and a script kept in a
// subfolder must say so (`scripts/dj.x.md`). Both action kinds use that same root — the
// spawned command inherits it as cwd, the turn path resolves against it explicitly.
//
// WHO RUNS A script_path (operator 2026-08-22): a bare `script_path:` spawns textecute.mjs,
// which opens its OWN CLI session — a turn that runs outside the being system entirely: no
// persona, no transcript, and (the reason this exists) no access_level, no allowed_users,
// no sandboxed. An entry may instead NAME the being that runs it — `agent: <being-id>`, a
// KEY of config.yaml's `agents:` map, never a handle — and then the loader dispatches a
// TURN for that being through the ONE turn path (brainpool.turn, injected as
// `dispatchTurn` by boot) in the entity the beat was declared in, so every confinement
// gate that guards an ordinary message turn guards this one too. The PROMPT is identical
// either way: textecute's own framePrompt, imported, never re-spelled. `agent:` +
// `command:` is invalid (a shell line has no being), `agent:` without `script_path:` is
// invalid, `agent:` naming a being config.yaml does not declare is invalid, `agent:` on a
// NODE-level beat is invalid (it names no entity to run in) — each skipped + logged like
// every other malformed entry. A turn beat is NOT an inbound message: it never touches
// gating.mjs, so a `mode: mention` being runs it without that also making the being answer
// un-addressed messages.
//
// THE WALK IS NOT HERE ANY MORE (2026-07-26). Reading the node config + every
// conversation folder + every room folder is ONE walk serving FOUR concerns
// (heartbeats, warm, transcription, members), so it moved to the config RESOLVER
// (src/spine/config-resolver.mjs) which layers the three rungs — config/config.yaml
// < config/conversations.yaml < <entity>/config.yaml. This loader consumes the
// resolved set: the node's `heartbeats:` block plus each entity's UNION-merged one.
// `heartbeats` is the resolver's one UNION block precisely so an entity declaring a
// beat CONTRIBUTES rather than replacing the node's (see its header).
//
// CONFIG REFRESH ON MESSAGE ARRIVAL (2026-08, replacing the 2026-07-02 tick-based hot
// reload): the reload TRIGGER is no longer the loop's own tick. spine.mjs's handleFast —
// the single ingestion path, before it dispatches a turn — calls an injected refreshConfig
// (wired in boot.mjs), which drives this loader's reload(): re-collect everything (node
// config once-at-boot, but entity folders re-enumerated fresh — so NEW conversations/rooms
// + edited entity config.yaml ARE picked up), re-register, rewrite all three files. No
// restart, no periodic timer, no self-checking beat — the trigger belongs to a real message
// arriving, not to a tick or to a task listed inside the set being reloaded.
//
// EVERY RUN IS OBSERVABLE (operator 2026-08-23: "when a heartbeat runs the agent does
// whatever. so log errors and triggers? as to know if it ran successfully"). A beat is
// unattended — nobody watches it fire — so each RUN logs exactly TWO lines through onLog
// (boot prefixes them `[heartbeat] `), one PAIR per run, keyed by the beat name:
//   <name>: fire command — <the shell line>        <name>: fire turn — <being> <script>
//   <name>: ok in 2.5s                             <name>: ok in 12.4s — <reply prefix>
//   <name>: FAILED in 0.9s — exited 3              <name>: FAILED in 600.0s — <message>
// ELAPSED is the point, not decoration: a beat that "succeeds" in 600s is a problem and
// must read as one without cross-referencing timestamps. The fire line lives in _fire (ONE
// path, both action kinds); the outcome lines live in each kind's runner because only it
// knows what "done" means (a child exit code / a resolved turn). Nothing else logs per
// tick — a not-due beat, a skipped one-shot and a plain tick are all silent. The one
// exception is the overlap-skip line, which IS the signal that something wedged.
//
// Three seams, one module, because of a boot ordering constraint (see boot.mjs):
//   collect()      — pure-ish: take the resolver's scan, parse cadences →
//                    { entries, finestMs }. Runs BEFORE createSpine so boot can
//                    size the tick to the finest cadence.
//   wrapRegistry() — capture the real cadence registry the spine ticks (heartbeats.mjs).
//                    Wired into services BEFORE createSpine.
//   activate()     — bind each entry's command ACTION (the beat reads spine.stats()
//                    for the pump env), register them, write the readonly.yaml. Runs
//                    AFTER createSpine.
//   reload()       — rebuild the whole set on demand (called from boot.mjs's
//                    refreshConfig, itself called from spine.mjs on message arrival).
//                    Reentrancy-guarded so a burst of messages can't pile up concurrent
//                    reloads.
//
// Every effectful edge is injected (the resolver / spawn / io.writeFile / io.mkdir
// / now) so the whole loader is unit-testable
// against fakes and never touches the real profile. Nothing here is fatal: a bad
// frequency, a bad when, a missing dir, a malformed entity config, a non-zero
// command exit, a reload error — all log and carry on. A heartbeat is a deadman
// switch; one broken entry must never take the boot (or its siblings) down.

import { writeFile as fsWriteFile, mkdir as fsMkdir, readFile as fsReadFile } from 'node:fs/promises';
import { basename, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as YAML from 'yaml';
import { EGPT_HOME } from '../egpt-home.mjs';
import { NODE_FILE } from './config-resolver.mjs';
// The script_path PROMPT CONTRACT and the .x.md consent rule both belong to textecute.mjs —
// the `agent:` turn path reuses them from there rather than owning a second copy (operator
// 2026-08-22: an .x.md script must read identically whichever surface interprets it).
import { framePrompt, isTextecutable } from '../tools/textecute.mjs';

// The loader owns the script_path sugar, so it resolves textecute.mjs itself (relative
// to this file: src/spine/ → src/tools/). Absolute path, so the expanded command
// runs from any entity cwd.
const TEXTECUTE_PATH = fileURLToPath(new URL('../tools/textecute.mjs', import.meta.url));

// A `when:` up to this far in the PAST still fires once (a grace window covering a
// slow boot / brief downtime); older than this at load time is stale — skipped so
// a long-dead node doesn't re-fire every past one-shot when it finally comes up.
const _WHEN_GRACE_MS = 2 * 60_000;

// ── run-log formatting (pure) ───────────────────────────────────────────────
// Elapsed reads at a glance: sub-second in ms, everything else in tenths of a
// second (so a 600s beat says `600.0s`, not `600000ms`).
function _elapsed(ms) { return ms < 1000 ? `${Math.max(0, Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`; }

// A turn's reply, squeezed to ONE greppable line. This is boot's old truncation (it used to
// log the reply itself); it moved here so there is a single outcome formatter for both kinds.
const _REPLY_MAX = 200;
function _replyPrefix(text) {
  const s = String(text ?? '').trim().replace(/\s+/g, ' ');
  return s.length > _REPLY_MAX ? `${s.slice(0, _REPLY_MAX)}…` : s;
}

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

// (parseHeartbeatsBlock lived here — a config.yaml TEXT → its heartbeats: map. The
// resolver parses each entity file ONCE into its whole doc now (parseEntityConfig) and
// hands this loader the block already layered across the rungs, so the block-specific
// text parser had no callers left.)

// A both-command-and-script_path collision returns this sentinel (truthy, so it isn't
// mistaken for "no action") — the entry is invalid and skipped.
const _INVALID_ACTION = Symbol('invalid-action');

// Resolve the ACTION for a raw entry: `command:` (verbatim shell line), `script_path:`
// (expanded to `node "<textecute.mjs>" "<script>"`, script relative → the entry cwd), or
// `agent:` + `script_path:` (a TURN for that being, dispatched through brainpool — see the
// header). Mutually exclusive. `alive` with no explicit action falls back to aliveCommand.
// `ns` is the entity namespace (`<surface>/<slug>`), absent for a node-level entry; `agents`
// is config.yaml's `agents:` map, the ONE registry an `agent:` value must be a key of.
function _resolveAction({ name, raw, isAlive, aliveCommand, cwd, aliveCwd, ns, agents = {}, onLog }) {
  const hasCommand = typeof raw?.command === 'string' && raw.command.trim();
  const hasScriptPath = typeof raw?.script_path === 'string' && raw.script_path.trim();
  const hasAgent = typeof raw?.agent === 'string' && raw.agent.trim();
  // The OLD key (2026-08-22 rename) is INVALID, not ignored: falling through would leave a
  // beat that used to run a script with no action at all — a silent no-op on a cadence the
  // operator still sees armed. The message carries the fix.
  if (raw && Object.prototype.hasOwnProperty.call(raw, 'ai_run')) { onLog(`${name}: ai_run: was renamed to script_path: — skipped`); return _INVALID_ACTION; }
  // A DECLARED-BUT-UNUSABLE agent: is invalid, never a silent fall-through — dropping to the
  // bare script_path branch here would run the very script the operator confined to a being
  // through textecute's unconfined session instead, exactly the failure this key exists to fix.
  if (raw?.agent != null && !hasAgent) { onLog(`${name}: agent ${JSON.stringify(raw.agent)} is not a being-id — skipped`); return _INVALID_ACTION; }
  if (hasCommand && hasScriptPath) { onLog(`${name}: both command and script_path set — skipped (use one action)`); return _INVALID_ACTION; }
  if (hasAgent && hasCommand) { onLog(`${name}: both agent and command set — skipped (a shell line has no being; agent: runs a script_path script)`); return _INVALID_ACTION; }
  if (hasAgent) {
    const being = raw.agent.trim().toLowerCase();
    if (!hasScriptPath) { onLog(`${name}: agent ${JSON.stringify(raw.agent)} without script_path — skipped (agent: names WHO runs the script_path script)`); return _INVALID_ACTION; }
    if (!ns) { onLog(`${name}: agent ${JSON.stringify(raw.agent)} on a node-level beat — skipped (a turn runs in a conversation/room; declare the beat in that entity's config.yaml)`); return _INVALID_ACTION; }
    if (!Object.prototype.hasOwnProperty.call(agents, being)) { onLog(`${name}: unknown agent ${JSON.stringify(raw.agent)} — skipped (agent: is a KEY of config.yaml agents:, not a handle)`); return _INVALID_ACTION; }
    const script = raw.script_path.trim();
    if (!isTextecutable(script)) { onLog(`${name}: script_path ${JSON.stringify(script)} is not a textecutable — skipped (must end in .x.md)`); return _INVALID_ACTION; }
    return { kind: 'turn', being, script, cwd, ns, scriptPath: script };
  }
  if (hasScriptPath) {
    const script = raw.script_path.trim();
    return { kind: 'command', command: `node "${TEXTECUTE_PATH}" "${script}"`, cwd, scriptPath: script };
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
function _normalizeEntry({ name, source, cwd, raw, isAlive, aliveFallbackMs, aliveCommand, aliveCwd, ns, agents, timeZone, nowMs, onLog }) {
  const hasFrequency = raw?.frequency != null;
  const hasWhen = raw?.when != null;
  if (hasFrequency && hasWhen) { onLog(`${name}: both frequency and when set — skipped (use one trigger)`); return null; }

  const action = _resolveAction({ name, raw, isAlive, aliveCommand, cwd, aliveCwd, ns, agents, onLog });
  if (action === _INVALID_ACTION) return null;

  // ── when: a one-shot at a wall-clock time ──
  if (hasWhen) {
    if (!action) { onLog(`${name}: no command or script_path — skipped`); return null; }
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
 * @param {object} deps.resolver                        the config RESOLVER (src/spine/config-resolver.mjs) — THE walk; supplies the node rung (heartbeats + default_time_zone), every entity's UNION-merged heartbeats block, the aggregate paths and the staleness probe
 * @param {number} [deps.aliveMs]                       boot's aliveMs; 0 = don't inject the default alive (test contract)
 * @param {string} [deps.aliveCommand]                  the default alive command boot passes in: the one-liner `echo beat > state/alive.txt` (run with cwd = egptHome so the relative state/ resolves into the profile)
 * @param {() => number} [deps.now]                     clock for the stale-`when` check at load time AND for each run's elapsed time
 * @param {(cmd:string, opts:object) => any} deps.spawn                        child_process.spawn seam (shell:true)
 * @param {(t:{being:string, ns:string, prompt:string, name:string}) => Promise<{text?:string}>} [deps.dispatchTurn]   an `agent:` beat's TURN, injected by boot (ns → the conversation, then brainpool.turn). The loader never imports the brain: it hands over the being, the entity and the framed prompt and lets boot run it through the ONE turn path. It RETURNS the turn result; the loader puts a prefix of `text` in the run's outcome line.
 * @param {object} [deps.env]                           base env commands inherit (boot: process.env)
 * @param {string} [deps.egptHome]                      EGPT_HOME (spawn env + the alive beat's cwd)
 * @param {string} [deps.procCwd]                       cwd for node-level command heartbeats (the checkout)
 * @param {{writeFile?:Function, mkdir?:Function}} [deps.io]                   readonly.yaml IO seam
 * @param {(m:string) => void} [deps.onLog]
 */
export function createHeartbeatLoader({
  resolver,
  aliveMs = 0,
  aliveCommand = '',
  now = () => Date.now(),
  spawn,
  dispatchTurn = null,
  env = {},
  egptHome = EGPT_HOME,
  procCwd = process.cwd(),
  io = {},
  onLog = () => {},
} = {}) {
  const writeFile = io.writeFile ?? fsWriteFile;
  const mkdir = io.mkdir ?? fsMkdir;
  const readFile = io.readFile ?? fsReadFile;
  const aliveFallbackMs = aliveMs > 0 ? aliveMs : 60_000;
  // The default alive one-liner writes state/alive.txt RELATIVE to the profile,
  // so it must run with cwd = EGPT_HOME (not procCwd). Other node-level beats keep
  // procCwd (the checkout).
  const aliveCwd = egptHome;
  const readonlyPath = resolver.paths.heartbeats;

  let _entries = null;    // set by collect(), consumed by activate()
  let _registry = null;   // bound in wrapRegistry() — the real registry reload replaces entries on
  let _stats = null;      // bound in activate() — the pump-stats source for command env
  let _bootTickMs = 0;    // bound in activate() — the fixed boot tick, for the finer-cadence warning
  let _reloading = false; // reentrancy guard: a reload in flight blocks another
  let _activated = false; // flipped by activate() — before it, reload() is a no-op (nothing loaded yet)

  // finestMs is the min RECURRING cadence — `when:` one-shots ride the tick and
  // must not tighten it (a 30s tick fires them within 30s of the time, which is fine).
  function _finestMs(entries) {
    const ms = entries.filter((e) => e.everyMs != null).map((e) => e.everyMs);
    return ms.length ? Math.min(...ms) : null;
  }

  // ── phase 1: collect + parse (no spine.stats yet) ─────────────────────────
  async function collect() {
    // ONE walk, owned by the resolver. It hands back the node rung and every entity's
    // UNION-merged heartbeats block already layered across the registry + folder rungs.
    const set = await resolver.collect();
    const nodeConfig = set.node.config ?? {};
    const timeZone = resolveTimeZone(nodeConfig.default_time_zone, { onLog });
    const nowMs = now();
    const entries = [];
    const nodeBlock = nodeConfig.heartbeats;
    const node = (nodeBlock && typeof nodeBlock === 'object' && !Array.isArray(nodeBlock)) ? nodeBlock : {};
    // THE agents REGISTRY, straight off the node rung the resolver just handed back — an
    // `agent:` value must be a key of it. No new injection: this is the same config object
    // boot reads, arriving through the seam that already carries it.
    const agentsMap = (nodeConfig.agents && typeof nodeConfig.agents === 'object' && !Array.isArray(nodeConfig.agents)) ? nodeConfig.agents : {};

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
      const e = _normalizeEntry({ name, source: NODE_FILE, cwd: procCwd, raw, isAlive, aliveFallbackMs, aliveCommand, aliveCwd, ns: null, agents: agentsMap, timeZone, nowMs, onLog });
      if (e) entries.push(e);
    }

    // 2. Default alive: inject the default alive COMMAND (boot's aliveCommand,
    //    `echo beat > state/alive.txt`, cwd = EGPT_HOME so the relative state/
    //    resolves into the profile) when the node config declares no `alive` AND
    //    boot asked for it (aliveMs > 0). aliveMs === 0 (tests) means "don't
    //    inject" — but an explicit config alive above still loads. No builtin:
    //    the readonly view will show this real command.
    if (!aliveDeclared && aliveMs > 0) {
      entries.push({ name: 'alive', source: NODE_FILE, everyMs: aliveMs, rawFrequency: aliveMs, action: { kind: 'command', command: aliveCommand, cwd: aliveCwd } });
    }

    // 3. Entity entries: each conversation/room's resolved heartbeats block (its
    //    conversations.yaml entry, then its own config.yaml — nearest wins WITHIN the
    //    entity; ACROSS entities and against the node block above it is a UNION, which
    //    is why this appends rather than replaces). Names are namespaced
    //    (`<surface>/<slug>:<name>`, `room/<name>:<name>`) so they can't collide with
    //    node-level names.
    for (const { dir, ns, heartbeats, heartbeatSource } of set.entities.values()) {
      for (const [name, raw] of Object.entries(heartbeats)) {
        if (!raw || typeof raw !== 'object') { onLog(`${ns}:${name}: not a heartbeat block — skipped`); continue; }
        const e = _normalizeEntry({ name: `${ns}:${name}`, source: heartbeatSource[name], cwd: dir, raw, isAlive: false, aliveFallbackMs, aliveCommand, aliveCwd, ns, agents: agentsMap, timeZone, nowMs, onLog });
        if (e) entries.push(e);
      }
    }

    _entries = entries;
    return { entries, finestMs: _finestMs(entries) };
  }

  // Spawn an entry's command with the pump-stats env. onSettle() fires when the
  // child errors or exits (clears the caller's running/one-shot state), and with it the
  // run's ONE outcome line: `ok in <elapsed>`, or `FAILED in <elapsed> — <reason>` carrying
  // the real reason (the exit code, the signal, the spawn error). A failure is still only
  // logged — never thrown, never fatal. The latch matters because a failed spawn can emit
  // BOTH 'error' and 'exit': one outcome per run, and onSettle exactly once.
  function _spawnAction(entry, stats, startedMs, onSettle) {
    const { queueDepth = 0, oldestMs = 0 } = stats?.() ?? {};
    const childEnv = { ...env, EGPT_HOME: egptHome, EGPT_QUEUE_DEPTH: String(queueDepth), EGPT_QUEUE_OLDEST_MS: String(oldestMs) };
    let settled = false;
    const settle = (failure) => {
      if (settled) return;
      settled = true;
      const el = _elapsed(now() - startedMs);
      onLog(failure ? `${entry.name}: FAILED in ${el} — ${failure}` : `${entry.name}: ok in ${el}`);
      onSettle?.();
    };
    let child;
    try { child = spawn(entry.action.command, { shell: true, cwd: entry.action.cwd, env: childEnv }); }
    catch (e) { settle(`spawn failed: ${e?.message ?? e}`); return; }
    child?.on?.('error', (e) => settle(e?.message ?? e));
    child?.on?.('exit', (code, signal) => settle(code === 0 ? null : (signal ? `killed by ${signal}` : `exited ${code}`)));
  }

  // An `agent:` action: read the script FRESH (an edited *.x.md takes effect on the next
  // beat, exactly as it does for the spawned textecute), frame it with textecute's OWN
  // framing, and hand being + entity + prompt to boot's injected dispatcher, which runs it
  // through brainpool.turn. Never throws — a failure logs like a non-zero command exit, and
  // onSettle ALWAYS runs, so the overlap guard below cannot get stuck closed. Either way it
  // logs the run's ONE outcome line; on success with a prefix of the dispatcher's reply,
  // which is the only trace a turn otherwise leaves (its output is the script's business).
  async function _dispatchTurn(entry, startedMs, onSettle) {
    const { being, script, cwd, ns } = entry.action;
    try {
      if (typeof dispatchTurn !== 'function') throw new Error('no turn dispatcher wired — boot injects dispatchTurn');
      const path = resolvePath(cwd, script);
      const content = await readFile(path, 'utf8');
      const res = await dispatchTurn({ being, ns, name: entry.name, prompt: framePrompt(basename(path), content) });
      const reply = _replyPrefix(res?.text);
      onLog(`${entry.name}: ok in ${_elapsed(now() - startedMs)}${reply ? ` — ${reply}` : ''}`);
    } catch (e) {
      onLog(`${entry.name}: FAILED in ${_elapsed(now() - startedMs)} — ${e?.message ?? e}`);
    } finally {
      onSettle?.();
    }
  }

  // Run an entry's action, whichever kind it is. ONE fire path, so the overlap guard, the
  // one-shot latch below and the FIRE LINE cover a turn exactly as they cover a spawn — the
  // fire line belongs here for that reason; the outcome differs per kind, so it does not.
  function _fire(entry, stats, onSettle) {
    const a = entry.action;
    onLog(a.kind === 'turn' ? `${entry.name}: fire turn — ${a.being} ${a.script}` : `${entry.name}: fire command — ${a.command}`);
    const startedMs = now();
    if (a.kind === 'turn') { _dispatchTurn(entry, startedMs, onSettle); return; }
    _spawnAction(entry, stats, startedMs, onSettle);
  }

  // A recurring action: on each due tick spawn the shell line / dispatch the turn. OVERLAP
  // GUARD — a still-running previous run skips this tick + logs, so a slow command (or a
  // slow being turn: onSettle fires only when the turn resolves) never piles up. This skip
  // line is the ONE per-tick log that stays: a beat skipped because the last run is still
  // going is exactly the signal that something wedged. A failed run only logs (see _fire).
  function _makeRecurringBeat(entry, stats) {
    let running = false;
    return () => {
      if (running) { onLog(`${entry.name}: previous run still active — skipping`); return; }
      running = true;
      _fire(entry, stats, () => { running = false; });
    };
  }

  // A one-shot action: fires exactly once, at/after entry.whenMs. `fired` is set
  // BEFORE the fire so a re-entrant tick can never double-fire it.
  function _makeWhenBeat(entry, stats) {
    return (nowTick) => {
      if (entry.fired) return;
      if (nowTick < entry.whenMs) return;
      entry.fired = true;
      _fire(entry, stats);
    };
  }

  function _registerBeat(entry) {
    if (entry.whenMs != null) {
      // A one-shot rides the tick (everyMs 0 = evaluated every runDue); the beat
      // gates on now >= whenMs && !fired, so it cannot tighten the boot tick.
      _registry.register(entry.name, 0, _makeWhenBeat(entry, _stats));
    } else {
      _registry.register(entry.name, entry.everyMs, _makeRecurringBeat(entry, _stats));
    }
  }

  // ── reload: rebuild the whole set on demand (called from boot.mjs's refreshConfig,
  //    itself invoked from spine.mjs's handleFast on every inbound message) ────
  async function reload() {
    if (!_activated) return;                    // before activate() there are no beats loaded yet — nothing to reload
    if (_reloading) return;                     // reentrancy guard — a reload in flight blocks another
    _reloading = true;
    try {
      const { entries, finestMs } = await collect();   // collect() re-runs the resolver's walk
      _registry.clear();   // drop the whole old set — the fresh collect() rebuilds it
      for (const entry of entries) _registerBeat(entry);
      if (finestMs != null && _bootTickMs > 0 && finestMs < _bootTickMs) {
        onLog(`reloaded cadence ${finestMs}ms finer than the boot tick ${_bootTickMs}ms — restart to honor it`);
      }
      await _writeReadonly(entries);
      await resolver.writeReadonly();   // all three land together, on every reload
    } catch (e) {
      onLog(`reload failed: ${e?.message ?? e}`);   // never let a reload error break the message path
    } finally {
      _reloading = false;
    }
  }

  // ── the capture seam: hand the loader the real cadence registry the spine ticks
  //    (heartbeats.mjs), so _registerBeat/reload can register/clear onto it. No decoration
  //    needed any more — runDue is untouched now that the reload trigger lives on message
  //    arrival, not on the tick. Wired into services BEFORE createSpine. ──
  function wrapRegistry(registry) {
    _registry = registry;
    return registry;
  }

  // ── phase 2: bind command actions + register + materialize the readonly view ──
  async function activate({ stats, tickMs = 0 } = {}) {
    const entries = _entries ?? (await collect()).entries;
    _stats = stats;
    _bootTickMs = tickMs;
    for (const entry of entries) _registerBeat(entry);
    await _writeReadonly(entries);
    await resolver.writeReadonly();   // the other two aggregates land with this one
    _activated = true;
    return { entries, finestMs: _finestMs(entries) };
  }

  function _readonlyRow(e) {
    const row = { name: e.name, source: e.source };
    if (e.whenMs != null) row.when = e.rawWhen;
    else { row.frequency = e.rawFrequency; row.frequency_ms = e.everyMs; }
    // A script_path entry shows BOTH the sugar and the resolved command; a plain
    // command shows just the command. Neither hides anything behind a label.
    // An `agent:` entry has no command at all — it shows the sugar and WHO runs it, which
    // is the whole of what happens (a turn for that being in this entity).
    if (e.action.kind === 'turn') { row.action = `script_path: ${e.action.scriptPath}`; row.agent = e.action.being; }
    else if (e.action.scriptPath) { row.action = `script_path: ${e.action.scriptPath}`; row.command = e.action.command; }
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
      '# config.yaml) — the change takes effect automatically on the next inbound\n' +
      '# message (or at boot/restart). This file is purely informational: deleting or\n' +
      '# editing it does nothing special, and it is regenerated on every boot + refresh.\n\n';
    const list = entries.map(_readonlyRow);
    try {
      await mkdir(dirname(readonlyPath), { recursive: true });
      await writeFile(readonlyPath, header + YAML.stringify({ heartbeats: list }, { lineWidth: 0 }), 'utf8');
    } catch (e) { onLog(`readonly write: ${e?.message ?? e}`); }
  }

  return { collect, wrapRegistry, activate, reload };
}
