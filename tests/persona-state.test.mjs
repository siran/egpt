// tests/persona-state.test.mjs — @egpt persona session-history rules.
//
// Pin the behavior of every /egpt subcommand at the helper level, so the
// shell handler is a thin shell over tested logic.
//
//   /egpt status  → summarize(state)
//   /egpt list    → listHistory(state)
//   /egpt new     → startNew(state)        — clears active id, keeps history
//   /egpt rewind  → rewind(state, target)  — sets active to a past session
//
// The brain's optionsPatch.sessionId is fed back to the state via
// recordSession() after every @egpt turn — that's how history populates.

import { describe, it, expect } from 'vitest';
import {
  emptyState,
  recordSession,
  startNew,
  rewind,
  listHistory,
  summarize,
  HISTORY_CAP,
} from '../src/persona-state.mjs';

describe('persona-state — recordSession (history populates from @egpt turns)', () => {
  it('emptyState has no active session and no history', () => {
    const s = emptyState();
    expect(s.session_id).toBe(null);
    expect(s.history).toEqual([]);
  });

  it('recording a session sets active and prepends to history', () => {
    const s = recordSession(emptyState(), 'A');
    expect(s.session_id).toBe('A');
    expect(s.history).toHaveLength(1);
    expect(s.history[0].id).toBe('A');
  });

  it('recording a second session moves active and prepends history (newest first)', () => {
    let s = emptyState();
    s = recordSession(s, 'A');
    s = recordSession(s, 'B');
    expect(s.session_id).toBe('B');
    expect(s.history.map(h => h.id)).toEqual(['B', 'A']);
  });

  it('recording an existing id is dedup — moves it to the top, no duplicate entry', () => {
    let s = emptyState();
    s = recordSession(s, 'A');
    s = recordSession(s, 'B');
    s = recordSession(s, 'A');
    expect(s.session_id).toBe('A');
    expect(s.history.map(h => h.id)).toEqual(['A', 'B']);
    expect(s.history).toHaveLength(2);
  });

  it('history is capped at HISTORY_CAP (oldest entries fall off)', () => {
    let s = emptyState();
    for (let i = 0; i < HISTORY_CAP + 5; i++) s = recordSession(s, `id-${i}`);
    expect(s.history).toHaveLength(HISTORY_CAP);
    expect(s.history[0].id).toBe(`id-${HISTORY_CAP + 4}`);
  });

  it('records the brain type per entry (ccode vs codex are distinguishable)', () => {
    let s = emptyState({ type: 'ccode' });
    s = recordSession(s, 'A', { type: 'ccode' });
    s = recordSession(s, 'B', { type: 'codex' });
    expect(s.history[0]).toMatchObject({ id: 'B', type: 'codex' });
    expect(s.history[1]).toMatchObject({ id: 'A', type: 'ccode' });
  });

  it('null/empty id is a no-op (defensive — brain might return no id on error)', () => {
    const s = recordSession(emptyState(), null);
    expect(s).toEqual(emptyState());
  });
});

describe('persona-state — startNew (the /egpt new subcommand)', () => {
  it('clears active session_id but preserves history', () => {
    let s = emptyState();
    s = recordSession(s, 'A');
    s = recordSession(s, 'B');
    s = startNew(s);
    expect(s.session_id).toBe(null);
    expect(s.history.map(h => h.id)).toEqual(['B', 'A']);
  });

  it('on already-empty active is a no-op (returns the same state)', () => {
    const s = emptyState();
    expect(startNew(s)).toBe(s);  // identity, not just equality
  });
});

