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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
          body: JSON.stringify({ chat_id: targetChat, text: chunk, disable_web_page_preview: true }),
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
    log('telegram bridge: polling started');
    while (!stopped) {
      try {
        // Long-polling: timeout=25 keeps the connection open up to 25s
        // waiting for new updates. Cheap, near-instant delivery.
        const url = `${TG_BASE}${botToken}/getUpdates?offset=${lastUpdateId + 1}&timeout=25`;
        const res = await fetch(url);
        if (!res.ok) {
          err(`getUpdates HTTP ${res.status}`);
          await sleep(5000);
          continue;
        }
        const data = await res.json();
        if (!data.ok) {
          err(`getUpdates error: ${data.description}`);
          await sleep(5000);
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
        err(`poll error: ${e.message}`);
        await sleep(5000);
      }
    }
    log('telegram bridge: polling stopped');
  }

  pollLoop().catch(e => err(`pollLoop crashed: ${e.message}`));

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
    stop() { stopped = true; },
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
