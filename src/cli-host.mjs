// src/cli-host.mjs — the daemon HOLDS every being's `claude` process and its stdio, so a spine restart
// (/upgrade, /restart, a config restart, a crash) never ends a session or its background agents
// (operator 2026-10-16: "when egpt is back, it keeps talking with the threads as if nothing had
// changed"). Same shape as chrome-host.mjs: the daemon end holds processes and buffers their output;
// what to spawn, write and kill is decided by the spine (warm-cli-session through the warm pool) and
// arrives over the IPC slot of the spine's spawn. This file reloads only when the daemon does.
//
// spine → daemon: cli:hello · cli:spawn{hid, key, meta, bin, args, cwd, env} · cli:in{hid, data}
//                 · cli:end{hid} · cli:kill{hid} · cli:list{id} · cli:adopt{id, hid}
// daemon → spine: cli:reply{id, …} · cli:spawned{hid, pid} · cli:out{hid, data} · cli:err{hid, data}
//                 · cli:exit{hid, code, signal, error?}
import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { lowerChild } from './process-priority.mjs';

export const CLI_HOST_ENV = 'EGPT_CLI_HOST';
const BUFFER_BYTES = 4 * 1024 * 1024;   // per session, while no spine holds it; partials are shed first
const HELLO_MS = 60_000;                // a spine that never says cli:hello does not speak this protocol
const STDERR_TAIL = 2_000;
const EXIT_GRACE_MS = 5_000;            // 'close' after 'exit' — or never, when another process holds the stdio

const parse = (line) => { try { return JSON.parse(line); } catch { return null; } };
const userText = (ev) => (Array.isArray(ev?.message?.content) ? ev.message.content : []).filter((c) => c?.type === 'text').map((c) => c.text).join('');

