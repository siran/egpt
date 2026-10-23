// beeper-update.mjs — keeping Beeper Desktop current: detection, the log_to_group notice, and
// `/update beeper`. The install itself is beeper-update.ps1 beside this file (Windows only so far).
//
// config: beeper.auto_update.<windows|linux|mac>.method = auto | manual | none (config-schema.mjs).
// A controlled Beeper restart, the spine stays up (operator 2026-10-19): drain like /restart without
// exiting → every bridge enters its "Beeper restarting for update" state (calls wait, no redial, no
// ear verdict) → the .ps1 runs as a child → the state clears (redial now, held calls go) → ONE line.
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { openSync, closeSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn as nodeSpawn, execFile } from 'node:child_process';
import { EGPT_HOME } from '../egpt-home.mjs';
import { beeperBlockOf } from './config-io.mjs';

export const AUTO_UPDATE_METHODS = ['auto', 'manual', 'none'];
export const CHECK_EVERY_MS = 6 * 3_600_000;
export const PEER_WINDOW_MS = 20 * 60_000;    // a peer's "restarting for update…" line older than this is stale
const TOOL_CAP_MS = 20 * 60_000;              // longest the bridges hold for the tool
export const CLOSE_TRY_SEC = 30;              // the open app: WM_CLOSE, then this long for it to quit
export const CLOSE_WAIT_SEC = 570;            // it only hid: this much longer for the operator's tray Quit
const OS_OF = { win32: 'windows', linux: 'linux', darwin: 'mac' };
const DEFAULT_METHOD = { windows: 'manual' };
const PORTS = Array.from({ length: 10 }, (_, i) => 23373 + i);   // boot's DISCOVERY_PORTS
const FEED = 'https://api.beeper.com/desktop/update-feed.json';
const UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\4005ec12-b235-5981-b49e-4005d478a398';

// { os, method, note }: the method this node runs; note = the one boot log line when it differs from what is configured.
export function autoUpdateMethod(cfg, platform = process.platform) {
  const os = OS_OF[platform] ?? platform;
  const raw = beeperBlockOf(cfg)?.auto_update?.[os]?.method;
  const method = raw == null ? (DEFAULT_METHOD[os] ?? 'none') : String(raw).trim().toLowerCase();
  if (!AUTO_UPDATE_METHODS.includes(method)) return { os, method: 'none', note: `beeper.auto_update.${os}.method "${raw}" is not auto | manual | none — treated as none` };
  if (os !== 'windows' && method !== 'none') return { os, method: 'none', note: `beeper.auto_update.${os}.method is ${method}: Beeper updates are not implemented on ${os} yet — treated as none` };
  return { os, method, note: null };
}

export function cmpVersion(a, b) {
  const pa = String(a ?? '').split('.').map(Number), pb = String(b ?? '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}
const newer = (a, b) => !!a && !!b && cmpVersion(a, b) > 0;

// Ingest line → hold on (true) / off (false) / not a hold (null).
export function holdLine(line) {
  const cmd = String(line ?? '').trim();
  return cmd === '/beeper-hold on' ? true : cmd === '/beeper-hold off' ? false : null;
}

// d = { installed, pending: { version, adminRequired } | null, running: [{ name, port, version }], latest: { version } | null }
export function stateOf(d) {
  if (d.pending && newer(d.pending.version, d.installed)) return d.pending.adminRequired ? 'blocked' : 'downloaded';
  if ((d.running ?? []).some((r) => r.version && newer(d.installed, r.version))) return 'restart-needed';
  if (d.latest && newer(d.latest.version, d.installed)) return 'available';
  return 'up-to-date';
}

// ── detection: structured facts only, no elevation, changes nothing ──────────────────────────────
async function getJson(fetchImpl, url, { token = null, timeoutMs = 750 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: ctl.signal });
    return { status: res.status, json: res.status === 200 ? await res.json().catch(() => null) : null };
  } catch { return { status: 0, json: null }; } finally { clearTimeout(t); }
}

// The registry's DisplayVersion of the per-user install.
export function readInstalledVersion() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => execFile('reg', ['query', UNINSTALL_KEY, '/v', 'DisplayVersion'], { windowsHide: true, timeout: 10_000 }, (err, stdout) => {
    resolve(err ? null : (/DisplayVersion\s+REG_SZ\s+(\S+)/.exec(String(stdout)) ?? [])[1] ?? null);
  }));
}

