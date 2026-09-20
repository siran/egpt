// 0015 — every being on this node may read the operator's src/, granted ONCE.
//
// Operator, 2026-09-20: "all agents see an src/ directory, it is actually interesting to have a
// my-code/ pointing to src/egpt, we can 'leak' my own src/ to the agent (read-only for now)".
//
// A read grant used to be per TYPE FILE. E's config/agents/sonnet-default.yaml carried
//   allowed_paths:
//     C:/Users/an/src/egpt:
//       allowed_tools: [ Read, Glob, Grep ]
// and granting the same folder to a second being meant writing that block into a second file —
// revoking it meant finding every copy. That is the drift setup/migrate.mjs exists to end
// (operator 2026-09-16: "nothing should be hand-applied, everything structural").
//
// THE NODE-LEVEL KEY this writes is read by src/spine/brainpool.mjs's resolveBeingDef
// (withNodeAllowedPaths), which merges it into EVERY being's def UNDER the def's own entries. So
// both consumers of the one allowed_paths walk see it — confinementFor (the CLI layer's
// `--add-dir` and read-only deny rules) and sandboxSharePathsFor (the OS layer's per-turn
// `-SharePathReadOnly` ACE) — and a being that names the same path keeps its own, narrower grant.
//
// THE OS HALF IS ALREADY IN PLACE on kg (measured 2026-09-20): C:\Users\an\src carries
// `reve\egpt-sandbox-pool:(OI)(CI)(RX)` and C:\Users\an\src\egpt inherits it. Without this CLI
// half a confined being still REFUSES those paths — the kernel would let it read and Claude Code
// would not, the mirror image of the bug the two-layer walk was written to prevent.
//
// THE PATH IS DERIVED, never spelled: `dirname(EGPT_HOME) + '/src'`. The profile is ~/.egpt, so
// its parent IS the operator's home — the same reading 0014 uses for "where the operator's own
// session wakes". A node with its profile elsewhere grants ITS OWN src/, and a node that has no
// src/ at all is granted nothing (satisfied, with a note: a grant on a folder that is not there
// is a line that only lies).
//
// SATISFIED, NOT REFUSED — a refusal STOPS THE WHOLE CHAIN (setup/migrate.mjs), so this refuses
// only about a node it actually applies to (the 0003/0007/0011 lesson): the node already grants
// that path node-wide (whatever class it granted it in — widening or narrowing an existing grant
// is a human decision), and there is no such folder on this node.
//
// IT REFUSES, NAMING THE PLACE, only on what it cannot honestly edit: no config.yaml; one that is
// not valid UTF-8 or does not parse; and a top-level `allowed_paths:` that is not a mapping (a
// list or a scalar there is a hand edit whose meaning this migration cannot guess).
//
// THE EDIT is a byte insertion (src/tools/config-io.mjs spliceYamlInsertKey, added by 0011): the
// whole `allowed_paths:` block at the DOCUMENT ROOT, after the last top-level key, on a node that
// has none — or the ONE path key into the block on a node that already has one. CRLF, alignment
// and every other byte are kept, and the result is verified to re-parse to the config plus
// exactly that key.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import * as YAML from 'yaml';
import { spliceYamlInsertKey } from '../src/tools/config-io.mjs';

export const elevated = false;
export const summary = "the operator's own src/ is readable by every being on this node, granted once at the node level";

const KEY = 'allowed_paths';
// Read, Glob, Grep — a list with NO write-class tool, which is how brainpool.mjs's allowedPathsFor
// classifies a path as READ-ONLY ("read-only for now").
const TOOLS = '[ Read, Glob, Grep ]';

const refuse = (why) => { throw new Error(`0015 refuses: ${why}`); };
const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// config.yaml writes paths with forward slashes; node's join hands back the platform's. Compared
// and written in ONE dialect, and normalized the way brainpool.mjs's normalizeCwd reads an
// allowed_paths key (msys `/c/..` → `C:/..`), so "already granted" cannot be missed over a form.
const slash = (p) => String(p).replace(/\\/g, '/');
const normalize = (p) => {
  const m = slash(String(p).trim()).match(/^\/([a-zA-Z])\/(.*)$/);
  return m ? `${m[1].toUpperCase()}:/${m[2]}` : slash(String(p).trim());
};

