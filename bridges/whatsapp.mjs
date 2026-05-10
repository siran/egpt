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
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { promises as fs, existsSync } from 'node:fs';
import { classifyWhatsAppChat } from './whatsapp-classify.mjs';

const AUTH_DIR_DEFAULT = join(homedir(), '.egpt', 'wa-auth');
const RECONNECT_MS = 5_000;
const CHATS_CACHE_PATH = join(homedir(), '.egpt', 'wa-chats.json');
// Cap the persisted cache to avoid runaway growth — keep the most-
// recently-active. 500 is generous for a normal WA usage pattern.
const CHATS_CACHE_CAP = 500;

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
  // because they restarted the daemon. Set to 60 to discard
  // anything older than a minute before connect.
  maxBacklogSeconds = 0,
  onIncoming,
  onLog,
  onError,
  onChatId,    // called once when first chat is captured (host can persist)
  onQR,        // called with the rendered QR ASCII when WA wants a fresh pair; host can route to a visible surface
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
  let lastChat       = null;
  let chatIdNotified = false;
  let myJid          = null;     // our own jid (e.g. '1234567890@s.whatsapp.net')
  let myNumber       = null;     // bare number for mention-detection
  let myLid          = null;     // our own LID jid (privacy-format identity)
  let myLidNumber    = null;     // bare number portion of myLid (for self-DM detection)
  let sock           = null;
  let reconnectTimer = null;

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
  const _chats = new Map();   // jid → { jid, isGroup, lastActivityTs, creationTs, name }

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
            _chats.set(c.jid, {
              jid: c.jid,
              isGroup: !!c.isGroup,
              lastActivityTs: Number(c.lastActivityTs) || 0,
              creationTs:     Number(c.creationTs)     || 0,
              name: typeof c.name === 'string' ? c.name : null,
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

  function _recordChat({ jid, isGroup, name = null, ts = 0, kind = 'activity' }) {
    if (!jid) return;
    const cur = _chats.get(jid) ?? { jid, isGroup, lastActivityTs: 0, creationTs: 0, name: null };
    cur.isGroup = isGroup;
    if (kind === 'activity') cur.lastActivityTs = Math.max(cur.lastActivityTs, ts);
    else if (kind === 'creation') cur.creationTs = Math.max(cur.creationTs, ts);
    if (name) cur.name = name;
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
        const display = sock.user?.name ?? myNumber ?? '?';
        log(`whatsapp: connected as ${display} (${myNumber}${myLidNumber ? `, lid ${myLidNumber}` : ''})`);
      }
      if (connection === 'close') {
        const reason = lastDisconnect?.error?.output?.statusCode;
        if (reason === DisconnectReason.loggedOut) {
          err(`whatsapp: logged out — delete ${authDir} and restart to re-pair`);
          stopped = true;
          return;
        }
        if (!stopped) {
          log(`whatsapp: connection closed (reason ${reason ?? '?'}); reconnecting in ${RECONNECT_MS / 1000}s`);
          reconnectTimer = setTimeout(connect, RECONNECT_MS);
        }
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
      // Message content is NOT examined; only jid + isGroup + ts +
      // pushName for naming.
      for (const m of messages) {
        const jid = m.key?.remoteJid;
        if (!jid) continue;
        const isGroup = jid.endsWith('@g.us');
        const ts = (Number(m.messageTimestamp) || 0) * 1000;
        const remoteName = (!m.key?.fromMe && typeof m.pushName === 'string' && m.pushName.trim())
          ? m.pushName.trim() : null;
        if (ts > 0) _recordChat({ jid, isGroup, name: remoteName, ts, kind: 'activity' });
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
      for (const msg of messages) {
        try { await handleMessage(msg, { bypassAwareness: debug }); }
        catch (e) { err(`onIncoming threw: ${e.message}`); }
      }
    });

    // History sync — baileys delivers chats + their last conversation
    // timestamps in one shot after connect when shouldSyncHistoryMessage
    // is true. We READ ONLY THE chats ARRAY here. The event also
    // carries a `.messages` array with the actual message bodies of
    // the historical sync — we deliberately IGNORE that field so
    // history content never enters the shell UI, never goes through
    // onIncoming, never reaches a brain. The chats array gives us
    // jid + conversationTimestamp + name, which is exactly enough
    // for /channels and nothing more.
    sock.ev.on('messaging-history.set', ({ chats }) => {
      if (!Array.isArray(chats)) return;
      for (const chat of chats) {
        if (!chat?.id) continue;
        const isGroup = chat.id.endsWith('@g.us');
        const ts = (Number(chat.conversationTimestamp) || 0) * 1000;
        const name = typeof chat.name === 'string' && chat.name.trim() ? chat.name.trim() : null;
        if (ts > 0) _recordChat({ jid: chat.id, isGroup, name, ts, kind: 'activity' });
      }
    });

    // Live chat updates — fired when a new chat appears or an
    // existing one's metadata changes. Mostly redundant with the
    // messages.upsert pre-record above, but catches cases where WA
    // surfaces a chat without an associated message (e.g., a name
    // change, archive toggle).
    sock.ev.on('chats.upsert', (chats) => {
      if (!Array.isArray(chats)) return;
      for (const chat of chats) {
        if (!chat?.id) continue;
        const isGroup = chat.id.endsWith('@g.us');
        const ts = (Number(chat.conversationTimestamp) || 0) * 1000;
        const name = typeof chat.name === 'string' && chat.name.trim() ? chat.name.trim() : null;
        if (ts > 0) _recordChat({ jid: chat.id, isGroup, name, ts, kind: 'activity' });
      }
    });
  }

  async function handleMessage(msg, { bypassAwareness = false } = {}) {
    if (!msg.message) return;               // protocol message / ignored type

    // Backlog filter: if maxBacklogSeconds is configured (>0), drop
    // messages whose timestamp is older than (connectedAt - threshold).
    // This is for the WA-burst-on-handshake case: baileys hands you
    // recently-buffered messages immediately after WS open. An egpt
    // operator restarting the shell typically doesn't want their
    // transcript flooded with the last hour of group chatter; with
    // maxBacklogSeconds=60 only the last minute pre-connect comes
    // through. Default 0 = no filter (every delivered message passes).
    if (maxBacklogSeconds > 0 && connectedAt > 0) {
      const msgTsMs = (Number(msg.messageTimestamp) || 0) * 1000;
      if (msgTsMs > 0 && msgTsMs < connectedAt - maxBacklogSeconds * 1000) {
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
    // the best available display name. For groups we'll fill the
    // subject lazily via sock.groupMetadata at listChats() time.
    const msgTsMs = (Number(msg.messageTimestamp) || 0) * 1000 || Date.now();
    const remoteName = (!msg.key?.fromMe && typeof msg.pushName === 'string' && msg.pushName.trim())
      ? msg.pushName.trim()
      : null;
    _recordChat({ jid: chatJid0, isGroup: isGroup0, name: remoteName, ts: msgTsMs, kind: 'activity' });
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
    const text = textOf(msg.message);

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
    // Skipped entirely in debug mode or for wake-word messages.
    if (!bypassAwareness && !isWakeWord) {
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
    const senderJid = isGroup ? msg.key.participant : chatJid;
    const chatType = isGroup ? 'group' : 'private';

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
      if (!bypassAwareness && !isWakeWord && aware.groups === 'mentions' && !isMentioned && !replyingToMe) return;
      if (myNumber) {
        processed = processed.replace(new RegExp(`@${myNumber}\\s*`, 'g'), '').trim();
      }
    }

    await onIncoming?.(processed, {
      userId, username, firstName, chatId: chatJid, chatType, authorized,
    });
  }

  // ── Start ─────────────────────────────────────────────────────

  log('whatsapp: starting (baileys)');
  connect();

  // Lazy group-subject lookup. Uses sock.groupMetadata which caches
  // server-side. Falls back to the bare JID when we can't reach it.
  async function _groupSubject(jid) {
    try { return (await sock?.groupMetadata?.(jid))?.subject ?? null; }
    catch (_) { return null; }
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
  async function listChats({ limit = 20, all = true } = {}) {
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

    // Filter + sort. Active chats first (lastActivityTs desc); inactive
    // ones come behind by creation ts only if all=true.
    const everything = [..._chats.values()];
    const active   = everything.filter(c => c.lastActivityTs > 0)
                               .sort((a, b) => b.lastActivityTs - a.lastActivityTs);
    const inactive = all
      ? everything.filter(c => c.lastActivityTs === 0)
                  .sort((a, b) => b.creationTs - a.creationTs)
      : [];
    const top = [...active, ...inactive].slice(0, limit);

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
      return {
        jid: c.jid,
        name,
        isGroup:        c.isGroup,
        lastActivityTs: c.lastActivityTs,
        creationTs:     c.creationTs,
      };
    }));
    return out;
  }

  return {
    listChats,
    send(text, { chatId } = {}) {
      const target = chatId ?? lastChat;
      if (!target || !sock) return;
      sock.sendMessage(target, { text })
        .then(r => rememberSent(r?.key?.id))
        .catch(e => err(`send: ${e.message}`));
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
      (async () => {
        try {
          const r = await sock.sendMessage(target, { text: initialText });
          msgKey = r?.key ?? null;
          rememberSent(r?.key?.id);
        } catch (e) { err(`stream start: ${e.message}`); }
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
        sock.sendMessage(target, { edit: msgKey, text })
          .then((r) => {
            rememberSent(r?.key?.id);
            lastSent = text;
            lastEditAt = Date.now();
          })
          .catch((e) => err(`stream edit: ${e.message}`));
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
            if (initialDone && msgKey) {
              if (pending !== null && pending !== lastSent) {
                const r = await sock.sendMessage(target, { edit: msgKey, text: pending });
                rememberSent(r?.key?.id);
                lastSent = pending;
              }
            } else {
              const r = await sock.sendMessage(target, { text: pending });
              rememberSent(r?.key?.id);
            }
          } catch (e) { err(`stream finish: ${e.message}`); }
          stopTyping();
        },
      };
    },
    stop() {
      stopped = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
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
  };
}

// ── helpers ──────────────────────────────────────────────────────

function textOf(message) {
  return (
    message.conversation ??
    message.extendedTextMessage?.text ??
    message.imageMessage?.caption ??
    message.videoMessage?.caption ??
    null
  );
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
