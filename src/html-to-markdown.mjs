// html-to-markdown.mjs — convert inbound transport HTML to markdown.
//
// Beeper delivers message text as HTML ("<p>te entiendo</p>", "<a href=…>"), so
// the raw text reaching the model and transcript.md was markup (operator
// 2026-06-16, the `morgan` thread). This converts it to markdown AT THE BRIDGE,
// before dispatch/transcript — decoding the transport's wire format is a limb
// job, like downloading attachment bytes (GENOME I2). Markdown is the target,
// not flat text: links and emphasis stay legible to the model instead of being
// flattened away. It is the inbound complement of the outbound md→TG-HTML path.
//
// Pure + Node-free (no DOMParser, no node:*): a small, deterministic transform
// over the subset Beeper/Matrix actually emits. Idempotent on plain text — text
// with no tags and no entities returns unchanged (only end-trimmed). (Echo
// suppression keeps its own lossy `_normEcho` compare-key in beeper.mjs; this is
// the fidelity-preserving display conversion, a separate concern.)

function stripTags(s) { return String(s).replace(/<[^>]+>/g, ''); }

const NAMED = { '&nbsp;': ' ', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" };

function unescapeEntities(s) {
  let out = String(s);
  out = out.replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch { return ''; } });
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } });
  for (const [k, v] of Object.entries(NAMED)) out = out.split(k).join(v);
  out = out.replace(/&amp;/gi, '&');   // amp LAST so "&amp;lt;" → "&lt;", not "<"
  return out;
}

/** Convert inbound HTML to markdown. `null`/`undefined`/`''` → `''`. */
export function htmlToMarkdown(html) {
  if (html == null) return '';
  let s = String(html);
  if (!s) return '';
  // line breaks + block boundaries → newlines
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '\n- ');
  s = s.replace(/<\/(p|div|li|h[1-6]|blockquote|ul|ol)>/gi, '\n');
  // links → [text](href) (before the general tag-strip)
  s = s.replace(/<a\b[^>]*?\bhref=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi,
    (_, _q, href, txt) => { const t = stripTags(txt).trim(); return `[${t || href}](${href})`; });
  // emphasis / code / strike → markdown (open and close map to the same marker)
  s = s.replace(/<\/?(strong|b)\b[^>]*>/gi, '**');
  s = s.replace(/<\/?(em|i)\b[^>]*>/gi, '*');
  s = s.replace(/<\/?(code|tt|pre)\b[^>]*>/gi, '`');
  s = s.replace(/<\/?(s|del|strike)\b[^>]*>/gi, '~~');
  // drop any remaining tags, then unescape entities (so &lt; becomes content, not a tag)
  s = stripTags(s);
  s = unescapeEntities(s);
  // tidy whitespace: drop trailing space before newlines, collapse blank runs, trim
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return s;
}
