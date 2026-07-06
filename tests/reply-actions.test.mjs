// Conversation-E LIMBS (ROADMAP §3) — the emitted-action surface E drives from
// inside its own reply: parse (pure) + execute (confined, fail-closed).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseReplyActions, createReplyActions } from '../src/spine/reply-actions.mjs';

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