describe('persona-state — rewind (the /egpt rewind subcommand)', () => {
  it('default (no target) sets active to most-recent past session [history[0]]', () => {
    let s = emptyState();
    s = recordSession(s, 'A');
    s = recordSession(s, 'B');
    s = startNew(s);  // active=null, history=[B, A]
    s = rewind(s);
    expect(s.session_id).toBe('B');
  });

  it('rewind by numeric index walks deeper into history', () => {
    let s = emptyState();
    s = recordSession(s, 'A');
    s = recordSession(s, 'B');
    s = recordSession(s, 'C');
    s = rewind(s, 2);  // history[2] = A
    expect(s.session_id).toBe('A');
  });

  it('rewind by id-prefix matches uniquely', () => {
    let s = emptyState();
    s = recordSession(s, 'aaa-111');
    s = recordSession(s, 'bbb-222');
    s = rewind(s, 'aaa');
    expect(s.session_id).toBe('aaa-111');
  });

  it('rewind to a different-typed past session updates state.type accordingly', () => {
    let s = emptyState({ type: 'ccode' });
    s = recordSession(s, 'A', { type: 'ccode' });
    s = recordSession(s, 'B', { type: 'codex' });
    s = rewind(s, 1);  // back to A
    expect(s.session_id).toBe('A');
    expect(s.type).toBe('ccode');
  });

  it('rewind preserves history (so you can move forward / rewind again)', () => {
    let s = emptyState();
    s = recordSession(s, 'A');
    s = recordSession(s, 'B');
    s = rewind(s, 1);
    expect(s.history).toHaveLength(2);
    expect(s.history.map(h => h.id)).toEqual(['B', 'A']);
  });

  it('throws on empty history', () => {
    expect(() => rewind(emptyState())).toThrow(/no past sessions/);
  });

  it('throws on out-of-range index', () => {
    let s = emptyState();
    s = recordSession(s, 'A');
    expect(() => rewind(s, 5)).toThrow(/no such session/i);
  });

  it('throws on prefix that matches nothing', () => {
    let s = emptyState();
    s = recordSession(s, 'A');
    expect(() => rewind(s, 'zzz')).toThrow(/no past session/i);
  });

  it('throws on ambiguous prefix', () => {
    let s = emptyState();
    s = recordSession(s, 'aaa-1');
    s = recordSession(s, 'aaa-2');
    expect(() => rewind(s, 'aaa')).toThrow(/ambiguous/i);
  });
});

describe('persona-state — listHistory (the /egpt list subcommand)', () => {
  it('marks the active session', () => {
    let s = emptyState();
    s = recordSession(s, 'A');
    s = recordSession(s, 'B');
    const list = listHistory(s);
    expect(list[0]).toMatchObject({ id: 'B', isActive: true,  index: 0 });
    expect(list[1]).toMatchObject({ id: 'A', isActive: false, index: 1 });
  });

  it('after /egpt new no entry is active, but history is preserved', () => {
    let s = emptyState();
    s = recordSession(s, 'A');
    s = startNew(s);
    const list = listHistory(s);
    expect(list).toHaveLength(1);
    expect(list[0].isActive).toBe(false);
  });

  it('exposes a short id (first 8 chars) for compact display', () => {
    let s = emptyState();
    s = recordSession(s, '12345678abcdef');
    expect(listHistory(s)[0].short).toBe('12345678');
  });

  it('empty state lists nothing', () => {
    expect(listHistory(emptyState())).toEqual([]);
  });
});

describe('persona-state — summarize (the /egpt status subcommand)', () => {
  it('reports brain type, active short-id, and history count', () => {
    let s = emptyState({ type: 'ccode' });
    s = recordSession(s, '12345678abcdef');
    const sum = summarize(s);
    expect(sum.type).toBe('ccode');
    expect(sum.activeShort).toBe('12345678');
    expect(sum.activeFull).toBe('12345678abcdef');
    expect(sum.historyCount).toBe(1);
  });

  it('signals "no active session" clearly when session_id is null', () => {
    const sum = summarize(emptyState());
    expect(sum.activeShort).toMatch(/none/i);
    expect(sum.activeFull).toBe(null);
  });
});

