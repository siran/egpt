// room-routing.mjs — PURE fan-out planner for rooms (no side effects).
//
// Given the rooms state and an inbound message from one member, decide which
// rooms it enters and which other members should receive it. Reception is
// unconditional (every other member gets it); the SENDER's state decides
// whether the message contributes at all:
//   active | mention → contributes (humans/groups/shells are spontaneous, not
//                      prompted; for them `mention` is degenerate and behaves
//                      exactly like `active`)
//   muted            → contributes NOTHING. Uniform + absolute — "muted is
//                      muted, period," no member-kind branching.
// (Refined 2026-06-01 — see ROOMS-UNIFICATION.md. The brain-attention split
// between active and mention lives in the executor's brain dispatch, not here:
// planFanout only gates a SENDER's contribution, and senders are non-brains.)
//
// All surfaces are first-class: a member can be a wa-group, tg-group, brain,
// shell, or extension; the planner treats them identically (the executor
// dispatches per kind). The executor handles loop prevention + sending.

// Returns [{ room, sender, targets:[{kind,id,state}] }] — one entry per room
// the message contributes to. `targets` excludes the sender.
export function planFanout(roomsState, fromMemberId) {
  const plans = [];
  for (const [room, r] of Object.entries(roomsState?.rooms ?? {})) {
    const members = r.members ?? [];
    const me = members.find(m => m.id === fromMemberId);
    if (!me) continue;
    const contributes = me.state !== 'muted';   // active|mention contribute; muted is absolute
    if (!contributes) continue;
    const targets = members.filter(m => m.id !== fromMemberId);
    if (targets.length) plans.push({ room, sender: me, targets });
  }
  return plans;
}

// The line written into a room's shared transcript / fanned to surface members.
// Source-qualified so every surface sees who-said-what across the room.
const ROOM_PREFIX = '🏠 ';
export function roomEnvelope({ room, senderLabel, body }) {
  const who = String(senderLabel ?? 'someone').trim() || 'someone';
  return `${ROOM_PREFIX}${room} · ${who}: ${String(body ?? '').trim()}`;
}

// True when a body is ALREADY a room fan-out envelope. The echo/loop breaker:
// a fanned "🏠 <room> · …" arriving at another member must never be re-routed,
// or two active groups would bounce it forever.
export function isRoomEnvelope(body) {
  return String(body ?? '').trimStart().startsWith(ROOM_PREFIX);
}
