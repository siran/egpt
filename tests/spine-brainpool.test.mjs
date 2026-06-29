// brainpool (the Brain port): warm key, session resume/persist, and the §7
// context-overflow backstop (reset + retry once fresh), against a fake warm pool
// + in-memory conv-state. No claude, no spawn.
import { describe, it, expect } from 'vitest';
import { createBrainPool } from '../src/spine/brainpool.mjs';
import { emptyState, getBeing } from '../conversations-state.mjs';

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

function harness(scriptedResults, { config = {}, isOverflow } = {}) {
  let state = emptyState();
  const pool = fakePool(scriptedResults);
  const brain = createBrainPool({
    pool,
    getConfig: () => config,
    loadState: async () => state,
    writeState: async (s) => { state = s; },
    io: { mkdir: async () => {} },        // don't touch disk
    ...(isOverflow ? { isOverflow } : {}),
  });
  return { brain, pool, getState: () => state };
}

const ev = { surface: 'whatsapp', chatId: '!room:beeper.com', chatName: 'SPOILER', line: 'An@[SPOILER].wa (14:05) #m1: hola', body: 'hola' };

describe('brainpool.turn', () => {
  it('builds the e:ccode:<surface>:<slug> key, klass conversation, sends the dispatch line', async () => {
    const { brain, pool, getState } = harness([{ text: 'hi there', sessionId: 'sid-1' }]);
    const out = await brain.turn('e', ev);
    expect(out.text).toBe('hi there');
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0].key).toMatch(/^e:ccode:whatsapp:SPOILER-\d{10}$/);
    expect(pool.calls[0].klass).toBe('conversation');
    expect(pool.calls[0].message).toBe(ev.line);
    // a freshly-minted session is persisted onto the contact (resumed next turn)
    expect(getBeing(getState(), 'whatsapp', '!room:beeper.com', 'e').threadId).toBe('sid-1');
  });

  it('resumes the stored session: 2nd turn passes sessionId from the 1st', async () => {
    const { brain, pool } = harness([{ text: 'a', sessionId: 'sid-1' }, { text: 'b', sessionId: 'sid-1' }]);
    await brain.turn('e', ev);
    await brain.turn('e', ev);
    expect(pool.calls[0].brainOptions.sessionId).toBe(null);    // first turn: no prior session
    expect(pool.calls[1].brainOptions.sessionId).toBe('sid-1'); // second turn resumes it (arms the re-pin guard)
  });

  it('passes default_brain model/system_prompt/cwd into brainOptions', async () => {
    const config = { default_brain: { model: 'claude-x', system_prompt: 'you are E', cwd: 'C:/work', allowed_tools: 'Read,Edit' } };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], { config });
    await brain.turn('e', ev);
    expect(pool.calls[0].brainOptions).toMatchObject({ model: 'claude-x', appendSystemPrompt: 'you are E', cwd: 'C:/work', allowedTools: 'Read,Edit' });
  });

  it('context overflow THROWN → evict + retry once on a fresh session, chat gets the retry text', async () => {
    const { brain, pool } = harness([
      () => Promise.reject(new Error('claude: error_during_execution\n  Prompt is too long')),
      { text: 'fresh ok', sessionId: 'sid-2' },
    ], { config: { default_brain: { session_id: 'huge' } } });
    const out = await brain.turn('e', ev);
    expect(out.text).toBe('fresh ok');
    expect(pool.evicted).toHaveLength(1);                       // the overflowed key was evicted
    expect(pool.calls).toHaveLength(2);
    expect(pool.calls[0].brainOptions.sessionId).toBe('huge');  // first tried the (huge) session
    expect(pool.calls[1].brainOptions.sessionId).toBe(null);    // retry is fresh — no resume
  });

  it('context overflow RETURNED as result text → same reset + retry once fresh', async () => {
    const { brain, pool } = harness([
      { text: 'Prompt is too long', sessionId: 'huge-thread' },
      { text: 'recovered', sessionId: 'sid-3' },
    ]);
    const out = await brain.turn('e', ev);
    expect(out.text).toBe('recovered');
    expect(pool.evicted).toHaveLength(1);
    expect(pool.calls[1].brainOptions.sessionId).toBe(null);
  });

  it('a non-overflow error is NOT swallowed — it propagates', async () => {
    const { brain } = harness([() => Promise.reject(new Error('claude exited 1 mid-turn'))]);
    await expect(brain.turn('e', ev)).rejects.toThrow(/exited 1/);
  });
});
