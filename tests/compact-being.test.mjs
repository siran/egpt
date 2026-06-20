import { describe, it, expect } from 'vitest';
import {
  latestContextTokens, needsCompaction, compactableBeings, summarize, windowForModel,
  DEFAULT_WINDOW, COMPACT_RATIO,
} from '../src/tools/compact-being.mjs';

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
    // a big pre-compact turn, THEN a compact boundary and no real turn since
    const jsonl = [
      usageLine({ input_tokens: 2, cache_read_input_tokens: 768495, cache_creation_input_tokens: 854 }),  // wren's 769k turn
      '{"type":"user","isCompactSummary":true,"message":{"role":"user","content":"summary…"}}',            // compact boundary, newer
    ].join('\n');
    expect(latestContextTokens(jsonl)).toBe(0);          // effectively small now → not over threshold
    expect(needsCompaction(latestContextTokens(jsonl), { window: 1_000_000 })).toBe(false);
    // but once a REAL turn runs after the boundary, its usage counts again
    const after = jsonl + '\n' + usageLine({ input_tokens: 10, cache_read_input_tokens: 40000, cache_creation_input_tokens: 0 });
    expect(latestContextTokens(after)).toBe(40010);
  });

  it('the threshold is a fraction of the window, not the full window', () => {
    const limit = Math.round(DEFAULT_WINDOW * COMPACT_RATIO);   // 130_000 (haiku default)
    expect(needsCompaction(limit - 1)).toBe(false);
    expect(needsCompaction(limit)).toBe(true);
    expect(needsCompaction(DEFAULT_WINDOW)).toBe(true);
    // a freshly-compacted being (Don at 53k) stays well under → left alone
    expect(needsCompaction(53421)).toBe(false);
  });

  it('honours a custom window/ratio', () => {
    expect(needsCompaction(60, { window: 100, ratio: 0.5 })).toBe(true);
    expect(needsCompaction(40, { window: 100, ratio: 0.5 })).toBe(false);
  });

  it('context window is per-model — haiku 200k, opus/sonnet 1M (so 769k is fine on opus, fatal on haiku)', () => {
    expect(windowForModel('haiku')).toBe(200_000);
    expect(windowForModel('claude-opus-4-8')).toBe(1_000_000);
    expect(windowForModel('sonnet')).toBe(1_000_000);
    expect(windowForModel('whatever-unknown')).toBe(200_000);   // conservative default
    // Wren's real 769k: under threshold on opus (1M*0.65=650k? → over), over the roof on haiku
    expect(needsCompaction(769351, { window: windowForModel('opus') })).toBe(true);   // 769k ≥ 650k → compact
    expect(needsCompaction(120_000, { window: windowForModel('opus') })).toBe(false); // 120k on opus → plenty of room
    expect(needsCompaction(120_000, { window: windowForModel('haiku') })).toBe(false);
    expect(needsCompaction(150_000, { window: windowForModel('haiku') })).toBe(true); // 150k on haiku → compact
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
    expect(wren.model).toBe('haiku');           // default
    expect(wren.window).toBe(200_000);          // haiku window
    const don = compactableBeings(config).find(b => b.name === 'don');
    expect(don.cwd).toBe('C:/x');
    expect(don.window).toBe(200_000);
  });

  it('resolves the per-being window from model, with a config override', () => {
    const config = { siblings: {
      wren: { type: 'ccode', session_id: 'a', model: 'opus' },
      don:  { type: 'ccode', session_id: 'b', model: 'haiku' },
      sona: { type: 'ccode', session_id: 'c', model: 'sonnet', context_window: 400_000 },  // explicit override
    } };
    const by = Object.fromEntries(compactableBeings(config).map(b => [b.name, b.window]));
    expect(by).toEqual({ wren: 1_000_000, don: 200_000, sona: 400_000 });
  });

  it('summarize reports only beings actually acted on', () => {
    expect(summarize([{ name: 'don', status: 'ok', before: 50 }])).toMatch(/nothing over threshold/);
    expect(summarize([
      { name: 'don', status: 'compacted', before: 150000 },
      { name: 'wren', status: 'ok', before: 20000 },
    ])).toBe('compact: don compacted (was 150000 tok)');
  });
});
