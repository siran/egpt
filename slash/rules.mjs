// slash/rules.mjs — emit room etiquette into the transcript.
//
// Same delivery shape as a system message: written to room md, shown
// in the local transcript, mirrored to bridges via the items-mirror
// effect. CDP brains don't read the room md so they won't see this
// until the operator /mirror's the message into a brain tab.
//
// /rules @<who> prepends an @-mention to name the recipient. The
// mention is currently decorative — per-bridge mention encoding
// (push notifications, highlights) is a separate piece of work.

export const meta = {
  cmd: '/rules',
  section: 'ROOM',
  surface: 'shell',
  usage: '/rules',
  desc: 'write room etiquette',
};

export async function run({ arg, ctx }) {
  // ctx keys consumed:
  //   sessions      — snapshot of the current sessions object (React state)
  //   USER_NAME     — operator's handle (mutable let in egpt.mjs)
  //   append(author, body)        — write to room md
  //   setItems(updater)           — append to in-memory items
  const { sessions, USER_NAME, append, setItems } = ctx;

  const recipient = arg.trim().match(/^@(\S+)$/)?.[1] ?? null;
  const all = Object.entries(sessions)
    .map(([n, s]) => `${s.emoji ? s.emoji + ' ' : ''}${n} (${s.brain})${s.bio ? ` — ${s.bio}` : ''}`)
    .join(', ');
  const rules =
    `[Room rules — read once and remember]\n` +
    `Participants right now: ${all || '(no brains yet)'}, plus the human admin (${USER_NAME}).\n` +
    `Every participant is equal. No principal. Admins are the human overlords.\n\n` +
    `You don't have to reply to every message. Only speak when:\n` +
    `- you're directly addressed (your name or @mention),\n` +
    `- you have something specifically useful that hasn't been said,\n` +
    `- the admin asks for your input.\n\n` +
    `Otherwise, reply with literally just \`...\` (three dots) and nothing else.\n` +
    `The system reads that as a polite acknowledgement and won't post it to the room.\n\n` +
    `You may @mention another participant to ask them something. The admin\n` +
    `arbitrates when AI-AI exchanges get loud.\n\n` +
    `Identity slash commands (any participant may use):\n` +
    `  /emoji <name> <emoji>   set your avatar emoji (auto-assigned at join)\n` +
    `  /handle <old> <new>     rename yourself\n` +
    `  /bio <name> <text>      set a short bio visible to others in /sessions and /rules\n` +
    `Admins may also /emoji, /handle, /bio any participant.`;
  const finalRules = recipient ? `(for @${recipient})\n\n${rules}` : rules;
  await append('system', finalRules);
  setItems(p => [...p, { id: Date.now() + Math.random(), author: 'system', body: finalRules }]);
  return true;
}
