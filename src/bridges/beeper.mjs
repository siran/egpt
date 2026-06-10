// beeper.mjs — the WhatsApp/multi-network LIMB over the Beeper Desktop API.
//
// Why Beeper over CDP DOM-control: Beeper exposes a real LOCAL API (REST +
// WebSocket at http://127.0.0.1:23373) for every bridged network. That means
// event-driven receive (no DOM watcher / blank-tab / virtualization), real
// downloadable media (voice notes are local .ogg files → transcription is just
// read-the-file), and quoted replies. CDP stays as the fallback transport.
//
// TRADEOFF (known, operator-accepted): Beeper's WhatsApp bridge is whatsmeow —
// a reverse-engineered client, same ban-risk CLASS as baileys (CDP drove the
// genuine WA Web client, which has no protocol tell). We accept that for the
// robustness + multi-network reach.
//
// Limb contract (drop-in like whatsapp-cdp): { send, startStreamMessage,
// isAlive, stop, chatId }. No Beeper/Matrix anatomy leaks past this file —
// `from.chatId` is the opaque Beeper room id, used only to send back.
import WebSocket from 'ws';
import { transcribeAudioFile } from '../tools/transcribe.mjs';
import { mentionStatus } from '../auto-mode.mjs';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';

const _BEEPER_LOG = join(homedir(), '.egpt', 'logs', 'beeper.log');

