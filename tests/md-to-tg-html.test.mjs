// md-to-tg-html.test.mjs — a being's Markdown as Telegram HTML (restored from item-format, 25176248^).
import { describe, it, expect } from 'vitest';
import { escapeHtml, mdToTgHtml } from '../src/md-to-tg-html.mjs';

describe('mdToTgHtml', () => {
  it('escapeHtml protects Telegram HTML bodies', () => {
    expect(escapeHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });

  it('escapes first, then applies simple markdown tags', () => {
    expect(mdToTgHtml('**bold** and `x<y`')).toBe('<b>bold</b> and <code>x&lt;y</code>');
    expect(mdToTgHtml('```js\nif (a < b) {}\n```')).toBe('<pre><code class="language-js">if (a &lt; b) {}</code></pre>');
  });

  it('bold, italic, strike, links, headings', () => {
    expect(mdToTgHtml('__b__ *i* _i_ ***bi*** ~~s~~')).toBe('<b>b</b> <i>i</i> <i>i</i> <b><i>bi</i></b> <s>s</s>');
    expect(mdToTgHtml('*a **b** c*')).toBe('<i>a <b>b</b> c</i>');
    expect(mdToTgHtml('[docs](https://x.com/a_b_c?q=1&r=2)')).toBe('<a href="https://x.com/a_b_c?q=1&amp;r=2">docs</a>');
    expect(mdToTgHtml('[**bold** link](https://x.com)')).toBe('<a href="https://x.com"><b>bold</b> link</a>');
    expect(mdToTgHtml('## Plan\ntext')).toBe('<b>Plan</b>\ntext');
  });

  it('code keeps its content literal: no markdown, no tags', () => {
    expect(mdToTgHtml('```\n**kw** <b>x</b> a_b_\n  indented\n```')).toBe('<pre><code>**kw** &lt;b&gt;x&lt;/b&gt; a_b_\n  indented</code></pre>');
    expect(mdToTgHtml('`<b>` and `**x**`')).toBe('<code>&lt;b&gt;</code> and <code>**x**</code>');
  });

  it('snake_case, 2*3*4, lone asterisks, lists and bare URLs stay literal', () => {
    for (const s of ['snake_case_name', 'my_var and other_var', '2*3*4', '5 * 3 = 15', '*', '**', 'a*b and c*d', '- item\n* item\n1. item', 'https://x.com/_a_/b*c*d']) {
      expect(mdToTgHtml(s)).toBe(escapeHtml(s));
    }
    expect(mdToTgHtml('**https://x.com/a_b**')).toBe('<b>https://x.com/a_b</b>');
    expect(mdToTgHtml('see https://x.com/`a_b`')).toBe('see https://x.com/<code>a_b</code>');
  });

  it('unclosed markers (a stream mid-write) stay literal, never an unbalanced tag', () => {
    for (const s of ['**bol', '__bo', '*it', '_it', '~~st', '`cod', '[link](https://x.co', '<b>half', '<b>half</', '**bold*', '```js\nconst a = **b**;']) {
      expect(mdToTgHtml(s)).toBe(escapeHtml(s));
    }
    expect(mdToTgHtml('**done** and **half')).toBe('<b>done</b> and **half');
  });

  it('a being\'s own Telegram tags pass when well-formed; anything else is text', () => {
    expect(mdToTgHtml('<b>a</b> <STRONG>b</STRONG> <i>c</i> <u>d</u> <s>e</s> <tg-spoiler>f</tg-spoiler>'))
      .toBe('<b>a</b> <strong>b</strong> <i>c</i> <u>d</u> <s>e</s> <tg-spoiler>f</tg-spoiler>');
    expect(mdToTgHtml('<a href="https://x.com/?a=1&amp;b=2">x</a>')).toBe('<a href="https://x.com/?a=1&amp;b=2">x</a>');
    expect(mdToTgHtml('<blockquote expandable>q</blockquote>')).toBe('<blockquote expandable>q</blockquote>');
    expect(mdToTgHtml('<pre><code class="language-py">x < 1 and **y**</code></pre> <code>a<b</code>'))
      .toBe('<pre><code class="language-py">x &lt; 1 and **y**</code></pre> <code>a&lt;b</code>');
    expect(mdToTgHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(mdToTgHtml('<a href="javascript:x">y</a> <b onclick="z">w</b> <br>'))
      .toBe('&lt;a href="javascript:x"&gt;y&lt;/a&gt; &lt;b onclick="z"&gt;w&lt;/b&gt; &lt;br&gt;');
    expect(mdToTgHtml('<b><i>x</b>')).toBe('<b>&lt;i&gt;x</b>');
  });

  it('formatting that would cross tags falls back to plain escaped text', () => {
    expect(mdToTgHtml('<i>x **y</i> z**')).toBe(escapeHtml('<i>x **y</i> z**'));
    expect(mdToTgHtml('*a [b* c](https://x.com)')).toBe(escapeHtml('*a [b* c](https://x.com)'));
  });

  it('a visible stamp stays as written; null is empty', () => {
    expect(mdToTgHtml('🌉 🦉 ED: **hola** ñandú_x 💸')).toBe('🌉 🦉 ED: <b>hola</b> ñandú_x 💸');
    expect(mdToTgHtml(null)).toBe('');
  });
});
