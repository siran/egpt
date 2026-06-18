// Bridge item formatting for Telegram and WhatsApp mirrors.
//
// Pure helpers: callers pass the resolved node/user/config values instead of
// reading spine globals. This keeps item-append mirror logic runtime-safe
// without dragging UI surfaces along with it.

import { emojiForAuthor } from '../author-emoji.mjs';

export const escapeHtml = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function mdToTgHtml(text) {
  const s = String(text ?? '');
  const parts = s.split(/(```[\w]*\n?[\s\S]*?```)/g);
  return parts.map((part, i) => {
    if (i % 2 === 1) {
      const inner = part.replace(/^```[\w]*\n?/, '').replace(/```$/, '');
      return `<pre>${escapeHtml(inner.trim())}</pre>`;
    }
    let r = escapeHtml(part);
    r = r
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/__([^_\n]+)__/g, '<b>$1</b>')
      .replace(/\*([^*\n]+)\*/g, '<i>$1</i>')
      .replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, '<i>$1</i>')
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
      .replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
    return r;
  }).join('');
}

function authorEmoji(item, sessions, opts) {
  return emojiForAuthor(item?.author, sessions, opts.authorEmojiOptions ?? {});
}

function formatOptions(opts = {}) {
  return {
    egptEmoji: opts.egptEmoji ?? '🧠',
    userEmoji: opts.userEmoji ?? '🦅',
    userName: opts.userName ?? 'egptbot',
    surfaceTag: opts.surfaceTag ?? 'shell',
    mirrorHeaders: opts.mirrorHeaders ?? 'all',
    authorEmojiOptions: opts.authorEmojiOptions ?? {},
  };
}

export function formatItemForTelegram(item, sessions, opts = {}) {
  const o = formatOptions(opts);
  if (item.author === 'system') {
    if (item._tgBody) return item._tgBody;
    return `${o.egptEmoji} <b>egpt@${o.surfaceTag}</b>\n<i>${escapeHtml(item.body)}</i>`;
  }
  if (item.author === 'You') {
    return `${o.userEmoji} <b>${escapeHtml(o.userName)}@${o.surfaceTag}</b>\n${escapeHtml(item.body)}`;
  }
  const tagged = String(item.author).includes('@') ? item.author : `${item.author}@${o.surfaceTag}`;
  return `${authorEmoji(item, sessions, o)} <b>${escapeHtml(tagged)}</b>\n${mdToTgHtml(item.body)}`;
}

export function isBrainAuthor(item, sessions) {
  if (item.author === 'system') return true;
  const bare = String(item.author ?? '').split('@')[0];
  if (bare === 'egpt' || bare === 'e') return true;
  if (sessions?.[bare]) return true;
  return false;
}

export function formatItemForWhatsApp(item, sessions, opts = {}) {
  const o = formatOptions(opts);
  const keepHeader = o.mirrorHeaders === 'all'
    || (o.mirrorHeaders === 'brain_only' && isBrainAuthor(item, sessions));
  if (!keepHeader) return item.body;
  if (item.author === 'system') return `${o.egptEmoji} egpt@${o.surfaceTag}\n${item.body}`;
  if (item.author === 'You') return `${o.userEmoji} ${o.userName}@${o.surfaceTag}\n${item.body}`;
  const tagged = String(item.author).includes('@') ? item.author : `${item.author}@${o.surfaceTag}`;
  return `${authorEmoji(item, sessions, o)} ${tagged}\n${item.body}`;
}
