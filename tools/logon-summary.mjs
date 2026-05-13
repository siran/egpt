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

  const totalMessages = chats.reduce((sum, c) => sum + (c.messageCount || 0), 0);
  const topChats = chats
    .filter(c => (c.messageCount || 0) > 0 && c.jid !== 'status@broadcast')
    .sort((a, b) => (b.messageCount || 0) - (a.messageCount || 0))
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
    const chatBits = topChats.map(c => {
      const label = c.name || c.jid.split('@')[0];
      return `${label} ${c.messageCount}`;
    });
    const dropped = chats.filter(c => c.jid !== 'status@broadcast').length - topChats.length;
    const tail = (dropped > 0 && totalMessages > topChats.reduce((s, c) => s + c.messageCount, 0))
      ? ` · +${dropped} more chats` : '';
    lines.push(`  📥 ${totalMessages} messages   (${chatBits.join(' · ')}${tail})`);
  }

  if (statusTotal > 0) {
    const bits = topStatusAuthors.map(([name, n]) => `${name} ${n}`);
    const rest = Object.keys(statusByAuthor).length - topStatusAuthors.length;
    const tail = rest > 0 ? ` · ${rest} more` : '';
    lines.push(`  📡 ${statusTotal} status posts  (${bits.join(' · ')}${tail})`);
  }

  if (files.length > 0) {
    const kindBits = Object.entries(filesByKind)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`);
    lines.push(`  📎 ${files.length} files saved   (${kindBits.join(' · ')})  →  ${_formatSize(filesTotalBytes)}`);
  }

  if (topReaction) {
    const emojiList = Object.entries(topReaction.emojis ?? {})
      .sort((a, b) => b[1] - a[1])
      .map(([e, n]) => `${n} ${e}`)
      .join(', ');
    const preview = topReaction.preview
      ? `"${topReaction.preview}"`
      : '(unknown message)';
    lines.push(`  💥 most-reacted: ${preview}  [${emojiList}]`);
  }

  return lines.join('\n');
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
