// logon-summary.mjs — "while you were away" report shown when an
// interactive shell takes over from a headless engine (or from an
// earlier shell). Reads from disk only — no live bridge needed,
// the headless engine flushed everything synchronously on SIGTERM.
//
// Sources:
//   ~/.egpt/wa-chats.json           per-chat messageCount + broadcastsByAuthor
//   ~/.egpt/reaction-counts.json    msgId -> { count, emojis, preview, chatJid, lastTs }
//   ~/.egpt/media/<chatJid>/.media-index.json   files saved per chat
//   ~/.egpt/last-logon.json         { ts } — anchor for "since when"
//
// After rendering, the caller is expected to:
//   1. Reset the persistent counters (resetCountersOnDisk) so the next
//      summary starts from zero / fresh.
//   2. Write last-logon = now for the next cycle.
//
// Returns null when nothing is worth reporting (zero new messages,
// zero files, zero reactions); the caller skips the banner in that
// case. Otherwise returns a multi-line string ready to console.log.

import { promises as fs, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const HOME = join(homedir(), '.egpt');
const CHATS_PATH       = join(HOME, 'wa-chats.json');
const REACTIONS_PATH   = join(HOME, 'reaction-counts.json');
const LAST_LOGON_PATH  = join(HOME, 'last-logon.json');
const MEDIA_DIR        = join(HOME, 'media');

export async function buildLogonSummary() {
  const since = _readLastLogonTs();
  const ago   = since ? _formatAgo(Date.now() - since) : null;

  const chats     = await _readChats();
  const reactions = await _readReactions();
  const files     = await _walkMediaFiles(since);

  // Exclude status@broadcast from the inbox count — it has its own
  // "📡 status posts" line and merging them inflates the headline.
  const totalMessages = chats
    .filter(c => c.jid !== 'status@broadcast')
    .reduce((sum, c) => sum + (c.messageCount || 0), 0);
  // Order: pinned chats first (WA-pin status mirrors the user's own
  // priority signal), then by messageCount desc among the rest.
  // Pinned chats with 0 activity since last logon still take a slot
  // when they have at least 1 msg — without that the line goes blank.
  const topChats = chats
    .filter(c => (c.messageCount || 0) > 0 && c.jid !== 'status@broadcast')
    .sort((a, b) => {
      const ap = (a.pinned || 0) > 0 ? 1 : 0;
      const bp = (b.pinned || 0) > 0 ? 1 : 0;
      if (ap !== bp) return bp - ap;
      return (b.messageCount || 0) - (a.messageCount || 0);
    })
    .slice(0, 5);

  // status@broadcast lives in its own chat entry; pull out its
  // broadcastsByAuthor for the "who posted stories" breakdown.
  const status = chats.find(c => c.jid === 'status@broadcast');
  const statusTotal = status?.messageCount || 0;
  const statusByAuthor = status?.broadcastsByAuthor ?? {};
  const topStatusAuthors = Object.entries(statusByAuthor)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);

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
  const empty = totalMessages === 0 && statusTotal === 0
    && files.length === 0 && !topReaction;
  if (empty) return null;

  const lines = [];
  lines.push(ago
    ? `welcome back — since ${ago}:`
    : `welcome back — first logon since the engine started:`);

  if (totalMessages > 0) {
    const totalChatsActive = chats.filter(c => (c.messageCount || 0) > 0 && c.jid !== 'status@broadcast').length;
    lines.push('');
    lines.push(`  📥 ${totalMessages} message${totalMessages === 1 ? '' : 's'} in ${totalChatsActive} chat${totalChatsActive === 1 ? '' : 's'}:`);
    for (const c of topChats) {
      const label = _chatDisplayLabel(c);
      // Latest entry in the chat's recent[] ring — that's the freshest
      // snippet we have. The ring is capped at 10 per chat by the WA
      // bridge; messageCount can exceed it (we still report the real
      // count, just don't have every line). Filter by since-ts so we
      // never quote a stale message from a previous window.
      const fresh = _latestRecent(c.recent, since);
      const count = c.messageCount;
      const pin   = (c.pinned || 0) > 0 ? '📌 ' : '';
      const head  = `      ${pin}${label}  ·  ${count} msg${count === 1 ? '' : 's'}`;
      if (fresh) {
        const author = fresh.author ? `${fresh.author}: ` : '';
        lines.push(`${head}`);
        lines.push(`          ↳ ${author}"${_snippet(fresh.text)}"`);
      } else {
        lines.push(head);
      }
    }
    const dropped = totalChatsActive - topChats.length;
    if (dropped > 0) lines.push(`      … +${dropped} more chat${dropped === 1 ? '' : 's'}`);
  }

  if (statusTotal > 0) {
    const bits = topStatusAuthors.map(([name, n]) => `${name} ${n}`);
    const rest = Object.keys(statusByAuthor).length - topStatusAuthors.length;
    const tail = rest > 0 ? ` · ${rest} more` : '';
    lines.push('');
    lines.push(`  📡 ${statusTotal} status post${statusTotal === 1 ? '' : 's'}  (${bits.join(' · ')}${tail})`);
  }

  if (files.length > 0) {
    const kindBits = Object.entries(filesByKind)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`);
    lines.push('');
    lines.push(`  📎 ${files.length} file${files.length === 1 ? '' : 's'} saved   (${kindBits.join(' · ')})  →  ${_formatSize(filesTotalBytes)}`);
  }

  if (topReaction) {
    const emojiList = Object.entries(topReaction.emojis ?? {})
      .sort((a, b) => b[1] - a[1])
      .map(([e, n]) => `${n} ${e}`)
      .join(', ');
    const preview = topReaction.preview
      ? `"${topReaction.preview}"`
      : '(unknown message)';
    // Pair the reaction with the chat it landed in, when we can resolve
    // the chatJid → display label via the same chats array.
    const inChat = topReaction.chatJid
      ? chats.find(c => c.jid === topReaction.chatJid)
      : null;
    const where = inChat ? ` in ${_chatDisplayLabel(inChat)}` : '';
    lines.push('');
    lines.push(`  💥 most-reacted: ${preview}${where}  [${emojiList}]`);
  }

  // Pointer to commands that surface the underlying data. Important
  // distinction: /last reads the room md and only shows chats that
  // entered the transcript (egpt_chats + /join'd). /channels reads the
  // bridge's per-chat ring which captures EVERY observed chat
  // including observe-only ones — so messages summarized above that
  // don't appear in /last are findable via /channels.
  lines.push('');
  lines.push('  /last 50            scroll the transcript  (joined / egpt chats only)');
  lines.push('  /channels 20 5      every observed chat + 5 recent lines each');

  return lines.join('\n');
}

// One-line chat label with type indicator. Used both for the "top chats"
// section and for tagging the most-reacted-item line.
function _chatDisplayLabel(c) {
  if (c.jid === 'status@broadcast') return 'WA status feed';
  const isGroup = !!c.isGroup;
  // Strip the JID host suffix as a last resort. Group JIDs are
  // <id>@g.us; DM JIDs are <number>@s.whatsapp.net or @lid.
  const fallback = c.jid?.split('@')[0]?.split(':')[0] ?? '?';
  const name = (c.name && c.name.trim()) ? c.name.trim() : fallback;
  return isGroup ? `${name} (group)` : `DM with ${name}`;
}

// Latest body from a chat's recent[] ring, optionally filtered to
// entries newer than `since`. Returns { author, text, ts } or null.
function _latestRecent(recent, since) {
  if (!Array.isArray(recent) || recent.length === 0) return null;
  // recent[] is stored oldest-first; walk from the end.
  for (let i = recent.length - 1; i >= 0; i--) {
    const r = recent[i];
    if (!r || typeof r.text !== 'string') continue;
    if (since && r.ts && r.ts < since) continue;
    return r;
  }
  // Nothing in the since-window? Fall back to the absolute latest so
  // the user at least sees what the chat is about.
  for (let i = recent.length - 1; i >= 0; i--) {
    const r = recent[i];
    if (r && typeof r.text === 'string') return r;
  }
  return null;
}

function _snippet(text, max = 70) {
  if (!text) return '';
  const oneLine = String(text).replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max - 1) + '…';
}

// Reset the counters that the summary just consumed so the next
// "while you were away" window starts at zero. Idempotent — running
// this twice on the same disk state just no-ops the second pass.
export function resetCountersOnDisk() {
  // Chats: zero out messageCount and broadcastsByAuthor in-place.
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
  // Reactions: clear the whole file. Reactions are intrinsically
  // about "what got attention recently" — cumulative would lose the
  // signal.
  try {
    if (existsSync(REACTIONS_PATH)) writeFileSync(REACTIONS_PATH, '{}', { mode: 0o600 });
  } catch (_) {}
}

export function writeLastLogonNow() {
  try {
    writeFileSync(LAST_LOGON_PATH, JSON.stringify({ ts: Date.now() }), { mode: 0o600 });
  } catch (_) {}
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

// Walk ~/.egpt/media/<chat>/.media-index.json and collect saves whose
// timestamp is newer than `since`. Skips entries under deleted/
// (those moved out of the live media area on REVOKE).
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
      // Best-effort size: read fs.stat. Cheap (< 50 saves typical).
      let size = 0;
      try { const st = await fs.stat(entry.path); size = st.size; } catch {}
      out.push({ msgId, kind: entry.kind || 'file', ts, size, path: entry.path });
    }
  }
  return out;
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
