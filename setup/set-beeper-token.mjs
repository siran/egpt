// set-beeper-token.mjs - write one Beeper connection's token into config.yaml (limbs.beeper.<connection>.token).
//   node setup/set-beeper-token.mjs <connection> [--config <path>]     (token on stdin)
// Prints the token only as length + sha256[:12]. Backs config.yaml up first; the splice re-parses.
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import * as YAML from 'yaml';
import { spliceYamlScalar, beeperBlockOf, beeperBlockPath } from '../src/tools/config-io.mjs';

const fail = (m) => { console.error(`set-beeper-token: ${m}`); process.exit(1); };
const [connection, flag, cfgArg] = process.argv.slice(2);
if (!connection) fail('usage: node setup/set-beeper-token.mjs <connection> [--config <path>]  (token on stdin)');
const cfgPath = flag === '--config' && cfgArg
  ? cfgArg
  : join(process.env.EGPT_HOME || join(homedir(), '.egpt'), 'config', 'config.yaml');

const token = readFileSync(0, 'utf8').trim();
if (!/^\S{16,}$/.test(token)) fail('that does not look like a token (16+ characters, no spaces)');

const src = readFileSync(cfgPath, 'utf8');
const cfg = YAML.parse(src);
const at = [...beeperBlockPath(cfg), connection, 'token'];
const key = at.join('.');
const current = beeperBlockOf(cfg)?.[connection]?.token;
if (current === undefined) fail(`${cfgPath} has no ${key}`);

let out = spliceYamlScalar(src, at, { expect: current, to: token });
if (src.includes('\r\n')) out = out.replace(/\r?\n/g, '\r\n');
const tag = `${token.length} chars, sha256 ${createHash('sha256').update(token).digest('hex').slice(0, 12)}`;
if (out === src) { console.log(`${key} already is that token (${tag})`); process.exit(0); }

const backup = `${cfgPath}.bak-token-${connection}-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}`;
copyFileSync(cfgPath, backup);
writeFileSync(cfgPath, out);
console.log(`${key} written (${tag}); previous config kept as ${backup}`);
