// 0014 — a meta engineer wakes where the operator's own session does.
//
// Operator, 2026-09-20: "wren, as a meta engineer, should wake in your same folder; he manages
// everything, and it also enabled an easy thread inheritance."
//
// "Your same folder" is the ORCHESTRATOR SESSION'S cwd, C:/Users/an. Measured that day: the
// operator's own session files its transcript under ~/.claude/projects/C--Users-an/, while wren's
// threads sit in ~/.claude/projects/C--Users-an-bin-egpt/, because config/agents/wren.yaml pins
// `cwd: C:/Users/an/bin/egpt`. The CLI derives that project folder FROM THE CWD (the same mapping
// src/conversations-state.mjs reverses), so two beings in different cwds can never resume each
// other's thread. Same cwd, same folder, and a thread id can simply be handed over. Nothing is
// migrated to make that true: the operator ruled "egpt wren's thread can be lost; we keep this
// one", so wren wakes fresh in the new folder and no .jsonl is copied or moved.
//
// THE PROPERTY, ASKED OF THE NODE, not "edit wren": A META ENGINEER WAKES WHERE THE OPERATOR'S OWN
// SESSION DOES. A meta engineer is a being whose `conversation_defaults.access_level` is `all` —
// the unsandboxed being that runs AS the operator because its job is to change the machine. Where
// the operator's own session wakes is `dirname(EGPT_HOME)`: the profile is ~/.egpt, so its parent
// IS the home. Never a hardcoded C:/Users/an — a node with its profile elsewhere gets ITS home.
//
// On kg that being is `agents.wren`, and the line it moves is the whole edit:
//   cwd: C:/Users/an/bin/egpt # wren's job is the system, so it runs in the deployed tree
// The value AND the comment change: the comment documented the OLD placement, and a comment that
// lies is worse than none (0012). On do there is no such being, so do reads SATISFIED.
//
// THE SECOND HALF, and it is not optional. At bin/egpt wren picked the repo's CLAUDE.md up for
// free, because the CLI reads the rules file of the tree it wakes in. At C:/Users/an there is
// none (verified 2026-09-20: no ~/CLAUDE.md; ~/.claude/CLAUDE.md is the OPERATOR'S instructions,
// not the repo's), so moving wren home would silently drop the engineering rules it works by.
// They are put back where a being's kickoff is already composed — its IDENTITY file,
// config/agents/identities/<personality>.md, the one layer that is per-being (the shared layers in
// config/skeletons/room/ feed EVERY being and are the wrong place for one being's repo rules). One
// appended line NAMES ~/src/egpt/CLAUDE.md as the rules it works by, and is appended only when no
// line already names that file. BOTH EDITS LAND IN ONE apply, OR NEITHER DOES: every file is
// checked for a change-since-planned first, then each is backed up and written.
//
// SATISFIED, NOT REFUSED — a refusal STOPS THE WHOLE CHAIN (setup/migrate.mjs), so this refuses
// only about a node it actually applies to (the 0003/0007/0011 lesson): no `agents:` mapping; no
// being with `access_level: all`; no such being names a TYPE FILE (an inline `configuration:` has
// none, and the cwd this moves is a type file's); the type file is missing; it pins no `cwd:`; the
// `cwd` is already the home.
//
// IT REFUSES, NAMING THE PLACE, only on what it cannot honestly edit: a type file that does not
// parse; a `cwd` that is present but is not a string; more than one meta engineer whose pinned
// `cwd`s DISAGREE (a node with two of them pointing different ways is a human decision, not a
// guess — where they agree there is nothing to decide, and both move); and an identity file that
// is not there, because moving the being home without it is exactly the silent rule loss above.
//
// THE EDIT is a byte splice (src/tools/config-io.mjs spliceYamlScalar, with the `comment` 0012
// added) for the type file, and a plain append for the identity file — CRLF, alignment and every
// other byte are kept, and the config edit is verified to be ONE line and no other.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import * as YAML from 'yaml';
import { spliceYamlScalar } from '../src/tools/config-io.mjs';

export const elevated = false;
export const summary = "a meta engineer wakes in the operator's own folder, and its identity names the repo rules it works by";

