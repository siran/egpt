// 0034 — the operator's repositories are a global read path: `global_read_paths:` with
// `- repos: C:/Users/an/src/siran` in the node's config.yaml, on the node that has that folder.
//
// THE RULING (operator, 2026-09-28): "sandboxed beings should have access to my
// 'C:\Users\an\src\siran', we can call it repos/", then, the same day, "please frame this in
// config.yaml as global_read_paths list". 1fdf5c0 shipped the mount with the path spelled twice, in
// the provisioner and in the launcher; both now read it from this key (config/config-schema.mjs
// global_read_paths - the spine hands the launcher the list, the provisioner asks node for it). So
// with the code alone NOTHING is mounted anywhere: this is the half that puts kg's entry back.
//
// ONLY WHERE THE FOLDER IS. Asked of the node itself behind a ctx seam (0024's pattern:
// ctx.isDirectory, production asks the filesystem, the suite never depends on the machine it runs
// on). kg has it; do does not, and reads SATISFIED with a note - an entry for a folder that is not
// there is a line that only lies (0015's reading).
//
// INSERTED AT THE ROOT, LAST, with a comment in the operator's config voice. A node that already
// states a `global_read_paths:` - whatever it lists - is SATISFIED and left alone: that list is the
// operator's, and a refusal would stop every later migration there (setup/migrate.mjs). IT REFUSES
// only on a config.yaml it cannot honestly read: absent, not UTF-8, not parsing, or not a mapping.
//
// THE MOUNT NEEDS THE PROVISIONER TOO: the launcher plants `repos` only once the pool group's
// standing read grant is on the folder, and setup\provision-sandbox-account.cmd writes that grant -
// after carving every .env under it out. Elevated and the operator's to run; this migration does
// not run it, and the change list says so.
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { spliceYamlInsertKey } from '../src/tools/config-io.mjs';

export const elevated = false;
export const summary = 'the operator\'s repositories are a global read path: config.yaml lists `global_read_paths: - repos: C:/Users/an/src/siran` where that folder exists';

const ID = '0034';
const KEY = 'global_read_paths';
const NAME = 'repos';
// THE ONE PATH THIS MIGRATION SPELLS - the ruling's, in the forward-slash form these files use.
const DIR = 'C:/Users/an/src/siran';

const refuse = (why) => { throw new Error(`${ID} refuses: ${why}`); };
const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// statSync, not existsSync: a file of that name is not the folder. Any error is "no".
const dirExists = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

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
  return [`${file}:${s + 1}-${s + Math.max(gone.length, came.length)}  ${label}`, ...gone.map((l) => `  - ${l}`), ...came.map((l) => `  + ${l}`)];
}

const blockLines = () => [
  `# THE FOLDERS EVERY SANDBOXED BEING MAY READ (${ID}, operator 2026-09-28: "sandboxed beings should`,
  `# have access to my 'C:\\Users\\an\\src\\siran', we can call it repos/", then "please frame this in`,
  `# config.yaml as global_read_paths list"). Each \`- <mount name>: <path>\` is mounted READ-ONLY as`,
  `# ~/<mount name> in every sandbox pool profile, beside src. The grant behind it is STANDING and is`,
  `# setup\\provision-sandbox-account.cmd's - re-run it after changing this list. It takes the pool off`,
  `# every .env under the folder first ("EXCEPT secrets"), and grants nothing while one is readable by`,
  `# Everyone or Users. Until the grant is on, the folder is not mounted.`,
  `${KEY}:`,
  `  - ${NAME}: ${DIR}`,
];

export async function plan(ctx) {
  const file = join(ctx.egptHome, 'config', 'config.yaml');
  if (!existsSync(file)) refuse(`there is no ${file}`);
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) refuse(`${file} is not valid UTF-8; a splice would re-encode bytes it never meant to touch`);
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) refuse(`${file} does not parse: ${doc.errors[0].message}`);
  const data = doc.toJS();
  if (!isMap(data)) refuse(`${file} is not a mapping at its root - there is no place for \`${KEY}:\``);
  if (Object.hasOwn(data, KEY)) {
    return { satisfied: true, notes: [`${file} already states \`${KEY}: ${JSON.stringify(data[KEY])}\` - the operator's list on this node, left as it is`] };
  }
  const isDirectory = ctx.isDirectory ?? dirExists;
  if (!isDirectory(DIR)) {
    return { satisfied: true, notes: [`${DIR} is not a directory on this node, so there is nothing here to share as \`${NAME}\` - nothing added`] };
  }
  let next;
  try { next = spliceYamlInsertKey(text, [], { key: KEY, text: blockLines().join('\n') }); }
  catch (e) { refuse(`\`${KEY}:\` cannot be inserted at the root of ${file}: ${e?.message ?? e}`); }
  return {
    satisfied: false,
    changes: [
      ...rendered(file, text, next, `insert \`${KEY}:\` with \`${NAME}: ${DIR}\` at the root`),
      `every boxed being gets ~/${NAME} once the pool group's read grant is on ${DIR} - run setup\\provision-sandbox-account.cmd (elevated) to carve its .env files out and write it; this migration does not`,
      `backup first, beside it: config.yaml.bak-${ID}-<timestamp>`,
    ],
    apply: async () => {
      if (!readFileSync(file).equals(bytes)) refuse(`${file} changed since it was planned - re-run`);
      ctx.log(`backup: ${ctx.backup(file)}`);
      writeFileSync(file, next, 'utf8');
    },
  };
}
