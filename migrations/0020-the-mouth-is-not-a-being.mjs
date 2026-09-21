// 0020 — the mouth is not a being.
//
// `@rodz` is an ACCOUNT, not a persona. `beeper.secondary` is dolly.egpt@gmail.com, display name
// Rodz, and BOTH nodes speak through that one account — do's own config annotates it "Rodz - the
// mouth". kg nevertheless carries a BEING named after it: `agents.rodz`, name "Rodz",
// `personality: rodz`, `handles: [ rodz, r ]`, `access_level: sandbox`. Operator, 2026-09-20:
// "@rodz is an account; if people mention @rodz, do (the worker) preferably replies via Rodz."
//
// So this is ONE ruling in TWO halves, and each node does a different one:
//   kg  the being named after the mouth GOES — its config.yaml block, its per-chat records
//       (4 in config/conversations.yaml, measured 2026-09-20; none in rooms.yaml) and
//       config/agents/identities/rodz.md.
//   do  the being that answers to `don` — do's default being, the WORKER — ALSO answers to
//       `rodz`, so a `@rodz` mention reaches it.
// After both, exactly one node answers a `@rodz` mention. Handles are disjoint across nodes by
// design and there is no cross-node fallback; that is accepted, not an oversight.
//
// EACH HALF IS INDEPENDENTLY SATISFIABLE. kg has no `don`; do, once 0019 has run, has no being
// answering to `rodz`. A node missing its half reads SATISFIED WITH A NOTE — never a refusal,
// which would stop every later migration on that node (the 0003/0007/0011/0012 lesson).
//
// BOTH HALVES FIND THEIR BEING BY HANDLE, never by the map key. That is the trap the whole
// alignment came out of: on do the being named "Dron" is keyed `rodz` and on kg the being named
// "Rodz" is keyed `rodz`, two different beings behind one key. The question "does this being answer
// to `rodz`" is asked of src/spine/router.mjs's wakeTokens — the same one 0011, 0016 and 0019 ask —
// and never re-implemented here.
//
// ONLY `rodz` IS ADDED, not `r`. kg's persona listed both; a one-letter handle is too easy to
// trigger by accident, and nothing about the ruling asks for it.
//
// THE REMOVAL IS 0019'S, IMPORTED. "Remove this being" means the same three places here as there,
// and there is one definition of it — see 0019's header for why it lives in a migration rather than
// under src/. The per-chat records it removes are listed in `changes` WITH THEIR threadId: the
// operator sees exactly which threads die before approving.
//
// THE SECOND HALF IS ONE SPLICE: src/tools/config-io.mjs's spliceYamlSeqAppend puts `rodz` into the
// existing inline `handles:` list — `[ d, don ]` becomes `[ d, don, rodz ]`, brackets, spacing and
// trailing comment untouched, and the result verified to re-parse to that one item more.
//
// THE `don` BEING IS NEVER THE BEING REMOVED, and that is a correctness rule, not tidiness. Once
// half two applies, that being answers to `rodz` — so the re-plan the runner does straight after
// apply() would otherwise read the node's own PERSONA as the next thing to evict. 0019's `keep`
// option is exactly that exclusion. It also means a node where one being already answers to both
// reads SATISFIED: that is the end state this migration is for, already reached.
//
// IT REFUSES, NAMING THE PLACE, only on what it cannot honestly edit: a required file missing, not
// valid UTF-8, or that does not parse; MORE THAN ONE being answering to `rodz` (the `don` being
// aside) or to `don`; and a `don` being whose `handles:` is absent, is not a list, or is a BLOCK
// list — it answers by its map key alone, or in a shape this splice does not write, and there is no
// inline list to append to.
import { spliceYamlSeqAppend } from '../src/tools/config-io.mjs';
import { wakeTokens } from '../src/spine/router.mjs';
import { evict, applyEviction, beingsAnswering } from './0019-dron-is-gone.mjs';

