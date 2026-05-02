// brains/chatgpt-cdp.mjs — drives chatgpt.com via CDP
import * as cdp from './cdp.mjs';

export const name = 'chatgpt-cdp';
export const description = 'ChatGPT.com via Chrome DevTools Protocol. Tab keeps its own history.';
export const requires = ['targetId'];
export const homeUrl = 'https://chatgpt.com/';
export const urlMatch = /chatgpt\.com|chat\.openai\.com/;

const POLL_SCRIPT = `
(() => {
  // Stop-button detection. Only use signals that are NOT translated by the UI:
  //   - data-testid (test hooks, locale-stable by convention)
  //   - id (also locale-stable)
  //   - DOM-state markers (data-is-streaming, .result-streaming)
  // Avoid aria-label/visible text — those get i18n'd and overmatch.
  const stopBtn =
    document.querySelector('button[data-testid="stop-button"]') ||
    document.querySelector('button[data-testid="composer-stop-button"]') ||
    document.querySelector('button[data-testid="fruitjuice-stop-button"]') ||
    document.querySelector('button#stop-button') ||
    document.querySelector('button#composer-stop-button');
  const flag =
    document.querySelector('[data-is-streaming="true"]') ||
    document.querySelector('.result-streaming');
  const streaming = !!stopBtn || !!flag;
  const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
  const last = msgs[msgs.length - 1];
  if (!last) return { id: null, text: '', streaming };
  const content = last.querySelector('.markdown, .prose, [class*="markdown"]') || last;
  return {
    id: last.getAttribute('data-message-id'),
    text: content.innerText || '',
    streaming
  };
})()
`;

function buildInject(message) {
  return `
(() => {
  const ta = document.querySelector('#prompt-textarea');
  if (!ta) return false;
  ta.focus();
  const text = ${JSON.stringify(message)};
  const lines = text.split('\\n');
  ta.innerHTML = lines.map(l => {
    const safe = l.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'})[c]);
    return '<p>' + (safe || '<br>') + '</p>';
  }).join('');
  ta.dispatchEvent(new InputEvent('input', { bubbles: true }));
  setTimeout(() => {
    // Locale-stable selectors only. id and data-testid don't translate.
    const btn = document.querySelector(
      '#composer-submit-button, ' +
      'button[data-testid="send-button"], ' +
      'button[data-testid="composer-send-button"], ' +
      'button[data-testid="fruitjuice-send-button"]'
    );
    if (btn) btn.click();
  }, 120);
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
