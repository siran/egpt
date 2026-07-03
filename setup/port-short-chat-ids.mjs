#!/usr/bin/env node
// port-short-chat-ids.mjs — ONE-SHOT port of the live profile's full-form Beeper
// chat ids ('!xxxx:beeper.local') to the SHORT form ('xxxx') egpt now uses
// everywhere except the Beeper API boundary (operator 2026-07-03; the
// normalizer is src/bridges/chat-id.mjs — shortChatId/fullChatId). Rewrites, IN
// PLACE, the three places a full-form id was found live:
//
//   1. config/config.yaml        — chat_id / mirror_chat_id / allowed_users
//                                   entries / agents.*.relay_channel / any
//                                   other room-id-shaped value. A pure TEXT
//                                   substitution (every '!...:beeper.local'
//                                   occurrence, wherever it appears) — every
//                                   other byte (comments, formatting, quoting)
//                                   is untouched, and it can't miss a key this
//                                   script doesn't know to enumerate.
//   2. config/conversations.yaml  — contact jid KEYS (+ `aliasOf` references).
//                                   Round-trips through readState/writeState
//                                   (conversations-state.mjs) — the SAME yaml
//                                   Document API the rest of the app already
//                                   uses to read/write this file, so the
//                                   pushedName-as-inline-comment slim format
//                                   survives exactly as it does today.
//   3. state/beeper-seen.jsonl    — the persisted dedup keys, shaped
//                                   `${chatID}|${msgId}`.
//
// Idempotent: shortChatId is a no-op on an already-short id, so a second run
// touches nothing (each step logs "already short (no-op)" and skips its write).
//
// Run this with the egpt service STOPPED — it rewrites live state files, and a
// concurrent writer (the running bridge) could race the rewrite.
//
// Usage:  node setup/port-short-chat-ids.mjs
//   Profile is EGPT_HOME (env var), else ~/.egpt — same resolution as the app
//   (src/egpt-home.mjs). No flags; point EGPT_HOME at a non-default profile
//   the same way you would for any other egpt command.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { shortChatId } from '../src/bridges/chat-id.mjs';
import { CONFIG_YAML_PATH } from '../src/tools/config-io.mjs';
import { CONV_YAML_PATH, readState, writeState } from '../conversations-state.mjs';
import { EGPT_HOME } from '../src/egpt-home.mjs';
import { join } from 'node:path';

const SEEN_PATH = join(EGPT_HOME, 'state', 'beeper-seen.jsonl');

// Every '!<opaque>:beeper.local' occurrence anywhere in the file — chat_id,
// mirror_chat_id, allowed_users entries, agents.*.relay_channel, egpt_chats,
// auto_e_chats, … — replaced via the ACTUAL normalizer (shortChatId), so this
// can never drift from what the runtime does. Non-greedy up to the literal
// suffix means the match stops at the room id itself, never spilling into a
// surrounding quote/comma.
function portConfigYaml() {
  if (!existsSync(CONFIG_YAML_PATH)) { console.log('config.yaml: not found, skipping'); return; }
  const text = readFileSync(CONFIG_YAML_PATH, 'utf8');
  let n = 0;
  const next = text.replace(/!\S*?:beeper\.local/g, (m) => {
    const s = shortChatId(m);
    if (s !== m) n++;
    return s;
  });
  if (n === 0) { console.log('config.yaml: already short (no-op)'); return; }
  writeFileSync(CONFIG_YAML_PATH, next, 'utf8');
  console.log(`config.yaml: shortened ${n} room id(s)`);
}

// jid KEYS (+ aliasOf references, which point at another jid key in the same
// surface bucket and must shorten in lockstep or the alias dangles).
async function portConversationsYaml() {
  if (!existsSync(CONV_YAML_PATH)) { console.log('conversations.yaml: not found, skipping'); return; }
  const state = await readState(CONV_YAML_PATH);
  let changed = false;
  const nextContacts = {};
  for (const [surface, bucket] of Object.entries(state.contacts ?? {})) {
    const nextBucket = {};
    for (const [jid, entry] of Object.entries(bucket ?? {})) {
      const shortJid = shortChatId(jid);
      if (shortJid !== jid) changed = true;
      let nextEntry = entry;
      if (entry && typeof entry === 'object' && entry.aliasOf) {
        const shortAlias = shortChatId(entry.aliasOf);
        if (shortAlias !== entry.aliasOf) changed = true;
        nextEntry = { ...entry, aliasOf: shortAlias };
      }
      nextBucket[shortJid] = nextEntry;
    }
    nextContacts[surface] = nextBucket;
  }
  if (!changed) { console.log('conversations.yaml: already short (no-op)'); return; }
  await writeState(CONV_YAML_PATH, { ...state, contacts: nextContacts });
  console.log('conversations.yaml: jid keys shortened');
}

// `${chatID}|${msgId}` dedup keys — the chatID prefix (up to the FIRST '|'; a
// Beeper chatID never contains one) gets shortened. A torn/unparseable line is
// left byte-for-byte as-is (beeper.mjs already tolerates a torn line on load).
function portSeenJsonl() {
  if (!existsSync(SEEN_PATH)) { console.log('beeper-seen.jsonl: not found, skipping'); return; }
  const lines = readFileSync(SEEN_PATH, 'utf8').split('\n').filter(Boolean);
  let n = 0;
  const next = lines.map((line) => {
    let o;
    try { o = JSON.parse(line); } catch { return line; }
    const id = String(o.id ?? '');
    const i = id.indexOf('|');
    if (i < 0) return line;
    const chatPart = id.slice(0, i);
    const shortChat = shortChatId(chatPart);
    if (shortChat === chatPart) return line;
    n++;
    return JSON.stringify({ ...o, id: shortChat + id.slice(i) });
  });
  if (n === 0) { console.log('beeper-seen.jsonl: already short (no-op)'); return; }
  writeFileSync(SEEN_PATH, next.join('\n') + '\n', 'utf8');
  console.log(`beeper-seen.jsonl: shortened ${n} entries`);
}

async function main() {
  console.log(`port-short-chat-ids: profile ${EGPT_HOME}`);
  portConfigYaml();
  await portConversationsYaml();
  portSeenJsonl();
  console.log('done.');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
