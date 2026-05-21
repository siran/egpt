// bridges/telegram-mtproto.mjs — Telegram user-account (MTProto) bridge.
//
// Symmetric to bridges/whatsapp.mjs (baileys): the daemon logs in as
// the OPERATOR'S OWN Telegram account (phone-number based), sees every
// chat they're in (DMs, groups, channels), and acts as them. This is
// the PRIMARY TG surface. The Bot API bridge (bridges/telegram.mjs)
// stays as a rescue/fallback channel — distinct identity, distinct
// chats, used for control surfaces and alerts.
//
// First-run setup is a one-time interactive flow handled by
// tools/tg-mtproto-auth.mjs: operator runs that script, enters their
// phone, SMS code, and 2FA password; the script writes a session
// string to ~/.egpt/tg-mtproto-session.txt. Subsequent daemon boots
// load the session string and connect silently.
//
// Config (from ~/.egpt/config.yaml under telegram.mtproto):
//   api_id        — required. From https://my.telegram.org/apps
//   api_hash      — required. Same source.
//   session_path  — optional. Default ~/.egpt/tg-mtproto-session.txt
//
// The bridge exposes the same shape as bridges/telegram.mjs so callers
// (egpt.mjs onIncoming / outbox wa-send-equivalent) can swap freely:
//   { send, sendText, startStreamMessage, stop, healthy() }
// Plus a `routes` flag on each onIncoming to indicate is-direct-chat /
// is-group / is-channel so the host can apply per-surface routing.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

// Lazy imports — gramjs is heavy. Load on bridge start, not on module import.
let TelegramClient, StringSession, NewMessage, Api;

async function _loadGramjs() {
  if (TelegramClient) return;
  const tg = await import('telegram');
  const sessions = await import('telegram/sessions/index.js');
  const events = await import('telegram/events/index.js');
  TelegramClient = tg.TelegramClient;
  Api            = tg.Api;
  StringSession  = sessions.StringSession;
  NewMessage     = events.NewMessage;
}

const DEFAULT_SESSION_PATH = join(homedir(), '.egpt', 'tg-mtproto-session.txt');

