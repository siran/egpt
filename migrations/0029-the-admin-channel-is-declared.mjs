// 0029 — the admin channel is declared: `admin_channel: eGPT Admin` in the node's config.yaml.
//
// Operator, 2026-09-24: *"make it's posted on admin channel, eGPT Admin. BTW the 'admin channel'
// must be defined in config.yaml."* "It" is the compaction notice (efe344b): after a /compact that
// succeeded, boot's noticeToAdmin says `🗜️ <node> · <being> in <chat> compacted its context ...`
// in config.yaml's `admin_channel` - declared like `advice_channel` (config/config-schema.mjs), a
// chat NAME or a raw room id. Unset, the notice stays in the daemon log, so the code change alone
// posts nothing: this is the half that makes it land.
//
// THE VALUE IS THE NAME, not a room id: the operator named the group, a name reads the same on
// every node, and boot resolves it to its room with the bridge's own resolveChatId before it
// speaks. Every node posts into this one group; the line says which node it came from.
//
// INSERTED AT THE ROOT, LAST, with a comment quoting the operator. A node that already states an
// `admin_channel:` - whatever it says - is SATISFIED and left alone: that is the operator's choice
// on that node, and a refusal would stop every later migration there (setup/migrate.mjs). IT
// REFUSES only on a config.yaml it cannot honestly read: absent, not UTF-8, or not parsing.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { spliceYamlInsertKey } from '../src/tools/config-io.mjs';

export const elevated = false;
export const summary = 'the admin channel is declared: config.yaml names `admin_channel: eGPT Admin`, where the compaction notice is posted';

const ID = '0029';
const KEY = 'admin_channel';
const VALUE = 'eGPT Admin';

const refuse = (why) => { throw new Error(`${ID} refuses: ${why}`); };
const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

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
  `# THE ADMIN CHANNEL (${ID}, operator 2026-09-24: "make it's posted on admin channel, eGPT Admin.`,
  `# BTW the 'admin channel' must be defined in config.yaml"). The one chat this node posts its own`,
  `# notices to - today the compaction notice. A chat NAME or a raw Beeper room id, like`,
  `# advice_channel; unset, the notice stays in the daemon log. Operator alerts stay on the Self chat.`,
  `${KEY}: ${VALUE}`,
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
    return { satisfied: true, notes: [`${file} already states \`${KEY}: ${JSON.stringify(data[KEY])}\` - the operator's choice on this node, left as it is`] };
  }
  let next;
  try { next = spliceYamlInsertKey(text, [], { key: KEY, text: blockLines().join('\n') }); }
  catch (e) { refuse(`\`${KEY}:\` cannot be inserted at the root of ${file}: ${e?.message ?? e}`); }
  return {
    satisfied: false,
    changes: [...rendered(file, text, next, `insert \`${KEY}: ${VALUE}\` at the root`), `backup first, beside it: config.yaml.bak-${ID}-<timestamp>`],
    apply: async () => {
      if (!readFileSync(file).equals(bytes)) refuse(`${file} changed since it was planned - re-run`);
      ctx.log(`backup: ${ctx.backup(file)}`);
      writeFileSync(file, next, 'utf8');
    },
  };
}
