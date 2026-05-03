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

function buildInject(message) {
  return `
(() => {
  const editor = document.querySelector(
    'div[contenteditable="true"][role="textbox"], div.ProseMirror, div[contenteditable="true"]'
  );
  if (!editor) return false;
  editor.focus();
  const text = ${JSON.stringify(message)};

  const currentText = (el) => ('value' in el ? el.value : el.innerText) || '';
  const hasText = (el) => {
    const probe = text.slice(0, Math.min(80, text.length));
    const cur = currentText(el);
    return text.length === 0 || cur.includes(probe) || cur.length >= Math.min(text.length, 200);
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
  const fallbackSetWholeValue = (el) => {
    if ('value' in el) el.value = text;
    else el.innerHTML = htmlFromText(text);
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertFromPaste',
      data: text,
    }));
  };
  const pasteWholeValue = (el) => {
    clearEditor(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.addRange(range);
    try {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      const ev = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      });
      el.dispatchEvent(ev);
    } catch {
      return false;
    }
    return true;
  };

  pasteWholeValue(editor);

  setTimeout(() => {
    if (!hasText(editor)) fallbackSetWholeValue(editor);
    // Locale-stable selectors first. button[type="submit"] is a structural
    // fallback that works regardless of language since "submit" is an HTML
    // attribute value, not user-facing text.
    const btn = document.querySelector(
      'button[data-testid="send-button"], ' +
      'button[data-testid*="send" i], ' +
      'button[type="submit"]'
    );
    if (btn) btn.click();
  }, 200);
  return true;
})()
`;
}

export function stream({ message }, onUpdate, options = {}) {
  return cdp.streamFromTab({
    targetId: options.targetId,
    injectScript: buildInject(message),
    pollScript: POLL_SCRIPT,
    onUpdate,
  });
}

export async function peek(options = {}) {
  if (!options.targetId) throw new Error('no tab bound to this session');
  return cdp.peekTab(options.targetId, POLL_SCRIPT);
}
