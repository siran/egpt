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
import { join, dirname } from 'node:path';
import { promises as fs, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { classifyWhatsAppChat } from './whatsapp-classify.mjs';

const AUTH_DIR_DEFAULT = join(homedir(), '.egpt', 'wa-auth');
// Reconnect backoff. Initial wait, doubled on each consecutive
// failure, capped. baileys often reports 'connection.update' close
// → open → close in quick succession when WA's edge is flapping;
// the bridge must keep retrying instead of giving up after one
// scheduled attempt. Until this commit the retry was one-shot:
// connect() threw → setTimeout never re-armed → bridge dead.
const RECONNECT_MS = 5_000;
const RECONNECT_MAX_MS = 60_000;
// Bound every sock.sendMessage with this timeout so a flapping/down
// WS doesn't queue the call inside baileys forever. Symptom this
// catches: persona @e reply shows '⌛ thinking…' in WA and never
// edits — finish()'s edit call was queued behind a stale WS and
// never resolved. With the timeout, finish() rejects → err() fires
// → onError surfaces 'stream finish: timed out' in the shell →
// the persona fallback's bridge.send runs (also timed out) → if
// that also fails, errOut tells the operator clearly.
const SEND_TIMEOUT_MS = 12_000;
const CHATS_CACHE_PATH = join(homedir(), '.egpt', 'wa-chats.json');
// Cap the persisted cache to avoid runaway growth — keep the most-
// recently-active. 500 is generous for a normal WA usage pattern.
const CHATS_CACHE_CAP = 500;
// Phase 2 logon-summary: reactions are tracked across chats and
// persisted to a separate file so they survive bridge restarts and
// so the interactive shell's "while you were away" report can find
// the most-reacted item without scanning the room md.
const REACTION_COUNTS_PATH = join(homedir(), '.egpt', 'reaction-counts.json');
const REACTION_COUNTS_CAP = 500;
// Per-msg body preview cache (text snippeted to ≤60 chars, keyed by
// WA stanza id). In-memory was 4000 entries scoped to one bridge
// session — fine for "reply during the call", broken for "look up
// what I reacted to yesterday". Persisting carries the cache across
// restarts so the operator's '[reaction ❤️ to "…"]' enrichment can
// still resolve parents that have already rolled off the recent[]
// ring. ~60-byte values × 4000 entries ≈ 240KB on disk.
const MSG_BODY_CACHE_PATH = join(homedir(), '.egpt', 'msg-body-cache.json');
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
  awareness     = {},        // see header docs; defaults applied below
  debug         = false,     // log every incoming upsert (type, jid, fromMe, text-preview) before any filter
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
  // Default 5 catches only network-latency stragglers as live; any
  // genuinely-queued backlog gets reviewed first.
  maxBacklogSeconds = 5,
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
  onIncoming,
  onLog,
  onError,
  onChatId,    // called once when first chat is captured (host can persist)
  onQR,        // called with the rendered QR ASCII when WA wants a fresh pair; host can route to a visible surface
  onMediaSaved, // called per successful media download: { kind, chatJid, msgId, path, sizeBytes }
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

  // Bound a promise with a timeout. Rejects with a clear "<label> timed
  // out after N ms" when the underlying baileys send hangs (typically:
  // WS dropped mid-call, queue stalled waiting for reconnect). Used to
  // wrap every sock.sendMessage on the outbound path so the host gets
  // a visible failure instead of a deadlocked await.
  const _timeBound = (promise, label, ms = SEND_TIMEOUT_MS) => {
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
  let version;
  try {
    const fetched = await fetchLatestBaileysVersion();
    version = fetched.version;
  } catch (_) {
    // Offline or fetch blocked — baileys will use its default fallback.
    version = undefined;
  }

  let stopped        = false;
  let connectedAt    = 0;     // ms; set to Date.now() when WS reaches 'open'
  // Pre-connect backlog: messages older than connectedAt -
  // maxBacklogSeconds get parked here instead of dispatched. The host
  // surfaces them via /wa-pending so the operator can review and
  // explicitly dispatch (re-running handleMessage) or clear.
  const _heldMessages = [];
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
  // Exponential backoff state. Reset to 0 when 'connection: open'
  // fires; doubled on each consecutive close/connect-throw. _scheduleReconnect
  // is the single retry path — both the close handler and the
  // catch around connect() funnel through it.
  let reconnectAttempts = 0;
  function _scheduleReconnect(reason) {
    if (stopped) return;
    if (reconnectTimer) return;            // already armed
    const delay = Math.min(RECONNECT_MS * Math.pow(2, reconnectAttempts), RECONNECT_MAX_MS);
    reconnectAttempts++;
    err(`whatsapp: ${reason}; reconnect attempt ${reconnectAttempts} in ${Math.round(delay / 1000)}s`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
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
  // Cap is generous but bounded — reactions can arrive minutes after
  // the original message, so we keep more than _chats.recent's ring.
  const _msgBodyById = new Map();
  const _MSG_BODY_CACHE_CAP = 4_000;
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
  } catch (_) { /* corrupt cache file is non-fatal — just start fresh */ }
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
      } catch (_) { /* swallow — best-effort persistence */ }
    }, 5_000);
  }
  function _rememberMsgBody(keyId, body) {
    if (!keyId || !body || typeof body !== 'string') return;
    // Don't memoize placeholder-only bodies — a reaction-of-a-reaction
    // preview "[reaction 👍 to "…"]" is not interesting context.
    if (body.startsWith('[reaction ')) return;
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
  function _enrichReactionText(rawText, msg) {
    const r = msg?.message?.reactionMessage;
    if (!r?.key?.id) return rawText;
    let target = _msgBodyById.get(r.key.id);
    if (!target) {
      // Fallback: scan every observed chat's recent[] for an entry
      // with the same key.id. Covers parents older than the in-memory
      // _msgBodyById cache (it only fills as messages arrive this
      // session, so reactions to anything from before a bridge
      // restart kept landing as opaque placeholders).
      for (const c of _chats.values()) {
        const hit = c.recent?.find(rr => rr.key?.id === r.key.id);
        if (hit?.text) { target = hit.text; break; }
      }
    }
    if (!target) return rawText;
    // Snip the parent preview so reaction lines stay readable —
    // anything over ~60 chars dominates the row and obscures the
    // reaction itself.
    const oneLine = String(target).replace(/\s+/g, ' ').trim();
    const snippet = oneLine.length > 60 ? oneLine.slice(0, 59) + '…' : oneLine;
    const emoji = r.text || '·';
    return r.text
      ? `[reaction ${emoji} to "${snippet}"]`
      : `[reaction removed from "${snippet}"]`;
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
  } catch (_) { /* corrupt — start empty */ }

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
      } catch (_) { /* best-effort */ }
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
  } catch (_) { /* corrupt / unreadable — fall through to empty */ }

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
      } catch (_) { /* best-effort; in-memory state still works */ }
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
  // Track WAMessage IDs we sent ourselves so we can filter the echoes
  // WhatsApp sends back to all linked devices (us included). 60-second
  // window is plenty — IDs live shorter than that on the wire.
  const _sentIds = new Map();    // id -> ts
  function rememberSent(id) {
    if (!id) return;
    _sentIds.set(id, Date.now());
    const cutoff = Date.now() - 60_000;
    for (const [k, t] of _sentIds) if (t < cutoff) _sentIds.delete(k);
  }

  function connect() {
    if (stopped) return;
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

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        // Render QR to a string so Ink can print it cleanly,
        // instead of qrcode-terminal writing directly to stdout (which
        // tangles with Ink's render). Route to onQR when provided so
        // the host can surface it in a visible UI; fall back to
        // onLog for backwards compat with older hosts.
        qrcode.generate(qr, { small: true }, (qrText) => {
          const msg = 'whatsapp: scan this QR (WhatsApp → Settings → Linked devices → Link a device):\n' + qrText;
          if (typeof onQR === 'function') { try { onQR(qrText, msg); return; } catch (_) {} }
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
        const display = sock.user?.name ?? myNumber ?? '?';
        log(`whatsapp: connected as ${display} (${myNumber}${myLidNumber ? `, lid ${myLidNumber}` : ''})`);
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
        if (reason === DisconnectReason.loggedOut) {
          err(`whatsapp: logged out — delete ${authDir} and restart to re-pair`);
          stopped = true;
          return;
        }
        // 440 = connectionReplaced. Means WA's server has another
        // session authenticated with these credentials. Almost always
        // a stale session from a prior shell that didn't release the
        // WS cleanly on /upgrade or crash. Auto-reconnecting just
        // trips the replacement again — we'd loop forever fighting
        // ourselves. Stop and ask the operator to /whatsapp start
        // after a brief wait so WA's side can drain the stale entry.
        if (reason === DisconnectReason.connectionReplaced || reason === 440) {
          err('whatsapp: connection replaced by another session (reason 440). ' +
              'A stale WS from a prior process is still on WA\'s server. ' +
              'Wait ~30s then run /whatsapp start. Auto-reconnect disabled to avoid a fight loop.');
          stopped = true;
          return;
        }
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
      for (const msg of messages) {
        if (msg.message?.protocolMessage) {
          _handleRevoke(msg).catch(e => err(`media revoke threw: ${e.message}`));
        } else {
          _saveMediaIfAny(msg).catch(e => err(`media save threw: ${e.message}`));
        }
      }
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
          if (ts > 0) _recordChat({ jid: chat.id, isGroup, name, ts, kind: 'activity' });
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
        if (ts > 0 || pinned > 0) _recordChat({ jid: chat.id, isGroup, name, ts, kind: 'activity', pinned });
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
  // max_size_mb = N (default 25). Path is
  // ~/.egpt/media/<chatJidSan>/<msgId>.<ext>. Existing files are
  // not re-downloaded — idempotent across daemon restarts.
  const MEDIA_DIR = join(homedir(), '.egpt', 'media');
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
    try { await fs.writeFile(join(dir, '.media-index.json'), JSON.stringify(idx, null, 2)); } catch (_) {}
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
    const dir = join(MEDIA_DIR, _sanitiseChatJid(chatJid));
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
        try { await fs.writeFile(join(dir, `${base}.txt`), caption); } catch (_) {}
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
      try { onMediaSaved?.({
        kind: notifyKind, chatJid, msgId, path, sizeBytes: buf.length,
        msgKey: msg.key, msgRaw: msg.message,
        preConnect,
      }); } catch (_) {}
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
    const dir = join(MEDIA_DIR, _sanitiseChatJid(chatJid));
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
        try { await fs.rename(sidecar, join(deletedDir, `${entry.base}.txt`)); } catch (_) {}
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
      } catch (_) {}
      return newPath;
    } catch (e) {
      log(`media-revoke move failed (${targetId} in ${chatJid}): ${e.message}`);
      return null;
    }
  }

  async function handleMessage(msg, { bypassAwareness = false } = {}) {
    if (!msg.message) return;               // protocol message / ignored type

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
        // Skip clearly bot-side echoes (fromMe, our own sentIds) and
        // protocol noise — only hold genuine inbound that WOULD have
        // dispatched.
        if (!msg.key?.fromMe) {
          const text = textOf(msg.message);
          if (text) {
            _heldMessages.push({
              jid: msg.key?.remoteJid,
              author: typeof msg.pushName === 'string' && msg.pushName.trim()
                ? msg.pushName.trim()
                : null,
              text,
              ts: msgTsMs,
              key: msg.key?.id ? { id: msg.key.id, fromMe: false } : null,
              raw: msg,    // kept so the operator can re-dispatch through
                           // the same handleMessage path on /wa-pending
                           // dispatch — single source of truth for awareness
                           // + wake-word + brain routing.
            });
            log(`held pre-connect message from ${msg.key?.remoteJid?.split('@')[0] ?? '?'}: "${text.slice(0, 60)}${text.length > 60 ? '…' : ''}" — /wa-pending to review`);
          }
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
    const text = _enrichReactionText(textOf(msg.message), msg);

    // Wake-word: any message containing '@egpt' (as a token) bypasses
    // awareness. Lets the user summon egpt from a friend DM (where
    // personal:'incoming' would otherwise drop their fromMe text) or
    // from a group (where groups:'mentions' would otherwise require
    // @<my-number>, not @egpt). allowed_users gating downstream still
    // restricts who actually triggers anything; non-allowed senders
    // are silently ignored (no in-chat tattle).
    // '@egpt' or its short alias '@e' (/ee/, like 'eel') wakes the persona.
    const isWakeWord = !!text && /@(?:egpt|e)\b/i.test(text);

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
        try { onChatId?.(chatJid); } catch (_) {}
      }
    }

    const userId = senderJid?.split(':')[0]?.split('@')[0] ?? '?';
    const username = msg.pushName ?? null;
    const firstName = username ?? `wa:${userId}`;
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
    const authorized = fromMe || (allowedUsers.length > 0
      && allowedUsers.some(u => normalize(u) === normalize(userId)));

    let processed = text.trim();

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

    await onIncoming?.(processed, {
      userId, username, firstName, chatId: chatJid, chatType, authorized,
      // msgKey enables proper WA-reply quoting later — e.g. when the
      // operator types '@m42 …' in shell, we send the reply via
      // baileys with quoted: { key, message } pointing at this msg.
      msgKey: msg.key ? { ...msg.key } : null,
      msgRaw: msg.message ?? null,
    });
  }

  // ── Start ─────────────────────────────────────────────────────

  log('whatsapp: starting (baileys)');
  // Same retry-on-throw protection as the close handler — an initial
  // connect() that fails (network unreachable at boot) used to leave
  // the bridge dead. Now it backs off and retries the same way.
  try { connect(); }
  catch (e) { _scheduleReconnect(`initial connect() threw: ${e.message}`); }

  // Lazy group-subject lookup. Uses sock.groupMetadata which caches
  // server-side. Falls back to the bare JID when we can't reach it.
  async function _groupSubject(jid) {
    try { return (await sock?.groupMetadata?.(jid))?.subject ?? null; }
    catch (_) { return null; }
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
    } catch (_) { /* offline / not yet connected — fall through with what we have */ }

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

  return {
    listChats,
    prefetchHistoryForTopChats,
    getChatName,
    getChatSlug,
    // Fire-and-forget group-name lookup. Idempotent (returns
    // immediately if the chat already has a name OR if a fetch is
    // already in flight). Used by /recap to backfill names for any
    // group whose chat record is on disk but lacks a subject —
    // typically groups that haven't appeared in /channels yet.
    ensureGroupName: _ensureGroupName,
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
    async send(text, { chatId } = {}) {
      const target = chatId ?? lastChat;
      if (!target || !sock) return null;
      // Chunk long bodies so WA's per-message limit (or any
      // intermediate baileys quirk at large sizes) doesn't silently
      // truncate the reply. First chunk's send result is what the
      // caller gets back — that's the one whose key matters for
      // @m<N> reply-target threading. Subsequent chunks fire
      // sequentially as fresh sends so order is preserved.
      const chunks = chunkText(text, WA_CHUNK_CHARS);
      let firstResult = null;
      for (let i = 0; i < chunks.length; i++) {
        try {
          const r = await _timeBound(sock.sendMessage(target, { text: chunks[i] }), 'send');
          rememberSent(r?.key?.id);
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
        return _timeBound(sock.sendMessage(target, { text }), 'replyTo (fallback send)')
          .then(r => { rememberSent(r?.key?.id); return r; })
          .catch(e => { err(`replyTo (fallback send): ${e.message}`); return null; });
      }
      const quoted = { key, message: raw ?? { conversation: '' } };
      return _timeBound(sock.sendMessage(target, { text }, { quoted }), 'replyTo')
        .then(r => { rememberSent(r?.key?.id); return r; })
        .catch(e => { err(`replyTo: ${e.message}`); return null; });
    },
    startStreamMessage(initialText, { chatId } = {}) {
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
        sock.sendPresenceUpdate?.('composing', target).catch(() => {});
        if (typingTimer) clearTimeout(typingTimer);
        typingTimer = setTimeout(refreshTyping, 8_000);
      };
      const stopTyping = () => {
        if (typingTimer) { clearTimeout(typingTimer); typingTimer = null; }
        sock.sendPresenceUpdate?.('paused', target).catch(() => {});
      };

      // Initial send (async — updates that arrive before this resolves
      // queue into `pending` and flush once initialDone is true).
      // `delivered` is NOT set here: the placeholder reaching WA isn't
      // useful — we only care that the FINAL text did. finish() flips
      // delivered after a successful edit/send of the final body.
      // _timeBound prevents a baileys-internal stall from blocking
      // initialDone forever (would otherwise hang every update + finish).
      (async () => {
        try {
          const r = await _timeBound(sock.sendMessage(target, { text: initialText }), 'stream start');
          msgKey = r?.key ?? null;
          rememberSent(r?.key?.id);
        } catch (e) {
          lastError = e.message;
          err(`stream start: ${e.message}`);
        }
        initialDone = true;
        if (pending !== null) maybeEdit();
      })();
      refreshTyping();

      function flush() {
        if (editTimer) { clearTimeout(editTimer); editTimer = null; }
        if (!initialDone || !msgKey) return;
        if (pending === null || pending === lastSent) return;
        const text = pending;
        pending = null;
        _timeBound(sock.sendMessage(target, { edit: msgKey, text }), 'stream edit')
          .then((r) => {
            rememberSent(r?.key?.id);
            lastSent = text;
            lastEditAt = Date.now();
          })
          .catch((e) => { lastError = e.message; err(`stream edit: ${e.message}`); });
      }

      function maybeEdit() {
        const since    = Date.now() - lastEditAt;
        const interval = 2_500;
        if (since >= interval) flush();
        else if (!editTimer) {
          editTimer = setTimeout(() => { editTimer = null; flush(); }, interval - since);
        }
      }

      return {
        update(text) {
          if (finished) return;
          pending = text;
          refreshTyping();   // keep "typing…" alive while the brain is still producing
          maybeEdit();
        },
        async finish(text) {
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
            const chunks = chunkText(pending, WA_CHUNK_CHARS);
            if (initialDone && msgKey) {
              if (chunks[0] !== lastSent) {
                const r = await _timeBound(
                  sock.sendMessage(target, { edit: msgKey, text: chunks[0] }),
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
                sock.sendMessage(target, { text: chunks[0] }),
                'stream finish send',
              );
              rememberSent(r?.key?.id);
              if (r?.key) { msgKey = r.key; delivered = true; }
            }
            // Continuation chunks (only relevant for long replies).
            for (let i = 1; i < chunks.length; i++) {
              try {
                const r = await _timeBound(
                  sock.sendMessage(target, { text: chunks[i] }),
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
      };
    },
    stop() {
      stopped = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
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
        } catch (_) {}
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
        } catch (_) {}
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
        } catch (_) {}
      }
      try { sock?.end?.(undefined); } catch (_) {}
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
  return (
    message.extendedTextMessage?.contextInfo ??
    message.imageMessage?.contextInfo ??
    message.videoMessage?.contextInfo ??
    message.audioMessage?.contextInfo ??
    message.documentMessage?.contextInfo ??
    message.stickerMessage?.contextInfo ??
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
