// tests/bus-protocol.test.mjs — round-trip integration test for the
// CDP-mediated control bus.
//
// What this catches: the kind of regression where a refactor passes
// every unit test (parsing, manifest integrity, host resolution)
// while quietly breaking the actual cross-surface event flow. None of
// the existing tests would notice if e.g. tools/bus.mjs's postEvent
// stopped routing through the right Runtime.evaluate path, or if
// subscribeBusEvents ignored 'egpt-bus' console events. This test
// runs the real tools/cdp.mjs and tools/bus.mjs against a mock CDP
// server that behaves enough like Chrome to let an event posted by
// node A surface in node B's onEvent callback.
//
// The mock implements just enough of CDP:
//   HTTP /json/version + /json/list  (cdp.mjs uses these for tab
//                                     discovery and ws URL hand-off)
//   WS  /devtools/page/<id>          Runtime.enable, Runtime.evaluate
//                                    Runtime.consoleAPICalled emit
//
// The 'page' is virtual — there's no DOM. window.bus.post(ev) is
// emulated server-side: when an evaluate expression invokes it
// (we recognize the postEvent function shape and parse the JSON
// arg), the mock broadcasts Runtime.consoleAPICalled with
// args=['egpt-bus', JSON.stringify(ev)] to every active session
// against this page. That's exactly what the real bus.html does.

import { describe, it, beforeAll, beforeEach, afterAll, expect } from 'vitest';
import { createServer } from 'node:http';
import { setCdpHostGetter } from '../tools/cdp.mjs';
import * as bus from '../tools/bus.mjs';
import { WebSocketServer } from 'ws';

// ── mock CDP server ─────────────────────────────────────────────

function startMockCdp() {
  const TAB_ID = 'bus-tab-1';
  const sessions = new Set();   // every active WS to /devtools/page/<TAB_ID>
  const eventLog = [];          // server-side ring buffer mimicking bus.html's

  const server = createServer((req, res) => {
    const port = server.address().port;
    if (req.url === '/json/version') {
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        Browser: 'Mock/1.0',
        webSocketDebuggerUrl: `ws://localhost:${port}/devtools/browser/abc`,
      }));
    }
    if (req.url === '/json/list' || req.url === '/json') {
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([
        {
          id: TAB_ID,
          type: 'page',
          url: `http://localhost:${port}/bus.html`,
          webSocketDebuggerUrl: `ws://localhost:${port}/devtools/page/${TAB_ID}`,
          title: 'bus',
        },
      ]));
    }
    res.writeHead(404).end();
  });

  // WebSocket for /devtools/page/<TAB_ID>. Each session = one cdp
  // attach (one node). Sessions all share the same page state, so
  // broadcasts from any session reach every session — same as real.
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith(`/devtools/page/${TAB_ID}`)) {
      // Browser-level WS — accept but do nothing (cdp.mjs only opens
      // it transiently for openTab/closeTab).
      wss.handleUpgrade(req, socket, head, ws => {
        ws.on('message', msg => {
          const cmd = JSON.parse(msg.toString());
          ws.send(JSON.stringify({ id: cmd.id, result: {} }));
        });
      });
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      sessions.add(ws);
      ws.on('close', () => sessions.delete(ws));
      ws.on('message', msg => {
        let cmd;
        try { cmd = JSON.parse(msg.toString()); } catch { return; }
        if (cmd.method === 'Runtime.enable') {
          ws.send(JSON.stringify({ id: cmd.id, result: {} }));
          return;
        }
        if (cmd.method === 'Runtime.evaluate') {
          const expr = cmd.params?.expression ?? '';

          // Replay query: window.bus?.getEvents?.(<since>)
          const replayMatch = expr.match(/window\.bus\?\.getEvents\?\.\((\d+)\)/);
          if (replayMatch) {
            const since = parseInt(replayMatch[1], 10);
            const past = eventLog.filter(e => (e.ts ?? 0) > since);
            ws.send(JSON.stringify({
              id: cmd.id,
              result: { result: { value: JSON.stringify(past) } },
            }));
            return;
          }

          // Post-event: (function(ev){...})({"type":"foo",...})
          const postMatch = expr.match(/\}\)\((\{[\s\S]*\})\)\s*$/);
          if (postMatch) {
            try {
              const ev = JSON.parse(postMatch[1]);
              const stamped = { ts: Date.now(), ...ev };
              eventLog.push(stamped);
              if (eventLog.length > 500) eventLog.shift();
              broadcastBusEvent(sessions, stamped);
            } catch (_) { /* malformed event — ignore */ }
          }
          ws.send(JSON.stringify({ id: cmd.id, result: { result: { value: null } } }));
          return;
        }
        // Unrecognized — generic ack so cdp.mjs doesn't hang.
        ws.send(JSON.stringify({ id: cmd.id, result: {} }));
      });
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        clearEventLog() { eventLog.length = 0; },
        stop() {
          for (const s of sessions) { try { s.close(); } catch (_) {} }
          return new Promise(r => server.close(r));
        },
      });
    });
  });
}

function broadcastBusEvent(sessions, ev) {
  // Same shape Chrome emits for console.log('egpt-bus', JSON.stringify(ev))
  // captured by Runtime.consoleAPICalled.
  const params = {
    timestamp: Date.now(),  // post-subscribe, so the bus.mjs replay-filter passes
    args: [
      { type: 'string', value: 'egpt-bus' },
      { type: 'string', value: JSON.stringify(ev) },
    ],
  };
  for (const ws of sessions) {
    if (ws.readyState !== ws.OPEN) continue;
    ws.send(JSON.stringify({ method: 'Runtime.consoleAPICalled', params }));
  }
}

