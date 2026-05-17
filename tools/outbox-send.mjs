// tools/outbox-send.mjs — drop an event into the egpt outbox for the
// daemon to pick up and dispatch. Used by sibling subprocesses
// (cross-resume nudges, helper scripts) that need the daemon's
// baileys/telegram bridges without owning their own client.
//
// The daemon watches ~/.egpt/outbox/ via fs.watch + a periodic sweep
// (Windows fs.watch misses some renames under load). Each event lands
// as a single JSON file written atomically (write-temp + rename) so
// the watcher never sees a partial read. The daemon dispatches by
// event type (e.g. wa-send → baileys), then unlinks the file.
//
// This is one of egpt's send transports, each fit-for-purpose:
//   - tools/bus-send.mjs    → bus tab via CDP (extension↔daemon, Chrome-up)
//   - tools/outbox-send.mjs → ~/.egpt/outbox/  (sibling subprocess → daemon, headless)
//
// JS API:
//   import { outboxSend, waSend } from './tools/outbox-send.mjs';
//   await waSend({ jid: '34...@lid', body: 'hi' });
//
// CLI smoke test:
//   node tools/outbox-send.mjs --wa-to-self "jay-via-outbox 👋"

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const DEFAULT_FROM = 'sibling-subproc';
export const OUTBOX_DIR = path.join(os.homedir(), '.egpt', 'outbox');

async function readEgptConfig() {
  const p = path.join(os.homedir(), '.egpt', 'config.json');
  return JSON.parse(await fs.readFile(p, 'utf8'));
}

/**
 * Drop a JSON event into the outbox. Atomic: writes to a temp dotfile
 * first, then renames into place — the daemon's watcher only sees the
 * final filename on rename, never a half-written file.
 *
 * @param {object} event - at minimum { type }; consumer-specific fields beyond that
 * @param {object} opts  - { from = 'sibling-subproc' }
 * @returns {Promise<{filename: string, posted: object}>}
 */
export async function outboxSend(event, { from = DEFAULT_FROM } = {}) {
  if (!event || typeof event !== 'object' || !event.type) {
    throw new Error('outboxSend: event must be an object with a type');
  }
  await fs.mkdir(OUTBOX_DIR, { recursive: true });
  const ts = Date.now();
  const id = randomUUID();
  const finalName = `${ts}-${id}.json`;
  const tmpName = `.tmp-${id}.json`;
  const tmpPath = path.join(OUTBOX_DIR, tmpName);
  const finalPath = path.join(OUTBOX_DIR, finalName);
  const payload = { from, ts, ...event };
  await fs.writeFile(tmpPath, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmpPath, finalPath);
  return { filename: finalName, posted: payload };
}

/** Convenience: send WA text to a JID via the daemon's baileys bridge. */
export async function waSend({ jid, body, from = DEFAULT_FROM }) {
  if (!jid || !body) throw new Error('waSend: jid and body required');
  return outboxSend({ type: 'wa-send', jid, body }, { from });
}

// ---------------- CLI ----------------
const _invokedDirectly = process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (_invokedDirectly) {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
  };
  try {
    let jid = get('--jid');
    const waToSelf = get('--wa-to-self');
    const body = get('--body') ?? waToSelf;
    if (waToSelf && !jid) {
      const cfg = await readEgptConfig();
      jid = cfg.whatsapp?.chat_id ?? null;
      if (!jid) throw new Error('--wa-to-self: whatsapp.chat_id missing in ~/.egpt/config.json');
    }
    const type = get('--type') ?? 'wa-send';
    if (!body) throw new Error('--body (or --wa-to-self "msg") required');
    if (type === 'wa-send' && !jid) throw new Error('--jid required for wa-send');
    const from = get('--from') ?? DEFAULT_FROM;
    const ev = type === 'wa-send' ? { type: 'wa-send', jid, body } : { type, body };
    const res = await outboxSend(ev, { from });
    console.log(JSON.stringify(res, null, 2));
  } catch (e) {
    console.error('outbox-send: ' + e.message);
    process.exit(1);
  }
}
