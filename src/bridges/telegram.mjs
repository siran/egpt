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

import { readFile, writeFile } from 'node:fs/promises';
import { extname, basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { MIME_BY_EXT, mediaKind } from '../media-kind.mjs';
import { transcribeVoiceNote } from '../incoming-media.mjs';

const API = (token) => `https://api.telegram.org/bot${token}`;

const POLL_TIMEOUT = 25;     // seconds — Telegram long-poll window
const RETRY_409   = 15_000;  // ms to wait when another node is polling
const RETRY_ERR   = 5_000;   // ms to wait after network/other errors

export function startTelegramBridge({
  botToken,
  nodeName    = 'node',
  allowedUsers = [],
  chatId       = null,
  // The bot's internal egpt agent handle (e.g. 'wren'). Telegram doesn't
  // know this name — it's not a real @username — but the operator naturally
  // types "@wren …" to reach the bot's own agent. We treat an @<agentHandle>
  // token as an explicit address to the bot in ANY chat type, mark it
  // addressedToBot, and strip it so the host routes by identity (forceTarget)
  // instead of dropping the message under the mirror policy. Null disables.
  agentHandle  = null,
  // Hold-on-reconnect grace window (seconds). Mirrors the WA bridge.
  // After bridge connect, messages whose Telegram-side timestamp
  // (msg.date) is older than (connectedAt - maxBacklogSeconds) are
  // PARKED in _heldMessages instead of being dispatched. The host
  // surfaces them via /tg-pending so the operator decides whether
  // to dispatch each one. Critical for daemon restart: without this,
  // an overnight @e queued in Telegram's server-side buffer would
  // auto-execute the brain on every restart. Default 5 = only
  // genuinely in-flight live messages dispatch automatically; any
  // older buffered queue gets reviewed first. Set to -1 to disable
  // the hold entirely (the legacy behavior).
  maxBacklogSeconds = 5,
  onIncoming,
  onLog,
  onError,
  onYield,    // called once when 409 forces us to release the polling slot
  onChatId,   // called once when the bridge captures its first chat (host can persist)
  // Media plumbing — SAME host callbacks the Beeper limb uses, so a photo /
  // voice note / document arriving at this bot is processed at the bridge
  // level (limb-agnostic), not re-implemented here. The limb only fetches the
  // bytes off Telegram (getFile); the host saves to media/ (onMedia) and the
  // shared processor transcribes voice + posts the 👂 ack. Null = drop media
  // (legacy text-only behavior).
  onMedia,                       // (m) => Promise<savedPath> — host _saveIncomingMedia
  transcribe,                    // host-injected voice transcriber (remote-first); falls back to local
  audioCfg = {},                 // whatsapp.media.audio_transcribe
  // Host verdict for this chat's transcription service (per-entity ROOM service,
  // not E — async (chatId) => { enabled, postsBack }; src/transcription-service.mjs).
  // Default = transcribe but never surface (fail-closed announce).
  resolveTranscriptionService = async () => ({ enabled: true, postsBack: false }),
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
  let botUsername = null;  // set by getMe on startup, used to recognize /cmd@us
  let botId       = null;  // set by getMe; used to recognize replies to our own messages
  // Connect timestamp + held-message queue — same shape as the WA
  // bridge so /tg-pending can mirror /wa-pending's listHeld /
  // dispatchHeld / clearHeld API.
  let connectedAt = 0;
  const _heldMessages = [];

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

  // Fetch a Telegram file by file_id to a local temp path. getFile returns a
  // file_path; the bytes live at api.telegram.org/file/bot<token>/<file_path>.
  // The limb's one transport-specific job for media — only the limb can speak
  // its own download protocol; everything after the bytes land is host-side.
  async function downloadTelegramFile(fileId, fileName) {
    const f = await apiFetch('getFile', { file_id: fileId });
    const fp = f?.file_path;
    if (!fp) throw new Error('getFile returned no file_path');
    const res = await fetch(`https://api.telegram.org/file/bot${botToken}/${fp}`);
    if (!res.ok) throw new Error(`file download HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const safe = (fileName || basename(fp) || `tg-${fileId}`).replace(/[^\w.\-]+/g, '_');
    const dest = join(tmpdir(), `egpt-tg-${Date.now()}-${safe}`);
    await writeFile(dest, buf);
    return dest;
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
        // 'message_reaction' delivers per-user reactions on messages the
        // bot can see (its own outbound in DMs, all messages in groups
        // where the bot is admin). Without this in allowed_updates,
        // reactions are silently invisible to the bridge.
        allowed_updates:  ['message', 'message_reaction'],
      });

      if (stopped) return;

      // Stamp the first successful poll as the connect time so the
      // backlog hold has an anchor. Anything baileys delivered with a
      // msg.date predating connectedAt - maxBacklogSeconds gets held
      // for operator review (see handleUpdate below).
      if (connectedAt === 0) connectedAt = Date.now();

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
        try { onYield?.(); } catch (e) { console.error(`!! telegram.mjs:[catch] ${e?.message ?? e}`); }
        return;
      }
      err(`telegram poll error: ${e.message}`);
      pollTimer = setTimeout(poll, RETRY_ERR);
    }
  }

  async function handleUpdate(upd) {
    // Reaction events arrive as `message_reaction` updates, distinct from
    // `message`. Format them as a text envelope the host can route the
    // same way it routes a plain message — analog to the WA bridge's
    // _enrichReactionText, which turns reactions into '[reaction 👍 to
    // "..."]' lines. Without this, reactions are invisible to the host
    // even when allowed_updates includes 'message_reaction'.
    if (upd.message_reaction) {
      const r = upd.message_reaction;
      // new_reaction is the current state of the user's reactions on
      // the message. Empty = reaction removed; non-empty = added/changed.
      const newRs = Array.isArray(r.new_reaction) ? r.new_reaction : [];
      const oldRs = Array.isArray(r.old_reaction) ? r.old_reaction : [];
      const newEmojis = newRs.map(x => x.emoji ?? x.custom_emoji_id ?? '?').join('');
      const oldEmojis = oldRs.map(x => x.emoji ?? x.custom_emoji_id ?? '?').join('');
      const user = r.user?.username ? `@${r.user.username}` : (r.user?.first_name ?? `tg:${r.user?.id ?? '?'}`);
      const action = newEmojis ? `reacted ${newEmojis}` : (oldEmojis ? `removed reaction ${oldEmojis}` : 'changed reaction');
      const authorized = allowedUsers.length > 0 && allowedUsers.includes(r.user?.id ?? 0);
      // Operator (2026-05-21): "in telegram it would need to be
      // prepended with '@e'." Auto-prefix operator's own reactions so
      // the router dispatches them to @e / system-e. Others' reactions
      // stay un-routed (they'd never reach @e anyway without explicit
      // mention in TG; this only wakes the brain on the operator's
      // own engagement).
      const body = `${user} ${action} to msg ${r.message_id}`;
      const text = authorized ? `@e ${body}` : body;
      try {
        await onIncoming?.(text, {
          userId:    r.user?.id ?? 0,
          username:  r.user?.username ?? null,
          firstName: r.user?.first_name ?? 'reactor',
          chatId:    r.chat?.id ?? null,
          chatType:  r.chat?.type ?? 'private',
          authorized,
          tgMessageId: r.message_id ?? null,
          isReaction:  true,
        });
      } catch (e) {
        err(`onIncoming(reaction) threw: ${e.message}`);
      }
      return;
    }

    const msg = upd.message;
    if (!msg) return;
    // Media (photo/voice/audio/video/document) → one normalized descriptor; its
    // caption (if any) stands in for text. A message with neither text nor media
    // is nothing we act on here (reactions are handled above).
    const mediaSpec = pickTelegramMedia(msg);
    const rawText = String(msg.text ?? msg.caption ?? '');
    if (!rawText.trim() && !mediaSpec) return;

    // Backlog filter — same shape + intent as the WA bridge: any
    // message whose Telegram-side send timestamp (msg.date, seconds)
    // is older than (connectedAt - maxBacklogSeconds) gets parked in
    // _heldMessages for /tg-pending review instead of being dispatched
    // straight to onIncoming. Catches the daemon-restart scenario where
    // an @e queued overnight would otherwise auto-execute the brain.
    if (maxBacklogSeconds >= 0 && connectedAt > 0) {
      const msgTsMs = (Number(msg.date) || 0) * 1000;
      if (msgTsMs > 0 && msgTsMs < connectedAt - maxBacklogSeconds * 1000) {
        // Hold text AND media alike — replay re-runs handleUpdate(raw), which
        // re-downloads media from the (still valid) file_ids. Empty bodies were
        // filtered above; a media-only message gets a "[kind]" preview.
        const preview = rawText.trim() || (mediaSpec ? `[${mediaSpec.kind}]` : '');
        _heldMessages.push({
          chatId: msg.chat?.id ?? null,
          author: msg.from?.first_name ?? msg.from?.username ?? null,
          text: preview,
          ts: msgTsMs,
          msgId: msg.message_id ?? null,
          raw: upd,   // kept so dispatchHeld can replay through this same
                      // handleUpdate path for awareness + brain routing.
        });
        log(`held pre-connect message from ${msg.chat?.id ?? '?'}: "${preview.slice(0, 60)}${preview.length > 60 ? '…' : ''}" — /tg-pending to review`);
        return;
      }
    }

    const userId    = msg.from?.id ?? 0;
    const username  = msg.from?.username ?? null;
    const firstName = msg.from?.first_name ?? 'human';
    const msgChat   = msg.chat?.id ?? null;
    const chatType  = msg.chat?.type ?? 'private';   // 'private' | 'group' | 'supergroup' | 'channel'
    if (msgChat) {
      lastChat = msgChat;
      if (!chatIdNotified) {
        chatIdNotified = true;
        try { onChatId?.(msgChat); } catch (e) { console.error(`!! telegram.mjs:[catch] ${e?.message ?? e}`); }
      }
    }

    const authorized = allowedUsers.length > 0 && allowedUsers.includes(userId);
    let text = rawText.trim();

    // Media handling (limb-agnostic): fetch the bytes off Telegram, then hand to
    // the host. The shared processor runs the room transcription service; onMedia
    // saves every attachment to conversations/telegram/<slug>/media/. A voice note
    // becomes the dispatch text; an image/doc appends a saved-path note so Wren's
    // Read tool can open it. enabled gates the work, postsBack gates the 👂 — both
    // from the entity's config (default-on), surface-independent.
    if (mediaSpec && typeof onMedia === 'function') {
      try {
        const localPath = await downloadTelegramFile(mediaSpec.fileId, mediaSpec.fileName);
        const ts = ((Number(msg.date) || 0) * 1000) || Date.now();
        if (mediaSpec.kind === 'audio') {
          const svc = await resolveTranscriptionService(String(msgChat));
          const transcript = await transcribeVoiceNote({
            localPath, transcribe, audioCfg,
            reply: (t) => sendText(msgChat, t, { replyTo: msg.message_id }),
            enabled: svc.enabled,
            postsBack: svc.postsBack,
            muted: false,
            onLog: (m) => log(`media: ${m}`),
          });
          if (transcript) text = text ? `${text}\n${transcript}` : transcript;
          else if (!text) text = svc.enabled ? '[voice note — transcription failed]' : '[voice note]';
        }
        const savedPath = await onMedia({
          surface: 'telegram',
          chatID: String(msgChat),
          chatName: msg.chat?.title ?? firstName,
          chatType,
          msgId: msg.message_id ?? null,
          senderName: firstName,
          isSender: authorized,
          ts,
          kind: mediaSpec.kind,
          mime: mediaSpec.mime,
          fileName: mediaSpec.fileName,
          localPath,
          caption: msg.caption ?? (mediaSpec.kind === 'audio' ? text : null),
          isVoiceNote: mediaSpec.isVoiceNote,
        });
        if (mediaSpec.kind !== 'audio') {
          text = `${text ? text + ' ' : ''}[${mediaSpec.kind} saved: ${savedPath || localPath}]`;
        }
      } catch (e) { err(`media handling failed: ${e.message}`); }
    }
    if (!text.trim()) return;   // media-only with no host onMedia wired — nothing to route

    let addressedToBot = false;   // msg explicitly aimed at us (mention/reply/handle)

    // Does the message name the bot's internal egpt agent (@wren)? This is
    // independent of Telegram's own @username addressing — the operator types
    // the handle they know. In a group it's an additional way to be addressed
    // (alongside @<botUsername> and reply-to-us); in a 1:1 it short-circuits
    // the mirror policy so "@wren …" always reaches the agent.
    const mentionsAgent = !!agentHandle &&
      new RegExp(`@${escapeRe(agentHandle)}\\b`, 'i').test(text);

    // The bot IS its egpt agent (Wren is egpt_reve_bot), so any message that
    // ARRIVES in a group it belongs to is part of Wren's conversation and is
    // forwarded — no @mention required. Telegram's bot privacy mode is the
    // operator's filter for WHICH messages arrive: privacy-off delivers every
    // group message; privacy-on (the BotFather default) delivers only /cmds,
    // @<botUsername> mentions, and replies-to-us — and those are for us too.
    // The only thing still gated here is slash commands: a /cmd must carry
    // @<our-username>, else we'd steal commands meant for other bots (or act
    // on a bare, ambiguous /cmd). (1:1 chats are unaffected — every message is
    // for us by definition.)
    if (chatType !== 'private') {
      const m = text.match(/^\/(\S+?)(?:@(\S+))?(\s[\s\S]*)?$/);
      if (m) {
        const targetBot = m[2];
        if (!targetBot) return;                  // /cmd with no @bot — ambiguous, ignore
        if (botUsername && targetBot.toLowerCase() !== botUsername.toLowerCase()) {
          return;                                // command for some other bot
        }
        // Reconstruct without @us so downstream sees a clean /cmd ...
        text = `/${m[1]}${m[3] ?? ''}`.trim();
      } else {
        // Plain group message — forward it to the agent (the bot is Wren).
        // Strip a leading/inline @<botUsername> so the brain sees clean text.
        if (botUsername) {
          text = text.replace(new RegExp(`@${escapeRe(botUsername)}\\b`, 'ig'), '').replace(/\s{2,}/g, ' ').trim();
        }
        addressedToBot = true;
      }
    }

    // Internal agent handle (@wren) — addresses the bot's own agent by name in
    // ANY chat type. Strip the token and mark addressed so the host routes the
    // remainder to the agent (forceTarget) rather than dropping it under the
    // mirror policy. In a 1:1 this is the one explicit way to reach the agent;
    // in a group every plain message is already addressedToBot (the bot is
    // Wren), so this just cleans the @wren token out of the forwarded text.
    if (mentionsAgent) {
      text = text.replace(new RegExp(`@${escapeRe(agentHandle)}\\b`, 'ig'), '').replace(/\s{2,}/g, ' ').trim();
      addressedToBot = true;
    }

    try {
      // tgMessageId enables proper TG-reply quoting later (the
      // shell's '@m42 …' reply syntax routes here with
      // reply_to_message_id pointing at this msg).
      await onIncoming?.(text, {
        userId, username, firstName, chatId: msgChat, chatType, authorized,
        tgMessageId: msg.message_id ?? null,
        addressedToBot,
        fromBot: !!msg.from?.is_bot,   // loop-guard: a sibling bot's message is a being-turn
        // EXPLICITLY addressed (not just present in a group): an @agent mention
        // or a reply to this bot. Distinct from addressedToBot (which a group's
        // bot-presence sets for every message) — the per-being 'mention' mode
        // gates on this, so 'on' = all group msgs, 'mention' = only when called.
        explicitlyAddressed: mentionsAgent || (botId != null && msg.reply_to_message?.from?.id === botId),
      });
    } catch (e) {
      err(`onIncoming threw: ${e.message}`);
    }
  }

  // ── Send helpers ──────────────────────────────────────────────

  function enqueue(fn) {
    sendChain = sendChain.then(fn).catch(e => err(`send error: ${e.message}`));
    return sendChain;
  }

  async function sendText(chatId, text, { replyTo } = {}) {
    const chunks = chunkText(text, 4096);
    for (let i = 0; i < chunks.length; i++) {
      // reply_to_message_id only goes on the FIRST chunk — Telegram
      // doesn't have a concept of multi-message replies; subsequent
      // chunks land as regular sends right after.
      await apiFetch('sendMessage', {
        chat_id:              chatId,
        text:                 chunks[i],
        parse_mode:           'HTML',
        link_preview_options: { is_disabled: true },
        ...(i === 0 && replyTo ? { reply_to_message_id: replyTo } : {}),
      });
    }
  }

  // Outbound media via multipart upload (Bot API sendPhoto/sendVideo/
  // sendDocument/sendAudio/sendVoice). Mirrors the WA bridge's sendMedia so
  // /inject delivers a real attachment to a TG group. kind+mimetype inferred
  // from the extension when omitted; unknowns → document.
  async function sendMedia(chatId, { path, buffer, kind, caption, fileName, mimetype, ptt } = {}) {
    const target = chatId;   // no lastChat fallback — never guess a recipient
    if (!target) return null;
    let buf = buffer;
    if (!buf && path) { try { buf = await readFile(path); } catch (e) { err(`sendMedia read ${path}: ${e.message}`); return null; } }
    if (!buf) return null;
    const ext = (extname(fileName ?? path ?? '') || '').replace(/^\./, '').toLowerCase();
    const mt = mimetype ?? MIME_BY_EXT[ext] ?? null;
    const k = kind ?? mediaKind(mt, ext);
    const name = fileName ?? (path ? basename(path) : 'file');
    const method = k === 'image' ? 'sendPhoto' : k === 'video' ? 'sendVideo' : k === 'audio' ? (ptt ? 'sendVoice' : 'sendAudio') : 'sendDocument';
    const field  = k === 'image' ? 'photo'     : k === 'video' ? 'video'     : k === 'audio' ? (ptt ? 'voice' : 'audio')       : 'document';
    const form = new FormData();
    form.append('chat_id', String(target));
    if (caption) form.append('caption', caption);
    form.append(field, new Blob([buf], mt ? { type: mt } : {}), name);
    try {
      const res = await fetch(`${API(botToken)}/${method}`, { method: 'POST', body: form });
      const j = await res.json().catch(() => null);
      if (!j?.ok) err(`sendMedia ${method}: ${j?.description ?? res.status}`);
      else log(`sendMedia: ${k} (${(buf.length / 1024).toFixed(0)}KB) → ${target}`);
      return j;
    } catch (e) { err(`sendMedia: ${e.message}`); return null; }
  }

  function startStreamMessage(initialText, { chatId } = {}) {
    const targetChat = chatId;   // no lastChat fallback — streaming must name its chat
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
      // Remove the "⌛ thinking…" placeholder entirely — for a turn that resolved
      // to nothing (a sibling self-selecting silent with '…'). Editing it to '…'
      // would post a real message that fans to the other bots and feeds a
      // bot↔bot loop (operator 2026-06-14). Enqueued so it runs AFTER the initial
      // sendMessage set msgId; tolerant if the placeholder never sent.
      async delete() {
        pending = null;
        if (editTimer) { clearTimeout(editTimer); editTimer = null; }
        enqueue(async () => {
          if (!msgId) return;
          await apiFetch('deleteMessage', { chat_id: targetChat, message_id: msgId });
        });
        try { await sendChain; } catch {}
      },
    };
  }

  // ── Start ─────────────────────────────────────────────────────

  log(`telegram: starting as "${nodeName}"`);
  // Fetch our bot's identity so we can recognize /cmd@us in groups.
  // Best-effort — if it fails, group-chat addressing fails closed
  // (no /cmd is recognized in groups until we know our username).
  apiFetch('getMe', {}).then((me) => {
    botUsername = me?.username ?? null;
    botId       = me?.id ?? null;
    if (botUsername) log(`telegram: identified as @${botUsername} (id ${botId})`);
  }).catch(e => err(`getMe failed: ${e.message}`));
  poll();

  return {
    send(text, { chatId, replyTo } = {}) {
      const target = chatId;   // no lastChat fallback — never guess a recipient
      if (!target) return;
      enqueue(() => sendText(target, text, { replyTo }));
    },
    sendMedia(chatId, opts) { return sendMedia(chatId, opts); },
    startStreamMessage,
    stop() {
      stopped = true;
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    },
    get chatId() { return lastChat; },
    // Held pre-connect message API — mirrors the WA bridge's surface
    // so /tg-pending can be implemented the same way as /wa-pending.
    listHeld() {
      return _heldMessages.map((m, i) => ({
        idx: i, chatId: m.chatId, author: m.author, text: m.text, ts: m.ts, msgId: m.msgId,
      }));
    },
    async dispatchHeld(idx) {
      const entry = _heldMessages[idx];
      if (!entry) return { ok: false, reason: 'no such held message' };
      _heldMessages.splice(idx, 1);
      // Replay through the same handleUpdate pipeline. Set a flag-ish
      // raw so we know not to re-hold it (connectedAt is already past
      // any reasonable msg.date for a buffered message; we strip the
      // backlog guard by passing through a per-call escape — simplest
      // is to temporarily blank connectedAt around the call).
      const savedConnectedAt = connectedAt;
      connectedAt = 0;       // disable hold for the replay
      try { await handleUpdate(entry.raw); }
      catch (e) { return { ok: false, reason: e.message }; }
      finally { connectedAt = savedConnectedAt; }
      return { ok: true };
    },
    clearHeld() {
      const n = _heldMessages.length;
      _heldMessages.length = 0;
      return n;
    },
  };
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Telegram delivers media as distinct message fields (photo[], voice, audio,
// video, document), usually with no msg.text — the caption lives in msg.caption.
// Normalize whichever is present into one descriptor the limb can download +
// hand to the host. Photos arrive as an array of sizes; take the largest.
export function pickTelegramMedia(msg) {
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const p = msg.photo[msg.photo.length - 1];
    return { fileId: p.file_id, kind: 'image', mime: 'image/jpeg', fileName: `photo-${p.file_unique_id ?? p.file_id}.jpg`, isVoiceNote: false };
  }
  if (msg.voice)    return { fileId: msg.voice.file_id, kind: 'audio', mime: msg.voice.mime_type || 'audio/ogg', fileName: `voice-${msg.voice.file_unique_id ?? msg.voice.file_id}.ogg`, isVoiceNote: true };
  if (msg.audio)    return { fileId: msg.audio.file_id, kind: 'audio', mime: msg.audio.mime_type || 'audio/mpeg', fileName: msg.audio.file_name || `audio-${msg.audio.file_unique_id ?? msg.audio.file_id}.mp3`, isVoiceNote: false };
  if (msg.video)    return { fileId: msg.video.file_id, kind: 'video', mime: msg.video.mime_type || 'video/mp4', fileName: msg.video.file_name || `video-${msg.video.file_unique_id ?? msg.video.file_id}.mp4`, isVoiceNote: false };
  if (msg.document) {
    const mime = msg.document.mime_type || '';
    const ext = (msg.document.file_name || '').split('.').pop();
    return { fileId: msg.document.file_id, kind: mediaKind(mime, ext), mime, fileName: msg.document.file_name || `doc-${msg.document.file_unique_id ?? msg.document.file_id}`, isVoiceNote: false };
  }
  return null;
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
