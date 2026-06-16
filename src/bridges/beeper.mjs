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
//   - voice handling runs the room transcription service via the host's
//     per-chat verdict (resolveTranscriptionService → { enabled, postsBack };
//     a per-entity policy, default-on per conversation — see
//     src/transcription-service.mjs), AND honors Beeper's mute flag (a muted
//     chat never acks). The verdict defaults to NEVER surface here, so a bridge
//     with no host wired can never announce egpt — the host decides the policy.
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
//
// Schema facts VERIFIED against a live Beeper Desktop (2026-06-10):
//   - chatID is a Matrix room id ('!xxx:beeper.local') — NOT a WA jid.
//     auto_e_chats / chat_id whitelists must enroll these ids for the
//     beeper transport (the 👂-suppression log prints the id to enroll).
//   - message.timestamp is an ISO string → the backlog gate is active.
//   - message.id is a small PER-CHAT sequence number → all dedup keys
//     are chatID-qualified (see msgKeyOf).
//   - accountID is 'whatsapp' on both chats and messages.
//   - subscriptions.set does NOT replay history (live events only); the
//     gates cover edit/receipt re-fires and crash replays.
import WebSocket from 'ws';
import { transcribeAudioFile } from '../tools/transcribe.mjs';
import { transcribeVoiceNote } from '../incoming-media.mjs';
import { mentionStatus } from '../auto-mode.mjs';
import { mediaKind } from '../media-kind.mjs';
import { shouldDownload } from '../media-save.mjs';
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
    // CONTRACT C2: every attachment is persisted to the chat's media/ folder.
    // The bridge downloads + decides (whatsapp.media.download); the host's
    // onMedia copies the local file into slugDir/media/. No gate wired = the
    // host just doesn't persist (the file is still transcribed for voice).
    onMedia,
    onLog: _onLog = () => {},
    media = {},
    beeperToken,
    baseUrl = 'http://127.0.0.1:23373',
    wsUrl = 'ws://127.0.0.1:23373/v1/ws',
    networks = ['whatsapp'],   // v1 SAFE SCOPE: only act on these networks. The WS subscribes to '*' (all chats); anything else is dropped. Set [] / null to process every network.
    // Host verdict for this chat's transcription service (a per-entity ROOM
    // service, NOT E enrollment — the host reads the conversation/room config
    // and supplies { enabled, postsBack }; see src/transcription-service.mjs).
    // async (chatId) => { enabled, postsBack }. Default = transcribe (HEARD) but
    // never surface (SPOKEN): a bridge with no host wired can never announce egpt.
    resolveTranscriptionService = async () => ({ enabled: true, postsBack: false }),
    // Authorization: is this STABLE sender id an operator (may emit commands /
    // mentions)? Host-supplied (reads whatsapp.allowed_users live). Beeper does
    // NOT reliably tag the owner's OWN sends as isSender — it fails even in the
    // self-chat — so authorization must derive from the DELIVERED senderID, not
    // isSender alone (operator 2026-06-16). Keyed on the stable id, never a
    // display name (I6). Default deny.
    isAllowedUser = () => false,
    // Hold-on-reconnect grace (ms): messages older than bridgeStart - grace
    // are backlog — seen, never dispatched. Mirrors the baileys/TG semantic.
    holdGraceMs = 5_000,
    stateDir = join(homedir(), '.egpt', 'state'),
    transcribe = transcribeAudioFile,
  } = opts;
  const token = beeperToken || process.env.BEEPER_ACCESS_TOKEN;
  const audioCfg = media.audio_transcribe || {};
  const mediaDownloadPolicy = media.download ?? 'all';   // 'all' | 'images_docs' | 'off'
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

  // Deterministic chat slug (operator 2026-06-10: "conversations should be
  // a deterministic contact name"). Beeper chatIDs are opaque Matrix room
  // ids; nobody should have to chase them. The slug of a chat TITLE is the
  // stable, human-meaningful key: lowercase, diacritics stripped, runs of
  // non-alphanumerics collapsed to single dashes. 'Dando Ruiz' →
  // 'dando-ruiz'; config lists may then hold names/slugs instead of ids.
  function chatSlug(title) {
    return String(title ?? '')
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  // All chats from the Desktop API, normalized + briefly cached (60s) —
  // powers /channels-style listings and name→chatID resolution.
  let _chatList = null, _chatListAt = 0;
  async function listChats() {
    if (_chatList && Date.now() - _chatListAt < 60_000) return _chatList;
    const j = await api('GET', '/v1/chats');
    const items = j?.items ?? (Array.isArray(j) ? j : []);
    _chatList = items.map(c => ({
      id: c.id,
      // jid is the STABLE chat-id key the whole resolution layer is built on
      // (assignWaIndex / waListToStableCache / resolveChatTarget all read `.jid`).
      // On Beeper that id IS the Matrix room id; alias it so /channels numbers
      // chats (`@waN`, was `@wanull`) and name-resolution doesn't see a phantom
      // undefined-jid duplicate ("spoiler matches 2"). operator 2026-06-16.
      jid: c.id,
      name: c.title ?? c.id,
      slug: chatSlug(c.title ?? c.id),
      isGroup: c.type === 'group',
      isMuted: !!c.isMuted,
      network: c.network ?? c.accountID ?? null,
      unread: c.unreadCount ?? 0,
    }));
    _chatListAt = Date.now();
    for (const c of _chatList) {
      if (!_chatCache.has(c.id)) _chatCache.set(c.id, { title: c.name, type: c.isGroup ? 'group' : 'single', isMuted: c.isMuted, accountID: c.network });
    }
    return _chatList;
  }

  // nameOrId → chatID. Accepts a raw room id ('!…'), an exact title, or a
  // slug. Ambiguity (two chats, same slug) resolves to the first and logs.
  // Never throws — an unresolvable name returns null and the caller's
  // send-drop logging explains it.
  async function resolveChatId(nameOrId) {
    const s = String(nameOrId ?? '');
    if (!s) return null;
    if (s.startsWith('!')) return s;   // already a room id
    const want = chatSlug(s);
    let matches = [];
    try { matches = (await listChats()).filter(c => c.name === s || c.slug === want); }
    catch (e) { onLog(`beeper: resolveChatId(${JSON.stringify(s)}) — chat list unavailable: ${e?.message ?? e}`); return null; }
    if (!matches.length) { onLog(`beeper: resolveChatId(${JSON.stringify(s)}) — no chat matches`); return null; }
    if (matches.length > 1) onLog(`beeper: resolveChatId(${JSON.stringify(s)}) ambiguous (${matches.length} chats) — using "${matches[0].name}" (${matches[0].id})`);
    return matches[0].id;
  }

  // --- seen-id persistence (state/beeper-seen.jsonl) ---
  // Both dedup sets reload across restarts. Without this, every restart
  // forgot what was already handled/sent — and the upserted id can differ
  // from the POST's pendingMessageID, so text-window suppression alone
  // (60s) can't cover a replay.
  //
  // Keys are `${chatID}|${id}` — VERIFIED live 2026-06-10: Beeper message
  // ids are small per-chat sequence numbers (e.g. 488), NOT globally
  // unique. A bare-id set would collide across chats and silently drop
  // the second chat's message.
  const msgKeyOf = (chatID, id) => `${chatID}|${id}`;
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
  function markProcessed(chatID, id) {
    if (!id) return;
    const key = msgKeyOf(chatID, id);
    _processedIds.add(key); _capSet(_processedIds, SEEN_PROCESSED_CAP);
    _persistSeen('p', key);
  }

  // Echo suppression: ids egpt itself sent (so our own replies / 👂 acks don't
  // re-trigger), plus a short-lived chatID|text fallback (the upserted id may
  // differ from the POST's pendingMessageID). Operator's OWN messages are NOT
  // suppressed — so the operator can @e themselves.
  const _sentText = new Map();   // `${chatID}|${normalizedText}` -> expiry ms
  // Normalize for echo matching: egpt SENDS plain text ("🦙 l\n…") but Beeper
  // echoes our OWN message back HTML-formatted ("🦙 l<br>…") with a DIFFERENT
  // final id than the POST's pendingMessageID — so a raw id/text compare misses
  // it, the echo gets treated as a fresh incoming, and a sibling whose reply
  // mentions itself (e.g. @l discussing "@l ron") re-dispatches to itself and
  // loops forever (operator 2026-06-11). Strip tags + entities + collapse
  // whitespace so the sent and echoed forms compare equal.
  function _normEcho(t) {
    return String(t ?? '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>').replace(/&#39;/g, "'").replace(/&quot;/gi, '"')
      .replace(/\s+/g, ' ').trim();
  }
  function rememberSent(id, chatID, text) {
    if (id) { const key = msgKeyOf(chatID, id); _sentIds.add(key); _capSet(_sentIds, SEEN_SENT_CAP); _persistSeen('s', key); }
    if (text) {
      const now = Date.now();
      // Sweep expired entries — this map otherwise grows for the life of a
      // 24/7 daemon (entries "expire" logically but were never deleted).
      if (_sentText.size > 50) { for (const [k, exp] of _sentText) { if (exp < now) _sentText.delete(k); } }
      _sentText.set(`${chatID}|${_normEcho(text)}`, now + 60000);
    }
  }
  function isEcho(id, chatID, text) {
    if (id && _sentIds.has(msgKeyOf(chatID, id))) return true;
    const exp = _sentText.get(`${chatID}|${_normEcho(text)}`);   // don't delete — receipts re-fire the same upsert; let it expire
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

  // CONTRACT C2 — hand each attachment to the host's onMedia so it lands in the
  // chat's media/ folder. Gated by whatsapp.media.download ('off' / 'images_docs'
  // / 'all'). Re-uses an already-downloaded voice path so a voice note isn't
  // fetched twice. A failed download of one attachment is logged, never fatal —
  // it must not block the text dispatch.
  async function persistMedia(msg, info, { voiceAtt = null, voicePath = null, voiceCaption = null } = {}) {
    if (typeof onMedia !== 'function') return;
    if (mediaDownloadPolicy === 'off') return;
    const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
    if (!atts.length) return;
    const ts = _msgTimestampMs(msg) ?? Date.now();
    for (const att of atts) {
      const mime = att?.mimeType || att?.mimetype || att?.mime || '';
      const extHint = String(att?.fileName || '').split('.').pop();
      const kind = mediaKind(mime, extHint);
      if (!shouldDownload(mediaDownloadPolicy, kind)) continue;
      const localPath = (att === voiceAtt && voicePath) ? voicePath : await attachmentToLocalPath(att);
      if (!localPath) { onLog(`beeper: media download failed [${info.title}] att=${att?.id ?? '?'}`); continue; }
      try {
        await onMedia({
          chatID: msg.chatID,
          chatName: info.title,
          chatType: info.type === 'group' ? 'group' : 'private',
          msgId: msg.id ?? null,
          senderName: msg.senderName ?? null,
          isSender: !!msg.isSender,
          ts, kind, mime,
          fileName: att?.fileName ?? null,
          localPath,
          caption: (att === voiceAtt) ? voiceCaption : (att?.caption ?? (msg.text || null)),
          isVoiceNote: !!att?.isVoiceNote,
        });
      } catch (e) { onLog(`beeper: onMedia threw — ${e?.message ?? e}`); }
    }
  }

  // --- send (efferent) ---
  // chatID may be a room id, an exact chat title, or a deterministic slug —
  // one resolution chokepoint so config/outbox entries never need raw ids.
  async function sendMessage(chatIdOrName, text, { replyToMessageID } = {}) {
    const chatID = await resolveChatId(chatIdOrName);
    if (!chatID || !text) { onLog(`beeper: send DROPPED — chat=${JSON.stringify(chatIdOrName)} resolved=${chatID} textLen=${(text || '').length}`); return null; }
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
    if (msg.id) { if (_processedIds.has(msgKeyOf(chatID, msg.id))) return; markProcessed(chatID, msg.id); }

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

    let _voiceAtt = null, _voicePath = null, _voiceCaption = null;
    if ((msg.type === 'VOICE' || msg.type === 'AUDIO') && Array.isArray(msg.attachments) && msg.attachments.length) {
      isVoice = true;
      const att = msg.attachments.find(a => a.isVoiceNote || a.type === 'audio') || msg.attachments[0];
      const path = await attachmentToLocalPath(att);
      _voiceAtt = att; _voicePath = path;
      if (path) {
        // Limb-agnostic: the shared processor runs the room transcription
        // service. The limb supplies only the downloaded file, a quoted-reply
        // mechanism, and the host's verdict for THIS chat ({ enabled, postsBack }
        // from the conversation/room config, keyed on the STABLE chatID never a
        // display name; muted = Beeper's flag). The transcript reaches the model
        // whenever enabled; postsBack only gates the 👂. See src/incoming-media.mjs.
        const svc = await resolveTranscriptionService(chatID);
        const transcript = await transcribeVoiceNote({
          localPath: path, transcribe, audioCfg,
          reply: (t) => sendMessage(chatID, t, { replyToMessageID: msg.id }),
          enabled: svc.enabled,
          postsBack: svc.postsBack,
          muted: info.isMuted,
          onLog: (m) => onLog(`beeper: ${m}`),
        });
        if (transcript) {
          text = transcript;
          _voiceCaption = transcript;
          onLog(`beeper: voice transcribed [${chatID}] → ${JSON.stringify(transcript.slice(0, 80))}`);
        } else { text = svc.enabled ? '[voice note — transcription failed]' : '[voice note]'; }
      } else { text = '[voice note]'; }
    }

    // CONTRACT C2: persist EVERY attachment to the chat's media/ folder BEFORE
    // the non-text early-return below — a photo / sticker / document must be
    // saved even though it doesn't route to a brain in v1. Logging/saving is
    // independent of surfacing, same as transcripts.
    await persistMedia(msg, info, { voiceAtt: _voiceAtt, voicePath: _voicePath, voiceCaption: _voiceCaption });

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
      // OPERATOR authorization (gates slash/lifecycle commands host-side; a
      // non-operator's @e still reaches the persona via the host's persona-wake
      // exception). Two signals: Beeper's isSender (account owner, any device) OR
      // the delivered senderID being on the operator allowlist — because Beeper's
      // isSender is unreliable for the owner's own sends (fails even in the
      // self-chat, operator 2026-06-16), so we must authorize from the senderID
      // too. NEVER hardcode true — that authorizes every sender.
      authorized: !!msg.isSender || isAllowedUser(msg.senderID),
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
      return await sendMessage(chatId ?? chatName, text, {});
    },
    // Deterministic-name surface (operator 2026-06-10): callers and slash
    // files work with names/slugs; room ids stay an internal detail.
    listChats,
    getChatName: (id) => _chatCache.get(id)?.title ?? null,
    getChatSlug: (id) => { const t = _chatCache.get(id)?.title; return t ? chatSlug(t) : null; },
    resolveChatId,
    // Surface parity with slash-file expectations (integrity test):
    // honest stubs where Beeper has no equivalent yet.
    myJid: null,   // no jid concept on this transport
    listEgptPinned: () => [],   // pins were a baileys-side feature
    setEgptPin: (..._a) => { onLog('beeper: setEgptPin not supported on this transport (yet)'); return null; },
    // Non-streaming shim for the host's persona-reply path: the gate already
    // approved emit (streamFactory returns null otherwise); send the FINAL text
    // on finish(). Ignore intermediate update() frames (no edit-spam).
    startStreamMessage(initialText, { chatId, chatName, persona } = {}) {
      // The host meta-brain path (egpt.mjs ~7880) skips its fallback send only
      // when the stream reports `delivered` — so the handle MUST expose
      // `delivered` (+ `lastError`), else every sibling reply is sent twice
      // (stream finish + fallback). A local-only `delivered` was the double-@jay bug.
      let latest = initialText, finished = false;
      const handle = { delivered: false, lastError: null };
      const deliver = async () => {
        if (handle.delivered) return;
        handle.delivered = true;
        if (latest && latest.trim()) {
          const r = await sendMessage(chatId, latest, {});
          if (!r) { handle.delivered = false; handle.lastError = 'send returned null'; }
        }
      };
      handle.update = (t) => { if (!finished && t) latest = t; };
      handle.finish = async (t) => { if (t) latest = t; finished = true; await deliver(); };
      handle.fail = (e) => { finished = true; handle.lastError = e?.message ?? String(e); onLog(`beeper: stream fail — ${e?.message ?? e}`); };
      return handle;
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