export async function startBeeperBridge(opts = {}) {
  const {
    onIncoming,
    onLog: _onLog = () => {},
    media = {},
    beeperToken,
    baseUrl = 'http://127.0.0.1:23373',
    wsUrl = 'ws://127.0.0.1:23373/v1/ws',
  } = opts;
  const token = beeperToken || process.env.BEEPER_ACCESS_TOKEN;
  const audioCfg = media.audio_transcribe || {};
  const onLog = (m) => {
    try { appendFileSync(_BEEPER_LOG, `${new Date().toISOString()} ${m}\n`); } catch { /* ignore */ }
    try { _onLog(m); } catch { /* ignore */ }
  };
  if (!token) { onLog('startBeeperBridge: NO TOKEN (set whatsapp.beeper_token / beeper_token / BEEPER_ACCESS_TOKEN) — bridge inert'); }
  onLog(`startBeeperBridge: ENTRY (${baseUrl})`);

  // --- REST ---
  async function api(method, path, body) {
    const res = await fetch(baseUrl + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${(await res.text()).slice(0, 200)}`);
    const t = await res.text();
    return t ? JSON.parse(t) : null;
  }

  // chatID -> { title, type, isMuted } (cached; refreshed lazily)
  const _chatCache = new Map();
  async function chatInfo(chatID) {
    if (_chatCache.has(chatID)) return _chatCache.get(chatID);
    let info = { title: chatID, type: 'single', isMuted: false };
    try { const c = await api('GET', `/v1/chats/${encodeURIComponent(chatID)}`); info = { title: c.title || chatID, type: c.type || 'single', isMuted: !!c.isMuted }; }
    catch (e) { onLog(`beeper: chatInfo(${chatID}) failed — ${e?.message ?? e}`); }
    _chatCache.set(chatID, info);
    return info;
  }

  // Echo suppression: ids egpt itself sent (so our own replies / 👂 acks don't
  // re-trigger), plus a short-lived chatID|text fallback (the upserted id may
  // differ from the POST's pendingMessageID). Operator's OWN messages are NOT
  // suppressed — so the operator can @e themselves.
  const _sentIds = new Set();
  const _sentText = new Map();   // `${chatID}|${text}` -> expiry ms
  const _processedIds = new Set();   // incoming ids already dispatched (message.upserted re-fires on receipts/edits)
  function rememberSent(id, chatID, text) {
    if (id) { _sentIds.add(id); if (_sentIds.size > 500) _sentIds.delete(_sentIds.values().next().value); }
    if (text) _sentText.set(`${chatID}|${text}`, Date.now() + 60000);
  }
  function isEcho(id, chatID, text) {
    if (id && _sentIds.has(id)) return true;
    const exp = _sentText.get(`${chatID}|${text}`);   // don't delete — receipts re-fire the same upsert; let it expire
    return !!(exp && exp > Date.now());
  }

  function fileUrlToPath(u) { try { return fileURLToPath(u); } catch { return u.replace(/^file:\/\/\/?/, ''); } }

  // mxc:// / localmxc:// / file:// attachment → a local file path for whisper.
  // Incoming media arrives as mxc://; POST /v1/assets/download caches it and
  // returns a file:// srcURL (verified 2026-06-10).
  async function attachmentToLocalPath(att) {
    const src = att?.srcURL || '';
    if (src.startsWith('file://')) return fileUrlToPath(src);
    if (src.startsWith('mxc://') || src.startsWith('localmxc://')) {
      try {
        const r = await api('POST', '/v1/assets/download', { url: src });
        if (r?.srcURL?.startsWith('file://')) return fileUrlToPath(r.srcURL);
        if (r?.srcURL) return r.srcURL;
      } catch (e) { onLog(`beeper: assets/download failed (${att.id}) — ${e?.message ?? e}`); }
      return null;
    }
    return src || null;
  }

  // --- send (efferent) ---
  async function sendMessage(chatID, text, { replyToMessageID } = {}) {
    if (!chatID || !text) { onLog(`beeper: send DROPPED — chatID=${chatID} textLen=${(text || '').length}`); return null; }
    rememberSent(null, chatID, String(text));   // pre-record text BEFORE the POST: the WS echo can arrive before the HTTP response
    try {
      const body = { text: String(text) };
      if (replyToMessageID) body.replyToMessageID = String(replyToMessageID);
      const r = await api('POST', `/v1/chats/${encodeURIComponent(chatID)}/messages`, body);
      rememberSent(r?.pendingMessageID || r?.messageID || r?.id, chatID, String(text));
      return { ok: true, chatId: chatID, pendingMessageID: r?.pendingMessageID };
    } catch (e) { onLog(`beeper: send failed [${chatID}] — ${e?.message ?? e}`); return null; }
  }

  // --- dispatch one incoming message ---
  async function dispatchMessage(msg) {
    const chatID = msg.chatID;
    let text = msg.text || null, isVoice = false;
    if (isEcho(msg.id, chatID, text)) return;
    // Dedup: message.upserted re-fires for the same id (delivery/seen/reaction
    // updates). Process each message once.
    if (msg.id) { if (_processedIds.has(msg.id)) return; _processedIds.add(msg.id); if (_processedIds.size > 3000) _processedIds.delete(_processedIds.values().next().value); }

    if ((msg.type === 'VOICE' || msg.type === 'AUDIO') && Array.isArray(msg.attachments) && msg.attachments.length) {
      isVoice = true;
      const att = msg.attachments.find(a => a.isVoiceNote || a.type === 'audio') || msg.attachments[0];
      const path = await attachmentToLocalPath(att);
      if (path) {
        const transcript = await transcribeAudioFile(path, audioCfg, onLog);
        if (transcript) {
          text = transcript;
          onLog(`beeper: voice transcribed [${chatID}] → ${JSON.stringify(transcript.slice(0, 80))}`);
          const info = await chatInfo(chatID);
          if (!info.isMuted) await sendMessage(chatID, `👂 ${transcript}`, { replyToMessageID: msg.id });   // quoted reply; skip muted chats
        } else { text = '[voice note — transcription failed]'; }
      } else { text = '[voice note]'; }
    }
    if (text == null) return;   // non-text, non-voice (image/sticker/etc.) — nothing to route in v1

    const info = await chatInfo(chatID);
    const st = mentionStatus(text || '');
    const from = {
      chatId: chatID,                       // opaque Beeper room id (for send-back)
      chatName: info.title,
      chatType: info.type === 'group' ? 'group' : 'private',
      userId: msg.senderID || chatID,
      username: msg.senderName || undefined,
      firstName: msg.senderName || undefined,
      senderName: msg.senderName || null,
      authorized: true,                     // host gate is the real control
      atEStart: st.atEStart,
      atEAnywhere: st.atEAnywhere,
      replyToBot: false,                    // provable reply-to-persona is a follow-up
      isReaction: false,
      isTranscriptFromVoice: isVoice,
      msgKey: msg.id || null,
    };
    onLog(`beeper: incoming [${info.title}] ${msg.senderName}: ${JSON.stringify((text || '').slice(0, 60))} (atE=${st.atEAnywhere}${isVoice ? ' voice' : ''})`);
    try { await onIncoming?.(text, from); }
    catch (e) { onLog(`beeper: onIncoming threw — ${e?.message ?? e}`); }
  }

  // --- WebSocket afferent (subscribe '*', handle message.upserted) ---
  let ws = null, _stopped = false, _wsReady = false, _reconnectTimer = null;
  let _processing = Promise.resolve();   // serialize dispatch (slow transcribe must not interleave)

  function connect() {
    if (_stopped || !token) return;
    ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${token}` } });
    ws.on('open', () => onLog('beeper: WS open'));
    ws.on('message', (buf) => {
      let ev; try { ev = JSON.parse(buf.toString()); } catch { return; }
      if (ev.type === 'ready') {
        _wsReady = true;
        try { ws.send(JSON.stringify({ type: 'subscriptions.set', requestID: 'egpt', chatIDs: ['*'] })); onLog('beeper: subscribed to all chats'); }
        catch (e) { onLog(`beeper: subscribe failed — ${e?.message ?? e}`); }
        return;
      }
      if (ev.type === 'message.upserted' && Array.isArray(ev.entries)) {
        for (const entry of ev.entries) {
          const msg = entry?.id ? { chatID: ev.chatID, ...entry } : null;
          if (!msg) continue;
          // serialize: chain dispatch so a 20s transcribe doesn't overlap the next
          _processing = _processing.then(() => dispatchMessage(msg)).catch(e => onLog(`beeper: dispatch error — ${e?.message ?? e}`));
        }
      }
      // chat.upserted → refresh cache (title/mute may change)
      if (ev.type === 'chat.upserted' && Array.isArray(ev.entries)) {
        for (const c of ev.entries) if (c?.id) _chatCache.set(c.id, { title: c.title || c.id, type: c.type || 'single', isMuted: !!c.isMuted });
      }
      if (ev.type === 'error') onLog(`beeper: WS error event — ${JSON.stringify(ev).slice(0, 200)}`);
    });
    ws.on('close', () => { _wsReady = false; if (!_stopped) { onLog('beeper: WS closed — reconnecting in 3s'); _reconnectTimer = setTimeout(connect, 3000); } });
    ws.on('error', (e) => onLog(`beeper: WS error — ${e?.message ?? e}`));
  }
  connect();

  return {
    chatId: null,
    async send(text, { chatId, chatName } = {}) {
      return await sendMessage(chatId, text, {});
    },
    // Non-streaming shim for the host's persona-reply path: the gate already
    // approved emit (streamFactory returns null otherwise); send the FINAL text
    // on finish(). Ignore intermediate update() frames (no edit-spam).
    startStreamMessage(initialText, { chatId, chatName, persona } = {}) {
      let latest = initialText, finished = false, delivered = false;
      const deliver = async () => {
        if (delivered) return; delivered = true;
        if (latest && latest.trim()) await sendMessage(chatId, latest, {});
      };
      return {
        update: (t) => { if (!finished && t) latest = t; },
        finish: async (t) => { if (t) latest = t; finished = true; await deliver(); },
        fail: (e) => { finished = true; onLog(`beeper: stream fail — ${e?.message ?? e}`); },
      };
    },
    isAlive: () => _wsReady,
    stop: () => { _stopped = true; if (_reconnectTimer) clearTimeout(_reconnectTimer); try { ws?.close(); } catch {} },
  };
}

// quick CLI smoke test: BEEPER_ACCESS_TOKEN=... node src/bridges/beeper.mjs
if (process.argv[1]?.endsWith('beeper.mjs')) {
  let media = {}, token = process.env.BEEPER_ACCESS_TOKEN;
  try { const cfg = (await import('../tools/config-io.mjs')).readConfigSync(); media = cfg?.whatsapp?.media || {}; token = token || cfg?.beeper_token || cfg?.whatsapp?.beeper_token; } catch { /* ignore */ }
  startBeeperBridge({
    beeperToken: token,
    media,
    onLog: (m) => console.log('[beeper]', m),
    onIncoming: (text, from) => console.log('  INCOMING', JSON.stringify({ chat: from.chatName, sender: from.senderName, atE: from.atEAnywhere, voice: from.isTranscriptFromVoice, text: (text || '').slice(0, 80) })),
  }).then(() => console.log('beeper bridge running (Ctrl-C to stop) — send a WhatsApp message / voice note'));
}
