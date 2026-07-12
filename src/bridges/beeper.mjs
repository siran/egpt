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
//   - chatID is a Matrix room id ('!xxx:beeper.local') on the WIRE — NOT a WA
//     jid. SHORT IDS (operator 2026-07-03): everything past the WS/REST
//     boundary in this file sees the id with the '!' and ':beeper.local'
//     stripped (src/bridges/chat-id.mjs shortChatId/fullChatId) — auto_e_chats
//     / chat_id whitelists, the registry, gating, transcripts, mesh, all
//     compare/store the SHORT form now. Only the api() calls in THIS file
//     re-expand to the full Matrix form, right at the fetch.
//   - message.timestamp is an ISO string → the backlog gate is active.
//   - message.id is a small PER-CHAT sequence number → all dedup keys
//     are chatID-qualified (see msgKeyOf).
//   - accountID is 'whatsapp' on both chats and messages.
//   - subscriptions.set does NOT replay history (live events only); the
//     gates cover edit/receipt re-fires and crash replays.
import WebSocket from 'ws';
import { transcribeAudioFile } from '../tools/transcribe.mjs';
import { transcribeVoiceNote, voiceTranscriptBody, POSTS_BACK_DELAY_MS, cancelPromotion, markEchoObserved, ECHO_MARKER } from '../incoming-media.mjs';
import { htmlToMarkdown } from '../html-to-markdown.mjs';
import { reactionAction, editAction } from '../dispatch-line.mjs';
import { mentionStatus } from '../auto-mode.mjs';
import { mediaKind } from '../media-kind.mjs';
import { shouldDownload } from '../media-save.mjs';
import { relMediaPath } from '../media-path.mjs';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, basename } from 'node:path';
import { EGPT_HOME } from '../egpt-home.mjs';
import { shortChatId, fullChatId } from './chat-id.mjs';
import { parseMesh } from '../mesh/relay.mjs';   // envelope detection: a mesh envelope skips isEcho's FUZZY stage only (operator 2026-07-06)

// Profile-aware (NOT hardcoded ~/.egpt): EGPT_HOME selects the node, so two
// nodes on one box (prod ~/.egpt + a v2 test node ~/.egpt2) never interleave
// writes into the SAME bridge log. Exported so a test can lock the derivation.
export const _BEEPER_LOG = join(EGPT_HOME, 'config', 'logs', 'beeper.log');
const SEEN_PROCESSED_CAP = 3000;
const SEEN_SENT_CAP = 500;
const SEEN_COMPACT_EVERY = 1000;   // appends between jsonl compactions
const RECONNECT_MIN_MS = 3_000;
const RECONNECT_MAX_MS = 60_000;

// Normalize a body for SELF-ECHO comparison (used by rememberSent/isEcho). The
// bridge echoes our OWN sends back HTML-formatted ("🦙 l<br>…") with a DIFFERENT
// final id than the POST's pendingMessageID — so a raw id/text compare misses it.
// WORSE: WhatsApp/Beeper REWRITES list markers on the echo — an ordered "1)"/"2)"
// prompt comes back as "- " bullets — so even a tag-stripped compare missed it and
// the echoed prompt re-entered dispatch as fresh input (operator 2026-06-25: the
// add-agent wizard echo-looped in the Self DM, flooding). Fix: strip HTML, decode
// entities, AND flatten every LEADING list marker (-, *, •, "N.", "N)") to nothing,
// so the sent form and any re-marked echo compare equal. Per-line, before
// whitespace collapses — hence <br> → newline first.
export function normEchoText(t) {
  return String(t ?? '')
    .replace(/<br\s*\/?>/gi, '\n')                       // <br> → newline so per-line marker stripping works
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&#39;/g, "'").replace(/&quot;/gi, '"')
    .replace(/^[ \t]*(?:[-*•‣◦]|\d+[.)])[ \t]+/gm, '')   // drop leading list marker (WhatsApp swaps "N)" ↔ "- " on echo)
    .replace(/\s+/g, ' ').trim();
}

