// Look for the recent 'ft9' / 'ft10' messages in WA Web's DOM and
// reason about why the content script may have missed them.

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

const out = await evalJs(`JSON.stringify((() => {
  const norm = (s) => (s ?? '').replace(/\\s+/g, ' ').trim();
  const firstLine = (s) => norm((s || '').split('\\n')[0]);

  // 1. Active chat (the new selector)
  const h = document.querySelector('#main header [data-testid="conversation-info-header"]') ||
            document.querySelector('#main header') ||
            document.querySelector('header [data-testid="conversation-header"]');
  const activeChat = h ? firstLine(h.innerText || '') : null;

  // 2. Last 12 message rows in the active chat
  const rowsAll = document.querySelectorAll('[data-id]');
  const recent = [...rowsAll].slice(-12).map(r => {
    const id = r.getAttribute('data-id');
    const text = (r.querySelector('.copyable-text, [class*="copyable-text"]')?.innerText || '').trim();
    const ppt = r.querySelector('[data-pre-plain-text]')?.getAttribute('data-pre-plain-text') || null;
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
    const ageSec = ts ? Math.round((Date.now() - ts) / 1000) : null;
    return { id: id?.slice(0, 28), ageSec, ppt, text };
  });

  // 3. Look for ft9 / ft10 / @e specifically anywhere in the page
  const allText = document.body.innerText || '';
  const hasFt9  = /\\bft9\\b/.test(allText);
  const hasFt10 = /\\bft10\\b/.test(allText);

  // 4. Check chat-list previews for ft9/ft10 explicitly
  const panel = document.querySelector('[aria-label="Chat list" i]');
  const listMatches = [];
  if (panel) {
    for (const row of panel.querySelectorAll('[role="listitem"], div[role="row"]')) {
      const t = (row.innerText || '');
      if (/ft9|ft10|@e\\s+ft\\d+/i.test(t)) {
        const titleEl = row.querySelector('span[dir="auto"][title]') || row.querySelector('span[dir="auto"]');
        const name = (titleEl?.getAttribute('title') || titleEl?.innerText || '').trim();
        listMatches.push({ name, snippet: t.slice(0, 200) });
      }
    }
  }

  return { activeChat, recent, hasFt9, hasFt10, listMatches };
})(), null, 2)`);
console.log(out);
ws.close();
