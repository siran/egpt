// tools/browser-tools.mjs — CDP control library for operator brains
//
// Import this from an operator script to drive the live Chrome session
// that egpt manages. In a being's session ($EGPT_CDP set) it reaches the chat's
// group Chrome through the spine (cdp.mjs cdpWire); elsewhere Chrome must be running
// with --remote-debugging-port=9221 (cdp.mjs's default — or $EGPT_CDP_HOST must be set).
//
// Pause / resume mechanism:
//   await browser.waitForHuman('message')
//     — writes ~/.egpt/browser-pause.txt; egpt shows a banner
//     — resumes when the user types /continue (which creates browser-continue.txt)
//     — use for: CAPTCHAs, login pages, 2FA, reCAPTCHA / Cloudflare challenges
//
// Quick-start example:
//   import * as browser from '/abs/path/to/egpt/tools/browser-tools.mjs';
//   const id = await browser.openTab('https://amazon.com/s?k=bongo+drums');
//   await browser.waitForLoad(id);
//   const text = await browser.getText(id);
//   await browser.closeTab(id);
//
// From a shell: node browser-tools.mjs <tabUrlPart> list | click <text> | clickFirst <text>
//   | clickSel <css> | type <css> <text> | text [n]

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync, unlinkSync, realpathSync } from 'node:fs';
import { findTab, listTabs, openTab, closeTab, activateTarget, dispatchClick, cdpHost, cdpWire } from './cdp.mjs';
import { EGPT_HOME } from '../egpt-home.mjs';   // profile-aware: EGPT_HOME selects the node

export { openTab, closeTab, cdpHost, EGPT_HOME };

// Low-level: open a short-lived WebSocket to a tab and call one CDP method.
async function cdpCall(targetId, method, params = {}) {
  const tab = await findTab(targetId);
  if (!tab) throw new Error(`Tab ${(targetId ?? '?').slice(0, 8)}… not found`);
  const { WebSocket } = await cdpWire();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    const tmo = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`${method}: timeout`));
    }, 15000);
    ws.addEventListener('open', () =>
      ws.send(JSON.stringify({ id: 1, method, params })));
    ws.addEventListener('message', e => {
      let data; try { data = JSON.parse(e.data.toString()); } catch { return; }
      if (data.id === 1) {
        clearTimeout(tmo);
        try { ws.close(); } catch {}
        if (data.error) reject(new Error(data.error.message));
        else resolve(data.result);
      }
    });
    ws.addEventListener('error', () => {
      clearTimeout(tmo);
      reject(new Error(`${method}: CDP WebSocket error`));
    });
  });
}

// Evaluate a JS expression in the page and return its primitive value.
async function cdpEval(targetId, expression, { awaitPromise = false } = {}) {
  const r = await cdpCall(targetId, 'Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise,
  });
  if (r?.result?.subtype === 'error') throw new Error(r.result.description);
  return r?.result?.value;
}

/** Navigate the tab to a URL. */
export async function navigate(targetId, url) {
  await cdpCall(targetId, 'Page.navigate', { url });
}

/** Wait until document.readyState === 'complete'. */
export async function waitForLoad(targetId, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ready = await cdpEval(targetId, `document.readyState`);
      if (ready === 'complete') return;
    } catch { /* tab still loading */ }
    await new Promise(r => setTimeout(r, 400));
  }
  throw new Error(`waitForLoad: timed out after ${timeoutMs}ms`);
}

/**
 * Extract text from the page.
 * Without a selector, prefers semantic content areas (main, article, etc.)
 * and falls back to body.
 */
export async function getText(targetId, selector = null) {
  const expr = selector
    ? `document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`
    : `(document.querySelector('main,article,[role="main"],#main-content,#content') || document.body)?.innerText ?? ''`;
  return cdpEval(targetId, expr);
}

/** Get the current URL of the tab. */
export async function getUrl(targetId) {
  return cdpEval(targetId, `location.href`);
}

/** Get the document title. */
export async function getTitle(targetId) {
  return cdpEval(targetId, `document.title`);
}

/** Run an arbitrary JS expression in the page and return its primitive value. */
export async function evaluate(targetId, expression) {
  return cdpEval(targetId, expression);
}

const wait = ms => new Promise(r => setTimeout(r, ms));
const bySelector = selector => `document.querySelector(${JSON.stringify(selector)})`;
const VISIBLE_CLICKABLES = `[...document.querySelectorAll('a,button,input[type=submit],input[type=button],input[type=radio],[role=tab],[role=button],label')]
  .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; })`;

