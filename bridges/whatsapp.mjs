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
// Streaming: WhatsApp doesn't support incremental message updates the way
// Telegram's editMessageText does. startStreamMessage buffers and sends
// once on finish(). (Edit-based pseudo-streaming via baileys's edit
// message support is a future option.)
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
import { join } from 'node:path';

const AUTH_DIR_DEFAULT = join(homedir(), '.egpt', 'wa-auth');
const RECONNECT_MS = 5_000;

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
  let sock           = null;
  let reconnectTimer = null;

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
      // Don't print history of past chats on first sync — too noisy.
      shouldSyncHistoryMessage: () => false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        // Render QR to a string so Ink can print it cleanly via onLog,
        // instead of qrcode-terminal writing directly to stdout (which
        // tangles with Ink's render).
        qrcode.generate(qr, { small: true }, (qrText) => {
          log('whatsapp: scan this QR (WhatsApp → Settings → Linked devices → Link a device):\n' + qrText);
        });
      }
      if (connection === 'open') {
        myJid = sock.user?.id ?? null;          // e.g. '1234567890:42@s.whatsapp.net' (with device id)
        myNumber = myJid?.split(':')[0]?.split('@')[0] ?? null;
        connectedAt = Date.now();
        const display = sock.user?.name ?? myNumber ?? '?';
        log(`whatsapp: connected as ${display} (${myNumber})`);
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

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (debug) {
        for (const m of messages) {
          const peek = textOf(m.message ?? {})?.slice(0, 60) ?? null;
          log(`whatsapp[debug]: upsert type=${type} jid=${m.key?.remoteJid} fromMe=${!!m.key?.fromMe} id=${m.key?.id} text=${JSON.stringify(peek)}`);
        }
      }
      // Default mode: 'notify' (push-real-time) + 'append' (commonly
      // used for own-device messages on linked devices — 'Message
      // Yourself' lands here on some baileys versions). 'prepend' is
      // bulk history sync; skip. Debug mode passes everything through
      // so the user can see what baileys actually delivers and which
      // filter (if any) was hiding it.
      if (!debug && type !== 'notify' && type !== 'append') return;
      for (const msg of messages) {
        try { await handleMessage(msg, { bypassAwareness: debug }); }
        catch (e) { err(`onIncoming threw: ${e.message}`); }
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
    // self-DM detection: compare BARE numbers, not full JIDs. myJid
    // includes a device-id segment (e.g. '16468217865:42@s.whatsapp.net'),
    // but remoteJid for incoming messages doesn't ('16468217865@s.whatsapp.net').
    // Comparing strings directly always fails for self-DMs.
    const chatNumber = chatJid0.split('@')[0]?.split(':')[0];
    const isSelfDM = !isGroup0 && chatNumber === myNumber;
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
    const isWakeWord = !!text && /@egpt\b/i.test(text);

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
    if (!chatIdNotified) {
      chatIdNotified = true;
      try { onChatId?.(chatJid); } catch (_) {}
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

  return {
    send(text, { chatId } = {}) {
      const target = chatId ?? lastChat;
      if (!target || !sock) return;
      sock.sendMessage(target, { text })
        .then(r => rememberSent(r?.key?.id))
        .catch(e => err(`send: ${e.message}`));
    },
    startStreamMessage(initialText, { chatId } = {}) {
      // No native streaming on WhatsApp. Buffer then send once on finish.
      const target = chatId ?? lastChat;
      if (!target || !sock) return null;
      let pending = initialText;
      return {
        update(text) { pending = text; },
        async finish(text) {
          pending = text;
          try {
            const r = await sock.sendMessage(target, { text: pending });
            rememberSent(r?.key?.id);
          } catch (e) { err(`stream finish: ${e.message}`); }
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
