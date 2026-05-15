// logon-summary.mjs — "while you were away" report shown when an
// interactive shell takes over from a headless engine (or from an
// earlier shell). Reads from disk only — no live bridge needed,
// the headless engine flushed everything synchronously on SIGTERM.
//
// Output shape (revised 2026-05-14):
//   welcome back — since 8h ago.
//
//     recap — last 30 msgs — all chats:
//       07:27  wa-AC8AD42D  Daniel        DM with Daniel              [voice note: 22s]
//       07:33  wa-3EB1AB72  Daniel        DM with Daniel              [voice note: 21s]
//       03:48  wa-AC2475B7  Andrés        SPOILER ALERT (group)       [sticker]
//       ... up to ~30 one-liner rows, each with a reply-able stable id
//     reply with @<id> <body> — ids prefix-match, visible 8 chars enough
//
//   📎 13 files saved (12 videos · 1 image) → 16.6MB
//   💥 most-reacted: "…" in <chat>  [3 👍, 1 ❤️]
//
//   /last 50  ·  /channels 20 5  ·  /recap [N] [--all]  chronological recap
//
// Rendered by the App-mount effect (not pre-mount) so each shown WA
// row's reply-target gets registered in the persisted sidecar — the
// operator can @wa-<id> straight from the welcome-back report.
//
// Sources:
//   ~/.egpt/wa-chats.json           per-chat messageCount + broadcastsByAuthor + recent[]
//   ~/.egpt/reaction-counts.json    msgId → reaction tally
//   ~/.egpt/media/<chat>/.media-index.json   files saved per chat
//   ~/.egpt/last-logon.json         { ts } — anchor for "since when"
//
// After rendering, the caller resets the counters and stamps a fresh
// last-logon timestamp; the next cycle starts at zero.

