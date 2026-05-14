// slash/recap.mjs — chronological one-liner recap of recent activity
// across observed chats.
//
// Distinct from /last (which reads the room transcript and only shows
// chats joined / in egpt_chats) and /channels (which is per-chat,
// not chronological). /recap merges every observed chat's recent[]
// ring into one sorted stream — useful when the operator wants the
// time-rhythm of what's been going on without scrolling through
// per-chat lists.
//
// /recap            last 30 messages (default)
// /recap N          last N messages
//
// Pre-restart messages held by /wa-pending / /tg-pending also appear
// here (their bodies are in the chat's recent[] ring regardless of
// whether the brain was dispatched).

import { buildRecap } from '../tools/logon-summary.mjs';

export const meta = {
  cmd: '/recap',
  section: 'ROOM',
  surface: 'shell',
  usage: '/recap [N]',
  desc:
    'chronological one-liner recap of recent activity across all observed ' +
    'chats (default last 30). Unlike /last (room transcript only) or ' +
    '/channels (per-chat), /recap merges everything by timestamp.',
};

export async function run({ arg, ctx }) {
  // ctx keys consumed:
  //   sysOut(text)
  const { sysOut } = ctx;

  const n = parseInt(arg.trim(), 10);
  const max = Number.isFinite(n) && n > 0 ? Math.min(n, 500) : 30;

  const out = await buildRecap({ max });
  if (!out) {
    sysOut('(no recent activity to recap — bridges may not have synced yet)');
    return true;
  }
  sysOut(out);
  return true;
}
