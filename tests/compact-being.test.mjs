import { describe, it, expect } from 'vitest';
import {
  latestContextTokens, needsCompaction, compactableBeings, compactableConversations, summarize, windowForModel,
  isActiveMtime, DEFAULT_WINDOW, COMPACT_RATIO, BUSY_WINDOW_MS,
  extractConversationText, buildReseedPrompt, buildSeedPrompt, reseedSession, compactBeingIfNeeded,
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
    // THIN policy (25% → 50k on haiku): even ~53k trips it; only well under is left alone
    expect(needsCompaction(40_000)).toBe(false);
    expect(needsCompaction(53421)).toBe(true);
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
    // 25% thresholds: haiku 50k, opus/sonnet 250k
    expect(needsCompaction(769351, { window: windowForModel('opus') })).toBe(true);   // 769k ≥ 250k → compact
    expect(needsCompaction(120_000, { window: windowForModel('opus') })).toBe(false); // 120k on opus → plenty of room
    expect(needsCompaction(40_000, { window: windowForModel('haiku') })).toBe(false); // 40k < 50k → ok
    expect(needsCompaction(60_000, { window: windowForModel('haiku') })).toBe(true);  // 60k ≥ 50k → compact
  });

  it('compactableConversations — active threads become compaction targets (skips aliases / no-thread)', () => {
    const state = { contacts: {
      whatsapp: {
        '111@s': { slug: 'mom', threadId: 'sess-mom', threadCwd: 'C:/conv/mom' },
        '222@s': { slug: 'work', threadId: 'sess-work', threadCwd: 'C:/conv/work' },
        '333@s': { slug: 'idle' },                                  // no threadId → skip
        '444@s': { aliasOf: '111@s', threadId: 'x' },               // alias → skip
      },
      telegram: { '999': { slug: 'tg-chat', threadId: 'sess-tg', threadCwd: 'C:/conv/tg' } },
    } };
    const got = compactableConversations(state, 'haiku');
    expect(got.map(c => c.name).sort()).toEqual(['telegram/tg-chat', 'whatsapp/mom', 'whatsapp/work']);
    expect(got.find(c => c.name === 'whatsapp/mom')).toMatchObject({ sessionId: 'sess-mom', cwd: 'C:/conv/mom', model: 'haiku', window: 200_000 });
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

  it('BUSY-SKIP: a session whose jsonl changed recently is mid-turn → never reaped (the 2026-06-20 Wren guillotine)', () => {
    const now = 1_700_000_000_000;
    // Wren's failed turn: the scan fired 2.4 min into the turn — INSIDE the window → must skip
    expect(isActiveMtime(now - 2.4 * 60_000, now)).toBe(true);
    expect(isActiveMtime(now - 1_000, now)).toBe(true);                    // 1s ago → active
    expect(isActiveMtime(now - (BUSY_WINDOW_MS - 1), now)).toBe(true);     // just inside → active
    expect(isActiveMtime(now - (BUSY_WINDOW_MS + 1), now)).toBe(false);    // just outside → idle, ok to compact
    expect(isActiveMtime(now - 60 * 60_000, now)).toBe(false);            // an hour quiet → idle
    expect(isActiveMtime(NaN, now)).toBe(false);                          // no mtime → not active
  });

  it('summarize notes busy-skipped sessions (so the heartbeat log shows the skip, not silence)', () => {
    expect(summarize([{ name: 'wren', status: 'busy-skip', before: 60000 }]))
      .toBe('compact: nothing over threshold (1 busy-skipped)');
    expect(summarize([
      { name: 'don', status: 'compacted', before: 150000 },
      { name: 'wren', status: 'busy-skip', before: 60000 },
    ])).toBe('compact: don compacted (was 150000 tok) (1 busy-skipped)');
  });
});

