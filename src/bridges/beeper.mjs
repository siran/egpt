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
//
// Hardening pass (2026-06-10, review follow-up):
//   - 👂 transcript acks are gated on isEnrolledChat (host passes the
//     auto_e_chats + self-DM rule), NOT on Beeper's mute flag. Default
//     DENY — "leaks are unacceptable" (operator 2026-06-03). Suppressed
//     acks log the chatID so the operator can enroll it.
//   - Backlog gate: messages older than bridge start (minus holdGraceMs)
//     are marked seen but never dispatched — same hold-on-reconnect
//     semantic as the baileys/TG bridges. Without it, a Beeper replay
//     after restart would re-answer old messages (and egpt's own echoed
//     replies come back isSender=true, i.e. authorized — loop fuel).
//   - Seen-ids persist to state/beeper-seen.jsonl across restarts
//     (in-memory-only dedup + the pendingMessageID≠final-id gap meant a
//     restart forgot everything it ever sent or handled).
//   - Network scope is FAIL-CLOSED: unknown accountID with a scope active
//     drops the message (it used to pass).
//   - WS reconnect backs off 3s→60s (a closed Beeper app was writing a
//     log line every 3s, ~29k/day) and _sentText sweeps expired entries.
import WebSocket from 'ws';
import { transcribeAudioFile } from '../tools/transcribe.mjs';
import { mentionStatus } from '../auto-mode.mjs';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';

const _BEEPER_LOG = join(homedir(), '.egpt', 'logs', 'beeper.log');
const SEEN_PROCESSED_CAP = 3000;
const SEEN_SENT_CAP = 500;
const SEEN_COMPACT_EVERY = 1000;   // appends between jsonl compactions
const RECONNECT_MIN_MS = 3_000;
const RECONNECT_MAX_MS = 60_000;

