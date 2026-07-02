// brainpool (the Brain port): warm key, session resume/persist, the §7
// context-overflow backstop (reset + retry once fresh), and the identity kickoff
// (fresh thread → first turn wrapped with the feed; resumed thread → raw).
// Against a fake warm pool + in-memory conv-state. No claude, no spawn.
import { describe, it, expect } from 'vitest';
import { createBrainPool, parseWarmBlock } from '../src/spine/brainpool.mjs';
import { createContacts } from '../src/spine/contacts.mjs';
import { emptyState, getBeing, ensureContact, recordThread } from '../conversations-state.mjs';

// A fake warm pool that records run() calls and lets a test script the results.
function fakePool(scriptedResults) {
  const calls = [], evicted = [];
  let i = 0;
  return {
    calls, evicted,
    run(key, message, onPartial, opts) {
      calls.push({ key, message, brainOptions: opts.brainOptions, klass: opts.klass, idleTtlMs: opts.idleTtlMs });
      const r = scriptedResults[Math.min(i, scriptedResults.length - 1)]; i++;
      return typeof r === 'function' ? r() : Promise.resolve(r);
    },
    evict(key) { evicted.push(key); },
  };
}

const ev = { surface: 'whatsapp', chatId: '!room:beeper.com', chatName: 'SPOILER', line: 'An@[SPOILER].wa (14:05) #m1: hola', body: 'hola' };

