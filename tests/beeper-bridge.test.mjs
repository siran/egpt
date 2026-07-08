// Drives the real beeper bridge against a fake Beeper Desktop API (local
// HTTP + WS). Covers the hardening contract: room-service 👂 gating (posts_back),
// backlog gate, persisted dedup, fail-closed network scope, echo
// suppression.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startBeeperBridge, newerMsgId } from '../src/bridges/beeper.mjs';
import { EGPT_HOME } from '../src/egpt-home.mjs';
import { encodeMesh } from '../src/mesh/relay.mjs';
import { surfaceOf } from '../src/spine/identity.mjs';
import { _resetPostsBackDebounce } from '../src/incoming-media.mjs';

async function startFakeBeeper() {
  const posts = [];   // POSTs to /v1/chats/:id/messages
  const edits = [];   // PUTs to /v1/chats/:id/messages/:msgId (in-place stream edits)
  const reactions = [];   // POSTs to /v1/chats/:id/messages/:msgId/reactions (E's react limb)
  const uploads = [];     // POSTs to /v1/assets/upload (E's media limb)
  const chats = new Map();   // chatID -> chat info served by GET
  const messages = new Map();   // chatID -> recent-message list served by GET /messages (resolveSentMessageId)
  let msgListGets = 0;        // GET /messages polls served — lets a test choreograph the upsert race
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const react = req.url.match(/^\/v1\/chats\/([^/]+)\/messages\/([^/?]+)\/reactions$/);
      if (req.method === 'POST' && react) {
        reactions.push({ chatID: decodeURIComponent(react[1]), messageID: decodeURIComponent(react[2]), ...JSON.parse(body) });
        res.end(JSON.stringify({ success: true }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/assets/upload') {
        uploads.push({ bytes: body.length });   // multipart body — we don't parse it, just confirm the call
        res.end(JSON.stringify({ uploadID: `up-${uploads.length}`, mimeType: 'image/png', fileName: 'blob.png', srcURL: 'file:///tmp/x' }));
        return;
      }
      const post = req.url.match(/^\/v1\/chats\/([^/]+)\/messages$/);
      if (req.method === 'POST' && post) {
        posts.push({ chatID: decodeURIComponent(post[1]), ...JSON.parse(body) });
        res.end(JSON.stringify({ pendingMessageID: `pm-${posts.length}` }));
        return;
      }
      const put = req.url.match(/^\/v1\/chats\/([^/]+)\/messages\/([^/?]+)$/);
      if (req.method === 'PUT' && put) {
        edits.push({ chatID: decodeURIComponent(put[1]), messageID: decodeURIComponent(put[2]), ...JSON.parse(body) });
        res.end('{}');
        return;
      }
      // Recent-message list (resolveSentMessageId polls it to confirm a sent id).
      // A FUNCTION value serves dynamically — lets a test model the live upsert
      // race (the just-POSTed message appearing only on a later poll).
      const msgList = req.url.match(/^\/v1\/chats\/([^/]+)\/messages(?:\?.*)?$/);
      if (req.method === 'GET' && msgList) {
        msgListGets += 1;
        const v = messages.get(decodeURIComponent(msgList[1]));
        res.end(JSON.stringify({ items: (typeof v === 'function' ? v() : v) ?? [] }));
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
    port, posts, edits, reactions, uploads, chats, messages,
    msgListGets: () => msgListGets,
    subscribed: () => subscribed,
    emit: (ev) => { for (const ws of sockets) ws.send(JSON.stringify(ev)); },
    close: () => new Promise((r) => { for (const ws of sockets) ws.terminate(); wss.close(() => server.close(r)); }),
  };
}

const waitFor = async (cond, ms = 10000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

// 2026-07-08: constructing the REAL bridge fires its internal onLog, which
// appendFileSync's every line to join(EGPT_HOME, 'config', 'logs', 'beeper.log'). With
// EGPT_HOME unset that IS the LIVE ~/.egpt log — a `vitest` run polluted it with these
// very fixtures (chat-1, Bea, "fake transcript"). tests/setup-egpt-home.mjs forces
// EGPT_HOME to a throwaway temp before this module's (hoisted) imports freeze _BEEPER_LOG;
// assert that precondition held, so this file fails LOUD if the suite isolation is dropped.
beforeAll(() => {
  expect(EGPT_HOME, 'EGPT_HOME must be an isolated temp — see tests/setup-egpt-home.mjs').not.toBe(join(homedir(), '.egpt'));
});

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
    postsBackDelayMs: 0,   // tests assert the 👂 gate synchronously; debounce timing is covered in incoming-media.test.mjs
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

  // MESSAGES-FIRST-CLASS-PLAN Phase 2: a reaction rides the TARGET message's
  // re-upsert (reactions[] = [{participantID, reactionKey}]); the bare type:REACTION
  // event carries no emoji and is skipped. Baseline-on-first-sight (I10): only a
  // reaction ADDED after the message's first sight this session surfaces.
  it('surfaces a NEW reaction as a stage-direction (reactor + emoji + target + snippet)', async () => {
    const { incoming } = await startBridge();
    const tgt = `${Math.floor(Math.random() * 1e6)}`;
    // 1) the target message arrives first → baseline (no reactions yet)
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ id: tgt, text: '<strong>ron</strong> is bold', senderName: 'An' })] });
    await waitFor(() => incoming.some((i) => i.from.msgKey === tgt));
    const before = incoming.length;
    // 2) someone reacts → the target re-upserts carrying reactions[] (+ the bare REACTION event)
    fake.emit({ type: 'message.upserted', entries: [
      { id: '999001', chatID: CHAT('chat-1'), type: 'REACTION', text: '', senderID: 'bea@beeper.local', senderName: 'Bea (contacto)', senderPushName: 'Bea', linkedMessageID: tgt, timestamp: Date.now() },
      { id: tgt, chatID: CHAT('chat-1'), type: 'TEXT', text: '<strong>ron</strong> is bold', senderName: 'An',
        timestamp: Date.now(), reactions: [{ participantID: 'bea@beeper.local', emoji: true, reactionKey: '👍' }] },
    ] });
    await waitFor(() => incoming.length > before);
    const react = incoming[incoming.length - 1];
    expect(react.from.isReaction).toBe(true);
    expect(react.text).toBe('reacted 👍 to #' + tgt + ' "**ron** is bold"');   // emoji + target + snippet (markdown preserved)
    expect(react.from.senderName).toBe('Bea');   // reactor resolved by pushed name, not the saved label
  });

  it('does not surface a pre-existing reaction on a message first seen this session (I10)', async () => {
    const { incoming } = await startBridge();
    const tgt = `${Math.floor(Math.random() * 1e6)}`;
    // first sight ALREADY carries a reaction (reconnect re-sync) → baseline, no emit
    fake.emit({ type: 'message.upserted', entries: [
      { id: tgt, chatID: CHAT('chat-1'), type: 'TEXT', text: 'hola', senderName: 'An', timestamp: Date.now(),
        reactions: [{ participantID: 'bea@beeper.local', reactionKey: '👍' }] },
    ] });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ text: 'sentinel' })] });
    await waitFor(() => incoming.some((i) => i.text === 'sentinel'));
    expect(incoming.some((i) => i.from.isReaction)).toBe(false);   // the pre-existing 👍 was a baseline, not replayed
  });

  // MESSAGES-FIRST-CLASS-PLAN: an EDIT (re-upsert with changed text) surfaces as a
  // stage-direction; an unchanged re-upsert (receipt/seen) does not.
  it('surfaces a message EDIT as a stage-direction (old → new)', async () => {
    const { incoming } = await startBridge();
    const id = `${Math.floor(Math.random() * 1e6)}`;
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ id, text: 'imbécil', senderName: 'An' })] });
    await waitFor(() => incoming.some((i) => i.text === 'imbécil'));
    const before = incoming.length;
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ id, text: 'pobrecito', senderName: 'An' })] });   // edit: same id, new text
    await waitFor(() => incoming.length > before);
    const edit = incoming[incoming.length - 1];
    expect(edit.from.isStageDirection).toBe(true);
    expect(edit.from.isReaction).toBe(false);
    expect(edit.text).toBe('edited #' + id + ' "imbécil" → "pobrecito"');
  });

  it('does NOT emit an edit when a message re-upserts UNCHANGED (receipt/seen)', async () => {
    const { incoming } = await startBridge();
    const m = liveMsg({ id: `${Math.floor(Math.random() * 1e6)}`, text: 'hola' });
    fake.emit({ type: 'message.upserted', entries: [m] });
    fake.emit({ type: 'message.upserted', entries: [m] });   // identical re-upsert
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ text: 'sentinel' })] });
    await waitFor(() => incoming.some((i) => i.text === 'sentinel'));
    expect(incoming.some((i) => i.from.isStageDirection)).toBe(false);
  });

  it("suppresses an incoming that starts with the persona body_emoji (E's own re-ingested message)", async () => {
    const { incoming } = await startBridge({ personaEmoji: '🐶' });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ text: '🐶 egpt: roger', senderName: 'An' })] });   // E's own reply, echoed
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ text: 'sentinel-human' })] });                   // a real human message
    await waitFor(() => incoming.some((i) => i.text === 'sentinel-human'));
    expect(incoming.map((i) => i.text)).not.toContain('🐶 egpt: roger');   // the persona-marked message was dropped
  });

  it('converts inbound HTML message text to markdown before dispatch', async () => {
    // Beeper delivers text as HTML; the model + transcript must see prose/markdown,
    // not markup (operator 2026-06-16, the morgan thread).
    const { incoming } = await startBridge();
    fake.emit({ type: 'message.upserted', entries: [
      liveMsg({ text: '<p>te entiendo <strong>An</strong>, mira <a href="https://x.com/p">aquí</a></p>' }),
    ] });
    await waitFor(() => incoming.length === 1);
    expect(incoming[0].text).toBe('te entiendo **An**, mira [aquí](https://x.com/p)');
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

  it("self-sent (isSender) messages show the configured userName; others show their pushed name", async () => {
    // Beeper gives the self participant no fullName — senderName is the matrix id
    // ('@anrodriguez:beeper.com'). The bridge substitutes the configured userName
    // for the owner's own lines; other contacts get their OWN pushed name — never the
    // operator's saved contact-list label (op 2026-06-16 / privacy op 2026-07-03).
    const { incoming } = await startBridge({ userName: 'Andrés' });
    fake.emit({ type: 'message.upserted', entries: [
      liveMsg({ isSender: true, senderName: '@anrodriguez:beeper.com', text: 'mío' }),
      liveMsg({ isSender: false, senderName: 'Bea (mi vecina)', senderPushName: 'Bea', text: 'suyo' }),
    ] });
    await waitFor(() => incoming.length === 2);
    expect(incoming[0].from.senderName).toBe('Andrés');   // self → configured name
    expect(incoming[0].from.isSender).toBe(true);
    expect(incoming[1].from.senderName).toBe('Bea');      // other → pushed name, not the saved label
  });

  // The SENDER identity is the person's OWN pushed/profile name, NOT the operator's
  // saved contact-list label — a 1:1 with the saved label "Ricki Mejia amigo diana
  // real estate" leaked that private annotation as the sender (operator 2026-07-03).
  // When the payload carries a distinct pushed name, the LINE is attributed to it;
  // the chat label ([chatname] / folder) stays the operator's label (chatName).
  it('prefers the sender\'s own pushed name over the contact-list label for the SENDER', async () => {
    fake.chats.set(CHAT('chat-ricki'), { title: 'Ricki Mejia amigo diana real estate', type: 'single', isMuted: false, accountID: 'whatsapp' });
    const { incoming } = await startBridge();
    fake.emit({ type: 'message.upserted', entries: [liveMsg({
      chatID: CHAT('chat-ricki'), isSender: false,
      senderID: '@whatsapp_584122361030:beeper.local',
      senderName: 'Ricki Mejia amigo diana real estate',   // Beeper's saved contact-list label
      senderPushName: 'Ricki Mejia',                        // the person's OWN pushed name
      text: 'Buenísimos quedo atento',
    })] });
    await waitFor(() => incoming.length === 1);
    expect(incoming[0].from.senderName).toBe('Ricki Mejia');                        // SENDER = pushed name
    expect(incoming[0].from.chatName).toBe('Ricki Mejia amigo diana real estate');  // chat label unchanged
  });

  // HARD PRIVACY RULE (operator 2026-07-03): the sender attribution must NEVER be the
  // operator's saved contact-list label — not even as a fallback (the label carries
  // the operator's private annotations, a leak into transcripts/replies/mesh). When
  // no pushed name is present (Beeper's actual shape for a SAVED contact — senderName
  // IS the saved label, no separate pushName exists), the sender falls back to a
  // NON-PRIVATE id: the phone number from the WhatsApp jid. The label appears NOWHERE
  // in the sender identity (senderName / firstName / username all leak-safe).
  it('NEVER falls back to the operator\'s contact-list label — uses the phone/id instead', async () => {
    const { incoming } = await startBridge();
    fake.emit({ type: 'message.upserted', entries: [liveMsg({
      isSender: false,
      senderID: '@whatsapp_584122361030:beeper.local',
      senderName: 'Ricki Mejia amigo diana real estate',   // the private label — must never surface
      text: 'hola',
    })] });
    await waitFor(() => incoming.length === 1);
    const from = incoming[0].from;
    expect(from.senderName).toBe('+584122361030');   // non-private phone, NOT the label
    // the private label leaks through NONE of the sender-identity fields
    for (const v of [from.senderName, from.firstName, from.username]) {
      expect(v ?? '').not.toContain('amigo diana real estate');
    }
  });

  // Non-WhatsApp / unparseable id → the stable senderID stands in (still non-private);
  // the label is still never used.
  it('with no pushed name and a non-phone id, the stable id stands in (never the label)', async () => {
    fake.chats.set(CHAT('chat-tg'), { title: 'Primo (deudor)', type: 'single', isMuted: false, accountID: 'telegram' });
    const { incoming } = await startBridge();
    fake.emit({ type: 'message.upserted', entries: [liveMsg({
      chatID: CHAT('chat-tg'), isSender: false,
      senderID: '@telegram_88164392:beeper.local',
      senderName: 'Primo (deudor)', text: 'hola',
    })] });
    await waitFor(() => incoming.length === 1);
    expect(incoming[0].from.senderName).toBe('@telegram_88164392:beeper.local');   // stable id, not the label
    expect(incoming[0].from.senderName).not.toContain('deudor');
  });

  // The voice-note 👂 echo header carries the note author — same preference: the
  // person's pushed name, not the operator's saved label.
  it('the 👂 voice echo uses the sender\'s pushed name, not the contact-list label', async () => {
    const { incoming } = await startBridge({ resolveTranscriptionService: async () => ({ enabled: true, postsBack: true }) });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({
      isSender: false, type: 'VOICE', text: null,
      senderName: 'Ricki Mejia amigo diana real estate', senderPushName: 'Ricki Mejia',
      attachments: [{ id: 'a1', isVoiceNote: true, srcURL: 'file:///tmp/note.ogg' }],
    })] });
    await waitFor(() => incoming.length === 1);
    await waitFor(() => fake.posts.length === 1);
    expect(fake.posts[0].text).toBe('👂 Ricki Mejia: fake transcript');   // pushed name, not the label
  });

  // LID PUSH NAME (operator 2026-07-08, morgan chat): a WhatsApp LID sender
  // (@whatsapp_lid-…) is an UNSAVED contact, so Beeper's senderName is the person's OWN
  // pushed name (not a saved label). The label must resolve to it, not fall back to the
  // raw LID — the live 👂 posted "👂 @whatsapp_lid-85555832479795:beeper.local (92s): …".
  it('a LID-shaped sender uses its pushed name (senderName), not the raw LID', async () => {
    const { incoming } = await startBridge();
    fake.emit({ type: 'message.upserted', entries: [liveMsg({
      isSender: false,
      senderID: '@whatsapp_lid-85555832479795:beeper.local',
      senderName: 'le_moi',   // unsaved LID contact → senderName IS the push name
      text: 'hola',
    })] });
    await waitFor(() => incoming.length === 1);
    expect(incoming[0].from.senderName).toBe('le_moi');               // push name, not the raw LID
    expect(incoming[0].from.senderName).not.toContain('whatsapp_lid');
  });

  it('the 👂 voice echo for a LID sender carries the pushed name, not the raw LID', async () => {
    const { incoming } = await startBridge({ resolveTranscriptionService: async () => ({ enabled: true, postsBack: true }) });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({
      isSender: false, type: 'VOICE', text: null,
      senderID: '@whatsapp_lid-85555832479795:beeper.local',
      senderName: 'le_moi',
      attachments: [{ id: 'a1', isVoiceNote: true, srcURL: 'file:///tmp/note.ogg' }],
    })] });
    await waitFor(() => incoming.length === 1);
    await waitFor(() => fake.posts.length === 1);
    expect(fake.posts[0].text).toBe('👂 le_moi: fake transcript');   // pushed name, not the raw LID
  });

  // CONTRACT C2 (the regression): a voice note must be transcribed AND its file
  // handed to onMedia — not transcribed-then-dropped.
  it('a voice note is transcribed AND its file handed to onMedia (caption = transcript)', async () => {
    const { incoming, media } = await startBridge();
    const att = fakeAttachment({ name: 'ptt.ogg', mimeType: 'audio/ogg', isVoiceNote: true });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ type: 'VOICE', text: null, attachments: [att] })] });
    await waitFor(() => media.length === 1);
    expect(incoming[0].text).toBe('(voice transcription) fake transcript');   // dispatched as marked audio (no duration available)
    // onMedia is a host-facing (downstream) hook — it sees the SHORT chatID, not
    // the wire's full Matrix form (CHAT('chat-1') = '!chat-1:beeper.local').
    expect(media[0]).toMatchObject({ chatID: 'chat-1', kind: 'audio', isVoiceNote: true });
    expect(media[0].localPath).toContain('ptt.ogg');
    expect(media[0].caption).toBe('fake transcript');          // sidecar caption = bare transcription (no marker)
  });

  // GENOME §4 / C7.6: a voice note's body is marked "(voice transcription, Ns)"
  // so the model can tell audio arrived — with the duration the transcriber reads
  // off the ffmpeg WAV (operator 2026-06-16, the morgan thread: Beeper omitted the
  // marker; duration comes from ffmpeg, not the Beeper attachment).
  it('marks a voice note with the duration the transcriber reports', async () => {
    const { incoming } = await startBridge({
      transcribe: async (_p, _cfg, _log, meta) => { if (meta) meta.durationSec = 8; return 'fake transcript'; },
    });
    const att = fakeAttachment({ name: 'dur.ogg', mimeType: 'audio/ogg', isVoiceNote: true });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ type: 'VOICE', text: null, attachments: [att] })] });
    await waitFor(() => incoming.length === 1);
    expect(incoming[0].text).toBe('(voice transcription, 8s) fake transcript');
  });

  // A photo is saved AND announced to the model (operator 2026-06-16 regression):
  // the saved path is surfaced so E sees the media arrived and a vision brain can
  // Read it — it used to route to disk only and never reach E.
  it('a non-voice attachment (image) is saved AND announced to the model with its path', async () => {
    const { incoming, media } = await startBridge();
    const att = fakeAttachment({ name: 'foto.jpg', mimeType: 'image/jpeg' });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ type: 'IMAGE', text: null, attachments: [att] })] });
    await waitFor(() => incoming.length === 1);
    expect(media[0]).toMatchObject({ chatID: 'chat-1', kind: 'image', network: 'whatsapp' });   // SHORT (host-facing); meta carries the origin network (default chat = whatsapp)
    expect(incoming[0].text).toMatch(/\(image[^)]*\) \[saved: /);   // path announced to E
  });

  // The onMedia meta must carry the message's ORIGIN network so the media service
  // buckets the file under the SAME surface as the transcript (a Telegram photo
  // must not fall into the whatsapp media/ folder — the bug). Derived like
  // from.network: msg.accountID || the chat's accountID || 'whatsapp'.
  it('onMedia meta carries the origin network (a telegram chat → network:"telegram")', async () => {
    fake.chats.set(CHAT('chat-tg'), { title: 'TeleFam', type: 'single', isMuted: false, accountID: 'telegram' });
    const { media } = await startBridge();
    const att = fakeAttachment({ name: 'foto.jpg', mimeType: 'image/jpeg' });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ chatID: CHAT('chat-tg'), type: 'IMAGE', text: null, attachments: [att] })] });
    await waitFor(() => media.length === 1);
    expect(media[0]).toMatchObject({ chatID: 'chat-tg', kind: 'image', network: 'telegram' });   // SHORT (host-facing)
  });

  // ROUTE A (operator 2026-06-16): a video is handed to E with keyframes (Read
  // them) + the audio transcript — onMedia (the host) returns the augmented
  // descriptor; the bridge announces frames + transcript on the dispatch line.
  it('a video surfaces host-extracted frames + the audio transcript to the model', async () => {
    const { incoming } = await startBridge({
      onMedia: async () => ({ savedPath: '/m/clip.mp4', framePaths: ['/m/clip-frame-01.jpg', '/m/clip-frame-02.jpg'], transcript: 'hola desde el video' }),
    });
    const att = fakeAttachment({ name: 'clip.mp4', mimeType: 'video/mp4' });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ type: 'VIDEO', text: null, attachments: [att] })] });
    await waitFor(() => incoming.length === 1);
    // Paths are surfaced RELATIVE to the conversation folder (`media/<file>`),
    // never the absolute host path — E reads them from its sandbox root (GENOME
    // §2.5). The descriptor still carries the absolute path internally; only the
    // dispatch text is relativized.
    expect(incoming[0].text).toContain('(video clip.mp4) [saved: media/clip.mp4]');
    expect(incoming[0].text).toContain('frames (Read these): media/clip-frame-01.jpg  media/clip-frame-02.jpg');
    expect(incoming[0].text).toContain('(video transcription) hola desde el video');
    expect(incoming[0].text).not.toContain('/m/clip.mp4');   // no absolute host path leaks to E
  });

  it('an image WITH a caption surfaces both the caption and the saved path', async () => {
    const { incoming } = await startBridge();
    const att = fakeAttachment({ name: 'foto.jpg', mimeType: 'image/jpeg' });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ type: 'IMAGE', text: 'miren esto', attachments: [att] })] });
    await waitFor(() => incoming.length === 1);
    expect(incoming[0].text).toContain('miren esto');
    expect(incoming[0].text).toMatch(/\[saved: /);
  });

  // A shared AUDIO FILE (an .mp3 that is NOT a voice note) must be announced so E
  // knows it arrived — it used to be silently dropped (kind==='audio' filter),
  // never even logged (operator 2026-06-16: "not even in transcript").
  it('a non-voice audio file (.mp3) is announced to the model (not silently dropped)', async () => {
    const { incoming } = await startBridge();
    const att = fakeAttachment({ name: 'song.mp3', mimeType: 'audio/mpeg' });   // isVoiceNote:false
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ type: 'FILE', text: null, attachments: [att] })] });
    await waitFor(() => incoming.length === 1);
    expect(incoming[0].text).toMatch(/\(audio song\.mp3\) \[saved: /);
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

  it("mode:auto echo: E's OWN plain reply (no persona marker) is suppressed by sent-ids/text, but the operator's genuinely-typed line passes through", async () => {
    // In an auto chat E sends PLAIN operator text — no 🐶 body_emoji — so the
    // persona-marker guard cannot catch its echo; the sent-ids/text window IS the
    // suppression key (refinement #4). The operator's OWN typed line is isSender too but
    // was never sent by us, so it is NOT suppressed and reaches the host to accumulate.
    const { bridge, incoming } = await startBridge();   // NO personaEmoji — auto sends carry none
    await bridge.send('all good, talk soon', { chatId: CHAT('chat-1') });
    await waitFor(() => fake.posts.length === 1);
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ id: 'echo-id', isSender: true, text: 'all good, talk soon' })] });   // E's reply, echoed back
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ id: 'op-id', isSender: true, text: 'note for later' })] });          // operator's OWN typed message
    await waitFor(() => incoming.some((i) => i.text === 'note for later'));
    expect(incoming.map((i) => i.text)).not.toContain('all good, talk soon');   // echo suppressed via sent-ids/text window
    expect(incoming.find((i) => i.text === 'note for later').from.isSender).toBe(true);   // operator's own line passes through → spine accumulates it
  });

  it("a node's own MESH ENVELOPE echo IS suppressed like any other self-send (two-node topology: DOLLY sees it via normal cross-account delivery, not self-reingestion; reverts the 2026-07-05 self-relay exemption)", async () => {
    // With a real second node (DOLLY, a second Beeper account) on the other end of
    // the chain, each node sees the OTHER account's posts via normal cross-account
    // delivery and never needs to re-see its own. So a mesh envelope this node just
    // posted is an ordinary self-echo — sent-ids/text window suppresses it exactly
    // like any other message; there's no reason to special-case the provenance tail.
    const { bridge, incoming } = await startBridge();
    const envelope = '```\nQGRvbiBob2xh\n\n---\nfrom: Me\nto: don.do\nmid: chain-1\nenc: b64\n```';
    await bridge.send(envelope, { chatId: CHAT('chat-1') });
    await waitFor(() => fake.posts.length === 1);
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ id: 'self-echo-id', text: envelope })] });   // our own post, echoed back
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ text: 'a real message' })] });
    await waitFor(() => incoming.some((i) => i.text === 'a real message'));
    expect(incoming.map((i) => i.text)).not.toContain(envelope);   // echo suppressed via sent-ids/text window
  });

  // MULTIPATH MESH FUZZY-DROP (operator live test 2026-07-06): isEcho's stage-3 word-bag
  // fallback (built for reformatted MENU echoes) was eating RELAY traffic. Two mesh envelopes
  // in the SAME channel within the 60s TTL share almost every token — identical base64 body,
  // same from/from_node/by/post_id/enc — differing only in `to:` and one `via:` entry. Live:
  // REVE posted the origin envelope (to: don.do, via: [carol.kg]); ~1s later the NEXT HOP's
  // forward arrived in the same chat (to: wren.kg, via: [carol.kg, don.do], same body/post_id) —
  // a FOREIGN message the node had to act on — and stage 3 matched it as our own echo, dropping
  // it BEFORE the "incoming" log line. The relay chain died silently. FIX: a message that parses
  // as a mesh envelope skips ONLY the fuzzy stage (exact id/text stages still apply). Both
  // envelopes are built with encodeMesh so the shape is honest.
  it('a FOREIGN mesh-envelope forward (same body/provenance, only to:/via: differ) is NOT fuzzy-dropped as our own echo — the relay chain survives', async () => {
    const { bridge, incoming } = await startBridge();
    const chat = CHAT('egpt-mesh-do-kg');
    // Long enough body that the ORIGIN envelope's word bag clears rememberSent's size>=8 gate.
    const body = 'hola @don please answer this longer relayed question so the word bag is big';
    // ORIGIN envelope this node posted (to: don.do, via: [carol.kg]) → rememberSent records its text + bag.
    const origin = encodeMesh({ by: 'An', body, from: 'HFM', from_node: 'kg', to: 'don.do', post_id: 'p-1', via: 'carol.kg' });
    await bridge.send(origin, { chatId: chat });
    await waitFor(() => fake.posts.length === 1);
    // ~1s later the NEXT HOP's forward arrives in the SAME chat — a FOREIGN message: identical
    // base64 body + from/from_node/by/post_id/enc, differing ONLY in `to:` (wren.kg) and one `via:` entry.
    const forward = encodeMesh({ by: 'An', body, from: 'HFM', from_node: 'kg', to: 'wren.kg', post_id: 'p-1', via: 'carol.kg,don.do' });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ id: 'foreign-fwd', chatID: chat, isSender: false, text: forward })] });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ id: 'sentinel-fwd', chatID: chat, text: 'a real message' })] });
    await waitFor(() => incoming.some((i) => i.from.msgKey === 'sentinel-fwd'));
    expect(incoming.some((i) => i.from.msgKey === 'foreign-fwd')).toBe(true);   // surfaced, NOT fuzzy-dropped (pre-fix: dropped)
  });

  // REGRESSION LOCK (a): skipping the fuzzy stage for envelopes must NOT reopen the 73fc57a
  // invariant — a node's OWN envelope echo (identical text, different id) is STILL suppressed by
  // the exact-text stage. Same chat/scenario as the repro above.
  it("a node's OWN mesh-envelope echo (identical text) is STILL suppressed — only the fuzzy stage is skipped, the exact id/text stages stay (73fc57a invariant)", async () => {
    const { bridge, incoming } = await startBridge();
    const chat = CHAT('egpt-mesh-do-kg');
    const env = encodeMesh({ by: 'An', body: 'hola @don answer please a longer body here', from: 'HFM', from_node: 'kg', to: 'don.do', post_id: 'p-2', via: 'carol.kg' });
    await bridge.send(env, { chatId: chat });
    await waitFor(() => fake.posts.length === 1);
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ id: 'own-echo', chatID: chat, text: env })] });   // our own post, echoed back (different id, identical text)
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ id: 'sentinel-own', chatID: chat, text: 'a real message' })] });
    await waitFor(() => incoming.some((i) => i.from.msgKey === 'sentinel-own'));
    expect(incoming.some((i) => i.from.msgKey === 'own-echo')).toBe(false);   // suppressed by the exact-text stage
  });

  // REGRESSION LOCK (b): a reformatted NON-envelope MENU echo (same words, different markers) is
  // STILL caught by the fuzzy word-bag stage — the 2026-06-25 wizard echo-loop guard is unbroken
  // (parseMesh returns null for a menu, so the fuzzy stage still runs for it).
  it('a reformatted NON-envelope menu echo (same words, different markers) is STILL caught by the fuzzy word-bag stage', async () => {
    const { bridge, incoming } = await startBridge();
    const chat = CHAT('chat-1');
    const menu = 'egpt · conversations (newest first)\n  0) ✦ @egpt — global default brain\n  1) Joyce Vicente · e:haiku/mention\n  2) SPOILER ALERT · e:sonnet/mention\n(reply a number · q quit)';
    const echo = 'egpt · conversations (newest first) 0) ✦ @egpt — global default brain - 1) Joyce Vicente · e:haiku/mention - 2) SPOILER ALERT · e:sonnet/mention - reply a number · q quit';   // reformatted one-line echo, NOT a mesh envelope
    await bridge.send(menu, { chatId: chat });
    await waitFor(() => fake.posts.length === 1);
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ id: 'menu-echo', chatID: chat, text: echo })] });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ id: 'sentinel-menu', chatID: chat, text: 'a real human line' })] });
    await waitFor(() => incoming.some((i) => i.from.msgKey === 'sentinel-menu'));
    expect(incoming.some((i) => i.from.msgKey === 'menu-echo')).toBe(false);   // fuzzy stage still active for non-envelopes
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

  // BACKLOG BACKFILL (operator 2026-07-08, S3 wake): a message older than bridge start is
  // no longer DROPPED — it reaches the transcript flagged `backlog` (the spine logs it but
  // never dispatches). Was: `incoming.length === 1`, the stale message never surfaced.
  it('backlog backfill: an old message reaches the transcript flagged backlog; a fresh one is not', async () => {
    const { incoming } = await startBridge();
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ text: 'stale', timestamp: Date.now() - 60_000 })] });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ text: 'fresh' })] });
    await waitFor(() => incoming.length === 2);
    const stale = incoming.find((i) => i.text === 'stale');
    const fresh = incoming.find((i) => i.text === 'fresh');
    expect(stale.from.backlog).toBe(true);    // backfilled — the spine logs it, never dispatches (no re-answer)
    expect(fresh.from.backlog).toBe(false);   // live traffic — dispatched normally
  });

  // A HELD (backlog) voice note MUST still be transcribed locally so the backfill carries
  // text, not "[voice note]" — and the 👂 still posts on a default (transcribe_ack:true) node.
  it('backlog voice note is transcribed + logged, and the 👂 posts (default transcribe_ack)', async () => {
    const { incoming } = await startBridge({ resolveTranscriptionService: async () => ({ enabled: true, postsBack: true }) });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({
      text: null, type: 'VOICE', timestamp: Date.now() - 60_000,   // older than bridge start → backlog
      attachments: [{ id: 'a1', isVoiceNote: true, srcURL: 'file:///tmp/note.ogg' }],
    })] });
    await waitFor(() => incoming.length === 1);
    expect(incoming[0].from.backlog).toBe(true);                              // backfilled, never dispatched
    expect(incoming[0].text).toBe('(voice transcription) fake transcript');  // …but STILL transcribed locally
    await waitFor(() => fake.posts.length === 1);
    expect(fake.posts[0].text).toBe('👂 An: fake transcript');               // default transcribe_ack → 👂 posts
  });

  // 👂 ROLE-GATE (operator 2026-07-08): transcribe_ack:false transcribes + LOGS but never
  // posts the 👂 — for live notes too (one flag, one meaning: "this node posts 👂 acks").
  it('transcribe_ack:false silences the 👂 — the note is still transcribed + logged, never posted', async () => {
    const { incoming } = await startBridge({
      transcribeAck: false,
      resolveTranscriptionService: async () => ({ enabled: true, postsBack: true }),
    });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({
      text: null, type: 'VOICE',
      attachments: [{ id: 'a1', isVoiceNote: true, srcURL: 'file:///tmp/note.ogg' }],
    })] });
    await waitFor(() => incoming.length === 1);
    expect(incoming[0].text).toBe('(voice transcription) fake transcript');   // HEARD (transcribed + logged)
    expect(fake.posts).toHaveLength(0);                                        // SPOKEN suppressed by the role-gate
  });

  it('network scope is fail-closed WHEN SET: unknown or foreign accountID drops; prefix instance ids pass', async () => {
    fake.chats.set(CHAT('chat-unknown'), { title: 'X', type: 'single', isMuted: false, accountID: null });
    fake.chats.set(CHAT('chat-telegram'), { title: 'T', type: 'single', isMuted: false, accountID: 'telegram' });
    fake.chats.set(CHAT('chat-wa2'), { title: 'W', type: 'single', isMuted: false, accountID: 'whatsappgo_2' });
    const { incoming } = await startBridge({ networks: ['whatsapp'] });   // explicit scope (default [] = all networks)
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ chatID: CHAT('chat-unknown'), text: 'no-acct' })] });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ chatID: CHAT('chat-telegram'), text: 'tg' })] });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ chatID: CHAT('chat-wa2'), text: 'wa-instance' })] });
    await waitFor(() => incoming.length === 1);
    expect(incoming[0].text).toBe('wa-instance');
  });

  it('default network scope is OPEN ([]): EVERY network is processed (Beeper is the transport; network is metadata, not a gate)', async () => {
    fake.chats.set(CHAT('chat-unknown'), { title: 'X', type: 'single', isMuted: false, accountID: null });
    fake.chats.set(CHAT('chat-telegram'), { title: 'T', type: 'single', isMuted: false, accountID: 'telegram' });
    fake.chats.set(CHAT('chat-signal'), { title: 'S', type: 'single', isMuted: false, accountID: 'signal' });
    const { incoming } = await startBridge();   // no networks → default [] = process all
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ chatID: CHAT('chat-unknown'), text: 'no-acct' })] });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ chatID: CHAT('chat-telegram'), text: 'tg' })] });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ chatID: CHAT('chat-signal'), text: 'sig' })] });
    await waitFor(() => incoming.length === 3);
    expect(incoming.map((i) => i.text).sort()).toEqual(['no-acct', 'sig', 'tg']);
  });

  it('👂 ack only where posts_back; elsewhere still transcribes silently', async () => {
    // resolveTranscriptionService is a host-facing (downstream) hook — it's called
    // with the SHORT id, not the wire's full Matrix form.
    const { incoming } = await startBridge({ resolveTranscriptionService: async (id) => ({ enabled: true, postsBack: id === 'chat-enrolled' }) });
    const voice = (chatID) => liveMsg({
      chatID, text: null, type: 'VOICE',
      attachments: [{ id: 'a1', isVoiceNote: true, srcURL: 'file:///tmp/note.ogg' }],
    });
    fake.emit({ type: 'message.upserted', entries: [voice(CHAT('chat-quiet'))] });
    fake.emit({ type: 'message.upserted', entries: [voice(CHAT('chat-enrolled'))] });
    await waitFor(() => incoming.length === 2);
    // Both transcripts reach the engine (E hears everything — enabled), marked as audio…
    expect(incoming.map((i) => i.text)).toEqual(['(voice transcription) fake transcript', '(voice transcription) fake transcript']);
    expect(incoming.every((i) => i.from.isTranscriptFromVoice)).toBe(true);
    // …but only the posts_back chat got the in-chat 👂 reply.
    expect(fake.posts).toHaveLength(1);
    expect(fake.posts[0].chatID).toBe(CHAT('chat-enrolled'));
    expect(fake.posts[0].text).toBe('👂 An: fake transcript');   // echo carries the note's author
    expect(fake.posts[0].replyToMessageID).toBeTruthy();         // …as a reply to the audio note
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
    expect(seen).toEqual([['room9']]);                  // verdict got the id ALONE, SHORT form — no name/slug to match on
  });

  it('posts_back by stable id → ack fires regardless of the chat title', async () => {
    fake.chats.set(CHAT('room9'), { title: 'anything at all', type: 'single', isMuted: false, accountID: 'whatsapp' });
    const { incoming } = await startBridge({ resolveTranscriptionService: async (id) => ({ enabled: true, postsBack: id === 'room9' }) });
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

  it('exposes the deterministic-name surface (listChats / getChatName / getChatSlug) — SHORT ids', async () => {
    // The fake SERVER speaks full-form Matrix ids (CHAT('room9') = the wire
    // shape); listChats()/getChatName/getChatSlug are host-facing (downstream)
    // and must expose the SHORT id only (operator 2026-07-03).
    fake.chats.set(CHAT('room9'), { title: 'Dándo Ruiz', type: 'group', isMuted: true, accountID: 'whatsapp' });
    const { bridge } = await startBridge();
    const chats = await bridge.listChats();
    const r9 = chats.find((c) => c.id === 'room9');
    expect(r9).toMatchObject({ name: 'Dándo Ruiz', slug: 'dando-ruiz', isGroup: true, isMuted: true });
    // jid MUST alias the room id — the whole chat-resolution layer keys on `.jid`
    // (assignWaIndex/resolveChatTarget); without it /channels shows @wanull and
    // name-resolution sees a phantom undefined-jid duplicate (operator 2026-06-16).
    expect(r9.jid).toBe('room9');
    expect(bridge.getChatName('room9')).toBe('Dándo Ruiz');
    expect(bridge.getChatSlug('room9')).toBe('dando-ruiz');
    // Defensive: a caller that still hands getChatName/getChatSlug the legacy
    // full-form id gets the same answer (shortChatId at the getter, not just at ingest).
    expect(bridge.getChatName(CHAT('room9'))).toBe('Dándo Ruiz');
    expect(bridge.getChatSlug(CHAT('room9'))).toBe('dando-ruiz');
  });

  it('default verdict never surfaces: no resolver wired → transcribes but no 👂', async () => {
    const { incoming } = await startBridge();
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ text: null, type: 'VOICE', attachments: [{ id: 'a1', isVoiceNote: true, srcURL: 'file:///tmp/n.ogg' }] })] });
    await waitFor(() => incoming.length === 1);
    expect(incoming[0].text).toBe('(voice transcription) fake transcript');  // enabled by default → E still hears (marked audio)
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

  // resolveSentMessageId (via sendAndGetId) confirms the id of a message WE just
  // posted by text-matching the recent list. With the placeholder nonce removed,
  // several messages can share the placeholder's exact text — so the resolver must
  // still land on THIS turn's message: pick the NEWEST (numeric) match, ignore a
  // same-text message that isn't ours (isSender:false), AND refuse anything at/below
  // the pre-send id floor (a message listed BEFORE our send can't be our send — the
  // 2026-07-04 stale-twin landmine proved newest-id + isSender alone insufficient:
  // a poll racing the upsert saw ONLY the old twin and "newest match" returned it).
  // The list is served dynamically: the just-posted message upserts AFTER the POST,
  // as live — the old static-list version of this test listed "this turn's message"
  // before the send happened, encoding exactly the assumption the landmine exploited.
  it('resolves a just-sent id to the newest OUR-OWN match above the pre-send floor — not a stale placeholder, not a foreign echo', async () => {
    const { bridge } = await startBridge();
    const chat = CHAT('chat-1');
    const TXT = '🐶 egpt\n⏳ Thinking…';   // the exact reply-train placeholder (no nonce)
    // Pre-send: an OLD stuck identical-text placeholder (ours). After the POST the
    // list gains OUR new message (11) and a FOREIGN same-text copy (12 — someone
    // quoting our line) which is the NEWEST overall, so isSender (not newest-alone)
    // must exclude it; the floor (9) must exclude the stale twin.
    fake.messages.set(chat, () => (fake.posts.length >= 1
      ? [
          { id: '9',  text: TXT, isSender: true },    // stale twin (pre-send) — below the floor
          { id: '11', text: TXT, isSender: true },    // THIS turn's message
          { id: '12', text: TXT, isSender: false },   // foreign echo, newest — must be ignored
        ]
      : [{ id: '9', text: TXT, isSender: true }]));
    const id = await bridge.sendAndGetId(TXT, { chatId: chat });
    expect(id).toBe('11');   // not '9' (stale, at/below floor), not '12' (foreign)
  });

  it('resolveSentMessageId tolerates list items lacking isSender (schema drift): matches by newest id', async () => {
    const { bridge } = await startBridge();
    const chat = CHAT('chat-1');
    const TXT = 'plain placeholder text';
    fake.messages.set(chat, () => (fake.posts.length >= 1
      ? [
          { id: '3', text: 'earlier unrelated', isSender: false },
          { id: '4', text: TXT },    // no isSender field → absent is acceptable
          { id: '5', text: TXT },
        ]
      : [{ id: '3', text: 'earlier unrelated', isSender: false }]));
    const id = await bridge.sendAndGetId(TXT, { chatId: chat });
    expect(id).toBe('5');
  });
});

