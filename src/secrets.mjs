// secrets.mjs — tokens live in a folder, never in config.yaml (operator 2026-10-23):
// $EGPT_HOME/secrets/<name>, one value per file, trimmed. Read by the Telegram limb
// (telegram-<connection>.token) and the voice HMAC (synthesizer.token).
import { readFileSync, statSync, writeFileSync, renameSync, mkdirSync, chmodSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

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

// { token, path, warn } or { token: null, path, problem }.
export function readSecret(home, name, { platform = process.platform } = {}) {
  const path = secretPath(home, name);
  let token;
  try { token = readFileSync(path, 'utf8').trim(); }
  catch (e) { return { token: null, path, problem: e?.code === 'ENOENT' ? 'missing' : (e?.message ?? String(e)) }; }
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
// Meta: secrets/.meta.json { <name>: { created_by, created_at, changed_by, changed_at } } (0600).
// History: secrets/.history/<name>/<UTC stamp> (0600), one per save: the value it replaced, AS STORED (a locked
// one stays locked), as JSON { value, changed_by, changed_at (who wrote that value, when), replaced_by, replaced_at }.
// A name outside SECRET_NAME_RE, a dotfile and a *.tmp-* file are never listed or written here.
const nameOk = (name) => typeof name === 'string' && SECRET_NAME_RE.test(name) && !/\.tmp-/.test(name);
function needName(name) { if (!nameOk(name)) throw new Error('bad name: letters, digits, . _ - (at most 100, starting with a letter or digit)'); }
const stampOf = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace('.', '');   // 20261125T101500123Z
const posix = (platform) => platform !== 'win32';
function writeFile600(path, text, platform) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    if (posix(platform)) chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (e) { rmSync(tmp, { force: true }); throw e; }
}
const readStored = (home, name) => {
  try { return readFileSync(secretPath(home, name), 'utf8').replace(/\n$/, ''); }
  catch (e) { if (e?.code === 'ENOENT') return null; throw e; }
};

export function readMeta(home) {
  try { return JSON.parse(readFileSync(join(home, 'secrets', META_FILE), 'utf8')); }
  catch (e) { if (e?.code === 'ENOENT') return {}; throw e; }
}
const writeMeta = (home, meta, platform) => writeFile600(join(home, 'secrets', META_FILE), `${JSON.stringify(meta, null, 2)}\n`, platform);

// [{ name, locked, created_by, created_at, changed_by, changed_at }], by name; the secrets the page may touch.
export function listSecrets(home) {
  let files;
  try { files = readdirSync(join(home, 'secrets'), { withFileTypes: true }); }
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

// Newest first: [{ stamp, value, changed_by, changed_at, replaced_by, replaced_at }].
export function secretHistory(home, name) {
  if (!nameOk(name)) return [];
  const dir = join(home, 'secrets', HISTORY_DIR, name);
  let stamps;
  try { stamps = readdirSync(dir); } catch (e) { if (e?.code === 'ENOENT') return []; throw e; }
  return stamps.filter((s) => !s.includes('.tmp-')).sort().reverse()
    .map((stamp) => ({ stamp, ...JSON.parse(readFileSync(join(dir, stamp), 'utf8')) }));
}

// Moves a secret with its history and meta. Refuses a missing source or an existing target.
export function renameSecret(home, from, to, { platform = process.platform } = {}) {
  needName(from); needName(to);
  if (readStored(home, from) == null) throw new Error(`no secret '${from}'`);
  if (existsSync(secretPath(home, to))) throw new Error(`a secret '${to}' exists`);
  renameSync(secretPath(home, from), secretPath(home, to));
  const hist = join(home, 'secrets', HISTORY_DIR);
  if (existsSync(join(hist, from))) { rmSync(join(hist, to), { recursive: true, force: true }); renameSync(join(hist, from), join(hist, to)); }
  const meta = readMeta(home);
  if (meta[from]) { meta[to] = meta[from]; delete meta[from]; writeMeta(home, meta, platform); }
}

// Saves a value as stored (plain, or an enc:v1: string the browser made), keeping what it replaces in the
// history and who/when in the meta. `from`: the name it had, a rename first. Returns { action: created | changed | renamed, locked }.
export function saveSecret(home, name, value, who, { from = null, now = Date.now, platform = process.platform } = {}) {
  needName(name);
  if (typeof value !== 'string' || !value.length) throw new Error('empty value');
  if (Buffer.byteLength(value) > MAX_SECRET_BYTES) throw new Error(`value over ${MAX_SECRET_BYTES / 1024} KB`);
  const renamed = from != null && from !== name;
  if (renamed) renameSecret(home, from, name, { platform });
  const at = now(), meta = readMeta(home), prev = readStored(home, name);
  if (prev != null) {
    const m = meta[name] ?? {};
    let stamp = at;   // two saves in one millisecond must not overwrite each other
    while (existsSync(join(home, 'secrets', HISTORY_DIR, name, stampOf(stamp)))) stamp += 1;
    writeFile600(join(home, 'secrets', HISTORY_DIR, name, stampOf(stamp)), `${JSON.stringify({ value: prev, changed_by: m.changed_by ?? null, changed_at: m.changed_at ?? null, replaced_by: who, replaced_at: new Date(at).toISOString() })}\n`, platform);
  }
  writeSecret(home, name, value, { platform });
  const iso = new Date(at).toISOString();
  meta[name] = { created_by: meta[name]?.created_by ?? who, created_at: meta[name]?.created_at ?? iso, changed_by: who, changed_at: iso };
  writeMeta(home, meta, platform);
  return { action: renamed ? 'renamed' : prev == null ? 'created' : 'changed', locked: value.startsWith(ENCRYPTED_PREFIX) };
}
