// Simulate exactly what the content script's scan() does, against
// the live WA tab. Reports: header lookup result, fresh-row flags,
// what would be emitted vs silenced and why. Helps pin down whether
// the recent-fix early-return is too aggressive.

import WebSocket from 'ws';
import { listTabs } from '../tools/cdp.mjs';

const tabs = await listTabs();
const wa = tabs.find(t => /web\.whatsapp\.com/.test(t.url ?? ''));
if (!wa) { console.error('no WA Web tab'); process.exit(1); }

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

const out = await evalJs(`JSON.stringify((() => {
  // — exactly mirror wa-content.js logic —
  const norm = (s) => (s ?? '').replace(/\\s+/g, ' ').trim();
  const firstLine = (s) => norm((s || '').split('\\n')[0]);
  function activeChat() {
    const h = document.querySelector('header span[dir="auto"][title]');
    const raw = h?.getAttribute('title') || h?.innerText || '';
    const n = raw.split('\\n')[0].replace(/\\s+/g, ' ').trim();
    return n || null;
  }

  // Inspect the header in detail — multiple selector candidates
  const header = document.querySelector('header');
  const headerInfo = header ? {
    present: true,
    innerText: (header.innerText || '').slice(0, 200),
    titleSpans: [...header.querySelectorAll('span[dir="auto"][title]')].map(s => s.getAttribute('title')).slice(0, 5),
    autoSpans:  [...header.querySelectorAll('span[dir="auto"]')].map(s => (s.innerText || '').slice(0, 60)).slice(0, 5),
  } : { present: false };

  const chat = activeChat();
  const rowsAll = document.querySelectorAll('[data-id]');
  const ROWS_TO_INSPECT = 10;
  const list = [...rowsAll].slice(-ROWS_TO_INSPECT).map(row => {
    const id = row.getAttribute('data-id');
    const text = (row.querySelector('.copyable-text, [class*="copyable-text"]')?.innerText || '').trim().slice(0, 120);
    const ppt = row.querySelector('[data-pre-plain-text]')?.getAttribute('data-pre-plain-text') || null;
    // ts parse — same as wa-content
    let ts = null;
    if (ppt) {
      const m = ppt.match(/\\[(\\d{1,2}):(\\d{2})(?:\\s*(AM|PM))?,\\s*(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})\\]/i);
      if (m) {
        let [, hh, mn, ampm, mo, da, yr] = m;
        hh = +hh; mn = +mn; mo = +mo; da = +da; yr = +yr;
        if (ampm) { if (ampm.toUpperCase() === 'PM' && hh < 12) hh += 12; if (ampm.toUpperCase() === 'AM' && hh === 12) hh = 0; }
        let cand = new Date(yr, mo - 1, da, hh, mn).getTime();
        if (cand > Date.now() + 86_400_000) cand = new Date(yr, da - 1, mo, hh, mn).getTime();
        ts = cand;
      }
    }
    const ageMin = ts ? Math.round((Date.now() - ts) / 60000) : null;
    return { id: id?.slice(0, 28), ageMin, text, hasPpt: !!ppt };
  });

  return {
    activeChat: chat,
    headerInfo,
    domRowsTotal: rowsAll.length,
    rows: list,
  };
})(), null, 2)`);
console.log(out);
ws.close();
