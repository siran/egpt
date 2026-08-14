// brainpool (the Brain port): warm key, session resume/persist, the §7
// context-overflow backstop (reset + retry once fresh), and the identity kickoff
// (fresh thread → first turn wrapped with the feed; resumed thread → raw).
// Against a fake warm pool + in-memory conv-state. No claude, no spawn.
import { describe, it, expect, vi } from 'vitest';
import { createBrainPool, parseWarmBlock } from '../src/spine/brainpool.mjs';
import { createContacts } from '../src/spine/contacts.mjs';
import { createBrains } from '../src/spine/brains.mjs';
import { ConversationRoom } from '../src/room-core.mjs';
import { buildClaudeArgs, DEFAULT_ALLOWED_TOOLS } from '../src/claude-args.mjs';
import { emptyState, getBeing, getContact, ensureContact, recordThread, patchContact, patchBeing, slugDir } from '../src/conversations-state.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

function harness(scriptedResults, { config = {}, isOverflow, isDeadSession, loadFeed, loadManifest, loadAutoLayer, seedSession, seedMode, seedReadonly, seedAgents, brains, afterTurn, io, nodeIdentity, seedLayers, resolveConfig, loadPermission } = {}) {
  let state = emptyState();
  if (seedSession || seedMode || seedReadonly || seedAgents) {   // pre-register the contact (WITH a stored thread, an E mode, a freeze and/or an operator pin)
    const ens = ensureContact(state, ev.surface, ev.chatId, { pushedName: ev.chatName, slugHint: ev.chatName });
    state = ens.state;
    // Seed the persona under its NESTED 'e' block (operator 2026-07-10: the persona is a normal
    // nested being; the brainpool defaults defaultKey to 'e', so 'e' is the persona here).
    if (seedSession) state = recordThread(state, ev.surface, ev.chatId, seedSession, undefined, 'e');
    if (seedMode) {
      const prior = getContact(state, ev.surface, ev.chatId)?.entry?.e ?? {};
      state = patchContact(state, ev.surface, ev.chatId, { e: { ...prior, mode: seedMode } });   // e.g. 'auto'
    }
    if (seedReadonly) {   // a PREVIOUS instancing left frozen in entry.e.readonly
      const prior = getContact(state, ev.surface, ev.chatId)?.entry?.e ?? {};
      state = patchContact(state, ev.surface, ev.chatId, { e: { ...prior, readonly: seedReadonly } });
    }
    if (seedAgents) state = patchContact(state, ev.surface, ev.chatId, { agents: seedAgents });   // the operator's per-conversation pin
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
    // don't touch disk; writeFile is a no-op so the stats.yaml thread-mirror stays
    // in-memory (never writes into a real profile folder)
    io: io ?? { mkdir: async () => {}, readFile: async () => null, writeFile: async () => {} },
    // the config RESOLVER's per-entity lookup — default: nothing resolved anywhere, so no
    // warm override (the class TTL applies)
    resolveConfig: resolveConfig ?? (() => ({})),
    loadFeed: loadFeed ?? (async () => ''),        // default: no folder feed
    loadManifest: loadManifest ?? (async () => ''),// default: no manifest → raw line (focus on warm logic)
    ...(nodeIdentity != null ? { nodeIdentity } : {}),   // persona node-identity addendum (operator 2026-07-10)
    ...(seedLayers ? { seedLayers } : {}),         // the identity.d copy (default: the real seeder)
    ...(loadAutoLayer ? { loadAutoLayer } : {}),   // the mode:auto operator-role layer (default: real file)
    ...(brains ? { brains } : {}),                 // omit → falls back to a bare ccode def
    ...(afterTurn ? { afterTurn } : {}),
    ...(isOverflow ? { isOverflow } : {}),
    ...(isDeadSession ? { isDeadSession } : {}),
    ...(loadPermission ? { loadPermission } : {}),
  });
  return { brain, pool, getState: () => state, setState: (s) => { state = s; } };
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

  it('evict(being, ev) drops EXACTLY the warm key the conversation last ran (DEFECT 2 timeout hook)', async () => {
    const { brain, pool } = harness([{ text: 'hi', sessionId: 'sid-1' }]);
    await brain.turn('e', ev);
    const key = pool.calls[0].key;                 // e:ccode:whatsapp:SPOILER-<digits>
    brain.evict('e', ev);
    expect(pool.evicted).toEqual([key]);
    // a conversation that never ran → no-op (nothing to evict)
    brain.evict('e', { ...ev, chatId: '!never:beeper.com' });
    expect(pool.evicted).toEqual([key]);
  });

  it('resumes the stored session: 2nd turn passes sessionId from the 1st', async () => {
    const { brain, pool } = harness([{ text: 'a', sessionId: 'sid-1' }, { text: 'b', sessionId: 'sid-1' }]);
    await brain.turn('e', ev);
    await brain.turn('e', ev);
    expect(pool.calls[0].brainOptions.sessionId).toBe(null);    // first turn: no prior session
    expect(pool.calls[1].brainOptions.sessionId).toBe('sid-1'); // second turn resumes it (arms the re-pin guard)
  });

  // --- brain registry: instance-on-first-turn + freeze ---
  it('instances the default brain from the registry into readonly, keys by its engine', async () => {
    const brains = { resolve: () => ({ name: 'default', type: 'codex', model: 'gpt-5.4-mini', allowed_tools: 'all' }) };
    const { brain, pool, getState } = harness([{ text: 'ok', sessionId: 's' }], { brains });
    await brain.turn('e', ev);
    expect(pool.calls[0].key).toMatch(/^e:codex:whatsapp:SPOILER-\d{10}$/);       // engine from the brain, not hardcoded ccode
    expect(pool.calls[0].brainOptions).toMatchObject({ model: 'gpt-5.4-mini', allowedTools: DEFAULT_ALLOWED_TOOLS });
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
    const ro = getState().contacts.whatsapp['!room:beeper.com'].e.readonly;   // nested under the persona being (operator 2026-07-10)
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
    const ro = getState().contacts.whatsapp['!room:beeper.com'].e.readonly;   // nested under the persona being (operator 2026-07-10)
    expect(ro).toMatchObject({ agent: 'sonnet-high', type: 'ccode', model: 'opus', effort: 'low' });
    // the SAME resolved values reach the run (snapshot and run always agree)
    expect(pool.calls[0].brainOptions).toMatchObject({ model: 'opus', effort: 'low' });
  });

  it('mirrors a freshly-minted thread into the per-chat stats file (branch history) via the injected io', async () => {
    const writes = [];
    const io = { mkdir: async () => {}, readFile: async () => null, writeFile: async (p, data) => writes.push({ p, data }) };
    const { brain } = harness([{ text: 'ok', sessionId: 'sid-new' }], { io });
    await brain.turn('e', ev);
    // stats now live at state/stats/<surface>/<chatId>.yaml — the file IS <chatId>.yaml, not 'stats.yaml'.
    const statsWrite = writes.find((w) => String(w.p).endsWith(`${ev.chatId}.yaml`));
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
    const config = { agents: { egpt: { configuration: 'sonnet-high', handles: ['e', 'egpt'], default: true } } };
    const { brain, pool, getState } = harness([{ text: 'ok', sessionId: 's' }], { brains, config });
    await brain.turn('e', ev);
    expect(pool.calls[0].key).toMatch(/^e:ccode:whatsapp:SPOILER-\d{10}$/);
    expect(pool.calls[0].brainOptions).toMatchObject({ model: 'sonnet', effort: 'high', allowedTools: DEFAULT_ALLOWED_TOOLS });
    const view = getBeing(getState(), 'whatsapp', '!room:beeper.com', 'e');
    expect(view.brain).toBe('sonnet-high');    // instanced from the persona agent configuration
  });

  it('persona agent type that does NOT resolve falls through to the shipped "egpt" type', async () => {
    const brains = { resolve: (name) => name === 'egpt' ? ({ name: 'egpt', type: 'codex' }) : null };
    const config = { agents: { egpt: { configuration: 'ghost-type', handles: ['e', 'egpt'], default: true } } };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], { brains, config });
    await brain.turn('e', ev);
    expect(pool.calls[0].key).toMatch(/:codex:/);   // fell through to the last-resort 'egpt' type (codex)
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

  // THREAD-KEYED FRESHNESS (operator 2026-07-25: "deleting the thread-id reloads the config").
  // `fresh` used to key on the FREEZE, so deleting threadId bought a new claude session running
  // on the SAME stale frozen model/effort/tools — the gesture half-worked. It keys on the THREAD
  // now: no thread → re-read the config, re-freeze, and RUN on the re-read values.
  const RE_READ = { resolve: (n) => n === 'sonnet-high'
    ? ({ name: 'sonnet-high', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: ['Read', 'Grep'] }) : null };
  const RE_READ_CFG = { agents: { egpt: { configuration: 'sonnet-high', handles: ['e', 'egpt'], default: true } } };
  const STALE = { agent: 'stale', type: 'ccode', model: 'haiku', effort: 'low', allowed_tools: ['Read'] };

  it('threadId deleted with the freeze still on disk → the RUN uses the re-read config, and re-freezes', async () => {
    const { brain, pool, getState } = harness([{ text: 'ok', sessionId: 'sid-new' }], {
      brains: RE_READ, config: RE_READ_CFG, seedReadonly: STALE, loadFeed: async () => 'I am eGPT.',
    });
    await brain.turn('e', ev);
    // the RUN itself — not just the stored snapshot
    expect(pool.calls[0].brainOptions).toMatchObject({ model: 'sonnet', effort: 'high', allowedTools: ['Read', 'Grep'] });
    expect(pool.calls[0].brainOptions.sessionId).toBe(null);          // a new claude session, as before
    // …and the freeze was rewritten from config (the stale one is gone)
    expect(getState().contacts.whatsapp['!room:beeper.com'].e.readonly)
      .toMatchObject({ agent: 'sonnet-high', type: 'ccode', model: 'sonnet', effort: 'high' });
    // the identity kickoff re-injects on this path (it was ALREADY thread-keyed: `if (!sessionId)`)
    expect(pool.calls[0].message).toContain('I am eGPT.');
  });

  it('…and the conversation\'s own agents.<name> pin beats the re-read default on that run', async () => {
    const { brain, pool, getState } = harness([{ text: 'ok', sessionId: 'sid-new' }], {
      brains: RE_READ, config: RE_READ_CFG, seedReadonly: STALE, seedAgents: { e: { model: 'opus' } },
    });
    await brain.turn('e', ev);
    expect(pool.calls[0].brainOptions).toMatchObject({ model: 'opus', effort: 'high' });   // pin wins on model, config supplies the rest
    const entry = getState().contacts.whatsapp['!room:beeper.com'];
    expect(entry.e.readonly).toMatchObject({ agent: 'sonnet-high', model: 'sonnet' });     // the freeze records what CONFIG said
    expect(entry.agents.e).toEqual({ model: 'opus' });                                     // the operator's block is not machine state
  });

  it('a LIVE thread still runs on its freeze — a config re-point does NOT retro-alter it', async () => {
    const { brain, pool } = harness([{ text: 'ok', sessionId: 'sid' }], {
      brains: RE_READ, config: RE_READ_CFG, seedSession: 'sid', seedReadonly: STALE,
    });
    await brain.turn('e', ev);
    expect(pool.calls[0].brainOptions).toMatchObject({ model: 'haiku', effort: 'low' });   // frozen, untouched
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

  // --- mode: auto operator-role instruction layer (ROADMAP §3) ---
  it('FRESH auto thread: the kickoff feed carries the operator-role auto layer', async () => {
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], {
      seedMode: 'auto', loadFeed: async () => 'I am eGPT.', loadAutoLayer: async () => 'AUTO-ROLE-LAYER',
    });
    await brain.turn('e', ev);
    const msg = pool.calls[0].message;
    expect(msg).toContain('I am eGPT.');          // identity still there
    expect(msg).toContain('AUTO-ROLE-LAYER');     // auto layer appended to the kickoff
    expect(msg.endsWith(ev.line)).toBe(true);     // the live line at the tail
  });

  it('FRESH NON-auto thread: no auto layer (loadAutoLayer never consulted)', async () => {
    let consulted = false;
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], {
      loadFeed: async () => 'I am eGPT.', loadAutoLayer: async () => { consulted = true; return 'AUTO-ROLE-LAYER'; },
    });
    await brain.turn('e', ev);
    expect(consulted).toBe(false);
    expect(pool.calls[0].message).not.toContain('AUTO-ROLE-LAYER');
  });

  it('mode-flip: a RESUMED thread that switched to auto gets the layer ONCE (first turn after the flip only)', async () => {
    const { brain, pool } = harness([{ text: 'a', sessionId: 'sid' }, { text: 'b', sessionId: 'sid' }], {
      seedSession: 'sid', seedMode: 'auto', loadFeed: async () => 'FEED', loadAutoLayer: async () => 'AUTO-ROLE-LAYER',
    });
    await brain.turn('e', ev);                    // first turn after the flip
    await brain.turn('e', ev);                    // second turn
    expect(pool.calls[0].brainOptions.sessionId).toBe('sid');   // genuinely resumed (not fresh)
    expect(pool.calls[0].message).toContain('AUTO-ROLE-LAYER');  // layer injected once…
    expect(pool.calls[0].message).toContain(ev.line);           // …ahead of the live line
    expect(pool.calls[0].message).not.toContain('FEED');        // resume: identity NOT re-sent, only the auto stance
    expect(pool.calls[1].message).toBe(ev.line);                // second turn: raw line, no re-inject
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

  // --- dead-session backstop (stored threadId's CLI session store is gone) ---
  it('dead session THROWN → evict + retry once on a fresh session, new session gets recorded', async () => {
    const { brain, pool, getState } = harness([
      () => Promise.reject(new Error('error_during_execution\nNo conversation found with session ID: e78d812a-1234')),
      { text: 'fresh ok', sessionId: 'sid-new' },
    ], { seedSession: 'dead-sid' });
    const out = await brain.turn('e', ev);
    expect(out.text).toBe('fresh ok');
    expect(pool.evicted).toHaveLength(1);                          // the wedged key was evicted
    expect(pool.calls).toHaveLength(2);
    expect(pool.calls[0].brainOptions.sessionId).toBe('dead-sid'); // first tried the stored (dead) session
    expect(pool.calls[1].brainOptions.sessionId).toBe(null);       // retry is fresh — no resume
    expect(getBeing(getState(), 'whatsapp', '!room:beeper.com', 'e').threadId).toBe('sid-new'); // self-healed
  });

  it('retry happens at most once: two consecutive dead-session errors propagate', async () => {
    const { brain } = harness([
      () => Promise.reject(new Error('No conversation found with session ID: e78d812a-1234')),
      () => Promise.reject(new Error('No conversation found with session ID: e78d812a-1234')),
    ], { seedSession: 'dead-sid' });
    await expect(brain.turn('e', ev)).rejects.toThrow(/No conversation found/);
  });

  // --- per-conversation warm idle_ttl override (operator 2026-07-02) ---
  // The value comes from the RESOLVED config now (src/spine/config-resolver.mjs configFor,
  // injected as resolveConfig) — node config.yaml < the conversations.yaml entry < the
  // conversation's own folder — not from brainpool opening the folder file itself.
  it('passes the resolved warm idle_ttl override to pool.run (normal + overflow retry)', async () => {
    const { brain, pool } = harness([
      () => Promise.reject(new Error('claude: error_during_execution\n  Prompt is too long')),
      { text: 'fresh ok', sessionId: 'sid-2' },
    ], { seedSession: 'huge', resolveConfig: () => ({ warm: { idle_ttl: '5m' } }) });
    const out = await brain.turn('e', ev);
    expect(out.text).toBe('fresh ok');
    expect(pool.calls).toHaveLength(2);
    expect(pool.calls[0].idleTtlMs).toBe(300000);   // normal turn carries the override
    expect(pool.calls[1].idleTtlMs).toBe(300000);   // AND the overflow-retry path
  });

  it('no warm block at any rung → idleTtlMs null (class TTL applies)', async () => {
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }]);   // default resolveConfig → {}
    await brain.turn('e', ev);
    expect(pool.calls[0].idleTtlMs).toBe(null);
  });
});

