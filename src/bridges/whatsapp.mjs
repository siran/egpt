// bridges/whatsapp.mjs — egpt bridge for WhatsApp via baileys.
//
// Authenticates as a personal WhatsApp account (QR scan on first run,
// session reused after). Long-lived connection; messages.upsert is the
// inbound stream; sock.sendMessage(jid, { text }) is outbound.
//
// Same shape as bridges/telegram.mjs:
//   startWhatsAppBridge({ allowedUsers, onIncoming, onLog, onError, onChatId })
//     -> { send, startStreamMessage, stop, get chatId }
//
// Auth state persists at ~/.egpt/wa-auth/. To re-pair (different number
// or re-scan), delete that directory.
//
// Per-chat awareness rules (configurable):
//   self_chat:   'both' | 'incoming' | 'outgoing' | 'off'
//                  defaults to 'both' — in chat-with-yourself, both your
//                  phone-typed messages and any other-device echoes pass
//                  through. Useful for solo testing.
//   personal:    'both' | 'incoming' | 'outgoing' | 'off'
//                  defaults to 'incoming' — DMs from other people are
//                  processed; messages we type from another device are
//                  not (we don't want the bridge reacting to our own
//                  outbound to friends).
//   groups:      'mentions' | 'all' | 'off'
//                  defaults to 'mentions' — only group messages that
//                  mention <our-number> or reply to ours are processed.
//                  'all' processes every group message; 'off' ignores
//                  groups entirely.
//
// In all cases, allowedUsers gates whether commands and @-mentions are
// honored from a given sender — awareness only controls whether the
// message reaches onIncoming at all.
//
// Streaming: edit-based, modeled on Telegram. startStreamMessage sends
// the initial text, then debounces edits at 2.5s as the brain produces
// more. A 'composing' presence update (typing indicator) refreshes
// every 8s alongside, so the recipient sees both the partial text and
// "typing…" until finish() flushes the last edit. Trade-off: WhatsApp
// shows an "Edited" badge after the first edit (Telegram's edits are
// silent), so debounce is conservative to keep the visual churn low.
//
// ToS note: this uses the WhatsApp Web protocol via reverse-engineered
// libraries. Personal-account use at low volume has been historically
// tolerated; commercial / high-volume use risks account bans. Use at
// your own risk.

