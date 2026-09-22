// 0021 — the mouth can drive.
//
// Operator, 2026-09-22: *"Rodz account should be able to drive wren, and dron, right? is a matter
// of allowed_users."* Correct, and it is the only thing missing.
//
// WHAT WAS ALREADY TRUE, measured. The ear and the mouth are SEPARATE Beeper installs
// (`beeper.primary` / `beeper.secondary` — NODE-SHAPE.md's two services), so a message the mouth
// sends arrives at the ear as an ordinary participant message: that is exactly how a being's own
// `⏳ Thinking…` placeholders came back in and filled the loop guard on 09-20. So the mouth is
// HEARD already; nothing here is about delivery.
//
// WHAT IT LACKS IS AUTHORITY. Every operator-gated path tests the SENDER ID against
// `allowed_users` (src/conversations-state.mjs's allowedUsersPermits, the one predicate router.mjs
// and mesh.mjs both ask), and the mouth's id is on no list on either node. So a line typed through
// Rodz reaches the being and is then refused as a stranger's. The fix is one id on one list.
//
// THE ID IS THE MOUTH'S MATRIX USER ID, `@dolly-egpt:beeper.com` — the same on both nodes
// (`beeper.secondary`, the account dolly.egpt@gmail.com; handoffs/2026-09-03-session-zero.md
// records dolly's S0 token minted for exactly that id). It is NOT derived from the node's config:
// `beeper.secondary` holds the ACCOUNT (an e-mail), never the matrix id, so deriving it would be a
// guess dressed as a reading.
//
// WHICH BEING GETS IT — THE PROPERTY, ASKED OF THE NODE, never a hardcoded handle list and NEVER
// the map key. A meta engineer is an `access_level: all` being — the unsandboxed one that runs AS
// the operator because its job is to change the machine, the definition 0014 and 0016 both already
// ask for — AND it is PINNED NODE-WIDE with a `scope:`. On kg that being answers to `wren`, on do
// to `dren`, and a node that grows a third answers for itself. Asking for the PROPERTY is what
// makes this honest on a node neither of those names describes.
//
// THE PIN IS THE SECOND HALF, AND IT IS NOT DECORATION. `access_level: all` ALONE IS NOT A META
// ENGINEER, measured on do 2026-09-22: TWO beings there are `all` — `dren`, the engineer, pinned
// `scope: agent/dren`, and `djh`, a radio agent, unsandboxed but pinned to NOTHING. Level alone
// would make do ambiguous and — under the refusal rule below — would STOP THE CHAIN on the one
// node the ruling is most about. And the ruling named the ENGINEERS: *"drive wren, and dron"*, not
// every unsandboxed being on the box.
//
// `agents.<being>.scope: <surface>/<chatId>` is src/spine/identity-scope.mjs's pin — flat on the
// agent, NOT under `conversation_defaults` — and it means this being has ONE conversation that
// every chat it is addressed in resolves to. That is what an engineer is and a utility being is
// not: one continuous thread that is the machine's own. What is asked here is that the KEY IS
// THERE, not that its value parses: whether a pin resolves is identity-scope's question (it logs
// and ignores one that will not), and a `scope:` line is the operator declaring this being
// node-wide on purpose. The pin is PRINTED in the plan line, so what it is is read before it is
// approved, never guessed at afterwards.
//
// AN `all` BEING WITHOUT A PIN IS NAMED AND LEFT ALONE — in `changes` when there is an edit, in
// `notes` when there is not. It is never silently skipped: an operator reading this plan sees
// every unsandboxed being on the node and which one the mouth is being given.
//
// THE KEY IS NEVER THE QUESTION (the trap 0016, 0018, 0019 and 0020 are each written around: on do
// the being named "Dron" was keyed `rodz`). Nothing here reads a key as a name. Where a being has
// to be NAMED — in a change line, in a refusal — what it answers to is asked of
// src/spine/router.mjs's wakeTokens, THE definition of an agent's wake vocabulary, and never
// re-implemented.
//
// THE HANDLE `rodz` IS NOT THE MOUTH. 0020 gave do's WORKER the handle `rodz`, so on do there is
// now a being that answers to `@rodz` and an account called Rodz, and they are different things: a
// handle is how you ADDRESS a being on this node, an id is WHO SENT the line. The worker is
// `access_level: regular`, so it is not the meta engineer and it gets nothing here — and the
// do-shaped fixture in the tests proves precisely that. Had this been written against a handle
// list, `rodz` is exactly the word that would have put the mouth's authority on the wrong being.
//
// THE LIST IT LANDS ON is `conversation_defaults.allowed_users`, the global-default tier
// src/spine/brainpool.mjs reads (`getConfig()?.agents?.[being]?.conversation_defaults
// ?.allowed_users`) — the same line 0016 writes when it promotes a being. A per-conversation
// override REPLACES this tier rather than merging with it, and which chats deserve one is a human
// decision; this writes the node's default and nothing else.
//
// ALREADY-SATISFIED IS ASKED OF THE NODE'S OWN PREDICATE, not of `.includes`: allowedUsersPermits
// is what actually decides whether a sender gets a turn, so a list already reading `[ "*" ]` — the
// explicit wildcard an `all` being is allowed to carry — is already permitting the mouth, and
// adding an id beside a wildcard would be noise pretending to be a change.
//
// SATISFIED, NOT REFUSED. A refusal STOPS EVERY LATER MIGRATION on that node (setup/migrate.mjs —
// the 0003/0007/0011/0012 lesson), so "nothing to do here" is a note: no `agents:` mapping; no
// pinned `access_level: all` being on this node; the mouth already permitted.
//
// IT REFUSES, NAMING THE PLACE, only on what it cannot honestly edit: no config.yaml, one that is
// not valid UTF-8, or one that does not parse; MORE THAN ONE PINNED `all` being — two node-wide
// engineers on one box is a real human decision, and unlike do's `dren`/`djh` pair it is not a
// question the node itself already answers; and an `allowed_users` that is ABSENT (brainpool's
// structural gate already refuses that being a turn — there is no list here to add to, and where a
// new one belongs is a guess: that is 0016's job, not this one's) or present but not a NON-EMPTY
// list (`[]` means "somebody wrote a list and put nobody on it", and this does not overwrite a
// hand edit).
//
// THE EDIT IS ONE SPLICE, the layer that already owns this: src/tools/config-io.mjs's
// spliceYamlSeqAppend, added for 0020's handle append, puts one item at the end of an INLINE flow
// list — `[ "…", "@anrodriguez:beeper.com" ]` becomes `[ "…", "@anrodriguez:beeper.com",
// "@dolly-egpt:beeper.com" ]` with the brackets, the spacing and any trailing comment untouched,
// verified by re-parse to be that one item and nothing else. `@` is a YAML RESERVED INDICATOR, so
// the id can only be written QUOTED; the splice renders a new item in the same scalar style as the
// item before it, and every id in these lists is quoted (it has to be — a bare phone number would
// read as an integer), so it comes out quoted. A list whose last item were somehow plain is caught
// by the splice's own re-parse and refused by name, never written broken. A BLOCK list is refused
// by the layer by name too: it is a different shape than this one writes.
//
// THE TRAILING COMMENT IS KEPT, NOT REWRITTEN, and that is a deliberate limit rather than an
// oversight. spliceYamlSeqAppend has no `comment` option (spliceYamlScalar's, added by 0012, is
// for a line whose VALUE is being replaced), so a comment on this line survives the append
// untouched. That is right for a comment saying what the list IS FOR — `# who may drive this
// being` reads the same with one more id on it — and wrong for one that COUNTS or enumerates the
// ids, which a fourth entry would turn into a lie. If a node's line carries a counting comment,
// the honest fix is `comment` support on the append (one option, mirroring spliceYamlScalar's),
// not a second YAML path here — and that is a change to the shared layer, so it is proposed to the
// operator rather than taken.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { spliceYamlSeqAppend } from '../src/tools/config-io.mjs';
import { wakeTokens } from '../src/spine/router.mjs';
import { allowedUsersPermits } from '../src/conversations-state.mjs';

