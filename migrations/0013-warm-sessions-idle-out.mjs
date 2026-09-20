// 0013 — a warm session that has not been used for 12 hours is evicted.
//
// Operator, 2026-09-20: "let them idle out, 12h". kg was carrying 13 live claude.exe processes,
// one per warm session, because nothing ever idled out: every class under
// `warm.idle_ttl_by_class` in its config.yaml reads `-1`, so src/warm-sessions.mjs's `_armIdle`
// returns without arming a timer (`ttl < 0` = never) and `idle_ttl_ms` — the fallback for an
// UNLISTED class — never gets a say. A session left only when the pool hit `max`, or when the
// spine restarted.
//
// Evicting one is cheap: the thread id lives in the conversation record, so the next turn resumes
// the same session, just colder; and a sandboxed being may lease a different pool account next
// time (same ruling: "i see no reason why not jump between sandboxed accounts").
//
// THE PROPERTY, ASKED OF THE NODE, not "edit kg": no class is kept warm forever. Every class whose
// TTL is NEVER becomes 43200000 (12h). NEVER is read the way the pool reads it — `_armIdle`'s
// `ttl < 0`, ANY negative — not only the `-1` the dialect spells it with, because a `-2` keeps the
// session forever just the same and calling that node satisfied would be a lie. A class carrying a
// finite value is LEFT ALONE, `0` (always evict) included: someone chose it.
//
// SATISFIED, NOT REFUSED — a refusal STOPS THE WHOLE CHAIN (setup/migrate.mjs), so this refuses
// only about a node it actually applies to (the 0003/0007/0011 lesson): no `warm:` block, no
// `idle_ttl_by_class`, and no class kept warm forever all read satisfied, with a note.
//
// IT REFUSES, NAMING THE PLACE, only on what it cannot honestly edit: `idle_ttl_by_class` present
// but not a mapping, or a class holding something that is not a number of milliseconds.
//
// THE COMMENTS STAY HONEST. The block's own `# -1 = never idle-evict` is a LEGEND — it explains the
// dialect, it is still true after the edit, and it is left alone. A comment on a VALUE line that
// says "never" describes THAT line and would be a lie the moment the value idles out, so it is
// rewritten (spliceYamlScalar's `comment`, added by 0012). Every splice is chained onto the last,
// and the file is written ONCE, after a backup and a changed-since-planned guard.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { spliceYamlScalar } from '../src/tools/config-io.mjs';

export const elevated = false;
export const summary = 'a warm session that has not been used for 12 hours is evicted';

const TTL = 43_200_000;   // 12h
const KEY = 'idle_ttl_by_class';
// What a rewritten VALUE-line comment says: the new number in human units, and the ruling.
const COMMENT = '12h (0013, operator 2026-09-20: "let them idle out, 12h")';

const refuse = (why) => { throw new Error(`0013 refuses: ${why}`); };
const isMapping = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// JSON.stringify prints NaN and Infinity as `null`, which would name the wrong thing in a refusal.
const show = (v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : JSON.stringify(v));

export async function plan(ctx) {
  const file = join(ctx.egptHome, 'config', 'config.yaml');
  if (!existsSync(file)) refuse(`there is no ${file}`);
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) refuse(`${file} is not valid UTF-8; a splice would re-encode bytes it never meant to touch`);

  const doc = YAML.parseDocument(text);
  if (doc.errors.length) refuse(`${file} does not parse: ${doc.errors[0].message}`);

  const warm = doc.toJS()?.warm;
  if (!isMapping(warm)) return { satisfied: true, notes: [`${file} has no \`warm:\` block, so there is no per-class idle TTL here to change`] };
  if (!Object.hasOwn(warm, KEY)) return { satisfied: true, notes: [`warm: in ${file} has no \`${KEY}\`, so there is no per-class idle TTL here to change`] };

  const byClass = warm[KEY];
  if (!isMapping(byClass)) refuse(`warm.${KEY} in ${file} is ${show(byClass)}, not a mapping of class to milliseconds`);
  const entries = Object.entries(byClass);
  for (const [cls, v] of entries) {
    if (typeof v !== 'number' || !Number.isFinite(v)) refuse(`warm.${KEY}.${cls} in ${file} is ${show(v)}, not a number of milliseconds`);
  }

  const forever = entries.filter(([, v]) => v < 0).map(([cls]) => cls);
  if (!forever.length) {
    const held = entries.length ? entries.map(([c, v]) => `${c}=${v}`).join(', ') : 'no class listed';
    return { satisfied: true, notes: [`no class under warm.${KEY} in ${file} is kept warm forever (${held}) - every warm session already idles out`] };
  }

  // Read off the ORIGINAL text, before any splice moves the ranges: does this class's own line
  // carry a trailing comment, and does that comment say "never"?
  const saysNever = (cls) => {
    const end = doc.getIn(['warm', KEY, cls], true).range[1];
    const nl = text.indexOf('\n', end);
    const trailing = text.slice(end, nl === -1 ? text.length : nl);
    return /^[ \t]*#/.test(trailing) && /never/i.test(trailing);
  };

  let next = text;
  for (const cls of forever) {
    next = spliceYamlScalar(next, ['warm', KEY, cls], {
      expect: byClass[cls], to: TTL, ...(saysNever(cls) ? { comment: COMMENT } : {}),
    });
  }

  // The splices already proved the edit re-parses to this document with only those scalars changed.
  // Comments are not part of that parse, so the BYTES are checked too. One line per class, unless a
  // flow mapping puts several on the same line - never more, and never a line added or removed.
  const a = text.split('\n');
  const b = next.split('\n');
  if (a.length !== b.length) refuse(`the edit would change the line count of ${file}`);
  const at = a.flatMap((l, i) => (l === b[i] ? [] : [i]));
  if (!at.length || at.length > forever.length) refuse(`the edit would change ${at.length} lines of ${file}, not the ${forever.length} it planned`);

  return {
    satisfied: false,
    changes: [
      ...at.flatMap((i) => [`${file}:${i + 1}`, `  - ${a[i].replace(/\r$/, '')}`, `  + ${b[i].replace(/\r$/, '')}`]),
      `warm.${KEY}: ${forever.join(', ')} never idle-evict; each becomes ${TTL} ms (12h)`,
      'backup first, beside it: config.yaml.bak-0013-<timestamp>',
    ],
    apply: async () => {
      if (!readFileSync(file).equals(bytes)) refuse(`${file} changed since it was planned - re-run`);
      ctx.log(`backup: ${ctx.backup(file)}`);
      writeFileSync(file, next, 'utf8');
    },
  };
}
