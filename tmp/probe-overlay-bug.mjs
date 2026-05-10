// Reproduce the overlay-blocks-click bug, then confirm it's gone with
// the new ordering. Two passes:
//   A) overlay-first (old broken order) — chat-switch should fail
//   B) switch-first (new fixed order)   — chat-switch should succeed
//
// No message is actually sent in either pass (we abort right after
// the title verify so we don't spam your self-DM).

import WebSocket from 'ws';
import { listTabs } from '../tools/cdp.mjs';

const TARGET = '+1 (646) 821-7865';

const tabs = await listTabs();
const wa = tabs.find(t => /web\.whatsapp\.com/.test(t.url ?? ''));
if (!wa) { console.error('no WA Web tab'); process.exit(1); }

async function open() {
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
  const cmd = (method, params) => new Promise((resolve, reject) => {
    const id = ++_id;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalJs = async (e) => {
    const r = await cmd('Runtime.evaluate', { expression: e, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval threw');
    return r.result?.value;
  };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  return { ws, cmd, evalJs, sleep, close: () => ws.close() };
}

const SHOW_OVERLAY = `(() => {
  let el = document.getElementById('__egpt_typing_overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = '__egpt_typing_overlay';
    el.style.cssText = 'position:fixed;inset:0;background:rgba(15,20,25,0.55);color:#fff;font:600 16px system-ui,sans-serif;display:flex;align-items:center;justify-content:center;z-index:2147483647;pointer-events:auto;';
    el.textContent = 'egpt is typing for you…';
    document.body.appendChild(el);
  }
})()`;
const HIDE_OVERLAY = `document.getElementById('__egpt_typing_overlay')?.remove()`;
const HEADER = `(() => {
  const norm = (s) => (s ?? '').replace(/\\s+/g, ' ').trim();
  const firstLine = (s) => norm((s || '').split('\\n')[0]);
  const h = document.querySelector('header [data-testid="conversation-info-header"]') ||
            document.querySelector('header span[dir="auto"][title]') ||
            document.querySelector('header span[dir="auto"]');
  return firstLine(h?.getAttribute?.('title') || h?.innerText || '');
})()`;
const PROBE = (target) => `(() => {
  const norm = (s) => (s ?? '').replace(/\\s+/g, ' ').trim();
  const targetName = ${JSON.stringify(target)};
  const panel = document.querySelector('[aria-label="Chat list" i]') ||
                document.querySelector('[role="grid"][aria-label*="Chat" i]');
  const rows = panel ? panel.querySelectorAll('[role="listitem"], div[role="row"]') : [];
  for (const r of rows) {
    const titleEl = r.querySelector?.('span[dir="auto"][title]') || r.querySelector?.('span[dir="auto"]');
    const t = norm(titleEl?.getAttribute?.('title') || titleEl?.innerText || '');
    if (t === norm(targetName)) {
      try { r.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (_) {}
      const rect = r.getBoundingClientRect();
      return { found: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
  }
  return { found: false };
})()`;

async function trySwitch(label, overlayBefore) {
  const { cmd, evalJs, sleep, close } = await open();
  try {
    await cmd('Page.bringToFront');
    const before = await evalJs(HEADER);
    if (before === TARGET) {
      // Need a different starting chat for the test to be meaningful.
      // Click a non-target row to leave self-DM first.
      const other = await evalJs(PROBE('Lu Lu'));
      if (other.found) {
        for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
          await cmd('Input.dispatchMouseEvent', {
            type, x: other.x, y: other.y,
            button: type === 'mouseMoved' ? 'none' : 'left',
            clickCount: type === 'mouseMoved' ? 0 : 1,
          });
        }
        await sleep(700);
      }
    }
    const start = await evalJs(HEADER);
    if (overlayBefore) await evalJs(SHOW_OVERLAY);
    const v = await evalJs(PROBE(TARGET));
    if (!v.found) throw new Error('row not found');
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await cmd('Input.dispatchMouseEvent', {
        type, x: v.x, y: v.y,
        button: type === 'mouseMoved' ? 'none' : 'left',
        clickCount: type === 'mouseMoved' ? 0 : 1,
      });
    }
    await sleep(800);
    const after = await evalJs(HEADER);
    await evalJs(HIDE_OVERLAY);
    const switched = after === TARGET;
    console.log(`${label}:  start="${start}"  →  after="${after}"  switched=${switched}`);
    return switched;
  } finally {
    await evalJs(HIDE_OVERLAY).catch(() => {});
    close();
  }
}

console.log('— pass A: overlay BEFORE switch (old broken order) —');
const a = await trySwitch('A', /*overlayBefore=*/true);

await new Promise(r => setTimeout(r, 500));

console.log('— pass B: switch BEFORE overlay (new fixed order)   —');
const b = await trySwitch('B', /*overlayBefore=*/false);

console.log();
console.log(`pass A switched: ${a}  (expect: false — overlay swallowed the click)`);
console.log(`pass B switched: ${b}  (expect: true  — switch happened before overlay)`);
process.exit(a === false && b === true ? 0 : 1);