// NETWORK PIN (operator 2026-07-06: multi-network mesh) — the same chat NAME can
// exist on multiple networks under one Beeper account; resolveChatId(name, { network })
// pins which network's chat the name resolves to. The listChats item's `.network`
// (= the API's accountID) is the filter key.
describe('beeper bridge — resolveChatId network pin', () => {
  it('picks the matching-network chat when two chats share a title', async () => {
    fake.chats.set(CHAT('room-wa'), { title: 'Rodz', type: 'single', isMuted: false, accountID: 'whatsapp' });
    fake.chats.set(CHAT('room-tg'), { title: 'Rodz', type: 'single', isMuted: false, accountID: 'telegram' });
    const { bridge } = await startBridge();
    expect(await bridge.resolveChatId('Rodz', { network: 'telegram' })).toBe('room-tg');
    expect(await bridge.resolveChatId('Rodz', { network: 'whatsapp' })).toBe('room-wa');
  });

  it('MISSES (no-match) when only the WRONG network has that title', async () => {
    fake.chats.set(CHAT('room-wa'), { title: 'Rodz', type: 'single', isMuted: false, accountID: 'whatsapp' });
    const { bridge } = await startBridge();
    expect(await bridge.resolveChatId('Rodz', { network: 'telegram' })).toBeNull();   // falls through to normal not-found
    expect(await bridge.resolveChatId('Rodz', { network: 'whatsapp' })).toBe('room-wa');   // the right network still resolves
  });

  it('cache-key separation: an unfiltered resolve of a name never shadows a later filtered lookup of the same name', async () => {
    fake.chats.set(CHAT('room-wa'), { title: 'Rodz', type: 'single', isMuted: false, accountID: 'whatsapp' });
    fake.chats.set(CHAT('room-tg'), { title: 'Rodz', type: 'single', isMuted: false, accountID: 'telegram' });
    const { bridge } = await startBridge();
    const un = await bridge.resolveChatId('Rodz');                                    // unfiltered → first match (ambiguous)
    expect(['room-wa', 'room-tg']).toContain(un);
    expect(await bridge.resolveChatId('Rodz', { network: 'telegram' })).toBe('room-tg');   // REAL filtered lookup, not the cached unfiltered id
    expect(await bridge.resolveChatId('Rodz', { network: 'whatsapp' })).toBe('room-wa');
  });

  it('no pin → resolves across all networks (prior behavior, unchanged)', async () => {
    fake.chats.set(CHAT('room-tg'), { title: 'Solo', type: 'single', isMuted: false, accountID: 'telegram' });
    const { bridge } = await startBridge();
    expect(await bridge.resolveChatId('Solo')).toBe('room-tg');   // no pin, telegram-only name still resolves
  });
});

