// exec-policy.mjs — Route B security policy (operator 2026-06-16): conversation-e
// may EXECUTE a small allowlist of vetted, IMMUTABLE binaries (the chroot's
// read-only /bin) with raw args — "all powerful, but can't destroy itself or the
// host."
//
// MODEL (operator-chosen): raw binary + ARG VALIDATION, run via `execFile` —
// NEVER a shell. No shell means `;`, `&&`, `|`, `$()`, backticks, globbing are
// impossible by construction; an arg is one literal token. The boundary is then:
//   1. binary on the allowlist (and nothing else — no arbitrary exe, no interpreters);
//   2. every FILE-PATH arg resolves INSIDE the chat's sandbox dir (no absolute
//      path outside it, no `..` escape) — so a binary can't read/write the host;
//   3. URL args allowed ONLY for binaries declared `net` (yt-dlp/curl/wget), and
//      their OUTPUT paths are still sandbox-pinned (download in, never exfil out);
//   4. a per-binary DENY list of flags/values that escape the model (protocol
//      readers, alternate output sinks, config-file injection, local-file reads).
//
// ⚠️ HONEST LIMITATION — read before wiring this live. Arg-validation is
// best-effort, NOT a true sandbox. ffmpeg/curl/yt-dlp have a large surface; a flag
// we didn't deny could still escape (e.g. an ffmpeg protocol/muxer trick, a curl
// config file). For a fully PUBLIC deployment this MUST run under OS-level
// isolation (Windows Job Object + restricted token, or a container with only the
// chat's media/ bind-mounted, network off except for `net` binaries). This module
// is the FIRST layer, not the last. It ships DORMANT (nothing calls runExec yet);
// wiring it to E is a separate, reviewed step.
//
// Pure validation + a thin execFile runner. No global state.

import { execFile } from 'node:child_process';
import { resolve, isAbsolute, relative, sep } from 'node:path';

// kind: 'file' = operates on local files only (all paths sandbox-pinned, no URLs);
//       'net'  = may take a URL input (download), output still sandbox-pinned.
export const ALLOWED_BINARIES = {
  ffmpeg:    { kind: 'file', denyFlags: ['-f'], denyValuePatterns: [/^\w+:\/\//i, /^concat:/i, /^file:/i, /^pipe:/i, /^lavfi$/i] },
  ffprobe:   { kind: 'file', denyValuePatterns: [/^\w+:\/\//i, /^file:/i, /^pipe:/i] },
  magick:    { kind: 'file', denyValuePatterns: [/^\w+:\/\//i, /^https?:/i] },
  pdftotext: { kind: 'file' },
  pdfinfo:   { kind: 'file' },
  pandoc:    { kind: 'file' },
  jq:        { kind: 'file' },
  qrencode:  { kind: 'file' },
  zbarimg:   { kind: 'file' },
  // network tools — URL input allowed; outputs must stay in the sandbox. Deny the
  // flags that read local files / load configs / write outside the output arg.
  'yt-dlp':  { kind: 'net', denyFlags: ['--exec', '--config-location', '--batch-file', '-a'] },
  curl:      { kind: 'net', denyFlags: ['-K', '--config', '-T', '--upload-file', '--cookie-jar'] },
  wget:      { kind: 'net', denyFlags: ['--config', '-i', '--input-file', '--use-askpass'] },
};

function isUrl(s) { return /^https?:\/\//i.test(String(s)); }
function looksLikePath(s) {
  const t = String(s);
  if (t.startsWith('-')) return false;           // a flag, not a path
  if (isUrl(t)) return false;                    // a URL (handled separately)
  return /[\\/]/.test(t) || /\.[A-Za-z0-9]{1,5}$/.test(t);   // has a separator or a file-ish extension
}

// True iff `p` resolves to a location at/under `sandboxDir`.
export function isInsideSandbox(p, sandboxDir) {
  if (!sandboxDir) return false;
  const root = resolve(sandboxDir);
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p);
  const rel = relative(root, abs);
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}

/**
 * Validate a Route B exec request. Returns { ok:true } or { ok:false, reason }.
 * `sandboxDir` is the chat's own folder — the only place file args may point.
 */
export function validateExec(binary, args = [], { sandboxDir } = {}) {
  const spec = ALLOWED_BINARIES[binary];
  if (!spec) return { ok: false, reason: `binary not allow-listed: ${binary}` };
  if (!sandboxDir) return { ok: false, reason: 'no sandboxDir' };
  if (!Array.isArray(args)) return { ok: false, reason: 'args must be an array (execFile, never a shell string)' };
  for (const raw of args) {
    const a = String(raw);
    if (a.includes('\0')) return { ok: false, reason: 'null byte in arg' };
    if (a.startsWith('-')) {
      if ((spec.denyFlags ?? []).some((f) => a === f || a.startsWith(f + '='))) {
        return { ok: false, reason: `denied flag for ${binary}: ${a}` };
      }
      continue;
    }
    if (isUrl(a)) {
      if (spec.kind !== 'net') return { ok: false, reason: `${binary} may not take a URL: ${a}` };
      continue;   // URL input allowed for net binaries
    }
    if ((spec.denyValuePatterns ?? []).some((re) => re.test(a))) {
      return { ok: false, reason: `denied value pattern for ${binary}: ${a}` };
    }
    if (looksLikePath(a) && !isInsideSandbox(a, sandboxDir)) {
      return { ok: false, reason: `path escapes sandbox: ${a}` };
    }
  }
  return { ok: true };
}

/**
 * Run a validated Route B command via execFile (NO shell). Throws on a policy
 * rejection BEFORE spawning. Bounded by timeout + maxBuffer. The runner pins cwd
 * to the sandbox so relative paths resolve there.
 */
export function runExec(binary, args = [], { sandboxDir, timeoutMs = 60_000, maxBuffer = 8 * 1024 * 1024 } = {}) {
  const verdict = validateExec(binary, args, { sandboxDir });
  if (!verdict.ok) return Promise.reject(new Error(`exec-policy: ${verdict.reason}`));
  return new Promise((res, rej) => {
    execFile(binary, args.map(String), { cwd: resolve(sandboxDir), timeout: timeoutMs, maxBuffer, windowsHide: true, shell: false },
      (err, stdout, stderr) => err ? rej(Object.assign(err, { stderr })) : res({ stdout, stderr }));
  });
}
