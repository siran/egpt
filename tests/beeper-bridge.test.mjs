// Drives the real beeper bridge against a fake Beeper Desktop API (local
// HTTP + WS). Covers the hardening contract: room-service 👂 gating (posts_back),
// backlog gate, persisted dedup, fail-closed network scope, echo
// suppression.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startBeeperBridge, newerMsgId } from '../src/bridges/beeper.mjs';
import { EGPT_HOME } from '../src/egpt-home.mjs';
import { encodeMesh } from '../src/mesh/relay.mjs';
import { surfaceOf } from '../src/spine/identity.mjs';
import { _resetPromotions } from '../src/incoming-media.mjs';

async function startFakeBeeper() {
  const posts = [];   // POSTs to /v1/chats/:id/messages — each records the CONFIRMED id it created
  let confirmedSeq = 1000;   // the per-chat sequence Beeper assigns; NEVER equal to the pending id
  const edits = [];   // PUTs to /v1/chats/:id/messages/:msgId (in-place stream edits)
  const reactions = [];   // POSTs to /v1/chats/:id/messages/:msgId/reactions (E's react limb)
  const uploads = [];     // POSTs to /v1/assets/upload (E's media limb)
  const chats = new Map();   // chatID -> chat info served by GET
  const messages = new Map();   // chatID -> recent-message list served by GET /messages (resolveSentMessageId)
  const accounts = [];        // GET /v1/accounts fixture — tests push {accountID, user:{fullName}} before startBridge()
  let msgListGets = 0;        // GET /messages polls served — lets a test choreograph the upsert race
  let accountsGets = 0;       // GET /v1/accounts calls served — lets a test wait for the startup fetch
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
        // LIVE SHAPE (the whole point of this fake): the POST answers with ONLY a
        // pendingMessageID. Beeper then delivers that same message — over the WS AND
        // in the message list — under a DIFFERENT, CONFIRMED id. The two NEVER match,
        // so a bridge that remembers the PENDING id has no memory of what it sent.
        // The confirmed id is a numeric per-chat sequence, as verified live.
        const chatID = decodeURIComponent(post[1]);
        const parsed = JSON.parse(body);
        const confirmedID = `${(confirmedSeq += 10)}`;
        posts.push({ chatID, confirmedID, ...parsed });
        // …and the message becomes listable under that confirmed id (this is how the
        // bridge can learn it). A FUNCTION value means the test choreographs the list
        // itself (upsert-race models) — don't touch those.
        const cur = messages.get(chatID);
        if (typeof cur !== 'function') {
          const list = cur ?? [];
          list.push({ id: confirmedID, text: parsed.text ?? '', isSender: true });
          messages.set(chatID, list);
        }
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
        try {
          const v = messages.get(decodeURIComponent(msgList[1]));
          res.end(JSON.stringify({ items: (typeof v === 'function' ? v() : v) ?? [] }));
        } catch (e) {
          // a throwing message-list function models a GET failure → noteCovered fails-open
          res.statusCode = 500; res.end(JSON.stringify({ error: String(e?.message ?? e) }));
        }
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/chats') {
        res.end(JSON.stringify({ items: [...chats.entries()].map(([id, c]) => ({ id, ...c })) }));
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/accounts') {
        accountsGets += 1;
        res.end(JSON.stringify(accounts));
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
    port, posts, edits, reactions, uploads, chats, messages, accounts,
    msgListGets: () => msgListGets,
    accountsGets: () => accountsGets,
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

// A fake clock for the Phase 3b promotion timers — injected as the bridge's `scheduler` so a
// rank>1 node's (rank-1)*echoTimeoutMs promotion elapses WITHOUT a real wait. Timers fire in
// deadline order as time advances; advance() fires the callbacks but doesn't await their async
// sends, so tests use waitFor(posts) after advancing.
function makeClock() {
  let seq = 0, now = 0;
  const timers = [];   // { id, fn, at }
  return {
    set(fn, ms) { const id = ++seq; timers.push({ id, fn, at: now + ms }); return { id, unref() {} }; },
    clear(h) { const i = timers.findIndex((t) => h && t.id === h.id); if (i >= 0) timers.splice(i, 1); },
    async advance(ms) {
      now += ms;
      let t;
      while ((t = timers.filter((x) => x.at <= now).sort((a, b) => a.at - b.at)[0])) {
        timers.splice(timers.indexOf(t), 1);
        await t.fn();
      }
    },
  };
}

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
  _resetPromotions();   // clear module-global promotion timers between tests
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
    expect(edit.text).toBe('edited #' + id + '\n    - imbécil\n    + pobrecito');
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

  // OWN-MESSAGE SUPPRESSION is by wasSentByUs (the ids we sent), NOT a leading-emoji check
  // (that fallback was removed 2026-07-12 — no emoji may reach a decision). A reply E sent is dropped
  // when it echoes back EVEN when it does NOT lead with the persona emoji.
  it("suppresses E's own re-ingested reply by id — even one that does NOT lead with the persona emoji", async () => {
    const { bridge, incoming } = await startBridge();
    await bridge.send('🐶 egpt: roger', { chatId: CHAT('chat-1') });        // resolves + remembers its confirmed id
    await bridge.send('plain reply no emoji', { chatId: CHAT('chat-1') });  // a reply with NO leading persona emoji
    await waitFor(() => fake.posts.length === 2);
    // Both echo back under the ids BEEPER assigned them (that is the only id the WS
    // ever carries — the POST's pendingMessageID names nothing).
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ id: fake.posts[0].confirmedID, text: '🐶 egpt: roger' })] });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ id: fake.posts[1].confirmedID, text: 'plain reply no emoji' })] });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ text: 'sentinel-human' })] });
    await waitFor(() => incoming.some((i) => i.text === 'sentinel-human'));
    expect(incoming.map((i) => i.text)).not.toContain('🐶 egpt: roger');       // suppressed: we sent that id
    expect(incoming.map((i) => i.text)).not.toContain('plain reply no emoji');  // …and one without the emoji too
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

  // THE AUTHOR IS ALWAYS THE PUSH NAME (operator 2026-07-10): the OWNER's OWN sends are
  // attributed to the owner's push name, NEVER the node's configured userName. Live bug
  // (DOLLY, user_name "Don"/"AnDo"): An's OWN voice note echoed "👂 Don" — the node
  // userName mislabeled the owner as a person named Don (REVE, no such userName, showed
  // "An"). One rule for everyone: push name → number → stable id.
  it("the owner's OWN sends are attributed to the owner's push name, NOT the node userName", async () => {
    const { incoming } = await startBridge({ userName: 'Don' });   // node user_name that must NOT be the author
    fake.emit({ type: 'message.upserted', entries: [
      liveMsg({ isSender: true, senderPushName: 'An', senderName: '@anrodriguez:beeper.com', text: 'mío' }),
      liveMsg({ isSender: false, senderName: 'Bea (mi vecina)', senderPushName: 'Bea', text: 'suyo' }),
    ] });
    await waitFor(() => incoming.length === 2);
    expect(incoming[0].from.senderName).toBe('An');    // owner → OWN push name, NOT userName "Don"
    expect(incoming[0].from.isSender).toBe(true);
    expect(incoming[1].from.senderName).toBe('Bea');   // other → pushed name, not the saved label
  });

  // The owner with NO push name falls through the SAME non-private chain — the number
  // (from a WhatsApp jid), else a Matrix id's localpart — never the node userName (op 2026-07-10).
  it("the owner with no push name falls to the phone number, then the matrix localpart — never userName", async () => {
    const { incoming } = await startBridge({ userName: 'Don' });
    fake.emit({ type: 'message.upserted', entries: [
      liveMsg({ id: 'own-wa', isSender: true, senderID: '@whatsapp_16468217865:beeper.local', senderName: '@anrodriguez:beeper.com', text: 'wa' }),
      liveMsg({ id: 'own-mx', isSender: true, senderID: '@anrodriguez:beeper.com', senderName: '@anrodriguez:beeper.com', text: 'mx' }),
    ] });
    await waitFor(() => incoming.length === 2);
    const wa = incoming.find((i) => i.text === 'wa').from;
    const mx = incoming.find((i) => i.text === 'mx').from;
    expect(wa.senderName).toBe('+16468217865');   // owner, no push name, jid → number
    expect(mx.senderName).toBe('anrodriguez');    // owner, no push name, matrix id → localpart (decoration stripped)
    for (const v of [wa.senderName, mx.senderName]) expect(v).not.toBe('Don');   // never the node userName
  });

  // ACCOUNT SELF-USER NAME (operator 2026-07-13): the owner's OWN (isSender) message now
  // prefers the Beeper account self-user's fullName (GET /v1/accounts) over the matrix-id
  // localpart fallback — this is Beeper-sourced and identical on both co-account nodes, so
  // it doesn't reintroduce the old per-node userName mislabel (the prior test above).
  it("the owner's OWN send is attributed to the /v1/accounts self-user's fullName, not the matrix-id localpart", async () => {
    fake.accounts.push({ accountID: 'whatsapp', user: { fullName: 'An', isSelf: true } });
    const { incoming } = await startBridge();
    await waitFor(() => fake.accountsGets() >= 1);
    await new Promise((r) => setTimeout(r, 50));   // let the in-flight fetch's .then populate the map
    fake.emit({ type: 'message.upserted', entries: [
      liveMsg({ isSender: true, accountID: 'whatsapp', senderID: '@anrodriguez:beeper.com', senderName: '@anrodriguez:beeper.com', text: 'owner' }),
    ] });
    await waitFor(() => incoming.length === 1);
    expect(incoming[0].from.senderName).toBe('An');   // account self-user fullName, not 'anrodriguez'
  });

  // With no /v1/accounts fixture the map stays empty (fail-safe) — the owner falls back to
  // TODAY's unchanged chain (push name, then non-private id).
  it('with no /v1/accounts fixture, the owner falls back to the matrix-id localpart (unchanged)', async () => {
    const { incoming } = await startBridge();
    fake.emit({ type: 'message.upserted', entries: [
      liveMsg({ isSender: true, accountID: 'whatsapp', senderID: '@anrodriguez:beeper.com', senderName: '@anrodriguez:beeper.com', text: 'owner' }),
    ] });
    await waitFor(() => incoming.length === 1);
    expect(incoming[0].from.senderName).toBe('anrodriguez');
  });

  // MATRIX-ID DECORATION STRIP (operator 2026-07-10): with no push name, a bare Matrix
  // stable id reads as its localpart (a public handle), not the raw '@localpart:domain'
  // — An's own notes showed '@anrodriguez:beeper.com', wanted 'anrodriguez'. The WA-jid
  // number case still wins first; an id matching neither shape is unchanged.
  it('a matrix-shaped stable id resolves to its localpart; wa-jid → number; other id unchanged', async () => {
    const { incoming } = await startBridge();
    fake.emit({ type: 'message.upserted', entries: [
      liveMsg({ id: 'mx1', isSender: false, senderID: '@anrodriguez:beeper.com', senderName: 'saved label', text: 'a' }),
      liveMsg({ id: 'mx2', isSender: false, senderID: '@user:beeper.local', senderName: 'saved label', text: 'b' }),
      liveMsg({ id: 'wa1', isSender: false, senderID: '@whatsapp_16468217865:beeper.local', senderName: 'saved label', text: 'c' }),
      liveMsg({ id: 'raw1', isSender: false, senderID: 'zoot-42', senderName: 'saved label', text: 'd' }),
    ] });
    await waitFor(() => incoming.length === 4);
    const by = (t) => incoming.find((i) => i.text === t).from.senderName;
    expect(by('a')).toBe('anrodriguez');    // matrix id → localpart
    expect(by('b')).toBe('user');           // matrix id → localpart
    expect(by('c')).toBe('+16468217865');   // wa jid → number (the number case wins first)
    expect(by('d')).toBe('zoot-42');        // matches neither shape → raw id unchanged
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

  // A Matrix-shaped non-phone id → its localpart stands in (decoration stripped, still
  // non-private); the saved label is still never used (operator 2026-07-10).
  it('with no pushed name and a matrix-shaped id, the localpart stands in (never the label)', async () => {
    fake.chats.set(CHAT('chat-tg'), { title: 'Primo (deudor)', type: 'single', isMuted: false, accountID: 'telegram' });
    const { incoming } = await startBridge();
    fake.emit({ type: 'message.upserted', entries: [liveMsg({
      chatID: CHAT('chat-tg'), isSender: false,
      senderID: '@telegram_88164392:beeper.local',
      senderName: 'Primo (deudor)', text: 'hola',
    })] });
    await waitFor(() => incoming.length === 1);
    expect(incoming[0].from.senderName).toBe('telegram_88164392');   // matrix localpart, not the label
    expect(incoming[0].from.senderName).not.toContain('deudor');
  });

  // The 👂 voice echo carries the sender's pushed name (operator 2026-07-13): the same
  // senderDisplay(msg) value the MODEL envelope already gets — the person's OWN pushed
  // name, NEVER the saved contact label.
  it('the 👂 voice echo carries the pushed name as author; the model envelope carries the same (not the label)', async () => {
    const { incoming } = await startBridge({ resolveTranscriptionService: async () => ({ enabled: true, postsBack: true }) });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({
      isSender: false, type: 'VOICE', text: null,
      senderName: 'Ricki Mejia amigo diana real estate', senderPushName: 'Ricki Mejia',
      attachments: [{ id: 'a1', isVoiceNote: true, srcURL: 'file:///tmp/note.ogg' }],
    })] });
    await waitFor(() => incoming.length === 1);
    await waitFor(() => fake.posts.length === 1);
    expect(fake.posts[0].text).toBe('👂 Ricki Mejia: fake transcript');  // pushed name leads the echo
    expect(incoming[0].from.senderName).toBe('Ricki Mejia');            // …the model gets the same pushed name
    expect(incoming[0].from.senderName).not.toContain('amigo diana');   // never the saved label
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

  it('the 👂 voice echo for a LID sender carries the pushed name as author; the envelope keeps it too (not the raw LID)', async () => {
    const { incoming } = await startBridge({ resolveTranscriptionService: async () => ({ enabled: true, postsBack: true }) });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({
      isSender: false, type: 'VOICE', text: null,
      senderID: '@whatsapp_lid-85555832479795:beeper.local',
      senderName: 'le_moi',
      attachments: [{ id: 'a1', isVoiceNote: true, srcURL: 'file:///tmp/note.ogg' }],
    })] });
    await waitFor(() => incoming.length === 1);
    await waitFor(() => fake.posts.length === 1);
    expect(fake.posts[0].text).toBe('👂 le_moi: fake transcript');          // LID push name leads the echo
    expect(incoming[0].from.senderName).toBe('le_moi');                     // …envelope keeps the LID push name
    expect(incoming[0].from.senderName).not.toContain('whatsapp_lid');
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

  it("mode:auto echo: E's OWN plain reply (no persona marker) is suppressed by its sent id, but the operator's genuinely-typed line passes through", async () => {
    // In an auto chat E sends PLAIN operator text — no 🐶 body_emoji — so the
    // persona-marker guard cannot catch its echo; the sent-id set IS the suppression
    // key (refinement #4). The operator's OWN typed line is isSender too but was never
    // sent by us, so it is NOT suppressed and reaches the host to accumulate.
    const { bridge, incoming } = await startBridge();   // NO personaEmoji — auto sends carry none
    await bridge.send('all good, talk soon', { chatId: CHAT('chat-1') });
    await waitFor(() => fake.posts.length === 1);
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ id: fake.posts[0].confirmedID, isSender: true, text: 'all good, talk soon' })] });   // E's reply, echoed back under its real id
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ id: 'op-id', isSender: true, text: 'note for later' })] });                          // operator's OWN typed message
    await waitFor(() => incoming.some((i) => i.text === 'note for later'));
    expect(incoming.map((i) => i.text)).not.toContain('all good, talk soon');   // echo suppressed: we sent that id
    expect(incoming.find((i) => i.text === 'note for later').from.isSender).toBe(true);   // operator's own line passes through → spine accumulates it
  });

  it("a node's own MESH ENVELOPE echo IS suppressed like any other self-send (two-node topology: DOLLY sees it via normal cross-account delivery, not self-reingestion; reverts the 2026-07-05 self-relay exemption)", async () => {
    // With a real second node (DOLLY, a second Beeper account) on the other end of
    // the chain, each node sees the OTHER account's posts via normal cross-account
    // delivery and never needs to re-see its own. So a mesh envelope this node just
    // posted is an ordinary self-echo — the sent-id set suppresses it exactly like any
    // other message; there's no reason to special-case the provenance tail.
    const { bridge, incoming } = await startBridge();
    const envelope = '```\nQGRvbiBob2xh\n\n---\nfrom: Me\nto: don.do\nmid: chain-1\nenc: b64\n```';
    await bridge.send(envelope, { chatId: CHAT('chat-1') });
    await waitFor(() => fake.posts.length === 1);
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ id: fake.posts[0].confirmedID, text: envelope })] });   // our own post, echoed back under its real id
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ text: 'a real message' })] });
    await waitFor(() => incoming.some((i) => i.text === 'a real message'));
    expect(incoming.map((i) => i.text)).not.toContain(envelope);   // echo suppressed: we sent that id
  });

  // MULTIPATH MESH FUZZY-DROP (operator live test 2026-07-06): the word-bag fallback (built for
  // reformatted MENU echoes) was eating RELAY traffic. Two mesh envelopes in the SAME channel
  // within the 60s TTL share almost every token — identical base64 body, same
  // from/from_node/by/post_id/enc — differing only in `to:` and one `via:` entry. Live: REVE
  // posted the origin envelope (to: don.do, via: [carol.kg]); ~1s later the NEXT HOP's forward
  // arrived in the same chat (to: wren.kg, via: [carol.kg, don.do], same body/post_id) — a FOREIGN
  // message the node had to act on — and the word-bag matched it as our own echo, dropping it
  // BEFORE the "incoming" log line. The relay chain died silently. That stage needed a parseMesh
  // carve-out to stop eating relay traffic; with suppression keyed on the ids we sent, no carve-out
  // is needed — a foreign forward is simply an id we never sent. Both envelopes are built with
  // encodeMesh so the shape is honest.
  it('a FOREIGN mesh-envelope forward (same body/provenance, only to:/via: differ) is NOT dropped as our own echo — the relay chain survives', async () => {
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

  // REGRESSION LOCK (a): the node's OWN envelope echo is STILL suppressed — now because we
  // sent that id, which is also why the foreign forward above survives. One rule, both cases.
  it("a node's OWN mesh-envelope echo is STILL suppressed (73fc57a invariant) — by its sent id, the same rule that lets the foreign forward through", async () => {
    const { bridge, incoming } = await startBridge();
    const chat = CHAT('egpt-mesh-do-kg');
    const env = encodeMesh({ by: 'An', body: 'hola @don answer please a longer body here', from: 'HFM', from_node: 'kg', to: 'don.do', post_id: 'p-2', via: 'carol.kg' });
    await bridge.send(env, { chatId: chat });
    await waitFor(() => fake.posts.length === 1);
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ id: fake.posts[0].confirmedID, chatID: chat, text: env })] });   // our own post, echoed back
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ id: 'sentinel-own', chatID: chat, text: 'a real message' })] });
    await waitFor(() => incoming.some((i) => i.from.msgKey === 'sentinel-own'));
    expect(incoming.some((i) => i.from.msgKey === fake.posts[0].confirmedID)).toBe(false);   // suppressed: we sent that id
  });

  // REGRESSION LOCK (b): the 2026-06-25/28 wizard echo-loop guard. WhatsApp can hand our OWN
  // multi-line menu back REFORMATTED (one line, " - " bullets) — that is what defeated the exact
  // text compare and forced the word-bag fingerprints. It defeats NOTHING now: a reformat rewrites
  // the TEXT, never the ID, and the echo still arrives under the id Beeper gave our send. Identity
  // holds the flood guard that resemblance was hired for — and, unlike the bag, it cannot mistake a
  // human's paste for our own words.
  it('a reformatted echo of our own menu (one line, re-marked) is STILL suppressed — by its id, not by its words', async () => {
    const { bridge, incoming } = await startBridge();
    const chat = CHAT('chat-1');
    const menu = 'egpt · conversations (newest first)\n  0) ✦ @egpt — global default brain\n  1) Joyce Vicente · e:haiku/mention\n  2) SPOILER ALERT · e:sonnet/mention\n(reply a number · q quit)';
    const echo = 'egpt · conversations (newest first) 0) ✦ @egpt — global default brain - 1) Joyce Vicente · e:haiku/mention - 2) SPOILER ALERT · e:sonnet/mention - reply a number · q quit';   // reformatted one-line echo
    await bridge.send(menu, { chatId: chat });
    await waitFor(() => fake.posts.length === 1);
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ id: fake.posts[0].confirmedID, chatID: chat, text: echo })] });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ id: 'sentinel-menu', chatID: chat, text: 'a real human line' })] });
    await waitFor(() => incoming.some((i) => i.from.msgKey === 'sentinel-menu'));
    expect(incoming.some((i) => i.from.msgKey === fake.posts[0].confirmedID)).toBe(false);   // no echo-loop, no word-bag needed
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
  // text, not "[voice note]" — and the 👂 still posts on a default (echo:true) node. With the
  // arrival-lag/grace scaffold GONE, the 👂 posts immediately (coverage query finds no covering
  // reply); the note's age only gates DISPATCH (backlog), never the 👂.
  it('backlog voice note is transcribed + logged, and the 👂 posts (default echo)', async () => {
    const { incoming } = await startBridge({ resolveTranscriptionService: async () => ({ enabled: true, postsBack: true }) });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({
      text: null, type: 'VOICE', timestamp: Date.now() - 60_000,   // older than bridge start → backlog
      attachments: [{ id: 'a1', isVoiceNote: true, srcURL: 'file:///tmp/note.ogg' }],
    })] });
    await waitFor(() => incoming.length === 1);
    expect(incoming[0].from.backlog).toBe(true);                              // backfilled, never dispatched
    expect(incoming[0].text).toBe('(voice transcription) fake transcript');  // …but STILL transcribed locally
    await waitFor(() => fake.posts.length === 1);
    expect(fake.posts[0].text).toBe('👂 fake transcript');                   // default echo → 👂 posts (uncovered)
  });

  // 👂 ECHO PLAN (operator 2026-07-11, Phase 3b HRW ordered failover): the per-note gate is now
  // echoPlan(noteId) → { rank, winner } — rank 1 posts now, rank>1 HOLDS + arms a promotion, rank 0
  // is the echo:false hard opt-out. The rank/order itself is unit-tested in echo-hrw.test.mjs; here
  // we lock the BRIDGE behavior. A rank-1 winner posts; the echo:false opt-out (rank 0) never
  // posts/promotes; and both are still transcribed + logged (HEARD).
  it('the echo:false opt-out (rank 0) transcribes + logs but NEVER posts the 👂 (hard opt-out)', async () => {
    const { incoming } = await startBridge({
      echoPlan: () => ({ rank: 0, winner: false }),
      resolveTranscriptionService: async () => ({ enabled: true, postsBack: true }),
    });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({
      text: null, type: 'VOICE',
      attachments: [{ id: 'a1', isVoiceNote: true, srcURL: 'file:///tmp/note.ogg' }],
    })] });
    await waitFor(() => incoming.length === 1);
    expect(incoming[0].text).toBe('(voice transcription) fake transcript');   // HEARD (transcribed + logged)
    expect(fake.posts).toHaveLength(0);                                        // SPOKEN never — opt-out (no promotion either)
  });

  it('a rank-1 WINNER posts the 👂 (3a preserved for the all-up case)', async () => {
    const { incoming } = await startBridge({
      echoPlan: () => ({ rank: 1, winner: true }),
      resolveTranscriptionService: async () => ({ enabled: true, postsBack: true }),
    });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({
      text: null, type: 'VOICE',
      attachments: [{ id: 'a1', isVoiceNote: true, srcURL: 'file:///tmp/note.ogg' }],
    })] });
    await waitFor(() => incoming.length === 1);
    await waitFor(() => fake.posts.length === 1);
    expect(fake.posts[0].text).toBe('👂 fake transcript');
  });

  // The bridge feeds the note's SHARED Beeper message id (msg.id) to echoPlan — that shared identity
  // is what makes the two co-account nodes agree on the rank. Lock it: a rank keyed on the id posts
  // (rank 1) for exactly the note it names, and BOTH notes are still transcribed + logged.
  it('echoPlan is keyed on the note\'s Beeper message id — exactly the rank-1 note posts, both are transcribed', async () => {
    const { incoming } = await startBridge({
      echoPlan: (noteId) => ({ rank: noteId === 'note-win' ? 1 : 0, winner: noteId === 'note-win' }),
      resolveTranscriptionService: async () => ({ enabled: true, postsBack: true }),
    });
    const voice = (id) => liveMsg({
      id, text: null, type: 'VOICE',
      attachments: [{ id: `a-${id}`, isVoiceNote: true, srcURL: 'file:///tmp/note.ogg' }],
    });
    fake.emit({ type: 'message.upserted', entries: [voice('note-lose')] });
    fake.emit({ type: 'message.upserted', entries: [voice('note-win')] });
    await waitFor(() => incoming.length === 2);
    // Both HEARD (transcribed + logged) …
    expect(incoming.map((i) => i.text)).toEqual(['(voice transcription) fake transcript', '(voice transcription) fake transcript']);
    // … but only the rank-1 note got the in-chat 👂 (as a reply to ITSELF).
    await waitFor(() => fake.posts.length === 1);
    expect(fake.posts).toHaveLength(1);
    expect(fake.posts[0].replyToMessageID).toBe('note-win');
    expect(fake.posts[0].text).toBe('👂 fake transcript');
  });

  // ORDERED FAILOVER (Phase 3b) at the bridge, fake-clock driven:
  //   - rank-1 posts immediately (all-up) — see the WINNER test above;
  //   - a rank-2 node HOLDS, and PROMOTES after its window when rank-1 stays silent (rank-1 down);
  //   - a rank-2 node whose note gets COVERED (a matching peer 👂 lands in the chat) stands down when
  //     its timer fires and re-queries coverage — no double.
  it('rank-1 DOWN: a rank-2 node PROMOTES the held 👂 after its window (exactly one 👂, delayed)', async () => {
    const clock = makeClock();
    const { incoming } = await startBridge({
      echoPlan: () => ({ rank: 2, winner: false }),
      echoTimeoutMs: 20_000, scheduler: clock,
      resolveTranscriptionService: async () => ({ enabled: true, postsBack: true }),
    });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({
      id: 'note-p', isSender: false, text: null, type: 'VOICE',
      attachments: [{ id: 'a1', isVoiceNote: true, srcURL: 'file:///tmp/note.ogg' }],
    })] });
    await waitFor(() => incoming.length === 1);
    expect(incoming[0].text).toBe('(voice transcription) fake transcript');   // HEARD …
    expect(fake.posts).toHaveLength(0);                                        // … but held (rank-1 would post first)
    await clock.advance(20_000);                                              // rank-1 stayed silent → +T promote
    await waitFor(() => fake.posts.length === 1);
    expect(fake.posts[0].text).toBe('👂 fake transcript');
    expect(fake.posts[0].replyToMessageID).toBe('note-p');                     // same quoted reply as rank-1 would use
  });

  it('all-up: a rank-2 node stands down when a matching peer 👂 already covers the note (coverage re-checked at fire)', async () => {
    const clock = makeClock();
    const { incoming } = await startBridge({
      echoPlan: () => ({ rank: 2, winner: false }),
      echoTimeoutMs: 20_000, scheduler: clock,
      resolveTranscriptionService: async () => ({ enabled: true, postsBack: true }),
    });
    // the voice note → this (rank-2) node arms a promotion (held, no post; coverage empty at arm time)
    fake.emit({ type: 'message.upserted', entries: [liveMsg({
      id: 'note-o', isSender: false, text: null, type: 'VOICE',
      attachments: [{ id: 'a1', isVoiceNote: true, srcURL: 'file:///tmp/note.ogg' }],
    })] });
    await waitFor(() => incoming.some((i) => i.from.msgKey === 'note-o'));
    // rank-1 (the co-account peer) posted its 👂 as a quoted reply to the note — now present in the chat.
    fake.messages.set(CHAT('chat-1'), [{ id: 'peer-echo', text: '👂 fake transcript', linkedMessageID: 'note-o', isSender: false }]);
    await clock.advance(20_000);                                    // our promotion window elapses → re-queries coverage …
    await new Promise((r) => setTimeout(r, 30));                    // let the async fire settle
    expect(fake.posts).toHaveLength(0);                             // … covered → stood down → we NEVER posted (no double)
  });

  // PER-CONVERSATION 👂 delay (operator 2026-07-16): the bridge debounces with the PER-CHAT
  // postsBackDelayMs the resolver returns (conversations.yaml `posts_back_delay_ms`), NOT the
  // boot-global. Here the port default is 0 (immediate), but the resolver returns 20_000 → the
  // 👂 is HELD, proving the per-chat delay overrode the boot-global.
  it('the bridge debounces with the resolver’s PER-CHAT postsBackDelayMs (over the boot-global)', async () => {
    const clock = makeClock();
    const { incoming } = await startBridge({
      echoPlan: () => ({ rank: 1, winner: true }),
      scheduler: clock,
      postsBackDelayMs: 0,   // boot-global would post immediately …
      resolveTranscriptionService: async () => ({ enabled: true, postsBack: true, postsBackDelayMs: 20_000 }),
    });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({
      id: 'note-delay', isSender: false, text: null, type: 'VOICE',
      attachments: [{ id: 'a1', isVoiceNote: true, srcURL: 'file:///tmp/note.ogg' }],
    })] });
    await waitFor(() => incoming.length === 1);
    expect(incoming[0].text).toBe('(voice transcription) fake transcript');   // HEARD immediately …
    expect(fake.posts).toHaveLength(0);                                        // … but the 👂 is HELD (per-chat 20s, not the port's 0)
    await clock.advance(20_000);                                              // window elapses → the held echo posts
    await waitFor(() => fake.posts.length === 1);
    expect(fake.posts[0].text).toBe('👂 fake transcript');
  });

  // A conversation set to `posts_back_delay_ms: -1` resolves to postsBack:false → the note is
  // transcribed + logged (HEARD) but the 👂 NEVER posts (SPOKEN). A normal chat still posts.
  it('a -1 conversation is transcribed + logged but posts NO 👂; a normal chat still posts', async () => {
    const quiet = await startBridge({
      echoPlan: () => ({ rank: 1, winner: true }),
      resolveTranscriptionService: async () => ({ enabled: true, postsBack: false, postsBackDelayMs: 0 }),   // what -1 resolves to
    });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({
      text: null, type: 'VOICE',
      attachments: [{ id: 'a1', isVoiceNote: true, srcURL: 'file:///tmp/note.ogg' }],
    })] });
    await waitFor(() => quiet.incoming.length === 1);
    expect(quiet.incoming[0].text).toBe('(voice transcription) fake transcript');   // HEARD
    expect(fake.posts).toHaveLength(0);                                             // … but never SPOKEN

    const loud = await startBridge({
      echoPlan: () => ({ rank: 1, winner: true }),
      resolveTranscriptionService: async () => ({ enabled: true, postsBack: true, postsBackDelayMs: 0 }),   // normal chat
    });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({
      chatID: CHAT('chat-2'), text: null, type: 'VOICE',
      attachments: [{ id: 'a2', isVoiceNote: true, srcURL: 'file:///tmp/note.ogg' }],
    })] });
    await waitFor(() => loud.incoming.length === 1);
    await waitFor(() => fake.posts.length === 1);
    expect(fake.posts[0].text).toBe('👂 fake transcript');                          // normal chat still posts
  });

  // LAYERED 👂 ECHO (operator 2026-07-12): the '👂 <transcript>' core is wrapped concentrically by the
  // outer bridge_signature_open/close (which SPINE posted) and the inner transcription_open/close (the
  // 👂 feature's own frame) — top→bottom: bridge_open, transcription_open, 👂 core, transcription_close,
  // bridge_close, empties skipped. All slots default EMPTY → byte-identical to today (existing echo tests
  // pass no slots and assert the bare '👂 …' form).
  it('the 👂 echo renders CONCENTRIC when all four echo slots are set (bridge outer, transcription inner)', async () => {
    const { incoming } = await startBridge({
      bridgeSignatureOpen: 'BO', transcriptionOpen: 'TO', transcriptionClose: 'TC', bridgeSignatureClose: 'BC',
      resolveTranscriptionService: async () => ({ enabled: true, postsBack: true }),
    });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({
      text: null, type: 'VOICE',   // fresh (Date.now()) → rank-1 default posts immediately
      attachments: [{ id: 'a1', isVoiceNote: true, srcURL: 'file:///tmp/note.ogg' }],
    })] });
    await waitFor(() => incoming.length === 1);
    await waitFor(() => fake.posts.length === 1);
    expect(fake.posts[0].text).toBe('BO\nTO\n👂 fake transcript\nTC\nBC');   // concentric: opens top-down, closes bottom-up
  });

  // CLOSES-ONLY (opens empty) → the 👂 still LEADS. A pure render lock; with token-based coverage the
  // leading position no longer matters for dedup, but this pins the concentric render shape.
  it('closes-only echo slots keep the 👂 LEADING (render shape)', async () => {
    const { incoming } = await startBridge({
      transcriptionClose: 'TC', bridgeSignatureClose: '💸',   // opens empty
      resolveTranscriptionService: async () => ({ enabled: true, postsBack: true }),
    });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({
      text: null, type: 'VOICE',
      attachments: [{ id: 'a1', isVoiceNote: true, srcURL: 'file:///tmp/note.ogg' }],
    })] });
    await waitFor(() => incoming.length === 1);
    await waitFor(() => fake.posts.length === 1);
    expect(fake.posts[0].text).toBe('👂 fake transcript\nTC\n💸');   // 👂 leads, closes below (inner then outer)
    expect(fake.posts[0].text.startsWith('👂')).toBe(true);          // still the LEADING char
  });

  // POSITION-INDEPENDENT COVERAGE (operator 2026-07-12): a peer 👂 carrying a leading OPEN and/or trailing
  // CLOSE lines (or any wrap) still COVERS the note — the coverage query matches on normalized WORD TOKENS
  // (text-similarity), which drop the markers/wrap lines, so the overlap with our transcript stays ≥
  // threshold regardless of position. (This is why the old "opens must stay empty" observe-cancel
  // constraint is gone.)
  it('a rank-2 node stands down when the peer 👂 carries OPEN + CLOSE wrap (token overlap still covers)', async () => {
    const clock = makeClock();
    const { incoming } = await startBridge({
      echoPlan: () => ({ rank: 2, winner: false }),
      echoTimeoutMs: 20_000, scheduler: clock,
      resolveTranscriptionService: async () => ({ enabled: true, postsBack: true }),
    });
    // rank-2 → this node arms a promotion for the note (held, no post)
    fake.emit({ type: 'message.upserted', entries: [liveMsg({
      id: 'note-sig', isSender: false, text: null, type: 'VOICE',
      attachments: [{ id: 'a1', isVoiceNote: true, srcURL: 'file:///tmp/note.ogg' }],
    })] });
    await waitFor(() => incoming.some((i) => i.from.msgKey === 'note-sig'));
    // the peer's 👂 for the same note, WRAPPED — leading opens (BO/TO) + trailing closes (TC/💸) around the
    // transcript, so it does NOT lead with 👂. Token overlap ('fake transcript') still covers.
    fake.messages.set(CHAT('chat-1'), [{ id: 'peer-echo-sig', text: 'BO\nTO\n👂 fake transcript\nTC\n💸', linkedMessageID: 'note-sig', isSender: false }]);
    await clock.advance(20_000);                             // our promotion window elapses → re-queries coverage …
    await new Promise((r) => setTimeout(r, 30));             // let the async fire settle
    expect(fake.posts).toHaveLength(0);                      // … covered by token overlap despite the wrap → no double
  });

  // ALL-EMPTY regression lock: no echo slots → today's bare '👂 <transcript>' output, byte-for-byte.
  it('with ALL echo slots empty (default), the 👂 echo is byte-identical to today', async () => {
    const { incoming } = await startBridge({
      resolveTranscriptionService: async () => ({ enabled: true, postsBack: true }),
    });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({
      text: null, type: 'VOICE',
      attachments: [{ id: 'a1', isVoiceNote: true, srcURL: 'file:///tmp/note.ogg' }],
    })] });
    await waitFor(() => incoming.length === 1);
    await waitFor(() => fake.posts.length === 1);
    expect(fake.posts[0].text).toBe('👂 fake transcript');   // exactly today's form
  });

  // RENDER LOCK: a non-empty transcription_open is prepended ABOVE the 👂, so the echo no longer LEADS
  // with 👂. This USED to break the leading-marker observe-cancel — now DELETED — so with the token-based
  // coverage query a pre-👂 open is harmless (position-independent). Kept as a pure render lock.
  it('a non-empty transcription_open renders ABOVE the 👂 (token-based coverage makes a pre-👂 open safe)', async () => {
    const { incoming } = await startBridge({
      transcriptionOpen: 'TO',   // a pre-👂 open
      resolveTranscriptionService: async () => ({ enabled: true, postsBack: true }),
    });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({
      text: null, type: 'VOICE',
      attachments: [{ id: 'a1', isVoiceNote: true, srcURL: 'file:///tmp/note.ogg' }],
    })] });
    await waitFor(() => incoming.length === 1);
    await waitFor(() => fake.posts.length === 1);
    expect(fake.posts[0].text).toBe('TO\n👂 fake transcript');    // the open sits ABOVE the 👂
    expect(fake.posts[0].text.startsWith('👂')).toBe(false);      // 👂 no longer leads — coverage is token-based, so dedup is unaffected
  });

  it('a rank-2 node still PROMOTES when the chat has NO matching reply (prose reply to the note + a matching 👂 to a DIFFERENT note)', async () => {
    const clock = makeClock();
    const { incoming } = await startBridge({
      echoPlan: () => ({ rank: 2, winner: false }),
      echoTimeoutMs: 20_000, scheduler: clock,
      resolveTranscriptionService: async () => ({ enabled: true, postsBack: true }),
    });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({
      id: 'note-u', isSender: false, text: null, type: 'VOICE',
      attachments: [{ id: 'a1', isVoiceNote: true, srcURL: 'file:///tmp/note.ogg' }],
    })] });
    await waitFor(() => incoming.some((i) => i.from.msgKey === 'note-u'));
    // the chat holds a prose reply to THIS note (no token overlap with 'fake transcript') and a matching
    // 👂 replying to a DIFFERENT note — neither covers note-u.
    fake.messages.set(CHAT('chat-1'), [
      { id: 'human', text: 'gracias!', linkedMessageID: 'note-u', isSender: false },
      { id: 'other', text: '👂 fake transcript', linkedMessageID: 'some-other-note', isSender: false },
    ]);
    await clock.advance(20_000);
    await waitFor(() => fake.posts.length === 1);                   // uncovered → still promotes
    expect(fake.posts[0].replyToMessageID).toBe('note-u');
    expect(fake.posts[0].text).toBe('👂 fake transcript');
  });

  // The age bound is ORTHOGONAL to the rank: a too-old note never echoes even for a rank-1 winner.
  it('echoMaxAgeMs still suppresses an old note even for a rank-1 winner (age bound is independent of the rank)', async () => {
    const { incoming } = await startBridge({
      echoPlan: () => ({ rank: 1, winner: true }),   // this node IS rank-1 …
      echoMaxAgeMs: 3_600_000,
      resolveTranscriptionService: async () => ({ enabled: true, postsBack: true }),
    });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({
      text: null, type: 'VOICE', timestamp: Date.now() - 2 * 3_600_000,   // 2h old — past the bound
      attachments: [{ id: 'a1', isVoiceNote: true, srcURL: 'file:///tmp/note.ogg' }],
    })] });
    await waitFor(() => incoming.length === 1);
    expect(incoming[0].text).toBe('(voice transcription) fake transcript');   // still HEARD
    expect(fake.posts).toHaveLength(0);                                        // … but too old to SPEAK
  });

  // 👂 ACK AGE BOUND (operator 2026-07-08, Zohykar 1:1 incident): a Beeper resync re-delivered
  // 12-DAY-OLD voice notes; the backlog backfill correctly transcribed them for the record, but
  // the 👂 posted their transcriptions into the LIVE chat, stale and confusing ("ese era un
  // mensaje viejo"). The 👂 now only posts when the NOTE ITSELF is recent — transcription +
  // transcript-logging are unaffected. REPRODUCE: before this fix, the 👂 posted here too.
  const voiceNoteAt = (ageMs) => liveMsg({
    text: null, type: 'VOICE', timestamp: Date.now() - ageMs,
    attachments: [{ id: 'a1', isVoiceNote: true, srcURL: 'file:///tmp/note.ogg' }],
  });
  it('a 12-day-old voice note is transcribed + logged, but the 👂 is NOT posted (age bound)', async () => {
    const { incoming } = await startBridge({ resolveTranscriptionService: async () => ({ enabled: true, postsBack: true }) });
    fake.emit({ type: 'message.upserted', entries: [voiceNoteAt(12 * 24 * 60 * 60 * 1000)] });
    await waitFor(() => incoming.length === 1);
    expect(incoming[0].text).toBe('(voice transcription) fake transcript');   // HEARD (transcribed + logged)
    expect(fake.posts).toHaveLength(0);                                        // SPOKEN suppressed — too old
  });

  it('a 10-minute-old voice note still gets its 👂 (sleep-window courtesy, well within the default 1h bound)', async () => {
    // Within the age bound → echo allowed; with the arrival-lag/grace scaffold gone it posts immediately
    // (coverage query finds no covering reply). The note's age gates only the ECHO bound, not the timing.
    const { incoming } = await startBridge({ resolveTranscriptionService: async () => ({ enabled: true, postsBack: true }) });
    fake.emit({ type: 'message.upserted', entries: [voiceNoteAt(10 * 60 * 1000)] });
    await waitFor(() => incoming.length === 1);
    await waitFor(() => fake.posts.length === 1);
    expect(fake.posts[0].text).toBe('👂 fake transcript');
  });

  it('default bound (echoMaxAgeMs absent) is ~1h: a note just past it is not acked', async () => {
    const { incoming } = await startBridge({ resolveTranscriptionService: async () => ({ enabled: true, postsBack: true }) });
    fake.emit({ type: 'message.upserted', entries: [voiceNoteAt(61 * 60 * 1000)] });   // 61 min — just past the default 1h
    await waitFor(() => incoming.length === 1);
    expect(fake.posts).toHaveLength(0);
  });

  it('echoMaxAgeMs: 0 disables the bound — even a 12-day-old note still gets its 👂 (posts immediately)', async () => {
    // Bound disabled → echo allowed; with no arrival-lag/grace scaffold it posts immediately (uncovered).
    const { incoming } = await startBridge({
      echoMaxAgeMs: 0,
      resolveTranscriptionService: async () => ({ enabled: true, postsBack: true }),
    });
    fake.emit({ type: 'message.upserted', entries: [voiceNoteAt(12 * 24 * 60 * 60 * 1000)] });
    await waitFor(() => incoming.length === 1);
    await waitFor(() => fake.posts.length === 1);
    expect(fake.posts[0].text).toBe('👂 fake transcript');
  });

  it('a voice note with NO parseable timestamp still gets its 👂 (fail-open, matching the backlog gate)', async () => {
    const { incoming } = await startBridge({ resolveTranscriptionService: async () => ({ enabled: true, postsBack: true }) });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({
      text: null, type: 'VOICE', timestamp: undefined,
      attachments: [{ id: 'a1', isVoiceNote: true, srcURL: 'file:///tmp/note.ogg' }],
    })] });
    await waitFor(() => incoming.length === 1);
    await waitFor(() => fake.posts.length === 1);
    expect(fake.posts[0].text).toBe('👂 fake transcript');
  });

  // 👂 ON-DEMAND COVERAGE QUERY (operator 2026-07-12) — the ONE de-dup mechanism, replacing the deleted
  // observed-set + arrival-lag/grace/reconnect scaffold. Before posting a note's 👂, noteCovered lists the
  // recent messages and stands down if a reply to THIS note already carries a matching transcript. It reads
  // the CHAT directly, so coverage is seen in ANY delivery order (a steady-state peer echo, a reconnect
  // replay whose covering reply is already in the list) with NO marker in the decision and NO shadow store.
  it('STEADY STATE: rank-1 stands down when a matching peer 👂 already covers the note (no post)', async () => {
    const { incoming } = await startBridge({
      echoPlan: () => ({ rank: 1, winner: true }),
      resolveTranscriptionService: async () => ({ enabled: true, postsBack: true }),
    });
    // the peer's matching 👂 (a reply to this note) is ALREADY in the chat when the note is processed.
    fake.messages.set(CHAT('chat-1'), [{ id: 'peer-echo', text: '👂 fake transcript', linkedMessageID: 'note-cov', isSender: false }]);
    fake.emit({ type: 'message.upserted', entries: [liveMsg({
      id: 'note-cov', text: null, type: 'VOICE',
      attachments: [{ id: 'a1', isVoiceNote: true, srcURL: 'file:///tmp/note.ogg' }],
    })] });
    await waitFor(() => incoming.some((i) => i.from.msgKey === 'note-cov'));
    expect(incoming.find((i) => i.from.msgKey === 'note-cov').text).toBe('(voice transcription) fake transcript');   // HEARD
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.posts).toHaveLength(0);                          // covered → this node does NOT echo
  });

  // POSITION- + HTML-INDEPENDENCE: the covering reply is HTML-wrapped and does NOT lead with 👂 (a leading
  // open + a linkified domain token). htmlToMarkdown + normalizeTokens still recover 'fake'/'transcript', so
  // token overlap covers it — proving the query never depends on a leading marker (the old early-observe
  // hook keyed on raw-starts-with-👂; this replaces it, correctly).
  it('recognizes an HTML-wrapped, non-leading covering reply (htmlToMarkdown + token overlap)', async () => {
    const { incoming } = await startBridge({
      echoPlan: () => ({ rank: 1, winner: true }),
      resolveTranscriptionService: async () => ({ enabled: true, postsBack: true }),
    });
    fake.messages.set(CHAT('chat-1'), [{ id: 'peer', text: '<p>TO 👂 fake transcript see <a href="http://don.do">don.do</a></p>', linkedMessageID: 'note-h', isSender: false }]);
    fake.emit({ type: 'message.upserted', entries: [liveMsg({
      id: 'note-h', text: null, type: 'VOICE',
      attachments: [{ id: 'a1', isVoiceNote: true, srcURL: 'file:///tmp/note.ogg' }],
    })] });
    await waitFor(() => incoming.some((i) => i.from.msgKey === 'note-h'));
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.posts).toHaveLength(0);                          // covered despite the HTML wrap + non-leading 👂
  });

  it('rank-1 POSTS when the only replies are non-matching or to a DIFFERENT note (not covered)', async () => {
    const { incoming } = await startBridge({
      echoPlan: () => ({ rank: 1, winner: true }),
      resolveTranscriptionService: async () => ({ enabled: true, postsBack: true }),
    });
    fake.messages.set(CHAT('chat-1'), [
      { id: 'prose', text: 'gracias!', linkedMessageID: 'note-x', isSender: false },              // reply to THIS note, no overlap
      { id: 'elsewhere', text: '👂 fake transcript', linkedMessageID: 'another-note', isSender: false },   // matches but wrong note
    ]);
    fake.emit({ type: 'message.upserted', entries: [liveMsg({
      id: 'note-x', text: null, type: 'VOICE',
      attachments: [{ id: 'a1', isVoiceNote: true, srcURL: 'file:///tmp/note.ogg' }],
    })] });
    await waitFor(() => incoming.some((i) => i.from.msgKey === 'note-x'));
    await waitFor(() => fake.posts.length === 1);                // uncovered → posts
    expect(fake.posts[0].text).toBe('👂 fake transcript');
  });

  it('FAIL-OPEN: the coverage GET failing is treated as NOT covered → the 👂 still posts', async () => {
    const { incoming } = await startBridge({
      echoPlan: () => ({ rank: 1, winner: true }),
      resolveTranscriptionService: async () => ({ enabled: true, postsBack: true }),
    });
    fake.messages.set(CHAT('chat-1'), () => { throw new Error('boom'); });   // the coverage GET 500s
    fake.emit({ type: 'message.upserted', entries: [liveMsg({
      id: 'note-fo', text: null, type: 'VOICE',
      attachments: [{ id: 'a1', isVoiceNote: true, srcURL: 'file:///tmp/note.ogg' }],
    })] });
    await waitFor(() => incoming.some((i) => i.from.msgKey === 'note-fo'));
    await waitFor(() => fake.posts.length === 1);                // GET failed → fail-open → posts (a rare double beats a missed echo)
    expect(fake.posts[0].text).toBe('👂 fake transcript');
  });

  // RECONNECT-STYLE (replaces the deleted arrival-lag/grace path): on reconnect Beeper re-delivers BOTH the
  // note and the survivor's 👂; the coverage query sees the covering reply directly — no lag detection, no
  // grace window, no WS-open event. The note is old (a replay) but that only gates DISPATCH, not the echo.
  it('RECONNECT-STYLE: a replayed note whose covering reply is already in the fetched list stands down', async () => {
    const { incoming } = await startBridge({
      echoPlan: () => ({ rank: 1, winner: true }),
      resolveTranscriptionService: async () => ({ enabled: true, postsBack: true }),
    });
    fake.messages.set(CHAT('chat-1'), [{ id: 'survivor-echo', text: '👂 fake transcript', linkedMessageID: 'note-rc', isSender: false }]);
    fake.emit({ type: 'message.upserted', entries: [liveMsg({
      id: 'note-rc', text: null, type: 'VOICE', timestamp: Date.now() - 60_000,   // an old replay — irrelevant to coverage
      attachments: [{ id: 'a1', isVoiceNote: true, srcURL: 'file:///tmp/note.ogg' }],
    })] });
    await waitFor(() => incoming.some((i) => i.from.msgKey === 'note-rc'));
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.posts).toHaveLength(0);                          // covered by the replayed 👂 already in the list → no double
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
    expect(fake.posts[0].text).toBe('👂 fake transcript');   // author-less echo (attribution via the quote)
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
// The bridge's persona gate honors the node's OWN configured wake-word set (operator 2026-07-09:
// SYMMETRIC nodes wake on their own handles, NOTHING is injected network-wide). boot derives the
// set from the persona agent's name + handles; the bridge just applies it.
describe('beeper bridge — wake words (own handles only, no injection)', () => {
  // A DOLLY-shaped node: persona handles [ed, egptd] ONLY — no network-wide e/egpt injected.
  const DOLLY_WAKE = ['ed', 'egptd'];

  it('@ed wakes a node whose handles include ed (the DOLLY sleep-test bug)', async () => {
    const { incoming } = await startBridge({ wakeWords: DOLLY_WAKE });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ isSender: false, senderName: 'Bea', text: '@ed estás?' })] });
    await waitFor(() => incoming.length === 1);
    expect(incoming[0].from.atEStart).toBe(true);
    expect(incoming[0].from.atEAnywhere).toBe(true);
  });

  it('the network-wide @e does NOT wake a node whose handles are [ed, egptd] (no injection)', async () => {
    const { incoming } = await startBridge({ wakeWords: DOLLY_WAKE });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ isSender: false, senderName: 'Bea', text: '@e estás?' })] });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ isSender: false, senderName: 'Bea', text: 'sentinel' })] });
    await waitFor(() => incoming.some((m) => m.text === 'sentinel'));
    const m = incoming.find((x) => x.text === '@e estás?');
    expect(m.from.atEAnywhere).toBe(false);   // pre-2026-07-09: true, via the removed network-wide injection
  });

  it('a node with handles [e, egpt] still wakes on @e (default wake set)', async () => {
    const { incoming } = await startBridge();   // default wakeWords e/egpt
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ isSender: false, senderName: 'Bea', text: '@e estás?' })] });
    await waitFor(() => incoming.length === 1);
    expect(incoming[0].from.atEAnywhere).toBe(true);
  });

  it("the node's OWN persona reply (multi-line 🐶 header) is dropped when it echoes back (its sent id)", async () => {
    const { bridge, incoming } = await startBridge();
    await bridge.send('🐶 egpt\nmy own reply', { chatId: CHAT('chat-1') });
    await waitFor(() => fake.posts.length === 1);
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ id: fake.posts[0].confirmedID, text: '🐶 egpt\nmy own reply' })] });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ isSender: false, text: 'sentinel-own' })] });
    await waitFor(() => incoming.some((m) => m.text === 'sentinel-own'));
    expect(incoming.map((m) => m.text)).not.toContain('🐶 egpt\nmy own reply');   // dropped: we sent that id
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

  // The POST's pendingMessageID is NOT an id anything else in the system ever uses:
  // Beeper delivers the message — over the WS, in the list, and as a reply's quoted
  // id — under a DIFFERENT CONFIRMED id. So ownership must be keyed on the CONFIRMED
  // id. (Both this test and the replyToBot one below asserted the exact opposite —
  // that 'pm-1' was ours and was quotable — which is the pending≠final conflation the
  // bridge's own comments say does NOT hold live: it made every plain send unknown to
  // wasSentByUs, so replying to E's reply never woke it.)
  it('wasSentByUs is true for the CONFIRMED id of a message this bridge sent — never the POST pendingMessageID', async () => {
    const { bridge } = await startBridge();
    await bridge.send('hi there', { chatId: CHAT('chat-1') });
    await waitFor(() => bridge.wasSentByUs(CHAT('chat-1'), fake.posts[0].confirmedID), 4000);
    expect(bridge.wasSentByUs(CHAT('chat-1'), 'pm-1')).toBe(false);   // the pending id names no real message
    expect(bridge.wasSentByUs(CHAT('chat-1'), 'someone-elses-id')).toBe(false);
  });

  it('an inbound reply to a message WE sent → replyToBot true + ↩#id ref (operator: "reply to E isn\'t notified")', async () => {
    const { bridge, incoming } = await startBridge();
    await bridge.send('egpt here', { chatId: CHAT('chat-1') });
    const confirmed = fake.posts[0].confirmedID;   // the id Beeper gave our send — the only id a reply can quote
    await waitFor(() => bridge.wasSentByUs(CHAT('chat-1'), confirmed), 4000);
    // someone replies to it (Beeper carries the quoted id as a bare linkedMessageID)
    fake.emit({ type: 'message.upserted', entries: [
      liveMsg({ isSender: false, senderName: 'Bea', text: 'gracias', linkedMessageID: confirmed }),
    ] });
    await waitFor(() => incoming.some((i) => i.text === 'gracias'));
    const m = incoming.find((i) => i.text === 'gracias');
    expect(m.from.replyToBot).toBe(true);        // → the gate fires without any @e
    expect(m.from.replyToId).toBe(confirmed);    // → identity renders ↩#<id> in the dispatch line
  });

  it('an inbound reply to SOMEONE ELSE → replyToBot false, but the ↩#id ref still rides', async () => {
    const { bridge, incoming } = await startBridge();
    await bridge.send('egpt here', { chatId: CHAT('chat-1') });
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

// OWN-SEND SUPPRESSION IS BY IDENTITY, NEVER BY RESEMBLANCE.
// The bridge shares ONE Beeper account with the operator, so Beeper hands our OWN
// sends back over the WS with isSender:true — and the operator's own messages, and a
// PEER node's sends on that same account, arrive looking exactly the same. isSender
// therefore cannot separate "we sent this" from "a human sent this"; only remembering
// the ids WE sent can. Since the POST returns a pendingMessageID and the WS delivers a
// DIFFERENT confirmed id, that memory only works if the bridge RESOLVES the confirmed
// id — which is the whole fix. Exactly ONE class of inbound may ever be suppressed.
describe('beeper bridge — own-send suppression is id-exact (shared account)', () => {
  const chat = CHAT('chat-1');

  it("our OWN send, echoed back under its CONFIRMED id (≠ the pendingMessageID), never re-enters dispatch", async () => {
    const { bridge, incoming } = await startBridge();
    await bridge.send('egpt says hi', { chatId: chat });
    await waitFor(() => fake.posts.length === 1);
    const confirmed = fake.posts[0].confirmedID;
    await waitFor(() => bridge.wasSentByUs(chat, confirmed), 4000);
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ id: confirmed, chatID: chat, text: 'egpt says hi' })] });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ id: 'sentinel-echo', chatID: chat, isSender: false, text: 'a real message' })] });
    await waitFor(() => incoming.some((i) => i.from.msgKey === 'sentinel-echo'));
    expect(incoming.map((i) => i.text)).not.toContain('egpt says hi');   // no self-loop
  });

  it("a human PASTING the bot's own text back (same words, DIFFERENT id) DISPATCHES — resemblance must never suppress", async () => {
    const { bridge, incoming } = await startBridge();
    // Long enough to trip BOTH removed resemblance stages: the exact sent-text window
    // and the >=8-word bag fingerprint. Only the id may decide.
    const line = 'egpt · conversations (newest first) — reply with a number or q to quit';
    await bridge.send(line, { chatId: chat });
    await waitFor(() => bridge.wasSentByUs(chat, fake.posts[0].confirmedID), 4000);
    // The operator pastes our own line back, seconds later, from the SAME account:
    // isSender:true, byte-identical text — but an id we never sent.
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ id: 'human-paste', chatID: chat, text: line })] });
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ id: 'sentinel-paste', chatID: chat, isSender: false, text: 'a real message' })] });
    await waitFor(() => incoming.some((i) => i.from.msgKey === 'sentinel-paste'));
    expect(incoming.some((i) => i.from.msgKey === 'human-paste')).toBe(true);   // pre-fix: silently swallowed by the 60s text window
  });

  it("the operator's OWN human message (isSender, an id we never sent) DISPATCHES", async () => {
    const { bridge, incoming } = await startBridge();
    await bridge.send('egpt says hi', { chatId: chat });
    await waitFor(() => bridge.wasSentByUs(chat, fake.posts[0].confirmedID), 4000);
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ id: 'op-typed', chatID: chat, text: 'note for later' })] });
    await waitFor(() => incoming.some((i) => i.from.msgKey === 'op-typed'));
    expect(incoming.find((i) => i.from.msgKey === 'op-typed').from.isSender).toBe(true);   // same account, still surfaced
  });

  it("a PEER node's send on the shared account (isSender, an id we never sent) DISPATCHES — this is how @e reaches @don", async () => {
    const { incoming } = await startBridge();
    fake.emit({ type: 'message.upserted', entries: [liveMsg({ id: 'peer-send', chatID: chat, text: '@don please take this one' })] });
    await waitFor(() => incoming.some((i) => i.from.msgKey === 'peer-send'));
    expect(incoming.find((i) => i.from.msgKey === 'peer-send').from.isSender).toBe(true);
  });

  // THE SAFETY GATE, stated honestly. Identity is bootstrapped by re-finding our own
  // message in the chat's list (resolveSentMessageId). That lookup CAN miss — and a
  // send whose id we never learned is a send we cannot recognize: its echo will
  // dispatch. We do NOT paper over that with a text guess; the guess is the bug being
  // removed here, and it silently ate the operator's own messages. We fail LOUD
  // instead, so a miss is visible in the log rather than hidden behind a heuristic.
  // If this line ever appears live, fix the RESOLVER's matching — not by reintroducing
  // resemblance.
  it('a send whose confirmed id cannot be resolved is logged LOUD (never silently text-suppressed)', async () => {
    const logs = [];
    const { bridge } = await startBridge({ onLog: (m) => logs.push(m) });
    const gone = CHAT('chat-unlistable');
    fake.messages.set(gone, () => []);   // our POST never becomes findable → the resolver exhausts its polls
    await bridge.send('a reply that never appears in the list', { chatId: gone });
    await waitFor(() => logs.some((l) => l.includes('SEND ID UNCONFIRMED')), 8000);
  }, 12000);
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

  // SENT-ID LOG INTEGRITY: a streamed reply edits its placeholder dozens of times a
  // turn, and every edit re-remembered the same id — appending another 's' line to
  // beeper-seen.jsonl each time. Reload only reads the LAST 3500 lines, so a busy run
  // could pack that window with a handful of ids repeated hundreds of times and
  // rehydrate _sentIds with a couple dozen distinct ids instead of SEEN_SENT_CAP — a
  // silent decay of the id memory (self-echo suppression AND replyToBot) across
  // restarts, and the id memory is now the ONLY own-message signal. One line per id.
  it('a streamed reply logs its sent id ONCE, not once per edit (seen-log integrity)', async () => {
    const chat = CHAT('chat-1');
    armStaleTwinChat(chat, { text: '⏳ Thinking…' });
    const { bridge } = await startBridge();
    const handle = bridge.startStreamMessage('⏳ Thinking…', { chatId: chat });
    for (const t of ['partial one', 'partial one two']) {
      handle.update(t);
      await new Promise((r) => setTimeout(r, 450));   // clear the EDIT_MIN_MS debounce so each lands as a real edit
    }
    await handle.finish('the reply');
    expect(fake.edits.length).toBeGreaterThanOrEqual(2);   // several real edits landed…
    const sent = readFileSync(join(stateDir, 'beeper-seen.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((o) => o.k === 's');
    expect(sent).toHaveLength(1);              // …but the id was recorded once (pre-fix: one line per edit)
    expect(sent[0].id).toBe('chat-1|200');     // the chat-qualified confirmed id
  });

  it('sendAndGetId refuses a stale identical-text match too (same pre-send floor)', async () => {
    const chat = CHAT('chat-1');
    armStaleTwinChat(chat, { text: 'status ping' });   // stale twin of the text we are about to send
    const { bridge } = await startBridge();

    expect(await bridge.sendAndGetId('status ping', { chatId: chat })).toBe('200');   // pre-fix: '100' (the stale twin)
  });
});
