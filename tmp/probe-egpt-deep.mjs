import WebSocket from 'ws';
const all = await fetch('http://localhost:9221/json').then(r => r.json());
const egpt = all.find(t => t.type === 'page' && /tab\/index\.html/.test(t.url ?? ''));
if (!egpt) { console.error('no egpt tab'); process.exit(1); }
const ws = new WebSocket(egpt.webSocketDebuggerUrl);
let _id = 0; const pending = new Map();
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id != null && pending.has(m.id)) { const { resolve } = pending.get(m.id); pending.delete(m.id); resolve(m.result); }
});
await new Promise((r) => ws.once('open', r));
const evalJs = async (e) => {
  const id = ++_id;
  const p = new Promise((resolve) => pending.set(id, { resolve }));
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: e, returnByValue: true } }));
  const r = await p;
  return r.result?.value;
};

const out = await evalJs(`JSON.stringify({
  total: document.querySelectorAll('.msg').length,
  authorTallies: (() => {
    const counts = {};
    for (const el of document.querySelectorAll('.msg-author')) {
      const a = el.innerText;
      counts[a] = (counts[a] ?? 0) + 1;
    }
    return Object.entries(counts).sort((x,y) => y[1]-x[1]).slice(0, 20);
  })(),
  bodyTallies: (() => {
    const counts = {};
    for (const el of document.querySelectorAll('.msg-body')) {
      const b = (el.innerText || '').slice(0, 80);
      counts[b] = (counts[b] ?? 0) + 1;
    }
    return Object.entries(counts).sort((x,y) => y[1]-x[1]).slice(0, 20);
  })(),
  // First and last 8 messages by document order, to see flood ranges
  first: Array.from(document.querySelectorAll('.msg')).slice(0, 8).map(el => ({
    author: el.querySelector('.msg-author')?.innerText ?? '',
    body:   (el.querySelector('.msg-body')?.innerText ?? '').slice(0, 80),
  })),
  last: Array.from(document.querySelectorAll('.msg')).slice(-8).map(el => ({
    author: el.querySelector('.msg-author')?.innerText ?? '',
    body:   (el.querySelector('.msg-body')?.innerText ?? '').slice(0, 80),
  })),
}, null, 2)`);
console.log(out);
ws.close();
