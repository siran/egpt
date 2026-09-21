// 0019 — dron is gone.
//
// Operator, 2026-09-20: "dron needs not to exist".
//
// `beeper.secondary` is the ACCOUNT dolly.egpt@gmail.com, display name Rodz, and BOTH nodes speak
// through that one account — do's own config annotates it "Rodz - the mouth". do ALSO carries a
// being for it: `agents.rodz`, named "Dron", `handles: [ dron ]`, the one 0016 promoted to
// `access_level: all` three migrations ago. A being standing beside the account it speaks through
// is the confusion this removes. kg has nothing answering to `dron`, so kg reads SATISFIED.
//
// THE BEING IS FOUND BY ITS HANDLE, never by the map key — the trap 0016 is written around, and
// the same answer: src/spine/router.mjs's wakeTokens, THE definition of an agent's wake vocabulary,
// asked here and never re-implemented. On do "the agent called dron" is `agents.rodz`, and a
// key-based lookup would read satisfied on the one node this is for.
//
// WHAT GOES WITH IT, and this is the ONE way it differs from 0009 (which evicted gauss and REFUSED
// while anything still referenced it): there, a dangling reference was a human decision still to be
// made. Here the operator has already made it — the being goes and its threads go with it. So the
// per-chat records go too, and every one of them is listed in `changes` WITH ITS threadId, so the
// operator sees exactly which threads die before approving. Measured on do, 2026-09-20: one.
//   config/config.yaml                  `agents.<key>` and the comment lines that introduce it
//   config/rooms.yaml                   every per-chat `agents.<key>` record — the two registries
//   config/conversations.yaml           that carry them, the scope 0010 measured
//   config/agents/identities/dron.md    the identity it wore, when no OTHER being still declares
//                                       that personality (an identity two beings share is not
//                                       orphaned, and is left alone with a note)
//
// Removing a being removes the comment block that introduces it — exactly as 0009 does, and every
// removed line is quoted in `changes`. In a chat where it is the ONLY being recorded, the empty
// `agents:` key goes with it: the splice layer will not leave a map holding null, and a chat with
// no `agents:` block reads the same as one with an empty one.
//
// HEARTBEATS ARE NOT SCANNED. The operator measured none naming this being, and heartbeat-loader
// .mjs SKIPS an unknown `agent:` rather than failing, so a beat left behind is inert — not a reason
// to go looking somewhere the evidence does not name (0010), and certainly not a reason to refuse.
//
// SATISFIED FIRST, always: nothing answering to `dron` and no orphaned identity file. A node
// half-way there finishes the other half (0009). A refusal STOPS EVERY LATER MIGRATION on the node,
// so "nothing to do here" is a note, never a throw.
//
// IT REFUSES, NAMING THE PLACE, only on what it cannot honestly edit: a required file missing, not
// valid UTF-8, or that does not parse; MORE THAN ONE being answering to `dron` (which one goes is a
// human decision, not a guess); a record the splice layer will not remove.
//
// THE EVICTION ITSELF IS EXPORTED, because 0020 removes kg's `rodz` persona in exactly the same
// three places and there must be ONE definition of "remove this being". It lives HERE, in a
// migration, and not under src/: a migration is frozen history, and a helper in live code is
// something a later refactor silently rewrites underneath an ALREADY-APPLIED migration. 0019 can
// never change, so neither can this.
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { spliceYamlRemoveKey } from '../src/tools/config-io.mjs';
import { wakeTokens } from '../src/spine/router.mjs';

export const elevated = false;
export const summary = 'the being that answers to `dron` is gone: its block in config.yaml, its per-chat records and the identity it wore';

const ID = '0019';
const HANDLE = 'dron';
const IDENTITY = 'dron';   // config/agents/identities/dron.md

// The two registry files that carry per-chat `agents:` blocks (src/rooms-file.mjs: `rooms: →
// room/<slug>: → agents: → <being>:`; conversations.yaml: `contacts: → <surface>: → <jid>: →
// agents: → <being>:`) — the scope 0010 measured. Missing is fine.
const REGISTRIES = ['rooms.yaml', 'conversations.yaml'];

const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const agentEntries = (agents) => Object.entries(agents).filter(([n, a]) => isMap(a) && !n.startsWith('_'));

function readUtf8(file, refuse) {
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) refuse(`${file} is not valid UTF-8; a splice would re-encode bytes it never meant to touch`);
  return { bytes, text };
}

