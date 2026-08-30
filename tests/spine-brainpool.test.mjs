// brainpool (the Brain port): warm key, session resume/persist, the §7
// context-overflow backstop (reset + retry once fresh), and the identity kickoff
// (fresh thread → first turn wrapped with the feed; resumed thread → raw).
// Against a fake warm pool + in-memory conv-state. No claude, no spawn.
import { describe, it, expect, vi } from 'vitest';
import { createBrainPool, parseWarmBlock } from '../src/spine/brainpool.mjs';
import { createWarmPool } from '../src/warm-sessions.mjs';
import { createPiCliSession } from '../src/pi-cli-session.mjs';
import { EventEmitter } from 'node:events';
import { loadPermissionLevel } from '../src/spine/permission-levels.mjs';
import { createContacts } from '../src/spine/contacts.mjs';
import { createBrains } from '../src/spine/brains.mjs';
import { ConversationRoom } from '../src/room-core.mjs';
import { buildClaudeArgs, DEFAULT_ALLOWED_TOOLS } from '../src/claude-args.mjs';
import { emptyState, getBeing, getContact, ensureContact, recordThread, patchBeing, slugDir } from '../src/conversations-state.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A fake warm pool that records run() calls and lets a test script the results.
function fakePool(scriptedResults, { steerTakes = true } = {}) {
  const calls = [], evicted = [], steered = [];
  let i = 0;
  return {
    calls, evicted, steered,
    run(key, message, onPartial, opts) {
      calls.push({ key, message, brainOptions: opts.brainOptions, klass: opts.klass, idleTtlMs: opts.idleTtlMs });
      const r = scriptedResults[Math.min(i, scriptedResults.length - 1)]; i++;
      return typeof r === 'function' ? r() : Promise.resolve(r);
    },
    // The real pool's injected-or-nothing weave (warm-sessions `steer`): a boolean, and it
    // NEVER runs a turn — so a `false` here must leave `calls` untouched.
    steer(key, message) { steered.push({ key, message }); return steerTakes; },
    evict(key) { evicted.push(key); },
  };
}

const ev = { surface: 'whatsapp', chatId: '!room:beeper.com', chatName: 'SPOILER', line: 'An@[SPOILER].wa (14:05) #m1: hola', body: 'hola' };