describe('persona-state — URL-based brains (chatgpt-cdp, claude-cdp)', () => {
  it('isUrlBrain identifies URL-keyed brain types', async () => {
    const { isUrlBrain } = await import('../src/persona-state.mjs');
    expect(isUrlBrain('chatgpt-cdp')).toBe(true);
    expect(isUrlBrain('claude-cdp')).toBe(true);
    expect(isUrlBrain('claude-code')).toBe(false);
    expect(isUrlBrain('codex')).toBe(false);
    expect(isUrlBrain('ccode')).toBe(false);
  });

  it('recordSession stores ref as url (not session_id) when the type is a URL brain', () => {
    const s = recordSession(emptyState({ type: 'chatgpt-cdp' }), 'https://chatgpt.com/c/abc');
    expect(s.url).toBe('https://chatgpt.com/c/abc');
    expect(s.session_id).toBe(null);
    expect(s.history[0]).toMatchObject({ url: 'https://chatgpt.com/c/abc', type: 'chatgpt-cdp' });
    expect(s.history[0].id).toBeUndefined();
  });

  it('summarize for a URL brain exposes the full URL as activeFull and short-truncates at 50', () => {
    let s = recordSession(emptyState({ type: 'chatgpt-cdp' }), 'https://chatgpt.com/c/' + 'x'.repeat(60));
    const sum = summarize(s);
    expect(sum.type).toBe('chatgpt-cdp');
    expect(sum.activeKind).toBe('url');
    expect(sum.activeFull.length).toBe('https://chatgpt.com/c/'.length + 60);
    expect(sum.activeShort.length).toBeLessThanOrEqual(50);
    expect(sum.activeShort.endsWith('…')).toBe(true);
  });

  it('listHistory exposes url + kind for URL entries', () => {
    let s = emptyState({ type: 'chatgpt-cdp' });
    s = recordSession(s, 'https://chatgpt.com/c/abc');
    s = recordSession(s, 'https://chatgpt.com/c/def');
    const list = listHistory(s);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ url: 'https://chatgpt.com/c/def', kind: 'url' });
    expect(list[1]).toMatchObject({ url: 'https://chatgpt.com/c/abc', kind: 'url' });
    expect(list[0].isActive).toBe(true);
  });

  it('rewind by URL prefix selects the right entry', () => {
    let s = emptyState({ type: 'chatgpt-cdp' });
    s = recordSession(s, 'https://chatgpt.com/c/aaa');
    s = recordSession(s, 'https://chatgpt.com/c/bbb');
    s = startNew(s);
    const after = rewind(s, 'https://chatgpt.com/c/a');
    expect(after.url).toBe('https://chatgpt.com/c/aaa');
    expect(after.session_id).toBe(null);
  });

  it('startNew clears both session_id and url', () => {
    let s = recordSession(emptyState({ type: 'chatgpt-cdp' }), 'https://chatgpt.com/c/x');
    s = startNew(s);
    expect(s.session_id).toBe(null);
    expect(s.url).toBe(null);
    expect(s.history).toHaveLength(1);   // history retained
  });
});

describe('persona-state — setBrain', () => {
  it('switches brain type without a ref, clears active, preserves history', async () => {
    const { setBrain } = await import('../src/persona-state.mjs');
    let s = recordSession(emptyState(), 'sess-1');
    expect(s.session_id).toBe('sess-1');
    s = setBrain(s, 'chatgpt-cdp');
    expect(s.type).toBe('chatgpt-cdp');
    expect(s.session_id).toBe(null);
    expect(s.url).toBe(null);
    expect(s.history).toHaveLength(1);
  });

  it('switches brain type WITH a ref records it as url for URL brains', async () => {
    const { setBrain } = await import('../src/persona-state.mjs');
    let s = emptyState();
    s = setBrain(s, 'chatgpt-cdp', 'https://chatgpt.com/c/abc');
    expect(s.type).toBe('chatgpt-cdp');
    expect(s.url).toBe('https://chatgpt.com/c/abc');
    expect(s.session_id).toBe(null);
    expect(s.history[0].url).toBe('https://chatgpt.com/c/abc');
  });

  it('switches brain type WITH a ref records it as session_id for CLI brains', async () => {
    const { setBrain } = await import('../src/persona-state.mjs');
    let s = emptyState();
    s = setBrain(s, 'ccode', 'session-abc');
    expect(s.type).toBe('ccode');
    expect(s.session_id).toBe('session-abc');
    expect(s.url).toBe(null);
  });

  it('no-op when type is empty', async () => {
    const { setBrain } = await import('../src/persona-state.mjs');
    const before = recordSession(emptyState(), 'sess-1');
    const after = setBrain(before, null);
    expect(after).toEqual(before);
  });
});

describe('persona-state — backward compat with existing default_brain configs', () => {
  it('a config with session_id but no history reads cleanly (history defaults to [])', () => {
    // Mimics the current shape on disk: { type, session_id } — no history yet.
    const onDisk = { type: 'ccode', session_id: 'X' };
    // The shell wraps the disk value into a state by spreading + filling defaults.
    const state = { ...emptyState({ type: onDisk.type }), session_id: onDisk.session_id };
    expect(state.history).toEqual([]);
    // First @egpt after upgrade: brain returns the same session_id (resumed),
    // recordSession backfills history.
    const after = recordSession(state, 'X', { type: 'ccode' });
    expect(after.history).toHaveLength(1);
    expect(after.history[0].id).toBe('X');
    expect(after.session_id).toBe('X');
  });
});
