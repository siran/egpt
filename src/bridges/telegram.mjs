// telegram.mjs — the Telegram limb: one bot on the Bot API, over HTTPS with plain fetch.
// Long polling (getUpdates): the node dials out, no inbound port, no webhook.
// It is the "real" bridge behind the port adapter (beeper-port.mjs createBeeperBridgePort with
// `start` injected), so it keeps startBeeperBridge's contract and the wrap/stream/status logic
// stays in one place. Media is downloaded (getFile) and goes through the same intake as Beeper's
// (limb-intake.mjs: voice note, 👂, readback; the host's onMedia saves it).
// Inside the spine a chat id is `tg:<chat id>`; the prefix is dropped only at the API call.
// No invisible characters go out (visibleOnly; Telegram reads hidden text as spam, 2026-10-24): the
// port's wrap adds no structural frame, and send/edit/caption strip what is left. So the bot's own
// message is known by its sender, and the being who wrote it by its visible stamp (stampedBeing).
// A being's Markdown goes out as Telegram HTML (md-to-tg-html.mjs); text Telegram cannot parse goes
// once more as plain text.
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { secretPath, readSecret } from '../secrets.mjs';
import { mentionStatus } from '../auto-mode.mjs';
import { stripNodeSignature } from '../node-signature.mjs';
import { stripInvisible } from '../invisible.mjs';
import { mdToTgHtml } from '../md-to-tg-html.mjs';
import { reactionAction, editAction, isLiveStreamFrame } from '../dispatch-line.mjs';
import { mediaKind, MIME_BY_EXT } from '../media-kind.mjs';
import { shouldDownload } from '../media-save.mjs';
import { POSTS_BACK_DELAY_MS } from '../incoming-media.mjs';
import { transcribeAudioFile } from '../tools/transcribe.mjs';
import { makeWrapPersona, stampedBeing } from './persona-wrap.mjs';
import { makeSerialByKey } from '../serial-by-key.mjs';
import { startVoiceNote, readBack, savedEntry, withMediaLines, VOICE_NOTE_PLACEHOLDER } from './limb-intake.mjs';

export const TG_PREFIX = 'tg:';
export const isTelegramChatId = (id) => String(id ?? '').startsWith(TG_PREFIX);
const apiChatId = (id) => (isTelegramChatId(id) ? String(id).slice(TG_PREFIX.length) : null);

// The bot token lives in a file, never in config.yaml: $EGPT_HOME/secrets/telegram-<connection>.token
export const telegramTokenPath = (home, connection) => secretPath(home, `telegram-${connection}.token`);
export const secretTag = (s) => `${s.length} chars, sha256 ${createHash('sha256').update(s).digest('hex').slice(0, 12)}`;

// { token, path, warn } or { token: null, path, problem }.
export const readTelegramToken = (home, connection, opts) => readSecret(home, `telegram-${connection}.token`, opts);

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
const DOWNLOAD_MAX = 20 * 1024 * 1024;                // the Bot API serves files up to 20 MB
const CAPTION_MAX = 1000;                             // under the 1024 limit
const MEDIA_SEND = {
  image: { method: 'sendPhoto', field: 'photo' }, video: { method: 'sendVideo', field: 'video' },
  voice: { method: 'sendVoice', field: 'voice' }, audio: { method: 'sendAudio', field: 'audio' },
  document: { method: 'sendDocument', field: 'document' },
};

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

