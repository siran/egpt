// flood-ban.test.mjs — the media-flood auto-ban (src/flood-ban.mjs). A sender who dumps a
// burst of media (GIFs/stickers/images, "a whatsapp virus") into one chat is muted for a
// cooldown so NOTHING of theirs enters the accumulator or hits disk; the ban lifts lazily.
// Injected `now` drives the sliding window, the same style as guard-rate-repetition.test.mjs.
import { describe, it, expect } from 'vitest';
import { createFloodBan } from '../src/flood-ban.mjs';

const S = 'whatsapp', CH = 'chat-1';
const media = (senderName = 'Flooder', chatName = 'La Familia') => ({ isMedia: true, senderName, chatName });
const text = (senderName = 'Flooder', chatName = 'La Familia') => ({ isMedia: false, senderName, chatName });

describe('flood-ban: a media burst from one sender auto-mutes them', () => {
  it('`count` media within window → A banned; the NEXT message (media OR text) reports banned, notice once', () => {
    let t = 0;
    const notices = [];
    const fb = createFloodBan({ count: 5, windowMs: 20_000, cooldownMs: 600_000, now: () => t, onLog: (m) => notices.push(m) });
    let last;
    for (let i = 0; i < 5; i++) { t += 2_000; last = fb.observe(S, CH, 'A', media()); }
    expect(last).toEqual({ banned: true, justBanned: true });          // the 5th tips it
    expect(fb.isBanned(S, CH, 'A')).toBe(true);
    // the next media is banned, and so is the next plain text
    t += 2_000;
    expect(fb.observe(S, CH, 'A', media())).toEqual({ banned: true, justBanned: false });
    expect(fb.observe(S, CH, 'A', text())).toEqual({ banned: true, justBanned: false });
    expect(notices.filter((m) => /^flood-ban: /.test(m))).toHaveLength(1);   // exactly one ban notice
    expect(notices[0]).toMatch(/flood-ban: Flooder in La Familia — 5 media in 20s, muted 10m/);
  });

  it('A\'s plain TEXT during the cooldown is dropped (banned) too', () => {
    let t = 0;
    const fb = createFloodBan({ count: 3, windowMs: 20_000, cooldownMs: 600_000, now: () => t });
    for (let i = 0; i < 3; i++) { t += 1_000; fb.observe(S, CH, 'A', media()); }
    expect(fb.isBanned(S, CH, 'A')).toBe(true);
    t += 5 * 60_000;   // well within the 10-min cooldown
    expect(fb.isBanned(S, CH, 'A')).toBe(true);
    expect(fb.observe(S, CH, 'A', text()).banned).toBe(true);
  });

  it('after cooldownMs the ban lifts (lazy), with a lift notice', () => {
    let t = 0;
    const notices = [];
    const fb = createFloodBan({ count: 3, windowMs: 20_000, cooldownMs: 600_000, now: () => t, onLog: (m) => notices.push(m) });
    for (let i = 0; i < 3; i++) { t += 1_000; fb.observe(S, CH, 'A', media()); }
    expect(fb.isBanned(S, CH, 'A')).toBe(true);
    t += 600_001;   // past the cooldown
    expect(fb.isBanned(S, CH, 'A')).toBe(false);
    expect(notices.some((m) => /^flood-ban lifted: Flooder in La Familia/.test(m))).toBe(true);
  });

  it('a slow drip never bans — fewer than count, or media spread beyond the window', () => {
    let t = 0;
    const slow = createFloodBan({ count: 5, windowMs: 20_000, cooldownMs: 600_000, now: () => t });
    // count-1 media, fast → not enough
    for (let i = 0; i < 4; i++) { t += 1_000; expect(slow.observe(S, CH, 'A', media()).banned).toBe(false); }
    expect(slow.isBanned(S, CH, 'A')).toBe(false);

    // 5 media but each > windowMs apart → the window never holds `count` at once
    let u = 0;
    const drip = createFloodBan({ count: 5, windowMs: 20_000, cooldownMs: 600_000, now: () => u });
    for (let i = 0; i < 5; i++) { u += 25_000; expect(drip.observe(S, CH, 'A', media()).banned).toBe(false); }
    expect(drip.isBanned(S, CH, 'A')).toBe(false);
  });

  it('a DIFFERENT sender B is unaffected while A is banned', () => {
    let t = 0;
    const fb = createFloodBan({ count: 3, windowMs: 20_000, cooldownMs: 600_000, now: () => t });
    for (let i = 0; i < 3; i++) { t += 1_000; fb.observe(S, CH, 'A', media('A')); }
    expect(fb.isBanned(S, CH, 'A')).toBe(true);
    expect(fb.isBanned(S, CH, 'B')).toBe(false);
    // B may flood media of its own without A's ban touching it
    t += 1_000; expect(fb.observe(S, CH, 'B', media('B')).banned).toBe(false);
    expect(fb.isBanned(S, CH, 'B')).toBe(false);
  });

  it('a never_ban sender never bans even while flooding (matched by id OR display name)', () => {
    let t = 0;
    const byId = createFloodBan({ count: 3, windowMs: 20_000, cooldownMs: 600_000, neverBan: ['op-id'], now: () => t });
    for (let i = 0; i < 6; i++) { t += 1_000; expect(byId.observe(S, CH, 'op-id', media('Operator')).banned).toBe(false); }
    expect(byId.isBanned(S, CH, 'op-id')).toBe(false);

    let u = 0;
    const byName = createFloodBan({ count: 3, windowMs: 20_000, cooldownMs: 600_000, neverBan: ['Operator'], now: () => u });
    for (let i = 0; i < 6; i++) { u += 1_000; expect(byName.observe(S, CH, 'xyz', media('Operator')).banned).toBe(false); }
    expect(byName.isBanned(S, CH, 'xyz')).toBe(false);
  });

  it('unban() lifts the ban early; list() reports active bans; unban by name filters', () => {
    let t = 0;
    const fb = createFloodBan({ count: 3, windowMs: 20_000, cooldownMs: 600_000, now: () => t });
    for (let i = 0; i < 3; i++) { t += 1_000; fb.observe(S, CH, 'A', media('Alice')); }
    for (let i = 0; i < 3; i++) { t += 1_000; fb.observe(S, CH, 'B', media('Bob')); }
    expect(fb.list().map((b) => b.senderName).sort()).toEqual(['Alice', 'Bob']);

    // name filter clears only the match
    expect(fb.unban(S, CH, 'Alice')).toBe(1);
    expect(fb.isBanned(S, CH, 'A')).toBe(false);
    expect(fb.isBanned(S, CH, 'B')).toBe(true);

    // bare unban clears the rest in this chat
    expect(fb.unban(S, CH)).toBe(1);
    expect(fb.isBanned(S, CH, 'B')).toBe(false);
    expect(fb.list()).toEqual([]);
  });

  it('count <= 0 disables the whole guard', () => {
    let t = 0;
    const off = createFloodBan({ count: 0, windowMs: 20_000, cooldownMs: 600_000, now: () => t });
    for (let i = 0; i < 10; i++) { t += 100; off.observe(S, CH, 'A', media()); }
    expect(off.isBanned(S, CH, 'A')).toBe(false);
  });
});

