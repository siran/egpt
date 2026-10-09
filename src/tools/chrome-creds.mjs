// tools/chrome-creds.mjs — read the brain Chrome profile's OWN saved login for a domain.
//
// Approach (2) of the auto-login limb (plan plans/2610082200-EGPT-LOGIN-PLAN.md): approach (ii)
// "ride Chrome's own autofill" proved impossible (no CDP command triggers Chrome's saved-password
// autofill, and a CDP click does not fill it), so the spine reads Chrome's own saved password the
// way Chrome stores it and types it. This module does ONLY the read + decrypt; login.mjs types the
// result through cdp.fill and nulls it. NOTHING here is logged, returned to a being, or posted.
//
// THE FOUR STEPS (validated live against the operator's ClassDojo store):
//   1. <profile>/Local State → os_crypt.encrypted_key (base64). Decode; strip a leading ascii
//      "DPAPI" (5 bytes) if present.
//   2. DPAPI-Unprotect that blob (CurrentUser) via PowerShell → the 32-byte AES-256-GCM key. The PS
//      command embeds only the ENCRYPTED key blob — NEVER a password. Add-Type is required on
//      Windows PowerShell 5.1.
//   3. Copy <profile>/Default/Login Data to a temp file (Chrome locks the live one) and read
//      `logins` via node:sqlite.
//   4. For a row whose origin shares the target's REGISTRABLE DOMAIN, AES-256-GCM-decrypt
//      password_value (v10/v11 blob: nonce=bytes[3:15], ct=bytes[15:-16], tag=bytes[-16:]).
//
// SEAMS: the PowerShell call, the Local State read, and the sqlite read are injected (defaults do
// the real thing) so the parsing/branching unit-tests with no live profile, Chrome, or DPAPI. The
// AES-GCM decrypt runs for real on whatever bytes a seam supplies (node:crypto, always available).

import { readFileSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';

// Hostname of a URL or a bare host string, lowercased; null if there's nothing usable.
function hostnameOf(urlOrHost) {
  const s = String(urlOrHost || '').trim();
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try { return new URL(s).hostname.toLowerCase() || null; } catch { return null; }
  }
  return s.replace(/^\/+/, '').split('/')[0].split(':')[0].toLowerCase() || null;
}

// Registrable domain ≈ eTLD+1 via the pragmatic "last two labels" rule — enough for the targeted
// case (the saved origin www.classdojo.com and the login page home.classdojo.com BOTH reduce to
// classdojo.com, so the saved row matches the page). It does NOT handle multi-part public suffixes
// (example.co.uk → co.uk); this limb signs in to single-label-TLD sites and does not need it.
function registrableDomain(urlOrHost) {
  const host = hostnameOf(urlOrHost);
  if (!host) return null;
  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.') || null;
  return labels.slice(-2).join('.');
}

// Normalize a value column (node:sqlite returns BLOBs as Uint8Array, not Buffer) to a Buffer.
function toBuf(x) {
  if (Buffer.isBuffer(x)) return x;
  if (x instanceof Uint8Array || Array.isArray(x)) return Buffer.from(x);
  return null;
}

// Decrypt a Chrome `password_value`. v10/v11 = AES-256-GCM; anything else (older DPAPI-only blobs,
// or garbage) → null so the caller skips the row. Never throws.
function decryptPassword(value, aesKey) {
  const buf = toBuf(value);
  if (!buf || buf.length < 3 + 12 + 16) return null;         // prefix + nonce + tag minimum
  const scheme = buf.subarray(0, 3).toString('latin1');
  if (scheme !== 'v10' && scheme !== 'v11') return null;
  try {
    const nonce = buf.subarray(3, 15);
    const tag = buf.subarray(buf.length - 16);
    const ciphertext = buf.subarray(15, buf.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', aesKey, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch { return null; }
}

// The DPAPI-unprotect PowerShell one-liner. Embeds ONLY the encrypted key blob (base64) — no
// secret of ours, and never a password. Add-Type loads System.Security on Windows PowerShell 5.1.
function dpapiUnprotectScript(encKeyBlobB64) {
  return [
    'Add-Type -AssemblyName System.Security;',
    `$b=[Convert]::FromBase64String('${encKeyBlobB64}');`,
    '$k=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);',
    '[Convert]::ToBase64String($k)',
  ].join(' ');
}

// Default seam: run PowerShell and return stdout. Its error messages carry only an exit code —
// never the key or a password. stdout (the base64 AES key) is returned to the caller and MUST NOT
// be logged by it.
function defaultRunPowerShell(script) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 20 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`DPAPI unprotect failed (powershell exit ${r.status})`);
  return r.stdout;
}

