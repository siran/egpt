// tests/cdp-pipe-transport.test.mjs — the pipe CDP transport (chunk 3a).
//
// A Chrome launched with --remote-debugging-pipe exposes NO port and NO HTTP:
// CDP rides two inherited fds (3 client→Chrome writes, 4 Chrome→client reads),
// each message ASCII JSON followed by a single \0 byte, targets discovered and
// addressed through the Target domain (flat protocol, sessionId). This proves
// createPipeTransport speaks that wire against a FAKE peer — two in-memory
// streams, no real Chrome — and that createCdpClient's ops read the same over
// the pipe as over the port (3a is the transport only; 3b hands it real fds).
//
// The fake peer: it reads \0-delimited command frames off the writable (fd3),
// records them, and answers scripted responses on the readable (fd4). That the
// peer parses what the transport wrote, and the transport parses what the peer
// wrote, is itself the framing proof on both directions.
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { createPipeTransport, createCdpClient } from '../src/tools/cdp.mjs';

const tick = () => new Promise(r => setTimeout(r, 10));

// The targets the scripted peer reports. A non-page (service_worker) is present
// so listTabs' page filter is exercised.
const TARGETS = [
  { targetId: 'T-page-1', type: 'page', url: 'https://chatgpt.com/c/1', title: 'one' },
  { targetId: 'T-page-2', type: 'page', url: 'https://example.com', title: 'two' },
  { targetId: 'T-sw', type: 'service_worker', url: 'https://x/sw.js', title: 'sw' },
];

// A scripted CDP peer: id-echoing responses for the Target-domain + per-target
// methods the ops drive. Session-scoped responses echo the sessionId back.
function script(msg) {
  const { id, method, params, sessionId } = msg;
  switch (method) {
    case 'Target.getTargets':        return { id, result: { targetInfos: TARGETS } };
    case 'Target.attachToTarget':    return { id, result: { sessionId: `S-${params.targetId}` } };
    case 'Target.detachFromTarget':  return { id, result: {} };
    case 'Target.createTarget':      return { id, result: { targetId: 'T-new' } };
    case 'Target.closeTarget':       return { id, result: { success: true } };
    case 'Runtime.evaluate':         return { id, sessionId, result: { result: { value: { echoed: params.expression, sessionId } } } };
    case 'Page.captureScreenshot':   return { id, sessionId, result: { data: 'BASE64PNG' } };
    default:                         return { id, result: {} };
  }
}

// Wire a pipe transport to a fake peer. `respond(msg, push)` returns a response
// object (or array, or undefined to stay silent) for each command; `push` also
// lets a test emit unsolicited events. Records parsed command frames + raw bytes.
function fakePeer(respond = script) {
  const toChrome = new PassThrough();   // fd3: transport writes commands here
  const toClient = new PassThrough();   // fd4: transport reads responses here
  const received = [];                  // parsed command frames the peer saw
  const rawWrites = [];                 // raw chunks the transport wrote (framing proof)
  const push = (obj) => toClient.write(JSON.stringify(obj) + '\0');
  let buf = Buffer.alloc(0);
  toChrome.on('data', (chunk) => {
    rawWrites.push(Buffer.from(chunk));
    buf = Buffer.concat([buf, chunk]);
    let i;
    while ((i = buf.indexOf(0)) !== -1) {
      const frame = buf.subarray(0, i);
      buf = buf.subarray(i + 1);
      if (frame.length === 0) continue;
      const msg = JSON.parse(frame.toString('utf8'));   // throws loudly if the writer mis-framed
      received.push(msg);
      const out = respond(msg, push);
      if (out !== undefined) for (const r of [].concat(out)) push(r);
    }
  });
  const transport = createPipeTransport({ writable: toChrome, readable: toClient });
  return { transport, received, rawWrites, push, toChrome, toClient };
}

describe('pipe transport — framing + id correlation', () => {
  it('correlates responses by id even out of order, and frames every command as JSON + a trailing \\0', async () => {
    let q = [];
    const peer = fakePeer((msg, push) => {
      q.push(msg);
      if (q.length === 2) {          // answer the SECOND command first, then the first
        push({ id: q[1].id, result: { which: 'second' } });
        push({ id: q[0].id, result: { which: 'first' } });
      }
      return undefined;
    });
    const s = await peer.transport.openBrowserSession();
    const [r1, r2] = await Promise.all([s.send('M1'), s.send('M2')]);
    expect(r1).toEqual({ which: 'first' });     // id-correlated, not order-of-arrival
    expect(r2).toEqual({ which: 'second' });

    // The two commands carried distinct integer ids.
    expect(peer.received.map(m => m.method)).toEqual(['M1', 'M2']);
    expect(peer.received[0].id).not.toBe(peer.received[1].id);

    // Write-side framing: the concatenated bytes are \0-delimited JSON, ending on a NUL.
    const all = Buffer.concat(peer.rawWrites);
    expect(all.includes(0)).toBe(true);
    expect(all[all.length - 1]).toBe(0);
    for (const seg of all.toString('utf8').split('\0').filter(Boolean)) {
      expect(() => JSON.parse(seg)).not.toThrow();
    }
  });

  it('reassembles a response split across readable chunks — a frame dispatches only at its \\0', async () => {
    const toChrome = new PassThrough();
    const toClient = new PassThrough();
    const transport = createPipeTransport({ writable: toChrome, readable: toClient });
    const s = await transport.openBrowserSession();
    const pending = s.send('Whatever');

    // Learn the id the transport used, then feed its response in pieces.
    const cmd = await new Promise(res => toChrome.once('data', d => res(JSON.parse(d.toString('utf8').replace(/\0$/, '')))));
    const resp = JSON.stringify({ id: cmd.id, result: { ok: true } });
    toClient.write(resp.slice(0, 6));   // first half — no \0 yet, must not dispatch
    await tick();
    toClient.write(resp.slice(6));      // rest of the JSON, still no \0
    toClient.write('\0');               // the delimiter — now it dispatches
    await expect(pending).resolves.toEqual({ ok: true });
  });
});

