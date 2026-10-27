// ayde-user.mjs - the /ayde users: $EGPT_HOME/secrets/ayde.users, each with a level (team < devs < admin < root)
//   node setup/ayde-user.mjs add <user> <level> | set-level <user> <level> | remove <user> | list
// add asks the password twice (not shown), or reads it from stdin when piped; adding an existing user
// sets a new password and level. Never prints a password or a hash. The limb reads the file on each request.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { EGPT_HOME } from '../src/egpt-home.mjs';
import { readSecret, writeSecret } from '../src/secrets.mjs';
import { AYDE_USERS_FILE, LEVELS, USER_RE, userLine } from '../src/bridges/http-ayde.mjs';

const USAGE = `usage: node setup/ayde-user.mjs add <user> <level> | set-level <user> <level> | remove <user> | list   (level: ${LEVELS.join('|')}; add: the password on stdin, or asked)`;
const PASSWORD_MIN = 8;
const fail = (m) => { console.error(`ayde-user: ${m}`); process.exit(1); };

// One line from the console, not echoed when hidden.
function ask(question, { hidden = false } = {}) {
  process.stdout.write(question);
  const output = hidden ? new Writable({ write(_c, _e, cb) { cb(); } }) : process.stdout;
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => rl.once('line', (line) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(line); }));
}

const tty = !!process.stdin.isTTY;
let [action, user, level] = process.argv.slice(2);
if (!action && tty) action = (await ask('add, set-level, remove or list: ')).trim();
if (!['add', 'set-level', 'remove', 'list'].includes(action)) fail(USAGE);
if (action !== 'list' && !user && tty) user = (await ask('Username: ')).trim();
if (action !== 'list' && !USER_RE.test(user ?? '')) fail(user ? `"${user}" is not a username (letters, digits, . _ @ -; at most 64)` : USAGE);
if ((action === 'add' || action === 'set-level') && !level && tty) level = (await ask(`Level (${LEVELS.join(', ')}): `)).trim();
if ((action === 'add' || action === 'set-level') && !LEVELS.includes(level)) fail(level ? `"${level}" is not a level (${LEVELS.join(', ')})` : USAGE);

const cur = readSecret(EGPT_HOME, AYDE_USERS_FILE);
if (!cur.token && !['missing', 'empty'].includes(cur.problem)) fail(`cannot read ${cur.path}: ${cur.problem}`);
const lines = (cur.token ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
const nameOf = (line) => line.split(':')[0];
const mine = lines.find((l) => nameOf(l) === user);
const others = lines.filter((l) => nameOf(l) !== user);
const save = (next) => { try { writeSecret(EGPT_HOME, AYDE_USERS_FILE, next.join('\n')); } catch (e) { fail(`could not write ${cur.path}: ${e?.message ?? e}`); } };

if (action === 'list') {
  if (!lines.length) console.log(`no users in ${cur.path}`);
  for (const l of lines) console.log(l.split(':').slice(0, 2).join(' '));
} else if (action === 'remove') {
  if (!mine) fail(`no user "${user}" in ${cur.path}`);
  save(others);
  console.log(`${user} removed from ${cur.path} (${others.length} left).`);
} else if (action === 'set-level') {
  if (!mine) fail(`no user "${user}" in ${cur.path}`);
  const [, , ...rest] = mine.split(':');
  save([...others, [user, level, ...rest].join(':')]);
  console.log(`${user} is now ${level} in ${cur.path}.`);
} else {
  let password;
  if (tty) {
    password = await ask(`Password for ${user} (not shown): `, { hidden: true });
    if ((await ask('Again: ', { hidden: true })) !== password) fail('the two passwords differ');
  } else password = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
  if (password.length < PASSWORD_MIN) fail(`the password needs at least ${PASSWORD_MIN} characters`);
  save([...others, await userLine(user, level, password)]);
  console.log(`${user} (${level}) ${mine ? 'has a new password' : 'added'} in ${cur.path}. No restart needed.`);
}
