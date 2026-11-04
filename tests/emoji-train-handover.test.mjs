// The emoji train, first byte and alive (operator 2026-11-04):
// A. the 👾 is placed at once by the account the line arrived on, by its own id; once the mouth has its own
//    copy the mark moves there (placed there, then taken off the holder). No copy: it stays to the end.
// B. the started phase steps through dispatch.thinking_frames, one every dispatch.thinking_frame_ms, on the
//    account holding it, until the mark comes off (the bubble opens, or the turn ends). A step still in
//    flight skips the next; none queue.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTurns, THINKING_FRAMES } from '../src/spine/turns.mjs';
import { makePeerMouth } from '../src/spine/boot.mjs';
import { crossAccountMsgKey } from '../src/bridges/beeper.mjs';

const EAR_TS = Date.parse('2026-10-31T02:53:07.260Z');
const ON_EAR = { id: '41174', text: 'w', timestamp: EAR_TS };
const ON_MOUTH = { id: '17743', text: 'w', timestamp: '2026-10-31T02:53:08.000Z' };
const EV = { surface: 'whatsapp', chatId: 'chat-1', senderId: 'an', body: 'w', msgId: ON_EAR.id, msgHash: crossAccountMsgKey(ON_EAR), msgTs: EAR_TS };
const ONE = () => ['🤔'];                                       // frames off: A's tests watch the handover alone

afterEach(() => vi.useRealTimers());

// The real lookup (boot makePeerMouth → ownCopy): its arrival record and its wait. `slow`: a glyph whose
// placement on the ear takes that long.
function node({ frames = ONE, frameMs, slow = {} } = {}) {
  const seen = [], waiters = new Set(), placed = [], logs = [];
  const mouthBridge = {
    recentMessages: () => [...seen],
    awaitMessage: (_c, test, ms) => new Promise((resolve) => {
      const w = { test, done: (m) => { clearTimeout(t); waiters.delete(w); resolve(m); } };
      const t = setTimeout(() => w.done(null), ms);
      waiters.add(w);
    }),
    async react(chatId, msgId, emoji) { placed.push(`+${emoji}@${msgId}`); return true; },
    async unreact(chatId, msgId, emoji) { placed.push(`-${emoji}@${msgId}`); return true; },
  };
  const ear = {
    async react(chatId, msgId, emoji) { if (slow[emoji]) await new Promise((r) => setTimeout(r, slow[emoji])); placed.push(`+${emoji}@${msgId}`); return true; },
    async unreact(chatId, msgId, emoji) { placed.push(`-${emoji}@${msgId}`); return true; },
  };
  const mouth = makePeerMouth({ peer: null, bridge: ear, localMouth: () => ({ name: 'secondary', home: 'primary', bridge: mouthBridge }), onLog: (s) => logs.push(s) });
  const peerMouth = { ...mouth, route: async () => ({ connection: 'secondary', bridge: mouthBridge, chatId: 'mouth-1' }) };
  const turns = createTurns({ brain: {}, bridge: ear, peerMouth, log: { line: (s) => logs.push(s) }, thinkingFrames: frames, ...(frameMs ? { thinkingFrameMs: frameMs } : {}) });
  const arrive = (m) => { seen.push(m); for (const w of [...waiters]) if (w.test(m)) w.done(m); };
  return { turns, placed, logs, arrive };
}
const tick = (ms) => vi.advanceTimersByTimeAsync(ms);