describe('brainpool.turn — local sibling beings (agents registry)', () => {
  it('a LOCAL agent\'s type file (agents block) is resolved through the registry — no readonly instancing', async () => {
    const brains = { resolve: (name) => name === 'sonnet-high' ? ({ name: 'sonnet-high', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: 'Read,Bash' }) : null };
    const config = { agents: { 'don-local': { configuration: 'sonnet-high', name: 'Don' } } };
    const { brain, pool, getState } = harness([{ text: 'ok', sessionId: 'd1' }], { brains, config });
    await brain.turn('don-local', ev);
    expect(pool.calls[0].key).toMatch(/^don-local:ccode:whatsapp:SPOILER-\d{10}$/);
    expect(pool.calls[0].brainOptions).toMatchObject({ model: 'sonnet', effort: 'high', allowedTools: 'Read,Bash' });
    expect(pool.calls[0].message).toBe(ev.line);   // a local agent is an engineer — no identity kickoff
    const entry = getState().contacts.whatsapp['!room:beeper.com'];
    expect(entry['don-local']?.readonly).toBeUndefined();   // def lives in config → not instanced
  });

  it('records the local agent thread in a NESTED block (E flat untouched) and RESUMES it next turn', async () => {
    const brains = { resolve: (name) => name === 'sonnet-high' ? ({ name: 'sonnet-high', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: 'Read,Bash' }) : null };
    const config = { agents: { wren: { configuration: 'sonnet-high', name: 'wren' } } };
    const { brain, pool, getState } = harness([{ text: 'a', sessionId: 'w1' }, { text: 'b', sessionId: 'w1' }], { brains, config });
    await brain.turn('wren', ev);
    expect(getBeing(getState(), 'whatsapp', '!room:beeper.com', 'wren').threadId).toBe('w1');
    expect(getBeing(getState(), 'whatsapp', '!room:beeper.com', 'e').threadId).toBe(null);   // E's flat thread stays empty
    await brain.turn('wren', ev);
    expect(pool.calls[0].brainOptions.sessionId).toBe(null);   // first turn: fresh
    expect(pool.calls[1].brainOptions.sessionId).toBe('w1');   // second resumes the nested thread
  });
});

