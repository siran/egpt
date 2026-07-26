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
