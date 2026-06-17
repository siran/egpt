import { describe, it, expect } from 'vitest';

import {
  escapeHtml,
  mdToTgHtml,
  isBrainAuthor,
  formatItemForTelegram,
  formatItemForWhatsApp,
} from '../src/item-format.mjs';

const opts = {
  egptEmoji: 'E',
  userEmoji: 'U',
  userName: 'An',
  surfaceTag: 'node1',
  authorEmojiOptions: {
    egpt_emoji: 'E',
    user_emoji: 'U',
    user_name: 'An',
    persona_emoji: 'P',
    human_emoji: 'H',
  },
};

describe('item-format bridge renderers', () => {
  it('escapeHtml protects Telegram HTML bodies', () => {
    expect(escapeHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });

  it('mdToTgHtml escapes first, then applies simple markdown tags', () => {
    expect(mdToTgHtml('**bold** and `x<y`')).toBe('<b>bold</b> and <code>x&lt;y</code>');
    expect(mdToTgHtml('```js\nif (a < b) {}\n```')).toBe('<pre>if (a &lt; b) {}</pre>');
  });

  it('formatItemForTelegram handles system, user, and brain items', () => {
    expect(formatItemForTelegram({ author: 'system', body: '<ok>' }, {}, opts))
      .toBe('E <b>egpt@node1</b>\n<i>&lt;ok&gt;</i>');
    expect(formatItemForTelegram({ author: 'system', body: 'ignored', _tgBody: 'custom tg' }, {}, opts))
      .toBe('custom tg');
    expect(formatItemForTelegram({ author: 'You', body: 'hi <x>' }, {}, opts))
      .toBe('U <b>An@node1</b>\nhi &lt;x&gt;');
    expect(formatItemForTelegram({ author: 'e', body: '**yes**' }, { e: { emoji: 'dog' } }, opts))
      .toBe('P <b>e@node1</b>\n<b>yes</b>');
    expect(formatItemForTelegram({ author: 'codex@peer', body: 'ok' }, {}, opts))
      .toBe('❓ <b>codex@peer</b>\nok');
  });

  it('isBrainAuthor matches system, egpt aliases, and configured sessions', () => {
    expect(isBrainAuthor({ author: 'system' }, {})).toBe(true);
    expect(isBrainAuthor({ author: 'e@node' }, {})).toBe(true);
    expect(isBrainAuthor({ author: 'cx@node' }, { cx: { brain: 'ccode' } })).toBe(true);
    expect(isBrainAuthor({ author: 'An' }, {})).toBe(false);
  });

  it('formatItemForWhatsApp obeys mirror header policy', () => {
    const sessions = { cx: { emoji: 'C' } };
    expect(formatItemForWhatsApp({ author: 'system', body: 'sys' }, sessions, opts))
      .toBe('E egpt@node1\nsys');
    expect(formatItemForWhatsApp({ author: 'You', body: 'hello' }, sessions, opts))
      .toBe('U An@node1\nhello');
    expect(formatItemForWhatsApp({ author: 'cx', body: 'answer' }, sessions, opts))
      .toBe('C cx@node1\nanswer');
    expect(formatItemForWhatsApp({ author: 'You', body: 'plain' }, sessions, { ...opts, mirrorHeaders: 'none' }))
      .toBe('plain');
    expect(formatItemForWhatsApp({ author: 'You', body: 'plain' }, sessions, { ...opts, mirrorHeaders: 'brain_only' }))
      .toBe('plain');
    expect(formatItemForWhatsApp({ author: 'cx', body: 'answer' }, sessions, { ...opts, mirrorHeaders: 'brain_only' }))
      .toBe('C cx@node1\nanswer');
  });
});
