// A ChatGPT tab member's reply is the NEW message, and it comes back VERBATIM. The REAL
// streamFromTab and the REAL chatgpt scripts, against a mock CDP server whose page is scripted
// over time (the style of tests/cdp-reasoning-reply.test.mjs).
//
// THE LIVE FAILURES (kg, 2026-09-25, room tpoef):
//   A. 16:44 the room recorded the PREVIOUS answer ("Of course. Where do you want to pick it
//      up...") as the reply; the tab held the real one as a separate, newer assistant message
//      that was never read. The poll read "the last assistant message", and streamFromTab, once
//      it had seen one new id, took whatever was last - so a moment in which the previous answer
//      was last again (a re-render, the switch from the reasoning block to the answer) handed
//      its text in as the reply.
//   B. The capture read the rendered body, so KaTeX came back as "n(ω)". The turn's own Copy
//      writes the source ("\(n(\omega)\)") to the clipboard - measured on the live tab.
//
// The page has no DOM: each Runtime.evaluate runs in `vm` against a small fake `document` and a
// fake `navigator` whose clipboard stands in for the OS one.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer } from 'node:http';
import vm from 'node:vm';
import { WebSocketServer } from 'ws';
import { setCdpHostGetter, streamFromTab } from '../src/tools/cdp.mjs';
import * as chatgpt from '../config/brains/chatgpt-cdp.mjs';

const TAB = 'verbatim-tab-1';
const OLD = 'Of course. Where do you want to pick it up: the toroidal basis?';
const ANSWER = 'Yes. I think there is real merit, provided the goal is prediction.';
const RENDERED = 'connecting optical response n(ω) to a transport quantity';
const SOURCE = 'connecting optical response \\(n(\\omega)\\) to a transport quantity\n';

let page;
function freshPage() {
  const os = { writes: 0 };
  const clipboard = {
    // The OS clipboard. Nothing in a capture may ever reach it.
    write: async () => { os.writes++; },
    writeText: async () => { os.writes++; },
  };
  const orig = { write: clipboard.write, writeText: clipboard.writeText };
  return { stop: false, messages: [{ id: 'old-0', status: '', body: OLD, finished: true }], timers: [], nav: { clipboard }, os, orig };
}

