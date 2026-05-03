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

  const currentText = (el) => ('value' in el ? el.value : el.innerText) || '';
  const hasText = (el) => {
    const probe = text.slice(0, Math.min(80, text.length));
    const cur = currentText(el);
    return text.length === 0 || cur.includes(probe) || cur.length >= Math.min(text.length, 200);
  };
  const isDisabled = (el) =>
    !el ||
    el.disabled ||
    el.getAttribute('disabled') !== null ||
    el.getAttribute('aria-disabled') === 'true' ||
    el.closest('[aria-disabled="true"]');
  const looksLikeVoiceButton = (el) =>
    /voice|dictation|audio/i.test(el.getAttribute('aria-label') || '');
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
      if (btn && !isDisabled(btn)) return btn;
    }
    const composerBtn = document.querySelector('button.composer-submit-button-color');
    if (composerBtn && !isDisabled(composerBtn) && !looksLikeVoiceButton(composerBtn)) return composerBtn;
    return null;
  };
  const htmlFromText = (value) => value.split('\\n').map(l => {
    const safe = l.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'})[c]);
    return '<p>' + (safe || '<br>') + '</p>';
  }).join('');
  const fallbackSetWholeValue = (el) => {
    if ('value' in el) el.value = text;
    else el.innerHTML = htmlFromText(text);
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertFromPaste',
      data: text,
    }));
  };
  const clearEditor = (el) => {
    if ('value' in el) el.value = '';
    else el.innerHTML = '';
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
  };
  const pasteWholeValue = (el) => {
    clearEditor(el);
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

  pasteWholeValue(ta);
  let attempts = 0;
  let usedFallback = false;
  const trySubmit = () => {
    attempts++;
    if (!usedFallback && attempts >= 6 && !hasText(ta)) {
      fallbackSetWholeValue(ta);
      usedFallback = true;
    }
    if (hasText(ta)) {
      const btn = findSendButton();
      if (btn) {
        btn.click();
        return;
      }
    }
    if (attempts < 50) setTimeout(trySubmit, 100);
  };
  setTimeout(trySubmit, 100);
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