// Default seam: copy the locked Login Data to a temp file and read its `logins` rows.
// node:sqlite is experimental in this Node (v24) — it emits an ExperimentalWarning but needs no
// flag; imported lazily so merely loading this module (e.g. under the test runner) never touches
// it, and so a live /login is the only thing that triggers the warning.
async function defaultReadLogins(loginDataPath) {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'egpt-cred-'));
  const tmp = join(dir, 'Login Data');
  try {
    copyFileSync(loginDataPath, tmp);
    const db = new DatabaseSync(tmp, { readOnly: true });
    try { return db.prepare('SELECT origin_url, username_value, password_value FROM logins').all(); }
    finally { db.close(); }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp copy — best-effort */ }
  }
}

/**
 * Read the brain Chrome profile's saved { username, password } for `domain`, or null when there is
 * no saved login for that domain (by registrable domain) or the decrypt fails. NEVER throws: any
 * seam error collapses to null (login.mjs maps null → the 'no-credential' outcome). The returned
 * password is the plaintext — the caller types it and nulls it; it is never logged or posted here.
 *
 * @param {object} o
 * @param {string} o.profilePath  the Chrome user-data-dir (the brain profile root)
 * @param {string} o.domain       the site to sign in to (host or URL)
 * @param {object} [seams]
 * @param {function} [seams.readFile]      (path) => utf8 string; default node:fs readFileSync
 * @param {function} [seams.runPowerShell] (script) => stdout string; default spawnSync powershell
 * @param {function} [seams.readLogins]    (loginDataPath) => Promise<rows>; default node:sqlite
 * @returns {Promise<{username:string,password:string}|null>}
 */
export async function readChromeCredential({ profilePath, domain } = {}, {
  readFile = (p) => readFileSync(p, 'utf8'),
  runPowerShell = defaultRunPowerShell,
  readLogins = defaultReadLogins,
} = {}) {
  try {
    if (!profilePath || !domain) return null;
    const target = registrableDomain(domain);
    if (!target) return null;

    // 1. the encrypted master-key blob from Local State (strip the "DPAPI" ascii prefix).
    let localState;
    try { localState = JSON.parse(readFile(join(profilePath, 'Local State'))); } catch { return null; }
    const encKeyB64 = localState?.os_crypt?.encrypted_key;
    if (!encKeyB64) return null;
    let keyBlob = Buffer.from(String(encKeyB64), 'base64');
    if (keyBlob.length >= 5 && keyBlob.subarray(0, 5).toString('latin1') === 'DPAPI') keyBlob = keyBlob.subarray(5);

    // 2. DPAPI-unprotect it → the 32-byte AES-256-GCM key.
    const aesKey = Buffer.from(String(runPowerShell(dpapiUnprotectScript(keyBlob.toString('base64')))).trim(), 'base64');
    if (aesKey.length !== 32) return null;

    // 3. the saved logins.
    const rows = await readLogins(join(profilePath, 'Default', 'Login Data'));

    // 4. the first row whose origin shares the target's registrable domain, decrypted.
    for (const row of rows || []) {
      if (registrableDomain(row?.origin_url) !== target) continue;
      const password = decryptPassword(row?.password_value, aesKey);
      if (password == null) continue;
      const username = typeof row?.username_value === 'string' ? row.username_value : String(row?.username_value ?? '');
      return { username, password };
    }
    return null;
  } catch { return null; }
}
