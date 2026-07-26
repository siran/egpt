import { describe, it, expect } from 'vitest';
import {
  latestContextTokens, needsCompaction, compactableBeings, compactableConversations, windowForModel,
  isActiveMtime, DEFAULT_WINDOW, COMPACT_RATIO, BUSY_WINDOW_MS,
  compactionTargets, dueForCompaction,
} from '../src/tools/compact-being.mjs';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join as pjoin } from 'node:path';
import { tmpdir } from 'node:os';

const usageLine = (u) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', usage: u } });

describe('compact-being — deterministic trigger', () => {
  it('reads the latest turn context from Claude Code usage (input + cache_read + cache_creation)', () => {
    const jsonl = [
      usageLine({ input_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 }),
      usageLine({ input_tokens: 10, cache_read_input_tokens: 21142, cache_creation_input_tokens: 32269 }),  // the LAST one wins
      '{"type":"last-prompt"}', '{"type":"permission-mode"}',                                                // trailing metadata is skipped
    ].join('\n');
    expect(latestContextTokens(jsonl)).toBe(10 + 21142 + 32269);   // 53421 — matches Don's real session
  });

  it('returns 0 for a session with no usage yet (fresh/empty → never compacts)', () => {
    expect(latestContextTokens('')).toBe(0);
    expect(latestContextTokens('{"type":"user"}\n{"type":"system"}')).toBe(0);
    expect(needsCompaction(0)).toBe(false);
  });

  it('returns 0 right after a compact (boundary NEWER than last usage) — never re-compacts', () => {
    const jsonl = [
      usageLine({ input_tokens: 2, cache_read_input_tokens: 768495, cache_creation_input_tokens: 854 }),  // wren's 769k turn
      '{"type":"user","isCompactSummary":true,"message":{"role":"user","content":"summary…"}}',            // compact boundary, newer
    ].join('\n');
    expect(latestContextTokens(jsonl)).toBe(0);          // effectively small now → not over threshold
    expect(needsCompaction(latestContextTokens(jsonl), { window: 1_000_000 })).toBe(false);
    const after = jsonl + '\n' + usageLine({ input_tokens: 10, cache_read_input_tokens: 40000, cache_creation_input_tokens: 0 });
    expect(latestContextTokens(after)).toBe(40010);
  });

  it('the threshold is a fraction of the window, not the full window', () => {
    const limit = Math.round(DEFAULT_WINDOW * COMPACT_RATIO);   // 50_000 (haiku default)
    expect(needsCompaction(limit - 1)).toBe(false);
    expect(needsCompaction(limit)).toBe(true);
    expect(needsCompaction(DEFAULT_WINDOW)).toBe(true);
    expect(needsCompaction(40_000)).toBe(false);
    expect(needsCompaction(53421)).toBe(true);
  });

  it('honours a custom window/ratio', () => {
    expect(needsCompaction(60, { window: 100, ratio: 0.5 })).toBe(true);
    expect(needsCompaction(40, { window: 100, ratio: 0.5 })).toBe(false);
  });

  it('context window is per-model — haiku 200k, opus/sonnet 1M', () => {
    expect(windowForModel('haiku')).toBe(200_000);
    expect(windowForModel('claude-opus-4-8')).toBe(1_000_000);
    expect(windowForModel('sonnet')).toBe(1_000_000);
    expect(windowForModel('whatever-unknown')).toBe(200_000);   // conservative default
    expect(needsCompaction(769351, { window: windowForModel('opus') })).toBe(true);   // 769k ≥ 250k → compact
    expect(needsCompaction(120_000, { window: windowForModel('opus') })).toBe(false); // 120k on opus → plenty of room
    expect(needsCompaction(40_000, { window: windowForModel('haiku') })).toBe(false); // 40k < 50k → ok
    expect(needsCompaction(60_000, { window: windowForModel('haiku') })).toBe(true);  // 60k ≥ 50k → compact
  });

  // REPRODUCE-FIRST (HANDOFF C4, 2026-07-26): a live thread lives in the NESTED per-being block
  // `entry[<being>].threadId` since the 2026-07-10 agent-identity refactor — the FLAT `e.threadId`
  // is the abandoned legacy slot. Enumerating the flat slot found ZERO of the live threads on the
  // real registry (14 stale flat targets vs 12 live nested ones, measured 2026-07-26).
  it('compactableConversations — NESTED per-being threads become targets (skips aliases / no-thread)', () => {
    const state = { contacts: {
      whatsapp: {
        '111@s': { slug: 'mom', egpt: { threadId: 'sess-mom', readonly: { type: 'ccode' } } },
        '222@s': { slug: 'work', egpt: { threadId: 'sess-work' } },                  // no frozen type yet
        '333@s': { slug: 'idle', egpt: { mode: 'auto' } },                           // resident, no thread → skip
        '444@s': { aliasOf: '111@s', egpt: { threadId: 'x' } },                     // alias → skip
        '555@s': { slug: 'legacy', threadId: 'sess-legacy' },                        // FLAT-only → abandoned, skip
      },
      telegram: { '999': { slug: 'tg-chat', egpt: { threadId: 'sess-tg' } } },
    } };
    const got = compactableConversations(state, 'haiku');
    expect(got.map(c => c.name).sort()).toEqual(['telegram/tg-chat#egpt', 'whatsapp/mom#egpt', 'whatsapp/work#egpt']);
    expect(got.find(c => c.name === 'whatsapp/mom#egpt')).toMatchObject({ surface: 'whatsapp', slug: 'mom', being: 'egpt', sessionId: 'sess-mom', engine: 'ccode', model: 'haiku', window: 200_000 });
    expect(got.find(c => c.name === 'whatsapp/work#egpt').engine).toBe(null);
  });

  it('one conversation with TWO resident beings yields TWO targets (one thread each)', () => {
    const state = { contacts: { whatsapp: { '111@s': { slug: 'lab',
      egpt: { threadId: 'sess-e' },
      scribe: { threadId: 'sess-scribe' },
      guard: { turns: 3, window: 60 },          // a contact-level override, NOT a resident
    } } } };
    const got = compactableConversations(state, 'haiku');
    expect(got.map(c => c.sessionId).sort()).toEqual(['sess-e', 'sess-scribe']);
  });

  it('an `agents:` override of threadId is honoured (getBeing is the reader, not a re-parse)', () => {
    const state = { contacts: { whatsapp: { '111@s': { slug: 'mom',
      egpt: { threadId: 'sess-old' },
      agents: { egpt: { threadId: 'sess-pinned' } },
    } } } };
    expect(compactableConversations(state, 'haiku')[0].sessionId).toBe('sess-pinned');
  });

  it('selects only LOCAL ccode beings with a session_id — never sdk/codex/llama or _note', () => {
    const config = { siblings: {
      _note: 'registry doc',
      e:    { type: 'ccode', body_emoji: '🐶' },                       // no session_id → skip
      don:  { type: 'ccode', session_id: '23dfef93', cwd: 'C:/x', model: 'haiku' },
      wren: { type: 'ccode', session_id: '120da173' },                 // cwd/model defaulted
      jay:  { type: 'claude-sdk', session_id: '825b1c00' },            // sdk → skip
      iris: { type: 'codex', session_id: '019eb415', enabled: false }, // codex + disabled → skip
      l:    { type: 'llama' },                                          // llama → skip
    } };
    const got = compactableBeings(config).map(b => b.name).sort();
    expect(got).toEqual(['don', 'wren']);
    const wren = compactableBeings(config).find(b => b.name === 'wren');
    expect(wren.model).toBe('haiku');
    expect(wren.window).toBe(200_000);
    const don = compactableBeings(config).find(b => b.name === 'don');
    expect(don.cwd).toBe('C:/x');
  });

  it('resolves the per-being window from model, with a config override', () => {
    const config = { siblings: {
      wren: { type: 'ccode', session_id: 'a', model: 'opus' },
      don:  { type: 'ccode', session_id: 'b', model: 'haiku' },
      sona: { type: 'ccode', session_id: 'c', model: 'sonnet', context_window: 400_000 },
    } };
    const by = Object.fromEntries(compactableBeings(config).map(b => [b.name, b.window]));
    expect(by).toEqual({ wren: 1_000_000, don: 200_000, sona: 400_000 });
  });

  it('isActiveMtime: a recently-touched jsonl is mid-turn', () => {
    const now = 1_700_000_000_000;
    expect(isActiveMtime(now - 2.4 * 60_000, now)).toBe(true);
    expect(isActiveMtime(now - (BUSY_WINDOW_MS - 1), now)).toBe(true);
    expect(isActiveMtime(now - (BUSY_WINDOW_MS + 1), now)).toBe(false);
    expect(isActiveMtime(NaN, now)).toBe(false);
  });
});

