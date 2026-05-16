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
import { readFile, readdir, unlink } from 'node:fs/promises';
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
