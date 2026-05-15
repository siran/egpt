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
import { waListToStableCache as _waListToStableCache } from '../tools/wa-bindings.mjs';

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
  //   waChannelsCacheRef — React ref; refreshed in display order so
  //     '@waN <body>' / '/join @waN' / '/pin @waN' etc. resolve to the
  //     same chat the operator just read in the recap output. Same
  //     contract /channels uses.
  //   waBridgeRef — fire-and-forget group-name backfill: each chat
  //     in the recap that's a group without a name triggers
  //     wa.ensureGroupName(jid) so the NEXT /recap (or live render)
  //     shows the real subject instead of the bare JID prefix.
  const { sysOut, registerReplyTarget, theme, waChannelsCacheRef, waBridgeRef } = ctx;

  const tokens = arg.trim().split(/\s+/).filter(Boolean);
  const includeDms = tokens.some(t => t === '--all' || t === '-a');
  const numTok = tokens.find(t => /^\d+$/.test(t));
  const n = numTok ? parseInt(numTok, 10) : NaN;
  // /recap N now means "N previews per selected chat" (default 3),
  // matching /channels' compact shape. Selection itself is curated:
  // pinned chats always in full, top 5 unpinned per section by
  // lastActivityTs. Disk retention stays infinite — only the
  // displayed slice is bounded.
  const max = Number.isFinite(n) && n > 0 ? n : undefined;

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
  if (waChannelsCacheRef && Array.isArray(out.chatList)) {
    // Wrap through waListToStableCache — @waN stays bound to the
    // chat it first claimed (session-scoped), so recency reorders
    // between /recap and the operator's next /movie / /pin /
    // /oracle dispatch don't silently retarget the command.
    waChannelsCacheRef.current = _waListToStableCache(out.chatList);
  }
  // Fire-and-forget group-name backfill for any group whose disk
  // record lacks a subject. Idempotent — _ensureGroupName skips
  // chats that already have a name or have a lookup in flight.
  // Results show up on the NEXT /recap (or live message arrival).
  const wa = waBridgeRef?.current;
  if (wa?.ensureGroupName && Array.isArray(out.chatList)) {
    for (const c of out.chatList) {
      if (c.isGroup && (!c.name || c.name.length <= 1)) {
        try { wa.ensureGroupName(c.jid); } catch {}
      }
    }
  }
  // _recap + _recapRows: the renderer's _recap branch uses _recapRows
  // for per-column colored rendering; body stays as the flat text so
  // any non-Ink fallback (mirror, transcript) still gets readable
  // output without color.
  sysOut(out.text, { _recap: true, _recapRows: out.rows });
  return true;
}
