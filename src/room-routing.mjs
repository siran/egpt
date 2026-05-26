// room-routing.mjs — PURE fan-out planner for rooms (no side effects).
//
// Given the rooms state and an inbound message from one member, decide which
// rooms it enters and which other members should receive it. Reception is
// unconditional (every other member gets it); the SENDER's state decides
// whether the message contributes at all:
//   active            → contributes
//   mention + @mention→ contributes (the message named a room participant)
//   muted / mention-no-mention → does NOT enter the room
//
// All surfaces are first-class: a member can be a wa-group, tg-group, brain,
// shell, or extension; the planner treats them identically (the executor
// dispatches per kind). The executor handles loop prevention + sending.

// Returns [{ room, sender, targets:[{kind,id,state}] }] — one entry per room
// the message contributes to. `targets` excludes the sender.
export function planFanout(roomsState, fromMemberId, { atEAnywhere = false } = {}) {
  const plans = [];
  for (const [room, r] of Object.entries(roomsState?.rooms ?? {})) {
    const members = r.members ?? [];
    const me = members.find(m => m.id === fromMemberId);
    if (!me) continue;
    const contributes = me.state === 'active' || (me.state === 'mention' && atEAnywhere);
    if (!contributes) continue;
    const targets = members.filter(m => m.id !== fromMemberId);
    if (targets.length) plans.push({ room, sender: me, targets });
  }
  return plans;
}

// The line written into a room's shared transcript / fanned to surface members.
// Source-qualified so every surface sees who-said-what across the room.
export function roomEnvelope({ room, senderLabel, body }) {
  const who = String(senderLabel ?? 'someone').trim() || 'someone';
  return `🏠 ${room} · ${who}: ${String(body ?? '').trim()}`;
}
