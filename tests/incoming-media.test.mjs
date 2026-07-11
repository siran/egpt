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
import {
  transcribeVoiceNote, POSTS_BACK_DELAY_MS, flushPostsBackAck, _resetPostsBackDebounce,
  cancelPromotion, hasPendingPromotion, _resetPromotions, ECHO_MARKER,
} from '../src/incoming-media.mjs';

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

  it('includes author + duration in the 👂 ack when provided', async () => {
    const sent = [];
    const t = await transcribeVoiceNote({
      localPath: '/tmp/n.ogg',
      transcribe: async (_p, _cfg, _log, meta) => { meta.durationSec = 8; return 'hola que tal'; },
      reply: (x) => sent.push(x), enabled: true, postsBack: true, author: 'An',
    });
    expect(t).toBe('hola que tal');
    expect(sent).toEqual(['👂 An (8s): hola que tal']);
  });

  // NO author (operator 2026-07-10): Beeper exposes no push name, so the limb passes no
  // author; the duration MUST survive on its own (the ack "👂 (Ns) <text>"), and the
  // per-note quoted reply carries attribution. Guards the author/duration decoupling.
  it('OMITS the author but KEEPS the duration when no author is given', async () => {
    const sent = [];
    const t = await transcribeVoiceNote({
      localPath: '/tmp/n.ogg',
      transcribe: async (_p, _cfg, _log, meta) => { meta.durationSec = 164; return 'hola que tal'; },
      reply: (x) => sent.push(x), enabled: true, postsBack: true,   // NO author passed
    });
    expect(t).toBe('hola que tal');
    expect(sent).toEqual(['👂 (164s) hola que tal']);   // author dropped, duration survives
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

// 👂 PROMOTION — ORDERED FAILOVER (operator 2026-07-11, Phase 3b). A rank>1 co-account node HOLDS
// its 👂 and posts it at (rank-1)*echoTimeoutMs ONLY if the higher ranks stay silent; it stands down
// (cancelPromotion) the instant the note's 👂 is observed from a higher rank. Fake clock — no real
// waits. cancelPromotion stands in for the bridge's observe-and-cancel hook (which fires it on a 👂
// reply to a pending note; that correlation is locked at the bridge in beeper-bridge.test.mjs).
describe('transcribeVoiceNote — 👂 promotion / ordered failover (operator 2026-07-11)', () => {
  beforeEach(() => { _resetPostsBackDebounce(); _resetPromotions(); });

  // A fake clock that models real time: timers fire in DEADLINE order as time advances, so a
  // staggered rank-2(+T)/rank-3(+2T) schedule elapses in the right sequence.
  function makeClock() {
    let seq = 0;
    let now = 0;
    const timers = [];   // { id, fn, at }
    return {
      set(fn, ms) { const id = ++seq; timers.push({ id, fn, at: now + ms }); return { id, unref() {} }; },
      clear(h) { const i = timers.findIndex((t) => h && t.id === h.id); if (i >= 0) timers.splice(i, 1); },
      async advance(ms) {
        now += ms;
        let t;
        while ((t = timers.filter((x) => x.at <= now).sort((a, b) => a.at - b.at)[0])) {
          timers.splice(timers.indexOf(t), 1);
          await t.fn();
        }
      },
      pending() { return timers.length; },
    };
  }
  const armVoice = (over) => transcribeVoiceNote({
    localPath: '/n.ogg', transcribe: async () => 'hola', reply: over.reply,
    enabled: true, postsBack: true, muted: false,
    debounceKey: over.debounceKey, echoRank: over.echoRank, echoTimeoutMs: over.echoTimeoutMs ?? 20_000,
    scheduler: over.scheduler,
  });

  it('the marker the bridge correlates on is 👂', () => {
    expect(ECHO_MARKER).toBe('👂');
  });

  it('rank-1 POSTS (immediate path) — unchanged from 3a', async () => {
    const sent = [];
    const t = await transcribeVoiceNote({
      localPath: '/n.ogg', transcribe: async () => 'hola', reply: (x) => sent.push(x),
      enabled: true, postsBack: true, echoRank: 1, debounceKey: 'chat:note-1', postsBackDelayMs: 0,
    });
    expect(t).toBe('hola');
    expect(sent).toEqual(['👂 hola']);                       // rank-1 posts now
    expect(hasPendingPromotion('chat:note-1')).toBe(false);  // no promotion armed for rank-1
  });

  it('rank-2 HOLDS the 👂 (arms a promotion, posts nothing yet)', async () => {
    const sent = [];
    const clock = makeClock();
    await armVoice({ reply: (x) => sent.push(x), debounceKey: 'chat:note-2', echoRank: 2, scheduler: clock });
    expect(sent).toEqual([]);                                // held — not posted
    expect(hasPendingPromotion('chat:note-2')).toBe(true);   // armed
  });

  it('rank-2 OBSERVED before its timer → does NOT post (a higher rank posted; stand down)', async () => {
    const sent = [];
    const clock = makeClock();
    await armVoice({ reply: (x) => sent.push(x), debounceKey: 'chat:note-3', echoRank: 2, echoTimeoutMs: 20_000, scheduler: clock });
    expect(cancelPromotion('chat:note-3')).toBe(true);       // the bridge observed rank-1's 👂 → cancel
    await clock.advance(20_000);                             // the timer WOULD have fired here …
    expect(sent).toEqual([]);                                // … but it was cancelled → no post
    expect(hasPendingPromotion('chat:note-3')).toBe(false);
  });

  it('rank-2 UNOBSERVED → posts the HELD transcript exactly at +echoTimeoutMs', async () => {
    const sent = [];
    const clock = makeClock();
    await armVoice({ reply: (x) => sent.push(x), debounceKey: 'chat:note-4', echoRank: 2, echoTimeoutMs: 20_000, scheduler: clock });
    await clock.advance(19_999); expect(sent).toEqual([]);           // not yet
    await clock.advance(1);      expect(sent).toEqual(['👂 hola']);  // fires at +T → promotes the held 👂
  });

  it('rank-3 PROMOTES only if BOTH higher ranks stay silent — posts at +2×echoTimeoutMs', async () => {
    const sent = [];
    const clock = makeClock();
    await armVoice({ reply: (x) => sent.push(x), debounceKey: 'chat:note-5', echoRank: 3, echoTimeoutMs: 10_000, scheduler: clock });
    await clock.advance(10_000); expect(sent).toEqual([]);           // +T: rank-2's window (on the peer) — rank-3 waits
    await clock.advance(10_000); expect(sent).toEqual(['👂 hola']);  // +2T: still silent → rank-3 promotes
  });

  it('rank-3 STANDS DOWN when it observes rank-2\'s post (staggering → exactly one poster with several ranks down)', async () => {
    const sent = [];
    const clock = makeClock();
    await armVoice({ reply: (x) => sent.push(x), debounceKey: 'chat:note-6', echoRank: 3, echoTimeoutMs: 10_000, scheduler: clock });
    await clock.advance(10_000);                             // +T: rank-2 (a lower-latency peer) posts its 👂 …
    expect(sent).toEqual([]);                                // rank-3 hasn't reached +2T
    expect(cancelPromotion('chat:note-6')).toBe(true);       // … which rank-3 observes before its own window → cancel
    await clock.advance(10_000);                             // +2T
    expect(sent).toEqual([]);                                // stood down — no double
  });

  it('an UNRELATED note\'s echo does NOT cancel this promotion (keyed per note)', async () => {
    const sent = [];
    const clock = makeClock();
    await armVoice({ reply: (x) => sent.push(x), debounceKey: 'chat:note-A', echoRank: 2, echoTimeoutMs: 20_000, scheduler: clock });
    expect(cancelPromotion('chat:note-B')).toBe(false);      // a 👂 for a DIFFERENT note → no-op
    await clock.advance(20_000);
    expect(sent).toEqual(['👂 hola']);                       // note-A still promotes (its own key untouched)
  });

  it('a TOO-OLD note (postsBack:false at the bridge) neither posts NOR promotes even at rank>1', async () => {
    const sent = [];
    const clock = makeClock();
    // The bridge folds tooOldForEcho / echo:false-opt-out into postsBack:false.
    await transcribeVoiceNote({
      localPath: '/n.ogg', transcribe: async () => 'hola', reply: (x) => sent.push(x),
      enabled: true, postsBack: false, echoRank: 2, debounceKey: 'chat:note-7', echoTimeoutMs: 20_000, scheduler: clock,
    });
    expect(hasPendingPromotion('chat:note-7')).toBe(false);  // never armed
    await clock.advance(20_000);
    expect(sent).toEqual([]);                                // and never posts
  });

  it('rank>1 with NO per-note key WITHHOLDS (can\'t correlate a cancel → fail-safe, no double)', async () => {
    const sent = [];
    const clock = makeClock();
    await transcribeVoiceNote({
      localPath: '/n.ogg', transcribe: async () => 'hola', reply: (x) => sent.push(x),
      enabled: true, postsBack: true, echoRank: 2, debounceKey: null, echoTimeoutMs: 20_000, scheduler: clock,
    });
    expect(clock.pending()).toBe(0);   // nothing armed
    await clock.advance(20_000);
    expect(sent).toEqual([]);          // withheld
  });
});

// (transcription primary/standby 👂 dedup removed 2026-07-09: symmetric nodes, no
// suppression — the 👂 echo is now a plain per-node `echo` boolean, HRW rotation is a
// LATER phase. The debounced-echo behavior above is unchanged.)

// (pickTelegramMedia tests removed 2026-06-24 with the direct Telegram-bot transport.)
