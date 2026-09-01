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

// THE DAY, MARKED WHERE IT CHANGES (operator 2026-09-01, reading his own live SPOILER
// transcript — three adjacent lines, `(22:40)`, `(00:18)`, `(06:20)`, with midnight passing
// between the first two and NOTHING saying so, so no reader, human or model, can tell which
// day any line belongs to). A dispatch line carries HH:MM and no date on purpose (the shape
// above is operator-mandated), and stamping the date on every line would repeat it thousands
// of times across months of history to say one thing — so it is said ONCE, at the boundary:
//
//   [ 2026-09-01 ]
//
// Its own block, bracket-wrapped like a stage direction, because a day change is not an
// utterance. Deliberately NOT an entry shape: no `@[`, no `(HH:MM)`, so it matches neither
// transcript-log's _ENTRY_HEAD/beingReplyRe nor commands.mjs's _SENDER_RE — a boundary can
// never be read back as a message, a speaker, or a roster member. The ONE reader that must
// know it is bodyForMessageId's continuation walk (transcript-log.mjs), which stops at
// `isDayBoundary` instead of swallowing the marker into the body of the previous day's last
// entry; that is why the predicate lives HERE, beside the formatter, and is imported there.
//
// Same clock discipline as hhmm above: the node's configured `default_time_zone`, UTC when
// unset or rejected by Intl, and NEVER throwing — a boundary computed in the wrong zone marks
// midnight at the wrong line, which is worse than not marking it.
export function dayBoundary(ts, timeZone) {
  const d = new Date(ts ?? Date.now());
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
      const at = (t) => parts.find((p) => p.type === t)?.value ?? '';
      const y = at('year'), m = at('month'), day = at('day');
      if (y && m && day) return `[ ${y}-${m}-${day} ]`;
    } catch { /* invalid zone → the UTC fallback below */ }
  }
  const pad = (n) => String(n).padStart(2, '0');
  return `[ ${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ]`;
}

// Is this line a day boundary rather than transcript content? PRESENCE of the exact shape
// above and nothing looser — the readers that consult it are deciding whether an entry's body
// ends here, so a false positive would truncate a real message.
const _DAY_BOUNDARY_RE = /^\[\s*\d{4}-\d{2}-\d{2}\s*\]$/;
export function isDayBoundary(line) { return _DAY_BOUNDARY_RE.test(String(line ?? '').trim()); }

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
  //
  // IT RIDES THE BODY, BRACKETED (operator 2026-09-01, reading his own live SPOILER transcript:
  // the old shape "…wa (08:26) #204778 re #204774: no podría…" is hard to read, because a bare
  // `re #…` floats between the id and the `:` and the head's length changes with it). Same
  // information, one head shape for every line — the id is followed STRAIGHT by the separator,
  // and the reference opens the body as `[re #<id>] `, the way `(not surfaced) `/`(streaming) `
  // already open a body (transcript-log.replyLine):
  //   An@[SPOILER ALERT: chat de EyAy].wa (08:26) #204778: [re #204774] no podría estar más de acuerdo
  // Every reader keyed on this shape keeps working: _ENTRY_HEAD/beingReplyRe stop at the
  // timestamp, and bodyForMessageId's id capture stops at the `:` either way — it strips the
  // prefix back off (transcript-log._REPLY_REF) so "the recorded body" stays byte-identical to
  // what it was before the move. Edit-block indentation (editAction) is untouched.
  const replyRef = (replyToId != null && String(replyToId).trim()) ? `[re #${String(replyToId).trim()}] ` : '';
  return `${sender}@[${nm}].${nd} (${tstr})${idTag}: ${replyRef}${body ?? ''}`;
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

