// claude-oauth-token.mjs - store the boxed beings' Claude credential as $EGPT_HOME/secrets/claude-oauth.token
//   claude setup-token                                    (as the operator; prints the token)
//   node setup/claude-oauth-token.mjs [--home <EGPT_HOME>]  (paste it, then Enter and Ctrl-D; or pipe it in)
// Prints the token only as length + sha256[:12]. Read per turn, so no restart is needed.
// config.yaml's sandbox_oauth_token, where set, still wins (src/spine/brainpool.mjs sandboxOauthTokenOf).
import { readFileSync } from 'node:fs';
import { EGPT_HOME } from '../src/egpt-home.mjs';
import { secretTag } from '../src/bridges/telegram.mjs';
import { writeSecret, CLAUDE_OAUTH_TOKEN_FILE } from '../src/secrets.mjs';

const fail = (m) => { console.error(`claude-oauth-token: ${m}`); process.exit(1); };
const args = process.argv.slice(2);
const homeAt = args.indexOf('--home');
const home = homeAt >= 0 ? args[homeAt + 1] : EGPT_HOME;
if (homeAt >= 0 && !home) fail('--home needs a path');

if (process.stdin.isTTY) console.error('Paste the token from `claude setup-token`, then Enter and Ctrl-D:');
const token = readFileSync(0, 'utf8').trim();
if (!/^sk-ant-oat\d*-[A-Za-z0-9_-]{20,}$/.test(token)) fail('that does not look like a `claude setup-token` token (sk-ant-oat…); an sk-ant-api key will not work');
let path;
try { path = writeSecret(home, CLAUDE_OAUTH_TOKEN_FILE, token); } catch (e) { fail(`could not write: ${e?.message ?? e}`); }
console.log(`${path} written (${secretTag(token)}).`);