function harness(scriptedResults, { config = {}, isOverflow, isDeadSession, loadFeed, loadManifest, loadAutoLayer, seedSession, seedMode, seedAgents, brains, afterTurn, io, seedLayers, resolveConfig, loadPermission, skipAccessLevelDefault, poolOverride, onLog, steerTakes } = {}) {
  let state = emptyState();
  if (seedSession || seedMode || seedAgents) {   // pre-register the contact (WITH a stored thread, an E mode, and/or per-being pins)
    const ens = ensureContact(state, ev.surface, ev.chatId, { pushedName: ev.chatName, slugHint: ev.chatName });
    state = ens.state;
    // Seed the persona's `agents.e` block (phase 1, operator 2026-08-14: the ONE per-being
    // home — the brainpool defaults defaultKey to 'e', so 'e' is the persona here). There is
    // no more `readonly` to seed: engine/model/effort/tools always resolve fresh from config.
    if (seedSession) state = recordThread(state, ev.surface, ev.chatId, seedSession, undefined, 'e');
    if (seedMode) state = patchBeing(state, ev.surface, ev.chatId, 'e', { mode: seedMode });   // e.g. 'auto'
    // seedAgents: { <being>: {<fields>}, ... } — one or more beings' agents.<being> blocks,
    // merged field-wise over anything seedSession/seedMode already wrote.
    if (seedAgents) {
      for (const [being, fields] of Object.entries(seedAgents)) state = patchBeing(state, ev.surface, ev.chatId, being, fields);
    }
  }
  // poolOverride: a REAL createWarmPool, for the one test that has to see the warm
  // process reused across turns (the fake pool has no session lifetime of its own).
  const pool = poolOverride ?? fakePool(scriptedResults, { steerTakes: steerTakes ?? true });
  const loadState = async () => state;
  const writeState = async (s) => { state = s; };
  // resolveBeingDef (phase 2, operator 2026-08-14: "remove the concept of siblings") needs an
  // agents()[<being>] ENTRY to exist before it will even attempt brains.resolve — mirroring
  // boot.mjs's guarantee that defaultKey's own agents() entry always exists (the persona
  // agent, `default: true`, a fatal boot error otherwise). Most tests below only care what
  // def the injected `brains` mock resolves to, not the agents-block shape, so a minimal
  // stand-in `agents.e` entry is synthesized here when the test's own config doesn't declare
  // one; a test that supplies its OWN config.agents (persona OR sibling) is left exactly as
  // given.
  const cfg = config.agents ? config : { ...config, agents: { e: {} } };
  // STRUCTURAL SAFETY GATE FIXTURE DEFAULT (operator 2026-08-16): brainpool.turn() now refuses
  // to run any being whose resolved accessLevel isn't 'all'/'regular' at either tier — see the
  // STRUCTURAL SAFETY GATES block in brainpool.mjs. Almost every test in this file exercises
  // UNRELATED behavior and never meant to set one, so default every agents.<being> entry's
  // conversation_defaults.access_level to 'regular' (the confined tier — never touches
  // dangerously_skip_permissions/allowed_tools semantics on its own) unless the test's OWN config already pins a
  // global access_level for that being, or seedAgents already pins a PER-CONVERSATION one (which
  // would win anyway). A test that exercises accessLevel/allowed_users semantics ITSELF passes
  // skipAccessLevelDefault to opt out and sets its own.
  if (!skipAccessLevelDefault) {
    const agents2 = { ...cfg.agents };
    for (const being of Object.keys(agents2)) {
      const a = agents2[being] ?? {};
      if (a.conversation_defaults?.access_level == null && seedAgents?.[being]?.access_level == null) {
        agents2[being] = { ...a, conversation_defaults: { ...a.conversation_defaults, access_level: 'regular' } };
      }
    }
    cfg.agents = agents2;
  }
  const brain = createBrainPool({
    pool,
    getConfig: () => cfg,
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
    ...(seedLayers ? { seedLayers } : {}),         // the identity.d copy (default: the real seeder)
    ...(loadAutoLayer ? { loadAutoLayer } : {}),   // the mode:auto operator-role layer (default: real file)
    ...(brains ? { brains } : {}),                 // omit → falls back to a bare ccode def
    ...(afterTurn ? { afterTurn } : {}),
    ...(isOverflow ? { isOverflow } : {}),
    ...(isDeadSession ? { isDeadSession } : {}),
    // Default: a NO-OP (unless the test injects its own) — since accessLevel is now always
    // 'all'/'regular' (see the default above), the ACCESS-LEVEL OVERRIDE block in turn() is now
    // unconditionally reachable; without this, createBrainPool's OWN default
    // (loadPermissionLevel, the REAL config/permissions/*.md reader) would clobber a test's
    // carefully-crafted def with a real permissions grant. The one test that wants the real
    // reader (the "end-to-end with the REAL config/permissions/*.md files" test) injects
    // loadPermissionLevel itself.
    loadPermission: loadPermission ?? (() => null),
    ...(onLog ? { onLog } : {}),                   // the diagnostic sink (allow_new_input validation)
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

  // --- brain registry: resolved FRESH every turn (phase 1, operator 2026-08-14 — no more
  //     per-conversation freeze). The def is never written back into the registry any more;
  //     these lock what the RUN itself carries. ---
  it('resolves the default brain from the registry, keys the warm entry by its engine', async () => {
    const brains = { resolve: () => ({ name: 'default', type: 'codex', model: 'gpt-5.4-mini', allowed_tools: 'all' }) };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], { brains });
    await brain.turn('e', ev);
    expect(pool.calls[0].key).toMatch(/^e:codex:whatsapp:SPOILER-\d{10}$/);       // engine from the brain, not hardcoded ccode
    expect(pool.calls[0].brainOptions).toMatchObject({ model: 'gpt-5.4-mini', allowedTools: DEFAULT_ALLOWED_TOOLS });
  });

  it('DETERMINISM: a def with model:null/effort omitted runs on the deterministic fallback, never null (operator 2026-07-02)', async () => {
    const brains = { resolve: () => ({ name: 'default', type: 'ccode', model: null, allowed_tools: 'all' }) };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], { brains });
    await brain.turn('e', ev);
    expect(pool.calls[0].brainOptions.model).toBe('sonnet');    // deterministic fallback (def.model was null)
    expect(pool.calls[0].brainOptions.effort).toBe('high');     // deterministic fallback (def.effort absent)
  });

  it('a type def with concrete model/effort runs on those exact values (fallback only fills the gaps)', async () => {
    const brains = { resolve: () => ({ name: 'sonnet-high', type: 'ccode', model: 'opus', effort: 'low', allowed_tools: 'all' }) };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], { brains });
    await brain.turn('e', ev);
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

  it('persona agent type (agents block) supplies E\'s def, resolved through the registry', async () => {
    // the persona agent's MAP KEY must be the being-id turn() is called with (boot always
    // derives defaultKey from that same key, phase 2 — see resolveBeingDef's doc comment).
    const brains = { resolve: (name) => name === 'sonnet-high' ? ({ name: 'sonnet-high', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: 'all' }) : null };
    const config = { agents: { e: { configuration: 'sonnet-high', handles: ['e', 'egpt'], default: true } } };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], { brains, config });
    await brain.turn('e', ev);
    expect(pool.calls[0].key).toMatch(/^e:ccode:whatsapp:SPOILER-\d{10}$/);
    expect(pool.calls[0].brainOptions).toMatchObject({ model: 'sonnet', effort: 'high', allowedTools: DEFAULT_ALLOWED_TOOLS });
  });

  // PHASE 2 BEHAVIOUR CHANGE (operator 2026-08-14, reported per the phase-2 brief): pre-phase-2,
  // an unresolvable persona `configuration` fell through to the SHIPPED 'egpt' brain-type FILE
  // (a second, persona-only fallback tier — resolveDefaultBrainDef tried `brains.resolve('egpt')`
  // before giving up). resolveBeingDef — now the ONE resolver for every being, siblings included —
  // has never had that second tier: an unresolvable configuration falls straight to the bare
  // ccode def (DEFAULT_ALLOWED_TOOLS, model/effort null). For the PERSONA specifically, the being
  // === defaultKey branch below still fills model/effort with the DETERMINISTIC fallback
  // (sonnet/high — same values the shipped egpt.yaml happens to carry today), so the practical
  // difference is narrow (engine defaults to 'ccode', not whatever the shipped file's own `type`
  // says, and any OTHER custom field on a hand-edited egpt.yaml — allowed_paths, system_prompt,
  // personality — is no longer picked up by this fallback path). Only reachable when the
  // persona's own agent entry names an unresolvable `configuration` at all, which boot does not
  // otherwise permit.
  it('PHASE 2: persona agent type that does NOT resolve now falls to the bare ccode def (no more shipped-"egpt"-file fallback)', async () => {
    const brains = { resolve: (name) => name === 'egpt' ? ({ name: 'egpt', type: 'codex' }) : null };
    const config = { agents: { e: { configuration: 'ghost-type', handles: ['e', 'egpt'], default: true } } };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], { brains, config });
    await brain.turn('e', ev);
    expect(pool.calls[0].key).toMatch(/:ccode:/);                          // bare fallback, not the shipped 'egpt' file's codex
    expect(pool.calls[0].brainOptions).toMatchObject({ model: 'sonnet', effort: 'high', allowedTools: DEFAULT_ALLOWED_TOOLS });
  });

  it('a re-pointed default reaches an already-running conversation on its very next turn (phase 1: no more per-conversation freeze)', async () => {
    let type = 'ccode';
    const brains = { resolve: () => ({ name: 'default', type }) };
    const { brain, pool } = harness([{ text: 'a', sessionId: 's' }, { text: 'b', sessionId: 's' }], { brains });
    await brain.turn('e', ev);            // first turn on ccode
    type = 'codex';                       // operator re-points the default
    await brain.turn('e', ev);            // this SAME live conversation follows — no freeze to retro-alter
    expect(pool.calls[0].key).toMatch(/:ccode:/);
    expect(pool.calls[1].key).toMatch(/:codex:/);
  });

  // ALWAYS FRESH (phase 1, operator 2026-08-14: "engine/model/effort/tools resolve fresh from
  // config every turn"). The pre-phase-1 "deleting the thread-id reloads the config" ruling is
  // now just the GENERAL CASE — every turn re-reads config, live thread or brand new one.
  const RE_READ = { resolve: (n) => n === 'sonnet-high'
    ? ({ name: 'sonnet-high', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: ['Read', 'Grep'] }) : null };
  const RE_READ_CFG = { agents: { e: { configuration: 'sonnet-high', handles: ['e', 'egpt'], default: true } } };

  it('threadId deleted → a NEW session starts, and the run reads the CURRENT config', async () => {
    const { brain, pool } = harness([{ text: 'ok', sessionId: 'sid-new' }], {
      brains: RE_READ, config: RE_READ_CFG, loadFeed: async () => 'I am eGPT.',
    });
    await brain.turn('e', ev);
    expect(pool.calls[0].brainOptions).toMatchObject({ model: 'sonnet', effort: 'high', allowedTools: ['Read', 'Grep'] });
    expect(pool.calls[0].brainOptions.sessionId).toBe(null);          // a new claude session
    expect(pool.calls[0].message).toContain('I am eGPT.');            // fresh thread → identity kickoff
  });

  it('a LIVE (resumed) thread ALSO reads the CURRENT config on every turn — a re-point reaches it immediately, no re-instancing needed', async () => {
    let model = 'haiku';
    const brains = { resolve: () => ({ name: 'x', type: 'ccode', model, effort: 'low', allowed_tools: ['Read'] }) };
    const { brain, pool } = harness([{ text: 'a', sessionId: 'sid' }, { text: 'b', sessionId: 'sid' }], {
      brains, seedSession: 'sid',
    });
    await brain.turn('e', ev);
    expect(pool.calls[0].brainOptions.model).toBe('haiku');
    expect(pool.calls[0].brainOptions.sessionId).toBe('sid');   // genuinely resumed, not fresh
    model = 'opus';                                             // operator edits config.yaml
    await brain.turn('e', ev);
    expect(pool.calls[1].brainOptions.model).toBe('opus');      // the SAME live thread follows the re-point immediately
    expect(pool.calls[1].brainOptions.sessionId).toBe('sid');   // still the same resumed thread
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

  // THE dj-son OVERFLOW (2026-08-28): `@pd` on a local 16k model died with
  // "request (25322 tokens) exceeds the available context size (16384)". Its pi
  // session held 32 copies of the identity feed — 2018 chars each, ~75% of the
  // whole 80-minute session — because the engine never reported a session id, so
  // recordThread never fired, so every turn resolved sessionId:null and took the
  // wrapFresh branch, while the WARM POOL kept feeding all of it to the SAME live
  // pi process. Two turns is enough to see it: the feed must reach the thread ONCE.
  // Real warm pool + real pi session (fake spawn) — the fake pool has no session
  // lifetime, and the lifetime is exactly what is broken.
  it('pi: the identity feed reaches ONE warm pi thread ONCE, not on every turn', async () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.prompts = [];
    proc.kill = () => {};
    proc.stdin = {
      write: (s) => {
        proc.prompts.push(JSON.parse(s).message);
        setImmediate(() => {
          for (const e of [{ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ok' } }, { type: 'agent_settled' }]) {
            proc.stdout.emit('data', Buffer.from(`${JSON.stringify(e)}\n`));
          }
        });
        return true;
      },
      end() {},
    };
    const spawn = vi.fn(() => proc);
    const pool = createWarmPool({ makeSession: (opts) => createPiCliSession({ ...opts, spawn }) });
    const { brain } = harness([], {
      poolOverride: pool,
      brains: { resolve: () => ({ name: 'pi', type: 'pi', personality: 'egpt' }) },
      config: { agents: { pd: { configuration: 'pi', handles: ['pd'] } } },
      loadFeed: async () => 'I AM EGPT (the feed)',
    });
    await brain.turn('pd', ev);
    await brain.turn('pd', ev);
    pool.close();
    expect(spawn).toHaveBeenCalledTimes(1);                                        // ONE warm process = ONE pi session
    expect(proc.prompts).toHaveLength(2);
    expect(proc.prompts.filter((m) => m.includes('I AM EGPT (the feed)'))).toHaveLength(1);
    expect(proc.prompts[1]).toBe(ev.line);                                         // turn 2 continues its own thread
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
    const { brain, pool, getState } = harness([{ text: 'ok', sessionId: 'd1' }],
      { brains, config, loadFeed: async () => 'FEED-LAYERS' });
    await brain.turn('don-local', ev);
    expect(pool.calls[0].key).toMatch(/^don-local:ccode:whatsapp:SPOILER-\d{10}$/);
    expect(pool.calls[0].brainOptions).toMatchObject({ model: 'sonnet', effort: 'high', allowedTools: 'Read,Bash' });
    // EVERY agent gets its own kickoff feed — the persona/sibling split was
    // evicted (operator 2026-08-28: "we only have agents now"). A local agent
    // opens its thread knowing the actions grammar and its own folder, with its
    // own line last.
    expect(pool.calls[0].message.startsWith('FEED-LAYERS')).toBe(true);   // the feed LEADS
    expect(pool.calls[0].message.endsWith(ev.line)).toBe(true);           // its own line LAST
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

  // REPRODUCE-FIRST (phase 2, operator 2026-08-14): wantAuto used to be `!isSibling && mode
  // === 'auto'` — a sibling could never be 'auto' eligible no matter its own configured mode.
  // The gate is REMOVED (not widened): every being's own mode is consulted now. A sibling still
  // gets NO identity KICKOFF feed (that gate — wrapFresh's `being !== defaultKey` — is
  // unchanged, out of scope), so the effect only surfaces on a RESUMED thread that flips to
  // auto (wrapAutoResume, which never gated on being at all).
  it('PHASE 2: a RESUMED SIBLING thread with mode: auto configured now ALSO gets the one-time operator-role preamble — no longer persona-only eligibility', async () => {
    const brains = { resolve: (name) => name === 'sonnet-high' ? ({ name: 'sonnet-high', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: 'Read,Bash' }) : null };
    const config = { agents: { wren: { configuration: 'sonnet-high', name: 'wren' } } };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 'w1' }], {
      brains, config, seedAgents: { wren: { threadId: 'w1', mode: 'auto' } }, loadAutoLayer: async () => 'AUTO-ROLE-LAYER',
    });
    await brain.turn('wren', ev);
    expect(pool.calls[0].brainOptions.sessionId).toBe('w1');        // genuinely resumed
    expect(pool.calls[0].message).toContain('AUTO-ROLE-LAYER');     // phase 2: the sibling now gets the auto preamble too
    expect(pool.calls[0].message).toContain(ev.line);
  });
});

