// Locks the limb-agnostic incoming-media contracts (operator 2026-06-13/15):
//   - transcription is a ROOM SERVICE with two gates resolved host-side:
//     `enabled` (transcribe at all — HEARD) + `postsBack` (surface the 👂 —
//     SPOKEN). The transcript ALWAYS returns when enabled, regardless of
//     postsBack (E hears everything; surfacing is separate). Shared by every
//     limb via src/incoming-media.mjs.
//   - the module is Node-import-free so telegram.mjs (which imports it) still
//     bundles for the browser extension.
//   - Telegram's media normalizer maps photo[]/voice/audio/document to one
//     descriptor (largest photo; voice = audio+isVoiceNote).
import { describe, it, expect, beforeEach } from 'vitest';
import { transcribeVoiceNote, POSTS_BACK_DELAY_MS, flushPostsBackAck, _resetPostsBackDebounce } from '../src/incoming-media.mjs';
import { pickTelegramMedia } from '../src/bridges/telegram.mjs';

const fakeTranscribe = async () => 'hola que tal';

// A manual timer so the trailing-debounce window is deterministic: capture the
// pending callback, fire it on demand. Mirrors clear()-then-set() reset.
function makeScheduler() {
  const s = {
    fn: null, setCount: 0, clearCount: 0,
    set(fn) { s.setCount++; s.fn = fn; return { id: s.setCount }; },
    clear() { s.clearCount++; s.fn = null; },
    async fire() { const f = s.fn; s.fn = null; if (f) await f(); },
  };
  return s;
}

describe('transcribeVoiceNote — room service (enabled + postsBack)', () => {
  it('enabled + postsBack + not muted → transcribes AND posts the 👂 ack', async () => {
    const sent = [];
    const t = await transcribeVoiceNote({
      localPath: '/tmp/n.ogg', transcribe: fakeTranscribe,
      reply: (x) => sent.push(x), enabled: true, postsBack: true, muted: false,
    });
    expect(t).toBe('hola que tal');
    expect(sent).toEqual(['👂 hola que tal']);
  });

  it('postsBack:false → transcript still returns, but NO ack (heard, not spoken)', async () => {
    const sent = [];
    const t = await transcribeVoiceNote({
      localPath: '/tmp/n.ogg', transcribe: fakeTranscribe,
      reply: (x) => sent.push(x), enabled: true, postsBack: false, muted: false,
    });
    expect(t).toBe('hola que tal');     // E hears everything
    expect(sent).toEqual([]);           // …but doesn't surface it
  });

  it('enabled:false → NOT transcribed (no work), null, no ack', async () => {
    const sent = [];
    let called = false;
    const t = await transcribeVoiceNote({
      localPath: '/tmp/n.ogg', transcribe: async () => { called = true; return 'x'; },
      reply: (x) => sent.push(x), enabled: false, postsBack: true,
    });
    expect(t).toBeNull();
    expect(called).toBe(false);         // the service is off — whisper never runs
    expect(sent).toEqual([]);
  });

  it('muted → no ack even when postsBack', async () => {
    const sent = [];
    const t = await transcribeVoiceNote({
      localPath: '/tmp/n.ogg', transcribe: fakeTranscribe,
      reply: (x) => sent.push(x), enabled: true, postsBack: true, muted: true,
    });
    expect(t).toBe('hola que tal');
    expect(sent).toEqual([]);
  });

  it('transcription failure → null, no ack', async () => {
    const sent = [];
    const t = await transcribeVoiceNote({
      localPath: '/tmp/n.ogg', transcribe: async () => null,
      reply: (x) => sent.push(x), enabled: true, postsBack: true,
    });
    expect(t).toBeNull();
    expect(sent).toEqual([]);
  });

  it('no transcriber injected → null (module stays Node-import-free)', async () => {
    const t = await transcribeVoiceNote({ localPath: '/tmp/n.ogg', enabled: true, postsBack: true });
    expect(t).toBeNull();
  });
});