// SHORT-ID BOUNDARY (operator 2026-07-03): the fake API always speaks the wire's
// full Matrix form (CHAT(n) helper); the bridge must normalize it to SHORT the
// moment it enters, and re-expand to full ONLY at the api() call. Everything
// host-facing (onIncoming's `from`, onMedia, listChats, getChatName/getChatSlug)
// sees short ids only; every fake.posts[*].chatID (what actually hit the API) is
// the full form.
describe('beeper bridge — short-id boundary', () => {
  it('onIncoming/from.chatId is the SHORT id, never the wire\'s full Matrix form', async () => {
    const { incoming } = await startBridge();
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ chatID: CHAT('chat-short'), text: 'hola' })] });
    await waitFor(() => incoming.length === 1);
    expect(incoming[0].from.chatId).toBe('chat-short');   // NOT '!chat-short:beeper.local'
  });

  it('a bare SHORT raw id (not a name) resolves and the send expands to full form at the POST', async () => {
    fake.chats.set(CHAT('room-plain'), { title: 'Room Plain', type: 'single', isMuted: false, accountID: 'whatsapp' });
    const { bridge } = await startBridge();
    // Prime the chat list cache so the short raw id resolves by exact `c.id` match
    // (mirrors how config/callers pass an already-known short id).
    await bridge.listChats();
    const r = await bridge.send('hola short id', { chatId: 'room-plain' });
    expect(r?.ok).toBe(true);
    expect(r.chatId).toBe('room-plain');                       // returned to the caller: SHORT
    expect(fake.posts[0].chatID).toBe(CHAT('room-plain'));      // what hit the API: FULL form
  });

  it('a legacy full-form chatId passed by a caller still resolves (defensive tolerance)', async () => {
    const { bridge } = await startBridge();
    const r = await bridge.send('hola legacy', { chatId: CHAT('chat-1') });
    expect(r?.ok).toBe(true);
    expect(r.chatId).toBe('chat-1');                            // normalized down for the caller
    expect(fake.posts[0].chatID).toBe(CHAT('chat-1'));           // still expands to full for the API
  });
});

