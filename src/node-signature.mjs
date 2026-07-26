// node-signature.mjs — THE STRUCTURAL NODE ID: which spine committed this frame to a surface,
// encoded in INVISIBLE characters (operator 2026-07-26: "invisible characters are the way to go
// … there's a structural invisible and a visible pre and post signature. spine doesn't boot
// without the invisible ones. the visible one are prescindable, there are only for human purviews
// … oh, yes, the transcript must decode the signature into a <node>").
//
// A LEAF: imports nothing from the project (like sanitize.mjs / text-similarity.mjs), so the
// outbound wrap (bridges/persona-wrap.mjs), the inbound envelope builder (spine/identity.mjs) and
// the bridge's compare-key normalizer (bridges/beeper.mjs) all share ONE definition of the frame.
//
// THE FRAME
//   U+E0001 TAG LANGUAGE  +  the node name, tag-encoded  +  U+E007F CANCEL TAG
// Tag encoding is the Unicode TAGS block's own design: U+E0000 + <ASCII codepoint>, so "kg"
// becomes U+E006B U+E0067 — the name encodes and decodes with arithmetic, no lookup table, and
// the frame is unique per node because node_name already is. The block exists to carry invisible
// metadata beside text (RGI emoji tag sequences use exactly this, terminated by the same
// U+E007F), so nothing renders.
//
// WHY THIS BLOCK. 20 candidate invisible characters were sent through the live Beeper Self chat
// and read back (operator probe, 2026-07-26): 19 of 20 survived byte-for-byte — including TAG
// LANGUAGE U+E0001 and TAG LATIN A U+E0041, the two members of this block that were tested. The
// one casualty was U+0000 NUL, which is independently disqualified (a literal NUL byte once made
// ripgrep silently truncate a source file in this repo). Two rejected alternatives: U+FEFF BOM is
// JavaScript whitespace, so String.prototype.trim() — which htmlToMarkdown and transcriptAppend
// both run — would eat it; ZWSP/ZWNJ/ZWJ runs would need a lookup table to carry a NAME.
//
// The one theoretical collision: a message whose last character is 🏴 U+1F3F4 followed by our
// frame ALMOST forms an RGI emoji tag sequence — but U+E0001 is not a valid member of one, so the
// sequence is invalid and clients render the flag as they already do.
const TAG_BASE = 0xE0000;
const TAG_BEGIN = '\u{E0001}';    // TAG LANGUAGE — the opener
const TAG_CANCEL = '\u{E007F}';   // CANCEL TAG — the terminator
// The whole frame, findable and removable in ONE regex so stripping is total. The interior is the
// tag-encoded printable-ASCII range (U+E0020..U+E007E) only, so the terminator can never be eaten.
const FRAME_SOURCE = '\u{E0001}[\u{E0020}-\u{E007E}]*\u{E007F}';
const FRAME_G = new RegExp(FRAME_SOURCE, 'gu');

/**
 * The invisible frame for `node`. '' when there is no node name — the CODEC is tolerant so a
 * directly-constructed port stays byte-identical to before; boot is where a missing node_name is
 * FATAL (src/spine/boot.mjs). Non-ASCII characters are dropped (the tags block encodes ASCII).
 */
export function encodeNodeSignature(node) {
  const name = String(node ?? '').trim();
  let out = '';
  for (const ch of name) {
    const c = ch.codePointAt(0);
    if (c >= 0x20 && c <= 0x7E) out += String.fromCodePoint(TAG_BASE + c);
  }
  return out ? `${TAG_BEGIN}${out}${TAG_CANCEL}` : '';
}

/** The node name carried by the FIRST frame in `text`, or null when there is none (the ordinary case). */
export function decodeNodeSignature(text) {
  const m = String(text ?? '').match(FRAME_G);
  if (!m?.length) return null;
  let out = '';
  for (const ch of m[0].slice(TAG_BEGIN.length, -TAG_CANCEL.length)) out += String.fromCodePoint(ch.codePointAt(0) - TAG_BASE);
  return out || null;
}

/** Remove EVERY frame — total, so no invisible byte survives into a prompt. */
export function stripNodeSignature(text) {
  return String(text ?? '').replace(FRAME_G, '');
}

/** Replace every frame with a legible `<node>` — what a human (and the model) reads in the record. */
export function renderNodeSignature(text) {
  return String(text ?? '').replace(FRAME_G, (frame) => {
    const node = decodeNodeSignature(frame);
    return node ? `<${node}>` : '';
  });
}
