// brainpool (the Brain port): warm key, session resume/persist, the §7
// context-overflow backstop (reset + retry once fresh), and the identity kickoff
// (fresh thread → first turn wrapped with the feed; resumed thread → raw).
// Against a fake warm pool + in-memory conv-state. No claude, no spawn.
import { describe, it, expect } from 'vitest';
import { createBrainPool } from '../src/spine/brainpool.mjs';
import { emptyState, getBeing, ensureContact, recordThread } from '../conversations-state.mjs';

// A fake warm pool that records run() calls and lets a test script the results.
function fakePool(scriptedResults) {
  const calls = [], evicted = [];
  let i = 0;
  return {
    calls, evicted,
    run(key, message, onPartial, opts) {
      calls.push({ key, message, brainOptions: opts.brainOptions, klass: opts.klass });
      const r = scriptedResults[Math.min(i, scriptedResults.length - 1)]; i++;
      return typeof r === 'function' ? r() : Promise.resolve(r);
    },
    evict(key) { evicted.push(key); },
  };
}

const ev = { surface: 'whatsapp', chatId: '!room:beeper.com', chatName: 'SPOILER', line: 'An@[SPOILER].wa (14:05) #m1: hola', body: 'hola' };

function harness(scriptedResults, { config = {}, isOverflow, loadFeed, loadManifest, seedSession } = {}) {
  let state = emptyState();
  if (seedSession) {           // pre-register the contact WITH a stored thread (a resumed, non-fresh conv)
    const ens = ensureContact(state, ev.surface, ev.chatId, { pushedName: ev.chatName, slugHint: ev.chatName });
    state = recordThread(ens.state, ev.surface, ev.chatId, seedSession);
  }
  const pool = fakePool(scriptedResults);
  const brain = createBrainPool({
    pool,
    getConfig: () => config,
    loadState: async () => state,
    writeState: async (s) => { state = s; },
    io: { mkdir: async () => {} },                 // don't touch disk
    loadFeed: loadFeed ?? (async () => ''),        // default: no folder feed
    loadManifest: loadManifest ?? (async () => ''),// default: no manifest → raw line (focus on warm logic)
    ...(isOverflow ? { isOverflow } : {}),
  });
  return { brain, pool, getState: () => state };
}

describe('brainpool.turn', () => {
  it('builds the e:ccode:<surface>:<slug> key, klass conversation, sends the dispatch line', async () => {
    const { brain, pool, getState } = harness([{ text: 'hi there', sessionId: 'sid-1' }]);
    const out = await brain.turn('e', ev);
    expect(out.text).toBe('hi there');
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0].key).toMatch(/^e:ccode:whatsapp:SPOILER-\d{10}$/);
    expect(pool.calls[0].klass).toBe('conversation');
    expect(pool.calls[0].message).toBe(ev.line);   // no feed configured → raw line
    expect(getBeing(getState(), 'whatsapp', '!room:beeper.com', 'e').threadId).toBe('sid-1');
  });

  it('resumes the stored session: 2nd turn passes sessionId from the 1st', async () => {
    const { brain, pool } = harness([{ text: 'a', sessionId: 'sid-1' }, { text: 'b', sessionId: 'sid-1' }]);
    await brain.turn('e', ev);
    await brain.turn('e', ev);
    expect(pool.calls[0].brainOptions.sessionId).toBe(null);    // first turn: no prior session
    expect(pool.calls[1].brainOptions.sessionId).toBe('sid-1'); // second turn resumes it (arms the re-pin guard)
  });

  it('does NOT cross-wire onto default_brain.session_id (per-conversation sessions only)', async () => {
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], { config: { default_brain: { session_id: 'GLOBAL' } } });
    await brain.turn('e', ev);
    expect(pool.calls[0].brainOptions.sessionId).toBe(null);    // fresh conv → null, NOT the global seed
  });

  it('passes default_brain model/system_prompt/cwd into brainOptions', async () => {
    const config = { default_brain: { model: 'claude-x', system_prompt: 'you are E', cwd: 'C:/work', allowed_tools: 'Read,Edit' } };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], { config });
    await brain.turn('e', ev);
    expect(pool.calls[0].brainOptions).toMatchObject({ model: 'claude-x', appendSystemPrompt: 'you are E', cwd: 'C:/work', allowedTools: 'Read,Edit' });
  });

  // --- identity kickoff (the beta-1 mechanism: first user turn, not a system prompt) ---
  it('FRESH thread: wraps the first turn with the identity feed + the live-message envelope', async () => {
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], { loadFeed: async () => 'I am eGPT, a loop around a mind.' });
    await brain.turn('e', ev);
    const msg = pool.calls[0].message;
    expect(msg).toContain('I am eGPT, a loop around a mind.');           // identity feed prepended
    expect(msg).toContain('Live message from the chat (envelope');        // the wrapper framing
    expect(msg.endsWith(ev.line)).toBe(true);                             // the actual line at the tail
  });

  it('falls back to the e_identity.md manifest when a personality has no folder feed', async () => {
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], { loadFeed: async () => '', loadManifest: async () => 'I am eGPT (manifest).' });
    expect((await brain.turn('e', ev), pool.calls[0].message)).toContain('I am eGPT (manifest).');
  });

  it('RESUMED thread: does NOT re-inject the identity — sends the raw line', async () => {
    const { brain, pool } = harness([{ text: 'ok', sessionId: 'sid' }], { seedSession: 'sid', loadFeed: async () => 'FEED' });
    await brain.turn('e', ev);
    expect(pool.calls[0].brainOptions.sessionId).toBe('sid');
    expect(pool.calls[0].message).toBe(ev.line);   // resumed → no wrap
  });

  it('no identity available (no feed, no manifest) → raw line even when fresh', async () => {
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }]);  // defaults: feed='' manifest=''
    await brain.turn('e', ev);
    expect(pool.calls[0].message).toBe(ev.line);
  });

  // --- context-overflow backstop ---
  it('overflow THROWN → evict + retry once on a fresh session, chat gets the retry text', async () => {
    const { brain, pool } = harness([
      () => Promise.reject(new Error('claude: error_during_execution\n  Prompt is too long')),
      { text: 'fresh ok', sessionId: 'sid-2' },
    ], { seedSession: 'huge' });
    const out = await brain.turn('e', ev);
    expect(out.text).toBe('fresh ok');
    expect(pool.evicted).toHaveLength(1);                       // the overflowed key was evicted
    expect(pool.calls).toHaveLength(2);
    expect(pool.calls[0].brainOptions.sessionId).toBe('huge');  // first tried the (huge) stored session
    expect(pool.calls[1].brainOptions.sessionId).toBe(null);    // retry is fresh — no resume
  });

  it('overflow RETURNED as result text → same reset + retry once fresh, retry re-wraps identity', async () => {
    const { brain, pool } = harness([
      { text: 'Prompt is too long', sessionId: 'huge-thread' },
      { text: 'recovered', sessionId: 'sid-3' },
    ], { loadFeed: async () => 'I am eGPT.' });   // fresh conv → both attempts wrapped
    const out = await brain.turn('e', ev);
    expect(out.text).toBe('recovered');
    expect(pool.evicted).toHaveLength(1);
    expect(pool.calls[1].brainOptions.sessionId).toBe(null);
    expect(pool.calls[1].message).toContain('I am eGPT.');       // the reset thread re-gets the identity
  });

  it('a non-overflow error is NOT swallowed — it propagates', async () => {
    const { brain } = harness([() => Promise.reject(new Error('claude exited 1 mid-turn'))]);
    await expect(brain.turn('e', ev)).rejects.toThrow(/exited 1/);
  });
});
