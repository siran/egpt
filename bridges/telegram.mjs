// bridges/telegram.mjs — Telegram input/output bridge for egpt.
// Long-polls Telegram for incoming messages, calls onIncoming() with each.
// Exposes send() so egpt can forward room events back to the chat.
//
// Config (from ~/.egpt/config.json under "telegram"):
//   bot_token        — required. Get from BotFather.
//   allowed_users    — array of Telegram user IDs that may send commands.
//                      Empty/missing means anyone with the token can send.
//   chat_id          — optional. If set, outgoing messages go here even
//                      before any incoming. Otherwise outgoing buffers
//                      until the first incoming, then sends to that chat.

const TG_BASE = 'https://api.telegram.org/bot';
const sleep = (ms, signal) => new Promise((r, j) => {
  const t = setTimeout(r, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); j(new DOMException('aborted', 'AbortError')); }, { once: true });
});

export function startTelegramBridge({
  botToken,
  allowedUsers = [],
  chatId = null,
  onIncoming,
  onLog,
  onError,
}) {
  if (!botToken) throw new Error('telegram bridge: bot_token is required');

  let stopped = false;
  const stopController = new AbortController();
  let lastUpdateId = 0;
  let lastSeenChat = chatId;
  // Sequential send chain so messages arrive on Telegram in the order
  // egpt produced them. Without this, fire-and-forget fetch races over the
  // network and shorter messages can overtake longer ones.
  let sendChain = Promise.resolve();

  const log  = (m) => onLog?.(m);
  const err  = (m) => onError?.(m);

  async function sendMessage(targetChat, text) {
    if (!targetChat) return;
    const chunks = chunkText(text, 4000);
    for (const chunk of chunks) {
      try {
        const res = await fetch(`${TG_BASE}${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: targetChat, text: chunk, disable_web_page_preview: true, parse_mode: 'HTML' }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          err(`sendMessage HTTP ${res.status}: ${body.slice(0, 200)}`);
          return;
        }
      } catch (e) {
        err(`sendMessage failed: ${e.message}`);
        return;
      }
    }
  }

  async function pollLoop() {
    // Clear any stale webhook before long-polling. A set webhook causes Telegram
    // to return 409 Conflict on every getUpdates call.
    try {
      await fetch(`${TG_BASE}${botToken}/deleteWebhook`, { method: 'POST' });
    } catch {}
    log('telegram bridge: polling started');
    const sig = stopController.signal;
    while (!stopped) {
      try {
        // Long-polling: timeout=25 keeps the connection open up to 25s
        // waiting for new updates. Cheap, near-instant delivery.
        const url = `${TG_BASE}${botToken}/getUpdates?offset=${lastUpdateId + 1}&timeout=25`;
        const res = await fetch(url, { signal: sig });
        if (!res.ok) {
          if (res.status === 409) {
            // 409 Conflict = another getUpdates call is in flight (restarted too
            // fast) or a webhook is set. Wait 35s > the 25s long-poll timeout so
            // the old request expires, then retry.
            err('getUpdates 409 — another instance running or stale webhook. Waiting 35s…');
            await sleep(35000, sig);
          } else {
            err(`getUpdates HTTP ${res.status}`);
            await sleep(5000, sig);
          }
          continue;
        }
        const data = await res.json();
        if (!data.ok) {
          err(`getUpdates error: ${data.description}`);
          await sleep(5000, sig);
          continue;
        }
        for (const update of data.result) {
          lastUpdateId = update.update_id;
          const msg = update.message ?? update.edited_message;
          if (!msg || !msg.text) continue;
          if (allowedUsers.length > 0 && !allowedUsers.includes(msg.from.id)) {
            log(`ignored message from unauthorized user ${msg.from.id} (${msg.from.username || msg.from.first_name})`);
            continue;
          }
          lastSeenChat = msg.chat.id;
          try {
            await onIncoming(msg.text, {
              userId: msg.from.id,
              username: msg.from.username,
              firstName: msg.from.first_name,
              chatId: msg.chat.id,
            });
          } catch (e) {
            err(`onIncoming threw: ${e.message}`);
          }
        }
      } catch (e) {
        if (e.name === 'AbortError') break;
        err(`poll error: ${e.message}`);
        await sleep(5000, sig);
      }
    }
    log('telegram bridge: polling stopped');
  }

  pollLoop().catch(e => err(`pollLoop crashed: ${e.message}`));

  // Start a Telegram message that will be edited in place as a brain stream
  // progresses. Returns { update(text), finish(text) }. Drops silently if no
  // chat is known. Edits are throttled to once every 1.5s to stay under
  // Telegram's edit rate limit; finish() cancels the throttle and flushes.
  function startStreamMessage(initialText) {
    if (!lastSeenChat) return null;
    let msgId = null;
    let pending = null;
    let lastSent = initialText;
    let lastEditAt = Date.now();
    let editTimer = null;
    let initialDone = false;

    sendChain = sendChain.then(async () => {
      try {
        const res = await fetch(`${TG_BASE}${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: lastSeenChat, text: initialText.slice(0, 4000), disable_web_page_preview: true, parse_mode: 'HTML' }),
        });
        if (res.ok) {
          const data = await res.json();
          msgId = data.result?.message_id ?? null;
        }
      } catch (e) { err(`stream start: ${e.message}`); }
      initialDone = true;
      if (pending !== null) maybeEdit();
    }).catch(() => {});

    function flush() {
      if (editTimer) { clearTimeout(editTimer); editTimer = null; }
      if (!initialDone || !msgId) return;
      if (pending === null || pending === lastSent) return;
      const text = pending;
      pending = null;
      sendChain = sendChain.then(async () => {
        try {
          await fetch(`${TG_BASE}${botToken}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: lastSeenChat, message_id: msgId,
              text: text.slice(0, 4000),
              disable_web_page_preview: true,
              parse_mode: 'HTML',
            }),
          });
          lastSent = text;
          lastEditAt = Date.now();
        } catch {}
      }).catch(() => {});
    }

    function maybeEdit() {
      const since = Date.now() - lastEditAt;
      const interval = 1500;
      if (since >= interval) flush();
      else if (!editTimer) {
        editTimer = setTimeout(() => { editTimer = null; flush(); }, interval - since);
      }
    }

    return {
      update(text) { pending = text; maybeEdit(); },
      async finish(text) {
        pending = text;
        if (editTimer) { clearTimeout(editTimer); editTimer = null; }
        flush();
        // Wait for the chain so callers can sequence cleanly.
        try { await sendChain; } catch {}
      },
    };
  }

  return {
    // Send a line to Telegram. Drops silently if no chat is known yet (the
    // user hasn't messaged the bot in this lifetime). The bridge does NOT
    // buffer — old shell-side traffic shouldn't dump into the chat once a
    // human shows up. They can /last N if they want to catch up.
    send(text) {
      if (!lastSeenChat) return;
      sendChain = sendChain
        .then(() => sendMessage(lastSeenChat, text))
        .catch(e => err(`send failed: ${e.message}`));
    },
    startStreamMessage,
    stop() { stopped = true; stopController.abort(); },
    get chatId() { return lastSeenChat; },
  };
}

function chunkText(text, max) {
  if (text.length <= max) return [text];
  const out = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + max, text.length);
    // Try to break on a newline if possible to keep chunks readable
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end);
      if (nl > i + max / 2) end = nl;
    }
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}
