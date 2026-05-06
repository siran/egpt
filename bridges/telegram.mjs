// bridges/telegram.mjs — Telegram Bot API bridge for egpt.
//
// Telegram is the off-LAN bridge. Recommended one bot token per node so each
// off-LAN node has independent access; LAN coordination is via the CDP bus
// (see tools/bus.mjs), not Telegram. With one-token-per-node there is no
// contention for the polling slot.
//
// If two nodes accidentally share a token, Bot API returns 409 Conflict to
// one of them. We back off and retry — purely defensive; coordination is the
// host's job, done via /telegram <node> over the bus.
//
// Config keys (from ~/.egpt/config.json → "telegram", or chrome.storage):
//   bot_token     — required. From @BotFather.
//   node_name     — this node's identifier. Default: 'node'.
//   allowed_users — array of Telegram user IDs authorized for commands.
//   chat_id       — optional initial outgoing chat target.

const API = (token) => `https://api.telegram.org/bot${token}`;

const POLL_TIMEOUT = 25;     // seconds — Telegram long-poll window
const RETRY_409   = 15_000;  // ms to wait when another node is polling
const RETRY_ERR   = 5_000;   // ms to wait after network/other errors

export function startTelegramBridge({
  botToken,
  nodeName    = 'node',
  allowedUsers = [],
  chatId       = null,
  onIncoming,
  onLog,
  onError,
  onYield,    // called once when 409 forces us to release the polling slot
  onChatId,   // called once when the bridge captures its first chat (host can persist)
}) {
  if (!botToken) throw new Error('telegram bridge: botToken is required');

  const log = (m) => onLog?.(m);
  const err = (m) => onError?.(m);

  let offset    = 0;
  let lastChat  = chatId ?? null;
  let chatIdNotified = !!chatId;  // skip onChatId if host pre-configured it
  let stopped   = false;
  let pollTimer = null;
  let sendChain = Promise.resolve();

  // ── Bot API fetch ─────────────────────────────────────────────

  async function apiFetch(method, body = {}) {
    const res = await fetch(`${API(botToken)}/${method}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    if (res.status === 409) {
      const e = new Error('409 Conflict');
      e.status = 409;
      throw e;
    }
    const json = await res.json();
    if (!json.ok) {
      const e = new Error(json.description ?? 'telegram api error');
      e.status = res.status;
      throw e;
    }
    return json.result;
  }

  // ── Polling loop ──────────────────────────────────────────────
  //
  // /telegram coordination is NOT in this file: the bridge is dumb (poll +
  // confirm + deliver). The host parses /telegram via its slash-command
  // handler and posts handoff events on the CDP bus. 409 Conflict here is
  // purely defensive (someone else accidentally polling the same token).

  async function poll() {
    if (stopped) return;
    try {
      const updates = await apiFetch('getUpdates', {
        offset,
        timeout:          POLL_TIMEOUT,
        allowed_updates:  ['message'],
      });

      if (stopped) return;

      for (const upd of updates) {
        await handleUpdate(upd);
        offset = upd.update_id + 1;
        if (stopped) return;
      }

      pollTimer = setTimeout(poll, 0);
    } catch (e) {
      if (stopped) return;
      if (e.status === 409) {
        // Another node is already polling this token. Yield permanently
        // (no retry loop — the noise was unhelpful and the right answer
        // is "let the holder hold it"). The host decides whether to
        // auto-resume when the holder releases (via onYield + bus state).
        log('telegram: 409 conflict — another node is polling this token; yielding');
        stopped = true;
        if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
        try { onYield?.(); } catch (_) {}
        return;
      }
      err(`telegram poll error: ${e.message}`);
      pollTimer = setTimeout(poll, RETRY_ERR);
    }
  }

  async function handleUpdate(upd) {
    const msg = upd.message;
    if (!msg?.text) return;

    const userId    = msg.from?.id ?? 0;
    const username  = msg.from?.username ?? null;
    const firstName = msg.from?.first_name ?? 'human';
    const msgChat   = msg.chat?.id ?? null;
    if (msgChat) {
      lastChat = msgChat;
      if (!chatIdNotified) {
        chatIdNotified = true;
        try { onChatId?.(msgChat); } catch (_) {}
      }
    }

    const authorized = allowedUsers.length > 0 && allowedUsers.includes(userId);
    const text = msg.text.trim();

    try {
      await onIncoming?.(text, { userId, username, firstName, chatId: msgChat, authorized });
    } catch (e) {
      err(`onIncoming threw: ${e.message}`);
    }
  }

  // ── Send helpers ──────────────────────────────────────────────

  function enqueue(fn) {
    sendChain = sendChain.then(fn).catch(e => err(`send error: ${e.message}`));
    return sendChain;
  }

  async function sendText(chatId, text) {
    const chunks = chunkText(text, 4096);
    for (const chunk of chunks) {
      await apiFetch('sendMessage', {
        chat_id:              chatId,
        text:                 chunk,
        parse_mode:           'HTML',
        link_preview_options: { is_disabled: true },
      });
    }
  }

  function startStreamMessage(initialText, { chatId } = {}) {
    const targetChat = chatId ?? lastChat;
    if (!targetChat) return null;
    let msgId       = null;
    let pending     = null;
    let lastSent    = initialText;
    let lastEditAt  = Date.now();
    let editTimer   = null;
    let initialDone = false;

    enqueue(async () => {
      try {
        const sent = await apiFetch('sendMessage', {
          chat_id:              targetChat,
          text:                 initialText.slice(0, 4096),
          parse_mode:           'HTML',
          link_preview_options: { is_disabled: true },
        });
        msgId = sent.message_id;
      } catch (e) { err(`stream start: ${e.message}`); }
      initialDone = true;
      if (pending !== null) maybeEdit();
    });

    function flush() {
      if (editTimer) { clearTimeout(editTimer); editTimer = null; }
      if (!initialDone || !msgId) return;
      if (pending === null || pending === lastSent) return;
      const text = pending;
      pending = null;
      enqueue(async () => {
        try {
          await apiFetch('editMessageText', {
            chat_id:              targetChat,
            message_id:           msgId,
            text:                 text.slice(0, 4096),
            parse_mode:           'HTML',
            link_preview_options: { is_disabled: true },
          });
          lastSent   = text;
          lastEditAt = Date.now();
        } catch {}
      });
    }

    function maybeEdit() {
      const since    = Date.now() - lastEditAt;
      const interval = 1500;
      if (since >= interval) flush();
      else if (!editTimer) editTimer = setTimeout(() => { editTimer = null; flush(); }, interval - since);
    }

    return {
      update(text) { pending = text; maybeEdit(); },
      async finish(text) {
        pending = text;
        if (editTimer) { clearTimeout(editTimer); editTimer = null; }
        flush();
        try { await sendChain; } catch {}
      },
    };
  }

  // ── Start ─────────────────────────────────────────────────────

  log(`telegram: starting as "${nodeName}"`);
  poll();

  return {
    send(text, { chatId } = {}) {
      const target = chatId ?? lastChat;
      if (!target) return;
      enqueue(() => sendText(target, text));
    },
    startStreamMessage,
    stop() {
      stopped = true;
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    },
    get chatId() { return lastChat; },
  };
}

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
