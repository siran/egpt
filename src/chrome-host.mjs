// src/chrome-host.mjs — the Session-1 daemon HOLDS every browser group's Chrome and its CDP pipe, so a
// spine restart (/upgrade, /restart, a config restart) never restarts a Chrome (operator 2026-10-11).
// The daemon end holds processes and fds, nothing else: what to launch, send and kill is decided by
// the spine (src/spine/commands.mjs ensureChrome) and arrives over the IPC slot of the spine's spawn.
// This file reloads only when the daemon does; the spine end (connectChromeHost) ships with /upgrade.
//
// spine → daemon: launch{id, group, profileDir, bin, argv, plain?} · msg{group, msg} · kill{group} · list{id}
// daemon → spine: reply{id, pid | error | groups:[{group, profileDir, pid, plain?}]} · msg{group, msg}
//                 · exit{group, pid, code, signal}
import { spawn as nodeSpawn } from 'node:child_process';
import { relative, isAbsolute } from 'node:path';
import { createPipeChannel, createHostChannel } from './tools/cdp.mjs';
import { findChromeExecutable, chromeProcesses, killProcessTree } from './tools/chrome-launcher.mjs';
import { lowerChild } from './process-priority.mjs';

export const CHROME_HOST_ENV = 'EGPT_CHROME_HOST';
const ROOT_ATTACH = /^Target\.attachTo(Browser)?Target$/;

export function createChromeHost({ profilesRoot, spawn = nodeSpawn, setPriority, processes = chromeProcesses, killTree = killProcessTree, log = () => {} }) {
  const chromes = new Map();   // group → { profileDir, child, channel, roots, attaching }
  let spine = null;
  let ownId = 0;               // the daemon's own CDP ids are negative: never a spine's
  const tell = (m) => { if (spine?.connected) spine.send(m); };
  const detach = (c, sessionId) => c.channel.send({ id: -(++ownId), method: 'Target.detachFromTarget', params: { sessionId } });

  // A spine's ROOT sessions (attached at the top level; the rest hang off them) are detached when its
  // IPC drops, so the next spine starts clean. An attach still in flight is detached when it lands.
  function fromChrome(group, c, m) {
    if (m.id < 0) return;
    const by = c.attaching.get(m.id);
    if (by !== undefined) {
      c.attaching.delete(m.id);
      const sid = m.result?.sessionId;
      if (sid && by !== spine) return detach(c, sid);
      if (sid) c.roots.add(sid);
    }
    if (!m.sessionId && m.method === 'Target.attachedToTarget') c.roots.add(m.params?.sessionId);
    if (!m.sessionId && m.method === 'Target.detachedFromTarget') c.roots.delete(m.params?.sessionId);
    tell({ t: 'msg', group, msg: m });
  }

  // The daemon is the ONLY Chrome spawner: it runs nothing but a pipe Chrome, or a plain one (a human's
  // sign-in window, /browser refresh), on the profile it was sent, under our profiles root. Switches as
  // Chrome reads them: --, - or /, any case.
  function refusal(profileDir, argv, plain) {
    const port = argv.find((a) => /^(--|-|\/)remote-debugging-(port|address)/i.test(a));
    if (port) return `${port} opens a debugging port`;
    const cmd = argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
    if (plain && argv.some((a) => /^(--|-|\/)remote-debugging-/i.test(a))) return 'a plain Chrome takes no --remote-debugging switch';
    if (!plain && !isPipe(cmd)) return 'not a pipe Chrome (no --remote-debugging-pipe)';
    if (argv.filter((a) => /^(--|-|\/)user-data-dir=/i.test(a)).length > 1) return 'it names more than one --user-data-dir';
    const dir = userDataDirOf(cmd);
    if (!dir || !under(dir, profilesRoot)) return `its --user-data-dir must be under ${profilesRoot}`;
    if (dir !== profileDir) return `its --user-data-dir ${dir} is not ${profileDir}`;
    return null;
  }

  function launch({ id, group, profileDir, bin, argv, plain = false }) {
    const why = refusal(profileDir, argv, plain);
    if (why) { log(`chrome-host: refused "${group}" launch — ${why}`); return tell({ t: 'reply', id, error: why }); }
    if (chromes.has(group)) return tell({ t: 'reply', id, error: `the "${group}" Chrome is already up (pid ${chromes.get(group).child.pid})` });
    const exe = bin || findChromeExecutable();
    if (!exe) return tell({ t: 'reply', id, error: 'Chrome executable not found in standard locations' });
    let child;
    try { child = spawn(exe, argv, { stdio: plain ? 'inherit' : ['inherit', 'inherit', 'inherit', 'pipe', 'pipe'] }); }
    catch (e) { return tell({ t: 'reply', id, error: String(e?.message ?? e) }); }
    const c = { profileDir, child, plain };
    chromes.set(group, c);
    if (!plain) {
      lowerChild(child.pid, { onLog: log, setPriority });
      Object.assign(c, { channel: createPipeChannel({ writable: child.stdio[3], readable: child.stdio[4] }), roots: new Set(), attaching: new Map() });
      child.stdio[3].on('error', () => {});   // EPIPE once Chrome is gone; its exit says so
      c.channel.onMessage((m) => fromChrome(group, c, m));
    }
    let started = false;
    child.on('spawn', () => {
      started = true;
      log(`chrome-host: launched "${group}" ${plain ? 'plain ' : ''}Chrome pid ${child.pid} on ${profileDir}`);
      tell({ t: 'reply', id, pid: child.pid });
    });
    child.on('error', (e) => {
      if (started) return log(`chrome-host: "${group}" Chrome pid ${child.pid}: ${e?.message ?? e}`);
      if (chromes.get(group) === c) chromes.delete(group);
      tell({ t: 'reply', id, error: String(e?.message ?? e) });
    });
    child.on('exit', (code, signal) => {
      if (chromes.get(group) === c) chromes.delete(group);
      if (!started) return;
      log(`chrome-host: "${group}" Chrome pid ${child.pid} exited (${signal ?? code})`);
      tell({ t: 'exit', group, pid: child.pid, code, signal });
    });
  }

  function fromSpine(m) {
    const c = chromes.get(m?.group);
    if (m?.t === 'launch') return launch(m);
    if (m?.t === 'list') return tell({ t: 'reply', id: m.id, groups: [...chromes].map(([group, h]) => ({ group, profileDir: h.profileDir, pid: h.child.pid, ...(h.plain && { plain: true }) })) });
    if (m?.t === 'kill') return c?.child.kill();
    if (m?.t !== 'msg' || !c?.channel) return;
    if (!m.msg.sessionId && ROOT_ATTACH.test(m.msg.method)) c.attaching.set(m.msg.id, spine);
    c.channel.send(m.msg);
  }

  function dropped() {
    if (!spine) return;
    spine = null;
    for (const c of chromes.values()) { if (c.plain) continue; for (const s of c.roots) detach(c, s); c.roots.clear(); }
  }

  return {
    // Each spine the daemon spawns, in turn. The previous one's sessions are dropped first.
    attach(child) {
      dropped();
      spine = child;
      child.on('message', fromSpine);
      child.on('disconnect', () => { if (spine === child) dropped(); });
    },
    // At daemon start, a pipe Chrome on one of OUR profiles is an orphan: the daemon that held its
    // pipe is gone. Nothing else is touched.
    sweepOrphans() {
      try {
        for (const { pid, cmd } of processes()) {
          const dir = userDataDirOf(cmd);
          if (!isPipe(cmd) || !dir || !under(dir, profilesRoot)) continue;
          log(`chrome-host: killing orphan pipe Chrome pid ${pid} on ${dir}`);
          killTree(pid);
        }
      } catch (e) { log(`chrome-host: orphan sweep failed — ${e?.message ?? e}`); }
    },
  };
}

