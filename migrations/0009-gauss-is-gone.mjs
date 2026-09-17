// 0009 — gauss is gone.
//
// Operator, 2026-09-17: "evict gauss. that was a brain fart of some agent."
//
// gauss was added on kg on 2026-09-16 as its own being (config.yaml `agents.gauss`, running the
// shared opus-xhigh def with the personality config/agents/identities/gauss.md), meant to be woken by
// the primo-del-dia-contexto heartbeat in Reencuentro CRC. Evicting it is the block and the identity
// file; opus-xhigh.yaml is SHARED with ken and is not touched. Measured by the operator on
// 2026-09-17: nothing else on kg names gauss (not rooms.yaml, not conversations.yaml, no entity
// config.yaml, no agents/gauss folder), and do has no gauss at all, so do reads satisfied.
//
// SATISFIED FIRST: no `agents.gauss` in config.yaml and no identity file. A node half-way there (one
// of the two left) finishes the other half.
//
// IT REFUSES, NAMING THE PLACE, while anything still references the being: a heartbeat whose
// `agent:` is one of gauss's handles (a heartbeat names a HANDLE, heartbeat-loader.mjs) in
// config/rooms.yaml, config/conversations.yaml, or an entity config.yaml under conversations/ or
// rooms/, or an `agents.gauss` per-being record in any of those. Removing the being under them would
// leave a beat that skips every day and a record for a being that does not exist - which of those
// goes too is a human decision.
//
// The edit is a byte splice (src/tools/config-io.mjs spliceYamlRemoveKey): the gauss block and the
// comment lines directly above it at its column go, every other byte - CRLF, ken's last line,
// `codex:` - is kept, and the result is verified to re-parse to the config minus agents.gauss.
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { spliceYamlRemoveKey } from '../src/tools/config-io.mjs';

export const elevated = false;
export const summary = 'gauss is evicted: its agents.gauss block in config.yaml and its identity file';

const AGENT = 'gauss';

const refuse = (why) => { throw new Error(`0009 refuses: ${why}`); };

// Every config file a reference to gauss could live in: the two registries, and each entity folder's
// own config.yaml (conversations/<surface>/<slug>/, rooms/<slug>/).
function referenceFiles(egptHome) {
  const dirs = (p) => { try { return readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(p, e.name)); } catch { return []; } };
  const entities = [...dirs(join(egptHome, 'conversations')).flatMap(dirs), ...dirs(join(egptHome, 'rooms'))];
  return [
    join(egptHome, 'config', 'rooms.yaml'),
    join(egptHome, 'config', 'conversations.yaml'),
    ...entities.map((d) => join(d, 'config.yaml')),
  ].filter((f) => existsSync(f));
}

// A walk, not fixed paths, so no shape a file nests its heartbeats or per-being blocks in can slip past.
function referencesIn(data, handles) {
  const found = [];
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      const here = [...path, k];
      if (k === 'heartbeats' && v && typeof v === 'object') {
        for (const [name, beat] of Object.entries(v)) {
          if (typeof beat?.agent === 'string' && handles.has(beat.agent.trim().toLowerCase())) {
            found.push(`${[...here, name, 'agent'].join('.')} = ${JSON.stringify(beat.agent)}`);
          }
        }
      }
      if (k === 'agents' && v && typeof v === 'object' && Object.hasOwn(v, AGENT)) found.push([...here, AGENT].join('.'));
      walk(v, here);
    }
  };
  walk(data, []);
  return found;
}

export async function plan(ctx) {
  const file = join(ctx.egptHome, 'config', 'config.yaml');
  const identity = join(ctx.egptHome, 'config', 'agents', 'identities', `${AGENT}.md`);
  if (!existsSync(file)) refuse(`there is no ${file}`);
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) refuse(`${file} is not valid UTF-8; a splice would re-encode bytes it never meant to touch`);

  const doc = YAML.parseDocument(text);
  if (doc.errors.length) refuse(`${file} does not parse: ${doc.errors[0].message}`);
  const agents = doc.toJS()?.agents;
  const hasAgent = !!agents && typeof agents === 'object' && Object.hasOwn(agents, AGENT);
  const hasIdentity = existsSync(identity);
  if (!hasAgent && !hasIdentity) return { satisfied: true, notes: [`no agents.${AGENT} in config.yaml and no config/agents/identities/${AGENT}.md - nothing to evict`] };

  const handles = new Set([AGENT, ...(Array.isArray(agents?.[AGENT]?.handles) ? agents[AGENT].handles : [])].map((h) => String(h).trim().toLowerCase()));
  const refs = [];
  for (const f of referenceFiles(ctx.egptHome)) {
    const d = YAML.parseDocument(readFileSync(f, 'utf8'));
    if (d.errors.length) refuse(`${f} does not parse (${d.errors[0].message}), so whether it still references ${AGENT} cannot be read`);
    for (const r of referencesIn(d.toJS(), handles)) refs.push(`${f}: ${r}`);
  }
  if (refs.length) refuse(`${AGENT} is still referenced, and removing it would leave these dangling - a human decision: ${refs.join('; ')}`);

  const changes = [];
  let next = text;
  if (hasAgent) {
    next = spliceYamlRemoveKey(text, ['agents'], { key: AGENT });
    const a = text.split('\n');
    const b = next.split('\n');
    const n = a.length - b.length;
    let s = 0;
    while (s < b.length && a[s] === b[s]) s++;
    const removed = a.slice(s, s + n).map((l) => l.replace(/\r$/, ''));
    const described = removed[0]?.trimStart().startsWith('#') ? ' and the comment above it' : '';
    changes.push(`${file}:${s + 1}-${s + n}  remove agents.${AGENT}${described} (${n} lines):`, ...removed.map((l) => `  - ${l}`));
  }
  const idBytes = hasIdentity ? readFileSync(identity) : null;
  if (hasIdentity) changes.push(`delete ${identity} (${idBytes.length} bytes)`);
  changes.push('backup first, beside each: <file>.bak-0009-<timestamp>');

  return {
    satisfied: false,
    changes,
    apply: async () => {
      if (!readFileSync(file).equals(bytes)) refuse(`${file} changed since it was planned - re-run`);
      if (hasIdentity && !(existsSync(identity) && readFileSync(identity).equals(idBytes))) refuse(`${identity} changed since it was planned - re-run`);
      if (hasAgent) ctx.log(`backup: ${ctx.backup(file)}`);
      if (hasIdentity) ctx.log(`backup: ${ctx.backup(identity)}`);
      if (hasAgent) writeFileSync(file, next, 'utf8');
      if (hasIdentity) unlinkSync(identity);
    },
  };
}
