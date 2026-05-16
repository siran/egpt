#!/usr/bin/env node
// egpt-keeper.mjs — standalone entry point for the comm-handler half
// of the twin-soul split (per design in projects/egpt/play.md).
//
// PHASE 2 STATUS: scaffold only. This file describes the future
// architecture but does NOT yet run as a separate process — egpt.mjs
// still owns baileys, the outbox watcher, and inbound delivery via
// in-process callbacks (currently routed through the wrappers in
// egpt-comm-handler.mjs). The shape is committed so the migration
// can land incrementally without a big-bang refactor.
//
// When Phase 2 is complete, tools/daemon-wrap.ps1 will spawn both:
//   - this file (the keeper — long-lived, owns baileys + WA IPC)
//   - egpt-daemon.mjs (which spawns egpt.mjs — the handler, restartable)
//
// File IPC vocabulary (per Wren's split plan, kebab-case):
//
//   ~/.egpt/inbox/<ts>-<uuid>.json   keeper → handler
//     {type:'wa-inbound',       from, ts, jid, body, msgKey, msgRaw, ...}
//     {type:'wa-qr',            from, ts, qrAscii}
//     {type:'wa-presence',      from, ts, jid, presence}
//     {type:'wa-chat-seen',     from, ts, jid, name, lastActivityTs}
//     {type:'wa-chats-snapshot',from, ts, chats: [...]}   // on handler-online
//     {type:'wa-media-saved',   from, ts, ...metadata}
//
//   ~/.egpt/outbox/<ts>-<uuid>.json   handler → keeper (existing dir)
//     {type:'wa-send',          from, ts, jid, body, to_node?}   // today
//     {type:'wa-react',         from, ts, msgKey, emoji}         // future
//     {type:'wa-edit',          from, ts, msgKey, body}          // future
//     {type:'wa-delete',        from, ts, msgKey}                // future
//     {type:'wa-typing-on'|'wa-typing-off', from, ts, jid}       // future
//     {type:'restart-keeper',   from, ts, reason}                // future
//     {type:'daemon-restart',   from, ts}                        // today
//
// Both sides debounce restart-* events to ignore repeats within 5s
// (per Wren) to kill flap loops.
//
// PIDs live at:
//   ~/.egpt/keeper.pid
//   ~/.egpt/handler.pid
// so the wrapper knows what to kill / respawn independently.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, unlinkSync } from 'node:fs';

const EGPT_HOME = join(homedir(), '.egpt');
const KEEPER_PID_PATH  = join(EGPT_HOME, 'keeper.pid');
const KEEPER_INBOX_DIR = join(EGPT_HOME, 'inbox');

async function main() {
  // PHASE 2 implementation lands here. Today this is a placeholder
  // so the file can be referenced + tested without breaking the
  // in-process Phase 1 wiring egpt.mjs depends on.
  //
  // The implementation will be:
  //   1. Write our PID to KEEPER_PID_PATH so the wrapper can target us.
  //   2. mkdir KEEPER_INBOX_DIR.
  //   3. startBaileysBridge({ ...callbacks that write to KEEPER_INBOX_DIR }).
  //   4. startOutboxWatcher({
  //        outboxDir: ~/.egpt/outbox,
  //        dispatchWaSend: (p) => bridge.send(p.body, {chatId: p.jid}),
  //        log: console.log,
  //        signalRestart: () => process.exit(0),
  //      });
  //   5. SIGTERM handler → close bridge cleanly, unlink PID, exit 0.
  //   6. on('uncaughtException')/('unhandledRejection') → log + exit
  //      non-zero so wrapper respawns.

  console.log(`[egpt-keeper] scaffold only — Phase 2 work in progress`);
  console.log(`[egpt-keeper] inbox dir will be ${KEEPER_INBOX_DIR}`);
  console.log(`[egpt-keeper] today, egpt.mjs still owns baileys via egpt-comm-handler.mjs in-process`);
  process.exit(0);
}

main().catch(e => { console.error('[egpt-keeper] fatal:', e); process.exit(1); });

// Avoid unused-import warnings while the scaffold isn't doing anything yet.
void writeFileSync; void unlinkSync; void KEEPER_PID_PATH;
