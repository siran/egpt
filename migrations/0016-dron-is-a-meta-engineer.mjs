// 0016 — dron is a meta engineer.
//
// Operator, 2026-09-20: "dron is a meta engineer in DO". The standing definition, the one 0014
// already asks the node for: a meta engineer is an `access_level: all` being — the unsandboxed one
// that runs AS the operator, because its job is to change the machine.
//
// THE BEING IS FOUND BY ITS HANDLE, never by the map key, and that is the whole trap this
// migration is written around. On do the block is keyed `rodz`:
//   rodz:
//     configuration: sonnet-high
//     personality: dron
//     handles: [ dron ]
// so "the agent called dron" is `agents.rodz`. The question "does this being answer to `dron`" is
// asked of src/spine/router.mjs's wakeTokens — THE definition of an agent's wake vocabulary, the
// same one 0011 asks — and never re-implemented here. kg has no being with that handle, so kg
// reads SATISFIED.
//
// THE LEVEL AND THE LIST ARE ONE CHANGE, and that is not tidiness. src/spine/brainpool.mjs's
// STRUCTURAL SAFETY GATE throws for an `access_level: 'all'` being with no `allowed_users` at
// either tier ("refusing to run — set allowed_users, or ['*'] to explicitly allow anyone"), so
// granting the level without the list would SILENCE the being instead of promoting it. Both land
// in one apply or neither does.
//
// `allowed_users` IS NOT INVENTED HERE, exactly as in 0011. It is copied from the node's own
// config: another `all` being's `conversation_defaults.allowed_users` first — the beings already
// trusted at this very level — else the persona's. A node with neither reads SATISFIED with a
// note: promoting a being ungated is the thing the gate exists to prevent, and a refusal would
// stop every later migration on that node (the 0003/0007/0011 lesson).
//
// `sandboxed: false` IS ALREADY THERE AND STAYS. An `all` being runs unsandboxed, as wren does;
// nothing here writes it, and nothing here removes it.
//
// SATISFIED, NOT REFUSED: no `agents:` mapping; no being answering to `dron`; that being is
// already `all` with a non-empty `allowed_users`; and no list anywhere to copy.
//
// IT REFUSES, NAMING THE PLACE, only on what it cannot honestly edit: no config.yaml, one that is
// not valid UTF-8 or does not parse; MORE THAN ONE being answering to `dron` (two beings on one
// token is a human decision, not a guess); that being having no `conversation_defaults:` mapping
// or no `access_level:` key inside it (there is no line to change, and where a new block belongs
// is a guess); an `allowed_users` that is present but is not a non-empty list.
//
// THE EDITS are byte splices of config/config.yaml (src/tools/config-io.mjs): spliceYamlScalar for
// the one `access_level` line — with the `comment` 0012 added, so a trailing comment that
// documented the OLD level is rewritten rather than left lying — and spliceYamlInsertKey for the
// `allowed_users` line directly after it. CRLF, alignment and every other byte are kept.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { spliceYamlScalar, spliceYamlInsertKey } from '../src/tools/config-io.mjs';
import { wakeTokens } from '../src/spine/router.mjs';

export const elevated = false;
export const summary = 'the being that answers to `dron` becomes a meta engineer — `access_level: all`, gated by the node\'s own trusted ids';

const HANDLE = 'dron';
const LEVEL = 'all';
const COMMENT = 'a meta engineer runs as the operator because its job is to change the machine (0016, operator 2026-09-20: "dron is a meta engineer in DO")';

const refuse = (why) => { throw new Error(`0016 refuses: ${why}`); };
const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const agentEntries = (agents) => Object.entries(agents).filter(([n, a]) => isMap(a) && !n.startsWith('_'));

