// announced-modes.mjs — persist "which reply-mode note was last shown to E per
// chat" across restarts.
//
// The mode note ("(Chat reply mode: mention. …)") is injected into E's prompt
// ONLY when the chat's mode CHANGES — "E remembers; just say it per change of
// mode" (operator). The tracking Map used to be in-memory only, so EVERY daemon
// restart re-announced the mode on the next message in each chat (and in dev we
// restart constantly) — spamming the prompt + transcript with a note for a mode
// that never changed (operator 2026-06-16). E also resumes its thread across a
// restart (`--resume`), so it already knows the mode; re-announcing is pure noise.
//
// Persisting the announced-mode map fixes it: a restart reloads the prior state,
// so the note shows only on a genuine mode change (or first contact). Sync IO —
// loaded once at boot, written on the rare mode-change announce. Best-effort:
// never throws (a missing/corrupt file just starts empty).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Load the persisted chatId→mode map (empty Map on absent/corrupt file). */
export function loadAnnouncedModes(path) {
  try {
    const obj = JSON.parse(readFileSync(path, 'utf8'));
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return new Map(Object.entries(obj));
  } catch { /* absent / corrupt → empty */ }
  return new Map();
}

/** Persist the chatId→mode map (best-effort; never throws). */
export function saveAnnouncedModes(path, map) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(Object.fromEntries(map ?? new Map())), 'utf8');
  } catch { /* best-effort */ }
}