// PER-SURFACE AUTHORIZATION (operator 2026-07-02): ids are per-surface NAMESPACES —
// a WhatsApp jid authorizes NOTHING on Telegram — so the bridge passes the message's
// origin network to isAllowedUser(senderId, network) and the host resolves the
// network → that surface's OWN allowed_users. These drive the SAME surfaceOf-based
// callback boot wires, so what's exercised is the bridge→host network-threading.
describe('beeper bridge — per-surface authorization', () => {
  const cfg = {
    whatsapp: { allowed_users: ['wa-op@beeper.local'] },
    telegram: { allowed_users: ['tg-op@beeper.local'] },
  };
  const perSurfaceAuth = (id, network) => ((cfg[surfaceOf(network)]?.allowed_users) ?? []).includes(id);

  it('a telegram sender in telegram.allowed_users is authorized', async () => {
    fake.chats.set(CHAT('chat-tg'), { title: 'TeleFam', type: 'single', isMuted: false, accountID: 'telegram' });
    const { incoming } = await startBridge({ isAllowedUser: perSurfaceAuth });
    fake.emit({ type: 'message.upserted', entries: [
      liveMsg({ chatID: CHAT('chat-tg'), isSender: false, senderID: 'tg-op@beeper.local', senderName: 'TgOp', text: 'tg' }),
    ] });
    await waitFor(() => incoming.length === 1);
    expect(incoming[0].from.authorized).toBe(true);
  });

  it('a telegram sender whose id is ONLY in whatsapp.allowed_users is NOT authorized (cross-surface namespace)', async () => {
    fake.chats.set(CHAT('chat-tg'), { title: 'TeleFam', type: 'single', isMuted: false, accountID: 'telegram' });
    const { incoming } = await startBridge({ isAllowedUser: perSurfaceAuth });
    fake.emit({ type: 'message.upserted', entries: [
      liveMsg({ chatID: CHAT('chat-tg'), isSender: false, senderID: 'wa-op@beeper.local', senderName: 'WaOp', text: 'tg-cross' }),
    ] });
    await waitFor(() => incoming.length === 1);
    expect(incoming[0].from.authorized).toBe(false);   // a wa id must not authorize on telegram
  });

  it('a whatsapp sender in whatsapp.allowed_users is authorized (unchanged behavior)', async () => {
    const { incoming } = await startBridge({ isAllowedUser: perSurfaceAuth });   // default chat = whatsapp
    fake.emit({ type: 'message.upserted', entries: [
      liveMsg({ isSender: false, senderID: 'wa-op@beeper.local', senderName: 'WaOp', text: 'wa' }),
    ] });
    await waitFor(() => incoming.length === 1);
    expect(incoming[0].from.authorized).toBe(true);
  });

  it('the reaction path threads the origin network too (a telegram reactor resolves on telegram)', async () => {
    fake.chats.set(CHAT('chat-tg'), { title: 'TeleFam', type: 'single', isMuted: false, accountID: 'telegram' });
    const { incoming } = await startBridge({ isAllowedUser: perSurfaceAuth, userName: 'Owner' });
    const tgt = `${Math.floor(Math.random() * 1e6)}`;
    // baseline: the target message's first sight (no reactions yet)
    fake.emit({ type: 'message.upserted', entries: [
      liveMsg({ id: tgt, chatID: CHAT('chat-tg'), isSender: false, senderID: 'x@beeper.local', senderName: 'X', text: 'hola' }),
    ] });
    await waitFor(() => incoming.some((i) => i.from.msgKey === tgt));
    const before = incoming.length;
    // tg-op reacts → authorized on telegram (in telegram.allowed_users); _reactorName
    // also gets the network, so an authorized owner reaction resolves to userName.
    fake.emit({ type: 'message.upserted', entries: [
      { id: tgt, chatID: CHAT('chat-tg'), type: 'TEXT', text: 'hola', senderName: 'X', timestamp: Date.now(),
        reactions: [{ participantID: 'tg-op@beeper.local', reactionKey: '👍' }] },
    ] });
    await waitFor(() => incoming.length > before);
    const react = incoming[incoming.length - 1];
    expect(react.from.isReaction).toBe(true);
    expect(react.from.authorized).toBe(true);      // network reached isAllowedUser on the reaction path
    expect(react.from.senderName).toBe('Owner');   // …and reached _reactorName (owner → configured name)
  });
});