// Word-set fingerprint for self-echo. WhatsApp can reformat our OWN multi-line menu
// into ONE line with " - " bullets and reordered punctuation, so even normEchoText
// (which only flattens LEADING markers) won't make the sent and echoed forms compare
// equal — the /e browser + add-agent menus echo-looped in the Self DM (2026-06-28).
// A menu's WORDS survive any reformatting, so fingerprint by the lowercased token SET:
// an incoming whose words are almost entirely contained in a recent multi-word send is
// that send echoing back. Short operator replies (a number, "n", a name) have too few
// words to ever match a menu, so they're never false-dropped.
export function wordBag(t) {
  return new Set(String(t ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}
// True iff `inBag` (incoming) is ≥ `threshold` contained in `sentBag` (a recent send).
export function bagContains(sentBag, inBag, threshold = 0.85) {
  if (!sentBag || !inBag || inBag.size === 0) return false;
  let hit = 0;
  for (const w of inBag) if (sentBag.has(w)) hit++;
  return hit / inBag.size >= threshold;
}

// Pick the NEWER of two Beeper message ids — the "largest id wins" reduction
// resolveSentMessageId runs over its text matches. Beeper ids are per-chat
// SEQUENCE numbers, so compare NUMERICALLY when both are finite numbers: a plain
// string compare ranks "9" > "10" and would resolve the OLDER of two matches, so
// the stream placeholder edits the wrong (earlier) message. Fall back to string
// order only when an id isn't a clean number (schema-tolerant). Ties keep `a`
// (the incumbent best), matching the original strict-greater comparator.
export function newerMsgId(a, b) {
  if (a == null) return b;
  if (b == null) return a;
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return nb > na ? b : a;
  return String(b) > String(a) ? b : a;
}

export async function startBeeperBridge(opts = {}) {
  const {
    onIncoming,
    // RAW edit hook (An 2026-06-20): an incoming message EDIT, before it's wrapped
    // as an editAction stage-direction. Lets the mesh router mirror a relayed
    // reply's streamed edits to the origin chat. async (chatId, msgId, newText,
    // oldText) => truthy-if-consumed (truthy → skip the stage-direction surfacing).
    onMessageEdit = null,
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
    networks = [],   // [] / null = process EVERY network Beeper bridges (signal/telegram/whatsapp/…). Beeper is the transport; network is metadata on each message, NOT a gate — anything that reaches the spine is processed (operator 2026-06-25). Set ['whatsapp', ...] to restrict scope.
    // Host verdict for this chat's transcription service (a per-entity ROOM
    // service, NOT E enrollment — the host reads the conversation/room config
    // and supplies { enabled, postsBack }; see src/transcription-service.mjs).
    // async (chatId) => { enabled, postsBack }. Default = transcribe (HEARD) but
    // never surface (SPOKEN): a bridge with no host wired can never announce egpt.
    resolveTranscriptionService = async () => ({ enabled: true, postsBack: false }),
    // Trailing-debounce window for the 👂 echo (per chat, coalesced). The
    // transcript still reaches the model instantly; only the chat echo waits.
    postsBackDelayMs = POSTS_BACK_DELAY_MS,
    // The persona body_emoji (🐶). Every message E sends is stamped with it, so any
    // INCOMING that starts with it is E's own — suppress it (in the self-chat E
    // posts as the operator's account, so id/text echo-suppression can race; this
    // content marker never does, and it keeps transcript.md linear).
    personaEmoji = null,
    // The persona wake-word set (operator 2026-07-07): the network-wide default e/egpt
    // PLUS the persona agent's name + every configured handle (boot derives it from the
    // agents block). The gate hardcoded e/egpt and never read the config, so a node
    // configured with handles [ed, egptd] never woke on @ed. Default = e/egpt (unchanged
    // for a node that passes nothing).
    wakeWords = ['e', 'egpt'],
    // 👂 ECHO PLAN (operator 2026-07-11, Phase 3b HRW ordered failover; plans/2607101713-HRW-ECHO-PLAN.md):
    // (noteId) => { rank, winner } — this node's 1-indexed failover RANK for the note. rank 1 = the
    // rendezvous-hash winner, posts now; rank>1 = a lower rank that HOLDS its 👂 and posts only if the
    // higher ranks stay silent (arms a promotion at (rank-1)*echoTimeoutMs, cancelled on observing the
    // note's 👂 from a higher rank); rank 0 = the echo:false hard opt-out (never post / never promote).
    // Boot builds it from node_name + the co-account peer set so exactly ONE node posts each note,
    // rotating per note, with ORDERED failover for an offline/silent winner — NOT dedup, no
    // coordination. A non-winner still HEARS (transcribes + logs). Default rank-1-always (a solo node
    // / no HRW config posts immediately, as in 3a).
    echoPlan = () => ({ rank: 1, winner: true }),
    // 👂 PER-RANK PROMOTION STEP (ms): rank-R waits (R-1)*echoTimeoutMs before posting the 👂 a silent
    // higher rank didn't. GENEROUS so a merely-SLOW rank-1 isn't mistaken for a DOWN one → double-👂.
    echoTimeoutMs = 20_000,
    // Timer seam for the 👂 debounce + promotion (forwarded to incoming-media). undefined → real
    // setTimeout; tests inject a fake clock so no real wait is needed.
    scheduler = undefined,
    // 👂 ECHO AGE BOUND (operator 2026-07-09, Zohykar 1:1 incident; renamed from
    // transcribe_ack_max_age_ms): a Beeper resync can re-deliver ancient backlog voice notes;
    // the 👂 is a live-conversation courtesy, not an archaeology announcement, so it only posts
    // when the NOTE ITSELF (its own message timestamp, not bridge start) is within this bound of
    // now. Default 1h covers the sleep-window courtesy. 0 or negative = no bound. A note with no
    // parseable timestamp echoes normally (fail-open, matching the backlog gate).
    echoMaxAgeMs = 3_600_000,
    // Authorization: is this STABLE sender id an operator (may emit commands /
    // mentions) ON THIS network? Signature is (senderId, network) — the host reads
    // the PER-SURFACE allowed_users live (operator 2026-07-02: ids are per-surface
    // namespaces, so a WhatsApp jid authorizes nothing on Telegram; the bridge
    // passes the message's origin network so the host resolves the right block).
    // Beeper does NOT reliably tag the owner's OWN sends as isSender — it fails
    // even in the self-chat — so authorization must derive from the DELIVERED
    // senderID, not isSender alone (operator 2026-06-16). Keyed on the stable id,
    // never a display name (I6). A two-arg-unaware callback ignores the extra arg
    // harmlessly. Default deny.
    isAllowedUser = () => false,
    // Display name for the ACCOUNT OWNER's own (isSender) messages. Beeper gives
    // the self participant NO fullName — only its matrix id — so without this the
    // operator's own lines read '@anrodriguez:beeper.com' instead of a name
    // (operator 2026-06-16). Host supplies the configured user_name.
    userName = null,
    // Hold-on-reconnect grace (ms): messages older than bridgeStart - grace
    // are backlog — seen, never dispatched. Mirrors the baileys/TG semantic.
    holdGraceMs = 5_000,
    stateDir = join(EGPT_HOME, 'state'),   // profile-aware default (boot injects it; a caller that omits it still lands in THIS node's profile, never ~/.egpt)
    transcribe = transcribeAudioFile,
    // Whisper binary/model config — now sourced from transcription.whisper (the
    // host resolves it; falls back to the legacy whatsapp.media.audio_transcribe
    // during migration). Transcription is its own concern, not a media subkey.
    transcribeCfg = null,
  } = opts;
  const token = beeperToken || process.env.BEEPER_ACCESS_TOKEN;
  const audioCfg = transcribeCfg ?? media.audio_transcribe ?? {};
  const mediaDownloadPolicy = media.download ?? 'all';   // 'all' | 'images_docs' | 'off'
  const onLog = (m) => {
    try { appendFileSync(_BEEPER_LOG, `${new Date().toISOString()} ${m}\n`); } catch { /* ignore */ }
    try { _onLog(m); } catch { /* ignore */ }
  };
  if (!token) { onLog('startBeeperBridge: NO TOKEN (set whatsapp.beeper_token / beeper_token / BEEPER_ACCESS_TOKEN) — bridge inert'); }
  onLog(`startBeeperBridge: ENTRY (${baseUrl})`);
  const bridgeStartMs = Date.now();
  // 👂 PHASE 3c RECONNECT GRACE (operator 2026-07-11, Stage B): the wall-clock ms of the CURRENT WS
  // connection's open. A voice note whose OWN timestamp is BEFORE this is a REPLAY Beeper re-delivered
  // late (this node was offline when it arrived) — routed through incoming-media's grace window so a
  // survivor's ALSO-replayed 👂 can cancel this node's echo (kills the reconnect double). Date.now()
  // (NOT the injected scheduler) to match this file's other echo-age math (tooOldForEcho). null until open.
  let lastWsOpenMs = null;

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
  // Short ids resolveChatId has independently confirmed are REAL rooms (seen via
  // chatInfo, listChats, chat.upserted, or the legacy full-form '!' fast path).
  // Before ':beeper.local' was dropped, a raw '!'-prefixed id short-circuited
  // resolveChatId with NO lookup, so a chatID the bridge already held (e.g.
  // msg.chatID feeding a voice-note reply's sendMessage call, or a caller that
  // resolves once then hands the resolved id to another function that resolves
  // AGAIN — sendAndGetId, startStreamMessage) always re-resolved trivially. A bare
  // short id can't carry that same free signal, so this set restores the same
  // robustness: once a short id is known real, resolving it again never depends
  // on a listChats round-trip (or on that chat ever being independently listed).
  const _knownChatIds = new Set();
  async function chatInfo(chatID) {
    if (_chatCache.has(chatID)) return _chatCache.get(chatID);
    let info = { title: chatID, type: 'single', isMuted: false, accountID: null };
    try { const c = await api('GET', `/v1/chats/${encodeURIComponent(fullChatId(chatID))}`); info = { title: c.title || chatID, type: c.type || 'single', isMuted: !!c.isMuted, accountID: c.accountID || null }; }
    catch (e) { onLog(`beeper: chatInfo(${chatID}) failed — ${e?.message ?? e}`); }
    _chatCache.set(chatID, info);
    _knownChatIds.add(chatID);
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
    _chatList = items.map(c => {
      const id = shortChatId(c.id);   // SHORT past this boundary — see chat-id.mjs
      return {
        id,
        // jid is the STABLE chat-id key the whole resolution layer is built on
        // (assignWaIndex / waListToStableCache / resolveChatTarget all read `.jid`).
        // On Beeper that id IS the Matrix room id (short form); alias it so
        // /channels numbers chats (`@waN`, was `@wanull`) and name-resolution
        // doesn't see a phantom undefined-jid duplicate ("spoiler matches 2").
        // operator 2026-06-16.
        jid: id,
        name: c.title ?? c.id,
        slug: chatSlug(c.title ?? c.id),
        isGroup: c.type === 'group',
        isMuted: !!c.isMuted,
        network: c.network ?? c.accountID ?? null,
        unread: c.unreadCount ?? 0,
      };
    });
    _chatListAt = Date.now();
    for (const c of _chatList) {
      if (!_chatCache.has(c.id)) _chatCache.set(c.id, { title: c.name, type: c.isGroup ? 'group' : 'single', isMuted: c.isMuted, accountID: c.network });
      _knownChatIds.add(c.id);
    }
    return _chatList;
  }

  // nameOrId → chatID. Accepts a raw room id ('!…'), an exact title, or a
  // slug. Ambiguity (two chats, same slug) resolves to the first and logs.
  // Never throws — an unresolvable name returns null and the caller's
  // send-drop logging explains it.
  // OPTIONAL NETWORK PIN (operator 2026-07-06: multi-network mesh) — the same chat
  // NAME can exist on several networks under one Beeper account (whatsapp/telegram/
  // signal/matrix are all bridged into this one API). When opts.network is given, only
  // chats whose network (listChats item `.network` = the API's accountID) matches count
  // as NAME-match candidates, so a shared name resolves to the pinned network's chat.
  // Absent → resolve across all (prior behavior). Raw/known ids bypass the filter (they
  // already are canonical, so there's nothing to disambiguate) — the `!`-prefix and
  // _knownChatIds short-circuits below both return before the filter, and an UNSEEN raw
  // id (c.id === s) is not a name match so it's never network-gated either.
  // No cache-key change is needed: _knownChatIds keys on RESOLVED ids, never names, so an
  // unfiltered lookup never caches the name and can't shadow a later filtered lookup.
  async function resolveChatId(nameOrId, { network = null } = {}) {
    const s = String(nameOrId ?? '');
    if (!s) return null;
    // Legacy/defensive: a full-form Matrix room id is recognized without a
    // listChats round-trip (same short-circuit the '!' prefix always gave), just
    // normalized down to the short form egpt uses past this point.
    if (s.startsWith('!')) { const id = shortChatId(s); _knownChatIds.add(id); return id; }
    // Already-known real id (see _knownChatIds above) — resolves with NO lookup,
    // same free short-circuit the '!' prefix used to give every raw id.
    if (_knownChatIds.has(s)) return s;
    const net = network ? String(network).toLowerCase() : null;
    const want = chatSlug(s);
    let matches = [];
    // `c.id === s` lets an UNSEEN raw short room id (e.g. one an operator typed
    // straight from /channels output) resolve directly once listed — a raw id, not a
    // name match, so it is never network-gated. A name/slug match IS gated by the pin.
    try {
      matches = (await listChats()).filter(c =>
        c.id === s ||
        ((c.name === s || c.slug === want) && (!net || String(c.network ?? '').toLowerCase() === net)));
    }
    catch (e) { onLog(`beeper: resolveChatId(${JSON.stringify(s)}) — chat list unavailable: ${e?.message ?? e}`); return null; }
    if (!matches.length) { onLog(`beeper: resolveChatId(${JSON.stringify(s)}${net ? ` net=${net}` : ''}) — no chat matches`); return null; }
    if (matches.length > 1) onLog(`beeper: resolveChatId(${JSON.stringify(s)}) ambiguous (${matches.length} chats) — using "${matches[0].name}" (${matches[0].id})`);
    _knownChatIds.add(matches[0].id);
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
  const _sentBags = [];          // [{ chatID, bag:Set, exp }] — word-set fingerprints of recent multi-word sends (reformat-proof echo guard)
  // Chat-qualified ids of OUR OWN streaming placeholders (meta-engineer 🤔→reply
  // in-place edits). Our live edits re-upsert the message; without this guard the
  // bridge would surface each as an incoming "edit" stage-direction (spam / loop).
  const _ourStreamIds = new Set();
  // Normalize for echo matching — module-scope normEchoText (strips HTML/entities
  // AND flattens list markers so a re-marked echo still compares equal).
  const _normEcho = normEchoText;
  function rememberSent(id, chatID, text) {
    if (id) { const key = msgKeyOf(chatID, id); _sentIds.add(key); _capSet(_sentIds, SEEN_SENT_CAP); _persistSeen('s', key); }
    if (text) {
      const now = Date.now();
      // Sweep expired entries — this map otherwise grows for the life of a
      // 24/7 daemon (entries "expire" logically but were never deleted).
      if (_sentText.size > 50) { for (const [k, exp] of _sentText) { if (exp < now) _sentText.delete(k); } }
      _sentText.set(`${chatID}|${_normEcho(text)}`, now + 60000);
      // Word-set fingerprint for multi-word sends (menus) — survives WhatsApp's reformat.
      // Fingerprint the NORMALIZED text (HTML stripped) so the incoming echo's bag —
      // also normalized in isEcho — isn't diluted by tag tokens (<p>/<br>/<a…>).
      const bag = wordBag(_normEcho(text));
      if (bag.size >= 8) {
        if (_sentBags.length > 40) _sentBags.splice(0, _sentBags.length - 40);
        for (let i = _sentBags.length - 1; i >= 0; i--) if (_sentBags[i].exp < now) _sentBags.splice(i, 1);
        _sentBags.push({ chatID, bag, exp: now + 60000 });
      }
    }
  }
  function isEcho(id, chatID, text) {
    if (id && _sentIds.has(msgKeyOf(chatID, id))) return true;
    const exp = _sentText.get(`${chatID}|${_normEcho(text)}`);   // don't delete — receipts re-fire the same upsert; let it expire
    if (exp && exp > Date.now()) return true;
    // A MESH ENVELOPE skips ONLY the fuzzy word-bag stage (operator 2026-07-06): the heuristic is
    // for REFORMATTED MENU echoes — but two relay envelopes in ONE channel share ~every token across
    // hops (identical base64 body + from/from_node/by/post_id/enc, differing only in to:/via:), so a
    // FOREIGN forward would fuzzy-match our own origin envelope and be dropped BEFORE the "incoming"
    // log — the multipath relay chain died silently (REVE live test, to: don.do → next hop to: wren.kg).
    // The exact id/text stages ABOVE still suppress a node's OWN envelope echo (identical id/text —
    // the 73fc57a invariant that removed the too-broad blanket exemption; only the fuzzy stage is skipped).
    if (parseMesh(text)) return false;
    // Reformat-proof fallback: a reformatted echo of our own menu — same words, same chat.
    // Normalize first (strip HTML) so tag tokens don't dilute the containment ratio.
    const inBag = wordBag(_normEcho(text));
    if (inBag.size >= 5) {
      const nowMs = Date.now();
      for (const s of _sentBags) {
        if (s.exp < nowMs || s.chatID !== chatID) continue;
        if (bagContains(s.bag, inBag)) return true;
      }
    }
    return false;
  }
  // Did THIS bridge send (chatID, messageID)? Reads the persisted _sentIds set (the
  // '<chat>|<id>' keys reloaded from beeper-seen.jsonl). Used for two fail-closed
  // decisions: E may only /edit or /delete a message it sent, and an inbound reply's
  // quoted id is "a reply to E" only when we sent that id. HONEST LIMIT: the set only
  // knows messages sent SINCE seen-state existed (and is LRU-capped, SEEN_SENT_CAP),
  // so a reply to an older/pruned E message reads false — correct fail-closed
  // behavior (the human just includes @e, as before).
  function wasSentByUs(chatID, messageID) {
    if (!chatID || messageID == null) return false;
    return _sentIds.has(msgKeyOf(shortChatId(chatID), messageID));
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
  // Returns the saved descriptors [{ kind, savedPath, fileName, isVoiceNote }] so
  // the caller can ANNOUNCE non-voice media to the model (the saved path) — a
  // photo/gif/video/doc must reach E, not just disk (operator 2026-06-16: this
  // regressed; onMedia's returned path was discarded here).
  async function persistMedia(msg, info, { voiceAtt = null, voicePath = null, voiceCaption = null } = {}) {
    const saved = [];
    if (typeof onMedia !== 'function') return saved;
    if (mediaDownloadPolicy === 'off') return saved;
    const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
    if (!atts.length) return saved;
    const ts = _msgTimestampMs(msg) ?? Date.now();
    for (const att of atts) {
      const mime = att?.mimeType || att?.mimetype || att?.mime || '';
      const extHint = String(att?.fileName || '').split('.').pop();
      const kind = mediaKind(mime, extHint);
      if (!shouldDownload(mediaDownloadPolicy, kind)) continue;
      const localPath = (att === voiceAtt && voicePath) ? voicePath : await attachmentToLocalPath(att);
      if (!localPath) { onLog(`beeper: media download failed [${info.title}] att=${att?.id ?? '?'}`); continue; }
      try {
        const r = await onMedia({
          chatID: msg.chatID,
          chatName: info.title,
          chatType: info.type === 'group' ? 'group' : 'private',
          // Origin network (Beeper accountID) — SAME derivation dispatchMessage
          // uses for `from.network`, so the media service buckets the file under
          // the identical surface as the transcript (identity.surfaceOf); without
          // it a non-WhatsApp attachment fell to media's 'whatsapp' default.
          network: msg.accountID || info.accountID || 'whatsapp',
          msgId: msg.id ?? null,
          senderName: senderDisplay(msg),   // leak-safe: pushed name / non-private id, never the saved label (media index.md is model-readable)
          isSender: !!msg.isSender,
          ts, kind, mime,
          fileName: att?.fileName ?? null,
          localPath,
          caption: (att === voiceAtt) ? voiceCaption : (htmlToMarkdown(att?.caption) || htmlToMarkdown(msg.text) || null),
          isVoiceNote: !!att?.isVoiceNote,
        });
        // onMedia returns the saved path (string) OR, for a video (Route A), an
        // augmented descriptor { savedPath, framePaths, transcript } — the host
        // extracted keyframes + transcribed the audio so we can hand them to E.
        const savedPath = (r && typeof r === 'object') ? r.savedPath : r;
        const framePaths = (r && typeof r === 'object' && Array.isArray(r.framePaths)) ? r.framePaths : [];
        const vTranscript = (r && typeof r === 'object') ? (r.transcript ?? null) : null;
        // inText: this attachment is the one the voice branch already transcribed
        // into `text` — don't ALSO announce its path (avoids a double mention).
        saved.push({ kind, savedPath: savedPath ?? localPath, fileName: att?.fileName ?? null, isVoiceNote: !!att?.isVoiceNote, inText: att === voiceAtt, framePaths, transcript: vTranscript });
      } catch (e) { onLog(`beeper: onMedia threw — ${e?.message ?? e}`); }
    }
    return saved;
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
      const r = await api('POST', `/v1/chats/${encodeURIComponent(fullChatId(chatID))}/messages`, body);
      rememberSent(r?.pendingMessageID || r?.messageID || r?.id, chatID, String(text));
      return { ok: true, chatId: chatID, pendingMessageID: r?.pendingMessageID };
    } catch (e) { onLog(`beeper: send failed [${chatID}] — ${e?.message ?? e}`); return null; }
  }

  // --- edit / delete (Beeper Desktop API: PUT/DELETE a message by its CONFIRMED
  // id) -------------------------------------------------------------------------
  // Verified live 2026-06-20: PUT /v1/chats/{c}/messages/{id} {text} edits in place;
  // DELETE removes. The POST only returns a pendingMessageID — useless for PUT — so
  // the confirmed id is resolved separately (resolveSentMessageId).
  async function editMessage(chatID, messageID, text) {
    if (!chatID || !messageID || !text) return false;
    try { await api('PUT', `/v1/chats/${encodeURIComponent(fullChatId(chatID))}/messages/${encodeURIComponent(messageID)}`, { text: String(text) }); return true; }
    catch (e) { onLog(`beeper: edit failed [${chatID}/${messageID}] — ${e?.message ?? e}`); return false; }
  }
  async function deleteMessage(chatID, messageID) {
    if (!chatID || !messageID) return false;
    try { await api('DELETE', `/v1/chats/${encodeURIComponent(fullChatId(chatID))}/messages/${encodeURIComponent(messageID)}`); return true; }
    catch (e) { onLog(`beeper: delete failed [${chatID}/${messageID}] — ${e?.message ?? e}`); return false; }
  }

  // --- reactions / media SEND (Beeper Desktop local API) -----------------------
  // Verified against the live Desktop API + docs (2026-07-04):
  //   REACT : POST /v1/chats/{c}/messages/{id}/reactions  { reactionKey }
  //   MEDIA : POST /v1/assets/upload (multipart 'file') -> { uploadID, mimeType,
  //           fileName } ; then POST /v1/chats/{c}/messages { attachment:{uploadID,
  //           type, mimeType, fileName}, text? }.
  // These give conversation-E its LIMBS (reply-to already rides sendMessage's
  // replyToMessageID). chatID resolves through the same chokepoint as sendMessage,
  // so a name/slug/room-id all work; a resolve miss logs + returns false.
  async function sendReaction(chatIDOrName, messageID, reactionKey) {
    const chatID = await resolveChatId(chatIDOrName);
    if (!chatID || !messageID || !reactionKey) { onLog(`beeper: reaction DROPPED — chat=${JSON.stringify(chatIDOrName)} resolved=${chatID} msg=${messageID} key=${JSON.stringify(reactionKey)}`); return false; }
    try { await api('POST', `/v1/chats/${encodeURIComponent(fullChatId(chatID))}/messages/${encodeURIComponent(messageID)}/reactions`, { reactionKey: String(reactionKey) }); return true; }
    catch (e) { onLog(`beeper: reaction failed [${chatID}/${messageID}] — ${e?.message ?? e}`); return false; }
  }
  // Beeper's attachment `type` enum hint, derived from the upload's mimeType.
  function attachmentType(mime) {
    const m = String(mime ?? '').toLowerCase();
    if (m === 'image/gif') return 'gif';
    if (m.startsWith('image/')) return 'image';
    if (m.startsWith('video/')) return 'video';
    if (m.startsWith('audio/')) return 'audio';
    return 'file';
  }
  // Multipart upload of a LOCAL file → the temp asset descriptor { uploadID, ... }.
  // Uses the global fetch/FormData/Blob (Node 18+) directly, not api() — api() is
  // JSON-only. Throws on a non-2xx so sendMedia logs + fails closed.
  async function uploadAsset(filePath) {
    const buf = await readFile(filePath);
    const form = new FormData();
    form.append('file', new Blob([buf]), basename(filePath));
    const res = await fetch(baseUrl + '/v1/assets/upload', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    if (!res.ok) throw new Error(`POST /v1/assets/upload → ${res.status} ${(await res.text()).slice(0, 200)}`);
    const t = await res.text();
    return t ? JSON.parse(t) : null;
  }
  async function sendMedia(chatIDOrName, filePath, { caption = null } = {}) {
    const chatID = await resolveChatId(chatIDOrName);
    if (!chatID || !filePath) { onLog(`beeper: media DROPPED — chat=${JSON.stringify(chatIDOrName)} resolved=${chatID} file=${JSON.stringify(filePath)}`); return false; }
    try {
      const up = await uploadAsset(filePath);
      if (!up?.uploadID) { onLog(`beeper: media upload returned no uploadID [${filePath}]`); return false; }
      const body = { attachment: { uploadID: up.uploadID, type: attachmentType(up.mimeType), ...(up.mimeType ? { mimeType: up.mimeType } : {}), ...(up.fileName ? { fileName: up.fileName } : {}) } };
      if (caption) { body.text = String(caption); rememberSent(null, chatID, String(caption)); }   // pre-record caption (WS echo can beat the HTTP response)
      const r = await api('POST', `/v1/chats/${encodeURIComponent(fullChatId(chatID))}/messages`, body);
      if (caption) rememberSent(r?.pendingMessageID || r?.messageID || r?.id, chatID, String(caption));
      onLog(`beeper: media sent [${chatID}] ${basename(filePath)} (${up.mimeType || 'unknown'})`);
      return true;
    } catch (e) { onLog(`beeper: media send failed [${chatID}/${filePath}] — ${e?.message ?? e}`); return false; }
  }
  // Resolve the CONFIRMED id of a message we just sent: poll the recent list and
  // match our own text; pick the newest match (largest numeric id). TRANSFORM-TOLERANT:
  // Beeper round-trips our text LOSSY, so a literal compare misses the message.
  //   - FENCE: sent ``` → Beeper stores <pre><code> → htmlToMarkdown yields `` (drop backticks).
  //   - LINK: sent a domain-like token "don.do" → Beeper auto-linkifies → htmlToMarkdown
  //     yields "[don.do](http://don.do)" (collapse [text](url) → text). Verified live
  //     2026-06-21: this was why the relay placeholder "↪ relayed to don.do — waiting…"
  //     never resolved its id, so post_id was empty in the tail and the origin couldn't
  //     stream the relayed reply in place.
  // Normalise BOTH sides identically so the just-sent message is found regardless.
  // BELT-AND-SUSPENDERS (2026-07-02): a message WE sent always comes back
  // isSender:true, so require it when the list item carries the field — this
  // cheaply excludes a same-text message from someone ELSE (e.g. a quote/echo of
  // our line). Items lacking the field are tolerated (schema drift) — absent is
  // acceptable, so we never reject our own send just because the flag is missing.
  // No time-window: clock skew + the retry loop make it fragile; isSender +
  // newest-id (numeric, via newerMsgId) is enough to land on THIS turn's message
  // — PROVIDED the caller passes `afterId` (the pre-send floor, below). Without
  // it, "newest match" only compares matches WITHIN one poll: a poll that races
  // the new message's upsert sees ONLY a stale identical-text twin and returns it.
  const _matchKey = (s) => _normEcho(
    String(s ?? '').replace(/`+/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'),
  );
  async function resolveSentMessageId(chatID, text, { tries = 6, delayMs = 500, afterId = null } = {}) {
    const want = _matchKey(text);
    if (!chatID || !want) return null;
    for (let i = 0; i < tries; i++) {
      try {
        const r = await api('GET', `/v1/chats/${encodeURIComponent(fullChatId(chatID))}/messages?limit=25`);
        const items = Array.isArray(r?.items) ? r.items : [];
        let best = null;
        for (const m of items) {
          if (!m?.id) continue;
          if (m.isSender === false) continue;   // present-and-false → not our send (absent tolerated)
          // Pre-send floor: an id at/below `afterId` existed BEFORE our send, so an
          // identical-text match there is a STALE TWIN, never the message we just
          // posted (ids are per-chat sequence numbers). Skip it and keep polling
          // until the real one upserts. (The live landmine 2026-07-04, SPOILER: a
          // previous turn's orphaned '⏳ Thinking…' placeholder matched on the first
          // poll — which races the new post's upsert — so the stream bound to the
          // OLD message; every edit then landed invisibly in the scrollback, the new
          // placeholder stuck forever and became the NEXT turn's twin. Immediate
          // turns died in a self-perpetuating chain; queued ones — distinct
          // 'Queued (N ahead)' texts, no twin — always delivered.)
          if (afterId != null && newerMsgId(afterId, m.id) === afterId) continue;
          if (_matchKey(htmlToMarkdown(m.text) || m.text || '') !== want) continue;
          best = newerMsgId(best, m.id);
        }
        if (best != null) return best;
      } catch { /* retry */ }
      await new Promise((res) => setTimeout(res, delayMs));
    }
    return null;
  }
  // The newest id currently in the chat — snapshot BEFORE a send to arm
  // resolveSentMessageId's `afterId` floor. null (empty chat / GET failure) =
  // no floor, i.e. today's accept-any behavior (degraded, never blocking).
  async function newestChatMsgId(chatID) {
    try {
      const r = await api('GET', `/v1/chats/${encodeURIComponent(fullChatId(chatID))}/messages?limit=25`);
      let newest = null;
      for (const m of (Array.isArray(r?.items) ? r.items : [])) if (m?.id != null) newest = newerMsgId(newest, m.id);
      return newest;
    } catch { return null; }
  }

  // --- reactions (MESSAGES-FIRST-CLASS-PLAN Phase 2) ---------------------------
  // Beeper delivers a reaction as TWO events (verified live 2026-06-16): a bare
  // type:'REACTION' event (reactor + linkedMessageID, but NO emoji), and a
  // re-upsert of the TARGET message carrying reactions[] = [{participantID,
  // reactionKey}] — that's where the emoji + the snippet (the target's text) live.
  // So we read reactions off the target re-upsert, not the bare event.
  //
  // Flood-safe by BASELINE-ON-FIRST-SIGHT (I10 — catch up, don't replay): every
  // message upsert records its current reaction set; we emit only reactions ADDED
  // after a message's FIRST sight this session. On reconnect, re-synced messages
  // are "first seen" with their existing reactions → recorded, never surfaced; a
  // genuinely live reaction diffs against the baseline and emits. No timestamps,
  // no event correlation.
  const _idToName = new Map();         // senderID -> last-seen senderName (reactor naming)
  const _seenReactions = new Map();    // msgId -> Set of `${reactor}\u0000${emoji}`
  const _seenText = new Map();         // msgId -> last cleaned text (edit detection, baseline-on-first-sight)
  const REACTION_CAP = 4000;
  function _capMap(m, cap) { while (m.size > cap) m.delete(m.keys().next().value); }

  // The SENDER's display name for the dispatch line / transcript / reactor + editor
  // names. HARD PRIVACY RULE (operator 2026-07-03): the sender attribution must
  // NEVER be the operator's SAVED contact-list label — it's a leak (the operator's
  // private annotations, e.g. "Ricki Mejia amigo diana real estate", would ride into
  // transcripts fed to models and surface in replies / mesh envelopes). Beeper fills
  // message.senderName with EXACTLY that saved label for a saved contact (verified
  // live 2026-07-03: senderName == the participant's fullName == the chat title; no
  // separate pushName is exposed — every /v1/contacts|users|participants-by-id
  // endpoint 404s). So we never surface senderName as the author; instead, for EVERY
  // sender (owner included, operator 2026-07-10):
  //   1. the person's OWN pushed/profile name if the payload carries one
  //      (msg.senderPushName / msg.pushName — schema-tolerant, like _msgTimestampMs);
  //   2. else a HUMAN-READABLE NON-PRIVATE id — the phone number embedded in a
  //      WhatsApp senderID ('@whatsapp_<digits>:beeper.local' → '+<digits>'), else
  //      the localpart of a Matrix id ('@<localpart>:<domain>' → '<localpart>', a
  //      public handle — e.g. '@anrodriguez:beeper.com' → 'anrodriguez', not a label);
  //   3. else the raw stable senderID itself; 4. else null (caller's own fallback).
  // The chat label / [chatname] / conversation folder (conversations.yaml pushedName)
  // KEEP the operator's label — that's the CHAT's name, not the person's. Display-only:
  // authorization stays id-based (GENOME I6). The OWNER (isSender) is NO LONGER exempt
  // (operator 2026-07-10): the author is ALWAYS the push name, then number, then stable
  // id — NEVER the node's configured userName (that mislabeled An's OWN voice notes as
  // the node's user_name, e.g. DOLLY echoed "👂 Don"; REVE labeled the same note "An").
  // The owner's own push name is their OWN profile name — safe. userName still names the
  // owner for REACTION attribution (_reactorName) and cross-surface mirroring, not here.
  function fallbackSenderId(msg) {
    const id = String(msg?.senderID ?? '');
    const wa = /^@whatsapp_(\d{6,15}):/i.exec(id);   // WhatsApp jid → phone number (human-readable, non-private)
    if (wa) return `+${wa[1]}`;
    const mx = /^@([^:]+):[^:]+$/.exec(id);          // Matrix id '@<localpart>:<domain>' → localpart (public handle, no leak)
    if (mx) return mx[1];
    return id || null;                                // neither shape: the raw stable id (still non-private)
  }
  // PUSHED NAME from a WhatsApp LID sender (operator 2026-07-08: the morgan 👂 posted the
  // raw LID `@whatsapp_lid-…:beeper.local` where the push name "le_moi" belonged). A LID
  // (`@whatsapp_lid-<digits>`) is an UNSAVED contact — you don't have their number — so
  // Beeper's senderName is the person's OWN pushed/profile name, NOT a saved contact-list
  // label (the private-annotation leak the senderName rule guards against; a SAVED contact
  // arrives as a phone jid, and that path is untouched — it never reaches here). So for a
  // LID sender the senderName IS the push name and is safe to surface. null when absent →
  // fallbackSenderId (the raw id) stands, per the "no push name → raw id" allowance.
  function lidPushName(msg) {
    return /^@whatsapp_lid-/i.test(String(msg?.senderID ?? '')) ? (msg?.senderName || null) : null;
  }
  function senderDisplay(msg) {
    // ONE rule for EVERYONE incl. the owner (operator 2026-07-10): pushed name (incl. a
    // LID's senderName) → non-private id (number, then stable id). NEVER the node's
    // configured userName, NEVER the saved contact label. See the block above.
    return msg?.senderPushName || msg?.pushName || lidPushName(msg) || fallbackSenderId(msg);
  }

  function _reactorName(id, network) {
    if (!id) return 'someone';
    if (isAllowedUser(id, network) && userName) return userName;   // the owner → configured name
    return _idToName.get(id) || id;
  }
  // Sync diff: update the per-message baseline, return the reactions ADDED since
  // last sight (empty on first sight, so a baseline is never surfaced).
  function _freshReactions(msg) {
    if (msg.type === 'REACTION') return [];   // bare event carries no emoji — skip
    if (!msg.id) return [];
    const msgId = msgKeyOf(msg.chatID, msg.id);   // chat-qualified: Beeper ids are per-chat
    const list = Array.isArray(msg.reactions) ? msg.reactions : [];
    const cur = new Set();
    for (const r of list) {
      const reactor = r?.participantID || r?.id;
      const emoji = (typeof r?.reactionKey === 'string' && r.reactionKey) || null;
      if (reactor && emoji) cur.add(`${reactor}\u0000${emoji}`);
    }
    const first = !_seenReactions.has(msgId);
    const prev = _seenReactions.get(msgId) || new Set();
    _seenReactions.set(msgId, cur);
    _capMap(_seenReactions, REACTION_CAP);
    if (first) return [];   // baseline — record, never surface (don't replay)
    const fresh = [];
    for (const key of cur) if (!prev.has(key)) { const [reactor, emoji] = key.split('\u0000'); fresh.push({ reactor, emoji }); }
    return fresh;
  }
  // Surface each newly-added reaction as a stage-direction through the ONE router
  // (onIncoming), flagged isReaction:true so the host wraps it in brackets and the
  // mode gate (I5 revised) decides whether E answers.
  async function _maybeEmitReactions(msg) {
    const fresh = _freshReactions(msg);
    if (!fresh.length) return;
    const info = await chatInfo(msg.chatID);
    const network = msg.accountID || info.accountID || 'whatsapp';   // origin network (Beeper accountID); default 'whatsapp'
    const snippet = htmlToMarkdown(msg.text) || '';
    for (const { reactor, emoji } of fresh) {
      const name = _reactorName(reactor, network);
      const body = reactionAction({ emoji, targetId: msg.id, snippet });
      onLog(`beeper: reaction ${emoji} by ${name} → #${msg.id} [${info.title}]`);
      const from = {
        chatId: msg.chatID, chatName: info.title,
        chatType: info.type === 'group' ? 'group' : 'private',
        network,   // per-surface authorization namespace
        userId: reactor, username: undefined, firstName: name, senderName: name,
        isSender: false, authorized: isAllowedUser(reactor, network),
        atEStart: false, atEAnywhere: false, replyToBot: false,
        isReaction: true, isTranscriptFromVoice: false,
        msgKey: msg.id || null,   // the reacted-to message id (referenced as #id in the body)
      };
      try { await onIncoming?.(body, from); }
      catch (e) { onLog(`beeper: reaction onIncoming threw — ${e?.message ?? e}`); }
    }
  }

  // EDITS (MESSAGES-FIRST-CLASS-PLAN): an edit re-upserts the message with NEW
  // text. Detect a text CHANGE vs the per-message baseline (same flood-safe
  // baseline-on-first-sight as reactions: first sight records, never surfaces, so a
  // reconnect re-sync of already-edited text isn't replayed). Emit an append-only
  // stage-direction; the original line stays in the transcript. Shape-agnostic —
  // works off the re-upsert's text, no edit-marker field required.
  async function _maybeEmitEdits(msg) {
    if (!msg?.id || msg.type === 'REACTION') return;
    const key = msgKeyOf(msg.chatID, msg.id);   // chat-qualified: Beeper ids are per-chat
    const cur = htmlToMarkdown(msg.text) || '';
    // OUR OWN streaming edit (a meta-engineer's 🤔→reply in-place edit): keep the
    // baseline current so a LATER genuine edit still diffs, but NEVER surface it.
    if (_ourStreamIds.has(key)) { _seenText.set(key, cur); return; }
    const first = !_seenText.has(key);
    const prev = _seenText.get(key);
    _seenText.set(key, cur);
    _capMap(_seenText, REACTION_CAP);
    if (first || !cur || prev === cur) return;   // baseline / empty / unchanged → not an edit
    // RAW edit hook: a relayed reply's relay-room message was edited by the
    // responder (streaming). Let the mesh router mirror it to the origin chat; if it
    // consumes the edit, skip the normal stage-direction surfacing.
    if (onMessageEdit) {
      try { if (await onMessageEdit(msg.chatID, msg.id, cur, prev)) return; }
      catch (e) { onLog(`beeper: onMessageEdit threw — ${e?.message ?? e}`); }
    }
    const info = await chatInfo(msg.chatID);
    const network = msg.accountID || info.accountID || 'whatsapp';   // origin network (Beeper accountID); default 'whatsapp'
    const editor = senderDisplay(msg) || _idToName.get(msg.senderID) || 'someone';
    const body = editAction({ targetId: msg.id, oldText: prev, newText: cur });
    onLog(`beeper: edit #${msg.id} by ${editor} [${info.title}]: ${JSON.stringify(prev.slice(0, 40))} → ${JSON.stringify(cur.slice(0, 40))}`);
    const from = {
      chatId: msg.chatID, chatName: info.title,
      chatType: info.type === 'group' ? 'group' : 'private',
      network,   // per-surface authorization namespace
      userId: msg.senderID || msg.chatID, username: editor,   // never the saved contact label (privacy)
      firstName: editor, senderName: editor,
      isSender: !!msg.isSender, authorized: !!msg.isSender || isAllowedUser(msg.senderID, network),
      atEStart: false, atEAnywhere: false, replyToBot: false,
      isReaction: false, isStageDirection: true, isTranscriptFromVoice: false,
      msgKey: msg.id || null,
    };
    try { await onIncoming?.(body, from); }
    catch (e) { onLog(`beeper: edit onIncoming threw — ${e?.message ?? e}`); }
  }

  // --- dispatch one incoming message ---
  async function dispatchMessage(msg) {
    const chatID = msg.chatID;
    // Remember sender display names for reactor resolution (reactions[] only
    // carries the participant id, not a name). Store the leak-safe form (pushed name
    // → non-private id, NEVER the saved contact label) so a later reaction/edit
    // resolves to who the person IS, not the operator's private annotation.
    { const sn = senderDisplay(msg); if (msg.senderID && sn) _idToName.set(msg.senderID, sn); }
    // REACTIONS (Phase 2): handle BEFORE echo/dedup — a reaction rides the TARGET
    // message's re-upsert, and that target may be E's OWN message (an echo) or an
    // already-processed message (deduped); both must still surface the reaction.
    await _maybeEmitReactions(msg);
    await _maybeEmitEdits(msg);   // a re-upsert with changed text → an edit stage-direction (before dedup)
    if (msg.type === 'REACTION') return;   // bare reaction event: no body to route
    // Echo suppression compares the RAW wire text (its own _normEcho strips HTML,
    // C5.3) — so check it BEFORE converting. Beeper delivers text as HTML; convert
    // it to markdown so the model + transcript see prose, not markup (the inbound
    // complement of the outbound md→HTML path; src/html-to-markdown.mjs).
    if (isEcho(msg.id, chatID, msg.text)) return;
    let text = htmlToMarkdown(msg.text) || null, isVoice = false;
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

    // Backlog gate → BACKFILL (operator 2026-07-08, trusted network / S3 wake): a node
    // that slept and woke MUST keep a complete record. A replayed/old message (older than
    // bridge start) is no longer DROPPED here — it is flagged `isBacklog` and rides the
    // rest of this path so it is transcribed (voice below) + transcript-logged, but the
    // `backlog` flag on `from` makes the spine log-but-NEVER-dispatch it (no agents, no
    // commands, no mesh, no mode:on — today's no-dispatch guarantee, kept). Was: returned
    // before the message ever reached the transcript.
    const tsMs = _msgTimestampMs(msg);
    let isBacklog = false;
    if (tsMs == null) {
      if (!_warnedNoTimestamp) { _warnedNoTimestamp = true; onLog('beeper: message payload has no parseable timestamp — backlog gate INACTIVE (verify schema with tests-manual/beeper-ws-capture.mjs)'); }
    } else if (tsMs < bridgeStartMs - holdGraceMs) {
      isBacklog = true;
      onLog(`beeper: backlog message [${info.title}] (${new Date(tsMs).toISOString()} < bridge start) — backfilled to transcript, not dispatched`);
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
        const vmeta = {};
        // 👂 ECHO AGE BOUND (operator 2026-07-09, Zohykar incident): gate on the NOTE'S OWN
        // timestamp (tsMs, computed above for the backlog gate) vs now — NOT bridge start, so a
        // note that arrived during sleep still echoes on wake if the note itself is within the
        // bound. No parseable timestamp -> fail-open (echo), same as the backlog gate.
        const tooOldForEcho = echoMaxAgeMs > 0 && tsMs != null && (Date.now() - tsMs) > echoMaxAgeMs;
        if (tooOldForEcho) onLog(`beeper: echo suppressed - note older than bound [${info.title}] (${new Date(tsMs).toISOString()}, bound ${echoMaxAgeMs}ms)`);
        // 👂 PHASE 3c RECONNECT-REPLAY (operator 2026-07-11, Stage B): a note recorded BEFORE our current
        // WS connection opened is a replay we are seeing late (offline during its arrival). Route it
        // through incoming-media's grace window (graceMs below) — even at rank-1 it ARMS then posts only
        // if unobserved, so the survivor's replayed 👂 (also in this replay stream) cancels it → no double
        // 👂. A live note (tsMs >= lastWsOpenMs, or no parseable ts) is graceMs 0 — unchanged.
        const reconnectReplay = tsMs != null && lastWsOpenMs != null && tsMs < lastWsOpenMs;
        if (reconnectReplay) onLog(`beeper: reconnect-replay voice note [${info.title}] — echo via grace window`);
        // 👂 ECHO PLAN (operator 2026-07-11, Phase 3b HRW ordered failover): this node's rank for the
        // note over the co-account peer set. msg.id is the note's SHARED Beeper message id — IDENTICAL
        // on both co-account nodes (one shared account → the same message → the same per-chat sequence
        // id), so the ranks AGREE: exactly ONE rank-1 posts now, and a lower rank promotes only if the
        // higher ranks are silent (NOT dedup). rank 0 = echo:false hard opt-out. The age bound is
        // ORTHOGONAL — tooOldForEcho suppresses ANY post/promotion regardless of rank.
        const plan = echoPlan(msg.id);
        const echoOn = plan.rank >= 1 && !tooOldForEcho;   // is an echo POSSIBLE at all for this note on this node?
        const transcript = await transcribeVoiceNote({
          localPath: path, transcribe, audioCfg,
          reply: (t) => sendMessage(chatID, t, { replyToMessageID: msg.id }),
          enabled: svc.enabled,
          // rank 1 → post now (immediate/debounced); rank>1 → HOLD + arm a promotion at
          // (rank-1)*echoTimeoutMs (incoming-media). A non-winner still HEARS (transcribes + logs);
          // only the POST is gated. rank 0 (echo:false) / too-old → echoOn false → neither posts nor
          // promotes.
          postsBack: echoOn ? svc.postsBack : false,
          echoRank: plan.rank,          // 1 = rank-1 (post now); >1 = arm the ordered-failover promotion
          echoTimeoutMs,                // per-rank promotion step
          graceMs: reconnectReplay ? echoTimeoutMs : 0,   // Phase 3c: a reconnect replay arms an observe-then-post window (even at rank-1) so a survivor's replayed 👂 cancels it before it fires
          scheduler,                    // fake clock in tests; real setTimeout in prod
          muted: info.isMuted,
          // NO author on the 👂 ack (operator 2026-07-10): Beeper exposes no push name,
          // so senderDisplay would yield a bare phone number / id — useless as a name.
          // The ack is ALREADY a per-note quoted reply to the note itself, so attribution
          // comes from the quote; the ack just shows "👂 (<Ns>) <transcript>" (duration
          // kept). The MODEL envelope still carries senderDisplay(msg) — this drops it
          // ONLY from the in-chat echo.
          // PER-NOTE key (chat + this note's id): each voice note gets its OWN delayed 👂
          // transcript, posted as a reply to ITSELF (operator 2026-06-24), never coalesced.
          debounceKey: `${chatID}:${msg.id}`,
          postsBackDelayMs,
                    onLog: (m) => onLog(`beeper: ${m}`),
          meta: vmeta,
        });
        if (transcript) {
          // Mark the body AS audio (GENOME §4 / C7.6) so the model + reader can
          // tell a voice note arrived — not an ordinary message. Duration comes
          // from the ffmpeg WAV the transcriber already made (vmeta.durationSec),
          // omitted when unknown. The bare transcript still feeds the 👂 ack + the
          // media sidecar caption.
          text = voiceTranscriptBody(transcript, { durationSec: vmeta.durationSec });
          _voiceCaption = transcript;
          onLog(`beeper: voice transcribed [${chatID}] → ${JSON.stringify(transcript.slice(0, 80))}`);
        } else { text = svc.enabled ? '[voice note — transcription failed]' : '[voice note]'; }
      } else { text = '[voice note]'; }
    }

    // CONTRACT C2: persist EVERY attachment to the chat's media/ folder BEFORE
    // the non-text early-return below — a photo / sticker / document must be
    // saved even though it doesn't route to a brain in v1. Logging/saving is
    // independent of surfacing, same as transcripts.
    const _savedMedia = await persistMedia(msg, info, { voiceAtt: _voiceAtt, voicePath: _voicePath, voiceCaption: _voiceCaption });

    // Surface non-voice media to the model (operator 2026-06-16 regression): a
    // photo / gif / video / document must be ANNOUNCED so E sees it arrived and a
    // vision brain can Read the saved file. Voice is already in `text` (the
    // transcript), and audio is the transcribe path — skip both here. Without
    // this, media was saved to disk but the bridge returned before onIncoming, so
    // E never knew (e.g. "puedes ver lo que posteó ron?").
    // Surface media paths RELATIVE to the chat's conversation folder
    // (`media/<file>`), NEVER the absolute host path (GENOME §2.5; shared
    // `relMediaPath`). Applies to the saved attachment AND the Route-A frames.
    const _mediaLines = _savedMedia
      // Announce every saved attachment EXCEPT the voice note already in `text`.
      // (Was: `m.kind !== 'audio'` — which silently dropped a shared AUDIO FILE
      // like an .mp3 that wasn't a voice note, so E never knew it arrived and it
      // wasn't even logged — operator 2026-06-16. `inText` now excludes only the
      // transcribed voice note, so non-voice audio files surface like any media.)
      .filter((m) => m.savedPath && !m.isVoiceNote && !m.inText)
      .map((m) => {
        let line = `(${m.kind}${m.fileName ? ` ${m.fileName}` : ''}) [saved: ${relMediaPath(m.savedPath)}]`;
        // ROUTE A: a video is handed to E on a silver platter — keyframes the
        // host already extracted (Read them with your vision) + the audio
        // transcript. E never had to run anything.
        if (m.kind === 'video') {
          if (Array.isArray(m.framePaths) && m.framePaths.length) line += `\nframes (Read these): ${m.framePaths.map(relMediaPath).join('  ')}`;
          if (m.transcript) line += `\n(video transcription) ${m.transcript}`;
        }
        return line;
      });
    if (_mediaLines.length) text = [text, ..._mediaLines].filter(Boolean).join('\n');

    if (text == null) return;   // nothing to route — no text, no announceable media

    // Own-message suppression by persona MARKER: every message E sends starts with
    // its body_emoji, so an incoming that does is E's own (a re-ingested reply /
    // streamed edit). Drop it — reliable where the id/text echo race isn't (the
    // self-chat, where E posts as the operator). Keeps E out of its own context.
    if (personaEmoji && String(text).trimStart().startsWith(personaEmoji)) {
      onLog(`beeper: suppressed own persona message in [${info.title}] (marker ${personaEmoji})`);
      return;
    }

    const st = mentionStatus(text || '', wakeWords);
    // Quoted/replied-to target (operator 2026-07-04). Beeper carries a reply's quoted
    // message id as a BARE `linkedMessageID` (verified live 2026-06-16, MESSAGES-
    // FIRST-CLASS-PLAN — no inline quoted text/sender). We surface it two ways:
    //   1. `replyToId` rides into the dispatch line as `↩#<id>` (any reply, to anyone)
    //      so the model knows exactly which message is being answered — and can target
    //      it back with a /reply emit action;
    //   2. `replyToBot` is true when that quoted id is one WE sent (wasSentByUs) — the
    //      operator's complaint "when I reply to E it isn't notified, I have to include
    //      @e". Since the quoted content isn't inlined, the persona-marker check isn't
    //      possible; the sent-id set IS the signal. auto-mode already gates on it.
    const replyToId = msg.linkedMessageID ?? msg.replyToMessageID ?? msg.quotedMessageID ?? null;
    const replyToBot = !!(replyToId && wasSentByUs(chatID, replyToId));
    // 👂 PROMOTION OBSERVE-AND-CANCEL (operator 2026-07-11, Phase 3b ordered failover): a co-account
    // peer's 👂 arrives here as a NORMAL inbound (its account/process is not ours → not a self-echo;
    // our OWN 👂 is suppressed by isEcho far above, so this never self-cancels). When it is a 👂
    // (starts with the marker) REPLYING to a note we hold a pending promotion for, a higher rank has
    // posted → stand down and cancel our timer (else we'd double the echo). Correlated by reply-to id:
    // every 👂 is a quoted reply to its note (replyToMessageID = note.id), keyed by the SAME per-note
    // key the promotion was armed under (`${chatID}:${noteId}`). A reply that is NOT a 👂 (a human
    // replying to the note), or a 👂 to a different note, never cancels. NOT dedup — this only covers
    // an offline/slow higher rank; the rank itself is a deterministic upfront pre-assignment.
    if (replyToId && String(text ?? '').trimStart().startsWith(ECHO_MARKER)) {
      // markEchoObserved RECORDS the observation persistently (so a standby that arms its promotion
      // AFTER this 👂 still stands down — the arming-order double fix) AND cancels any already-armed
      // promotion, logging only on an actual cancel (its true return), exactly as cancelPromotion did.
      if (markEchoObserved(`${chatID}:${replyToId}`)) onLog(`beeper: 👂 promotion cancelled — observed echo for note ${replyToId} [${info.title}]`);
    }
    const from = {
      chatId: chatID,                       // opaque Beeper room id (for send-back)
      chatName: info.title,
      chatType: info.type === 'group' ? 'group' : 'private',
      network: acct || 'whatsapp',          // origin network (Beeper accountID); default 'whatsapp'
      userId: msg.senderID || chatID,
      // username / firstName / senderName ALL go through senderDisplay so the
      // operator's saved contact-list label NEVER leaks into the sender identity —
      // not even via the identity.build `senderName ?? firstName` fallback. ONE rule
      // for every sender incl. the owner (operator 2026-07-10): their OWN pushed name,
      // else a non-private id (number, then stable id) — NEVER the node's configured
      // userName, NEVER the saved label (operator 2026-07-03: privacy — the label
      // carries private annotations).
      username: senderDisplay(msg) || undefined,
      firstName: senderDisplay(msg) || undefined,
      senderName: senderDisplay(msg),
      isSender: !!msg.isSender,
      // OPERATOR authorization (gates slash/lifecycle commands host-side; a
      // non-operator's @e still reaches the persona via the host's persona-wake
      // exception). Two signals: Beeper's isSender (account owner, any device) OR
      // the delivered senderID being on the operator allowlist — because Beeper's
      // isSender is unreliable for the owner's own sends (fails even in the
      // self-chat, operator 2026-06-16), so we must authorize from the senderID
      // too. NEVER hardcode true — that authorizes every sender. `acct` is the
      // origin network so the host resolves the per-surface allowed_users.
      authorized: !!msg.isSender || isAllowedUser(msg.senderID, acct),
      atEStart: st.atEStart,
      atEAnywhere: st.atEAnywhere,
      backlog: isBacklog,                   // older than bridge start (a woken node's replay) → transcript-only, never dispatched
      replyToBot,                           // true when this is a reply to a message WE sent (gates a reply without @e)
      replyToId,                            // the quoted message id (→ `↩#<id>` in the dispatch line), null when not a reply
      isReaction: false,
      isTranscriptFromVoice: isVoice,
      msgKey: msg.id || null,
    };
    onLog(`beeper: incoming [${info.title}] ${msg.senderName}: ${JSON.stringify((text || '').slice(0, 60))} (atE=${st.atEAnywhere}${replyToBot ? ' replyToBot' : ''}${replyToId ? ` ↩${replyToId}` : ''}${isVoice ? ' voice' : ''})`);
    // Hand off to the host WITHOUT awaiting the reply turn. The host (spine) enqueues
    // this message synchronously — so this dispatch chain's ORDER into the spine is
    // preserved — and then owns per-conversation serialization, cross-conversation
    // concurrency, and placeholder-on-arrival. Awaiting the turn here would chain
    // every conversation's turn behind this transcription-ordering `_processing`
    // chain (a mid-train mention's placeholder would not appear until the prior turn
    // finished). The returned promise settles, never rejects; log any rejection.
    try { Promise.resolve(onIncoming?.(text, from)).catch((e) => onLog(`beeper: onIncoming threw — ${e?.message ?? e}`)); }
    catch (e) { onLog(`beeper: onIncoming threw — ${e?.message ?? e}`); }
  }

  // --- WebSocket afferent (subscribe '*', handle message.upserted) ---
  let ws = null, _stopped = false, _wsReady = false, _reconnectTimer = null;
  let _reconnectMs = RECONNECT_MIN_MS;   // backs off to RECONNECT_MAX_MS while Beeper is down
  let _processing = Promise.resolve();   // serialize dispatch (slow transcribe must not interleave)

  function connect() {
    if (_stopped || !token) return;
    ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${token}` } });
    ws.on('open', () => { lastWsOpenMs = Date.now(); onLog('beeper: WS open'); });
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
          if (!entry?.id) continue;
          // INBOUND normalization (operator 2026-07-03): shorten the chatID the
          // instant it enters — entry.chatID wins over ev.chatID when present
          // (same precedence the old `{ chatID: ev.chatID, ...entry }` spread
          // gave), so everything downstream (dispatch, reactions, edits, onMedia,
          // onIncoming's `from`) sees the SHORT id only.
          const msg = { ...entry, chatID: shortChatId(entry.chatID ?? ev.chatID) };
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
          const id = shortChatId(c.id);
          const prev = _chatCache.get(id);
          _chatCache.set(id, { title: c.title || id, type: c.type || 'single', isMuted: !!c.isMuted, accountID: c.accountID ?? prev?.accountID ?? null });
          _knownChatIds.add(id);
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
    async send(text, { chatId, chatName, replyToMessageID = null } = {}) {
      return await sendMessage(chatId ?? chatName, text, { replyToMessageID });
    },
    // Post a message and resolve its CONFIRMED Beeper message id (polls the
    // message list — same path startStreamMessage uses). Returns null on failure.
    // Use this when the caller needs to EDIT the message later (e.g. relay streaming).
    async sendAndGetId(text, { chatId, chatName } = {}) {
      const chatID = await resolveChatId(chatId ?? chatName);
      if (!chatID || !text) return null;
      const floor = await newestChatMsgId(chatID);   // pre-send floor: a stale same-text message can't be mistaken for this send
      const r = await sendMessage(chatID, text, {});
      if (!r) return null;
      return await resolveSentMessageId(chatID, text, { afterId: floor }) ?? null;
    },
    // In-place edit / delete by CONFIRMED message id (used by the show-think
    // stream; also available to callers that hold a real id).
    editMessage:   (chatId, messageId, text) => editMessage(chatId, messageId, text),
    deleteMessage: (chatId, messageId)       => deleteMessage(chatId, messageId),
    // Conversation-E limbs (ROADMAP §3): send a reaction / a media file; and the
    // fail-closed ownership probe (also drives inbound replyToBot). Reply-to already
    // rides send()'s replyToMessageID.
    sendReaction:  (chatId, messageId, key)  => sendReaction(chatId, messageId, key),
    sendMedia:     (chatId, filePath, opts)  => sendMedia(chatId, filePath, opts),
    wasSentByUs:   (chatId, messageId)       => wasSentByUs(chatId, messageId),
    // Deterministic-name surface (operator 2026-06-10): callers and slash
    // files work with names/slugs; room ids stay an internal detail.
    listChats,
    getChatName: (id) => _chatCache.get(shortChatId(id))?.title ?? null,
    getChatSlug: (id) => { const t = _chatCache.get(shortChatId(id))?.title; return t ? chatSlug(t) : null; },
    resolveChatId,
    // Surface parity with slash-file expectations (integrity test):
    // honest stubs where Beeper has no equivalent yet.
    myJid: null,   // no jid concept on this transport
    listEgptPinned: () => [],   // pins were a baileys-side feature
    setEgptPin: (..._a) => { onLog('beeper: setEgptPin not supported on this transport (yet)'); return null; },
    // Stream a bot reply into the chat as a REAL in-place editor: post the
    // placeholder, edit it live as the turn streams, finalize in place — ONE
    // message, never a separate "final" send. The edit lifecycle is OWNED HERE in
    // the bridge so every surface behaves identically. An 2026-06-20: edit-streaming
    // is a bridge PROPERTY of ANY bot reply (the operator's own typing never
    // streams — this only ever runs on a bot's generated reply). `showThink` only
    // adds the 🤔 placeholder + "✅ Done" marker (engineers); a plain reply (E)
    // finalizes to just its text. The host skips its fallback send only when the
    // stream reports `delivered`, so the handle MUST expose delivered (+ lastError).
    startStreamMessage(initialText, { chatId, chatName, persona, showThink = false, existingMsgId = null, replyToMessageID = null } = {}) {
      // ── universal in-place editor (every bot reply) ──────────────────────────
      let latest = initialText, finished = false, cid = null, realId = null;
      let lastEditAt = 0, editTimer = null, pendingText = null, chain = Promise.resolve();
      const EDIT_MIN_MS = 400;   // debounce live edits (operator 2026-06-29: 1.5s felt sluggish; local Beeper API is fast)
      const handle = { delivered: false, lastError: null };
      const serial = (fn) => (chain = chain.then(fn, fn));   // never overlap PUTs (final edit wins)

      // Post the placeholder NOW (so it shows immediately) + resolve its CONFIRMED
      // id (POST returns only a pending id). Mark it OURS so our live edits don't
      // surface as incoming edits, and rememberSent so the re-upsert is deduped.
      // CRUCIAL: post + resolve the FIXED `initialText`, NOT `latest` — update()
      // overwrites `latest` with partials before this resolves, so matching `latest`
      // hunts text the placeholder never had and fails ("could not resolve
      // placeholder id" → edits no-op → fallback fresh send). The edits (applyEdit,
      // which await `ready`) carry `latest` and land AFTER the id is known.
      const placeholder = initialText;
      const ready = (async () => {
        try {
          cid = await resolveChatId(chatId ?? chatName);
          if (!cid) { handle.lastError = 'no chat'; return; }
          if (existingMsgId) {
            // Caller already posted the placeholder and resolved its id — just wire.
            realId = existingMsgId;
            _ourStreamIds.add(msgKeyOf(cid, realId)); _capSet(_ourStreamIds, 200);
            return;
          }
          // Pre-send id floor (live landmine 2026-07-04, see resolveSentMessageId):
          // snapshot the chat's newest id BEFORE posting so a STALE identical-text
          // message — a previous turn's orphaned placeholder — can never be resolved
          // as THIS placeholder. Costs one local GET; without it the first poll races
          // the post's upsert and binds the stream to the old message, delivering the
          // whole reply invisibly into the scrollback.
          const floor = await newestChatMsgId(cid);
          const r = await sendMessage(cid, placeholder, { replyToMessageID });
          if (!r) { handle.lastError = 'placeholder send failed'; return; }
          realId = await resolveSentMessageId(cid, placeholder, { afterId: floor });
          if (realId) {
            _ourStreamIds.add(msgKeyOf(cid, realId)); _capSet(_ourStreamIds, 200);
            rememberSent(realId, cid, placeholder);
          } else { handle.lastError = 'could not resolve placeholder id'; onLog(`beeper: stream could not resolve placeholder id in ${cid} — edits will no-op (placeholder: ${JSON.stringify(String(placeholder).slice(0, 40))})`); }
        } catch (e) { handle.lastError = e?.message ?? String(e); }
      })();

      const applyEdit = (text) => serial(async () => {
        await ready;
        if (!cid || !realId) return false;
        rememberSent(realId, cid, text);   // our edit re-upserts this → suppress from dispatch
        return editMessage(cid, realId, text);
      });

      handle.update = (t) => {
        if (finished || !t) return;
        latest = t; pendingText = t;
        const now = Date.now();
        if (now - lastEditAt >= EDIT_MIN_MS) { lastEditAt = now; applyEdit(t); }
        else if (!editTimer) {
          editTimer = setTimeout(() => { editTimer = null; lastEditAt = Date.now(); if (pendingText != null) applyEdit(pendingText); }, EDIT_MIN_MS - (now - lastEditAt));
        }
      };
      handle.finish = async (t) => {
        if (finished) return; finished = true;
        if (editTimer) { clearTimeout(editTimer); editTimer = null; }
        if (t) latest = t;
        await ready;
        if (cid && realId) {
          const ok = await applyEdit(showThink ? `${latest}\n\n✅ Done` : latest);
          if (ok) handle.delivered = true; else handle.lastError = handle.lastError || 'final edit failed';
        }
        // Couldn't edit in place → drop the dangling placeholder so the spine's
        // fallback can send the reply fresh (delivered stays false).
        if (!handle.delivered && cid && realId) { await deleteMessage(cid, realId).catch(() => {}); }
      };
      handle.delete = async () => {
        finished = true;
        if (editTimer) { clearTimeout(editTimer); editTimer = null; }
        await ready;
        if (cid && realId) await deleteMessage(cid, realId).catch(() => {});
      };
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
  let transcribeCfg = null;
  try { const cfg = (await import('../tools/config-io.mjs')).readConfigSync(); media = cfg?.whatsapp?.media || {}; transcribeCfg = cfg?.transcription?.cli ?? cfg?.transcription?.whisper ?? cfg?.whatsapp?.media?.audio_transcribe ?? null; token = token || cfg?.beeper_token || cfg?.whatsapp?.beeper_token; } catch { /* ignore */ }
  startBeeperBridge({
    beeperToken: token,
    media,
    transcribeCfg,
    onLog: (m) => console.log('[beeper]', m),
    onIncoming: (text, from) => console.log('  INCOMING', JSON.stringify({ chat: from.chatName, sender: from.senderName, atE: from.atEAnywhere, voice: from.isTranscriptFromVoice, text: (text || '').slice(0, 80) })),
  }).then(() => console.log('beeper bridge running (Ctrl-C to stop) — send a WhatsApp message / voice note'));
}



