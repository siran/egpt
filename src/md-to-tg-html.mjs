// md-to-tg-html.mjs — a being's Markdown as Telegram HTML (parse_mode 'HTML'). A leaf: imports nothing.
// Only clear pairs convert: anything unpaired or half-written (a stream) stays literal text.
// A being's own Telegram tags pass when well-formed; any other tag is shown as text.

export const escapeHtml = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const W = '\\p{L}\\p{N}_';   // a word character, any script
const INLINE = [
  [/\*\*\*(?=\S)(.+?)(?<=\S)\*\*\*/gu, '<b><i>$1</i></b>'],
  [/\*\*(?=\S)(.+?)(?<=\S)\*\*/gu, '<b>$1</b>'],
  [new RegExp(`(?<![${W}])__(?=\\S)(.+?)(?<=\\S)__(?![${W}])`, 'gu'), '<b>$1</b>'],
  [new RegExp(`(?<![${W}*])\\*(?=[^\\s*])(.+?)(?<=[^\\s*])\\*(?![${W}*])`, 'gu'), '<i>$1</i>'],
  [new RegExp(`(?<![${W}])_(?=[^\\s_])(.+?)(?<=[^\\s_])_(?![${W}])`, 'gu'), '<i>$1</i>'],
  [/~~(?=\S)(.+?)(?<=\S)~~/gu, '<s>$1</s>'],
  [/^#{1,6}[ \t]+(.+?)[ \t#]*$/gmu, '<b>$1</b>'],
];
const FENCE = /```(?:([\w+#.-]+)?\n)?([\s\S]*?)```|```[\s\S]*$/g;
const CODE_TAG = /<(pre|code)(\s[^<>]*)?>([\s\S]*?)<\/\1>/gi;
const TAG = /<(\/?)(b|strong|i|em|u|ins|s|strike|del|a|blockquote|tg-spoiler)(\s[^<>]*)?>/gi;
const LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)\0]+)\)/g;
const URL = /https?:\/\/[^\s\0]+?(?=[*_~.,;:!?)\]]*(?:[\s\0]|$))/gu;
const HELD = /\0(\d+)\0/g;
const TABLE_MAX = 40;   // (operator 2026-11-20) characters that fit a phone's width in Telegram's monospace
const DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const cells = (line) => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

const codeClass = (attrs = '') => {
  if (!attrs.trim()) return '';
  const m = /^\s+class\s*=\s*"(language-[\w+#.-]+)"\s*$/i.exec(attrs);
  return m ? ` class="${m[1]}"` : null;
};

function openTag(name, attrs = '') {
  if (name === 'a') {
    const m = /^\s+href\s*=\s*(["'])(https?:\/\/[^"'\s<>]+)\1\s*$/i.exec(attrs);
    return m ? `<a href="${escapeHtml(m[2].replace(/&amp;/g, '&'))}">` : null;
  }
  if (name === 'blockquote' && /^\s+expandable\s*$/i.test(attrs)) return '<blockquote expandable>';
  return attrs.trim() ? null : `<${name}>`;
}

function balanced(html) {
  const stack = [];
  for (const [, close, name] of html.matchAll(/<(\/?)([a-z-]+)[^>]*>/g)) {
    if (!close) stack.push(name);
    else if (stack.pop() !== name) return false;
  }
  return !stack.length;
}

export function mdToTgHtml(text) {
  const input = String(text ?? '').replace(/\0/g, '');
  const held = [], src = [];
  const hold = (html, from = html) => { held.push(html); src.push(from); return `\0${held.length - 1}\0`; };
  const raw = (s) => s.replace(HELD, (_, i) => src[i]);

  // Code first: its content is never formatted. An unclosed fence stays literal to the end.
  let s = input.replace(FENCE, (m, lang, body) => (body?.trim()
    ? hold(`<pre><code${lang ? ` class="language-${lang}"` : ''}>${escapeHtml(body.replace(/\n$/, ''))}</code></pre>`, m)
    : hold(escapeHtml(m), m)));
  s = s.replace(/`([^`\n]+)`/g, (m, c) => hold(`<code>${escapeHtml(c)}</code>`, m));
  s = s.replace(CODE_TAG, (m, name, attrs, inner) => {
    if (name.toLowerCase() === 'code') {
      const cls = codeClass(attrs);
      return cls == null ? m : hold(`<code${cls}>${escapeHtml(raw(inner))}</code>`, m);
    }
    if (attrs?.trim()) return m;
    const c = /^<code(\s[^<>]*)?>([\s\S]*)<\/code>$/i.exec(inner);
    const cls = c && codeClass(c[1]);
    return hold(cls != null ? `<pre><code${cls}>${escapeHtml(raw(c[2]))}</code></pre>` : `<pre>${escapeHtml(raw(inner))}</pre>`, m);
  });

  // Tables (operator 2026-11-20: Telegram has no table tags). A table is a header row, a delimiter row,
  // then consecutive pipe rows. Streaming: only a delimiter row makes a table, so a lone header stays literal;
  // a last row without its newline is already a body row. Narrow (fits TABLE_MAX): one <pre>, padded columns,
  // honoring :-- / --: / :-: alignment. Wide: the header as one italic line, then a line per row, first cell bold, the rest through the inline pass.
  const lines = s.split('\n'), out = [];
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].includes('|') && DELIM.test(lines[i + 1] ?? '') ? cells(lines[i]) : null;
    const align = head && cells(lines[i + 1]).map((c) => (c.startsWith(':') ? (c.endsWith(':') ? 'c' : 'l') : c.endsWith(':') ? 'r' : 'l'));
    if (!head || align.length !== head.length) { out.push(lines[i]); continue; }
    let end = i + 2;
    while (end < lines.length && lines[end].includes('|')) end++;
    const body = lines.slice(i + 2, end).map((l) => { const c = cells(l); return head.map((_, k) => c[k] ?? ''); });
    const rows = [head, ...body].map((r) => r.map((c) => raw(c)));
    const width = head.map((_, k) => Math.max(...rows.map((r) => [...r[k]].length)));
    const pad = (c, k) => { const n = width[k] - [...c].length, l = align[k] === 'r' ? n : align[k] === 'c' ? n >> 1 : 0; return ' '.repeat(l) + c + ' '.repeat(n - l); };
    const line = (r) => r.map(pad).join('  ').trimEnd();
    const total = width.reduce((a, b) => a + b, 0) + 2 * (width.length - 1);
    if (total <= TABLE_MAX) {
      const text = [line(rows[0]), '─'.repeat(total), ...rows.slice(1).map(line)];
      out.push(hold(`<pre>${escapeHtml(text.join('\n'))}</pre>`, lines.slice(i, end).join('\n')));
    } else {
      out.push(`${hold('<i>')}${head.join(' · ')}${hold('</i>')}`);   // the header keeps what the columns are
      for (const r of body) {
        const rest = r.slice(1).map((c, k) => (r.length > 2 ? `${head[k + 1]}: ${c}` : c));
        out.push(`${hold('<b>')}${r[0].replace(/^\*\*(.+)\*\*$/, '$1')}${hold('</b>')} — ${rest.join(' · ')}`);
      }
    }
    i = end - 1;
  }
  s = out.join('\n');

  // A being's own tags: only matched pairs pass; an unclosed one (mid-stream) is text.
  const pass = new Map(), stack = [];
  for (const m of s.matchAll(TAG)) {
    const name = m[2].toLowerCase();
    if (!m[1]) {
      const html = openTag(name, m[3]);
      if (html) stack.push({ at: m.index, name, html });
      continue;
    }
    const j = stack.findLastIndex((o) => o.name === name);
    if (j < 0 || m[3]?.trim()) continue;
    pass.set(stack[j].at, stack[j].html).set(m.index, `</${name}>`);
    stack.length = j;
  }
  s = s.replace(TAG, (m, _c, _n, _a, at) => (pass.has(at) ? hold(pass.get(at)) : m));

  s = escapeHtml(s)
    .replace(LINK, (m, label, url) => `${hold(`<a href="${url.replace(/"/g, '&quot;')}">`)}${label}${hold('</a>')}`)
    .replace(URL, (m) => hold(m));
  for (const [re, to] of INLINE) s = s.replace(re, to);
  s = s.replace(HELD, (_, i) => held[i]);
  return balanced(s) ? s : escapeHtml(input);
}
