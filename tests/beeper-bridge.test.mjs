// Drives the real beeper bridge against a fake Beeper Desktop API (local
// HTTP + WS). Covers the hardening contract: room-service 👂 gating (posts_back),
// backlog gate, persisted dedup, fail-closed network scope, echo
// suppression.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startBeeperBridge } from '../src/bridges/beeper.mjs';

async function startFakeBeeper() {
  const posts = [];   // POSTs to /v1/chats/:id/messages
  const chats = new Map();   // chatID -> chat info served by GET
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const post = req.url.match(/^\/v1\/chats\/([^/]+)\/messages$/);
      if (req.method === 'POST' && post) {
        posts.push({ chatID: decodeURIComponent(post[1]), ...JSON.parse(body) });
        res.end(JSON.stringify({ pendingMessageID: `pm-${posts.length}` }));
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/chats') {
        res.end(JSON.stringify({ items: [...chats.entries()].map(([id, c]) => ({ id, ...c })) }));
        return;
      }
      const get = req.url.match(/^\/v1\/chats\/([^/]+)$/);
      if (req.method === 'GET' && get) {
        const id = decodeURIComponent(get[1]);
        res.end(JSON.stringify(chats.get(id) ?? { id, title: `Chat ${id}`, type: 'single', isMuted: false, accountID: 'whatsapp' }));
        return;
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const wss = new WebSocketServer({ server, path: '/v1/ws' });
  const sockets = [];
  let subscribed = 0;
  wss.on('connection', (ws) => {
    sockets.push(ws);
    ws.on('message', (buf) => { try { if (JSON.parse(buf.toString()).type === 'subscriptions.set') subscribed += 1; } catch { /* noop */ } });
    ws.send(JSON.stringify({ type: 'ready' }));
  });
  return {
    port, posts, chats,
    subscribed: () => subscribed,
    emit: (ev) => { for (const ws of sockets) ws.send(JSON.stringify(ev)); },
    close: () => new Promise((r) => { for (const ws of sockets) ws.terminate(); wss.close(() => server.close(r)); }),
  };
}

const waitFor = async (cond, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

let fake, stateDir, bridges;
beforeEach(async () => {
  fake = await startFakeBeeper();
  stateDir = mkdtempSync(join(tmpdir(), 'egpt-beeper-'));
  bridges = [];
});
afterEach(async () => {
  for (const b of bridges) b.stop();
  await fake.close();
  rmSync(stateDir, { recursive: true, force: true });
});

async function startBridge(extra = {}) {
  const incoming = [];
  const media = [];
  const base = fake.subscribed();   // wait for THIS bridge's subscription, not a predecessor's
  const bridge = await startBeeperBridge({
    beeperToken: 'test-token',
    baseUrl: `http://127.0.0.1:${fake.port}`,
    wsUrl: `ws://127.0.0.1:${fake.port}/v1/ws`,
    stateDir,
    onIncoming: (text, from) => incoming.push({ text, from }),
    onMedia: (m) => media.push(m),
    transcribe: async () => 'fake transcript',
    ...extra,
  });
  bridges.push(bridge);
  await waitFor(() => fake.subscribed() > base);
  return { bridge, incoming, media };
}

// A local file standing in for an already-downloaded attachment (srcURL file://
// passes straight through attachmentToLocalPath — no /v1/assets/download call).
function fakeAttachment({ name = 'blob.bin', mimeType = '', isVoiceNote = false } = {}) {
  const p = join(stateDir, name);
  writeFileSync(p, 'fake-bytes');
  return { id: `att-${Math.random().toString(36).slice(2)}`, srcURL: pathToFileURL(p).href, fileName: name, mimeType, isVoiceNote };
}

// Real Beeper chatIDs are Matrix room ids ('!xxx:beeper.local'); tests
// mirror that so the '!'-prefix fast path in name resolution is exercised
// the same way as production.
const CHAT = (n) => `!${n}:beeper.local`;
const liveMsg = (over = {}) => ({
  id: `m-${Math.random().toString(36).slice(2)}`,
  chatID: CHAT('chat-1'),
  text: 'hola',
  senderName: 'An',
  isSender: true,
  timestamp: Date.now(),
  ...over,
});

describe('beeper bridge', () => {
  it('dispatches a live message; authorized mirrors isSender', async () => {
    const { incoming } = await startBridge();
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ isSender: false, senderName: 'Bea' })] });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ text: '@e hola' })] });
    await waitFor(() => incoming.length === 2);
    expect(incoming[0].from.authorized).toBe(false);
    expect(incoming[1].from.authorized).toBe(true);
    expect(incoming[1].from.atEStart).toBe(true);
  });

  it('authorizes a non-isSender message when its senderID is allow-listed', async () => {
    // Beeper does not reliably tag the owner's own sends as isSender (fails even
    // on Self, operator 2026-06-16), so the bridge must authorize from the
    // delivered senderID against the operator allowlist. Keyed on the STABLE id.
    const { incoming } = await startBridge({ isAllowedUser: (id) => id === 'op@beeper.local' });
    fake.emit({ type: 'message.upserted', entries: [
      liveMsg({ isSender: false, senderID: 'op@beeper.local', senderName: 'Operator', text: '/e auto on spoiler' }),
      liveMsg({ isSender: false, senderID: 'rando@beeper.local', senderName: 'Rando' }),
    ] });
    await waitFor(() => incoming.length === 2);
    expect(incoming[0].from.authorized).toBe(true);    // allow-listed senderID → authorized despite isSender:false
    expect(incoming[1].from.authorized).toBe(false);   // not allow-listed → unauthorized
  });

  // CONTRACT C2 (the regression): a voice note must be transcribed AND its file
  // handed to onMedia — not transcribed-then-dropped.
  it('a voice note is transcribed AND its file handed to onMedia (caption = transcript)', async () => {
    const { incoming, media } = await startBridge();
    const att = fakeAttachment({ name: 'ptt.ogg', mimeType: 'audio/ogg', isVoiceNote: true });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ type: 'VOICE', text: null, attachments: [att] })] });
    await waitFor(() => media.length === 1);
    expect(incoming[0].text).toBe('fake transcript');          // still dispatched as text
    expect(media[0]).toMatchObject({ chatID: CHAT('chat-1'), kind: 'audio', isVoiceNote: true });
    expect(media[0].localPath).toContain('ptt.ogg');
    expect(media[0].caption).toBe('fake transcript');          // sidecar caption = transcription
  });

  // A photo doesn't route to a brain in v1, but its file MUST still be saved.
  it('a non-voice attachment (image) is handed to onMedia even though text is null', async () => {
    const { incoming, media } = await startBridge();
    const att = fakeAttachment({ name: 'foto.jpg', mimeType: 'image/jpeg' });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ type: 'IMAGE', text: null, attachments: [att] })] });
    await waitFor(() => media.length === 1);
    expect(media[0]).toMatchObject({ chatID: CHAT('chat-1'), kind: 'image' });
    expect(incoming).toHaveLength(0);                          // not routed (no text)
  });

  it('whatsapp.media.download:"off" saves nothing', async () => {
    const { media } = await startBridge({ media: { download: 'off' } });
    const att = fakeAttachment({ name: 'foto.jpg', mimeType: 'image/jpeg' });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ type: 'IMAGE', text: 'pic', attachments: [att] })] });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ text: 'sentinel' })] });   // ordering barrier
    await waitFor(() => true);
    await new Promise((r) => setTimeout(r, 50));
    expect(media).toHaveLength(0);
  });

  it('"images_docs" saves an image but skips audio', async () => {
    const { media } = await startBridge({ media: { download: 'images_docs' } });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ type: 'IMAGE', text: null, attachments: [fakeAttachment({ name: 'a.jpg', mimeType: 'image/jpeg' })] })] });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ type: 'VOICE', text: null, attachments: [fakeAttachment({ name: 'b.ogg', mimeType: 'audio/ogg', isVoiceNote: true })] })] });
    await waitFor(() => media.length >= 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(media.map((m) => m.kind)).toEqual(['image']);      // audio skipped by policy
  });

  it('suppresses the WS echo of its own send (text window, different id)', async () => {
    const { bridge, incoming } = await startBridge();
    await bridge.send('egpt says hi', { chatId: CHAT('chat-1') });
    await waitFor(() => fake.posts.length === 1);
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ id: 'totally-new-id', text: 'egpt says hi' })] });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ text: 'a real message' })] });
    await waitFor(() => incoming.length === 1);
    expect(incoming[0].text).toBe('a real message');
  });

  it('dedups re-upserts of the same id (receipts/edits)', async () => {
    const { incoming } = await startBridge();
    const m = liveMsg();
    fake.emit({ type: 'message.upserted', entries: [m] });
    fake.emit({ type: 'message.upserted', entries: [m] });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ text: 'sentinel' })] });
    await waitFor(() => incoming.some((i) => i.text === 'sentinel'));
    expect(incoming.filter((i) => i.text === 'hola')).toHaveLength(1);
  });

  it('same numeric id in DIFFERENT chats is two messages, not a dupe', async () => {
    // Verified live: Beeper ids are per-chat sequence numbers (e.g. 488).
    const { incoming } = await startBridge();
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ id: 488, chatID: CHAT('chat-a'), text: 'from a' })] });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ id: 488, chatID: CHAT('chat-b'), text: 'from b' })] });
    await waitFor(() => incoming.length === 2);
    expect(incoming.map((i) => i.text).sort()).toEqual(['from a', 'from b']);
  });

  it('backlog gate: messages older than bridge start are never dispatched', async () => {
    const { incoming } = await startBridge();
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ text: 'stale', timestamp: Date.now() - 60_000 })] });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ text: 'fresh' })] });
    await waitFor(() => incoming.length === 1);
    expect(incoming[0].text).toBe('fresh');
  });

  it('network scope is fail-closed: unknown or foreign accountID drops; prefix instance ids pass', async () => {
    fake.chats.set(CHAT('chat-unknown'), { title: 'X', type: 'single', isMuted: false, accountID: null });
    fake.chats.set(CHAT('chat-telegram'), { title: 'T', type: 'single', isMuted: false, accountID: 'telegram' });
    fake.chats.set(CHAT('chat-wa2'), { title: 'W', type: 'single', isMuted: false, accountID: 'whatsappgo_2' });
    const { incoming } = await startBridge();
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ chatID: CHAT('chat-unknown'), text: 'no-acct' })] });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ chatID: CHAT('chat-telegram'), text: 'tg' })] });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ chatID: CHAT('chat-wa2'), text: 'wa-instance' })] });
    await waitFor(() => incoming.length === 1);
    expect(incoming[0].text).toBe('wa-instance');
  });

  it('👂 ack only where posts_back; elsewhere still transcribes silently', async () => {
    const { incoming } = await startBridge({ resolveTranscriptionService: async (id) => ({ enabled: true, postsBack: id === CHAT('chat-enrolled') }) });
    const voice = (chatID) => liveMsg({
      chatID, text: null, type: 'VOICE',
      attachments: [{ id: 'a1', isVoiceNote: true, srcURL: 'file:///tmp/note.ogg' }],
    });
    fake.emit({ type: 'message.upserted', entries: [voice(CHAT('chat-quiet'))] });
    fake.emit({ type: 'message.upserted', entries: [voice(CHAT('chat-enrolled'))] });
    await waitFor(() => incoming.length === 2);
    // Both transcripts reach the engine (E hears everything — enabled)…
    expect(incoming.map((i) => i.text)).toEqual(['fake transcript', 'fake transcript']);
    expect(incoming.every((i) => i.from.isTranscriptFromVoice)).toBe(true);
    // …but only the posts_back chat got the in-chat 👂 reply.
    expect(fake.posts).toHaveLength(1);
    expect(fake.posts[0].chatID).toBe(CHAT('chat-enrolled'));
    expect(fake.posts[0].text).toBe('👂 fake transcript');
    expect(fake.posts[0].replyToMessageID).toBeTruthy();
  });

  it('👂 verdict is keyed on the STABLE id — the bridge passes it nothing but the id', async () => {
    // Security guard (operator 2026-06-10): authorization must never rely
    // on a display name. The bridge calls resolveTranscriptionService with the
    // room id and NOTHING else, so a name/slug-based gate can't even be written
    // against it. A title-matching gate sees undefined → no ack.
    fake.chats.set(CHAT('room9'), { title: 'Dándo Ruiz', type: 'single', isMuted: false, accountID: 'whatsapp' });
    const seen = [];
    const { incoming } = await startBridge({
      resolveTranscriptionService: async (...args) => { seen.push(args); return { enabled: true, postsBack: false }; },
    });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ chatID: CHAT('room9'), text: null, type: 'VOICE', attachments: [{ id: 'a1', isVoiceNote: true, srcURL: 'file:///tmp/n.ogg' }] })] });
    await waitFor(() => incoming.length === 1);
    expect(fake.posts).toHaveLength(0);                 // posts_back false → no ack
    expect(seen).toEqual([[CHAT('room9')]]);            // verdict got the id ALONE — no name/slug to match on
  });

  it('posts_back by stable id → ack fires regardless of the chat title', async () => {
    fake.chats.set(CHAT('room9'), { title: 'anything at all', type: 'single', isMuted: false, accountID: 'whatsapp' });
    const { incoming } = await startBridge({ resolveTranscriptionService: async (id) => ({ enabled: true, postsBack: id === CHAT('room9') }) });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ chatID: CHAT('room9'), text: null, type: 'VOICE', attachments: [{ id: 'a1', isVoiceNote: true, srcURL: 'file:///tmp/n.ogg' }] })] });
    await waitFor(() => incoming.length === 1);
    expect(fake.posts).toHaveLength(1);
    expect(fake.posts[0].chatID).toBe(CHAT('room9'));
  });

  it('send accepts a deterministic name/slug and resolves it to the room id', async () => {
    fake.chats.set(CHAT('room9'), { title: 'Dándo Ruiz', type: 'single', isMuted: false, accountID: 'whatsapp' });
    const { bridge } = await startBridge();
    const r = await bridge.send('hola por nombre', { chatId: 'dando-ruiz' });
    expect(r?.ok).toBe(true);
    expect(fake.posts).toHaveLength(1);
    expect(fake.posts[0].chatID).toBe(CHAT('room9'));

    // Unresolvable name → dropped, not thrown.
    expect(await bridge.send('nope', { chatId: 'no-such-contact' })).toBeNull();
    expect(fake.posts).toHaveLength(1);
  });

  it('exposes the deterministic-name surface (listChats / getChatName / getChatSlug)', async () => {
    fake.chats.set(CHAT('room9'), { title: 'Dándo Ruiz', type: 'group', isMuted: true, accountID: 'whatsapp' });
    const { bridge } = await startBridge();
    const chats = await bridge.listChats();
    const r9 = chats.find((c) => c.id === CHAT('room9'));
    expect(r9).toMatchObject({ name: 'Dándo Ruiz', slug: 'dando-ruiz', isGroup: true, isMuted: true });
    expect(bridge.getChatName(CHAT('room9'))).toBe('Dándo Ruiz');
    expect(bridge.getChatSlug(CHAT('room9'))).toBe('dando-ruiz');
  });

  it('default verdict never surfaces: no resolver wired → transcribes but no 👂', async () => {
    const { incoming } = await startBridge();
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ text: null, type: 'VOICE', attachments: [{ id: 'a1', isVoiceNote: true, srcURL: 'file:///tmp/n.ogg' }] })] });
    await waitFor(() => incoming.length === 1);
    expect(incoming[0].text).toBe('fake transcript');  // enabled by default → E still hears
    expect(fake.posts).toHaveLength(0);                 // postsBack false by default → silent
  });

  it('processed ids survive a restart (beeper-seen.jsonl)', async () => {
    const first = await startBridge();
    const m = liveMsg({ text: 'once only' });
    fake.emit({ type: 'message.upserted', entries: [m] });
    await waitFor(() => first.incoming.length === 1);
    first.bridge.stop();

    const second = await startBridge();
    // Same id replayed with a FRESH timestamp (so the backlog gate alone
    // can't be what saves us).
    fake.emit({ type: 'message.upserted', entries: [{ ...m, timestamp: Date.now() }] });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ text: 'sentinel' })] });
    await waitFor(() => second.incoming.some((i) => i.text === 'sentinel'));
    expect(second.incoming.filter((i) => i.text === 'once only')).toHaveLength(0);
  });
});
