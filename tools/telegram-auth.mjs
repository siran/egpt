#!/usr/bin/env node
// tools/telegram-auth.mjs — one-time MTProto auth.
// Run once per device to produce a session string, then save it to
// ~/.egpt/config.json so both shell and extension can share it.
//
// Usage: node tools/telegram-auth.mjs

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { createInterface } from 'readline';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const CONFIG_PATH = join(homedir(), '.egpt', 'config.json');

function readConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return {}; }
}

function writeConfig(cfg) {
  mkdirSync(join(homedir(), '.egpt'), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

function prompt(rl, question) {
  return new Promise(res => rl.question(question, res));
}

const rl = createInterface({ input: process.stdin, output: process.stdout });

console.log('\n=== egpt Telegram MTProto auth ===');
console.log('Get your api_id and api_hash from https://my.telegram.org/apps\n');

const cfg = readConfig();
const existing = cfg.telegram ?? {};

const apiIdStr  = await prompt(rl, `api_id   [${existing.api_id ?? ''}]: `);
const apiHashIn = await prompt(rl, `api_hash [${existing.api_hash ? '***' : ''}]: `);

const api_id   = parseInt(apiIdStr.trim() || String(existing.api_id ?? '0'), 10);
const api_hash = apiHashIn.trim() || (existing.api_hash ?? '');

if (!api_id || !api_hash) {
  console.error('api_id and api_hash are required.');
  process.exit(1);
}

const client = new TelegramClient(new StringSession(''), api_id, api_hash, {
  connectionRetries: 3,
  useWSS: false,
});

await client.start({
  phoneNumber: async () => {
    const p = await prompt(rl, 'Phone number (e.g. +1234567890): ');
    return p.trim();
  },
  phoneCode: async () => {
    const c = await prompt(rl, 'Auth code (from Telegram app): ');
    return c.trim();
  },
  password: async () => {
    const p = await prompt(rl, '2FA password (leave blank if none): ');
    return p.trim();
  },
  onError: (err) => console.error('Auth error:', err.message),
});

const session = client.session.save();
console.log('\nAuth successful!');
console.log('Session string (keep secret):\n', session);

const updated = {
  ...cfg,
  telegram: {
    ...existing,
    api_id,
    api_hash,
    session,
  },
};
writeConfig(updated);
console.log(`\nSaved to ${CONFIG_PATH}`);
console.log('Paste the session string into the extension settings too.');

await client.disconnect();
rl.close();
process.exit(0);
