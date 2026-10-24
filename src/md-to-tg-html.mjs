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
