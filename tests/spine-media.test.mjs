// media.save: persist an incoming attachment into conversations/<slug>/media/
// with a meaningful name + index line. In-memory io + conv-state; no disk.
import { describe, it, expect } from 'vitest';
import { createMedia } from '../src/spine/media.mjs';
import { createContacts } from '../src/spine/contacts.mjs';
import { emptyState } from '../src/conversations-state.mjs';

function harness() {
  let state = emptyState();
  const copies = [], appends = [];
  const io = {
    copyFile: async (src, dest) => copies.push({ src, dest }),
    mkdir: async () => {},
    appendFile: async (p, data) => appends.push({ p, data }),
  };
  const contacts = createContacts({ loadState: async () => state, writeState: async (s) => { state = s; }, io });
  const media = createMedia({ contacts, io });
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

  it("routes the save to the surface of meta.network — a telegram photo lands under telegram, not whatsapp", async () => {
    // Bug: media hardcoded the 'whatsapp' surface, so a non-WhatsApp attachment
    // registered a duplicate contact in the whatsapp bucket and saved under
    // conversations/whatsapp/<slug>/media/, while the transcript + brain cwd live
    // under telegram/. The save must bucket by the message's origin network.
    let state = emptyState();
    const copies = [], appends = [];
    const io = {
      copyFile: async (src, dest) => copies.push({ src, dest }),
      mkdir: async () => {},
      appendFile: async (p, data) => appends.push({ p, data }),
    };
    const contacts = createContacts({ loadState: async () => state, writeState: async (s) => { state = s; }, io });
    const media = createMedia({ contacts, io });
    const dest = await media.save({ ...META, network: 'telegram' });
    expect(dest).toMatch(/telegram[\\/]fam-\d{10}[\\/]media[\\/]20260629-140530-an-image-m5\.jpg$/);
    expect(dest).not.toMatch(/whatsapp/);
    expect(state.contacts.telegram?.['!room:beeper.com']).toBeTruthy();   // contact registered in the telegram bucket
    expect(state.contacts.whatsapp).toBeUndefined();                       // NOT the whatsapp bucket
  });

  it("falls back to the constructor surface when meta carries no network", async () => {
    const { media } = harness();
    const dest = await media.save(META);   // META has no `network`
    expect(dest).toMatch(/whatsapp[\\/]fam-\d{10}[\\/]media[\\/]/);
  });

  it('returns null (never throws) when localPath or chatID is missing', async () => {
    const { media } = harness();
    expect(await media.save({ chatID: '!r' })).toBe(null);
    expect(await media.save({ localPath: '/x' })).toBe(null);
  });

  it('a video gets Route-A: keyframes (ffmpeg from config) + audio transcript → augmented descriptor', async () => {
    let state = emptyState();
    const io = { copyFile: async () => {}, mkdir: async () => {}, appendFile: async () => {} };
    const frameCalls = [], txCalls = [];
    const media = createMedia({
      contacts: createContacts({ loadState: async () => state, writeState: async (s) => { state = s; }, io }), io,
      transcribeCfg: { ffmpeg_command: 'C:/ff/ffmpeg.exe', language: 'es' },
      extractFrames: async (path, opts) => { frameCalls.push({ path, opts }); return [`${opts.outDir}/v-frame-01.jpg`, `${opts.outDir}/v-frame-02.jpg`]; },
      transcribe: async (path, cfg) => { txCalls.push({ path, cfg }); return '(video) gol de Enciso'; },
    });
    const r = await media.save({ ...META, kind: 'video', mime: 'video/mp4', fileName: 'clip.mp4', localPath: '/tmp/clip.mp4' });
    expect(r.savedPath).toMatch(/media[\\/].*\.mp4$/);
    expect(r.framePaths).toEqual(expect.arrayContaining([expect.stringContaining('v-frame-01.jpg')]));
    expect(r.transcript).toBe('(video) gol de Enciso');
    expect(frameCalls[0].opts.ffmpeg).toBe('C:/ff/ffmpeg.exe');   // ffmpeg path from config
    expect(frameCalls[0].opts.count).toBe(3);
    expect(txCalls).toHaveLength(1);                              // audio transcribed
  });

  // VIDEOS ON THE SAME PATH AS VOICE NOTES (operator 2026-09-16). A voice note is transcribed only when
  // resolveTranscriptionService(chatID).enabled (beeper.mjs); a video's audio was transcribed whatever
  // the chat's verdict. Same resolver, same verdict, and the keyframes are not the transcriber's business.
  describe('a video obeys the chat\'s transcription verdict, the one voice notes gate on', () => {
    const video = { ...META, kind: 'video', mime: 'video/mp4', fileName: 'clip.mp4', localPath: '/tmp/clip.mp4' };
    const build = (verdict) => {
      let state = emptyState();
      const io = { copyFile: async () => {}, mkdir: async () => {}, appendFile: async () => {} };
      const seen = { asked: [], tx: 0 };
      const media = createMedia({
        contacts: createContacts({ loadState: async () => state, writeState: async (s) => { state = s; }, io }), io,
        extractFrames: async (_p, opts) => [`${opts.outDir}/v-frame-01.jpg`],
        transcribe: async () => { seen.tx++; return '(video) gol de Enciso'; },
        resolveTranscriptionService: async (chatID) => { seen.asked.push(chatID); return verdict; },
      });
      return { media, seen };
    };

    it('transcription OFF for the chat: keyframes still extracted, the audio is not transcribed', async () => {
      const { media, seen } = build({ enabled: false, postsBack: false, postsBackDelayMs: 0 });
      const r = await media.save(video);
      expect(seen.asked).toEqual(['!room:beeper.com']);
      expect(seen.tx).toBe(0);
      expect(r.transcript).toBe(null);
      expect(r.framePaths).toHaveLength(1);
    });

    it('transcription ON for the chat: transcribed, as before', async () => {
      const { media, seen } = build({ enabled: true, postsBack: false, postsBackDelayMs: 0 });
      const r = await media.save(video);
      expect(seen.asked).toEqual(['!room:beeper.com']);
      expect(seen.tx).toBe(1);
      expect(r.transcript).toBe('(video) gol de Enciso');
    });
  });

  it('swallows a copy failure → null (media must never block text)', async () => {
    let state = emptyState();
    const io = { copyFile: async () => { throw new Error('disk full'); }, mkdir: async () => {}, appendFile: async () => {} };
    const media = createMedia({ contacts: createContacts({ loadState: async () => state, writeState: async (s) => { state = s; }, io }), io });
    expect(await media.save(META)).toBe(null);
  });
});