// TRUSTED EGPT NETWORK (operator 2026-07-08) + the atE-handles fix (operator 2026-07-07).
// The bridge's persona gate must honor the CONFIGURED wake-word set (network defaults e/egpt
// PLUS the node's own handles), and it flags a peer node's OWN output (its reply stamp leads
// the text) so the host can transcript-log-but-never-dispatch it (sibling-output guard).
describe('beeper bridge — trusted network gate (wake words + peer-output)', () => {
  // DOLLY-shaped wake set: network-wide e/egpt + the persona agent's handles [ed, egptd].
  const DOLLY_WAKE = ['e', 'egpt', 'ed', 'egptd'];

  it('atE=true for a configured handle @ed (the DOLLY sleep-test bug) + atEPinned true', async () => {
    const { incoming } = await startBridge({ wakeWords: DOLLY_WAKE });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ isSender: false, senderName: 'Bea', text: '@ed estás?' })] });
    await waitFor(() => incoming.length === 1);
    expect(incoming[0].from.atEStart).toBe(true);       // pre-fix: false — never dispatched
    expect(incoming[0].from.atEAnywhere).toBe(true);
    expect(incoming[0].from.atEPinned).toBe(true);       // an OWN handle → a standby answers it immediately
  });

  it('regression: the network-wide @e still wakes, but is NOT pinned (it is the shared address)', async () => {
    const { incoming } = await startBridge({ wakeWords: DOLLY_WAKE });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ isSender: false, senderName: 'Bea', text: '@e estás?' })] });
    await waitFor(() => incoming.length === 1);
    expect(incoming[0].from.atEStart).toBe(true);
    expect(incoming[0].from.atEPinned).toBe(false);      // network address → held for takeover on a standby
  });

  it('a node with NO configured handles (default wake set) does NOT wake on @ed', async () => {
    const { incoming } = await startBridge();   // no wakeWords → default e/egpt
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ isSender: false, senderName: 'Bea', text: '@ed estás?' })] });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ isSender: false, senderName: 'Bea', text: 'sentinel' })] });
    await waitFor(() => incoming.some((i) => i.text === 'sentinel'));
    const m = incoming.find((i) => i.text === '@ed estás?');
    expect(m.from.atEAnywhere).toBe(false);              // unchanged for a node without handles
    expect(m.from.atEPinned).toBe(false);
  });

  it("a peer-stamped message is flagged peerOutput (reaches the host, which drops it); a plain one is not", async () => {
    const { incoming } = await startBridge({ personaEmoji: '🐶', peerStamps: ['🤝'] });   // kg node: own 🐶, peer 🤝
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ isSender: false, senderName: 'do', text: '🤝 egpt\nya respondí' })] });   // the peer node's own reply
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ isSender: false, senderName: 'Bea', text: 'hola normal' })] });
    await waitFor(() => incoming.some((i) => i.text === 'hola normal'));
    const peer = incoming.find((i) => i.text.startsWith('🤝'));
    expect(peer.from.peerOutput).toBe(true);             // the host transcript-logs but never dispatches it
    expect(incoming.find((i) => i.text === 'hola normal').from.peerOutput).toBe(false);
  });

  it("regression: the node's OWN persona echo (🐶) is STILL dropped outright, even with peer stamps configured", async () => {
    const { incoming } = await startBridge({ personaEmoji: '🐶', peerStamps: ['🤝'] });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ isSender: false, text: '🐶 egpt\nmy own reply' })] });   // our own echo
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ isSender: false, text: 'sentinel-own' })] });
    await waitFor(() => incoming.some((i) => i.text === 'sentinel-own'));
    expect(incoming.map((i) => i.text)).not.toContain('🐶 egpt\nmy own reply');   // dropped, never reaches the host
  });
});

