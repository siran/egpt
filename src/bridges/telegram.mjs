// telegram.mjs — the Telegram limb: one bot on the Bot API, over HTTPS with plain fetch.
// Long polling (getUpdates): the node dials out, no inbound port, no webhook.
// It is the "real" bridge behind the port adapter (beeper-port.mjs createBeeperBridgePort with
// `start` injected), so it keeps startBeeperBridge's contract and the wrap/stream/status logic
// stays in one place. Text only for now; media is logged and its caption passed on.
// Inside the spine a chat id is `tg:<chat id>`; the prefix is dropped only at the API call.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { mentionStatus } from '../auto-mode.mjs';
import { decodeNodeSignature, decodeBeingSignature } from '../node-signature.mjs';

export const TG_PREFIX = 'tg:';
export const isTelegramChatId = (id) => String(id ?? '').startsWith(TG_PREFIX);
const apiChatId = (id) => (isTelegramChatId(id) ? String(id).slice(TG_PREFIX.length) : null);

// The bot token lives in a file, never in config.yaml: $EGPT_HOME/secrets/telegram-<connection>.token
export const telegramTokenPath = (home, connection) => join(home, 'secrets', `telegram-${connection}.token`);
export const secretTag = (s) => `${s.length} chars, sha256 ${createHash('sha256').update(s).digest('hex').slice(0, 12)}`;

// { token, path, warn } or { token: null, path, problem }.
export function readTelegramToken(home, connection, { platform = process.platform } = {}) {
  const path = telegramTokenPath(home, connection);
  let token;
  try { token = readFileSync(path, 'utf8').trim(); }
  catch (e) { return { token: null, path, problem: e?.code === 'ENOENT' ? 'missing' : (e?.message ?? String(e)) }; }
  if (!token) return { token: null, path, problem: 'empty' };
  let warn = null;
  if (platform !== 'win32') {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) warn = `mode ${mode.toString(8)}, expected 600`;
  }
  return { token, path, warn };
}

const API_BASE = 'https://api.telegram.org';
const POLL_TIMEOUT_S = 25;
const POLL_ABORT_MS = (POLL_TIMEOUT_S + 15) * 1000;   // a silently dropped connection must not hang the poll
const TEXT_MAX = 4000;                                // under the 4096 limit, room for the signature
const EDIT_MIN_MS = 1000;                             // Telegram rate-limits edits; one a second per stream
const RETRY_MIN_MS = 3_000, RETRY_MAX_MS = 60_000;
const CONFLICT_MIN_MS = 60_000, CONFLICT_MAX_MS = 15 * 60_000;
const RETRY_AFTER_MAX_S = 30;
const WAKE_WINDOW_MS = 15 * 60_000;                   // older than this before start (or wake) = backlog, as on Beeper
const SENT_MAX = 2000;
const MEDIA_KEYS = ['photo', 'voice', 'audio', 'video', 'video_note', 'document', 'sticker', 'animation'];