// NO HARDCODED NODE IDENTITY (operator 2026-08-29): the boot-assembled who/where-am-I addendum
// is GONE. It named the node's DEFAULT persona ("You are the eGPT persona \"don\"…") in EVERY
// agent's system prompt, contradicting each agent's own identity feed. WHO an agent is now comes
// from the identity feed (config/identities/<personality>.md in the 00-identity slot) and nowhere
// else, so the turn's appendSystemPrompt is the def's own system_prompt — nothing appended.
describe('brainpool.turn — appendSystemPrompt is the def system_prompt alone', () => {
  it('appendSystemPrompt is EXACTLY the def system_prompt, and is absent when the def has none', async () => {
    const brains = { resolve: () => ({ name: 'egpt', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: 'all', system_prompt: 'DEF-PROMPT' }) };
    const withPrompt = harness([{ text: 'ok', sessionId: 's' }], { brains });
    await withPrompt.brain.turn('e', ev);
    expect(withPrompt.pool.calls[0].brainOptions.appendSystemPrompt).toBe('DEF-PROMPT');

    const noPrompt = harness([{ text: 'ok', sessionId: 's' }]);   // bare ccode def — no system_prompt
    await noPrompt.brain.turn('e', ev);
    expect(noPrompt.pool.calls[0].brainOptions.appendSystemPrompt).toBe(undefined);
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

// ── DANGEROUSLY_SKIP_PERMISSIONS:true (operator 2026-08 meta-engineer) — the ONE unconfined
//    tier. Skips BOTH coerceAllowedTools (an 'all'/list allowed_tools list runs verbatim, incl.
//    bare Bash/Agent) AND confinementFor (no confineToDirs/addDirs/readOnlyDirs, ever) at every
//    def-resolution call site in turn() — the persona (fresh-instance) path, the sibling path,
//    and the freeze-read-back path. A def with the flag unset must stay bitwise unchanged
//    (regression lock — every pre-existing test above already re-asserts this unmodified). ──
describe('brainpool.turn — dangerously_skip_permissions:true skips coercion + confinement (operator 2026-08 meta-engineer)', () => {
  it('PERSONA def dangerously_skip_permissions:true → allowedTools pass through verbatim (incl. bare Bash/Agent), NO confineToDirs/addDirs/readOnlyDirs', async () => {
    const brains = { resolve: () => ({ name: 'meta-engineer', type: 'ccode', model: 'sonnet', effort: 'high', dangerously_skip_permissions: true, allowed_tools: ['Read', 'Write', 'Bash', 'Agent'] }) };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], { brains });
    await brain.turn('e', ev);
    const opts = pool.calls[0].brainOptions;
    expect(opts.allowedTools).toEqual(['Read', 'Write', 'Bash', 'Agent']);   // verbatim — bare Bash survived, never coerced
    expect(opts.confineToDirs).toBeUndefined();
    expect(opts.addDirs).toBeUndefined();
    expect(opts.readOnlyDirs).toBeUndefined();
    expect(opts.dangerouslySkipPermissions).toBe(true);   // operator 2026-08-17: the explicit field buildClaudeArgs acts on
    // end-to-end through the real arg builder: no sandbox flags, the real bypass flags (2026-08-17),
    // a plain --allowedTools with Bash present
    const args = buildClaudeArgs(opts);
    expect(argVals(args, '--setting-sources')).toEqual([]);
    expect(args).toContain('--dangerously-skip-permissions');
    expect(argVals(args, '--permission-mode')).toEqual(['bypassPermissions']);
    expect(argVals(args, '--add-dir')).toEqual([]);
    expect(argVals(args, '--allowedTools')[0]).toContain('Bash');
  });

  it('SIBLING def dangerously_skip_permissions:true (agents registry, never frozen) → same unconfined behavior', async () => {
    const brains = { resolve: (name) => name === 'meta-engineer' ? ({ name: 'meta-engineer', type: 'ccode', model: 'sonnet', effort: 'high', dangerously_skip_permissions: true, allowed_tools: ['Read', 'Bash'] }) : null };
    const config = { agents: { wren: { configuration: 'meta-engineer', name: 'wren' } } };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 'w1' }], { brains, config });
    await brain.turn('wren', ev);
    const opts = pool.calls[0].brainOptions;
    expect(opts.allowedTools).toEqual(['Read', 'Bash']);
    expect(opts.confineToDirs).toBeUndefined();
  });

  it("a dangerously_skip_permissions def's OWN 'all'/'*' also passes through unrejected (dangerously_skip_permissions means dangerously_skip_permissions — coercion never runs)", async () => {
    const brains = { resolve: () => ({ name: 'meta-engineer', type: 'ccode', dangerously_skip_permissions: true, allowed_tools: 'all' }) };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], { brains });
    await brain.turn('e', ev);
    expect(pool.calls[0].brainOptions.allowedTools).toBe('all');   // NOT coerced to DEFAULT_ALLOWED_TOOLS
    expect(pool.calls[0].brainOptions.confineToDirs).toBeUndefined();
  });

  it('REGRESSION: a def with dangerously_skip_permissions absent is bitwise unchanged — still coerced + confined', async () => {
    const brains = { resolve: () => ({ name: 'egpt', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: 'all' }) };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], { brains });
    await brain.turn('e', ev);
    const opts = pool.calls[0].brainOptions;
    expect(opts.allowedTools).toEqual(DEFAULT_ALLOWED_TOOLS);   // 'all' still rejected → coerced
    expect(opts.confineToDirs).toEqual([opts.cwd]);              // still confined
  });

  it('REGRESSION: dangerously_skip_permissions: false (explicit) behaves exactly like absent — coerced + confined', async () => {
    const brains = { resolve: () => ({ name: 'egpt', type: 'ccode', dangerously_skip_permissions: false, allowed_tools: 'all' }) };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], { brains });
    await brain.turn('e', ev);
    const opts = pool.calls[0].brainOptions;
    expect(opts.allowedTools).toEqual(DEFAULT_ALLOWED_TOOLS);
    expect(opts.confineToDirs).toEqual([opts.cwd]);
  });
});