// TRANSCRIPTION PRIMARY/STANDBY 👂 dedup (operator 2026-07-08: one 👂 per note — two
// nodes share a chat, both transcribe locally, but only ONE 👂 lands. The standby watches
// the chat coordination-free: the primary's 👂 arrives as an inbound reply to the note, so
// the standby holds its own 👂 an extra takeover margin then skips if the primary's showed).
describe('beeper bridge — transcription standby 👂 dedup', () => {
  beforeEach(() => _resetPostsBackDebounce());   // shared incoming-media debounce state
  const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));
  const svcPostsBack = async () => ({ enabled: true, postsBack: true });
  const voiceNote = (id) => liveMsg({ id, text: null, type: 'VOICE', attachments: [{ id: `att-${id}`, isVoiceNote: true, srcURL: 'file:///tmp/note.ogg' }] });
  const primaryEar = (noteId) => liveMsg({ isSender: false, senderName: 'do', text: '👂 An: fake transcript', linkedMessageID: noteId });
  const ears = () => fake.posts.filter((p) => String(p.text).startsWith('👂'));

  it('standby: the primary 👂 for the note lands before the margin → OUR 👂 is skipped', async () => {
    const { incoming } = await startBridge({ transcribeRole: 'standby', transcribeTakeoverMs: 300, resolveTranscriptionService: svcPostsBack });
    fake.emit({ type: 'message.upserted', entries: [voiceNote('note-1')] });
    await waitFor(() => incoming.some((i) => i.from.isTranscriptFromVoice));   // HEARD + 👂 queued (held for takeover)
    // the PRIMARY's 👂 arrives as an inbound reply to the SAME note, before the 300ms margin elapses
    fake.emit({ type: 'message.upserted', entries: [primaryEar('note-1')] });
    await waitMs(500);                                                          // past the takeover — held 👂 fires, sees the primary's, skips
    expect(ears()).toHaveLength(0);                                            // one 👂 in the chat (the primary's), NOT two
  });

  it('standby: NO primary 👂 → ours posts after the debounce + takeover margin (the standby covers a sleeping primary)', async () => {
    await startBridge({ transcribeRole: 'standby', transcribeTakeoverMs: 150, resolveTranscriptionService: svcPostsBack });
    fake.emit({ type: 'message.upserted', entries: [voiceNote('note-2')] });
    await waitFor(() => ears().length === 1);                                   // eventually posts — one 👂 either way, just later
  });

  it('standby: a primary 👂 for a DIFFERENT note does NOT suppress ours (correlation is chat + note id)', async () => {
    const { incoming } = await startBridge({ transcribeRole: 'standby', transcribeTakeoverMs: 200, resolveTranscriptionService: svcPostsBack });
    fake.emit({ type: 'message.upserted', entries: [voiceNote('note-3')] });
    await waitFor(() => incoming.some((i) => i.from.isTranscriptFromVoice));
    fake.emit({ type: 'message.upserted', entries: [primaryEar('note-999')] });  // ack for a DIFFERENT note id
    await waitFor(() => ears().length === 1);                                   // our note-3 ack still posts
    expect(ears()[0].replyToMessageID).toBe('note-3');
  });

  it('primary (default / absent transcribe_role): posts the 👂 as today, even with a peer 👂 already in the chat', async () => {
    await startBridge({ resolveTranscriptionService: svcPostsBack });           // no transcribeRole → primary
    fake.emit({ type: 'message.upserted', entries: [primaryEar('note-4')] });    // a peer 👂 already present — a primary ignores it
    fake.emit({ type: 'message.upserted', entries: [voiceNote('note-4')] });
    await waitFor(() => ears().length === 1);                                   // immediate (postsBackDelayMs 0), unchanged
  });

  it('transcribe_ack:false silences the 👂 regardless of role (standby)', async () => {
    const { incoming } = await startBridge({ transcribeRole: 'standby', transcribeTakeoverMs: 100, transcribeAck: false, resolveTranscriptionService: svcPostsBack });
    fake.emit({ type: 'message.upserted', entries: [voiceNote('note-5')] });
    await waitFor(() => incoming.some((i) => i.from.isTranscriptFromVoice));    // HEARD (transcribed + logged)
    await waitMs(300);                                                          // past the takeover — never queued, never posts
    expect(ears()).toHaveLength(0);
  });
});