describe('compact-being — summarize-and-reseed (claude /compact is dead on 2.1.185)', () => {
  const userLine = (t) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: t }] } });
  const asstLine = (t) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } });

  it('extractConversationText pulls user/assistant text and labels roles', () => {
    const jsonl = [
      userLine('hello there'),
      asstLine('hi, how can I help'),
      '{"type":"system","subtype":"init"}',                       // non-message → skipped
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'plain string content' } }),
      asstLine(''),                                               // empty → skipped
    ].join('\n');
    const text = extractConversationText(jsonl);
    expect(text).toContain('User: hello there');
    expect(text).toContain('Assistant: hi, how can I help');
    expect(text).toContain('User: plain string content');
    expect(text).not.toContain('init');
  });

  it('extractConversationText keeps only the TAIL within the char budget', () => {
    const lines = [];
    for (let i = 0; i < 50; i++) lines.push(userLine(`msg-${i} ${'x'.repeat(50)}`));
    const text = extractConversationText(lines.join('\n'), { maxChars: 200 });
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text).toContain('msg-49');     // most recent kept
    expect(text).not.toContain('msg-0');  // oldest dropped
  });

  it('the prompts keep the brief OUT of the conversation feed and the seed', () => {
    const reseed = buildReseedPrompt('CONV-BODY');
    expect(reseed).toContain('=== CONVERSATION ===');
    expect(reseed).toContain('CONV-BODY');
    const seed = buildSeedPrompt('THE BRIEF');
    expect(seed).toContain('THE BRIEF');
    expect(seed).not.toContain('=== CONVERSATION ===');   // the seed carries ONLY the brief
  });

  it('reseedSession distils + seeds a fresh session and reports the new id', () => {
    const dir = mkdtempSync(pjoin(tmpdir(), 'reseed-'));
    const file = pjoin(dir, 'sess.jsonl');
    writeFileSync(file, [userLine('remember the secret is 42'), asstLine('noted')].join('\n'));
    let fedConversation = null, fedSeed = null;
    const summarize = (text, opts) => { fedConversation = text; fedSeed = 'BRIEF'; return { sessionId: 'fresh-001', brief: 'BRIEF' }; };
    const r = reseedSession(
      { name: 'whatsapp/spoiler', sessionId: 'old-999', model: 'haiku', cwd: dir },
      { summarize, resolveFile: () => file },
    );
    expect(r.status).toBe('reseeded');
    expect(r.newSessionId).toBe('fresh-001');
    expect(fedConversation).toContain('secret is 42');   // the summarizer saw the real history
  });

  it('reseedSession aborts when the summarizer returns the SAME id or nothing', () => {
    const dir = mkdtempSync(pjoin(tmpdir(), 'reseed-'));
    const file = pjoin(dir, 'sess.jsonl');
    writeFileSync(file, userLine('hi'));
    const same = reseedSession({ name: 'x', sessionId: 'old-999', model: 'haiku', cwd: dir },
      { summarize: () => ({ sessionId: 'old-999', brief: 'b' }), resolveFile: () => file });
    expect(same.status).toBe('reseed-failed');
    const none = reseedSession({ name: 'x', sessionId: 'old-999', model: 'haiku', cwd: dir },
      { summarize: () => null, resolveFile: () => file });
    expect(none.status).toBe('reseed-failed');
    const noFile = reseedSession({ name: 'x', sessionId: 'gone', model: 'haiku' },
      { summarize: () => ({ sessionId: 'new' }), resolveFile: () => null });
    expect(noFile.status).toBe('no-session-file');
  });

  it('compactBeingIfNeeded reseeds an over-threshold session and carries newSessionId', () => {
    const dir = mkdtempSync(pjoin(tmpdir(), 'reseed-'));
    const file = pjoin(dir, 'sess.jsonl');
    // a usage line over the haiku 25% threshold (50k) + some conversation
    writeFileSync(file, [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', usage: { input_tokens: 10, cache_read_input_tokens: 179206, cache_creation_input_tokens: 0 } } }),
      userLine('the football debate'), asstLine('par or impar'),
    ].join('\n'));
    const r = compactBeingIfNeeded(
      { name: 'whatsapp/spoiler', sessionId: 'old-999', model: 'haiku', window: 200_000, cwd: dir, surface: 'whatsapp', slug: 'spoiler' },
      { force: true, summarize: () => ({ sessionId: 'fresh-77', brief: 'B' }), resolveFile: () => file },
    );
    expect(r.status).toBe('compacted');     // reporting layer unchanged
    expect(r.newSessionId).toBe('fresh-77'); // pointer for the CLI main to persist
    expect(r.before).toBe(179216);
  });

  it('compactableConversations carries surface+slug and leaves cwd null when no threadCwd (runner fills it)', () => {
    const state = { contacts: { whatsapp: {
      '111@s': { slug: 'mom', threadId: 'sess-mom' },                      // no threadCwd
      '222@s': { slug: 'work', threadId: 'sess-work', threadCwd: 'C:/conv/work' },
    } } };
    const got = compactableConversations(state, 'haiku');
    const mom = got.find(c => c.name === 'whatsapp/mom');
    expect(mom).toMatchObject({ surface: 'whatsapp', slug: 'mom', sessionId: 'sess-mom', cwd: null });
    const work = got.find(c => c.name === 'whatsapp/work');
    expect(work.cwd).toBe('C:/conv/work');   // threadCwd preserved
  });
});
