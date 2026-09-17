// 0011 — E+ is E on opus-high, gated to the operator.
//
// Operator, 2026-09-17: "can + be an agent? would be like an E+ running opus high. K is opus
// xhigh. `+ hi, please write this egpt module`" … "yes, +/e+ for opus high only for allowed user".
//
// So: a being addressed as `+` or `e+`, wearing E's identity (the same personality file, the same
// voice), running the opus-high configuration. It is its OWN key, so it keeps its OWN threads —
// this is not E's conversation continued on a bigger model, it is a second being. Opus 5 costs
// 2.5x Sonnet 5 per token ($5/$25 vs $2/$10 per million), which is why `allowed_users` keeps it to
// the operator: anyone else saying "+" in a chat wakes nobody.
//
// WHICH NODE GETS IT, and why it is not `node_name`: the node whose DEFAULT PERSONA answers to
// `e`. E+ is E's own voice, so it belongs beside E — and if both nodes carried it, both would wake
// on one `+` in one chat and the operator would get two answers to one question. On kg the default
// agent is `egpt` with handles [ e, egpt, ekg, egptkg ], so kg gets it; on do the default persona's
// handles are [ d, don ], so do reads SATISFIED and is left alone. The question "does this agent
// answer to `e`" is asked of router.mjs's wakeTokens — THE definition of an agent's wake
// vocabulary — never re-implemented here.
//
// `allowed_users` IS NOT INVENTED HERE. It is copied from the node's own config: the default
// persona's `conversation_defaults.allowed_users`, else the `wren` agent's. A node with neither
// list, or without `config/agents/opus-high.yaml`, is NOT a node E+ belongs on: those read
// satisfied with a note, never a refusal. An ungated E+ is what the operator ruled against, and
// a chain stopped forever over a being that node never asked for is the 0003/0007 mistake.
//
// SATISFIED FIRST: `agents.eplus` already carrying these handles on this configuration. Then "not
// this node" — the persona does not answer to `e`, or there is no persona at all (no agent carries
// `default: true`, which is every node with no `agents:` block). Only after both does it check
// anything it could refuse over, so a node this migration has no business on is never refused over
// a collision or a missing file that is none of its concern — a refusal STOPS THE WHOLE CHAIN
// (setup/migrate.mjs), so a migration must only refuse about a node it actually applies to.
//
// IT REFUSES, NAMING THE PLACE, when: `agents.eplus` is there in a DIFFERENT shape (a hand-edit
// this migration must not silently overwrite); any existing agent already answers to `+` or `e+`
// (its handles, voice_handles or fallback_handle — two beings on one token is the double-answer
// bug again); or MORE THAN ONE agent carries `default: true` — a node that has personas but cannot
// say which one is THE persona may well be E's, and neither "which node" nor "after which block"
// can be answered by guessing.
//
// The edit is a byte insertion (src/tools/config-io.mjs spliceYamlInsertKey): the block below goes
// in directly after the persona's own block, every other byte — CRLF, the persona's trailing
// comment line, the comment block that introduces the NEXT being — is kept, and the result is
// verified to re-parse to the config plus exactly agents.eplus.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { spliceYamlInsertKey } from '../src/tools/config-io.mjs';
import { wakeTokens, voiceWakeTokens, fallbackWake } from '../src/spine/router.mjs';

export const elevated = false;
export const summary = 'E+ (`+`, `e+`) — E\'s identity on opus-high, gated to the operator — is added on the node whose persona answers to `e`';

const AGENT = 'eplus';
const PERSONA_TOKEN = 'e';
const CONFIGURATION = 'opus-high';
const HANDLES = ['+', 'e+'];

const refuse = (why) => { throw new Error(`0011 refuses: ${why}`); };

// The block AS IT WILL READ in the operator's file, indented for `agents:`. Everything but the id
// list is fixed text; `users` is the node's own list, rendered as the one-line flow list the rest
// of these configs use.
const blockText = (users) => [
  '  # E+ - E\'s own voice on a bigger model (operator 2026-09-17: "+/e+ for opus high only for',
  '  # allowed user"). Its own key, so its own threads: this is not E\'s conversation continued,',
  '  # it is a second being wearing E\'s identity. Opus 5 is 2.5x Sonnet 5 per token ($5/$25 vs',
  '  # $2/$10 per million), so `allowed_users` keeps it to the operator - anyone else saying "+"',
  '  # in a chat wakes nobody.',
  `  ${AGENT}:`,
  `    configuration: ${CONFIGURATION} # config/agents/${CONFIGURATION}.yaml`,
  '    personality: egpt # config/agents/identities/egpt.md - E\'s identity, E\'s voice',
  '    handles: [ "+", "e+" ] # quoted: bare + and e+ are not plain YAML scalars',
  '    name: "E+"',
  '    body_emoji: "🐶"',
  '    mode: mention # never answers unaddressed',
  '    conversation_defaults:',
  '      access_level: sandbox',
  `      allowed_users: ${YAML.stringify(users, { flow: true, lineWidth: 0 }).trim()}`,
  '      verbose_thinking: true',
].join('\n');

