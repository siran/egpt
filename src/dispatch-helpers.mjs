// src/dispatch-helpers.mjs — pure, closure-free dispatch helpers lifted out of
// egpt-spine.mjs's App component (Phase C: shrinking the App toward an engine
// module, one cohesive unit at a time). No refs, no config, no React — just
// message/mode string logic, so they import cleanly into the App today and the
// engine tomorrow.

// The per-mode coaching note prepended to E's prompt so it knows how its replies
// are surfaced for this chat (CONTRACTS auto-mode).
export const MODE_NOTES = {
  on:               '(Chat reply mode: all. You can reply at will, and your replies are surfaced to the chat.)',
  accum:            '(Chat reply mode: accum. Messages are batched and shown to you together; you reply only when @mentioned, and that reply carries the batch.)',
  mute:             '(Chat reply mode: mute. You receive messages for context, but your replies are never surfaced.)',
  'mention-direct': '(Chat reply mode: mention-direct. You can reply at will, but a reply is only surfaced when @e starts a message or someone replies to you.)',
  mention:          '(Chat reply mode: mention. You can reply at will, but a reply is only surfaced when you are @mentioned.)',
  off:              '(Chat reply mode: off.)',
};
export const modeNote = (mode) => MODE_NOTES[mode] ?? MODE_NOTES.mention;

// Does the body @mention a brain by name (@e/@egpt for 'e', else @<id>)?
export const bodyMentionsBrain = (body, id) => {
  const alts = (id === 'e' || id === 'egpt') ? ['e', 'egpt'] : [String(id)];
  const esc = alts.map(a => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`(^|\\s)@(?:${esc})\\b`, 'i').test(String(body ?? ''));
};

// Does the body @mention ANY of these names (a sibling's canonical name OR alias)?
export const bodyMentionsAny = (body, names) => {
  const esc = names.map(a => String(a).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).filter(Boolean).join('|');
  if (!esc) return false;
  return new RegExp(`(^|\\s)@(?:${esc})\\b`, 'i').test(String(body ?? ''));
};