describe('pipe transport — ops over the Target domain (same shape as the port path)', () => {
  it('listTabs: Target.getTargets, page-only, shaped {id,type,url,title}', async () => {
    const peer = fakePeer();
    const client = createCdpClient(peer.transport);
    const tabs = await client.listTabs();
    expect(peer.received.some(m => m.method === 'Target.getTargets')).toBe(true);
    expect(tabs).toEqual([                       // service_worker filtered out; targetId → id
      { id: 'T-page-1', type: 'page', url: 'https://chatgpt.com/c/1', title: 'one' },
      { id: 'T-page-2', type: 'page', url: 'https://example.com', title: 'two' },
    ]);
  });

  it('listTabs honors a url filter', async () => {
    const client = createCdpClient(fakePeer().transport);
    const tabs = await client.listTabs(/example\.com/);
    expect(tabs.map(t => t.id)).toEqual(['T-page-2']);
  });

  it('openTab → Target.createTarget, returns the new targetId', async () => {
    const peer = fakePeer();
    const client = createCdpClient(peer.transport);
    const id = await client.openTab('https://new.test/');
    expect(peer.received.find(m => m.method === 'Target.createTarget').params).toEqual({ url: 'https://new.test/' });
    expect(id).toBe('T-new');
  });

  it('closeTab → Target.closeTarget', async () => {
    const peer = fakePeer();
    const client = createCdpClient(peer.transport);
    await client.closeTab('T-page-2');
    expect(peer.received.find(m => m.method === 'Target.closeTarget').params).toEqual({ targetId: 'T-page-2' });
  });

  it('evaluate attaches (flatten) then round-trips Runtime.evaluate through the sessionId', async () => {
    const peer = fakePeer();
    const client = createCdpClient(peer.transport);
    const value = await client.evaluate('T-page-1', '1 + 1');
    expect(peer.received.find(m => m.method === 'Target.attachToTarget').params).toEqual({ targetId: 'T-page-1', flatten: true });
    const evalCmd = peer.received.find(m => m.method === 'Runtime.evaluate');
    expect(evalCmd.sessionId).toBe('S-T-page-1');          // per-target command carries the session
    expect(evalCmd.params.expression).toBe('1 + 1');
    expect(value).toEqual({ echoed: '1 + 1', sessionId: 'S-T-page-1' });   // ops unwrap result.result.value
  });

  it('captureScreenshot round-trips Page.captureScreenshot through the sessionId', async () => {
    const peer = fakePeer();
    const client = createCdpClient(peer.transport);
    const data = await client.captureScreenshot('T-page-1');
    expect(peer.received.find(m => m.method === 'Page.captureScreenshot').sessionId).toBe('S-T-page-1');
    expect(data).toBe('BASE64PNG');
  });
});

describe('pipe transport — event dispatch', () => {
  it('routes a target-scoped event (no id) to that session\'s onEvent by sessionId', async () => {
    const peer = fakePeer();
    const s = await peer.transport.openTargetSession('T-page-1');   // sessionId S-T-page-1
    const events = [];
    s.onEvent((method, params) => events.push({ method, params }));
    peer.push({ method: 'Runtime.consoleAPICalled', sessionId: 'S-T-page-1', params: { type: 'log' } });
    await tick();
    expect(events).toEqual([{ method: 'Runtime.consoleAPICalled', params: { type: 'log' } }]);
  });

  it('routes a browser-scoped event (no sessionId) to a browser session\'s onEvent', async () => {
    const peer = fakePeer();
    const s = await peer.transport.openBrowserSession();
    const events = [];
    s.onEvent((method) => events.push(method));
    peer.push({ method: 'Target.targetCreated', params: {} });
    await tick();
    expect(events).toEqual(['Target.targetCreated']);
  });
});

describe('pipe transport — clean failure on disconnect (Chrome exits)', () => {
  it('fails in-flight calls and notifies onClose when the readable ends, without throwing', async () => {
    // The peer answers the attach but never the evaluate, modeling a call still
    // outstanding when Chrome dies.
    const peer = fakePeer((msg) => (msg.method === 'Target.attachToTarget'
      ? { id: msg.id, result: { sessionId: 'S1' } }
      : undefined));
    const s = await peer.transport.openTargetSession('T-x');
    let closedErr = null;
    s.onClose(e => { closedErr = e; });
    const inflight = s.send('Runtime.evaluate', { expression: 'never answered' });

    peer.toClient.end();   // fd4 ends — Chrome exited

    await expect(inflight).rejects.toThrow(/pipe closed/i);   // in-flight call fails cleanly
    await tick();
    expect(closedErr).toBeInstanceOf(Error);                   // onClose fired, once
    expect(await peer.transport.isRunning()).toBe(false);      // transport knows it's gone

    // A send after disconnect REJECTS (a normal disconnect never throws synchronously).
    let threw = false;
    let p;
    try { p = s.send('Anything'); } catch { threw = true; }
    expect(threw).toBe(false);
    await expect(p).rejects.toThrow(/pipe closed/i);
  });
});