// electron-updater's update-info.json for the downloaded installer.
export async function readPending({ localAppData = process.env.LOCALAPPDATA, readFileImpl = readFile } = {}) {
  if (!localAppData) return null;
  try {
    const info = JSON.parse(String(await readFileImpl(join(localAppData, 'beepertexts-updater', 'pending', 'update-info.json'), 'utf8')).replace(/^﻿/, ''));
    return { fileName: info.fileName ?? null, version: (/(\d+\.\d+\.\d+(?:\.\d+)?)/.exec(info.fileName ?? '') ?? [])[1] ?? null, adminRequired: !!info.isAdminRightsRequired };
  } catch { return null; }
}

// Every Beeper answering /v1/info, named by the connection whose token it answers; tokened connections with no port too.
export async function readRunning(cfg, { fetchImpl = fetch } = {}) {
  const conns = Object.entries(beeperBlockOf(cfg) ?? {}).filter(([k, v]) => k !== 'auto_update' && v && typeof v === 'object' && v.token).map(([name, v]) => ({ name, token: v.token }));
  const live = (await Promise.all(PORTS.map(async (port) => ({ port, version: (await getJson(fetchImpl, `http://127.0.0.1:${port}/v1/info`)).json?.app?.version ?? null })))).filter((p) => p.version);
  const owner = new Map();
  await Promise.all(conns.flatMap((c) => live.map(async (p) => {
    if ((await getJson(fetchImpl, `http://127.0.0.1:${p.port}/v1/accounts`, { token: c.token })).status === 200) owner.set(p.port, c.name);
  })));
  const named = new Set(owner.values());
  return [
    ...live.map((p) => ({ name: owner.get(p.port) ?? null, port: p.port, version: p.version })),
    ...conns.filter((c) => !named.has(c.name)).map((c) => ({ name: c.name, port: null, version: null })),
  ];
}

// The update feed's JSON (204 = nothing newer).
export async function readLatest(installed, { fetchImpl = fetch } = {}) {
  const q = new URLSearchParams({ bundleID: 'com.automattic.beeper.desktop', version: installed ?? '0.0.0', platform: 'win32', arch: 'x64', channel: 'stable' });
  const r = await getJson(fetchImpl, `${FEED}?${q}`, { timeoutMs: 10_000 });
  if (r.status === 204) return { version: installed, date: null };
  return r.json?.version ? { version: r.json.version, date: r.json.pub_date ?? null } : null;
}

export async function detect(cfg, { fetchImpl = fetch, installedVersion = readInstalledVersion, localAppData } = {}) {
  const installed = await installedVersion();
  const [pending, running, latest] = await Promise.all([readPending({ localAppData }), readRunning(cfg, { fetchImpl }), readLatest(installed, { fetchImpl })]);
  return { installed, pending, running, latest };
}

// ── the lines ──────────────────────────────────────────────────────────────────────────────────
const runningText = (d) => (d.running ?? []).map((r) => `${r.name ?? 'other'} ${r.version ?? '?'}${r.port ? ` :${r.port}` : ' no port'}`).join(', ');
const oldestRunning = (d) => (d.running ?? []).map((r) => r.version).filter(Boolean).sort(cmpVersion)[0] ?? d.installed;

export function statusLine(node, d, state = stateOf(d)) {
  const what = {
    'up-to-date': 'up to date',
    available: `${d.latest?.version} available, not downloaded yet`,
    downloaded: `${d.pending?.version} downloaded`,
    blocked: `${d.pending?.version} downloaded, blocked: needs admin rights`,
    'restart-needed': `installed, but a Beeper still runs ${oldestRunning(d)} — restart needed`,
  }[state];
  const run = runningText(d);
  return `${node} · Beeper ${d.installed ?? '?'} · ${what}${run ? ` · running ${run}` : ''}`;
}

export function noticeLine(node, d, state, { method, hint, updateCmd }) {
  if (state === 'blocked') return `⬆ ${node} · Beeper ${d.pending.version} downloaded, needs admin rights — run ${updateCmd} (it asks for administrator)`;
  const running = [...new Set((d.running ?? []).map((r) => r.version).filter(Boolean))].join('/') || d.installed;
  return `⬆ ${node} · Beeper ${d.pending.version} downloaded (running ${running}) — ${method === 'auto' ? 'installing at the next quiet moment' : `send ${hint}`}`;
}

export function refusalText(r) {
  if (r?.step === 'permission') return `needs elevation: ${r.remedy}`;
  return `${r?.error ?? 'the update tool gave no answer'}${r?.remedy ? ` — ${r.remedy}` : ''}`;
}