describe('flood-ban: ban() — a ban decided outside the media counter (the /agents flood)', () => {
  it('mutes the sender for the same cooldown, logs the reason once, lifts lazily', () => {
    let t = 0;
    const notices = [];
    const fb = createFloodBan({ count: 5, windowMs: 20_000, cooldownMs: 600_000, now: () => t, onLog: (m) => notices.push(m) });
    expect(fb.ban(S, CH, 'A', { reason: '/agents flood', senderName: 'Emely', chatName: 'C' })).toBe(true);
    expect(fb.isBanned(S, CH, 'A')).toBe(true);
    expect(fb.observe(S, CH, 'A', text('Emely', 'C')).banned).toBe(true);
    expect(fb.ban(S, CH, 'A', { reason: '/agents flood' })).toBe(true);             // already banned: no second notice
    expect(notices).toEqual(['flood-ban: Emely in C — /agents flood, muted 10m']);
    expect(fb.list()).toEqual([{ surface: S, chatId: CH, senderId: 'A', senderName: 'Emely', chatName: 'C', until: 600_000, reason: '/agents flood' }]);
    t += 600_001;
    expect(fb.isBanned(S, CH, 'A')).toBe(false);
  });

  it('never_ban is honoured; unban() clears it like a media ban', () => {
    const fb = createFloodBan({ neverBan: ['Operator'], now: () => 0 });
    expect(fb.ban(S, CH, 'op', { reason: '/agents flood', senderName: 'Operator' })).toBe(false);
    expect(fb.isBanned(S, CH, 'op')).toBe(false);
    expect(fb.ban(S, CH, 'B', { reason: '/agents flood', senderName: 'Bob' })).toBe(true);
    expect(fb.unban(S, CH, 'Bob')).toBe(1);
    expect(fb.isBanned(S, CH, 'B')).toBe(false);
  });
});