// Every `agents:` block in a parsed registry, with the PATH to it — 0010's walk, not fixed depths,
// so no nesting a registry uses can slip past. Neither of these two files carries the node-level
// agent REGISTRY, so inside them an `agents:` map is always a container of per-being blocks.
function agentBlocks(data) {
  const out = [];
  const walk = (node, path) => {
    if (!isMap(node)) return;
    for (const [k, v] of Object.entries(node)) {
      const here = [...path, k];
      if (k === 'agents' && isMap(v)) out.push({ path: here, beings: v });
      walk(v, here);
    }
  };
  walk(data, []);
  return out;
}

// The lines one splice took out, read off the two texts rather than guessed — 0009/0010's
// rendering, so a `changes` list reads identically across migrations.
function removedLines(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length - b.length;
  let s = 0;
  while (s < b.length && a[s] === b[s]) s++;
  return { first: s + 1, last: s + n, lines: a.slice(s, s + n).map((l) => l.replace(/\r$/, '')) };
}

// Which beings answer to `handle` — wakeTokens, the node's own definition, never re-implemented.
// Exported for 0020, which asks the same question of `rodz` and of `don`.
export function beingsAnswering(agents, handle) {
  if (!isMap(agents)) return [];
  return agentEntries(agents).filter(([name, a]) => wakeTokens(name, a).includes(handle)).map(([name]) => name);
}

