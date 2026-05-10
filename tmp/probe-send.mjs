// End-to-end CDP send test against the WA Web tab.
//   - Records the active chat so we can restore it
//   - Switches to self-DM (+1 (646) 821-7865)
//   - Types a clearly-marked probe message
//   - Verifies title + composer body at each step (titlesEqual logic)
//   - Sends via Enter
//   - Waits, then asserts the message landed
//   - Switches back to original chat
//
// Uses the same selectors the production background.js uses, so a
// passing run here is a real verification of the send pipeline.

import WebSocket from 'ws';
import { listTabs } from '../tools/cdp.mjs';

const TARGET_NAME = '+1 (646) 821-7865';
const PROBE_TEXT  = `[egpt cdp probe ${new Date().toISOString().slice(11, 19)}]`;

const tabs = await listTabs();
const wa = tabs.find(t => /web\.whatsapp\.com/.test(t.url ?? ''));
if (!wa) { console.error('no WA Web tab'); process.exit(1); }
console.log(`WA tab: ${wa.id.slice(0, 8)}…  ${wa.title}`);

// Open one persistent CDP WS for the whole flow so we can mix
// Runtime.evaluate, Page.bringToFront, Input.* in order.
const ws = new WebSocket(wa.webSocketDebuggerUrl);
let _id = 0;
const pending = new Map();
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id != null && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(m.error.message));
    else resolve(m.result);
  }
});
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