// Conversation-E LIMBS (ROADMAP §3): the bridge SEND primitives + the inbound
// replyToBot signal. Reaction/reply-to/media hit the real Beeper endpoints; a reply
// to a message WE sent is flagged replyToBot so the gate fires without an @e.
describe('beeper bridge — E limbs + reply-to-E notification', () => {
  it('sendReaction POSTs { reactionKey } to /messages/:id/reactions', async () => {
    const { bridge } = await startBridge();
    const ok = await bridge.sendReaction(CHAT('chat-1'), '157204', '🔥');
    expect(ok).toBe(true);
    expect(fake.reactions).toHaveLength(1);
    expect(fake.reactions[0]).toMatchObject({ chatID: CHAT('chat-1'), messageID: '157204', reactionKey: '🔥' });
  });

  it('sendMedia uploads the file then posts an attachment referencing the uploadID', async () => {
    const { bridge } = await startBridge();
    const p = join(stateDir, 'pic.png');
    writeFileSync(p, 'fake-image-bytes');
    const ok = await bridge.sendMedia(CHAT('chat-1'), p, { caption: 'look' });
    expect(ok).toBe(true);
    expect(fake.uploads).toHaveLength(1);                  // /v1/assets/upload was hit
    const post = fake.posts[fake.posts.length - 1];
    expect(post.attachment).toMatchObject({ uploadID: 'up-1', type: 'image', mimeType: 'image/png' });
    expect(post.text).toBe('look');
  });

  it('wasSentByUs is true for a message this bridge sent, false otherwise', async () => {
    const { bridge } = await startBridge();
    await bridge.send('hi there', { chatId: CHAT('chat-1') });   // records pm-1 in _sentIds
    expect(bridge.wasSentByUs(CHAT('chat-1'), 'pm-1')).toBe(true);
    expect(bridge.wasSentByUs(CHAT('chat-1'), 'someone-elses-id')).toBe(false);
  });

  it('an inbound reply to a message WE sent → replyToBot true + ↩#id ref (operator: "reply to E isn\'t notified")', async () => {
    const { bridge, incoming } = await startBridge();
    await bridge.send('egpt here', { chatId: CHAT('chat-1') });   // our sent id = pm-1
    // someone replies to pm-1 (Beeper carries the quoted id as a bare linkedMessageID)
    fake.emit({ type: 'message.upserted', entries: [
      liveMsg({ isSender: false, senderName: 'Bea', text: 'gracias', linkedMessageID: 'pm-1' }),
    ] });
    await waitFor(() => incoming.some((i) => i.text === 'gracias'));
    const m = incoming.find((i) => i.text === 'gracias');
    expect(m.from.replyToBot).toBe(true);       // → the gate fires without any @e
    expect(m.from.replyToId).toBe('pm-1');      // → identity renders ↩#pm-1 in the dispatch line
  });

  it('an inbound reply to SOMEONE ELSE → replyToBot false, but the ↩#id ref still rides', async () => {
    const { bridge, incoming } = await startBridge();
    await bridge.send('egpt here', { chatId: CHAT('chat-1') });   // our id = pm-1
    fake.emit({ type: 'message.upserted', entries: [
      liveMsg({ isSender: false, senderName: 'Bea', text: 'ya te dije', linkedMessageID: 'other-99' }),
    ] });
    await waitFor(() => incoming.some((i) => i.text === 'ya te dije'));
    const m = incoming.find((i) => i.text === 'ya te dije');
    expect(m.from.replyToBot).toBe(false);      // not a reply to E → mention rules unchanged
    expect(m.from.replyToId).toBe('other-99');  // …but the model still sees which message is answered
  });

  it('a plain (non-reply) inbound carries no reply ref', async () => {
    const { incoming } = await startBridge();
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ isSender: false, senderName: 'Bea', text: 'hola' })] });
    await waitFor(() => incoming.some((i) => i.text === 'hola'));
    const m = incoming.find((i) => i.text === 'hola');
    expect(m.from.replyToBot).toBe(false);
    expect(m.from.replyToId).toBe(null);
  });
});