// ── accessLevel OVERRIDE (operator 2026-08-14, was /e access all|regular; the command is
//    now /agents access_level all|regular <handle>|all, 2026-08-15). Applied live, every
//    turn, independent of the fresh/frozen instancing above — the whole point vs. the old
//    freeze-into-readonly shape. PHASE 2 (operator 2026-08-14, "remove the concept of
//    siblings"): no longer persona-only — every being's OWN accessLevel (per-being, read via
//    getBeing) is eligible now. /agents' access_level subcommand can WRITE any being's
//    accessLevel (not just defaultKey's, 2026-08-15) — but a sibling's accessLevel set by
//    hand-editing conversations.yaml has always been honored here too, regardless of how it
//    got written. ──
describe('brainpool.turn — accessLevel override (operator 2026-08-14, was /e access, now /agents … access_level)', () => {
  it("accessLevel 'all' overrides dangerously_skip_permissions/allowedTools on an ALREADY-LIVE (resumed) thread too — applied fresh every turn", async () => {
    const brains = { resolve: () => ({ name: 'sonnet-high', type: 'ccode', model: 'haiku', effort: 'low', allowed_tools: ['Read'] }) };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 'sid-live' }], {
      brains, seedSession: 'sid-live', seedAgents: { e: { access_level: 'all', allowed_users: ['123'] } },
      loadPermission: (level) => (level === 'all' ? { dangerouslySkipPermissions: true, allowedTools: ['Read', 'Write', 'Bash', 'Agent'] } : null),
    });
    await brain.turn('e', ev);
    const opts = pool.calls[0].brainOptions;
    expect(opts.allowedTools).toEqual(['Read', 'Write', 'Bash', 'Agent']);   // the permissions file's grant, not the def's own ['Read']
    expect(opts.confineToDirs).toBeUndefined();                             // dangerously_skip_permissions:true → unconfined
    expect(opts.dangerouslySkipPermissions).toBe(true);                     // the explicit field buildClaudeArgs acts on
    expect(opts.sessionId).toBe('sid-live');                                // genuinely resumed, not a fresh turn
  });

  it("accessLevel 'regular' overrides dangerously_skip_permissions/allowedTools to a confined grant on a fresh (never-instanced) turn too", async () => {
    const brains = { resolve: () => ({ name: 'meta-engineer', type: 'ccode', model: 'sonnet', effort: 'high', dangerously_skip_permissions: true, allowed_tools: ['Read', 'Bash'] }) };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], {
      brains, seedAgents: { e: { access_level: 'regular' } },
      loadPermission: (level) => (level === 'regular' ? { dangerouslySkipPermissions: false, allowedTools: DEFAULT_ALLOWED_TOOLS } : null),
    });
    await brain.turn('e', ev);
    const opts = pool.calls[0].brainOptions;
    expect(opts.allowedTools).toEqual(DEFAULT_ALLOWED_TOOLS);   // overrides the instanced dangerously_skip_permissions:true def entirely
    expect(opts.confineToDirs).toEqual([opts.cwd]);             // confined, not the def's own unconfined tier
    expect(opts.dangerouslySkipPermissions).toBe(false);        // the override's dangerouslySkipPermissions:false wins, not the def's own true
  });

  it('editing the permissions-file RESULT between two turns of the SAME conversation changes the SECOND turn — no /e access re-run, proves live re-read (no caching)', async () => {
    let grant = { dangerouslySkipPermissions: true, allowedTools: ['Read', 'Bash'] };
    const { brain, pool } = harness([{ text: 'a', sessionId: 'sid' }, { text: 'b', sessionId: 'sid' }], {
      seedAgents: { e: { access_level: 'all', allowed_users: ['123'] } },
      loadPermission: () => grant,
    });
    await brain.turn('e', ev);                                             // turn 1: sees the first grant
    grant = { dangerouslySkipPermissions: false, allowedTools: ['Read', 'Grep'] };   // "editing the file" — same access_level, different content
    await brain.turn('e', ev);                                             // turn 2: no command re-run
    expect(pool.calls[0].brainOptions.allowedTools).toEqual(['Read', 'Bash']);
    expect(pool.calls[0].brainOptions.confineToDirs).toBeUndefined();
    expect(pool.calls[1].brainOptions.allowedTools).toEqual(['Read', 'Grep']);
    expect(pool.calls[1].brainOptions.confineToDirs).toEqual([pool.calls[1].brainOptions.cwd]);
  });

  // REWRITTEN (operator 2026-08-16 structural gate): the old premise — a sibling with NO
  // accessLevel of its own still runs, on its unmodified def, loadPermission never consulted —
  // is now categorically impossible (rule 1 refuses ANY being with no accessLevel at either
  // tier). The regression worth keeping is narrower but still real: a sibling's OWN accessLevel
  // (here, its own 'regular') governs its turn, never the PERSONA's 'all' pin on the same
  // conversation — accessLevel is read per-being (getBeing(..., being)), so a persona-level pin
  // never leaks into a sibling's, even when both are set on the very same conversation.
  it('REGRESSION: a sibling\'s OWN accessLevel governs its turn — the PERSONA\'s accessLevel on the same conversation never leaks in (per-being isolation, unchanged by phase 2)', async () => {
    const brains = { resolve: (name) => name === 'sonnet-high' ? ({ name: 'sonnet-high', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: ['Read', 'Bash'] }) : null };
    const config = { agents: { wren: { configuration: 'sonnet-high', name: 'wren' } } };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 'w1' }], {
      brains, config, seedAgents: { e: { access_level: 'all', allowed_users: ['123'] }, wren: { access_level: 'regular' } },
      loadPermission: (level) => (level === 'all' ? { dangerouslySkipPermissions: true, allowedTools: ['Bash'] } : { dangerouslySkipPermissions: false, allowedTools: ['Read', 'Grep'] }),
    });
    await brain.turn('wren', ev);
    const opts = pool.calls[0].brainOptions;
    expect(opts.allowedTools).toEqual(['Read', 'Grep']);          // wren's OWN 'regular' grant, not the persona's 'all' one
    expect(opts.confineToDirs).toEqual([opts.cwd]);                // confined — never the persona's unconfined tier
  });

  // REPRODUCE-FIRST (phase 2): before this change, the accessLevel override was gated on
  // `!isSibling` and a sibling's OWN access_level was never even read for this purpose — this
  // asserts the NEW, intentionally widened behavior: a sibling GIVEN its own accessLevel (e.g.
  // by hand-editing conversations.yaml, or — since 2026-08-15 — via
  // `/agents access_level all wren`) now gets the SAME live override the persona does.
  it('PHASE 2: a SIBLING with its OWN accessLevel now ALSO gets the live override — no longer persona-only', async () => {
    const brains = { resolve: (name) => name === 'sonnet-high' ? ({ name: 'sonnet-high', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: ['Read'] }) : null };
    const config = { agents: { wren: { configuration: 'sonnet-high', name: 'wren' } } };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 'w1' }], {
      brains, config, seedAgents: { wren: { access_level: 'all', allowed_users: ['123'] } },
      loadPermission: (level) => (level === 'all' ? { dangerouslySkipPermissions: true, allowedTools: ['Read', 'Write', 'Bash', 'Agent'] } : null),
    });
    await brain.turn('wren', ev);
    const opts = pool.calls[0].brainOptions;
    expect(opts.allowedTools).toEqual(['Read', 'Write', 'Bash', 'Agent']);   // the permissions file's grant, not wren's own ['Read']
    expect(opts.confineToDirs).toBeUndefined();                             // dangerously_skip_permissions:true → unconfined
  });

  // REWRITTEN (operator 2026-08-20): accessLevel null/unset used to REFUSE the turn (the
  // 2026-08-16 structural gate). Refined the same day: resolveConv's own fallback now resolves
  // an unset accessLevel to the explicit 'regular' instead of null, so the turn proceeds
  // CONFINED rather than refusing — loadPermission('regular') IS consulted (this is no longer
  // the "no override" case; it is now the ordinary 'regular' override path, just reached via
  // the default instead of an explicit setting).
  it("accessLevel null/unset at both tiers now resolves to 'regular' and runs CONFINED, instead of refusing (operator 2026-08-20 refinement)", async () => {
    const brains = { resolve: () => ({ name: 'egpt', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: 'all' }) };
    let seenLevel = null;
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], {
      brains, skipAccessLevelDefault: true,
      loadPermission: (level) => { seenLevel = level; return { dangerouslySkipPermissions: false, allowedTools: DEFAULT_ALLOWED_TOOLS }; },
    });
    await brain.turn('e', ev);
    expect(seenLevel).toBe('regular');     // the override block DOES run now, on the resolved default
    expect(pool.calls).toHaveLength(1);    // the turn reaches the engine
    expect(pool.calls[0].brainOptions.allowedTools).toEqual(DEFAULT_ALLOWED_TOOLS);
    expect(pool.calls[0].brainOptions.confineToDirs).toEqual([pool.calls[0].brainOptions.cwd]);   // confined
  });

  it('end-to-end with the REAL config/permissions/*.md files (no injected loadPermission): all → dangerously_skip_permissions + bare Bash/Agent, regular → confined DEFAULT_ALLOWED_TOOLS', async () => {
    const brains = { resolve: () => ({ name: 'sonnet-high', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: ['Read'] }) };
    // loadPermission: loadPermissionLevel — the REAL config/permissions/*.md reader; the harness's
    // own default is a no-op (operator 2026-08-16, see harness()'s comment) so this end-to-end
    // test must opt back in explicitly.
    const all = harness([{ text: 'ok', sessionId: 's' }], { brains, seedAgents: { e: { access_level: 'all', allowed_users: ['123'] } }, loadPermission: loadPermissionLevel });
    await all.brain.turn('e', ev);
    const optsAll = all.pool.calls[0].brainOptions;
    expect(optsAll.allowedTools).toEqual(expect.arrayContaining(['Bash', 'Agent']));
    expect(optsAll.confineToDirs).toBeUndefined();
    expect(optsAll.dangerouslySkipPermissions).toBe(true);      // all.md's dangerously_skip_permissions: true reaches brainOptions verbatim
    expect(buildClaudeArgs(optsAll)).toContain('--dangerously-skip-permissions');

    const regular = harness([{ text: 'ok', sessionId: 's' }], { brains, seedAgents: { e: { access_level: 'regular' } }, loadPermission: loadPermissionLevel });
    await regular.brain.turn('e', ev);
    const optsRegular = regular.pool.calls[0].brainOptions;
    expect(optsRegular.allowedTools).toEqual(DEFAULT_ALLOWED_TOOLS);
    expect(optsRegular.confineToDirs).toEqual([optsRegular.cwd]);
    expect(optsRegular.dangerouslySkipPermissions).toBe(false); // regular.md's dangerously_skip_permissions: false
    expect(buildClaudeArgs(optsRegular)).not.toContain('--dangerously-skip-permissions');
  });
});