// The ONE agent carrying `default: true` — the persona, whose key boot injects as defaultBeing.
// None: this node has no persona, so it is not E's and there is nothing to sit beside (null, read
// as satisfied). Several: it may well be E's node and nothing here can say which block E+ goes
// after, so that is refused.
function personaOf(agents) {
  const keys = Object.entries(agents)
    .filter(([name, a]) => a && typeof a === 'object' && !name.startsWith('_') && a.default === true)
    .map(([name]) => name);
  if (keys.length > 1) refuse(`the default persona cannot be identified: ${keys.length} agents carry \`default: true\` (${keys.join(', ')})`);
  return keys[0] ?? null;
}

// The id list, taken from the node's own config or not at all. NOT FOUND IS NOT A REFUSAL: a node
// that lists nobody has nothing to gate E+ with, so E+ is not for it - and a refusal would stop
// every later migration on that node over a being it never asked for (the 0003/0007 lesson).
function allowedUsersFrom(agents, persona) {
  const looked = [];
  for (const key of [persona, 'wren']) {
    looked.push(`agents.${key}.conversation_defaults.allowed_users`);
    const v = agents?.[key]?.conversation_defaults?.allowed_users;
    if (Array.isArray(v) && v.length) return { users: v, from: looked[looked.length - 1] };
  }
  return { users: null, looked };
}

// Every agent that already answers to one of E+'s handles, by whichever declaration claims it.
function claimants(agents) {
  const want = new Set(HANDLES);
  const out = [];
  for (const [name, agent] of Object.entries(agents ?? {})) {
    if (!agent || typeof agent !== 'object' || name.startsWith('_') || name === AGENT) continue;
    for (const [field, tokens] of [
      ['handles', wakeTokens(name, agent)],
      ['voice_handles', voiceWakeTokens(agent)],
      ['fallback_handle', fallbackWake(agent)?.handles ?? []],
    ]) {
      for (const t of tokens) if (want.has(t)) out.push(`agents.${name}.${field} claims ${JSON.stringify(t)}`);
    }
  }
  return out;
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
  if (!agents || typeof agents !== 'object') return { satisfied: true, notes: [`${file} has no \`agents:\` mapping, so this node has no persona for E+ to sit beside`] };

  const existing = agents[AGENT];
  if (existing) {
    const same = existing.configuration === CONFIGURATION
      && JSON.stringify(existing.handles) === JSON.stringify(HANDLES);
    if (same) return { satisfied: true, notes: [`agents.${AGENT} is already configured: handles [ ${HANDLES.join(', ')} ] on ${CONFIGURATION}`] };
    refuse(`agents.${AGENT} already exists in ${file} in a different shape (configuration: ${JSON.stringify(existing.configuration)}, handles: ${JSON.stringify(existing.handles)}) - a hand edit this migration will not overwrite`);
  }

  const persona = personaOf(agents);
  if (persona === null) return { satisfied: true, notes: [`no agent in ${file} carries \`default: true\`, so this node has no persona for E+ to sit beside`] };
  if (!wakeTokens(persona, agents[persona]).includes(PERSONA_TOKEN)) {
    return { satisfied: true, notes: [`this node's persona is agents.${persona}, which answers to [ ${wakeTokens(persona, agents[persona]).join(', ')} ] and not \`${PERSONA_TOKEN}\` - E+ belongs beside E, on one node only`] };
  }

  const taken = claimants(agents);
  if (taken.length) refuse(`another being already answers to E+'s handles in ${file}: ${taken.join('; ')}`);
  // THE TWO THINGS E+ NEEDS FROM THE NODE, and neither is a refusal when absent: a node without
  // the type file or without a list of trusted ids is simply not a node E+ belongs on, and
  // stopping its migration chain over that would be the 0003/0007 mistake again.
  const configuration = join(ctx.egptHome, 'config', 'agents', `${CONFIGURATION}.yaml`);
  if (!existsSync(configuration)) {
    return { satisfied: true, notes: [`there is no ${configuration} on this node, so there is no ${CONFIGURATION} for E+ to run on - not added here`] };
  }
  const { users, from, looked } = allowedUsersFrom(agents, persona);
  if (!users) {
    return { satisfied: true, notes: [`this node lists no trusted ids (${looked.join(' or ')}), and E+ is not added ungated - not added here`] };
  }

  const next = spliceYamlInsertKey(text, ['agents'], { key: AGENT, text: blockText(users), after: persona });
  const a = text.split('\n');
  const b = next.split('\n');
  const n = b.length - a.length;
  let s = 0;
  while (s < a.length && a[s] === b[s]) s++;
  const added = b.slice(s, s + n).map((l) => l.replace(/\r$/, ''));

  return {
    satisfied: false,
    changes: [
      `${file}:${s + 1}-${s + n}  insert agents.${AGENT} directly after agents.${persona} (${n} lines):`,
      ...added.map((l) => `  + ${l}`),
      `allowed_users copied from ${from}`,
      'backup first, beside it: <file>.bak-0011-<timestamp>',
    ],
    apply: async () => {
      if (!readFileSync(file).equals(bytes)) refuse(`${file} changed since it was planned - re-run`);
      ctx.log(`backup: ${ctx.backup(file)}`);
      writeFileSync(file, next, 'utf8');
    },
  };
}
