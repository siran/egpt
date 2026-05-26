// slash/react.mjs — react to a WhatsApp message with an emoji.
//
// Two address forms, mirroring the @-reply handler:
//   /react @waN <emoji>        — react to the most-recent message in chat @waN
//                                (resolves against the last /recap or /channels)
//   /react @wa-<msgId> <emoji>  — react to a specific message
//                                (resolves against the reply-target sidecar)
//
// <emoji> can be a literal emoji ('👍', '❤️', '😂') or a short word
// alias (see ALIASES below). Pass an empty string to remove a
// previous reaction from the same target ('/react @waN '').

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const ALIASES = {
  // Approval / agreement
  like:        '👍',
  thumbs:      '👍',
  yes:         '👍',
  ok:          '👌',
  perfect:     '💯',
  '100':       '💯',
  check:       '✅',
  clap:        '👏',
  // Disapproval / disagreement
  no:          '👎',
  thumbsdown:  '👎',
  cross:       '❌',
  x:           '❌',
  // Love / heart
  heart:       '❤️',
  love:        '❤️',
  loveeyes:    '😍',
  kiss:        '😘',
  // Laughter (escalating)
  laugh:       '😂',
  lol:         '😂',
  joy:         '🤣',
  lmao:        '🤣',
  rofl:        '🤣',
  // Sadness (escalating)
  sad:         '😢',
  cry:         '😢',
  bigcry:      '😭',
  sob:         '😭',
  bawl:        '😭',
  // Surprise / shock (escalating)
  wow:         '😮',
  surprise:    '😮',
  shock:       '😱',
  headexplode: '🤯',
  mindblown:   '🤯',
  mind:        '🤯',
  // Disgust (escalating)
  yuck:        '🤢',
  sick:        '🤢',
  puke:        '🤮',
  vomit:       '🤮',
  // Reactions to dumb / facepalm / hmm
  think:       '🤔',
  thinking:    '🤔',
  hmm:         '🤔',
  facepalm:    '🤦',
  shrug:       '🤷',
  // Vibes
  fire:        '🔥',
  hot:         '🔥',
  cool:        '😎',
  party:       '🎉',
  star:        '⭐',
  rocket:      '🚀',
  skull:       '💀',
  ghost:       '👻',
  eye:         '👀',
  look:        '👀',
  greed:       '🤑',
  money:       '🤑',
  pray:        '🙏',
  thanks:      '🙏',
  evil:        '😈',
  angel:       '😇',
  sleep:       '😴',
};

export const meta = {
  cmd: '/react',
  section: 'ROOM',
  surface: 'shell',
  usage: '/react @waN|@wa-<msgId> <emoji|alias>',
  desc:
    'react to a WhatsApp message with an emoji. @waN reacts to the chat\'s ' +
    'most recent message (from the last /recap / /channels); @wa-<msgId> ' +
    'reacts to a specific message. Aliases: like, heart, laugh, wow, sad, ' +
    'pray, fire, yuck, ok, no, party, star, etc. Pass an empty emoji to ' +
    'remove a prior reaction.',
};

