// 0025 — everyone is in a box, and the box is the only thing holding anyone.
//
// 33c9eb5 shipped the CODE half of the doctrine. This is the CONFIGURATION half: the four lines
// that have to move in the operator's config.yaml for the code half to mean on THIS node what it
// says in the repo. Neither half is the ruling on its own — the code made `sandbox` the answer to
// silence, and these keys are what silence currently says.
//
// WHAT THE CODE HALF DID, in the order it matters here:
//
//   1. src/spine/brainpool.mjs resolveConv now defaults an undeclared `access_level` to `sandbox`
//      (it was `regular`). Silence used to mean the CLI-flag tier; it now means the OS box, which
//      resolveSandboxed's RUNG 1 then forces on above every `sandboxed:` rung beneath it.
//   2. THE CLI STOPPED BEING A FENCE for a boxed being (src/claude-args.mjs, operator: "and so
//      --permission-mode [should] be none at all. free roam inside the sandbox"): no `--add-dir`,
//      no read-only deny rules, no `--allowedTools` — `--dangerously-skip-permissions` under
//      `bypassPermissions`. The Windows account is the whole boundary, checked by the kernel on
//      every open, which is the only boundary a being holding bare Bash ever actually had.
//   3. `allowed_paths` therefore has exactly ONE consumer left — sandboxSharePathsFor, the OS
//      layer, which turns each entry into a per-LEASE ACE on the leased pool account. It is no
//      longer a list of folders a CLI flag mentions; it is a list of folders the kernel is told
//      to open up, for the length of a turn, to an account that otherwise cannot see them.
//   4. setup/provision-sandbox-account.ps1 retired the WIDE `~\src` grant on the pool group and
//      gave `~\src\egpt` its own EXPLICIT read ACE, leaving `~\src` traverse-only — so a being
//      still reads its own checkout and no longer reads everything beside it.
//
// ── A. THE BLANKET `~/src` GRANT IS RETIRED ─────────────────────────────────────────────────
// Operator, 2026-09-23: *"dismiss mounting ~/src always, that was a faux-pas."*
//
// 0015 wrote that grant when `allowed_paths` meant a `--add-dir`, and it was right then: the OS
// had already opened `~\src` to the pool and the CLI was refusing what the kernel allowed. Point
// 3 above inverts it. The same line now ASKS THE LAUNCHER to re-open the operator's whole src/ to
// every leased account on every turn — which is precisely the wide grant point 4 just took off
// the folder. Left in place it would quietly undo the provisioner on the next turn after every
// deploy, one ACE at a time, and the explicit `~\src\egpt` ACE beside it exists exactly so this
// entry does not have to.
//
// THE ENTRY IS FOUND THE WAY 0015 WROTE IT — `dirname(EGPT_HOME) + '/src'`, normalized as
// brainpool.mjs's normalizeCwd reads an allowed_paths key (msys `/c/..` → `C:/..`), never spelled
// as a path. A node whose profile lives elsewhere retires ITS OWN src/ grant; a node that never
// had one (do does not) is told so. Nothing else under `allowed_paths:` is touched: another
// folder there is another operator decision, and this one names only what 0015 put there.
//
// AND AN `allowed_paths:` LEFT WITH NOTHING IN IT GOES WITH IT. `allowed_paths:` carrying no
// entries is not a narrower grant, it is a key that reads like a grant and grants nothing — and
// src/tools/config-io.mjs's remove splice refuses to leave one behind anyway (removing a map's
// only key re-parses to `null`, not `{}`). So the whole mapping is removed instead, with the
// comment block 0015 wrote above it, which describes a rule this node no longer follows.
//
// ── B. A BEING THAT DECLARES NOTHING SAYS SO ────────────────────────────────────────────────
// Measured on kg, 2026-09-23: `carol`, `cara` and `don` state no `access_level` anywhere. Under
// point 1 they are ALREADY boxed — this writes down what already governs their turns, it does not
// change one. That is the whole of its value: a tier nobody can read off the file is a tier that
// gets explained wrongly, which is the same defect the `sandboxed: false` line in D is.
//
// A BEING THAT DECLARES ONE IS NOT TOUCHED, whichever one it declares. `egpt`/`eplus`/`ken`/`sh`
// already say `sandbox`; `codex`/`llama` say `regular` and C is what answers them; `wren` says
// `all` and is the meta engineer the default was written to spare (brainpool.mjs: "THE META
// ENGINEERS ARE UNTOUCHED BECAUSE THEY SAY SO"). Overwriting any of those would be this migration
// deciding a tier, which is the one thing it must never do.
//
// ── C. THE ONE TIER WITH NOTHING HOLDING IT IS SWITCHED OFF ─────────────────────────────────
// Operator, 2026-09-23: *"for now we can disable L, P, and C."*
//
// `regular` means NO OS box (resolveSandboxed never reaches rung 1), and after point 2 the CLI is
// not a fence for anyone. On a `regular` being the CLI layer is still built — that is why point 2
// says "for a boxed being" — but it is a layer around a being that holds bare Bash, which is the
// arrangement the boxed tier exists because nobody trusts. Until one of these beings is given a
// box, it does not take turns.
//
// `off` is the mode the gate already has (src/auto-mode.mjs): neither receive nor reply, so the
// being never sees the chat at all. 0006 wrote that same line for `djh` on do, which is why the
// spelling here is copied from it rather than invented.
//
// QUALIFIED BY HANDLE, THROUGH router.mjs's wakeTokens — the node's own definition of who answers
// to what, never a map key and never re-implemented here. `don` on do is keyed `don` today and
// that is 0018's doing; the rule that a key is not an identity outlived the rename.
//
// WHAT THIS DOES NOT DO: it does not read `pi`. The operator named L, P and C; `pi` is not in kg's
// agents map at all (it is the dj that replaces djh, and it has no block yet), so there is nothing
// here to switch off for it and inventing a block would be a guess.
//
// A CONVERSATION CAN STILL OVERRIDE IT, and that is NOTED rather than refused. src/spine/gating.mjs
// resolves a being's mode most-specific-first, so the agent default this writes is silent only
// where no conversation re-enables it. 0006 REFUSED over that; this does not, because 0006 was one
// being's ruling and a refusal here would stop every later migration on the node over a chat that
// is the operator's to change (the 0003/0007/0011/0012 lesson). The chat is named instead.
//
// ── D. A LEVEL AND A SECOND OPINION BESIDE IT, BOTH CORRECTED AT ONCE ───────────────────────
// Operator, 2026-09-23: *"don debería tener access_level: sandbox."* On do:
//
//   don:
//     conversation_defaults:
//       access_level: regular
//       sandboxed: false      # no sandbox pool provisioned on dolly yet
//
// THAT COMMENT IS FALSE. Measured on dolly today: 16 pool accounts and the `egpt-sandbox-pool`
// group, both there. The line was true when it was written and nobody came back to it — which is
// why nothing this migration writes counts anything or claims a machine's state (0021's lesson).
//
// BOTH LINES MOVE TOGETHER OR NEITHER DOES. `access_level: sandbox` forces the box (rung 1), and
// src/spine/brainpool.mjs's isSandboxContradiction reads `sandbox` + an explicit falsy
// `sandboxed:` as exactly the dead-line contradiction src/spine/boot.mjs makes FATAL for this
// tier. So writing the level alone would stop the node at boot, and removing the line alone would
// leave a `regular` being unboxed under a comment that no longer explains anything. They are
// planned as one unit and, if either splice cannot be made, NEITHER is written and the node is
// told why.
//
// AND NO `sandboxed:` LINE IS EVER WRITTEN BY THIS MIGRATION, anywhere, including in B. The level
// decides; a second opinion beside it is the contradiction the gate refuses, and a `sandboxed:
// true` under `access_level: sandbox` is merely redundant today and a lie the day the level
// changes.
//
// ── EACH PART IS INDEPENDENTLY SATISFIABLE ──────────────────────────────────────────────────
// A node carrying only some of these gets only the rest, and every part is asked as a PROPERTY of
// what is in the file — the `allowed_paths` key is there; a being states no `access_level`; a
// being answering to a named handle is `regular`; a being is `regular` and states a `sandboxed:`.
// No node name appears below. D and C can only ever pick the same being if it is `regular`, states
// a `sandboxed:` AND answers to one of C's handles; D takes it, because D is what the being IS and
// a being with a box is no longer the tier C switches off.
//
// SATISFIED, NOT REFUSED — A REFUSAL STOPS EVERY LATER MIGRATION on that node (setup/migrate.mjs).
// "Nothing to do here" is a note: no `allowed_paths:` or none naming this node's src/; no `agents:`
// mapping; a being already stating a level; a mode already `off`; a block with no column to match
// and no sibling to follow (an empty or flow mapping), where the line would have to be placed by
// guess; and a pair in D that cannot be written as a pair.
//
// IT REFUSES, NAMING THE PLACE, only on what it cannot honestly read or edit: no config.yaml; one
// that is not valid UTF-8 (a splice would re-encode bytes it never meant to touch) or does not
// parse (what this node declares cannot be read at all); an `allowed_paths:` that EXISTS but is
// not a mapping; a being block that is not a mapping; and a `sandboxed:` that is not a boolean —
// the one value D has to reason about, and the one it will not guess at.
//
// THE EDIT IS THE EXISTING SPLICE LAYER (src/tools/config-io.mjs), all three directions of it:
// insert a key as the text it will read, replace one scalar, remove one entry with its own comment
// lines. Nothing is re-serialized — a no-op `parseDocument().toString()` already rewrites these
// files — so CRLF, alignment and every other comment survive, and each splice re-parses to prove
// the edit is that one change and nothing else.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import * as YAML from 'yaml';
import { spliceYamlInsertKey, spliceYamlRemoveKey, spliceYamlScalar } from '../src/tools/config-io.mjs';
import { wakeTokens } from '../src/spine/router.mjs';