// resolveSentMessageId reduces its text matches with newerMsgId to pick the NEWEST
// (largest-id) match. Beeper ids are per-chat sequence numbers, so the pick must be
// NUMERIC — a string compare ranks "9" > "10" and resolves the OLDER message, so the
// stream placeholder edits the wrong line. This unit-tests the pure reducer directly.
describe('newerMsgId (resolveSentMessageId newest-match reducer)', () => {
  it('null incumbent yields the candidate', () => {
    expect(newerMsgId(null, '5')).toBe('5');
    expect(newerMsgId('5', null)).toBe('5');
  });
  it('numeric compare wins where string order disagrees (9 vs 10, 99 vs 100)', () => {
    expect(newerMsgId('9', '10')).toBe('10');    // string order would pick "9" — the older message
    expect(newerMsgId('10', '9')).toBe('10');
    expect(newerMsgId('99', '100')).toBe('100');
    expect(newerMsgId('100', '99')).toBe('100');
    // numeric ids too (Beeper delivers them as numbers), not only strings
    expect(newerMsgId(9, 10)).toBe(10);
  });
  it('ties keep the incumbent (strict-greater, matching the original comparator)', () => {
    expect(newerMsgId('7', '7')).toBe('7');
  });
  it('falls back to string order when an id is not a clean number', () => {
    expect(newerMsgId('a', 'b')).toBe('b');
    expect(newerMsgId('b', 'a')).toBe('b');
  });
});

// The STALE-TWIN LANDMINE (live 2026-07-04, SPOILER — the acceptance rerun on the
// guarded spine): once ONE '⏳ Thinking…' placeholder is left orphaned in a chat,
// every LATER same-text placeholder binds its edit stream to the STALE message:
// resolveSentMessageId's first poll races the new post's upsert, sees only the old
// identical-text twin (isSender, matching text), and returns it — first hit wins.
// Every partial + finish edit then PUTs the OLD message (succeeds! delivered=true,
// no fallback, no error anywhere), the reply lands invisibly in the scrollback, and
// the NEW placeholder sticks at '⏳ Thinking…' forever — becoming the NEXT turn's
// twin. Immediate turns died in a self-perpetuating chain while queued ones
// (distinct 'Queued (N ahead)' texts — no twin) always delivered. The spine was
// fully correct (all replies recorded in transcript.md); the loss was pure delivery.
// FIX: a pre-send id floor — ids are per-chat sequence numbers, so any match at or
// below the newest pre-send id is stale by construction (newestChatMsgId →
// resolveSentMessageId { afterId }). These tests choreograph the exact live race.
describe('stale-twin placeholder landmine — pre-send id floor', () => {
  // Deterministic race model: the list omits the just-posted message on the FIRST
  // poll served after the POST (the poll that, pre-fix, matched the stale twin and
  // returned it) and includes it from the second poll on — no wall-clock timing.
  function armStaleTwinChat(chat, { text, staleId = '100', newId = '200', extra = [] } = {}) {
    let postSeenPolls = 0;
    const base = [{ id: staleId, text, isSender: true }, ...extra];
    fake.messages.set(chat, () => {
      if (fake.posts.length >= 1) postSeenPolls += 1;
      return postSeenPolls >= 2 ? [...base, { id: newId, text, isSender: true }] : base;
    });
  }

  it('startStreamMessage binds to the JUST-POSTED placeholder, never a stale identical-text one, even when the first poll races the upsert', async () => {
    const chat = CHAT('chat-1');
    // The landmine: a previous turn's orphaned placeholder — same text, our own send.
    armStaleTwinChat(chat, { text: '⏳ Thinking…', extra: [{ id: '101', text: 'unrelated chatter', isSender: false }] });
    const { bridge } = await startBridge();

    const handle = bridge.startStreamMessage('⏳ Thinking…', { chatId: chat });
    handle.update('partial reply');
    await handle.finish('the reply');

    expect(handle.delivered).toBe(true);
    const targets = fake.edits.map((e) => e.messageID);
    expect(targets).toContain('200');        // the reply edited the REAL placeholder…
    expect(targets).not.toContain('100');    // …and NEVER the stale twin (pre-fix: every edit hit '100')
  });

  it('sendAndGetId refuses a stale identical-text match too (same pre-send floor)', async () => {
    const chat = CHAT('chat-1');
    armStaleTwinChat(chat, { text: 'status ping' });   // stale twin of the text we are about to send
    const { bridge } = await startBridge();

    expect(await bridge.sendAndGetId('status ping', { chatId: chat })).toBe('200');   // pre-fix: '100' (the stale twin)
  });
});
