// 0050 — config.yaml: an agent that states no allowed_users keeps answering anyone (operator 2026-10-26).
//
// Since 2026-10-26 a being with no allowed_users at either tier answers only the node's owners
// (src/spine/router.mjs mayWake). This writes `conversation_defaults.allowed_users: ['*']` on every
// agent that states none, so an existing node answers exactly as before. Conversation lists are not
// touched. Edits go through the splice layer (src/tools/config-io.mjs); every other byte stays.
//
// Satisfied: no config.yaml or no `agents:` map; a top-level `conversation_defaults:` (a profile
// seeded from the new skeleton, born under the owner default); every agent states a list.
// Left as is, with a note — the agent then answers only the owners, never wider than before:
//   - `access_level: all` at its conversation_defaults: brainpool refuses it with no list, ['*'] would open it;
//   - a conversation (conversations.yaml / rooms.yaml) runs it `all` without a list of its own: same;
//   - a block this cannot write: not a mapping, a `conversation_defaults:` that is not one.
// Refuses: config.yaml not UTF-8 or not parsing; conversations.yaml / rooms.yaml not parsing; the
// file changed since it was planned.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as YAML from 'yaml';
import { spliceYamlInsertKey } from '../src/tools/config-io.mjs';

export const elevated = false;
export const summary = "agents that state no allowed_users keep answering anyone: conversation_defaults.allowed_users: ['*'] written on each (a being with no list now answers only the node's owners)";

const ID = '0050';
const AGENTS = 'agents';
const CD = 'conversation_defaults';
const AU = 'allowed_users';
const ANYONE = "['*']";
const LINE = `${AU}: ${ANYONE}   # ${ID}: anyone, as before the owner default (2026-10-26)`;
const refuse = (why) => { throw new Error(`${ID} refuses: ${why}`); };
const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Beings some conversation runs `all` without a list of its own.
function allWithoutAList(egptHome) {
  const names = new Set();
  for (const f of ['conversations.yaml', 'rooms.yaml']) {
    const file = join(egptHome, 'config', f);
    if (!existsSync(file)) continue;
    const doc = YAML.parseDocument(readFileSync(file, 'utf8'));
    if (doc.errors.length) refuse(`${file} does not parse (${doc.errors[0].message}) - whether a conversation runs a being 'all' without a list cannot be read`);
    const walk = (node) => {
      if (!isMap(node)) return;
      for (const [k, v] of Object.entries(node)) {
        if (isMap(v) && v.access_level === 'all' && !Array.isArray(v[AU])) names.add(k);
        walk(v);
      }
    };
    walk(doc.toJS());
  }
  return names;
}

// The column a block mapping's keys sit at.
const columnOf = (text, node) => {
  const at = node.items[0].key.range[0];
  return ' '.repeat(at - (text.lastIndexOf('\n', at - 1) + 1));
};

// `key: value` added at the end of a flow mapping, re-parsed to prove it is that one change.
function flowInsert(text, path, key, value) {
  const doc = YAML.parseDocument(text);
  const node = doc.getIn(path, true);
  const last = node.items[node.items.length - 1];
  const at = last ? ((last.value?.range ?? last.key.range)[1]) : node.range[0] + 1;
  const next = `${text.slice(0, at)}${last ? ', ' : ' '}${key}: ${value}${last ? '' : ' '}${text.slice(at)}`;
  const expected = doc.toJS();
  path.reduce((o, k) => o[k], expected)[key] = YAML.parse(value);
  const check = YAML.parseDocument(next);
  if (check.errors.length || !isDeepStrictEqual(check.toJS(), expected)) throw new Error(`the flow mapping at ${path.join('.')} cannot take \`${key}\` cleanly`);
  return next;
}

// One agent's edit onto the running text.
function addAnyone(text, name) {
  const doc = YAML.parseDocument(text);
  const agent = doc.getIn([AGENTS, name], true);
  const cd = agent.get(CD, true);
  if (cd === undefined) {
    if (agent.flow || !agent.items.length) return flowInsert(text, [AGENTS, name], CD, `{ ${AU}: ${ANYONE} }`);
    const pad = columnOf(text, agent);
    return spliceYamlInsertKey(text, [AGENTS, name], { key: CD, text: `${pad}${CD}:\n${pad}  ${LINE}` });
  }
  if (cd.flow || !cd.items.length) return flowInsert(text, [AGENTS, name, CD], AU, ANYONE);
  return spliceYamlInsertKey(text, [AGENTS, name, CD], { key: AU, text: `${columnOf(text, cd)}${LINE}` });
}

export async function plan(ctx) {
  const file = join(ctx.egptHome, 'config', 'config.yaml');
  if (!existsSync(file)) return { satisfied: true, notes: [`no ${file}`] };
  const bytes = readFileSync(file);
  const original = bytes.toString('utf8');
  if (!Buffer.from(original, 'utf8').equals(bytes)) refuse(`${file} is not valid UTF-8; a splice would re-encode bytes it never meant to touch`);
  const doc = YAML.parseDocument(original);
  if (doc.errors.length) refuse(`${file} does not parse: ${doc.errors[0].message}`);
  const data = doc.toJS();
  if (isMap(data) && Object.hasOwn(data, CD)) return { satisfied: true, notes: [`${file} states a top-level \`${CD}:\` - this profile was made under the owner default`] };
  const agents = isMap(data) ? data[AGENTS] : undefined;
  if (!isMap(agents)) return { satisfied: true, notes: [`${file} has no \`${AGENTS}:\` mapping`] };

  const runsAll = allWithoutAList(ctx.egptHome);
  let text = original;
  const changes = [];
  const notes = [];
  for (const [name, a] of Object.entries(agents)) {
    if (name.startsWith('_')) continue;
    const at = `${AGENTS}.${name}`;
    if (!isMap(a)) { notes.push(`${at} is not a mapping - left; it answers only the owners now`); continue; }
    const cd = a[CD];
    if (cd !== undefined && !isMap(cd)) { notes.push(`${at}.${CD} is not a mapping - left; it answers only the owners now`); continue; }
    if (Array.isArray(cd?.[AU])) continue;
    if (cd?.access_level === 'all') {
      notes.push(`${at} runs 'all' by default with no list - left: brainpool refuses it, and ${ANYONE} would open it to anyone`);
      continue;
    }
    if (runsAll.has(name)) {
      notes.push(`${at} runs 'all' in a conversation with no list - left: brainpool refuses it there, and ${ANYONE} would open it to anyone; elsewhere it answers only the owners now`);
      continue;
    }
    try { text = addAnyone(text, name); } catch (e) { notes.push(`${at}: ${e.message} - left; it answers only the owners now`); continue; }
    changes.push(`${file}: ${at}.${CD}.${AU}: ${ANYONE} - it stated no list, so it keeps answering anyone`);
  }
  if (!changes.length) return { satisfied: true, notes };

  return {
    satisfied: false,
    changes: [...changes, ...notes, `backup first, beside it: config.yaml.bak-${ID}-<timestamp>`],
    apply: async () => {
      if (!readFileSync(file).equals(bytes)) refuse(`${file} changed since it was planned - re-run`);
      ctx.log(`backup: ${ctx.backup(file)}`);
      writeFileSync(file, text, 'utf8');
    },
  };
}