export const elevated = false;
export const summary = 'every being is in the OS box unless it says otherwise: the blanket ~/src grant goes, an undeclared being states `access_level: sandbox`, the one tier with nothing holding it is switched off, and a level and the dead `sandboxed:` line beside it are corrected together';

const ID = '0025';
// config.yaml's node-level map of folders the launcher opens to a leased account, and the one
// registry of beings.
const PATHS = 'allowed_paths';
const AGENTS = 'agents';
// The rung the two-tier walk reads (src/spine/brainpool.mjs resolveConv), and its three keys. NOT
// a flat sibling of `handles:`/`configuration:` — `conversation_defaults` IS the allowlist of
// which fields get a per-conversation override at all.
const CD = 'conversation_defaults';
const LEVEL = 'access_level';
const SANDBOXED = 'sandboxed';
const SANDBOX = 'sandbox';
const REGULAR = 'regular';
// The agent-level reply mode, where 0006 wrote it for djh, and the value that means neither
// receive nor reply (src/auto-mode.mjs).
const MODE = 'mode';
const OFF = 'off';
// THE HANDLES C ANSWERS TO — the operator's "L, P, and C", as router.mjs's wakeTokens spells a
// handle. `pi` (P) is deliberately absent: it has no block on any node yet, so there is nothing to
// switch off and a block invented for it would be a guess.
const OFF_HANDLES = ['codex', 'llama'];

