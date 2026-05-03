// brains/claude-cdp.mjs — drives claude.ai via CDP
// Selectors are best-effort against current claude.ai DOM (may need tweaking).
import * as cdp from './cdp.mjs';

export const name = 'claude-cdp';
export const description = 'Claude.ai via Chrome DevTools Protocol. Tab keeps its own history.';
export const requires = ['targetId'];
export const homeUrl = 'https://claude.ai/new';
export const urlMatch = /claude\.ai/;

const POLL_SCRIPT = `
(() => {
  // Locale-stable signals only (data-testid + DOM state). aria-label is i18n'd.
  const stopBtn =
    document.querySelector('button[data-testid*="stop" i]') ||
    document.querySelector('button[data-testid="stop-button"]') ||
    document.querySelector('button[data-testid*="cancel" i]') ||
    document.querySelector('button#stop-button');
  const flag =
    document.querySelector('[data-is-streaming="true"]') ||
    document.querySelector('[data-is-streaming]:not([data-is-streaming="false"])');
  const streaming = !!stopBtn || !!flag;
  const msgs = document.querySelectorAll('.font-claude-message');
  const last = msgs[msgs.length - 1];
  if (!last) {
    const any = document.querySelectorAll('[data-test-render-count]');
    const fb = any[any.length - 1];
    if (!fb) return { id: null, text: '', streaming };
    return {
      id: 'rc:' + (fb.getAttribute('data-test-render-count') || any.length),
      text: fb.innerText || '',
      streaming
    };
  }
  return {
    id: 'fc:' + msgs.length + ':' + (last.innerText.length || 0),
    text: last.innerText || '',
    streaming
  };
})()
`;

function buildInject(message, ask = null) {
  return `
(() => {
  const editor = document.querySelector(
    'div[contenteditable="true"][role="textbox"], div.ProseMirror, div[contenteditable="true"]'
  );
  if (!editor) return false;
  editor.focus();
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
  const findSendButton = () => {
    const selectors = [
      'button[data-testid="send-button"]',
      'button[data-testid*="send" i]',
      'button[aria-label*="Send" i]',
      'button[type="submit"]',
    ];
    for (const selector of selectors) {
      const btn = document.querySelector(selector);
      if (btn && !isDisabled(btn)) return btn;
    }
    return null;
  };
  const htmlFromText = (value) => value.split('\\n').map(l => {
    const safe = l.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'})[c]);
    return '<p>' + (safe || '<br>') + '</p>';
  }).join('');
  const clearEditor = (el) => {
    if ('value' in el) el.value = '';
    else el.innerHTML = '';
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
  };
  const fallbackSetContent = (el) => {
    if ('value' in el) el.value = contentText;
    else el.innerHTML = htmlFromText(contentText);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: contentText }));
  };
  const pasteContent = (el) => {
    clearEditor(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.addRange(range);
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
      // ProseMirror: move cursor to end, then insertText via execCommand
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('insertText', false, appendStr);
    }
  };

  pasteContent(editor);

  let attempts = 0;
  let usedFallback = false;
  let askDone = !askText;
  const trySubmit = () => {
    attempts++;
    if (!usedFallback && attempts >= 6 && !hasContent(editor)) {
      fallbackSetContent(editor);
      usedFallback = true;
    }
    if (hasContent(editor)) {
      if (!askDone) {
        typeAsk(editor);
        askDone = true;
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
    injectScript: buildInject(message, ask),
    pollScript: POLL_SCRIPT,
    onUpdate,
  });
}

export async function peek(options = {}) {
  if (!options.targetId) throw new Error('no tab bound to this session');
  return cdp.peekTab(options.targetId, POLL_SCRIPT);
}
