#!/usr/bin/env node
// egpt.mjs — the v2 node.
//
// The node IS the loop. boot() wires the ports + services and runs the spine;
// there is nothing else to choose. No role flags (--client/--headless/--spine),
// no attach probe, no pidfile handshake — all of that was the old launcher's
// machinery for an architecture that no longer exists. The profile (config,
// conversations, state, claude sessions) is selected by EGPT_HOME (default
// ~/.egpt). Supervised by egpt-daemon.mjs; run it directly to drive a node by hand.
import { boot } from './src/spine/boot.mjs';

const app = await boot({ aliveMs: 60_000 });   // beat state/alive.txt every 60s via a spine heartbeat so the daemon sees the loop isn't wedged

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  try { app.stop(); } catch { /* already torn down */ }
  process.exit(code);
}
process.on('SIGTERM', () => stop(0));
process.on('SIGINT', () => stop(0));
