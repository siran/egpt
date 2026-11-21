// beeper-update.mjs — keeping Beeper Desktop current: detection, the log_to_group notice, and
// `/update beeper`. The install itself is platform-specific: beeper-update.ps1 beside this file on
// Windows; on Linux (the docker node) the feed's AppImage unpacked onto the volume (runLinux); on a
// Mac the feed's zip swapped in for the app bundle (runMac).
//
// config: beeper.auto_update.<windows|linux|mac>.method = auto | manual | none (config-schema.mjs).
// A controlled Beeper restart, the spine stays up (operator 2026-10-19): drain like /restart without
// exiting → every bridge enters its "Beeper restarting for update" state (calls wait, no redial, no
// ear verdict) → the install tool runs → the state clears (redial now, held calls go) → ONE line.
import { readFile, writeFile, mkdir, rename, rm, readdir, mkdtemp, chmod, access } from 'node:fs/promises';
import { openSync, closeSync, mkdirSync, createReadStream, createWriteStream, constants as fsConstants } from 'node:fs';
import { join, basename, dirname, posix } from 'node:path';
import { homedir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { spawn as nodeSpawn, execFile } from 'node:child_process';
import { EGPT_HOME } from '../egpt-home.mjs';
import { beeperBlockOf } from './config-io.mjs';

export const AUTO_UPDATE_METHODS = ['auto', 'manual', 'none'];
export const CHECK_EVERY_MS = 6 * 3_600_000;
const TOOL_CAP_MS = 20 * 60_000;              // longest the bridges hold for the tool
const DOWNLOAD_CAP_MS = 20 * 60_000;          // longest the installer download may take
export const CLOSE_TRY_SEC = 30;              // the open app: WM_CLOSE, this long to quit; then its process tree is ended
const OS_OF = { win32: 'windows', linux: 'linux', darwin: 'mac' };
const DEFAULT_METHOD = { windows: 'auto', linux: 'auto', mac: 'auto' };
const IMPLEMENTED = ['windows', 'linux', 'mac'];   // the OSes that can install a Beeper update
const APPLICABLE = ['downloaded', 'restart-needed', 'available'];   // the states /update beeper acts on
const PORTS = Array.from({ length: 10 }, (_, i) => 23373 + i);   // boot's DISCOVERY_PORTS
const FEED = 'https://api.beeper.com/desktop/update-feed.json';
const BUNDLE_ID = 'com.automattic.beeper.desktop';
const UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\4005ec12-b235-5981-b49e-4005d478a398';

// { os, method, note }: the method this node runs; note = the one boot log line when it differs from what is configured.
export function autoUpdateMethod(cfg, platform = process.platform) {
  const os = OS_OF[platform] ?? platform;
  const raw = beeperBlockOf(cfg)?.auto_update?.[os]?.method;
  const method = raw == null ? (DEFAULT_METHOD[os] ?? 'none') : String(raw).trim().toLowerCase();
  if (!AUTO_UPDATE_METHODS.includes(method)) return { os, method: 'none', note: `beeper.auto_update.${os}.method "${raw}" is not auto | manual | none — treated as none` };
  if (!IMPLEMENTED.includes(os) && method !== 'none') return { os, method: 'none', note: `beeper.auto_update.${os}.method is ${method}: Beeper updates are not implemented on ${os} yet — treated as none` };
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

// The registry's DisplayVersion of the per-user install; on Linux the version the entrypoint would launch;
// on a Mac the app bundle's.
export function readInstalledVersion({ platform = process.platform, home } = {}) {
  if (platform === 'linux') return readInstalledLinux({ home });
  if (platform === 'darwin') return readInstalledMac();
  if (platform !== 'win32') return Promise.resolve(null);
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

// The update feed's JSON (204 = nothing newer). A Mac gets its own architecture's zip; everywhere else x64.
export async function readLatest(installed, { fetchImpl = fetch, platform = 'win32', arch = process.arch } = {}) {
  const q = new URLSearchParams({ bundleID: BUNDLE_ID, version: installed ?? '0.0.0', platform, arch: platform === 'darwin' && arch === 'arm64' ? 'arm64' : 'x64', channel: 'stable' });
  const r = await getJson(fetchImpl, `${FEED}?${q}`, { timeoutMs: 10_000 });
  if (r.status === 204) return { version: installed, date: null };
  return r.json?.version ? { version: r.json.version, date: r.json.pub_date ?? null, url: r.json.url ?? null, sha512: r.json.sha512 ?? null } : null;
}

// sha512 as base64, the feed's encoding.
async function sha512Of(path) {
  const h = createHash('sha512');
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest('base64');
}

// The feed's installer into dir, verified → { ok, path } | { ok: false, error }. Never Beeper's own
// pending folder: its updater empties that (kg 2026-10-30). onStart(mb): the download begins.
export async function fetchInstaller({ url, sha512 }, { dir, fetchImpl = fetch, onStart = () => {} } = {}) {
  if (!url || !sha512) return { ok: false, error: 'the update feed names no installer url and sha512' };
  const path = join(dir, basename(decodeURIComponent(new URL(url).pathname)));
  if ((await sha512Of(path).catch(() => null)) === sha512) return { ok: true, path };
  const part = `${path}.part`;
  try {
    await mkdir(dir, { recursive: true });
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_CAP_MS) });
    if (res.status !== 200 || !res.body) throw new Error(`the installer download answered ${res.status}`);
    await onStart(Math.round(Number(res.headers?.get('content-length') ?? 0) / 2 ** 20));
    await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
    if ((await sha512Of(part)) !== sha512) throw new Error('the download does not match the feed\'s sha512 — deleted');
    await rename(part, path);
    return { ok: true, path };
  } catch (e) {
    await rm(part, { force: true });
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export async function detect(cfg, { fetchImpl = fetch, installedVersion = readInstalledVersion, localAppData, platform = process.platform, arch, home } = {}) {
  const installed = await installedVersion({ platform, home });
  const [pending, running, latest] = await Promise.all([platform === 'win32' ? readPending({ localAppData }) : null, readRunning(cfg, { fetchImpl }), readLatest(installed, { fetchImpl, platform, arch })]);
  return { installed, pending, running, latest };
}

// ── the lines ──────────────────────────────────────────────────────────────────────────────────
const runningText = (d) => (d.running ?? []).map((r) => `${r.name ?? 'other'} ${r.version ?? '?'}${r.port ? ` :${r.port}` : ' no port'}`).join(', ');
const oldestRunning = (d) => (d.running ?? []).map((r) => r.version).filter(Boolean).sort(cmpVersion)[0] ?? d.installed;

export function statusLine(node, d, state = stateOf(d), hint = '/update beeper') {
  const what = {
    'up-to-date': 'up to date',
    available: `${d.latest?.version} available — ${hint} downloads and installs it`,
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

export const downloadLine = (node, from, to, mb) => `⬇ ${node} · Beeper ${from} → ${to}: downloading the installer${mb ? ` (${mb} MB)` : ''} first`;
export const startLine = (node, from, to, marker) => `🔄 ${node} · Beeper ${from} → ${to} · restarting for update… ${marker}`;

// The ONE line that replaces the start line: "🔄 kg · Beeper a → b · restarted in 72 s · primary ✓ · secondary ✓".
export function resultLine(node, { from, to, result: r = {} }) {
  const head = `🔄 ${node} · Beeper ${from} → ${to}`;
  const took = r.restartSec != null ? `restarted in ${r.restartSec} s` : null;
  const conns = (r.connections ?? []).map((c) => `${c.name} ${c.status === 'ok' ? '✓' : `✗ ${c.status}`}`);
  return (r.ok ? [head, took, ...conns] : [`${head} · FAILED at ${r.step ?? '?'}: ${refusalText(r)}`, took, ...conns]).filter(Boolean).join(' · ');
}

// ── the .ps1 ─────────────────────────────────────────────────────────────────────────────────
const installerArgs = (installer, sha512) => (installer ? ['-Installer', installer, '-Sha512', sha512] : []);
const toolArgv = (repoRoot, home, extra) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(repoRoot, 'src', 'tools', 'beeper-update.ps1'), '-NoElevate', '-EgptHome', home, ...extra];
export const lastJson = (text) => {
  for (const line of String(text ?? '').split(/\r?\n/).reverse()) {
    if (!line.trim().startsWith('{')) continue;
    try { return JSON.parse(line); } catch { /* not ours */ }
  }
  return null;
};

// The plan, touching nothing: { ok, flow, ... } or { ok: false, step, error, remedy }.
export function runToolDry({ repoRoot, home = EGPT_HOME, restartOnly = false, installer = null, sha512 = null, spawn = nodeSpawn, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn('powershell.exe', toolArgv(repoRoot, home, ['-DryRun', ...(restartOnly ? ['-RestartOnly'] : []), ...installerArgs(installer, sha512)]), { windowsHide: true });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.stdout?.on('data', (b) => { out += b; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, step: 'tool', error: e?.message ?? String(e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve(lastJson(out) ?? { ok: false, step: 'tool', error: `the update tool exited ${code} with no plan` }); });
  });
}

// The real run, as a child writing to config/logs/beeper-update.log (a file, so nothing it prints
// depends on this process); resolves with its JSON line once it exits.
// closeAppOnly: only close the open app (WM_CLOSE, waitSec; still there: its process tree ended) → { quit: true } or the close-app refusal.
// installer + sha512: install that file (eGPT's own download), not Beeper's pending one.
export function runTool({ repoRoot, home = EGPT_HOME, restartOnly = false, closeAppOnly = false, waitSec = CLOSE_TRY_SEC, relaunchApp = false, installer = null, sha512 = null, spawn = nodeSpawn, readFileImpl = readFile, capMs = TOOL_CAP_MS } = {}) {
  const logPath = join(home, 'config', 'logs', 'beeper-update.log');
  mkdirSync(join(home, 'config', 'logs'), { recursive: true });
  const fd = openSync(logPath, 'w');
  const extra = closeAppOnly ? ['-CloseAppOnly', '-WaitSec', String(waitSec)] : [...(restartOnly ? ['-RestartOnly'] : []), ...(relaunchApp ? ['-RelaunchApp'] : []), ...installerArgs(installer, sha512)];
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

// ── Linux: the AppImage unpacked onto the volume ─────────────────────────────────────────────────
// The image ships Beeper in /opt/beeper (read-only). docker/entrypoint.sh's beeper_bin launches the
// newest $EGPT_HOME/beeper/<version>/beepertexts instead when it is newer than the image's, on every
// keep_running relaunch. So an update = the feed's AppImage unpacked there, then the Beeper main processes killed.
export const ENTRYPOINT_MARKER = 'beeper_bin()';   // in the entrypoint that launches from the volume
const ENTRYPOINT = '/usr/local/bin/egpt-entrypoint';
const IMAGE_DIR = '/opt/beeper';
const KEEP_VERSIONS = 2;                           // on the volume after an update: the new one and the one before
const RESTART_CAP_MS = 3 * 60_000;                 // longest the restarted Beepers have to report the new version
const POLL_MS = 5_000;
const EXTRACT_PREFIX = '.extract-';                // an unpack in progress, beside the versions

// The versions unpacked on the volume that the entrypoint could launch, newest first.
async function volumeVersions(home) {
  const dir = join(home, 'beeper');
  const names = (await readdir(dir).catch(() => [])).filter((v) => /^\d+(\.\d+)*$/.test(v));
  const ok = await Promise.all(names.map((v) => access(join(dir, v, 'beepertexts'), fsConstants.X_OK).then(() => v, () => null)));
  return ok.filter(Boolean).sort((a, b) => cmpVersion(b, a));
}

const desktopVersion = async (dir) => (/^X-AppImage-Version=(\S+)/m.exec(await readFile(join(dir, 'beepertexts.desktop'), 'utf8').catch(() => '')) ?? [])[1] ?? null;

// The version the entrypoint (beeper_bin) would launch: the highest of the volume's and the image's own; a tie is the image's.
export async function readInstalledLinux({ home = EGPT_HOME, imageDir = IMAGE_DIR } = {}) {
  const volume = (await volumeVersions(home))[0] ?? null, image = await desktopVersion(imageDir);
  return newer(volume, image) || !image ? volume : image;
}

// The dry run: does the image's entrypoint launch Beeper from the volume? → { ok, flow } | { ok: false, step, error, remedy }.
export async function runLinuxDry({ entrypoint = ENTRYPOINT } = {}) {
  if ((await readFile(entrypoint, 'utf8').catch(() => '')).includes(ENTRYPOINT_MARKER)) return { ok: true, flow: 'volume' };
  return { ok: false, step: 'entrypoint', error: 'this image launches Beeper from /opt/beeper only', remedy: 'rebuild the image (docker/aws/build-push.sh) once' };
}

// `<appImage> --appimage-extract` in cwd → cwd/squashfs-root (no FUSE needed; it lists every file, so stdout is dropped).
const extractAppImage = (appImage, cwd) => new Promise((resolve, reject) => {
  const child = nodeSpawn(appImage, ['--appimage-extract'], { cwd, stdio: ['ignore', 'ignore', 'pipe'], timeout: 5 * 60_000 });
  let err = '';
  child.stderr.on('data', (b) => { err = (err + b).slice(-500); });
  child.on('error', reject);
  child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${basename(appImage)} --appimage-extract exited ${code}: ${err.trim()}`))));
});

// The Beeper main processes under dirs: argv[0] a beepertexts there, no --type= (the children go with their main).
export async function beeperMains(dirs, procDir = '/proc') {
  const found = await Promise.all((await readdir(procDir)).filter((p) => /^\d+$/.test(p)).map(async (p) => {
    const argv = String(await readFile(join(procDir, p, 'cmdline'), 'utf8').catch(() => '')).split('\0');
    return basename(argv[0]) === 'beepertexts' && dirs.some((d) => argv[0].startsWith(`${d}/`)) && !argv.some((a) => a.startsWith('--type=')) ? Number(p) : null;
  }));
  return found.filter(Boolean);
}

// The AppImage unpacked as $EGPT_HOME/beeper/<its version> (temp directory beside it, one rename), then deleted → the version.
// An unpack that crashed leaves its temp directory (~500 MB): removed first.
async function unpack(installer, { home, extract }) {
  const root = join(home, 'beeper');
  await mkdir(root, { recursive: true });
  for (const n of (await readdir(root)).filter((n) => n.startsWith(EXTRACT_PREFIX))) await rm(join(root, n), { recursive: true, force: true });
  const work = await mkdtemp(join(root, EXTRACT_PREFIX));
  try {
    await chmod(installer, 0o755);
    await extract(installer, work);
    const version = await desktopVersion(join(work, 'squashfs-root'));
    if (!version) throw new Error(`${basename(installer)} unpacked without an X-AppImage-Version`);
    await rename(join(work, 'squashfs-root'), join(root, version));
    await rm(installer, { force: true });
    return version;
  } finally { await rm(work, { recursive: true, force: true }); }
}

// The real run, the .ps1's result shape: unpack the AppImage (installer; none = restart only), kill the Beeper main
// processes so keep_running relaunches them on the newest, wait until every Beeper that was answering /v1/info
// reports that version, then keep only the newest two on the volume. running() = readRunning's [{ name, port, version }].
export async function runLinux({
  home = EGPT_HOME, installer = null, running, imageDir = IMAGE_DIR,
  extract = extractAppImage, mains = () => beeperMains([imageDir, join(home, 'beeper')]), kill = (pid) => process.kill(pid, 'SIGTERM'),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, capMs = RESTART_CAP_MS,
} = {}) {
  let step = 'extract';
  try {
    const to = installer ? await unpack(installer, { home, extract }) : await readInstalledLinux({ home, imageDir });
    step = 'restart';
    const before = (await running()).filter((r) => r.port);
    const t0 = now();
    for (const pid of await mains()) kill(pid);
    let connections;
    for (;;) {
      const live = await running();
      connections = before.map((b) => {
        const v = live.find((r) => r.port === b.port)?.version;
        return { name: b.name ?? `:${b.port}`, status: v === to ? 'ok' : `still ${v ?? 'down'}` };
      });
      if (connections.every((c) => c.status === 'ok') || now() - t0 >= capMs) break;
      await sleep(POLL_MS);
    }
    const restartSec = Math.round((now() - t0) / 1000);
    if (!connections.every((c) => c.status === 'ok')) return { ok: false, step, error: `not every Beeper reported ${to} within ${capMs / 60_000} min`, restartSec, connections };
    for (const v of (await volumeVersions(home)).slice(KEEP_VERSIONS)) await rm(join(home, 'beeper', v), { recursive: true, force: true });
    return { ok: true, restartSec, connections };
  } catch (e) { return { ok: false, step, error: e?.message ?? String(e) }; }
}

// ── Mac: the feed's zip swapped in for the app bundle ──────────────────────────────────────────────
// Beeper Desktop.app in /Applications or ~/Applications. An update = the zip unpacked (ditto) into a hidden
// folder beside the app, the Beeper main processes quit, the bundle swapped in by rename, the same mains opened
// again. macOS 13+ guards app bundles (App Management): the dry run writes one probe file into the bundle and
// removes it, so a node without that permission is refused before anything quits.
const APP_NAME = 'Beeper Desktop.app';
const STAGE_PREFIX = '.beeper-update-';            // an unpack in progress, beside the app
const QUIT_CAP_MS = 60_000;                        // longest the mains have to quit before SIGKILL
const QUIT_POLL_MS = 1_000;
const appCandidates = (home = homedir()) => ['/Applications', join(home, 'Applications')].map((d) => join(d, APP_NAME));
const execFileP = (file, args, timeout = 5 * 60_000) => new Promise((resolve, reject) => execFile(file, args, { timeout }, (err, stdout, stderr) => {
  if (err) reject(new Error(`${file} ${args[0]}: ${String(stderr).trim() || err.message}`));
  else resolve(String(stdout));
}));

const plistValue = (xml, key) => (new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(xml) ?? [])[1] ?? null;
// { id, version } from an app bundle's Info.plist (electron-builder writes it as XML).
async function bundleInfo(app) {
  const xml = await readFile(join(app, 'Contents', 'Info.plist'), 'utf8').catch(() => '');
  return { id: plistValue(xml, 'CFBundleIdentifier'), version: plistValue(xml, 'CFBundleShortVersionString') };
}

// The first candidate that is Beeper's bundle → { app, version } | null.
export async function findMacApp({ candidates = appCandidates() } = {}) {
  for (const app of candidates) {
    const i = await bundleInfo(app);
    if (i.id === BUNDLE_ID && i.version) return { app, version: i.version };
  }
  return null;
}
export const readInstalledMac = async (o) => (await findMacApp(o))?.version ?? null;

// The dry run: the app found, its folder and bundle writable by this process → { ok, flow } | { ok: false, step, error, remedy }.
export async function runMacDry({ candidates = appCandidates(), io = { access, writeFile, rm } } = {}) {
  const found = await findMacApp({ candidates });
  if (!found) return { ok: false, step: 'find-app', error: `no ${APP_NAME} of ${BUNDLE_ID} in ${candidates.map(dirname).join(' or ')}`, remedy: 'install Beeper Desktop there' };
  const probe = join(found.app, 'Contents', '.egpt-update-probe');
  try {
    await io.access(dirname(found.app), fsConstants.W_OK);
    await io.writeFile(probe, '');
    await io.rm(probe, { force: true });
  } catch (e) {
    return { ok: false, step: 'bundle', error: `${found.app} is not writable by this process (${e?.code ?? e?.message ?? e})`, remedy: 'give the app that runs eGPT App Management (System Settings → Privacy & Security → App Management)' };
  }
  return { ok: true, flow: 'bundle' };
}

// The Beeper main processes of app: `ps` lines starting with its Contents/MacOS/ executable (the helpers live
// under Contents/Frameworks/), never --type= → [{ pid, args }], args = the main's own flags, kept for the reopen.
// A flag value holding " -" would split in two: ps joins argv with spaces.
export async function macMains(app, { ps = () => execFileP('ps', ['-axww', '-o', 'pid=,args=']) } = {}) {
  const exe = `${posix.join(app, 'Contents', 'MacOS')}/`;
  return String(await ps()).split('\n').map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter((m) => m && m[2].startsWith(exe) && !/\s--type=/.test(m[2])).map(([, pid, cmd]) => {
    const rest = cmd.slice(exe.length), at = rest.search(/\s-/);
    return { pid: Number(pid), args: at < 0 ? [] : rest.slice(at + 1).split(/\s+(?=-)/).filter((a) => !a.startsWith('-psn_')) };
  });
}

// `open` arguments that bring each quit main back: a plain one as the app itself, one with flags as a new instance with them.
export const reopenArgs = (app, quit) => [...new Map(quit.map((m) => [m.args.join('\0'), m.args.length ? ['-n', '-g', '-a', app, '--args', ...m.args] : ['-g', '-a', app]])).values()];

// The real run, the .ps1's result shape: unzip the installer beside the app (none = restart only), quit the Beeper
// mains (SIGTERM, SIGKILL after the cap), swap the bundle, open them again, wait until every Beeper that was
// answering /v1/info reports the new version. The old bundle and the zip go once it is swapped in.
export async function runMac({
  installer = null, running, candidates = appCandidates(),
  unzip = (zip, dir) => execFileP('ditto', ['-x', '-k', zip, dir]), mains = macMains, kill = (pid, sig) => process.kill(pid, sig),
  alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }, open = (args) => execFileP('open', args),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, capMs = RESTART_CAP_MS, quitCapMs = QUIT_CAP_MS,
} = {}) {
  let step = 'find-app', app = null, stage = null;
  try {
    const found = await findMacApp({ candidates });
    if (!found) throw new Error(`no ${APP_NAME} of ${BUNDLE_ID} to update`);
    app = found.app;
    let to = found.version, fresh = null;
    if (installer) {
      step = 'extract';
      const parent = dirname(app);
      for (const n of (await readdir(parent)).filter((n) => n.startsWith(STAGE_PREFIX))) await rm(join(parent, n), { recursive: true, force: true });
      stage = await mkdtemp(join(parent, STAGE_PREFIX));
      await unzip(installer, stage);
      fresh = join(stage, APP_NAME);
      const i = await bundleInfo(fresh);
      if (i.id !== BUNDLE_ID || !i.version) throw new Error(`${basename(installer)} unpacked without ${APP_NAME} of ${BUNDLE_ID}`);
      to = i.version;
    }
    step = 'quit';
    const before = (await running()).filter((r) => r.port);
    const t0 = now();
    const quit = await mains(app);
    for (const m of quit) kill(m.pid, 'SIGTERM');
    while (quit.some((m) => alive(m.pid)) && now() - t0 < quitCapMs) await sleep(QUIT_POLL_MS);
    for (const m of quit) if (alive(m.pid)) kill(m.pid, 'SIGKILL');
    if (fresh) {
      step = 'swap';
      const old = join(stage, `old-${APP_NAME}`);
      try {
        await rename(app, old);
        try { await rename(fresh, app); } catch (e) { await rename(old, app); throw e; }
      } catch (e) {
        for (const args of reopenArgs(app, quit)) await open(args).catch(() => {});   // the old one back, as it was
        throw e;
      }
      await rm(installer, { force: true });
    }
    step = 'restart';
    for (const args of reopenArgs(app, quit)) await open(args);
    let connections;
    for (;;) {
      const live = await running();
      connections = before.map((b) => {
        const v = live.find((r) => r.port === b.port)?.version;
        return { name: b.name ?? `:${b.port}`, status: v === to ? 'ok' : `still ${v ?? 'down'}` };
      });
      if (connections.every((c) => c.status === 'ok') || now() - t0 >= capMs) break;
      await sleep(POLL_MS);
    }
    const restartSec = Math.round((now() - t0) / 1000);
    if (!connections.every((c) => c.status === 'ok')) return { ok: false, step, error: `not every Beeper reported ${to} within ${capMs / 60_000} min`, restartSec, connections };
    return { ok: true, restartSec, connections };
  } catch (e) { return { ok: false, step, error: e?.message ?? String(e) }; }
  finally {
    // the stage holds the unzipped app, or the old one once swapped; never removed while the app itself is missing
    if (stage && (await bundleInfo(app)).id === BUNDLE_ID) await rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}

// ── the service ──────────────────────────────────────────────────────────────────────────────
export function createBeeperUpdate({
  getConfig = () => ({}),
  platform = process.platform,
  home = EGPT_HOME,
  repoRoot = process.cwd(),
  detect: detectFn = (cfg) => detect(cfg, { platform, home }),
  dryRun = (o) => (platform === 'linux' ? runLinuxDry() : platform === 'darwin' ? runMacDry() : runToolDry({ repoRoot, home, ...o })),
  run = (o) => {
    const running = () => readRunning(getConfig() ?? {}, { fetchImpl });
    return platform === 'linux' ? runLinux({ home, running, ...o }) : platform === 'darwin' ? runMac({ running, ...o }) : runTool({ repoRoot, home, ...o });
  },
  drain = null,                       // (fn) => void — boot: the /restart drain, which calls fn instead of exiting
  restartPending = () => false,       // a /restart or /upgrade is draining: it goes first
  beeperRestart = async () => {},     // (on) => sets/clears every bridge's "Beeper restarting for update" state
  logToGroup = async () => false,     // (text) => posts one line to log_to_group
  readLog = async () => [],           // log_to_group's recent messages: [{ id, text, ts }]
  editLog = async () => false,        // (id, text) => bool
  hint = () => '/update beeper',      // what a human types on this node
  fetchImpl = fetch,                  // the installer download (state available)
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
  let downloading = false;
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

  // The open app goes first, with every bridge still serving: WM_CLOSE, else its process tree ended
  // (Close-BeeperApp). → null once it is gone, else the result to report.
  async function closeApp() {
    try {
      const r = await run({ closeAppOnly: true, waitSec: CLOSE_TRY_SEC });
      return r?.quit === true ? null : r;
    } catch (e) { return { ok: false, step: 'tool', error: e?.message ?? String(e) }; }
  }

  // What applying does: a restart (a running Beeper is older than the install) or an install, from → to.
  const stepOf = (d, state) => {
    const restartOnly = state === 'restart-needed';
    return { restartOnly, from: restartOnly ? oldestRunning(d) : d.installed, to: restartOnly ? d.installed : state === 'available' ? d.latest.version : d.pending.version };
  };

  // Once the drain finds nothing in flight: the start line, the app, the restart, the result.
  async function apply({ from, to, restartOnly, appOpen = false, own = {} }) {
    try {
      const marker = `⟦bu-${node()}-${now().toString(36)}⟧`;
      await say(startLine(node(), from, to, marker));
      let result = appOpen ? await closeApp() : null;
      if (!result) {
        try { await beeperRestart(true); result = await run({ restartOnly, relaunchApp: appOpen, ...own }); }
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
  // progress(text): a line before the reply (the download starting).
  async function start(progress = () => {}) {
    const m = autoUpdateMethod(cfg(), platform);
    if (!IMPLEMENTED.includes(m.os)) return { started: false, text: `${node()} · Beeper updates are not implemented on ${m.os} yet` };
    if (busy || downloading) return { started: false, text: busyText() };
    if (restartPending()) return { started: false, text: `${node()} · a restart is pending — send ${hint()} after it` };
    const d = await detectFn(cfg());
    const state = stateOf(d);
    if (!APPLICABLE.includes(state)) return { started: false, text: `${statusLine(node(), d, state, hint())}${state === 'blocked' ? ` — run ${updateCmd} (it asks for administrator)` : ''}` };
    const { restartOnly, from, to } = stepOf(d, state);
    let own = {};   // available: eGPT's own download, as -Installer/-Sha512
    if (state === 'available') {
      downloading = true;
      let got;
      try { got = await fetchInstaller(d.latest, { dir: join(home, 'state', 'beeper-update'), fetchImpl, onStart: (mb) => progress(downloadLine(node(), from, to, mb)) }); }
      finally { downloading = false; }
      if (!got.ok) return { started: false, text: `${node()} · Beeper ${to} not downloaded: ${got.error}` };
      own = { installer: got.path, sha512: d.latest.sha512 };
    }
    const plan = await dryRun({ restartOnly, ...own });
    if (!plan?.ok) return { started: false, text: `${node()} · Beeper ${to} not installed: ${refusalText(plan)}` };
    if (typeof drain !== 'function') return { started: false, text: `${node()} · Beeper ${to}: no drain on this node — run ${updateCmd}` };
    if (busy) return { started: false, text: busyText() };
    let release;
    busy = { kind: 'update', done: new Promise((r) => { release = r; }), release };
    drain(() => { apply({ from, to, restartOnly, appOpen: !!plan.closeApp, own }); });
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

  // What the operator could apply now: { from, to, hint } (hint = the command), else null. Changes nothing.
  async function pending() {
    if (autoUpdateMethod(cfg(), platform).method === 'none') return null;
    const d = await detectFn(cfg());
    const state = stateOf(d);
    if (!APPLICABLE.includes(state)) return null;
    const { from, to } = stepOf(d, state);
    return { from, to, hint: hint() };
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
    const key = state === 'downloaded' ? d.pending.version : state === 'restart-needed' ? `restart-${d.installed}` : state === 'available' ? `available-${d.latest.version}` : null;
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
    tick, check, hold, pending,
    update: async (progress) => (await start(progress)).text,
    busy: () => !!busy,
    idle: () => busy?.done ?? Promise.resolve(),
  };
}
