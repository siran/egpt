// persona-state.mjs — pure-function manipulation of the @egpt persona's
// session-history state.
//
// Backed on disk by ~/.egpt/config.json default_brain.{type, session_id, url, history}.
// Each function returns a new state — never mutates input. The shell handler
// (/egpt new|status|rewind|list|brain) is a thin wrapper that loads disk →
// applies a function → persists back.
//
// The "active ref" is what gets passed to the brain on the next @egpt turn.
// Two flavors of ref exist because the brain ecosystem has two flavors:
//   - CLI brains (claude-code, codex, ccode) want a session_id — passed
//     as --resume so the brain reloads its persistent state.
//   - URL brains (chatgpt-cdp, claude-cdp) want a URL — the shell finds
//     or opens a tab at that URL, then drives it via CDP. The URL IS the
//     thread (chatgpt persists it server-side at /c/<uuid>).
// At any time at most ONE of session_id / url is set on the active state.
// History entries also carry one or the other so rewind works on both.

export const HISTORY_CAP = 20;

// Brain types that key their persistent thread by URL rather than by a
// stdout-emitted session_id. Anything outside this set is treated as a
// CLI brain whose ref is a session_id.
const URL_BRAIN_TYPES = new Set(['chatgpt-cdp', 'claude-cdp']);
export function isUrlBrain(type) { return URL_BRAIN_TYPES.has(String(type)); }

export function emptyState({ type = 'claude-code' } = {}) {
  return { type, session_id: null, url: null, history: [] };
}

// Set the active ref + record it in history. Auto-infers whether the
// ref is a URL (for URL brains) or a session_id, based on the supplied
// `type` (or the current state.type when type isn't overridden).
//   recordSession(s, 'abc-123')                              → session_id 'abc-123'
//   recordSession(s, 'https://chatgpt.com/c/x', { type:'chatgpt-cdp' }) → url
// History entries carry { type, at } plus exactly one of { id } or { url }.
// Backwards-compat history entries from before this version still have
// { id, type, at } — rewind/list handle both shapes.
export function recordSession(state, ref, { type = state.type, at = Date.now() } = {}) {
  if (!ref) return state;
  const useUrl = isUrlBrain(type);
  const cleanState = { ...state, type, session_id: null, url: null };
  cleanState[useUrl ? 'url' : 'session_id'] = ref;
  // Dedupe: drop any prior entry whose id OR url matches the new ref
  const stripped = (state.history ?? []).filter(h => h.id !== ref && h.url !== ref);
  const entry = useUrl ? { url: ref, type, at } : { id: ref, type, at };
  cleanState.history = [entry, ...stripped].slice(0, HISTORY_CAP);
  return cleanState;
}

// /egpt new — clears the active ref; history stays so the user can rewind.
export function startNew(state) {
  if (!state.session_id && !state.url) return state;
  return { ...state, session_id: null, url: null };
}

// /egpt brain <type> [<ref>] — switch the persona to a different brain
// without clearing history. When ref is given it becomes the active ref
// (recorded to history too); when omitted, active goes to null so the
// next @e starts a fresh thread on the new brain.
export function setBrain(state, newType, ref = null) {
  if (!newType) return state;
  const cleared = { ...state, type: newType, session_id: null, url: null };
  if (!ref) return cleared;
  return recordSession(cleared, ref, { type: newType });
}

// /egpt rewind — set active to a past entry (by index or id/url prefix).
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
    const matches = history.filter(h => (h.id ?? h.url ?? '').startsWith(key));
    if (!matches.length) throw new Error(`no past session matches "${key}"`);
    if (matches.length > 1) {
      throw new Error(`ambiguous prefix "${key}" matches ${matches.length} sessions`);
    }
    entry = matches[0];
  }
  const next = { ...state, type: entry.type ?? state.type, session_id: null, url: null };
  if (entry.url) next.url = entry.url;
  else if (entry.id) next.session_id = entry.id;
  return next;
}

// Compact, kind-aware preview of a ref. session_id → 8-char prefix
// (UUIDs are roomy enough to disambiguate at 8 chars); URL → 50-char
// trimmed to keep table-style listings readable.
function shortRef(ref, isUrl) {
  if (!ref) return '';
  if (isUrl) return ref.length > 50 ? ref.slice(0, 47) + '…' : ref;
  return ref.slice(0, 8);
}

// /egpt list — per-entry view object suitable for printing.
export function listHistory(state) {
  const history = state.history ?? [];
  const activeRef = state.session_id ?? state.url ?? null;
  return history.map((h, i) => {
    const ref = h.id ?? h.url ?? '';
    const isUrl = !!h.url;
    return {
      index: i,
      ref,
      // Keep `id` as a legacy alias for callers that haven't migrated.
      id:    h.id ?? null,
      url:   h.url ?? null,
      short: shortRef(ref, isUrl),
      type:  h.type,
      kind:  isUrl ? 'url' : 'session_id',
      at:    h.at,
      isActive: ref === activeRef && !!activeRef,
    };
  });
}

// /egpt status — single summary object for terse one-line output.
export function summarize(state) {
  const { type, session_id, url, history = [] } = state;
  const activeRef = url ?? session_id ?? null;
  const isUrl = !!url;
  return {
    type,
    activeShort: activeRef ? shortRef(activeRef, isUrl) : '(none — next @egpt starts fresh)',
    activeFull:  activeRef,
    activeKind:  url ? 'url' : (session_id ? 'session_id' : null),
    historyCount: history.length,
  };
}