// The being this is about: the unsandboxed one, `conversation_defaults.access_level: all`.
const ACCESS = 'all';
// What the moved line documents itself with: BOTH reasons the operator gave.
const COMMENT = 'a meta engineer manages the whole box, and only a being in this cwd can inherit a thread from the operator\'s own session (0014, operator 2026-09-20: "should wake in your same folder")';
// The repo's rules, under the operator's home — the checkout, not the deployed tree.
const RULES = ['src', 'egpt', 'CLAUDE.md'];
const rulesLine = (rules) => `I wake in the operator's own folder, not in the eGPT checkout, so the repo's rules do not load themselves: the engineering rules I work by are ${rules}, and I read that file before I change the system.`;

const refuse = (why) => { throw new Error(`0014 refuses: ${why}`); };
const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// These files write paths with forward slashes; node's dirname/join hand back the platform's.
// Compared and written in ONE dialect so "already home" cannot be missed over a separator.
const slash = (p) => String(p).replace(/\\/g, '/');

function readUtf8(file) {
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) refuse(`${file} is not valid UTF-8; an edit would re-encode bytes it never meant to touch`);
  return { bytes, text };
}

// Which identity file a being's kickoff is built from: the ladder src/spine/brainpool.mjs's
// `personalityFor` defines — the agent's OWN `personality:` outranks the type file's pin (operator
// 2026-09-10), and neither means `egpt`. Read here rather than imported because that helper is
// module-private to brainpool.mjs.
const personalityOf = (agent, def) => agent?.personality ?? def?.personality ?? 'egpt';

