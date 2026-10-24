// secrets.mjs — tokens live in a folder, never in config.yaml (operator 2026-10-23):
// $EGPT_HOME/secrets/<name>, one value per file, trimmed. Read by the Telegram limb
// (telegram-<connection>.token) and the voice HMAC (synthesizer.token).
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The voice HMAC key, shared by the synthesizer worker and its voice_service clients.
export const SYNTH_TOKEN_FILE = 'synthesizer.token';

export const secretPath = (home, name) => join(home, 'secrets', name);

// { token, path, warn } or { token: null, path, problem }.
export function readSecret(home, name, { platform = process.platform } = {}) {
  const path = secretPath(home, name);
  let token;
  try { token = readFileSync(path, 'utf8').trim(); }
  catch (e) { return { token: null, path, problem: e?.code === 'ENOENT' ? 'missing' : (e?.message ?? String(e)) }; }
  if (!token) return { token: null, path, problem: 'empty' };
  let warn = null;
  if (platform !== 'win32') {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) warn = `mode ${mode.toString(8)}, expected 600`;
  }
  return { token, path, warn };
}