describe('transcribeVoiceNote — 👂 posts-back debounce (operator 2026-06-21)', () => {
  beforeEach(() => _resetPostsBackDebounce());

  it('the default window is 5 minutes', () => {
    expect(POSTS_BACK_DELAY_MS).toBe(5 * 60 * 1000);
  });

  it('HEARD is instant, SPOKEN is held: transcript returns now, 👂 only after the window', async () => {
    const sent = [];
    const sched = makeScheduler();
    const t = await transcribeVoiceNote({
      localPath: '/tmp/n.ogg', transcribe: fakeTranscribe,
      reply: (x) => sent.push(x), enabled: true, postsBack: true, muted: false,
      debounceKey: 'chat-1', scheduler: sched,
    });
    expect(t).toBe('hola que tal');   // model + transcript.md get it immediately
    expect(sent).toEqual([]);         // …but the chat echo is queued, not posted yet
    expect(sched.setCount).toBe(1);
    await sched.fire();
    expect(sent).toEqual(['👂 hola que tal']);
  });

  it('coalesces a burst into ONE 👂 echo and resets the trailing window on each note', async () => {
    const sent = [];
    const sched = makeScheduler();
    const reply = (x) => sent.push(x);
    await transcribeVoiceNote({ localPath: '/a.ogg', transcribe: async () => 'uno',  reply, enabled: true, postsBack: true, debounceKey: 'chat-1', scheduler: sched });
    await transcribeVoiceNote({ localPath: '/b.ogg', transcribe: async () => 'dos',  reply, enabled: true, postsBack: true, debounceKey: 'chat-1', scheduler: sched });
    await transcribeVoiceNote({ localPath: '/c.ogg', transcribe: async () => 'tres', reply, enabled: true, postsBack: true, debounceKey: 'chat-1', scheduler: sched });
    expect(sent).toEqual([]);          // nothing posted mid-burst
    expect(sched.setCount).toBe(3);    // re-armed on every note
    expect(sched.clearCount).toBe(2);  // …resetting the prior timer each time
    await sched.fire();
    expect(sent).toEqual(['👂 uno\n\ndos\n\ntres']);   // one batched echo, in order
  });

  it('keeps separate chats in separate batches', async () => {
    const sent = [];
    const reply = (x) => sent.push(x);
    const s1 = makeScheduler(), s2 = makeScheduler();
    await transcribeVoiceNote({ localPath: '/a.ogg', transcribe: async () => 'hi-1', reply, enabled: true, postsBack: true, debounceKey: 'chat-1', scheduler: s1 });
    await transcribeVoiceNote({ localPath: '/b.ogg', transcribe: async () => 'hi-2', reply, enabled: true, postsBack: true, debounceKey: 'chat-2', scheduler: s2 });
    await s2.fire();
    await s1.fire();
    expect(sent).toEqual(['👂 hi-2', '👂 hi-1']);
  });

  it('muted → not even queued (no echo when the window fires)', async () => {
    const sent = [];
    const sched = makeScheduler();
    await transcribeVoiceNote({
      localPath: '/tmp/n.ogg', transcribe: fakeTranscribe,
      reply: (x) => sent.push(x), enabled: true, postsBack: true, muted: true,
      debounceKey: 'chat-1', scheduler: sched,
    });
    expect(sched.setCount).toBe(0);
    await sched.fire();
    expect(sent).toEqual([]);
  });

  it('no debounceKey → legacy immediate echo (unchanged for non-batching callers)', async () => {
    const sent = [];
    const t = await transcribeVoiceNote({
      localPath: '/tmp/n.ogg', transcribe: fakeTranscribe,
      reply: (x) => sent.push(x), enabled: true, postsBack: true,
    });
    expect(t).toBe('hola que tal');
    expect(sent).toEqual(['👂 hola que tal']);   // posted synchronously, before return
  });

  it('flushPostsBackAck posts a chat’s pending echo immediately (e.g. on shutdown)', async () => {
    const sent = [];
    const sched = makeScheduler();
    await transcribeVoiceNote({ localPath: '/a.ogg', transcribe: async () => 'bye', reply: (x) => sent.push(x), enabled: true, postsBack: true, debounceKey: 'chat-1', scheduler: sched });
    expect(sent).toEqual([]);
    await flushPostsBackAck('chat-1');
    expect(sent).toEqual(['👂 bye']);
    await sched.fire();                 // the (now-stale) timer fires into nothing
    expect(sent).toEqual(['👂 bye']);   // no double post
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
