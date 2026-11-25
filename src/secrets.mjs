// secrets.mjs — tokens live in a folder, never in config.yaml (operator 2026-10-23):
// $EGPT_HOME/secrets/<name>, one value per file, trimmed. Read by the Telegram limb
// (telegram-<connection>.token) and the voice HMAC (synthesizer.token).
import { readFileSync, statSync, writeFileSync, renameSync, mkdirSync, chmodSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';

// The voice HMAC key, shared by the synthesizer worker and its voice_service clients.
export const SYNTH_TOKEN_FILE = 'synthesizer.token';
// A boxed being's Claude credential (`claude setup-token`) when config.yaml has no sandbox_oauth_token.
export const CLAUDE_OAUTH_TOKEN_FILE = 'claude-oauth.token';
// The console / being-link HMAC key when config.yaml has no shell.token.
export const SHELL_TOKEN_FILE = 'shell.token';

// A value locked with a password in the browser (http-secrets.mjs): enc:v1:<b64 salt>:<b64 iv>:<b64 ciphertext>.
export const ENCRYPTED_PREFIX = 'enc:v1:';
export const SECRET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const MAX_SECRET_BYTES = 64 * 1024;
const META_FILE = '.meta.json', HISTORY_DIR = '.history';

export const secretPath = (home, name) => join(home, 'secrets', name);
// What the page manages lives in its own folder, never beside the node's token files (shell.token, telegram-*.token …).
export const PAGE_DIR = 'managed';
export const pageDir = (home) => join(home, 'secrets', PAGE_DIR);
export const pagePath = (home, name) => join(pageDir(home), name);

// { token, path, warn } or { token: null, path, problem }. The node's own file first, else the one the page saved.
export function readSecret(home, name, { platform = process.platform } = {}) {
  let path = secretPath(home, name);
  let token;
  try { token = readFileSync(path, 'utf8').trim(); }
  catch (e) {
    if (e?.code !== 'ENOENT') return { token: null, path, problem: e?.message ?? String(e) };
    const own = path;
    path = pagePath(home, name);
    try { token = readFileSync(path, 'utf8').trim(); }
    catch (e2) { return { token: null, path: own, problem: e2?.code === 'ENOENT' ? 'missing' : (e2?.message ?? String(e2)) }; }
  }
  if (!token) return { token: null, path, problem: 'empty' };
  if (token.startsWith(ENCRYPTED_PREFIX)) return { token: null, path, problem: 'encrypted' };   // locked in a browser: the node cannot use it
  let warn = null;
  if (platform !== 'win32') {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) warn = `mode ${mode.toString(8)}, expected 600`;
  }
  return { token, path, warn };
}

// Writes one secret: temp file then rename; on POSIX the file is 0600 and the folder 0700. Returns its path.
export function writeSecret(home, name, value, { platform = process.platform } = {}) {
  const path = secretPath(home, name);
  const posix = platform !== 'win32';
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (posix) chmodSync(dirname(path), 0o700);
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, `${value}\n`, { mode: 0o600 });
    if (posix) chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return path;
}

// ── the operator's secrets page (http-secrets.mjs): list, history, meta, rename ──
// Everything the page manages is under secrets/managed/ (PAGE_DIR), apart from the node's token files: the page can
// neither list, read nor overwrite shell.token, telegram-*.token, … (a name that is a file in secrets/ is refused).
// Meta: managed/.meta.json { <name>: { created_by, created_at, changed_by, changed_at } }.
// History: managed/.history/<name>/<UTC stamp>, one per save, METADATA ONLY: JSON { kind: plain | encrypted, fingerprint
// (first 8 hex of the SHA-256 of the replaced value), changed_by, changed_at (who wrote it, when), replaced_by,
// replaced_at }. An old plain value is never kept; an old locked value is kept as its ciphertext (`value`, enc:v1:),
// which only its password opens. purgeHistory forgets it. A name outside SECRET_NAME_RE, a dotfile and a *.tmp-*
// file are never listed or written here. On Windows each folder and file is locked to the user and SYSTEM (lockPath).
const nameOk = (name) => typeof name === 'string' && SECRET_NAME_RE.test(name) && !/\.tmp-/.test(name);
function needName(name) { if (!nameOk(name)) throw new Error('bad name: letters, digits, . _ - (at most 100, starting with a letter or digit)'); }
function needFree(home, name) { if (existsSync(secretPath(home, name))) throw new Error(`'${name}' is one of the node's own files (secrets/${name}); this page does not manage it`); }
const stampOf = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace('.', '');   // 20261125T101500123Z
const posix = (platform) => platform !== 'win32';
const fingerprint = (value) => createHash('sha256').update(value).digest('hex').slice(0, 8);

// Windows: the owner and SYSTEM only, inheritance off (what 0600/0700 are on POSIX; chmod does nothing there). `icacls` is a seam.
const runIcacls = (args) => execFileSync('icacls', args, { stdio: 'pipe', windowsHide: true });
export function lockPath(path, { platform = process.platform, dir = false, icacls = runIcacls, user = userInfo().username } = {}) {
  if (posix(platform)) return;
  const perm = dir ? '(OI)(CI)F' : 'F';
  icacls([path, '/inheritance:r', '/grant:r', `${user}:${perm}`, `*S-1-5-18:${perm}`]);
}
function lockedDir(path, o) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (posix(o.platform)) chmodSync(path, 0o700); else lockPath(path, { ...o, dir: true });
}
function writeFile600(path, text, o) {
  lockedDir(dirname(path), o);
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    if (posix(o.platform)) chmodSync(tmp, 0o600); else lockPath(tmp, o);
    renameSync(tmp, path);
  } catch (e) { rmSync(tmp, { force: true }); throw e; }
}
const readStored = (home, name) => {
  try { return readFileSync(pagePath(home, name), 'utf8').replace(/\n$/, ''); }
  catch (e) { if (e?.code === 'ENOENT') return null; throw e; }
};