const refuse = (why) => { throw new Error(`${ID} refuses: ${why}`); };
const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// JSON.stringify prints undefined as nothing and NaN/Infinity as `null`, which would name the
// wrong thing in a refusal.
const show = (v) => (v === undefined ? 'undefined' : (typeof v === 'number' && !Number.isFinite(v) ? String(v) : JSON.stringify(v)));
// config.yaml writes paths with forward slashes; node's join hands back the platform's. Compared
// in ONE dialect and normalized the way brainpool.mjs's normalizeCwd reads an allowed_paths key
// (msys `/c/..` → `C:/..`) — the SAME reading 0015 used to decide the grant was already there, so
// "already granted" and "now retired" cannot disagree over a spelling.
const normalize = (p) => {
  const s = String(p).trim().replace(/\\/g, '/');
  const m = s.match(/^\/([a-zA-Z])\/(.*)$/);
  return m ? `${m[1].toUpperCase()}:/${m[2]}` : s;
};
// A `_`-prefixed key is a comment, not a being — the same guard src/spine/router.mjs's
// addressableTokens applies before it will advertise a token.
const isBeingKey = (n) => !String(n).startsWith('_');

// The config file, read the ONE way every migration reads one: bytes first (so a splice can never
// re-encode what it did not touch), then a parse that must succeed.
function open(file) {
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) refuse(`${file} is not valid UTF-8; a splice would re-encode bytes it never meant to touch`);
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) refuse(`${file} does not parse: ${doc.errors[0].message}`);
  return { file, bytes, text, doc, data: doc.toJS() };
}