function harness(scriptedResults, { config = {}, isOverflow, loadFeed, loadManifest, seedSession, brains, afterTurn, io } = {}) {
  let state = emptyState();
  if (seedSession) {           // pre-register the contact WITH a stored thread (a resumed, non-fresh conv)
    const ens = ensureContact(state, ev.surface, ev.chatId, { pushedName: ev.chatName, slugHint: ev.chatName });
    state = recordThread(ens.state, ev.surface, ev.chatId, seedSession);
  }
  const pool = fakePool(scriptedResults);
  const loadState = async () => state;
  const writeState = async (s) => { state = s; };
  const brain = createBrainPool({
    pool,
    getConfig: () => config,
    contacts: createContacts({ loadState, writeState, io: { mkdir: async () => {} } }),
    loadState,
    writeState,
    // don't touch disk; readFile → "no config.yaml" (no warm override); writeFile is a no-op so
    // the stats.yaml thread-mirror stays in-memory (never writes into a real profile folder)
    io: io ?? { mkdir: async () => {}, readFile: async () => null, writeFile: async () => {} },
    loadFeed: loadFeed ?? (async () => ''),        // default: no folder feed
    loadManifest: loadManifest ?? (async () => ''),// default: no manifest → raw line (focus on warm logic)
    ...(brains ? { brains } : {}),                 // omit → falls back to a bare ccode def
    ...(afterTurn ? { afterTurn } : {}),
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

  // --- brain registry: instance-on-first-turn + freeze ---
  it('instances the default brain from the registry into readonly, keys by its engine', async () => {
    const brains = { resolve: () => ({ name: 'default', type: 'codex', model: 'gpt-5.4-mini', allowed_tools: 'all' }) };
    const { brain, pool, getState } = harness([{ text: 'ok', sessionId: 's' }], { brains });
    await brain.turn('e', ev);
    expect(pool.calls[0].key).toMatch(/^e:codex:whatsapp:SPOILER-\d{10}$/);       // engine from the brain, not hardcoded ccode
    expect(pool.calls[0].brainOptions).toMatchObject({ model: 'gpt-5.4-mini', allowedTools: 'all' });
    const view = getBeing(getState(), 'whatsapp', '!room:beeper.com', 'e');
    expect(view.brain).toBe('default');
    expect(view.brainType).toBe('codex');                                        // frozen into readonly
  });

  it('instancing freezes the def under readonly.agent with CONCRETE model/effort (no null, no brain/personality)', async () => {
    // def omits effort and has model:null → the snapshot must be deterministic, never null
    // (operator 2026-07-02: "make it deterministic").
    const brains = { resolve: () => ({ name: 'default', type: 'ccode', model: null, allowed_tools: 'all' }) };
    const { brain, getState } = harness([{ text: 'ok', sessionId: 's' }], { brains });
    await brain.turn('e', ev);
    const ro = getState().contacts.whatsapp['!room:beeper.com'].readonly;
    expect(ro.agent).toBe('default');            // the new key
    expect('brain' in ro).toBe(false);           // the legacy key is NOT written going forward
    expect('personality' in ro).toBe(false);     // the retired personality key is NOT written either
    expect(ro.model).toBe('sonnet');             // deterministic fallback (def.model was null)
    expect(ro.effort).toBe('high');              // deterministic fallback (def.effort absent)
  });

  it('a type def with concrete model/effort freezes those exact values (fallback only fills the gaps)', async () => {
    const brains = { resolve: () => ({ name: 'sonnet-high', type: 'ccode', model: 'opus', effort: 'low', allowed_tools: 'all' }) };
    const { brain, pool, getState } = harness([{ text: 'ok', sessionId: 's' }], { brains });
    await brain.turn('e', ev);
    const ro = getState().contacts.whatsapp['!room:beeper.com'].readonly;
    expect(ro).toMatchObject({ agent: 'sonnet-high', type: 'ccode', model: 'opus', effort: 'low' });
    // the SAME resolved values reach the run (snapshot and run always agree)
    expect(pool.calls[0].brainOptions).toMatchObject({ model: 'opus', effort: 'low' });
  });

  it('mirrors a freshly-minted thread into stats.yaml (branch history) via the injected io', async () => {
    const writes = [];
    const io = { mkdir: async () => {}, readFile: async () => null, writeFile: async (p, data) => writes.push({ p, data }) };
    const { brain } = harness([{ text: 'ok', sessionId: 'sid-new' }], { io });
    await brain.turn('e', ev);
    const statsWrite = writes.find((w) => String(w.p).endsWith('stats.yaml'));
    expect(statsWrite).toBeTruthy();
    expect(statsWrite.data).toContain('sid-new');   // the new thread id appended to threads:
    expect(statsWrite.data).toContain('threads:');
  });

  it('kickoff feed comes from the TYPE def\'s personality (def.personality reaches loadFeed, not the conversation)', async () => {
    const seen = [];
    const brains = { resolve: () => ({ name: 'default', type: 'ccode', personality: 'custom' }) };
    const { brain } = harness([{ text: 'ok', sessionId: 's' }], {
      brains,
      loadFeed: async (p) => { seen.push(p); return `feed-for-${p}`; },
    });
    await brain.turn('e', ev);
    expect(seen).toEqual(['custom']);            // the agent-type def's personality, not 'default'
  });

  it('persona agent type (agents block) supplies E\'s fresh-conversation def, resolved through the registry', async () => {
    // the persona agent points at type "sonnet-high"; the registry resolves that type file
    const brains = { resolve: (name) => name === 'sonnet-high' ? ({ name: 'sonnet-high', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: 'all' }) : null };
    const config = { agents: { egpt: { type: 'sonnet-high', handles: ['e', 'egpt'] } } };
    const { brain, pool, getState } = harness([{ text: 'ok', sessionId: 's' }], { brains, config });
    await brain.turn('e', ev);
    expect(pool.calls[0].key).toMatch(/^e:ccode:whatsapp:SPOILER-\d{10}$/);
    expect(pool.calls[0].brainOptions).toMatchObject({ model: 'sonnet', effort: 'high', allowedTools: 'all' });
    const view = getBeing(getState(), 'whatsapp', '!room:beeper.com', 'e');
    expect(view.brain).toBe('sonnet-high');    // instanced from the persona agent type
  });

  it('persona agent type that does NOT resolve falls through to default_brain', async () => {
    const brains = { resolve: (name) => name === 'default' ? ({ name: 'default', type: 'codex' }) : null };
    const config = { agents: { egpt: { type: 'ghost-type', handles: ['e', 'egpt'] } } };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], { brains, config });
    await brain.turn('e', ev);
    expect(pool.calls[0].key).toMatch(/:codex:/);   // fell through to default_brain → 'default' (codex)
  });

  it('a re-pointed default does NOT retro-alter an already-instanced conversation', async () => {
    let type = 'ccode';
    const brains = { resolve: () => ({ name: 'default', type }) };
    const { brain, pool } = harness([{ text: 'a', sessionId: 's' }, { text: 'b', sessionId: 's' }], { brains });
    await brain.turn('e', ev);            // instances ccode
    type = 'codex';                       // operator re-points the default
    await brain.turn('e', ev);            // …but this conv stays frozen on ccode
    expect(pool.calls[1].key).toMatch(/:ccode:/);
  });

  it('fires the afterTurn hook with the key + final session (auto-compaction trigger)', async () => {
    const seen = [];
    const { brain } = harness([{ text: 'ok', sessionId: 'sid-9' }], { afterTurn: (x) => seen.push(x) });
    await brain.turn('e', ev);
    expect(seen).toHaveLength(1);
    expect(seen[0].key).toMatch(/^e:ccode:whatsapp:SPOILER-\d{10}$/);
    expect(seen[0].sessionId).toBe('sid-9');
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

  // --- per-conversation warm idle_ttl override (operator 2026-07-02) ---
  it('passes the conversation folder warm idle_ttl override to pool.run (normal + overflow retry)', async () => {
    const yaml = 'warm:\n  idle_ttl: 5m\n';
    const { brain, pool } = harness([
      () => Promise.reject(new Error('claude: error_during_execution\n  Prompt is too long')),
      { text: 'fresh ok', sessionId: 'sid-2' },
    ], { seedSession: 'huge', io: { mkdir: async () => {}, readFile: async () => yaml, writeFile: async () => {} } });
    const out = await brain.turn('e', ev);
    expect(out.text).toBe('fresh ok');
    expect(pool.calls).toHaveLength(2);
    expect(pool.calls[0].idleTtlMs).toBe(300000);   // normal turn carries the override
    expect(pool.calls[1].idleTtlMs).toBe(300000);   // AND the overflow-retry path
  });

  it('no config.yaml → idleTtlMs null (class TTL applies)', async () => {
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }]);   // default io: readFile → null
    await brain.turn('e', ev);
    expect(pool.calls[0].idleTtlMs).toBe(null);
  });
});