// READABLE NODE-IDENTITY (operator 2026-07-10): the persona's who/where-am-I addendum is appended
// to the PERSONA turn's system prompt so it survives RESUMED threads (the first-turn kickoff feed
// only lands on a fresh thread). It COMBINES with the def's own system_prompt (both), never
// replaces it. Siblings are engineers — out of scope, their turn never carries it.
describe('brainpool.turn — node-identity system prompt', () => {
  const NODE_ID = 'You are the eGPT persona "Don" running as don.do — node "do".';

  it('PERSONA turn: appendSystemPrompt COMBINES nodeIdentity with the def system_prompt (both present)', async () => {
    const brains = { resolve: () => ({ name: 'egpt', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: 'all', system_prompt: 'DEF-PROMPT' }) };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], { brains, nodeIdentity: NODE_ID });
    await brain.turn('e', ev);
    const asp = pool.calls[0].brainOptions.appendSystemPrompt;
    expect(asp).toContain(NODE_ID);        // node identity present
    expect(asp).toContain('DEF-PROMPT');   // the def's own system prompt ALSO present — combined, not replaced
  });

  it('PERSONA turn with NO def system_prompt: appendSystemPrompt is exactly the nodeIdentity', async () => {
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], { nodeIdentity: NODE_ID });
    await brain.turn('e', ev);
    expect(pool.calls[0].brainOptions.appendSystemPrompt).toBe(NODE_ID);
  });

  it('SIBLING turn: appendSystemPrompt does NOT include the nodeIdentity', async () => {
    const brains = { resolve: (name) => name === 'sonnet-high' ? ({ name: 'sonnet-high', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: 'Read,Bash' }) : null };
    const config = { agents: { wren: { configuration: 'sonnet-high', name: 'wren' } } };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 'w1' }], { brains, config, nodeIdentity: NODE_ID });
    await brain.turn('wren', ev);
    const asp = pool.calls[0].brainOptions.appendSystemPrompt;
    expect(asp === undefined || !String(asp).includes(NODE_ID)).toBe(true);   // a sibling turn never carries the node identity
  });
});

