// 0049 — config.yaml: top-level `beeper:` → `limbs.beeper` (operator 2026-10-23, limbs phase A).
//
// The block's lines (comments above and inside it: the lines yamlKeyLines cuts) move verbatim under
// `limbs:`, indented. An existing `limbs:` keeps its lines and takes the block after them (reve);
// with none, `limbs:` is written where `beeper:` stood (dolly). Every other byte stays, except a
// blank line the cut would leave doubled.
//
// Refuses, changing nothing: `beeper:` beside `limbs.beeper`; either key not a plain block mapping;
// config.yaml absent, not UTF-8 or not parsing; a result that does not re-parse to the move alone or
// drops a non-blank line; a file changed since it was planned (the operator edits it in parallel).
// No spine stop: both keys are restart-only, the running spine reads either form (beeperBlockOf),
// and upgrade.ps1 restarts once anything applied. Backups: <profile>/disposable/migration-0049-<ts>/.
// Output names keys and line numbers, never values.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as YAML from 'yaml';
import { yamlKeyLines } from '../src/tools/config-io.mjs';

export const elevated = false;
export const summary = 'the Beeper block lives under limbs: top-level beeper: → limbs.beeper, verbatim, comments included';

const ID = '0049';
const refuse = (why) => { throw new Error(`${ID} refuses: ${why}`); };
const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const eolAt = (text, i) => { const n = text.indexOf('\n', i); return n > 0 && text[n - 1] === '\r' ? '\r\n' : '\n'; };
const lineNo = (text, i) => text.slice(0, i).split('\n').length;
const colOf = (text, i) => i - (text.lastIndexOf('\n', i - 1) + 1);
const isBlankAt = (text, i) => /^[ \t]*\r?\n/.test(text.slice(i));
const nonBlank = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean).sort();

export async function plan(ctx) {
  const file = join(ctx.egptHome, 'config', 'config.yaml');
  if (!existsSync(file)) refuse(`there is no ${file}`);
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) refuse(`${file} is not valid UTF-8; an edit would re-encode bytes it never meant to touch`);
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) refuse(`${file} does not parse: ${doc.errors[0].message}`);
  const data = doc.toJS();
  if (!isMap(data)) refuse(`${file} is not a mapping at its root`);
  if (!Object.hasOwn(data, 'beeper')) return { satisfied: true, notes: ['no top-level `beeper:` left in config.yaml'] };

  const pairOf = (key) => doc.contents.items.find((p) => YAML.isScalar(p.key) && p.key.value === key);
  const blockMap = (key) => { const v = pairOf(key).value; return YAML.isMap(v) && !v.flow; };
  const plainKey = (span, key) => text.slice(span.keyAt, span.keyAt + key.length + 1) === `${key}:`;
  if (!blockMap('beeper')) refuse('`beeper:` is not a block mapping - left for a human');
  const hasLimbs = Object.hasOwn(data, 'limbs');
  if (hasLimbs && isMap(data.limbs) && Object.hasOwn(data.limbs, 'beeper')) refuse('config.yaml states a top-level `beeper:` AND `limbs.beeper` - merging them is a human decision');

  const b = yamlKeyLines(text, [], { key: 'beeper' });
  if (!plainKey(b, 'beeper')) refuse('`beeper:` is not written as a plain key - left for a human');
  const nl = eolAt(text, b.keyAt);
  const indent = (chunk, n) => { const c = chunk.endsWith('\n') ? chunk : chunk + nl; return c.replace(/^(?=[^\r\n])/gm, ' '.repeat(n)); };

  let next;
  let where;
  if (!hasLimbs) {
    next = text.slice(0, b.start) + `limbs:${nl}` + indent(text.slice(b.start, b.end), 2) + text.slice(b.end);
    where = `\`limbs:\` written where \`beeper:\` stood (line ${lineNo(text, b.start)})`;
  } else {
    const l = yamlKeyLines(text, [], { key: 'limbs' });
    if (!plainKey(l, 'limbs')) refuse('`limbs:` is not written as a plain key - left for a human');
    const keyLineEnd = text.indexOf('\n', l.keyAt);
    const empty = data.limbs == null && /^[ \t]*(#.*)?\r?$/.test(text.slice(l.keyAt + 'limbs:'.length, keyLineEnd === -1 ? text.length : keyLineEnd));
    if (!empty && !blockMap('limbs')) refuse('`limbs:` is neither an empty key nor a block mapping - left for a human');
    const col = empty ? 2 : colOf(text, pairOf('limbs').value.items[0].key.range[0]);
    // The cut, plus the blank line after it when one already stands before it.
    const cutEnd = isBlankAt(text, b.end) && (b.start === 0 || isBlankAt(text, text.lastIndexOf('\n', b.start - 2) + 1)) ? text.indexOf('\n', b.end) + 1 : b.end;
    const lead = l.end > 0 && text[l.end - 1] !== '\n' ? nl : '';
    const moved = lead + indent(text.slice(b.start, b.end), col);
    next = l.end <= b.start
      ? text.slice(0, l.end) + moved + text.slice(l.end, b.start) + text.slice(cutEnd)
      : text.slice(0, b.start) + text.slice(cutEnd, l.end) + moved + text.slice(l.end);
    const kept = text.slice(l.start, l.end).split('\n').filter((x) => x.trim().startsWith('#')).length;
    where = `under the existing \`limbs:\` (line ${lineNo(text, l.keyAt)}), after its own lines${kept ? ` (${kept} comment line(s) kept)` : ''}`;
  }

  const expected = doc.toJS();
  expected.limbs = { ...(isMap(expected.limbs) ? expected.limbs : {}), beeper: expected.beeper };
  delete expected.beeper;
  const check = YAML.parseDocument(next);
  if (check.errors.length || !isDeepStrictEqual(check.toJS(), expected)) refuse('the move would not re-parse to the same values - left for a human');
  if (!isDeepStrictEqual(nonBlank(next), nonBlank(text + (hasLimbs ? '' : `${nl}limbs:`)))) refuse('the move would not keep every line - left for a human');

  const conns = Object.keys(data.beeper);
  return {
    satisfied: false,
    changes: [
      `${file}: top-level \`beeper:\` (lines ${lineNo(text, b.start)}-${lineNo(text, b.end - 1)}; keys ${conns.join(', ')}) → \`limbs.beeper\`, ${where}; values and comments verbatim`,
      `backup first: ${join(ctx.egptHome, 'disposable', `migration-${ID}-<timestamp>`)}/config.yaml`,
    ],
    apply: async () => {
      if (!readFileSync(file).equals(bytes)) refuse(`${file} changed since it was planned - re-run`);
      const vault = join(ctx.egptHome, 'disposable', `migration-${ID}-${stamp(new Date())}`);
      mkdirSync(vault, { recursive: true });
      copyFileSync(file, join(vault, 'config.yaml'));
      ctx.log(`backup: ${join(vault, 'config.yaml')}`);
      const tmp = `${file}.tmp-${ID}-${process.pid}`;
      writeFileSync(tmp, next, 'utf8');
      renameSync(tmp, file);
    },
  };
}
