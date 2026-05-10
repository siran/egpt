// Diagnose why a WA-typed '@e ...' message wasn't picked up by the
// content script. Inspects: active chat, recent rendered rows in the
// conversation pane (with their data-id, author from data-pre-plain-text,
// and timestamp), the chat-list scroll/unread state, and whether the
// content-script flag is installed in the page.

import WebSocket from 'ws';
import { listTabs } from '../tools/cdp.mjs';

const tabs = await listTabs();
const wa = tabs.find(t => /web\.whatsapp\.com/.test(t.url ?? ''));
if (!wa) { console.error('no WA Web tab'); process.exit(1); }

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

const out = await evalJs(`JSON.stringify((() => {
  const norm = (s) => (s ?? '').replace(/\\s+/g, ' ').trim();
  const firstLine = (s) => norm((s || '').split('\\n')[0]);
  const headerOf = () => {
    const h = document.querySelector('header [data-testid="conversation-info-header"]') ||
              document.querySelector('header span[dir="auto"][title]') ||
              document.querySelector('header span[dir="auto"]');
    return firstLine(h?.getAttribute?.('title') || h?.innerText || '');
  };
  const activeTitle = headerOf();
  const csInstalled = !!window.__egptWaContentInstalled;
  const rowsAll = document.querySelectorAll('[data-id]');
  const rows = [];
  // last 25 rows in document order
  const list = [...rowsAll].slice(-25);
  for (const r of list) {
    const id = r.getAttribute('data-id');
    const text = (r.querySelector('.copyable-text, [class*="copyable-text"]')?.innerText || '').trim().slice(0, 120);
    const ppt = r.querySelector('[data-pre-plain-text]')?.getAttribute('data-pre-plain-text') || null;
    rows.push({ id: id?.slice(0, 28), ppt, text });
  }
  // chat-list panel — count rows and unread badges
  const panel = document.querySelector('[aria-label="Chat list" i]') ||
                document.querySelector('[role="grid"][aria-label*="Chat" i]');
  const chatRows = panel ? panel.querySelectorAll('[role="listitem"], div[role="row"]').length : 0;
  const unreadCount = panel ? panel.querySelectorAll('span[aria-label*="unread" i], [data-icon="unread-count"]').length : 0;
  return {
    activeTitle, csInstalled,
    chatRows, unreadCount,
    domRowsTotal: rowsAll.length,
    domRowsShown: rows.length,
    rows,
  };
})(), null, 2)`);
console.log(out);
ws.close();