export const elevated = false;
export const summary = 'the mouth may drive this node\'s meta engineer: `@dolly-egpt:beeper.com` joins the allowed_users of the `access_level: all` being pinned node-wide with `scope:`';

const ID = '0021';
// The being this is about, BOTH halves: the unsandboxed one —
// `conversation_defaults.access_level: all`, the definition 0014 and 0016 ask the node for — that
// is ALSO pinned node-wide by `agents.<being>.scope` (src/spine/identity-scope.mjs's pin, flat on
// the agent). Level alone is not a meta engineer: do's `djh` is unsandboxed and pinned to nothing.
const LEVEL = 'all';
const PIN = 'scope';
// The mouth's MATRIX USER ID, the same on both nodes — `beeper.secondary`, dolly.egpt@gmail.com.
const MOUTH = '@dolly-egpt:beeper.com';

const refuse = (why) => { throw new Error(`${ID} refuses: ${why}`); };
const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const agentEntries = (agents) => Object.entries(agents).filter(([n, a]) => isMap(a) && !n.startsWith('_'));

// How a being is NAMED in a change line or a refusal: by what it ANSWERS TO (router.mjs's
// wakeTokens), never by its map key alone — the key is bookkeeping, the handles are the being.
const answersTo = (name, agent) => {
  const tokens = wakeTokens(name, agent);
  return tokens.length ? tokens.map((h) => `\`${h}\``).join('/') : 'no handle at all';
};
const named = (agents, name) => `agents.${name} (answers to ${answersTo(name, agents[name])})`;
// The node-wide pin as it reads in the file, so the operator sees WHICH conversation this being is
// the engineer of before approving. A `scope:` that is not a string is shown as it is, not fixed up.
const pinOf = (agent) => (typeof agent[PIN] === 'string' ? agent[PIN] : JSON.stringify(agent[PIN] ?? null));