// Read every value that follows a given flag in a flat argv.
const argVals = (args, flag) => args.reduce((acc, a, i) => (a === flag ? [...acc, args[i + 1]] : acc), []);

describe('brainpool.turn — confine-by-default (allowed_tools list) + allowed_paths', () => {
  it('a LIST allowed_tools def → brainOptions carry confineToDirs [the conversation dir]; buildClaudeArgs sandboxes it', async () => {
    const brains = { resolve: () => ({ name: 'egpt', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: ['Read', 'Grep', 'WebFetch'] }) };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], { brains });
    await brain.turn('e', ev);
    const opts = pool.calls[0].brainOptions;
    expect(opts.confineToDirs).toEqual([opts.cwd]);            // confined to the conversation dir
    expect(opts.allowedTools).toEqual(['Read', 'Grep', 'WebFetch']);
    // end-to-end through the tested arg builder: sandbox flags, cwd added, file tools path-confined
    const args = buildClaudeArgs(opts);
    expect(argVals(args, '--add-dir')).toContain(opts.cwd);
    expect(argVals(args, '--setting-sources')).toEqual(['']);  // no ~/.claude inherit (sandbox)
    expect(argVals(args, '--permission-mode')).toEqual(['default']);
    expect(args).not.toContain('--dangerously-skip-permissions');
    const allow = argVals(args, '--allowedTools')[0].split(' ');
    expect(allow).toContain('WebFetch');                       // non-file tool pre-approved
    expect(allow).not.toContain('Read');                       // file tool stays path-confined
  });

  it('allowed_paths: null grant → --add-dir (full access); tool list w/o write tools → deny rules (read-only), end-to-end', async () => {
    const brains = { resolve: () => ({
      name: 'egpt', type: 'ccode', allowed_tools: ['Read', 'Edit'],
      allowed_paths: {
        '/c/work/project':   null,                                     // full access (read + write)
        '/c/work/reference': { allowed_tools: ['Read', 'Glob', 'Grep'] },   // READ-ONLY (omits write tools)
      },
    }) };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], { brains });
    await brain.turn('e', ev);
    const opts = pool.calls[0].brainOptions;
    expect(opts.confineToDirs).toEqual([opts.cwd]);
    expect(opts.addDirs).toEqual(['C:/work/project']);          // msys → windows, full access
    expect(opts.readOnlyDirs).toEqual(['C:/work/reference']);   // read-only
    const args = buildClaudeArgs(opts);
    // all three roots readable via --add-dir
    expect(argVals(args, '--add-dir')).toEqual(expect.arrayContaining([opts.cwd, 'C:/work/project', 'C:/work/reference']));
    // the RO root is write-denied; the full-access root is NOT
    const deny = JSON.parse(argVals(args, '--settings')[0]).permissions.deny;
    expect(deny).toContain('Write(C:/work/reference/**)');
    expect(deny).toContain('Edit(C:/work/reference/**)');
    expect(deny.some((r) => r.includes('C:/work/project'))).toBe(false);
  });

  it('per-path tool list WITH write tools → treated as full access (+ logged), not read-only', async () => {
    const logs = [];
    const brains = { resolve: () => ({
      name: 'egpt', type: 'ccode', allowed_tools: ['Read'],
      allowed_paths: { '/c/work/rw': { allowed_tools: ['Read', 'Write'] } },   // includes a write tool
    }) };
    const { brain, pool } = harnessWithLog(logs, brains);
    await brain.turn('e', ev);
    const opts = pool.calls[0].brainOptions;
    expect(opts.addDirs).toEqual(['C:/work/rw']);               // full access, not RO
    expect(opts.readOnlyDirs).toBeUndefined();
    expect(logs.join('\n')).toMatch(/per-path tool granularity beyond read-only isn't native/);
  });

  it("'all' def is REJECTED → coerced to the explicit list, CONFINED, no bypass (operator 2026-07-03)", async () => {
    const brains = { resolve: () => ({ name: 'egpt', type: 'ccode', allowed_tools: 'all' }) };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], { brains });
    await brain.turn('e', ev);
    const opts = pool.calls[0].brainOptions;
    // 'all' now behaves exactly like the default list: confined to the conversation dir,
    // the explicit tool list, and NO --dangerously-skip-permissions.
    expect(opts.confineToDirs).toEqual([opts.cwd]);
    expect(opts.allowedTools).toEqual(DEFAULT_ALLOWED_TOOLS);
    const args = buildClaudeArgs(opts);
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(argVals(args, '--add-dir')).toEqual([opts.cwd]);    // confined — the conversation dir is a root
  });
});

