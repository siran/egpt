// config-resolver.mjs — ONE NAMESPACE, THREE RUNGS, nearest the room wins
// (operator ruling 2026-07-26).
//
//   config/config.yaml            the node rung (defaults for every entity)
//     < config/conversations.yaml   the REGISTRY rung (that conversation's entry)
//       < <entity>/config.yaml      the ENTITY rung (conversations/<slug>/ or rooms/<name>/)
//
// Operator: *"the configuration in a rooms/<room name>, or conversations/<slug> is more
// specific than a general conversations or config file"* and *"yaml keys in
// conversations.yaml are orthogonal from config.yaml; we only separate into two files for
// logical convenience."* So ANY key may appear at ANY rung — the split between the two top
// files is FILING, not schema. That is what makes the entity folder file a RUNG of one
// resolver rather than a second home for the same setting.
//
// THE SHAPE OF THE WORK (operator: *"scan configuration files, load them into memory, dump
// memory contents to readonly.file"*): collect() scans, the resolved set lives in MEMORY,
// and writeReadonly() dumps it. Consumers read MEMORY (configFor), never the dump — the
// dump is for the operator's eyes.
//
// THIS MODULE OWNS THE WALK. It used to live inside heartbeat-loader.collect(), which
// enumerated the node config + every conversation folder + every room folder for its own
// `heartbeats:` block while three OTHER readers (warm, transcription, members) each opened
// `<entity>/config.yaml` lazily and none of them layered over the node config. There is one
// walk now and the loader consumes its output; a second walk anywhere is a bug.
//
// ── COMBINING IS NOT UNIFORM ────────────────────────────────────────────────
// A generic "entity beats node" resolver silently breaks heartbeats, so the rules are per
// BLOCK and each one is test-locked in tests/spine-config-resolver.test.mjs:
//   heartbeats:  UNION    — every rung CONTRIBUTES entries; the node's block does not lose
//                           to a conversation's. (Within ONE entity, a same-named entry at
//                           the folder rung still overrides the registry rung's.)
//   everything else: OVERRIDE, nearest rung wins — DEEP-merged per leaf, so a folder that
//                           pins `transcription_service.posts_back` does not delete the
//                           node's `use_config` and engine profiles. A list is one value,
//                           replaced whole.
//   members:     entity-only in practice — no node or registry rung declares it, so the
//                           generic OVERRIDE resolves it to the folder's roster verbatim.
//
// ── PROVENANCE ─────────────────────────────────────────────────────────────
// Operator: *"a nice addition to the readonly.yaml files is to specify from where the
// overriding chunk was read (the relative path to file)"*. `source` is a tree with the SAME
// SHAPE as the resolved config whose leaves are profile-relative file paths — at the same
// granularity as the merge, so a block assembled from two rungs names both.
//
// ── THE THREE AGGREGATES ───────────────────────────────────────────────────
// At the PROFILE ROOT, not state/ (operator: *"state/ hides too much"*):
//   ~/.egpt/config.readonly.yaml         the node rung as loaded
//   ~/.egpt/conversations.readonly.yaml  every entity + what ITS OWN rungs supplied
//   ~/.egpt/heartbeats.readonly.yaml     the resolved heartbeat set (written by the loader,
//                                        which owns the row shape; the path is ours)
// conversations.readonly.yaml deliberately shows only the keys the registry/entity rungs
// TOUCH: the node rung is already dumped once in config.readonly.yaml, and repeating a
// whole config.yaml under each of forty conversations is a wall, not a report.
//
// CONFIG REFRESH ON MESSAGE ARRIVAL (2026-08): config changes are picked up automatically on
// the next inbound message — spine.mjs's handleFast calls the injected refreshConfig before
// dispatching, which re-runs collect() (see boot.mjs) — or at boot/restart. No file deletion,
// no periodic timer, no manual action needed. These three files are PURE diagnostic output;
// they carry zero control role.
//
// Nothing here is fatal: a missing dir, an unreadable registry, a malformed entity config —
// all log and degrade to the rung above.

import { writeFile as fsWriteFile, mkdir as fsMkdir } from 'node:fs/promises';
import { join, dirname, relative, sep } from 'node:path';
import * as YAML from 'yaml';
import { EGPT_HOME } from '../egpt-home.mjs';
import { CONTACT_BOOKKEEPING_KEYS, residentsOf } from '../conversations-state.mjs';

// The two top rungs, named the way they are written into `source:` — profile-relative.
export const NODE_FILE = 'config/config.yaml';
export const REGISTRY_FILE = 'config/conversations.yaml';

// Blocks that UNION instead of overriding. Collected per rung-owner and never layered, so
// an entity declaring its own can't delete the node's.
export const UNION_KEYS = new Set(['heartbeats']);

export function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

/**
 * An entity config.yaml's text → its whole doc, tolerantly ({} when absent / empty /
 * malformed / not a map). ONE parse for every block, replacing the per-block text parsers
 * (a heartbeats one, a warm one, a transcription one) that each re-read the same file.
 */
