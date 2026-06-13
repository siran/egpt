// Locks the limb-agnostic incoming-media contracts (operator 2026-06-13):
//   - the 👂 ack is gated on the host's enrolled verdict + transport mute, and
//     the transcript ALWAYS returns regardless (E hears everything; surfacing
//     is separate). This is the same privacy rule the Beeper limb enforced
//     inline, now shared by every limb via src/incoming-media.mjs.
//   - the module is Node-import-free so telegram.mjs (which imports it) still
//     bundles for the browser extension.
//   - Telegram's media normalizer maps photo[]/voice/audio/document to one
//     descriptor (largest photo; voice = audio+isVoiceNote).
import { describe, it, expect } from 'vitest';
import { transcribeVoiceNote } from '../src/incoming-media.mjs';
import { pickTelegramMedia } from '../src/bridges/telegram.mjs';

const fakeTranscribe = async () => 'hola que tal';

describe('transcribeVoiceNote — shared ack policy', () => {
  it('enrolled + not muted → transcribes AND posts the 👂 ack', async () => {
    const sent = [];
    const t = await transcribeVoiceNote({
      localPath: '/tmp/n.ogg', transcribe: fakeTranscribe,
      reply: (x) => sent.push(x), enrolled: true, muted: false,
    });
    expect(t).toBe('hola que tal');
    expect(sent).toEqual(['👂 hola que tal']);
  });

  it('NOT enrolled → transcript still returns, but NO ack (privacy)', async () => {
    const sent = [];
    const t = await transcribeVoiceNote({
      localPath: '/tmp/n.ogg', transcribe: fakeTranscribe,
      reply: (x) => sent.push(x), enrolled: false, muted: false,
    });
    expect(t).toBe('hola que tal');     // E hears everything
    expect(sent).toEqual([]);           // …but doesn't reveal itself
  });

  it('muted → no ack even when enrolled', async () => {
    const sent = [];
    const t = await transcribeVoiceNote({
      localPath: '/tmp/n.ogg', transcribe: fakeTranscribe,
      reply: (x) => sent.push(x), enrolled: true, muted: true,
    });
    expect(t).toBe('hola que tal');
    expect(sent).toEqual([]);
  });

  it('transcription failure → null, no ack', async () => {
    const sent = [];
    const t = await transcribeVoiceNote({
      localPath: '/tmp/n.ogg', transcribe: async () => null,
      reply: (x) => sent.push(x), enrolled: true,
    });
    expect(t).toBeNull();
    expect(sent).toEqual([]);
  });

  it('no transcriber injected → null (module stays Node-import-free)', async () => {
    const t = await transcribeVoiceNote({ localPath: '/tmp/n.ogg', enrolled: true });
    expect(t).toBeNull();
  });
});

describe('pickTelegramMedia — normalizer', () => {
  it('photo[] → largest, kind image', () => {
    const m = pickTelegramMedia({ photo: [{ file_id: 'lo', file_unique_id: 'u1' }, { file_id: 'hi', file_unique_id: 'u2' }] });
    expect(m).toMatchObject({ fileId: 'hi', kind: 'image', isVoiceNote: false });
  });

  it('voice → kind audio, isVoiceNote true', () => {
    const m = pickTelegramMedia({ voice: { file_id: 'v', file_unique_id: 'u', mime_type: 'audio/ogg' } });
    expect(m).toMatchObject({ fileId: 'v', kind: 'audio', isVoiceNote: true });
  });

  it('document pdf → resolved kind, carries the filename', () => {
    const m = pickTelegramMedia({ document: { file_id: 'd', file_unique_id: 'u', mime_type: 'application/pdf', file_name: 'report.pdf' } });
    expect(m.fileId).toBe('d');
    expect(m.fileName).toBe('report.pdf');
    expect(m.isVoiceNote).toBe(false);
  });

  it('text-only message → null (nothing to download)', () => {
    expect(pickTelegramMedia({ text: 'hi' })).toBeNull();
  });
});
