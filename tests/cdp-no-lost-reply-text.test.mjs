// No text is lost on a tab member's reply (operator 2026-09-25: "forget images, let's make it
// text-only. this is a working tool. just make sure no text is lost on replies.").
//
// Three ways a reply lost text, each reproduced here against the REAL code:
//   1. CUT MID-ANSWER. streamFromTab ended a capture on text that had stopped changing - 5s of it
//      even while the stop button showed, ~1s when the stop selectors missed the page - and on its
//      180s timeout with whatever text it had. ChatGPT pauses mid-answer (web search, code) with
//      half a reply written, so the room got the half. Now a reply that reports its own finished
//      marker (the turn's Copy action, chatgpt-cdp `copyShown`) ends on that marker.
//   2. OVERLAP. Every room message starts its own fanOut, so a second message was typed into the
//      tab while the first reply was still being written. Now one capture per tab at a time.
//   3. PRESSING STOP. During generation the composer's submit control is ChatGPT's Stop, and the
//      inject script's send finder tried '#composer-submit-button' first. Now it never presses a
//      stop control, and a tab still answering reports the send as not made.
//
// The page has no DOM: each Runtime.evaluate runs in `vm` against a small fake `document` (the
// style of tests/cdp-reply-by-id-verbatim.test.mjs). The relay cases use createRoomRelay with a
// fake capture; the send-button cases run the real injectScript in `vm` with timers stepped by hand.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer } from 'node:http';
import vm from 'node:vm';
import { WebSocketServer } from 'ws';
import { setCdpHostGetter, streamFromTab } from '../src/tools/cdp.mjs';
import { createRoomRelay } from '../src/spine/room-relay.mjs';
import * as chatgpt from '../config/brains/chatgpt-cdp.mjs';

const TAB = 'no-lost-text-tab-1';
const OLD = 'Of course. Where do you want to pick it up?';
const HALF = 'There is real merit in it. Let me check the literature first';
const FULL = 'There is real merit in it. Let me check the literature first. Three results bear on it: one, two and three.';

let page;
const freshPage = () => ({ stop: false, messages: [{ id: 'old-0', body: OLD, finished: true }], timers: [] });

function fakeDocument(p) {
  const turnOf = (m) => ({ querySelector: (sel) => (/copy-turn-action-button/.test(sel) && m.finished ? { click() {} } : null) });
  const elementOf = (m) => ({
    getAttribute: (a) => (a === 'data-message-id' ? m.id : null),
    get innerText() { return m.body ?? ''; },
    querySelector: (sel) => (/markdown|prose/.test(sel) && m.body != null ? { innerText: m.body } : null),
    closest: () => turnOf(m),
  });
  return {
    querySelector: (sel) => (/stop/i.test(sel) && p.stop ? {} : null),
    querySelectorAll: (sel) => (/assistant/.test(sel) ? p.messages.map(elementOf) : []),
  };
}

function play(steps) { for (const [at, fn] of steps) page.timers.push(setTimeout(() => fn(page), at)); }
let timeline = [];

