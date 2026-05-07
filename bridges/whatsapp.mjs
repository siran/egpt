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
// Group-chat handling: in groups we only act on messages that mention us
// or reply to one of ours — same "explicit addressing" model the Telegram
// bridge uses with /cmd@bot. The @<our-number> mention is stripped from
// the text before forwarding to onIncoming.
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
  onIncoming,
  onLog,
  onError,
  onChatId,    // called once when first chat is captured (host can persist)
}) {
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
  let lastChat       = null;
  let chatIdNotified = false;
  let myJid          = null;     // our own jid (e.g. '1234567890@s.whatsapp.net')
  let myNumber       = null;     // bare number for mention-detection
  let sock           = null;
  let reconnectTimer = null;
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
      // Only act on real-time messages, not history sync replays.
      if (type !== 'notify') return;
      for (const msg of messages) {
        try { await handleMessage(msg); }
        catch (e) { err(`onIncoming threw: ${e.message}`); }
      }
    });
  }

  async function handleMessage(msg) {
    if (!msg.message) return;               // protocol message / ignored type

    // fromMe handling:
    //   * Messages with an id we just sent via baileys: skip
    //     (WhatsApp echoes our outbound to every linked device).
    //   * Messages typed from your phone to your own self-DM
    //     (chat with yourself): pass through — useful for solo
    //     testing, and the room treats them as user input.
    //   * Other fromMe (typing on phone to a friend, or another
    //     linked device): skip — the bridge would otherwise react
    //     to your own outbound.
    if (msg.key?.fromMe) {
      const id = msg.key.id;
      if (id && _sentIds.has(id)) {
        _sentIds.delete(id);
        return;
      }
      const isSelfDM = msg.key.remoteJid === myJid;
      if (!isSelfDM) return;
    }

    // Pull text out of whatever variant baileys delivered.
    const text = textOf(msg.message);
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
    const authorized = allowedUsers.length > 0
      && allowedUsers.some(u => normalize(u) === normalize(userId));

    let processed = text.trim();

    // In groups, only act on messages that mention us or reply to ours.
    // Otherwise we'd respond to every line of group chatter.
    if (chatType !== 'private') {
      const ctx = msg.message.extendedTextMessage?.contextInfo ?? {};
      const mentions = ctx.mentionedJid ?? [];
      const isMentioned = myNumber && mentions.some(m => m.startsWith(`${myNumber}@`));
      const replyingToMe = myJid && ctx.participant === myJid;
      if (!isMentioned && !replyingToMe) return;
      // Strip the @<our-number> mention from the text so downstream
      // command parsing sees a clean string.
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
    },
    get chatId() { return lastChat; },
    get myJid()  { return myJid; },
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