// One reading of a Chrome command line, for the orphan sweep and for the argv launch is about to run.
const isPipe = (cmd) => /(?:^|\s)"?--remote-debugging-pipe"?(?=\s|$)/.test(cmd);
const userDataDirOf = (cmd) => /(?:^|\s)("?)--user-data-dir=(.+?)\1(?=\s|$)/.exec(cmd)?.[2];
const under = (p, root) => { const rel = relative(root, p); return !!rel && !rel.startsWith('..') && !isAbsolute(rel); };

/**
 * The spine's end. null without a daemon host (a spine run by hand, tests, Session 0) → no browser.
 *   launch({ group, profileDir, bin, argv }) → { pid, channel }   launchPlain({ group, profileDir, bin, argv }) → { pid }
 *   list() → [{ group, profileDir, pid, channel } | { group, profileDir, pid, plain: true }]
 *   kill(group)   onExit(cb({ group, pid, code, signal }))
 */
export function connectChromeHost(proc = process, env = process.env, { timeoutMs = 15_000 } = {}) {
  if (env[CHROME_HOST_ENV] !== '1' || typeof proc.send !== 'function') return null;
  delete env[CHROME_HOST_ENV];   // the spine's alone: a process it starts has no host on its IPC
  const channels = new Map();    // group → createHostChannel's { channel, emit, fail }
  const replies = new Map();     // request id → settle
  const exits = new Set();
  let req = 0;
  const post = (m) => { if (proc.connected) proc.send(m); };
  const ask = (m) => new Promise((resolve, reject) => {
    if (!proc.connected) return reject(new Error('the daemon holding the browsers is gone'));
    const id = ++req;
    const t = setTimeout(() => { replies.delete(id); reject(new Error(`the daemon's chrome-host did not answer "${m.t}"`)); }, timeoutMs);
    replies.set(id, (r) => { clearTimeout(t); replies.delete(id); if (r.error) reject(new Error(r.error)); else resolve(r); });
    proc.send({ ...m, id });
  });
  const open = (group) => {
    const c = createHostChannel((msg) => post({ t: 'msg', group, msg }));
    channels.set(group, c);
    return c.channel;
  };
  const drop = (group, why) => { channels.get(group)?.fail(new Error(why)); channels.delete(group); };
  proc.on('message', (m) => {
    if (m?.t === 'reply') replies.get(m.id)?.(m);
    else if (m?.t === 'msg') channels.get(m.group)?.emit(m.msg);
    else if (m?.t === 'exit') { drop(m.group, 'CDP pipe closed (Chrome exited)'); for (const cb of exits) cb(m); }
  });
  proc.on('disconnect', () => { for (const g of [...channels.keys()]) drop(g, 'the daemon holding this Chrome is gone'); });
  return {
    launch: async (o) => ({ pid: (await ask({ t: 'launch', ...o })).pid, channel: open(o.group) }),
    launchPlain: async (o) => ({ pid: (await ask({ t: 'launch', ...o, plain: true })).pid }),
    list: async () => (await ask({ t: 'list' })).groups.map((g) => (g.plain ? g : { ...g, channel: open(g.group) })),
    kill: (group) => post({ t: 'kill', group }),
    onExit: (cb) => { exits.add(cb); },
  };
}
