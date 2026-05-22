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
import { startWhatsAppBridge } from '../bridges/whatsapp.mjs';

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
 * Keeper-side stream registry. Holds the live `bridgeStream` objects
 * (returned by bridge.startStreamMessage) keyed by handler-minted
 * streamId. The registry receives wa-stream-open/update/finish events
 * (in-process today, file IPC after the split) and drives the bridge.
 *
 * On registry-miss (wa-stream-update or finish for a streamId that
 * isn't registered — keeper crashed/restarted mid-stream, or update
 * raced past open), finish() returns
 * {delivered:false, lastError:'no such stream'} and update() no-ops.
 *
 * @param {object} bridge - the WA bridge handle (today: result of startBaileysBridge)
 */
export function createStreamRegistry(bridge) {
  if (!bridge?.startStreamMessage) {
    throw new Error('createStreamRegistry: bridge.startStreamMessage missing');
  }
  const streams = new Map();
  return {
    open({ streamId, chatId, initialText }) {
      if (!streamId) return;
      if (streams.has(streamId)) return;        // duplicate-open is a no-op
      const s = bridge.startStreamMessage(initialText, { chatId });
      if (s) streams.set(streamId, s);
    },
    update({ streamId, text }) {
      streams.get(streamId)?.update(text);
    },
    async finish({ streamId, text }) {
      const s = streams.get(streamId);
      if (!s) return { streamId, delivered: false, lastError: 'no such stream' };
      try { await s.finish(text); }
      catch (e) { console.error(`!! comm-handler stream.finish(${streamId}): ${e?.message ?? e}`); /* lastError already set on s */ }
      const result = { streamId, delivered: !!s.delivered, lastError: s.lastError ?? null };
      streams.delete(streamId);
      return result;
    },
    // Cancel orphans on shutdown / restart — synthesizes a
    // wa-stream-result for each pending stream so the handler-side
    // finish() promises resolve instead of hanging until their 30s
    // timeout fires.
    cancelAll(reason = 'keeper restarted mid-stream') {
      const out = [];
      for (const streamId of streams.keys()) {
        out.push({ streamId, delivered: false, lastError: reason });
      }
      streams.clear();
      return out;
    },
    size() { return streams.size; },
  };
}

/**
 * Handler-side stream proxy. Implements the SAME surface as the in-
 * process object bridge.startStreamMessage returns — update(text),
 * async finish(text), getters .delivered + .lastError — but every
 * operation is a wa-stream-* event emission.
 *
 * No hardcoded caps on @e's speed. Both timing knobs are operator-
 * configurable via EGPT_CONFIG.streaming.{update_coalesce_ms,
 * finish_timeout_ms} (caller threads them in via opts). Defaults:
 *   updateCoalesceMs = 0      every update() fires immediately —
 *                             no proxy-side cap on token rate
 *   finishTimeoutMs  = 30000  protection against keeper hangs only;
 *                             does NOT cap reply speed (only kicks
 *                             in if the keeper never delivers a
 *                             wa-stream-result for a finished stream)
 *
 * `_finalized` flag drops late wa-stream-result arrivals so a
 * recovered keeper can't double-deliver.
 *
 * @param {object} opts
 * @param {string} opts.streamId
 * @param {(event) => void}  opts.sendEvent     - fire-and-forget wa-stream-* events
 * @param {(streamId, timeoutMs) => Promise<{delivered, lastError}>} opts.awaitResult
 * @param {string} [opts.from='handler']
 * @param {number} [opts.updateCoalesceMs=0]
 * @param {number} [opts.finishTimeoutMs=30000]
 */
export function createStreamProxy({
  streamId,
  sendEvent,
  awaitResult,
  from = 'handler',
  updateCoalesceMs = 0,
  finishTimeoutMs  = 30_000,
} = {}) {
  if (!streamId) throw new Error('createStreamProxy: streamId required');
  if (typeof sendEvent !== 'function') throw new Error('createStreamProxy: sendEvent required');
  if (typeof awaitResult !== 'function') throw new Error('createStreamProxy: awaitResult required');

  let pending     = null;
  let pendingTimer = null;
  let finished    = false;
  let finalized   = false;
  let delivered   = false;
  let lastError   = null;

  const flushUpdate = () => {
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    if (pending === null || finished) return;
    const text = pending;
    pending = null;
    sendEvent({ type: 'wa-stream-update', from, ts: Date.now(), streamId, text });
  };

  return {
    update(text) {
      if (finished) return;
      pending = text;
      if (updateCoalesceMs <= 0) {
        // No cap: fire every update immediately. Operator opts in
        // to coalescing via EGPT_CONFIG.streaming.update_coalesce_ms.
        flushUpdate();
      } else if (!pendingTimer) {
        pendingTimer = setTimeout(flushUpdate, updateCoalesceMs);
      }
    },
    async finish(text) {
      if (finished) return;
      finished = true;
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
      sendEvent({ type: 'wa-stream-finish', from, ts: Date.now(), streamId, text });
      const result = await awaitResult(streamId, finishTimeoutMs);
      // Late arrivals after finalization get silently dropped by the
      // caller of sendStreamResult — finalized acts as the boundary.
      finalized = true;
      delivered = !!result?.delivered;
      lastError = result?.lastError ?? null;
    },
    get delivered() { return delivered; },
    get lastError() { return lastError; },
    get finalized() { return finalized; },
  };
}

