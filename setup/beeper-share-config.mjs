// beeper-share-config.mjs - the config.yaml half of setup/share-beeper-primary-profile.ps1.
//   node setup/beeper-share-config.mjs remove-gui [--config <path>]
//       removes beeper.primary_gui (the window's own connection; the window now IS primary).
//   node setup/beeper-share-config.mjs restore --from <backup> [--config <path>]
//       puts beeper.primary.token and the beeper.primary_gui block back from that backup.
// Backs config.yaml up before writing; a token is printed only as length + sha256[:12].
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import * as YAML from 'yaml';
import { spliceYamlRemoveKey, spliceYamlScalar, spliceYamlInsertKey, yamlKeyLines } from '../src/tools/config-io.mjs';

const fail = (m) => { console.error(`beeper-share-config: ${m}`); process.exit(1); };
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i < 0 ? null : args[i + 1]; };
const cfgPath = opt('config') ?? join(process.env.EGPT_HOME || join(homedir(), '.egpt'), 'config', 'config.yaml');
const tag = (t) => `${String(t).length} chars, sha256 ${createHash('sha256').update(String(t)).digest('hex').slice(0, 12)}`;

const src = readFileSync(cfgPath, 'utf8');
const beeper = YAML.parse(src)?.beeper ?? {};
let out = src;
const said = [];

if (args[0] === 'remove-gui') {
  if (!beeper.primary_gui) { console.log('beeper.primary_gui is not there - nothing to remove'); process.exit(0); }
  out = spliceYamlRemoveKey(src, ['beeper'], { key: 'primary_gui' });
  said.push('beeper.primary_gui removed');
} else if (args[0] === 'restore') {
  const from = opt('from') ?? fail('restore needs --from <backup>');
  const bsrc = readFileSync(from, 'utf8');
  const old = YAML.parse(bsrc)?.beeper ?? {};
  if (old.primary?.token && beeper.primary?.token !== undefined && beeper.primary.token !== old.primary.token) {
    out = spliceYamlScalar(out, ['beeper', 'primary', 'token'], { expect: beeper.primary.token, to: old.primary.token });
    said.push(`beeper.primary.token restored (${tag(old.primary.token)})`);
  }
  if (old.primary_gui && !beeper.primary_gui) {
    const { start, end } = yamlKeyLines(bsrc, ['beeper'], { key: 'primary_gui' });
    out = spliceYamlInsertKey(out, ['beeper'], { key: 'primary_gui', text: bsrc.slice(start, end), after: 'primary' });
    said.push('beeper.primary_gui restored');
  }
  if (!said.length) { console.log('config.yaml already has the backup\'s beeper.primary.token and beeper.primary_gui'); process.exit(0); }
} else {
  fail('usage: remove-gui | restore --from <backup>   [--config <path>]');
}

if (src.includes('\r\n')) out = out.replace(/\r?\n/g, '\r\n');
const backup = `${cfgPath}.bak-share-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}`;
copyFileSync(cfgPath, backup);
writeFileSync(cfgPath, out);
console.log(`${said.join('; ')}; previous config kept as ${backup}`);
