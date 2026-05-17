#!/usr/bin/env node
// egpt-keeper.mjs — standalone entry point for the comm-handler half
// of the twin-soul split (per design in projects/egpt/play.md).
//
// PHASE 2c STATUS: minimum-viable runnable scaffold. The keeper boots,
// writes its PID, sets up signal handlers, and holds open. It does NOT
// yet own baileys or run an outbox watcher — both still live inside
// egpt.mjs (handler-side, via egpt-comm-handler.mjs imports). That
// transfer is the next commit: keeper takes baileys ownership +
// outbox watcher, handler gains an inbox watcher that consumes
// ~/.egpt/inbox/<id>.json events the keeper writes for each WA
// arrival.
//
// Running standalone:
//   node egpt-keeper.mjs
//
// Today this is safe to invoke alongside the running daemon — keeper
// doesn't yet take over any state. Don't add it to tools/daemon-wrap.ps1
// until the ownership transfer lands, or both processes will fight
// over the outbox.
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

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { createWriteStream } from 'node:fs';

const EGPT_HOME = join(homedir(), '.egpt');
const KEEPER_PID_PATH  = join(EGPT_HOME, 'keeper.pid');
const KEEPER_LOG_PATH  = join(EGPT_HOME, 'keeper.log');
const KEEPER_INBOX_DIR = join(EGPT_HOME, 'inbox');

mkdirSync(EGPT_HOME, { recursive: true });
mkdirSync(KEEPER_INBOX_DIR, { recursive: true });

const logStream = createWriteStream(KEEPER_LOG_PATH, { flags: 'a' });
function log(msg) {
  const line = `[keeper ${new Date().toISOString()}] ${msg}\n`;
  logStream.write(line);
  process.stdout.write(line);
}

// PID file: claims this process as the running keeper. If a stale
// one exists from a prior crash, overwrite — Phase 2c step 2 will
// add a "is the listed PID still alive?" handshake to detect a real
// running keeper and refuse to double-start.
function writePidFile() {
  try {
    if (existsSync(KEEPER_PID_PATH)) {
      log(`stale ${KEEPER_PID_PATH} present, overwriting`);
    }
    writeFileSync(KEEPER_PID_PATH, String(process.pid));
    log(`pid ${process.pid} written to ${KEEPER_PID_PATH}`);
  } catch (e) {
    log(`!! could not write pid file: ${e.message}`);
  }
}

function clearPidFile() {
  try { unlinkSync(KEEPER_PID_PATH); log('pid file removed'); }
  catch (_) {}
}

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`received ${signal}, shutting down cleanly`);
  clearPidFile();
  // Future: stop baileys, drain outbox watcher, send wa-stream-cancel
  // for any pending streams. Today nothing-owned, so just exit.
  logStream.end(() => process.exit(0));
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP',  () => shutdown('SIGHUP'));

process.on('uncaughtException', (e) => {
  log(`!! uncaughtException: ${e?.stack ?? e}`);
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (e) => {
  log(`!! unhandledRejection: ${e?.stack ?? e}`);
  // Don't shut down on unhandled rejections — log and continue.
});

async function main() {
  log(`egpt-keeper starting`);
  log(`  cwd:   ${process.cwd()}`);
  log(`  node:  ${process.version}`);
  log(`  inbox: ${KEEPER_INBOX_DIR}`);
  writePidFile();

  // Phase 2c step 1: scaffold only — no baileys, no outbox watcher.
  // Hold the process open so SIGTERM/restart cycles are testable.
  // Future commits replace this no-op heartbeat with real work:
  //   - startBaileysBridge({...callbacks writing inbox events})
  //   - startOutboxWatcher({...dispatchWaSend → bridge.send})
  //   - inbound-event ack channel back to the handler

  setInterval(() => {
    // Heartbeat to keeper.log so the operator can see the process
    // is alive without grepping ps. 60s is quiet enough to not
    // bloat the log; future replaces with real event activity.
    log('idle heartbeat');
  }, 60_000);

  log('scaffold ready — no work yet (Phase 2c step 1)');
}

main().catch(e => {
  log(`!! fatal in main: ${e?.stack ?? e}`);
  clearPidFile();
  process.exit(1);
});
