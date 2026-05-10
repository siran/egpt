// Inspect the egpt UI tab's bridge state — is the wa-cdp bridge
// alive, is handleIncomingWaCdp actually wired?

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

// Window globals — App.jsx variables aren't exposed to window unless
// we explicitly attach them. So we can't directly inspect React state.
// But we can inspect the visible message log + sessionsList in the DOM.
const out = await evalJs(`JSON.stringify({
  sessionsTextarea: document.querySelector('textarea')?.value ?? null,
  // Messages already appended (look for any 'me→' tags, indicating
  // handleIncomingWaCdp actually ran):
  msgAuthors: Array.from(document.querySelectorAll('.msg-author'))
    .slice(-30).map(el => el.innerText),
}, null, 2)`);
console.log(out);
ws.close();
