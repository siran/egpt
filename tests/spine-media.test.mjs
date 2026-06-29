// media.save: persist an incoming attachment into conversations/<slug>/media/
// with a meaningful name + index line. In-memory io + conv-state; no disk.
import { describe, it, expect } from 'vitest';
import { createMedia } from '../src/spine/media.mjs';
import { emptyState } from '../conversations-state.mjs';

function harness() {
  let state = emptyState();
  const copies = [], appends = [];
  const io = {
    copyFile: async (src, dest) => copies.push({ src, dest }),
    mkdir: async () => {},
    appendFile: async (p, data) => appends.push({ p, data }),
  };
  const media = createMedia({ loadState: async () => state, writeState: async (s) => { state = s; }, io });
  return { media, copies, appends };
}

const META = {
  chatID: '!room:beeper.com', chatName: 'fam', msgId: 'm5', senderName: 'An',
  ts: Date.UTC(2026, 5, 29, 14, 5, 30), kind: 'image', mime: 'image/jpeg',
  fileName: 'photo.jpg', localPath: '/tmp/dl/photo.jpg', caption: 'look', isVoiceNote: false,
};

describe('media.save', () => {
  it('copies the attachment into conversations/<slug>/media with a meaningful name + index line', async () => {
    const { media, copies, appends } = harness();
    const dest = await media.save(META);
    expect(copies).toHaveLength(1);
    expect(copies[0].src).toBe('/tmp/dl/photo.jpg');
    expect(dest).toMatch(/whatsapp[\\/]fam-\d{10}[\\/]media[\\/]20260629-140530-an-image-m5\.jpg$/);
    expect(appends[0].data).toContain('[20260629-140530-an-image-m5.jpg]');   // index links the file
    expect(appends[0].data).toContain('look');                                // caption
  });

  it('returns null (never throws) when localPath or chatID is missing', async () => {
    const { media } = harness();
    expect(await media.save({ chatID: '!r' })).toBe(null);
    expect(await media.save({ localPath: '/x' })).toBe(null);
  });

  it('swallows a copy failure → null (media must never block text)', async () => {
    let state = emptyState();
    const io = { copyFile: async () => { throw new Error('disk full'); }, mkdir: async () => {}, appendFile: async () => {} };
    const media = createMedia({ loadState: async () => state, writeState: async (s) => { state = s; }, io });
    expect(await media.save(META)).toBe(null);
  });
});
