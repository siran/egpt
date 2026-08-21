// src/shell/auth.mjs — the ONE definition of the shell socket's authentication.
//
// WHY THIS EXISTS (operator 2026-08-21). The shell socket used to trust the LOOPBACK
// itself: shell-port dialled ws://127.0.0.1:23375 and treated whatever answered as the
// operator's editor — a PARTICIPANT with `authorized: true`, i.e. a peer allowed to run
// `/upgrade` (git pull + npm install, unsandboxed). Windows has no per-user loopback
// namespace and does not firewall loopback, so the sandboxed CLI accounts (egpt-sbx-NN)
// can bind and dial 127.0.0.1 freely — and 23375 is USUALLY UNBOUND (the editor is only
// open when the operator has it open; that is the ECONNREFUSED reconnect loop in the
// daemon log). A sandboxed process could therefore bind the port, wait for the spine to
// dial OUT to it, and speak as the operator. Loopback is NOT an authenticator here.
//
// THE FIX, and the reason it lives in ONE module: the SERVER proves it holds the shared
// secret before the CLIENT trusts it. Both ends need the identical algorithm, so the
// wire frames, the MAC and the comparison are defined here exactly once and imported by
// both src/bridges/shell-port.mjs (the spine's limb, which challenges) and
// src/shell/server.mjs (the editor, which answers). No second implementation.
//
// SHAPE — nonce challenge-response, so the secret never rides the wire and a captured
// answer cannot be replayed onto a later connection:
//   spine  → editor : { auth: 'challenge', nonce }      (fresh 32 random bytes per socket)
//   editor → spine  : { auth: 'response',  mac }        mac = HMAC-SHA256(token, nonce)
// The spine compares with crypto.timingSafeEqual and sends/accepts NOTHING until it
// matches. The topology is unchanged (plans/2607191835-SHELL-LIMB-S1-PLAN.md §1: the
// editor serves, the spine dials — "Close it → spine lives").
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// The one operator-facing instruction, appended to whichever end had to refuse. FAIL
// CLOSED is deliberate (no auto-generated secret, no unauthenticated fallback): the
// operator adds this value by hand, to a file only the operator's account can write.
export const SHELL_TOKEN_HELP =
  'add a shared secret to ~/.egpt/config/config.yaml as `shell:` / `  token: <32+ random chars>`, then restart the spine AND the editor';

// WHERE THE SECRET LIVES — read from the node config, the same place beeper.main.token and
// the transcription/voice tokens live. Pure: the CALLER supplies the already-read config
// (boot has it as `cfg`; the editor reads it with readConfigSync), so neither the limb nor
// this module ever touches the filesystem.
export function shellTokenFrom(cfg) {
  const t = cfg?.shell?.token;
  return typeof t === 'string' ? t.trim() : '';
}

// A fresh per-connection nonce: 32 random bytes, hex. Fresh per SOCKET is what makes a
// recorded response useless on the next connection.
export function newNonce() { return randomBytes(32).toString('hex'); }

// The proof. Domain-separated so a token shared with some other HMAC use cannot be
// cross-protocol replayed into this one.
export function authMac(token, nonce) {
  return createHmac('sha256', String(token ?? '')).update(`egpt-shell:${String(nonce ?? '')}`).digest('hex');
}

// The two wire frames — built here so the shapes exist in ONE place, not two.
export function challengeFrame(nonce) { return JSON.stringify({ auth: 'challenge', nonce }); }
export function responseFrame(token, nonce) { return JSON.stringify({ auth: 'response', mac: authMac(token, nonce) }); }

// Is this raw frame an AUTH frame? Returns the normalized frame, or null for anything else
// (a message frame, a bare text line, garbage). Both ends call this FIRST so an auth frame
// is never mistaken for transcript text.
export function parseAuthFrame(raw) {
  const s = (typeof raw === 'string') ? raw : (raw?.toString?.() ?? '');
  try {
    const j = JSON.parse(s);
    if (j && typeof j === 'object' && (j.auth === 'challenge' || j.auth === 'response')) {
      return { auth: j.auth, nonce: typeof j.nonce === 'string' ? j.nonce : '', mac: typeof j.mac === 'string' ? j.mac : '' };
    }
  } catch { /* not JSON → not an auth frame */ }
  return null;
}

// Constant-time compare of two hex MACs. The length check leaks only the length (both are
// fixed-width sha256 hex); the bytes themselves are compared with timingSafeEqual, never
// with === (which returns early on the first differing byte).
export function macMatches(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (ba.length === 0 || ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