function fakeDocument(p) {
  const buttonOf = (m) => (m.copy === 'none' ? null : {
    click: () => {
      if (m.copy === 'silent') return;                  // a copy that writes nothing
      p.nav.clipboard.write([{
        types: ['text/plain', 'text/html'],
        getType: async (t) => ({ text: async () => (t === 'text/plain' ? (m.source ?? m.body) : `<p>${m.body}</p>`) }),
      }]);
    },
  });
  const turnOf = (m) => ({ querySelector: (sel) => (/copy-turn-action-button/.test(sel) && m.finished ? buttonOf(m) : null) });
  const elementOf = (m) => ({
    getAttribute: (a) => (a === 'data-message-id' ? m.id : null),
    get innerText() { return m.body != null ? m.body : m.status; },
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
      ws.on('message', async (raw) => {
        const cmd = JSON.parse(raw.toString());
        const expr = cmd.params?.expression ?? '';
        let value;
        if (expr.includes('#prompt-textarea')) { value = true; play(timeline); }
        else {
          value = vm.runInNewContext(expr, { document: fakeDocument(page), navigator: page.nav, setTimeout, clearTimeout });
          if (cmd.params?.awaitPromise && value && typeof value.then === 'function') value = await value;
        }
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
const newAnswer = (at, extra = {}) => [
  [at, (p) => { p.messages.push({ id: 'new-1', status: '', body: 'Yes.', finished: false, ...extra }); }],
  [at + 300, (p) => { p.messages[p.messages.length - 1].body = 'Yes. I think there is real merit'; }],
  [at + 600, (p) => { p.messages[p.messages.length - 1].body = extra.body ?? ANSWER; }],
  [at + 900, (p) => { p.stop = false; p.messages[p.messages.length - 1].finished = true; }],
];

describe('A. the reply is the NEW message, never one that was there before the send', () => {
  it('REPRODUCE: the previous answer is last again while the new one reasons - the new answer comes back, not the previous', async () => {
    page = freshPage();
    timeline = [
      [0, (p) => { p.messages.push({ id: 'new-1', status: 'Thinking', body: null, finished: false }); }],
      // the new message leaves the page for a moment: the previous answer is last again
      [1000, (p) => { p.messages.pop(); }],
      [3000, (p) => { p.messages.push({ id: 'new-1', status: '', body: 'Yes.', finished: false }); }],
      [3300, (p) => { p.messages[1].body = 'Yes. I think there is real merit'; }],
      [3600, (p) => { p.messages[1].body = ANSWER; }],
      [3900, (p) => { p.messages[1].finished = true; }],
    ];
    await expect(capture()).resolves.toBe(ANSWER);
  }, 20000);

  it('REPRODUCE: with the stop button showing, the previous answer is never streamed as a preview', async () => {
    page = freshPage();
    const previews = [];
    timeline = [
      [0, (p) => { p.stop = true; p.messages.push({ id: 'new-1', status: 'Thinking', body: null, finished: false }); }],
      [800, (p) => { p.messages.pop(); }],
      [1600, (p) => { p.messages.push({ id: 'new-1', status: '', body: 'Yes.', finished: false }); }],
      [1900, (p) => { p.messages[1].body = ANSWER; }],
      [2200, (p) => { p.stop = false; p.messages[1].finished = true; }],
    ];
    await expect(capture({ onUpdate: (t) => previews.push(t) })).resolves.toBe(ANSWER);
    expect(previews).not.toContain(OLD);
  }, 20000);

  it('a reasoning block and the answer as two new messages: the answer (the newest new one) is the reply', async () => {
    page = freshPage();
    timeline = [
      [0, (p) => { p.stop = true; p.messages.push({ id: 'new-think', status: 'Thinking', body: null, finished: false }); }],
      ...newAnswer(1200, {}),
    ];
    await expect(capture()).resolves.toBe(ANSWER);
  }, 20000);
});

describe('B. the reply comes back VERBATIM, through its own Copy', () => {
  it('REPRODUCE: KaTeX rendered on the page, the source through Copy - the capture returns the source', async () => {
    page = freshPage();
    timeline = newAnswer(0, { body: RENDERED, source: SOURCE });
    await expect(capture({ copyScript: chatgpt.copyScript })).resolves.toBe(SOURCE);
  }, 20000);

  it('the OS clipboard is never written, and the page\'s clipboard is restored', async () => {
    page = freshPage();
    timeline = newAnswer(0, { body: RENDERED, source: SOURCE });
    await capture({ copyScript: chatgpt.copyScript });
    expect(page.os.writes).toBe(0);
    expect(page.nav.clipboard.write).toBe(page.orig.write);
    expect(page.nav.clipboard.writeText).toBe(page.orig.writeText);
  }, 20000);

  it('no copy button on the reply: the rendered text, and the log says why', async () => {
    // With no copy button the reply never shows its finished marker either, so it ends on the
    // quiet fallback (shortened here from its 2-minute default) - both are logged.
    page = freshPage();
    const logs = [];
    timeline = newAnswer(0, { body: RENDERED, copy: 'none' });
    await expect(capture({ copyScript: chatgpt.copyScript, quietFallbackMs: 1500, onLog: (m) => logs.push(m) })).resolves.toBe(RENDERED);
    expect(logs.join('\n')).toMatch(/verbatim/i);
    expect(logs.join('\n')).toMatch(/without its finished marker/);
  }, 20000);

  it('a copy that writes nothing: the rendered text within a couple of seconds, logged', async () => {
    page = freshPage();
    const logs = [];
    timeline = newAnswer(0, { body: RENDERED, copy: 'silent' });
    const t0 = Date.now();
    await expect(capture({ copyScript: chatgpt.copyScript, onLog: (m) => logs.push(m) })).resolves.toBe(RENDERED);
    expect(logs.join('\n')).toMatch(/verbatim/i);
    expect(Date.now() - t0).toBeLessThan(9000);
  }, 20000);
});