// ── DANGEROUS:true (operator 2026-08 meta-engineer) — the ONE unconfined tier. Skips BOTH
//    coerceAllowedTools (an 'all'/list allowed_tools list runs verbatim, incl. bare Bash/Agent)
//    AND confinementFor (no confineToDirs/addDirs/readOnlyDirs, ever) at every def-resolution
//    call site in turn() — the persona (fresh-instance) path, the sibling path, and the
//    freeze-read-back path. A NON-dangerous def must stay bitwise unchanged (regression lock —
//    every pre-existing test above already re-asserts this unmodified). ──
describe('brainpool.turn — dangerous:true skips coercion + confinement (operator 2026-08 meta-engineer)', () => {
  it('PERSONA def dangerous:true → allowedTools pass through verbatim (incl. bare Bash/Agent), NO confineToDirs/addDirs/readOnlyDirs', async () => {
    const brains = { resolve: () => ({ name: 'meta-engineer', type: 'ccode', model: 'sonnet', effort: 'high', dangerous: true, allowed_tools: ['Read', 'Write', 'Bash', 'Agent'] }) };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], { brains });
    await brain.turn('e', ev);
    const opts = pool.calls[0].brainOptions;
    expect(opts.allowedTools).toEqual(['Read', 'Write', 'Bash', 'Agent']);   // verbatim — bare Bash survived, never coerced
    expect(opts.confineToDirs).toBeUndefined();
    expect(opts.addDirs).toBeUndefined();
    expect(opts.readOnlyDirs).toBeUndefined();
    // end-to-end through the real arg builder: no sandbox flags, a plain --allowedTools with Bash present
    const args = buildClaudeArgs(opts);
    expect(argVals(args, '--setting-sources')).toEqual([]);
    expect(argVals(args, '--permission-mode')).toEqual([]);
    expect(argVals(args, '--add-dir')).toEqual([]);
    expect(argVals(args, '--allowedTools')[0]).toContain('Bash');
  });

  it('SIBLING def dangerous:true (agents registry, never frozen) → same unconfined behavior', async () => {
    const brains = { resolve: (name) => name === 'meta-engineer' ? ({ name: 'meta-engineer', type: 'ccode', model: 'sonnet', effort: 'high', dangerous: true, allowed_tools: ['Read', 'Bash'] }) : null };
    const config = { agents: { wren: { configuration: 'meta-engineer', name: 'wren' } } };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 'w1' }], { brains, config });
    await brain.turn('wren', ev);
    const opts = pool.calls[0].brainOptions;
    expect(opts.allowedTools).toEqual(['Read', 'Bash']);
    expect(opts.confineToDirs).toBeUndefined();
  });

  it("a dangerous def's OWN 'all'/'*' also passes through unrejected (dangerous means dangerous — coercion never runs)", async () => {
    const brains = { resolve: () => ({ name: 'meta-engineer', type: 'ccode', dangerous: true, allowed_tools: 'all' }) };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], { brains });
    await brain.turn('e', ev);
    expect(pool.calls[0].brainOptions.allowedTools).toBe('all');   // NOT coerced to DEFAULT_ALLOWED_TOOLS
    expect(pool.calls[0].brainOptions.confineToDirs).toBeUndefined();
  });

  it('REGRESSION: a NON-dangerous def (dangerous absent) is bitwise unchanged — still coerced + confined', async () => {
    const brains = { resolve: () => ({ name: 'egpt', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: 'all' }) };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], { brains });
    await brain.turn('e', ev);
    const opts = pool.calls[0].brainOptions;
    expect(opts.allowedTools).toEqual(DEFAULT_ALLOWED_TOOLS);   // 'all' still rejected → coerced
    expect(opts.confineToDirs).toEqual([opts.cwd]);              // still confined
  });

  it('REGRESSION: dangerous: false (explicit) behaves exactly like absent — coerced + confined', async () => {
    const brains = { resolve: () => ({ name: 'egpt', type: 'ccode', dangerous: false, allowed_tools: 'all' }) };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], { brains });
    await brain.turn('e', ev);
    const opts = pool.calls[0].brainOptions;
    expect(opts.allowedTools).toEqual(DEFAULT_ALLOWED_TOOLS);
    expect(opts.confineToDirs).toEqual([opts.cwd]);
  });
});

