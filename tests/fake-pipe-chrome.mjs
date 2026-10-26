// tests/fake-pipe-chrome.mjs — a fake group Chrome. No real Chrome.
//   fakeChromeChild(browser, pid) — a Chrome PROCESS as src/chrome-host.mjs spawns it: fds 3/4 speak
//     \0-framed CDP to a scripted peer. `browser` is shaped like a CDP client (listTabs / openTab /
//     closeTab / activateTarget answer their Target methods), or `browser.cdp(msg)` answers anything
//     (a returned promise holds the reply). A thrown error becomes a CDP error. `received` = every
//     message in.
//   fakePipeChrome(browserOf) — a fake `chromeHost` (connectChromeHost's shape) over such children,
//     for createCommands. A function `(launchOpts) => browser` picks one per launch. `plain` = every
//     launchPlain's opts + pid + close() (its Chrome exits); `events` = kill/launch/plain in order.
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createPipeChannel } from '../src/tools/cdp.mjs';

const answer = async (browser, { method, params = {} }) => {
  switch (method) {
    case 'Target.getTargets': return { targetInfos: (await (browser.listTabs?.() ?? [])).map((t) => ({ targetId: t.id, type: t.type ?? 'page', url: t.url, title: t.title })) };
    case 'Target.createTarget': return { targetId: (await browser.openTab?.(params.url)) ?? 'NEW' };
    case 'Target.closeTarget': await browser.closeTab?.(params.targetId); return {};
    case 'Target.activateTarget': await browser.activateTarget?.(params.targetId); return {};
    case 'Target.attachToTarget': return { sessionId: `S-${params.targetId}` };
    default: return {};
  }
};

export function fakeChromeChild(browser = {}, pid = 0) {
  const toChrome = new PassThrough();
  const toClient = new PassThrough();
  const child = Object.assign(new EventEmitter(), { pid, exitCode: null, killed: false, stdio: [null, null, null, toChrome, toClient], received: [] });
  let buf = Buffer.alloc(0);
  toChrome.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let i;
    while ((i = buf.indexOf(0)) !== -1) {
      const frame = buf.subarray(0, i);
      buf = buf.subarray(i + 1);
      if (!frame.length) continue;
      const msg = JSON.parse(frame.toString('utf8'));
      child.received.push(msg);
      const reply = (body) => { if (!toClient.writableEnded) toClient.write(JSON.stringify({ id: msg.id, ...body, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) }) + '\0'); };
      Promise.resolve().then(() => (browser.cdp ? browser.cdp(msg) : answer(browser, msg)))
        .then((result) => reply({ result: result ?? {} }), (e) => reply({ error: { message: e?.message ?? String(e) } }));
    }
  });
  child.kill = () => {
    if (child.killed) return false;
    child.killed = true; child.exitCode = 0;
    toClient.end();
    child.emit('exit', 0, null);
    return true;
  };
  setImmediate(() => child.emit('spawn'));
  return child;
}

export function fakePipeChrome(browserOf = {}) {
  const calls = [];
  const handles = [];
  const plain = [];
  const events = [];
  const live = new Map();
  const exits = new Set();
  let pid = 1000;
  const chromeHost = {
    async launchPlain(opts) {
      events.push(`plain:${opts.group}`);
      const p = { ...opts, pid: ++pid, close: () => { for (const cb of exits) cb({ group: opts.group, pid: p.pid, code: 0, signal: null }); } };
      plain.push(p);
      return { pid: p.pid };
    },
    async launch(opts) {
      events.push(`launch:${opts.group}`);
      calls.push(opts);
      const child = fakeChromeChild(typeof browserOf === 'function' ? browserOf(opts) : browserOf, ++pid);
      live.set(opts.group, child);
      child.on('exit', (code, signal) => {
        if (live.get(opts.group) === child) live.delete(opts.group);
        for (const cb of exits) cb({ group: opts.group, pid: child.pid, code, signal });
      });
      handles.push({ child, pid: child.pid, profileDir: opts.profileDir });
      return { pid: child.pid, channel: createPipeChannel({ writable: child.stdio[3], readable: child.stdio[4] }) };
    },
    list: async () => [],
    kill: (group) => { events.push(`kill:${group}`); live.get(group)?.kill(); },
    onExit: (cb) => { exits.add(cb); },
  };
  return { chromeHost, calls, handles, plain, events };
}
