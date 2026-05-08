// persona-state.mjs — pure-function manipulation of the @egpt persona's
// session-history state.
//
// Backed on disk by ~/.egpt/config.json default_brain.{type, session_id, history}.
// Each function returns a new state — never mutates input. The shell handler
// (/egpt new|status|rewind|list) is a thin wrapper that loads disk → applies
// a function → persists back.
//
// The "active session_id" is what gets passed as --resume to the brain on the
// next @egpt turn. The "history" is the recently-seen ids (newest first,
// capped) so the user can rewind to a past thread without remembering ids.

export const HISTORY_CAP = 20;

export function emptyState({ type = 'claude-code' } = {}) {
  return { type, session_id: null, history: [] };
}

// Record a session as active. If id is already in history it moves to the
// top (and refreshes its timestamp); otherwise it's prepended. History is
// capped — oldest entries fall off. null/empty id is a no-op.
export function recordSession(state, id, { type = state.type, at = Date.now() } = {}) {
  if (!id) return state;
  const stripped = (state.history ?? []).filter(h => h.id !== id);
  const next = [{ id, type, at }, ...stripped].slice(0, HISTORY_CAP);
  return { ...state, type, session_id: id, history: next };
}

// /egpt new — clears the active session_id; history stays so the user can
// rewind back. No-op (returns identity) when there's nothing to clear.
export function startNew(state) {
  if (!state.session_id) return state;
  return { ...state, session_id: null };
}

// /egpt rewind — set active to a past session, by index (default 0 = most-
// recent past entry in history) or by id-prefix. Throws when there's
// nothing to rewind to, or when the prefix doesn't disambiguate.
export function rewind(state, target = 0) {
  const history = state.history ?? [];
  if (!history.length) throw new Error('no past sessions to rewind to');
  let entry;
  if (typeof target === 'number') {
    if (target < 0 || target >= history.length) {
      throw new Error(`no such session #${target} (history has ${history.length})`);
    }
    entry = history[target];
  } else {
    const key = String(target);
    const matches = history.filter(h => h.id.startsWith(key));
    if (!matches.length) throw new Error(`no past session id starts with "${key}"`);
    if (matches.length > 1) {
      throw new Error(`ambiguous prefix "${key}" matches ${matches.length} sessions`);
    }
    entry = matches[0];
  }
  return { ...state, session_id: entry.id, type: entry.type ?? state.type };
}

// /egpt list — return per-entry view objects suitable for printing.
export function listHistory(state) {
  const history = state.history ?? [];
  const active = state.session_id;
  return history.map((h, i) => ({
    index: i,
    id: h.id,
    short: h.id.slice(0, 8),
    type: h.type,
    at: h.at,
    isActive: h.id === active,
  }));
}

// /egpt status — single summary object for terse one-line output.
export function summarize(state) {
  const { type, session_id, history = [] } = state;
  return {
    type,
    activeShort: session_id ? session_id.slice(0, 8) : '(none — next @egpt starts fresh)',
    activeFull:  session_id ?? null,
    historyCount: history.length,
  };
}
