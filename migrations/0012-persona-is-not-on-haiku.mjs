// 0012 — the node's default persona does not answer on haiku.
//
// Operator, 2026-09-17: D — do's persona — answered a question in a chat with "sin más contexto
// sobre qué es E", on a thread that had just been rethreaded, without reading the 77 KB transcript
// sitting beside it. Asked whether D is opus-high, the answer was no: do's `agents.egpt` runs
// `configuration: haiku-low` (config/agents/haiku-low.yaml — model haiku, effort low). The ruling:
// "please change as in KG, sonnet high".
//
// THE RULE, AS A PROPERTY OF THE NODE, not as "edit do": the default persona does not answer on
// haiku. A named Haiku type is repointed to `sonnet-high`; an inline Haiku definition has its
// model and effort changed in place. kg's persona is on `sonnet-default`, whose model is sonnet,
// so kg reads SATISFIED and is left alone — the same one rule, asked of each node.
//
// THE MODEL IS READ, NEVER GUESSED FROM THE NAME: a named configuration reads its type file; an
// inline configuration reads its own model. A named target must declare sonnet/high before any edit.
//
// WHICH NODE: the one agent carrying `default: true` — the persona, whose key boot injects as
// defaultBeing (0011's personaOf, same shape). None means this node has no persona, which is
// satisfied; more than one means nothing here can say which persona is THE persona, which is
// refused.
//
// SATISFIED, NOT REFUSED — a refusal STOPS THE WHOLE CHAIN (setup/migrate.mjs), so a migration
// only refuses about a node it actually applies to (the 0003/0007/0011 lesson): no `agents:`
// mapping; no persona; no config/agents/sonnet-high.yaml for a named configuration (nothing to
// repoint TO, checked before refusals); the persona's model is already non-haiku.
//
// IT REFUSES, NAMING THE PLACE, when: more than one agent carries `default: true`; the persona has
// no `configuration`; a Haiku inline map has no scalar effort; or a named type file is missing or
// invalid. A named target with the wrong model/effort is refused before config.yaml is written.
//
// THE EDIT uses spliceYamlScalar (src/tools/config-io.mjs). A named configuration changes one
// scalar and its trailing comment, if present. An inline definition changes its model and effort
// scalars, preserving its personality and every other field. Reparse and line diffs verify each.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { spliceYamlScalar } from '../src/tools/config-io.mjs';

export const elevated = false;
export const summary = "the node's default persona moves from haiku to sonnet high";

const TARGET = 'sonnet-high';
const HAIKU = 'haiku';
// What the repointed line documents itself with. It names the NEW file, and records the ruling.
const COMMENT = `config/agents/${TARGET}.yaml (0012, operator 2026-09-17: "as in KG, sonnet high")`;

const refuse = (why) => { throw new Error(`0012 refuses: ${why}`); };

// The ONE agent carrying `default: true`. None: this node has no persona (null, read as satisfied).
// Several: nothing here can say which one answers as the node, so that is refused. (0011.)
function personaOf(agents) {
  const keys = Object.entries(agents)
    .filter(([name, a]) => a && typeof a === 'object' && !name.startsWith('_') && a.default === true)
    .map(([name]) => name);
  if (keys.length > 1) refuse(`the default persona cannot be identified: ${keys.length} agents carry \`default: true\` (${keys.join(', ')})`);
  return keys[0] ?? null;
}

// What model a `configuration:` name actually resolves to on THIS node — read out of the file it
// names, never inferred from the name. A missing or unparseable file is a broken node, not a node
// to repoint quietly.
function typeFileModel(egptHome, name) {
  const file = join(egptHome, 'config', 'agents', `${name}.yaml`);
  if (!existsSync(file)) refuse(`the persona's configuration names ${name}, but there is no ${file} - this node is already broken, and repointing it would hide that`);
  let data;
  try { data = YAML.parse(readFileSync(file, 'utf8')); } catch (e) { refuse(`${file} does not parse: ${e.message}`); }
  if (!data || typeof data !== 'object') refuse(`${file} does not parse to a mapping, so it says no model`);
  return { file, model: data.model };
}

