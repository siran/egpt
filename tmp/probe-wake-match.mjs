import WebSocket from 'ws';
import { listTabs } from '../tools/cdp.mjs';

const tabs = await listTabs();
const wa = tabs.find(t => /web\.whatsapp\.com/.test(t.url ?? ''));
const ws = new WebSocket(wa.webSocketDebuggerUrl);
let _id = 0; const pending = new Map();
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id != null && pending.has(m.id)) {
    const { resolve } = pending.get(m.id); pending.delete(m.id); resolve(m.result);
  }
});
await new Promise((r) => ws.once('open', r));
const evalJs = async (e) => {
  const id = ++_id;
  const p = new Promise((resolve) => pending.set(id, { resolve }));
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: e, returnByValue: true } }));
  const r = await p;
  return r.result?.value;
};

// Apply the new extractRow logic + wake regex against every row.
const out = await evalJs(`JSON.stringify((() => {
  const WAKE_RE = /(?:^|\\s)@(egpt|e)\\b/i;
  const panel = document.querySelector('[aria-label="Chat list" i]') ||
                document.querySelector('[role="grid"][aria-label*="Chat" i]');
  const rows = panel ? panel.querySelectorAll('[role="listitem"], div[role="row"]') : [];
  const out = [];
  for (const row of rows) {
    const titleEl = row.querySelector('span[dir="auto"][title]') || row.querySelector('span[dir="auto"]');
    const name = (titleEl?.getAttribute('title') || titleEl?.innerText || '').trim();
    if (!name) continue;
    const unread = !!(
      row.querySelector('span[aria-label*="unread" i]') ||
      row.querySelector('[data-icon="unread-count"]')
    );
    const fullText = row.innerText || '';
    const preview = fullText
      .split('\\n')
      .map(s => s.trim())
      .filter(line => line && line !== name && !/^\\d+ unread/i.test(line))
      .join(' ')
      .slice(0, 300);
    const wake = WAKE_RE.test(preview);
    out.push({ name, unread, preview, wake });
    if (out.length >= 12) break;
  }
  return out;
})(), null, 2)`);
console.log(out);
ws.close();
