// Read the content script's internal state by attaching to the WA
// tab and walking execution contexts to find the isolated world the
// content script runs in. The isolated world has its own `window`
// where __egptWaContentInstalled lives.

import WebSocket from 'ws';

const all = await fetch('http://localhost:9221/json').then(r => r.json());
const wa = all.find(t => t.type === 'page' && /web\.whatsapp\.com/.test(t.url ?? ''));
if (!wa) { console.error('no WA tab'); process.exit(1); }

const ws = new WebSocket(wa.webSocketDebuggerUrl);
let _id = 0;
const pending = new Map();
const ctxs = [];

ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.method === 'Runtime.executionContextCreated') {
    ctxs.push(m.params.context);
  }
  if (m.id != null && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
  }
});
await new Promise((r) => ws.once('open', r));
const cmd = (method, params) => new Promise((resolve, reject) => {
  const id = ++_id;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});

// Enable Runtime to receive executionContextCreated events for ALL
// existing contexts (replayed on enable).
await cmd('Runtime.enable');
// Give it a moment to flush context-created events.
await new Promise(r => setTimeout(r, 300));

console.log('execution contexts:');
for (const c of ctxs) {
  console.log(`  id=${c.id}  origin=${c.origin}  name=${JSON.stringify(c.name)}  uniqueId=${c.uniqueId?.slice(-12)}`);
}

// Find the content-script isolated world. WA's manifest matches
// web.whatsapp.com, so the extension's content script gets its own
// isolated world labeled with the extension id or as 'isolated'.
// Try to find by name prefix or by NOT being the main world.
const main = ctxs.find(c => c.auxData?.isDefault === true);
const isolated = ctxs.find(c =>
  c.auxData?.isDefault !== true &&
  /chrome-extension|isolated/i.test(c.name + (c.auxData?.type ?? ''))
);
console.log('\nmain world:', main?.id, main?.name);
console.log('isolated world:', isolated?.id, isolated?.name);

if (isolated) {
  const r = await cmd('Runtime.evaluate', {
    contextId: isolated.id,
    expression: `JSON.stringify({
      installed: window.__egptWaContentInstalled === true,
      hasObserver: typeof MutationObserver === 'function',
    })`,
    returnByValue: true,
  });
  console.log('\nisolated world probe:', r.result?.value);
}

// Also try ALL contexts to find which one has our flag
console.log('\n— scanning all contexts for __egptWaContentInstalled —');
for (const c of ctxs) {
  try {
    const r = await cmd('Runtime.evaluate', {
      contextId: c.id,
      expression: `({ flag: window.__egptWaContentInstalled === true })`,
      returnByValue: true,
    });
    if (r.result?.value?.flag) {
      console.log(`  ✓ context id=${c.id} name=${c.name} HAS the flag`);
    }
  } catch (e) {
    // some contexts may have been destroyed already
  }
}

ws.close();
