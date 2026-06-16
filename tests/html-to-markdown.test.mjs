import { describe, it, expect } from 'vitest';
import { htmlToMarkdown } from '../src/html-to-markdown.mjs';

describe('html → markdown (inbound transport text)', () => {
  it('unwraps a paragraph', () => {
    expect(htmlToMarkdown('<p>te entiendo</p>')).toBe('te entiendo');
  });

  it('joins multiple paragraphs with a newline', () => {
    expect(htmlToMarkdown('<p>uno</p><p>dos</p>')).toBe('uno\ndos');
  });

  it('turns <br> into a newline', () => {
    expect(htmlToMarkdown('a<br>b<br/>c')).toBe('a\nb\nc');
  });

  it('keeps links as markdown', () => {
    expect(htmlToMarkdown('mira <a href="https://x.com/p">aquí</a>')).toBe('mira [aquí](https://x.com/p)');
    expect(htmlToMarkdown("<a href='https://y.com'>y</a>")).toBe('[y](https://y.com)');
  });

  it('maps emphasis/code/strike to markdown', () => {
    expect(htmlToMarkdown('<strong>hi</strong> <em>yo</em> <code>x</code> <s>no</s>')).toBe('**hi** *yo* `x` ~~no~~');
  });

  it('unescapes entities (amp resolved last)', () => {
    expect(htmlToMarkdown('a &amp; b &lt;3&gt; &quot;q&quot;')).toBe('a & b <3> "q"');
    expect(htmlToMarkdown('&amp;lt;')).toBe('&lt;');
    expect(htmlToMarkdown('caf&#233;')).toBe('café');
  });

  it('is idempotent on plain text', () => {
    expect(htmlToMarkdown('hola mundo, @e ¿vienes?')).toBe('hola mundo, @e ¿vienes?');
  });

  it('strips unknown tags but keeps their content', () => {
    expect(htmlToMarkdown('<span class="x">hola</span> <unknown>mundo</unknown>')).toBe('hola mundo');
  });

  it('returns empty for null/undefined/empty', () => {
    expect(htmlToMarkdown(null)).toBe('');
    expect(htmlToMarkdown(undefined)).toBe('');
    expect(htmlToMarkdown('')).toBe('');
  });
});
