// bridges/telegram.mjs — Telegram Bot API bridge for egpt.
//
// Multiple nodes (extension, shells) compete to poll. Only one wins at a time:
// getUpdates returns 409 when another node holds the connection. Losers back
// off and retry every RETRY_409 ms. When the active poller wants to hand off,
// it reads the handoff directive, leaves it UNCONFIRMED (offset stays at that
// update_id), and stops. The next node to grab polling reads the same message
// and, if addressed to it, sets offset = N+1 and continues.
//
// Handoff message (sent by user from their Telegram client):
//   /telegram @nodeName [offset:N] [ttl:T]
//   /telegram disconnect
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
}) {
  if (!botToken) throw new Error('telegram bridge: botToken is required');

  const log = (m) => onLog?.(m);
  const err = (m) => onError?.(m);

  let offset    = 0;
  let lastChat  = chatId ?? null;
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
        const keep = await handleUpdate(upd);
        // Advance offset only when we're "consuming" the update.
        // For handoff-to-other, keep === false: leave update unconfirmed.
        if (keep !== false) offset = upd.update_id + 1;
        if (stopped) return;
      }

      pollTimer = setTimeout(poll, 0);
    } catch (e) {
      if (stopped) return;
      if (e.status === 409) {
        log('telegram: another node is polling — waiting…');
        pollTimer = setTimeout(poll, RETRY_409);
      } else {
        err(`telegram poll error: ${e.message}`);
        pollTimer = setTimeout(poll, RETRY_ERR);
      }
    }
  }

  // ── Update handler ────────────────────────────────────────────
  // Returns false to leave the update unconfirmed (handoff-to-other case).

  async function handleUpdate(upd) {
    const msg = upd.message;
    if (!msg?.text) return true;

    const userId    = msg.from?.id ?? 0;
    const username  = msg.from?.username ?? null;
    const firstName = msg.from?.first_name ?? 'human';
    const msgChat   = msg.chat?.id ?? null;
    if (msgChat) lastChat = msgChat;

    const authorized = allowedUsers.length > 0 && allowedUsers.includes(userId);
    const text = msg.text.trim();

    // ── /telegram handoff directive ───────────────────────────
    const handoff = parseHandoff(text);
    if (handoff) {
      if (handoff.target === 'disconnect') {
        log('telegram: disconnect directive — stopping');
        stopped = true;
        return true; // confirm: no node should re-read a disconnect
      }

      if (handoff.target !== nodeName) {
        // Not addressed to us. Leave update unconfirmed so the target
        // node will read it when it grabs polling.
        log(`telegram: handoff to ${handoff.target} — stepping back`);
        stopped = true;
        if (handoff.ttl) {
          pollTimer = setTimeout(() => {
            if (!stopped) return;
            stopped = false;
            log(`telegram: TTL expired — attempting to reclaim`);
            poll();
          }, handoff.ttl * 1000);
        }
        return false; // ← do NOT advance offset
      }

      // Addressed to us. If message includes explicit offset, jump there.
      if (handoff.offset != null) offset = handoff.offset;
      log(`telegram: handoff accepted — polling as ${nodeName}`);
      return true; // confirm and continue
    }

    // ── Regular message ───────────────────────────────────────
    try {
      await onIncoming?.(text, { userId, username, firstName, chatId: msgChat, authorized });
    } catch (e) {
      err(`onIncoming threw: ${e.message}`);
    }
    return true;
  }

  // ── Handoff parser ────────────────────────────────────────────
  // /telegram @target [offset:N] [ttl:T]
  // /telegram disconnect

  function parseHandoff(text) {
    const m = text.match(/^\/telegram\s+(\S+)(?:\s+offset:(\d+))?(?:\s+ttl:(\d+))?/i);
    if (!m) return null;
    const target = m[1].replace(/^@/, '');
    return {
      target,
      offset: m[2] != null ? parseInt(m[2], 10) : null,
      ttl:    m[3] != null ? parseInt(m[3], 10) : null,
    };
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
        link_preview_options: { is_disabled: true },
      });
    }
  }

  function startStreamMessage(initialText) {
    if (!lastChat) return null;
    const targetChat = lastChat;
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
    send(text) {
      if (!lastChat) return;
      enqueue(() => sendText(lastChat, text));
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