let server, wss, port;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/json' || req.url === '/json/list') {
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([
        { id: TAB, type: 'page', url: 'https://chatgpt.com/c/test', title: 'test', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${TAB}` },
      ]));
    }
    res.writeHead(404).end();
  });
  wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (raw) => {
        const cmd = JSON.parse(raw.toString());
        const expr = cmd.params?.expression ?? '';
        let value;
        if (expr.includes('#prompt-textarea')) { value = true; play(timeline); }
        else value = vm.runInNewContext(expr, { document: fakeDocument(page) });
        ws.send(JSON.stringify({ id: cmd.id, result: { result: { value } } }));
      });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  setCdpHostGetter(() => `127.0.0.1:${port}`);
});
afterAll(async () => {
  setCdpHostGetter(() => process.env.EGPT_CDP_HOST || 'localhost:9221');
  for (const c of wss.clients) c.terminate();
  await new Promise((r) => server.close(r));
});
afterEach(() => { for (const t of page?.timers ?? []) clearTimeout(t); });

const capture = (opts = {}) => streamFromTab({
  targetId: TAB, injectScript: chatgpt.injectScript('hi'), pollScript: chatgpt.pollScript, onUpdate: () => {}, ...opts,
});
const reply = () => page.messages[page.messages.length - 1];

describe('1. a reply is not cut mid-answer', () => {
  it('REPRODUCE: half written, a long pause with the stop button showing, then the rest - the whole reply comes back', async () => {
    page = freshPage();
    timeline = [
      [0, (p) => { p.stop = true; p.messages.push({ id: 'new-1', body: HALF, finished: false }); }],
      // a pause past the old safety net (5s unchanged once polling has run 10s)
      [11000, () => { reply().body = FULL; }],
      [11300, (p) => { p.stop = false; reply().finished = true; }],
    ];
    await expect(capture()).resolves.toBe(FULL);
  }, 25000);

  it('REPRODUCE: the same pause when the stop-button selectors miss the page - still the whole reply', async () => {
    page = freshPage();
    timeline = [
      [0, (p) => { p.messages.push({ id: 'new-1', body: HALF, finished: false }); }],
      [3000, () => { reply().body = FULL; }],
      [3300, () => { reply().finished = true; }],
    ];
    await expect(capture()).resolves.toBe(FULL);
  }, 15000);

  it('REPRODUCE: a reply still writing at the timeout is waited for, not cut with what it has', async () => {
    page = freshPage();
    timeline = [
      [0, (p) => { p.stop = true; p.messages.push({ id: 'new-1', body: HALF, finished: false }); }],
      [2000, () => { reply().body = FULL; }],
      [2300, (p) => { p.stop = false; reply().finished = true; }],
    ];
    await expect(capture({ timeoutMs: 1000 })).resolves.toBe(FULL);
  }, 15000);

  it('a finished reply ends on its marker in about a second, not on a fallback window', async () => {
    page = freshPage();
    timeline = [
      [0, (p) => { p.stop = true; p.messages.push({ id: 'new-1', body: FULL, finished: false }); }],
      [300, (p) => { p.stop = false; reply().finished = true; }],
    ];
    const t0 = Date.now();
    await expect(capture()).resolves.toBe(FULL);
    expect(Date.now() - t0).toBeLessThan(4000);
  }, 15000);

  it('a page that never shows the marker ends on the quiet window, and the log says so', async () => {
    page = freshPage();
    const logs = [];
    timeline = [[0, (p) => { p.messages.push({ id: 'new-1', body: FULL, finished: false }); }]];
    await expect(capture({ quietFallbackMs: 1500, onLog: (m) => logs.push(m) })).resolves.toBe(FULL);
    expect(logs.join('\n')).toMatch(/without its finished marker/);
  }, 15000);

  it('a stop signal stuck on for good still ends, on the stuck window, and the log says so', async () => {
    page = freshPage();
    const logs = [];
    timeline = [[0, (p) => { p.stop = true; p.messages.push({ id: 'new-1', body: FULL, finished: false }); }]];
    await expect(capture({ stuckFallbackMs: 1500, onLog: (m) => logs.push(m) })).resolves.toBe(FULL);
    expect(logs.join('\n')).toMatch(/stop signal still showed/);
  }, 15000);
});

// ── 2. one capture per tab at a time ─────────────────────────────────────────────────────────
function relayHarness(capture) {
  const posts = [];
  const fails = [];
  const relay = createRoomRelay({
    resolveMembers: async () => [{ kind: 'brain', id: 'chatgpt', targetId: 'T1', adapter: 'chatgpt-cdp', state: 'active' }],
    adapterOf: async () => ({ injectScript: (t) => `INJECT[${t}]`, pollScript: 'POLL' }),
    streamFromTab: capture,
    openStream: () => ({ update() {}, async finish(r) { if (r?.text) posts.push(r.text); }, async fail(e) { fails.push(e?.message ?? String(e)); } }),
  });
  const ev = (body, n) => ({ surface: 'room', chatId: 'room-1', body, msgId: `m${n}` });
  return { relay, posts, fails, ev };
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

describe('2. one reply in flight per tab', () => {
  it('REPRODUCE: two messages back to back - the second is sent only after the first reply is captured, and both come back whole', async () => {
    const order = [];
    const h = relayHarness(async ({ injectScript }) => {
      order.push(`send ${injectScript}`);
      await delay(300);
      order.push(`done ${injectScript}`);
      return `reply to ${injectScript}`;
    });
    await Promise.all([h.relay.fanOut(h.ev('one', 1)), h.relay.fanOut(h.ev('two', 2))]);
    expect(order).toEqual(['send INJECT[one]', 'done INJECT[one]', 'send INJECT[two]', 'done INJECT[two]']);
    expect(h.posts).toEqual(['reply to INJECT[one]', 'reply to INJECT[two]']);
  });

  it('a failed capture releases the tab: the next message is still sent and its reply posted', async () => {
    const order = [];
    const h = relayHarness(async ({ injectScript }) => {
      order.push(`send ${injectScript}`);
      await delay(100);
      if (injectScript === 'INJECT[one]') throw new Error('Repeated poll failures');
      return `reply to ${injectScript}`;
    });
    await Promise.all([h.relay.fanOut(h.ev('one', 1)), h.relay.fanOut(h.ev('two', 2))]);
    expect(order).toEqual(['send INJECT[one]', 'send INJECT[two]']);
    expect(h.fails).toEqual(['Repeated poll failures']);
    expect(h.posts).toEqual(['reply to INJECT[two]']);
  });
});

// ── 3. the send never presses Stop ───────────────────────────────────────────────────────────
// The REAL injectScript in `vm`, against a fake composer and the given buttons. Timers are queued
// and stepped by hand so the retrying send loop runs to its end deterministically.
function runInject(buttons) {
  const clicks = [];
  const queue = [];
  const ta = {
    value: '', focus() {}, getAttribute: () => null, closest: () => null,
    dispatchEvent(e) { if (e.type === 'paste') ta.value = e.clipboardData.getData('text/plain'); },
  };
  const attr = (b, a) => ({ 'data-testid': b.testid, 'aria-label': b.aria, id: b.id, type: b.type }[a] ?? null);
  const el = (b) => ({ disabled: false, getAttribute: (a) => attr(b, a), closest: () => null, click: () => clicks.push(b.name) });
  const matchOne = (s, b) => {
    s = s.trim();
    let m;
    if ((m = s.match(/^(?:button)?#([\w-]+)$/))) return b.id === m[1];
    if ((m = s.match(/^button\[data-testid="([^"]+)"\]$/))) return b.testid === m[1];
    if (/^button\[aria-label\*="Send" i\]$/.test(s)) return /send/i.test(b.aria ?? '');
    if (s === 'form button[type="submit"]') return b.type === 'submit';
    if ((m = s.match(/^button\.([\w-]+)$/))) return (b.cls ?? '').split(' ').includes(m[1]);
    return false;
  };
  const document = {
    querySelector: (sel) => {
      if (sel === '#prompt-textarea') return ta;
      const hit = buttons.find((b) => sel.split(',').some((s) => matchOne(s, b)));
      return hit ? el(hit) : null;
    },
  };
  class DataTransfer { constructor() { this.d = {}; } setData(t, v) { this.d[t] = v; } getData(t) { return this.d[t]; } }
  class ClipboardEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } }
  class InputEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } }
  const result = vm.runInNewContext(chatgpt.injectScript('hello there'), {
    document, DataTransfer, ClipboardEvent, InputEvent, setTimeout: (fn) => queue.push(fn),
  });
  for (let i = 0; i < 500 && queue.length; i++) queue.shift()();
  return { result, clicks };
}

describe('3. the send never presses Stop', () => {
  it('REPRODUCE: only a Stop control on the page (the tab is still answering) - nothing is pressed, and the send is reported as not made', () => {
    const { result, clicks } = runInject([{ name: 'stop', id: 'composer-submit-button', testid: 'stop-button' }]);
    expect(clicks).toEqual([]);
    expect(result).toBe(false);
  });

  it('REPRODUCE: the submit control carries a stop testid the list does not know - it is skipped for the real send button', () => {
    const { result, clicks } = runInject([
      { name: 'stop', id: 'composer-submit-button', testid: 'composer-stop-v2', aria: 'Stop streaming' },
      { name: 'send', testid: 'send-button', aria: 'Send prompt' },
    ]);
    expect(result).toBe(true);
    expect(clicks).toEqual(['send']);
  });

  it('an ordinary composer still sends through its submit control', () => {
    const { result, clicks } = runInject([{ name: 'submit', id: 'composer-submit-button', testid: 'send-button' }]);
    expect(result).toBe(true);
    expect(clicks).toEqual(['submit']);
  });
});
