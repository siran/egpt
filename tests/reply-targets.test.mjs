import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  replyTargetsSidecarPath,
  loadReplyTargets,
  saveReplyTargets,
  stableIdForItem,
} from '../src/reply-targets.mjs';

describe('reply-target helpers', () => {
  it('derives the sidecar path next to the transcript', () => {
    expect(replyTargetsSidecarPath('/x/conversation.md')).toBe('/x/conversation.replytargets.json');
    expect(replyTargetsSidecarPath('/x/room.MD')).toBe('/x/room.replytargets.json');
    expect(replyTargetsSidecarPath('/x/no-ext')).toBe('/x/no-ext.replytargets.json');
  });

  it('loadReplyTargets returns an empty map when the sidecar is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'egpt-rt-'));
    try {
      const map = await loadReplyTargets(join(dir, 'conversation.md'));
      expect(map).toBeInstanceOf(Map);
      expect(map.size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('saveReplyTargets writes JSON and loadReplyTargets reads it back as a Map', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'egpt-rt-'));
    try {
      const transcript = join(dir, 'nested', 'conversation.md');
      const target = { kind: 'wa', chatId: 'c1', key: { id: 'm1' } };
      await saveReplyTargets(transcript, new Map([['wa-m1', target]]));
      expect(JSON.parse(await readFile(replyTargetsSidecarPath(transcript), 'utf8'))).toEqual({ 'wa-m1': target });
      const loaded = await loadReplyTargets(transcript);
      expect(loaded.get('wa-m1')).toEqual(target);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stableIdForItem prefers explicit and bridge-derived ids', () => {
    expect(stableIdForItem({ _stableId: 'custom-1' }, {})).toBe('custom-1');
    expect(stableIdForItem({ _replyTarget: { kind: 'wa', key: { id: 'abc' } } }, {})).toBe('wa-abc');
    expect(stableIdForItem({ _replyTarget: { kind: 'tg', chatId: '42', msgId: 7 } }, {})).toBe('tg-42-7');
    expect(stableIdForItem({ _replyTarget: [{ kind: 'wa', key: { id: 'first' } }] }, {})).toBe('wa-first');
  });

  it('stableIdForItem falls back by author kind', () => {
    expect(stableIdForItem({ author: 'system' }, {})).toMatch(/^s-[a-z2-9]{6}$/);
    expect(stableIdForItem({ author: 'You' }, {})).toMatch(/^u-[a-z2-9]{6}$/);
    expect(stableIdForItem({ author: 'e@room' }, { e: { brain: 'ccode' } })).toMatch(/^b-[a-z2-9]{6}$/);
    expect(stableIdForItem({ author: 'someone' }, {})).toMatch(/^p-[a-z2-9]{6}$/);
  });
});
