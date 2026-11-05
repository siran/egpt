// flood-ban.mjs — auto-mute a sender who dumps a BURST OF MEDIA into one chat (the
// "whatsapp virus": GIFs/stickers/images that pollute E's accumulated context and bloat
// the chat's media/ folder). A single sender posting >= `count` media attachments inside
// `windowMs`, in one (surface, chatId), is BANNED for `cooldownMs`. The bridge consults
// this BEFORE it saves or dispatches: while banned, EVERY message of that sender in that
// chat — media AND plain text — is dropped before persistMedia + onIncoming, so nothing of
// theirs reaches disk or the spine. The ban lifts LAZILY on the next observe/isBanned past
// the cooldown (no timer). In-memory per (surface, chatId, senderId): a restart re-arms
// detection, exactly like stop-guard.mjs. `neverBan` (match senderId OR display name) is
// exempt. Modeled on src/stop-guard.mjs — injected `now`, directly unit-testable.

const SEP = '\u0000';
const KEY = (surface, chatId, senderId) => `${surface}${SEP}${chatId}${SEP}${senderId}`;
const lc = (x) => String(x ?? '').toLowerCase();

// NEW-CHAT BURST (operator 2026-11-05: a linked Telegram imported years of chats at once). More than
// NEW_CHAT_BURST chats the node has never seen, first seen within NEW_CHAT_WINDOW_MS on one connection,
// hold every chat first seen in that window as backlog — and every later one — until a window passes
// with no new chat. Lifts lazily, like a ban.
export const NEW_CHAT_BURST = 10;
export const NEW_CHAT_WINDOW_MS = 5 * 60_000;

export function createFloodBan({
  count = 5, windowMs = 20_000, cooldownMs = 600_000,
  neverBan = [], now = () => Date.now(), onLog = () => {},
} = {}) {
  const hits = new Map();   // key -> [t,...] recent MEDIA timestamps (the sliding window)
  const bans = new Map();   // key -> { until, senderName, chatName }
  const newChats = new Map();   // connection -> { firsts: Map(chatId -> t) in the window, held: Set | null, last }
  const never = new Set(neverBan.map(lc).filter(Boolean));

  const isNever = (senderId, senderName) => never.has(lc(senderId)) || never.has(lc(senderName));

  // Lazily expire a stale ban, emitting the lift notice once. Returns whether still banned.
  function live(key) {
    const b = bans.get(key);
    if (!b) return false;
    if (now() >= b.until) {
      bans.delete(key);
      onLog(`flood-ban lifted: ${b.senderName} in ${b.chatName}`);
      return false;
    }
    return true;
  }

  return {
    isBanned(surface, chatId, senderId) { return live(KEY(surface, chatId, senderId)); },

    // Record one inbound message; transition into banned when media crosses `count` in
    // `windowMs`. Only MEDIA advances the window; a non-media turn is a no-op on the count.
    observe(surface, chatId, senderId, { isMedia = false, senderName = '', chatName = '' } = {}) {
      const key = KEY(surface, chatId, senderId);
      if (live(key)) return { banned: true, justBanned: false };
      if (!(count > 0)) return { banned: false, justBanned: false };       // disabled
      if (!isMedia) return { banned: false, justBanned: false };
      if (isNever(senderId, senderName)) return { banned: false, justBanned: false };
      const t = now();
      const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
      arr.push(t);
      if (arr.length >= count) {
        hits.delete(key);
        bans.set(key, { until: t + cooldownMs, senderName: String(senderName || senderId), chatName: String(chatName || chatId) });
        onLog(`flood-ban: ${senderName || senderId} in ${chatName || chatId} — ${arr.length} media in ${Math.round(windowMs / 1000)}s, muted ${Math.round(cooldownMs / 60_000)}m`);
        return { banned: true, justBanned: true };
      }
      hits.set(key, arr);
      return { banned: false, justBanned: false };
    },

    // Is this chat held as backlog? `isNew`: the node has never seen it (the caller's conversations.yaml read).
    // `notice`: the start line, on the one call that starts a burst (boot posts it to the admin chat).
    observeChat(connection, chatId, { isNew = false, chatName = '' } = {}) {
      const t = now();
      let notice = null;
      let b = newChats.get(connection);
      if (!b) newChats.set(connection, (b = { firsts: new Map(), held: null, last: 0 }));
      for (const [c, at] of b.firsts) { if (t - at < NEW_CHAT_WINDOW_MS) break; b.firsts.delete(c); }
      if (b.held && t - b.last >= NEW_CHAT_WINDOW_MS) {
        onLog(`new-chat burst on ${connection} lifted: ${b.held.size} chats were held`);
        b.held = null;
      }
      if (isNew && !b.firsts.has(chatId) && !b.held?.has(chatId)) {
        b.firsts.set(chatId, t);
        b.last = t;
        if (b.held) b.held.add(chatId);
        else if (b.firsts.size > NEW_CHAT_BURST) {
          b.held = new Set(b.firsts.keys());
          const m = NEW_CHAT_WINDOW_MS / 60_000;
          notice = `new-chat burst on ${connection}: ${b.firsts.size} new chats in ${m}m (last: ${chatName || chatId}) — every chat first seen in it is held as backlog (recorded, not dispatched, not transcribed) until ${m}m pass with no new chat`;
          onLog(notice);
        }
      }
      return { held: !!b.held?.has(chatId), notice };
    },

    // A ban decided by a caller rather than the media counter (commands.mjs: the /agents flood).
    // Same mute, cooldown, never_ban, /bans and /unban. Returns whether the sender is banned now.
    ban(surface, chatId, senderId, { reason = 'flood', senderName = '', chatName = '' } = {}) {
      if (isNever(senderId, senderName)) return false;
      const key = KEY(surface, chatId, senderId);
      if (live(key)) return true;
      hits.delete(key);
      bans.set(key, { until: now() + cooldownMs, senderName: String(senderName || senderId), chatName: String(chatName || chatId), reason });
      onLog(`flood-ban: ${senderName || senderId} in ${chatName || chatId} — ${reason}, muted ${Math.round(cooldownMs / 60_000)}m`);
      return true;
    },

    // Clear active ban(s) in a (surface, chatId); optional name filter matches senderId OR
    // display name (case-insensitive). Returns how many were cleared.
    unban(surface, chatId, senderName) {
      const want = senderName != null && String(senderName).trim() !== '' ? lc(senderName) : null;
      let n = 0;
      for (const [key, b] of [...bans]) {
        const [s, c, sid] = key.split(SEP);
        if (s !== surface || c !== chatId) continue;
        if (want != null && lc(b.senderName) !== want && lc(sid) !== want) continue;
        bans.delete(key); hits.delete(key); n++;
        onLog(`flood-ban cleared: ${b.senderName} in ${b.chatName}`);
      }
      return n;
    },

    // Active bans (for /bans), stale ones expired first.
    list() {
      const out = [];
      for (const key of [...bans.keys()]) {
        if (!live(key)) continue;
        const b = bans.get(key);
        const [surface, chatId, senderId] = key.split(SEP);
        out.push({ surface, chatId, senderId, senderName: b.senderName, chatName: b.chatName, until: b.until, ...(b.reason ? { reason: b.reason } : {}) });
      }
      return out;
    },
  };
}