export function readMeta(home) {
  try { return JSON.parse(readFileSync(join(pageDir(home), META_FILE), 'utf8')); }
  catch (e) { if (e?.code === 'ENOENT') return {}; throw e; }
}
const writeMeta = (home, meta, o) => writeFile600(join(pageDir(home), META_FILE), `${JSON.stringify(meta, null, 2)}\n`, o);

// [{ name, locked, created_by, created_at, changed_by, changed_at }], by name; the secrets the page may touch.
export function listSecrets(home) {
  let files;
  try { files = readdirSync(pageDir(home), { withFileTypes: true }); }
  catch (e) { if (e?.code === 'ENOENT') return []; throw e; }
  const meta = readMeta(home);
  return files.filter((f) => f.isFile() && nameOk(f.name)).map((f) => f.name).sort()
    .map((name) => ({ name, locked: readStored(home, name)?.startsWith(ENCRYPTED_PREFIX) === true, ...meta[name] }));
}

// { name, value (as stored), locked, ...meta } or null.
export function getSecret(home, name) {
  if (!nameOk(name)) return null;
  const value = readStored(home, name);
  return value == null ? null : { name, value, locked: value.startsWith(ENCRYPTED_PREFIX), ...readMeta(home)[name] };
}

// Newest first: [{ stamp, kind, fingerprint, value? (ciphertext, locked ones only), changed_by, changed_at, replaced_by, replaced_at }].
export function secretHistory(home, name) {
  if (!nameOk(name)) return [];
  const dir = join(pageDir(home), HISTORY_DIR, name);
  let stamps;
  try { stamps = readdirSync(dir); } catch (e) { if (e?.code === 'ENOENT') return []; throw e; }
  return stamps.filter((s) => !s.includes('.tmp-')).sort().reverse()
    .map((stamp) => ({ stamp, ...JSON.parse(readFileSync(join(dir, stamp), 'utf8')) }));
}

// Forgets the history of one secret, or of all of them (name null). Returns how many entries went.
export function purgeHistory(home, name = null) {
  if (name != null && !nameOk(name)) throw new Error('bad name');
  const root = join(pageDir(home), HISTORY_DIR), dir = name == null ? root : join(root, name);
  const n = name != null ? secretHistory(home, name).length : existsSync(root) ? readdirSync(root).reduce((a, d) => a + readdirSync(join(root, d)).length, 0) : 0;
  rmSync(dir, { recursive: true, force: true });
  return n;
}

// Moves a secret with its history and meta. Refuses a missing source or an existing target.
export function renameSecret(home, from, to, o = {}) {
  o = { platform: process.platform, ...o };
  needName(from); needName(to); needFree(home, to);
  if (readStored(home, from) == null) throw new Error(`no secret '${from}'`);
  if (existsSync(pagePath(home, to))) throw new Error(`a secret '${to}' exists`);
  renameSync(pagePath(home, from), pagePath(home, to));
  const hist = join(pageDir(home), HISTORY_DIR);
  if (existsSync(join(hist, from))) { rmSync(join(hist, to), { recursive: true, force: true }); renameSync(join(hist, from), join(hist, to)); }
  const meta = readMeta(home);
  if (meta[from]) { meta[to] = meta[from]; delete meta[from]; writeMeta(home, meta, o); }
}

// Saves a value as stored (plain, or an enc:v1: string the browser made); what it replaces goes to the history as
// metadata only (see above) and who/when to the meta. `from`: the name it had, a rename first.
// Returns { action: created | changed | renamed, locked }.
export function saveSecret(home, name, value, who, { from = null, now = Date.now, platform = process.platform, icacls } = {}) {
  const o = { platform, ...(icacls && { icacls }) };
  needName(name); needFree(home, name);
  if (typeof value !== 'string' || !value.length) throw new Error('empty value');
  if (Buffer.byteLength(value) > MAX_SECRET_BYTES) throw new Error(`value over ${MAX_SECRET_BYTES / 1024} KB`);
  const renamed = from != null && from !== name;
  if (renamed) renameSecret(home, from, name, o);
  const at = now(), meta = readMeta(home), prev = readStored(home, name);
  if (prev != null) {
    const m = meta[name] ?? {};
    let stamp = at;   // two saves in one millisecond must not overwrite each other
    while (existsSync(join(pageDir(home), HISTORY_DIR, name, stampOf(stamp)))) stamp += 1;
    const locked = prev.startsWith(ENCRYPTED_PREFIX);
    writeFile600(join(pageDir(home), HISTORY_DIR, name, stampOf(stamp)), `${JSON.stringify({
      kind: locked ? 'encrypted' : 'plain', fingerprint: fingerprint(prev), ...(locked && { value: prev }),
      changed_by: m.changed_by ?? null, changed_at: m.changed_at ?? null, replaced_by: who, replaced_at: new Date(at).toISOString(),
    })}\n`, o);
  }
  writeFile600(pagePath(home, name), `${value}\n`, o);
  const iso = new Date(at).toISOString();
  meta[name] = { created_by: meta[name]?.created_by ?? who, created_at: meta[name]?.created_at ?? iso, changed_by: who, changed_at: iso };
  writeMeta(home, meta, o);
  return { action: renamed ? 'renamed' : prev == null ? 'created' : 'changed', locked: value.startsWith(ENCRYPTED_PREFIX) };
}
