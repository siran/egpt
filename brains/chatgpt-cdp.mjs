// brains/chatgpt-cdp.mjs — drives chatgpt.com via CDP
import * as cdp from './cdp.mjs';

export const name = 'chatgpt-cdp';
export const description = 'ChatGPT.com via Chrome DevTools Protocol. Tab keeps its own history.';
export const requires = ['targetId'];
export const homeUrl = 'https://chatgpt.com/';
export const urlMatch = /chatgpt\.com|chat\.openai\.com/;

const POLL_SCRIPT = `
(() => {
  // Stop button: localized aria-labels + testids + ids.
  const stopBtn =
    document.querySelector('button[data-testid="stop-button"]') ||
    document.querySelector('button[data-testid="composer-stop-button"]') ||
    document.querySelector('button#stop-button') ||
    document.querySelector('button[aria-label*="Stop" i]') ||
    document.querySelector('button[aria-label*="Detener" i]') ||
    document.querySelector('button[aria-label*="Arrêter" i]') ||
    document.querySelector('button[aria-label*="Stoppen" i]') ||
    document.querySelector('button[aria-label*="Stoppa" i]') ||
    document.querySelector('button[aria-label*="Para" i]');
  // Backup: any element flagged streaming.
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
    const btn = document.querySelector(
      '#composer-submit-button, button[data-testid="send-button"], button[aria-label*="Send" i]'
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