export function parseEntityConfig(yamlText) {
  if (!yamlText || !String(yamlText).trim()) return {};
  let doc;
  try { doc = YAML.parse(yamlText); } catch { return {}; }
  return isPlainObject(doc) ? doc : {};
}

/** A provenance tree shaped like `value`, every leaf the file `src` was read from. */
export function mirrorSource(value, src) {
  if (!isPlainObject(value)) return src;
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = mirrorSource(v, src);
  return out;
}

/**
 * Layer one rung's `doc` over the accumulating {config, source}. Plain maps merge DEEP
 * (nearest rung wins per leaf); anything else replaces whole. `top` skips the UNION blocks,
 * which are collected separately — nested keys of the same name are ordinary keys.
 * Copy-on-write: untouched subtrees stay shared with the rung below.
 */
export function layerInto(config, source, doc, src, top = false) {
  if (!isPlainObject(doc)) return;
  for (const [k, v] of Object.entries(doc)) {
    if (top && UNION_KEYS.has(k)) continue;
    if (isPlainObject(v) && isPlainObject(config[k])) {
      source[k] = isPlainObject(source[k]) ? { ...source[k] } : mirrorSource(config[k], source[k]);
      config[k] = { ...config[k] };
      layerInto(config[k], source[k], v, src);
    } else {
      config[k] = v;
      source[k] = mirrorSource(v, src);
    }
  }
}

// A profile-relative, forward-slashed path — what `source:` shows for an entity file.
function _rel(egptHome, abs) {
  const r = relative(egptHome, abs);
  return r ? r.split(sep).join('/') : abs;
}

/**
 * @param {object} deps
 * @param {() => object} deps.getConfig                               the node rung (boot's config.yaml)
 * @param {() => Promise<object>} deps.loadRegistry                   conversations.yaml state ({contacts:{surface:{jid:entry}}})
 * @param {() => Promise<Array<{dir:string, ns:string}>>} deps.listEntityDirs  conversation + room folders
 * @param {(dir:string) => Promise<object>} deps.readEntityConfig     a folder's WHOLE config.yaml doc ({} when absent/malformed)
 * @param {string} [deps.egptHome]
 * @param {{writeFile?:Function, mkdir?:Function}} [deps.io]
 * @param {(m:string) => void} [deps.onLog]
 */
