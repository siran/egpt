import WebSocket from 'ws';
import { listTabs } from '../tools/cdp.mjs';

const tabs = await listTabs();
const wa = tabs.find(t => /web\.whatsapp\.com/.test(t.url ?? ''));
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

const old = await evalJs(`(() => {
  const h = document.querySelector('header span[dir="auto"][title]');
  return h?.getAttribute('title') || h?.innerText?.trim() || null;
})()`);

const fresh = await evalJs(`(() => {
  const h = document.querySelector('#main header [data-testid="conversation-info-header"]') ||
            document.querySelector('#main header') ||
            document.querySelector('header [data-testid="conversation-header"]');
  if (!h) return null;
  return (h.innerText || h.getAttribute('title') || '').split('\\n')[0].replace(/\\s+/g, ' ').trim() || null;
})()`);

console.log('old selector  →', JSON.stringify(old));
console.log('new selector  →', JSON.stringify(fresh));
ws.close();
