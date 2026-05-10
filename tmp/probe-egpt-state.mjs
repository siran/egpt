// Inspect the egpt UI tab: recent messages (looking for any
// '!! WA reply mirror failed' lines), the whatsapp_cdp config, and
// the bridge attach state.

import WebSocket from 'ws';
import { listTabs } from '../tools/cdp.mjs';

const tabs = await listTabs();
const egpt = tabs.find(t => /chrome-extension:.*\/tab\/index\.html/.test(t.url ?? ''));
if (!egpt) { console.error('no egpt tab'); process.exit(1); }

const ws = new WebSocket(egpt.webSocketDebuggerUrl);
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
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: e, returnByValue: true, awaitPromise: true } }));
  const r = await p;
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval threw');
  return r.result?.value;
};

// 1. Read recent messages from the visible chat scroller.
const messages = await evalJs(`JSON.stringify(
  Array.from(document.querySelectorAll('.msg')).slice(-25).map(el => ({
    author: el.querySelector('.msg-author')?.innerText ?? '',
    body:   el.querySelector('.msg-body')?.innerText ?? '',
  })), null, 2)`);
console.log('— recent messages —');
console.log(messages);

// 2. Read whatsapp_cdp config (visible to the page since it's our extension's UI).
const cfg = await evalJs(`new Promise((r) => chrome.storage.sync.get('whatsapp_cdp', (v) => r(JSON.stringify(v ?? {}, null, 2))))`);
console.log('\n— chrome.storage.sync.whatsapp_cdp —');
console.log(cfg);
ws.close();
