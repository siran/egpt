// tools/bus-sign.mjs — HMAC-SHA256 signing/verification for bus events.
//
// Phase 1 of bus security: prevent FORGERY. Any peer with the shared
// key can sign + verify; observers without the key can still read
// event bodies (this module does NOT encrypt — that's phase 2). The
// guarantee here is "the event came from someone who holds the key,
// and the body wasn't tampered with after signing."
//
// Threat addressed: a third party (other extension, dev-tools poke,
// random script that gained access to /json/list) injects a forged
// event like:
//   { type: 'mention', target: 'e', body: '<malicious instructions>' }
// Without the key they can't compute a valid _sig; receivers reject.
//
// Envelope shape (added by signEvent, stripped before verify):
//   _sig    base64url HMAC-SHA256 over canonical JSON of the event
//           with these two fields removed
//   _sig_v  signature scheme version (1 today; bump when shape changes)
//
// Canonicalization: sorted-keys recursive JSON.stringify so equivalent
// objects produce byte-identical input regardless of insertion order.
// Without this, two peers might sign equivalent events that hash
// differently and reject each other.
//
// Web Crypto API works in both contexts:
//   - browser / extension:   globalThis.crypto.subtle  (always present)
//   - Node 19+ / current:    globalThis.crypto.subtle  (exposed since 19)

const SIG_VERSION = 1;
const HMAC_ALGO = { name: 'HMAC', hash: 'SHA-256' };
const _enc = new TextEncoder();

// ── canonical JSON ────────────────────────────────────────────────

export function canonicalize(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out = {};
  for (const k of Object.keys(value).sort()) {
    out[k] = canonicalize(value[k]);
  }
  return out;
}

export function canonicalString(value) {
  return JSON.stringify(canonicalize(value));
}

// ── base64url ─────────────────────────────────────────────────────
// Browser/extension has btoa/atob; Node 18+ has them globally too.
// We only encode/decode small byte arrays (32-byte keys, 32-byte sigs).

function bytesToBase64Url(bytes) {
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64UrlToBytes(s) {
  if (typeof s !== 'string') throw new Error('base64UrlToBytes: not a string');
  let p = s.replace(/-/g, '+').replace(/_/g, '/');
  while (p.length % 4) p += '=';
  const str = atob(p);
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
  return bytes;
}

export function keyToString(bytes) { return bytesToBase64Url(bytes); }
export function keyFromString(s)   { return base64UrlToBytes(s); }

// ── key generation ────────────────────────────────────────────────

// Generates a 256-bit random key. Returned as base64url so it can be
// stored in chrome.storage / env vars / config files as a single
// printable string.
export async function generateKey() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return keyToString(bytes);
}

async function _importKey(keyBytes) {
  if (!(keyBytes instanceof Uint8Array)) {
    throw new Error('importKey: keyBytes must be Uint8Array (use keyFromString first)');
  }
  return globalThis.crypto.subtle.importKey('raw', keyBytes, HMAC_ALGO, false, ['sign', 'verify']);
}

// ── sign / verify ─────────────────────────────────────────────────

// Returns a NEW event object with _sig + _sig_v added. Strips any
// pre-existing _sig fields before signing so we don't compound them
// across resends.
export async function signEvent(event, keyBytes) {
  const ck = await _importKey(keyBytes);
  const { _sig: _drop1, _sig_v: _drop2, ...payload } = event ?? {};
  const data = _enc.encode(canonicalString(payload));
  const sig = await globalThis.crypto.subtle.sign('HMAC', ck, data);
  return { ...payload, _sig: bytesToBase64Url(new Uint8Array(sig)), _sig_v: SIG_VERSION };
}

// Returns one of:
//   'valid'   — _sig present and matches
//   'invalid' — _sig present but doesn't match (forgery / tampering)
//   'missing' — no _sig field on the event
//
// 'missing' lets callers decide whether to reject (strict) or allow
// (permissive — useful during phased rollout when peers may not yet
// be signing).
export async function verifyEvent(event, keyBytes) {
  if (!event || typeof event !== 'object') return 'missing';
  if (typeof event._sig !== 'string') return 'missing';
  const { _sig, _sig_v: _drop, ...payload } = event;
  const data = _enc.encode(canonicalString(payload));
  let sigBytes;
  try { sigBytes = base64UrlToBytes(_sig); }
  catch { return 'invalid'; }
  const ck = await _importKey(keyBytes);
  const ok = await globalThis.crypto.subtle.verify('HMAC', ck, sigBytes, data);
  return ok ? 'valid' : 'invalid';
}