const nodeAt = (f, path) => (path.length ? f.doc.getIn(path, true) : f.doc.contents);
// The column a mapping's own keys sit at, read off the file: spliceYamlInsertKey refuses text that
// is indented for a different map, which is how an insertion silently nests one block inside its
// neighbour. Read from the ORIGINAL document for every target up front — an insertion or a removal
// elsewhere moves offsets, but never a surviving line's indent.
const columnOf = (f, path) => {
  const node = nodeAt(f, path);
  const keyAt = node.items[0].key.range[0];
  return ' '.repeat(keyAt - (f.text.lastIndexOf('\n', keyAt - 1) + 1));
};
// A map this layer can insert into at all: block style (a flow `{}` puts its entries on one line)
// and carrying at least one key (there is no column to match and no sibling to follow otherwise).
const writable = (f, path) => {
  const node = nodeAt(f, path);
  return YAML.isMap(node) && !node.flow && node.items.length > 0;
};

// ONE edit, rendered off the two texts rather than guessed: the lines that left and the lines that
// arrived, with the file and the range they sat at. Insert, replace and remove all render through
// this one function, so a `changes` list reads the same whichever direction an edit went.
function rendered(file, before, after, label) {
  const a = before.split('\n');
  const b = after.split('\n');
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const strip = (l) => l.replace(/\r$/, '');
  const gone = a.slice(s, a.length - e).map(strip);
  const came = b.slice(s, b.length - e).map(strip);
  return [
    `${file}:${s + 1}-${s + Math.max(gone.length, came.length)}  ${label}`,
    ...gone.map((l) => `  - ${l}`),
    ...came.map((l) => `  + ${l}`),
  ];
}

// ── the text, AS IT WILL READ in the operator's file ─────────────────────────────────────────
// Written by hand rather than serialized from data, for the reason the splice layer's own header
// gives: the caller owns the comment lines, the alignment and the quoting. NOTHING BELOW COUNTS
// ANYTHING or states what a machine currently has — a comment that enumerates becomes a lie the
// day the number changes, and D exists because exactly that happened.
const levelLines = (pad) => [
  `${pad}# BOXED UNLESS IT SAYS OTHERWISE (${ID}, operator 2026-09-23: "all agents sandboxed, but the`,
  `${pad}# meta engineers"). This being declared no level at all, and silence RESOLVES to this one`,
  `${pad}# (src/spine/brainpool.mjs resolveConv) - so the line states what already governs its turns`,
  `${pad}# rather than changing them. \`${SANDBOX}\` is all's capability inside a Windows logon session`,
  `${pad}# whose ACEs are the entire boundary; it FORCES the OS box on (resolveSandboxed's rung 1),`,
  `${pad}# above any \`${SANDBOXED}:\` a lower rung could state - which is why no such line is written`,
  `${pad}# beside it, and why one that IS written beside it is refused at boot.`,
  `${pad}${LEVEL}: ${SANDBOX}`,
];
const cdLines = (pad) => [
  `${pad}# THE FIELDS THIS BEING LETS A CONVERSATION OVERRIDE, and its own defaults for them - the`,
  `${pad}# nesting IS the allowlist (src/spine/brainpool.mjs resolveConv reads this rung and no`,
  `${pad}# other; a flat sibling of \`handles:\` would be read by nothing).`,
  `${pad}${CD}:`,
  ...levelLines(`${pad}  `),
];
const modeLines = (pad) => [
  `${pad}# OFF UNTIL SOMETHING HOLDS IT (${ID}, operator 2026-09-23: "for now we can disable L, P, and`,
  `${pad}# C"). A \`${REGULAR}\` being gets NO OS box - resolveSandboxed never reaches the rung that`,
  `${pad}# forces one - and since 33c9eb5 the CLI is no longer a fence for anyone: no --add-dir, no`,
  `${pad}# deny rules. So this is the one tier with nothing holding it. \`${OFF}\` is the mode the gate`,
  `${pad}# already has (src/auto-mode.mjs): it neither receives nor replies, so the being never sees`,
  `${pad}# the chat. Give it a box - \`${CD}.${LEVEL}: ${SANDBOX}\` - to switch it back on.`,
  `${pad}${MODE}: ${OFF}`,
];

