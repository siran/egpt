#!/usr/bin/env node
// port-explicit-tools.mjs — ONE-SHOT: rewrite conversations.yaml's frozen
// `readonly.allowed_tools: all` entries (flat 'e' + every nested per-being block) to the
// explicit DEFAULT_ALLOWED_TOOLS vertical list.
//
// Why (operator 2026-07-03): 'all' is REJECTED at the spawn boundary (d025413) — a live
// turn already self-heals a legacy 'all' entry on its NEXT turn (the brainpool's
// coerceAllowedTools), but an idle conversation that never gets a next turn keeps 'all'
// on disk indefinitely. This port fixes the registry directly, in one pass, without
// waiting for traffic.
//
// Uses the SAME readState/writeState Document round-trip conversations-state.mjs uses
// for every other write, so the pushedName-as-inline-comment slim format survives
// byte-for-byte (verify by dry-running against a scratch COPY, never the live file).
// The 'all'/'*' predicate mirrors the brainpool's own coerceAllowedTools (the spawn
// boundary's one chokepoint) — same condition, kept dependency-light here (this script
// pulls in only conversations-state.mjs + the repo's `yaml`, not the whole engine).
//
// Usage:  node setup/port-explicit-tools.mjs [path]     # path defaults to CONV_YAML_PATH
// Idempotent: an already-explicit entry (any list, or allowed_tools omitted) is left
// untouched; running it twice in a row is a no-op the second time. The orchestrator runs
// this with the service stopped.
import { pathToFileURL } from 'node:url';
import { CONV_YAML_PATH, DEFAULT_ALLOWED_TOOLS, residentsOf, readState, writeState } from '../conversations-state.mjs';

const isLegacyAll = (v) => v === 'all' || v === '*';

// Pure transform: walk every surface/contact/being's readonly.allowed_tools, replacing a
// literal 'all'/'*' with its OWN fresh copy of DEFAULT_ALLOWED_TOOLS (never the same array
// reference across entries — the yaml lib would otherwise anchor/alias coincidentally-equal
// values, which is correct but a needless surprise in a hand-readable registry). Returns a
// NEW state (only the touched entries are cloned) + the list of touched locations.
export function portExplicitTools(state) {
  const touched = [];
  const nextContacts = {};
  for (const [surface, bucket] of Object.entries(state?.contacts ?? {})) {
    if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) { nextContacts[surface] = bucket; continue; }
    const nextBucket = {};
    for (const [jid, entry] of Object.entries(bucket)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || entry.aliasOf) { nextBucket[jid] = entry; continue; }
      let nextEntry = entry;
      // Legacy FLAT readonly (the pre-nested persona slot, labeled 'e') — residentsOf no
      // longer synthesizes an implicit 'e' (operator 2026-07-10), so port it explicitly.
      if (entry.readonly && typeof entry.readonly === 'object' && isLegacyAll(entry.readonly.allowed_tools)) {
        nextEntry = { ...nextEntry, readonly: { ...entry.readonly, allowed_tools: [...DEFAULT_ALLOWED_TOOLS] } };
        touched.push({ surface, jid, being: 'e' });
      }
      // Nested per-being readonly blocks (siblings, and — going forward — the persona keyed
      // by its own map key).
      for (const being of residentsOf(entry)) {
        const ro = entry[being]?.readonly;
        if (!ro || typeof ro !== 'object' || !isLegacyAll(ro.allowed_tools)) continue;
        const coerced = { ...ro, allowed_tools: [...DEFAULT_ALLOWED_TOOLS] };
        nextEntry = { ...nextEntry, [being]: { ...nextEntry[being], readonly: coerced } };
        touched.push({ surface, jid, being });
      }
      nextBucket[jid] = nextEntry;
    }
    nextContacts[surface] = nextBucket;
  }
  return { state: { ...state, contacts: nextContacts }, touched };
}

async function main() {
  const path = process.argv[2] || CONV_YAML_PATH;
  const state = await readState(path);
  const { state: next, touched } = portExplicitTools(state);
  if (!touched.length) {
    console.log(`port-explicit-tools: nothing to do — no legacy 'all'/'*' entries in ${path}`);
    return;
  }
  await writeState(path, next);
  console.log(`port-explicit-tools: coerced ${touched.length} entr${touched.length === 1 ? 'y' : 'ies'} in ${path} -> [${DEFAULT_ALLOWED_TOOLS.join(', ')}]`);
  for (const t of touched) console.log(`  ${t.surface}/${t.jid}${t.being !== 'e' ? `.${t.being}` : ''}`);
}

// Run only when invoked directly (so portExplicitTools imports cleanly in tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