export function createCliHost({ spawn = nodeSpawn, setPriority, log = () => {}, bufferBytes = BUFFER_BYTES, helloMs = HELLO_MS, setTimeout: setTimeoutFn = setTimeout, clearTimeout: clearTimeoutFn = clearTimeout } = {}) {
  const procs = new Map();   // hid → rec
  let spine = null;
  let hello = false;
  let helloTimer = null;
  const tell = (m) => { if (spine?.connected) spine.send(m); };
  const owned = (rec) => rec.owner !== null && rec.owner === spine && spine.connected;

  // What the CLI's events say, delivered or not: whether a turn is open, task start times, the thread.
  function track(rec, ev) {
    if (typeof ev?.session_id === 'string' && !rec.sessionId) rec.sessionId = ev.session_id;
    if (ev?.type === 'result' && ev.origin?.kind !== 'task-notification') rec.open = false;
    if (ev?.type === 'system' && ev.subtype === 'background_tasks_changed') {
      for (const t of Array.isArray(ev.tasks) ? ev.tasks : []) if (!rec.since.has(t.task_id)) rec.since.set(t.task_id, Date.now());
    }
  }
  // …and what a spine has been handed: the state an adopter starts from, before the buffer.
  function delivered(rec, ev) {
    if (ev?.type === 'system' && ev.subtype === 'init' && typeof ev.model === 'string') rec.model = ev.model;
    if (ev?.type === 'system' && ev.subtype === 'background_tasks_changed') rec.tasks = Array.isArray(ev.tasks) ? ev.tasks : [];
  }
  function keep(rec, line, ev) {
    rec.buffer.push({ line, partial: ev?.type === 'stream_event' });
    rec.bytes += line.length + 1;
    if (rec.bytes <= bufferBytes) return;
    rec.buffer = rec.buffer.filter((b) => { if (!b.partial) return true; rec.bytes -= b.line.length + 1; rec.dropped++; return false; });
    while (rec.bytes > bufferBytes && rec.buffer.length) { rec.bytes -= rec.buffer.shift().line.length + 1; rec.dropped++; }
  }
  function onOut(rec, chunk) {
    const lines = (rec.partial + chunk).split('\n');
    rec.partial = lines.pop();
    let out = '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const ev = parse(line);
      track(rec, ev);
      if (owned(rec)) { delivered(rec, ev); out += `${line}\n`; } else keep(rec, line, ev);
    }
    if (out) tell({ t: 'cli:out', hid: rec.hid, data: out });
  }
  function onErr(rec, chunk) {
    rec.stderr = (rec.stderr + chunk).slice(-STDERR_TAIL);
    if (owned(rec)) tell({ t: 'cli:err', hid: rec.hid, data: chunk });
  }

  function spawnFor(m) {
    const { hid, key, meta = null, bin, args = [], cwd, env } = m;
    let child;
    try { child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...(cwd ? { cwd } : {}), ...(env ? { env } : {}) }); }
    catch (e) { return tell({ t: 'cli:exit', hid, code: null, signal: null, error: String(e?.message ?? e) }); }
    const rec = { hid, key, meta, child, owner: spine, sessionId: m.sessionId ?? null, model: null, tasks: [], since: new Map(), open: false, openAtDetach: false, opener: '', partial: '', buffer: [], bytes: 0, dropped: 0, stderr: '' };
    procs.set(hid, rec);
    lowerChild(child.pid, { onLog: log, setPriority });
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', (d) => onOut(rec, d));
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on('data', (d) => onErr(rec, d));
    child.stdin?.on?.('error', () => {});   // EPIPE once it is gone; its exit says so
    let started = false;
    child.on('spawn', () => {
      started = true;
      log(`cli-host: ${key} pid ${child.pid} spawned`);
      if (owned(rec)) tell({ t: 'cli:spawned', hid, pid: child.pid });
    });
    child.on('error', (e) => {
      if (started) return log(`cli-host: ${key} pid ${child.pid}: ${e?.message ?? e}`);
      procs.delete(hid);
      if (owned(rec)) tell({ t: 'cli:exit', hid, code: null, signal: null, error: String(e?.message ?? e) });
    });
    const gone = (code, signal) => {
      if (procs.get(hid) !== rec) return;
      procs.delete(hid);
      log(`cli-host: ${key} pid ${child.pid} exited (${signal ?? code})${owned(rec) ? '' : ` while no spine held it${rec.buffer.length ? ` — ${rec.buffer.length} buffered line(s) lost` : ''}`}`);
      if (owned(rec)) tell({ t: 'cli:exit', hid, code, signal });
    };
    child.on('close', gone);
    // A sandbox launcher hands its stdio to the claude it starts, so its 'close' can never come.
    child.on('exit', (code, signal) => { setTimeoutFn(() => gone(code, signal), EXIT_GRACE_MS)?.unref?.(); });
  }

  function write(rec, data) {
    for (const line of String(data).split('\n')) {
      const ev = line.trim() ? parse(line) : null;
      if (ev?.type !== 'user') continue;
      if (!rec.open) rec.opener = userText(ev);
      rec.open = true;
    }
    try { rec.child.stdin.write(data); } catch { /* exiting — its close says so */ }
  }

  // The new spine takes a held session: what it was handed before the buffer, then the buffer itself.
  function adopt(id, hid) {
    const rec = procs.get(hid);
    if (!rec) return tell({ t: 'cli:reply', id, error: `no held session ${hid}` });
    const replay = rec.buffer.map((b) => `${b.line}\n`).join('');
    const reply = {
      t: 'cli:reply', id, pid: rec.child.pid, sessionId: rec.sessionId, model: rec.model,
      background: rec.tasks.map((t) => ({ task_id: t.task_id, description: t.description, since: rec.since.get(t.task_id) ?? Date.now() })),
      orphan: rec.openAtDetach ? { opener: rec.opener } : null,
      stderr: rec.stderr, replay, dropped: rec.dropped,
    };
    for (const b of rec.buffer) delivered(rec, parse(b.line));
    if (rec.dropped) log(`cli-host: ${rec.key} — ${rec.dropped} buffered line(s) were shed while no spine held it`);
    Object.assign(rec, { owner: spine, buffer: [], bytes: 0, dropped: 0, openAtDetach: false });
    tell(reply);
  }

  function fromSpine(m) {
    const rec = procs.get(m?.hid);
    if (m?.t === 'cli:hello') { hello = true; clearTimeoutFn(helloTimer); return; }
    if (m?.t === 'cli:spawn') return spawnFor(m);
    if (m?.t === 'cli:list') return tell({ t: 'cli:reply', id: m.id, sessions: [...procs.values()].filter((r) => !r.ending).map((r) => ({ hid: r.hid, key: r.key, meta: r.meta, pid: r.child.pid, held: owned(r) })) });
    if (m?.t === 'cli:adopt') return adopt(m.id, m.hid);
    if (!rec) return;
    if (m.t === 'cli:in') write(rec, m.data);
    else if (m.t === 'cli:end') { try { rec.child.stdin.end(); } catch { /* already closing */ } }
    else if (m.t === 'cli:kill') { try { rec.child.kill(); } catch { /* already gone */ } }
  }

  function dropped() {
    if (!spine) return;
    spine = null;
    for (const rec of procs.values()) if (rec.owner) { rec.owner = null; rec.openAtDetach = rec.open; }
  }

  function endAll(why) {
    clearTimeoutFn(helloTimer);
    for (const rec of procs.values()) {
      rec.ending = true;
      log(`cli-host: ending ${rec.key} pid ${rec.child.pid} — ${why}`);
      try { rec.child.stdin.end(); } catch { /* */ }
      try { rec.child.kill(); } catch { /* */ }
    }
  }

  return {
    // Each spine the daemon spawns, in turn. Its sessions stay up, held and buffered, until the next adopts them.
    attach(child) {
      dropped();
      spine = child;
      hello = false;
      clearTimeoutFn(helloTimer);
      child.on('message', fromSpine);
      child.on('disconnect', () => { if (spine === child) dropped(); });
      if (procs.size) {
        helloTimer = setTimeoutFn(() => { if (spine === child && !hello) endAll('its spine does not speak cli-host (an older checkout?)'); }, helloMs);
        helloTimer?.unref?.();
      }
    },
    // A spine leaving with 44 (/rewind): nothing will adopt these, so they end, as they did when the
    // spine held them.
    endAll,
    get size() { return procs.size; },
  };
}

