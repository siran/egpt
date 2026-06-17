// The ONE identity line every brain sees for an inbound auto-dispatched message.
// Operator-mandated shape (2026-06-12):
//
//   Sender@[chatname/groupname].{node} (HH:MM): body
//
// `{node}` is the ENTRY POINT the message arrived through — the surface/client
// the human used: 'wa' (WhatsApp), 'kg' (the home shell), 'chrome' (the
// extension). It is resolved from the client/surface identity, NEVER hardcoded
// into the template (the bug this replaces: '.wa' baked in, so every line read
// '.wa' no matter the origin). HH:MM is UTC (operator 2026-05-21: all
// timestamps consistent, to match the reply envelope). A voice note arrives
// with its body already prefixed "(voice transcription, Ns) …" by the caller —
// this formatter is body-agnostic.
//
// Pure + exported so tests/dispatch-line.test.mjs locks the shape (CONTRACT
// C7.6). egpt.mjs `formatAutoDispatchLine` is a thin wrapper over this, and the
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

export function formatDispatchLine({ senderName, chatName, node, surface, body, ts, msgId, stageDirection = false } = {}) {
  const d = new Date(ts ?? Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  const tstr = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
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
  return `${sender}@[${nm}].${nd} (${tstr})${idTag}: ${body ?? ''}`;
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
// text changed after it was sent → `edited #<id> "old" → "new"`. Append-only: the
// original line stays in the transcript; this records the correction (so E sees
// e.g. that "imbécil" was softened to "pobrecito"). Pure + test-locked.
export function editAction({ targetId, oldText, newText } = {}) {
  const id = String(targetId ?? '').trim();
  const o = String(oldText ?? '').replace(/\s+/g, ' ').trim().slice(0, 50);
  const n = String(newText ?? '').replace(/\s+/g, ' ').trim().slice(0, 50);
  return `edited #${id} "${o}" → "${n}"`;
}