export async function plan(ctx) {
  const file = join(ctx.egptHome, 'config', 'config.yaml');
  if (!existsSync(file)) refuse(`there is no ${file}`);
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) refuse(`${file} is not valid UTF-8; a splice would re-encode bytes it never meant to touch`);

  const doc = YAML.parseDocument(text);
  if (doc.errors.length) refuse(`${file} does not parse: ${doc.errors[0].message}`);
  const agents = doc.toJS()?.agents;
  if (!isMap(agents)) return { satisfied: true, notes: [`${file} has no \`agents:\` mapping, so this node has no meta engineer for the mouth to drive`] };

  // THE PROPERTY, not a handle and not a key: the `access_level: all` being that is ALSO pinned
  // node-wide. An unsandboxed being with no pin (do's `djh`) is a utility, not an engineer.
  const unsandboxed = agentEntries(agents).filter(([, a]) => a.conversation_defaults?.access_level === LEVEL);
  const engineers = unsandboxed.filter(([, a]) => Object.hasOwn(a, PIN)).map(([name]) => name);
  // Never silently skipped: every unsandboxed being the mouth is NOT being given is named in the
  // plan the operator approves.
  const leftAlone = unsandboxed
    .filter(([, a]) => !Object.hasOwn(a, PIN))
    .map(([name]) => `${named(agents, name)} is \`access_level: ${LEVEL}\` too but carries no \`${PIN}:\` pin, so it is not this node's meta engineer and is left alone`);

  if (!engineers.length) {
    return {
      satisfied: true,
      notes: [
        `no being in ${file} is \`conversation_defaults.access_level: ${LEVEL}\` AND pinned node-wide with \`${PIN}:\`, so this node has no meta engineer for the mouth to drive`,
        ...leftAlone,
      ],
    };
  }
  if (engineers.length > 1) {
    const both = engineers.map((n) => `${named(agents, n)} pinned to \`${pinOf(agents[n])}\``).join(', ');
    refuse(`${engineers.length} beings in ${file} are \`access_level: ${LEVEL}\` AND pinned node-wide with \`${PIN}:\` (${both}) - which one the mouth drives is a human decision, not a guess`);
  }

  const being = engineers[0];
  const who = named(agents, being);
  const at = ['agents', being, 'conversation_defaults', 'allowed_users'];
  const users = agents[being].conversation_defaults.allowed_users;

  if (users === undefined) {
    refuse(`${who} is this node's meta engineer and its \`conversation_defaults:\` in ${file} has no \`allowed_users\` - brainpool.mjs's structural gate already refuses that being a turn, so there is no list here to add ${MOUTH} to, and where a new one belongs is a guess (that is 0016's job, not this one's)`);
  }
  if (!Array.isArray(users) || !users.length) {
    refuse(`\`allowed_users\` in agents.${being}.conversation_defaults is ${JSON.stringify(users)} - an \`${LEVEL}\` being with an empty or non-list allowed_users is refused a turn by brainpool.mjs, and this migration will not overwrite a hand edit there`);
  }

  // The node's OWN predicate decides "already permitted", so a list carrying the explicit `*`
  // wildcard counts — the mouth can drive it already and an id beside it would change nothing.
  if (allowedUsersPermits(users, MOUTH)) {
    const why = users.includes('*')
      ? `already reads ${JSON.stringify(users)} - the explicit wildcard permits anyone, the mouth included`
      : `already lists ${MOUTH}`;
    return { satisfied: true, notes: [`${who} is this node's meta engineer and its allowed_users ${why}`, ...leftAlone] };
  }

  let next;
  try { next = spliceYamlSeqAppend(text, at, { expect: users, add: MOUTH }); }
  catch (e) { refuse(`\`allowed_users:\` in agents.${being}.conversation_defaults cannot take ${MOUTH} (${e?.message ?? e})`); }

  const a = text.split('\n');
  const b = next.split('\n');
  const line = a.findIndex((l, i) => l !== b[i]);

  return {
    satisfied: false,
    changes: [
      `${file}:${line + 1}`,
      `  - ${a[line].replace(/\r$/, '')}`,
      `  + ${b[line].replace(/\r$/, '')}`,
      `${who} is this node's meta engineer - the \`access_level: ${LEVEL}\` being pinned node-wide to \`${pinOf(agents[being])}\` - and ${MOUTH}, the mouth, may drive it from here on; the ${users.length} id${users.length === 1 ? '' : 's'} already there keep theirs`,
      ...leftAlone,
      `backup first, beside it: <file>.bak-${ID}-<timestamp>`,
    ],
    apply: async () => {
      if (!readFileSync(file).equals(bytes)) refuse(`${file} changed since it was planned - re-run`);
      ctx.log(`backup: ${ctx.backup(file)}`);
      writeFileSync(file, next, 'utf8');
    },
  };
}
