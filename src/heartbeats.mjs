// heartbeats.mjs — per-entity heartbeat config.
//
// A "heartbeat" is a property of an ENTITY (a conversation or a room), not a
// global daemon loop. The old global @e heartbeat — an unconfined turn on the
// 'system' surface with repo cwd + Bash that self-emitted via ~/.egpt/outbox —
// was removed (operator 2026-06-03). A heartbeat now lives in the entity's own
// folder and is dispatched through the SAME confined + bridge-gated path as any
// reply, so it can never reach a surface a normal reply couldn't.
//
// Layout (folder = a conversation's slug dir OR ~/.egpt/rooms/<name>/):
//   <dir>/config.yaml          → { heartbeat: { enabled, interval_min } }   operator-owned
//   <dir>/heartbeat.md         → the prompt body (${time} substituted)      operator-owned
//   <dir>/heartbeat.state.json → { lastFiredAt }                            engine-owned sidecar
//
// The engine NEVER writes config.yaml or heartbeat.md (operator-owned); it only
// writes the sidecar state. This module is pure logic + best-effort IO that
// never throws to the scanner (a malformed file disables that entity's
// heartbeat, it does not crash the tick).

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as YAML from 'yaml';

export const DEFAULT_INTERVAL_MIN = 30;
// Floor: a heartbeat may not fire more often than this regardless of config —
// guards against a typo (`interval_min: 0`) turning into a per-tick storm.
export const MIN_INTERVAL_MIN = 0.1;

export const configPath        = (dir) => join(dir, 'config.yaml');
export const promptPath        = (dir) => join(dir, 'heartbeat.md');
export const commandPath       = (dir) => join(dir, 'heartbeat.yaml');
export const statePath         = (dir) => join(dir, 'heartbeat.state.json');

// Parse the heartbeat block out of a config.yaml's text. Pure: takes the raw
// YAML string (or null/'' when the file is absent) and returns a normalized
// { enabled, intervalMin }. Anything malformed or missing → disabled.
export function parseHeartbeatConfig(yamlText) {
  let doc = {};
  if (yamlText && yamlText.trim()) {
    try { doc = YAML.parse(yamlText) ?? {}; } catch { doc = {}; }
  }
  const hb = (doc && typeof doc === 'object' && doc.heartbeat && typeof doc.heartbeat === 'object')
    ? doc.heartbeat : {};
  const raw = Number(hb.interval_min);
  const intervalMin = Number.isFinite(raw) && raw > 0 ? Math.max(raw, MIN_INTERVAL_MIN) : DEFAULT_INTERVAL_MIN;
  return { enabled: hb.enabled === true, intervalMin };
}

// A COMMAND heartbeat (heartbeat.yaml): deterministic upkeep the engine runs
// ITSELF — no AI in the loop. Pure parse of { enabled, interval_min, command,
// cwd? }. enabled requires a non-empty command (a heartbeat that runs nothing is
// disabled). Anything malformed → disabled. An 2026-06-19: "heartbeats should be
// more deterministic — AI not required for compression; only a heartbeat.yaml
// specifying the command, executed by the bridge."
export function parseCommandHeartbeat(yamlText) {
  let doc = {};
  if (yamlText && yamlText.trim()) { try { doc = YAML.parse(yamlText) ?? {}; } catch { doc = {}; } }
  if (!doc || typeof doc !== 'object') doc = {};
  const raw = Number(doc.interval_min);
  const intervalMin = Number.isFinite(raw) && raw > 0 ? Math.max(raw, MIN_INTERVAL_MIN) : DEFAULT_INTERVAL_MIN;
  const command = (typeof doc.command === 'string' && doc.command.trim()) ? doc.command.trim() : null;
  const cwd = (typeof doc.cwd === 'string' && doc.cwd.trim()) ? doc.cwd.trim() : null;
  return { enabled: doc.enabled === true && !!command, intervalMin, command, cwd };
}

export async function readCommandHeartbeat(dir) {
  let text = null;
  try { text = await readFile(commandPath(dir), 'utf8'); } catch { /* no heartbeat.yaml = disabled */ }
  return parseCommandHeartbeat(text);
}

// Pure firing gate: enabled AND the configured interval has elapsed since
// lastFiredAt. lastFiredAtMs = 0 (never fired) always fires when enabled.
export function shouldFire({ enabled, intervalMin = DEFAULT_INTERVAL_MIN } = {}, lastFiredAtMs = 0, nowMs = Date.now()) {
  if (!enabled) return false;
  const interval = Math.max(intervalMin, MIN_INTERVAL_MIN) * 60 * 1000;
  return (nowMs - (Number(lastFiredAtMs) || 0)) >= interval;
}

// ── best-effort IO (never throws) ──────────────────────────────────────────

export async function readConfig(dir) {
  let text = null;
  try { text = await readFile(configPath(dir), 'utf8'); } catch { /* no config.yaml = disabled */ }
  return parseHeartbeatConfig(text);
}

// The prompt body, with ${time} substituted to HH:MM local. null when absent or
// blank (blank prompt = nothing to say = treated as disabled by the scanner).
export async function readPrompt(dir, { now = new Date() } = {}) {
  let text;
  try { text = await readFile(promptPath(dir), 'utf8'); } catch { return null; }
  if (!text || !text.trim()) return null;
  const tstr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  return text.replace(/\$\{time\}/g, tstr);
}

export async function readLastFiredMs(dir) {
  try {
    const j = JSON.parse(await readFile(statePath(dir), 'utf8'));
    const ms = Date.parse(j?.lastFiredAt);
    return Number.isFinite(ms) ? ms : 0;
  } catch { return 0; }
}

export async function markFired(dir, iso = new Date().toISOString()) {
  try { await writeFile(statePath(dir), JSON.stringify({ lastFiredAt: iso }, null, 2) + '\n', 'utf8'); return true; }
  catch { return false; }
}