// ── STRUCTURAL SAFETY GATE (operator 2026-08-16; refined 2026-08-20). Checked at the very top
//    of turn() — BEFORE any being-def resolution, so a refusal grants NOTHING, not even the
//    type file's own baseline allowed_tools:
//      accessLevel:'all' (unconfined) must never be paired with an empty/unset allowed_users
//      (unrestricted reachability) — the escape hatch is the literal "*" wildcard entry
//      (allowedUsersPermits' twin in conversations-state.mjs recognizes the same literal for
//      router.mjs/mesh.mjs's sender-match).
//    The former rule 1 here ("accessLevel must resolve to 'all' or 'regular' at either tier, or
//    the being does not run at all") is GONE (operator 2026-08-20): resolveConv's own fallback
//    now resolves an unset accessLevel to the explicit 'regular' instead of null, so an unset
//    being now runs CONFINED rather than refusing — see the REPRODUCE-FIRST test just below,
//    which proves this on CURRENT code (it used to throw; the 2026-08-16 gate test asserted
//    exactly that — see git history / this file's diff for the before/after). ──
describe('brainpool.turn — STRUCTURAL SAFETY GATE (operator 2026-08-16, refined 2026-08-20)', () => {
  it("REPRODUCE-FIRST (before/after, operator 2026-08-20): accessLevel null at BOTH tiers used to refuse the turn (2026-08-16 gate) — now resolves to 'regular' and runs CONFINED, before any allowed_users concern even applies", async () => {
    const brains = { resolve: () => ({ name: 'egpt', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: 'all' }) };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], {
      brains, skipAccessLevelDefault: true,
      loadPermission: (level) => (level === 'regular' ? { dangerouslySkipPermissions: false, allowedTools: DEFAULT_ALLOWED_TOOLS } : null),
    });
    const out = await brain.turn('e', ev);   // AFTER: no longer throws
    expect(out.text).toBe('ok');
    expect(pool.calls).toHaveLength(1);      // the engine WAS invoked, confined as 'regular'
    expect(pool.calls[0].brainOptions.confineToDirs).toEqual([pool.calls[0].brainOptions.cwd]);
  });

  it("accessLevel 'all' with NO allowed_users at either tier → refuses", async () => {
    const brains = { resolve: () => ({ name: 'egpt', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: 'all' }) };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], {
      brains, skipAccessLevelDefault: true, seedAgents: { e: { access_level: 'all' } },
    });
    await expect(brain.turn('e', ev)).rejects.toThrow(/allowed_users/);
    expect(pool.calls).toHaveLength(0);
  });

  it("accessLevel 'all' with allowed_users: ['*'] → the explicit wildcard escape hatch, proceeds normally", async () => {
    const brains = { resolve: () => ({ name: 'sonnet-high', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: ['Read'] }) };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], {
      brains, skipAccessLevelDefault: true, seedAgents: { e: { access_level: 'all', allowed_users: ['*'] } },
      loadPermission: (level) => (level === 'all' ? { dangerouslySkipPermissions: true, allowedTools: ['Bash'] } : null),
    });
    await brain.turn('e', ev);
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0].brainOptions.allowedTools).toEqual(['Bash']);
    expect(pool.calls[0].brainOptions.dangerouslySkipPermissions).toBe(true);
  });

  it("accessLevel 'all' with allowed_users: ['123'] (an ordinary non-empty list) → proceeds normally", async () => {
    const brains = { resolve: () => ({ name: 'sonnet-high', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: ['Read'] }) };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], {
      brains, skipAccessLevelDefault: true, seedAgents: { e: { access_level: 'all', allowed_users: ['123'] } },
      loadPermission: (level) => (level === 'all' ? { dangerouslySkipPermissions: true, allowedTools: ['Bash'] } : null),
    });
    await brain.turn('e', ev);
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0].brainOptions.allowedTools).toEqual(['Bash']);
    expect(pool.calls[0].brainOptions.dangerouslySkipPermissions).toBe(true);
  });

  it("accessLevel 'regular' (no allowed_users involved) → proceeds normally, unaffected by rule 2", async () => {
    const brains = { resolve: () => ({ name: 'sonnet-high', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: ['Read'] }) };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], {
      brains, skipAccessLevelDefault: true, seedAgents: { e: { access_level: 'regular' } },
      loadPermission: (level) => (level === 'regular' ? { dangerouslySkipPermissions: false, allowedTools: DEFAULT_ALLOWED_TOOLS } : null),
    });
    await brain.turn('e', ev);
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0].brainOptions.allowedTools).toEqual(DEFAULT_ALLOWED_TOOLS);
    expect(pool.calls[0].brainOptions.dangerouslySkipPermissions).toBe(false);
  });
});

