// brains/chatgpt-cdp.mjs — drives chatgpt.com via CDP
import * as cdp from '../../src/tools/cdp.mjs';

export const name = 'chatgpt-cdp';
export const description = 'ChatGPT.com via Chrome DevTools Protocol. Tab keeps its own history.';
export const requires = ['targetId'];
export const homeUrl = 'https://chatgpt.com/';
export const urlMatch = /chatgpt\.com|chat\.openai\.com/;

// The DOM poll heuristic (locale-stable) + the inject builder are EXPORTED so the room
// relay (design B, phase 4) can drive them through streamFromTab directly —
// `streamFromTab(targetId, adapter.injectScript(text), adapter.pollScript)`. stream()/peek()
// below reuse the same two, so the adapter has ONE source of truth for its page knowledge.
//
// Stop-button detection. Only use signals that are NOT translated by the UI:
//   - data-testid (test hooks, locale-stable by convention)
//   - id (also locale-stable)
// Avoid aria-label/visible text — those get i18n'd and overmatch. ONE list, read by the poll
// ("is a reply streaming?") and by injectScript ("may I send, or would I press Stop?").
const STOP_SELECTOR = [
  'button[data-testid="stop-button"]',
  'button[data-testid="composer-stop-button"]',
  'button[data-testid="fruitjuice-stop-button"]',
  'button#stop-button',
  'button#composer-stop-button',
].join(', ');

export const pollScript = `
(() => {
  // DOM-state markers (data-is-streaming, .result-streaming) count as streaming too.
  const stopBtn = document.querySelector(${JSON.stringify(STOP_SELECTOR)});
  const flag =
    document.querySelector('[data-is-streaming="true"]') ||
    document.querySelector('.result-streaming');
  const streaming = !!stopBtn || !!flag;
  const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
  // EVERY assistant id on the page, not just the last one's (kg, 2026-09-25, room tpoef):
  // streamFromTab records them before the send and never takes text from any of them, so a
  // moment in which the previous answer is last again cannot hand its text in as the reply.
  const ids = Array.from(msgs, (m) => m.getAttribute('data-message-id')).filter(Boolean);
  const last = msgs[msgs.length - 1];
  if (!last) return { id: null, ids, text: '', streaming, copyShown: false };
  // THE REPLY IS ITS BODY (kg, 2026-09-24, room tpoef). A reasoning model's message is on the
  // page before it has one, and its only text then is a status line ("Thinking" - localized,
  // so this keys on structure, never on the word). Read whole, that line was taken for the
  // answer: it does not change while the model thinks, so streamFromTab's end rules finished
  // on it and the real reply never came back. No body -> no text, and both end rules need
  // text, so a reasoning phase can end nothing. A turn that FINISHED with no body - nothing
  // streaming and its copy action shown - is read whole, so a reply rendered some other way
  // is still captured.
  const body = last.querySelector('.markdown, .prose, [class*="markdown"]');
  const turn = last.closest('article, [data-testid^="conversation-turn"]') || last;
  // THE REPLY'S OWN "FINISHED" MARKER (operator 2026-09-25: "just make sure no text is lost on
  // replies"). A turn shows its Copy action once its reply is done (measured on the live tab),
  // and streamFromTab ends on THAT - not on text that stopped changing, which a mid-answer
  // pause (web search, running code) also does, nor on the stop button, whose selectors can
  // miss the current page. Reported for the last message; streamFromTab reads it only when
  // that message is the new reply.
  const copyShown = !!turn.querySelector('[data-testid="copy-turn-action-button"]');
  const finished = !streaming && copyShown;
  return {
    id: last.getAttribute('data-message-id'),
    ids,
    text: body ? (body.innerText || '') : (finished ? (last.innerText || '') : ''),
    streaming,
    copyShown
  };
})()
`;

// THE REPLY, VERBATIM, THROUGH ITS OWN COPY (operator 2026-09-25: "chatgpt is rendering html at
// times, or ascii, or latex, you should copy back verbatim"). The page holds only the rendering -
// KaTeX leaves "n(ω)", no TeX annotation - but the turn's Copy action writes the source to the
// clipboard (measured on the live tab: navigator.clipboard.write, text/plain "\\(n(\\omega)\\)").
// So streamFromTab, once a reply is done, runs this against that reply's id: the page's clipboard
// writes are caught in a variable for the length of one click - the OS clipboard is never
// written - and put back in a finally. Resolves { text } or { text: null, error } for the log.
export function copyScript(messageId) {
  return `
(async () => {
  const id = ${JSON.stringify(messageId)};
  const el = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'))
    .find((m) => m.getAttribute('data-message-id') === id);
  if (!el) return { text: null, error: 'the reply is not on the page' };
  const turn = el.closest('article, [data-testid^="conversation-turn"]');
  const btn = turn && turn.querySelector('[data-testid="copy-turn-action-button"]');
  if (!btn) return { text: null, error: 'the reply has no copy button' };
  const cb = navigator.clipboard;
  if (!cb) return { text: null, error: 'the page has no clipboard API' };
  const own = (k) => Object.prototype.hasOwnProperty.call(cb, k);
  const saved = { write: [own('write'), cb.write], writeText: [own('writeText'), cb.writeText] };
  let copied = null;
  let wrote;
  const written = new Promise((r) => { wrote = r; });
  cb.writeText = async (t) => { copied = String(t); wrote(); };
  cb.write = async (items) => {
    try {
      for (const it of items) {
        if (!it.types || !it.types.includes('text/plain')) continue;
        copied = await (await it.getType('text/plain')).text();
        break;
      }
    } finally { wrote(); }
  };
  try {
    btn.click();
    await Promise.race([written, new Promise((r) => setTimeout(r, 1500))]);
  } finally {
    for (const k of ['write', 'writeText']) {
      if (saved[k][0]) cb[k] = saved[k][1]; else delete cb[k];
    }
  }
  return copied ? { text: copied } : { text: null, error: 'the copy wrote nothing' };
})()
`;
}

