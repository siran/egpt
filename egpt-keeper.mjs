#!/usr/bin/env node
// egpt-keeper.mjs — standalone entry point for the comm-handler half
// of the twin-soul split (per design in projects/egpt/play.md).
//
// PHASE 2c STATUS:
//   step 1 (88fa2da): scaffold — PID, log, signal handlers, idle heartbeat
//   step 2 (this commit): OPTIONALLY owns baileys + outbox watcher,
//                         writing inbound WA events to ~/.egpt/inbox/
//                         Gated by env var EGPT_KEEPER_OWNS_BAILEYS=1
//                         so it doesn't collide with the running daemon
//                         by default. Default: scaffold behavior.
//   step 3 (future):    handler-side inbox watcher in egpt.mjs;
//                         handler stops calling startBaileysBridge;
//                         daemon-wrap.ps1 spawns keeper instead.
//
// Running standalone (scaffold mode):
//   node egpt-keeper.mjs
//
// Running standalone with baileys ownership (test mode — make sure
// the daemon isn't also holding baileys, or you'll trigger the 440
// fight loop):
//   EGPT_KEEPER_OWNS_BAILEYS=1 node egpt-keeper.mjs
//
// File IPC vocabulary (per Wren's split plan, kebab-case):
//
//   ~/.egpt/inbox/<ts>-<uuid>.json   keeper → handler
//     {type:'wa-inbound',       from, ts, body, userId, username, firstName, chatId, chatType, authorized, msgKey, msgRaw, replyPersona, senderName}
//     {type:'wa-qr',            from, ts, qrAscii, msgWithHeader}
//     {type:'wa-chat-id',       from, ts, chatId}
//     {type:'wa-media-saved',   from, ts, ...metadata}
//     {type:'wa-summon-genie',  from, ts, chatId}
//     {type:'wa-summon-movie',  from, ts, chatId, triggerKey, argsStr}
//     {type:'wa-log',           from, ts, level: 'info'|'error', message}
//
//   ~/.egpt/outbox/<ts>-<uuid>.json   handler → keeper (existing dir)
//     {type:'wa-send',          from, ts, jid, body, to_node?}
//     {type:'daemon-restart',   from, ts}
//     (wa-react / wa-edit / wa-delete / wa-typing-* / restart-keeper added later)

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, unlinkSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import {
  startBaileysBridge,
  startOutboxWatcher,
  isBaileysPaired,
  writeIpcEvent,
} from './egpt-comm-handler.mjs';

const EGPT_HOME = join(homedir(), '.egpt');
const KEEPER_PID_PATH  = join(EGPT_HOME, 'keeper.pid');
// Keeper log under state/ (operator 2026-05-22 declutter). Migrate
// any pre-rename file on first load.
const KEEPER_LOG_PATH  = join(EGPT_HOME, 'state', 'keeper.log');
(function _migrateKeeperLog() {
  const oldPath = join(EGPT_HOME, 'keeper.log');
  try {
    if (existsSync(oldPath) && !existsSync(KEEPER_LOG_PATH)) {
      mkdirSync(join(EGPT_HOME, 'state'), { recursive: true });
      renameSync(oldPath, KEEPER_LOG_PATH);
    }
  } catch (e) { /* best effort; logger isn't up yet at this point */ }
})();
const KEEPER_INBOX_DIR = join(EGPT_HOME, 'inbox');
const KEEPER_OUTBOX_DIR = join(EGPT_HOME, 'outbox');
const KEEPER_AUTH_DIR   = join(EGPT_HOME, 'wa-auth');
const KEEPER_CONFIG_PATH = join(EGPT_HOME, 'config.json');

const OWNS_BAILEYS = process.env.EGPT_KEEPER_OWNS_BAILEYS === '1';

mkdirSync(EGPT_HOME, { recursive: true });
mkdirSync(KEEPER_INBOX_DIR, { recursive: true });

const logStream = createWriteStream(KEEPER_LOG_PATH, { flags: 'a' });
function log(msg) {
  const line = `[keeper ${new Date().toISOString()}] ${msg}\n`;
  logStream.write(line);
  process.stdout.write(line);
}

// PID file: claims this process as the running keeper.
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

function readConfig() {
  try {
    return JSON.parse(readFileSync(KEEPER_CONFIG_PATH, 'utf8'));
  } catch (e) {
    log(`!! could not read ${KEEPER_CONFIG_PATH}: ${e.message}`);
    return {};
  }
}

// Bridge handle once baileys is up. dispatchWaSend reads this when
// the outbox watcher hands it a wa-send event.
let bridgeRef = null;
let stopOutbox = null;

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`received ${signal}, shutting down cleanly`);
  if (stopOutbox) { try { stopOutbox(); } catch (_) {} }
  if (bridgeRef?.stop) { try { bridgeRef.stop(); } catch (_) {} }
  clearPidFile();
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
});

// Best-effort JSON-safe coercion of baileys msgRaw (contains Buffers
// + protobuf structures that JSON.stringify can mangle). We round-
// trip through stringify+parse so Buffers become {"type":"Buffer",
// "data":[...]} — handler-side can reconstruct or ignore.
function safeSerialize(v) {
  if (v == null) return null;
  try { return JSON.parse(JSON.stringify(v)); }
  catch (_) { return null; }
}

