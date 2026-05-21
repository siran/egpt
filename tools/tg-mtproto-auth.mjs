#!/usr/bin/env node
// tools/tg-mtproto-auth.mjs — interactive first-run auth for the MTProto
// (personal-account) Telegram bridge.
//
// Run ONCE per machine to log the daemon in to your personal Telegram
// account. Prompts for phone, SMS code, and 2FA password; writes a
// session string to ~/.egpt/tg-mtproto-session.txt. From then on the
// daemon loads the session silently — no re-auth needed unless you
// invalidate the session from Telegram → Settings → Devices.
//
// Prereq: register an app at https://my.telegram.org/apps to obtain
// api_id and api_hash. Add them to ~/.egpt/config.yaml:
//
//   telegram:
//     mtproto:
//       api_id: 12345678
//       api_hash: "abcd...efgh"
//
// Then run:
//
//   node tools/tg-mtproto-auth.mjs
//
// The script reads api_id / api_hash from the config so you don't
// have to type them every time.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { readConfig } from './config-io.mjs';

const SESSION_PATH = join(homedir(), '.egpt', 'tg-mtproto-session.txt');

async function prompt(rl, question, { mask = false } = {}) {
  // node:readline/promises doesn't natively mask. For 2FA password
  // we'd want masking; for now we print the prompt and read the answer
  // in cleartext — the operator's terminal, single user. Trade-off
  // accepted (alternative is a third-party 'read' lib).
  if (mask) output.write('(input will be echoed in cleartext) ');
  return (await rl.question(question)).trim();
}

async function main() {
  const cfg = await readConfig();
  const mt = cfg.telegram?.mtproto ?? {};
  if (!mt.api_id || !mt.api_hash) {
    console.error('!! telegram.mtproto.api_id and telegram.mtproto.api_hash must be set in ~/.egpt/config.yaml first.');
    console.error('   Obtain them at https://my.telegram.org/apps');
    process.exit(1);
  }

  if (existsSync(SESSION_PATH)) {
    const overwrite = await (async () => {
      const rl = readline.createInterface({ input, output });
      try {
        const a = await rl.question(`Session file already exists at ${SESSION_PATH}. Overwrite (re-auth)? [y/N] `);
        return a.trim().toLowerCase() === 'y';
      } finally { rl.close(); }
    })();
    if (!overwrite) {
      console.log('Aborted. Existing session preserved.');
      process.exit(0);
    }
  }

  const session = new StringSession('');   // empty → triggers auth flow
  const client = new TelegramClient(session, Number(mt.api_id), String(mt.api_hash), {
    connectionRetries: 5,
  });

  const rl = readline.createInterface({ input, output });
  try {
    await client.start({
      phoneNumber: () => prompt(rl, 'Phone (international format, e.g. +1234567890): '),
      phoneCode:   () => prompt(rl, 'SMS code received: '),
      password:    () => prompt(rl, '2FA password (if enabled, otherwise press Enter): ', { mask: true }),
      onError:     (e) => console.error('!! auth error:', e?.message ?? e),
    });
  } finally { rl.close(); }

  const saved = client.session.save();
  await mkdir(dirname(SESSION_PATH), { recursive: true });
  await writeFile(SESSION_PATH, saved, { mode: 0o600 });

  const me = await client.getMe();
  console.log(`\n✓ Authorized as ${me.firstName ?? ''} ${me.lastName ?? ''} (@${me.username ?? '—'}, id ${me.id})`);
  console.log(`✓ Session string written to ${SESSION_PATH} (chmod 600)`);
  console.log(`\nNext: restart the daemon. The MTProto bridge will auto-connect at boot.`);
  console.log(`\nTo revoke this session later: Telegram → Settings → Devices → terminate "Telegram Desktop" (or whatever name appears).`);

  await client.disconnect();
  process.exit(0);
}

main().catch(e => {
  console.error('!! tg-mtproto-auth fatal:', e?.stack ?? e?.message ?? e);
  process.exit(1);
});