describe('A. the 👾 at first byte, from the account holding the line; then over to the mouth', () => {
  it('REPRODUCE: the 👾 lands at arrival with no wait, on the holder', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { turns, placed } = node();
    turns.train('egpt', EV);
    await tick(1);
    expect(placed).toEqual(['+👾@41174']);
  });

  it('REPRODUCE: the copy lands 2 s late — the mark moves to the mouth (placed there, then off the holder); the end takes it off there', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { turns, placed, arrive } = node();
    const t = turns.train('egpt', EV);
    await tick(500);
    t.started();
    await tick(1500);
    expect(placed).toEqual(['+👾@41174', '+🤔@41174']);
    arrive(ON_MOUTH);
    await tick(10);
    expect(placed).toEqual(['+👾@41174', '+🤔@41174', '+🤔@17743', '-🤔@41174']);
    await t.off();
    expect(placed.at(-1)).toBe('-🤔@17743');
  });

  it('REPRODUCE: the copy lands at 5.5 s — inside the wait; it moves then', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { turns, placed, arrive } = node();
    const t = turns.train('egpt', EV);
    await tick(5500);
    arrive(ON_MOUTH);
    await tick(10);
    await t.off();
    expect(placed).toEqual(['+👾@41174', '+👾@17743', '-👾@41174', '-👾@17743']);
  });

  it('REPRODUCE: no copy ever — the mark stays on the holder to the end and comes off there', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { turns, placed, logs } = node();
    const t = turns.train('egpt', EV);
    t.started();
    await tick(10_000);
    await t.off();
    expect(placed).toEqual(['+👾@41174', '+🤔@41174', '-🤔@41174']);
    expect(logs.join('\n')).toMatch(/no copy of its own .*nor did it arrive within 6000ms.* the mark stays/);
  });

  it('the turn ends before the copy — off the holder; the copy arriving later moves nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { turns, placed, arrive } = node();
    const t = turns.train('egpt', EV);
    t.started();
    const off = t.off();
    await tick(2000);
    arrive(ON_MOUTH);
    await tick(10);
    await off;
    expect(placed).toEqual(['+👾@41174', '-👾@41174']);
  });

  it('REPRODUCE (lock): one account (the Telegram bot, or the holder is the mouth) — placed and replaced there, nothing moves, no copy asked for', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const placed = [], asked = [];
    const bot = { beingAccount: true, async react(c, id, e) { placed.push(`+${e}@${id}`); return true; }, async unreact(c, id, e) { placed.push(`-${e}@${id}`); return true; } };
    const peerMouth = { route: async () => null, mouthIsElsewhere: () => false, quote: async () => { asked.push('quote'); return { ok: true }; } };
    const t = createTurns({ brain: {}, bridge: bot, peerMouth, thinkingFrames: ONE }).train('egpt', { ...EV, chatId: 'tg:42' });
    t.started();
    await tick(10_000);
    await t.off();
    expect(placed).toEqual(['+👾@41174', '+🤔@41174', '-🤔@41174']);
    expect(asked).toEqual([]);
  });
});

describe('B. the started phase steps through the thinking frames', () => {
  it('REPRODUCE: one frame every 2 s on a fake clock, from the default set; the end stops them', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    expect(THINKING_FRAMES).toEqual(['🤔', '🤓', '👀', '🤯']);
    const { turns, placed } = node({ frames: () => THINKING_FRAMES });
    const t = turns.train('egpt', EV);
    t.started();
    await tick(1);
    expect(placed).toEqual(['+👾@41174', '+🤔@41174']);
    await tick(1999);
    expect(placed.at(-1)).toBe('+🤓@41174');
    await tick(6000);
    expect(placed.slice(2)).toEqual(['+🤓@41174', '+👀@41174', '+🤯@41174', '+🤔@41174']);
    await t.off();
    await tick(10_000);
    expect(placed.slice(6)).toEqual(['-🤔@41174']);
  });

  it('read live: the frames and their interval follow the config as it stands at each step', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let frames = ['🤔', '🤓'], ms = 2000;
    const { turns, placed } = node({ frames: () => frames, frameMs: () => ms });
    const t = turns.train('egpt', EV);
    t.started();
    await tick(2000);
    frames = ['👀', '🤯'];                               // the frame after next is read from these
    ms = 500;
    await tick(2000);                                   // 4 s: the 2 s already armed, then 500 ms
    expect(placed.slice(1)).toEqual(['+🤔@41174', '+🤓@41174', '+👀@41174']);
    await tick(500);
    expect(placed.at(-1)).toBe('+🤯@41174');
    await t.off();
  });

  it('REPRODUCE: a slow step skips the next frame rather than queueing it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { turns, placed } = node({ frames: () => THINKING_FRAMES, slow: { '🤓': 3000 } });
    const t = turns.train('egpt', EV);
    t.started();
    await tick(2000);                                   // 🤓 asked; it lands at 5 s
    await tick(2000);                                   // 4 s: in flight — skipped
    expect(placed).toEqual(['+👾@41174', '+🤔@41174']);
    await tick(1000);                                   // 5 s: 🤓 lands
    await tick(1000);                                   // 6 s: the next, once
    expect(placed).toEqual(['+👾@41174', '+🤔@41174', '+🤓@41174', '+👀@41174']);
    await t.off();
  });

  it('the frames go on the account holding the mark: after the handover, on the mouth', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { turns, placed, arrive } = node({ frames: () => THINKING_FRAMES });
    const t = turns.train('egpt', EV);
    t.started();
    await tick(1000);
    arrive(ON_MOUTH);
    await tick(1000);
    await t.off();
    expect(placed).toEqual(['+👾@41174', '+🤔@41174', '+🤔@17743', '-🤔@41174', '+🤓@17743', '-🤓@17743']);
  });
});
