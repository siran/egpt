// speech-clean.mjs — prepare model prose for TTS (operator 2026-08-10, `@ev`
// chunk). `@ev`/voice-out sends E's raw prose straight to the synthesizer
// (spine.mjs wantsVoice path) — literal markdown syntax and a trailing
// Sources/citations footer read aloud as noise (asterisks spoken, a wall of
// URLs). This is the one insertion point: strip markdown down to spoken
// words and drop a trailing Sources section, WITHOUT touching the on-screen
// proseText that still ships as the quoted-text companion message.
//
// Pure + Node-free: a small, deterministic transform, not a markdown parser.

const SOURCES_HEADING = /^[ \t]*#{0,6}[ \t]*\**[ \t]*(sources?|citations?|references?|fuentes?)[ \t]*:?[ \t]*\**[ \t]*$/im;

function dropSourcesSection(s) {
  const m = SOURCES_HEADING.exec(s);
  return m ? s.slice(0, m.index).trimEnd() : s;
}

function stripMarkdown(s) {
  let out = s;
  // fenced code blocks → their inner text
  out = out.replace(/```[^\n]*\n([\s\S]*?)```/g, '$1');
  // images: drop entirely (alt text rarely worth speaking)
  out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  // links → link text only
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // headings, blockquotes, list bullets/numbers at line start
  out = out.replace(/^[ \t]*#{1,6}[ \t]*/gm, '');
  out = out.replace(/^[ \t]*>[ \t]?/gm, '');
  out = out.replace(/^[ \t]*[-*+][ \t]+/gm, '');
  out = out.replace(/^[ \t]*\d+[.)][ \t]+/gm, '');
  // horizontal rules
  out = out.replace(/^[ \t]*([-*_])[ \t]*(\1[ \t]*){2,}$/gm, '');
  // emphasis / bold / strike / inline code markers (line-scoped: unbalanced
  // markers in one line shouldn't swallow the rest of the message)
  out = out.replace(/(\*\*\*|___)([^\n]+?)\1/g, '$2');
  out = out.replace(/(\*\*|__)([^\n]+?)\1/g, '$2');
  out = out.replace(/(\*|_)([^\n]+?)\1/g, '$2');
  out = out.replace(/~~([^\n]+?)~~/g, '$1');
  out = out.replace(/`([^`\n]+)`/g, '$1');
  return out;
}

/** Prepare model prose for TTS: drop a trailing Sources/citations section, strip markdown syntax down to spoken words. `null`/`undefined`/`''` → `''`. */
export function cleanForSpeech(text) {
  if (text == null) return '';
  let s = String(text);
  if (!s) return '';
  s = dropSourcesSection(s);
  s = stripMarkdown(s);
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return s;
}