// ── SANDBOXED default-on (operator 2026-08-20): same two-tier resolution (per-conversation,
//    then agents.<being>.conversation_defaults) as accessLevel/allowedUsers, but the FALLBACK
//    when unset at both tiers is now `true` (was `null`) — OS-level isolation applies to every
//    being unless a tier explicitly opts out with `sandboxed: false`. `??` only falls through on
//    null/undefined, so an explicit `false` at either tier still wins over the default. ──
describe('brainpool.turn — sandboxed default-on (operator 2026-08-20)', () => {
  it('unset at both tiers → resolves to true (brainOptions.sandboxed reaches boot.mjs\'s makeSession dispatch)', async () => {
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }]);   // no seedAgents.e.sandboxed, no config default
    await brain.turn('e', ev);
    expect(pool.calls[0].brainOptions.sandboxed).toBe(true);
  });

  it('conversation_defaults.sandboxed unset (agents block present but no sandboxed key) → still resolves to true', async () => {
    const config = { agents: { e: { conversation_defaults: { access_level: 'regular' } } } };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], { config });
    await brain.turn('e', ev);
    expect(pool.calls[0].brainOptions.sandboxed).toBe(true);
  });

  it('REGRESSION: explicit per-conversation sandboxed:false overrides the true default (opt-out survives)', async () => {
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], {
      seedAgents: { e: { sandboxed: false } },
    });
    await brain.turn('e', ev);
    expect(pool.calls[0].brainOptions.sandboxed).toBe(false);
  });

  it('REGRESSION: explicit conversation_defaults.sandboxed:false overrides the true default when no per-conversation value is set', async () => {
    const config = { agents: { e: { conversation_defaults: { access_level: 'regular', sandboxed: false } } } };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], { config });
    await brain.turn('e', ev);
    expect(pool.calls[0].brainOptions.sandboxed).toBe(false);
  });

  it('a per-conversation sandboxed:true wins over an explicit conversation_defaults.sandboxed:false', async () => {
    const config = { agents: { e: { conversation_defaults: { access_level: 'regular', sandboxed: false } } } };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], {
      config, seedAgents: { e: { sandboxed: true } },
    });
    await brain.turn('e', ev);
    expect(pool.calls[0].brainOptions.sandboxed).toBe(true);
  });
});

// ── VERBOSE_THINKING, THREE tiers (operator 2026-08-30: "verbose thinking should be
//    controlled from config.yaml rather than the agent.yaml"). It shipped 2026-08-29 as a
//    TYPE-FILE-ONLY field, so the agent-type file was the only place to turn it on — and a type
//    is shared by every agent pointed at it, so it could not say "verbose for THIS agent, in
//    THIS chat". It is now a conversation_defaults field with the same two-tier resolution
//    accessLevel/allowedUsers/sandboxed have, stacked ON TOP of the original type-file tier
//    (which is KEPT — wren's live egpt-xhigh.yaml declares it there and must not regress).
//    Precedence, highest first: per-conversation → conversation_defaults → type file → false.
//    `??` throughout, so an explicit `false` at a higher tier STOPS the walk instead of falling
//    through to a lower tier's `true` — that opt-out is the whole reason the tiers were added.
//    resolveConv resolves tiers 1-2 to null-when-unset; baseOpts applies tier 3, the first
//    point where the resolved `def` exists. ──
describe('brainpool.turn — verbose_thinking three-tier resolution (operator 2026-08-30)', () => {
  // A type file that says nothing about verbose_thinking (tier 3 silent), vs one that opts in.
  const typeFile = (verbose) => ({
    resolve: () => ({
      name: 'sonnet-high', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: ['Read'],
      ...(verbose == null ? {} : { verbose_thinking: verbose }),
    }),
  });

  it('unset at all three tiers → false (the default for every being)', async () => {
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], { brains: typeFile(null) });
    await brain.turn('e', ev);
    expect(pool.calls[0].brainOptions.verboseThinking).toBe(false);
  });

  it("REGRESSION (tier 3): the TYPE FILE's own verbose_thinking:true still wins when neither config.yaml tier states anything — wren's live egpt-xhigh.yaml", async () => {
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], { brains: typeFile(true) });
    await brain.turn('e', ev);
    expect(pool.calls[0].brainOptions.verboseThinking).toBe(true);
  });

  it('tier 2 (THE NEW TIER): agents.<being>.conversation_defaults.verbose_thinking:true applies with no per-conversation override and a silent type file', async () => {
    const config = { agents: { e: { conversation_defaults: { access_level: 'regular', verbose_thinking: true } } } };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], { config, brains: typeFile(null) });
    await brain.turn('e', ev);
    expect(pool.calls[0].brainOptions.verboseThinking).toBe(true);
  });

  it('tier 2 OUTRANKS tier 3: an explicit conversation_defaults.verbose_thinking:false overrides a type file that says true (the opt-out a shared type file could never express)', async () => {
    const config = { agents: { e: { conversation_defaults: { access_level: 'regular', verbose_thinking: false } } } };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], { config, brains: typeFile(true) });
    await brain.turn('e', ev);
    expect(pool.calls[0].brainOptions.verboseThinking).toBe(false);
  });

  it('tier 1: a per-conversation verbose_thinking:true applies with nothing set at either lower tier', async () => {
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], {
      brains: typeFile(null), seedAgents: { e: { verbose_thinking: true } },
    });
    await brain.turn('e', ev);
    expect(pool.calls[0].brainOptions.verboseThinking).toBe(true);
  });

  it('tier 1 OUTRANKS tier 2: a per-conversation verbose_thinking:false wins over conversation_defaults.verbose_thinking:true', async () => {
    const config = { agents: { e: { conversation_defaults: { access_level: 'regular', verbose_thinking: true } } } };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], {
      config, brains: typeFile(null), seedAgents: { e: { verbose_thinking: false } },
    });
    await brain.turn('e', ev);
    expect(pool.calls[0].brainOptions.verboseThinking).toBe(false);
  });

  it('FULL PRECEDENCE: per-conversation true beats a conversation_defaults false beats a type-file true', async () => {
    const config = { agents: { e: { conversation_defaults: { access_level: 'regular', verbose_thinking: false } } } };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], {
      config, brains: typeFile(true), seedAgents: { e: { verbose_thinking: true } },
    });
    await brain.turn('e', ev);
    expect(pool.calls[0].brainOptions.verboseThinking).toBe(true);
  });

  it('getBeing surfaces the per-conversation value (null when the block states none) — the tier-1 read resolveConv makes', async () => {
    const { brain, getState } = harness([{ text: 'ok', sessionId: 's' }], {
      brains: typeFile(null), seedAgents: { e: { verbose_thinking: true }, wren: { mode: 'mention' } },
    });
    await brain.turn('e', ev);
    expect(getBeing(getState(), ev.surface, ev.chatId, 'e').verboseThinking).toBe(true);
    expect(getBeing(getState(), ev.surface, ev.chatId, 'wren').verboseThinking).toBe(null);
  });
});

