// One-shot snapshot of where each piece is right now, after the
// 'morgan message not picked up' report.

import WebSocket from 'ws';

const all = await fetch('http://localhost:9221/json').then(r => r.json());
const wa = all.find(t => t.type === 'page' && /web\.whatsapp\.com/.test(t.url ?? ''));
const egpt = all.find(t => t.type === 'page' && /tab\/index\.html/.test(t.url ?? ''));
const buses = all.filter(t => t.type === 'page' && /bus\.html/.test(t.url ?? ''));
const sw = all.find(t => t.type === 'service_worker' && /chrome-extension/.test(t.url ?? ''));

console.log(`WA tab: ${wa ? '✓' : '✗'}    egpt tab: ${egpt ? '✓' : '✗'}    bus tabs: ${buses.length}    SW: ${sw ? '✓' : '✗'}`);

async function eval_(target, expr) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let _id = 0;
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id != null && pending.has(m.id)) { const { resolve } = pending.get(m.id); pending.delete(m.id); resolve(m.result); }
  });
  await new Promise((r) => ws.once('open', r));
  const id = ++_id;
  const p = new Promise((resolve) => pending.set(id, { resolve }));
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
  const r = await p;
  ws.close();
  return r?.result?.value;
}

if (sw) {
  const swState = await eval_(sw, `JSON.stringify({
    busTabPorts:      _busTabPorts?.size      ?? null,
    subscribers:      _subscribers?.size      ?? null,
    waContentPorts:   _waContentPorts?.size   ?? null,
    waCdpSubscribers: _waCdpSubscribers?.size ?? null,
    waContentTabIds:  _waContentPorts ? [..._waContentPorts].map(p => p._waTabId ?? null) : null,
    openInFlight:     _openInFlight ? [..._openInFlight] : null,
    waTabQueueKeys:   _waTabQueues ? [..._waTabQueues.keys()] : null,
  }, null, 2)`);
  console.log('\nSW state:\n' + swState);
}

if (wa) {
  const waState = await eval_(wa, `JSON.stringify((() => {
    const norm = (s) => (s ?? '').replace(/\\s+/g, ' ').trim();
    const firstLine = (s) => norm((s || '').split('\\n')[0]);
    const h = document.querySelector('#main header [data-testid="conversation-info-header"]') ||
              document.querySelector('#main header') ||
              document.querySelector('header [data-testid="conversation-header"]');
    const activeChat = h ? firstLine(h.innerText || '') : null;
    const panel = document.querySelector('[aria-label="Chat list" i]');
    const rows = panel ? [...panel.querySelectorAll('[role="listitem"], div[role="row"]')].slice(0, 12) : [];
    const list = rows.map(row => {
      const titleEl = row.querySelector('span[dir="auto"][title]') || row.querySelector('span[dir="auto"]');
      const name = (titleEl?.getAttribute('title') || titleEl?.innerText || '').trim();
      const unread = !!(row.querySelector('span[aria-label*="unread" i]') || row.querySelector('[data-icon="unread-count"]'));
      const fullText = row.innerText || '';
      const preview = fullText.split('\\n').map(s => s.trim()).filter(line => line && line !== name && !/^\\d+ unread/i.test(line)).join(' ').slice(0, 200);
      const wake = /(?:^|\\s)@(egpt|e)\\b/i.test(preview);
      return { name, unread, wake, preview };
    });
    return { activeChat, panelFound: !!panel, list };
  })(), null, 2)`);
  console.log('\nWA state:\n' + waState);
}

if (egpt) {
  const egptState = await eval_(egpt, `JSON.stringify(
    Array.from(document.querySelectorAll('.msg')).slice(-15).map(el => ({
      author: el.querySelector('.msg-author')?.innerText ?? '',
      body:   el.querySelector('.msg-body')?.innerText?.slice(0, 200) ?? '',
    })), null, 2)`);
  console.log('\nrecent egpt messages:\n' + egptState);
}