import { promises as fs, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const HOME = join(homedir(), '.egpt');
const CHATS_PATH       = join(HOME, 'wa-chats.json');
const REACTIONS_PATH   = join(HOME, 'reaction-counts.json');
const LAST_LOGON_PATH  = join(HOME, 'last-logon.json');
const MEDIA_DIR        = join(HOME, 'media');

// Previews per chat, default — /recap N now means "N previews per
// selected chat", not "N total messages". 3 reads like /channels
// (compact, scannable). Operator can /recap 1 for an even tighter
// view or /recap 10 to dive deeper without paging through /last.
const DEFAULT_PREVIEWS_PER_CHAT = 3;
// How many non-pinned chats to surface per section. Pinned chats
// always show in full (operator pinned them for a reason).
const DEFAULT_CHATS_PER_SECTION = 5;

// Returns { text, entries } so the App-mount effect can register each
// shown WA row in the shell's persisted reply-target sidecar (so
// '@wa-<id> body' jumps the operator into the conversation right
// away). Internally delegates to buildRecap for the chronological
// stream and stitches the welcome-back header + files + most-reacted
// blocks around it. Files / reactions still filter by `since` (those
// blocks represent the "what arrived while you were away" window);
// the recap rows do not, so the welcome-back is never empty when
// activity exists.
export async function buildWelcomeBack({
  maxRecapLines = DEFAULT_PREVIEWS_PER_CHAT,
  includeDms = false,
  emojis = null,
} = {}) {
  const since = _readLastLogonTs();
  const ago   = since ? _formatAgo(Date.now() - since) : null;

  const chats     = await _readChats();
  const reactions = await _readReactions();
  const files     = await _walkMediaFiles(since);

  const recap = await buildRecap({ max: maxRecapLines, includeDms, emojis, since });

  const filesByKind = files.reduce((acc, f) => {
    acc[f.kind] = (acc[f.kind] || 0) + 1;
    return acc;
  }, {});
  const filesTotalBytes = files.reduce((sum, f) => sum + (f.size || 0), 0);

  // Most-reacted: highest count overall. Ties broken by recency.
  const reactionEntries = Object.entries(reactions ?? {})
    .filter(([, r]) => (r?.count || 0) > 0)
    .sort((a, b) => {
      const dc = (b[1].count || 0) - (a[1].count || 0);
      if (dc !== 0) return dc;
      return (b[1].lastTs || 0) - (a[1].lastTs || 0);
    });
  const topReaction = reactionEntries[0]?.[1] ?? null;

  // Nothing to say?
  const empty = !recap && files.length === 0 && !topReaction;
  if (empty) return null;

  const titleText = ago
    ? `welcome back — since ${ago}.`
    : `welcome back — first logon since the engine started.`;

  // rows: structured for the Ink _recap renderer
  // lines: flat for the log/transcript fallback
  const rows = [{ type: 'title', text: titleText }];
  const lines = [titleText];

  if (recap) {
    rows.push({ type: 'blank' });
    lines.push('');
    // Recap rows already include their own title + section headers +
    // hint footer — splice them in as-is.
    for (const row of recap.rows) rows.push(row);
    for (const l of recap.text.split('\n')) lines.push('  ' + l);
  }

  if (files.length > 0) {
    const kindBits = Object.entries(filesByKind)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`);
    const t = `📎 ${files.length} file${files.length === 1 ? '' : 's'} saved (${kindBits.join(' · ')}) → ${_formatSize(filesTotalBytes)}`;
    rows.push({ type: 'hint', text: t });
    lines.push('  ' + t);
  }

  if (topReaction) {
    const emojiList = Object.entries(topReaction.emojis ?? {})
      .sort((a, b) => b[1] - a[1])
      .map(([e, n]) => `${n} ${e}`)
      .join(', ');
    const preview = topReaction.preview
      ? `"${topReaction.preview}"`
      : '(unknown message)';
    const inChat = topReaction.chatJid
      ? chats.find(c => c.jid === topReaction.chatJid)
      : null;
    const where = inChat ? ` in ${_chatDisplayLabel(inChat)}` : '';
    const t = `💥 most-reacted: ${preview}${where}  [${emojiList}]`;
    rows.push({ type: 'hint', text: t });
    lines.push('  ' + t);
  }

  rows.push({ type: 'blank' });
  rows.push({ type: 'hint', text: '/last 50  ·  /channels 20 5  ·  /recap [N] [--all]  chronological recap' });
  rows.push({ type: 'hint', text: '/wa-pending  ·  /tg-pending  for held messages awaiting review' });
  lines.push('');
  lines.push('  /last 50  ·  /channels 20 5  ·  /recap [N] [--all]  chronological recap');
  lines.push('  /wa-pending  ·  /tg-pending  for held messages awaiting review');

  return { text: lines.join('\n'), entries: recap?.entries ?? [], rows, chatList: recap?.chatList ?? [] };
}

// Reset the counters that the summary just consumed so the next
// "while you were away" window starts at zero. Idempotent — running
// this twice on the same disk state just no-ops the second pass.
export function resetCountersOnDisk() {
  try {
    if (existsSync(CHATS_PATH)) {
      const raw = readFileSync(CHATS_PATH, 'utf8');
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const c of arr) {
          if (!c || typeof c !== 'object') continue;
          c.messageCount = 0;
          if (c.jid === 'status@broadcast') c.broadcastsByAuthor = {};
        }
        writeFileSync(CHATS_PATH, JSON.stringify(arr, null, 2), { mode: 0o600 });
      }
    }
  } catch (_) {}
  try {
    if (existsSync(REACTIONS_PATH)) writeFileSync(REACTIONS_PATH, '{}', { mode: 0o600 });
  } catch (_) {}
}

export function writeLastLogonNow() {
  try {
    writeFileSync(LAST_LOGON_PATH, JSON.stringify({ ts: Date.now() }), { mode: 0o600 });
  } catch (_) {}
}

// Public helper for the /recap slash command. Reads the same data
// sources as the summary but lets the caller pick how many lines and
// optionally how far back. Without `since`, walks every recent[]
// entry and returns the most recent `max`.
// Returns { text, entries } so the slash-command caller can register
// each shown row's reply-target in the shell's persisted sidecar —
// that makes '@wa-<id> body' resolvable for messages the operator
// never directly interacted with (recent[] in wa-chats.json doesn't
// pre-populate the sidecar; only items that landed in the App's
// `items` array do). Without registration the displayed ids would
// be cosmetic; with it, /recap becomes an actual jump-into-the-
// conversation surface.
// Curated /recap: a chat-list (like /channels) with N previews per
// chat. Sections in fixed order — pinned chats float regardless of
// kind, then top-K unpinned groups, then status feed, then top-K
// unpinned DMs (only with includeDms). Operator's policy:
//   • pinned chats always show in full (they pinned them for a reason)
//   • top 5 unpinned per kind by lastActivityTs (most-recent first)
//   • each chat shows its last `max` recent[] previews
//   • output mirrors /channels visually: header line + indented
//     `author: body` previews, no per-row id or timestamp
//
// Returns { text, entries, rows, chatList } — entries register reply
// targets, chatList overwrites waChannelsCacheRef so '@waN' resolves
// to the same chat the operator just read.
export async function buildRecap({
  max = DEFAULT_PREVIEWS_PER_CHAT,
  chatsPerSection = DEFAULT_CHATS_PER_SECTION,
  since = null,
  includeDms = false,
  emojis = null,
} = {}) {
  const chats = await _readChats();
  const mediaIndex = await _loadMediaIndex();
  const emo = { ...DEFAULT_EMOJI, ...(emojis || {}) };

  const isPinned = (c) => (c.pinned || 0) > 0 || (c.egptPinned || 0) > 0;
  const isStatus = (c) => c.jid === 'status@broadcast';
  const isGroup  = (c) => !!c.isGroup && !isStatus(c);
  const isDm     = (c) => !c.isGroup && !isStatus(c);
  const recencyDesc = (a, b) => (b.lastActivityTs || 0) - (a.lastActivityTs || 0);

  // Unreplied = chat has a recent[] tail whose latest entry is from
  // someone OTHER than the operator. The operator owes a reply.
  const isUnreplied = (c) => {
    const recent = Array.isArray(c.recent) ? c.recent : [];
    if (!recent.length) return false;
    const last = recent[recent.length - 1];
    return last.author && last.author !== 'You';
  };

  // Selection by section.
  //   Pinned         all chats with pinned > 0 (operator priority)
  //   Unreplied DMs  always visible — these are conversations the
  //                  operator is on the hook for. Excluded from
  //                  the plain DMs section so they don't double up.
  //   Groups         top 5 non-pinned by lastActivityTs
  //   Status         top 5 non-pinned posters
  //   DMs            with --all: top 5 OTHER DMs (already-replied or
  //                  quiet). Without --all, hidden; the unreplied
  //                  ones still show in their own section above.
  const pinnedChats   = chats.filter(isPinned).sort(recencyDesc);
  const unrepliedDms  = chats.filter(c => isDm(c) && !isPinned(c) && isUnreplied(c)).sort(recencyDesc);
  const groupsTop     = chats.filter(c => isGroup(c)  && !isPinned(c)).sort(recencyDesc).slice(0, chatsPerSection);
  const statusTop     = chats.filter(c => isStatus(c) && !isPinned(c)).sort(recencyDesc).slice(0, chatsPerSection);
  const otherDmsTop   = includeDms
    ? chats.filter(c => isDm(c) && !isPinned(c) && !isUnreplied(c)).sort(recencyDesc).slice(0, chatsPerSection)
    : [];

  const sections = [
    { kind: 'pinned',     chats: pinnedChats,   capped: false },
    { kind: 'unrepliedDm',chats: unrepliedDms,  capped: false, label: 'Unreplied DMs' },
    { kind: 'group',      chats: groupsTop,     capped: groupsTop.length === chatsPerSection },
    { kind: 'status',     chats: statusTop,     capped: false },
    { kind: 'dm',         chats: otherDmsTop,   capped: otherDmsTop.length === chatsPerSection, label: 'Other DMs' },
  ];

  if (!sections.some(s => s.chats.length)) return null;

  // Build chatList in display order so @waN resolves correctly.
  const chatList = [];
  for (const s of sections) for (const c of s.chats) chatList.push(c);

  // Header summary fragments. Each is an independent computation
  // that contributes a count + label to the title line; this is
  // the seed of the "behavioral plugin" shape the operator wants —
  // future watchers (whisper transcripts, btc ticker, calendar
  // reminders, todo nudges) plug in here without restructuring
  // the recap. Today: unreplied DMs + groups with You-not-last,
  // plus status post count since `since`.
  const summaries = [];

  // Unreplied count for the header — share isUnreplied() defined
  // above. Names suffixed `Count` to avoid colliding with the
  // section chat arrays that already live as unrepliedDms.
  const unrepliedDmCount = chats.filter(c => isDm(c) && !isPinned(c) && isUnreplied(c)).length;
  if (unrepliedDmCount) summaries.push(`${unrepliedDmCount} unreplied DM${unrepliedDmCount === 1 ? '' : 's'}`);
  const unrepliedGroupCount = chats.filter(c => isGroup(c) && !isPinned(c) && isUnreplied(c)).length;
  if (unrepliedGroupCount) summaries.push(`${unrepliedGroupCount} active group${unrepliedGroupCount === 1 ? '' : 's'}`);

  // Status posts since the cutoff (or total stored if no cutoff).
  const statusChat = chats.find(c => isStatus(c));
  const statusCount = statusChat && Array.isArray(statusChat.recent)
    ? (since ? statusChat.recent.filter(r => r.ts >= since).length : statusChat.recent.length)
    : 0;
  if (statusCount) summaries.push(`${statusCount} status post${statusCount === 1 ? '' : 's'}`);

  // _formatAgo already appends ' ago' (e.g. '8h ago'); don't double-stamp it.
  const sinceClause = since ? ` since ${_formatAgo(Date.now() - since)}` : '';
  const summaryClause = summaries.length
    ? ' · ' + summaries.join(' · ')
    : (since ? ' · caught up' : '');
  const dmsClause = includeDms ? '' : ' (DMs hidden — --all)';
  const titleText = `recap${summaryClause}${sinceClause}${dmsClause}`;

  const rows = [{ type: 'title', text: titleText }];
  const lines = [titleText];
  const entries = [];
  let waIdx = 0;

  for (const section of sections) {
    if (!section.chats.length) continue;
    const emoji = emo[section.kind] ?? emo.dm ?? '';
    const label = section.label ?? SECTION_LABEL_TEXT[section.kind] ?? section.kind;
    const more = section.capped ? ` (top ${chatsPerSection})` : '';
    rows.push({ type: 'blank' });
    rows.push({ type: 'section', section: section.kind, emoji, label: label + more });
    lines.push('');
    lines.push(`  ${emoji} ${label}${more}`);

    for (const c of section.chats) {
      waIdx++;
      const kindTag = isStatus(c) ? 'status' : (isGroup(c) ? 'group' : '1:1');
      const displayName = (c.name && c.name.trim() ? c.name.trim() : (c.jid?.split('@')[0] ?? '?'))
        .replace(/\s+\(group\)$/, '')
        .replace(/^DM with\s+/, '');
      // _formatAgo already appends "ago" (e.g. "5m ago"); don't double it.
      const ageText = c.lastActivityTs > 0
        ? _formatAgo(Date.now() - c.lastActivityTs)
        : (c.creationTs > 0 ? 'dormant' : 'never');
      rows.push({
        type: 'chat-header',
        section: section.kind,
        waIdx,
        pinned: isPinned(c),
        kindTag,
        chatLabel: displayName,
        age: ageText,
      });
      const pin = isPinned(c) ? '📌 ' : '';
      lines.push(`    ${pin}@wa${waIdx}  [${kindTag}]  ${displayName}  (${ageText})`);

      // Last `max` previews from this chat's recent[]. Skip empty
      // bodies; register each preview's reply-target.
      const recent = Array.isArray(c.recent) ? c.recent : [];
      const slice = recent.filter(r => r && typeof r.text === 'string' && r.text.trim() && r.ts).slice(-max);
      for (const r of slice) {
        let stableId = null, replyTarget = null;
        if (r.key?.id) {
          stableId = `wa-${r.key.id}`;
          replyTarget = {
            kind: 'wa',
            chatId: c.jid,
            key: { id: r.key.id, fromMe: !!r.key.fromMe, remoteJid: c.jid },
            raw: { conversation: r.text },
          };
          entries.push({ stableId, replyTarget });
        }
        const enriched = _enrichStoredReaction(r.text, chats);
        let mediaPath = null;
        if (mediaIndex && r.key?.id) {
          const m = mediaIndex.get(r.key.id);
          if (m?.path) mediaPath = m.path;
        }
        rows.push({
          type: 'preview',
          section: section.kind,
          author: r.author ?? '?',
          body: enriched,
          stableId,
          ts: r.ts,
          mediaPath,
        });
        // Flat-text fallback: include the id + HH:MM at the end so
        // operator can copy/paste from log dumps. The renderer's
        // 'preview' branch formats this with per-segment colors.
        const d = r.ts ? new Date(r.ts) : null;
        const hhmm = d ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '';
        const idDisp = stableId ? stableId.replace(/^([a-z]+)-/, '$1_').slice(0, 11) : '';
        lines.push(`       ${r.author ?? '?'}: ${enriched.replace(/\s+/g, ' ').trim()}  ${idDisp}  ${hhmm}`);
      }
    }
  }

  rows.push({ type: 'blank' });
  rows.push({ type: 'hint', text: '@waN to address a chat · @<id> <body> to reply · /recap N for more previews · /recap --all for DMs' });
  lines.push('');
  lines.push('  @waN to address a chat · @<id> <body> to reply · /recap N for more previews · /recap --all for DMs');

  return { text: lines.join('\n'), entries, rows, chatList };
}

// Collect recent[] entries across all observed chats into one
// chronological list — status@broadcast included (status posts ride
// the same recap path as DMs / groups since 2026-05-14 per operator
// preference; the chat label "WA status feed" tags them clearly
// without needing a separator section). Filters by `since` when set;
// takes the most recent `max` entries.
// Section ordering for the rendered recap. Pinned chats float above
// everything regardless of group/DM/status kind — the operator
// pinned them precisely because they want them in front. The
// remaining sections follow in the order most readers scan: groups
// (multi-speaker rooms), status feed (broadcast-style updates),
// then DMs (1:1s, usually noisier and read elsewhere).
const SECTION_ORDER = ['pinned', 'group', 'status', 'dm'];
const SECTION_LABEL_TEXT = {
  pinned: 'Pinned',
  group:  'Groups',
  status: 'Status feed',
  dm:     'DMs',
};
// Default emojis — overridable per-theme via the `emojis` param to
// buildRecap / buildWelcomeBack. The slash command and App-mount
// effect look them up from the active theme (T.recapEmoji*) and pass
// them through; callers that don't care (tools, tests, direct CLI
// dumps) get these defaults.
const DEFAULT_EMOJI = {
  pinned: '📌',
  group:  '👥',
  status: '📡',
  dm:     '💬',
};

function _sectionForChat(c) {
  // Pin promotes — both layers count: `pinned` is WA's own pin (3-cap)
  // and `egptPinned` is the eGPT-side overlay (unlimited).
  if ((c.pinned || 0) > 0 || (c.egptPinned || 0) > 0) return 'pinned';
  if (c.jid === 'status@broadcast') return 'status';
  if (c.isGroup) return 'group';
  return 'dm';
}

// Re-enrich a reaction placeholder ('[reaction <emoji> (msg <8-char
// prefix>)]') by looking the parent up in two sources, in order:
//   1. msg-body cache on disk (~/.egpt/msg-body-cache.json) — keyed
//      by full WA stanza id, populated by the bridge across sessions
//      so it survives bridge restarts and is wider than any single
//      chat's recent[] ring.
//   2. Each chat's recent[] (fallback for very fresh entries that
//      may not have hit the debounced disk write yet).
// Prefix-matches the 8-char placeholder id against both sources;
// first hit wins.
const _MSG_BODY_CACHE_PATH = join(HOME, 'msg-body-cache.json');
let _msgBodyCache = null;
function _loadMsgBodyCache() {
  if (_msgBodyCache) return _msgBodyCache;
  _msgBodyCache = new Map();
  try {
    if (existsSync(_MSG_BODY_CACHE_PATH)) {
      const raw = readFileSync(_MSG_BODY_CACHE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const [keyId, preview] of Object.entries(parsed)) {
          if (typeof keyId === 'string' && typeof preview === 'string') {
            _msgBodyCache.set(keyId, preview);
          }
        }
      }
    }
  } catch (_) { /* corrupt file — keep an empty map */ }
  return _msgBodyCache;
}
function _findByKeyPrefix(chats, prefix) {
  if (!prefix) return null;
  const cache = _loadMsgBodyCache();
  // Cache lookup: exact match on full id (placeholder prefix is 8
  // chars; cache keys are the full ~32-char WA stanza id, so we scan
  // for any cached id that startsWith prefix). 4000-cap Map iteration
  // is cheap.
  for (const [keyId, preview] of cache.entries()) {
    if (keyId.startsWith(prefix) && preview) return preview;
  }
  for (const c of chats) {
    if (!Array.isArray(c.recent)) continue;
    for (const r of c.recent) {
      if (r?.key?.id?.startsWith(prefix) && r?.text) return r.text;
    }
  }
  return null;
}

const _REACTION_PLACEHOLDER_RE = /^\[reaction\s+(\S+)\s+\(msg\s+([A-Za-z0-9]+)\)\]$/;
const _REACTION_REMOVED_RE     = /^\[reaction\s+removed\s+\(msg\s+([A-Za-z0-9]+)\)\]$/;
function _enrichStoredReaction(text, chats) {
  if (typeof text !== 'string') return text;
  let m = text.match(_REACTION_PLACEHOLDER_RE);
  if (m) {
    const parent = _findByKeyPrefix(chats, m[2]);
    if (!parent) return text;
    const oneLine = parent.replace(/\s+/g, ' ').trim();
    const snippet = oneLine.length > 60 ? oneLine.slice(0, 59) + '…' : oneLine;
    return `[reaction ${m[1]} to "${snippet}"]`;
  }
  m = text.match(_REACTION_REMOVED_RE);
  if (m) {
    const parent = _findByKeyPrefix(chats, m[1]);
    if (!parent) return text;
    const oneLine = parent.replace(/\s+/g, ' ').trim();
    const snippet = oneLine.length > 60 ? oneLine.slice(0, 59) + '…' : oneLine;
    return `[reaction removed from "${snippet}"]`;
  }
  return text;
}

function _collectRecent(chats, since, max, { includeDms = true, mediaIndex = null } = {}) {
  const all = [];
  for (const c of chats) {
    if (!Array.isArray(c.recent)) continue;
    const section = _sectionForChat(c);
    // DMs are gated by includeDms unless pinned — pinned promotes
    // regardless of kind so the operator can opt a single 1:1 into
    // the default view without flipping --all on the whole recap.
    if (!includeDms && section === 'dm') continue;
    const label = _chatDisplayLabel(c);
    for (const r of c.recent) {
      if (!r || typeof r.text !== 'string' || !r.text.trim()) continue;
      if (!r.ts) continue;
      if (since && r.ts < since) continue;
      // Build the WA reply-target from the persisted key. recent[]
      // only carries the WA bridge today (TG doesn't write recent[]
      // entries through this path), so the stable id is always
      // wa-<full key.id> when key.id is present. Full id is stored;
      // display truncates to 8 chars (prefix-match resolves either
      // form at @-reply time).
      let stableId = null, replyTarget = null;
      if (r.key && typeof r.key.id === 'string' && r.key.id) {
        stableId = `wa-${r.key.id}`;
        // Synthesize `raw` from the persisted recent[] body so when
        // the operator @-replies to this row, wa.replyTo can feed
        // baileys a quoted-message with actual content. Without raw,
        // bridges/whatsapp.mjs falls back to { conversation: '' },
        // WA propagates the empty quote, and when the echo bounces
        // back through textOf it renders as '(unsupported message)'.
        // For media-typed rows the body is a bracketed placeholder
        // ('[image] caption') — not pristine, but still readable as
        // a text-quote and far better than the confusing fallback.
        const quotedBody = (typeof r.text === 'string' && r.text.trim()) ? r.text : '';
        replyTarget = {
          kind: 'wa',
          chatId: c.jid,
          key: { id: r.key.id, fromMe: !!r.key.fromMe, remoteJid: c.jid },
          raw: { conversation: quotedBody },
        };
      }
      // Media path lookup — when this message had an image/video/
      // audio/etc saved to disk by the WA bridge, attach the abs path
      // so the renderer can wrap the body cell in an OSC 8 hyperlink
      // (Ctrl/Cmd+click to open). Index key is the WA msg id from
      // r.key.id; the bridge's onMediaSaved hook is the source of
      // truth for these entries.
      let mediaPath = null;
      if (mediaIndex && r.key?.id) {
        const m = mediaIndex.get(r.key.id);
        if (m?.path) mediaPath = m.path;
      }
      all.push({
        ts: r.ts,
        author: r.author ?? '?',
        // Re-enrich '[reaction X (msg <prefix>)]' placeholders that
        // were persisted before the bridge's silent-track enrichment
        // shipped — looks the parent up by key prefix across every
        // chat's recent[]. If the parent's no longer on disk, the
        // placeholder stays unchanged.
        text: _enrichStoredReaction(r.text, chats),
        chatLabel: label,
        section,
        stableId,
        replyTarget,
        mediaPath,
        chat: c,
      });
    }
  }
  // Trim to `max` with pinned-priority: pinned entries take slots
  // first (newest first), then non-pinned fill the remainder by ts
  // DESC. So pinning a chat guarantees its recent activity is in
  // the report even when a noisy non-pinned chat would otherwise
  // crowd the budget. The re-sort below restores section grouping.
  all.sort((a, b) => {
    const ap = a.section === 'pinned' ? 0 : 1;
    const bp = b.section === 'pinned' ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return b.ts - a.ts;
  });
  const trimmed = all.slice(0, max);
  // Display order: by section (per SECTION_ORDER), then by chatLabel
  // ASC (stable per-chat block placement), then ts ASC inside each
  // chat block — reads like a play, oldest line first, latest at the
  // bottom. (Trim sort above stays DESC to pick the latest `max`.)
  const sectionRank = (s) => {
    const i = SECTION_ORDER.indexOf(s);
    return i < 0 ? SECTION_ORDER.length : i;
  };
  trimmed.sort((a, b) => {
    const ds = sectionRank(a.section) - sectionRank(b.section);
    if (ds !== 0) return ds;
    const dc = a.chatLabel.localeCompare(b.chatLabel);
    if (dc !== 0) return dc;
    return a.ts - b.ts;
  });
  return trimmed;
}

// One-liner format: HH:MM  <author>  <chat>  <body…>
// Columns padded for legibility on a typical terminal; the body
// gets the rest of the line and is snippeted to ~80 chars.
// Swap the leading kind prefix's dash for an underscore so terminal
// double-click selects the whole id ('wa_AC8AD42D' grabs as one
// token, 'wa-AC8AD42D' splits at the hyphen). Internal hyphens
// elsewhere in the id (e.g. tg-<chatId>-<msgId>) stay as hyphens —
// only the leading kind separator changes. The @-reply handler
// accepts either form (normalizes underscore → hyphen before sidecar
// lookup), so the canonical hyphenated form stays in storage.
function _displayId(stableId) {
  if (!stableId) return '';
  return stableId.replace(/^([a-z]+)-/, '$1_');
}

// `cont` collapses the author label when the speaker is unchanged
// from the previous row in the same chat block; the row indents
// further to signal continuation. The chat label itself moves into
// its own header line (emitted once per chat block in buildRecap),
// so individual row format is just `<author>: <body>  <id>  <time>`
// for speaker rows and `  <body>  <id>  <time>` for continuations.
function _formatRecapLine(m, cont = false) {
  const d = new Date(m.ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const id = _displayId(m.stableId).slice(0, 11);
  // Body: flatten newlines so the row stays one logical line (id +
  // time still need to land at the end), but no length truncation —
  // operator wants the full message text "like a play". The terminal
  // soft-wraps long bodies naturally.
  const body = String(m.text ?? '').replace(/\s+/g, ' ').trim();
  if (cont) {
    return `  ${body}  ${id}  ${hh}:${mm}`;
  }
  const author = _short(m.author, 28);
  return `${author}: ${body}  ${id}  ${hh}:${mm}`;
}

// Truncate s to maxLen with a trailing ellipsis when clipped.
function _short(s, maxLen) {
  if (!s) return '';
  return s.length <= maxLen ? s : s.slice(0, maxLen - 1) + '…';
}

// Left-pad s with spaces to width.
function _pad(s, width) {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function _readLastLogonTs() {
  try {
    const raw = readFileSync(LAST_LOGON_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const ts = Number(parsed?.ts);
    return Number.isFinite(ts) && ts > 0 ? ts : null;
  } catch { return null; }
}

async function _readChats() {
  try {
    if (!existsSync(CHATS_PATH)) return [];
    const raw = await fs.readFile(CHATS_PATH, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

async function _readReactions() {
  try {
    if (!existsSync(REACTIONS_PATH)) return {};
    const raw = await fs.readFile(REACTIONS_PATH, 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch { return {}; }
}

// Build a msgId → { kind, path } map from every ~/.egpt/media/<chat>/
// .media-index.json. Used by /recap to attach a clickable filesystem
// path to media rows ([image] / [video] / [voice note] …) so the
// operator can Ctrl/Cmd+click the body cell to open the file in
// their OS viewer. Returns an empty Map if the media dir doesn't
// exist yet — first-run shells without any saved media still work.
async function _loadMediaIndex() {
  const out = new Map();
  let chatDirs = [];
  try { chatDirs = await fs.readdir(MEDIA_DIR); } catch { return out; }
  for (const chatDir of chatDirs) {
    const idxPath = join(MEDIA_DIR, chatDir, '.media-index.json');
    if (!existsSync(idxPath)) continue;
    let idx = {};
    try { idx = JSON.parse(await fs.readFile(idxPath, 'utf8')); } catch { continue; }
    for (const [msgId, entry] of Object.entries(idx ?? {})) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.deleted) continue;
      if (entry.path) out.set(msgId, { kind: entry.kind || 'file', path: entry.path });
    }
  }
  return out;
}

async function _walkMediaFiles(since) {
  const out = [];
  let chatDirs = [];
  try { chatDirs = await fs.readdir(MEDIA_DIR); } catch { return out; }
  for (const chatDir of chatDirs) {
    const idxPath = join(MEDIA_DIR, chatDir, '.media-index.json');
    if (!existsSync(idxPath)) continue;
    let idx = {};
    try { idx = JSON.parse(await fs.readFile(idxPath, 'utf8')); } catch { continue; }
    for (const [msgId, entry] of Object.entries(idx ?? {})) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.deleted) continue;
      const ts = Number(entry.ts) || 0;
      if (since && ts < since) continue;
      let size = 0;
      try { const st = await fs.stat(entry.path); size = st.size; } catch {}
      out.push({ msgId, kind: entry.kind || 'file', ts, size, path: entry.path });
    }
  }
  return out;
}

function _chatDisplayLabel(c) {
  if (c.jid === 'status@broadcast') return 'WA status feed';
  const isGroup = !!c.isGroup;
  const fallback = c.jid?.split('@')[0]?.split(':')[0] ?? '?';
  const name = (c.name && c.name.trim()) ? c.name.trim() : fallback;
  return isGroup ? `${name} (group)` : `DM with ${name}`;
}

function _snippet(text, max = 70) {
  if (!text) return '';
  const oneLine = String(text).replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max - 1) + '…';
}

function _formatAgo(ms) {
  if (ms < 60_000)        return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000)     return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000)    return `${(ms / 3_600_000).toFixed(1)}h ago`;
  return `${(ms / 86_400_000).toFixed(1)}d ago`;
}

function _formatSize(bytes) {
  if (bytes < 1024)         return `${bytes}B`;
  if (bytes < 1024 * 1024)  return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 ** 3)    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)}GB`;
}
