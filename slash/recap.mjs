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
// /recap            last 30 messages, groups + status only (no DMs)
// /recap N          last N messages, same scope
// /recap --all      include 1:1 DMs in the stream
// /recap N --all    both
//
// DMs are hidden by default because the operator typically reads them
// directly in WA / TG and doesn't need them re-surfaced at logon
// alongside groups and status. --all opts in to the full picture.
//
// Pre-restart messages held by /wa-pending / /tg-pending also appear
// here (their bodies are in the chat's recent[] ring regardless of
// whether the brain was dispatched).

import { buildRecap } from '../tools/logon-summary.mjs';

export const meta = {
  cmd: '/recap',
  section: 'ROOM',
  surface: 'shell',
  usage: '/recap [N] [--all]',
  desc:
    'chronological one-liner recap of recent activity (default last 30, ' +
    'groups + status only). --all includes 1:1 DMs. Unlike /last (room ' +
    'transcript only) or /channels (per-chat), /recap merges everything ' +
    'by timestamp.',
};

export async function run({ arg, ctx }) {
  // ctx keys consumed:
  //   sysOut(text, extras)
  //   registerReplyTarget(stableId, rt)  — wires each shown row into
  //     the shell's reply-target sidecar so '@wa-<id> body' resolves
  //     even for messages the operator never directly interacted with
  //     (recent[] in wa-chats.json doesn't auto-populate the sidecar).
  //   theme  — active theme palette; we read the recap section emojis
  //     so each theme can carry its own personality (🐈 for catppuccin,
  //     🦇 for dracula, 🌊 for ocean…). Renderer reads recap*Color
  //     keys directly from the same palette.
  const { sysOut, registerReplyTarget, theme } = ctx;

  const tokens = arg.trim().split(/\s+/).filter(Boolean);
  const includeDms = tokens.some(t => t === '--all' || t === '-a');
  const numTok = tokens.find(t => /^\d+$/.test(t));
  const n = numTok ? parseInt(numTok, 10) : NaN;
  const max = Number.isFinite(n) && n > 0 ? Math.min(n, 500) : 30;

  const emojis = theme ? {
    pinned: theme.recapEmojiPinned,
    group:  theme.recapEmojiGroup,
    status: theme.recapEmojiStatus,
    dm:     theme.recapEmojiDm,
  } : null;

  const out = await buildRecap({ max, includeDms, emojis });
  if (!out) {
    sysOut('(no recent activity to recap — bridges may not have synced yet)');
    return true;
  }
  if (typeof registerReplyTarget === 'function') {
    for (const e of out.entries) registerReplyTarget(e.stableId, e.replyTarget);
  }
  // _recap + _recapRows: the renderer's _recap branch uses _recapRows
  // for per-column colored rendering; body stays as the flat text so
  // any non-Ink fallback (mirror, transcript) still gets readable
  // output without color.
  sysOut(out.text, { _recap: true, _recapRows: out.rows });
  return true;
}