// The body of a LIMB stage-direction (operator 2026-09-01): the being drove an action from
// INSIDE its own reply (`/react #563 🤝`, src/spine/reply-actions.mjs) and the transcript said
// nothing about it. Live that day, twice, in the SPOILER chat: the 🤝 landed on the right
// message in WhatsApp, but the record showed only the settled message text — so reading back
// what happened meant resolving ids by hand across two accounts. The operator's target: "if
// model replies '/react ...', we need to put in transcript its reaction … so that there is
// legible record of what happened".
//
// A limb is a meta-EVENT, exactly like the reaction/edit the bridge already records for
// everyone else, so it takes the SAME stage-direction wrapper (formatDispatchLine
// stageDirection:true) and — for /react — the SAME vocabulary (reactionAction above), so one
// kind of line means "a reaction happened" whoever caused it.
//
// THE ID IS THIS NODE'S OWN, and that needs no apology: Beeper message ids are PER-ACCOUNT
// (measured 2026-09-01 — the same chat is localChatID 13 on one node and in the 69,000s on
// another; a raw payload carries only id/chatID/accountID/senderID/senderName/timestamp/
// linkedMessageID, so no cross-account message id exists). The model emitted #563 because #563
// is what THIS node's transcript calls that message, and this line is written into THAT
// transcript — recording the action as an EVENT is precisely what makes a shared id unnecessary.
// Pure + exported so the shape is test-locked beside the two above.
export function limbAction(action = {}) {
  const snip = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const id = String(action?.targetId ?? '').trim();
  switch (action?.type) {
    case 'react': return reactionAction({ emoji: action.emoji, targetId: id });
    case 'reply': return `replied to #${id}${snip(action.text) ? ` "${snip(action.text)}"` : ''}`;
    case 'edit': return `edited #${id}${snip(action.text) ? ` → "${snip(action.text)}"` : ''}`;
    case 'media': return `sent media ${snip(action.path)}${snip(action.caption) ? ` "${snip(action.caption)}"` : ''}`;
    case 'ask': return `asked the advice channel${snip(action.question) ? ` "${snip(action.question)}"` : ''}`;
    default: return null;   // an unknown limb invents no vocabulary — the raw reply line already holds it
  }
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
// THE ONE SCAN. `p` = length of the common prefix, `s` = length of the common suffix, so
// `b.slice(p, b.length - s)` is what was ADDED and `a.slice(p, a.length - s)` is what was
// TAKEN BACK — two reads of one boundary pair, never two scans that can drift (operator
// 2026-09-01 added the second read; the first has been the ruling since 2026-08-27).
// The `s < max - p` guard keeps the two halves from overlapping, so both slices are valid.
function _scan(a, b) {
  const max = Math.min(a.length, b.length);
  let p = 0;
  while (p < max && a[p] === b[p]) p++;
  let s = 0;
  while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  // Never cut a surrogate pair in half — two different emoji share a high surrogate
  // (🌉/🌀 are both U+D83C …), and a signature layer is made of emoji, so a boundary
  // landing mid-pair is reachable and would append a lone surrogate to the record.
  // Both adjustments serve BOTH slices: prefix and suffix are COMMON, so a[p-1] === b[p-1]
  // and a[a.length-s] === b[b.length-s] — pulling the boundary back keeps the pair whole on
  // the `-` side and the `+` side at once.
  if (p > 0 && _isHigh(a.charCodeAt(p - 1))) p--;
  if (s > 0 && _isLow(b.charCodeAt(b.length - s))) s--;
  return { p, s };
}
export function streamIncrement(before, after) {
  const a = String(before ?? ''), b = String(after ?? '');
  if (a === b) return '';
  const { p, s } = _scan(a, b);
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

// WHAT WAS TAKEN BACK — the middle of `before` that `after` does not keep (operator 2026-09-01:
// "forward edits means keeping the diffs after every backwards edit of the model").
//
// His example: a reply streams ab → abcd → abef → abegi → abcdefghi and the record kept only
// `- ab / + abcdefghi`. Every intermediate state was gone, and with it the FACT that the model
// wrote `cd`, then `f`, then `eg`, and took each of them back. streamIncrement above records
// what a frame ADDED and, by design, nothing else — so `abcd`→`abef` logged `ef` and said
// nothing at all about `cd` vanishing from a surface a human was already reading.
//
// THE RULE, and why it does not resurrect the flood 372c17f killed:
//     after.startsWith(before)  →  pure append, nothing was lost, record nothing new
//     otherwise                 →  text was retracted, record the diff
// A streaming reply is appends almost end to end, so the common case still costs zero extra
// bytes; a retraction is rare and ALWAYS means the model changed its mind about something
// already on the surface, which is exactly what deserves a line. The 2026-08-27 ruling (no
// per-frame `edited #<id>` snapshot pair: 492 frames, 35% of the live SPOILER transcript) is
// untouched — this writes the removed text ONCE, never the full before/after pair.
//
// The test is COMPUTED, not restated: an empty middle IS `after.startsWith(before)` for raw
// text, and it is the only form that survives contact with a real node — a live frame is
// wrapped by the bridge signature and ends with the live marker, so a literal startsWith()
// would call EVERY peer frame a retraction and log the whole wrapped text each time. Prefix
// and suffix are both discovered (see _scan); no signature format appears here (372c17f).
export function streamRetraction(before, after) {
  const a = String(before ?? ''), b = String(after ?? '');
  if (a === b) return '';
  const { p, s } = _scan(a, b);
  return a.slice(p, a.length - s);
}

// THE BYTES ONE FRAME CONTRIBUTES to the record: the retraction first (this was taken back),
// then what replaced it, on its own line. Retracted text is FLATTENED to one line exactly as
// editAction flattens a diff side — a blank line inside it would split the stream block and
// every reader that walks blank-line-separated entries would see two.
//
//   e@[fam].wa (14:05): (streaming) Let me look at the config file first…
//       - Let me look at the config file first…
//   42 is the answer.
//
// `    - ` is the notation editAction already uses for "this text is gone", so the file has
// ONE way of saying it. It is a body line inside an open `(streaming)` block, never an entry:
// no `@[`, no `(HH:MM)` of its own, so _ENTRY_HEAD/beingReplyRe/_SENDER_RE cannot read it as a
// message or a speaker. It changes nothing about which entry the block belongs to either — on
// the emitting side the `(streaming)` head is itself an entry head and stops the walk above it;
// on the observing side the train is unlabelled (this node cannot honestly name a peer's being)
// and already reads as continuation of the entry above, so a `    - ` line is no different from
// the increment bytes beside it.
//
// The increment's own restart break (streamIncrement's leading `\n`) is dropped when a
// retraction already opened the line — a divergence is ALWAYS a retraction, so the two rules
// would otherwise emit a blank line between them and split the block in half.
export function streamRecord(before, after) {
  const inc = streamIncrement(before, after);
  const back = streamRetraction(before, after).replace(/\s+/g, ' ').trim();
  if (!back) return inc;
  return `\n    - ${back}\n${inc.startsWith('\n') ? inc.slice(1) : inc}`;
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
// The two demarked sides of a frame, read ONCE — the increment and the retraction are two
// questions about the same pair and must never disagree about what the pair is.
function _frameSides(editBody) {
  const lines = String(editBody ?? '').split('\n');
  const side = (mark) => { const l = lines.find((x) => x.startsWith(mark)); return l == null ? '' : _demark(l.slice(mark.length)); };
  return { minus: side('    - '), plus: side('    + ') };
}
export function liveFrameIncrement(editBody) {
  const { minus, plus } = _frameSides(editBody);
  return streamIncrement(minus, plus);
}

// The OBSERVING half of the retraction ruling (operator 2026-09-01): the same frame, read for
// what it took back as well as what it added. Demarking runs FIRST and that is load-bearing:
// the marker's POSITION moves — the eager placeholder is `⏳ Thinking…` (marker first) and
// every real frame ends with it — so scanning the raw bytes puts OUR OWN token inside the
// retracted middle and writes `⏳` into the record as if the model had said it. (Where the
// marker sits at the end on both sides the common-suffix scan absorbs it and a pure append
// retracts nothing even raw; demarking is what makes that true in every frame, not most.)
//
// The eager `⏳ Thinking…` placeholder IS retracted when the first real frame lands, so a
// streamed peer reply opens with one `    - Thinking…` line. That is honest — the placeholder
// was on the surface and the model replaced it — and it is one line per reply, not per frame.
export function liveFrameRecord(editBody) {
  const { minus, plus } = _frameSides(editBody);
  return streamRecord(minus, plus);
}