// The one attachment a Telegram message carries: { file, kind, mime, fileName, voice, isVoiceNote, duration }.
// A voice note and an audio file are both transcribed, as on Beeper (VOICE / AUDIO).
export function pickMedia(m) {
  const of = (file, mime, extra = {}) => ({ file, mime, kind: mediaKind(mime, String(file?.file_name ?? '').split('.').pop()), fileName: file?.file_name ?? null, ...extra });
  if (Array.isArray(m.photo) && m.photo.length) return of(m.photo.at(-1), 'image/jpeg');
  if (m.voice) return of(m.voice, m.voice.mime_type || 'audio/ogg', { voice: true, isVoiceNote: true, duration: m.voice.duration });
  if (m.audio) return of(m.audio, m.audio.mime_type || 'audio/mpeg', { voice: true, duration: m.audio.duration });
  if (m.video_note) return of(m.video_note, 'video/mp4');
  if (m.video) return of(m.video, m.video.mime_type || 'video/mp4');
  if (m.animation) return of(m.animation, m.animation.mime_type || 'video/mp4');
  if (m.document) return of(m.document, m.document.mime_type || '');
  if (m.sticker) return of(m.sticker, m.sticker.is_video ? 'video/webm' : m.sticker.is_animated ? 'application/x-tgsticker' : 'image/webp');
  return null;
}