/**
 * Convenience: wire a registry + proxy together IN-PROCESS via a
 * tiny result-promise registry. Used during Phase 2b before the
 * keeper runs in its own process. The returned factory has the
 * exact same call shape as bridge.startStreamMessage so call-site
 * swaps in egpt.mjs are mechanical.
 *
 * Late wa-stream-result deliveries (after the proxy has finalized
 * via timeout) are silently dropped — pendingResults entry is
 * already gone.
 *
 * @param {object} bridge
 * @returns {{ makeStream, registry, deliverResult }}
 *   makeStream: (initialText, {chatId}) => proxy   // drop-in
 *   registry: createStreamRegistry(bridge)         // exposed for tests / inspection
 *   deliverResult: ({streamId, delivered, lastError}) => void
 */
export function createInProcessStreamChannel(bridge) {
  const registry = createStreamRegistry(bridge);
  const pendingResults = new Map();   // streamId -> resolve fn

  const awaitResult = (streamId, timeoutMs) => new Promise((resolve) => {
    const tmo = setTimeout(() => {
      pendingResults.delete(streamId);
      resolve({ delivered: false, lastError: 'stream-result timeout' });
    }, timeoutMs);
    pendingResults.set(streamId, (res) => {
      clearTimeout(tmo);
      pendingResults.delete(streamId);
      resolve(res);
    });
  });

  const deliverResult = (result) => {
    const fn = pendingResults.get(result?.streamId);
    if (fn) fn(result);
    // else: late arrival, proxy already finalized → silent drop
  };

  // sendEvent fans out to the registry synchronously (in-process)
  // and queues the wa-stream-result back through deliverResult for
  // finish events. In-process there's no actual file IPC; this just
  // exercises the same surface area that the file-IPC version will.
  const sendEvent = (ev) => {
    switch (ev?.type) {
      case 'wa-stream-update': registry.update(ev); return;
      case 'wa-stream-finish': {
        // Run async so the proxy's awaitResult registration has
        // happened by the time we resolve. Without this, the
        // resolve fn isn't yet in pendingResults when we deliver.
        Promise.resolve()
          .then(() => registry.finish(ev))
          .then(deliverResult)
          .catch((e) => deliverResult({ streamId: ev.streamId, delivered: false, lastError: e?.message ?? String(e) }));
        return;
      }
      case 'wa-stream-cancel': {
        // Future hook. v1 doesn't emit; included for completeness.
        return;
      }
      default: return;
    }
  };

  const makeStream = (initialText, { chatId } = {}, proxyOpts = {}) => {
    const streamId = randomUUID();
    registry.open({ streamId, chatId, initialText });
    return createStreamProxy({
      streamId, sendEvent, awaitResult,
      // Operator-configurable timing per EGPT_CONFIG.streaming.*; the
      // caller threads them in. Defaults inside createStreamProxy
      // (updateCoalesceMs=0, finishTimeoutMs=30000) are uncapped on
      // speed.
      ...proxyOpts,
    });
  };

  return { makeStream, registry, deliverResult };
}

/**
 * Watch ~/.egpt/inbox/ for JSON events written by the keeper (or any
 * other producer) and dispatch them through onEvent. Handler-side
 * counterpart of startOutboxWatcher — same atomicity + claim-set
 * pattern, only the direction is reversed (handler is the READER,
 * keeper is the WRITER).
 *
 * Future Phase 2c step 3: egpt.mjs imports this and wires its
 * existing onIncoming dispatch behind a startInboxWatcher subscription
 * keyed on { type: 'wa-inbound' }. Other event types (wa-qr,
 * wa-presence, wa-chat-seen, wa-chats-snapshot, wa-media-saved)
 * route to the same callbacks the bridge used to call directly when
 * baileys lived in-process.
 *
 * @param {object} opts
 * @param {string} opts.inboxDir                    - default ~/.egpt/inbox
 * @param {(event) => any} opts.onEvent             - dispatcher; truthy return = consumed (unlinked)
 * @param {(msg) => void} [opts.log]                - optional log channel
 * @returns {() => void} stop function
 */