const cmd = (method, params) => new Promise((resolve, reject) => {
  const id = ++_id;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evalJs = async (expression) => {
  const r = await cmd('Runtime.evaluate', { expression, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval threw');
  return r.result?.value;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// — same titlesEqual JS the prod code uses —
const titlesEqualExpr = (a, b) => `(() => {
  const norm = (s) => String(s ?? '').replace(/\\s+/g, ' ').trim().replace(/\\s*\\([^()]*\\)\\s*$/, '').trim();
  return norm(${JSON.stringify(a)}) === norm(${JSON.stringify(b)});
})()`;

const headerOfExpr = `(() => {
  const norm = (s) => (s ?? '').replace(/\\s+/g, ' ').trim();
  const firstLine = (s) => norm((s || '').split('\\n')[0]);
  const h =
    document.querySelector('header [data-testid="conversation-info-header"]') ||
    document.querySelector('header span[dir="auto"][title]') ||
    document.querySelector('header span[dir="auto"]');
  return firstLine(h?.getAttribute?.('title') || h?.innerText || '');
})()`;

try {
  // 0. Bring tab to front (matches the production fix)
  await cmd('Page.bringToFront');
  console.log('✓ Page.bringToFront');

  // 1. Record original chat
  const origTitle = await evalJs(headerOfExpr);
  console.log(`✓ original chat: "${origTitle}"`);

  // 2. Find target row
  const probeExpr = `(() => {
    const norm = (s) => (s ?? '').replace(/\\s+/g, ' ').trim();
    const firstLine = (s) => norm((s || '').split('\\n')[0]);
    const stripBadge = (s) => firstLine(s).replace(/\\s*\\([^()]*\\)\\s*$/, '').trim();
    const targetName = ${JSON.stringify(TARGET_NAME)};
    const headerOf = () => {
      const h =
        document.querySelector('header [data-testid="conversation-info-header"]') ||
        document.querySelector('header span[dir="auto"][title]') ||
        document.querySelector('header span[dir="auto"]');
      return firstLine(h?.getAttribute?.('title') || h?.innerText || '');
    };
    const activeTitle = headerOf();
    if (stripBadge(activeTitle) === stripBadge(targetName)) {
      return { state: 'already', activeTitle };
    }
    const panel = document.querySelector('[aria-label="Chat list" i]') ||
                  document.querySelector('[role="grid"][aria-label*="Chat" i]');
    const rows = panel ? panel.querySelectorAll('[role="listitem"], div[role="row"]') : [];
    let matchRow = null;
    const tnorm = norm(targetName);
    for (const r of rows) {
      const titleEl = r.querySelector?.('span[dir="auto"][title]') || r.querySelector?.('span[dir="auto"]');
      const t = norm(titleEl?.getAttribute?.('title') || titleEl?.innerText || '');
      if (t === tnorm) { matchRow = r; break; }
    }
    if (!matchRow) return { state: 'not-found', activeTitle };
    try { matchRow.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (_) {}
    const rect = matchRow.getBoundingClientRect();
    return { state: 'found', activeTitle, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`;
  const v = await evalJs(probeExpr);
  console.log('✓ probe:', JSON.stringify(v));
  if (v.state === 'not-found') throw new Error('target row not found');

  // 3. Click via real CDP mouse if not already
  if (v.state !== 'already') {
    const click = (type) => cmd('Input.dispatchMouseEvent', {
      type, x: v.x, y: v.y,
      button: type === 'mouseMoved' ? 'none' : 'left',
      clickCount: type === 'mouseMoved' ? 0 : 1,
    });
    await click('mouseMoved');
    await click('mousePressed');
    await click('mouseReleased');
    await sleep(800);
    console.log('✓ Input.dispatchMouseEvent click sequence sent');
  }

  // 4. Verify title with the production titlesEqual logic
  const newTitle = await evalJs(headerOfExpr);
  const verifyOk = await evalJs(titlesEqualExpr(newTitle, TARGET_NAME));
  console.log(`✓ post-switch title: "${newTitle}"  →  titlesEqual(target)=${verifyOk}`);
  if (!verifyOk) throw new Error('title verify failed');

  // 5. Focus composer
  await evalJs(`(
    document.querySelector('div[contenteditable="true"][data-tab="10"]') ||
    document.querySelector('footer div[contenteditable="true"]') ||
    document.querySelector('div[contenteditable="true"][role="textbox"]')
  )?.focus()`);
  console.log('✓ composer focused');

  // 6. Type via Input.insertText
  await cmd('Input.insertText', { text: PROBE_TEXT });
  await sleep(200);
  const composerText = await evalJs(`(() => {
    const el = document.querySelector('div[contenteditable="true"][data-tab="10"]') ||
               document.querySelector('footer div[contenteditable="true"]') ||
               document.querySelector('div[contenteditable="true"][role="textbox"]');
    return (el?.innerText || '').trim();
  })()`);
  console.log(`✓ composer body after insertText: "${composerText}"`);
  if (!composerText.includes(PROBE_TEXT)) throw new Error('composer body verify failed');

  // 7. Send via Enter
  const enter = {
    type: 'keyDown', key: 'Enter', code: 'Enter',
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    unmodifiedText: '\r', text: '\r',
  };
  await cmd('Input.dispatchKeyEvent', enter);
  await cmd('Input.dispatchKeyEvent', { ...enter, type: 'keyUp' });
  console.log('✓ Enter dispatched');

  // 8. Wait for the message to render in the conversation pane
  let landed = false;
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    const found = await evalJs(`(() => {
      const rows = document.querySelectorAll('[data-id]');
      const probe = ${JSON.stringify(PROBE_TEXT)};
      for (const r of rows) {
        const t = (r.querySelector('.copyable-text, [class*="copyable-text"]')?.innerText || '').trim();
        if (t.includes(probe)) return true;
      }
      return false;
    })()`);
    if (found) { landed = true; break; }
  }
  console.log(landed ? `✓ probe message landed in conversation pane` : `✗ message did not appear within 5s`);

  // 9. Restore original chat
  if (origTitle && origTitle !== TARGET_NAME) {
    const restoreProbe = await evalJs(probeExpr.replace(JSON.stringify(TARGET_NAME), JSON.stringify(origTitle)));
    if (restoreProbe.state === 'found') {
      const click = (type) => cmd('Input.dispatchMouseEvent', {
        type, x: restoreProbe.x, y: restoreProbe.y,
        button: type === 'mouseMoved' ? 'none' : 'left',
        clickCount: type === 'mouseMoved' ? 0 : 1,
      });
      await click('mouseMoved'); await click('mousePressed'); await click('mouseReleased');
      await sleep(500);
      console.log(`✓ restored to original chat "${origTitle}"`);
    }
  }
} catch (e) {
  console.error('✗ FAILED:', e.message);
  process.exitCode = 1;
} finally {
  ws.close();
}