// The ids this being is gated by, taken from the node's own config or not at all. The beings
// already trusted at THIS level first, then the persona (`default: true`). NOT FOUND IS NOT A
// REFUSAL - see the header.
function allowedUsersFrom(agents, target) {
  const looked = [];
  const rungs = [
    ...agentEntries(agents).filter(([n, a]) => n !== target && a.conversation_defaults?.access_level === LEVEL),
    ...agentEntries(agents).filter(([n, a]) => n !== target && a.default === true),
  ];
  for (const [name, a] of rungs) {
    const where = `agents.${name}.conversation_defaults.allowed_users`;
    if (looked.includes(where)) continue;
    looked.push(where);
    const v = a.conversation_defaults?.allowed_users;
    if (Array.isArray(v) && v.length) return { users: v, from: where };
  }
  return { users: null, looked };
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
  if (!isMap(agents)) return { satisfied: true, notes: [`${file} has no \`agents:\` mapping, so nothing here answers to \`${HANDLE}\``] };

  // THE HANDLE, not the key: on do the being called dron is keyed `rodz`.
  const answering = agentEntries(agents).filter(([name, a]) => wakeTokens(name, a).includes(HANDLE)).map(([name]) => name);
  if (!answering.length) {
    return { satisfied: true, notes: [`no being in ${file} answers to \`${HANDLE}\`, so this node has no dron to promote`] };
  }
  if (answering.length > 1) {
    refuse(`${answering.length} beings in ${file} answer to \`${HANDLE}\` (${answering.join(', ')}) - which one is the meta engineer is a human decision, not a guess`);
  }

  const being = answering[0];
  const at = ['agents', being, 'conversation_defaults'];
  const cd = agents[being].conversation_defaults;
  if (!isMap(cd)) refuse(`agents.${being} (the being that answers to \`${HANDLE}\`) has no \`conversation_defaults:\` mapping in ${file} - there is no line here to change, and where a new block belongs is a guess`);
  if (!Object.hasOwn(cd, 'access_level')) refuse(`agents.${being}.conversation_defaults in ${file} has no \`access_level:\` key - there is no line here to change`);

  const users = cd.allowed_users;
  const hasUsers = Array.isArray(users) && users.length > 0;
  if (users !== undefined && !hasUsers) {
    refuse(`\`allowed_users\` in agents.${being}.conversation_defaults is ${JSON.stringify(users)} - an \`${LEVEL}\` being with an empty or non-list allowed_users is refused a turn by brainpool.mjs, and this migration will not overwrite a hand edit there`);
  }
  if (cd.access_level === LEVEL && hasUsers) {
    return { satisfied: true, notes: [`agents.${being} already runs \`access_level: ${LEVEL}\` gated by ${users.length} allowed_users - it is already this node's meta engineer`] };
  }

  const { users: copied, from, looked } = hasUsers ? { users, from: null } : allowedUsersFrom(agents, being);
  if (!copied) {
    return { satisfied: true, notes: [`this node lists no trusted ids (${looked.join(' or ')}), and agents.${being} is not promoted ungated - brainpool.mjs refuses a turn for an \`${LEVEL}\` being with no allowed_users, so the level alone would silence it`] };
  }

  // The column `conversation_defaults`' own keys sit at, read off the file - the inserted line must
  // be written at exactly that indent or spliceYamlInsertKey refuses it.
  const cdNode = doc.getIn(at, true);
  const keyAt = cdNode.items[0].key.range[0];
  const indent = ' '.repeat(keyAt - (text.lastIndexOf('\n', keyAt - 1) + 1));

  const changes = [];
  let next = text;

  if (cd.access_level !== LEVEL) {
    // Read off the ORIGINAL text: does the `access_level` line carry a trailing comment to rewrite?
    // A line with none keeps none - spliceYamlScalar rewrites a comment, it does not invent one (0012).
    const valueEnd = doc.getIn([...at, 'access_level'], true).range[1];
    const eol = text.indexOf('\n', valueEnd);
    const documented = /^[ \t]*#/.test(text.slice(valueEnd, eol === -1 ? text.length : eol));
    next = spliceYamlScalar(next, [...at, 'access_level'], { expect: cd.access_level, to: LEVEL, ...(documented ? { comment: COMMENT } : {}) });
    const a = text.split('\n');
    const b = next.split('\n');
    const line = a.findIndex((l, i) => l !== b[i]);
    changes.push(
      `${file}:${line + 1}`,
      `  - ${a[line].replace(/\r$/, '')}`,
      `  + ${b[line].replace(/\r$/, '')}`,
    );
  }

  if (!hasUsers) {
    const block = [
      `${indent}# A meta engineer is gated by name (0016): brainpool.mjs's structural gate REFUSES a turn`,
      `${indent}# for an \`access_level: ${LEVEL}\` being with no allowed_users at either tier, so the level`,
      `${indent}# without the list would silence this being instead of promoting it. Copied from this`,
      `${indent}# node's own trusted ids, never invented here.`,
      `${indent}allowed_users: ${YAML.stringify(copied, { flow: true, lineWidth: 0 }).trim()}`,
    ].join('\n');
    const before = next.split('\n');
    next = spliceYamlInsertKey(next, at, { key: 'allowed_users', text: block, after: 'access_level' });
    const after = next.split('\n');
    let s = 0;
    while (s < before.length && before[s] === after[s]) s++;
    const n = after.length - before.length;
    changes.push(
      `${file}:${s + 1}-${s + n}  insert agents.${being}.conversation_defaults.allowed_users, copied from ${from} (${n} lines):`,
      ...after.slice(s, s + n).map((l) => `  + ${l.replace(/\r$/, '')}`),
    );
  }

  changes.push(
    `agents.${being} answers to \`${HANDLE}\` and becomes this node's meta engineer - unsandboxed, running as the operator`,
    'backup first, beside it: <file>.bak-0016-<timestamp>',
  );

  return {
    satisfied: false,
    changes,
    apply: async () => {
      if (!readFileSync(file).equals(bytes)) refuse(`${file} changed since it was planned - re-run`);
      ctx.log(`backup: ${ctx.backup(file)}`);
      writeFileSync(file, next, 'utf8');
    },
  };
}