export function startTelegramBridge({
  telegramToken,
  connection = 'main',
  isAllowedUser = () => false,
  wakeWords,
  addressWithoutAt = true,
  nodeName = '',
  personaStamps = () => [],  // [{ being, bodyEmoji, label }]: reads a being off its stamp (stampedBeing)
  resumedAt = () => null,
  onIncoming,
  onMessageEdit = null,      // the raw edit hook (the mesh mirror), as on Beeper
  // The node-level media + voice options boot hands every limb (sharedBridgeOpts), as Beeper takes them.
  onMedia = null,
  media = {},
  transcribe = transcribeAudioFile,
  transcribeCfg = null,
  resolveTranscriptionService = async () => ({ enabled: true, postsBack: false }),
  postsBackDelayMs = POSTS_BACK_DELAY_MS,
  bridgeSignatureOpen = '',
  bridgeSignatureClose = '',
  transcriptionOpen = '',
  transcriptionClose = '',
  voiceWakeWords = [],
  replyWakeWords = null,
  synthesize = null,
  voice = null,
  echoPlan = () => ({ rank: 1, winner: true }),
  echoTimeoutMs = 20_000,
  echoMaxAgeMs = 3_600_000,
  echoGate = (fn) => fn(),
  readTranscript = async () => null,
  outboundFor = null,
  scheduler = undefined,
  mediaDir = join(tmpdir(), 'egpt-telegram'),
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
  const refused = new Set(), refusedLogged = new Set();   // reactions Telegram would not take
  let stopped = false, alive = false, me = null, offset = 0, privacyNoted = false;
  const replyWake = (Array.isArray(replyWakeWords) && replyWakeWords.length) ? replyWakeWords : (wakeWords ?? []);
  const audioCfg = transcribeCfg ?? media.audio_transcribe ?? {};
  const wrapEcho = makeWrapPersona({ bridgeSignatureOpen, bridgeSignatureClose, nodeName, visibleOnly: true });
  const echoTag = { agentSigOpen: transcriptionOpen, agentSigClose: transcriptionClose };
  const transcribing = makeSerialByKey();

  const wait = (ms) => new Promise((resolve) => {
    if (stopped) { resolve(); return; }
    const t = setTimeoutFn(() => { timers.delete(t); resolve(); }, ms);
    timers.set(t, resolve);
  });

  // A FormData body is a multipart upload (media); anything else goes as JSON.
  async function api(method, body = {}, { signal } = {}) {
    const form = body instanceof FormData;
    let res;
    try {
      res = await fetchFn(`${API_BASE}/bot${token}/${method}`, {
        method: 'POST', ...(form ? {} : { headers: { 'Content-Type': 'application/json' } }), body: form ? body : JSON.stringify(body), signal,
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
  // body(t) builds the request around the text t: first as HTML, then as written if Telegram cannot parse it.
  async function callHtml(method, text, body) {
    const html = body(stripInvisible(mdToTgHtml(text)));
    if (html instanceof FormData) html.set('parse_mode', 'HTML'); else html.parse_mode = 'HTML';
    try { return await call(method, html); }
    catch (e) {
      if (e.status !== 400 || !/can't parse|is empty/i.test(e.message)) throw e;
      log(`${method}: Telegram could not parse the HTML (${e.message}) — sent once more as plain text`);
      return call(method, body(text));
    }
  }

  const noteSent = (chatId, id) => {
    sent.add(`${chatId}#${id}`);
    if (sent.size > SENT_MAX) sent.delete(sent.values().next().value);
  };
  const wasSentByUs = (chatId, msgId) => msgId != null && sent.has(`${chatId}#${msgId}`);
  // A message of ours is this node's; its being is the one whose stamp it carries.
  const authorOf = (ours, text) => (ours ? { replyToNode: String(nodeName).trim() || null, replyToBeing: stampedBeing(text, personaStamps()) } : { replyToNode: null, replyToBeing: null });
  // The text of every message seen or sent: a reaction names its target's text, an edit its old text.
  const seenText = new Map();
  const remember = (chatId, id, text) => {
    if (id == null) return;
    seenText.set(`${chatId}#${id}`, String(text ?? ''));
    if (seenText.size > SENT_MAX) seenText.delete(seenText.keys().next().value);
  };
  const chatOf = (chat) => {
    const chatId = TG_PREFIX + chat.id;
    const title = chat.title ?? ([chat.first_name, chat.last_name].filter(Boolean).join(' ') || (chat.username ? `@${chat.username}` : chatId));
    titles.set(chatId, title);
    return { chatId, title, chatType: chat.type === 'group' || chat.type === 'supergroup' ? 'group' : 'private' };
  };
  const nameOf = (u, fallback) => [u?.first_name, u?.last_name].filter(Boolean).join(' ') || (u?.username ? `@${u.username}` : fallback);
  const stale = (dateS) => (Number(dateS) || 0) * 1000 < Math.max(startedAt, resumedAt?.() ?? 0) - WAKE_WINDOW_MS;
  const hand = (body, from, what) => Promise.resolve().then(() => onIncoming?.(body, from)).catch((e) => log(`${what} onIncoming threw — ${e?.message ?? e}`));

  // A HUMAN REACTION is input, as on Beeper (dispatch-line reactionAction; the chat's mode decides).
  // Telegram never reports the bot's own reactions, and in groups reports them only to an admin bot.
  function reacted(r) {
    if (!r?.chat || r.chat.type === 'channel') return;
    const { chatId, title, chatType } = chatOf(r.chat);
    const before = new Set((r.old_reaction ?? []).filter((x) => x.type === 'emoji').map((x) => x.emoji));
    const fresh = (r.new_reaction ?? []).filter((x) => x.type === 'emoji' && !before.has(x.emoji)).map((x) => x.emoji);
    if (!fresh.length) return;
    const msgKey = String(r.message_id);
    const userId = String(r.user?.id ?? r.actor_chat?.id ?? '');
    const name = nameOf(r.user, r.actor_chat?.title ?? userId);
    if (stale(r.date)) { log(`reaction by ${name} → #${msgKey} [${title}] is from before the wake window — not replayed`); return; }
    const target = seenText.get(`${chatId}#${msgKey}`) ?? '';
    const ours = wasSentByUs(chatId, msgKey);
    const { replyToNode, replyToBeing } = authorOf(ours, target);
    for (const emoji of fresh) {
      log(`reaction ${emoji} by ${name} → #${msgKey} [${title}]`);
      hand(reactionAction({ emoji, targetId: msgKey, snippet: stripNodeSignature(target) }), {
        chatId, chatName: title, chatType, network: 'telegram',
        userId, username: r.user?.username, firstName: name, senderName: name,
        isSender: false, authorized: !!userId && !!isAllowedUser(userId, 'telegram'),
        atEStart: false, atEAnywhere: false, replyToBot: ours, replyToBeing, replyToNode,
        isReaction: true, isTranscriptFromVoice: false,
        msgKey,
      }, 'reaction');
    }
  }

  // AN EDIT is an append-only stage direction, as on Beeper (dispatch-line editAction). A message
  // never seen before (sent before this start) has no old text: recorded, not surfaced.
  async function edited(m) {
    if (!m?.chat || m.chat.type === 'channel') return;
    const { chatId, title, chatType } = chatOf(m.chat);
    const msgKey = String(m.message_id);
    const cur = String(m.text ?? m.caption ?? '');
    const prev = seenText.get(`${chatId}#${msgKey}`);
    remember(chatId, msgKey, cur);
    if (prev == null || !cur || prev === cur) return;
    if (stale(m.edit_date ?? m.date)) return;
    if (onMessageEdit) {
      try { if (await onMessageEdit(chatId, msgKey, cur, prev)) return; }
      catch (e) { log(`onMessageEdit threw — ${e?.message ?? e}`); }
    }
    const body = editAction({ targetId: msgKey, oldText: prev, newText: cur });
    if (isLiveStreamFrame(body)) return;
    const userId = String(m.from?.id ?? '');
    const editor = nameOf(m.from, userId) || 'someone';
    log(`edit #${msgKey} by ${editor} [${title}]: ${JSON.stringify(prev.slice(0, 40))} → ${JSON.stringify(cur.slice(0, 40))}`);
    hand(body, {
      chatId, chatName: title, chatType, network: 'telegram',
      userId, username: editor, firstName: editor, senderName: editor,
      isSender: false, authorized: !!userId && !!isAllowedUser(userId, 'telegram'),
      atEStart: false, atEAnywhere: false, replyToBot: false,
      isReaction: false, isStageDirection: true, isTranscriptFromVoice: false,
      msgKey,
    }, 'edit');
  }

  // getFile, then the file URL (it carries the token: never logged). { path } or null, said why.
  async function download(md, title) {
    const size = Number(md.file?.file_size) || 0;
    if (size > DOWNLOAD_MAX) { log(`[${title}] ${md.kind} of ${Math.round(size / 1048576)} MB not downloaded — over the Bot API's 20 MB`); return null; }
    try {
      const f = await call('getFile', { file_id: md.file.file_id });
      if (!f?.file_path) throw new Error('getFile returned no file_path');
      const res = await fetchFn(`${API_BASE}/file/bot${token}/${f.file_path}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await mkdir(mediaDir, { recursive: true });
      const dest = join(mediaDir, `${now()}-${String(md.file.file_unique_id ?? md.file.file_id).replace(/[^\w-]/g, '')}-${basename(md.fileName || f.file_path).replace(/[^\w.-]+/g, '_')}`);
      await writeFile(dest, Buffer.from(await res.arrayBuffer()));
      return dest;
    } catch (e) { log(`[${title}] ${md.kind} download failed — ${scrub(e?.message ?? e)}`); return null; }
  }

  // --- inbound ---
  // As beeper.mjs dispatchMessage: a plain text goes straight through; media is downloaded, a voice
  // note is the shared intake's (two lines), the rest saved through onMedia and announced.
  async function handle(update) {
    const m = update?.message;
    if (!m) return;
    const chat = m.chat ?? {};
    if (chat.type === 'channel') return;
    const chatId = TG_PREFIX + chat.id;
    const group = chat.type === 'group' || chat.type === 'supergroup';
    const title = chat.title ?? ([chat.first_name, chat.last_name].filter(Boolean).join(' ') || (chat.username ? `@${chat.username}` : chatId));
    titles.set(chatId, title);
    const md = pickMedia(m);
    let text = String(m.text ?? m.caption ?? '');
    remember(chatId, m.message_id, text);
    if (!text.trim() && !md) return;
    if (group && me && me.can_read_all_group_messages === false && !privacyNoted) {
      privacyNoted = true;
      log(`first group message (${title}): @${me.username} has privacy mode ON, so in groups it receives only /commands, replies to it and @${me.username} mentions`);
    }
    // A group command addressed to this bot (/status@bot) is the command itself.
    if (me?.username) text = text.replace(new RegExp(`^(/\\S+?)@${escapeRe(me.username)}\\b`, 'i'), '$1');
    const userId = String(m.from?.id ?? '');
    const senderName = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ') || (m.from?.username ? `@${m.from.username}` : userId);
    const tsMs = (Number(m.date) || 0) * 1000 || now();
    const msgKey = m.message_id != null ? String(m.message_id) : null;
    const authorized = !!userId && !!isAllowedUser(userId, 'telegram');
    const quoted = m.reply_to_message ?? null;
    const replyToId = quoted?.message_id != null ? String(quoted.message_id) : null;
    const quotedText = String(quoted?.text ?? quoted?.caption ?? '');
    const replyToBot = !!quoted && ((me?.id != null && quoted.from?.id === me.id) || wasSentByUs(chatId, replyToId));
    const { replyToNode, replyToBeing } = authorOf(replyToBot, quotedText);
    const backlog = tsMs < Math.max(startedAt, resumedAt?.() ?? 0) - WAKE_WINDOW_MS;
    const chatType = group ? 'group' : 'private';

    // MEDIA: a voice/audio note is always fetched (it is transcribed); the rest per whatsapp.media.download.
    const policy = media.download ?? 'all';
    const caption = text.trim() ? text : null;
    let path = null, isVoice = false, pending = null, listening = false;
    if (md && (md.voice || shouldDownload(policy, md.kind))) path = await download(md, title);
    const meta = md && shouldDownload(policy, md.kind) && typeof onMedia === 'function'
      ? { chatID: chatId, chatName: title, chatType, network: 'telegram', msgId: msgKey, senderName, isSender: false, ts: tsMs, kind: md.kind, mime: md.mime, fileName: md.fileName, isVoiceNote: !!md.isVoiceNote }
      : null;
    if (md?.voice) {
      isVoice = true;
      if (path) {
        const svc = await resolveTranscriptionService(chatId);
        ({ text, pending, listening } = await startVoiceNote({
          path, chatId, title, msgId: msgKey, tsMs, durationSec: md.duration, author: senderName,
          operatorSent: () => authorized,
          svc, echoPlan, echoMaxAgeMs, echoTimeoutMs, postsBackDelayMs, audioCfg, transcribe, outboundFor, scheduler,
          reply: (t) => echoGate(() => send(wrapEcho(echoTag, t), { chatId, replyToMessageID: msgKey })),
          serial: transcribing,
          onLog: log,
        }));
      } else text = VOICE_NOTE_PLACEHOLDER;
      if (caption) text = `${text}\n${caption}`;
    }
    // Saved through the host's onMedia and announced (the voice note's own line already says it).
    const withMedia = async (body, voiceCaption) => {
      if (!meta || !path) return body;
      let saved = [];
      try { saved = [savedEntry(await onMedia({ ...meta, localPath: path, caption: isVoice ? voiceCaption : caption }), { kind: md.kind, localPath: path, fileName: md.fileName, isVoiceNote: !!md.isVoiceNote, inText: isVoice })]; }
      catch (e) { log(`onMedia threw — ${e?.message ?? e}`); }
      return withMediaLines(body, saved);
    };
    const done = () => { if (path) unlink(path).catch(() => {}); };
    if (!pending && md) { text = await withMedia(text, null); done(); }
    if (!text) return;

    const st = mentionStatus(text, wakeWords, { addressWithoutAt, voiceWake: isVoice ? voiceWakeWords : undefined });
    // BARE NAME REPLY (contract 8.4) — the shared readback; Telegram inlines the quoted text.
    if (replyToId) {
      const r = await readBack({
        text, replyToId, ownerSent: () => authorized, replyWake, readTranscript, chatId, title, network: 'telegram', msgId: msgKey,
        quoted: () => quotedText || null,
        send: (c, t, o) => send(t, { chatId: c, ...o }), sendMedia, deleteMessage, synthesize, voice,
        onLog: log,
      });
      if (r.done) return;
      text = r.text;
    }
    const from = {
      chatId, chatName: title, chatType, network: 'telegram',
      userId, username: m.from?.username, firstName: m.from?.first_name, senderName,
      isSender: false,
      authorized,
      atEStart: st.atEStart, atEAnywhere: st.atEAnywhere,
      backlog, replyToBot, replyToId, replyToBeing, replyToNode,
      isReaction: false,
      isTranscriptFromVoice: isVoice && !pending,
      // what a restart resumes a pending note from (spine/background.mjs)
      ...(pending ? { voiceLine: 'arrival', voicePath: path, voiceMedia: meta ? { ...meta, localPath: path } : null, voiceListening: listening } : {}),
      msgKey,
      msgTs: tsMs,
    };
    log(`incoming [${title}] ${senderName}: ${JSON.stringify(text.slice(0, 60))} (atE=${st.atEAnywhere}${replyToBot ? ' replyToBot' : ''}${replyToId ? ` ↩${replyToId}` : ''}${backlog ? ' backlog' : ''}${isVoice ? ' voice' : ''})`);
    // Not awaited: the spine owns per-chat ordering (enqueue), as with Beeper.
    const deliver = (body, f) => {
      try { Promise.resolve(onIncoming?.(body, f)).catch((e) => log(`onIncoming threw — ${e?.message ?? e}`)); }
      catch (e) { log(`onIncoming threw — ${e?.message ?? e}`); }
    };
    deliver(text, from);
    if (!pending) return;
    // …and the voice note's second line: its transcription (or why there is none).
    try {
      const { body, caption: heardCaption } = await pending;
      const heard = await withMedia(body, heardCaption);
      const vst = mentionStatus(heard, wakeWords, { addressWithoutAt, voiceWake: voiceWakeWords });
      log(`incoming [${title}] ${senderName}: ${JSON.stringify(heard.slice(0, 60))} (atE=${vst.atEAnywhere} voice ↩#${msgKey ?? '?'})`);
      deliver(heard, { ...from, isTranscriptFromVoice: true, voiceLine: 'outcome', atEStart: vst.atEStart, atEAnywhere: vst.atEAnywhere });
    } finally { done(); }
  }

  async function poll() {
    let retryMs = RETRY_MIN_MS, conflictMs = CONFLICT_MIN_MS;
    while (!stopped) {
      try {
        const signal = AbortSignal.any([ac.signal, AbortSignal.timeout(POLL_ABORT_MS)]);
        const updates = await api('getUpdates', { offset, timeout: POLL_TIMEOUT_S, allowed_updates: ['message', 'edited_message', 'message_reaction'] }, { signal });
        if (!alive) log('polling');
        alive = true; retryMs = RETRY_MIN_MS; conflictMs = CONFLICT_MIN_MS;
        for (const u of updates ?? []) {
          offset = Math.max(offset, Number(u.update_id) + 1);
          const done = u.message ? handle(u) : u.edited_message ? edited(u.edited_message) : Promise.resolve(reacted(u.message_reaction));
          done.catch((e) => log(`an update could not be handled — ${e?.message ?? e}`));
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
    text = stripInvisible(text);
    if (!text.trim()) return null;
    let first = null;
    try {
      for (const [i, part] of chunks(text).entries()) {
        const reply = i === 0 && replyToMessageID != null ? { reply_parameters: { message_id: Number(replyToMessageID), allow_sending_without_reply: true } } : {};
        const m = await callHtml('sendMessage', part, (t) => ({ chat_id: chat, text: t, ...reply }));
        noteSent(chatId, m.message_id);
        remember(chatId, m.message_id, part);
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
    const head = chunks(stripInvisible(text))[0];
    try { await callHtml('editMessageText', head, (t) => ({ chat_id: chat, message_id: Number(msgId), text: t })); remember(chatId, msgId, head); return true; }
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
  // Bots may only use Telegram's fixed reaction set (and a group's allowed list): a refused emoji
  // is logged once, then skipped in that chat. Never text instead.
  async function setReaction(chatId, msgId, reaction) {
    const chat = apiChatId(chatId);
    if (chat == null || msgId == null) return false;
    const emoji = reaction[0]?.emoji;
    if (emoji && refused.has(`${chatId}|${emoji}`)) return false;
    try { return !!(await call('setMessageReaction', { chat_id: chat, message_id: Number(msgId), reaction })); }
    catch (e) {
      if (emoji && /REACTION_INVALID/i.test(e.message)) {
        refused.add(`${chatId}|${emoji}`);
        if (!refusedLogged.has(emoji)) { refusedLogged.add(emoji); log(`Telegram refuses ${emoji} as a bot reaction (${e.message}) — not placed, skipped from now on`); }
        return false;
      }
      log(`reaction on #${msgId} in ${chatId} failed — ${e.message}`);
      return false;
    }
  }

  // .ogg/.opus is a voice note; Telegram's audio player takes only mp3/m4a, so any other audio is a document.
  function mediaMethod(filePath) {
    const ext = extname(String(filePath)).slice(1).toLowerCase();
    const mime = MIME_BY_EXT[ext] ?? null;
    let kind = mediaKind(mime, ext);
    if (kind === 'audio') kind = ['ogg', 'opus'].includes(ext) ? 'voice' : ['mp3', 'm4a'].includes(ext) ? 'audio' : 'document';
    return { mime, ...MEDIA_SEND[kind] };
  }

  // A caption over Telegram's limit goes out as a text reply to the media instead.
  async function sendMedia(chatId, filePath, { caption = null, replyTo = null } = {}) {
    const chat = apiChatId(chatId);
    if (chat == null || !filePath) { log(`media refused — ${chatId} is not a telegram chat or there is no file`); return false; }
    const { method, field, mime } = mediaMethod(filePath);
    if (caption != null) caption = stripInvisible(caption);
    const long = !!caption && [...caption].length > CAPTION_MAX;
    try {
      const file = new Blob([await readFile(filePath)], mime ? { type: mime } : {});
      const form = (cap) => {
        const f = new FormData();
        f.append('chat_id', chat);
        if (cap) f.append('caption', cap);
        if (replyTo != null) f.append('reply_parameters', JSON.stringify({ message_id: Number(replyTo), allow_sending_without_reply: true }));
        f.append(field, file, basename(String(filePath)));
        return f;
      };
      const m = caption && !long ? await callHtml(method, caption, form) : await call(method, form(null));
      const id = String(m.message_id);
      noteSent(chatId, id);
      failures.delete(chatId);
      log(`media sent to ${chatId}: ${basename(String(filePath))} (${method})`);
      if (long) await send(caption, { chatId, replyToMessageID: id });
      return { ok: true, chatId, messageId: id, confirmedId: id };
    } catch (e) {
      failures.set(chatId, e.message);
      log(`media to ${chatId} failed (${method}) — ${scrub(e.message)}`);
      return false;
    }
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
    visibleOnly: true,   // read by the port (beeper-port.mjs): its wrap adds no invisible frame here
    send,
    async sendAndGetId(text, { chatId } = {}) { return (await send(text, { chatId }))?.messageId ?? null; },
    editMessage,
    deleteMessage,
    // Telegram's set spells emoji without the U+FE0F presentation selector (❤, not ❤️).
    sendReaction: (chatId, msgId, emoji) => setReaction(chatId, msgId, [{ type: 'emoji', emoji: String(emoji ?? '').replace(/\uFE0F/g, '') }]),
    removeReaction: (chatId, msgId) => setReaction(chatId, msgId, []),
    sendMedia,
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