export function startInboxWatcher({
  inboxDir,
  onEvent,
  log = () => {},
} = {}) {
  if (typeof onEvent !== 'function') {
    throw new Error('startInboxWatcher: onEvent is required');
  }
  if (!inboxDir) throw new Error('startInboxWatcher: inboxDir is required');

  try { mkdirSync(inboxDir, { recursive: true }); } catch {}

  const claimed = new Set();
  let stopped = false;

  const handleFile = async (name) => {
    if (stopped) return;
    if (!name.endsWith('.json')) return;
    if (claimed.has(name)) return;
    claimed.add(name);
    const full = join(inboxDir, name);
    let payload;
    try {
      const raw = await readFile(full, 'utf8');
      // Strip UTF-8 BOM if present — PowerShell Out-File / Set-Content
      // default to writing UTF-8 WITH BOM, which JSON.parse rejects
      // ("Unexpected token '﻿'"). Affects e/@e and any human/
      // script-written files from a PS prompt. Cheap to strip.
      const stripped = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
      payload = JSON.parse(stripped);
    } catch (e) {
      if (e.code === 'ENOENT') { claimed.delete(name); return; }
      log(`!! inbox: dropping ${name} — ${e.message}`);
      try { await unlink(full); } catch {}
      return;
    }
    let consumed = false;
    try {
      consumed = !!(await onEvent(payload));
    } catch (e) {
      log(`!! inbox onEvent threw on ${name}: ${e.message}`);
      // Treat thrown errors as "not consumed" so the file stays for
      // a follow-up — better than silently dropping events the
      // handler couldn't yet process (e.g. during boot ordering).
      claimed.delete(name);
      return;
    }
    if (!consumed) {
      claimed.delete(name);
      return;
    }
    try { await unlink(full); } catch {}
  };

  const sweep = async () => {
    if (stopped) return;
    let names = [];
    try { names = await readdir(inboxDir); } catch { return; }
    for (const n of names) await handleFile(n);
  };

  sweep().catch(e => console.error(`!! comm-handler initial sweep: ${e?.message ?? e}`));

  let watcher = null;
  try {
    watcher = fsWatch(inboxDir, (_eventType, filename) => {
      if (!filename) return;
      handleFile(filename).catch(e => console.error(`!! comm-handler handleFile(${filename}): ${e?.message ?? e}`));
    });
  } catch (e) { console.error(`!! comm-handler fsWatch(${inboxDir}): ${e?.message ?? e}`); /* sweep alone keeps things flowing */ }

  const sweepTimer = setInterval(() => { sweep().catch(e => console.error(`!! comm-handler periodic sweep: ${e?.message ?? e}`)); }, 2000);

  return () => {
    stopped = true;
    try { watcher?.close(); } catch {}
    clearInterval(sweepTimer);
  };
}

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
 *   { type: 'wa-group-subject', from, jid, subject }
 *     → dispatchWaGroupSubject(payload, 'outbox'). Same truthy-=-consumed
 *       contract. jid must be a group (@g.us); bot account must be admin.
 *   { type: 'wa-group-members', from, jid }
 *     → dispatchWaGroupMembers(payload, 'outbox'). Fetches group members.
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
 * @param {(payload, src) => any} opts.dispatchWaSend          - send via baileys; truthy if consumed
 * @param {(payload, src) => any} [opts.dispatchWaGroupSubject] - groupUpdateSubject; truthy if consumed; absent = log+drop
 * @param {(payload, src) => any} [opts.dispatchWaGroupMembers] - getGroupMembers; truthy if consumed; absent = log+drop
 * @param {(msg) => void} opts.log                             - operator-visible status (sysLog/sysOut)
 * @param {(payload) => void} opts.signalRestart               - daemon-restart handler
 * @param {string} [opts.outboxDir]                            - default ~/.egpt/outbox
 * @returns {() => void} stop function
 */