import {
  default as makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import { homedir } from 'node:os';
import { join, dirname, basename, extname } from 'node:path';
import { promises as fs, existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { spawn as _spawnChild } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { classifyWhatsAppChat } from './whatsapp-classify.mjs';
import { makeSerialByKey } from '../serial-by-key.mjs';
import { mentionStatus } from '../auto-mode.mjs';
import { defaultIsAlive } from '../daemon-singleton.mjs';
import { waSend as _outboxWaSend } from '../tools/outbox-send.mjs';
import { MIME_BY_EXT as _MIME_BY_EXT, mediaKind as _mediaKind } from '../media-kind.mjs';
import { isAuthorizedUser } from '../identity.mjs';

const AUTH_DIR_DEFAULT = join(homedir(), '.egpt', 'wa-auth');

// Silence-marker detector. egpt.mjs's persona dispatch already filters
// '...' / '…' / "(internal note)" / etc. before invoking bridge.send,
// but defense-in-depth: a caller that bypasses that path (a future
// slash command, an outbox event, an extension write) must not leak a
// literal "..." into WA. Operator (2026-05-17): "e keeps posting
// visibly '...' i think this should be filtered by bridge."
//
// Matches: '...', '…', '🐶 ...', '🐶 e: ...', '🐶 e: …', '🐶 e\n…' etc.
// The optional leading emoji + optional "<name><sep>" preamble covers the
// persona-tag-prefix shape the bridge auto-adds upstream of this layer.
// The separator after the name accepts EITHER ':' OR pure whitespace
// (including '\n') because egpt.mjs's persona-dispatch waPrefix uses
// '<emoji> <name>\n' (newline-delimited) — the prior ':\s' shape missed
// the leak (operator-reported 2026-05-17 23:05: '🐶 e\n…' still visible).
// Trailing letters / a real message body break the match — only pure
// silence variants are dropped.
export function isSilenceMarker(text) {
  if (!text) return false;
  const trimmed = String(text).trim();
  return /^(\p{Extended_Pictographic}[\p{Extended_Pictographic}️‍]*\s*)?(\w{1,16}[:\s]\s*)?(\.{3}|…)\s*$/u.test(trimmed);
}
// Reconnect backoff. Initial wait, doubled on each consecutive
// failure, capped. baileys often reports 'connection.update' close
// → open → close in quick succession when WA's edge is flapping;
// the bridge must keep retrying instead of giving up after one
// scheduled attempt. Until this commit the retry was one-shot:
// connect() threw → setTimeout never re-armed → bridge dead.
const RECONNECT_MS = 5_000;
const RECONNECT_MAX_MS = 60_000;
const BRIDGE_ALIVE_INTERVAL_MS = 60_000;
// Bound every sock.sendMessage with this timeout so a flapping/down
// WS doesn't queue the call inside baileys forever. Symptom this
// catches: persona @e reply shows '⌛ thinking…' in WA and never
// edits — finish()'s edit call was queued behind a stale WS and
// never resolved. With the timeout, finish() rejects → err() fires
// → onError surfaces 'stream finish: timed out' in the shell →
// the persona fallback's bridge.send runs (also timed out) → if
// that also fails, errOut tells the operator clearly.
const SEND_TIMEOUT_MS = 12_000;

// Bridge internal state lives under ~/.egpt/state/bridge/ (operator
// 2026-05-22 declutter). Caches + dedup rings + audit data — not files
// the operator reads at the root. Migrations below move pre-rename
// files into place on first load so we don't lose existing state.
const STATE_BRIDGE_DIR = join(homedir(), '.egpt', 'state', 'bridge');
function _migratePathOnce(oldPath, newPath) {
  try {
    if (!existsSync(oldPath)) return;
    if (existsSync(newPath)) return;       // already moved
    mkdirSync(dirname(newPath), { recursive: true });
    renameSync(oldPath, newPath);
  } catch (e) {
    console.error(`!! whatsapp bridge: migrate ${oldPath} → ${newPath}: ${e?.message ?? e}`);
  }
}
const CHATS_CACHE_PATH = join(STATE_BRIDGE_DIR, 'wa-chats.json');
_migratePathOnce(join(homedir(), '.egpt', 'wa-chats.json'), CHATS_CACHE_PATH);
// No cap on the persisted chat cache. Operator: "why are you even
// deleting chats? there's space enough. whatsapp or beeper don't
// delete my message. history is sacred." Every chat we've ever
// observed stays in wa-chats.json. Disk grows with chat count;
// that's the operator-accepted tradeoff.
const CHATS_CACHE_CAP = Infinity;
// Phase 2 logon-summary: reactions are tracked across chats and
// persisted to a separate file so they survive bridge restarts and
// so the interactive shell's "while you were away" report can find
// the most-reacted item without scanning the room md.
const REACTION_COUNTS_PATH = join(STATE_BRIDGE_DIR, 'reaction-counts.json');
_migratePathOnce(join(homedir(), '.egpt', 'reaction-counts.json'), REACTION_COUNTS_PATH);
// Same policy: don't evict reaction history.
const REACTION_COUNTS_CAP = Infinity;
// Per-msg body preview cache (text snippeted to ≤60 chars, keyed by
// WA stanza id). In-memory was 4000 entries scoped to one bridge
// session — fine for "reply during the call", broken for "look up
// what I reacted to yesterday". Persisting carries the cache across
// restarts so the operator's '[reaction ❤️ to "…"]' enrichment can
// still resolve parents that have already rolled off the recent[]
// ring. ~60-byte values × 4000 entries ≈ 240KB on disk.
const MSG_BODY_CACHE_PATH = join(STATE_BRIDGE_DIR, 'msg-body-cache.json');
_migratePathOnce(join(homedir(), '.egpt', 'msg-body-cache.json'), MSG_BODY_CACHE_PATH);
// WhatsApp's text-message Protobuf supports up to ~65k chars, but
// baileys / WA Web silently misbehave at large sizes (edit can reject,
// chunk boundaries break formatting). 4000 matches the Telegram
// chunk size we already use; small enough to be safe everywhere,
// large enough that most replies are one message. chunkText splits
// on newline boundaries when possible to avoid breaking mid-paragraph.
const WA_CHUNK_CHARS = 4000;
function chunkText(text, max) {
  if (text.length <= max) return [text];
  const out = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + max, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end);
      if (nl > i + max / 2) end = nl;
    }
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

export async function startWhatsAppBridge({
  authDir       = AUTH_DIR_DEFAULT,
  allowedUsers  = [],
  // Host supplies this to override per-chat media save location.
  // Signature: (jid) => string | null. When it returns a string the
  // bridge saves all media for that JID there; when null/undefined,
  // bridge falls back to ~/.egpt/media/<chatJidSan>/.
  // See egpt.mjs's wiring: callback resolves jid → contact slug →
  // ~/.egpt/conversations/<slug>/media/ so conversation-e sees media
  // inside its own sandboxed dir.
  mediaDirForChat = null,
  awareness     = {},        // see header docs; defaults applied below
  debug         = false,     // log every incoming upsert (type, jid, fromMe, text-preview) before any filter
  // Valid persona names for the cf77999 reply-as-mention detection.
  // Lowercase strings; matched against the leading word of a quoted
  // body (e.g. "🐦 wren: …" → 'wren'). The caller computes from
  // EGPT_CONFIG.siblings entries (+ their aliases) so new siblings
  // become reply-routable without touching this file. Default keeps
  // the historical hardcoded list working when no caller supplies it.
  personaNames  = ['e', 'egpt', 'me', 'wren'],
  // Drop messages whose timestamp is older than this many seconds
  // before connect. Default 0 = no drop. WhatsApp delivers a burst
  // of recently-buffered messages on linked-device handshake; an
  // operator who's not a WhatsApp client typically doesn't want
  // their shell flooded with the last hour of group chatter just
  // because they restarted the daemon. Default 30s: anything older
  // is HELD (not dispatched) and surfaced via /wa-pending so the
  // operator can review and explicitly dispatch (or discard).
  //
  // Semantic (changed 2026-05-14 after operator reported overnight
  // restart auto-executed a stale @e):
  //   N > 0    grace window of N seconds — messages older than that
  //            before connect are held
  //   N == 0   STRICT — any message older than connectedAt is held
  //   N == -1  disable the hold entirely (legacy behavior; not
  //            recommended — daemon restart will auto-execute brain
  //            on every queued bridge message)
  // Default 0 = STRICT (operator 2026-05-23): "nothing that happened
  // pre-online is ever autodelivered." Any message with a timestamp
  // before connectedAt is held in _heldMessages → /wa-pending; the
  // brain only ever sees messages that arrive LIVE (timestamp >=
  // connectedAt). No grace window — a 60s grace still let the last
  // minute of pre-connect backlog slip through, which violated the
  // rule. The interpreter nucleus never bursts pre-online traffic;
  // only an unrefined bridge would, so the bridge enforces the rule
  // at the gate.
  maxBacklogSeconds = 0,
  // Media download/save config. From host: { download, max_size_mb }.
  //   download:    'all' (default) — save images / videos / audio /
  //                voice notes / documents / stickers
  //                'images_docs' — only images + documents
  //                'off' — disable
  //   max_size_mb: skip downloads larger than this (default 25)
  // Files land at ~/.egpt/media/<chat>/<msgId>.<ext>. Chat dir is
  // the JID with @<host> turned into _<host-prefix> for filesystem
  // safety. msgId is the baileys stanza id (globally unique).
  media         = {},
  // When true (default), `@e` / `@egpt` appearing ANYWHERE in a
  // message body (not just at start) is rewritten to a leading
  // `@e ` prefix before handing the body to the host — so
  // parseInput, which anchors mentions at start, routes the
  // message to @e. Without this, mid-sentence wake-words bypass
  // awareness but fall through to plain-text routing. Set false
  // to require @e at start (legacy behavior).
  atEAnywhere   = true,
  // Per-instance timing knobs. All four were hardcoded const values
  // until 2026-05-16 (operator principle: "limits must never be
  // hardcoded, they all should have configurable keys"). Defaults
  // below preserve the previous behavior — each protects against a
  // WhatsApp-protocol or baileys-internals floor; lowering risks
  // server-side rate-limits or silent failures. Surface knobs so
  // the operator owns the trade-off, not the bridge.
  //
  //   editCadenceMs:   min ms between stream-message edits during
  //                    persona streaming. WA rate-limits edits at
  //                    ~1/2s sustained — going below 2000 risks
  //                    rejected edits. Default 2500 reads as smooth
  //                    typing without throttle pressure.
  //   typingRefreshMs: how often to re-emit the 'composing' presence
  //                    while a stream is open. WA's indicator times
  //                    out around 15s without refresh; 8000 keeps it
  //                    alive without spam.
  //   sendTimeoutMs:   _timeBound default for sock.sendMessage calls
  //                    so a flapping WS doesn't block the bridge.
  //                    12000 was the empirically-set floor that
  //                    catches stalls without aborting normal sends.
  //   chunkChars:      max chars per outbound text body — long
  //                    replies are split into multiple messages.
  //                    WA's protobuf supports ~65k but baileys / WA
  //                    Web misbehave above ~5k; 4000 matches the TG
  //                    chunk size and is safe across surfaces.
  editCadenceMs   = 2500,
  typingRefreshMs = 8000,
  sendTimeoutMs   = SEND_TIMEOUT_MS,
  chunkChars      = WA_CHUNK_CHARS,
  onIncoming,
  onLog,
  onError,
  onChatId,    // called once when first chat is captured (host can persist)
  onQR,        // called with the rendered QR ASCII when WA wants a fresh pair; host can route to a visible surface
  onMediaSaved, // called per successful media download: { kind, chatJid, msgId, path, sizeBytes }
  onSummonGenie, // called when '@?' token detected in an allowed sender's message; host summons a genie
  onSummonMovie, // called when '@movie <preset> [args]' token detected; host builds frames and calls playFrames with existingKey so the trigger message becomes the movie
}) {
  const aware = {
    self_chat: awareness.self_chat ?? 'both',
    // Defaults are permissive ('both' / 'all'): the operator wants
    // every WhatsApp message visible across surfaces (play-script
    // model). Dial back via config.whatsapp.awareness if a particular
    // channel turns out too noisy. The wake-word path (@egpt …) was
    // a workaround when defaults were strict; with these defaults
    // it's no longer load-bearing for visibility — it still opts a
    // message out of any 'off'/'mentions' override the operator
    // configures.
    personal:  awareness.personal  ?? 'both',
    groups:    awareness.groups    ?? 'all',
  };
  const log = (m) => onLog?.(m);
  const err = (m) => onError?.(m);

  // Dedicated, fs-direct bridge log. onLog/onError flow into the Ink/pushItem
  // render buffer (headless.log), which silently DROPS lines under load — so on
  // the headless spine we couldn't tell whether/when/why the outbound bridge
  // reaches 'open'. This append-only file bypasses Ink entirely; best-effort,
  // never throws. Operator 2026-06-02 ("no egpt back!"): the back-online ride
  // the outbox, which needs a live bridge, and the bridge state was unobservable.
  const _BRIDGE_LOG = join(homedir(), '.egpt', 'wa-bridge.log');
  const _blog = (m) => {
    try { appendFileSync(_BRIDGE_LOG, `${new Date().toISOString()} [${process.pid}] ${m}\n`, { mode: 0o600 }); } catch { /* best effort */ }
  };
  _blog(`startWhatsAppBridge: ENTRY (authDir=${authDir}, supervised=${!!process.env.EGPT_SUPERVISED})`);

  // Bound a promise with a timeout. Rejects with a clear "<label> timed
  // out after N ms" when the underlying baileys send hangs (typically:
  // WS dropped mid-call, queue stalled waiting for reconnect). Used to
  // wrap every sock.sendMessage on the outbound path so the host gets
  // a visible failure instead of a deadlocked await.
  const _timeBound = (promise, label, ms = sendTimeoutMs) => {
    let t;
    const timeout = new Promise((_, reject) => {
      t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([
      promise.then(v => { clearTimeout(t); return v; },
                    e => { clearTimeout(t); throw e; }),
      timeout,
    ]);
  };

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  _blog('auth-state loaded');
  let version;
  try {
    // MUST be time-bound: fetchLatestBaileysVersion is a network call with no
    // internal timeout. On the headless/before-logon spine it can hang
    // indefinitely (DNS/network not fully up), and since it's awaited BEFORE
    // connect() and the handle return, a hang means startBaileysBridge never
    // resolves → waBridgeRef.current stays null → every outbound drops with
    // "no baileys bridge here" and the back-online announce never sends
    // (operator 2026-06-02 "no egpt back!"). On timeout we fall back to
    // baileys' bundled default version and connect anyway.
    const fetched = await _timeBound(fetchLatestBaileysVersion(), 'fetchLatestBaileysVersion', 10000);
    version = fetched.version;
    _blog(`version fetched: ${Array.isArray(version) ? version.join('.') : version}`);
  } catch (e) {
    console.error(`!! whatsapp.mjs fetchLatestBaileysVersion: ${e?.message ?? e}`);
    // Offline / fetch blocked / TIMED OUT — baileys uses its default fallback.
    version = undefined;
    _blog(`version fetch FAILED (using baileys default): ${e?.message ?? e}`);
  }

  let stopped        = false;
  // Set when the 440 handler defers to another live egpt — outbound send()
  // calls fall back to the outbox so shell↔WhatsApp keeps working through the
  // other process's bridge instead of failing silently (operator 2026-05-29).
  let _deferredToPid = null;
  let connectedAt    = 0;     // ms; set to Date.now() when WS reaches 'open'
  // Pre-connect backlog: messages older than connectedAt -
  // maxBacklogSeconds get parked here instead of dispatched. The host
  // surfaces them via /wa-pending so the operator can review and
  // explicitly dispatch (re-running handleMessage) or clear.
  const _heldMessages = [];
  // Live oracles per chat — at most one per chat (/oracle stop @waN to
  // retire, /oracle @waN to summon a fresh one in its place). Each
  // value is the handle returned by startOracle: { msgKey, chatId,
  // onReply, stop, state }.
  const _liveOracles = new Map();
  // Host-driven awareness bypass: chats whose every message should
  // pass through to onIncoming regardless of awareness defaults.
  // /use @waN and /join @waN add entries here so the operator sees
  // ALL traffic in a joined chat (not just @-mentions), which is
  // what enables the cross-chat bridge.
  const _bypassChats = new Set();
  // Storm mode — global all-visible. When on, every WA arrival
  // bypasses awareness and reaches the host regardless of group
  // mention rules / personal awareness / etc. Toggled via the
  // setStorm() API from /storm in shell.
  let _storm = false;
  let lastChat       = null;
  let chatIdNotified = false;
  let myJid          = null;     // our own jid (e.g. '1234567890@s.whatsapp.net')
  let myNumber       = null;     // bare number for mention-detection
  let myLid          = null;     // our own LID jid (privacy-format identity)
  let myLidNumber    = null;     // bare number portion of myLid (for self-DM detection)
  let sock           = null;
  let reconnectTimer = null;
  let waAliveTimer   = null;
  // Exponential backoff state. Reset to 0 when 'connection: open'
  // fires; doubled on each consecutive close/connect-throw. _scheduleReconnect
  // is the single retry path — both the close handler and the
  // catch around connect() funnel through it.
  let reconnectAttempts = 0;

  // Bridge heartbeat. Same prefix as state/alive.txt:
  // "<tic|toc> <iso> <pid> ...". Details after the pid identify
  // which WA account is connected. Keep .txt so double-click opens.
  const WA_STATE_PATH = join(homedir(), '.egpt', 'state', 'whatsapp-alive.txt');
  const WA_STATE_LEGACY_PATH = join(homedir(), '.egpt', 'state', 'whatsapp-alive');
  function _waAliveDetail() {
    const pushname = sock?.user?.name ?? myNumber ?? '?';
    return [
      `pushname=${JSON.stringify(pushname)}`,
      `jid=${myJid ?? '?'}`,
      ...(myLid ? [`lid=${myLid}`] : []),
    ].join(' ');
  }
  function _writeWaState(state, detail = '') {
    // Option A: only the supervised daemon writes wa-alive.txt. Interactive
    // shells share the home but don't touch the bridge-state file — keeps
    // setup/watchdog.ps1's freshness check single-writer and unambiguous.
    if (!process.env.EGPT_SUPERVISED) return;
    try {
      mkdirSync(dirname(WA_STATE_PATH), { recursive: true });
      writeFileSync(WA_STATE_PATH, `${state} ${new Date().toISOString()} ${process.pid} ${detail}\n`.trim() + '\n', { mode: 0o600 });
    } catch (e) { /* best effort */ }
  }
  // Is there ANOTHER egpt PROCESS alive? Cooperation signal on 440 — with the
  // daemon-singleton holding, a 440 means EITHER an external WA Web client OR
  // a daemon-vs-interactive race (operator runs `node egpt.mjs` alongside the
  // headless daemon; the cross-session takeover silently no-ops on Win32).
  // Defer to any other alive egpt to break the loop (operator 2026-05-29).
  //
  // Scan BOTH heartbeat files: each one races during the fight (both processes
  // alternate truncate/append on the same path, so whichever wrote last owns
  // the file's tic/toc lines while the other's get erased). Catching the
  // other process in EITHER file is enough. Cross-session-safe via
  // defaultIsAlive (Win32 S4U detection via tasklist fallback).
  //
  // - alive.txt        — egpt process heartbeat; present whether the bridge
  //                      is up or not, but trunc-on-tic alternation between
  //                      two egpts means each is visible only ~half the time.
  // - wa-alive.txt     — bridge state; the "deferring" / "reconnecting" state
  //                      lines don't match a tic/toc regex but they DO leave
  //                      the OTHER process's tic/toc intact alongside (no
  //                      trunc), so this file often holds both pids while
  //                      one side has deferred.
  // Option A discovery (operator 2026-05-29): one ~/.egpt/ = one egpt node.
  // Only the supervised daemon writes alive.txt, so it's a clean single-
  // writer single-reader signal. An interactive shell sharing the home
  // detects the daemon via alive.txt and defers; a separate egpt node
  // lives in its own ~/.egpt-<name>/ with its own wa-auth and own alive.txt,
  // naturally parallel-safe.
  const ALIVE_TXT_PATH = join(homedir(), '.egpt', 'state', 'alive.txt');
  function _findAnotherEgpt() {
    let content = '';
    try { content = readFileSync(ALIVE_TXT_PATH, 'utf8'); } catch { return null; }
    const re = /^(?:tic|toc)\s+(\S+)\s+(\d+)/gm;
    let m;
    while ((m = re.exec(content)) !== null) {
      const ts = Date.parse(m[1]);
      const pid = Number(m[2]);
      if (!pid || pid === process.pid) continue;
      if (!Number.isFinite(ts) || Date.now() - ts > 180_000) continue;
      if (defaultIsAlive(pid)) return pid;
    }
    return null;
  }
  function _writeWaAliveNow() {
    // Single-writer: only supervised daemon (see _writeWaState comment).
    if (!process.env.EGPT_SUPERVISED) return;
    try {
      const now = new Date().toISOString();
      const beat = (label) => `${label} ${now} ${process.pid} ${_waAliveDetail()}\n`;
      let content = '';
      try { content = readFileSync(WA_STATE_PATH, 'utf8'); } catch {}
      if (/^toc /m.test(content)) writeFileSync(WA_STATE_PATH, beat('tic'), { mode: 0o600 });
      else appendFileSync(WA_STATE_PATH, beat('toc'), { mode: 0o600 });
    } catch (e) { /* best effort */ }
  }
  function _startWaAlive() {
    try { unlinkSync(WA_STATE_LEGACY_PATH); } catch {}
    _writeWaAliveNow();
    if (waAliveTimer) clearInterval(waAliveTimer);
    waAliveTimer = setInterval(_writeWaAliveNow, BRIDGE_ALIVE_INTERVAL_MS);
    waAliveTimer.unref?.();
  }
  function _stopWaAlive(state, detail = '') {
    if (waAliveTimer) { clearInterval(waAliveTimer); waAliveTimer = null; }
    if (state) _writeWaState(state, detail);
  }
  function _scheduleReconnect(reason) {
    if (stopped) return;
    if (reconnectTimer) return;            // already armed
    const delay = Math.min(RECONNECT_MS * Math.pow(2, reconnectAttempts), RECONNECT_MAX_MS);
    reconnectAttempts++;
    err(`whatsapp: ${reason}; reconnect attempt ${reconnectAttempts} in ${Math.round(delay / 1000)}s`);
    _stopWaAlive('reconnecting', reason);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      // Late-detection: another egpt may have taken WA between attempts
      // (the 440 handler's first check can race the other side's first
      // tic/toc write). Re-check here so we don't reconnect into a fight.
      // Supervised never defers (see startup-defer comment).
      const otherEgpt = process.env.EGPT_SUPERVISED ? null : _findAnotherEgpt();
      if (otherEgpt) {
        // Internal deferral — INFO, see startup defer comment.
        log(`whatsapp: reconnect deferred — another egpt (pid ${otherEgpt}) is alive. ` +
            `Outbound sends relay via the outbox.`);
        _stopWaAlive('connection_replaced', `deferring to pid ${otherEgpt}`);
        _deferredToPid = otherEgpt;
        stopped = true;
        return;
      }
      try { connect(); }
      catch (e) { _scheduleReconnect(`connect() threw: ${e.message}`); }
    }, delay);
  }

  // Chat tracker. baileys is configured with shouldSyncHistoryMessage:
  // () => false so we never get a bulk chat list on each startup —
  // we accumulate chats as messages flow through AND persist the map
  // to ~/.egpt/wa-chats.json so subsequent runs start with the same
  // view they had before. Without persistence, /channels right after
  // a shell restart would only show the one chat that had pinged
  // since boot.
  //
  // TWO timestamps per chat, deliberately separate:
  //   lastActivityTs — real message timestamp from messages.upsert.
  //                    Only set by _recordChat(..., { kind: 'activity' }).
  //                    Zero means the chat has had no traffic since
  //                    the very first time we observed it.
  //   creationTs     — set by listChats from groupFetchAllParticipating's
  //                    meta.creation. Useful as a fallback sort key
  //                    for groups we belong to but never confused
  //                    with real activity.
  // Per-chat recent ring. Capped per entry — stored alongside chat
  // metadata in _chats and persisted to disk. Used by listChats so
  // /channels can show a few lines per group ("get a feel of each
  // group" — user request). Caching them is still SILENT tracking
  // (no UI / brain / mirror) per the deliver-vs-render rule —
  // /channels is a user-pulled read, not push.
  // Per-chat recent retention. No cap — operator's policy is
  // "never lose information". Every message the bridge observes
  // stays in recent[] permanently; the splice below is a no-op.
  // wa-chats.json grows linearly with activity (~80 chars × entry
  // count); when that file ever feels too big the right fix is a
  // per-chat append-only ndjson archive (recent[] keeps the hot
  // tail, archive holds everything else), NOT a ring that
  // silently drops content.
  const RECENT_PER_CHAT = Infinity;
  const RECENT_BODY_CAP  = 200;      // chars stored per message body
  const _chats = new Map();   // jid → { jid, isGroup, lastActivityTs, creationTs, name, recent: [{ts,author,text}] }
  // Parallel msgId → short preview cache so reaction placeholders can
  // resolve the target message body ("[reaction 👍 to "buy bitcoin!"]"
  // instead of "[reaction 👍 (msg 3A9838E5)]"). Lookup is by full
  // WA stanza id (msg.key.id) which is what reactionMessage carries.
  // No cap — history is sacred. The cache grows linearly with every
  // observed message we record a body for; persists across restarts
  // via the 5s debounced disk save below.
  const _msgBodyById = new Map();
  const _MSG_BODY_CACHE_CAP = Infinity;
  // msgId → whisper.cpp transcript (string). Populated during
  // _saveMediaIfAny when audio transcription completes; consumed by
  // _enrichAudioText so handleMessage can inline the transcript into
  // the dispatched body ("[voice note: 31s] <transcript>") instead of
  // making @e read the sidecar file. Unbounded — transcripts are
  // small (~1KB typical) and bounded by audio msg count.
  const _transcriptByMsgId = new Map();
  // msgId → streaming-transcription handle ({emitter, donePromise, livePath,
  // finalPath}). Populated when a voice note arrives in streaming mode;
  // consumed by handleMessage when forwarding to onIncoming so the
  // dispatcher can subscribe to chunk events. GC'd 30s after donePromise
  // settles. Operator (2026-05-22): live voice transcription via base
  // model, chunked via ffmpeg.
  const _voiceStreamsByMsgId = new Map();
  // Per-chat transcription serializer. Voice notes in a batch are saved via
  // Promise.all (parallel), and separate upsert events overlap too — so
  // several whisper /inference calls for one chat could run at once, fighting
  // the single whisper slot and scrambling transcript order. This chains them
  // per chat so a chat's voice notes transcribe one at a time, in arrival
  // order (operator 2026-05-25). See src/serial-by-key.mjs.
  const _serializeTranscription = makeSerialByKey();
  // ── @lid name-leak diagnostic (operator 2026-05-26) ───────────────
  // For SAVED @lid contacts, WhatsApp substitutes the operator's address-book
  // label into the field baileys hands us as msg.pushName (confirmed: Diego
  // arrived as "Diego Pérez (Koma)"). UNSAVED contacts keep their real
  // pushName ("le moi"). To find a clean discriminator we keep a contacts map
  // (name=address book, notify=their pushName, verifiedName=business) fed by
  // baileys contacts.* events, and dump per-@lid-message how each field
  // compares. Lets us confirm `.notify` (or absence of `.name`) as the
  // safe source. Capped so the file can't grow unbounded.
  const _waContacts = new Map();   // jid -> { name, notify, verifiedName }
  const _NAME_DEBUG_PATH = join(STATE_BRIDGE_DIR, 'wa-name-debug.log');
  let _nameDebugCount = 0;
  const _NAME_DEBUG_CAP = 300;
  const _ingestContacts = (list) => {
    if (!Array.isArray(list)) return;
    for (const c of list) {
      if (!c?.id) continue;
      const prev = _waContacts.get(c.id) ?? {};
      _waContacts.set(c.id, {
        name: c.name ?? prev.name ?? null,
        notify: c.notify ?? prev.notify ?? null,
        verifiedName: c.verifiedName ?? prev.verifiedName ?? null,
      });
    }
  };
  const _dumpNameDebug = (msg) => {
    try {
      if (_nameDebugCount >= _NAME_DEBUG_CAP) return;
      const jid = msg?.key?.remoteJid;
      if (!jid || !String(jid).endsWith('@lid')) return;
      _nameDebugCount++;
      const c = _waContacts.get(jid) ?? {};
      const row = {
        t: new Date().toISOString(),
        jid,
        fromMe: !!msg?.key?.fromMe,
        pushName: msg?.pushName ?? null,
        verifiedBizName: msg?.verifiedBizName ?? null,
        senderPn: msg?.key?.senderPn ?? msg?.key?.participantPn ?? null,
        remoteJidAlt: msg?.key?.remoteJidAlt ?? null,
        contact_name: c.name ?? null,
        contact_notify: c.notify ?? null,
        contact_verifiedName: c.verifiedName ?? null,
      };
      appendFileSync(_NAME_DEBUG_PATH, JSON.stringify(row) + '\n', { mode: 0o600 });
    } catch { /* diagnostic only — never throw into the message path */ }
  };
  // Load persisted cache on boot — survives bridge restarts so
  // reaction enrichment can resolve parents from any session in the
  // last ~4000 messages, not just this one.
  try {
    if (existsSync(MSG_BODY_CACHE_PATH)) {
      const raw = readFileSync(MSG_BODY_CACHE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const [keyId, preview] of Object.entries(parsed)) {
          if (typeof keyId === 'string' && typeof preview === 'string') {
            _msgBodyById.set(keyId, preview);
          }
        }
      }
    }
  } catch (e) { console.error(`!! whatsapp.mjs:[catch] ${e?.message ?? e}`); /* corrupt cache file is non-fatal — just start fresh */ }
  let _msgBodyDirty = false;
  let _msgBodySaveTimer = null;
  function _scheduleMsgBodySave() {
    if (!_msgBodyDirty) return;
    if (_msgBodySaveTimer) return;
    _msgBodySaveTimer = setTimeout(() => {
      _msgBodySaveTimer = null;
      _msgBodyDirty = false;
      try {
        const obj = Object.fromEntries(_msgBodyById.entries());
        writeFileSync(MSG_BODY_CACHE_PATH, JSON.stringify(obj), { mode: 0o600 });
      } catch (e) { console.error(`!! whatsapp.mjs:[catch] ${e?.message ?? e}`); /* swallow — best-effort persistence */ }
    }, 5_000);
  }
  function _rememberMsgBody(keyId, body) {
    if (!keyId || !body || typeof body !== 'string') return;
    // Don't memoize reaction-event bodies — a reaction-of-a-reaction
    // preview is not interesting context. Matches both legacy
    // `[reaction 👍 to "…"]` form and the new event-style `reacted 👍 to "…"`.
    if (body.startsWith('[reaction ') || body.startsWith('reacted ') || body.startsWith('removed reaction ')) return;
    const oneLine = body.replace(/\s+/g, ' ').trim();
    if (!oneLine) return;
    const preview = oneLine.length > 60 ? oneLine.slice(0, 59) + '…' : oneLine;
    if (_msgBodyById.get(keyId) === preview) return;   // no-op
    _msgBodyById.set(keyId, preview);
    if (_msgBodyById.size > _MSG_BODY_CACHE_CAP) {
      // Drop the oldest insertion. Map preserves insertion order.
      const firstKey = _msgBodyById.keys().next().value;
      _msgBodyById.delete(firstKey);
    }
    _msgBodyDirty = true;
    _scheduleMsgBodySave();
  }
  // Enrich a reaction placeholder with the target body when we know it.
  // textOf produces '[reaction <emoji> (msg <id8>)]'; this swaps the
  // truncated id for a short quoted preview of the referenced message.
  // Falls through unchanged when the target isn't in our cache (history
  // older than session start, or a chat we haven't observed before).
  // Enrich an audio placeholder ('[voice note: 8s]' / '[audio: 31s]')
  // with the whisper.cpp transcript when a sidecar exists. The
  // sidecar is written by _transcribeAudio synchronously inside
  // _saveMediaIfAny, so by the time handleMessage runs (which is
  // awaited AFTER the save Promise.all), the file is on disk.
  // Pattern: append the transcript after the bracketed placeholder
  // (keeping the placeholder visible so @e knows the source is audio).
  // No-op if no audioMessage / no sidecar / read fails.
  function _enrichAudioText(rawText, msg) {
    if (!rawText) return rawText;
    // Only enrich when the underlying message is audio (peel envelopes).
    const m = msg?.message ?? {};
    const inner = m.audioMessage
      ?? m.ephemeralMessage?.message?.audioMessage
      ?? m.viewOnceMessage?.message?.audioMessage
      ?? m.viewOnceMessageV2?.message?.audioMessage
      ?? null;
    if (!inner) return rawText;
    const chatJid = msg?.key?.remoteJid;
    const msgId = msg?.key?.id;
    if (!chatJid || !msgId) return rawText;
    // Look up base from the media-index for this chat (written by
    // _saveMediaIfAny). The index ties msgId → filename so we don't
    // have to recompute the slug-stamp here.
    const dir = _mediaDirFor(chatJid);
    let base = null;
    try {
      const idx = JSON.parse(readFileSync(join(dir, '.media-index.json'), 'utf8'));
      base = idx[msgId]?.base ?? null;
    } catch (e) { console.error(`!! whatsapp.mjs:[catch] ${e?.message ?? e}`); /* no index yet */ }
    if (!base) return rawText;
    const txtPath = join(dir, `${base}.transcript.txt`);
    if (!existsSync(txtPath)) return rawText;
    let transcript = null;
    try { transcript = readFileSync(txtPath, 'utf8').trim(); }
    catch (e) { console.error(`!! whatsapp.mjs:[catch] ${e?.message ?? e}`); return rawText; }
    if (!transcript) return rawText;
    // Brain dispatch body: JUST the transcript text. The "(transcript
    // from voice note)" annotation gets added by formatPersonaPrompt
    // via meta.isTranscript flag (set by handleMessage when it
    // detects audioMessage). The sugar — animated 👂 message,
    // pushName, duration, timestamp — is for chat members visible in
    // WA, not for the brain. Operator 2026-05-23: "this '👂 Daniel
    // 12s @ 14:35:' and the animation is sugar for members."
    // Replace the placeholder with an explicit transcript tag + the text, so a
    // text-only brain (@l) knows the words ARE a voice transcript and how long
    // the note was (operator 2026-05-25). Keeps any ↳ quoted-preview prefix.
    return rawText.replace(/\[(?:voice note|audio):\s*(\d+)\s*s?\]/i,
      (_m, secs) => `[voice note transcript, total duration: ${secs}s] ${transcript}`);
  }

  // Append the saved file path to image placeholders so @e can use
  // its Read tool to actually view the image (Claude Read supports
  // image inputs). On-demand viewing — no per-message image token
  // cost up front. Body becomes '[image] <caption> path: /...'.
  function _enrichImageText(rawText, msg) {
    if (!rawText) return rawText;
    const m = msg?.message ?? {};
    const inner = m.imageMessage
      ?? m.ephemeralMessage?.message?.imageMessage
      ?? m.viewOnceMessage?.message?.imageMessage
      ?? m.viewOnceMessageV2?.message?.imageMessage
      ?? m.documentWithCaptionMessage?.message?.imageMessage
      ?? null;
    if (!inner) return rawText;
    const chatJid = msg?.key?.remoteJid;
    const msgId = msg?.key?.id;
    if (!chatJid || !msgId) return rawText;
    const dir = _mediaDirFor(chatJid);
    let imgPath = null;
    try {
      const idx = JSON.parse(readFileSync(join(dir, '.media-index.json'), 'utf8'));
      imgPath = idx[msgId]?.path ?? null;
    } catch (e) { console.error(`!! whatsapp.mjs:[catch] ${e?.message ?? e}`); /* no index yet */ }
    if (!imgPath || !existsSync(imgPath)) return rawText;
    return `${rawText} path: ${imgPath}`;
  }

  // Append video file path + keyframe path + audio transcript (if
  // any) to video placeholders. @e Reads the keyframe JPG to "see"
  // the visual content (Claude Read supports JPG/PNG); the audio
  // transcript covers spoken content. Body becomes
  // '[video] <caption> path: /<video> keyframe: /<jpg> transcript: <text>'.
  function _enrichVideoText(rawText, msg) {
    if (!rawText) return rawText;
    const m = msg?.message ?? {};
    const inner = m.videoMessage
      ?? m.ephemeralMessage?.message?.videoMessage
      ?? m.viewOnceMessage?.message?.videoMessage
      ?? m.viewOnceMessageV2?.message?.videoMessage
      ?? null;
    if (!inner) return rawText;
    const chatJid = msg?.key?.remoteJid;
    const msgId = msg?.key?.id;
    if (!chatJid || !msgId) return rawText;
    const dir = _mediaDirFor(chatJid);
    let base = null, vidPath = null;
    try {
      const idx = JSON.parse(readFileSync(join(dir, '.media-index.json'), 'utf8'));
      base = idx[msgId]?.base ?? null;
      vidPath = idx[msgId]?.path ?? null;
    } catch (e) { console.error(`!! whatsapp.mjs:[catch] ${e?.message ?? e}`); /* no index yet */ }
    if (!base) return rawText;
    const extras = [];
    if (vidPath && existsSync(vidPath)) extras.push(`path: ${vidPath}`);
    const keyframePath = join(dir, `${base}.keyframe.jpg`);
    if (existsSync(keyframePath)) extras.push(`keyframe: ${keyframePath}`);
    const txtPath = join(dir, `${base}.transcript.txt`);
    if (existsSync(txtPath)) {
      try {
        const transcript = readFileSync(txtPath, 'utf8').trim();
        if (transcript) extras.push(`transcript: ${transcript}`);
      } catch (e) { console.error(`!! whatsapp.mjs:[catch] ${e?.message ?? e}`); }
    }
    if (extras.length === 0) return rawText;
    return `${rawText} ${extras.join(' ')}`;
  }

  function _enrichReactionText(rawText, msg) {
    const r = msg?.message?.reactionMessage;
    if (!r?.key?.id) return rawText;
    let target = _msgBodyById.get(r.key.id);
    let targetAuthor = null;
    let targetTs = null;
    if (!target) {
      // Fallback: scan every observed chat's recent[] for an entry
      // with the same key.id. Covers parents older than the in-memory
      // _msgBodyById cache (it only fills as messages arrive this
      // session, so reactions to anything from before a bridge
      // restart kept landing as opaque placeholders).
      for (const c of _chats.values()) {
        const hit = c.recent?.find(rr => rr.key?.id === r.key.id);
        if (hit?.text) {
          target = hit.text;
          targetAuthor = hit.author ?? null;
          targetTs = hit.ts ?? null;
          break;
        }
      }
    } else {
      // _msgBodyById is body-only; pull author/ts from recent[] if
      // available for the same key.
      for (const c of _chats.values()) {
        const hit = c.recent?.find(rr => rr.key?.id === r.key.id);
        if (hit) {
          targetAuthor = targetAuthor ?? hit.author ?? null;
          targetTs = targetTs ?? hit.ts ?? null;
          break;
        }
      }
    }
    if (!target) return rawText;
    // Snip the parent preview so reaction lines stay readable —
    // anything over ~60 chars dominates the row and obscures the
    // reaction itself.
    const oneLine = String(target).replace(/\s+/g, ' ').trim();
    const snippet = oneLine.length > 60 ? oneLine.slice(0, 59) + '…' : oneLine;
    const emoji = r.text || '·';
    // Verb-form so the auto-dispatch envelope reads as an event,
    // not a content placeholder. Compare:
    //   OLD: [An@compren.wa (16:06)]: [reaction 😂 to "X"]
    //   NEW: [An@compren.wa (16:06)]: reacted 😂 to "X" (Pancho at 14:21)
    // Target author/timestamp included when available so @e can
    // tell whether the reaction is to a fresh or old message.
    const tsSuffix = (() => {
      if (!targetTs) return '';
      const d = new Date(targetTs);
      const pad = (n) => String(n).padStart(2, '0');
      const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      return targetAuthor ? ` (${targetAuthor} at ${hhmm})` : ` (at ${hhmm})`;
    })();
    // Operator (2026-05-21): "reactions should reach @e too."
    // For operator's own reactions (fromMe), prepend "@e " so the
    // router dispatches them to @e / system-e (per personality of
    // the target chat). Others' reactions stay plain — only the
    // operator's reactions wake the brain.
    const body = r.text
      ? `reacted ${emoji} to "${snippet}"${tsSuffix}`
      : `removed reaction from "${snippet}"${tsSuffix}`;
    return msg?.key?.fromMe ? `@e ${body}` : body;
  }

  // Phase 2: reaction counts. Persisted across bridge restarts and
  // reset by the interactive shell on logon (after rendering the
  // "most-reacted" line in its summary). Keyed by target msgId.
  // Entry: { count, emojis: { '👍': 3, '❤️': 1 }, preview, chatJid, lastTs }.
  // count = total non-removal reactions (including changes); emojis
  // tracks each distinct emoji's total. Caps at REACTION_COUNTS_CAP
  // by dropping oldest insertion when full.
  const _reactionCounts = new Map();
  try {
    if (existsSync(REACTION_COUNTS_PATH)) {
      const raw = await fs.readFile(REACTION_COUNTS_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const [msgId, entry] of Object.entries(parsed)) {
          if (msgId && entry && typeof entry === 'object') _reactionCounts.set(msgId, entry);
        }
      }
    }
  } catch (e) { console.error(`!! whatsapp.mjs:[catch] ${e?.message ?? e}`); /* corrupt — start empty */ }

  let _reactionsWriteTimer = null;
  function _scheduleReactionsWrite() {
    if (_reactionsWriteTimer) return;
    _reactionsWriteTimer = setTimeout(async () => {
      _reactionsWriteTimer = null;
      try {
        // Cap by recency (lastTs). Oldest entries fall off when over cap.
        const all = [..._reactionCounts.entries()]
          .sort((a, b) => (b[1].lastTs || 0) - (a[1].lastTs || 0))
          .slice(0, REACTION_COUNTS_CAP);
        const obj = Object.fromEntries(all);
        await fs.mkdir(dirname(REACTION_COUNTS_PATH), { recursive: true });
        await fs.writeFile(REACTION_COUNTS_PATH, JSON.stringify(obj, null, 2), { mode: 0o600 });
      } catch (e) { console.error(`!! whatsapp.mjs:[catch] ${e?.message ?? e}`); /* best-effort */ }
    }, 2_000);
    _reactionsWriteTimer.unref?.();
  }

  // Record a single reaction observation. Called from handleMessage
  // when message.reactionMessage is present. Removals (empty r.text)
  // don't bump count — they signal a takeback, not a fresh reaction.
  function _recordReaction(msg) {
    const r = msg?.message?.reactionMessage;
    if (!r?.key?.id) return;
    const emoji = r.text;
    if (!emoji) return;        // removal — ignore
    const targetId = r.key.id;
    const chatJid = msg.key?.remoteJid ?? null;
    const ts = (Number(msg.messageTimestamp) || 0) * 1000 || Date.now();
    const prev = _reactionCounts.get(targetId)
      ?? { count: 0, emojis: {}, preview: null, chatJid, lastTs: 0 };
    prev.count = (prev.count || 0) + 1;
    prev.emojis = { ...(prev.emojis ?? {}) };
    prev.emojis[emoji] = (prev.emojis[emoji] ?? 0) + 1;
    if (!prev.preview) prev.preview = _msgBodyById.get(targetId) ?? null;
    if (!prev.chatJid) prev.chatJid = chatJid;
    prev.lastTs = Math.max(prev.lastTs || 0, ts);
    _reactionCounts.set(targetId, prev);
    _scheduleReactionsWrite();
  }

  // Load persisted chats on bridge start. Silently best-effort —
  // missing file / corrupt JSON just yields an empty map and we
  // accumulate fresh. The pre-existing wa-auth directory next to
  // the cache is mature, so adding a JSON next to it doesn't move
  // the trust boundary.
  try {
    if (existsSync(CHATS_CACHE_PATH)) {
      const raw = await fs.readFile(CHATS_CACHE_PATH, 'utf8');
      const entries = JSON.parse(raw);
      if (Array.isArray(entries)) {
        for (const c of entries) {
          if (c && typeof c.jid === 'string') {
            // Repaint the rotating contact name that pre-fix builds had
            // pinned on status@broadcast; the JID itself is preserved so
            // the recent[] history of who posted what stays intact.
            // Same defensive scrub for groups: pre-fix builds stored
            // the first-speaker's pushName as the chat name (so a
            // group could surface as "Mauricio" or even "m"). Drop
            // any name that doesn't look like a real subject when
            // loaded from disk — _ensureGroupName re-fetches the
            // proper subject on the next message in that chat.
            let loadedName = c.jid === 'status@broadcast'
              ? '(WA status updates)'
              : (typeof c.name === 'string' ? c.name : null);
            // Privacy (operator 2026-05-26): a DM's persisted name may be the
            // operator's address-book label, contaminated via a contacts /
            // history sync for saved @lid contacts ("Diego Pérez (Koma)").
            // Drop every non-group, non-status DM name on load — leave only the
            // id. A live message's pushName refills it from then on.
            if (loadedName && c.jid !== 'status@broadcast' && !c.jid?.endsWith?.('@g.us')) {
              loadedName = null;
            }
            if (c.jid?.endsWith?.('@g.us') && loadedName && loadedName.length <= 2) {
              loadedName = null;
            }
            _chats.set(c.jid, {
              jid: c.jid,
              isGroup: !!c.isGroup,
              lastActivityTs: Number(c.lastActivityTs) || 0,
              creationTs:     Number(c.creationTs)     || 0,
              name: loadedName,
              recent: Array.isArray(c.recent)
                ? c.recent.filter(r => r && typeof r.text === 'string').slice(-RECENT_PER_CHAT)
                : [],
              // Phase 2 logon-summary counters. messageCount: every
              // activity tick (caps at the chat level, not recent[]'s
              // 10-deep ring). broadcastsByAuthor: per-author count
              // for status@broadcast only (the "who posted stories"
              // breakdown). Both reset by the interactive shell on
              // takeover so the summary covers "since last logon".
              messageCount: Number(c.messageCount) || 0,
              broadcastsByAuthor: (c.jid === 'status@broadcast' && c.broadcastsByAuthor && typeof c.broadcastsByAuthor === 'object')
                ? { ...c.broadcastsByAuthor } : {},
              pinned: Number(c.pinned) || 0,
              // egptPinned: eGPT-side pin layer, additive with WA's
              // 3-chat phone-side limit. /pin @waN sets a timestamp;
              // /unpin clears it. Independent of WA's `pinned`, both
              // contribute to the "is this chat pinned" decision.
              egptPinned: Number(c.egptPinned) || 0,
            });
          }
        }
      }
    }
  } catch (e) { console.error(`!! whatsapp.mjs:[catch] ${e?.message ?? e}`); /* corrupt / unreadable — fall through to empty */ }

  // Debounced write. Many messages can arrive in a burst; we don't
  // need to fsync after each one. 2s lets a burst settle, then one
  // write captures the resulting state. The unref() keeps the timer
  // from blocking process exit.
  let _chatsWriteTimer = null;
  function _scheduleChatsWrite() {
    if (_chatsWriteTimer) return;
    _chatsWriteTimer = setTimeout(async () => {
      _chatsWriteTimer = null;
      try {
        // Cap by most-recent activity; truly idle entries fall off.
        const all = [..._chats.values()].sort((a, b) =>
          (b.lastActivityTs || b.creationTs) - (a.lastActivityTs || a.creationTs));
        const trimmed = all.slice(0, CHATS_CACHE_CAP);
        await fs.mkdir(dirname(CHATS_CACHE_PATH), { recursive: true });
        await fs.writeFile(CHATS_CACHE_PATH, JSON.stringify(trimmed, null, 2), { mode: 0o600 });
      } catch (e) { console.error(`!! whatsapp.mjs:[catch] ${e?.message ?? e}`); /* best-effort; in-memory state still works */ }
    }, 2_000);
    _chatsWriteTimer.unref?.();
  }

  function _recordChat({ jid, isGroup, name = null, ts = 0, kind = 'activity', author = null, body = null, key = null, pinned = undefined, live = false }) {
    // `live` discriminates real-time arrivals (messages.upsert type=='notify')
    // from bulk history backfill (messages.upsert type=='append'/'prepend',
    // messaging-history.set). The logon-summary counters (messageCount,
    // broadcastsByAuthor) ONLY bump for live=true — otherwise a re-pair
    // or restart that triggers a big history sync inflates the count to
    // tens of thousands. Default false so callers that genuinely just
    // need to record a chat (chats.upsert metadata, group-creation) don't
    // need to think about it.
    if (!jid) return;
    // status@broadcast is WhatsApp's global status-updates feed: every
    // contact's 24h stories arrive on this single JID with their own
    // pushName attached. We keep the data (useful later for per-contact
    // personality analysis of what each contact posts to status) but
    // pin the chat name to a stable label so the messages.upsert name-
    // flip rule doesn't paint a rotating contact name over the slot.
    // Visibility in /channels is handled in listChats.
    if (jid === 'status@broadcast') {
      name = '(WA status updates)';
    }
    const cur = _chats.get(jid) ?? {
      jid, isGroup, lastActivityTs: 0, creationTs: 0, name: null, recent: [],
      messageCount: 0, broadcastsByAuthor: {}, pinned: 0, egptPinned: 0,
    };
    if (!Array.isArray(cur.recent)) cur.recent = [];
    if (typeof cur.messageCount !== 'number') cur.messageCount = 0;
    if (!cur.broadcastsByAuthor || typeof cur.broadcastsByAuthor !== 'object') cur.broadcastsByAuthor = {};
    if (typeof cur.pinned !== 'number') cur.pinned = 0;
    if (typeof cur.egptPinned !== 'number') cur.egptPinned = 0;
    cur.isGroup = isGroup;
    if (kind === 'activity') cur.lastActivityTs = Math.max(cur.lastActivityTs, ts);
    else if (kind === 'creation') cur.creationTs = Math.max(cur.creationTs, ts);
    if (name) cur.name = name;
    // Pinned state. baileys uses pin = <ms since epoch when pinned>,
    // 0/undefined when not. We mirror that: explicit 0 to unpin,
    // positive number to pin, undefined to leave unchanged. Matters
    // for listChats ordering and the logon-summary "📌" indicator
    // — WA's own UI surfaces pinned chats at the top of the list,
    // so doing the same here matches the operator's mental model.
    if (typeof pinned === 'number') cur.pinned = pinned > 0 ? pinned : 0;
    // Append a recent-message entry when we have a real body. Dedupe
    // by ts+author+key so the same row arriving via both messages.upsert
    // and messaging-history.set doesn't double-count. Storing the WA
    // message key lets prefetchHistoryForTopChats anchor a deeper
    // sock.fetchMessageHistory call later.
    if (body && typeof body === 'string' && ts > 0) {
      const trimmed = body.trim();
      if (trimmed) {
        const text = trimmed.length > RECENT_BODY_CAP
          ? trimmed.slice(0, RECENT_BODY_CAP - 1) + '…'
          : trimmed;
        const keyId = key?.id ?? null;
        // Feed the reaction-target preview cache. Independent of the
        // recent[] ring — that one is for /channels (per-chat,
        // newest 10); _msgBodyById is for reaction lookups (cross-
        // chat, ~4k cap, longer time horizon).
        if (keyId) _rememberMsgBody(keyId, trimmed);
        const dupe = cur.recent.some(r =>
          (keyId && r.key?.id === keyId) ||
          (r.ts === ts && r.author === author && r.text === text));
        if (!dupe) {
          const entry = { ts, author: author ?? null, text };
          if (keyId) entry.key = { id: keyId, fromMe: !!key.fromMe };
          cur.recent.push(entry);
          // Keep newest at the end. Sort + slice to cap.
          cur.recent.sort((a, b) => a.ts - b.ts);
          if (cur.recent.length > RECENT_PER_CHAT) {
            cur.recent.splice(0, cur.recent.length - RECENT_PER_CHAT);
          }
          // Logon-summary counters: bump ONLY for live arrivals. The
          // dedupe above already drops most history replays, but baileys's
          // history sync after re-pair / restart can still deliver tens
          // of thousands of unique-keyed messages that pre-fix would
          // inflate messageCount to "76k since last logon" garbage.
          // `live` is true only when called from messages.upsert with
          // type==='notify' or from handleMessage (the LOUD path); every
          // other call site (history.set, prepend, chats.upsert) leaves
          // it false and the counter stays untouched.
          if (kind === 'activity' && live) {
            cur.messageCount += 1;
            if (jid === 'status@broadcast' && author) {
              cur.broadcastsByAuthor[author] = (cur.broadcastsByAuthor[author] ?? 0) + 1;
            }
          }
        }
      }
    }
    _chats.set(jid, cur);
    _scheduleChatsWrite();
  }

  // libsignal (the signal-protocol package baileys depends on) emits
  // session-management dumps via console.info / console.warn / .log /
  // .error directly — bypassing baileys's pino-silencer. Patch the
  // four console methods while the bridge is active. Any call whose
  // first arg starts with a known libsignal prefix is dropped; the
  // rest pass through unchanged.
  // Source for the prefixes: node_modules/libsignal/src/{session_record,
  // session_cipher, session_builder, queue_job, curve}.js.
  const _origLog   = console.log;
  const _origInfo  = console.info;
  const _origWarn  = console.warn;
  const _origError = console.error;
  const NOISE_PREFIXES = [
    'Closing session',          // session_record close
    'Opening session',          // session_record open
    'Closing open session',     // session_builder
    'Closing stale open session', // session_builder
    'Removing old closed session', // session_record
    'Migrating session',        // session_record
    'Session already closed',
    'Session already open',
    'Decrypted message with closed session',
    'Failed to decrypt message',
    'Session error',
    'V1 session storage migration error',
    'Unhandled bucket type',
    'WARNING: Expected pubkey',
  ];
  const isLibsignalNoise = (...args) => {
    const first = args[0];
    if (typeof first !== 'string') return false;
    return NOISE_PREFIXES.some(p => first.startsWith(p));
  };
  console.log   = (...args) => { if (!isLibsignalNoise(...args)) _origLog(...args); };
  console.info  = (...args) => { if (!isLibsignalNoise(...args)) _origInfo(...args); };
  console.warn  = (...args) => { if (!isLibsignalNoise(...args)) _origWarn(...args); };
  console.error = (...args) => { if (!isLibsignalNoise(...args)) _origError(...args); };
  // Track WAMessage IDs we sent ourselves so we can filter the
  // echoes WhatsApp sends back to all linked devices AND so the
  // reply-as-mention detection works for ANY past bot message —
  // not just the last N seconds. Persisted at ~/.egpt/wa-sent.jsonl
  // (load on bridge start, append on each send) so a daemon restart
  // does not amnesia the history. Operator can rm the file to reset;
  // bridge rebuilds from the next send onward.
  const SENT_LOG = join(STATE_BRIDGE_DIR, 'wa-sent.jsonl');
  _migratePathOnce(join(homedir(), '.egpt', 'wa-sent.jsonl'), SENT_LOG);
  const _sentIds = new Map();    // id -> ts
  try {
    const raw = readFileSync(SENT_LOG, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const { id, ts } = JSON.parse(line);
        if (id) _sentIds.set(id, ts ?? 0);
      } catch (e) { console.error(`!! whatsapp.mjs:[catch] ${e?.message ?? e}`); /* skip malformed lines */ }
    }
  } catch (e) { console.error(`!! whatsapp.mjs:[catch] ${e?.message ?? e}`); /* file missing on first run; created lazily by rememberSent */ }
  function rememberSent(id) {
    if (!id) return;
    if (_sentIds.has(id)) return;                  // dedupe re-tracks
    const ts = Date.now();
    _sentIds.set(id, ts);
    // Async append; in-memory map is already updated above so
    // concurrent reads see the new id immediately.
    fs.appendFile(SENT_LOG, JSON.stringify({ id, ts }) + '\n').catch(e => console.error(`!! whatsapp.mjs:[promise-catch] ${e?.message ?? e}`));
  }

  // Override baileys' default auto-extraction of @<digits> patterns
  // from outgoing message text into contextInfo.mentionedJid. Without
  // this, a reply that quotes or echoes any text containing a
  // phone-shaped token (e.g. "@4290722676802 dijo…") silently sets
  // mentionedJid for those numbers — which WhatsApp renders as @-
  // mention notifications to every matching member of the chat,
  // regardless of their in-app mute settings. Operators in a 17-
  // person group reported: "every reply notifies everyone".
  //
  // mentions:[] explicitly tells baileys NO mentions on this
  // message, period. The wrapper only adds it when the payload
  // carries user-visible text (text / edit); react / delete have
  // no body and skip the override.
  function _safeSend(target, payload, opts) {
    if (payload?.text !== undefined || payload?.edit !== undefined) {
      payload = { ...payload, mentions: [] };
    }
    return opts ? sock.sendMessage(target, payload, opts) : sock.sendMessage(target, payload);
  }

  function connect() {
    if (stopped) { _blog('connect(): SKIPPED — stopped'); return; }
    _blog('connect(): called');
    // STARTUP DEFERRAL: an interactive shell has no business taking control of
    // WA when the daemon already has it. Pre-fix we would start baileys, get
    // a 440 from the daemon's session being replaced (then the daemon would
    // 440 us back), generate a brief flurry of "external WA Web client" log
    // spam before the cooperative defer converged, and waste the cost of an
    // auth handshake just to immediately defer. Check FIRST — if another
    // egpt is already alive, defer without ever opening a socket. send()
    // will relay outbound through the outbox (operator 2026-05-29: "no
    // business in trying to take control if there is a daemon").
    //
    // The SUPERVISED daemon NEVER defers. The egpt-daemon.mjs singleton
    // guarantees no other supervised egpt is running, so any 'other egpt'
    // is an interactive shell that we should take from (the shell will
    // defer to us on its next reconnect attempt), or an external WA Web
    // contender (Beeper, etc.) — neither is a fight loop to avoid.
    const otherEgpt = process.env.EGPT_SUPERVISED ? null : _findAnotherEgpt();
    if (otherEgpt) {
      log(`whatsapp: another egpt process (pid ${otherEgpt}) already alive — ` +
          `not starting our bridge. Outbound sends relay via the outbox; ` +
          `inbound is handled by pid ${otherEgpt}. /whatsapp start to claim ` +
          `WA locally if that one /exits first.`);
      _stopWaAlive('connection_replaced', `startup defer to pid ${otherEgpt}`);
      _deferredToPid = otherEgpt;
      stopped = true;
      _blog(`connect(): STARTUP DEFER to pid ${otherEgpt} — no socket opened`);
      return;
    }
    _blog('connect(): opening socket (makeWASocket)');
    sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      // Identifies us in WhatsApp's Settings -> Linked devices list
      // as 'egpt' instead of the default 'Chrome'.
      browser: ['egpt', 'Chrome', '0.2.0'],
      // Logger: silence baileys's pino output unless something is wrong.
      logger: silentLogger(),
      // Sync history so we learn about chats that exist beyond the
      // ones that ping us since boot — otherwise /channels right
      // after a fresh start can only return the one or two chats
      // that have happened to send something. We DON'T pipe the bulk
      // history through onIncoming (the messages.upsert type filter
      // below skips 'prepend'); we just record the chat sightings.
      shouldSyncHistoryMessage: () => true,
    });

    sock.ev.on('creds.update', saveCreds);

    // Contacts feed for the @lid name-leak diagnostic. We only READ this to
    // compare .name (address book) vs .notify (their pushName); nothing
    // user-facing consumes it yet.
    sock.ev.on('contacts.upsert', (c) => _ingestContacts(c));
    sock.ev.on('contacts.update', (c) => _ingestContacts(c));
    sock.ev.on('contacts.set', (arg) => _ingestContacts(Array.isArray(arg) ? arg : arg?.contacts));

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        _writeWaState('pairing', 'qr');
        // Render QR to a string so Ink can print it cleanly,
        // instead of qrcode-terminal writing directly to stdout (which
        // tangles with Ink's render). Route to onQR when provided so
        // the host can surface it in a visible UI; fall back to
        // onLog for backwards compat with older hosts.
        qrcode.generate(qr, { small: true }, (qrText) => {
          const msg = 'whatsapp: scan this QR (WhatsApp → Settings → Linked devices → Link a device):\n' + qrText;
          if (typeof onQR === 'function') { try { onQR(qrText, msg); return; } catch (e) { console.error(`!! whatsapp.mjs:[catch] ${e?.message ?? e}`); } }
          log(msg);
        });
      }
      if (connection === 'open') {
        myJid = sock.user?.id ?? null;          // e.g. '1234567890:42@s.whatsapp.net' (with device id)
        myNumber = myJid?.split(':')[0]?.split('@')[0] ?? null;
        // LID is WhatsApp's privacy-format identity. The user's own
        // self-DM frequently arrives addressed as '<lidNumber>@lid'
        // instead of '<phoneNumber>@s.whatsapp.net' — without
        // capturing the LID we can't tell the LID self-DM apart from
        // any random group/contact, which breaks chat_id auto-
        // capture and the egpt-chat detection on the host side.
        myLid = sock.user?.lid ?? null;
        myLidNumber = myLid?.split(':')[0]?.split('@')[0] ?? null;
        connectedAt = Date.now();
        // Healthy connect — clear backoff so the NEXT close starts
        // at the base 5s delay again, not wherever it left off.
        reconnectAttempts = 0;
        // Clear any prior deferral state — we have a real session now, so
        // future send()s go through baileys, not the outbox.
        _deferredToPid = null;
        const display = sock.user?.name ?? myNumber ?? '?';
        log(`whatsapp: connected as ${display} (${myNumber}${myLidNumber ? `, lid ${myLidNumber}` : ''})`);
        _blog(`connection OPEN — connected as ${display} (${myNumber}${myLidNumber ? `, lid ${myLidNumber}` : ''})`);
        _startWaAlive();
        // Heal stale group names. Pre-fix bridge builds wrote the
        // first-speaker's pushName into the chat name for groups, so
        // a group's cached label could end up as a person's name
        // (e.g. "Andres" or "Mauricio"). That polluted the @<slug>.wa
        // segment of every speaker's handle in that group. Fire a
        // one-shot proactive refresh against the server to overwrite
        // every group's cached name with its real subject. Runs in
        // the background — doesn't block connect.
        _refreshAllGroupNames();
      }
      if (connection === 'close') {
        const reason = lastDisconnect?.error?.output?.statusCode;
        _blog(`connection CLOSE — reason=${reason ?? '?'} (${lastDisconnect?.error?.message ?? 'no message'})`);
        if (reason === DisconnectReason.loggedOut) {
          err(`whatsapp: logged out — delete ${authDir} and restart to re-pair`);
          _stopWaAlive('logged_out', `reason ${reason}`);
          stopped = true;
          return;
        }
        // 440 = connectionReplaced. WA's server has another session
        // authenticated with these credentials. Historically we treated
        // this as a self-conflict (a second egpt daemon fighting over the
        // session) and disabled auto-reconnect to avoid a fight loop. The
        // daemon-singleton (src/daemon-singleton.mjs, cross-session-aware
        // since 2026-05-28) now PROVES we're alone, so 440 must be
        // EXTERNAL — your phone's WA Web link, a browser tab on
        // whatsapp.com, or the Chrome extension's WA-CDP. Keep retrying:
        // the external client will eventually release (you close the tab,
        // refresh the phone link) and the next reconnect attempt wins.
        // _scheduleReconnect's exponential backoff caps at RECONNECT_MAX_MS,
        // so this isn't a hot loop — just patient reattempts.
        if (reason === DisconnectReason.connectionReplaced || reason === 440) {
          // Distinguish internal (another egpt has WA) from external (phone,
          // browser tab, extension). Daemon-singleton makes self-conflicts
          // structurally impossible AT THE DAEMON LEVEL, but a user can still
          // run `node egpt.mjs` (the app, not the supervisor) alongside the
          // headless daemon — the pidfile-handshake takeover is supposed to
          // hand WA between them, but its process.kill is cross-session
          // and silently no-ops against the S4U daemon on Win32. So check
          // here and defer to the other egpt if found; the operator can /exit
          // one of them to converge.
          // Supervised daemon never defers (see startup-defer comment).
          const otherEgpt = process.env.EGPT_SUPERVISED ? null : _findAnotherEgpt();
          if (otherEgpt) {
            // Internal deferral — INFO, not an error. Goes to /log only so it
            // doesn't pollute the shell. The send() relay through the outbox
            // is the user-facing visible behavior ("hello reached WA"); the
            // operator doesn't need to be told the plumbing on every 440.
            log(`whatsapp: connection replaced (reason 440) — another egpt (pid ${otherEgpt}) ` +
                `is alive. Deferring; outbound sends relay via the outbox.`);
            _stopWaAlive('connection_replaced', `reason ${reason} — deferring to pid ${otherEgpt}`);
            _deferredToPid = otherEgpt;
            stopped = true;
            return;
          }
          err('whatsapp: connection replaced (reason 440) — another WA Web client ' +
              'holds the session (your phone, a browser tab on whatsapp.com, or the ' +
              'extension). Reconnecting with backoff; close the other client to recover.');
          _stopWaAlive('connection_replaced', `reason ${reason}`);
          _scheduleReconnect(`connection replaced (reason ${reason})`);
          return;
        }
        _stopWaAlive('closed', `reason ${reason ?? '?'}`);
        // Other close reasons: funnel through _scheduleReconnect —
        // backoff retry, operator-visible errOut, and recovery from
        // a connect() that throws synchronously.
        _scheduleReconnect(`connection closed (reason ${reason ?? '?'})`);
      }
    });

    // TWO SEPARATE TRACKS in this handler. The pre-record loop is
    // SILENT — it updates an in-memory Map (with a debounced disk
    // write) so /channels has a chat list to show. The downstream
    // call to handleMessage is the LOUD path — it renders the
    // message in the shell UI, mirrors it to other bridges, and
    // possibly dispatches to a brain. We MUST NOT conflate them:
    // bulk history (type='prepend') must reach the silent tracker
    // for /channels coverage but must NOT reach handleMessage, or
    // the user gets flooded with the last hour of group chatter and
    // (worse) the brain receives a stream of stale messages as if
    // they were live questions.
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (debug) {
        for (const m of messages) {
          const peek = textOf(m.message ?? {})?.slice(0, 60) ?? null;
          log(`whatsapp[debug]: upsert type=${type} jid=${m.key?.remoteJid} fromMe=${!!m.key?.fromMe} id=${m.key?.id} text=${JSON.stringify(peek)}`);
        }
      }
      // — SILENT track — every row, regardless of type, feeds the
      // chat-list tracker. No UI, no onIncoming, no brain dispatch.
      // We extract the body here to keep a small recent-messages ring
      // per chat so /channels can surface a few lines as preview.
      // The ring is a state cache the user pulls via /channels — not
      // a push: it never auto-renders, never reaches a brain, never
      // mirrors to other bridges. Same rule as the chat-list itself.
      for (const m of messages) {
        const jid = m.key?.remoteJid;
        if (!jid) continue;
        // Edit envelope: WhatsApp wraps message edits in protocolMessage
        // with a new outer key.id but the ORIGINAL message's key in
        // protocolMessage.key. Without folding edits onto the original
        // recent[] entry, a brain stream that fires N edits during its
        // typing cycle piles up as N nearly-identical rows in /recap
        // (one per debounced edit — typically 4-10 per response).
        // Update the existing entry in place + skip the normal append.
        const proto = m.message?.protocolMessage;
        if (proto?.editedMessage && proto?.key?.id) {
          const targetId = proto.key.id;
          const newBody = textOf(proto.editedMessage) ?? null;
          if (newBody) {
            const chat = _chats.get(jid);
            if (chat?.recent?.length) {
              const entry = chat.recent.find(r => r.key?.id === targetId);
              if (entry) {
                const trimmed = newBody.trim();
                entry.text = trimmed.length > RECENT_BODY_CAP
                  ? trimmed.slice(0, RECENT_BODY_CAP - 1) + '…'
                  : trimmed;
                // Refresh the reaction-target preview cache too —
                // _quotedPreview reads from _msgBodyById to render '↳'
                // previews, and a stale half-stream body there would
                // produce confusing quotes when someone replies later.
                _rememberMsgBody(targetId, trimmed);
              }
            }
          }
          continue;
        }
        const isGroup = jid.endsWith('@g.us');
        const ts = (Number(m.messageTimestamp) || 0) * 1000;
        const fromMe = !!m.key?.fromMe;
        const pushedName = (typeof m.pushName === 'string' && m.pushName.trim()) ? m.pushName.trim() : null;
        // Naming: pushName is a SENDER's display name, never a chat
        // name for groups. Using it for groups was a latent bug —
        // a brand-new group's name would be whoever first happened
        // to speak (e.g. an Auge family group would render as
        // "Mauricio" until /channels triggered a subject fetch).
        // Group subject is filled in lazily by listChats from
        // sock.groupMetadata, or via _ensureGroupName below.
        // Author is still whoever spoke.
        const remoteName = (!isGroup && !fromMe && pushedName) ? pushedName : null;
        const author = fromMe ? 'You' : (pushedName ?? null);
        // Enrich reaction bodies at recording time so recent[] (which
        // /recap reads from) stores '[reaction 👍 to "parent text"]'
        // instead of the opaque '[reaction 👍 (msg AC8AD42D)]'
        // placeholder. _enrichReactionText is a no-op for non-reaction
        // messages, so passing every body through it is cheap.
        const rawBody = textOf(m.message ?? {}) ?? null;
        const body = rawBody ? _enrichReactionText(rawBody, m) : null;
        const key = m.key?.id ? { id: m.key.id, fromMe } : null;
        // type==='notify' is real-time push delivery from baileys.
        // 'append' / 'prepend' / undefined are history backfill — don't
        // count toward logon-summary deltas.
        const live = (type === 'notify');
        if (ts > 0) _recordChat({ jid, isGroup, name: remoteName, ts, kind: 'activity', author, body, key, live });
      }
      // — LOUD track — only real-time messages reach handleMessage,
      // which is the path that renders, mirrors, and may dispatch
      // to a brain. 'notify' is the normal push-real-time delivery;
      // 'append' is what some baileys versions use for own-device
      // 'Message Yourself' echoes. 'prepend' is the bulk history
      // sync — STOPS HERE; do not pass to handleMessage. Debug mode
      // bypasses the gate intentionally (operator wants to see
      // everything baileys actually delivers); leave debug off in
      // normal production use.
      if (!debug && type !== 'notify' && type !== 'append') return;
      // Media save — runs for every real-time delivery regardless
      // of awareness gates (the operator asked to retain ALL media,
      // for both observed chats and bound rooms; see whatsapp.media
      // config). Independent of handleMessage so a media message
      // dropped at the awareness gate still lands on disk. Revoke
      // notifications (a sender deleting a message) are handled in
      // the same loop — the file moves to a 'deleted/' subfolder.
      // Await saves+transcribes BEFORE dispatch so the body that
      // reaches @e includes any transcripts inlined. Parallel via
      // Promise.all — within a batch, multiple media saves can run
      // concurrently; dispatch waits for all of them. Voice notes
      // transcribed via whisper.cpp dominate the wait when present.
      await Promise.all(messages.map(msg => {
        if (msg.message?.protocolMessage) {
          return _handleRevoke(msg).catch(e => err(`media revoke threw: ${e.message}`));
        }
        return _saveMediaIfAny(msg).catch(e => err(`media save threw: ${e.message}`));
      }));
      for (const msg of messages) {
        try { await handleMessage(msg, { bypassAwareness: debug }); }
        catch (e) { err(`onIncoming threw: ${e.message}`); }
      }
    });

    // History sync — baileys delivers chats + their recent messages
    // in one shot after connect when shouldSyncHistoryMessage is true.
    //
    // CRITICAL: this is the SILENT track. We read both the .chats
    // array (for chat metadata) AND the .messages array (for the
    // per-chat recent ring that /channels surfaces) — but NEITHER
    // is piped to onIncoming, the shell UI, the bridge mirror, or
    // a brain. The body extracted from .messages is purely cache
    // state the user pulls via /channels — same posture as the chat
    // list itself.
    sock.ev.on('messaging-history.set', (params) => {
      const { chats, messages, syncType, isLatest } = params;
      const chatsCount = Array.isArray(chats) ? chats.length : 0;
      const messagesCount = Array.isArray(messages) ? messages.length : 0;
      // Visible diagnostic so the user can see how much history baileys
      // actually shipped on connect. Goes to onLog which is the hidden
      // /log buffer (operator can run /log to inspect). If messagesCount
      // is consistently 0, the phone-side sync isn't delivering message
      // bodies and we'll need a different strategy.
      log(`whatsapp[history]: chats=${chatsCount} messages=${messagesCount} syncType=${syncType} latest=${isLatest}`);
      // Diagnostic: sample the first 2 messages to see what fields are
      // populated (in particular whether m.message has actual content).
      if (debug && messagesCount > 0) {
        for (const m of messages.slice(0, 2)) {
          const sample = {
            jid: m.key?.remoteJid,
            fromMe: m.key?.fromMe,
            ts: m.messageTimestamp,
            pushName: m.pushName,
            messageType: m.message ? Object.keys(m.message)[0] : null,
            textPreview: textOf(m.message ?? {})?.slice(0, 60) ?? null,
          };
          log(`whatsapp[history-sample]: ${JSON.stringify(sample)}`);
        }
      }

      if (Array.isArray(chats)) {
        for (const chat of chats) {
          if (!chat?.id) continue;
          const isGroup = chat.id.endsWith('@g.us');
          const ts = (Number(chat.conversationTimestamp) || 0) * 1000;
          const name = typeof chat.name === 'string' && chat.name.trim() ? chat.name.trim() : null;
          // Only groups get a name from the sync (the group SUBJECT). For DMs
          // baileys' chat.name is the operator's address-book label — never
          // store it; DM names come exclusively from message pushNames.
          if (ts > 0) _recordChat({ jid: chat.id, isGroup, name: isGroup ? name : null, ts, kind: 'activity' });
        }
      }
      if (Array.isArray(messages)) {
        for (const m of messages) {
          const jid = m.key?.remoteJid;
          if (!jid) continue;
          const isGroup = jid.endsWith('@g.us');
          const ts = (Number(m.messageTimestamp) || 0) * 1000;
          const fromMe = !!m.key?.fromMe;
          const pushedName = (typeof m.pushName === 'string' && m.pushName.trim()) ? m.pushName.trim() : null;
          const author = fromMe ? 'You' : (pushedName ?? null);
          const body = textOf(m.message ?? {}) ?? null;
          const key = m.key?.id ? { id: m.key.id, fromMe } : null;
          if (ts > 0) _recordChat({ jid, isGroup, name: null, ts, kind: 'activity', author, body, key });
        }
      }
    });

    // Live chat updates — fired when a new chat appears or an
    // existing one's metadata changes. Mostly redundant with the
    // messages.upsert pre-record above, but catches cases where WA
    // surfaces a chat without an associated message (e.g., a name
    // change, archive toggle, pin/unpin).
    // baileys exposes the pin state as `chat.pin` (the timestamp the
    // chat was pinned, ms since epoch — same as WA's own ordering
    // primitive). 0/undefined means not pinned. We thread that
    // through _recordChat → listChats so pinned chats float to the
    // top of /channels and the logon summary, matching WA's UI.
    sock.ev.on('chats.upsert', (chats) => {
      if (!Array.isArray(chats)) return;
      for (const chat of chats) {
        if (!chat?.id) continue;
        const isGroup = chat.id.endsWith('@g.us');
        const ts = (Number(chat.conversationTimestamp) || 0) * 1000;
        const name = typeof chat.name === 'string' && chat.name.trim() ? chat.name.trim() : null;
        const pinned = Number(chat.pin) || 0;
        // Groups → subject; DMs → never the address-book chat.name (see above).
        if (ts > 0 || pinned > 0) _recordChat({ jid: chat.id, isGroup, name: isGroup ? name : null, ts, kind: 'activity', pinned });
      }
    });
    sock.ev.on('chats.update', (updates) => {
      if (!Array.isArray(updates)) return;
      for (const u of updates) {
        if (!u?.id) continue;
        // chats.update only carries the fields that changed, so we
        // only call _recordChat when pin (or another field we track)
        // is actually present. Pass pinned: 0 explicitly when WA
        // signals an unpin so the chat falls back into the regular
        // activity-ordered section.
        if (typeof u.pin !== 'undefined') {
          const isGroup = u.id.endsWith('@g.us');
          const pinned = Number(u.pin) || 0;
          _recordChat({ jid: u.id, isGroup, kind: 'activity', pinned });
        }
      }
    });
  }

  // Media save — runs alongside SILENT recording for every real-
  // time delivery. Independent of awareness gates so a media
  // message from an observed chat still lands on disk. Config
  // (whatsapp.media): download = 'all' | 'images_docs' | 'off';
  // max_size_mb = N (default 25). Default save path is
  // ~/.egpt/media/<chatJidSan>/<msgId>.<ext>. Existing files are
  // not re-downloaded — idempotent across daemon restarts.
  //
  // Operator (2026-05-20): media should land inside the contact's
  // slug-dir (~/.egpt/conversations/<slug>/media/) so conversation-e
  // sees it in `./media` without crossing its sandbox boundary. The
  // host supplies a `mediaDirForChat(jid)` callback that returns the
  // resolved slug-dir/media. Bridge falls back to MEDIA_DIR/<jid>
  // when the callback isn't wired or returns null (chat has no slug
  // yet — e.g., first message in a brand-new auto_e_chat).
  const MEDIA_DIR = join(homedir(), '.egpt', 'media');
  const _mediaDirFor = (chatJid) => {
    try {
      const resolved = typeof mediaDirForChat === 'function'
        ? mediaDirForChat(chatJid)
        : null;
      if (resolved && typeof resolved === 'string') return resolved;
    } catch (e) { console.error(`!! whatsapp.mjs:[catch] ${e?.message ?? e}`); }
    return join(MEDIA_DIR, _sanitiseChatJid(chatJid));
  };
  function _sanitiseChatJid(jid) {
    const at = jid.indexOf('@');
    if (at < 0) return jid.replace(/[^A-Za-z0-9._-]+/g, '_');
    const local = jid.slice(0, at).replace(/[^A-Za-z0-9._-]+/g, '_');
    const hostPrefix = jid.slice(at + 1).split('.')[0].replace(/[^A-Za-z0-9._-]+/g, '_');
    return hostPrefix ? `${local}_${hostPrefix}` : local;
  }
  function _extFor(mimetype, fileName) {
    // documentMessage carries the original filename — use its
    // extension as-is when present.
    if (fileName) {
      const m = fileName.match(/\.[A-Za-z0-9]{1,8}$/);
      if (m) return m[0].toLowerCase();
    }
    const subtype = (mimetype ?? '').split('/')[1]?.split(';')[0]?.trim().toLowerCase() ?? '';
    const map = {
      'jpeg': '.jpg', 'jpg': '.jpg', 'png': '.png', 'webp': '.webp',
      'gif': '.gif', 'svg+xml': '.svg', 'heic': '.heic', 'heif': '.heif',
      'mp4': '.mp4', 'quicktime': '.mov', 'webm': '.webm',
      'ogg': '.ogg', 'mpeg': '.mp3', 'aac': '.aac', 'm4a': '.m4a',
      'wav': '.wav', 'x-wav': '.wav',
      'pdf': '.pdf', 'plain': '.txt', 'zip': '.zip',
      'msword': '.doc',
      'vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
      'vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
      'vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
      'octet-stream': '.bin',
    };
    return map[subtype] ?? (subtype ? `.${subtype.replace(/[^a-z0-9]+/g, '')}` : '.bin');
  }
  // Slug helper for filenames — lowercase, alphanum + underscores
  // only, max length so paths stay sane across filesystems.
  function _slugify(s, maxLen = 40) {
    if (!s) return '';
    return String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, maxLen) || '';
  }
  function _stampMS(ts) {
    // YYYYMMDD-HHMM (UTC enough for filesystem sort; the operator
    // doesn't read TZ off filenames). Stable across timezones.
    const d = new Date(ts || Date.now());
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
           `-${pad(d.getHours())}${pad(d.getMinutes())}`;
  }
  // Index sidecar: msgId → { filename, kind, author, caption, ts }
  // Maintained per chat dir. Lets the delete handler find a saved
  // file by its original WA msg key id.
  async function _readMediaIndex(dir) {
    try {
      const raw = await fs.readFile(join(dir, '.media-index.json'), 'utf8');
      return JSON.parse(raw);
    } catch { return {}; }
  }
  async function _writeMediaIndex(dir, idx) {
    try { await fs.writeFile(join(dir, '.media-index.json'), JSON.stringify(idx, null, 2)); } catch (e) { console.error(`!! whatsapp.mjs:[catch] ${e?.message ?? e}`); }
  }
  // Spawn a command and resolve when it exits 0; reject otherwise.
  // stdout is piped to capture but unused by transcribe today; stderr is
  // included in the rejection so the log line points at the real cause.
  function _runCmd(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
      let proc;
      try {
        // windowsHide: don't flash a console window for ffmpeg /
        // whisper-cli on each call (operator 2026-05-23: "terminal
        // flashing every now and then").
        proc = _spawnChild(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...opts });
      } catch (e) { return reject(e); }
      let stderr = '';
      proc.stderr?.on('data', d => { stderr += d.toString(); });
      proc.on('error', reject);
      proc.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`${cmd} exited ${code}${stderr ? `: ${stderr.slice(0, 240).trim()}` : ''}`));
      });
    });
  }

  // Audio transcription via whisper.cpp. Async / fire-and-forget per
  // call — voice note save returns immediately; transcript sidecar
  // (<base>.transcript.txt) lands alongside the audio when whisper
  // finishes. ffmpeg pre-converts to 16kHz mono WAV (whisper.cpp's
  // expected input shape).
  //
  // Disabled by default. Operator must:
  //   1. Install ffmpeg (winget install Gyan.FFmpeg / brew install ffmpeg / apt install ffmpeg)
  //   2. Install whisper.cpp + a model (github.com/ggerganov/whisper.cpp/releases)
  //   3. Set whatsapp.media.audio_transcribe:
  //        { enabled: true, command: "<path-to-whisper-cli-or-main.exe>",
  //          model_path: "<path-to-ggml-*.bin>", language?: "es" }
  //
  // ── whisper-server lifecycle ────────────────────────────────────
  //
  // Operator (2026-05-22) measured cold-start vs warm: per-call
  // whisper-cli pays ~15s of fixed encoder/init overhead even when
  // the model file is in OS page cache. The fix is to keep ONE
  // whisper-server.exe process alive — model loaded once, encoder
  // path JIT'd once, subsequent /inference calls only pay the per-
  // audio decoder cost (~1s per audio-second on CPU, vs cli's
  // ~15-20s flat overhead per spawn).
  //
  // Auto-discovered: same dir as media.audio_transcribe.command,
  // s/whisper-cli/whisper-server/. Spawned lazily on first
  // transcribe call. Killed on bridge stop().
  //
  // Config:
  //   media.audio_transcribe.server_enabled: true|false  (default true
  //     when server binary is found alongside whisper-cli)
  //   media.audio_transcribe.server_port: 8765           (default)
  //   media.audio_transcribe.server_host: 127.0.0.1      (default; localhost only)
  let _whisperServerProc = null;
  let _whisperServerReady = null;   // resolved when server's HTTP is up
  let _whisperServerUrl  = null;
  let _whisperServerStarting = false;
  // Live decode progress (0-100), parsed from whisper-server's stderr
  // `progress = N%` callback. -1 = idle / no signal yet. The server's TEXT
  // (stdout / HTTP body) is buffered until the call returns, but the PROGRESS
  // callback streams to stderr as it decodes — so a determinate transcription
  // bar reads this. Server processes serially, so the live value belongs to
  // the in-flight transcription (operator 2026-05-25: "didn't we talk about
  // reading stderr?").
  let _whisperProgress = -1;

  function _whisperServerBinPath() {
    const cfg = media.audio_transcribe ?? {};
    const cliPath = cfg.command || 'whisper-cli';
    // Replace last segment 'whisper-cli[.exe]' → 'whisper-server[.exe]'.
    return cliPath.replace(/whisper-cli(\.exe)?$/i, (_m, ext) => `whisper-server${ext || ''}`);
  }

  async function _ensureWhisperServer() {
    const cfg = media.audio_transcribe ?? {};
    if (cfg.server_enabled === false) return null;
    if (_whisperServerProc) return _whisperServerReady;
    if (_whisperServerStarting) return _whisperServerReady;
    _whisperServerStarting = true;

    const serverBin = _whisperServerBinPath();
    if (!existsSync(serverBin)) {
      log(`whisper-server: binary not found at ${serverBin} — falling back to per-call whisper-cli`);
      _whisperServerStarting = false;
      return null;
    }
    const port = Number(cfg.server_port) || 8765;
    const host = cfg.server_host || '127.0.0.1';
    const modelPath = cfg.model_path;
    const language  = (typeof cfg.language === 'string' && cfg.language.trim()) ? cfg.language.trim() : null;
    if (!modelPath) {
      log(`whisper-server: no model_path; cannot start`);
      _whisperServerStarting = false;
      return null;
    }
    const args = [
      '-m', modelPath,
      '--host', host,
      '--port', String(port),
    ];
    if (language) args.push('-l', language);
    // Apply the same tunables that whisper-cli accepts.
    if (cfg.no_context === true)  args.push('--no-context');
    if (cfg.no_fallback === true) args.push('--no-fallback');
    if (Number.isFinite(cfg.no_speech_threshold)) args.push('--no-speech-thold', String(cfg.no_speech_threshold));
    if (Number.isFinite(cfg.logprob_threshold))   args.push('--logprob-thold',   String(cfg.logprob_threshold));
    if (Number.isFinite(cfg.beam_size))           args.push('-bs',               String(cfg.beam_size));
    if (Number.isFinite(cfg.best_of))             args.push('-bo',               String(cfg.best_of));
    if (Array.isArray(cfg.extra_args))            args.push(...cfg.extra_args.map(String));
    args.push('--print-progress');   // emit `progress = N%` to stderr for the live bar

    _whisperServerUrl = `http://${host}:${port}`;
    log(`whisper-server: starting ${serverBin} on ${_whisperServerUrl} (model ${modelPath.split(/[\\/]/).pop()})`);
    try {
      _whisperServerProc = _spawnChild(serverBin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      log(`whisper-server: spawn failed: ${e?.message ?? e}`);
      _whisperServerProc = null;
      _whisperServerStarting = false;
      return null;
    }
    _whisperServerProc.stderr?.on('data', d => {
      const s = d.toString();
      // Parse the decode progress callback (`progress = N%`) for the live
      // transcription bar. The line repeats as it climbs 0→100.
      const m = s.match(/progress\s*=\s*(\d+)\s*%/);
      if (m) _whisperProgress = Math.max(0, Math.min(100, parseInt(m[1], 10)));
      // The server writes init progress + per-call decode lines to
      // stderr. Surface only the init errors / "ready" line; the
      // decode chatter is too noisy for headless.log.
      if (/error|fail|warning/i.test(s) || /starting server/i.test(s)) log(`whisper-server: ${s.trim()}`);
    });
    _whisperServerProc.on('exit', (code) => {
      log(`whisper-server: exited code=${code}; will respawn on next call`);
      _whisperServerProc = null;
      _whisperServerReady = null;
      _whisperServerStarting = false;
    });

    // Poll /inference (HEAD or GET to root) until it responds. The
    // server emits "starting server at <host>:<port>" to stderr when
    // ready, but stderr ordering across model-load steps is fiddly;
    // a simple TCP poll is more robust.
    _whisperServerReady = (async () => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        try {
          const r = await fetch(`${_whisperServerUrl}/`, { method: 'GET' });
          if (r.status < 500) {
            log(`whisper-server: ready (${Date.now() - (deadline - 60_000)}ms to boot)`);
            return true;
          }
        } catch (_) { /* not up yet */ }
        await new Promise(res => setTimeout(res, 250));
      }
      log(`whisper-server: failed to come up within 60s`);
      try { _whisperServerProc?.kill(); } catch {}
      _whisperServerProc = null;
      return false;
    })();
    _whisperServerStarting = false;
    return _whisperServerReady;
  }

  // POST a WAV file to the warm whisper-server and return parsed text.
  // Returns null on failure so the caller can fall back to spawning
  // whisper-cli for that single call.
  async function _transcribeViaServer({ wavPath, language }) {
    const ready = await _ensureWhisperServer();
    if (!ready || !_whisperServerUrl) return null;
    try {
      const buf = await fs.readFile(wavPath);
      const form = new FormData();
      form.append('file', new Blob([buf], { type: 'audio/wav' }), 'audio.wav');
      if (language) form.append('language', language);
      form.append('response_format', 'json');
      const r = await fetch(`${_whisperServerUrl}/inference`, { method: 'POST', body: form });
      if (!r.ok) {
        log(`whisper-server: HTTP ${r.status} for ${wavPath.split(/[\\/]/).pop()}`);
        return null;
      }
      const j = await r.json();
      // whisper-server returns segments joined by '\n' inside the
      // "text" field. When a word straddles a segment boundary
      // (whisper splits on max-len or silence) the result is e.g.
      // "rein\nicie" instead of "reinicie". Collapse all whitespace
      // (newlines + tabs + multi-spaces) to single space so the
      // transcript reads as one sentence. Operator 2026-05-23
      // noticed this in andrés gonzález chat.
      const text = (j.text || '').replace(/\s+/g, ' ').trim();
      return { text };
    } catch (e) {
      log(`whisper-server: POST failed: ${e?.message ?? e}`);
      return null;
    }
  }

  function _stopWhisperServer() {
    if (_whisperServerProc) {
      try { _whisperServerProc.kill(); } catch {}
      _whisperServerProc = null;
      _whisperServerReady = null;
    }
  }

  // ── Parallel-CLI transcribe ─────────────────────────────────────
  //
  // Operator (2026-05-23): "we can however chop the 20s into 5 4s,
  // and transcribe those separately... maybe less concurrent so it
  // doesn't crash my machine."
  //
  // Splits audio into N-second windows, spawns up to maxConcurrent
  // whisper-cli processes simultaneously. Each spawn pays its own
  // ~5s model-load + ~16s encoder cost. With max_concurrent=2 and
  // 5 chunks of 4s: 3 rounds × ~21s = ~63s wall-clock for a 20s
  // audio (vs ~88s for sequential warm-server chunks, vs ~20s for
  // single batch). The win is selectable parallelism — more workers
  // = closer to batch time, capped by RAM (each whisper-cli loads
  // ~3GB).
  //
  // Output: single concatenated transcript.txt, no per-window files.
  // No streaming UI; all chunks resolve before we post.
  //
  // Config:
  //   audio_transcribe:
  //     method: parallel_cli          # 'batch' (default) | 'parallel_cli' | 'remote'
  //     parallel:
  //       chunk_seconds: 4            # window length
  //       max_concurrent: 2           # cap on simultaneous whisper-cli procs
  async function _transcribeAudio({ inputPath, outputDir, base }) {
    const cfg = media.audio_transcribe ?? {};
    if (!cfg.enabled) return null;
    const whisperBin = cfg.command || 'whisper-cli';
    const ffmpegBin  = cfg.ffmpeg_command || 'ffmpeg';
    const modelPath  = cfg.model_path;
    if (!modelPath) {
      log(`transcribe: enabled but model_path not set; skipping ${base}`);
      return null;
    }
    const finalTxt = join(outputDir, `${base}.transcript.txt`);
    if (existsSync(finalTxt)) return null;     // already transcribed
    const wavPath = join(outputDir, `${base}.tmp.wav`);
    // ffmpeg: opus/m4a/mp3 → 16kHz mono PCM WAV
    try {
      await _runCmd(ffmpegBin, ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath]);
    } catch (e) {
      log(`transcribe: ffmpeg failed for ${base}: ${e.message}`);
      return null;
    }
    const args = ['-m', modelPath, '-f', wavPath, '--output-txt', '--no-prints'];
    if (typeof cfg.language === 'string' && cfg.language.trim()) {
      args.push('-l', cfg.language.trim());
    }
    // Tunable whisper-cli flags via config (operator 2026-05-22 after
    // observing silence misclassified as [Música]). See whisper.cpp's
    // README for all flags. Common knobs:
    //   no_context: true            → --no-context  (each segment
    //                                  independent — prevents "carry-over"
    //                                  hallucinations like repeated music
    //                                  markers from one silent stretch).
    //   no_speech_threshold: 0.6    → --no-speech-thold N  (probability
    //                                  threshold above which the segment
    //                                  is marked as silence. Raise to
    //                                  reduce false silence; lower to
    //                                  catch more silence).
    //   logprob_threshold: -1.0     → --logprob-thold N  (drop low-
    //                                  confidence guesses — catches some
    //                                  hallucinated music/applause).
    //   temperature: 0              → -tp N  (sampling temperature; 0 is
    //                                  most deterministic).
    //   beam_size: 5                → -bs N  (beam search width).
    //   suppress_blank: true        → --suppress-blank  (don't emit
    //                                  "blank" tokens at start of segment).
    //   extra_args: ['--vad']       → spread literally (catch-all).
    if (cfg.no_context === true)  args.push('--no-context');
    if (cfg.no_fallback === true) args.push('--no-fallback');
    if (Number.isFinite(cfg.no_speech_threshold)) args.push('--no-speech-thold', String(cfg.no_speech_threshold));
    if (Number.isFinite(cfg.logprob_threshold))   args.push('--logprob-thold',   String(cfg.logprob_threshold));
    if (Number.isFinite(cfg.temperature))         args.push('-tp',               String(cfg.temperature));
    if (Number.isFinite(cfg.beam_size))           args.push('-bs',               String(cfg.beam_size));
    if (Number.isFinite(cfg.best_of))             args.push('-bo',               String(cfg.best_of));
    if (cfg.suppress_blank === true)              args.push('--suppress-blank');
    if (Array.isArray(cfg.extra_args))            args.push(...cfg.extra_args.map(String));

    // Try the warm whisper-server first (no per-call cold-start
    // overhead). Falls back to per-call whisper-cli if the server
    // isn't available, hasn't started, or HTTP-failed this call.
    let text = null;
    const serverResult = await _transcribeViaServer({ wavPath, language: cfg.language });
    if (serverResult?.text) {
      text = serverResult.text;
      try { await fs.writeFile(finalTxt, text, 'utf8'); }
      catch (e) { log(`transcribe: write finalTxt failed: ${e?.message ?? e}`); }
      try { await fs.unlink(wavPath); } catch {}
    } else {
      try {
        await _runCmd(whisperBin, args);
      } catch (e) {
        log(`transcribe: whisper failed for ${base}: ${e.message}`);
        try { await fs.unlink(wavPath); } catch {}
        return null;
      }
      // whisper.cpp writes <wavPath>.txt — move next to the audio
      // with a stable suffix the host / @e can grep for.
      const txtSrc = `${wavPath}.txt`;
      try {
        text = (await fs.readFile(txtSrc, 'utf8')).trim();
        await fs.rename(txtSrc, finalTxt);
      } catch (e) {
        log(`transcribe: read/move failed for ${base}: ${e.message}`);
      }
      try { await fs.unlink(wavPath); } catch {}
    }
    if (text) {
      const preview = text.length > 60 ? text.slice(0, 59) + '…' : text;
      log(`transcribed ${base}: "${preview}"`);
    }
    return text ? { path: finalTxt, text } : null;
  }

  // Streaming variant of _transcribeAudio (operator 2026-05-22):
  // returns an EventEmitter + donePromise so the dispatcher can react
  // to chunks of transcript as they're produced, rather than awaiting
  // the full transcription. The recipient sees the WA message body
  // evolve as the audio is "heard." This is the literal externalization
  // of attention forming meaning over time — analog of the /movie
  // alien-frames effect transposed onto a different modality.
  //
  // Architecture (probed in tools/probe-whisper-stream.mjs):
  //   whisper-cli is BATCH (stdout + output-srt both buffered until exit)
  //   → we ffmpeg-slice audio into N-second chunks
  //   → loop whisper-cli over chunks with the FAST base model (~1.3s/chunk)
  //   → emit 'chunk' (text, idx, cumulativeText) per chunk
  //   → optional: final pass with large model for the persisted transcript
  //
  // The large model stays as the canonical transcript (`<base>.transcript.txt`)
  // so the rest of the system (memory, /summarize, etc.) is unaffected.
  // The base model's chunked output is purely the live-preview layer.
  //
  // Idempotent: if `<base>.transcript.txt` exists, returns a done-emitter
  // with the existing text — no re-work.
  async function _extractVideoKeyframe({ inputPath, outputDir, base }) {
    const cfg = media.audio_transcribe ?? {};
    if (!cfg.enabled) return null;
    const ffmpegBin = cfg.ffmpeg_command || 'ffmpeg';
    const jpgPath = join(outputDir, `${base}.keyframe.jpg`);
    if (existsSync(jpgPath)) return jpgPath;
    try {
      await _runCmd(ffmpegBin, [
        '-y', '-i', inputPath,
        '-vf', 'thumbnail,scale=640:-1',
        '-frames:v', '1',
        jpgPath,
      ]);
      log(`keyframe extracted ${base}.keyframe.jpg`);
      return jpgPath;
    } catch (e) {
      log(`keyframe extract failed for ${base}: ${e.message}`);
      return null;
    }
  }

  async function _saveMediaIfAny(msg) {
    const downloadMode = media.download ?? 'all';
    if (downloadMode === 'off') return null;
    const m = msg.message ?? {};
    // Map of media-bearing variants. Order matters — checked first
    // wins (an extendedTextMessage with a contextInfo quote of a
    // documentMessage shouldn't trigger a save for the quoted doc).
    const kinds = [
      { key: 'imageMessage',    kind: 'image' },
      { key: 'videoMessage',    kind: 'video' },
      { key: 'audioMessage',    kind: 'audio' },
      { key: 'documentMessage', kind: 'document' },
      { key: 'stickerMessage',  kind: 'sticker' },
    ];
    const hit = kinds.find(k => m[k.key]);
    if (!hit) return null;
    // images_docs filter — only images + documents (videos / audio
    // / stickers skipped).
    if (downloadMode === 'images_docs' && !(hit.kind === 'image' || hit.kind === 'document')) return null;
    const node = m[hit.key];
    const chatJid = msg.key?.remoteJid;
    const msgId = msg.key?.id;
    if (!chatJid || !msgId) return null;
    // Size guard
    const fileLen = Number(node.fileLength) || 0;
    const maxSize = (Number(media.max_size_mb) || 25) * 1024 * 1024;
    if (fileLen > 0 && fileLen > maxSize) {
      log(`media skipped (${(fileLen / 1024 / 1024).toFixed(1)}MB > ${media.max_size_mb ?? 25}MB): ${hit.kind} from ${chatJid}`);
      return null;
    }
    const ext = _extFor(node.mimetype, node.fileName);
    const dir = _mediaDirFor(chatJid);
    // Filename: <YYYYMMDD-HHMM>_<author>_<slug>_<shortId>.<ext>
    //   - timestamp gives chronological sort
    //   - author slug (pushName or 'you')
    //   - body slug (caption / filename / kind placeholder)
    //   - shortId (last 6 chars of WA stanza id) disambiguates the
    //     occasional same-author same-minute collision and ties
    //     the file back to the msgId in the index sidecar
    //   - ext from mimetype / docFileName
    const ts = (Number(msg.messageTimestamp) || 0) * 1000;
    const stamp = _stampMS(ts);
    const fromMe = !!msg.key?.fromMe;
    const pushedName = (typeof msg.pushName === 'string' && msg.pushName.trim()) ? msg.pushName.trim() : null;
    const authorSlug = _slugify(fromMe ? 'you' : (pushedName ?? chatJid.split('@')[0] ?? 'anon'), 24) || 'anon';
    const caption = node.caption?.trim()
      ?? node.fileName?.trim()
      ?? (hit.kind === 'audio' && node.ptt ? 'voice_note' : null)
      ?? hit.kind;
    const slug = _slugify(caption, 40) || hit.kind;
    const shortId = msgId.slice(-6);
    const base = `${stamp}_${authorSlug}_${slug}_${shortId}`;
    const path = join(dir, `${base}${ext}`);
    // Idempotent: if the index already has this msgId, the file is
    // on disk (or under deleted/) — skip re-download.
    const indexBefore = await _readMediaIndex(dir);
    if (indexBefore[msgId]) return indexBefore[msgId].path ?? path;
    try {
      const buf = await downloadMediaMessage(msg, 'buffer', {});
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path, buf);
      // Sidecar .txt with the full caption / filename when the
      // truncated slug doesn't carry it all (the slug is capped at
      // 40 chars; a 200-char caption deserves the full record).
      if (caption && caption.length > 40) {
        try { await fs.writeFile(join(dir, `${base}.txt`), caption); } catch (e) { console.error(`!! whatsapp.mjs:[catch] ${e?.message ?? e}`); }
      }
      // Update the index. Stores enough to identify and locate the
      // file later (delete handler glues msgId → filename).
      const idx = await _readMediaIndex(dir);
      idx[msgId] = {
        filename: `${base}${ext}`,
        path,
        kind: hit.kind,
        author: pushedName ?? (fromMe ? 'you' : null),
        ts,
        caption: caption ?? null,
        ext,
        base,
      };
      await _writeMediaIndex(dir, idx);
      const sizeKB = (buf.length / 1024).toFixed(1);
      // Distinguish voice notes (PTT audio) from regular audio in the
      // surfaced 'kind' — the on-screen placeholder reads '[voice note: 31s]'
      // and the save notice should match. The filename slug already uses
      // 'voice_note' for PTT, so this only affects what onMediaSaved sees.
      const notifyKind = (hit.kind === 'audio' && node.ptt) ? 'voice note' : hit.kind;
      log(`media saved: ${notifyKind} ${sizeKB}KB → ${path}`);
      // preConnect flag: messages whose timestamp is older than the
      // bridge's hold window. Same gate as handleMessage's _heldMessages
      // check. The host uses this to suppress the visible 📎 sysOut for
      // backlog files — the file IS saved to disk (always; that's
      // independently useful) and the .media-index.json records it,
      // but we don't render a shell line or append to room md until
      // the operator explicitly dispatches the corresponding held
      // message via /wa-pending. Matches the operator-trust principle:
      // nothing about a pre-connect message is mirrored anywhere.
      const msgTsMs = (Number(msg.messageTimestamp) || 0) * 1000;
      const preConnect = maxBacklogSeconds >= 0 && connectedAt > 0
        && msgTsMs > 0 && msgTsMs < connectedAt - maxBacklogSeconds * 1000;
      // For audio: await transcription synchronously BEFORE the
      // saved-notice fires + before this function returns. Caller's
      // dispatch loop awaits save, so by the time handleMessage
      // computes the body for @e, the <base>.transcript.txt sidecar
      // exists and _enrichAudioText can inline it into the wa-inbound
      // text. No-op when whatsapp.media.audio_transcribe.enabled
      // is false (returns null fast).
      let transcript = null;
      let keyframePath = null;
      let voiceStream = null;        // streaming-transcription handle, when enabled + audio
      // Pre-connect backlog: baileys re-delivers offline messages on reconnect
      // (e.g. after a crash/restart). The media is SAVED above (logged), but
      // transcription + the 👂 ack are PROCESSING — skip them, same posture as
      // the dispatch hold (max_backlog_seconds → /wa-pending). Otherwise a
      // restart triggers a whisper storm over every old voice note. Operator,
      // repeatedly: "these bursts must be logged but not processed." Live
      // messages transcribe as normal.
      if (preConnect && (hit.kind === 'audio' || hit.kind === 'video')) {
        log(`media saved, transcription skipped (pre-connect backlog): ${notifyKind} → ${path}`);
      }
      if ((hit.kind === 'audio' || hit.kind === 'video') && !preConnect) {
        // Voice flow (operator 2026-05-23 redesign — "let's keep it
        // easy, remove all other ways, restart clean"):
        //
        // 1. Post acknowledgment reply IMMEDIATELY:
        //      "👂 PushName's NNs @ HH:MM ⏳"
        //    Quoted to the original voice. Brief looped emoji
        //    animation (dots cycling) while transcription runs, so
        //    chat sees activity not silence.
        //
        // 2. Run whisper transcription (single batch call via the
        //    warm whisper-server). One inference, one HTTP POST,
        //    no chunking, no parallel pool, no streaming windows.
        //
        // 3. When transcription completes: EDIT the acknowledgment
        //    message body to "👂 PushName's NNs @ HH:MM: <transcript>"
        //    Final state visible to everyone in chat.
        //
        // 4. Brain dispatch: handleMessage continues, _enrichAudioText
        //    formats the body as "👂 PushName Ns @ HH:MM: <transcript>"
        //    in operator's spec, brain replies in context.
        //
        // Per-chat opt-out: per_chat[jid] === 'off' skips the WA
        // acknowledgment+edit. Brain still gets the transcript inline.
        const _cfg = media.audio_transcribe ?? {};
        const _perChat = (_cfg.per_chat && typeof _cfg.per_chat === 'object') ? _cfg.per_chat : {};
        const _override = _perChat[chatJid];
        const wantPostAck = _override !== 'off';
        // Legacy variables kept temporarily so downstream references
        // (the "if (!voiceStream)" gate below) still compile; voiceStream
        // is always null now since the streaming path was retired.
        const wantReplyBatch = false;
        const wantReplyStreaming = false;
        // Operator (2026-05-22, "star wins"): the per-window streaming
        // architecture is fundamentally wrong on CPU with whisper-large.
        // Measured: 4s window = 17.5s wall-clock; 20s as one batch =
        // 20.6s. Encoder pass is a ~16.5s fixed cost per inference, so
        // splitting a 20s audio into 5 windows costs 5 × 17.5s = 87s vs
        // 20.6s for one batch. Chunking is 4× slower.
        //
        // Both 'streaming' AND 'batch' per_chat modes now route through
        // the single _transcribeAudio batch call. The reply (still
        // operator-preferred fresh message, not quoted) lands when
        // batch completes. The brain dispatch awaits the same batch.
        //
        // Old _transcribeAudioStreaming function stays in code but is
        // unreachable from this path. If someone gets a GPU and per-
        // window encoder cost drops to ~1s, flip this gate back to
        // wantReplyStreaming and the chunked typewriter works again.
        const streamingEnabled = false;
        if (streamingEnabled && hit.kind === 'audio' && node.ptt) {
          // Voice notes (PTT only — not music attachments) use the streaming
          // path. The handle is forwarded through onMediaSaved so the host
          // can attach to chunk events from the dispatcher. Don't await:
          // the bridge returns immediately so dispatch sees the inbound
          // before transcription completes. Operator (2026-05-22): the
          // recipient should see the WA message body evolve as the audio
          // is "heard" — meta-awareness through visible attention.
          // TIMING (operator 2026-05-22): measure transcription vs
          // dispatch latency so we can quantify how much earlier the
          // brain could dispatch if it consumed first chunk instead
          // of awaiting full done. Logged as TIMING lines in headless
          // + activity log so we can grep across multiple voices.
          const _t0 = Date.now();   // voice received → starting transcribe
          log(`reply-stream PATH entered ${base} | chat=${chatJid} | wantStream=${wantReplyStreaming} | wantBatch=${wantReplyBatch}`);
          let _tFirstChunk = null;
          let _tDone = null;
          try {
            voiceStream = await _transcribeAudioStreaming({ inputPath: path, outputDir: dir, base });
          } catch (e) {
            log(`transcribe-stream init failed (${base}): ${e?.message ?? e} — falling back to batch`);
            voiceStream = null;
          }
          if (voiceStream) {
            // Capture first-chunk arrival timestamp for the headroom
            // measurement (independent of the typewriter listener).
            voiceStream.emitter.once('chunk', () => {
              _tFirstChunk = Date.now();
            });
            // When streaming finishes, cache the final text in the same map
            // batch mode uses so /summarize etc still work.
            voiceStream.donePromise.then((res) => {
              if (res?.finalText && msg.key?.id) {
                _transcriptByMsgId.set(msg.key.id, res.finalText);
              }
            }).catch(e => log(`transcribe-stream donePromise: ${e?.message ?? e}`));

            // Voice-as-reply-transcript (streaming variant). Bridge opens
            // a WA stream message as a native QUOTED reply to the voice,
            // then edits the body as each whisper chunk arrives — the
            // recipient watches the transcript "type out" in place.
            // Final replacement at done() uses the cleaner deduped
            // finalText from the joined-windows pass.
            if (wantReplyStreaming && msg.key) {
              // Typewriter-paced reply stream (operator 2026-05-22 design
              // spec): "you have the transcript of those 4 seconds, say
              // 'hola como estás tú', then you have to play those 17
              // characters in 4 seconds." Each window's text gets queued
              // and "typed out" over the window's duration via batched
              // edits, so the recipient sees the text appear at audio-
              // pace rather than landing in chunky 4s clumps.
              //
              // Implementation: each chunk pushes text into `displayed`
              // incrementally on a timer. Edit cadence is ~600ms (safe
              // for WA edit rate) so a 4s window becomes ~6 batched
              // edits, each ~16% of the window's text. Final replacement
              // at done() reconciles with the deduped finalText.
              let replyMsgKey = null;
              let lastSentBody = '';
              // Serialize WA sends — concurrent _editReply calls at fast
              // cadence (60ms) raced: tick #2 read replyMsgKey=null
              // before tick #1's initial send had returned, fired a
              // SECOND initial send → recipient saw multiple message
              // bodies instead of one being edited. Operator (2026-05-22)
              // reported this: "it dispatched different messages
              // instead of editing one." Chain via single in-flight
              // promise so each call waits for prior completion before
              // reading replyMsgKey.
              let _editChain = Promise.resolve();
              let _editCount = 0;
              const _editReply = (body) => {
                _editChain = _editChain.then(async () => {
                  if (body === lastSentBody) return;
                  try {
                    if (!replyMsgKey) {
                      const r = await _safeSend(chatJid, { text: body });
                      replyMsgKey = r?.key ?? null;
                      if (replyMsgKey) rememberSent(replyMsgKey.id);
                      log(`reply-stream INITIAL ${base} → ${chatJid} (${body.length}ch, ${Date.now() - _t0}ms after voice)`);
                    } else {
                      _editCount++;
                      const r = await _safeSend(chatJid, { edit: replyMsgKey, text: body });
                      rememberSent(r?.key?.id);
                      log(`reply-stream EDIT#${_editCount} ${base} → ${chatJid} (${body.length}ch, ${Date.now() - _t0}ms after voice)`);
                    }
                    lastSentBody = body;
                  } catch (e) {
                    log(`reply-stream edit FAILED (${base}): ${e?.message ?? e}`);
                  }
                });
                return _editChain;
              };

              // Operator 2026-05-22 sequence: 600ms → 60ms (10x faster
              // ask) → 60ms caused WA throttling AND raced the initial-
              // send → settled at 150ms. Combined with the serialized
              // _editChain above, the effective max edit rate is whatever
              // WA's _safeSend can sustain (~1-3 edits/sec under load),
              // so a 150ms tick that consistently HITS a 300-500ms send
              // round-trip is fine — the chain just queues naturally.
              const EDIT_CADENCE_MS = 150;
              let displayedText = '';   // chars already shown to recipient
              let pendingQueue  = '';   // chars buffered, not yet shown
              let typeTimer     = null;
              let doneSignal    = false;
              // Animation style (operator 2026-05-25). 'bar' (default) renders a
              // determinate progress bar — driven by whisper's processed-audio
              // position (chunk.endSeconds) over the clip duration — ABOVE the
              // partial transcript that types out below it, so the recipient
              // sees BOTH the progress and the words appearing. 'typewriter'
              // keeps the legacy transcript-only stream. The bar is dropped on
              // done(), leaving just the clean final transcript.
              const _animStyle = media.audio_transcribe?.animation ?? 'bar';
              const _totalSec  = Number(node?.seconds) || 0;
              let _lastEndSec  = 0;
              const _bar = (pct) => {
                const w = 10, f = Math.max(0, Math.min(w, Math.round(pct / 100 * w)));
                return '▰'.repeat(f) + '▱'.repeat(w - f);
              };
              const _renderBody = () => {
                if (_animStyle === 'bar' && _totalSec > 0) {
                  const pct = Math.min(100, Math.round((_lastEndSec / _totalSec) * 100));
                  const head = `🎙 ${_bar(pct)} ${pct}%`;
                  return displayedText ? `${head}\n${displayedText}` : head;
                }
                return `🎙 ${displayedText}`;
              };

              const _scheduleType = (windowDurationMs) => {
                if (typeTimer) return;   // already typing
                // Compute chars-per-tick from queue length spread over
                // this window's duration. We re-derive at every tick so
                // late-arriving chunks reflow gracefully.
                const tick = () => {
                  if (!pendingQueue) {
                    clearInterval(typeTimer);
                    typeTimer = null;
                    return;
                  }
                  // Distribute remaining chars across remaining ticks of
                  // THIS window. Ticks per window = ceil(dur/cadence).
                  // Recompute every tick so newly-arriving chunks
                  // accelerate without overrunning the queue.
                  const ticksLeft = Math.max(1, Math.ceil(windowDurationMs / EDIT_CADENCE_MS));
                  const charsPerTick = Math.max(1, Math.ceil(pendingQueue.length / ticksLeft));
                  const slice = pendingQueue.slice(0, charsPerTick);
                  pendingQueue = pendingQueue.slice(charsPerTick);
                  displayedText += slice;
                  _editReply(_renderBody())
                    .catch(e => log(`reply-stream typewriter: ${e?.message ?? e}`));
                  if (!pendingQueue && doneSignal) {
                    clearInterval(typeTimer);
                    typeTimer = null;
                  }
                };
                typeTimer = setInterval(tick, EDIT_CADENCE_MS);
                tick();   // first char(s) immediately
              };

              voiceStream.emitter.on('chunk', (ev) => {
                // Advance the progress bar even for silent windows (no text),
                // so the bar tracks audio position, not just spoken chunks.
                if (ev?.endSeconds != null) _lastEndSec = Math.max(_lastEndSec, ev.endSeconds);
                if (!ev?.text) return;
                const sep = (displayedText || pendingQueue) ? ' ' : '';
                pendingQueue += sep + ev.text;
                // Window duration from the chunk's offset metadata; falls
                // back to 4s (matches the default windowSeconds).
                const winDurSec = Math.max(0.5,
                  (ev.endSeconds ?? 0) - (ev.offsetSeconds ?? 0)) || 4;
                _scheduleType(winDurSec * 1000);
              });

              voiceStream.donePromise.then((res) => {
                doneSignal = true;
                const final = res?.finalText?.trim() || (displayedText + pendingQueue).trim();
                if (!final) {
                  // Pure silence (no chars ever queued). Revoke if anything sent.
                  if (replyMsgKey) {
                    _safeSend(chatJid, { delete: replyMsgKey })
                      .catch(e => log(`reply-stream revoke: ${e?.message ?? e}`));
                  }
                  return;
                }
                // Let any pending queue drain (best-effort short wait),
                // then replace with the canonical deduped final text. The
                // typewriter shows the per-window joined text; the final
                // is the cleaner joined-windows version which we want as
                // the persistent reply body.
                setTimeout(() => {
                  if (typeTimer) { clearInterval(typeTimer); typeTimer = null; }
                  _editReply(`🎙 ${final}`)
                    .catch(e => log(`reply-stream final: ${e?.message ?? e}`));
                }, 800);
              }).catch((e) => {
                log(`reply-stream done error (${base}): ${e?.message ?? e}`);
              });
            }

            // Now await transcription completion so handleMessage's
            // _enrichAudioText finds the transcript inline for the brain.
            // Listeners above were attached FIRST so they receive chunks
            // as they fire (before the await resolves). Without this
            // ordering the typewriter never sees a single chunk —
            // they've already all emitted by the time we'd hook up.
            // Operator (2026-05-22): "did test and saw no transcription".
            //
            // The brain-streaming variant (`streaming: true`) WANTS the
            // dispatch to race transcription — only batch reply mode
            // waits.
            const brainWantsStreaming = !!(media.audio_transcribe?.streaming);
            if (!brainWantsStreaming) {
              await voiceStream.donePromise.catch(() => {});
              _tDone = Date.now();
            }
            // Headroom report: how many ms could brain dispatch have
            // started EARLIER if it consumed first-chunk instead of
            // awaiting done? Positive = first chunk arrived before we
            // finished waiting; that's the saved latency.
            const audioDurSec = (() => {
              const s = Number(node?.seconds);
              return Number.isFinite(s) ? s : null;
            })();
            const totalMs   = (_tDone ?? Date.now()) - _t0;
            const firstMs   = _tFirstChunk ? (_tFirstChunk - _t0) : null;
            const headroom  = (firstMs != null && _tDone != null) ? (_tDone - _tFirstChunk) : null;
            log(`TIMING voice ${base} audio=${audioDurSec ?? '?'}s | t0→first=${firstMs ?? '?'}ms | t0→done=${totalMs}ms | headroom=${headroom ?? '?'}ms | model=${(media.audio_transcribe?.model_path ?? '').split(/[\\/]/).pop()}`);
          }
        }
        if (!voiceStream) {
          // Single-path voice flow (operator 2026-05-23 "keep it easy,
          // remove all other ways, restart clean"):
          //   1. If audio + wantPostAck: post acknowledgment reply
          //      "👂 <speaker>'s NNs @ HH:MM ⏳"
          //      with simple looped emoji animation while we transcribe.
          //   2. Run _transcribeAudio (single whisper-server batch
          //      inference). Same for video — ffmpeg pulls the audio
          //      track.
          //   3. On done: edit the ack message to
          //      "👂 <speaker>'s NNs @ HH:MM: <transcript>"
          //   4. _transcriptByMsgId set so brain dispatch gets the
          //      transcript inline via _enrichAudioText.
          const isAudioForAck = hit.kind === 'audio' && wantPostAck && msg.key;
          const dur = Number(node?.seconds) || 0;
          const tsMs = (Number(msg.messageTimestamp) || 0) * 1000;
          const pad = (n) => String(n).padStart(2, '0');
          const hhmm = tsMs ? `${pad(new Date(tsMs).getHours())}:${pad(new Date(tsMs).getMinutes())}` : '?';
          const speaker = pushedName ?? (fromMe ? 'You' : 'someone');

          // (1)+(2) Ack + transcribe, serialized per chat. The 👂 ack and its
          // progress bar are posted INSIDE the whisper slot, so a chat's voice
          // notes ack + decode strictly one at a time, in arrival order. Posting
          // the ack up-front instead made a burst look parallel (N bars
          // animating at once) and crosstalked: every waiting bar reads the
          // single shared _whisperProgress, so it mirrored whichever note was
          // actually decoding. Now a queued note stays silent until its turn,
          // then shows its own bar tracking its own decode. (one whisper slot)
          let ackKey = null;
          let animTimer = null;
          transcript = await _serializeTranscription(chatJid, async () => {
            if (isAudioForAck) {
              // Animation style. 'bar' (default): a DETERMINATE transcription bar
              // driven by whisper-server's stderr `progress = N%` callback — the
              // ACTUAL decode percent, no simulation. It sits at 0% until whisper
              // emits its first reading (ffmpeg-convert + encode warm-up, ~1-2s),
              // then fills to the real %. 'emoji': legacy ⏳🔊🎧🦻 cycle. Drops to
              // the transcript on done either way.
              const _animStyle = media.audio_transcribe?.animation ?? 'bar';
              _whisperProgress = -1;   // reset; this note's decode hasn't reported yet
              const W = 12;
              const _barFill = (pct) => {
                const f = Math.max(0, Math.min(W, Math.round(pct / 100 * W)));
                return '▰'.repeat(f) + '▱'.repeat(W - f);
              };
              const _emoji = ['⏳', '🔊', '🎧', '🦻'];
              const _frame = (i) => {
                if (_animStyle === 'emoji') return `👂 ${speaker}'s ${dur}s @ ${hhmm} ${_emoji[i % _emoji.length]}`;
                const pct = _whisperProgress >= 0 ? Math.min(100, _whisperProgress) : 0;
                return `👂 ${speaker}'s ${dur}s @ ${hhmm}\n${_barFill(pct)} ${pct}%`;
              };

              let _lastBody = _frame(0);
              try {
                const r = await _safeSend(
                  chatJid,
                  { text: _lastBody },
                  { quoted: { key: msg.key, message: msg.message ?? { conversation: '' } } },
                );
                ackKey = r?.key ?? null;
                if (ackKey) rememberSent(ackKey.id);
              } catch (e) {
                log(`voice-ack post failed (${base}): ${e?.message ?? e}`);
              }

              // Refresh while transcription runs. The bar re-edits ONLY when the
              // real % actually changes (dedup) — no wasted edits, no fake
              // motion. The emoji style cycles each tick. Soft-fail on WA throttle.
              if (ackKey) {
                let frameIdx = 0;
                const _animMs = Number(media.audio_transcribe?.animation_ms)
                  || (_animStyle === 'emoji' ? 4800 : 1000);
                animTimer = setInterval(async () => {
                  frameIdx++;
                  const body = _frame(frameIdx);
                  if (body === _lastBody) return;   // bar: % hasn't moved → skip
                  _lastBody = body;
                  try {
                    await _safeSend(chatJid, { edit: ackKey, text: body });
                  } catch (e) {
                    // Soft-fail; rate-limit / blip shouldn't cascade.
                  }
                }, _animMs);
              }
            }

            // Transcribe (single batch). Same _transcribeAudio for video —
            // ffmpeg pulls the audio track. Silent → null. Stop the animation
            // as soon as the decode settles, before the chain's next link.
            try {
              return await _transcribeAudio({ inputPath: path, outputDir: dir, base });
            } finally {
              if (animTimer) { clearInterval(animTimer); animTimer = null; }
            }
          }).catch(e => { log(`transcribe error (${base}): ${e.message}`); return null; });
          if (transcript?.text && msg.key?.id) {
            _transcriptByMsgId.set(msg.key.id, transcript.text);
          }

          // (3) Finalize ack message with transcript.
          if (animTimer) { clearInterval(animTimer); animTimer = null; }
          if (isAudioForAck && ackKey) {
            try {
              const finalBody = transcript?.text
                ? `👂 ${speaker}'s ${dur}s @ ${hhmm}: ${transcript.text}`
                : `👂 ${speaker}'s ${dur}s @ ${hhmm}: (no transcript)`;
              await _safeSend(chatJid, { edit: ackKey, text: finalBody });
            } catch (e) {
              log(`voice-ack final edit failed (${base}): ${e?.message ?? e}`);
            }
          }
        }
      }
      if (hit.kind === 'video') {
        keyframePath = await _extractVideoKeyframe({ inputPath: path, outputDir: dir, base })
          .catch(e => { log(`keyframe error (${base}): ${e.message}`); return null; });
      }
      // Stash the streaming handle so handleMessage can pick it up by msgId
      // and forward through meta on onIncoming. (Can't just include it in
      // onMediaSaved — that fires once and doesn't carry through to the
      // brain dispatch path.)
      if (voiceStream && msg.key?.id) {
        _voiceStreamsByMsgId.set(msg.key.id, voiceStream);
        // GC: when done resolves (success or error), drop the handle.
        voiceStream.donePromise.finally(() => {
          setTimeout(() => _voiceStreamsByMsgId.delete(msg.key.id), 30_000);
        });
      }
      try { onMediaSaved?.({
        kind: notifyKind, chatJid, msgId, path, sizeBytes: buf.length,
        msgKey: msg.key, msgRaw: msg.message,
        preConnect,
        transcriptPath: transcript?.path ?? null,
        transcript: transcript?.text ?? null,
        keyframePath,
        voiceStream: voiceStream ?? null,
      }); } catch (e) { console.error(`!! whatsapp.mjs:[catch] ${e?.message ?? e}`); }
      return path;
    } catch (e) {
      log(`media download failed (${hit.kind} from ${chatJid}, msgId ${msgId}): ${e.message}`);
      return null;
    }
  }

  // Delete handler — WhatsApp sends a protocolMessage with type=0
  // (REVOKE) when a sender deletes a message. We've already saved
  // the media; move it to a 'deleted/' subdir of its chat so it's
  // preserved + visibly separated from the live media.
  async function _handleRevoke(msg) {
    const proto = msg.message?.protocolMessage;
    if (!proto) return null;
    // type 0 is REVOKE in baileys' enum; some versions string it.
    if (proto.type !== 0 && proto.type !== 'REVOKE') return null;
    const targetId = proto.key?.id;
    const chatJid = proto.key?.remoteJid ?? msg.key?.remoteJid;
    if (!targetId || !chatJid) return null;
    const dir = _mediaDirFor(chatJid);
    const idx = await _readMediaIndex(dir);
    const entry = idx[targetId];
    if (!entry) return null;       // no saved media for that msg
    try {
      const deletedDir = join(dir, 'deleted');
      await fs.mkdir(deletedDir, { recursive: true });
      const newPath = join(deletedDir, entry.filename);
      await fs.rename(entry.path, newPath);
      // Move sidecar .txt if present.
      const sidecar = join(dir, `${entry.base}.txt`);
      if (existsSync(sidecar)) {
        try { await fs.rename(sidecar, join(deletedDir, `${entry.base}.txt`)); } catch (e) { console.error(`!! whatsapp.mjs:[catch] ${e?.message ?? e}`); }
      }
      // Update index: mark deleted, point at new path.
      idx[targetId] = { ...entry, path: newPath, deleted: true, deletedAt: Date.now() };
      await _writeMediaIndex(dir, idx);
      log(`media moved to deleted/: ${entry.kind} from ${chatJid} → ${newPath}`);
      try {
        // proto.key is the ORIGINAL message's key (the deleted one),
        // not the REVOKE envelope. Pass it so the host can still
        // attach a _replyTarget pointing at the original — sometimes
        // useful for "reply to the message that was deleted" UX.
        onMediaSaved?.({
          kind: entry.kind, chatJid, msgId: targetId, path: newPath,
          sizeBytes: 0, deleted: true,
          msgKey: proto.key, msgRaw: null,
        });
      } catch (e) { console.error(`!! whatsapp.mjs:[catch] ${e?.message ?? e}`); }
      return newPath;
    } catch (e) {
      log(`media-revoke move failed (${targetId} in ${chatJid}): ${e.message}`);
      return null;
    }
  }

  async function handleMessage(msg, { bypassAwareness = false } = {}) {
    if (!msg.message) return;               // protocol message / ignored type

    // Oracle reply intercept — if this message is a reply to a live
    // oracle's spinner, route it to the oracle's onReply callback
    // and short-circuit normal dispatch. Operator wanted: anyone in
    // the chat can ask, no wake-word, the question's reply-target
    // (stanzaId) is signal enough.
    //
    // The filter is _sentIds.has(id), NOT fromMe. The bot IS the
    // operator's WhatsApp account; when the operator long-press →
    // Reply on their own phone, the message comes back fromMe=true.
    // We want to PROCESS that. What we want to skip is our own
    // bot-sent echoes (oracle frame edits, persona replies the
    // bridge dispatched). Those are in _sentIds; everything else,
    // including operator's phone-typed messages, falls through.
    if (_liveOracles.size > 0 && !_sentIds.has(msg.key?.id)) {
      const ctx = _contextInfo(msg.message);
      if (ctx?.stanzaId) {
        for (const oracle of _liveOracles.values()) {
          // Match against the oracle's associatedKeys set, not just
          // msgKey.id. The set is seeded with the spinner key and
          // gets the answer-message key appended after each Q+A so
          // operators can reply to the answer to continue the
          // conversation — natural UX. Without this, only replies
          // to the spinner itself triggered the second question.
          if (oracle.associatedKeys?.has(ctx.stanzaId)) {
            try { await oracle.onReply(msg); }
            catch (e) { err(`oracle onReply: ${e.message}`); }
            return;                          // bypass normal flow
          }
        }
      }
    }

    // '@?' wake-word: in-chat genie summon. When the operator
    // types '@?' (alone or with surrounding text) in a chat, the
    // bridge fires onSummonGenie so the host can spin up a genie
    // there. Default access policy: fromMe (operator) only, since
    // a public summon-anywhere is loud and the operator hadn't
    // yet wired allowed_summoners config. Per-chat dedup: if an
    // oracle already runs in this chat, the @? ping is ignored
    // (operator /oracle stop @waN, then /oracle @waN, or simply
    // wait — the existing genie is theirs to use).
    if (typeof onSummonGenie === 'function'
        && msg.key?.fromMe
        && !_sentIds.has(msg.key?.id)) {
      const body = textOf(msg.message);
      if (body && /(?:^|\s)@\?(?=\s|$|[.,!?;])/i.test(body)) {
        const chatJid = msg.key?.remoteJid;
        if (chatJid && !_liveOracles.has(chatJid)) {
          try {
            await onSummonGenie({ chatId: chatJid, fromMessage: msg });
          } catch (e) {
            err(`onSummonGenie: ${e.message}`);
          }
          // Don't return: the original message still records into
          // recent[] and the rest of the awareness flow runs. The
          // genie summon is a side effect of the operator typing
          // '@?', not a replacement for normal message handling.
        }
      }
    }

    // '@movie' wake-word: in-chat movie trigger. The operator (or
    // an allowed_users contact) types '@movie <preset> [args]'
    // anywhere in a message; the bridge fires onSummonMovie with
    // the trigger key so the host edits the trigger message
    // itself into the movie (no separate send). Combined with
    // autoDelete on most presets, the trigger gets revoked
    // automatically after the movie finishes — exactly the
    // 'command replaced by the movie' UX the operator asked for.
    if (typeof onSummonMovie === 'function' && !_sentIds.has(msg.key?.id)) {
      const _chatJid = msg.key?.remoteJid;
      const _isGroup = _chatJid?.endsWith?.('@g.us');
      const _isStatus = _chatJid === 'status@broadcast';
      const _senderJid = (_isGroup || _isStatus) ? msg.key?.participant : _chatJid;
      const _isAuthorized = msg.key?.fromMe || isAuthorizedUser(_senderJid, allowedUsers);
      if (_isAuthorized) {
        const body = textOf(msg.message);
        // '@movie' must stand alone as a token (avoid catching '@movies' or
        // someone's name '@moviefan'); the rest of the line is the args.
        const m = body?.match(/(?:^|\s)@movie\b\s*(.*)$/is);
        if (m) {
          const argsStr = (m[1] || '').trim();
          try {
            await onSummonMovie({
              chatId: _chatJid,
              fromMessage: msg,
              triggerKey: msg.key,
              argsStr,
            });
          } catch (e) {
            err(`onSummonMovie: ${e.message}`);
          }
        }
      }
    }

    // Backlog filter: messages whose timestamp is older than
    // (connectedAt - maxBacklogSeconds) are HELD instead of dispatched.
    // baileys hands you the recent backlog right after WS open, which
    // for a daemon-restart scenario means an @e from 20 minutes ago
    // would otherwise auto-run the brain — surprising and unsafe. We
    // capture them in _heldMessages so the operator can review via
    // /wa-pending and decide whether to dispatch each (or all, or
    // clear them). Set maxBacklogSeconds=0 to disable the hold and
    // restore the old auto-dispatch behaviour.
    if (maxBacklogSeconds >= 0 && connectedAt > 0) {
      const msgTsMs = (Number(msg.messageTimestamp) || 0) * 1000;
      if (msgTsMs > 0 && msgTsMs < connectedAt - maxBacklogSeconds * 1000) {
        // Hold ALL backlog including fromMe (operator 2026-05-23: on
        // reconnect, the operator's own queued sends also pile up — if
        // we let fromMe through, the brain still gets bombarded with
        // 20 dispatches from "while we were offline" sends). Hold
        // means: don't auto-dispatch to brain. Media still saves to
        // disk via onMediaSaved (independent of the hold gate).
        const text = textOf(msg.message);
        if (text) {
          _heldMessages.push({
            jid: msg.key?.remoteJid,
            author: typeof msg.pushName === 'string' && msg.pushName.trim()
              ? msg.pushName.trim()
              : null,
            text,
            ts: msgTsMs,
            key: msg.key?.id ? { id: msg.key.id, fromMe: !!msg.key.fromMe } : null,
            raw: msg,    // kept so the operator can re-dispatch through
                         // the same handleMessage path on /wa-pending
                         // dispatch — single source of truth for awareness
                         // + wake-word + brain routing.
          });
          log(`held pre-connect message from ${msg.key?.remoteJid?.split('@')[0] ?? '?'}: "${text.slice(0, 60)}${text.length > 60 ? '…' : ''}" — /wa-pending to review`);
        }
        return;
      }
    }

    // Filter our own bridge-sent echoes: WhatsApp delivers every outbound
    // back to all linked devices including us. Sent-id tracking knows
    // which messages we just sent — drop those before any awareness check.
    // (Kept even in debug mode so we don't loop the shell-mirror back
    // into the shell as 'incoming'.)
    if (msg.key?.fromMe) {
      const id = msg.key.id;
      if (id && _sentIds.has(id)) {
        _sentIds.delete(id);
        return;
      }
      // Our OWN edits echo back with a NEW outer key.id (the original lives in
      // protocolMessage.key), so the _sentIds check above misses them and they
      // re-enter as a phantom new turn — which is how a voice-ack's transcript
      // edit ("👂 …'s …s @ HH:MM: <transcript>") got dispatched to @e a SECOND
      // time and leaked a reply into a mention-mode chat (operator 2026-06-02,
      // Joyce). An edit of our own message is never a fresh conversational turn;
      // drop it before brain dispatch. The silent recap tracker (messages.upsert
      // above) already folds edits onto recent[] for /recap, so this loses
      // nothing there. Covers voice-ack animation + final edits AND persona
      // stream edits — every bridge-originated edit.
      if (msg.message?.protocolMessage?.editedMessage) return;
    }

    const chatJid0 = msg.key.remoteJid;
    if (!chatJid0) return;
    const isGroup0 = chatJid0.endsWith('@g.us');
    // Track every chat we see traffic in. For 1:1 chats the
    // remote party's pushName (msg.pushName when fromMe=false) is
    // the best available display name. For groups we fill the
    // subject lazily via sock.groupMetadata — see _ensureGroupName
    // below; never use pushName as a group's chat name.
    const msgTsMs = (Number(msg.messageTimestamp) || 0) * 1000 || Date.now();
    const remoteName = (!isGroup0 && !msg.key?.fromMe
      && typeof msg.pushName === 'string' && msg.pushName.trim())
      ? msg.pushName.trim()
      : null;
    _recordChat({ jid: chatJid0, isGroup: isGroup0, name: remoteName, ts: msgTsMs, kind: 'activity' });
    if (isGroup0) _ensureGroupName(chatJid0);
    // self-DM detection: compare BARE numbers, not full JIDs. myJid
    // includes a device-id segment (e.g. '16468217865:42@s.whatsapp.net'),
    // but remoteJid for incoming messages doesn't ('16468217865@s.whatsapp.net').
    // Comparing strings directly always fails for self-DMs.
    // Also accept LID self-DMs ('<lidNumber>@lid'): WhatsApp routes
    // 'Message Yourself' through LID for privacy, and the LID number
    // does NOT match the phone number — we have to compare against
    // myLidNumber separately.
    const chatNumber = chatJid0.split('@')[0]?.split(':')[0];
    const isSelfByPhone = chatNumber === myNumber;
    const isSelfByLid = !!myLidNumber && chatNumber === myLidNumber;
    const isSelfDM = !isGroup0 && (isSelfByPhone || isSelfByLid);
    const fromMe = !!msg.key?.fromMe;

    // Pull text out of whatever variant baileys delivered. We need it
    // BEFORE the awareness check because @<persona> wake-words always
    // pass through regardless of self/personal/group rules — that's
    // how the user can summon egpt from any chat the bridge is linked
    // to without setting personal:'both' or groups:'all'.
    // For reactionMessage variants, _enrichReactionText swaps the
    // "[reaction 👍 (msg <id8>)]" placeholder for "[reaction 👍 to
    // "<short preview of reacted-to msg>"]" when the target body is
    // in our msg-body cache (any message we've observed this session).
    // _recordReaction independently bumps the persistent reaction
    // counter for the logon-summary "most-reacted item" line —
    // happens regardless of whether the reaction reaches onIncoming.
    if (msg.message?.reactionMessage) _recordReaction(msg);
    const text = _enrichVideoText(
      _enrichImageText(
        _enrichAudioText(
          _enrichReactionText(textOf(msg.message), msg),
          msg),
        msg),
      msg);

    // Wake-word: any message containing '@egpt' (as a token) bypasses
    // awareness. Lets the user summon egpt from a friend DM (where
    // personal:'incoming' would otherwise drop their fromMe text) or
    // from a group (where groups:'mentions' would otherwise require
    // @<my-number>, not @egpt). allowed_users gating downstream still
    // restricts who actually triggers anything; non-allowed senders
    // are silently ignored (no in-chat tattle).
    // '@egpt' or its short alias '@e' (/ee/, like 'eel') wakes the persona.
    //
    // Plus: if the message is a WA reply (long-press → Reply, or the
    // operator's '@'-syntax-equivalent in WA UI) whose target is one
    // of our recently-sent messages, treat it as a wake-word. The
    // operator shouldn't need to retype '@e' just because they're
    // continuing a thread the bot started. Catches '@e' threading,
    // oracle replies, and follow-ups on any bot reply across chats.
    const ctxInfo = _contextInfo(msg.message);
    const isReplyToUs = !!ctxInfo?.stanzaId && _sentIds.has(ctxInfo.stanzaId);
    // Reply-as-mention: when the operator long-press → Replies to one
    // of our outbound messages, parse the quoted body's leading
    // persona tag ("🐦 wren: …", "🧠 e: …" per the persona-tag-prefix
    // convention) and treat the reply as an implicit @<persona>
    // mention. Without this, every reply defaults to @e even when
    // the operator clearly meant to address wren — since the daemon
    // sends from the operator's own WhatsApp account, the persona
    // prefix in the body is the only identity channel available.
    let replyPersona = null;
    if (isReplyToUs && ctxInfo?.quotedMessage) {
      const quotedBody = _baseTextOf(ctxInfo.quotedMessage);
      if (quotedBody) {
        // "<optional non-letter prefix like emoji> <name><sep>" —
        // the emoji is decorative, the name is what routes. The
        // separator after the name is either ':' (persona-tag-prefix
        // convention used by heartbeat / outbox-direct sends) or
        // whitespace including '\n' (operator-dispatched and
        // auto_e_chats sends use "<emoji> egpt\n<body>" — no colon).
        const m = quotedBody.match(/^\s*(?:[^a-z0-9\s]+\s+)?([a-z][a-z0-9]{0,15})(?:[\s:]|$)/i);
        if (m) {
          const cand = m[1].toLowerCase();
          // Only personas room.mjs / interpreter actually route. The
          // valid set comes from EGPT_CONFIG.siblings (caller-derived,
          // includes aliases). Unknown prefix falls through to the
          // existing @e default elsewhere.
          if (personaNames.includes(cand)) {
            replyPersona = cand;
          }
        }
      }
    }
    // Operator (2026-05-17): "replies should always trigger e. user
    // doesn't need to do anything special. replies should arrive and
    // trigger e as normal messages do. do not overcomplicate things."
    // When the message is a reply to ANY of our prior sends (isReplyToUs
    // via persisted _sentIds, no 60s cap since a1339c9) and the prefix
    // parse above couldn't pin a specific persona — quoted body was
    // truncated, the original was a system message, the prefix shape
    // didn't match — fall back to 'e' so EVERY reply routes to @e by
    // default. No format requirement on the user side.
    let replyPersonaFallback = false;
    if (isReplyToUs && !replyPersona) {
      replyPersona = 'e';
      replyPersonaFallback = true;
    }
    // Standalone @e/@egpt token (not glued inside a word/email like me@e.com)
    // OR a reply to one of our messages. mentionStatus does the token check.
    const isWakeWord = (!!text && mentionStatus(text).atEAnywhere) || isReplyToUs;

    // Awareness rules — decide whether this message reaches onIncoming.
    //   self_chat:   chat-with-yourself (your phone-typed self-DMs and
    //                any echoes from other devices in the same chat).
    //   personal:    1:1 chats with someone else.
    //   groups:      group chats — handled below since 'mentions' depends
    //                on parsing the message body.
    // Skipped entirely in debug mode, for wake-word messages, or
    // when the host has marked this chat for full passthrough via
    // setBypassChats (e.g. /use or /join binds the chat).
    const hostBypassEarly = _bypassChats.has(chatJid0);
    if (!bypassAwareness && !isWakeWord && !hostBypassEarly && !_storm) {
      if (isSelfDM) {
        if (aware.self_chat === 'off') return;
        if (aware.self_chat === 'incoming' && fromMe) return;
        if (aware.self_chat === 'outgoing' && !fromMe) return;
      } else if (!isGroup0) {
        if (aware.personal === 'off') return;
        if (aware.personal === 'incoming' && fromMe) return;
        if (aware.personal === 'outgoing' && !fromMe) return;
      } else {
        if (aware.groups === 'off') return;
        // 'mentions' filtering happens after we have the body in hand.
      }
    }

    if (!text || !text.trim()) return;

    const chatJid = msg.key.remoteJid;
    if (!chatJid) return;
    const isGroup = chatJid.endsWith('@g.us');
    const isStatus = chatJid === 'status@broadcast';
    const senderJid = isGroup || isStatus ? msg.key.participant : chatJid;
    // chatType: 'group' for @g.us, 'status' for WhatsApp's status@broadcast
    // (every contact's 24h-stories feed — neither private nor a real group),
    // 'private' for 1:1 chats including the self-DM. Surfaced to the host
    // so the cross-surface handle can convey context: groups become
    // <slug>.wa, status posts become status.wa, 1:1 chats keep the bridge
    // client_name (since a DM IS effectively a chat with one person via
    // that device).
    const chatType = isGroup ? 'group' : isStatus ? 'status' : 'private';

    lastChat = chatJid;
    // Auto-capture the WA chat_id ONLY from self-DM messages. The
    // chat_id is meant to be the user's "Message Yourself" chat
    // (the canonical egpt chat). Without this guard, whatever chat
    // the user happens to be in first — a group, a friend's DM —
    // gets persisted as the egpt chat_id, and self-DM messages then
    // fail the egpt-chat check and end up observe-only. Single
    // source of truth for "is this a self-DM" lives in the
    // classifier; we don't pass waConfig because chat_id capture
    // happens before any host-side persistence is relevant.
    if (!chatIdNotified) {
      const { shouldCaptureChatId } = classifyWhatsAppChat({
        chatId: chatJid,
        bridgeInfo: { myJid, myLid, myLidNumber, selfDmJid: myNumber ? `${myNumber}@s.whatsapp.net` : null },
      });
      if (shouldCaptureChatId) {
        chatIdNotified = true;
        try { onChatId?.(chatJid); } catch (e) { console.error(`!! whatsapp.mjs:[catch] ${e?.message ?? e}`); }
      }
    }

    const userId = senderJid?.split(':')[0]?.split('@')[0] ?? '?';
    const username = msg.pushName ?? null;
    const firstName = username ?? `wa:${userId}`;
    _dumpNameDebug(msg);   // @lid name-leak diagnostic (no-op for non-@lid / over cap)
    // Accept allowed-user entries with or without leading '+', spaces,
    // dashes, parens — the WA JID always has the bare digits, but a
    // human writing config might paste '+1 (646) 821-7865'.
    const normalize = (s) => String(s).replace(/[^\d]/g, '');
    // fromMe is authoritative: a message we sent (via any linked
    // device — phone, beeper, the bridge itself) is, by definition,
    // from the operator. Don't require it to match allowed_users —
    // the senderJid for fromMe in a chat using WhatsApp's '@lid'
    // privacy format is the OTHER party's lid, not our phone number,
    // so a strict allowed_users check would lock the operator out
    // of their own commands.
    // A message in the operator's OWN self-DM is, by definition, from the
    // operator — authorize it regardless of fromMe (Beeper / other linked
    // devices arrive WITHOUT a clean fromMe) or jid-form (lid vs phone). This
    // is what un-breaks e.g. /restart sent via Beeper to the self-DM, where the
    // sender reads as the lid and fromMe is absent (operator 2026-06-01).
    const { isSelfDM: _isSelfDMChat } = classifyWhatsAppChat({
      chatId: chatJid,
      bridgeInfo: { myJid, myLid, myLidNumber, selfDmJid: myNumber ? `${myNumber}@s.whatsapp.net` : null },
    });
    // Layer B (src/identity.mjs): the sender's CANONICAL id (lid/phone, device-
    // and group-independent) must be in allowed_users. Pass the raw senderJid —
    // canonicalUserId strips @server/:device/_N and the operator's allow-list
    // carries both lid + phone forms, so they're recognised from any group, 1:1,
    // or device (proven from sender-key data 2026-06-02). Supersedes the ad-hoc
    // normalize() compare.
    const authorized = fromMe || _isSelfDMChat || isAuthorizedUser(senderJid, allowedUsers);

    let processed = text.trim();

    // Mention-mode GATE signal for the host's per-chat auto-mode (mention /
    // mention-direct). It MUST reflect the user's ACTUAL typed body, so it is
    // computed HERE — BEFORE the two @e-routing rewrites below (reply-as-mention
    // synthesis + at_e_anywhere mid-body expansion), both of which PREPEND
    // "@e ". Computing it after the rewrite makes a mid-message @e look like
    // atEStart and silently collapses 'mention-direct' into 'mention' whenever
    // at_e_anywhere is on (the default). Routing still uses the rewritten
    // `processed`; only the gate uses this. The reply-to-our-message case is
    // carried separately via replyToBot, so reply-as-mention needs no atEStart.
    // A reaction NOTIFICATION is not an @e mention — the "@e" is the REACTOR,
    // not an address. Catch BOTH the native WA reaction (msg.reactionMessage)
    // AND the TEXT form that Beeper delivers ('@e reacted ❤ to "[sticker]"…',
    // 'reacted 👍 to "…"'). 9b107c9 only caught the protobuf, so Beeper's text
    // still tripped the mention gate and @e kept replying 'no reaccioné, para
    // de decir' in spoiler_alert (operator 2026-06-03). Pattern-match the
    // reaction-notice shape so it never counts as a mention. (A genuine "@e why
    // did you react?" has no 'reacted <emoji> to "' and still mentions normally.)
    const _isReactionNotice = !!msg.message?.reactionMessage
      || /(^|\s)reacted\s+\S{1,8}\s+to\s+"/i.test(processed)
      || /(^|\s)removed reaction from\s+"/i.test(processed)
      || /^\s*\[reaction\s/i.test(processed);
    // An "@e" inside CODE or a QUOTED line is not the operator addressing @e —
    // it's pasted/forwarded text. Pasting the 'egpt back!' announcement (which
    // contains my own commit subject "…is not an @e mention…") woke @e in a
    // group (operator 2026-06-03); triple-backticks didn't help because the
    // scan ignored markdown. Strip fenced/inline code + quoted ('↳'/'>') lines
    // BEFORE the mention check. A real "@e do this" sits outside code/quotes and
    // still counts. (Gate only — routing may still prepend; the gate decides.)
    const _forMention = String(processed)
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`[^`\n]*`/g, ' ')
      .split('\n').filter(l => !/^\s*(↳|>)/.test(l)).join('\n');
    const _gateMs = _isReactionNotice
      ? { atEStart: false, atEAnywhere: false }
      : mentionStatus(_forMention);

    // Reply-as-mention synthesis (paired with replyPersona detection
    // above). Drop the ↳ quote-preview that textOf prepended and
    // rebuild the body as "@<persona> <reply-text>\n\n↳ <preview>" so
    // parseInput sees a clean mention at start, while the brain still
    // gets the quoted preview as trailing context.
    if (replyPersona) {
      const replyOnly = (_baseTextOf(msg.message) ?? '').trim();
      const quoted = _quotedPreview(ctxInfo);
      processed = quoted
        ? `@${replyPersona} ${replyOnly}\n\n${quoted}`
        : `@${replyPersona} ${replyOnly}`;
    } else if (atEAnywhere && !/^@\S/.test(processed)
               && mentionStatus(processed).atEAnywhere) {
      // Mid-body @e expansion. isWakeWord above detects @e / @egpt
      // anywhere so the awareness gate bypasses, but parseInput is
      // anchored at start — without this synthesis, "hello @e are
      // you up?" wakes the bridge yet routes as a plain message
      // instead of reaching @e. Skipped when the body already
      // starts with any @-mention (operator's explicit target wins,
      // including @wren / @waN / @session-name).
      processed = `@e ${processed}`;
    }

    // Reply context for ANY quoted message. Operator 2026-05-24: replying
    // to a voice note or another user's message must give the brain the
    // quoted content — previously only replies to OUR OWN messages carried
    // it (via replyPersona above), so @e was "out of context" on
    // user-to-user / voice-note replies ("porfa guarda esta info" → "no veo
    // la info"). _quotedPreview reads stored bodies incl. voice transcripts.
    // Skip if replyPersona already appended it.
    if (!replyPersona && ctxInfo?.quotedMessage) {
      const _q = _quotedPreview(ctxInfo);
      if (_q) processed = `${processed}\n\n${_q}`;
    }

    // In groups, awareness 'mentions' (default) requires the message to
    // address us — either via @<our-number> or by replying to one of
    // ours. 'all' lets every group message through. Strip the
    // @<our-number> from the text in either case so command parsing
    // sees a clean string.
    if (chatType !== 'private') {
      const ctx = msg.message.extendedTextMessage?.contextInfo ?? {};
      const mentions = ctx.mentionedJid ?? [];
      const isMentioned = myNumber && mentions.some(m => m.startsWith(`${myNumber}@`));
      const replyingToMe = myJid && ctx.participant === myJid;
      // Awareness gate. Bypassed when the host has marked this chat
      // for full passthrough (typically because /use or /join binds
      // the chat — the operator wants every message visible, not
      // just mentions). bypassAwareness covers debug mode; isWakeWord
      // covers @-summons in 'mentions' chats; _bypassChats covers
      // host-driven per-chat opt-in.
      const hostBypass = _bypassChats.has(chatJid);
      if (!bypassAwareness && !hostBypass && !isWakeWord && !_storm
          && aware.groups === 'mentions' && !isMentioned && !replyingToMe) return;
      if (myNumber) {
        processed = processed.replace(new RegExp(`@${myNumber}\\s*`, 'g'), '').trim();
      }
    }

    // Detect voice/audio source so the host's envelope can annotate
    // the brain prompt ("(transcript from voice note)") without
    // burying the actual content. Operator 2026-05-23: the brain
    // should receive just the transcript text + an envelope hint,
    // NOT the chat-visible sugar (animation + 👂 + pushName +
    // duration). Peel ephemeral / viewOnce envelopes.
    const _audioInner = msg.message?.audioMessage
      ?? msg.message?.ephemeralMessage?.message?.audioMessage
      ?? msg.message?.viewOnceMessage?.message?.audioMessage
      ?? msg.message?.viewOnceMessageV2?.message?.audioMessage
      ?? null;
    const isTranscriptFromVoice = !!_audioInner;

    // Mention status for the host's per-chat auto-mode reply gate — taken from
    // `_gateMs` (captured on the pre-rewrite body above), NOT from the rewritten
    // `processed`, so 'mention-direct' (atEStart) is never falsely tripped by
    // the @e-routing prefix. replyToBot covers the reply-to-our-message case.
    await onIncoming?.(processed, {
      userId, username, firstName, chatId: chatJid, chatType, authorized,
      isTranscriptFromVoice,
      atEStart: _gateMs.atEStart,
      atEAnywhere: _gateMs.atEAnywhere,
      replyToBot: isReplyToUs,
      // Carry the reaction-notice signal so the host hard-blocks any reply to a
      // reaction in EVERY mode (mayEmit), not just the mention gate.
      isReaction: _isReactionNotice,
      // msgKey enables proper WA-reply quoting later — e.g. when the
      // operator types '@m42 …' in shell, we send the reply via
      // baileys with quoted: { key, message } pointing at this msg.
      msgKey: msg.key ? { ...msg.key } : null,
      msgRaw: msg.message ?? null,
      // Reply-as-mention detection (cf77999): when the operator
      // long-press → Replies to one of our outbound messages,
      // this is the persona slug parsed from the quoted body
      // ('e' | 'egpt' | 'me' | 'wren'), else null. The host uses
      // this to enable the streaming/typing indicator only on
      // direct-reply-to-persona — not on plain auto-dispatched
      // arrivals (the latter would spam typing for every group
      // message in an auto_e_chats chat).
      replyPersona,
      // True when replyPersona was assigned via the 36f173a fallback
      // (any reply to us → @e) rather than via clean prefix parse.
      // Host surfaces this in the dispatched prompt so @e knows the
      // intended recipient was inferred, not explicitly tagged.
      replyPersonaFallback,
      // Sender display name (pushName-only per
      // [[feedback-wa-pushname-only]]; never the operator's
      // address book). Used by auto_e_chats queueing to render
      // 'Mike: msg [HH:MM]\nJane: …' when piling messages.
      senderName: firstName ?? username ?? null,
      // Streaming-transcription handle for voice notes (operator
      // 2026-05-22). When present, the dispatcher should open a WA
      // stream message immediately and update its body as chunks
      // arrive, before firing the brain. The full transcript is
      // available via the handle's donePromise; the rest of the
      // system still sees the canonical <base>.transcript.txt via
      // _transcriptByMsgId on completion.
      voiceStream: msg.key?.id ? (_voiceStreamsByMsgId.get(msg.key.id) ?? null) : null,
    });
  }

  // ── Start ─────────────────────────────────────────────────────

  log('whatsapp: starting (baileys)');
  _blog('starting — about to call connect()');
  // Same retry-on-throw protection as the close handler — an initial
  // connect() that fails (network unreachable at boot) used to leave
  // the bridge dead. Now it backs off and retries the same way.
  try { connect(); }
  catch (e) { _scheduleReconnect(`initial connect() threw: ${e.message}`); }

  // Lazy group-subject lookup. Uses sock.groupMetadata which caches
  // server-side. Falls back to the bare JID when we can't reach it.
  async function _groupSubject(jid) {
    try { return (await sock?.groupMetadata?.(jid))?.subject ?? null; }
    catch (e) { console.error(`!! whatsapp.mjs:[catch] ${e?.message ?? e}`); return null; }
  }

  // One-shot proactive refresh of every cached group's name against
  // the server, run on each connection-open. Heals pre-fix corruption
  // (groups whose name was a person's pushName) without waiting for
  // the user to /channels or for a new message to arrive in that
  // chat. Best-effort: failures are logged once, never thrown.
  async function _refreshAllGroupNames() {
    try {
      const groups = await sock?.groupFetchAllParticipating?.();
      if (!groups || typeof groups !== 'object') return;
      let healed = 0;
      for (const [jid, meta] of Object.entries(groups)) {
        const subject = meta?.subject;
        if (!subject || typeof subject !== 'string') continue;
        const cur = _chats.get(jid);
        if (!cur) continue;
        if (cur.name === subject) continue;
        cur.name = subject;
        _chats.set(jid, cur);
        healed++;
      }
      if (healed > 0) {
        _scheduleChatsWrite();
        log(`whatsapp: refreshed ${healed} group name${healed === 1 ? '' : 's'} from server`);
      }
    } catch (e) {
      log(`whatsapp: group-name refresh failed (${e?.message ?? e}); will heal lazily per-message`);
    }
  }

  // Fire-and-forget: when we observe a group with no proper name yet
  // (or a stale pushName-shaped name carried over from the pre-fix
  // chats-cache), reach out to the WA server once for the subject and
  // patch the in-memory entry. Idempotent — _pendingGroupNameLookups
  // suppresses duplicate fetches while one is in flight.
  const _pendingGroupNameLookups = new Set();
  function _ensureGroupName(jid) {
    if (!jid || !jid.endsWith('@g.us')) return;
    if (_pendingGroupNameLookups.has(jid)) return;
    const cur = _chats.get(jid);
    if (cur?.name && cur.name.length > 1) return;
    _pendingGroupNameLookups.add(jid);
    (async () => {
      try {
        const subject = await _groupSubject(jid);
        if (subject) {
          const entry = _chats.get(jid);
          if (entry) {
            entry.name = subject;
            _chats.set(jid, entry);
            _scheduleChatsWrite();
          }
        }
      } finally {
        _pendingGroupNameLookups.delete(jid);
      }
    })();
  }

  // List chats. Returns the user's full chat universe, ordered:
  //   1. Active chats (have a lastActivityTs from real messages /
  //      history-sync), sorted by lastActivityTs desc.
  //   2. Then dormant groups (groupFetchAllParticipating returned
  //      them, but we've never seen a message timestamp), sorted
  //      by creationTs desc.
  // Caller can pass { all: false } to drop the dormant section if
  // they only want active chats. Default is true because the user's
  // expectation is "what WA shows me when I open it" — every group
  // I'm in, with the recent ones at the top.
  async function listChats({ limit = 20, all = true, messagesPerChat = 0, includeStatus = false } = {}) {
    if (!sock) return [];
    // Merge groups from server-side metadata into the in-memory map.
    // Only the CREATION timestamp goes in — never confused with
    // activity, so an idle group doesn't masquerade as recent.
    try {
      const groups = await sock.groupFetchAllParticipating();
      for (const [jid, meta] of Object.entries(groups ?? {})) {
        const subject = meta?.subject ?? null;
        const creationMs = (Number(meta?.creation) || 0) * 1000;
        _recordChat({ jid, isGroup: true, name: subject, ts: creationMs, kind: 'creation' });
      }
    } catch (e) { console.error(`!! whatsapp.mjs:[catch] ${e?.message ?? e}`); /* offline / not yet connected — fall through with what we have */ }

    // Filter + sort. Pinned chats float to the top (sorted among
    // themselves by pin timestamp desc — most recent pin first,
    // matching WA's own list ordering). Then active chats by
    // lastActivityTs desc. Then, if all=true, inactive chats by
    // creationTs. status@broadcast is held in the store for later
    // personality-analysis use but kept out of /channels by default.
    const everything = [..._chats.values()]
      .filter(c => includeStatus || c.jid !== 'status@broadcast');
    // Either source of "pinned" floats a chat to the top. WA's pin
    // caps at 3 phone-side; eGPT's pin layer is unlimited and lives
    // here. Sort the pinned set by max(WA-pin-ts, eGPT-pin-ts) so
    // the most recently pinned (from either source) tops the list.
    const pinScore = c => Math.max(c.pinned || 0, c.egptPinned || 0);
    const isPinned = c => pinScore(c) > 0;
    const pinned   = everything.filter(isPinned)
                               .sort((a, b) => pinScore(b) - pinScore(a));
    const active   = everything.filter(c => !isPinned(c) && c.lastActivityTs > 0)
                               .sort((a, b) => b.lastActivityTs - a.lastActivityTs);
    const inactive = all
      ? everything.filter(c => !isPinned(c) && c.lastActivityTs === 0)
                  .sort((a, b) => b.creationTs - a.creationTs)
      : [];
    const top = [...pinned, ...active, ...inactive].slice(0, limit);

    // Resolve missing names lazily.
    const isSelfDmJid = (jid) => {
      if (!jid) return false;
      const bare = jid.split('@')[0]?.split(':')[0];
      if (!bare) return false;
      if (myNumber && bare === myNumber) return true;
      if (myLidNumber && bare === myLidNumber) return true;
      return false;
    };
    const out = await Promise.all(top.map(async (c) => {
      let name = c.name;
      if (!name && c.isGroup) name = await _groupSubject(c.jid);
      if (!name) name = (c.jid.split('@')[0]?.split(':')[0] ?? c.jid);
      if (isSelfDmJid(c.jid)) name = `${name} (You)`;
      // recent[] is stored oldest-first. Caller asked for N newest.
      const recent = (messagesPerChat > 0 && Array.isArray(c.recent))
        ? c.recent.slice(-messagesPerChat)
        : [];
      return {
        jid: c.jid,
        name,
        isGroup:        c.isGroup,
        lastActivityTs: c.lastActivityTs,
        creationTs:     c.creationTs,
        pinned:         c.pinned || 0,
        egptPinned:     c.egptPinned || 0,
        recent,
      };
    }));
    return out;
  }

  // Explicit history fetch. baileys's sock.fetchMessageHistory needs
  // an anchor (an existing WAMessageKey + timestamp) to fetch older
  // messages going backward — there's no 'fetch from scratch' for a
  // chat we've never seen a message in. Walk the top-N chats by
  // lastActivityTs, find the OLDEST anchor in each chat's recent[]
  // (so the fetch walks further into the past), call fetchMessageHistory.
  // Returned messages arrive asynchronously via messaging-history.set
  // and feed the same silent _chats tracker. Caller can /channels
  // again a moment later to see the populated previews.
  //
  // Returns { requested, skipped } so caller knows how many fetches
  // went out vs how many chats lacked any anchor.
  async function prefetchHistoryForTopChats({ chatLimit = 20, perChat = 10 } = {}) {
    if (!sock) return { requested: 0, skipped: 0 };
    const chats = [..._chats.values()]
      .filter(c => c.lastActivityTs > 0 && Array.isArray(c.recent) && c.recent.length > 0 && c.recent[0].key?.id)
      .sort((a, b) => b.lastActivityTs - a.lastActivityTs)
      .slice(0, chatLimit);
    const skipped = [..._chats.values()].filter(c => c.lastActivityTs > 0).length - chats.length;
    let requested = 0;
    for (const c of chats) {
      // oldest anchor — fetchMessageHistory walks BACKWARD from this
      // point, so anchoring at the oldest in our cache gets the
      // largest new window.
      const anchor = c.recent[0];
      try {
        await sock.fetchMessageHistory(perChat, {
          remoteJid: c.jid,
          id: anchor.key.id,
          fromMe: !!anchor.key.fromMe,
        }, anchor.ts / 1000 | 0);
        requested++;
      } catch (e) {
        // Single-chat failures don't abort the whole prefetch. Common
        // cause: anchor key not recognized server-side (e.g., a chat
        // we know about but baileys never actually saw the message,
        // which can happen if our cache outlived the sync state).
        err(`prefetchHistory ${c.jid}: ${e.message}`);
      }
    }
    return { requested, skipped };
  }

  // Friendly chat name lookup from the in-memory _chats cache. Returns
  // the WA chat title (group subject or DM pushName) when known, else
  // null. Synchronous — callers that need a guaranteed name (e.g. for
  // group subjects we haven't observed yet) should call listChats first
  // or fall back themselves.
  function getChatName(jid) {
    if (!jid) return null;
    const c = _chats.get(jid);
    if (c?.name) return c.name;
    return null;
  }
  // Slugified chat label suitable for a handle's @<client> segment,
  // e.g. 'auge_family' for the group "Auge — Family Chat". Falls back
  // to the bare phone-number prefix of the JID (so DMs without a cached
  // pushName still render as something stable).
  function getChatSlug(jid) {
    if (!jid) return null;
    const name = getChatName(jid);
    if (name) return _slugify(name, 24) || null;
    const local = jid.split('@')[0]?.split(':')[0] ?? null;
    return local ? _slugify(local, 24) : null;
  }

  // eGPT-side pin layer. Independent of WA's 3-pin phone limit:
  // /pin @waN sets a positive timestamp; /unpin clears it. Returns
  // the new state ('pinned' | 'unpinned' | 'unknown') so the host
  // can confirm. Persists immediately via _scheduleChatsWrite.
  function setEgptPin(jid, on) {
    if (!jid) return 'unknown';
    const cur = _chats.get(jid);
    if (!cur) return 'unknown';
    cur.egptPinned = on ? Date.now() : 0;
    _chats.set(jid, cur);
    _scheduleChatsWrite();
    return on ? 'pinned' : 'unpinned';
  }
  // Snapshot of every eGPT-pinned chat — used by /pin (no arg) to
  // list current pins regardless of WA pin state. Sorted by pin ts
  // desc so the most recent /pin shows first.
  function listEgptPinned() {
    return [..._chats.values()]
      .filter(c => (c.egptPinned || 0) > 0)
      .sort((a, b) => (b.egptPinned || 0) - (a.egptPinned || 0))
      .map(c => ({ jid: c.jid, name: c.name, isGroup: !!c.isGroup, egptPinned: c.egptPinned }));
  }

  // If this line never appears in wa-bridge.log, an await ABOVE (auth-state /
  // version fetch) hung and the handle was never returned → the host's
  // `await startBaileysBridge(...)` never resolved → waBridgeRef.current stays
  // null → every outbound "no baileys bridge here". This is the key signal.
  _blog('handle RETURNED to host (waBridgeRef will be set)');
  return {
    listChats,
    prefetchHistoryForTopChats,
    getChatName,
    getChatSlug,
    setEgptPin,
    listEgptPinned,
    // Fire-and-forget group-name lookup. Idempotent (returns
    // immediately if the chat already has a name OR if a fetch is
    // already in flight). Used by /recap to backfill names for any
    // group whose chat record is on disk but lacks a subject —
    // typically groups that haven't appeared in /channels yet.
    ensureGroupName: _ensureGroupName,
    // Change a group's subject (the visible group name in WA UI).
    // Requires the bot account to be an admin of the group; baileys
    // throws otherwise (e.g. 403 / "not authorized"). Wrapped in
    // _timeBound so a flapping WS doesn't hang the caller.
    // Returns true on success, throws on failure (caller logs +
    // surfaces). jid must be a group JID (ends with @g.us).
    async setGroupSubject({ jid, subject }) {
      if (!sock) throw new Error('setGroupSubject: no sock');
      if (!jid || !String(jid).endsWith('@g.us')) {
        throw new Error(`setGroupSubject: jid must be a group (@g.us), got ${jid}`);
      }
      if (typeof subject !== 'string') {
        throw new Error('setGroupSubject: subject must be a string');
      }
      await _timeBound(sock.groupUpdateSubject(jid, subject), 'groupUpdateSubject');
      return true;
    },
    async getGroupMembers({ jid }) {
      if (!sock) throw new Error('getGroupMembers: no sock');
      if (!jid || !String(jid).endsWith('@g.us')) {
        throw new Error(`getGroupMembers: jid must be a group (@g.us), got ${jid}`);
      }
      const meta = await _timeBound(sock.groupMetadata(jid), 'groupMetadata');
      if (!meta || !meta.participants) {
        return [];
      }
      return meta.participants.map(p => ({
        jid: p.jid,
        pushName: p.name || p.pushName || '',
        admin: p.admin || null
      }));
    },
    // React to an existing WA message. `key` is the WAMessageKey of
    // the target; `emoji` is the literal reaction text (or '' /
    // null to remove an existing reaction from the same target).
    // Returns the baileys send result so the caller can capture the
    // reaction's own key for echo bookkeeping.
    async react({ chatId, key, emoji }) {
      if (!sock) return null;
      const target = chatId ?? lastChat;
      if (!target || !key?.id) return null;
      return _timeBound(
        sock.sendMessage(target, { react: { text: emoji ?? '', key } }),
        'react',
      ).catch(e => { err(`react: ${e.message}`); return null; });
    },
    // Edit an existing message in place. Used by /oracle to
    // transform a '🔮 thinking…' placeholder into the brain's
    // answer once it lands. Returns the baileys send result.
    async editMessage({ chatId, key, text }) {
      if (!sock) return null;
      const target = chatId ?? lastChat;
      if (!target || !key?.id) return null;
      return _timeBound(
        _safeSend(target, { edit: key, text }),
        'editMessage',
      ).then(r => { rememberSent(r?.key?.id); return r; })
       .catch(e => { err(`editMessage: ${e.message}`); return null; });
    },
    // Summon a phased oracle/genie in `chatId`. The animation runs
    // through four phases — summon (linear intro) → idle (cyclic,
    // waiting for question) → thinking (cyclic, brain working) →
    // retire (linear outro) — with the bridge handling transitions
    // based on handle.state.
    //
    // questionsLeft counts down once per answered reply. When it
    // hits zero (or stop() is called) the oracle plays the retire
    // animation and deletes itself.
    //
    // phases.idleFn(N) lets the slash command parameterize idle
    // frames on the current wish count ("3 wishes left" → "2 wishes
    // left" → …). Re-evaluated each idle iteration. phases.idle (a
    // static array) is the fallback if no idleFn provided.
    //
    // Returns the handle ({ msgKey, stop, state, questionsLeft, … }).
    async startOracle({
      chatId,
      phases = {},
      frameMs = 3000,
      summonMs,                       // override for the summon-phase cadence; defaults to frameMs / 2 (min 1200)
      onReply,
      onBusy,
      questionsLeft = 1,
      // idleAnimationBudget — max idle-phase edits emitted per idle
      // cycle. Once reached, the loop stops emitting until the
      // oracle transitions out of idle (e.g. into thinking on a
      // reply). Resets on each fresh entry into idle. The reason
      // for the cap: WA edits are supposed to be silent on the
      // recipient side, but some clients re-surface the chat in
      // the chat list (or show 'edited' indicators) on each one,
      // and a perpetual idle animation generates a steady drip of
      // those across every member of the chat. Capping at ~20
      // emits gives the genie ~2 cycles of liveness then settles
      // into a static face — enough to feel alive without
      // flooding anyone's phone. Set to 0 to animate forever
      // (matches pre-cap behavior).
      idleAnimationBudget = 20,
    }) {
      if (!sock) return null;
      const target = chatId ?? lastChat;
      if (!target) return null;
      const summonFrames   = Array.isArray(phases.summon)   ? phases.summon   : [];
      const idleFrames     = Array.isArray(phases.idle)     ? phases.idle     : [];
      const thinkingFrames = Array.isArray(phases.thinking) ? phases.thinking : [];
      const retireFrames   = Array.isArray(phases.retire)   ? phases.retire   : [];
      const idleFn         = typeof phases.idleFn === 'function' ? phases.idleFn : null;
      const initialFrame = summonFrames[0]
        ?? (idleFn ? idleFn(questionsLeft)[0] : idleFrames[0])
        ?? '🧞';
      const r0 = await _timeBound(
        _safeSend(target, { text: initialFrame }),
        'oracle initial',
      ).catch(e => { err(`oracle initial: ${e.message}`); return null; });
      const msgKey = r0?.key;
      if (!msgKey) return null;
      rememberSent(msgKey.id);

      const summonFrameMs = summonMs ?? Math.max(1200, Math.floor(frameMs / 2));
      const handle = {
        msgKey,
        chatId: target,
        state: 'summoning',           // → 'idle' → 'thinking' → 'idle' / 'retiring' → 'retired'
        questionsLeft,
        // Set of message ids the oracle "owns" — the spinner key
        // plus every answer-message key the host (slash file) adds
        // after wa.replyTo + editMessage. Reply intercept matches
        // against this so operators can reply to the answer to
        // continue the conversation instead of having to hunt
        // back to the spinner.
        associatedKeys: new Set([msgKey.id]),
        onReply: async (replyMsg) => {
          if (handle.state !== 'idle') {
            if (typeof onBusy === 'function') {
              try { await onBusy(replyMsg, handle); } catch (e) { err(`oracle onBusy: ${e.message}`); }
            }
            return;
          }
          handle.state = 'thinking';
          try { await onReply?.(replyMsg, handle); }
          finally {
            if (handle.state === 'retired') return;
            handle.questionsLeft = Math.max(0, handle.questionsLeft - 1);
            if (handle.questionsLeft > 0) {
              handle.state = 'idle';
            } else {
              handle.state = 'retiring';
              // retire frames play linearly; then stop() deletes the
              // message. Wrapped in the loop below.
            }
          }
        },
        stop: async () => {
          if (handle.state === 'retired') return;
          handle.state = 'retired';
          _liveOracles.delete(target);
          try { await _timeBound(sock.sendMessage(target, { delete: msgKey }), 'oracle delete'); }
          catch (e) { console.error(`!! whatsapp.mjs:[catch] ${e?.message ?? e}`); }
        },
      };
      _liveOracles.set(target, handle);

      // Edit helper — single place for rate-overlimit handling.
      let lastSent = initialFrame;
      async function emit(text) {
        if (!text || text === lastSent) return;
        try {
          await _timeBound(_safeSend(target, { edit: msgKey, text }), 'oracle frame');
          lastSent = text;
        } catch (e) {
          const rateLimited = /rate-overlimit/i.test(e.message ?? '');
          if (!rateLimited) err(`oracle frame: ${e.message}`);
          else log(`oracle frame rate-limited; backing off`);
          await new Promise(r => setTimeout(r, rateLimited ? 8000 : 3000));
        }
      }
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));

      // Phased animation driver. Walks summon → idle/thinking
      // cycle → retire, then deletes the message.
      (async () => {
        // Phase 1: summon — linear after the initial send. Faster
        // cadence than idle/thinking since the recipient's chat
        // is fresh and WA's edit-rate ceiling resets per message;
        // the burst is fine, sustained edits are what trip it.
        for (let i = 1; i < summonFrames.length; i++) {
          if (handle.state !== 'summoning') break;
          await sleep(summonFrameMs);
          if (handle.state !== 'summoning') break;
          await emit(summonFrames[i]);
        }
        if (handle.state === 'summoning') handle.state = 'idle';

        // Phase 2: idle/thinking cycles. Loop until 'retiring' or
        // 'retired'. idleFn(N) re-rendered each iteration so a
        // changed wish count surfaces immediately.
        // dwell carries the just-emitted frame's hold time. Idle
        // frames may be either plain strings (dwell = frameMs) or
        // { text, ms } objects (dwell = ms) — lets a storyboard
        // flash a quick blink/wink (~300ms) between long open
        // beats (~6s) so the face feels alive without burning
        // WA's edit-rate ceiling on average.
        //
        // idleEmits counts emitted idle frames in the current idle
        // cycle and resets on each fresh entry into idle (from
        // summoning/thinking). Once the budget is exhausted, the
        // loop sleeps in place — the face freezes on whatever
        // frame was last emitted, no more edits go out, and the
        // chat list stops re-surfacing.
        let idleIdx = 0, thinkingIdx = 0;
        let dwell = frameMs;
        let idleEmits = 0;
        let prevState = handle.state;
        while (handle.state !== 'retired' && handle.state !== 'retiring') {
          await sleep(dwell);
          if (handle.state === 'retired' || handle.state === 'retiring') break;
          if (handle.state === 'idle' && prevState !== 'idle') idleEmits = 0;
          prevState = handle.state;
          dwell = frameMs;
          if (handle.state === 'thinking' && thinkingFrames.length) {
            thinkingIdx = (thinkingIdx + 1) % thinkingFrames.length;
            await emit(thinkingFrames[thinkingIdx]);
          } else if (handle.state === 'idle') {
            if (idleAnimationBudget > 0 && idleEmits >= idleAnimationBudget) continue;
            const frames = idleFn ? idleFn(handle.questionsLeft) : idleFrames;
            if (frames.length) {
              idleIdx = (idleIdx + 1) % frames.length;
              const f = frames[idleIdx];
              const text = (f && typeof f === 'object') ? f.text : f;
              if (f && typeof f === 'object' && Number(f.ms) > 0) {
                dwell = Math.max(150, Number(f.ms));
              }
              await emit(text);
              idleEmits++;
            }
          }
        }

        // Phase 3: retire — linear outro before deletion.
        if (handle.state === 'retiring') {
          for (let i = 0; i < retireFrames.length; i++) {
            await emit(retireFrames[i]);
            await sleep(frameMs);
            if (handle.state === 'retired') break;
          }
          await handle.stop();
        }
      })().catch(e => err(`oracle loop: ${e.message}`));
      return handle;
    },
    // Retire the oracle running in `chatId` (or do nothing if none).
    // Returns true if an oracle was actually stopped.
    async stopOracle(chatId) {
      const target = chatId ?? lastChat;
      const handle = _liveOracles.get(target);
      if (!handle) return false;
      await handle.stop();
      return true;
    },
    // Retire every live oracle across every chat. Returns count.
    async stopAllOracles() {
      const handles = [..._liveOracles.values()];
      for (const h of handles) {
        try { await h.stop(); } catch (e) { console.error(`!! whatsapp.mjs:[catch] ${e?.message ?? e}`); }
      }
      return handles.length;
    },
    // Snapshot of currently-live oracles — used by /oracle (no arg)
    // to list active oracles across chats. Returns { jid, name (via
    // getChatName lookup at call time) }.
    listOracles() {
      return [..._liveOracles.values()].map(h => ({
        chatId: h.chatId,
        name: getChatName(h.chatId),
        state: h.state,
      }));
    },
    // Play a frame sequence as a single message that edits itself.
    // frames is an array of strings; the first is sent fresh, each
    // subsequent edit replaces the message body after frameMs delay.
    // Skip-identical-frame optimization so a sloppy frame array
    // (e.g. duplicate keyframes) doesn't waste edit budget.
    //
    // autoDelete + holdMs: after the last frame, wait holdMs then
    // revoke the message (delete-for-everyone). Default behavior
    // for /movie since the operator wanted ephemeral movies — the
    // animation plays, the recipient sees it, then the message
    // disappears. holdMs is per-call so a movie with a punchline
    // (e.g. --secret) can linger longer than a sparkler.
    //
    // Separate code path from startStreamMessage's edit pump —
    // that one is debounced to 2.5s for brain typing, this needs
    // the tighter frame rate of an animation (~200-800ms). The
    // protocolMessage.editedMessage echo handler folds the edits
    // onto the original recent[] entry, so /recap won't see N
    // mid-frame rows.
    // existingKey — when set, skip the initial send and use this
    // pre-existing WA message key as the canvas. Frame 0 goes out as
    // an edit (not a fresh send) so a chat-side trigger like an
    // operator typing '@movie alien' becomes the movie in place,
    // and autoDelete cleanly revokes the trigger at the end.
    async playFrames({ chatId, frames, frameMs = 700, autoDelete = false, holdMs = 2000, existingKey = null }) {
      if (!sock) return null;
      const target = chatId ?? lastChat;
      if (!target || !Array.isArray(frames) || !frames.length) return null;
      let msgKey;
      if (existingKey?.id) {
        msgKey = existingKey;
        await _timeBound(
          _safeSend(target, { edit: msgKey, text: frames[0] }),
          'movie initial (edit)',
        ).catch(e => err(`movie initial edit: ${e.message}`));
        rememberSent(msgKey.id);
      } else {
        const r0 = await _timeBound(
          _safeSend(target, { text: frames[0] }),
          'movie initial',
        ).catch(e => { err(`movie initial: ${e.message}`); return null; });
        msgKey = r0?.key;
        if (!msgKey) return null;
        rememberSent(msgKey.id);
      }
      let lastSent = frames[0];
      for (let i = 1; i < frames.length; i++) {
        await new Promise(resolve => setTimeout(resolve, frameMs));
        if (frames[i] === lastSent) continue;
        await _timeBound(
          _safeSend(target, { edit: msgKey, text: frames[i] }),
          `movie frame ${i + 1}/${frames.length}`,
        ).catch(e => err(`movie frame ${i + 1}: ${e.message}`));
        lastSent = frames[i];
      }
      if (autoDelete) {
        await new Promise(resolve => setTimeout(resolve, holdMs));
        await _timeBound(
          sock.sendMessage(target, { delete: msgKey }),
          'movie delete',
        ).catch(e => err(`movie delete: ${e.message}`));
      }
      return { key: msgKey, deleted: autoDelete };
    },
    async send(text, { chatId, deliverEcho = false, _noRelay = false } = {}) {
      // NO lastChat fallback. A send with no explicit chatId used to go to
      // whatever chat messaged the bridge last — which leaked shell/brain/@e
      // replies into a stranger's chat, re-firing on every interaction
      // (operator 2026-06-02: @e's answer to the operator kept landing in
      // Eduardo's chat). Every send must NAME its target; a missing chatId is a
      // caller bug — drop + log, never guess a recipient.
      const target = chatId;
      if (!target) {
        log(`send: DROPPED — no chatId (no lastChat fallback; would leak). body="${String(text ?? '').trim().slice(0, 40)}"`);
        return null;
      }
      // Defense-in-depth silence filter (must run before the outbox relay too —
      // silence shouldn't get spooled to the daemon either).
      if (isSilenceMarker(text)) {
        log(`send: dropping silence-marker "${String(text).trim().slice(0, 40)}" → ${target}`);
        return { silenced: true };
      }
      // Bridge deferred to another egpt — relay via the outbox so the holder
      // of the WA session does the send. _noRelay is the loop-breaker: when
      // OUR outbox watcher dispatches a wa-send to OUR bridge and we're
      // deferred, relaying again writes a new outbox event we'll just pick
      // up next sweep — a CPU-burning infinite loop that flooded the
      // operator's WA bridge with 1500+ duplicate sends (2026-05-29).
      // _noRelay → null tells the watcher "couldn't dispatch right now"
      // and it leaves the file for the next attempt (when our bridge has
      // reconnected, or another egpt with WA processes it first).
      if (!sock && _deferredToPid) {
        if (_noRelay) return null;
        try {
          const r = await _outboxWaSend({ jid: target, body: text, from: `egpt-pid-${process.pid}` });
          log(`send: relayed via outbox → ${target} (deferred to pid ${_deferredToPid}; file ${r.filename})`);
          return { relayed: true, outbox: r.filename };
        } catch (e) {
          err(`send: outbox relay failed → ${target}: ${e.message}`);
          return null;
        }
      }
      if (!sock) return null;
      // deliverEcho: skip rememberSent so this outbound is NOT filtered as a
      // self-echo when it comes back fromMe — it flows through onIncoming and
      // (in an auto_e chat) broadcasts to the chat's resident brains. Used by
      // the /e confirm watcher so the Self-DM residents (system-e / system-l)
      // see the debug mirror as normal chat messages they can react to.
      // Chunk long bodies so WA's per-message limit (or any
      // intermediate baileys quirk at large sizes) doesn't silently
      // truncate the reply. First chunk's send result is what the
      // caller gets back — that's the one whose key matters for
      // @m<N> reply-target threading. Subsequent chunks fire
      // sequentially as fresh sends so order is preserved.
      const chunks = chunkText(text, chunkChars);
      let firstResult = null;
      for (let i = 0; i < chunks.length; i++) {
        try {
          const r = await _timeBound(_safeSend(target, { text: chunks[i] }), 'send');
          if (!deliverEcho) rememberSent(r?.key?.id);
          if (i === 0) firstResult = r;
        } catch (e) {
          err(`send${chunks.length > 1 ? ` (chunk ${i + 1}/${chunks.length})` : ''}: ${e.message}`);
          // On failure mid-chunk we bail and return what we have so
          // far — caller's null-check still triggers the operator
          // breadcrumb if the FIRST chunk failed; partial delivery
          // is at least visible to the recipient.
          if (i === 0) return null;
          return firstResult;
        }
      }
      return firstResult;
    },
    // Outbound media — send a file as its native WA attachment. Pass a `path`
    // (read here) or a ready `buffer`. `kind` ('image'|'video'|'audio'|
    // 'document') is inferred from mimetype/extension when omitted. `caption`
    // rides on image/video/document; `ptt:true` makes audio a voice note.
    // Used by /inject-to-group and any future E-sends-media path.
    async sendMedia({ chatId, path, buffer, kind, caption, fileName, mimetype, ptt } = {}) {
      const target = chatId ?? lastChat;
      if (!target || !sock) return null;
      let buf = buffer;
      if (!buf && path) {
        try { buf = await fs.readFile(path); }
        catch (e) { err(`sendMedia: read ${path}: ${e.message}`); return null; }
      }
      if (!buf) { log('sendMedia: nothing to send (no path/buffer)'); return null; }
      const ext = (extname(fileName ?? path ?? '') || '').replace(/^\./, '').toLowerCase();
      const mt = mimetype ?? _MIME_BY_EXT[ext] ?? null;
      const k = kind ?? _mediaKind(mt, ext);
      const name = fileName ?? (path ? basename(path) : 'file');
      let payload;
      if (k === 'image')      payload = { image: buf, ...(mt ? { mimetype: mt } : {}), ...(caption ? { caption } : {}) };
      else if (k === 'video') payload = { video: buf, ...(mt ? { mimetype: mt } : {}), ...(caption ? { caption } : {}) };
      else if (k === 'audio') payload = { audio: buf, mimetype: mt ?? 'audio/ogg; codecs=opus', ptt: !!ptt };
      else                    payload = { document: buf, mimetype: mt ?? 'application/octet-stream', fileName: name, ...(caption ? { caption } : {}) };
      try {
        const r = await _timeBound(_safeSend(target, payload), 'sendMedia');
        rememberSent(r?.key?.id);
        log(`sendMedia: ${k} (${(buf.length / 1024).toFixed(0)}KB) → ${target}`);
        return r;
      } catch (e) { err(`sendMedia: ${e.message}`); return null; }
    },
    // Reply to a specific message with a WA-native quote. `key` is the
    // baileys WAMessageKey of the message being replied to; `raw` is
    // the inner m.message (kept around for the quote header — baileys
    // wants a minimal message body inside `quoted`). Falls back to
    // `send` if either is missing.
    async replyTo({ chatId, key, raw, text }) {
      if (!sock) return null;
      const target = chatId ?? lastChat;
      if (!target) return null;
      // Return the baileys send-result so callers can capture the new
      // message's key and attach it to the echo's _replyTarget — that
      // way the operator's reply gets a stable id derived from the WA
      // key (wa-<id>) instead of a random u-<rnd>, and subsequent
      // '@wa-<id> …' references reach this message correctly.
      if (!key) {
        return _timeBound(_safeSend(target, { text }), 'replyTo (fallback send)')
          .then(r => { rememberSent(r?.key?.id); return r; })
          .catch(e => { err(`replyTo (fallback send): ${e.message}`); return null; });
      }
      const quoted = { key, message: raw ?? { conversation: '' } };
      return _timeBound(_safeSend(target, { text }, { quoted }), 'replyTo')
        .then(r => { rememberSent(r?.key?.id); return r; })
        .catch(e => { err(`replyTo: ${e.message}`); return null; });
    },
    startStreamMessage(initialText, { chatId, quoted: quotedOpt = null } = {}) {
      // Edit-based streaming, modeled on bridges/telegram.mjs:
      //   1. Send the initial message and capture its key.
      //   2. Each update() debounces an edit (2.5s — WA is more rate-
      //      sensitive than Telegram, and the recipient sees an
      //      "Edited" badge after the first edit, so we don't want
      //      to spam).
      //   3. A 'composing' presence update fires alongside, refreshed
      //      every 8s so the typing indicator stays visible until
      //      finish() (baileys auto-expires it after ~10s otherwise).
      //   4. finish() flushes the last pending edit and clears typing.
      const target = chatId ?? lastChat;
      if (!target || !sock) return null;

      let msgKey      = null;
      let pending     = null;
      let lastSent    = initialText;
      let lastEditAt  = Date.now();
      let editTimer   = null;
      let typingTimer = null;
      let initialDone = false;
      let finished    = false;
      // Track whether ANY message has actually reached WA. Set to true
      // when the initial send returns a key OR when finish() falls back
      // to a fresh send and that succeeds. Callers (persona dispatch in
      // egpt.mjs) check this after finish() and fall back to a plain
      // bridge.send when false — otherwise a rate-limited / WS-blipped
      // stream fails silently and the user sees no reply.
      let delivered   = false;
      let lastError   = null;

      const refreshTyping = () => {
        if (finished) return;
        sock.sendPresenceUpdate?.('composing', target).catch(e => console.error(`!! whatsapp.mjs:[promise-catch] ${e?.message ?? e}`));
        if (typingTimer) clearTimeout(typingTimer);
        typingTimer = setTimeout(refreshTyping, typingRefreshMs);
      };
      const stopTyping = () => {
        if (typingTimer) { clearTimeout(typingTimer); typingTimer = null; }
        sock.sendPresenceUpdate?.('paused', target).catch(e => console.error(`!! whatsapp.mjs:[promise-catch] ${e?.message ?? e}`));
      };

      // Deferred initial send — operator (2026-05-19): when @e returns
      // '…' the recipient should see NOTHING. Sending the '⌛ thinking…'
      // placeholder upfront, then revoking, leaks: recipient glimpses
      // the placeholder before the revoke lands. Solution: don't send
      // anything until the first non-silence update / finish arrives.
      // initialText is dropped; the first real content becomes the
      // initial send. cancel() before that = nothing ever sent.
      //
      // Typing indicator still fires immediately so OTHER party sees
      // "typing…" while haiku produces; that's free (presence update,
      // no message in the chat).
      refreshTyping();

      // Send the first chunk that arrives — promotes update→initial
      // when no msgKey yet. Marked async so we await it from flush();
      // concurrent updates queue via pending+lastSent the same as edits.
      async function _doInitialSend(text) {
        if (msgKey || initialDone) return;
        initialDone = true; // claim slot synchronously to avoid double-send
        try {
          // quotedOpt is applied to the INITIAL send only — subsequent
          // edits don't carry quoted (they replace the same message).
          // Used by the voice-as-reply-transcript path so the streaming
          // edit message starts as a native WA reply to the voice.
          const opts = quotedOpt ? { quoted: quotedOpt } : undefined;
          const r = await _timeBound(_safeSend(target, { text }, opts), 'stream initial');
          msgKey = r?.key ?? null;
          rememberSent(r?.key?.id);
          if (r?.key) { delivered = true; lastSent = text; }
        } catch (e) {
          lastError = e.message;
          err(`stream initial: ${e.message}`);
          initialDone = false; // let a retry happen on finish()
        }
      }

      function flush() {
        if (editTimer) { clearTimeout(editTimer); editTimer = null; }
        if (pending === null || pending === lastSent) return;
        const text = pending;
        pending = null;
        // No initial sent yet — first chunk becomes the initial send
        // (deferred-placeholder model). Subsequent flushes edit it.
        if (!msgKey) {
          _doInitialSend(text).catch(e => console.error(`!! whatsapp.mjs:[promise-catch] ${e?.message ?? e}`));
          return;
        }
        _timeBound(_safeSend(target, { edit: msgKey, text }), 'stream edit')
          .then((r) => {
            rememberSent(r?.key?.id);
            lastSent = text;
            lastEditAt = Date.now();
          })
          .catch((e) => { lastError = e.message; err(`stream edit: ${e.message}`); });
      }

      function maybeEdit() {
        const since    = Date.now() - lastEditAt;
        const interval = editCadenceMs;
        if (since >= interval) flush();
        else if (!editTimer) {
          editTimer = setTimeout(() => { editTimer = null; flush(); }, interval - since);
        }
      }

      return {
        update(text) {
          if (finished) return;
          // Never let a silence-marker (e.g. "🐶 e\n…") land as a
          // placeholder edit — finish/cancel handles the silence path
          // by revoking. Without this guard, a fast brain that returns
          // '...' produces update('🐶 e\n...') → flush edits the
          // placeholder → cancel's revoke races against the already-
          // landed edit and the recipient sees "🐶 e\n…" anyway.
          // Operator-reported leak path (2026-05-17 22:31 in Lu Lu chat).
          if (isSilenceMarker(text)) return;
          pending = text;
          refreshTyping();   // keep "typing…" alive while the brain is still producing
          maybeEdit();
        },
        async finish(text) {
          // Silence-marker → revoke the placeholder instead of editing it
          // to "…" (which the recipient sees as a stranded "🐶 …" message).
          // Operator-reported leak path: persona returns '...', caller calls
          // finish('🐶 …'), placeholder gets edited to '🐶 …', stays visible.
          if (isSilenceMarker(text)) {
            return this.cancel();
          }
          finished = true;
          pending = text;
          if (editTimer) { clearTimeout(editTimer); editTimer = null; }
          // Final edit synchronous-ish so the recipient sees the
          // complete text before the typing indicator drops. If the
          // initial send is still in-flight, fall back to a plain
          // send (the recipient hasn't seen anything yet).
          try {
            // Long replies get chunked: edit covers the first chunk;
            // remaining chunks land as fresh sends. WA's edit can
            // misbehave at large sizes, and the recipient sees a
            // tidier "head edited + continuation messages" instead
            // of either a silent truncation or a giant scroll-wall.
            const chunks = chunkText(pending, chunkChars);
            if (initialDone && msgKey) {
              if (chunks[0] !== lastSent) {
                const r = await _timeBound(
                  _safeSend(target, { edit: msgKey, text: chunks[0] }),
                  'stream finish edit',
                );
                rememberSent(r?.key?.id);
                lastSent = chunks[0];
                if (r?.key) delivered = true;
              } else {
                // Already up to date from prior edits — that's a delivery.
                delivered = true;
              }
            } else {
              // Initial send failed or still in flight: plain send.
              const r = await _timeBound(
                _safeSend(target, { text: chunks[0] }),
                'stream finish send',
              );
              rememberSent(r?.key?.id);
              if (r?.key) { msgKey = r.key; delivered = true; }
            }
            // Continuation chunks (only relevant for long replies).
            for (let i = 1; i < chunks.length; i++) {
              try {
                const r = await _timeBound(
                  _safeSend(target, { text: chunks[i] }),
                  `stream finish chunk ${i + 1}/${chunks.length}`,
                );
                rememberSent(r?.key?.id);
              } catch (e) {
                lastError = e.message;
                err(`stream finish chunk ${i + 1}/${chunks.length}: ${e.message}`);
                // Stop chunking — host's fallback will see delivered
                // (chunk 0 reached WA) but lastError records the
                // truncation so the operator knows the tail was lost.
                break;
              }
            }
          } catch (e) {
            lastError = e.message;
            err(`stream finish: ${e.message}`);
          }
          stopTyping();
        },
        // Did any message actually reach WA? Callers use this after
        // finish() to decide whether to fall back to a plain send.
        // false here = silent failure path: initial send threw, finish
        // also threw, no message visible on the recipient's phone.
        get delivered() { return delivered; },
        get lastError() { return lastError; },
        // Cancel — caller decided no reply should be sent. Under the
        // deferred-initial model, if no first content ever arrived
        // (msgKey null) NOTHING was sent and there's nothing to clean
        // up beyond stopping the typing indicator. If a chunk landed
        // before cancel (rare race: update arrived between flush and
        // cancel), revoke it via baileys delete.
        async cancel() {
          finished = true;
          pending = null;
          if (editTimer) { clearTimeout(editTimer); editTimer = null; }
          stopTyping();
          if (!msgKey) return;
          try {
            await _timeBound(_safeSend(target, { delete: msgKey }), 'stream cancel revoke');
          } catch (e) {
            lastError = e.message;
            err(`stream cancel revoke: ${e.message}`);
          }
        },
      };
    },
    stop() {
      stopped = true;
      _stopWaAlive('stopped');
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      _stopWhisperServer();
      // Phase 2: synchronously flush any pending debounced writes so
      // SIGTERM (e.g. the pidfile takeover handshake) doesn't lose
      // the last burst of counters that the 2s timer hadn't fired yet.
      // writeFileSync is the only fs-call shape that completes inside
      // a SIGTERM handler before process.exit.
      if (_chatsWriteTimer) {
        clearTimeout(_chatsWriteTimer);
        _chatsWriteTimer = null;
        try {
          const all = [..._chats.values()].sort((a, b) =>
            (b.lastActivityTs || b.creationTs) - (a.lastActivityTs || a.creationTs));
          const trimmed = all.slice(0, CHATS_CACHE_CAP);
          mkdirSync(dirname(CHATS_CACHE_PATH), { recursive: true });
          writeFileSync(CHATS_CACHE_PATH, JSON.stringify(trimmed, null, 2), { mode: 0o600 });
        } catch (e) { console.error(`!! whatsapp.mjs:[catch] ${e?.message ?? e}`); }
      }
      if (_reactionsWriteTimer) {
        clearTimeout(_reactionsWriteTimer);
        _reactionsWriteTimer = null;
        try {
          const all = [..._reactionCounts.entries()]
            .sort((a, b) => (b[1].lastTs || 0) - (a[1].lastTs || 0))
            .slice(0, REACTION_COUNTS_CAP);
          const obj = Object.fromEntries(all);
          mkdirSync(dirname(REACTION_COUNTS_PATH), { recursive: true });
          writeFileSync(REACTION_COUNTS_PATH, JSON.stringify(obj, null, 2), { mode: 0o600 });
        } catch (e) { console.error(`!! whatsapp.mjs:[catch] ${e?.message ?? e}`); }
      }
      if (_msgBodySaveTimer) {
        clearTimeout(_msgBodySaveTimer);
        _msgBodySaveTimer = null;
      }
      if (_msgBodyDirty) {
        _msgBodyDirty = false;
        try {
          const obj = Object.fromEntries(_msgBodyById.entries());
          writeFileSync(MSG_BODY_CACHE_PATH, JSON.stringify(obj), { mode: 0o600 });
        } catch (e) { console.error(`!! whatsapp.mjs:[catch] ${e?.message ?? e}`); }
      }
      try { sock?.end?.(undefined); } catch (e) { console.error(`!! whatsapp.mjs:[catch] ${e?.message ?? e}`); }
      // Restore the four console methods we patched at start. If
      // something else patched between then and now, the ordering
      // will be slightly off, but in practice we're the only
      // patcher and stop() is rare.
      console.log   = _origLog;
      console.info  = _origInfo;
      console.warn  = _origWarn;
      console.error = _origError;
    },
    get chatId() { return lastChat; },
    get myJid()  { return myJid; },
    get myNumber() { return myNumber; },
    get myLid() { return myLid; },
    get myLidNumber() { return myLidNumber; },
    // The WhatsApp 'Message Yourself' chat — your own number as a JID.
    // Useful as the default mirror target so shell-typed transcript
    // shows up in your phone without configuring a chat_id.
    get selfDmJid() { return myNumber ? `${myNumber}@s.whatsapp.net` : null; },
    // ── Held pre-connect messages ────────────────────────────────
    // Surfaced as { idx, jid, author, text, ts } to the host. The
    // raw key+message stay inside the bridge so dispatchHeld can
    // replay through handleMessage (which goes through the same
    // awareness + wake-word + brain routing pipeline as a live one).
    setStorm(on) { _storm = !!on; },
    get storm() { return _storm; },
    setBypassChats(jids) {
      // Replace the entire bypass set with the supplied list. Host
      // calls this whenever the joined set changes so the bridge's
      // view is always in sync.
      _bypassChats.clear();
      for (const j of (jids ?? [])) if (j) _bypassChats.add(j);
    },
    listHeld() {
      return _heldMessages.map((m, i) => ({
        idx: i, jid: m.jid, author: m.author, text: m.text, ts: m.ts,
      }));
    },
    async dispatchHeld(idx) {
      const entry = _heldMessages[idx];
      if (!entry) return { ok: false, reason: 'no held message at that index' };
      // Pull from the queue first so a slow handleMessage doesn't
      // leave the entry visible to a concurrent caller.
      _heldMessages.splice(idx, 1);
      try {
        await handleMessage(entry.raw, { bypassAwareness: false });
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: e.message };
      }
    },
    clearHeld() {
      const n = _heldMessages.length;
      _heldMessages.length = 0;
      return n;
    },
  };
}

// ── helpers ──────────────────────────────────────────────────────

// contextInfo lives on every message variant that can be a reply
// (extendedTextMessage, imageMessage, videoMessage, audioMessage,
// documentMessage, stickerMessage, …). Pull whichever is present.
function _contextInfo(message) {
  if (!message) return null;
  // Envelope unwrap — WA wraps content one level deep in ephemeral
  // (disappearing-mode), viewOnce[V2|V2Extension], edited, or
  // documentWithCaption containers. Without recursing, a reply
  // typed inside a disappearing-mode chat would have its
  // contextInfo (and so its stanzaId) hidden from us — the oracle
  // can't see the reply, @e doesn't wake on replies, etc.
  if (message.ephemeralMessage?.message)              return _contextInfo(message.ephemeralMessage.message);
  if (message.viewOnceMessage?.message)               return _contextInfo(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2?.message)             return _contextInfo(message.viewOnceMessageV2.message);
  if (message.viewOnceMessageV2Extension?.message)    return _contextInfo(message.viewOnceMessageV2Extension.message);
  if (message.editedMessage?.message)                 return _contextInfo(message.editedMessage.message);
  if (message.protocolMessage?.editedMessage)         return _contextInfo(message.protocolMessage.editedMessage);
  if (message.documentWithCaptionMessage?.message)    return _contextInfo(message.documentWithCaptionMessage.message);
  return (
    message.extendedTextMessage?.contextInfo ??
    message.imageMessage?.contextInfo ??
    message.videoMessage?.contextInfo ??
    message.audioMessage?.contextInfo ??
    message.documentMessage?.contextInfo ??
    message.stickerMessage?.contextInfo ??
    message.reactionMessage?.contextInfo ??
    null
  );
}

// Render a one-line preview of the quoted message if this is a reply.
// Used as a '↳ <preview>' prefix on the reply body so the operator
// sees what's being replied to without having to scroll back.
function _quotedPreview(ctx) {
  if (!ctx?.quotedMessage) return null;
  // Recurse into textOf so a reply to an image renders '[image]
  // <caption>', a reply to a voice note renders '[voice note: 8s]',
  // etc. — preview text picks up the same placeholder vocabulary as
  // a fresh inbound. When textOf returns null (empty stub quote
  // from our own outbound when no raw was attached, or a truly
  // unknown envelope), skip the ↳ entirely — a labelled
  // '(unsupported message)' was more confusing than informative.
  const inner = textOf(ctx.quotedMessage);
  if (!inner) return null;
  const oneLine = inner.replace(/\s+/g, ' ').trim();
  if (!oneLine) return null;
  const trimmed = oneLine.length > 80 ? oneLine.slice(0, 79) + '…' : oneLine;
  // Attribution: last 6 digits of the original sender's phone
  // number. The leading 'from' label was added when the operator
  // reported confusing the bare '(…123456)' suffix for a truncated
  // msg-id — 'from' makes it clear this is the sender, not a
  // message reference. Resolving to a contact display name when
  // known would be nicer, but _quotedPreview lives at module scope
  // and can't reach the bridge factory's _chats Map without a
  // wider refactor; phone-suffix attribution stays the fallback.
  const who = ctx.participant
    ? ctx.participant.split('@')[0]?.split(':')[0]?.slice(-6) ?? null
    : null;
  return who ? `↳ ${trimmed}  (from …${who})` : `↳ ${trimmed}`;
}

// Extract a textual body from any baileys message variant. For
// non-text types (audio, image without caption, document, sticker,
// poll, location, reaction, contact) we return a bracketed
// placeholder so the host sees SOMETHING in the transcript instead
// of dropping the message silently. Captions are inlined when
// present. For replies, the quoted message's textOf form is
// prefixed as '↳ <preview>' so the operator sees what's being
// replied to. Downloads / auto-summarize / audio transcription are
// separate features; this function is the visibility step.
function textOf(message) {
  if (!message) return null;
  const base = _baseTextOf(message);
  if (base === null) return null;
  const q = _quotedPreview(_contextInfo(message));
  return q ? `${q}\n${base}` : base;
}

function _baseTextOf(message) {
  if (!message) return null;
  // Envelope unwrappers — WA wraps real content one level deep in
  // a handful of containers for ephemeral / view-once / edited /
  // captioned-document messages. Without unwrapping, _baseTextOf
  // falls through to null and the caller renders the parent as
  // '(unsupported message)' — common when the operator replies to
  // a disappearing-mode message in any group with retention set.
  // Recursion is bounded by the depth of these envelopes (at most
  // a couple in practice).
  if (message.ephemeralMessage?.message)              return _baseTextOf(message.ephemeralMessage.message);
  if (message.viewOnceMessage?.message)               return _baseTextOf(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2?.message)             return _baseTextOf(message.viewOnceMessageV2.message);
  if (message.viewOnceMessageV2Extension?.message)    return _baseTextOf(message.viewOnceMessageV2Extension.message);
  if (message.editedMessage?.message)                 return _baseTextOf(message.editedMessage.message);
  if (message.protocolMessage?.editedMessage)         return _baseTextOf(message.protocolMessage.editedMessage);
  if (message.documentWithCaptionMessage?.message)    return _baseTextOf(message.documentWithCaptionMessage.message);
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  // Reactions: an update to an existing message. Target msg-id is
  // included so a later /show or summary feature can resolve the
  // referenced message.
  if (message.reactionMessage) {
    const r = message.reactionMessage;
    const emoji = r.text || '·';
    const tid = r.key?.id ? ` (msg ${r.key.id.slice(0, 8)})` : '';
    return r.text
      ? `[reaction ${emoji}${tid}]`
      : `[reaction removed${tid}]`;
  }
  // Image / video: caption inline when present, placeholder when not.
  if (message.imageMessage) {
    const cap = message.imageMessage.caption?.trim();
    return cap ? `[image] ${cap}` : '[image]';
  }
  if (message.videoMessage) {
    const cap = message.videoMessage.caption?.trim();
    return cap ? `[video] ${cap}` : '[video]';
  }
  // Audio: voice notes (push-to-talk) and shared audio files. Length
  // is in seconds. Transcription is a separate pending feature.
  if (message.audioMessage) {
    const a = message.audioMessage;
    const secs = Number(a.seconds) || 0;
    const kind = a.ptt ? 'voice note' : 'audio';
    return secs > 0 ? `[${kind}: ${secs}s]` : `[${kind}]`;
  }
  if (message.documentMessage) {
    const d = message.documentMessage;
    const name = d.fileName || d.title || 'untitled';
    const cap = d.caption?.trim();
    return cap ? `[document: ${name}] ${cap}` : `[document: ${name}]`;
  }
  if (message.stickerMessage) {
    return '[sticker]';
  }
  if (message.locationMessage) {
    const l = message.locationMessage;
    const coords = (l.degreesLatitude != null && l.degreesLongitude != null)
      ? `${l.degreesLatitude.toFixed(4)},${l.degreesLongitude.toFixed(4)}`
      : '?';
    const name = l.name?.trim();
    return name ? `[location ${coords}: ${name}]` : `[location ${coords}]`;
  }
  if (message.liveLocationMessage) {
    return '[live location]';
  }
  if (message.contactMessage) {
    return `[contact: ${message.contactMessage.displayName || 'unknown'}]`;
  }
  if (message.contactsArrayMessage) {
    const n = message.contactsArrayMessage.contacts?.length ?? 0;
    return `[${n} contact${n === 1 ? '' : 's'}]`;
  }
  // Polls: both v1 and v3 schemas observed in the wild.
  const poll = message.pollCreationMessageV3 ?? message.pollCreationMessage;
  if (poll) {
    return `[poll: ${poll.name ?? '(no question)'}]`;
  }
  if (message.pollUpdateMessage) {
    return '[poll vote]';
  }
  // Protocol messages (read receipts, deletes, edits) and other
  // control envelopes — silent on purpose. handleMessage exits on
  // null so they don't reach the host.
  return null;
}

// baileys uses pino. We pass a no-op logger to keep its chatter out of
// our terminal. The shape it expects: { trace, debug, info, warn, error,
// fatal, level, child }.
function silentLogger() {
  const noop = () => {};
  const child = () => silentLogger();
  return {
    trace: noop, debug: noop, info: noop,
    warn:  noop, error: noop, fatal: noop,
    level: 'silent', child,
  };
}
