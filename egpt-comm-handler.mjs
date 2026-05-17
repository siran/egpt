// egpt-comm-handler.mjs — the "walkie-talkie supervisor" half of the
// twin-soul split (per AN/WREN design in projects/egpt/play.md).
//
// LONG-TERM target: this module runs in its own Node process, owns the
// baileys sock + bus tab + outbox/inbox watchers, and survives restarts
// of the egpt-handler process. The handler reaches WA via file IPC
// (~/.egpt/inbox/ for inbound, ~/.egpt/outbox/ for outbound + control).
//
// PHASE 1 (this commit): module-level extraction only. Imported in-process
// by egpt.mjs. Same lifecycle, same callbacks, same behavior — but the
// outbox watcher is now decoupled from React's useEffect closure, with
// dependencies threaded explicitly via the startOutboxWatcher options.
// Lets us verify the boundary works before splitting processes.
//
// Future phases will move startWhatsAppBridge in here too, then wire
// inbound via ~/.egpt/inbox/, then split out as a separate process
// spawned by tools/daemon-wrap.ps1.

import { join } from 'node:path';
import { mkdirSync, watch as fsWatch, existsSync } from 'node:fs';
import { readFile, readdir, unlink, writeFile, rename, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { startWhatsAppBridge } from './bridges/whatsapp.mjs';

/**
 * Phase 1 wrapper around startWhatsAppBridge — establishes the
 * comm-handler boundary in-process before the Phase 2 split into
 * a separate Node process. All callbacks (onIncoming, onMediaSaved,
 * onSummonGenie, onSummonMovie, onQR, onChatId, onLog, onError) come
 * in via opts because they reference handler-side state (React refs,
 * EGPT_CONFIG, runDefaultBrainTurn closure, etc.) that can't be
 * imported cleanly without dragging the whole React tree in.
 *
 * Returns the same bridge handle today's egpt.mjs uses — get/send/
 * sendReaction/edit/delete/playFrames/startStreamMessage/getChatName/
 * getChatSlug/getJidFromShortIndex/refreshGroupNames/stop/etc.
 *
 * Phase 2 will:
 *   - run startBaileysBridge in its own process (spawned by
 *     daemon-wrap.ps1 alongside the handler process);
 *   - replace direct callback delivery with file IPC: keeper writes
 *     ~/.egpt/inbox/<id>.json for every inbound event (wa-inbound,
 *     wa-qr, wa-presence, wa-media-saved, etc.), handler reads;
 *   - replace the ~13 in-process sock.* call sites with outbox
 *     events (wa-send, wa-react, wa-edit, wa-delete, wa-typing-*)
 *     that the keeper drains and executes against baileys.
 *
 * @param {object} opts  - passes through to startWhatsAppBridge AS-IS
 * @returns {Promise<object|null>}
 */
export async function startBaileysBridge(opts) {
  return startWhatsAppBridge(opts);
}

/**
 * Cheap check the handler uses before deciding to call
 * startBaileysBridge. Avoids printing a QR unprompted on first run.
 *
 * @param {string} authDir  - e.g. ~/.egpt/wa-auth
 * @returns {boolean}       - true iff baileys creds.json is present
 */
export function isBaileysPaired(authDir) {
  if (!authDir) return false;
  return existsSync(join(authDir, 'creds.json'));
}

// ─── Phase 2b: stream-over-IPC protocol design ────────────────────────
//
// The @e persona dispatch uses bridge.startStreamMessage to stream a
// reply into WA: send an initial placeholder, debounce-edit as tokens
// arrive, flush + clear typing on finish. This object holds in-process
// state (msgKey, edit timer, typing timer) plus the outcome accessors
// (delivered, lastError) that the caller reads SYNCHRONOUSLY after
// finish() resolves to decide whether to fall back to a plain send.
//
// For the process split (handler ↔ keeper), streaming needs an event
// protocol because the in-process object can't cross the boundary.
//
// Event vocabulary (handler → keeper, written to ~/.egpt/outbox/):
//
//   { type: 'wa-stream-open',   from, ts, streamId, chatId, initialText }
//   { type: 'wa-stream-update', from, ts, streamId, text }
//   { type: 'wa-stream-finish', from, ts, streamId, text }
//   { type: 'wa-stream-cancel', from, ts, streamId, reason? }  // future
//
// Event vocabulary (keeper → handler, written to ~/.egpt/inbox/):
//
//   { type: 'wa-stream-result', from, ts, streamId, delivered, lastError? }
//
// `streamId` is a UUID minted handler-side at open() time so the
// handler can correlate the eventual wa-stream-result back to the
// finish() promise it returned to the caller.
//
// Keeper-side StreamRegistry holds `Map<streamId, bridgeStream>`. On
// wa-stream-open it calls bridge.startStreamMessage and stores the
// returned object. On wa-stream-update it calls stream.update(text).
// On wa-stream-finish it awaits stream.finish(text), reads delivered/
// lastError off the stream, posts wa-stream-result back, and deletes
// the entry. Crash recovery: on keeper restart any orphan streamIds
// get an immediate wa-stream-result with {delivered: false, lastError:
// 'keeper restarted mid-stream'} so handler can fall back.
//
// Handler-side StreamProxy implements the same surface as the in-
// process stream object (update / async finish / delivered / lastError)
// but every method is a thin event emission + (for finish) an await
// on the matching wa-stream-result. createStreamSession({ mode, ... })
// returns an in-process stream for mode='in-process' and a StreamProxy
// for mode='ipc'. Phase 2b ships with the abstraction live and
// mode='in-process'. Phase 2c flips the default to 'ipc' when the
// keeper runs in its own process.
//
// Open questions (for an + wren before implementation):
//   1. Finish timeout: if wa-stream-result never arrives (keeper hung,
//      file IPC lost the file), how long should the handler block?
//      Proposal: 30s, then resolve with delivered=false,
//      lastError='stream-result timeout' so the existing fallback path
//      in egpt.mjs kicks in.
//   2. Update bursts: handler may call update() 20+ times per reply.
//      One file per event would flood ~/.egpt/outbox/. Should we
//      coalesce updates inside the proxy (debounce there too, e.g.
//      match the keeper's 2.5s edit cadence)? Or accept the file
//      churn since it's local-fs (cheap)?
//   3. Backpressure: if the keeper is down, wa-stream-* files pile up.
//      Outbox watcher discards stale wa-stream-update events with no
//      preceding open? Or replays them in order on keeper restart and
//      lets the stale ones no-op against the missing streamId?
//
// END Phase 2b design notes ────────────────────────────────────────────

/**
 * Atomically write a JSON event into a "kept directory" via the same
 * write-then-rename pattern the outbox sibling-side helper uses, so
 * the corresponding fs.watch reader on the other side never sees a
 * partial file.
 *
 * Used by the keeper to deliver inbound WA events (wa-inbound, wa-qr,
 * wa-presence, etc.) into ~/.egpt/inbox/, and reusable for any
 * future file-IPC channels we add.
 *
 * @param {object}  event         - must have a string `type`; rest is consumer-defined
 * @param {object}  opts
 * @param {string}  opts.dir      - target directory; created if missing
 * @param {string}  [opts.from]   - logical sender; defaults to 'keeper'
 * @returns {Promise<{filename: string, posted: object}>}
 */
export async function writeIpcEvent(event, { dir, from = 'keeper' } = {}) {
  if (!event || typeof event !== 'object' || !event.type) {
    throw new Error('writeIpcEvent: event must be an object with a type');
  }
  if (!dir) throw new Error('writeIpcEvent: dir is required');
  await mkdir(dir, { recursive: true });
  const ts = Date.now();
  const id = randomUUID();
  const finalName = `${ts}-${id}.json`;
  const tmpName   = `.tmp-${id}.json`;
  const tmpPath   = join(dir, tmpName);
  const finalPath = join(dir, finalName);
  const payload = { from, ts, ...event };
  await writeFile(tmpPath, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
  await rename(tmpPath, finalPath);
  return { filename: finalName, posted: payload };
}

/**
 * Watch ~/.egpt/outbox/ for JSON events written by sibling processes
 * (cross-resumed claude subagents, ad-hoc scripts) and dispatch them
 * through the supplied callbacks.
 *
 * Recognized event types:
 *   { type: 'wa-send', from, jid, body, to_node? }
 *     → dispatchWaSend(payload, 'outbox'). Truthy return = consumed
 *       (file unlinked). Falsy = retry on next sweep (bridge down).
 *   { type: 'daemon-restart', from }
 *     → signalRestart(payload). Caller decides what restart means
 *       (today: process.exit(0); future: just kill the handler half).
 *
 * Atomicity: writer is expected to use write-then-rename (sibling-side
 * .tmp → .json) so we only ever see fully-formed JSON files. A
 * name-keyed Set acts as a lock — fs.watch and the periodic sweep
 * both race to handleFile; first claim wins.
 *
 * @param {object} opts
 * @param {(payload, src) => any} opts.dispatchWaSend   - send via baileys; truthy if consumed
 * @param {(msg) => void} opts.log                      - operator-visible status (sysLog/sysOut)
 * @param {(payload) => void} opts.signalRestart        - daemon-restart handler
 * @param {string} [opts.outboxDir]                     - default ~/.egpt/outbox
 * @returns {() => void} stop function
 */
export function startOutboxWatcher({
  dispatchWaSend,
  log = () => {},
  signalRestart = () => {},
  outboxDir,
} = {}) {
  if (typeof dispatchWaSend !== 'function') {
    throw new Error('startOutboxWatcher: dispatchWaSend is required');
  }
  if (!outboxDir) throw new Error('startOutboxWatcher: outboxDir is required');

  try { mkdirSync(outboxDir, { recursive: true }); } catch {}

  const claimed = new Set();
  let stopped = false;

  const handleFile = async (name) => {
    if (stopped) return;
    if (!name.endsWith('.json')) return;
    if (claimed.has(name)) return;
    claimed.add(name);
    const full = join(outboxDir, name);
    let payload;
    try {
      const raw = await readFile(full, 'utf8');
      payload = JSON.parse(raw);
    } catch (e) {
      // Vanished mid-read (another claimer won) or malformed (poison).
      if (e.code === 'ENOENT') { claimed.delete(name); return; }
      log(`!! outbox: dropping ${name} — ${e.message}`);
      try { await unlink(full); } catch {}
      return;
    }
    if (payload?.type === 'wa-send') {
      const ok = dispatchWaSend(payload, 'outbox');
      if (!ok) {
        // Bridge down or malformed — leave for retry, release claim.
        claimed.delete(name);
        return;
      }
    } else if (payload?.type === 'daemon-restart') {
      log(`outbox: daemon-restart from ${payload.from ?? '<unknown>'} — exiting cleanly for wrapper to respawn`);
      try { await unlink(full); } catch {}
      // Caller decides the actual restart shape (today: process.exit(0);
      // post-split: just kill the handler-side process).
      signalRestart(payload);
      return;
    } else {
      log(`outbox: ignoring ${name} — unknown type ${payload?.type ?? '<missing>'}`);
    }
    try { await unlink(full); } catch {}
  };

  const sweep = async () => {
    if (stopped) return;
    let names = [];
    try { names = await readdir(outboxDir); } catch { return; }
    for (const n of names) await handleFile(n);
  };

  // Drain on mount: any files written while we were down.
  sweep().catch(() => {});

  // fs.watch is the fast path. Windows can miss rename events under
  // load; the 2s sweep below catches anything dropped.
  let watcher = null;
  try {
    watcher = fsWatch(outboxDir, (_eventType, filename) => {
      if (!filename) return;
      handleFile(filename).catch(() => {});
    });
  } catch (_) { /* watcher unavailable; sweep alone keeps things flowing */ }

  const sweepTimer = setInterval(() => { sweep().catch(() => {}); }, 2000);

  return () => {
    stopped = true;
    try { watcher?.close(); } catch {}
    clearInterval(sweepTimer);
  };
}
