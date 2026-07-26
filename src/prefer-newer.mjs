// prefer-newer.mjs — THE rule for every file the spine seeds into the profile
// (operator 2026-07-26, after hitting the staleness trap a fourth time).
//
// seed.mjs plants its files COPY-IF-MISSING, so once a profile has a copy nothing can
// ever change it: an upgraded shipped file is skipped by the seeder and ignored by a
// reader that prefers the profile. `git log` says current while the file in effect is not.
//
// So a reader does not pick a SIDE, it picks the NEWER of the two copies: a `git pull`
// restamps the shipped file's mtime, so an upgrade lands; an operator editing their
// profile copy afterwards makes theirs newer again, so the edit stays sacred. No config
// knob. First applied per-file to the room template (0b03dc9); this is that same logic,
// extracted so every seeded file resolves the same way.
import { existsSync, statSync } from 'node:fs';

// An unreadable stat sorts OLDEST, so a resolvable copy always beats an unresolvable one
// and two unresolvable ones fall back to the profile (the historical preference).
const defaultMtimeOf = (p) => { try { return statSync(p).mtimeMs; } catch { return 0; } };

// The copy of a seeded file that is in effect: whichever of {profile, shipped} has the
// NEWER mtime. Only one existing is used outright; neither existing → null. Never throws.
// `exists`/`mtimeOf` are injectable for callers whose fs is already a test seam.
export function preferNewer(profilePath, shippedPath, { exists = existsSync, mtimeOf = defaultMtimeOf } = {}) {
  const hasProfile = exists(profilePath);
  const hasShipped = exists(shippedPath);
  if (!hasProfile) return hasShipped ? shippedPath : null;
  if (!hasShipped) return profilePath;
  return mtimeOf(shippedPath) > mtimeOf(profilePath) ? shippedPath : profilePath;
}
