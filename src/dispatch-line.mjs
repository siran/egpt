// The ONE identity line every brain sees for an inbound auto-dispatched message.
// Operator-mandated shape (2026-06-12):
//
//   Sender@[chatname/groupname].{node} (HH:MM): body
//
// `{node}` is the ENTRY POINT the message arrived through — the surface/client
// the human used: 'wa' (WhatsApp), 'kg' (the home shell), 'chrome' (the
// extension). It is resolved from the client/surface identity, NEVER hardcoded
// into the template (the bug this replaces: '.wa' baked in, so every line read
// '.wa' no matter the origin). HH:MM renders in the node's configured
// `default_time_zone` (operator 2026-07-26), falling back to UTC when unset —
// the reply envelope's clock (transcript-log.replyLine) does the same, so all
// timestamps stay consistent (operator 2026-05-21). A voice note arrives
// with its body already prefixed "(voice transcription, Ns) …" by the caller —
// this formatter is body-agnostic.
//
// Pure + exported so tests/dispatch-line.test.mjs locks the shape (CONTRACT
// C7.6). egpt-spine.mjs `formatAutoDispatchLine` is a thin wrapper over this, and the
// function is passed by reference into dispatch.mjs / slash/rules.mjs — so the
// test guards the REAL formatter every surface uses, not a copy.

// A surface tag (egpt's buildWaSurfaceTag) carries the node, but is inconsistent
// about WHERE the node sits:
//   '<slug>.wa'      group        -> node 'wa', name '<slug>'   (node LAST)
//   'status.wa'      status feed  -> node 'wa', name 'status'   (node LAST)
//   'wa.<jid>'       DM / fallback-> node 'wa', name '<jid>'    (node FIRST)
//   'kg' / 'chrome'  shell / ext  -> node = the tag, name ''    (bare)
// So: a leading 'wa.' is the node-first WhatsApp shape; otherwise the LAST
// dot-segment is the node. This is only a FALLBACK — callers should pass an
// explicit { chatName, node } and skip the guessing.
export function splitSurfaceTag(surface) {
  const s = String(surface ?? '').trim();
  if (!s) return { name: '', node: '' };
  const segs = s.split('.').filter(Boolean);
  if (segs.length <= 1) return { name: '', node: segs[0] ?? '' };
  if (segs[0] === 'wa') return { name: segs.slice(1).join('.'), node: 'wa' };
  return { name: segs.slice(0, -1).join('.'), node: segs[segs.length - 1] };
}