// A child_process look-alike for warm-cli-session / sandbox-cli-session: stdout and stderr hold what
// arrives before anyone listens, so an adopted session's replay is never lost.
function heldStream() {
  const s = new EventEmitter();
  const held = [];
  s.setEncoding = () => s;
  s.push = (d) => { if (s.listenerCount('data') && !held.length) s.emit('data', d); else held.push(d); };
  s.on('newListener', (ev) => { if (ev === 'data' && held.length) queueMicrotask(() => { for (const d of held.splice(0)) s.emit('data', d); }); });
  return s;
}

/**
 * The spine's end. null without a daemon host (a spine run by hand, tests) → the spine spawns as before.
 *   spawner(key, meta) → spawn(bin, args, opts)   list() → [{ hid, key, meta, pid }]
 *   adopt(hid) → { proc, pid, sessionId, model, background, orphan }   kill(hid)
 */
export function connectCliHost(proc = process, env = process.env, { timeoutMs = 15_000, uuid = randomUUID } = {}) {
  if (env[CLI_HOST_ENV] !== '1' || typeof proc.send !== 'function') return null;
  delete env[CLI_HOST_ENV];   // the spine's alone: a process it starts has no host on its IPC
  const procs = new Map();    // hid → proxy
  const replies = new Map();
  let req = 0;
  const post = (m) => { if (proc.connected) proc.send(m); };
  const ask = (m) => new Promise((resolve, reject) => {
    if (!proc.connected) return reject(new Error('the daemon holding the sessions is gone'));
    const id = ++req;
    const t = setTimeout(() => { replies.delete(id); reject(new Error(`the daemon's cli-host did not answer "${m.t}"`)); }, timeoutMs);
    replies.set(id, (r) => { clearTimeout(t); replies.delete(id); if (r.error) reject(new Error(r.error)); else resolve(r); });
    proc.send({ ...m, id });
  });
  const proxy = (hid) => {
    const p = new EventEmitter();
    let closed = false;
    p.stdout = heldStream();
    p.stderr = heldStream();
    p.stdin = {
      write: (data) => { if (closed || !proc.connected) throw new Error('cli-host: that session is gone'); post({ t: 'cli:in', hid, data: String(data) }); return true; },
      end: () => post({ t: 'cli:end', hid }),
      on: () => p.stdin,
    };
    p.kill = () => { post({ t: 'cli:kill', hid }); return true; };
    p.close = (code, signal, error) => {
      if (closed) return;
      closed = true;
      procs.delete(hid);
      if (error && p.listenerCount('error')) p.emit('error', new Error(error));
      p.emit('exit', code, signal);
      p.emit('close', code, signal);
    };
    procs.set(hid, p);
    return p;
  };
  proc.on('message', (m) => {
    if (m?.t === 'cli:reply') return replies.get(m.id)?.(m);
    const p = procs.get(m?.hid);
    if (!p) return;
    if (m.t === 'cli:out') p.stdout.push(m.data);
    else if (m.t === 'cli:err') p.stderr.push(m.data);
    else if (m.t === 'cli:spawned') { p.pid = m.pid; p.emit('spawn'); }
    else if (m.t === 'cli:exit') p.close(m.code, m.signal, m.error);
  });
  proc.on('disconnect', () => { for (const p of [...procs.values()]) p.close(null, null); });
  post({ t: 'cli:hello' });
  return {
    spawner: (key, meta = null) => (bin, args, opts = {}) => {
      if (!proc.connected) throw new Error('cli-host: the daemon holding the sessions is gone');
      const hid = uuid();
      const p = proxy(hid);
      post({ t: 'cli:spawn', hid, key, meta, bin, args, cwd: opts.cwd, env: opts.env ?? process.env, sessionId: meta?.sessionId ?? null });
      return p;
    },
    list: async () => (await ask({ t: 'cli:list' })).sessions,
    adopt: async (hid) => {
      const r = await ask({ t: 'cli:adopt', hid });
      const p = proxy(hid);
      p.pid = r.pid;
      if (r.stderr) p.stderr.push(r.stderr);
      if (r.replay) p.stdout.push(r.replay);
      return { proc: p, pid: r.pid, sessionId: r.sessionId, model: r.model, background: r.background, orphan: r.orphan, dropped: r.dropped };
    },
    kill: (hid) => post({ t: 'cli:kill', hid }),
  };
}