export const startLine = (node, from, to, marker) => `🔄 ${node} · Beeper ${from} → ${to} · restarting for update… ${marker}`;
export const quitLine = (node, from, to) => `⏳ ${node} · Beeper ${from} → ${to}: quit Beeper from the tray (Quit) and the update continues; nothing is stopped until then`;

// The ONE line that replaces the start line: "🔄 kg · Beeper a → b · restarted in 72 s · primary ✓ · secondary ✓".
export function resultLine(node, { from, to, result: r = {} }) {
  const head = `🔄 ${node} · Beeper ${from} → ${to}`;
  const took = r.restartSec != null ? `restarted in ${r.restartSec} s` : null;
  const conns = (r.connections ?? []).map((c) => `${c.name} ${c.status === 'ok' ? '✓' : `✗ ${c.status}`}`);
  return (r.ok ? [head, took, ...conns] : [`${head} · FAILED at ${r.step ?? '?'}: ${refusalText(r)}`, took, ...conns]).filter(Boolean).join(' · ');
}

// The first other node whose recent start line in log_to_group is still open, or null.
export function peerUpdating(messages, { own = new Set(), nowMs = Date.now(), windowMs = PEER_WINDOW_MS } = {}) {
  for (const m of messages ?? []) {
    const hit = /🔄 (\S+) · Beeper [^\n]*· restarting for update…/u.exec(String(m?.text ?? ''));
    if (!hit || own.has(hit[1].toLowerCase())) continue;
    if (m.ts != null && nowMs - m.ts > windowMs) continue;
    return hit[1];
  }
  return null;
}

// ── the .ps1 ─────────────────────────────────────────────────────────────────────────────────
const toolArgv = (repoRoot, home, extra) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(repoRoot, 'src', 'tools', 'beeper-update.ps1'), '-NoElevate', '-EgptHome', home, ...extra];
export const lastJson = (text) => {
  for (const line of String(text ?? '').split(/\r?\n/).reverse()) {
    if (!line.trim().startsWith('{')) continue;
    try { return JSON.parse(line); } catch { /* not ours */ }
  }
  return null;
};

// The plan, touching nothing: { ok, flow, ... } or { ok: false, step, error, remedy }.
export function runToolDry({ repoRoot, home = EGPT_HOME, restartOnly = false, spawn = nodeSpawn, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn('powershell.exe', toolArgv(repoRoot, home, ['-DryRun', ...(restartOnly ? ['-RestartOnly'] : [])]), { windowsHide: true });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.stdout?.on('data', (b) => { out += b; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, step: 'tool', error: e?.message ?? String(e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve(lastJson(out) ?? { ok: false, step: 'tool', error: `the update tool exited ${code} with no plan` }); });
  });
}

// The real run, as a child writing to config/logs/beeper-update.log (a file, so nothing it prints
// depends on this process); resolves with its JSON line once it exits.
// closeAppOnly: only close the open app and wait waitSec for it to quit → { quit: true } or the close-app refusal.
export function runTool({ repoRoot, home = EGPT_HOME, restartOnly = false, closeAppOnly = false, waitSec = CLOSE_TRY_SEC, relaunchApp = false, spawn = nodeSpawn, readFileImpl = readFile, capMs = TOOL_CAP_MS } = {}) {
  const logPath = join(home, 'config', 'logs', 'beeper-update.log');
  mkdirSync(join(home, 'config', 'logs'), { recursive: true });
  const fd = openSync(logPath, 'w');
  const extra = closeAppOnly ? ['-CloseAppOnly', '-WaitSec', String(waitSec)] : [...(restartOnly ? ['-RestartOnly'] : []), ...(relaunchApp ? ['-RelaunchApp'] : [])];
  return new Promise((resolve) => {
    let child;
    try { child = spawn('powershell.exe', toolArgv(repoRoot, home, extra), { stdio: ['ignore', fd, fd], windowsHide: true }); }
    catch (e) { resolve({ ok: false, step: 'tool', error: e?.message ?? String(e) }); return; }
    finally { closeSync(fd); }
    const timer = setTimeout(() => resolve({ ok: false, step: 'tool', error: `no result after ${capMs / 60_000} min — see ${logPath}` }), capMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, step: 'tool', error: e?.message ?? String(e) }); });
    child.on('exit', async (code) => {
      clearTimeout(timer);
      let text = '';
      try { text = String(await readFileImpl(logPath, 'utf8')); } catch { /* none */ }
      resolve(lastJson(text) ?? { ok: false, step: 'tool', error: `the update tool exited ${code} with no result — see ${logPath}` });
    });
  });
}

