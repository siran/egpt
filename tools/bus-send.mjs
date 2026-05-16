// tools/bus-send.mjs — post events to the egpt bus from anywhere with
// CDP access. Designed for sibling subprocesses (cross-resume nudges,
// helper scripts) that need to reach the running daemon's WA bridge
// (or any other bus consumer) without holding their own baileys sock.
//
// The bus tab in the brain Chrome is the IPC. The daemon CDP-attaches
// and listens for events; we attach as a one-shot writer and post.
// Same pattern the extension uses, just from Node.
//
// JS API:
//   import { busSend, waSend } from './tools/bus-send.mjs';
//   await waSend({ jid: '34...@lid', body: 'hi' });
//
// CLI smoke test:
//   node tools/bus-send.mjs --wa-to-an "wren-via-bus 👋"

import * as bus from './bus.mjs';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const DEFAULT_FROM = 'sibling-subproc';

async function readEgptConfig() {
  const p = path.join(os.homedir(), '.egpt', 'config.json');
  return JSON.parse(await fs.readFile(p, 'utf8'));
}

/**
 * Post an event to the bus. Loads the signing key, finds the running
 * bus tab (does NOT open one — the daemon owns its Chrome), signs,
 * posts, resolves on ack. Throws if no bus tab is found.
 *
 * @param {object} event - at minimum { type }; consumer-specific fields beyond that
 * @param {object} opts  - { from = 'sibling-subproc' }
 */
export async function busSend(event, { from = DEFAULT_FROM } = {}) {
  if (!event || typeof event !== 'object' || !event.type) {
    throw new Error('busSend: event must be an object with a type');
  }
  const key = await bus.loadOrCreateBusKey();
  bus.setBusKey(key);
  const tab = await bus.findOrOpenBusTab({ open: false });
  if (!tab) throw new Error('busSend: no bus tab — is the daemon Chrome running?');
  const payload = { from, ts: Date.now(), ...event };
  await bus.postEvent(tab.targetId, payload);
  return { targetId: tab.targetId, posted: payload };
}

/** Convenience: send WA text to a JID via the daemon's baileys bridge. */
export async function waSend({ jid, body, toNode = null, from = DEFAULT_FROM }) {
  if (!jid || !body) throw new Error('waSend: jid and body required');
  const ev = { type: 'wa-send', jid, body };
  if (toNode) ev.to_node = toNode;
  return busSend(ev, { from });
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
    const waToAn = get('--wa-to-an');
    const body = get('--body') ?? waToAn;
    if (waToAn && !jid) {
      const cfg = await readEgptConfig();
      jid = cfg.whatsapp?.chat_id ?? null;
      if (!jid) throw new Error('--wa-to-an: whatsapp.chat_id missing in ~/.egpt/config.json');
    }
    const type = get('--type') ?? 'wa-send';
    if (!body) throw new Error('--body (or --wa-to-an "msg") required');
    if (type === 'wa-send' && !jid) throw new Error('--jid required for wa-send');
    const from = get('--from') ?? DEFAULT_FROM;
    const ev = type === 'wa-send' ? { type: 'wa-send', jid, body } : { type, body };
    const res = await busSend(ev, { from });
    console.log(JSON.stringify(res, null, 2));
  } catch (e) {
    console.error('bus-send: ' + e.message);
    process.exit(1);
  }
}
