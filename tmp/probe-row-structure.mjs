import WebSocket from 'ws';
import { listTabs } from '../tools/cdp.mjs';

const tabs = await listTabs();
const wa = tabs.find(t => /web\.whatsapp\.com/.test(t.url ?? ''));
const ws = new WebSocket(wa.webSocketDebuggerUrl);
let _id = 0; const pending = new Map();
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id != null && pending.has(m.id)) {
    const { resolve } = pending.get(m.id);
    pending.delete(m.id);
    resolve(m.result);
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

// For the unread "Rollatos" row (and a couple of others) — dump every
// inner span's innerText AND the full row innerText so we can pick a
// preview source that includes the actual message body.
const out = await evalJs(`JSON.stringify((() => {
  const panel = document.querySelector('[aria-label="Chat list" i]') ||
                document.querySelector('[role="grid"][aria-label*="Chat" i]');
  const rows = panel ? panel.querySelectorAll('[role="listitem"], div[role="row"]') : [];
  const sample = [];
  for (const row of rows) {
    const titleEl = row.querySelector('span[dir="auto"][title]') || row.querySelector('span[dir="auto"]');
    const name = (titleEl?.getAttribute('title') || titleEl?.innerText || '').trim();
    if (!name || sample.length >= 4) continue;
    if (!['Rollatos', 'compren bitcoin!', 'Lu Lu', '+1 (646) 821-7865'].includes(name)) continue;
    const allSpans = [...row.querySelectorAll('span[dir="auto"]')].map(s => ({
      title: s.getAttribute('title'),
      innerText: (s.innerText || '').slice(0, 100),
    }));
    sample.push({
      name,
      rowInnerText: (row.innerText || '').slice(0, 250),
      spans: allSpans,
      rowHtml: row.outerHTML.slice(0, 600),
    });
  }
  return sample;
})(), null, 2)`);
console.log(out);
ws.close();