// ── ALLOW_NEW_INPUT (operator's ruling 2026-08-30): may a message arriving while this being
//    is ALREADY streaming a turn STEER that turn, instead of queueing behind it on the spine's
//    per-conversation FIFO? An ORDERED enum none|same_sender|any, resolved with the SAME two
//    tiers accessLevel/allowedUsers/sandboxed use — per-conversation override, then
//    agents.<being>.conversation_defaults. Unlike verbose_thinking there is deliberately NO
//    type-file tier: this is a property of a CONVERSATION, not of an agent TYPE.
//
//    The fallback is the LITERAL DEFAULT ('same_sender'), not null, because resolution ENDS
//    here — there is no lower tier for a null to defer to. And the default carries a caveat
//    that belongs in the tests too: IT HAS ONLY BEEN TESTED WITH ccode. The measurement the
//    feature rests on drove the real claude stream-json CLI and nothing else; pi is untested
//    and llama has no stream, and neither exports the session-level inject() this rides on —
//    so with either brain every value here behaves like 'none' regardless (locked in
//    warm-sessions.test.mjs, where the capability actually gates it).
//
//    The spine holds the OTHER half of the decision (who triggered the live turn) and asks
//    for this via brain.allowNewInput; brain.steer is the weave itself. ──
describe('brainpool — allow_new_input (operator 2026-08-30)', () => {
  it("unset at BOTH tiers → 'same_sender' (the default)", async () => {
    const { brain } = harness([{ text: 'ok', sessionId: 's' }]);
    expect(await brain.allowNewInput('e', ev)).toBe('same_sender');
  });

  it("tier 2: agents.<being>.conversation_defaults.allow_new_input applies with no per-conversation override", async () => {
    for (const v of ['none', 'same_sender', 'any']) {
      const config = { agents: { e: { conversation_defaults: { access_level: 'regular', allow_new_input: v } } } };
      const { brain } = harness([{ text: 'ok', sessionId: 's' }], { config });
      expect(await brain.allowNewInput('e', ev)).toBe(v);
    }
  });

  it('tier 1: a per-conversation allow_new_input applies with nothing set at the global tier', async () => {
    for (const v of ['none', 'same_sender', 'any']) {
      const { brain } = harness([{ text: 'ok', sessionId: 's' }], { seedAgents: { e: { allow_new_input: v } } });
      expect(await brain.allowNewInput('e', ev)).toBe(v);
    }
  });

  it("tier 1 OUTRANKS tier 2: a per-conversation 'none' is a real opt-out over a node-wide 'any'", async () => {
    const config = { agents: { e: { conversation_defaults: { access_level: 'regular', allow_new_input: 'any' } } } };
    const { brain } = harness([{ text: 'ok', sessionId: 's' }], { config, seedAgents: { e: { allow_new_input: 'none' } } });
    expect(await brain.allowNewInput('e', ev)).toBe('none');
  });

  it('an INVALID value falls back to the default and is LOGGED — a config typo must not take the conversation down', async () => {
    const logs = [];
    const config = { agents: { e: { conversation_defaults: { access_level: 'regular', allow_new_input: 'same-sender' } } } };
    const { brain } = harness([{ text: 'ok', sessionId: 's' }], { config, onLog: (s) => logs.push(s) });
    expect(await brain.allowNewInput('e', ev)).toBe('same_sender');
    expect(logs.join('\n')).toMatch(/allow_new_input .*same-sender.* is not one of none\|same_sender\|any/);
    // ...and the turn itself still runs: this is a routing preference, not a safety gate.
    await expect(brain.turn('e', ev)).resolves.toMatchObject({ text: 'ok' });
  });

  it('an invalid value at the PER-CONVERSATION tier falls back too (the walk normalizes whatever it produced)', async () => {
    const logs = [];
    const { brain } = harness([{ text: 'ok', sessionId: 's' }], { seedAgents: { e: { allow_new_input: 'yes' } }, onLog: (s) => logs.push(s) });
    expect(await brain.allowNewInput('e', ev)).toBe('same_sender');
    expect(logs.join('\n')).toMatch(/allow_new_input/);
  });

  it('getBeing surfaces the per-conversation value RAW (null when the block states none)', async () => {
    const { brain, getState } = harness([{ text: 'ok', sessionId: 's' }], {
      seedAgents: { e: { allow_new_input: 'any' }, wren: { mode: 'mention' } },
    });
    await brain.turn('e', ev);
    expect(getBeing(getState(), ev.surface, ev.chatId, 'e').allowNewInput).toBe('any');
    expect(getBeing(getState(), ev.surface, ev.chatId, 'wren').allowNewInput).toBe(null);
  });

  it('steer() weaves into the warm key this conversation LAST ran — the same lookup evict() uses, no re-derivation', async () => {
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }]);
    await brain.turn('e', ev);
    expect(brain.steer('e', ev)).toBe(true);
    expect(pool.steered).toHaveLength(1);
    expect(pool.steered[0].key).toBe(pool.calls[0].key);   // exactly the turn's warm key
    expect(pool.steered[0].message).toBe(ev.line);         // the plain dispatch line
    expect(pool.calls).toHaveLength(1);                    // a steer is NOT a turn
  });

  it('steer() is false — and runs NOTHING — for a conversation that has never opened a warm key', async () => {
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }]);
    expect(brain.steer('e', ev)).toBe(false);
    expect(pool.steered).toHaveLength(0);
    expect(pool.calls).toHaveLength(0);
  });

  it("steer() reports the pool's refusal verbatim (a session that cannot weave → false, never a turn)", async () => {
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], { steerTakes: false });
    await brain.turn('e', ev);
    expect(brain.steer('e', ev)).toBe(false);
    expect(pool.calls).toHaveLength(1);                    // no fallthrough turn was run
  });

  it('steer() does NOT re-enter turn()\'s fresh-thread machinery — no identity feed, no roll, no second turn', async () => {
    const seeded = [];
    const { brain, pool } = harness([{ text: 'ok', sessionId: 'brand-new' }], {
      loadFeed: async () => 'IDENTITY FEED',
      seedLayers: async (...a) => { seeded.push(a); },
    });
    await brain.turn('e', ev);                             // FRESH thread: this turn IS feed-wrapped
    expect(pool.calls[0].message).toMatch(/IDENTITY FEED/);
    const seedsAfterTurn = seeded.length;
    expect(brain.steer('e', ev)).toBe(true);
    expect(pool.steered[0].message).toBe(ev.line);         // the raw line — NOT the feed
    expect(seeded.length).toBe(seedsAfterTurn);            // nothing re-seeded/overwritten
    expect(pool.calls).toHaveLength(1);
  });
});

