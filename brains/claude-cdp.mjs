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
  const stopBtn =
    document.querySelector('button[aria-label*="Stop" i]') ||
    document.querySelector('button[aria-label*="Detener" i]') ||
    document.querySelector('button[aria-label*="Arrêter" i]') ||
    document.querySelector('button[aria-label*="Stoppen" i]') ||
    document.querySelector('button[data-testid*="stop" i]');
  const flag = document.querySelector('[data-is-streaming="true"]');
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

  try {
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(editor);
    sel.addRange(range);
    document.execCommand('insertText', false, text);
  } catch {
    const lines = text.split('\\n');
    editor.innerHTML = lines.map(l => {
      const safe = l.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'})[c]);
      return '<p>' + (safe || '<br>') + '</p>';
    }).join('');
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }

  setTimeout(() => {
    const btn = document.querySelector(
      'button[aria-label*="Send" i], button[aria-label*="message" i], button[type="submit"]'
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