// ── /e access all|regular — accessLevel OVERRIDE (operator 2026-08-14). Applied live,
//    every turn, independent of the fresh/frozen instancing above — the whole point vs.
//    the old freeze-into-readonly shape. Persona-only; a sibling turn is untouched. ──
describe('brainpool.turn — accessLevel override (operator 2026-08-14, /e access)', () => {
  it("accessLevel 'all' overrides dangerous/allowedTools even on an ALREADY-FROZEN (instanced) thread — no re-freeze needed", async () => {
    const STALE_RO = { agent: 'sonnet-high', type: 'ccode', model: 'haiku', effort: 'low', allowed_tools: ['Read'] };
    const { brain, pool, getState } = harness([{ text: 'ok', sessionId: 'sid-live' }], {
      seedSession: 'sid-live', seedReadonly: STALE_RO, seedAgents: { e: { access_level: 'all' } },
      loadPermission: (level) => (level === 'all' ? { dangerous: true, allowedTools: ['Read', 'Write', 'Bash', 'Agent'] } : null),
    });
    await brain.turn('e', ev);
    const opts = pool.calls[0].brainOptions;
    expect(opts.allowedTools).toEqual(['Read', 'Write', 'Bash', 'Agent']);   // the permissions file's grant, not the stale freeze's ['Read']
    expect(opts.confineToDirs).toBeUndefined();                             // dangerous:true → unconfined
    expect(opts.sessionId).toBe('sid-live');                                // genuinely resumed — this was NOT a fresh/re-instance turn
    // the readonly freeze itself is UNCHANGED — proves this is a live override, not a re-freeze
    expect(getState().contacts.whatsapp['!room:beeper.com'].e.readonly).toEqual(STALE_RO);
  });

  it("accessLevel 'regular' overrides dangerous/allowedTools to a confined grant on a fresh (never-instanced) turn too", async () => {
    const brains = { resolve: () => ({ name: 'meta-engineer', type: 'ccode', model: 'sonnet', effort: 'high', dangerous: true, allowed_tools: ['Read', 'Bash'] }) };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], {
      brains, seedAgents: { e: { access_level: 'regular' } },
      loadPermission: (level) => (level === 'regular' ? { dangerous: false, allowedTools: DEFAULT_ALLOWED_TOOLS } : null),
    });
    await brain.turn('e', ev);
    const opts = pool.calls[0].brainOptions;
    expect(opts.allowedTools).toEqual(DEFAULT_ALLOWED_TOOLS);   // overrides the instanced dangerous:true def entirely
    expect(opts.confineToDirs).toEqual([opts.cwd]);             // confined, not the def's own unconfined tier
  });

  it('editing the permissions-file RESULT between two turns of the SAME conversation changes the SECOND turn — no /e access re-run, proves live re-read (no caching)', async () => {
    let grant = { dangerous: true, allowedTools: ['Read', 'Bash'] };
    const { brain, pool } = harness([{ text: 'a', sessionId: 'sid' }, { text: 'b', sessionId: 'sid' }], {
      seedAgents: { e: { access_level: 'all' } },
      loadPermission: () => grant,
    });
    await brain.turn('e', ev);                                             // turn 1: sees the first grant
    grant = { dangerous: false, allowedTools: ['Read', 'Grep'] };           // "editing the file" — same access_level, different content
    await brain.turn('e', ev);                                             // turn 2: no command re-run
    expect(pool.calls[0].brainOptions.allowedTools).toEqual(['Read', 'Bash']);
    expect(pool.calls[0].brainOptions.confineToDirs).toBeUndefined();
    expect(pool.calls[1].brainOptions.allowedTools).toEqual(['Read', 'Grep']);
    expect(pool.calls[1].brainOptions.confineToDirs).toEqual([pool.calls[1].brainOptions.cwd]);
  });

  it('a SIBLING turn is never affected by accessLevel — persona-only override', async () => {
    const brains = { resolve: (name) => name === 'sonnet-high' ? ({ name: 'sonnet-high', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: ['Read', 'Bash'] }) : null };
    const config = { agents: { wren: { configuration: 'sonnet-high', name: 'wren' } } };
    let called = false;
    // even a persona access_level pin present on the same conversation must not reach the sibling turn
    const { brain, pool } = harness([{ text: 'ok', sessionId: 'w1' }], {
      brains, config, seedAgents: { e: { access_level: 'all' }, wren: {} },
      loadPermission: () => { called = true; return { dangerous: true, allowedTools: ['Bash'] }; },
    });
    await brain.turn('wren', ev);
    expect(called).toBe(false);
    expect(pool.calls[0].brainOptions.allowedTools).toEqual(['Read', 'Bash']);   // wren's own def, unmodified
  });

  it('REGRESSION: accessLevel null/unset (the default) never consults loadPermission — byte-identical to current committed behavior', async () => {
    const brains = { resolve: () => ({ name: 'egpt', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: 'all' }) };
    let called = false;
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], {
      brains, loadPermission: () => { called = true; return { dangerous: true, allowedTools: ['Bash'] }; },
    });
    await brain.turn('e', ev);
    expect(called).toBe(false);
    const opts = pool.calls[0].brainOptions;
    expect(opts.allowedTools).toEqual(DEFAULT_ALLOWED_TOOLS);   // 'all' still rejected → coerced, exactly as before this feature
    expect(opts.confineToDirs).toEqual([opts.cwd]);
  });

  it('end-to-end with the REAL config/permissions/*.md files (no injected loadPermission): all → dangerous + bare Bash/Agent, regular → confined DEFAULT_ALLOWED_TOOLS', async () => {
    const brains = { resolve: () => ({ name: 'sonnet-high', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: ['Read'] }) };
    const all = harness([{ text: 'ok', sessionId: 's' }], { brains, seedAgents: { e: { access_level: 'all' } } });
    await all.brain.turn('e', ev);
    const optsAll = all.pool.calls[0].brainOptions;
    expect(optsAll.allowedTools).toEqual(expect.arrayContaining(['Bash', 'Agent']));
    expect(optsAll.confineToDirs).toBeUndefined();

    const regular = harness([{ text: 'ok', sessionId: 's' }], { brains, seedAgents: { e: { access_level: 'regular' } } });
    await regular.brain.turn('e', ev);
    const optsRegular = regular.pool.calls[0].brainOptions;
    expect(optsRegular.allowedTools).toEqual(DEFAULT_ALLOWED_TOOLS);
    expect(optsRegular.confineToDirs).toEqual([optsRegular.cwd]);
  });
});