// THE TRANSCRIPT CLOCK. HH:MM rendered in `timeZone` — the node's config
// `default_time_zone`, resolved by the heartbeat loader's resolveTimeZone (ONE zone
// mechanism, no second one) and injected by boot into the two line formatters. Operator
// 2026-07-26: "timestamps should be rendered as per the configuration key" — he reads at
// −0400, so a UTC line looked four hours ahead of when it happened and he believed his own
// message was missing from the bottom of a live file.
// No zone — or a zone Intl rejects — renders UTC, the historical behaviour. NEVER throws:
// a transcript line is not worth losing over a clock.
export function hhmm(ts, timeZone) {
  const d = new Date(ts ?? Date.now());
  if (timeZone) {
    try {
      return new Intl.DateTimeFormat('en-GB', { timeZone, hour12: false, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(d);
    } catch { /* invalid zone → the UTC fallback below */ }
  }
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function formatDispatchLine({ senderName, chatName, node, surface, body, ts, msgId, replyToId, stageDirection = false, timeZone = null } = {}) {
  const tstr = hhmm(ts, timeZone);
  const sender = (senderName != null && String(senderName).trim()) ? String(senderName).trim() : 'someone';
  // Explicit { chatName, node } win; the surface tag is only a fallback source.
  const fromSurface = splitSurfaceTag(surface);
  const nd = (node != null && String(node).trim()) ? String(node).trim() : (fromSurface.node || 'wa');
  const nm = (chatName != null && String(chatName).trim()) ? String(chatName).trim() : (fromSurface.name || nd);
  // Stage-direction (theater-play model, MESSAGES-FIRST-CLASS-PLAN): a meta-event
  // (a reaction/edit/delete) is NOT an utterance — wrap it in outer brackets so
  // the reader/model can tell it apart from speech. The body carries the action
  // ("reacted 👍 to #<id> …") which references its own target id, so no #<id> tag.
  if (stageDirection) return `[ ${sender}@[${nm}].${nd} (${tstr}): ${body ?? ''} ]`;
  // Message id (Beeper msg.id) — makes each line addressable so the model can
  // /react / /reply it and reactions can reference it (#<id>). Optional →
  // omitted when absent (back-compat). (MESSAGES-FIRST-CLASS-PLAN Phase 1)
  const idTag = (msgId != null && String(msgId).trim()) ? ` #${String(msgId).trim()}` : '';
  // Reply reference (operator 2026-07-04): when this message QUOTES/replies to another,
  // `re #<id>` names the answered message so the model can respond to it directly —
  // including via a /reply emit action. Omitted when absent (back-compat).
  const replyTag = (replyToId != null && String(replyToId).trim()) ? ` re #${String(replyToId).trim()}` : '';
  return `${sender}@[${nm}].${nd} (${tstr})${idTag}${replyTag}: ${body ?? ''}`;
}

// The body of a reaction stage-direction (MESSAGES-FIRST-CLASS-PLAN Phase 2):
//   reacted 👍 to #<targetId> "<snippet>"
// `snippet` is the target message's text (pre-cleaned to markdown by the caller),
// trimmed to a short quote; omitted when empty. Pure + exported so the shape is
// test-locked alongside formatDispatchLine.
export function reactionAction({ emoji, targetId, snippet } = {}) {
  const e = String(emoji ?? '').trim() || '❓';
  const id = String(targetId ?? '').trim();
  const snip = String(snippet ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return `reacted ${e} to #${id}${snip ? ` "${snip}"` : ''}`;
}

// The body of an EDIT stage-direction (MESSAGES-FIRST-CLASS-PLAN): a message's
// text changed after it was sent → a two-line git-style diff:
//   edited #<id>
//       - <full old>
//       + <full new>
// Append-only: the original line stays in the transcript; this records the
// correction (so E sees e.g. that "imbécil" was softened to "pobrecito").
// NOT truncated — a change past a short prefix must stay visible on both
// sides. Pure + test-locked.
export function editAction({ targetId, oldText, newText } = {}) {
  const id = String(targetId ?? '').trim();
  const o = String(oldText ?? '').replace(/\s+/g, ' ').trim();
  const n = String(newText ?? '').replace(/\s+/g, ' ').trim();
  return `edited #${id}\n    - ${o}\n    + ${n}`;
}

// The LIVE-FRAME marker. src/spine/sender.mjs `update()` stamps it onto every
// intermediate frame of a streaming reply (`${partial} ⏳`) and ONLY there — `finish()`
// posts the settled text without it. It is the one token that separates "this message is
// still being written" from "this is what it says".
export const LIVE_FRAME_MARK = '⏳';

// Is this edit stage-direction a LIVING-MIRROR STREAM FRAME rather than history?
//
// A streaming reply is ONE message rewritten in place, so every frame re-upserts it and a
// node OBSERVING that reply (a peer spine on the same shared Beeper account — the bridge
// only suppresses its OWN stream ids, _ourStreamIds) sees each frame as an incoming edit.
// Those frames are TRANSIENT: only the settled text is history. A HUMAN editing their own
// earlier message is real history and must never be caught here — which is why the test is
// the marker OUR OWN sender stamps, not a guess about who sent it or how the text looks.
//
// Reads the `+` (new) side only: the SETTLE frame's `-` side is the last partial and still
// carries the marker, and that frame is exactly the one entry we keep. PRESENCE, not
// position — a surface may wrap a committed frame in a signature layer, so the marker is
// not guaranteed to stay at the very end of the line.
export function isLiveStreamFrame(editBody) {
  const plus = String(editBody ?? '').split('\n').find((l) => l.startsWith('    + '));
  return plus != null && plus.includes(LIVE_FRAME_MARK);
}

// THE INCREMENT — what `after` ADDED to `before`, and nothing else (operator 2026-08-27:
// "the peer node needs to log only the increments, not the deletions").
//
// ONE derivation, used by BOTH halves of the ruling: the EMITTING node diffs the
// accumulated model text against what it has already logged (spine.mjs's onPartial), and an
// OBSERVING node diffs a live frame's `-` side against its `+` side (liveFrameIncrement
// below). Two sides of the same coin, so they must not be two functions that drift.
//
// Common PREFIX + common SUFFIX, returning the middle of `after`. The suffix half is not a
// nicety: a live frame is wrapped by the node's bridge signature and ends with the live
// marker, so `after` is NEVER a prefix-extension of `before` on a real node — a
// startsWith() test would fail on every frame and log the whole wrapped text each time,
// which is exactly the 1.3 MB flood 372c17f exists to stop. No signature format appears
// here: the suffix is DISCOVERED, never named.
//
// A shrink returns '' (nothing was added — a deletion is not an increment). A DIVERGENCE
// (the model rewrote, rather than extended, what it had said — the "boom, it changes" the
// operator reported) has a short common prefix/suffix, so the new text comes back whole and
// gets logged. Nothing already written is ever removed: this only ever RETURNS bytes.
//
// PREFIX FIRST, then the suffix over what is left — never the other way round. Suffix-first
// over-matches into the CONTENT (the `a` of "para" against the `a` of "verla") and emits a
// fragment that reconstructs WRONG. The order here costs a known, harmless artifact instead:
// when a frame's new space coincides with the wrapper's own separator space, the prefix
// swallows it and the next increment carries it, so a wrapped stream reconstructs with a
// space displaced by one token ("Buenluga r random" for "Buen lugar random"). Every
// character is present, in order, exactly once — only whitespace can shift. Removing even
// that would mean knowing the signature format, which is precisely what 372c17f forbids.
// The EMITTING side has no wrapper, so its stream is byte-exact.
const _isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const _isLow = (c) => c >= 0xdc00 && c <= 0xdfff;
export function streamIncrement(before, after) {
  const a = String(before ?? ''), b = String(after ?? '');
  if (a === b) return '';
  const max = Math.min(a.length, b.length);
  let p = 0;
  while (p < max && a[p] === b[p]) p++;
  let s = 0;
  while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  // Never cut a surrogate pair in half — two different emoji share a high surrogate
  // (🌉/🌀 are both U+D83C …), and a signature layer is made of emoji, so a boundary
  // landing mid-pair is reachable and would append a lone surrogate to the record.
  if (p > 0 && _isHigh(a.charCodeAt(p - 1))) p--;
  if (s > 0 && _isLow(b.charCodeAt(b.length - s))) s--;
  const inc = b.slice(p, b.length - s);
  // A RESTART gets a line break, and only a restart: `after` shares NOTHING with the text
  // already on the record, so it is a new utterance, not a continuation of the last one.
  // Without it a wholesale replacement (the "boom, it changes") glues onto the interim train
  // mid-sentence and the log asserts a continuity that never happened. This is a boundary,
  // not a notation — nothing to learn to read, and nothing is removed. A frame that DOES
  // continue (every ordinary token delta, and every peer frame, whose shared persona stamp
  // guarantees a common prefix) is appended bare, so the increments still concatenate back
  // into the text the model wrote.
  return (p === 0 && a && inc) ? `\n${inc}` : inc;
}

// The increment carried by an edit stage-direction — the inverse of editAction, for the
// OBSERVING half of the ruling. A peer's streamed reply reaches this node only as edits
// (`don` runs on DOLLY, so the frames are inbound and this process holds no state naming
// that message), so its `-`/`+` sides are the only material there is to derive from.
// Reads BOTH sides but returns only what the `+` side added: the `-` text is never
// returned, so it can never be written.
//
// THE MARKER COMES OFF BOTH SIDES FIRST. It is OUR OWN token — sender.mjs stamps it, this
// module defines it — not something the model said, and it moves to the end of the text on
// every frame, so leaving it in writes a `⏳` into the middle of the record at each restart
// ("Buen lugar random para ⏳verla …"). Stripping it is not knowledge of the SIGNATURE
// format, which stays undiscussed here (372c17f): the wrapper is still only ever found by
// the common-suffix scan.
const _MARK_RE = new RegExp(LIVE_FRAME_MARK, 'g');
const _demark = (s) => s.replace(_MARK_RE, '').replace(/\s+/g, ' ');
export function liveFrameIncrement(editBody) {
  const lines = String(editBody ?? '').split('\n');
  const side = (mark) => { const l = lines.find((x) => x.startsWith(mark)); return l == null ? '' : _demark(l.slice(mark.length)); };
  return streamIncrement(side('    - '), side('    + '));
}
