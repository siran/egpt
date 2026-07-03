// brainpool (the Brain port): warm key, session resume/persist, the §7
// context-overflow backstop (reset + retry once fresh), and the identity kickoff
// (fresh thread → first turn wrapped with the feed; resumed thread → raw).
// Against a fake warm pool + in-memory conv-state. No claude, no spawn.
import { describe, it, expect } from 'vitest';
import { createBrainPool, parseWarmBlock } from '../src/spine/brainpool.mjs';
import { createContacts } from '../src/spine/contacts.mjs';
import { buildClaudeArgs } from '../src/claude-args.mjs';
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
    const config = { agents: { egpt: { configuration: 'sonnet-high', handles: ['e', 'egpt'] } } };
    const { brain, pool, getState } = harness([{ text: 'ok', sessionId: 's' }], { brains, config });
    await brain.turn('e', ev);
    expect(pool.calls[0].key).toMatch(/^e:ccode:whatsapp:SPOILER-\d{10}$/);
    expect(pool.calls[0].brainOptions).toMatchObject({ model: 'sonnet', effort: 'high', allowedTools: 'all' });
    const view = getBeing(getState(), 'whatsapp', '!room:beeper.com', 'e');
    expect(view.brain).toBe('sonnet-high');    // instanced from the persona agent configuration
  });

  it('persona agent type that does NOT resolve falls through to the shipped "egpt" type', async () => {
    const brains = { resolve: (name) => name === 'egpt' ? ({ name: 'egpt', type: 'codex' }) : null };
    const config = { agents: { egpt: { configuration: 'ghost-type', handles: ['e', 'egpt'] } } };
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

  it("'all' def → TRUSTED/unconfined: no confineToDirs/addDirs/readOnlyDirs, bypass permissions (regression lock)", async () => {
    const brains = { resolve: () => ({ name: 'egpt', type: 'ccode', allowed_tools: 'all' }) };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], { brains });
    await brain.turn('e', ev);
    const opts = pool.calls[0].brainOptions;
    expect(opts.confineToDirs).toBeUndefined();
    expect(opts.addDirs).toBeUndefined();
    expect(opts.readOnlyDirs).toBeUndefined();
    const args = buildClaudeArgs(opts);
    expect(args).toContain('--dangerously-skip-permissions');
    expect(argVals(args, '--add-dir')).toEqual([]);            // unconfined — no dir roots
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
  const mk = (ro) => ({ contacts: { whatsapp: { '!r:beeper.local': { slug: 'x', readonly: ro } } } });
  it('resolves the def name from a readonly.agent entry', () => {
    const v = getBeing(mk({ agent: 'sonnet-high', type: 'ccode' }), 'whatsapp', '!r:beeper.local', 'e');
    expect(v.brain).toBe('sonnet-high');   // `brain` stays the returned property
    expect(v.agent).toBe('sonnet-high');   // `agent` is the alias
    expect(v.brainType).toBe('ccode');
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