export async function run({ arg, ctx, meta = {} }) {
  // ctx keys consumed:
  //   sysOut(text)
  //   waBridgeRef           — React ref to the WA bridge (exposes react())
  //   waChannelsCacheRef    — React ref to the last @waN listing
  const { sysOut, waBridgeRef, waChannelsCacheRef } = ctx;

  const wa = waBridgeRef?.current;
  if (!wa?.react) {
    sysOut('!! /react: whatsapp bridge not running');
    return true;
  }

  const parts = arg.trim().split(/\s+/).filter(Boolean);
  const targetTok = parts[0];

  // Contextual form (resident-emitted, operator 2026-05-26): `/react <emoji>`
  // with no @target reacts to the message that TRIGGERED this turn — the key
  // rides in meta.waMsgKey / meta.waChatId. Lets conversation-e react to what
  // it's replying to without knowing @waN indices or msg-ids. The whole arg is
  // the emoji here (there's no target token to strip).
  const looksLikeTarget = /^@(?:wa|tg)[-_0-9]/i.test(targetTok ?? '');
  if (!looksLikeTarget && meta?.waMsgKey?.id && meta?.waChatId) {
    const e = ALIASES[arg.trim().toLowerCase()] ?? arg.trim();
    const key = {
      id: meta.waMsgKey.id,
      fromMe: !!meta.waMsgKey.fromMe,
      remoteJid: meta.waMsgKey.remoteJid ?? meta.waChatId,
      ...(meta.waMsgKey.participant ? { participant: meta.waMsgKey.participant } : {}),
    };
    const r = await wa.react({ chatId: meta.waChatId, key, emoji: e });
    if (r?.key) sysOut(`${e ? `reacted ${e} to` : 'cleared reaction on'} the current message`);
    else sysOut('!! /react: bridge returned no key — message may not have reached WA');
    return true;
  }
  // Treat everything after the target as the emoji argument, so
  // multi-codepoint emojis split by an intermediate VS-16 / ZWJ on
  // some clipboards still land intact. Empty string removes.
  const emojiArg = parts.slice(1).join(' ');
  if (!targetTok) {
    sysOut(`!! usage: ${meta.usage}`);
    return true;
  }

  const emoji = ALIASES[emojiArg.toLowerCase()] ?? emojiArg;
  // Emoji can be empty (removal) — that's an explicit '/react @waN '
  // form. Anything that's NOT an alias AND has non-printable shape
  // is still allowed; baileys just sends whatever string we pass.

  // @waN form — most-recent message in that chat.
  const waN = targetTok.match(/^@wa(\d+)$/i);
  if (waN) {
    const idx = parseInt(waN[1], 10) - 1;
    const chat = waChannelsCacheRef?.current?.[idx];
    if (!chat) {
      sysOut(`!! /react: no chat at ${targetTok} — /recap or /channels first to populate indices`);
      return true;
    }
    // Most-recent recent[] entry with a usable key. recent[] is
    // sorted oldest→newest, so the tail is what we want.
    const recent = Array.isArray(chat.recent) ? chat.recent : [];
    const target = [...recent].reverse().find(r => r?.key?.id);
    if (!target) {
      sysOut(`!! /react: ${targetTok} "${chat.name}" has no message with a key in recent[]`);
      return true;
    }
    const key = { id: target.key.id, fromMe: !!target.key.fromMe, remoteJid: chat.jid };
    const r = await wa.react({ chatId: chat.jid, key, emoji });
    if (r?.key) {
      const verb = emoji ? `reacted ${emoji} to` : 'cleared reaction on';
      sysOut(`${verb} ${targetTok} "${chat.name}" → ${target.author ?? '?'}: ${(target.text ?? '').slice(0, 60)}`);
    } else {
      sysOut(`!! /react: bridge returned no key — message may not have reached WA`);
    }
    return true;
  }

  // @wa-<msgId> / @wa_<msgId> form — look up the reply-target
  // sidecar (same store the @-reply handler uses). The sidecar
  // lives next to the room transcript; we read it directly so the
  // command works even for ids that came from /recap (they're
  // already registered) but the operator hasn't typed an @reply
  // for yet.
  const stable = targetTok.match(/^@((?:wa|tg)[-_][A-Za-z0-9-]+)$/i);
  if (stable) {
    const stableId = stable[1].replace(/^([a-z]+)_/, '$1-');
    const sidecar = _loadReplyTargetSidecar();
    let rt = sidecar.get(stableId);
    if (!rt) {
      const matches = [...sidecar.keys()].filter(k => k.startsWith(stableId));
      if (matches.length === 1) rt = sidecar.get(matches[0]);
      else if (matches.length > 1) {
        sysOut(`!! /react: @${stable[1]} ambiguous — matches ${matches.length} ids`);
        return true;
      }
    }
    if (!rt?.key?.id || !rt?.chatId) {
      sysOut(`!! /react: no reply-target for @${stable[1]} in sidecar — /recap to register, then retry`);
      return true;
    }
    const r = await wa.react({ chatId: rt.chatId, key: rt.key, emoji });
    if (r?.key) {
      const verb = emoji ? `reacted ${emoji} to` : 'cleared reaction on';
      sysOut(`${verb} @${stable[1]}`);
    } else {
      sysOut(`!! /react: bridge returned no key`);
    }
    return true;
  }

  sysOut(`!! /react: "${targetTok}" isn't @waN or @wa-<msgId>`);
  return true;
}

// Read the room's reply-target sidecar directly so /react works
// without depending on the shell's in-memory persistedReplyTargets
// (which only lives inside the App component). Same on-disk schema:
// JSON object keyed by stableId.
function _loadReplyTargetSidecar() {
  const out = new Map();
  // Sidecar lives next to the current conversation md. We don't
  // know which room is active here, but the default room's
  // sidecar is conversation.replytargets.json in the cwd —
  // matching transcriptFileForRoom('default') + '.replytargets'.
  const candidates = [
    join(process.cwd(), 'conversation.replytargets.json'),
    join(homedir(), '.egpt', 'rooms', 'default.replytargets.json'),
  ];
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const raw = readFileSync(p, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) out.set(k, v);
      }
    } catch {}
  }
  return out;
}