// The block AS IT WILL READ in the operator's file. `indent` is the column the map it goes into
// sits at: 0 for the document root (the whole key), 2 for an existing `allowed_paths:` (the one
// path). Everything but the path is fixed text.
const pathLines = (src, pad) => [
  `${pad}${src}:`,
  `${pad}  allowed_tools: ${TOOLS}`,
];
const rootBlock = (src) => [
  '# NODE-WIDE READ GRANT (0015, operator 2026-09-20: "we can \'leak\' my own src/ to the agent',
  '# (read-only for now)"). ONE place to grant a folder to EVERY being here, and one place to',
  '# revoke it - src/spine/brainpool.mjs resolveBeingDef merges this into every being\'s def, UNDER',
  '# the def\'s own allowed_paths, so a being that names the same path keeps its own narrower grant.',
  `${KEY}:`,
  ...pathLines(src, '  '),
].join('\n');

export async function plan(ctx) {
  const srcDir = slash(join(dirname(ctx.egptHome), 'src'));

  const file = join(ctx.egptHome, 'config', 'config.yaml');
  if (!existsSync(file)) refuse(`there is no ${file}`);
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) refuse(`${file} is not valid UTF-8; a splice would re-encode bytes it never meant to touch`);

  const doc = YAML.parseDocument(text);
  if (doc.errors.length) refuse(`${file} does not parse: ${doc.errors[0].message}`);
  const cfg = doc.toJS();
  const existing = isMap(cfg) ? cfg[KEY] : undefined;
  if (existing !== undefined && !isMap(existing)) {
    refuse(`\`${KEY}:\` in ${file} is ${JSON.stringify(existing)}, not a mapping of paths - this migration will not guess what a hand edit there meant`);
  }

  const granted = Object.keys(existing ?? {}).find((k) => normalize(k) === srcDir);
  if (granted !== undefined) {
    return { satisfied: true, notes: [`${file} already grants ${srcDir} node-wide (\`${KEY}.${granted}\`), so every being here already reads it`] };
  }
  // A grant on a folder that is not there is a line that only lies - and the node this runs on may
  // simply not be the operator's box. Satisfied, never a refusal: the chain must not stop over it.
  if (!existsSync(srcDir)) {
    return { satisfied: true, notes: [`there is no ${srcDir} on this node, so there is nothing to grant - not added here`] };
  }

  // Into the existing block, or the whole block at the root. Both are the same one splice.
  const next = existing === undefined
    ? spliceYamlInsertKey(text, [], { key: KEY, text: rootBlock(srcDir) })
    : spliceYamlInsertKey(text, [KEY], { key: srcDir, text: pathLines(srcDir, '  ').join('\n') });

  const a = text.split('\n');
  const b = next.split('\n');
  const n = b.length - a.length;
  let s = 0;
  while (s < a.length && a[s] === b[s]) s++;
  const added = b.slice(s, s + n).map((l) => l.replace(/\r$/, ''));

  return {
    satisfied: false,
    changes: [
      existing === undefined
        ? `${file}:${s + 1}-${s + n}  insert the node-level \`${KEY}:\` block at the document root (${n} lines):`
        : `${file}:${s + 1}-${s + n}  insert ${srcDir} into the node's existing \`${KEY}:\` (${n} lines):`,
      ...added.map((l) => `  + ${l}`),
      `every being on this node reads ${srcDir} - granted once, revoked once`,
      'backup first, beside it: <file>.bak-0015-<timestamp>',
    ],
    apply: async () => {
      if (!readFileSync(file).equals(bytes)) refuse(`${file} changed since it was planned - re-run`);
      ctx.log(`backup: ${ctx.backup(file)}`);
      writeFileSync(file, next, 'utf8');
    },
  };
}
