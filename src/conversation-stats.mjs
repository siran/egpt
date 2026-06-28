// conversation-stats.mjs — per-conversation metrics for the /e console `config` view.
//
// PURE: the caller (the spine) gathers the fs facts (transcript text + mtime, dir counts)
// and passes them in; this only does string/number work, so it's testable in isolation.

const KB = 1024, MB = 1024 * 1024;
export function fmtBytes(n = 0) {
  if (n >= MB) return `${(n / MB).toFixed(1)}MB`;
  if (n >= KB) return `${Math.round(n / KB)}K`;
  return `${n}B`;
}

// Coarse human duration: 3d / 5h / 12m / 9s (largest unit only).
export function humanDur(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  const s = Math.max(0, Math.round(ms / 1000));
  if (s >= 86400) return `${Math.floor(s / 86400)}d`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h`;
  if (s >= 60) return `${Math.floor(s / 60)}m`;
  return `${s}s`;
}

// A transcript "message" line carries a (HH:MM) timestamp marker (the dispatch-line
// format: "Name@[chat].wa (14:08) #id: body"). Count those — a good proxy for msg count
// that ignores blank lines, day headers, and wrapped continuation lines.
const _MSG_LINE = /\(\d{1,2}:\d{2}\)/;

export function conversationStats({
  entry = {}, now = Date.now(),
  transcriptText = '', transcriptMtimeMs = null,
  mediaCount = 0, archiveCount = 0, pastCount = 0,
} = {}) {
  const lines = transcriptText ? transcriptText.split('\n') : [];
  const messages = lines.reduce((n, l) => n + (_MSG_LINE.test(l) ? 1 : 0), 0);
  const ageMs = entry.threadCreatedAt ? (now - Date.parse(entry.threadCreatedAt)) : null;
  const sinceLastMs = transcriptMtimeMs != null ? (now - transcriptMtimeMs) : null;
  return {
    transcriptBytes: Buffer.byteLength(transcriptText, 'utf8'),
    transcriptLines: transcriptText ? lines.length : 0,
    messages,
    threadAgeMs: Number.isFinite(ageMs) ? ageMs : null,
    sinceLastMs,
    mediaCount, archiveCount, pastCount,
  };
}

export function renderStats(s) {
  const age = humanDur(s.threadAgeMs);
  const last = humanDur(s.sinceLastMs);
  return [
    `transcript: ${fmtBytes(s.transcriptBytes)} · ${s.transcriptLines} lines · ~${s.messages} msgs`,
    `thread age: ${age ?? '(no thread)'}   last activity: ${last ? last + ' ago' : '(none)'}`,
    `media: ${s.mediaCount} · archived: ${s.archiveCount}${s.pastCount ? ` · past convos: ${s.pastCount}` : ''}`,
  ].join('\n');
}
