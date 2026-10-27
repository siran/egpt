// escritorio-user.mjs - a chatbox client's escritorio staff: $EGPT_HOME/secrets/chatbox-<client>-escritorio.users
//   node setup/escritorio-user.mjs <client> add|remove|list [<username>]
// add asks the password twice (not shown), or reads it from stdin when piped; adding an existing user
// sets a new password. Never prints a password or a hash. The limb reads the file on each request.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { EGPT_HOME } from '../src/egpt-home.mjs';
import { readSecret, writeSecret } from '../src/secrets.mjs';
import { CLIENT_RE } from '../src/bridges/http.mjs';
import { escritorioUsersFile, staffLine, staffOf, STAFF_RE } from '../src/bridges/http-admin.mjs';

const USAGE = 'usage: node setup/escritorio-user.mjs <client> add|remove|list [<username>]  (add: the password on stdin, or asked)';
const PASSWORD_MIN = 8;
const fail = (m) => { console.error(`escritorio-user: ${m}`); process.exit(1); };

// One line from the console, not echoed when hidden.
function ask(question, { hidden = false } = {}) {
  process.stdout.write(question);
  const output = hidden ? new Writable({ write(_c, _e, cb) { cb(); } }) : process.stdout;
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => rl.once('line', (line) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(line); }));
}

const tty = !!process.stdin.isTTY;
let [client, action, user] = process.argv.slice(2);
if (!client && tty) client = (await ask('Client (e.g. demoiev): ')).trim();
if (!action && tty) action = (await ask('add, remove or list: ')).trim();
if (!user && tty && (action === 'add' || action === 'remove')) user = (await ask('Username: ')).trim();
if (!client || !action) fail(USAGE);
if (!CLIENT_RE.test(client)) fail(`"${client}" is not a client name (lowercase letters, digits, - and _)`);
if (!['add', 'remove', 'list'].includes(action)) fail(USAGE);
if (action !== 'list' && !STAFF_RE.test(user ?? '')) fail(user ? `"${user}" is not a username (letters, digits, . _ @ -; at most 64)` : USAGE);

const name = escritorioUsersFile(client);
const cur = readSecret(EGPT_HOME, name);
if (!cur.token && !['missing', 'empty'].includes(cur.problem)) fail(`cannot read ${cur.path}: ${cur.problem}`);
const lines = (cur.token ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
const others = lines.filter((l) => staffOf(l) !== user);
const save = (next) => { try { writeSecret(EGPT_HOME, name, next.join('\n')); } catch (e) { fail(`could not write ${cur.path}: ${e?.message ?? e}`); } };

if (action === 'list') {
  if (!lines.length) console.log(`no users in ${cur.path}`);
  for (const l of lines) console.log(staffOf(l));
} else if (action === 'remove') {
  if (others.length === lines.length) fail(`no user "${user}" in ${cur.path}`);
  save(others);
  console.log(`${user} removed from ${cur.path} (${others.length} left).`);
} else {
  let password;
  if (tty) {
    password = await ask(`Password for ${user} (not shown): `, { hidden: true });
    if ((await ask('Again: ', { hidden: true })) !== password) fail('the two passwords differ');
  } else password = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
  if (password.length < PASSWORD_MIN) fail(`the password needs at least ${PASSWORD_MIN} characters`);
  save([...others, await staffLine(user, password)]);
  console.log(`${user} ${others.length < lines.length ? 'has a new password' : 'added'} in ${cur.path}. No restart needed.`);
}