describe('brainpool.turn — local sibling beings', () => {
  const sibCfg = { siblings: { wren: { type: 'ccode', name: 'wren', model: 'claude-y', effort: 'high', allowed_tools: 'Read,Bash' } } };

  it('uses the config def (model/effort/allowed_tools reach brainOptions), keys by being+engine, no identity feed', async () => {
    const { brain, pool } = harness([{ text: 'ok', sessionId: 'w1' }], { config: sibCfg, loadFeed: async () => 'IGNORED', loadManifest: async () => 'IGNORED' });
    await brain.turn('wren', ev);
    expect(pool.calls[0].key).toMatch(/^wren:ccode:whatsapp:SPOILER-\d{10}$/);   // being+engine key
    expect(pool.calls[0].brainOptions).toMatchObject({ model: 'claude-y', effort: 'high', allowedTools: 'Read,Bash' });
    expect(pool.calls[0].message).toBe(ev.line);   // siblings get the raw line — no identity kickoff
  });

  it('writes NO readonly instancing for a sibling (its def lives in config)', async () => {
    const { brain, getState } = harness([{ text: 'ok', sessionId: 'w1' }], { config: sibCfg });
    await brain.turn('wren', ev);
    const entry = getState().contacts.whatsapp['!room:beeper.com'];
    expect(entry.readonly).toBeUndefined();         // no flat readonly
    expect(entry.wren?.readonly).toBeUndefined();    // nor a nested one
  });

  it('records the sibling thread in a NESTED block (E flat untouched) and RESUMES it next turn', async () => {
    const { brain, pool, getState } = harness([{ text: 'a', sessionId: 'w1' }, { text: 'b', sessionId: 'w1' }], { config: sibCfg });
    await brain.turn('wren', ev);
    expect(getBeing(getState(), 'whatsapp', '!room:beeper.com', 'wren').threadId).toBe('w1');
    expect(getBeing(getState(), 'whatsapp', '!room:beeper.com', 'e').threadId).toBe(null);   // E's flat thread stays empty
    await brain.turn('wren', ev);
    expect(pool.calls[0].brainOptions.sessionId).toBe(null);   // first turn: fresh
    expect(pool.calls[1].brainOptions.sessionId).toBe('w1');   // second resumes the nested thread
  });

  it('a LOCAL agent\'s type file (agents block) is resolved through the registry — no readonly instancing', async () => {
    const brains = { resolve: (name) => name === 'sonnet-high' ? ({ name: 'sonnet-high', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: 'Read,Bash' }) : null };
    const config = { agents: { 'don-local': { type: 'sonnet-high', name: 'Don' } } };
    const { brain, pool, getState } = harness([{ text: 'ok', sessionId: 'd1' }], { brains, config });
    await brain.turn('don-local', ev);
    expect(pool.calls[0].key).toMatch(/^don-local:ccode:whatsapp:SPOILER-\d{10}$/);
    expect(pool.calls[0].brainOptions).toMatchObject({ model: 'sonnet', effort: 'high', allowedTools: 'Read,Bash' });
    expect(pool.calls[0].message).toBe(ev.line);   // a local agent is an engineer — no identity kickoff
    const entry = getState().contacts.whatsapp['!room:beeper.com'];
    expect(entry['don-local']?.readonly).toBeUndefined();   // def lives in config → not instanced
  });
});