async function startKeeperBaileys() {
  const cfg = readConfig();
  const wa = cfg.whatsapp ?? {};

  if (!isBaileysPaired(KEEPER_AUTH_DIR)) {
    log(`!! ${KEEPER_AUTH_DIR}/creds.json missing — pair WA via egpt shell first, then start keeper with EGPT_KEEPER_OWNS_BAILEYS=1`);
    return null;
  }

  log(`starting baileys bridge (keeper-owned)`);
  const bridge = await startBaileysBridge({
    authDir:      KEEPER_AUTH_DIR,
    allowedUsers: wa.allowed_users ?? [],
    awareness:    wa.awareness ?? {},
    debug:        wa.debug === true,
    maxBacklogSeconds: wa.max_backlog_seconds != null ? Number(wa.max_backlog_seconds) : 5,
    media: wa.media ?? {},

    onIncoming: async (text, from) => {
      try {
        await writeIpcEvent({
          type: 'wa-inbound',
          body: text,
          userId:       from.userId,
          username:     from.username,
          firstName:    from.firstName,
          chatId:       from.chatId,
          chatType:     from.chatType,
          authorized:   from.authorized,
          msgKey:       from.msgKey ?? null,
          msgRaw:       safeSerialize(from.msgRaw),
          replyPersona: from.replyPersona ?? null,
          senderName:   from.senderName ?? null,
        }, { dir: KEEPER_INBOX_DIR, from: 'keeper' });
      } catch (e) { log(`!! inbox write failed (wa-inbound): ${e.message}`); }
    },

    onLog: (msg) => log(`whatsapp: ${msg}`),
    onError: (msg) => log(`!! whatsapp: ${msg}`),

    onQR: async (qrText, msgWithHeader) => {
      log(`QR pair requested — also writing wa-qr event to inbox for handler`);
      try {
        await writeIpcEvent({
          type: 'wa-qr', qrAscii: qrText, msgWithHeader,
        }, { dir: KEEPER_INBOX_DIR, from: 'keeper' });
      } catch (e) { log(`!! inbox write failed (wa-qr): ${e.message}`); }
    },

    onChatId: async (id) => {
      log(`chat_id captured: ${id}`);
      try {
        await writeIpcEvent({
          type: 'wa-chat-id', chatId: id,
        }, { dir: KEEPER_INBOX_DIR, from: 'keeper' });
      } catch (e) { log(`!! inbox write failed (wa-chat-id): ${e.message}`); }
    },

    onMediaSaved: async (info) => {
      try {
        await writeIpcEvent({
          type: 'wa-media-saved',
          kind: info.kind, chatJid: info.chatJid, msgId: info.msgId,
          path: info.path, sizeBytes: info.sizeBytes, deleted: info.deleted,
          preConnect: info.preConnect,
          msgKey: info.msgKey ?? null, msgRaw: safeSerialize(info.msgRaw),
        }, { dir: KEEPER_INBOX_DIR, from: 'keeper' });
      } catch (e) { log(`!! inbox write failed (wa-media-saved): ${e.message}`); }
    },

    onSummonGenie: async ({ chatId }) => {
      try {
        await writeIpcEvent({
          type: 'wa-summon-genie', chatId,
        }, { dir: KEEPER_INBOX_DIR, from: 'keeper' });
      } catch (e) { log(`!! inbox write failed (wa-summon-genie): ${e.message}`); }
    },

    onSummonMovie: async ({ chatId, triggerKey, argsStr }) => {
      try {
        await writeIpcEvent({
          type: 'wa-summon-movie', chatId,
          triggerKey: safeSerialize(triggerKey), argsStr,
        }, { dir: KEEPER_INBOX_DIR, from: 'keeper' });
      } catch (e) { log(`!! inbox write failed (wa-summon-movie): ${e.message}`); }
    },
  });

  return bridge;
}

async function main() {
  log(`egpt-keeper starting`);
  log(`  cwd:    ${process.cwd()}`);
  log(`  node:   ${process.version}`);
  log(`  inbox:  ${KEEPER_INBOX_DIR}`);
  log(`  owns baileys: ${OWNS_BAILEYS}`);
  writePidFile();

  if (OWNS_BAILEYS) {
    bridgeRef = await startKeeperBaileys();
    if (!bridgeRef) {
      log('!! baileys did not start — exiting');
      shutdown('baileys-failed');
      return;
    }

    // Outbox watcher: drain wa-send + daemon-restart events the handler
    // (or any sibling subprocess) drops into ~/.egpt/outbox/. Each
    // wa-send fires bridge.send. daemon-restart triggers our clean exit
    // (wrapper respawns).
    stopOutbox = startOutboxWatcher({
      outboxDir: KEEPER_OUTBOX_DIR,
      dispatchWaSend: (payload) => {
        if (!bridgeRef?.send) { log(`!! wa-send dropped — no bridge`); return false; }
        if (!payload.jid || !payload.body) {
          log(`!! wa-send dropped — missing jid/body (from ${payload.from})`);
          return true; // consume anyway, malformed
        }
        try {
          bridgeRef.send(payload.body, { chatId: payload.jid });
          log(`wa-send → ${payload.jid} for ${payload.from} (${(payload.body || '').slice(0, 40)}${payload.body.length > 40 ? '…' : ''})`);
          return true;
        } catch (e) {
          log(`!! wa-send threw: ${e.message}`);
          return false; // leave for retry
        }
      },
      log,
      signalRestart: () => shutdown('daemon-restart-event'),
    });

    log('keeper armed — baileys owned, outbox watcher draining');
    return;
  }

  // Scaffold mode (default): hold open with idle heartbeat.
  setInterval(() => log('idle heartbeat'), 60_000);
  log('scaffold ready — no work (set EGPT_KEEPER_OWNS_BAILEYS=1 to arm)');
}

main().catch(e => {
  log(`!! fatal in main: ${e?.stack ?? e}`);
  clearPidFile();
  process.exit(1);
});
