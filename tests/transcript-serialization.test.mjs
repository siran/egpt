// The archive path (archiveOldTranscriptDays) does read → rewrite-tmp →
// rename-over. Before serialization, an append landing between the read and
// the rename went to the old inode and was silently lost. These tests drive
// the exported appendTranscript / maybePrefixDateHeader through a slow fs
// (the archive holds its content snapshot for 15ms before rewriting) to
// prove appends can no longer straddle a rewrite.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendTranscript, maybePrefixDateHeader } from '../dispatch.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Slow fs: readFile holds its snapshot, writes are delayed — widens the
// race window that used to lose appends.
const slowFs = {
  mkdir: fsp.mkdir,
  appendFile: async (p, b, e) => { await sleep(5); return fsp.appendFile(p, b, e); },
  readFile: async (p, e) => { const c = await fsp.readFile(p, e); await sleep(15); return c; },
  writeFile: async (p, b, e) => { await sleep(5); return fsp.writeFile(p, b, e); },
  rename: fsp.rename,
  stat: fsp.stat,
  unlink: fsp.unlink,
};

// Fixed clock: 2026-06-10, so a `## 2026-05-01` section is past the
// 8-day rolling window and gets archived into memories/.
const clock = { now: () => new Date('2026-06-10T12:00:00.000Z') };

let dir, transcript;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'egpt-transcript-'));
  transcript = join(dir, 'transcript.md');
  await fsp.writeFile(transcript, '# log\n\n## 2026-05-01\n\nancient line\n\n', 'utf8');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('transcript append/archive serialization', () => {
  it('appends fired during an archive rewrite are never lost', async () => {
    const logger = { error: (m) => { throw new Error(`unexpected fs error: ${m}`) } };
    // Enqueue the archive first (call order = run order per path), then
    // five appends while its slow read→rewrite is still in flight.
    const work = [maybePrefixDateHeader(slowFs, transcript, clock)];
    for (let i = 0; i < 5; i++) {
      work.push(appendTranscript({ fs: slowFs, logger, path: transcript, body: `line-${i}\n`, label: 'test' }));
    }
    const [header, ...appended] = await Promise.all(work);

    expect(header).toBe('## 2026-06-10\n\n');
    expect(appended).toEqual([true, true, true, true, true]);

    const content = await fsp.readFile(transcript, 'utf8');
    for (let i = 0; i < 5; i++) expect(content).toContain(`line-${i}`);
    // Appends arrive in call order.
    expect(content.indexOf('line-0')).toBeLessThan(content.indexOf('line-4'));
    // The old section left the rolling window…
    expect(content).not.toContain('ancient line');
    // …and landed in memories/.
    const archived = await fsp.readFile(join(dir, 'memories', 'transcript-2026-05-01.md'), 'utf8');
    expect(archived).toContain('ancient line');
  });

  it('concurrent date-header calls produce exactly one header', async () => {
    const [a, b, c] = await Promise.all([
      maybePrefixDateHeader(slowFs, transcript, clock),
      maybePrefixDateHeader(slowFs, transcript, clock),
      maybePrefixDateHeader(slowFs, transcript, clock),
    ]);
    const headers = [a, b, c].filter(Boolean);
    expect(headers).toEqual(['## 2026-06-10\n\n']);
  });

  it('same-day repeat is a cheap no-op (cache fast path)', async () => {
    await maybePrefixDateHeader(slowFs, transcript, clock);
    expect(await maybePrefixDateHeader(slowFs, transcript, clock)).toBe('');
  });
});