export async function plan(ctx) {
  const home = slash(dirname(ctx.egptHome));
  const rules = slash(join(dirname(ctx.egptHome), ...RULES));
  const LINE = rulesLine(rules);

  const configFile = join(ctx.egptHome, 'config', 'config.yaml');
  if (!existsSync(configFile)) refuse(`there is no ${configFile}`);
  const cfgDoc = YAML.parseDocument(readUtf8(configFile).text);
  if (cfgDoc.errors.length) refuse(`${configFile} does not parse: ${cfgDoc.errors[0].message}`);
  const agents = cfgDoc.toJS()?.agents;
  if (!isMap(agents)) return { satisfied: true, notes: [`${configFile} has no \`agents:\` mapping, so this node has no meta engineer`] };

  const engineers = Object.entries(agents)
    .filter(([name, a]) => isMap(a) && !name.startsWith('_') && a.conversation_defaults?.access_level === ACCESS)
    .map(([name]) => name);
  if (!engineers.length) {
    return { satisfied: true, notes: [`no being in ${configFile} has \`conversation_defaults.access_level: ${ACCESS}\`, so this node has no meta engineer`] };
  }

  // Each meta engineer's type file, read (never guessed from the name) for the `cwd:` it pins.
  // Keyed by PATH so two beings sharing one type file are one edit, not two.
  const pinned = new Map();   // typeFile -> { bytes, text, doc, def, cwd, beings: [] }
  const looked = [];
  for (const being of engineers) {
    const configuration = agents[being].configuration;
    if (typeof configuration !== 'string') { looked.push(`agents.${being} names no type file (\`configuration:\` is ${isMap(configuration) ? 'an inline map' : JSON.stringify(configuration ?? null)})`); continue; }
    const typeFile = join(ctx.egptHome, 'config', 'agents', `${configuration}.yaml`);
    if (!existsSync(typeFile)) { looked.push(`agents.${being} names ${configuration}, and there is no ${typeFile}`); continue; }

    let entry = pinned.get(typeFile);
    if (!entry) {
      const { bytes, text } = readUtf8(typeFile);
      const doc = YAML.parseDocument(text);
      if (doc.errors.length) refuse(`${typeFile} does not parse: ${doc.errors[0].message}`);
      const def = doc.toJS();
      if (!isMap(def)) refuse(`${typeFile} does not parse to a mapping, so it says no \`cwd\``);
      if (!Object.hasOwn(def, 'cwd')) { looked.push(`agents.${being} runs ${configuration}, and ${typeFile} pins no \`cwd\``); continue; }
      if (typeof def.cwd !== 'string') refuse(`\`cwd\` in ${typeFile} is ${JSON.stringify(def.cwd)}, not a directory`);
      entry = { bytes, text, doc, def, cwd: def.cwd, beings: [] };
      pinned.set(typeFile, entry);
    }
    entry.beings.push(being);
  }

  if (!pinned.size) {
    return { satisfied: true, notes: [`this node's meta engineer${engineers.length > 1 ? 's' : ''} (${engineers.join(', ')}) pin${engineers.length > 1 ? '' : 's'} no \`cwd\`, so nothing here decides where it wakes: ${looked.join('; ')}`] };
  }

  const entries = [...pinned.entries()];
  const distinct = [...new Set(entries.map(([, e]) => slash(e.cwd)))];
  if (distinct.length > 1) {
    const where = entries.map(([f, e]) => `${e.beings.join('/')} -> ${f} pins ${JSON.stringify(e.cwd)}`).join('; ');
    refuse(`this node has more than one meta engineer and they disagree about where they wake (${where}) - which one is the operator's own folder is a human decision, not a guess`);
  }
  if (distinct[0] === home) {
    return { satisfied: true, notes: [`${entries.map(([f]) => f).join(', ')} already pin${entries.length > 1 ? '' : 's'} \`cwd: ${home}\` - this node's meta engineer already wakes where the operator's own session does`] };
  }

  // ── the two edits, both planned before either is written ──────────────────────────────────
  const write = new Map();    // file -> { bytes, next }
  const changes = [];

  for (const [typeFile, e] of entries) {
    // Read off the ORIGINAL text: does the `cwd` line carry a trailing comment to rewrite? A line
    // with none keeps none - spliceYamlScalar rewrites a comment, it does not invent one (0012).
    const valueEnd = e.doc.getIn(['cwd'], true).range[1];
    const eol = e.text.indexOf('\n', valueEnd);
    const documented = /^[ \t]*#/.test(e.text.slice(valueEnd, eol === -1 ? e.text.length : eol));
    const next = spliceYamlScalar(e.text, ['cwd'], { expect: e.cwd, to: home, ...(documented ? { comment: COMMENT } : {}) });

    // The splice already proved the edit re-parses to this document with only that scalar changed.
    // The comment is not part of that parse, so the BYTES are checked too: one line, and no other.
    const a = e.text.split('\n');
    const b = next.split('\n');
    const at = a.length === b.length ? a.flatMap((l, i) => (l === b[i] ? [] : [i])) : null;
    if (at === null || at.length !== 1) refuse(`the edit would change ${at === null ? 'the line count' : `${at.length} lines`} of ${typeFile}, not one line`);
    write.set(typeFile, { bytes: e.bytes, next });
    changes.push(`${typeFile}:${at[0] + 1}`, `  - ${a[at[0]].replace(/\r$/, '')}`, `  + ${b[at[0]].replace(/\r$/, '')}`);
    changes.push(`${e.beings.join(', ')} wake${e.beings.length > 1 ? '' : 's'} at ${home} - the operator's own session folder, the parent of ${ctx.egptHome} - instead of ${e.cwd}`);
  }

  // The rules the move would otherwise drop, named in each moved being's own identity. Appended
  // only where no line names that file already, so a re-run adds nothing. Two beings wearing one
  // identity are one append, not two.
  const seen = new Set();
  for (const [typeFile, e] of entries) {
    for (const being of e.beings) {
      const personality = personalityOf(agents[being], e.def);
      const identityFile = join(ctx.egptHome, 'config', 'agents', 'identities', `${personality}.md`);
      if (!existsSync(identityFile)) {
        refuse(`agents.${being} wears the identity ${personality}, and there is no ${identityFile} - moving it out of the checkout without naming ${rules} there would silently drop the rules it engineers by`);
      }
      if (seen.has(identityFile)) continue;
      seen.add(identityFile);
      const { bytes, text } = readUtf8(identityFile);
      if (slash(text).includes(rules)) {
        changes.push(`${identityFile} already names ${rules} - left alone`);
        continue;
      }
      // Appended as the file's own line endings, after a blank line, with nothing already there
      // rewritten - an unterminated last line is ended first, and nothing else moves.
      const nl = text.includes('\r\n') ? '\r\n' : '\n';
      const lead = text.length === 0 ? '' : (text.endsWith('\n') ? nl : `${nl}${nl}`);
      const next = `${text}${lead}${LINE}${nl}`;
      write.set(identityFile, { bytes, next });
      changes.push(`${identityFile}:${next.split('\n').length - 1}  append the rules ${typeFile} no longer wakes inside:`, `  + ${LINE}`);
    }
  }

  changes.push('backup first, beside each: <file>.bak-0014-<timestamp>');

  return {
    satisfied: false,
    changes,
    apply: async () => {
      // Both edits, or neither: every file is checked before any of them is written.
      for (const [file, { bytes }] of write) {
        if (!readFileSync(file).equals(bytes)) refuse(`${file} changed since it was planned - re-run`);
      }
      for (const [file, { next }] of write) {
        ctx.log(`backup: ${ctx.backup(file)}`);
        writeFileSync(file, next, 'utf8');
      }
    },
  };
}