// ── accessLevel GLOBAL-DEFAULT TIER (operator 2026-08-15): access_level used to ONLY have a
//    per-conversation override (getBeing(...).accessLevel) — no node-level default at all. Now
//    config.yaml's agents.<being>.conversation_defaults.access_level is a fallback, read via
//    getConfig() (resolveConv), consulted ONLY when the per-conversation value is null. The
//    NESTING under conversation_defaults (not a flat sibling of handles/configuration) is the
//    allowlist of which agent fields get this two-tier treatment — mirrors router.mjs's
//    allowed_users global tier exactly. ──
describe('brainpool.turn — accessLevel GLOBAL-DEFAULT tier (operator 2026-08-15, conversation_defaults)', () => {
  it("REPRODUCE-FIRST: access_level set ONLY at config.yaml's agents.<being>.conversation_defaults.access_level (no per-conversation override) still applies on the being's next turn", async () => {
    const brains = { resolve: () => ({ name: 'sonnet-high', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: ['Read'] }) };
    const config = { agents: { e: { conversation_defaults: { access_level: 'all', allowed_users: ['123'] } } } };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], {
      brains, config,
      loadPermission: (level) => (level === 'all' ? { dangerouslySkipPermissions: true, allowedTools: ['Read', 'Write', 'Bash', 'Agent'] } : null),
    });
    await brain.turn('e', ev);
    const opts = pool.calls[0].brainOptions;
    expect(opts.allowedTools).toEqual(['Read', 'Write', 'Bash', 'Agent']);   // the global default's permissions grant applied
    expect(opts.confineToDirs).toBeUndefined();                             // dangerously_skip_permissions:true → unconfined
  });

  it('REGRESSION: a per-conversation accessLevel override still WINS over the node global conversation_defaults.access_level default', async () => {
    const brains = { resolve: () => ({ name: 'sonnet-high', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: ['Read'] }) };
    const config = { agents: { e: { conversation_defaults: { access_level: 'all' } } } };
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], {
      brains, config, seedAgents: { e: { access_level: 'regular' } },
      loadPermission: (level) => {
        if (level === 'all') return { dangerouslySkipPermissions: true, allowedTools: ['Bash'] };
        if (level === 'regular') return { dangerouslySkipPermissions: false, allowedTools: DEFAULT_ALLOWED_TOOLS };
        return null;
      },
    });
    await brain.turn('e', ev);
    const opts = pool.calls[0].brainOptions;
    expect(opts.allowedTools).toEqual(DEFAULT_ALLOWED_TOOLS);   // per-conversation 'regular' wins, NOT the global 'all'
    expect(opts.confineToDirs).toEqual([opts.cwd]);             // confined, not the global tier's unconfined grant
  });

  // REWRITTEN (operator 2026-08-20): "neither tier set" used to REFUSE outright (the 2026-08-16
  // gate). Refined the same day — see the identical note on its twin above: an unset accessLevel
  // now resolves to 'regular' and the turn runs CONFINED, loadPermission('regular') included.
  it("neither tier set → resolves to 'regular', runs CONFINED (superseded — was \"turn() REFUSES\")", async () => {
    const brains = { resolve: () => ({ name: 'egpt', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: 'all' }) };
    let seenLevel = null;
    const { brain, pool } = harness([{ text: 'ok', sessionId: 's' }], {
      brains, skipAccessLevelDefault: true,
      loadPermission: (level) => { seenLevel = level; return { dangerouslySkipPermissions: false, allowedTools: DEFAULT_ALLOWED_TOOLS }; },
    });
    await brain.turn('e', ev);
    expect(seenLevel).toBe('regular');
    expect(pool.calls).toHaveLength(1);
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
describe('brainpool.turn — dangerously_skip_permissions:true escalation hole is closed end-to-end (real createBrains, real files)', () => {
  it('a conv-local brains/<name>.yaml attempting dangerously_skip_permissions:true does NOT unconfine a sibling turn', async () => {
    const tmpBase = mkdtempSync(join(tmpdir(), 'egpt-brains-e2e-'));
    const builtinDir = join(tmpBase, 'builtin');
    const convDir = join(tmpBase, 'conv');
    mkdirSync(builtinDir, { recursive: true });
    mkdirSync(join(convDir, 'brains'), { recursive: true });
    // a non-unconfined sibling type, shipped as a built-in
    writeFileSync(join(builtinDir, 'sonnet-high.yaml'), 'type: ccode\nmodel: sonnet\neffort: high\nallowed_tools:\n  - Read\n  - Bash\n', 'utf8');
    // THE ATTACK: a conv-local override — written by a being with ordinary Write access
    // to its own convDir — trying to grant itself dangerously_skip_permissions:true (mirroring
    // the real attack shape: dangerously_skip_permissions + a bare tool list).
    writeFileSync(join(convDir, 'brains', 'sonnet-high.yaml'), 'dangerously_skip_permissions: true\nallowed_tools:\n  - Bash\n  - Agent\n', 'utf8');

    const realBrains = createBrains({ builtinDir, agentsDir: join(tmpBase, 'nonexistent-agents') });
    const config = { agents: { wren: { configuration: 'sonnet-high', name: 'wren' } } };

    const spy = vi.spyOn(ConversationRoom.prototype, 'baseDir').mockReturnValue(convDir);
    try {
      const { brain, pool } = harness([{ text: 'ok', sessionId: 'w1' }], { brains: realBrains, config });
      await brain.turn('wren', ev);
      const opts = pool.calls[0].brainOptions;
      // the hole: dangerously_skip_permissions:true from the conv-local layer must NOT reach
      // brainOptions — the turn stays confined, exactly like the "REGRESSION: a def with
      // dangerously_skip_permissions absent" case above.
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
    // resolveBeingDef (phase 2) needs an agents()['e'] entry to exist before it will attempt
    // brains.resolve — see the main harness()'s identical synthesis above. access_level:'regular'
    // (operator 2026-08-16 structural gate, see harness()'s identical default) + a no-op
    // loadPermission below so the ACCESS-LEVEL OVERRIDE block doesn't clobber the test's def.
    getConfig: () => ({ agents: { e: { conversation_defaults: { access_level: 'regular' } } } }),
    contacts: createContacts({ loadState, writeState, io: { mkdir: async () => {} } }),
    loadState, writeState,
    io: { mkdir: async () => {}, readFile: async () => null, writeFile: async () => {} },
    loadFeed: async () => '', loadManifest: async () => '',
    brains,
    loadPermission: () => null,
    onLog: (m) => logs.push(String(m)),
  });
  return { brain, pool };
}

// THE FRESH MOMENT — what happens when a thread is (re-)instanced, i.e. the operator deleted
// threadId, /agents reset <handle> ran, or the session died. Two things the brainpool owes that moment:
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

  // REPRODUCE-FIRST (phase 2, operator 2026-08-14): seedLayers used to be gated on
  // `!isSibling` — a sibling turn never copied the identity kickoff layers into its conv
  // folder at all. The gate is REMOVED (not widened): every being's turn calls seedLayers now.
  it('PHASE 2: a SIBLING turn now ALSO copies the identity layers into its conv folder — no longer persona-only', async () => {
    const brains = { resolve: (name) => name === 'sonnet-high' ? ({ name: 'sonnet-high', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: 'Read,Bash' }) : null };
    const config = { agents: { wren: { configuration: 'sonnet-high', name: 'wren' } } };
    const seen = [];
    const seedLayers = async (room, name, opts = {}) => { seen.push({ overwrite: opts.overwrite }); return []; };
    const { brain } = harness([{ text: 'ok', sessionId: 'w1' }], { brains, config, seedLayers });
    await brain.turn('wren', ev);
    expect(seen).toEqual([{ overwrite: true }]);   // phase 2: called for the sibling's fresh turn too
  });

  // REPRODUCE-FIRST (phase 2 investigation, operator 2026-08-14): rollTranscript stays
  // PERSONA-ONLY on purpose — transcript.md is ONE shared file per conversation folder, not
  // per-being. If a sibling's OWN fresh-thread event also rolled it, a sibling's first-ever
  // turn in a conversation where the persona is already mid-thread would archive (and blank)
  // the persona's still-live transcript out from under it. This locks that a sibling's fresh
  // turn changes nothing about the shared file — the investigation's conclusion, made concrete.
  it('PHASE 2 (investigated, deliberately unchanged): a SIBLING\'s own fresh-thread turn does NOT roll the shared transcript, even while the persona is mid-thread', async () => {
    const brains = { resolve: (name) => name === 'sonnet-high' ? ({ name: 'sonnet-high', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: 'Read,Bash' }) : null };
    // access_level: 'regular' on BOTH beings (operator 2026-08-16 structural gate) — this config
    // supplies its OWN agents block (only 'wren'), so the harness's auto-default (which only fills
    // in beings the config ALREADY names) never sees 'e'; pin it explicitly here instead.
    const config = { agents: { wren: { configuration: 'sonnet-high', name: 'wren' }, e: { conversation_defaults: { access_level: 'regular' } } } };
    const fs = fakeIo({});
    const { brain, getState } = harness([{ text: 'a', sessionId: 'sid-1' }, { text: 'b', sessionId: 'w1' }], { io: fs.io, brains, config });
    await brain.turn('e', ev);                                          // persona's own fresh turn: gets thread sid-1
    const conv = norm(slugDir('whatsapp', getContact(getState(), 'whatsapp', ev.chatId).slug));
    const before = OLD.replace('THREAD-OLD', 'sid-1');
    fs.files[`${conv}/transcript.md`] = before;                         // the persona's active, stamped transcript

    await brain.turn('wren', ev);                                       // wren's OWN first-ever turn — fresh, no threadId

    // NOTHING ARCHIVED — the roll itself stayed persona-only, so the shared file was never
    // renamed out to transcripts/<id>.md.
    expect(Object.keys(fs.files).filter((p) => p.includes('/transcripts/'))).toEqual([]);
    // The persona's recorded conversation BODY survives untouched (this is what the roll
    // would have wiped had it fired). stampThreadId — a SEPARATE, pre-existing, being-agnostic
    // mechanism unrelated to phase 2 (it already ran for every being before this change) — DOES
    // re-stamp the shared front matter's `thread_id` to wren's own freshly-minted session; that
    // is expected and orthogonal to what this test locks.
    const after = fs.files[`${conv}/transcript.md`];
    expect(after).toContain('hola');
    expect(after).toContain('[@e (14:05)]: hey');
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