describe('getBeing — readonly.brain / readonly.agent back-read (vocabulary rename)', () => {
  const mk = (ro) => ({ contacts: { whatsapp: { '!r:beeper.local': { slug: 'x', readonly: ro } } } });
  it('resolves the def name from a LEGACY readonly.brain entry (un-migrated state)', () => {
    const v = getBeing(mk({ brain: 'default', type: 'ccode', model: null }), 'whatsapp', '!r:beeper.local', 'e');
    expect(v.brain).toBe('default');
    expect(v.agent).toBe('default');     // the alias resolves too
    expect(v.brainType).toBe('ccode');
  });
  it('resolves the def name from a NEW readonly.agent entry (migrated / freshly instanced state)', () => {
    const v = getBeing(mk({ agent: 'sonnet-high', type: 'ccode' }), 'whatsapp', '!r:beeper.local', 'e');
    expect(v.brain).toBe('sonnet-high');
    expect(v.agent).toBe('sonnet-high');
  });
});

describe('parseWarmBlock', () => {
  it('absent block / malformed / garbage → null', () => {
    expect(parseWarmBlock('').idleTtlMs).toBe(null);
    expect(parseWarmBlock(null).idleTtlMs).toBe(null);
    expect(parseWarmBlock('foo: bar').idleTtlMs).toBe(null);          // no warm block
    expect(parseWarmBlock('warm: not-a-map').idleTtlMs).toBe(null);   // warm not an object
    expect(parseWarmBlock('warm:\n  idle_ttl: nonsense').idleTtlMs).toBe(null);   // unparseable value
    expect(parseWarmBlock('warm:\n  idle_ttl: -5').idleTtlMs).toBe(null);         // negative → null
    expect(parseWarmBlock(': : bad yaml :').idleTtlMs).toBe(null);    // malformed YAML
  });
  it('duration string → ms via parseFrequency', () => {
    expect(parseWarmBlock('warm:\n  idle_ttl: 1h').idleTtlMs).toBe(3_600_000);
    expect(parseWarmBlock('warm:\n  idle_ttl: 5m').idleTtlMs).toBe(300_000);
    expect(parseWarmBlock('warm:\n  idle_ttl: 900000').idleTtlMs).toBe(900_000);   // bare ms number
  });
  it('idle_ttl: 0 → 0 (never evict — accepted despite parseFrequency rejecting 0)', () => {
    expect(parseWarmBlock('warm:\n  idle_ttl: 0').idleTtlMs).toBe(0);
  });
});
