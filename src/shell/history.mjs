// src/shell/history.mjs — pure input-history buffer (shell-style ↑/↓ recall).
//
// State shape: { entries: string[], cursor: number | null, draft: string }
//   entries — submitted lines, oldest first.
//   cursor  — index into entries currently shown, or null when not navigating (viewing the
//             live composer, not a recalled entry).
//   draft   — the composer text captured the moment ↑ first starts navigating; ↓ walking
//             past the newest entry restores it — standard shell-history behavior.
//
// The Ink view (src/shell/app.mjs) only calls up()/down() when the multi-line cursor is
// already at the composer's top/bottom row (input.mjs's edit.up/edit.down return the SAME
// state object at that boundary — checked by reference) so history recall never fights
// in-text cursor movement on a multi-line draft.

// Fresh empty history buffer.
export function empty() { return { entries: [], cursor: null, draft: '' }; }

// Record a submitted line. Ends any in-progress navigation.
export function push(state, line) {
  return { entries: [...state.entries, line], cursor: null, draft: '' };
}

// Walk back one entry (older). `current` is the live composer text — captured as the draft
// only the first time navigation starts. Returns null (no-op) when there's no history or
// already at the oldest entry.
export function up(state, current) {
  const { entries, cursor } = state;
  if (entries.length === 0) return null;
  if (cursor === null) {
    const next = entries.length - 1;
    return { state: { entries, cursor: next, draft: current }, text: entries[next] };
  }
  if (cursor === 0) return null;
  const next = cursor - 1;
  return { state: { ...state, cursor: next }, text: entries[next] };
}

// Walk forward one entry (newer); past the newest, restores the pre-navigation draft.
// Returns null (no-op) when not currently navigating.
export function down(state) {
  const { entries, cursor, draft } = state;
  if (cursor === null) return null;
  if (cursor >= entries.length - 1) return { state: { entries, cursor: null, draft: '' }, text: draft };
  const next = cursor + 1;
  return { state: { ...state, cursor: next }, text: entries[next] };
}