// Split on code points so a surrogate pair is never cut.
function chunks(text) {
  const out = [];
  let cur = '';
  for (const ch of String(text ?? '')) {
    if (cur.length + ch.length > TEXT_MAX) { out.push(cur); cur = ''; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function startTelegramBridge({
  telegramToken,
  connection = 'main',
  isAllowedUser = () => false,
  wakeWords,
  addressWithoutAt = true,
  nodeName = '',
  resumedAt = () => null,
  onIncoming,
  onLog: log = () => {},   // boot tags each line [telegram]
  fetch: fetchFn = (...a) => globalThis.fetch(...a),
  setTimeout: setTimeoutFn = globalThis.setTimeout,
  clearTimeout: clearTimeoutFn = globalThis.clearTimeout,
  now = () => Date.now(),
} = {}) {
  const token = String(telegramToken ?? '');
  const scrub = (s) => (token ? String(s).split(token).join('<token>') : String(s));
  const startedAt = now();
  const ac = new AbortController();
  const timers = new Map();        // pending waits: timer -> resolve, so stop() ends every loop
  const sent = new Set();          // `${chatId}#${msgId}` of everything this bot posted
  const titles = new Map();
  const failures = new Map();
  let stopped = false, alive = false, me = null, offset = 0, privacyNoted = false;

  const wait = (ms) => new Promise((resolve) => {
    if (stopped) { resolve(); return; }
    const t = setTimeoutFn(() => { timers.delete(t); resolve(); }, ms);
    timers.set(t, resolve);
  });

  async function api(method, body = {}, { signal } = {}) {
    let res;
    try {
      res = await fetchFn(`${API_BASE}/bot${token}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
      });
    } catch (e) { throw new Error(scrub(`${e?.message ?? e}${e?.cause?.code ? ` (${e.cause.code})` : ''}`)); }
    const j = await res.json().catch(() => null);
    if (j?.ok) return j.result;
    const err = new Error(scrub(j?.description ?? `HTTP ${res.status}`));
    err.status = j?.error_code ?? res.status;
    err.retryAfter = j?.parameters?.retry_after ?? null;
    throw err;
  }
  // One retry on 429, after the wait Telegram names (when it is short).
  async function call(method, body) {
    try { return await api(method, body); }
    catch (e) {
      if (e.status !== 429 || !(e.retryAfter <= RETRY_AFTER_MAX_S) || stopped) throw e;
      await wait(e.retryAfter * 1000);
      return api(method, body);
    }
  }

  const noteSent = (chatId, id) => {
    sent.add(`${chatId}#${id}`);
    if (sent.size > SENT_MAX) sent.delete(sent.values().next().value);
  };
  const wasSentByUs = (chatId, msgId) => msgId != null && sent.has(`${chatId}#${msgId}`);

  // --- inbound ---
  function handle(update) {
    const m = update?.message;
    if (!m) return;
    const chat = m.chat ?? {};
    if (chat.type === 'channel') return;
    const chatId = TG_PREFIX + chat.id;
    const group = chat.type === 'group' || chat.type === 'supergroup';
    const title = chat.title ?? ([chat.first_name, chat.last_name].filter(Boolean).join(' ') || (chat.username ? `@${chat.username}` : chatId));
    titles.set(chatId, title);
    const media = MEDIA_KEYS.find((k) => m[k] != null);
    if (media) log(`[${title}] ${media}: media not handled yet${m.caption ? ' — passing the caption' : ''}`);
    let text = String(m.text ?? m.caption ?? '');
    if (!text.trim()) return;
    if (group && me && me.can_read_all_group_messages === false && !privacyNoted) {
      privacyNoted = true;
      log(`first group message (${title}): @${me.username} has privacy mode ON, so in groups it receives only /commands, replies to it and @${me.username} mentions`);
    }
    // A group command addressed to this bot (/status@bot) is the command itself.
    if (me?.username) text = text.replace(new RegExp(`^(/\\S+?)@${escapeRe(me.username)}\\b`, 'i'), '$1');
    const userId = String(m.from?.id ?? '');
    const senderName = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ') || (m.from?.username ? `@${m.from.username}` : userId);
    const tsMs = (Number(m.date) || 0) * 1000 || now();
    const quoted = m.reply_to_message ?? null;
    const replyToId = quoted?.message_id != null ? String(quoted.message_id) : null;
    const quotedText = String(quoted?.text ?? quoted?.caption ?? '');
    const replyToNode = quoted ? decodeNodeSignature(quotedText) : null;
    const replyToBeing = replyToNode != null && replyToNode === String(nodeName).trim() ? decodeBeingSignature(quotedText) : null;
    const replyToBot = !!quoted && ((me?.id != null && quoted.from?.id === me.id) || wasSentByUs(chatId, replyToId) || !!replyToBeing);
    const st = mentionStatus(text, wakeWords, { addressWithoutAt });
    const backlog = tsMs < Math.max(startedAt, resumedAt?.() ?? 0) - WAKE_WINDOW_MS;
    const from = {
      chatId, chatName: title, chatType: group ? 'group' : 'private', network: 'telegram',
      userId, username: m.from?.username, firstName: m.from?.first_name, senderName,
      isSender: false,
      authorized: !!userId && !!isAllowedUser(userId, 'telegram'),
      atEStart: st.atEStart, atEAnywhere: st.atEAnywhere,
      backlog, replyToBot, replyToId, replyToBeing, replyToNode,
      isReaction: false,
      msgKey: m.message_id != null ? String(m.message_id) : null,
      msgTs: tsMs,
    };
    log(`incoming [${title}] ${senderName}: ${JSON.stringify(text.slice(0, 60))} (atE=${st.atEAnywhere}${replyToBot ? ' replyToBot' : ''}${replyToId ? ` ↩${replyToId}` : ''}${backlog ? ' backlog' : ''})`);
    // Not awaited: the spine owns per-chat ordering (enqueue), as with Beeper.
    try { Promise.resolve(onIncoming?.(text, from)).catch((e) => log(`onIncoming threw — ${e?.message ?? e}`)); }
    catch (e) { log(`onIncoming threw — ${e?.message ?? e}`); }
  }

  async function poll() {
    let retryMs = RETRY_MIN_MS, conflictMs = CONFLICT_MIN_MS;
    while (!stopped) {
      try {
        const signal = AbortSignal.any([ac.signal, AbortSignal.timeout(POLL_ABORT_MS)]);
        const updates = await api('getUpdates', { offset, timeout: POLL_TIMEOUT_S, allowed_updates: ['message'] }, { signal });
        if (!alive) log('polling');
        alive = true; retryMs = RETRY_MIN_MS; conflictMs = CONFLICT_MIN_MS;
        for (const u of updates ?? []) {
          offset = Math.max(offset, Number(u.update_id) + 1);
          try { handle(u); } catch (e) { log(`an update could not be handled — ${e?.message ?? e}`); }
        }
      } catch (e) {
        if (stopped) return;
        alive = false;
        if (e.status === 409) {
          log(`409 Conflict (${e.message}) — only one poller per bot token; backing off ${Math.round(conflictMs / 1000)}s, not fighting it`);
          await wait(conflictMs);
          conflictMs = Math.min(conflictMs * 2, CONFLICT_MAX_MS);
        } else if (e.status === 401 || e.status === 404) {
          log(`the Bot API rejected the token (${e.status}) — this limb is deaf until the token file is fixed and the spine restarts`);
          return;
        } else {
          log(`poll failed — ${e.message}; retrying in ${Math.round(retryMs / 1000)}s`);
          await wait(retryMs);
          retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
        }
      }
    }
  }

  // getMe first: it proves the token and names the bot. Never the token itself in a line.
  const startupReady = (async () => {
    if (!token) { log(`'${connection}': no token — limb inert`); return; }
    let retryMs = RETRY_MIN_MS;
    while (!stopped && !me) {
      try { me = await api('getMe'); }
      catch (e) {
        if (stopped) return;
        if (e.status === 401 || e.status === 404) { log(`'${connection}': the Bot API rejected the token (${secretTag(token)}) — limb inert until it is replaced (setup/telegram-token.mjs) and the spine restarts`); return; }
        log(`'${connection}': getMe failed — ${e.message}; retrying in ${Math.round(retryMs / 1000)}s`);
        await wait(retryMs);
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      }
    }
    if (stopped) return;
    log(`'${connection}' is @${me.username} (id ${me.id})`);
    if (me.can_read_all_group_messages === false) {
      log(`@${me.username} has privacy mode ON: in groups it hears only /commands, replies to it and @${me.username} mentions. To hear every message: @BotFather → /setprivacy → Disable (then re-add the bot to each group), or make it a group admin.`);
    }
    poll();
  })();

  // --- outbound ---
  async function send(text, { chatId, replyToMessageID = null } = {}) {
    const chat = apiChatId(chatId);
    if (chat == null) { log(`send refused — ${chatId} is not a telegram chat`); return null; }
    if (!String(text ?? '').trim()) return null;
    let first = null;
    try {
      for (const [i, part] of chunks(text).entries()) {
        const body = { chat_id: chat, text: part };
        if (i === 0 && replyToMessageID != null) body.reply_parameters = { message_id: Number(replyToMessageID), allow_sending_without_reply: true };
        const m = await call('sendMessage', body);
        noteSent(chatId, m.message_id);
        first ??= String(m.message_id);
      }
      failures.delete(chatId);
      return { messageId: first, confirmedId: first };
    } catch (e) {
      failures.set(chatId, e.message);
      log(`send to ${chatId} failed — ${e.message}`);
      return first ? { messageId: first, confirmedId: first } : null;
    }
  }

  async function editMessage(chatId, msgId, text) {
    const chat = apiChatId(chatId);
    if (chat == null || msgId == null) return false;
    try { await call('editMessageText', { chat_id: chat, message_id: Number(msgId), text: chunks(text)[0] }); return true; }
    catch (e) {
      if (/not modified/i.test(e.message)) return true;
      log(`edit #${msgId} in ${chatId} failed — ${e.message}`);
      return false;
    }
  }

  async function deleteMessage(chatId, msgId) {
    const chat = apiChatId(chatId);
    if (chat == null || msgId == null) return false;
    try { return !!(await call('deleteMessage', { chat_id: chat, message_id: Number(msgId) })); }
    catch (e) { log(`delete #${msgId} in ${chatId} failed — ${e.message}`); return false; }
  }

  // A bot holds at most one reaction per message: setting replaces it, [] takes it off.
  async function setReaction(chatId, msgId, reaction) {
    const chat = apiChatId(chatId);
    if (chat == null || msgId == null) return false;
    try { return !!(await call('setMessageReaction', { chat_id: chat, message_id: Number(msgId), reaction })); }
    catch (e) { log(`reaction on #${msgId} in ${chatId} failed — ${e.message}`); return false; }
  }

  // Placeholder now, in-place edits (at most one a second), the final text in the same message.
  function startStreamMessage(initialText, { chatId, replyToMessageID = null, existingMsgId = null } = {}) {
    let realId = existingMsgId ?? null, finished = false, latest = initialText;
    let lastEditAt = 0, timer = null, pending = null, chain = Promise.resolve();
    const handle = { delivered: false, lastError: null, get confirmedId() { return realId; } };
    const serial = (fn) => (chain = chain.then(fn, fn));
    const ready = existingMsgId ? Promise.resolve() : (async () => {
      const r = await send(initialText, { chatId, replyToMessageID });
      if (r) realId = r.messageId;
      else handle.lastError = failures.get(chatId) ?? 'placeholder send failed';
    })();
    const applyEdit = (t) => serial(async () => { await ready; return realId ? editMessage(chatId, realId, t) : false; });
    handle.update = (t) => {
      if (finished || !t) return;
      latest = t; pending = t;
      const n = now();
      if (n - lastEditAt >= EDIT_MIN_MS) { lastEditAt = n; pending = null; applyEdit(t); }
      else if (!timer) {
        timer = setTimeoutFn(() => {
          timer = null; lastEditAt = now();
          if (pending != null) { const p = pending; pending = null; applyEdit(p); }
        }, EDIT_MIN_MS - (n - lastEditAt));
      }
    };
    handle.finish = async (t) => {
      if (finished) return;
      finished = true;
      if (timer) { clearTimeoutFn(timer); timer = null; }
      if (t) latest = t;
      await ready;
      if (!realId) return;
      const [head, ...rest] = chunks(latest);
      if (await applyEdit(head)) {
        handle.delivered = true;
        for (const part of rest) await send(part, { chatId });
        return;
      }
      handle.lastError = handle.lastError || 'final edit failed';
      await applyEdit(`⚠️ could not deliver this reply — ${handle.lastError}`);
    };
    handle.delete = async () => {
      if (finished) return false;
      if (timer) { clearTimeoutFn(timer); timer = null; }
      await ready;
      if (!realId) return false;
      const ok = await serial(() => deleteMessage(chatId, realId));
      if (ok) { finished = true; realId = null; }
      return ok;
    };
    handle.fail = (e) => { finished = true; handle.lastError = e?.message ?? String(e); log(`stream fail — ${handle.lastError}`); };
    return handle;
  }

  return {
    startupReady,
    send,
    async sendAndGetId(text, { chatId } = {}) { return (await send(text, { chatId }))?.messageId ?? null; },
    editMessage,
    deleteMessage,
    sendReaction: (chatId, msgId, emoji) => setReaction(chatId, msgId, [{ type: 'emoji', emoji }]),
    removeReaction: (chatId, msgId) => setReaction(chatId, msgId, []),
    sendMedia: async (chatId) => { log(`media not handled yet — nothing sent to ${chatId}`); return false; },
    startStreamMessage,
    wasSentByUs,
    sendFailure: (chatId) => failures.get(chatId) ?? null,
    getChatName: (chatId) => titles.get(chatId) ?? null,
    isAlive: () => alive,
    stop: () => {
      stopped = true;
      ac.abort();
      for (const [t, resolve] of timers) { clearTimeoutFn(t); resolve(); }
      timers.clear();
    },
  };
}
