import WebSocket from 'ws';
const all = await fetch('http://localhost:9221/json').then(r => r.json());
const bus = all.find(t => t.type === 'page' && /bus\.html/.test(t.url ?? ''));
if (!bus) { console.error('no bus tab'); process.exit(1); }

const ws = new WebSocket(bus.webSocketDebuggerUrl);
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

const stats = await evalJs(`JSON.stringify((() => {
  const evs = window.bus?.getEvents?.(0) ?? [];
  const byType = {};
  const byFrom = {};
  for (const e of evs) {
    byType[e.type] = (byType[e.type] ?? 0) + 1;
    byFrom[e.from ?? '?'] = (byFrom[e.from ?? '?'] ?? 0) + 1;
  }
  // First 5 events with body '> /help' to see ts spread
  const helps = evs.filter(e => (e.body ?? '').startsWith('> /help')).slice(0, 5);
  // Last 5 events overall
  const lastEvents = evs.slice(-5);
  const oldest = evs[0]?.ts ?? null;
  const newest = evs[evs.length - 1]?.ts ?? null;
  return {
    total: evs.length,
    byType, byFrom,
    oldestTs: oldest, newestTs: newest,
    oldestAgo: oldest ? Math.round((Date.now() - oldest) / 1000) + 's ago' : null,
    newestAgo: newest ? Math.round((Date.now() - newest) / 1000) + 's ago' : null,
    helpSample: helps.map(e => ({ ts: e.ts, type: e.type, from: e.from, user: e.user, body: e.body, client: e.client, sig: e._sig ? e._sig.slice(0, 12) + '…' : '(none)' })),
    lastEvents: lastEvents.map(e => ({ ts: e.ts, type: e.type, from: e.from, user: e.user, body: (e.body ?? '').slice(0, 60), sig: e._sig ? '✓' : '✗' })),
  };
})(), null, 2)`);
console.log(stats);
ws.close();