// Scroll the element `elExpr` evaluates to into view; its viewport center, or null.
async function centerOf(targetId, elExpr) {
  return cdpEval(targetId, `(() => {
    const el = ${elExpr};
    if (!el) return null;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
}

/** Click an element matched by a CSS selector with a real mouse click at its center. Throws if not found. */
export async function click(targetId, selector) {
  const p = await centerOf(targetId, bySelector(selector));
  if (!p) throw new Error(`click: no element matches "${selector}"`);
  await dispatchClick(targetId, p.x, p.y);
}

/** Click the last (or first) visible link/button/label whose text matches `pattern`, case-insensitive. Throws if none. */
export async function clickText(targetId, pattern, { first = false } = {}) {
  const re = JSON.stringify(pattern.source ?? pattern);
  const p = await centerOf(targetId, `${VISIBLE_CLICKABLES}.filter(e => new RegExp(${re}, 'i').test(e.innerText || e.value || ''))${first ? '[0]' : '.pop()'}`);
  if (!p) throw new Error(`clickText: nothing visible matches "${pattern}"`);
  await dispatchClick(targetId, p.x, p.y);
}

// One keystroke's pause (ms): 25–110, mostly near the fast end; +60–150 after a space or
// punctuation; about 1 in 25 keys also +200–500, a short think.
export function keyDelay(ch, rand = Math.random) {
  let ms = 25 + 85 * rand() ** 2;
  if (/[\s\p{P}]/u.test(ch)) ms += 60 + 90 * rand();
  if (rand() < 0.04) ms += 200 + 300 * rand();
  return Math.round(ms);
}

/** Click an input / textarea / contenteditable, select its content, and type `text` over it one character at a time. */
export async function type(targetId, selector, text, { rand = Math.random, sleep = wait } = {}) {
  const p = await centerOf(targetId, bySelector(selector));
  if (!p) throw new Error(`type: no element matches "${selector}"`);
  await dispatchClick(targetId, p.x, p.y);
  await cdpEval(targetId, `(el => { el.focus(); if (el.select) el.select(); else getSelection().selectAllChildren(el); })(${bySelector(selector)})`);
  for (const ch of text) {
    await cdpCall(targetId, 'Input.insertText', { text: ch });
    await sleep(keyDelay(ch, rand));
  }
}

/** Scroll the page by (x, y) pixels. */
export async function scroll(targetId, x = 0, y = 500) {
  await cdpEval(targetId, `window.scrollBy(${x}, ${y})`);
}

/** Wait until a CSS selector matches at least one element. */
export async function waitForElement(targetId, selector, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ok = await cdpEval(targetId, `!!document.querySelector(${JSON.stringify(selector)})`);
      if (ok) return;
    } catch { /* transient */ }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`waitForElement: "${selector}" not found within ${timeoutMs}ms`);
}

/**
 * Pause the operator and ask the user to act in the browser.
 *
 * Writes ~/.egpt/browser-pause.txt — egpt detects this and shows a banner.
 * Blocks until the user types /continue in egpt (which creates browser-continue.txt).
 *
 * Use this for: CAPTCHAs, Cloudflare challenges, login screens, 2FA prompts,
 * reCAPTCHA iframes, or any time a human click is required.
 */
export async function waitForHuman(message = 'please act in the browser, then type /continue in egpt') {
  const pauseFile    = join(EGPT_HOME, 'browser-pause.txt');
  const continueFile = join(EGPT_HOME, 'browser-continue.txt');
  try { unlinkSync(continueFile); } catch {}
  writeFileSync(pauseFile, message, 'utf8');
  while (true) {
    await new Promise(r => setTimeout(r, 500));
    if (existsSync(continueFile)) {
      try { unlinkSync(continueFile); } catch {}
      try { unlinkSync(pauseFile); } catch {}
      return;
    }
  }
}

const USAGE = 'usage: node browser-tools.mjs <tabUrlPart> list | click <text> | clickFirst <text> | clickSel <css> | type <css> <text> | text [n]';
const ARITY = { list: 0, click: 1, clickFirst: 1, clickSel: 1, type: 2, text: 0 };

/** The shell entry: acts on the first tab whose URL contains `part`, brought to the front. Returns what to print. */
export async function cli([part, cmd, a1, a2] = []) {
  if (!part || !Object.hasOwn(ARITY, cmd) || [a1, a2].slice(0, ARITY[cmd]).includes(undefined)) throw new Error(USAGE);
  const tab = (await listTabs()).find(t => t.url.includes(part));
  if (!tab) throw new Error(`no tab whose url contains "${part}"`);
  const id = tab.id;
  await activateTarget(id);
  switch (cmd) {
    case 'list': return cdpEval(id, `${VISIBLE_CLICKABLES}.map(e => e.tagName + ':' + (e.innerText || e.value || e.id || '').trim().replace(/\\s+/g, ' ').slice(0, 50)).filter(s => !s.endsWith(':')).join(' | ')`);
    case 'click': await clickText(id, a1); return `clicked ${a1}`;
    case 'clickFirst': await clickText(id, a1, { first: true }); return `clicked ${a1}`;
    case 'clickSel': await click(id, a1); return `clicked ${a1}`;
    case 'type': await type(id, a1, a2); return `typed; value=${await cdpEval(id, `(el => el.value ?? el.innerText)(${bySelector(a1)})`)}`;
    case 'text': return [await getUrl(id), await getTitle(id), (await getText(id)).replace(/\s+/g, ' ').slice(0, +a1 || 1500)].join(' || ');
  }
}

// Run as a script: compared through realpathSync.native, as ask-spine.mjs does, so ~/src's junction still counts.
const real = p => { const r = realpathSync.native(p); return process.platform === 'win32' ? r.toLowerCase() : r; };
let invokedDirectly = false;
try { invokedDirectly = !!process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url)); } catch {}
if (invokedDirectly) {
  try { console.log(await cli(process.argv.slice(2))); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
