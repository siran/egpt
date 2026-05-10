// Verify the content script is alive in the WA tab and the observer
// is firing. We can't read the isolated-world `window.__egptWaContentInstalled`
// flag from main world, but we CAN look at indirect evidence:
//   - the bg port for 'egpt-wa-content' (background tracks _waContentPorts)
//   - the chat-list rows' aria-label for unread (does any wake-word
//     unread exist right now that should have been auto-opened?)

import WebSocket from 'ws';
import { listTabs } from '../tools/cdp.mjs';

const tabs = await listTabs();
const wa = tabs.find(t => /web\.whatsapp\.com/.test(t.url ?? ''));
if (!wa) { console.error('no WA tab'); process.exit(1); }

const ws = new WebSocket(wa.webSocketDebuggerUrl);
let _id = 0; const pending = new Map();
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id != null && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
  }
});
await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
const evalJs = async (e) => {
  const id = ++_id;
  const p = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: e, returnByValue: true } }));
  const r = await p;
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval threw');
  return r.result?.value;
};

// 1. List execution contexts (isolated worlds) — content script will
//    have its own. We use a different approach: poll for unread chats
//    and see what would be auto-opened RIGHT NOW.
const out = await evalJs(`JSON.stringify((() => {
  const norm = (s) => (s ?? '').replace(/\\s+/g, ' ').trim();
  const looksLikeJid = (v) => typeof v === 'string'
    && /^[\\w\\d-]+@[\\w.]+$/.test(v)
    && !/^[A-F0-9]{16,}$/i.test(v);
  const panel = document.querySelector('[aria-label="Chat list" i]') ||
                document.querySelector('[role="grid"][aria-label*="Chat" i]');
  if (!panel) return { panel: null };
  const rows = panel.querySelectorAll('[role="listitem"], div[role="row"]');
  const allRows = [];
  const wakeRe = /^@(egpt|e)\\b/i;
  for (const row of rows) {
    const titleEl = row.querySelector('span[dir="auto"][title]') || row.querySelector('span[dir="auto"]');
    const name = (titleEl?.getAttribute('title') || titleEl?.innerText || '').trim();
    if (!name) continue;
    const previewEl = [...row.querySelectorAll('span[dir="auto"]')].find(s => s !== titleEl);
    const preview = (previewEl?.innerText || '').slice(0, 200).trim();
    const unread = !!(
      row.querySelector('span[aria-label*="unread" i]') ||
      row.querySelector('[data-icon="unread-count"]')
    );
    allRows.push({ name, preview, unread, wakeMatch: wakeRe.test(preview) });
    if (allRows.length >= 12) break;
  }
  return {
    panelFound: !!panel,
    rows: allRows,
    unreadCount: allRows.filter(r => r.unread).length,
    wakeMatched: allRows.filter(r => r.unread && r.wakeMatch).length,
  };
})(), null, 2)`);
console.log(out);
ws.close();