// Every place a conversation sets one of these beings' mode to something other than `off` —
// src/spine/gating.mjs resolves that tier BEFORE the agent default, so an override is the one
// thing that would leave a being this migration switched off still answering somewhere. A walk,
// not a fixed path, so neither of the two per-conversation shapes can slip past (0006's reading).
// NOTED, never refused: the chat is the operator's to change and the chain must not stop over it.
function modeOverrides(file, names) {
  if (!names.length || !existsSync(file)) return [];
  let data;
  try { data = YAML.parse(readFileSync(file, 'utf8')); }
  catch (e) { return [`${file} could not be read (${e?.message ?? e}), so whether a conversation re-enables one of these beings is unknown here`]; }
  const found = [];
  const walk = (node, path) => {
    if (!isMap(node)) return;
    for (const [k, v] of Object.entries(node)) {
      if (names.includes(k) && isMap(v) && Object.hasOwn(v, MODE) && v[MODE] !== OFF) {
        found.push(`${file} overrides it at ${[...path, k].join('.')}.${MODE} = ${show(v[MODE])}, so it still answers there until that line goes - the per-conversation tier is resolved first (src/spine/gating.mjs)`);
      }
      walk(v, [...path, k]);
    }
  };
  walk(data, []);
  return found;
}

export async function plan(ctx) {
  const file = join(ctx.egptHome, 'config', 'config.yaml');
  if (!existsSync(file)) refuse(`there is no ${file}`);
  const f = open(file);

  let text = f.text;
  const changes = [];
  const notes = [];

  // ONE UNIT OF CHANGE, applied onto the running text. A unit of several edits is all-or-nothing:
  // D's two lines are one correction, and half of it is a node that does not boot.
  const write = (edits) => {
    const start = text;
    const staged = [];
    let t = start;
    for (const e of edits) {
      let next;
      try { next = e.fn(t); }
      catch (err) { return { ok: false, why: err?.message ?? String(err), label: e.label }; }
      staged.push({ before: t, after: next, label: e.label });
      t = next;
    }
    text = t;
    for (const s of staged) changes.push(...rendered(file, s.before, s.after, s.label));
    return { ok: true };
  };

  // ── A. the blanket grant 0015 wrote, retired the way 0015 wrote it ──────────────────────────
  const srcDir = normalize(join(dirname(ctx.egptHome), 'src'));
  const paths = isMap(f.data) ? f.data[PATHS] : undefined;
  if (paths !== undefined && !isMap(paths)) {
    refuse(`\`${PATHS}:\` in ${file} is ${show(paths)}, not a mapping of paths - this migration will not guess what a hand edit there meant`);
  }
  const grantedAs = paths ? Object.keys(paths).find((k) => normalize(k) === srcDir) : undefined;
  if (paths === undefined) {
    notes.push(`${file} states no \`${PATHS}:\` at all, so there is no blanket grant here to retire`);
  } else if (grantedAs === undefined) {
    notes.push(`${file} does not grant ${srcDir} node-wide, so there is no blanket grant here to retire - the ${Object.keys(paths).length === 1 ? 'entry' : 'entries'} it does state ${Object.keys(paths).length === 1 ? 'is' : 'are'} not this migration's to touch`);
  } else {
    // An `allowed_paths:` whose only entry is this one goes WHOLE: a mapping with nothing in it
    // reads like a grant and grants nothing, and the remove splice refuses to leave one behind
    // anyway (removing a map's only key re-parses to `null`, not `{}`).
    const alone = Object.keys(paths).length === 1;
    const r = write([alone
      ? { label: `remove the node's whole \`${PATHS}:\` mapping - ${srcDir} was its only entry, and an empty one would read like a grant and grant nothing`, fn: (t) => spliceYamlRemoveKey(t, [], { key: PATHS }) }
      : { label: `remove \`${PATHS}.${grantedAs}\` - the rest of the map is left exactly as it is`, fn: (t) => spliceYamlRemoveKey(t, [PATHS], { key: grantedAs }) }]);
    if (!r.ok) notes.push(`\`${PATHS}.${grantedAs}\` in ${file} cannot be taken out as it is written (${r.why}) - not retired here`);
  }

  // ── the node's beings, read once, in document order ─────────────────────────────────────────
  const agents = isMap(f.data) ? f.data[AGENTS] : undefined;
  const beings = isMap(agents) ? Object.entries(agents).filter(([n]) => isBeingKey(n)) : [];
  if (!isMap(agents)) {
    notes.push(`${file} has no \`${AGENTS}:\` mapping, so there is no being here to box, to switch off or to correct`);
  }
  // A being block that is not a mapping is not a hand edit this may write around: every part below
  // reads a key OUT of that block, and reading one out of a scalar would silently skip the being.
  for (const [name, a] of beings) {
    if (!isMap(a)) refuse(`${AGENTS}.${name} in ${file} is ${show(a)}, not a being block - this migration reads a level out of every being here and will not guess what a hand edit there meant`);
  }

  const levelOf = (a) => (isMap(a[CD]) ? a[CD][LEVEL] : undefined);
  // D's beings, decided BEFORE anything is written: `regular` and carrying a second opinion about
  // the box. A being D moves to `sandbox` is no longer the tier C switches off, so it is D's.
  const corrected = new Set(beings.filter(([, a]) => levelOf(a) === REGULAR && isMap(a[CD]) && Object.hasOwn(a[CD], SANDBOXED)).map(([n]) => n));
  const switchedOff = [];

  for (const [name, a] of beings) {
    const at = `${AGENTS}.${name}`;
    const cd = a[CD];
    const level = levelOf(a);
    const answers = wakeTokens(name, a).filter((h) => OFF_HANDLES.includes(h));

    // ── D. the level and the dead line beside it, as ONE correction ───────────────────────────
    if (corrected.has(name)) {
      const stated = cd[SANDBOXED];
      if (typeof stated !== 'boolean') {
        refuse(`\`${SANDBOXED}:\` at ${at}.${CD} in ${file} is ${show(stated)}, not a boolean - whether this being asked for the OS box cannot be read, and \`${LEVEL}: ${SANDBOX}\` written beside an unreadable one is what src/spine/boot.mjs refuses at boot`);
      }
      const r = write([
        { label: `\`${at}.${CD}.${LEVEL}\`: ${REGULAR} -> ${SANDBOX}, which FORCES the OS box on (resolveSandboxed rung 1)`, fn: (t) => spliceYamlScalar(t, [AGENTS, name, CD, LEVEL], { expect: REGULAR, to: SANDBOX }) },
        { label: `remove the now-dead \`${SANDBOXED}: ${stated}\` at ${at}.${CD} - under \`${SANDBOX}\` it is unreachable, and src/spine/boot.mjs makes it FATAL rather than let it read like an override`, fn: (t) => spliceYamlRemoveKey(t, [AGENTS, name, CD], { key: SANDBOXED }) },
      ]);
      if (!r.ok) {
        notes.push(`${at}.${CD} in ${file} cannot take both lines of this correction as it is written (${r.why}) - \`${LEVEL}: ${SANDBOX}\` beside a \`${SANDBOXED}: ${stated}\` is the contradiction src/spine/boot.mjs refuses at boot, so NEITHER line is written here`);
      }
      if (answers.length) {
        notes.push(`${at} also answers to [ ${answers.join(', ')} ] - it is given a box above rather than switched off, because the tier with nothing holding it is what \`${MODE}: ${OFF}\` is for and this being no longer is one`);
      }
      continue;
    }

    // ── C. the one tier with nothing holding it ───────────────────────────────────────────────
    if (level === REGULAR) {
      if (!answers.length) {
        notes.push(`${at} in ${file} states \`${LEVEL}: ${REGULAR}\` and answers to none of [ ${OFF_HANDLES.join(', ')} ] - which beings run unheld is the operator's call and this names only the ones it was given`);
        continue;
      }
      const mode = a[MODE];
      if (mode === OFF) {
        notes.push(`${at}.${MODE} in ${file} is already \`${OFF}\`, so this being already takes no turns`);
        switchedOff.push(name);
        continue;
      }
      if (Object.hasOwn(a, MODE) && typeof mode !== 'string') {
        notes.push(`${at}.${MODE} in ${file} is ${show(mode)}, not a mode name - left alone rather than overwritten`);
        continue;
      }
      let r;
      if (Object.hasOwn(a, MODE)) {
        // A mode is already stated: ONE scalar, so the line's own trailing comment and every byte
        // around it stay exactly where they are.
        r = write([{ label: `\`${at}.${MODE}\`: ${mode} -> ${OFF}, because a \`${REGULAR}\` being has no OS box and the CLI is no longer a fence`, fn: (t) => spliceYamlScalar(t, [AGENTS, name, MODE], { expect: mode, to: OFF }) }]);
      } else if (!writable(f, [AGENTS, name])) {
        r = { ok: false, why: 'it is an empty or flow mapping - there is no column to match and no sibling to follow' };
      } else {
        r = write([{ label: `insert \`${MODE}: ${OFF}\` at ${at}`, fn: (t) => spliceYamlInsertKey(t, [AGENTS, name], { key: MODE, text: modeLines(columnOf(f, [AGENTS, name])).join('\n') }) }]);
      }
      if (r.ok) switchedOff.push(name);
      else notes.push(`\`${MODE}: ${OFF}\` cannot be written at ${at} in ${file} (${r.why}) - not switched off here`);
      continue;
    }

    // ── B. a being that declares nothing says so ──────────────────────────────────────────────
    if (level !== undefined) {
      notes.push(`${at} in ${file} already states \`${LEVEL}: ${show(level)}\`, which is a tier its operator chose - left exactly as it is`);
      continue;
    }
    if (cd !== undefined && !isMap(cd)) {
      notes.push(`${at}.${CD} in ${file} is ${show(cd)}, not a mapping - no level can be written into it, and the being still resolves to \`${SANDBOX}\` by default; only the file does not say so`);
      continue;
    }
    const path = cd === undefined ? [AGENTS, name] : [AGENTS, name, CD];
    if (!writable(f, path)) {
      notes.push(`${cd === undefined ? at : `${at}.${CD}`} in ${file} is an empty or flow mapping - there is no column to match and no sibling to follow, so where an \`${LEVEL}:\` line belongs would be a guess; the being still resolves to \`${SANDBOX}\` by default`);
      continue;
    }
    const r = cd === undefined
      ? write([{ label: `insert \`${CD}.${LEVEL}: ${SANDBOX}\` at ${at} - the tier it already resolves to, written down`, fn: (t) => spliceYamlInsertKey(t, path, { key: CD, text: cdLines(columnOf(f, path)).join('\n') }) }])
      : write([{ label: `insert \`${LEVEL}: ${SANDBOX}\` at ${at}.${CD} - the tier it already resolves to, written down`, fn: (t) => spliceYamlInsertKey(t, path, { key: LEVEL, text: levelLines(columnOf(f, path)).join('\n') }) }]);
    if (!r.ok) notes.push(`\`${LEVEL}: ${SANDBOX}\` cannot be written at ${at} in ${file} (${r.why}) - not stated here; the being still resolves to \`${SANDBOX}\` by default`);
  }

  // A being switched off at the agent default still answers wherever a conversation says so.
  notes.push(...modeOverrides(join(ctx.egptHome, 'config', 'conversations.yaml'), switchedOff));

  if (!changes.length) return { satisfied: true, notes };

  changes.push(...notes, `backup first, beside it: config.yaml.bak-${ID}-<timestamp>`);
  return {
    satisfied: false,
    changes,
    apply: async () => {
      if (!readFileSync(file).equals(f.bytes)) refuse(`${file} changed since it was planned - re-run`);
      ctx.log(`backup: ${ctx.backup(file)}`);
      writeFileSync(file, text, 'utf8');
    },
  };
}