// ── END-TO-END escalation-hole regression (operator 2026-08): a confined being already
//    has Write access inside its OWN conversation directory, so it can write
//    <convDir>/brains/<name>.yaml. Proves the fix in src/spine/brains.mjs's resolve()
//    closes the hole at the REAL runtime call site (siblingDef → brains.resolve), using
//    the REAL createBrains() and REAL files on disk — not the injected/mock `brains`
//    object the tests above use. ConversationRoom.prototype.baseDir is spied so the
//    conversation resolves into a throwaway temp dir instead of the real ~/.egpt profile
//    (the house convention — see tests/spine-boot-radio-relay.test.mjs — sets EGPT_HOME
//    itself, but that must happen before this file's top-level imports run; spying
//    baseDir() achieves the same isolation without touching module-load order).
describe('brainpool.turn — dangerous:true escalation hole is closed end-to-end (real createBrains, real files)', () => {
  it('a conv-local brains/<name>.yaml attempting dangerous:true does NOT unconfine a sibling turn', async () => {
    const tmpBase = mkdtempSync(join(tmpdir(), 'egpt-brains-e2e-'));
    const builtinDir = join(tmpBase, 'builtin');
    const convDir = join(tmpBase, 'conv');
    mkdirSync(builtinDir, { recursive: true });
    mkdirSync(join(convDir, 'brains'), { recursive: true });
    // a non-dangerous sibling type, shipped as a built-in
    writeFileSync(join(builtinDir, 'sonnet-high.yaml'), 'type: ccode\nmodel: sonnet\neffort: high\nallowed_tools:\n  - Read\n  - Bash\n', 'utf8');
    // THE ATTACK: a conv-local override — written by a being with ordinary Write access
    // to its own convDir — trying to grant itself dangerous:true (mirroring the real
    // attack shape: dangerous + a bare tool list).
    writeFileSync(join(convDir, 'brains', 'sonnet-high.yaml'), 'dangerous: true\nallowed_tools:\n  - Bash\n  - Agent\n', 'utf8');

    const realBrains = createBrains({ builtinDir, agentsDir: join(tmpBase, 'nonexistent-agents') });
    const config = { agents: { wren: { configuration: 'sonnet-high', name: 'wren' } } };

    const spy = vi.spyOn(ConversationRoom.prototype, 'baseDir').mockReturnValue(convDir);
    try {
      const { brain, pool } = harness([{ text: 'ok', sessionId: 'w1' }], { brains: realBrains, config });
      await brain.turn('wren', ev);
      const opts = pool.calls[0].brainOptions;
      // the hole: dangerous:true from the conv-local layer must NOT reach brainOptions —
      // the turn stays confined, exactly like the "REGRESSION: a NON-dangerous def" case above.
      expect(opts.confineToDirs).toEqual([opts.cwd]);
      const args = buildClaudeArgs(opts);
      expect(args).not.toContain('--dangerously-skip-permissions');
      expect(argVals(args, '--add-dir')).toContain(opts.cwd);
      expect(argVals(args, '--setting-sources')).toEqual(['']);          // sandboxed — no ~/.claude inherit
      expect(argVals(args, '--permission-mode')).toEqual(['default']);
    } finally {
      spy.mockRestore();
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});

// A harness variant that captures onLog (the write-tools-in-allowed_paths log line).
function harnessWithLog(logs, brains) {
  let state = emptyState();
  const pool = fakePool([{ text: 'ok', sessionId: 's' }]);
  const loadState = async () => state;
  const writeState = async (s) => { state = s; };
  const brain = createBrainPool({
    pool,
    getConfig: () => ({}),
    contacts: createContacts({ loadState, writeState, io: { mkdir: async () => {} } }),
    loadState, writeState,
    io: { mkdir: async () => {}, readFile: async () => null, writeFile: async () => {} },
    loadFeed: async () => '', loadManifest: async () => '',
    brains,
    onLog: (m) => logs.push(String(m)),
  });
  return { brain, pool };
}

describe('getBeing — readonly.agent read (new-config-only)', () => {
  // readonly lives in the being's NESTED block now (operator 2026-07-10 — the persona 'e' is a
  // normal nested being; no flat readonly fallback).
  const mk = (ro) => ({ contacts: { whatsapp: { '!r:beeper.local': { slug: 'x', e: { readonly: ro } } } } });
  it('resolves the def name from a readonly.agent entry', () => {
    const v = getBeing(mk({ agent: 'sonnet-high', type: 'ccode' }), 'whatsapp', '!r:beeper.local', 'e');
    expect(v.brain).toBe('sonnet-high');   // `brain` stays the returned property
    expect(v.agent).toBe('sonnet-high');   // `agent` is the alias
    expect(v.brainType).toBe('ccode');
  });
});

// THE FRESH MOMENT — what happens when a thread is (re-)instanced, i.e. the operator deleted
// threadId, /e new ran, or the session died. Two things the brainpool owes that moment:
// the retiring thread's transcript is archived under its own id and the new one is stamped
// (operator 2026-07-25: "there must be a new transcript if thread-id changes"), and the room
// template's layers are RE-COPIED (operator 2026-07-26: "all skeleton files are copied on
// refresh thread") so a conversation seeded months ago finally learns the current capabilities.
describe('brainpool.turn — the fresh moment', () => {
  const norm = (p) => String(p).replace(/\\/g, '/');
  const OLD = ['---', 'name: SPOILER', 'chat_id: !room:beeper.com', 'surface: whatsapp',
    'thread_id: THREAD-OLD', 'notes:', '---', '', 'hola', '', '[@e (14:05)]: hey', '', ''].join('\n');

  // A whole-profile fake fs keyed by path: the roll reads/renames/writes and the stamp
  // rewrites through it, so nothing touches a real folder.
  const fakeIo = (files) => ({
    files,
    io: {
      mkdir: async () => {},
      readFile: async (p) => {
        const k = norm(p);
        if (k in files) return files[k];
        if (k.endsWith('config.yaml')) return null;     // no warm override
        const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e;
      },
      writeFile: async (p, d) => { files[norm(p)] = d; },
      rename: async (a, b) => { files[norm(b)] = files[norm(a)]; delete files[norm(a)]; },
    },
  });
  const at = (files, suffix) => Object.entries(files).find(([p]) => p.endsWith(suffix))?.[1];

  it('archives the retiring thread under its own id and stamps the transcript with the new one', async () => {
    const fs = fakeIo({});
    const { brain, getState, setState } = harness([{ text: 'a', sessionId: 'sid-1' }, { text: 'b', sessionId: 'sid-2' }], { io: fs.io });
    await brain.turn('e', ev);                                      // turn 1: the conversation gets thread sid-1
    const conv = norm(slugDir('whatsapp', getContact(getState(), 'whatsapp', ev.chatId).slug));
    // the transcript sid-1 wrote — the shape the ingestion append + the stamp produce together
    const before = OLD.replace('THREAD-OLD', 'sid-1');
    fs.files[`${conv}/transcript.md`] = before;
    // THE OPERATOR'S GESTURE: delete threadId → the next turn is fresh (operator 2026-07-25)
    setState(patchBeing(getState(), 'whatsapp', ev.chatId, 'e', { threadId: null }));

    await brain.turn('e', ev);

    expect(fs.files[`${conv}/transcripts/sid-1.md`]).toBe(before);   // the retiring thread, every byte
    const now = fs.files[`${conv}/transcript.md`];
    expect(now).toContain('thread_id: sid-2');                       // …and the live file names the NEW thread
    expect(now).toContain('chat_id: !room:beeper.com');              // identity carried forward, chat id untouched
    expect(now).not.toContain('hola');                               // the turns went with the archive
  });

  it('a first-ever turn (no transcript yet) rolls nothing — and still stamps its own thread', async () => {
    const fs = fakeIo({});
    const { brain, getState } = harness([{ text: 'hi', sessionId: 'sid-1' }], { io: fs.io });
    await brain.turn('e', ev);
    const conv = norm(slugDir('whatsapp', getContact(getState(), 'whatsapp', ev.chatId).slug));
    expect(Object.keys(fs.files).filter((p) => p.includes('/transcripts/'))).toEqual([]);   // nothing archived
    expect(fs.files[`${conv}/transcript.md`]).toContain('thread_id: sid-1');
  });

  // A turn that THREW before the session was recorded leaves transcript.md un-stamped; the
  // next turn is fresh again and must NOT shred it. (The roll's own guard, end-to-end.)
  it('an un-stamped transcript is left alone by the roll', async () => {
    const fs = fakeIo({});
    const { brain, getState } = harness([{ text: 'hi', sessionId: 'sid-1' }], { io: fs.io });
    const seeded = ['---', 'name: SPOILER', 'chat_id: !room:beeper.com', 'notes:', '---', '', 'hola', '', ''].join('\n');
    // resolve the folder first (the resolver mints the slug), then plant the un-stamped file
    const { brain: b0, getState: s0 } = harness([{ text: 'x', sessionId: 'sid-0' }], { io: fakeIo({}).io });
    await b0.turn('e', ev);
    const conv = norm(slugDir('whatsapp', getContact(s0(), 'whatsapp', ev.chatId).slug));
    fs.files[`${conv}/transcript.md`] = seeded;
    await brain.turn('e', ev);
    expect(Object.keys(fs.files).filter((p) => p.includes('/transcripts/'))).toEqual([]);   // no archive
    expect(fs.files[`${conv}/transcript.md`]).toContain('hola');                            // nothing lost
  });

  // `fresh` is "instance the agent" — it also fires for a thread that has no FREEZE (the
  // re-instancing case). That turn resumes the very same session, so nothing retires and the
  // live transcript must not be archived out from under it.
  it('a thread that resumes (no freeze, so re-instanced) rolls nothing', async () => {
    const fs = fakeIo({});
    const { brain, getState } = harness([{ text: 'hi', sessionId: 'sid-live' }], { io: fs.io, seedSession: 'sid-live' });
    const conv = norm(slugDir('whatsapp', getContact(getState(), 'whatsapp', ev.chatId).slug));
    fs.files[`${conv}/transcript.md`] = OLD.replace('THREAD-OLD', 'sid-live');
    await brain.turn('e', ev);
    expect(Object.keys(fs.files).filter((p) => p.includes('/transcripts/'))).toEqual([]);
    expect(fs.files[`${conv}/transcript.md`]).toContain('hola');   // the live record is untouched
  });

  // "all skeleton files are copied on refresh thread" (operator 2026-07-26): the copy-if-missing
  // seeding never reached an already-seeded folder, so a template edit (e.g. 10-actions.md
  // learning /ask) could not reach a live conversation. A refresh overwrites; a mid-thread turn
  // does not (it must not rewrite files under a running E).
  it('a refresh re-copies the layers; an ordinary turn keeps copy-if-missing', async () => {
    const fs = fakeIo({});
    const seen = [];
    const seedLayers = async (room, name, opts = {}) => { seen.push(opts.overwrite); return []; };
    const { brain } = harness([{ text: 'a', sessionId: 'sid-1' }, { text: 'b', sessionId: 'sid-1' }], { io: fs.io, seedLayers });
    await brain.turn('e', ev);    // fresh → a thread is being instanced
    await brain.turn('e', ev);    // resumed on sid-1 → ordinary turn
    expect(seen).toEqual([true, false]);
  });
});

// parseWarmBlock takes the RESOLVED doc, not config.yaml text — `warm:` is one
// rung-resolved block of the one namespace, and the resolver already did the parsing.
describe('parseWarmBlock', () => {
  it('absent block / wrong shape / garbage value → null', () => {
    expect(parseWarmBlock({}).idleTtlMs).toBe(null);
    expect(parseWarmBlock(null).idleTtlMs).toBe(null);
    expect(parseWarmBlock({ foo: 'bar' }).idleTtlMs).toBe(null);            // no warm block
    expect(parseWarmBlock({ warm: 'not-a-map' }).idleTtlMs).toBe(null);     // warm not an object
    expect(parseWarmBlock({ warm: [1] }).idleTtlMs).toBe(null);             // a list is not a block
    expect(parseWarmBlock({ warm: { idle_ttl: 'nonsense' } }).idleTtlMs).toBe(null);   // unparseable value
  });
  it('duration string → ms via parseFrequency', () => {
    expect(parseWarmBlock({ warm: { idle_ttl: '1h' } }).idleTtlMs).toBe(3_600_000);
    expect(parseWarmBlock({ warm: { idle_ttl: '5m' } }).idleTtlMs).toBe(300_000);
    expect(parseWarmBlock({ warm: { idle_ttl: 900000 } }).idleTtlMs).toBe(900_000);   // bare ms number
  });
  it('idle_ttl: 0 → 0 (always evict — accepted despite parseFrequency rejecting 0)', () => {
    expect(parseWarmBlock({ warm: { idle_ttl: 0 } }).idleTtlMs).toBe(0);
  });
  it('idle_ttl: -1 → -1 (never evict — matches _armIdle\'s `ttl < 0`, any negative)', () => {
    expect(parseWarmBlock({ warm: { idle_ttl: -1 } }).idleTtlMs).toBe(-1);
    expect(parseWarmBlock({ warm: { idle_ttl: -5 } }).idleTtlMs).toBe(-5);   // not special-cased to -1: any negative passes through
  });
});