// PLAN the eviction of the being that answers to `handle`: its config.yaml block, its per-chat
// records in both registries, and config/agents/identities/<identity>.md when nothing else wears
// it. Reads only — every edit is returned as text to write, never written here.
//
// `keep` names a handle whose being is NEVER the one evicted, even when it also answers to
// `handle`. 0020 needs it and it is not a convenience: 0020 GIVES `rodz` to the being that answers
// to `don`, so after it applies that being answers to `rodz` too — and the re-plan the runner does
// straight after apply() would otherwise read it as the next thing to evict and delete the node's
// persona. The being this migration hands a handle to is never the being it removes.
//
// Returns { id, configFile, configBytes, configText, agents, being, identityFile, satisfied, notes,
// changes, edits: Map<file, {bytes, text, next}>, deletes: [{file, bytes}] }. `agents` and the
// config text are handed back because 0020 has a SECOND half to plan against the same file.
export function evict(ctx, { id, handle, identity, keep = null }) {
  const refuse = (why) => { throw new Error(`${id} refuses: ${why}`); };

  const configFile = join(ctx.egptHome, 'config', 'config.yaml');
  if (!existsSync(configFile)) refuse(`there is no ${configFile}`);
  const { bytes: configBytes, text: configText } = readUtf8(configFile, refuse);
  const doc = YAML.parseDocument(configText);
  if (doc.errors.length) refuse(`${configFile} does not parse: ${doc.errors[0].message}`);
  const raw = doc.toJS()?.agents;
  const agents = isMap(raw) ? raw : null;

  const kept = keep === null ? [] : beingsAnswering(agents, keep);
  const answering = beingsAnswering(agents, handle).filter((name) => !kept.includes(name));
  if (answering.length > 1) {
    refuse(`${answering.length} beings in ${configFile} answer to \`${handle}\` (${answering.join(', ')}) - which one goes is a human decision, not a guess`);
  }
  const being = answering[0] ?? null;

  // The identity file is ORPHANED only when no being LEFT declares that personality. Two beings can
  // wear one identity the way 0009's ken and gauss shared one type file, and an identity still worn
  // is not this migration's to delete. That is also what keeps plan() honest after apply(): a file
  // it leaves behind is one it reported leaving behind, so the re-check still reads satisfied.
  const identityFile = join(ctx.egptHome, 'config', 'agents', 'identities', `${identity}.md`);
  const wornBy = (agents ? agentEntries(agents) : [])
    .filter(([name]) => name !== being)
    .filter(([, a]) => typeof a.personality === 'string' && a.personality.trim().toLowerCase() === identity)
    .map(([name]) => `agents.${name}`);
  const identityThere = existsSync(identityFile);

  const edits = new Map();   // file -> { bytes, text, next }
  const deletes = [];        // { file, bytes }
  const changes = [];

  if (being !== null) {
    let next;
    try { next = spliceYamlRemoveKey(configText, ['agents'], { key: being }); }
    catch (e) { refuse(`agents.${being} (the being that answers to \`${handle}\`) cannot be spliced out of ${configFile} (${e?.message ?? e})`); }
    edits.set(configFile, { bytes: configBytes, text: configText, next });
    const { first, last, lines } = removedLines(configText, next);
    const described = lines[0]?.trimStart().startsWith('#') ? ' and the comment above it' : '';
    changes.push(
      `${configFile}:${first}-${last}  remove agents.${being} - the being that answers to \`${handle}\`${described} (${lines.length} lines):`,
      ...lines.map((l) => `  - ${l}`),
    );

    // Its per-chat records. They are keyed by the BEING KEY (0010), which is why the handle lookup
    // above had to come first: on do the key is `rodz`, not `dron`.
    for (const name of REGISTRIES) {
      const file = join(ctx.egptHome, 'config', name);
      if (!existsSync(file)) continue;
      const { bytes, text } = readUtf8(file, refuse);
      const d = YAML.parseDocument(text);
      if (d.errors.length) refuse(`${file} does not parse (${d.errors[0].message}), so whether it holds a record for agents.${being} cannot be read`);
      let current = text;
      for (const { path, beings } of agentBlocks(d.toJS())) {
        if (!Object.hasOwn(beings, being)) continue;
        const at = [...path, being].join('.');
        // A chat where this being is the ONLY one recorded: removing a map's only key would leave
        // `agents:` holding null, which the splice layer refuses - that is not "the document minus
        // that key". An `agents:` block with nothing in it means the same as no `agents:` block at
        // all (src/conversations-state.mjs reads a missing one as empty), so the whole key goes.
        const alone = Object.keys(beings).length === 1;
        const container = path[path.length - 1];
        let after;
        try {
          after = alone
            ? spliceYamlRemoveKey(current, path.slice(0, -1), { key: container })
            : spliceYamlRemoveKey(current, path, { key: being });
        } catch (e) {
          refuse(`${file}: ${at} cannot be spliced out (${e?.message ?? e})`
            + (alone ? ` - it is the only being recorded there, and taking the empty \`${container}:\` with it would leave ${path.slice(0, -1).join('.')} with nothing in it; whether that whole entry goes is a human decision` : ''));
        }
        const cut = removedLines(current, after);
        changes.push(
          `${file}:${cut.first}-${cut.last}  remove ${at}${alone ? ` and the \`${container}:\` it was alone in` : ''} - threadId ${JSON.stringify(beings[being]?.threadId ?? null)} (${cut.lines.length} lines):`,
          ...cut.lines.map((l) => `  - ${l}`),
        );
        current = after;
      }
      if (current !== text) edits.set(file, { bytes, text, next: current });
    }
  }

  if (identityThere && !wornBy.length) {
    const bytes = readFileSync(identityFile);
    deletes.push({ file: identityFile, bytes });
    changes.push(`delete ${identityFile} (${bytes.length} bytes) - the identity it wore, declared by no other being here`);
  }

  const satisfied = being === null && !deletes.length;
  const aboutIdentity = !identityThere
    ? `there is no ${identityFile}`
    : `${identityFile} is still worn by ${wornBy.join(', ')} (\`personality: ${identity}\`) and is left alone`;
  const spared = kept.filter((name) => wakeTokens(name, agents[name]).includes(handle)).map((name) => `agents.${name}`);
  const aboutHandle = spared.length
    ? `nothing in ${configFile} answers to \`${handle}\` but ${spared.join(', ')}, which is the being that answers to \`${keep}\` and keeps it`
    : `no being in ${configFile} answers to \`${handle}\``;
  return {
    id, configFile, configBytes, configText, agents, being, identityFile,
    satisfied,
    notes: satisfied ? [`${aboutHandle}, and ${aboutIdentity} - nothing to evict here`] : [],
    changes, edits, deletes,
  };
}

// WRITE what evict() planned: every file re-verified byte-identical to what was planned, backed up,
// then rewritten or unlinked. Exported for 0020, which adds one more edit to the same `edits` map
// before calling this.
export async function applyEviction(ctx, { id, edits, deletes }) {
  const refuse = (why) => { throw new Error(`${id} refuses: ${why}`); };
  for (const [file, e] of edits) {
    if (!readFileSync(file).equals(e.bytes)) refuse(`${file} changed since it was planned - re-run`);
  }
  for (const { file, bytes } of deletes) {
    if (!existsSync(file) || !readFileSync(file).equals(bytes)) refuse(`${file} changed since it was planned - re-run`);
  }
  for (const [file, e] of edits) {
    ctx.log(`backup: ${ctx.backup(file)}`);
    writeFileSync(file, e.next, 'utf8');
  }
  for (const { file } of deletes) {
    ctx.log(`backup: ${ctx.backup(file)}`);
    unlinkSync(file);
  }
}

export async function plan(ctx) {
  const ev = evict(ctx, { id: ID, handle: HANDLE, identity: IDENTITY });
  if (ev.satisfied) return { satisfied: true, notes: ev.notes };
  return {
    satisfied: false,
    changes: [...ev.changes, `backup first, beside each: <file>.bak-${ID}-<timestamp>`],
    apply: async () => { await applyEviction(ctx, ev); },
  };
}