describe('compact-being — warm-pool targets (native /compact lives in the spine)', () => {
  it('builds the EXACT warm-pool keys dispatch/spine use (drift guard)', () => {
    const config = { default_brain: { model: 'haiku' }, siblings: {
      wren: { type: 'ccode', session_id: 'wren-sid', model: 'opus', cwd: 'C:/wren' },
    } };
    const convState = { contacts: { whatsapp: {
      '120@g.us': { slug: 'SPOILER-x', egpt: { threadId: 'spoiler-sid', readonly: { type: 'ccode' } } },
    } } };
    const slugDir = (surface, slug) => `C:/.egpt/conversations/${surface}/${slug}`;
    const targets = compactionTargets({ config, convState, slugDir });
    const being = targets.find(t => t.name === 'wren');
    const conv = targets.find(t => t.name === 'whatsapp/SPOILER-x#egpt');
    // being key MUST match egpt-spine.mjs: `sib:<name>:<session_id>`
    expect(being.key).toBe('sib:wren:wren-sid');
    expect(being).toMatchObject({ sessionId: 'wren-sid', cwd: 'C:/wren', klass: 'resident', window: 1_000_000 });
    // conversation key MUST match brainpool's warm key: `<being>:<engine>:<surface>:<slug>` —
    // the being is the RESIDENT's own name (live profiles run `egpt`, never a literal 'e').
    expect(conv.key).toBe('egpt:ccode:whatsapp:SPOILER-x');
    expect(conv).toMatchObject({ sessionId: 'spoiler-sid', cwd: 'C:/.egpt/conversations/whatsapp/SPOILER-x', klass: 'conversation' });
  });

  it('a not-yet-instanced thread falls back to the default engine in the key', () => {
    const config = { default_brain: { model: 'haiku' }, siblings: {} };
    const convState = { contacts: { whatsapp: { '1@g': { slug: 'chat', egpt: { threadId: 'sid' } } } } };
    const slugDir = (surface, slug) => `C:/dir/${surface}/${slug}`;
    const [conv] = compactionTargets({ config, convState, slugDir });
    expect(conv.key).toBe('egpt:ccode:whatsapp:chat');
    expect(conv.cwd).toBe('C:/dir/whatsapp/chat');   // the cwd the daemon resumes with
  });

  it('dueForCompaction reads the session jsonl and applies the threshold', () => {
    const dir = mkdtempSync(pjoin(tmpdir(), 'due-'));
    const file = pjoin(dir, 's.jsonl');
    writeFileSync(file, usageLine({ input_tokens: 10, cache_read_input_tokens: 60000, cache_creation_input_tokens: 0 }));
    const over = dueForCompaction({ sessionId: 'x', model: 'haiku', window: 200_000 }, { resolveFile: () => file });
    expect(over).toMatchObject({ due: true, tokens: 60010, threshold: 50_000 });

    writeFileSync(file, usageLine({ input_tokens: 10, cache_read_input_tokens: 30000, cache_creation_input_tokens: 0 }));
    const under = dueForCompaction({ sessionId: 'x', model: 'haiku', window: 200_000 }, { resolveFile: () => file });
    expect(under.due).toBe(false);

    const missing = dueForCompaction({ sessionId: 'gone' }, { resolveFile: () => null });
    expect(missing.due).toBe(false);
  });
});
