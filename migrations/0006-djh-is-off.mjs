// 0006 — djh (djhaiku) is off until dj pi replaces it.
//
// Operator, 2026-09-16: "djh -- djhaiku -- can be disabled for now, since we're not using. it'll be
// replaced by dj pi, ran by an sandboxed opus high model. however, disable djh for now."
//
// "Off" is the mode the gate already has: src/auto-mode.mjs makes `off` neither receive nor reply,
// so the being never sees the chat at all. Only do defines djh; on a node without it this reads
// satisfied.
//
// THE AGENT DEFAULT IS NOT THE WHOLE ANSWER. src/spine/gating.mjs resolves a being's mode down one
// chain, most specific first: conversations.yaml per-conversation (<conv>.agents.djh.mode, then
// <conv>.djh.mode), THEN config.yaml agents.djh.mode, then the node default. So setting the agent
// default to `off` silences djh only where no conversation overrides it. This migration therefore
// checks the EFFECTIVE state: it is satisfied only when the agent default is `off` AND no
// conversation re-enables djh, and it refuses by name - naming the chat - rather than reporting
// djh off while it still answers somewhere. Measured on do, 2026-09-16: one djh block (Radio WnL),
// no mode override.
//
// The edit goes through the splice (src/tools/config-io.mjs): one scalar, every other byte kept.
// A splice cannot INSERT a key, so a djh with no `mode:` at all is refused rather than rewritten.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { spliceYamlScalar } from '../src/tools/config-io.mjs';

export const elevated = false;
export const summary = 'djh (djhaiku) is off until dj pi replaces it';

const AGENT = 'djh';
const OFF = 'off';

const refuse = (why) => { throw new Error(`0006 refuses: ${why}`); };

// Every place a conversation sets djh's mode to something other than `off`, whichever of the two
// per-conversation shapes it uses. A walk, not a fixed path, so neither shape can slip past.
function conversationOverrides(convText) {
  const found = [];
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (k === AGENT && v && typeof v === 'object' && Object.hasOwn(v, 'mode') && v.mode !== OFF) {
        found.push(`${[...path, k].join('.')}.mode = ${JSON.stringify(v.mode)}`);
      }
      walk(v, [...path, k]);
    }
  };
  walk(YAML.parse(convText), []);
  return found;
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
  if (!agents || !Object.hasOwn(agents, AGENT)) return { satisfied: true, notes: [`no agents.${AGENT} on this node - nothing to switch off`] };

  const convFile = join(ctx.egptHome, 'config', 'conversations.yaml');
  const overrides = existsSync(convFile) ? conversationOverrides(readFileSync(convFile, 'utf8')) : [];
  if (overrides.length) {
    refuse(`a conversation overrides ${AGENT}'s mode, so switching the agent default off would not silence it there - a human decision: ${overrides.join('; ')} (${convFile})`);
  }

  const def = agents[AGENT];
  if (!def || typeof def !== 'object') refuse(`agents.${AGENT} is not a block`);
  if (!Object.hasOwn(def, 'mode')) refuse(`agents.${AGENT} has no mode: key, and a splice cannot insert one - add \`mode: ${OFF}\` to it`);
  const current = def.mode;
  if (current === OFF) return { satisfied: true, notes: [`agents.${AGENT}.mode is already ${OFF}, and no conversation overrides it`] };
  if (typeof current !== 'string') refuse(`agents.${AGENT}.mode is ${JSON.stringify(current)}, not a mode name`);

  const next = spliceYamlScalar(text, ['agents', AGENT, 'mode'], { expect: current, to: OFF });

  const changes = [];
  const a = text.split('\n');
  const b = next.split('\n');
  a.forEach((line, i) => {
    if (line !== b[i]) changes.push(`${file}:${i + 1}`, `  - ${line.replace(/\r$/, '')}`, `  + ${b[i].replace(/\r$/, '')}`);
  });
  changes.push('backup first, beside it: config.yaml.bak-0006-<timestamp>');

  return {
    satisfied: false,
    changes,
    apply: async () => {
      if (!readFileSync(file).equals(bytes)) refuse(`${file} changed since it was planned - re-run`);
      const backup = ctx.backup(file);
      ctx.log(`backup: ${backup}`);
      writeFileSync(file, next, 'utf8');
    },
  };
}
