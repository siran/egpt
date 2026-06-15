// src/config-validate.mjs — cheap boot-time WIRING checks that turn a silent
// runtime failure into a loud, actionable boot warning.
//
// Born from a real bug (operator 2026-06-14): a being's `cwd` got mangled in
// DOLLY's config.yaml — `"C:\Users\an\src\egpt"` written DOUBLE-QUOTED in YAML
// became `C:Usersansrcegpt`, because `\U \a \s \e` are (invalid) YAML escape
// sequences that get eaten. That non-existent dir made every Don turn spawn the
// engine with an invalid cwd and die with a CRYPTIC `spawn <claude> ENOENT` —
// Node names the command, not the missing cwd, so it read as "claude not found"
// and sent us chasing PATH/binary ghosts for hours. A one-line existsSync check
// at boot would have said exactly what was wrong.
//
// Pure + dependency-light: `exists` is injectable so the logic is unit-tested
// without touching the filesystem.

import { existsSync } from 'node:fs';

// MSYS2/Cygwin "/c/Users/.." → "C:/Users/.." (mirror of warm-cli's normalizeCwd)
// so an msys-form cwd isn't false-flagged as missing.
function normalizeCwd(p) {
  if (!p) return p;
  const m = String(p).match(/^\/([a-zA-Z])\/(.*)$/);
  return m ? `${m[1].toUpperCase()}:/${m[2]}` : p;
}

// Return [{ name, cwd }] for every sibling whose `cwd` is set but does NOT exist
// on disk. Empty array = all wired cwds are reachable.
export function findUnreachableSiblingCwds(config, exists = existsSync) {
  const out = [];
  const sibs = (config && typeof config.siblings === 'object' && config.siblings) || {};
  for (const [name, e] of Object.entries(sibs)) {
    if (!e || typeof e !== 'object') continue;
    if (typeof e.cwd !== 'string' || !e.cwd.trim()) continue;
    if (!exists(normalizeCwd(e.cwd))) out.push({ name, cwd: e.cwd });
  }
  return out;
}

// Human-readable, actionable warning lines for each unreachable cwd. The message
// names the LIKELY cause (YAML backslash mangling) + the fix (forward slashes),
// because that's the trap that produced the bug.
export function configWarnings(config, exists = existsSync) {
  return findUnreachableSiblingCwds(config, exists).map(({ name, cwd }) =>
    `!! CONFIG: sibling "${name}" cwd does not exist: ${JSON.stringify(cwd)} — its turns will fail with a misleading "spawn … ENOENT". ` +
    `Fix siblings.${name}.cwd (use forward slashes, e.g. C:/Users/you/src/egpt; a double-quoted backslash path gets mangled by YAML).`);
}