export async function startTelegramMtprotoBridge({
  apiId,
  apiHash,
  sessionPath  = DEFAULT_SESSION_PATH,
  maxBacklogSeconds = 5,
  onIncoming,
  onLog,
  onError,
  // Sender-resolver hook: gramjs gives us peer IDs; host may want to
  // resolve usernames/firstnames separately for slug-hint enrichment.
  // If null, we resolve via client.getEntity ourselves on first sight.
}) {
  if (!apiId || !apiHash) {
    throw new Error('telegram-mtproto: api_id and api_hash are required (set telegram.mtproto in ~/.egpt/config.yaml; obtain from https://my.telegram.org/apps)');
  }
  if (!existsSync(sessionPath)) {
    throw new Error(`telegram-mtproto: no session file at ${sessionPath}. Run \`node tools/tg-mtproto-auth.mjs\` first to authorize.`);
  }

  await _loadGramjs();

  const log = (m) => onLog?.(m);
  const err = (m) => onError?.(m);

  const sessionString = (await readFile(sessionPath, 'utf8')).trim();
  const session = new StringSession(sessionString);
  const client = new TelegramClient(session, Number(apiId), String(apiHash), {
    connectionRetries: 5,
    autoReconnect:     true,
    // gramjs's own logger is noisy; we route via onLog selectively.
    baseLogger: { log: () => {}, warn: (m) => log(`gramjs warn: ${m}`),
                  error: (m) => err(`gramjs error: ${m}`), info: () => {},
                  debug: () => {} },
  });

  let stopped     = false;
  let connectedAt = 0;
  const _heldMessages = [];
  // Cache resolved entities so we don't re-fetch on every message.
  const _entityCache = new Map();   // peerKey → { name, username, isUser, isGroup, isChannel }

  // ── connect ────────────────────────────────────────────────────

  await client.connect();
  if (!await client.isUserAuthorized()) {
    throw new Error('telegram-mtproto: session file is present but not authorized. Re-run tools/tg-mtproto-auth.mjs.');
  }
  connectedAt = Date.now();
  log(`mtproto: connected as user account`);

  // ── message handler ────────────────────────────────────────────

  async function _resolveEntity(peer) {
    const key = peer?.userId?.toString?.()
             ?? peer?.chatId?.toString?.()
             ?? peer?.channelId?.toString?.()
             ?? String(peer);
    if (_entityCache.has(key)) return _entityCache.get(key);
    let info = { name: null, username: null, isUser: false, isGroup: false, isChannel: false };
    try {
      const ent = await client.getEntity(peer);
      info.username = ent.username ?? null;
      info.name     = ent.firstName
                      ?? ent.title
                      ?? ent.username
                      ?? null;
      info.isUser    = ent.className === 'User';
      info.isGroup   = ent.className === 'Chat' || (ent.className === 'Channel' && ent.megagroup);
      info.isChannel = ent.className === 'Channel' && !ent.megagroup;
    } catch (e) {
      log(`mtproto: getEntity failed for ${key}: ${e?.message ?? e}`);
    }
    _entityCache.set(key, info);
    return info;
  }

  // gramjs IDs: peerId is an object {userId} / {chatId} / {channelId}.
  // We normalize to a stable string id for use as the chat's threadId
  // in conversations.yaml. Format mirrors WA's JID convention loosely:
  //   user:<userId>     1:1 with a user
  //   chat:<chatId>     small group ("basic group" in TG terms)
  //   channel:<channelId>  supergroup or broadcast channel
  function _normalizedChatId(peer) {
    if (!peer) return null;
    if (peer.userId    != null) return `tg:user:${peer.userId.toString()}`;
    if (peer.chatId    != null) return `tg:chat:${peer.chatId.toString()}`;
    if (peer.channelId != null) return `tg:channel:${peer.channelId.toString()}`;
    return null;
  }

  client.addEventHandler(async (event) => {
    if (stopped) return;
    const msg = event.message;
    if (!msg) return;
    const text = msg.message ?? '';
    if (!text) return;     // only handle text (for now — media is a follow-up)

    const chatPeer = msg.peerId;
    const senderPeer = msg.fromId ?? chatPeer;  // 1:1 has no fromId; fall back to peer
    const chatId   = _normalizedChatId(chatPeer);
    if (!chatId) return;

    // Backlog hold — same shape as the WA / bot bridges. msg.date is
    // a unix timestamp (seconds).
    if (maxBacklogSeconds >= 0 && connectedAt > 0) {
      const msgTsMs = (Number(msg.date) || 0) * 1000;
      if (msgTsMs > 0 && msgTsMs < connectedAt - maxBacklogSeconds * 1000) {
        _heldMessages.push({
          chatId, text, ts: msgTsMs,
          msgId: msg.id ?? null,
          fromMe: !!msg.out,
        });
        log(`mtproto: held pre-connect message in ${chatId}: "${text.slice(0, 60)}${text.length > 60 ? '…' : ''}"`);
        return;
      }
    }

    const chatInfo   = await _resolveEntity(chatPeer);
    const senderInfo = senderPeer === chatPeer ? chatInfo : await _resolveEntity(senderPeer);

    try {
      await onIncoming?.(text, {
        chatId,
        chatType:  chatInfo.isUser ? 'private'
                 : chatInfo.isGroup ? 'group'
                 : chatInfo.isChannel ? 'channel'
                 : 'unknown',
        chatName:  chatInfo.name ?? null,
        senderId:  senderPeer?.userId?.toString?.() ?? null,
        senderName: senderInfo.name ?? null,
        senderUsername: senderInfo.username ?? null,
        fromMe:    !!msg.out,
        tgMessageId: msg.id ?? null,
      });
    } catch (e) {
      err(`onIncoming threw: ${e?.message ?? e}`);
    }
  }, new NewMessage({}));

  // ── send API ───────────────────────────────────────────────────

  async function sendText(chatId, text, { replyTo } = {}) {
    // Reverse the chatId normalization: "tg:user:123" → 123 (user peer).
    // client.sendMessage accepts the bare ID for users, or a username,
    // or an InputPeer. For groups/channels, we pass the negative form
    // that MTProto expects when working with chatId/channelId.
    const target = _resolveTarget(chatId);
    if (!target) {
      err(`mtproto sendText: cannot resolve target "${chatId}"`);
      return;
    }
    try {
      await client.sendMessage(target, {
        message: text,
        ...(replyTo ? { replyTo } : {}),
      });
    } catch (e) {
      err(`mtproto sendText to ${chatId}: ${e?.message ?? e}`);
      throw e;
    }
  }

  function _resolveTarget(chatId) {
    if (typeof chatId !== 'string') return chatId;
    const m = chatId.match(/^tg:(user|chat|channel):(.+)$/);
    if (!m) return chatId;
    const [, kind, idStr] = m;
    // gramjs accepts BigInt or numeric for user ids; for chats and
    // channels the MTProto-side negative-id convention is what
    // client.sendMessage's resolve-cache expects.
    const id = BigInt(idStr);
    if (kind === 'user')    return id;
    if (kind === 'chat')    return -id;
    if (kind === 'channel') return BigInt('-100' + idStr);
    return chatId;
  }

  // Stream-message support: gramjs allows editMessage for in-flight
  // updates, same model as the bot bridge. Skeleton for now — first
  // ship the receive path; streaming sends are a follow-up.
  function startStreamMessage(initialText, { chatId } = {}) {
    // TODO: mirror bridges/telegram.mjs startStreamMessage with
    // client.editMessage. Punt for v1 — operators that need streams
    // can fall back to the bot bridge.
    return null;
  }

  // ── lifecycle ──────────────────────────────────────────────────

  async function stop() {
    if (stopped) return;
    stopped = true;
    try { await client.disconnect(); } catch (e) { err(`mtproto stop: ${e?.message ?? e}`); }
    log('mtproto: bridge stopped');
  }

  function healthy() {
    return !stopped && client.connected;
  }

  function listHeld() {
    return _heldMessages.slice();
  }
  function clearHeld() {
    _heldMessages.length = 0;
  }

  return {
    send: sendText,
    sendText,
    startStreamMessage,
    stop,
    healthy,
    listHeld,
    clearHeld,
    // Expose the underlying client for advanced uses (entity resolution,
    // sending media, etc.) — host should treat this as escape hatch.
    _client: client,
  };
}