export function injectScript(message, ask = null) {
  return `
(() => {
  const ta = document.querySelector('#prompt-textarea');
  if (!ta) return false;
  // NEVER PRESS STOP (operator 2026-09-25: "just make sure no text is lost on replies"). While a
  // reply is still being written the composer's submit control IS ChatGPT's Stop, so a send now
  // would cut that reply off. Nothing is pasted or clicked: the send is reported as not made.
  if (document.querySelector(${JSON.stringify(STOP_SELECTOR)})) return false;
  ta.focus();
  const contentText = ${JSON.stringify(message)};
  const askText = ${JSON.stringify(ask)};

  const currentText = (el) => ('value' in el ? el.value : el.innerText) || '';
  const hasContent = (el) => {
    const probe = contentText.slice(0, Math.min(80, contentText.length));
    const cur = currentText(el);
    return contentText.length === 0 || cur.includes(probe) || cur.length >= Math.min(contentText.length, 200);
  };
  const isDisabled = (el) =>
    !el ||
    el.disabled ||
    el.getAttribute('disabled') !== null ||
    el.getAttribute('aria-disabled') === 'true' ||
    el.closest('[aria-disabled="true"]');
  const looksLikeVoiceButton = (el) =>
    /voice|dictation|audio/i.test(el.getAttribute('aria-label') || '');
  // A control that stops the reply is never a send button, whatever selector found it: its
  // data-testid first (locale-stable), then an English aria-label as a second net for a testid
  // the stop list above does not know yet.
  const looksLikeStopButton = (el) =>
    /stop/i.test(el.getAttribute('data-testid') || '') || /stop/i.test(el.getAttribute('aria-label') || '');
  const findSendButton = () => {
    const selectors = [
      '#composer-submit-button',
      'button[data-testid="send-button"]',
      'button[data-testid="composer-send-button"]',
      'button[data-testid="fruitjuice-send-button"]',
      'button[aria-label*="Send" i]',
      'form button[type="submit"]',
    ];
    for (const selector of selectors) {
      const btn = document.querySelector(selector);
      if (btn && !isDisabled(btn) && !looksLikeStopButton(btn)) return btn;
    }
    const composerBtn = document.querySelector('button.composer-submit-button-color');
    if (composerBtn && !isDisabled(composerBtn) && !looksLikeVoiceButton(composerBtn) && !looksLikeStopButton(composerBtn)) return composerBtn;
    return null;
  };
  const htmlFromText = (value) => value.split('\\n').map(l => {
    const safe = l.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'})[c]);
    return '<p>' + (safe || '<br>') + '</p>';
  }).join('');
  const fallbackSetContent = (el) => {
    if ('value' in el) el.value = contentText;
    else el.innerHTML = htmlFromText(contentText);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: contentText }));
  };
  const clearEditor = (el) => {
    if ('value' in el) el.value = '';
    else el.innerHTML = '';
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
  };
  const pasteContent = (el) => {
    clearEditor(el);
    try {
      const data = new DataTransfer();
      data.setData('text/plain', contentText);
      el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    } catch { return false; }
    return true;
  };
  // Type (not paste) the ask prompt after content has landed.
  const typeAsk = (el) => {
    if (!askText) return;
    const appendStr = '\\n\\n' + askText;
    if ('value' in el) {
      el.value += appendStr;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: appendStr }));
    } else {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('insertText', false, appendStr);
    }
  };

  pasteContent(ta);
  let attempts = 0;
  let usedFallback = false;
  let askDone = !askText;
  const trySubmit = () => {
    attempts++;
    if (!usedFallback && attempts >= 6 && !hasContent(ta)) {
      fallbackSetContent(ta);
      usedFallback = true;
    }
    if (hasContent(ta)) {
      if (!askDone) {
        typeAsk(ta);
        askDone = true;
        // Give React one tick to process the input event and re-enable the button.
        if (attempts < 50) setTimeout(trySubmit, 100);
        return;
      }
      const btn = findSendButton();
      if (btn) { btn.click(); return; }
    }
    if (attempts < 50) setTimeout(trySubmit, 100);
  };
  setTimeout(trySubmit, 100);
  return true;
})()
`;
}

export function stream({ message, ask = null }, onUpdate, options = {}) {
  return cdp.streamFromTab({
    targetId: options.targetId,
    injectScript: injectScript(message, ask),
    pollScript,
    copyScript,
    onUpdate,
    onLog: options.onLog,
  });
}

export async function peek(options = {}) {
  if (!options.targetId) throw new Error('no tab bound to this session');
  return cdp.peekTab(options.targetId, pollScript);
}
