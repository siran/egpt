// telegram-token.mjs - store one Telegram bot token as $EGPT_HOME/secrets/telegram-<connection>.token
//   node setup/telegram-token.mjs <connection> [--home <EGPT_HOME>]     (token on stdin, or asked)
// Prints the token only as length + sha256[:12]. Temp file then rename; on POSIX the file is 0600
// and the folder 0700. config.yaml carries no token: just limbs.telegram.<connection>: { account }.
import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { EGPT_HOME } from '../src/egpt-home.mjs';
import { telegramTokenPath, secretTag } from '../src/bridges/telegram.mjs';

const fail = (m) => { console.error(`telegram-token: ${m}`); process.exit(1); };
const args = process.argv.slice(2);
const homeAt = args.indexOf('--home');
const home = homeAt >= 0 ? args[homeAt + 1] : EGPT_HOME;
if (homeAt >= 0 && !home) fail('--home needs a path');
const positional = args.filter((_, i) => i !== homeAt && i !== homeAt + 1);

// One line from the console, not echoed.
function ask(question, { hidden = false } = {}) {
  process.stdout.write(question);
  const output = hidden ? new Writable({ write(_c, _e, cb) { cb(); } }) : process.stdout;
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => rl.once('line', (line) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(line); }));
}

const tty = !!process.stdin.isTTY;
let connection = positional[0];
if (!connection && tty) connection = (await ask('Connection name [main]: ')).trim() || 'main';
if (!connection) fail('usage: node setup/telegram-token.mjs <connection> [--home <EGPT_HOME>]  (token on stdin)');
if (!/^[A-Za-z0-9_-]+$/.test(connection)) fail(`"${connection}" is not a connection name (letters, digits, _ and - only)`);

const token = (tty ? await ask('Paste the bot token from @BotFather (not shown) and press Enter: ', { hidden: true }) : readFileSync(0, 'utf8')).trim();
if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) fail('that does not look like a bot token (<digits>:<30+ letters, digits, _ or ->)');

const path = telegramTokenPath(home, connection);
const posix = process.platform !== 'win32';
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
if (posix) chmodSync(dirname(path), 0o700);
const tmp = `${path}.tmp-${process.pid}`;
try {
  writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
  if (posix) chmodSync(tmp, 0o600);
  renameSync(tmp, path);
} catch (e) {
  rmSync(tmp, { force: true });
  fail(`could not write ${path}: ${e?.message ?? e}`);
}
console.log(`${path} written (${secretTag(token)}). Restart the spine to use it; boot names the bot with getMe.`);
