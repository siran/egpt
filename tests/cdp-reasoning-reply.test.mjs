// A reasoning model's reply through a ChatGPT tab: the REAL streamFromTab and the REAL chatgpt
// pollScript, driven against a mock CDP server whose page is scripted over time.
//
// THE LIVE FAILURE (kg, 2026-09-24 20:57, room tpoef): the room recorded a ChatGPT member's reply
// as just `Thinking` and the answer never came back. While a reasoning model thinks, its assistant
// message exists with NO markdown body yet; the poll read the whole element instead - the status
// line - and streamFromTab's end rules took that unchanging line for a finished reply.
//
// The page has no DOM: each Runtime.evaluate of a poll runs the expression in `vm` against a small
// fake `document` that answers exactly the queries the pollScript makes. The inject script is
// recognised by its composer selector, answers `true`, and starts the page's timeline.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer } from 'node:http';
import vm from 'node:vm';
import { WebSocketServer } from 'ws';
import { setCdpHostGetter, streamFromTab } from '../src/tools/cdp.mjs';
import { pollScript, injectScript } from '../config/brains/chatgpt-cdp.mjs';

const TAB = 'reasoning-tab-1';
const ANSWER = 'Yes. Physically it may neutralize the motivation behind the problem.';

// The page: earlier turns plus whatever the timeline adds. A message's WHOLE text is its status
// line until a body exists, then the body - which is what a real turn's innerText reads as.
let page;
const freshPage = () => ({ stop: false, messages: [{ id: 'old-0', status: '', body: 'an earlier answer', finished: true }], timers: [] });

function fakeDocument(p) {
  const turnOf = (m) => ({ querySelector: (sel) => (/copy-turn-action-button/.test(sel) && m.finished ? {} : null) });
  const elementOf = (m) => ({
    getAttribute: (a) => (a === 'data-message-id' ? m.id : null),
    get innerText() { return m.body != null ? m.body : m.status; },
    querySelector: (sel) => (/markdown|prose/.test(sel) && m.body != null ? { innerText: m.body } : null),
    closest: () => turnOf(m),
  });
  return {
    // Every stop-button selector names "stop"; the streaming-flag selectors never match here.
    querySelector: (sel) => (/stop/i.test(sel) && p.stop ? {} : null),
    querySelectorAll: (sel) => (/assistant/.test(sel) ? p.messages.map(elementOf) : []),
  };
}

// A timeline step: [atMs, (page) => void], relative to the inject.
function play(steps) {
  for (const [at, fn] of steps) page.timers.push(setTimeout(() => fn(page), at));
}
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

const capture = (opts = {}) => streamFromTab({ targetId: TAB, injectScript: injectScript('hi'), pollScript, onUpdate: () => {}, ...opts });

// The reply as it lands: a thinking message, then a body streaming in, then the turn finishing.
const reasoningThen = (thinkMs, { stopShows }) => [
  [0, (p) => { p.messages.push({ id: 'new-1', status: 'Thinking', body: null, finished: false }); p.stop = stopShows; }],
  [thinkMs, (p) => { p.messages[1].body = 'Yes.'; p.stop = stopShows; }],
  [thinkMs + 300, (p) => { p.messages[1].body = 'Yes. Physically it may'; }],
  [thinkMs + 600, (p) => { p.messages[1].body = ANSWER; }],
  [thinkMs + 900, (p) => { p.stop = false; p.messages[1].finished = true; }],
];

describe('a reasoning model\'s reply through a ChatGPT tab', () => {
  it('REPRODUCE: thinking longer than the safety net while the stop button shows - the answer, not "Thinking"', async () => {
    page = freshPage();
    timeline = reasoningThen(12000, { stopShows: true });
    await expect(capture()).resolves.toBe(ANSWER);
  }, 30000);

  it('REPRODUCE: the stop-button selectors miss the current UI - thinking still is not a reply', async () => {
    page = freshPage();
    timeline = reasoningThen(3000, { stopShows: false });
    await expect(capture()).resolves.toBe(ANSWER);
  }, 20000);

  it('a turn that FINISHES with no body at all is read whole, so it is still captured', async () => {
    page = freshPage();
    timeline = [
      [0, (p) => { p.messages.push({ id: 'new-1', status: 'Thinking', body: null, finished: false }); p.stop = true; }],
      [1500, (p) => { p.messages[1].status = 'Image created'; p.stop = false; p.messages[1].finished = true; }],
    ];
    await expect(capture()).resolves.toBe('Image created');
  }, 20000);

  it('reasoning that outlasts timeoutMs is waited for, up to the cap', async () => {
    page = freshPage();
    timeline = reasoningThen(3000, { stopShows: true });
    await expect(capture({ timeoutMs: 1000, reasoningCapMs: 15000 })).resolves.toBe(ANSWER);
  }, 20000);

  it('a reply still reasoning at the cap ends with an error that says so', async () => {
    page = freshPage();
    timeline = [[0, (p) => { p.messages.push({ id: 'new-1', status: 'Thinking', body: null, finished: false }); p.stop = true; }]];
    await expect(capture({ timeoutMs: 500, reasoningCapMs: 1500 })).rejects.toThrow(/still reasoning/);
  }, 20000);

  it('a send that never produced a reply still times out at timeoutMs, as before', async () => {
    page = freshPage();
    timeline = [];
    const t0 = Date.now();
    await expect(capture({ timeoutMs: 800, reasoningCapMs: 15000 })).rejects.toThrow(/Timed out waiting for response \(800ms\)/);
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 20000);
});