export async function startBeeperBridge(opts = {}) {
  const {
    onIncoming,
    onLog: _onLog = () => {},
    media = {},
    beeperToken,
    baseUrl = 'http://127.0.0.1:23373',
    wsUrl = 'ws://127.0.0.1:23373/v1/ws',
    networks = ['whatsapp'],   // v1 SAFE SCOPE: only act on these networks. The WS subscribes to '*' (all chats); anything else is dropped. Set [] / null to process every network.
    // Enrolled-chats gate for the 👂 transcript ack — the SAME rule as every
    // other egpt-initiated send (auto_e_chats + self-DM), supplied by the
    // host. Default DENY: a bridge with no gate wired must never announce
    // egpt's presence in a chat nobody enrolled.
    isEnrolledChat = () => false,
    // Hold-on-reconnect grace (ms): messages older than bridgeStart - grace
    // are backlog — seen, never dispatched. Mirrors the baileys/TG semantic.
    holdGraceMs = 5_000,
    stateDir = join(homedir(), '.egpt', 'state'),
    transcribe = transcribeAudioFile,
  } = opts;
  const token = beeperToken || process.env.BEEPER_ACCESS_TOKEN;
  const audioCfg = media.audio_transcribe || {};
  const onLog = (m) => {
    try { appendFileSync(_BEEPER_LOG, `${new Date().toISOString()} ${m}\n`); } catch { /* ignore */ }
    try { _onLog(m); } catch { /* ignore */ }
  };
  if (!token) { onLog('startBeeperBridge: NO TOKEN (set whatsapp.beeper_token / beeper_token / BEEPER_ACCESS_TOKEN) — bridge inert'); }
  onLog(`startBeeperBridge: ENTRY (${baseUrl})`);
  const bridgeStartMs = Date.now();

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

  // chatID -> { title, type, isMuted, accountID } (cached; refreshed lazily)
  const _chatCache = new Map();
  async function chatInfo(chatID) {
    if (_chatCache.has(chatID)) return _chatCache.get(chatID);
    let info = { title: chatID, type: 'single', isMuted: false, accountID: null };
    try { const c = await api('GET', `/v1/chats/${encodeURIComponent(chatID)}`); info = { title: c.title || chatID, type: c.type || 'single', isMuted: !!c.isMuted, accountID: c.accountID || null }; }
    catch (e) { onLog(`beeper: chatInfo(${chatID}) failed — ${e?.message ?? e}`); }
    _chatCache.set(chatID, info);
    return info;
  }

  // --- seen-id persistence (state/beeper-seen.jsonl) ---
  // Both dedup sets reload across restarts. Without this, every restart
  // forgot what was already handled/sent — and the upserted id can differ
  // from the POST's pendingMessageID, so text-window suppression alone
  // (60s) can't cover a replay.
  const _sentIds = new Set();
  const _processedIds = new Set();   // incoming ids already handled (message.upserted re-fires on receipts/edits)
  const _seenPath = join(stateDir, 'beeper-seen.jsonl');
  let _seenAppends = 0;
  {
    let lines = [];
    try { lines = readFileSync(_seenPath, 'utf8').split('\n').filter(Boolean); } catch { /* fresh */ }
    for (const l of lines.slice(-(SEEN_PROCESSED_CAP + SEEN_SENT_CAP))) {
      try {
        const o = JSON.parse(l);
        if (o.k === 'p') _processedIds.add(o.id);
        else if (o.k === 's') _sentIds.add(o.id);
      } catch { /* skip torn line */ }
    }
    if (lines.length) onLog(`beeper: seen-state loaded (${_processedIds.size} processed, ${_sentIds.size} sent)`);
  }
  function _capSet(set, cap) { while (set.size > cap) set.delete(set.values().next().value); }
  function _persistSeen(k, id) {
    if (!id) return;
    try {
      mkdirSync(stateDir, { recursive: true });
      appendFileSync(_seenPath, JSON.stringify({ k, id, ts: Date.now() }) + '\n');
      if (++_seenAppends % SEEN_COMPACT_EVERY === 0) {
        const out = [
          ...[..._processedIds].map(i => JSON.stringify({ k: 'p', id: i })),
          ...[..._sentIds].map(i => JSON.stringify({ k: 's', id: i })),
        ].join('\n') + '\n';
        writeFileSync(_seenPath, out);
      }
    } catch (e) { onLog(`beeper: seen-state persist failed — ${e?.message ?? e}`); }
  }
  function markProcessed(id) {
    if (!id) return;
    _processedIds.add(id); _capSet(_processedIds, SEEN_PROCESSED_CAP);
    _persistSeen('p', id);
  }

  // Echo suppression: ids egpt itself sent (so our own replies / 👂 acks don't
  // re-trigger), plus a short-lived chatID|text fallback (the upserted id may
  // differ from the POST's pendingMessageID). Operator's OWN messages are NOT
  // suppressed — so the operator can @e themselves.
  const _sentText = new Map();   // `${chatID}|${text}` -> expiry ms
  function rememberSent(id, chatID, text) {
    if (id) { _sentIds.add(id); _capSet(_sentIds, SEEN_SENT_CAP); _persistSeen('s', id); }
    if (text) {
      const now = Date.now();
      // Sweep expired entries — this map otherwise grows for the life of a
      // 24/7 daemon (entries "expire" logically but were never deleted).
      if (_sentText.size > 50) { for (const [k, exp] of _sentText) { if (exp < now) _sentText.delete(k); } }
      _sentText.set(`${chatID}|${text}`, now + 60000);
    }
  }
  function isEcho(id, chatID, text) {
    if (id && _sentIds.has(id)) return true;
    const exp = _sentText.get(`${chatID}|${text}`);   // don't delete — receipts re-fire the same upsert; let it expire
    return !!(exp && exp > Date.now());
  }

  // Message timestamp (ms) from the upsert payload, schema-tolerantly:
  // ISO string or epoch ms/seconds in `timestamp` / `ts` / `date`. null =
  // unknown (gate inactive for that message; logged once).
  let _warnedNoTimestamp = false;
  function _msgTimestampMs(msg) {
    const v = msg?.timestamp ?? msg?.ts ?? msg?.date ?? null;
    if (v == null) return null;
    if (typeof v === 'number') {
      if (v > 1e12) return v;            // epoch ms
      if (v > 1e9) return v * 1000;      // epoch seconds
      return null;
    }
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
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
    // updates). Process each message once — across restarts (persisted).
    if (msg.id) { if (_processedIds.has(msg.id)) return; markProcessed(msg.id); }

    const info = await chatInfo(chatID);
    // SCOPE (fail-closed): with a network scope active, a message whose
    // account can't be determined is DROPPED, not passed. Prefix match so
    // account-instance ids ('whatsapp', 'whatsappgo_2', …) still scope.
    const acct = msg.accountID || info.accountID;
    if (networks && networks.length) {
      if (!acct) { onLog(`beeper: DROP [${chatID}] — accountID unknown with network scope ${JSON.stringify(networks)} active (fail-closed)`); return; }
      if (!networks.some(n => String(acct).toLowerCase().startsWith(String(n).toLowerCase()))) return;
    }

    // Backlog gate: replayed/old messages are recorded as seen (above) but
    // never dispatched — egpt answers live traffic only, same as the
    // baileys/TG hold-on-reconnect rule.
    const tsMs = _msgTimestampMs(msg);
    if (tsMs == null) {
      if (!_warnedNoTimestamp) { _warnedNoTimestamp = true; onLog('beeper: message payload has no parseable timestamp — backlog gate INACTIVE (verify schema with tests-manual/beeper-ws-capture.mjs)'); }
    } else if (tsMs < bridgeStartMs - holdGraceMs) {
      onLog(`beeper: held backlog message [${info.title}] (${new Date(tsMs).toISOString()} < bridge start) — not dispatched`);
      return;
    }

    if ((msg.type === 'VOICE' || msg.type === 'AUDIO') && Array.isArray(msg.attachments) && msg.attachments.length) {
      isVoice = true;
      const att = msg.attachments.find(a => a.isVoiceNote || a.type === 'audio') || msg.attachments[0];
      const path = await attachmentToLocalPath(att);
      if (path) {
        const transcript = await transcribe(path, audioCfg, onLog);
        if (transcript) {
          text = transcript;
          onLog(`beeper: voice transcribed [${chatID}] → ${JSON.stringify(transcript.slice(0, 80))}`);
          // 👂 ack is an egpt-initiated SEND — it follows the enrolled-chats
          // rule (auto_e_chats + self-DM), not Beeper's mute flag. In a
          // non-enrolled chat egpt still hears (text continues to dispatch)
          // but must not reveal itself.
          if (isEnrolledChat(chatID)) {
            if (!info.isMuted) await sendMessage(chatID, `👂 ${transcript}`, { replyToMessageID: msg.id });   // quoted reply
          } else {
            onLog(`beeper: 👂 ack SUPPRESSED [${info.title}] — chat ${chatID} not enrolled (auto_e_chats/chat_id)`);
          }
        } else { text = '[voice note — transcription failed]'; }
      } else { text = '[voice note]'; }
    }
    if (text == null) return;   // non-text, non-voice (image/sticker/etc.) — nothing to route in v1

    const st = mentionStatus(text || '');
    const from = {
      chatId: chatID,                       // opaque Beeper room id (for send-back)
      chatName: info.title,
      chatType: info.type === 'group' ? 'group' : 'private',
      userId: msg.senderID || chatID,
      username: msg.senderName || undefined,
      firstName: msg.senderName || undefined,
      senderName: msg.senderName || null,
      // OPERATOR-ONLY: isSender === true means the account owner sent it (any
      // of their devices). Slash/lifecycle commands are gated on this host-side;
      // a non-operator's @e still reaches the persona via the host's persona-wake
      // exception. NEVER hardcode true — that authorizes every sender.
      authorized: !!msg.isSender,
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
  let _reconnectMs = RECONNECT_MIN_MS;   // backs off to RECONNECT_MAX_MS while Beeper is down
  let _processing = Promise.resolve();   // serialize dispatch (slow transcribe must not interleave)

  function connect() {
    if (_stopped || !token) return;
    ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${token}` } });
    ws.on('open', () => onLog('beeper: WS open'));
    ws.on('message', (buf) => {
      let ev; try { ev = JSON.parse(buf.toString()); } catch { return; }
      if (ev.type === 'ready') {
        _wsReady = true;
        _reconnectMs = RECONNECT_MIN_MS;   // healthy again — reset backoff
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
      // chat.upserted → refresh cache (title/mute may change). Preserve the
      // accountID we already know — the upsert payload may omit it, and the
      // network scope above fails closed without one.
      if (ev.type === 'chat.upserted' && Array.isArray(ev.entries)) {
        for (const c of ev.entries) {
          if (!c?.id) continue;
          const prev = _chatCache.get(c.id);
          _chatCache.set(c.id, { title: c.title || c.id, type: c.type || 'single', isMuted: !!c.isMuted, accountID: c.accountID ?? prev?.accountID ?? null });
        }
      }
      if (ev.type === 'error') onLog(`beeper: WS error event — ${JSON.stringify(ev).slice(0, 200)}`);
    });
    ws.on('close', () => {
      _wsReady = false;
      if (_stopped) return;
      onLog(`beeper: WS closed — reconnecting in ${Math.round(_reconnectMs / 1000)}s`);
      _reconnectTimer = setTimeout(connect, _reconnectMs);
      _reconnectMs = Math.min(_reconnectMs * 2, RECONNECT_MAX_MS);
    });
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
    stop: () => { _stopped = true; if (_reconnectTimer) clearTimeout(_reconnectTimer); try { ws?.close(); } catch { /* closing */ } },
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
