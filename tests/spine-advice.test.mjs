// advice.mjs — the mode:auto consult channel: /ask posts to the config advice channel
// (origin-tagged, id stored), isAnswer detects the operator's quote-reply, routeAnswer
// injects the answer as a turn into the ORIGIN conversation. Against a fake bridge.
import { describe, it, expect } from 'vitest';
import { createAdvice } from '../src/spine/advice.mjs';

// A fake bridge: postStatus returns a scripted confirmed id and records the post.
function fakeBridge(postId = 'ask-1') {
  const posts = [];
  return {
    posts,
    async postStatus(chat, text) { posts.push({ chat, text }); return typeof postId === 'function' ? postId() : postId; },
    async send(chat, text) { posts.push({ chat, text, viaSend: true }); return { ok: true }; },
  };
}

const ORIGIN_EV = { surface: 'whatsapp', chatId: '!origin:beeper.local', chatName: 'Bea', body: 'confirm the Friday move?' };

describe('advice.ask — post to the config advice channel', () => {
  it('posts the origin-tagged question to advice_channel and returns true', async () => {
    const b = fakeBridge('ask-42');
    const advice = createAdvice({ bridge: b, getConfig: () => ({ advice_channel: 'EGPT AUTO' }) });
    const ok = await advice.ask({ ev: ORIGIN_EV, question: 'should I confirm?' });
    expect(ok).toBe(true);
    expect(b.posts).toHaveLength(1);
    expect(b.posts[0].chat).toBe('EGPT AUTO');            // the configured channel, resolved by the bridge
    expect(b.posts[0].text).toContain('Bea');             // origin conversation name (back-reference)
    expect(b.posts[0].text).toContain('should I confirm?');
  });

  it('unconfigured advice_channel → fail-closed: no post, returns false, logged', async () => {
    const b = fakeBridge();
    const logs = [];
    const advice = createAdvice({ bridge: b, getConfig: () => ({}), onLog: (m) => logs.push(m) });
    const ok = await advice.ask({ ev: ORIGIN_EV, question: 'help?' });
    expect(ok).toBe(false);
    expect(b.posts).toEqual([]);                          // nothing sent anywhere
    expect(logs.some((l) => /not configured/i.test(l))).toBe(true);
  });

  it('post returns no confirmed id → not routable, returns false', async () => {
    const b = fakeBridge(null);   // postStatus resolves null
    const advice = createAdvice({ bridge: b, getConfig: () => ({ advice_channel: 'EGPT AUTO' }) });
    expect(await advice.ask({ ev: ORIGIN_EV, question: 'q?' })).toBe(false);
  });
});

describe('advice.isAnswer / routeAnswer — the operator reply → origin turn', () => {
  async function armed(postId = 'ask-7') {
    const b = fakeBridge(postId);
    const advice = createAdvice({ bridge: b, getConfig: () => ({ advice_channel: 'EGPT AUTO' }) });
    await advice.ask({ ev: ORIGIN_EV, question: 'confirm?' });   // stores postId → origin
    return { b, advice };
  }

  it('isAnswer: true ONLY for a quote-reply to a stored ask id', async () => {
    const { advice } = await armed('ask-7');
    expect(advice.isAnswer({ replyToId: 'ask-7' })).toBe(true);
    expect(advice.isAnswer({ replyToId: 'someone-else' })).toBe(false);   // not our ask
    expect(advice.isAnswer({ replyToId: null })).toBe(false);             // not a reply
    expect(advice.isAnswer({})).toBe(false);
  });

  it('routeAnswer: dispatches the operator answer as a turn into the ORIGIN chat (private guidance)', async () => {
    const { advice } = await armed('ask-7');
    const dispatched = [];
    advice.useDispatch((msg) => { dispatched.push(msg); return Promise.resolve(); });
    const ok = await advice.routeAnswer({ replyToId: 'ask-7', body: 'yes, go ahead', senderId: 'op', isSender: true });
    expect(ok).toBe(true);
    // fire-and-forget — let the dispatch microtask settle
    await Promise.resolve();
    expect(dispatched).toHaveLength(1);
    const { body, from } = dispatched[0];
    expect(from.chatId).toBe('!origin:beeper.local');   // routed into the ORIGIN conversation
    expect(from.network).toBe('whatsapp');
    expect(body).toContain('yes, go ahead');            // the operator's guidance
    expect(body).toMatch(/guidance/i);                  // framed as private guidance, not a raw message
  });

  it('routeAnswer is one-shot: the mapping is consumed (a second reply no longer routes)', async () => {
    const { advice } = await armed('ask-7');
    advice.useDispatch(() => Promise.resolve());
    expect(await advice.routeAnswer({ replyToId: 'ask-7', body: 'a' })).toBe(true);
    expect(advice.isAnswer({ replyToId: 'ask-7' })).toBe(false);   // consumed
    expect(await advice.routeAnswer({ replyToId: 'ask-7', body: 'b' })).toBe(false);
  });

  it('routeAnswer with no bound dispatch → false + logged (never throws)', async () => {
    const logs = [];
    const b = fakeBridge('ask-9');
    const advice = createAdvice({ bridge: b, getConfig: () => ({ advice_channel: 'EGPT AUTO' }), onLog: (m) => logs.push(m) });
    await advice.ask({ ev: ORIGIN_EV, question: 'q?' });
    expect(await advice.routeAnswer({ replyToId: 'ask-9', body: 'ans' })).toBe(false);
    expect(logs.some((l) => /dispatch not bound/i.test(l))).toBe(true);
  });
});
