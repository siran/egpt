// sandbox-pins.mjs — a being pinned to ONE sandbox pool account in ONE conversation (operator
// 2026-10-27: "this E should be tied only to this sandbox account, sticky... when the account is
// released all access permission is reset"). Opted in by conversations.yaml
// contacts.<surface>.<id>.agents.<being>.sandbox_pin, a map in the allowed_paths shape (`{}` = pinned,
// no standing paths). The launcher claims the account and keeps the standing grants
// (setup/sandbox-account.ps1, PINNED ACCOUNTS); this module names a pin, and releases every pin whose
// opt-in is gone (setup/release-sandbox-pin.ps1) on the spine's tick.
import { spawn as nodeSpawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBeing } from '../conversations-state.mjs';

// setup/sandbox-account.ps1 $SandboxPinsDir.
export const SANDBOX_PINS_DIR = join(process.env.ProgramData || 'C:\\ProgramData', 'egpt', 'sandbox-pins');
const RELEASE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'setup', 'release-sandbox-pin.ps1');
const RELEASE_DONE = 0;   // release-sandbox-pin.ps1: released, or no such pin

export const isSandboxPin = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

// The launcher's -PinKey and the pin file's key= line. `chatId` is the contact's PRIMARY id (getBeing's
// `jid`), so an alias of the chat names the same pin.
export const sandboxPinKeyOf = (being, surface, chatId) => `${being}:${surface}:${chatId}`;

// Every pin conversations.yaml still asks for, read through getBeing like a turn reads it.
export function optedInPinKeys(state) {
  const keys = new Set();
  for (const [surface, byId] of Object.entries(state?.contacts ?? {})) {
    for (const [id, entry] of Object.entries(byId ?? {})) {
      for (const being of Object.keys(entry?.agents ?? {})) {
        const b = getBeing(state, surface, id, being);
        if (b && isSandboxPin(b.sandboxPin)) keys.add(sandboxPinKeyOf(being, surface, b.jid));
      }
    }
  }
  return keys;
}

// The key= line of each <account>.pin. No directory = no pins; any other read failure throws.
export function readPinKeys(dir = SANDBOX_PINS_DIR, { readdir = readdirSync, readFile = readFileSync } = {}) {
  let names;
  try { names = readdir(dir); } catch (e) { if (e?.code === 'ENOENT') return []; throw e; }
  return names.filter((n) => n.toLowerCase().endsWith('.pin')).flatMap((n) => {
    const line = String(readFile(join(dir, n), 'utf8')).split(/\r?\n/).find((l) => l.startsWith('key='));
    return line ? [line.slice(4).trim()] : [];
  });
}

// Once per `everyMs` (and at the first tick): for each pin whose opt-in is gone, end that being's warm
// session there (once per pin — it holds the account), then release. A release that did not finish
// (busy, or something still granted) is retried next time.
export function createSandboxPinReleaser({ loadState, evictWarm = () => {}, platform = process.platform, dir = SANDBOX_PINS_DIR, everyMs = 60_000, spawn = nodeSpawn, readdir, readFile, onLog = () => {} } = {}) {
  let last = -Infinity;
  let running = null;
  const evicted = new Set();

  function release(key) {
    return new Promise((resolve) => {
      let tail = '';
      const proc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', RELEASE_SCRIPT, '-Key', key], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      proc.stderr?.on('data', (c) => { tail = (tail + c).slice(-4000); });
      proc.once('error', (e) => { onLog(`${key}: release could not start — ${e?.message ?? e}`); resolve(-1); });
      proc.once('close', (code) => {
        const said = tail.trim().split(/\r?\n/).pop();
        onLog(`${key}: release exited ${code}${said ? ` — ${said}` : ''}`);
        resolve(code);
      });
    });
  }

  async function sweep() {
    const keys = readPinKeys(dir, { readdir, readFile });
    if (!keys.length) return [];
    const active = optedInPinKeys(await loadState());
    const out = [];
    for (const key of keys.filter((k) => !active.has(k))) {
      if (!evicted.has(key)) {
        evicted.add(key);
        const [being, surface, ...chat] = key.split(':');
        try { await evictWarm(being, { surface, chatId: chat.join(':') }); } catch (e) { onLog(`${key}: could not end its warm session — ${e?.message ?? e}`); }
      }
      const code = await release(key);
      if (code === RELEASE_DONE) evicted.delete(key);
      out.push({ key, code });
    }
    return out;
  }

  return {
    sweep,
    // The sweep in flight, if this tick started one (the spine ignores it).
    tick(now) {
      if (platform !== 'win32' || running || now - last < everyMs) return null;
      last = now;
      running = sweep().catch((e) => onLog(`sweep failed — ${e?.message ?? e}`)).finally(() => { running = null; });
      return running;
    },
  };
}