export function startOutboxWatcher({
  dispatchWaSend,
  dispatchWaGroupSubject = null,
  dispatchWaGroupMembers = null,
  dispatchSlash         = null,
  dispatchButlerTask    = null,
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
      // Strip UTF-8 BOM if present — PowerShell Out-File / Set-Content
      // default to writing UTF-8 WITH BOM, which JSON.parse rejects
      // ("Unexpected token '﻿'"). Affects e/@e and any human/
      // script-written files from a PS prompt. Cheap to strip.
      const stripped = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
      payload = JSON.parse(stripped);
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
    } else if (payload?.type === 'wa-group-subject') {
      if (typeof dispatchWaGroupSubject !== 'function') {
        log(`outbox: dropping wa-group-subject from ${payload.from ?? '<unknown>'} — no dispatcher wired`);
      } else {
        const ok = dispatchWaGroupSubject(payload, 'outbox');
        if (!ok) {
          // Bridge down / not admin / bad jid — leave for retry,
          // release claim. Caller's log already explained.
          claimed.delete(name);
          return;
        }
      }
    } else if (payload?.type === 'wa-group-members') {
      if (typeof dispatchWaGroupMembers !== 'function') {
        log(`outbox: dropping wa-group-members from ${payload.from ?? '<unknown>'} — no dispatcher wired`);
      } else {
        const ok = dispatchWaGroupMembers(payload, 'outbox');
        if (!ok) {
          // Bridge down / bad jid — leave for retry, release claim.
          claimed.delete(name);
          return;
        }
      }
    } else if (payload?.type === 'butler-task') {
      // Ephemeral haiku sub-agent invocation. Body shape:
      //   { type: 'butler-task', from, prompt, relayToSlug?, model?, allowedTools? }
      // 'relayToSlug' (optional): when set, butler's output is
      // dispatched as a system turn into that contact's thread.
      if (typeof dispatchButlerTask !== 'function') {
        log(`outbox: dropping butler-task from ${payload.from ?? '<unknown>'} — no dispatcher wired`);
      } else {
        const ok = await dispatchButlerTask(payload, 'outbox');
        if (!ok) { claimed.delete(name); return; }
      }
    } else if (payload?.type === 'slash') {
      // Programmatic slash command. Bypasses the bridge round-trip
      // (which would dedupe via _sentIds and never fire onIncoming).
      // Body shape: { type: 'slash', from, cmd: '/identity' [, meta] }
      if (typeof dispatchSlash !== 'function') {
        log(`outbox: dropping slash from ${payload.from ?? '<unknown>'} — no dispatcher wired`);
      } else {
        const ok = await dispatchSlash(payload, 'outbox');
        if (!ok) {
          claimed.delete(name);
          return;
        }
      }
    } else if (payload?.type === 'daemon-restart') {
      log(`outbox: daemon-restart from ${payload.from ?? '<unknown>'} — exiting cleanly for wrapper to respawn`);
      try { await unlink(full); } catch (e) { console.error(`!! outbox unlink(${full}): ${e?.message ?? e}`); }
      // Caller decides the actual restart shape (today: process.exit(0);
      // post-split: just kill the handler-side process).
      signalRestart(payload);
      return;
    } else {
      // Unknown event type — quarantine instead of just deleting, so the
      // operator can grep ~/.egpt/outbox-quarantine/ for misshapen
      // payloads from buggy scripts / typo'd outbox writes. The log
      // message names the file so post-mortem is easy.
      log(`!! outbox: ignoring ${name} — unknown type ${payload?.type ?? '<missing>'} — quarantined`);
      try {
        const qdir = join(outboxDir, '..', 'outbox-quarantine');
        await (async () => {
          const { mkdir, rename } = await import('node:fs/promises');
          await mkdir(qdir, { recursive: true });
          await rename(full, join(qdir, name));
        })();
        return;
      } catch (e) {
        console.error(`!! outbox quarantine(${full}): ${e?.message ?? e}`);
        // Fall through to plain unlink so the bad event doesn't loop.
      }
    }
    try { await unlink(full); } catch (e) { console.error(`!! outbox unlink(${full}): ${e?.message ?? e}`); }
  };

  const sweep = async () => {
    if (stopped) return;
    let names = [];
    try { names = await readdir(outboxDir); } catch { return; }
    for (const n of names) await handleFile(n);
  };

  // Drain on mount: any files written while we were down.
  sweep().catch(e => console.error(`!! outbox-watcher initial sweep: ${e?.message ?? e}`));

  // fs.watch is the fast path. Windows can miss rename events under
  // load; the 2s sweep below catches anything dropped.
  let watcher = null;
  try {
    watcher = fsWatch(outboxDir, (_eventType, filename) => {
      if (!filename) return;
      handleFile(filename).catch(e => console.error(`!! outbox-watcher handleFile(${filename}): ${e?.message ?? e}`));
    });
  } catch (e) { console.error(`!! outbox-watcher fsWatch(${outboxDir}): ${e?.message ?? e}`); /* sweep alone keeps things flowing */ }

  const sweepTimer = setInterval(() => { sweep().catch(e => console.error(`!! outbox-watcher periodic sweep: ${e?.message ?? e}`)); }, 2000);

  return () => {
    stopped = true;
    try { watcher?.close(); } catch {}
    clearInterval(sweepTimer);
  };
}