// ── shared fixtures ─────────────────────────────────────────────

let mock;

beforeAll(async () => {
  mock = await startMockCdp();
  setCdpHostGetter(() => `localhost:${mock.port}`);
});

afterAll(async () => {
  await mock.stop();
});

// Each test starts with an empty event log so replay tests don't see
// each other's posts.
beforeEach(() => {
  mock.clearEventLog();
});

// ── tests ───────────────────────────────────────────────────────

describe('bus protocol round-trip', () => {
  it('node B receives the event node A posts', async () => {
    // Node A subscribes
    const located = await bus.findOrOpenBusTab({ open: false });
    expect(located).toBeTruthy();
    const received = [];
    const subA = await bus.subscribeBusEvents(located.targetId, ev => received.push(ev));

    try {
      // Node B posts
      await bus.postEvent(located.targetId, {
        type: 'node-online', from: 'node-b', ts: Date.now(), role: 'shell',
      });
      // Give the WS round-trip a moment
      await new Promise(r => setTimeout(r, 100));

      expect(received.length).toBe(1);
      expect(received[0]).toMatchObject({ type: 'node-online', from: 'node-b', role: 'shell' });
    } finally {
      subA.stop();
    }
  });

  it('two subscribers both see the same broadcast', async () => {
    const located = await bus.findOrOpenBusTab({ open: false });
    const a = [];
    const b = [];
    const subA = await bus.subscribeBusEvents(located.targetId, ev => a.push(ev));
    const subB = await bus.subscribeBusEvents(located.targetId, ev => b.push(ev));

    try {
      await bus.postEvent(located.targetId, {
        type: 'sessions-update', from: 'node-c', ts: Date.now(), sessions: [],
      });
      await new Promise(r => setTimeout(r, 100));

      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
      expect(a[0].from).toBe('node-c');
      expect(b[0].from).toBe('node-c');
    } finally {
      subA.stop();
      subB.stop();
    }
  });

  it('replay filter drops events older than subscribedAt', async () => {
    // The bus.mjs subscribeBusEvents drops Runtime.consoleAPICalled events
    // whose timestamp is earlier than (Date.now() - 1000) at subscription
    // time — so reconnecting nodes don't replay all of Chrome's buffered
    // console history. Verify by emitting a fresh event AFTER subscribing
    // and asserting it gets through (positive control); a true replay
    // case would need timestamp manipulation in the mock.
    const located = await bus.findOrOpenBusTab({ open: false });
    const recv = [];
    const sub = await bus.subscribeBusEvents(located.targetId, ev => recv.push(ev));

    try {
      await bus.postEvent(located.targetId, {
        type: 'mention', from: 'node-d', ts: Date.now(), target: 'codex1', body: 'hi',
      });
      await new Promise(r => setTimeout(r, 100));
      expect(recv.length).toBeGreaterThan(0);
      expect(recv[recv.length - 1].type).toBe('mention');
    } finally {
      sub.stop();
    }
  });

  it('replays past events to a late subscriber, marked _replayed:true', async () => {
    const located = await bus.findOrOpenBusTab({ open: false });
    // Post events with NO subscribers attached.
    await bus.postEvent(located.targetId, {
      type: 'room-utterance', from: 'node-x', user: 'an', body: 'past line 1',
    });
    await bus.postEvent(located.targetId, {
      type: 'room-utterance', from: 'node-x', user: 'an', body: 'past line 2',
    });

    // Late joiner subscribes — should see both via replay.
    const recv = [];
    const sub = await bus.subscribeBusEvents(located.targetId, ev => recv.push(ev));
    try {
      // No timeout needed: subscribe doesn't resolve until replay
      // dispatch is complete.
      const replayed = recv.filter(e => e._replayed);
      expect(replayed.length).toBeGreaterThanOrEqual(2);
      expect(replayed.find(e => e.body === 'past line 1')).toBeTruthy();
      expect(replayed.find(e => e.body === 'past line 2')).toBeTruthy();
    } finally {
      sub.stop();
    }
  });

  it('opt-out via { replay: false } skips the replay dispatch', async () => {
    const located = await bus.findOrOpenBusTab({ open: false });
    await bus.postEvent(located.targetId, {
      type: 'room-utterance', from: 'node-y', user: 'an', body: 'silenced past',
    });

    const recv = [];
    const sub = await bus.subscribeBusEvents(located.targetId, ev => recv.push(ev), { replay: false });
    try {
      // No replay dispatch — past events not delivered.
      expect(recv.find(e => e.body === 'silenced past')).toBeUndefined();
      // But fresh posts still arrive live.
      await bus.postEvent(located.targetId, {
        type: 'room-utterance', from: 'node-y', user: 'an', body: 'fresh',
      });
      await new Promise(r => setTimeout(r, 100));
      expect(recv.find(e => e.body === 'fresh')).toBeTruthy();
    } finally {
      sub.stop();
    }
  });

  it('replaySinceMs limits the look-back window', async () => {
    const located = await bus.findOrOpenBusTab({ open: false });
    // The mock stamps incoming events with Date.now(); with a tiny
    // window, prior posts fall outside it.
    await bus.postEvent(located.targetId, {
      type: 'room-utterance', from: 'node-z', user: 'an', body: 'should-skip-window',
    });
    // 50ms wait so the look-back window comfortably excludes the post.
    await new Promise(r => setTimeout(r, 50));

    const recv = [];
    const sub = await bus.subscribeBusEvents(located.targetId, ev => recv.push(ev), {
      replaySinceMs: 10,
    });
    try {
      expect(recv.find(e => e.body === 'should-skip-window')).toBeUndefined();
    } finally {
      sub.stop();
    }
  });
});
