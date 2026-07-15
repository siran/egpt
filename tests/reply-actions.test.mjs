// Conversation-E LIMBS (ROADMAP §3) — the emitted-action surface E drives from
// inside its own reply: parse (pure) + execute (confined, fail-closed).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseReplyActions, partialProse, createReplyActions } from '../src/spine/reply-actions.mjs';

const EV = { chatId: '!room:beeper.local', surface: 'whatsapp', chatName: 'Bea' };

describe('parseReplyActions — the pure split', () => {
  it('react: #id + emoji', () => {
    const { prose, run, stripped } = parseReplyActions('/react #157204 🔥', EV);
    expect(prose).toBe('');
    expect(stripped).toEqual([]);
    expect(run).toEqual([{ type: 'react', chatId: EV.chatId, targetId: '157204', emoji: '🔥' }]);
  });

  it('react: no #id is malformed — STRICT, never defaults to an arbitrary message (live bug 2026-07-06: "/react 👋" silently reacted to ev.msgId)', () => {
    const { run, stripped } = parseReplyActions('/react 👋', EV);
    expect(run).toEqual([]);
    expect(stripped).toHaveLength(1);
    expect(stripped[0].reason).toMatch(/#<id>/);
  });

  it('react: a word alias resolves to an emoji', () => {
    expect(parseReplyActions('/react #12 heart', EV).run[0].emoji).toBe('❤️');
  });

  it('react: no emoji → stripped (malformed), never executed', () => {
    const { run, stripped } = parseReplyActions('/react', EV);
    expect(run).toEqual([]);
    expect(stripped).toHaveLength(1);
    expect(stripped[0].reason).toMatch(/emoji/);
  });

  it('reply: #id + text', () => {
    const { run } = parseReplyActions('/reply #157204 sounds good to me', EV);
    expect(run[0]).toEqual({ type: 'reply', chatId: EV.chatId, targetId: '157204', text: 'sounds good to me' });
  });

  it('reply: missing text or id → stripped', () => {
    expect(parseReplyActions('/reply #157204', EV).stripped).toHaveLength(1);
    expect(parseReplyActions('/reply hola', EV).stripped).toHaveLength(1);
  });

  // REDUNDANCY GUARD (operator 2026-07-08, Zohykar #159710): when the reply E is already
  // posting QUOTES the target, a /reply at that same id only posts a second, near-duplicate
  // message (a rogue twin). Stripped like any malformed limb.
  //
  // The premise is `quotedId` — what the reply ACTUALLY quotes — NOT ev.msgId, the message
  // being answered (made honest 2026-07-15). This test used to pass only ev.msgId and assert
  // the strip; that assertion was WRONG, not merely inconvenient: it declared a quote that
  // may not exist. The reply only quotes the trigger when its placeholder was OPENED as a
  // quote of it, which the spine did solely for @-mentions — so in a mode:on/auto chat the
  // guard discarded, as "already quoted", the one limb by which E could quote at all: the
  // main reply posted plain AND the /reply was dropped. The parse cannot see the placeholder,
  // so the caller must state the quote; absent that claim there is no redundancy (below).
  // The TARGET is redundant; the WORDS are not. Stripping the whole line ate E's reply
  // outright whenever it had no other prose (the live 2026-07-15 shape) — so a redundant
  // /reply DEMOTES: its text becomes prose in the reply that already quotes the target.
  // Still no second/duplicate post, so the 2026-07-08 rogue twin stays fixed.
  it('reply: targeting the message THIS REPLY ALREADY QUOTES is REDUNDANT — DEMOTES to prose, never executed', () => {
    const ev = { ...EV, msgId: '159710' };
    const { prose, run, stripped } = parseReplyActions('/reply #159710 Hola Zohy 👋', ev, { quotedId: '159710' });
    expect(run).toEqual([]);          // never executed — no repost, no twin
    expect(stripped).toEqual([]);     // not malformed: it carries content
    expect(prose).toBe('Hola Zohy 👋');   // …and the content survives, in the already-quoting reply
  });

  it('reply: a redundant /reply demotes ALONGSIDE prose — its words join the reply, not a second post', () => {
    const ev = { ...EV, msgId: '159710' };
    const { prose, run } = parseReplyActions('Vale, ya lo miro.\n/reply #159710 Hola Zohy 👋', ev, { quotedId: '159710' });
    expect(run).toEqual([]);
    expect(prose).toBe('Vale, ya lo miro.\nHola Zohy 👋');
  });

  // The demoted text is CONTENT, never re-parsed — otherwise a /reply carrying an action-shaped
  // line would smuggle a live limb past the guard.
  it('reply: demoted text is literal prose, NOT re-parsed as an action', () => {
    const ev = { ...EV, msgId: '159710' };
    const { prose, run } = parseReplyActions('/reply #159710 /react #7 🔥', ev, { quotedId: '159710' });
    expect(run).toEqual([]);                 // the smuggled /react does NOT fire
    expect(prose).toBe('/react #7 🔥');      // it is just text
  });

  // MALFORMED still STRIPS (the 2026-07-08 decision stands where it belongs): no id, nothing
  // to demote, nothing to quote — there is no content-bearing reading to preserve.
  it('reply: a MALFORMED /reply is still stripped, demote or not', () => {
    const ev = { ...EV, msgId: '159710' };
    expect(parseReplyActions('/reply #159710', ev, { quotedId: '159710' }).stripped).toHaveLength(1);
    expect(parseReplyActions('/reply hola', ev, { quotedId: '159710' }).stripped).toHaveLength(1);
  });

  // The live 2026-07-15 defect, locked: the trigger is NOT quoted (no quotedId — the reply
  // posts plain), so /reply at it is E's ONLY way to quote and MUST survive the guard.
  it('reply: targeting the trigger when the reply quotes NOTHING still executes (the guard has no premise)', () => {
    const ev = { ...EV, msgId: '159710' };
    const { run, stripped } = parseReplyActions('/reply #159710 Hola Zohy 👋', ev);
    expect(stripped).toEqual([]);
    expect(run).toEqual([{ type: 'reply', chatId: EV.chatId, targetId: '159710', text: 'Hola Zohy 👋' }]);
  });

  it('reply: targeting a DIFFERENT message than the one quoted still executes (regression-lock)', () => {
    const ev = { ...EV, msgId: '159710' };
    const { run, stripped } = parseReplyActions('/reply #157204 sounds good to me', ev, { quotedId: '159710' });
    expect(stripped).toEqual([]);
    expect(run).toEqual([{ type: 'reply', chatId: EV.chatId, targetId: '157204', text: 'sounds good to me' }]);
  });

  it('media: a relative path is accepted; an absolute path or .. is stripped', () => {
    expect(parseReplyActions('/media chart.png here you go', EV).run[0])
      .toEqual({ type: 'media', chatId: EV.chatId, path: 'chart.png', caption: 'here you go' });
    expect(parseReplyActions('/media /etc/passwd', EV).stripped[0].reason).toMatch(/absolute/);
    expect(parseReplyActions('/media ../../secrets.txt', EV).stripped[0].reason).toMatch(/traversal/);
    expect(parseReplyActions('/media C:/Windows/system32/x', EV).stripped[0].reason).toMatch(/absolute/);
  });

  it('media: a quoted path tolerates spaces in the filename', () => {
    expect(parseReplyActions('/media "my photo.png" look', EV).run[0])
      .toMatchObject({ type: 'media', path: 'my photo.png', caption: 'look' });
  });

  it('edit / delete parse (ownership is enforced at execute, not here)', () => {
    expect(parseReplyActions('/edit #12 fixed typo', EV).run[0]).toEqual({ type: 'edit', chatId: EV.chatId, targetId: '12', text: 'fixed typo' });
    expect(parseReplyActions('/delete #12', EV).run[0]).toEqual({ type: 'delete', chatId: EV.chatId, targetId: '12' });
    expect(parseReplyActions('/delete nope', EV).stripped).toHaveLength(1);
  });

  it('prose + action mixed: prose surfaces, action runs', () => {
    const { prose, run } = parseReplyActions('Nice one!\n/react #7 🔥\nsee you soon', EV);
    expect(prose).toBe('Nice one!\nsee you soon');
    expect(run).toHaveLength(1);
  });

  it('a slash INSIDE a sentence is prose, never an action', () => {
    const { prose, run, stripped } = parseReplyActions('use /react to add an emoji, see /usr/bin', EV);
    expect(prose).toBe('use /react to add an emoji, see /usr/bin');
    expect(run).toEqual([]); expect(stripped).toEqual([]);
  });

  it('an unknown slash verb stays prose (only the reserved verbs are action-family)', () => {
    const { prose, run, stripped } = parseReplyActions('/help me out', EV);
    expect(prose).toBe('/help me out');
    expect(run).toEqual([]); expect(stripped).toEqual([]);
  });

  it('action-only reply → empty prose', () => {
    expect(parseReplyActions('/react #7 👍', EV).prose).toBe('');
  });

  it('DOC/HELP placeholder lines are malformed (stripped, never executed) — the anti-accident guard', () => {
    // exactly the lines E sees in its own identity feed — a verbatim echo must NOT fire
    const help = [
      '/react #<id> <emoji>       react to message #<id>',
      '/reply #<id> <text>        quote-reply to a specific message',
      '/media <path> [caption]    send a file from this folder',
      '/edit #<id> <text>         edit one of my own messages',
      '/delete #<id>              delete one of my own messages',
    ].join('\n');
    const { run, stripped } = parseReplyActions(help, EV);
    expect(run).toEqual([]);            // NOTHING executes
    expect(stripped).toHaveLength(5);   // all recognized as malformed action attempts, logged
  });

  it('react with extra words (not a single emoji) is malformed', () => {
    expect(parseReplyActions('/react thumbs up please', EV).stripped).toHaveLength(1);
  });

  it('ask: the whole line is the question; empty / placeholder is stripped', () => {
    expect(parseReplyActions('/ask should I confirm the Friday move?', EV).run[0])
      .toEqual({ type: 'ask', chatId: EV.chatId, question: 'should I confirm the Friday move?' });
    expect(parseReplyActions('/ask', EV).stripped).toHaveLength(1);             // empty
    expect(parseReplyActions('/ask <question>', EV).stripped[0].reason).toMatch(/placeholder/);   // doc echo
  });
});

// The STREAMING half of the split (operator 2026-07-15). A partial can end ANYWHERE, so the
// hard case is the trailing INCOMPLETE line: parsing whole lines only would render a
// half-typed "/repl" for a frame and snap it away — the same bug, one frame later. The tail
// is withheld while it could still become an action, and only while it could.
describe('partialProse — what a PARTIAL may safely stream', () => {
  it('withholds a trailing tail that could still become an action — every prefix of the token', () => {
    // Each is a real stream position mid-token; none may leak a character of it.
    for (const tail of ['/', '/r', '/re', '/rep', '/reply', '/reply ', '/reply #9', '/reply #99 hi'])
      expect(partialProse(`Hola\n${tail}`, EV)).toBe('Hola');
    expect(partialProse('/reply #99 hi', EV)).toBe('');           // action-only → nothing to stream yet
  });

  it('streams a tail that can NO LONGER become an action — ordinary prose is never held back', () => {
    expect(partialProse('Hola mun', EV)).toBe('Hola mun');        // mid-word, no '/' → flows
    expect(partialProse('Hola\nhttp://x', EV)).toBe('Hola\nhttp://x');   // a slash mid-line is prose
    expect(partialProse('/hello wor', EV)).toBe('/hello wor');    // '/hello' is not a verb of ours
    expect(partialProse('/reactx foo', EV)).toBe('/reactx foo');  // a verb PREFIX match is not a verb
    expect(partialProse('/123', EV)).toBe('/123');                // never action-shaped
  });

  it('strips COMPLETED action lines mid-stream while later prose keeps flowing', () => {
    expect(partialProse('Nice\n/react #7 🔥\nby', EV)).toBe('Nice\nby');
  });

  it('is a pure prefix walk: the streamed prose only ever grows toward the finished prose', () => {
    const full = 'Nice one!\n/react #7 🔥\nbye';
    const seen = [];
    for (let i = 1; i <= full.length; i++) seen.push(partialProse(full.slice(0, i), EV));
    for (const s of seen) expect(s).not.toMatch(/\//);                       // no token, ever
    expect(seen[seen.length - 1]).toBe(parseReplyActions(full, EV).prose);   // lands exactly on the delivered prose
  });

  // A redundant /reply DEMOTES to prose, so partialProse must stream it — it must not be
  // withheld as a "viable action prefix" forever, or the shape that demote exists to rescue
  // would never stream at all. The id is fixed the instant whitespace terminates it, so from
  // `#<id> ` on the line is provably prose; before that the target is unknown and it stays held.
  it('streams a DEMOTING /reply as prose, but only once its id is provably the one we quote', () => {
    const opts = { quotedId: '159710' };
    for (const held of ['/', '/re', '/reply', '/reply ', '/reply #', '/reply #15971', '/reply #159710'])
      expect(partialProse(held, EV, opts)).toBe('');            // id not yet terminated — target still unknown
    expect(partialProse('/reply #159710 H', EV, opts)).toBe('H');          // id fixed → the text is prose
    expect(partialProse('/reply #159710 Hola Zohy', EV, opts)).toBe('Hola Zohy');
  });

  it('keeps WITHHOLDING a /reply aimed at a DIFFERENT id — that one is a real limb, never prose', () => {
    const opts = { quotedId: '159710' };
    expect(partialProse('/reply #157204 sounds', EV, opts)).toBe('');
    expect(partialProse('Hola\n/reply #157204 sounds good', EV, opts)).toBe('Hola');
  });

  it('demoted streaming is a monotone prefix walk that lands on the delivered prose', () => {
    const opts = { quotedId: '159710' };
    const full = '/reply #159710 Hola Zohy';
    const seen = [];
    for (let i = 1; i <= full.length; i++) seen.push(partialProse(full.slice(0, i), EV, opts));
    for (const s of seen) expect(s).not.toMatch(/\//);                             // no token, ever
    for (let i = 1; i < seen.length; i++) expect(seen[i].startsWith(seen[i - 1])).toBe(true);
    expect(seen[seen.length - 1]).toBe(parseReplyActions(full, EV, opts).prose);   // == 'Hola Zohy'
  });
});

// A fake bridge port capturing the limb calls (follows tests/beeper-port.test.mjs style).
function fakeBridge(over = {}) {
  const calls = { react: [], send: [], media: [], edit: [], del: [] };
  return {
    calls,
    react: (chat, id, emoji) => { calls.react.push({ chat, id, emoji }); return true; },
    send: (chat, text, opts) => { calls.send.push({ chat, text, opts }); return { ok: true }; },
    sendMedia: (chat, path, opts) => { calls.media.push({ chat, path, opts }); return true; },
    editOwn: (chat, id, text, opts) => { calls.edit.push({ chat, id, text, opts }); return true; },
    deleteOwn: (chat, id) => { calls.del.push({ chat, id }); return true; },
    wasSentByUs: () => false,
    ...over,
  };
}

describe('createReplyActions.execute — confined + fail-closed', () => {
  const mk = (bridge, opts = {}) => createReplyActions({
    bridge, bodyEmojiOf: () => '🐶', labelOf: () => 'egpt',
    resolveConvDir: opts.resolveConvDir ?? (async () => null),
    onLog: opts.onLog ?? (() => {}),
  });

  it('react hits the bridge with (ev.chatId, targetId, emoji)', async () => {
    const b = fakeBridge();
    const a = mk(b);
    const { run, stripped } = a.parse('/react #7 🔥', EV);
    await a.execute(run, stripped, EV, { being: 'e' });
    expect(b.calls.react).toEqual([{ chat: EV.chatId, id: '7', emoji: '🔥' }]);
  });

  it('reply routes through send() with replyTo + persona stamp opts', async () => {
    const b = fakeBridge();
    const a = mk(b);
    const { run } = a.parse('/reply #7 yes', EV);
    await a.execute(run, [], EV, { being: 'e' });
    expect(b.calls.send[0]).toMatchObject({ chat: EV.chatId, text: 'yes', opts: { replyTo: '7', bodyEmoji: '🐶', label: 'egpt' } });
  });

  it('EVERY action targets ev.chatId — a limb can never reach another chat', async () => {
    const b = fakeBridge();
    const a = mk(b);
    const { run } = a.parse('/react #7 👍\n/reply #7 hi', EV);
    await a.execute(run, [], EV, { being: 'e' });
    expect(b.calls.react[0].chat).toBe(EV.chatId);
    expect(b.calls.send[0].chat).toBe(EV.chatId);
  });

  it('edit/delete are refused unless the message is one WE sent (wasSentByUs)', async () => {
    const logs = [];
    const b = fakeBridge({ wasSentByUs: (_c, id) => id === '5' });   // only #5 is ours
    const a = mk(b, { onLog: (m) => logs.push(m) });
    await a.execute(a.parse('/edit #9 nope', EV).run, [], EV, { being: 'e' });   // not ours
    await a.execute(a.parse('/delete #9', EV).run, [], EV, { being: 'e' });      // not ours
    expect(b.calls.edit).toEqual([]);
    expect(b.calls.del).toEqual([]);
    expect(logs.filter((l) => /not one of our/.test(l))).toHaveLength(2);
    // …but our own #5 goes through
    await a.execute(a.parse('/edit #5 fixed', EV).run, [], EV, { being: 'e' });
    expect(b.calls.edit[0]).toMatchObject({ chat: EV.chatId, id: '5', text: 'fixed' });
  });

  it('a media path INSIDE the conversation dir is sent; a missing file is skipped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'egpt-limb-'));
    writeFileSync(join(dir, 'pic.png'), 'bytes');
    const b = fakeBridge();
    const a = mk(b, { resolveConvDir: async () => dir });
    await a.execute(a.parse('/media pic.png caption here', EV).run, [], EV, { being: 'e' });
    expect(b.calls.media[0]).toMatchObject({ chat: EV.chatId, opts: { caption: 'caption here', bodyEmoji: '🐶', label: 'egpt' } });
    expect(b.calls.media[0].path).toMatch(/pic\.png$/);
    // a file that doesn't exist → no send
    b.calls.media.length = 0;
    await a.execute(a.parse('/media nope.png', EV).run, [], EV, { being: 'e' });
    expect(b.calls.media).toEqual([]);
  });

  it('ask: delegates to the injected askAdvice callback (never a bridge send to another chat)', async () => {
    const b = fakeBridge();
    const asked = [];
    const a = createReplyActions({
      bridge: b, bodyEmojiOf: () => '🐶', labelOf: () => 'egpt', resolveConvDir: async () => null,
      askAdvice: async (x) => { asked.push(x); return true; },
    });
    await a.execute(a.parse('/ask confirm the booking?', EV).run, [], EV, { being: 'e' });
    expect(asked).toEqual([{ ev: EV, question: 'confirm the booking?', being: 'e' }]);
    // the /ask NEVER touches the ordinary bridge send/react/media surface — the ONLY
    // cross-chat path is the sanctioned askAdvice callback.
    expect(b.calls.send).toEqual([]);
    expect(b.calls.react).toEqual([]);
    expect(b.calls.media).toEqual([]);
  });

  it('ask: no askAdvice wired → fail-closed (logged, dropped, no bridge send)', async () => {
    const logs = [];
    const b = fakeBridge();
    const a = mk(b, { onLog: (m) => logs.push(m) });   // default askAdvice = fail-closed no-op
    await a.execute(a.parse('/ask anybody home?', EV).run, [], EV, { being: 'e' });
    expect(b.calls.send).toEqual([]);                  // nothing sent anywhere
    expect(logs.some((l) => /no advice channel/i.test(l))).toBe(true);
  });

  it('malformed lines are logged, never executed; a throwing limb never crashes execute', async () => {
    const logs = [];
    const b = fakeBridge({ react: () => { throw new Error('boom'); } });
    const a = mk(b, { onLog: (m) => logs.push(m) });
    const { run, stripped } = a.parse('/react\n/react #7 👍', EV);   // one malformed, one that throws
    await expect(a.execute(run, stripped, EV, { being: 'e' })).resolves.toBeUndefined();
    expect(logs.some((l) => /stripped malformed action/.test(l))).toBe(true);
    expect(logs.some((l) => /action react failed: boom/.test(l))).toBe(true);
  });
});
