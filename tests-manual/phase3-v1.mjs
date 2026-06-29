#!/usr/bin/env node
// phase3-v1.mjs — the LIVE v1 verify gate (SPINE-REWRITE-PLAN.md §6 Phase 3):
// "gated receive → brain → reply → send live; transcript written." This is the
// NEW spine, run for real: boot() wires the real Beeper bridge, the real warm
// claude pool, and the real services, then the loop runs. It is the same code
// path production will use at cutover — only the launcher (egpt.mjs) still points
// at the old egpt-spine.mjs until then, so running this does NOT disturb the old
// spine (stop the old one first if it holds the Beeper pairing).
//
// Behavior is gated by YOUR config (whatsapp.auto_modes / auto_e_default): an
// unconfigured chat defaults to 'mention' (E answers only when @e'd). To see a
// reply, @e in a chat, or set a chat to 'on' in config.
//
// Run on the TEST Beeper account (NOT REVE/DOLLY), Beeper Desktop up, claude CLI
// installed:
//   node tests-manual/phase3-v1.mjs
// Ctrl-C to stop. Replies land in conversations/<surface>/<slug>/transcript.md.
import { boot } from '../src/spine/boot.mjs';

const app = await boot({
  log: { line: (s) => console.log(s) },
  tickMs: 0,        // v1 has no heartbeat work yet — keep the loop purely event-driven
});

console.log(`phase3-v1: spine up (bridge alive=${app.bridge.isAlive()}). Gated by config. Ctrl-C to stop.`);
const status = setInterval(() => console.log(`  [status] bridge alive=${app.bridge.isAlive()} | warm ${JSON.stringify(app.pool.stats())}`), 30_000);
process.on('SIGINT', () => { clearInterval(status); app.stop(); console.log('\nphase3-v1: stopped'); process.exit(0); });
