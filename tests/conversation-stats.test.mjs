import { describe, it, expect } from 'vitest';
import { conversationStats, renderStats, fmtBytes, humanDur } from '../src/conversation-stats.mjs';

describe('conversation-stats', () => {
  it('fmtBytes scales B/K/MB', () => {
    expect(fmtBytes(500)).toBe('500B');
    expect(fmtBytes(2048)).toBe('2K');
    expect(fmtBytes(3 * 1024 * 1024)).toBe('3.0MB');
  });

  it('humanDur picks the largest unit', () => {
    expect(humanDur(5000)).toBe('5s');
    expect(humanDur(90_000)).toBe('1m');
    expect(humanDur(2 * 3600_000)).toBe('2h');
    expect(humanDur(3 * 86400_000)).toBe('3d');
    expect(humanDur(null)).toBe(null);
  });

  it('counts messages by the (HH:MM) marker, ignores blanks/headers/wraps', () => {
    const t = [
      '## 2026-06-28',
      'An@[x].wa (14:08) #1: hello',
      '  a wrapped continuation line',
      '',
      'egpt@[x].wa (14:09): hi back',
    ].join('\n');
    const s = conversationStats({ transcriptText: t });
    expect(s.messages).toBe(2);
    expect(s.transcriptLines).toBe(5);
    expect(s.transcriptBytes).toBe(Buffer.byteLength(t, 'utf8'));
  });

  it('computes thread age + since-last from timestamps', () => {
    const now = Date.parse('2026-06-28T12:00:00Z');
    const s = conversationStats({
      now,
      entry: { threadCreatedAt: '2026-06-25T12:00:00Z' },
      transcriptMtimeMs: now - 3600_000,
      mediaCount: 4, archiveCount: 2,
    });
    expect(humanDur(s.threadAgeMs)).toBe('3d');
    expect(humanDur(s.sinceLastMs)).toBe('1h');
    expect(s.mediaCount).toBe(4);
    expect(s.archiveCount).toBe(2);
  });

  it('renders a 3-line summary; handles no thread / no activity', () => {
    const out = renderStats(conversationStats({ transcriptText: '', entry: {} }));
    expect(out).toMatch(/transcript: 0B · 0 lines/);
    expect(out).toMatch(/thread age: \(no thread\)/);
    expect(out).toMatch(/last activity: \(none\)/);
  });
});