export const elevated = false;
export const summary = 'the mouth stops being a being: the one answering to `rodz` is removed, and the one answering to `don` answers to `rodz` too';

const ID = '0020';
const HANDLE = 'rodz';       // the persona named after the mouth — it goes
const IDENTITY = 'rodz';     // config/agents/identities/rodz.md
const HOST_HANDLE = 'don';   // do's default being, the worker — it inherits the mention
const GIVEN = 'rodz';        // only this one: `r` is one letter and too easy to trigger by accident

export async function plan(ctx) {
  const refuse = (why) => { throw new Error(`${ID} refuses: ${why}`); };

  // ── half one: the being named after the mouth goes (0019's eviction, same three places) ──
  // `keep` is what makes the two halves safe to run on ONE node, and is not a nicety: half two
  // gives `rodz` to the being that answers to `don`, so the moment it applies, that being answers
  // to `rodz` too — and the runner's re-plan straight after apply() would read the node's PERSONA
  // as the next thing to evict. The being this hands a handle to is never the being it removes.
  const ev = evict(ctx, { id: ID, handle: HANDLE, identity: IDENTITY, keep: HOST_HANDLE });
  const { configFile, configText, configBytes, agents } = ev;

  // ── half two: the being that answers to `don` also answers to `rodz` ──
  const answering = beingsAnswering(agents, HOST_HANDLE);
  if (answering.length > 1) {
    refuse(`${answering.length} beings in ${configFile} answer to \`${HOST_HANDLE}\` (${answering.join(', ')}) - which one takes \`@${GIVEN}\` is a human decision, not a guess`);
  }
  const host = answering[0] ?? null;

  const changes = [...ev.changes];
  const notes = ev.satisfied ? [...ev.notes] : [];
  let hostSatisfied = true;

  if (host === null) {
    notes.push(`no being in ${configFile} answers to \`${HOST_HANDLE}\`, so there is nothing here to hand \`@${GIVEN}\` to`);
  } else if (wakeTokens(host, agents[host]).includes(GIVEN)) {
    notes.push(`agents.${host} already answers to \`${GIVEN}\``);
  } else {
    const handles = agents[host].handles;
    if (!Array.isArray(handles)) {
      refuse(`agents.${host} (the being that answers to \`${HOST_HANDLE}\`) has no \`handles:\` list in ${configFile} - \`handles\` is ${JSON.stringify(handles ?? null)}, so it answers by its map key alone (router.mjs wakeTokens) and there is no list here to append \`${GIVEN}\` to`);
    }
    // Onto the text the eviction already produced, when it produced one: both halves edit this one
    // file, and a node doing both must write it once.
    const base = ev.edits.get(configFile)?.next ?? configText;
    let next;
    try { next = spliceYamlSeqAppend(base, ['agents', host, 'handles'], { expect: handles, add: GIVEN }); }
    catch (e) { refuse(`\`handles:\` in agents.${host} cannot take \`${GIVEN}\` (${e?.message ?? e})`); }
    ev.edits.set(configFile, { bytes: configBytes, text: configText, next });

    const a = base.split('\n');
    const b = next.split('\n');
    const line = a.findIndex((l, i) => l !== b[i]);
    changes.push(
      `${configFile}:${line + 1}`,
      `  - ${a[line].replace(/\r$/, '')}`,
      `  + ${b[line].replace(/\r$/, '')}`,
      `agents.${host} answers to \`@${GIVEN}\` from here on - \`@rodz\` is the account both nodes speak through, and a mention of it now reaches this node's worker`,
    );
    hostSatisfied = false;
  }

  if (ev.satisfied && hostSatisfied) return { satisfied: true, notes };
  return {
    satisfied: false,
    changes: [...changes, ...notes.map((n) => `(the other half is already settled here: ${n})`), `backup first, beside each: <file>.bak-${ID}-<timestamp>`],
    apply: async () => { await applyEviction(ctx, ev); },
  };
}