// ── the service ──────────────────────────────────────────────────────────────────────────────
export function createBeeperUpdate({
  getConfig = () => ({}),
  platform = process.platform,
  home = EGPT_HOME,
  repoRoot = process.cwd(),
  detect: detectFn = (cfg) => detect(cfg),
  dryRun = (o) => runToolDry({ repoRoot, home, ...o }),
  run = (o) => runTool({ repoRoot, home, ...o }),
  drain = null,                       // (fn) => void — boot: the /restart drain, which calls fn instead of exiting
  restartPending = () => false,       // a /restart or /upgrade is draining: it goes first
  beeperRestart = async () => {},     // (on) => sets/clears every bridge's "Beeper restarting for update" state
  logToGroup = async () => false,     // (text) => posts one line to log_to_group
  readLog = async () => [],           // log_to_group's recent messages: [{ id, text, ts }]
  editLog = async () => false,        // (id, text) => bool
  hint = () => '/update beeper',      // what a human types on this node
  ownNames = () => new Set(),         // this node's own names (node_name ∪ node_alias), lowercased
  now = Date.now,
  everyMs = CHECK_EVERY_MS,
  holdCapMs = 3 * 60_000,             // longest a handover hold lasts
  io = { readFile, writeFile, mkdir, rename },
  onLog = () => {},
} = {}) {
  const cfg = () => getConfig() ?? {};
  const node = () => cfg().node_name ?? '?';
  const updateCmd = join(repoRoot, 'src', 'tools', 'beeper-update.cmd');
  const statePath = join(home, 'state', 'beeper-update.json');
  let st = null, ticking = false, lastCheck = null, noted = false;
  let busy = null;   // { kind: 'update' | 'hold', done: Promise, release }: an accepted /update beeper until its line is posted, or a handover hold
  let holdTimer = null;
  const busyText = () => `${node()} · ${busy?.kind === 'hold' ? 'a Beeper handover is under way' : 'a Beeper update is already under way'}`;

  const load = async () => {
    if (!st) { try { st = JSON.parse(String(await io.readFile(statePath, 'utf8'))); } catch { st = {}; } }
    return st;
  };
  const save = async () => {
    await io.mkdir(join(home, 'state'), { recursive: true });
    await io.writeFile(`${statePath}.tmp`, JSON.stringify(st), 'utf8');
    await io.rename(`${statePath}.tmp`, statePath);
  };
  const say = (text) => { onLog(text); return logToGroup(text); };   // the spine log keeps it when log_to_group is unset
  // Edit the line carrying `marker` in place; post `text` when it cannot be found or edited.
  const replaceLine = async (marker, text) => {
    try {
      const hit = (await readLog()).find((m) => m?.id != null && String(m.text ?? '').includes(marker));
      if (hit && (await editLog(hit.id, text))) return true;
    } catch (e) { onLog(`log_to_group read/edit: ${e?.message ?? e}`); }
    return logToGroup(text);
  };

  // The open app quits first, with every bridge still serving: WM_CLOSE; if it only hid, ONE line
  // asking for the tray Quit, then a longer wait. → null once it has quit, else the result to report.
  async function closeApp({ from, to }) {
    try {
      let r = await run({ closeAppOnly: true, waitSec: CLOSE_TRY_SEC });
      if (r?.quit !== true && r?.step === 'close-app') {
        await say(quitLine(node(), from, to));
        r = await run({ closeAppOnly: true, waitSec: CLOSE_WAIT_SEC });
      }
      return r?.quit === true ? null : r;
    } catch (e) { return { ok: false, step: 'tool', error: e?.message ?? String(e) }; }
  }

  // Once the drain finds nothing in flight: peer check, the start line, the app, the restart, the result.
  async function apply({ from, to, restartOnly, appOpen = false }) {
    try {
      let peer = null;
      try { peer = peerUpdating(await readLog(), { own: ownNames(), nowMs: now() }); } catch (e) { onLog(`peer check: ${e?.message ?? e}`); }
      if (peer) {
        await say(`⏸ ${node()} · Beeper ${from} → ${to} not started — ${peer} is restarting its Beeper for an update; send ${hint()} again after its 🔄 line`);
        return;
      }
      const marker = `⟦bu-${node()}-${now().toString(36)}⟧`;
      await say(startLine(node(), from, to, marker));
      let result = appOpen ? await closeApp({ from, to }) : null;
      if (!result) {
        try { await beeperRestart(true); result = await run({ restartOnly, relaunchApp: appOpen }); }
        catch (e) { result = { ok: false, step: 'tool', error: e?.message ?? String(e) }; }
        finally { await beeperRestart(false); }
      }
      const line = resultLine(node(), { from, to, result });
      onLog(line);
      await replaceLine(marker, line);
    } catch (e) { onLog(`update: ${e?.message ?? e}`); }
    finally { const b = busy; busy = null; b?.release(); }
  }

  // { started, text }: refused or not needed → the one-line reason; started → the drain is under way.
  async function start() {
    const m = autoUpdateMethod(cfg(), platform);
    if (m.os !== 'windows') return { started: false, text: `${node()} · Beeper updates are not implemented on ${m.os} yet` };
    if (busy) return { started: false, text: busyText() };
    if (restartPending()) return { started: false, text: `${node()} · a restart is pending — send ${hint()} after it` };
    const d = await detectFn(cfg());
    const state = stateOf(d);
    if (state !== 'downloaded' && state !== 'restart-needed') return { started: false, text: `${statusLine(node(), d, state)}${state === 'blocked' ? ` — run ${updateCmd} (it asks for administrator)` : ''}` };
    const restartOnly = state === 'restart-needed';
    const from = restartOnly ? oldestRunning(d) : d.installed;
    const to = restartOnly ? d.installed : d.pending.version;
    const plan = await dryRun({ restartOnly });
    if (!plan?.ok) return { started: false, text: `${node()} · Beeper ${to} not installed: ${refusalText(plan)}` };
    if (typeof drain !== 'function') return { started: false, text: `${node()} · Beeper ${to}: no drain on this node — run ${updateCmd}` };
    if (busy) return { started: false, text: busyText() };
    let release;
    busy = { kind: 'update', done: new Promise((r) => { release = r; }), release };
    drain(() => { apply({ from, to, restartOnly, appOpen: !!plan.closeApp }); });
    return { started: true, text: `⏳ ${node()} · Beeper ${from} → ${to}: restarting Beeper for the update once turns finish (about a minute, ${plan.flow} flow); the result goes to log_to_group` };
  }

  // Beeper handover (setup/beeper-window.ps1 via ingest): the update's restart state, sharing its busy.
  async function hold(on) {
    if (!on) {
      if (busy?.kind !== 'hold') return false;
      clearTimeout(holdTimer);
      holdTimer = null;
      try { await beeperRestart(false); }
      finally { const b = busy; busy = null; b.release(); }
      return true;
    }
    if (busy) { onLog(`hold refused: ${busy.kind === 'hold' ? 'already held' : 'an update is under way'}`); return false; }
    let release;
    busy = { kind: 'hold', done: new Promise((r) => { release = r; }), release };
    try { await beeperRestart(true); }
    catch (e) { onLog(`hold: ${e?.message ?? e}`); await hold(false); return false; }
    holdTimer = setTimeout(() => {
      onLog(`hold released by its ${holdCapMs / 1000} s cap`);
      hold(false).catch((e) => onLog(`hold cap: ${e?.message ?? e}`));
    }, holdCapMs);
    return true;
  }

  // At boot, every 6 h: ONE notice per newly downloaded version; auto installs it.
  async function check() {
    const m = autoUpdateMethod(cfg(), platform);
    if (m.method === 'none') return null;
    const d = await detectFn(cfg());
    const state = stateOf(d);
    await load();
    if ((state === 'downloaded' || state === 'blocked') && st.noticed !== d.pending.version) {
      st.noticed = d.pending.version;
      await save();
      await say(noticeLine(node(), d, state, { method: m.method, hint: hint(), updateCmd }));
    }
    const key = state === 'downloaded' ? d.pending.version : state === 'restart-needed' ? `restart-${d.installed}` : null;
    if (m.method === 'auto' && key && st.autoTried !== key && !busy) {
      st.autoTried = key;
      await save();
      const r = await start();
      if (!r.started) await say(r.text);   // refused: said once per version
    }
    return state;
  }

  function tick(nowMs = now()) {
    if (!noted) { noted = true; const n = autoUpdateMethod(cfg(), platform).note; if (n) onLog(n); }
    if (ticking || (lastCheck != null && nowMs - lastCheck < everyMs)) return;
    ticking = true;
    lastCheck = nowMs;
    Promise.resolve().then(check).catch((e) => onLog(`check: ${e?.message ?? e}`)).finally(() => { ticking = false; });
  }

  return {
    tick, check, hold,
    update: async () => (await start()).text,
    busy: () => !!busy,
    idle: () => busy?.done ?? Promise.resolve(),
  };
}
