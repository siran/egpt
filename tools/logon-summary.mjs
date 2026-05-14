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

const DEFAULT_RECAP_LINES = 30;

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
  maxRecapLines = DEFAULT_RECAP_LINES,
  includeDms = false,
  emojis = null,
} = {}) {
  const since = _readLastLogonTs();
  const ago   = since ? _formatAgo(Date.now() - since) : null;

  const chats     = await _readChats();
  const reactions = await _readReactions();
  const files     = await _walkMediaFiles(since);

  const recap = await buildRecap({ max: maxRecapLines, includeDms, emojis });

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
export async function buildRecap({
  max = DEFAULT_RECAP_LINES,
  since = null,
  includeDms = false,
  emojis = null,
} = {}) {
  const chats = await _readChats();
  const mediaIndex = await _loadMediaIndex();
  const recap = _collectRecent(chats, since, max, { includeDms, mediaIndex });
  if (!recap.length) return null;
  const emo = { ...DEFAULT_EMOJI, ...(emojis || {}) };
  const scope = includeDms ? 'all chats' : 'groups + status (no DMs)';
  const titleText = since
    ? `recap — last ${recap.length} msg${recap.length === 1 ? '' : 's'} since ${_formatAgo(Date.now() - since)} ago — ${scope}:`
    : `recap — last ${recap.length} msg${recap.length === 1 ? '' : 's'} — ${scope}:`;

  // Build two parallel outputs: the structured `rows` for the Ink
  // renderer's _recap branch (per-segment colors per row) and the
  // flat `text` for the transcript / log fallback. Both walk the
  // same recap list in lockstep.
  const rows = [{ type: 'title', text: titleText }];
  const lines = [titleText];
  const entries = [];
  // chatList collects the chats in display order so the caller can
  // overwrite waChannelsCacheRef.current — that way the operator can
  // type '@wa3 hello' (or /join @wa3, /pin @wa3 …) right off the
  // recap output without bouncing through /channels first. The waIdx
  // shown on each chat header is 1-based and increments in the same
  // order chats appear here.
  const chatList = [];
  const chatIdxByJid = new Map();
  let currentSection = null;
  let prevChat = null, prevAuthor = null;
  for (const m of recap) {
    if (m.section !== currentSection) {
      currentSection = m.section;
      const emoji = emo[m.section] ?? '';
      const label = SECTION_LABEL_TEXT[m.section] ?? m.section;
      rows.push({ type: 'blank' });
      rows.push({ type: 'section', section: m.section, emoji, label });
      lines.push('');
      lines.push(`  ${emoji} ${label}`);
      prevChat = null; prevAuthor = null;
    }
    if (m.chatLabel !== prevChat) {
      // New chat block within this section. Strip the section-redundant
      // suffix / prefix from the display title — section header above
      // already says 'Groups' / 'DMs' / 'Status feed', so 'Auge family
      // (group)' becomes 'Auge family' and 'DM with Daniel' becomes
      // 'Daniel'. The internal chatLabel (used for grouping + repeat
      // tracking) keeps the original form.
      const displayChat = m.chatLabel
        .replace(/\s+\(group\)$/, '')
        .replace(/^DM with\s+/, '');
      // Assign @waN by display order; dedupe on jid in case a chat
      // appears in multiple sections (shouldn't, but safe).
      let waIdx = chatIdxByJid.get(m.chat?.jid);
      if (waIdx == null && m.chat) {
        chatList.push(m.chat);
        waIdx = chatList.length;
        chatIdxByJid.set(m.chat.jid, waIdx);
      }
      rows.push({ type: 'blank' });
      rows.push({
        type: 'chat',
        section: m.section,
        chatLabel: displayChat,
        waIdx,
      });
      lines.push('');
      lines.push(`    @wa${waIdx}  ${displayChat}`);
      prevChat = m.chatLabel;
      prevAuthor = null;
    }
    const cont = (m.author === prevAuthor);
    rows.push({
      type: 'row',
      section: m.section,
      ts: m.ts,
      stableId: m.stableId ?? '',
      author: m.author ?? '?',
      chatLabel: m.chatLabel,
      body: m.text,
      mediaPath: m.mediaPath ?? null,
      cont,
    });
    lines.push('    ' + _formatRecapLine(m, cont));
    if (m.stableId && m.replyTarget) {
      entries.push({ stableId: m.stableId, replyTarget: m.replyTarget });
    }
    prevAuthor = m.author;
  }
  rows.push({ type: 'blank' });
  lines.push('');
  if (!includeDms) {
    rows.push({ type: 'hint', text: '(DMs hidden — /recap --all to include them)' });
    lines.push('  (DMs hidden — /recap --all to include them)');
  }
  rows.push({ type: 'hint', text: 'reply with @<id> <body>, or address a chat with @waN — ids prefix-match' });
  lines.push('  reply with @<id> <body>, or address a chat with @waN — ids prefix-match');
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
        text: r.text,
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
