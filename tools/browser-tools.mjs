// tools/browser-tools.mjs — CDP control library for operator brains
//
// Import this from an operator script to drive the live Chrome session
// that egpt manages. Chrome must be running with --remote-debugging-port=9222
// (or $EGPT_CDP_HOST must be set).
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

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { findTab, openTab, closeTab, cdpHost } from './cdp.mjs';

export { openTab, closeTab, cdpHost };
export const EGPT_HOME = join(homedir(), '.egpt');

// Low-level: open a short-lived WebSocket to a tab and call one CDP method.
async function cdpCall(targetId, method, params = {}) {
  const tab = await findTab(targetId);
  if (!tab) throw new Error(`Tab ${(targetId ?? '?').slice(0, 8)}… not found`);
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

/** Click an element matched by a CSS selector. Throws if not found. */
export async function click(targetId, selector) {
  const ok = await cdpEval(targetId, `(function() {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.click();
    return true;
  })()`);
  if (!ok) throw new Error(`click: no element matches "${selector}"`);
}

/** Set the value of an input / textarea and fire an input event. */
export async function type(targetId, selector, text) {
  const ok = await cdpEval(targetId, `(function() {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.focus();
    if ('value' in el) {
      el.value = ${JSON.stringify(text)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      el.innerHTML = '';
      document.execCommand('insertText', false, ${JSON.stringify(text)});
    }
    return true;
  })()`);
  if (!ok) throw new Error(`type: no element matches "${selector}"`);
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
