// What's the actual DOM structure of WA Web's conversation header?
// activeChat() returns null but there are 20 message rows in DOM,
// so the chat IS open — selector just doesn't match. Find what does.

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

const out = await evalJs(`JSON.stringify((() => {
  // 1. All header elements
  const headers = [...document.querySelectorAll('header')];
  const headerSummary = headers.map((h, i) => ({
    idx: i,
    childCount: h.children.length,
    innerText: (h.innerText || '').slice(0, 200),
    htmlPrefix: h.outerHTML.slice(0, 400),
  }));

  // 2. Find a recent row and walk up — what panel is it in?
  const rows = document.querySelectorAll('[data-id]');
  const lastRow = rows[rows.length - 1];
  let walk = [];
  if (lastRow) {
    let cur = lastRow;
    let i = 0;
    while (cur && i < 12) {
      walk.push({
        tag: cur.tagName,
        id: cur.id || null,
        cls: (cur.className || '').toString().slice(0, 80),
        role: cur.getAttribute?.('role') || null,
        aria: cur.getAttribute?.('aria-label') || null,
        dataTab: cur.getAttribute?.('data-tab') || null,
      });
      cur = cur.parentElement;
      i++;
    }
  }

  // 3. Try alternative header lookups commonly used by WA Web
  const candidates = [
    ['header [title]', '[title] in any header'],
    ['#main header', 'header inside #main'],
    ['#main header span', 'span inside #main header'],
    ['#main header div[role="button"]', 'header button (chat-info trigger)'],
    ['div#main header', 'div#main header (alt)'],
    ['[data-tab="6"] header', 'data-tab=6 header'],
    ['._amid header', 'class-prefixed header'],
  ];
  const results = candidates.map(([sel, label]) => {
    const els = document.querySelectorAll(sel);
    return {
      selector: sel,
      label,
      count: els.length,
      sample: els[0] ? {
        innerText: (els[0].innerText || '').slice(0, 100),
        title: els[0].getAttribute?.('title'),
      } : null,
    };
  });

  // 4. Last-resort: page <title>
  const pageTitle = document.title;

  return { headerSummary, lastRowAncestry: walk, candidates: results, pageTitle };
})(), null, 2)`);
console.log(out);
ws.close();
