// Inspect the service worker's runtime state directly. We can attach
// to the SW target and read the global counters (_waContentPorts,
// _waCdpSubscribers, _busTabPorts, _subscribers).

import WebSocket from 'ws';

const all = await fetch('http://localhost:9221/json').then(r => r.json());
const sw = all.find(t => t.type === 'service_worker' && /chrome-extension/.test(t.url ?? ''));
if (!sw) { console.error('no extension service worker'); process.exit(1); }
console.log('SW:', sw.id.slice(0,8), sw.url);

const ws = new WebSocket(sw.webSocketDebuggerUrl);
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

const out = await evalJs(`JSON.stringify({
  busTabPorts:      _busTabPorts?.size      ?? 'undefined',
  subscribers:      _subscribers?.size      ?? 'undefined',
  waContentPorts:   _waContentPorts?.size   ?? 'undefined',
  waCdpSubscribers: _waCdpSubscribers?.size ?? 'undefined',
  waContentTabIds:  _waContentPorts ? [..._waContentPorts].map(p => p._waTabId ?? null) : null,
}, null, 2)`);
console.log(out);
ws.close();