// NEW-CHAT BURST (operator 2026-11-05): a linked network importing its history makes many chats at
// once. More than NEW_CHAT_BURST chats the node has never seen, within NEW_CHAT_WINDOW_MS on one
// connection, holds every chat first seen in that window — until a window passes with no new chat.
describe('flood-ban: observeChat — a burst of new chats on one connection is held', () => {
  const newChats = (fb, conn, from, to) => { for (let i = from; i <= to; i++) fb.observeChat(conn, `c${i}`, { isNew: true }); };

  it('10 new chats in the window are live; the 11th starts the burst and holds all 11; one notice', () => {
    let t = 0;
    const notices = [];
    const fb = createFloodBan({ now: () => t, onLog: (m) => notices.push(m) });
    for (let i = 1; i <= 10; i++) { t += 1_000; expect(fb.observeChat('primary', `c${i}`, { isNew: true })).toBe(false); }
    t += 1_000;
    expect(fb.observeChat('primary', 'c11', { isNew: true, chatName: 'Tío Pepe' })).toBe(true);
    expect(fb.observeChat('primary', 'c1')).toBe(true);                  // first seen in the window, known now: held
    expect(fb.observeChat('primary', 'old')).toBe(false);                // a chat the node already had
    expect(fb.observeChat('primary', 'c12', { isNew: true })).toBe(true);
    expect(notices).toEqual(['new-chat burst on primary: 11 new chats in 5m (last: Tío Pepe) — every chat first seen in it is held as backlog (recorded, not dispatched, not transcribed) until 5m pass with no new chat']);
  });

  it('a slow trickle never trips it: new chats spread past the window', () => {
    let t = 0;
    const fb = createFloodBan({ now: () => t });
    for (let i = 1; i <= 30; i++) { t += 31_000; expect(fb.observeChat('primary', `c${i}`, { isNew: true })).toBe(false); }
  });

  it('the same new chat seen twice before it is registered counts once', () => {
    const fb = createFloodBan({ now: () => 0 });
    for (let i = 0; i < 20; i++) fb.observeChat('primary', 'same', { isNew: true });
    newChats(fb, 'primary', 1, 8);
    expect(fb.observeChat('primary', 'c10', { isNew: true })).toBe(false);   // 10 distinct, not 29
    expect(fb.observeChat('primary', 'c11', { isNew: true })).toBe(true);
  });

  it('lifts once a window passes with no new chat — lift notice — and the held chats are live again', () => {
    let t = 0;
    const notices = [];
    const fb = createFloodBan({ now: () => t, onLog: (m) => notices.push(m) });
    newChats(fb, 'primary', 1, 11);
    t += 4 * 60_000;
    expect(fb.observeChat('primary', 'c12', { isNew: true })).toBe(true);    // a new chat keeps it going
    t += 4 * 60_000;
    expect(fb.observeChat('primary', 'c1')).toBe(true);                      // 4m since the last new chat: still on
    t += 60_000;
    expect(fb.observeChat('primary', 'c1')).toBe(false);
    expect(fb.observeChat('primary', 'c13', { isNew: true })).toBe(false);
    expect(notices[1]).toBe('new-chat burst on primary lifted: 12 chats were held');
    expect(notices).toHaveLength(2);
  });

  it('each connection counts its own new chats', () => {
    const fb = createFloodBan({ now: () => 0 });
    newChats(fb, 'primary', 1, 6);
    newChats(fb, 'secondary', 7, 12);
    expect(fb.observeChat('primary', 'c7', { isNew: true })).toBe(false);
    expect(fb.observeChat('secondary', 'c1', { isNew: true })).toBe(false);
  });
});