export function createConfigResolver({
  getConfig = () => ({}),
  loadRegistry = async () => ({}),
  listEntityDirs = async () => [],
  readEntityConfig = async () => ({}),
  egptHome = EGPT_HOME,
  io = {},
  onLog = () => {},
} = {}) {
  const writeFile = io.writeFile ?? fsWriteFile;
  const mkdir = io.mkdir ?? fsMkdir;

  const paths = {
    config: join(egptHome, 'config.readonly.yaml'),
    conversations: join(egptHome, 'conversations.readonly.yaml'),
    heartbeats: join(egptHome, 'heartbeats.readonly.yaml'),
  };

  let _set = null;   // the in-memory resolved set — what consumers read

  // The node rung, resolved on its own: the whole doc (heartbeats included — the node's
  // block is one of the UNION's contributors) plus the base every entity layers over
  // (the same doc MINUS the union blocks, so they can't leak in as an override).
  function _node() {
    const doc = getConfig() ?? {};
    const config = {}, source = {};
    layerInto(config, source, doc, NODE_FILE);
    const baseConfig = {}, baseSource = {};
    layerInto(baseConfig, baseSource, doc, NODE_FILE, true);
    return { config, source, baseConfig, baseSource };
  }

  // A registry entry is a MIXED bag: the registry's own bookkeeping (slug/pushedName/
  // pointers), the resident beings' blocks, and — as the middle rung — configuration. Only
  // the last is contributed. Both exclusions come from conversations-state, which owns that
  // vocabulary; nothing is re-spelled here.
  function _registryConfig(entry) {
    if (!isPlainObject(entry)) return {};
    const residents = new Set(residentsOf(entry));
    const out = {};
    for (const [k, v] of Object.entries(entry)) {
      if (CONTACT_BOOKKEEPING_KEYS.has(k) || residents.has(k)) continue;
      out[k] = v;
    }
    return out;
  }

  // slug-keyed index of the registry, per surface: `<surface>/<slug>` → entry. The entity
  // walk hands back that exact ns for a conversation folder, so the join is a lookup.
  function _indexRegistry(state) {
    const index = new Map();
    for (const [surface, bucket] of Object.entries(state?.contacts ?? {})) {
      for (const entry of Object.values(bucket ?? {})) {
        if (!entry || entry.aliasOf || !entry.slug) continue;
        index.set(`${surface}/${entry.slug}`, entry);
      }
    }
    return index;
  }

  /** Scan every rung and load the resolved set into memory. Never throws. */
  async function collect() {
    const node = _node();

    let registryState = {};
    try { registryState = (await loadRegistry()) ?? {}; }
    catch (e) { onLog(`registry: ${e?.message ?? e}`); }
    const index = _indexRegistry(registryState);

    let dirs = [];
    try { dirs = (await listEntityDirs()) ?? []; }
    catch (e) { onLog(`listEntityDirs: ${e?.message ?? e}`); }

    const entities = new Map();
    for (const { dir, ns } of dirs) {
      let folder = {};
      try { folder = (await readEntityConfig(dir)) ?? {}; }
      catch (e) { onLog(`${ns}: ${e?.message ?? e}`); folder = {}; }
      if (!isPlainObject(folder)) folder = {};

      const entryRung = _registryConfig(index.get(ns));
      const folderFile = _rel(egptHome, join(dir, 'config.yaml'));

      const config = { ...node.baseConfig };
      const source = { ...node.baseSource };
      const touched = [];
      for (const [rung, file] of [[entryRung, REGISTRY_FILE], [folder, folderFile]]) {
        for (const k of Object.keys(rung)) if (!UNION_KEYS.has(k) && !touched.includes(k)) touched.push(k);
        layerInto(config, source, rung, file, true);
      }

      // UNION block: the entity's own contribution, registry rung first so a same-named
      // folder entry wins WITHIN this entity. The node's block is a separate contributor
      // and is never merged in here.
      const heartbeats = {}, heartbeatSource = {};
      for (const [rung, file] of [[entryRung, REGISTRY_FILE], [folder, folderFile]]) {
        for (const [name, raw] of Object.entries(isPlainObject(rung.heartbeats) ? rung.heartbeats : {})) {
          heartbeats[name] = raw;
          heartbeatSource[name] = file;
        }
      }

      entities.set(dir, {
        ns, dir,
        kind: ns.startsWith('room/') ? 'room' : 'conversation',
        config, source, touched, heartbeats, heartbeatSource,
      });
    }

    _set = { node, entities };
    return _set;
  }

  /** The resolved entity record for a folder, or null when it wasn't in the last walk. */
  function entityFor(dir) { return _set?.entities.get(dir) ?? null; }

  /**
   * The resolved config a consumer reads. An unknown dir — a folder born since the last
   * collect — resolves to the node rung alone; its own file joins on the next reload,
   * exactly as a new conversation's heartbeats already did.
   */
  function configFor(dir) {
    const e = entityFor(dir);
    if (e) return e.config;
    return (_set?.node ?? _node()).baseConfig;
  }

  /** The provenance tree for the same lookup. */
  function sourceFor(dir) {
    const e = entityFor(dir);
    if (e) return e.source;
    return (_set?.node ?? _node()).baseSource;
  }

  /** The in-memory set (null before the first collect). */
  function snapshot() { return _set; }

  async function _write(path, text) {
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text, 'utf8');
    } catch (e) { onLog(`readonly write ${path}: ${e?.message ?? e}`); }
  }

  // Only the keys the entity's OWN rungs supplied — resolved value + per-leaf source. The
  // node rung is dumped once, in config.readonly.yaml.
  function _entityRow(e) {
    const config = {}, source = {};
    for (const k of e.touched) { config[k] = e.config[k]; source[k] = e.source[k]; }
    const row = { kind: e.kind, dir: e.dir, config };
    if (e.touched.length) row.source = source;
    if (Object.keys(e.heartbeats).length) row.heartbeats = Object.keys(e.heartbeats);
    return row;
  }

  /** Dump the node rung + the per-entity overlay. The loader writes the heartbeats one. */
  async function writeReadonly() {
    const set = _set ?? (await collect());
    await _write(paths.config,
      '# config.readonly.yaml — spine-written. DO NOT EDIT.\n' +
      '# The NODE rung of the config resolver, as loaded into memory. Edit config/config.yaml —\n' +
      '# the change takes effect automatically on the next inbound message (or at boot/restart).\n' +
      '# This file is purely informational: deleting or editing it does nothing special, and it\n' +
      '# is regenerated on every boot + refresh, overwriting.\n\n' +
      YAML.stringify({ source: NODE_FILE, config: set.node.config }, { lineWidth: 0 }));

    const entities = {};
    for (const e of set.entities.values()) entities[e.ns] = _entityRow(e);
    await _write(paths.conversations,
      '# conversations.readonly.yaml — spine-written. DO NOT EDIT.\n' +
      '# Every conversation + room the spine walked, and the values ITS OWN rungs supplied:\n' +
      '#   config/conversations.yaml (the entry)  <  <entity>/config.yaml   — nearest wins.\n' +
      '# `source:` names the file each value was read from. Keys resolved purely from the\n' +
      '# node rung are NOT repeated here — they are in config.readonly.yaml. A change takes\n' +
      '# effect automatically on the next inbound message (or at boot/restart); this file is\n' +
      '# purely informational, regenerated then — deleting or editing it does nothing special.\n\n' +
      YAML.stringify({ entities }, { lineWidth: 0 }));
  }

  return { collect, configFor, sourceFor, entityFor, snapshot, writeReadonly, paths };
}
