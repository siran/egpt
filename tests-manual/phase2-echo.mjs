#!/usr/bin/env node
// phase2-echo.mjs — the LIVE Phase 2 verify gate (SPINE-REWRITE-PLAN.md §6):
// "real Bridge behind the port → a live test chat echoes inbound→outbound (no
// brain)." It wires the REAL Beeper bridge through the §2b Bridge port adapter
// and echoes each inbound text back to the SAME chat — no spine, no brain, no
// gating. If a message you send in the target chat comes back prefixed "🔁",
// the port is live and bidirectional.
//
// SAFETY: scoped to ONE chat. Target = argv[2] (chat id / title / slug) or, if
// omitted, whatsapp.chat_id (your self-DM — the canonical safe test room). It
// NEVER echoes any other conversation, nor reactions/edits, nor its own echoes.
//
// Run on the TEST Beeper account (NOT REVE/DOLLY), with Beeper Desktop running:
//   node tests-manual/phase2-echo.mjs
//   node tests-manual/phase2-echo.mjs "my test group"
// Ctrl-C to stop.
import { readConfigSync } from '../src/tools/config-io.mjs';
import { createBeeperBridgePort } from '../src/bridges/beeper-port.mjs';

const slug = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const cfg = readConfigSync();
const token = cfg.beeper_token ?? cfg.whatsapp?.beeper_token ?? process.env.BEEPER_ACCESS_TOKEN;
const target = process.argv[2] ?? cfg.whatsapp?.chat_id ?? null;

if (!token) { console.error('!! no beeper token (config beeper_token / whatsapp.beeper_token / BEEPER_ACCESS_TOKEN)'); process.exit(1); }
if (!target) { console.error('!! no target chat — pass one as argv[2], or set whatsapp.chat_id in config'); process.exit(1); }

const wantSlug = slug(target);
const isTarget = (from) =>
  from.chatId === target || from.chatName === target || slug(from.chatName) === wantSlug;

const port = await createBeeperBridgePort({ beeperToken: token, onLog: (m) => console.log(`  [bridge] ${m}`) });

port.onMessage(async ({ body, from }) => {
  if (from.isReaction || from.isStageDirection) return;        // text only
  if (typeof body !== 'string' || !body.trim()) return;
  if (body.startsWith('🔁 ')) return;                          // never echo our own echo
  console.log(`← in  [${from.chatName}] ${from.senderName ?? from.userId}: ${JSON.stringify(body.slice(0, 80))}${isTarget(from) ? '' : '  (not target — ignored)'}`);
  if (!isTarget(from)) return;
  try { await port.send(from.chatId, `🔁 ${body}`); console.log(`→ out [${from.chatName}] echoed`); }
  catch (e) { console.error(`!! echo send failed — ${e?.message ?? e}`); }
});

console.log(`phase2-echo: echoing chat ${JSON.stringify(target)} (slug ${JSON.stringify(wantSlug)}). Ctrl-C to stop.`);
const aliveTimer = setInterval(() => console.log(`  [status] bridge alive=${port.isAlive()}`), 15_000);
process.on('SIGINT', () => { clearInterval(aliveTimer); port.stop(); console.log('\nphase2-echo: stopped'); process.exit(0); });
