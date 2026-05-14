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
export async function buildWelcomeBack({ maxRecapLines = DEFAULT_RECAP_LINES, includeDms = false } = {}) {
  const since = _readLastLogonTs();
  const ago   = since ? _formatAgo(Date.now() - since) : null;

  const chats     = await _readChats();
  const reactions = await _readReactions();
  const files     = await _walkMediaFiles(since);

  const recap = await buildRecap({ max: maxRecapLines, includeDms });

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

  const lines = [];
  lines.push(ago
    ? `welcome back — since ${ago}.`
    : `welcome back — first logon since the engine started.`);

  if (recap) {
    lines.push('');
    for (const l of recap.text.split('\n')) lines.push('  ' + l);
  }

  if (files.length > 0) {
    const kindBits = Object.entries(filesByKind)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`);
    lines.push(`  📎 ${files.length} file${files.length === 1 ? '' : 's'} saved (${kindBits.join(' · ')}) → ${_formatSize(filesTotalBytes)}`);
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
    lines.push(`  💥 most-reacted: ${preview}${where}  [${emojiList}]`);
  }

  lines.push('');
  lines.push('  /last 50  ·  /channels 20 5  ·  /recap [N] [--all]  chronological recap');
  lines.push('  /wa-pending  ·  /tg-pending  for held messages awaiting review');

  return { text: lines.join('\n'), entries: recap?.entries ?? [] };
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
export async function buildRecap({ max = DEFAULT_RECAP_LINES, since = null, includeDms = false } = {}) {
  const chats = await _readChats();
  const recap = _collectRecent(chats, since, max, { includeDms });
  if (!recap.length) return null;
  const scope = includeDms ? 'all chats' : 'groups + status (no DMs)';
  const header = since
    ? `recap — last ${recap.length} msg${recap.length === 1 ? '' : 's'} since ${_formatAgo(Date.now() - since)} ago — ${scope}:`
    : `recap — last ${recap.length} msg${recap.length === 1 ? '' : 's'} — ${scope}:`;
  const lines = [header];
  const entries = [];
  // Insert a section header line when the section changes. recap is
  // already sorted section → chat → ts so a single pass suffices.
  let currentSection = null;
  for (const m of recap) {
    if (m.section !== currentSection) {
      currentSection = m.section;
      const label = SECTION_LABEL[m.section] ?? m.section;
      lines.push('');
      lines.push(`  ${label}`);
    }
    lines.push('    ' + _formatRecapLine(m));
    if (m.stableId && m.replyTarget) {
      entries.push({ stableId: m.stableId, replyTarget: m.replyTarget });
    }
  }
  lines.push('');
  if (!includeDms) lines.push('  (DMs hidden — /recap --all to include them)');
  lines.push('  reply with @<id> <body> — ids prefix-match, so the visible 8 chars are enough');
  return { text: lines.join('\n'), entries };
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
const SECTION_LABEL = {
  pinned: '📌 Pinned',
  group:  'Groups',
  status: 'Status feed',
  dm:     'DMs',
};

function _sectionForChat(c) {
  // Pin promotes — both layers count: `pinned` is WA's own pin (3-cap)
  // and `egptPinned` is the eGPT-side overlay (unlimited).
  if ((c.pinned || 0) > 0 || (c.egptPinned || 0) > 0) return 'pinned';
  if (c.jid === 'status@broadcast') return 'status';
  if (c.isGroup) return 'group';
  return 'dm';
}

function _collectRecent(chats, since, max, { includeDms = true } = {}) {
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
        replyTarget = {
          kind: 'wa',
          chatId: c.jid,
          key: { id: r.key.id, fromMe: !!r.key.fromMe, remoteJid: c.jid },
        };
      }
      all.push({
        ts: r.ts,
        author: r.author ?? '?',
        text: r.text,
        chatLabel: label,
        section,
        stableId,
        replyTarget,
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
  // ASC (stable per-chat block placement), then ts DESC inside each
  // chat block (latest message at the top of its block).
  const sectionRank = (s) => {
    const i = SECTION_ORDER.indexOf(s);
    return i < 0 ? SECTION_ORDER.length : i;
  };
  trimmed.sort((a, b) => {
    const ds = sectionRank(a.section) - sectionRank(b.section);
    if (ds !== 0) return ds;
    const dc = a.chatLabel.localeCompare(b.chatLabel);
    if (dc !== 0) return dc;
    return b.ts - a.ts;
  });
  return trimmed;
}

// One-liner format: HH:MM  <author>  <chat>  <body…>
// Columns padded for legibility on a typical terminal; the body
// gets the rest of the line and is snippeted to ~80 chars.
function _formatRecapLine(m) {
  const d = new Date(m.ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  // 8-char id prefix (after wa-/tg-) — enough to disambiguate within a
  // 30-row recap, and the shell's stable-id lookup prefix-matches
  // against the sidecar so typing @wa-AC8AD42D body resolves to the
  // full wa-<32-char> key. No trailing ellipsis: it'd suggest the
  // operator has to type more chars, but the visible prefix is what's
  // meant to be typed verbatim.
  const id = m.stableId ? _pad(m.stableId.slice(0, 11), 11) : _pad('', 11);
  const author = _pad(_short(m.author, 16), 16);
  const chat = _pad(_short(m.chatLabel, 30), 30);
  const body = _snippet(m.text, 72);
  return `${hh}:${mm}  ${id}  ${author}  ${chat}  ${body}`;
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