export async function plan(ctx) {
  const file = join(ctx.egptHome, 'config', 'config.yaml');
  if (!existsSync(file)) refuse(`there is no ${file}`);
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) refuse(`${file} is not valid UTF-8; a splice would re-encode bytes it never meant to touch`);

  const doc = YAML.parseDocument(text);
  if (doc.errors.length) refuse(`${file} does not parse: ${doc.errors[0].message}`);
  const agents = doc.toJS()?.agents;
  if (!agents || typeof agents !== 'object') return { satisfied: true, notes: [`${file} has no \`agents:\` mapping, so this node has no persona`] };

  const persona = personaOf(agents);
  if (persona === null) return { satisfied: true, notes: [`no agent in ${file} carries \`default: true\`, so this node has no persona`] };

  const def = agents[persona];
  const inline = def?.configuration && typeof def.configuration === 'object' && !Array.isArray(def.configuration);
  // A named configuration needs the target file. An inline definition can be edited in place.
  const target = join(ctx.egptHome, 'config', 'agents', `${TARGET}.yaml`);
  if (!inline && !existsSync(target)) {
    return { satisfied: true, notes: [`there is no ${target} on this node, so there is nothing for agents.${persona}.configuration to be repointed to - left alone`] };
  }

  if (!Object.hasOwn(def, 'configuration')) refuse(`agents.${persona} in ${file} has no \`configuration\` key, so there is nothing to repoint`);
  const current = def.configuration;
  if (Array.isArray(current)) refuse(`agents.${persona}.configuration in ${file} is a list, not a type file name or inline map`);
  if (!inline && typeof current !== 'string') refuse(`agents.${persona}.configuration in ${file} is ${JSON.stringify(current)}, not the name of a type file`);

  const { file: typeFile, model } = inline
    ? { file: null, model: current.model }
    : typeFileModel(ctx.egptHome, current);
  if (model !== HAIKU) {
    const where = inline ? `agents.${persona}.configuration is an inline map` : `agents.${persona}.configuration is ${current}, and ${typeFile}`;
    return { satisfied: true, notes: [`${where} is model ${JSON.stringify(model ?? null)} - this node's persona does not answer on ${HAIKU}`] };
  }

  let next;
  if (inline) {
    if (typeof current.effort !== 'string') refuse(`agents.${persona}.configuration.effort in ${file} is ${JSON.stringify(current.effort)}, not a scalar effort`);
    next = spliceYamlScalar(text, ['agents', persona, 'configuration', 'model'], { expect: HAIKU, to: 'sonnet' });
    next = spliceYamlScalar(next, ['agents', persona, 'configuration', 'effort'], { expect: current.effort, to: 'high' });
  } else {
    let targetDef;
    try { targetDef = YAML.parse(readFileSync(target, 'utf8')); } catch (e) { refuse(`${target} does not parse: ${e.message}`); }
    if (!targetDef || typeof targetDef !== 'object' || Array.isArray(targetDef)
      || targetDef.model !== 'sonnet' || targetDef.effort !== 'high') {
      refuse(`${target} must declare model: sonnet and effort: high before repointing agents.${persona}.configuration`);
    }
    // Read the comment off the line: node.comment can also include a comment on the next line.
    const valueEnd = doc.getIn(['agents', persona, 'configuration'], true).range[1];
    const nl = text.indexOf('\n', valueEnd);
    const documented = /^[ \t]*#/.test(text.slice(valueEnd, nl === -1 ? text.length : nl));
    next = spliceYamlScalar(text, ['agents', persona, 'configuration'], {
      expect: current, to: TARGET, ...(documented ? { comment: COMMENT } : {}),
    });
  }

  // The splice already proved the edit re-parses to this document with only that scalar changed.
  // The comment is not part of that parse, so the BYTES are checked too: one line, and no other.
  const a = text.split('\n');
  const b = next.split('\n');
  const at = a.length === b.length ? a.flatMap((l, i) => (l === b[i] ? [] : [i])) : null;
  if (at === null || at.length < 1 || at.length > (inline ? 2 : 1)) refuse(`the edit would change ${at === null ? 'the line count' : `${at.length} lines`} of ${file}, not ${inline ? 'one or two' : 'one'} line`);
  const i = at[0];

  return {
    satisfied: false,
    changes: inline ? [
      ...at.flatMap((line) => [`${file}:${line + 1}`, `  - ${a[line].replace(/\r$/, '')}`, `  + ${b[line].replace(/\r$/, '')}`]),
      `inline model ${HAIKU} and effort ${current.effort} become sonnet and high`,
      'backup first, beside it: config.yaml.bak-0012-<timestamp>',
    ] : [
      `${file}:${i + 1}`,
      `  - ${a[i].replace(/\r$/, '')}`,
      `  + ${b[i].replace(/\r$/, '')}`,
      `${current} is ${typeFile} (model ${HAIKU}); ${TARGET} is ${target}`,
      'backup first, beside it: config.yaml.bak-0012-<timestamp>',
    ],
    apply: async () => {
      if (!readFileSync(file).equals(bytes)) refuse(`${file} changed since it was planned - re-run`);
      ctx.log(`backup: ${ctx.backup(file)}`);
      writeFileSync(file, next, 'utf8');
    },
  };
}
