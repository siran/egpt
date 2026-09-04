// beeper-whoami.mjs — WHICH Beeper Desktop is on which port, and whose account it is.
//
// A node now runs TWO Beeper Desktops at once: the agent's, in SESSION 0 under a service,
// and the operator's GUI in SESSION 1. They are the same binary, often the same account, and
// they differ only by PORT — Beeper takes the next free one, so which Desktop holds 23373 is
// decided by BOOT ORDER and INVERTS the moment a GUI starts before the service. Guessing that
// mapping is the expensive mistake: a spine pointed at the wrong Desktop throws no error, it
// just answers in the operator's own groups as the wrong person.
//
// The claim this tool exists to retire (2026-09-03) is that Session 0 is opaque from a logged-in
// session — "owner unreadable from here, my token can't query across the boundary". It is not:
// LOOPBACK IS MACHINE-WIDE, NOT SESSION-SCOPED, so a Session 0 Desktop's API on 127.0.0.1
// answers Session 1 exactly as it answers the spine. What is actually per-install is the TOKEN:
// a token is minted by, and belongs to, ONE INSTALL, so the S1 GUI's token 401s against the S0
// Desktop and vice versa. That 401 is not a failure here — it is the CHEAPEST PROOF of which
// install owns a port, so this tool tries every token it knows against every port and reports
// the whole matrix.
//
//   node src/tools/beeper-whoami.mjs                       # THE MAP: one table, every port, and
//                                                          #   every peer named in egpt_nodes
//   node src/tools/beeper-whoami.mjs --host <ssh target>   # ...plus a node config does not name
//   node src/tools/beeper-whoami.mjs --detail              # the full token x port matrix below
//   node src/tools/beeper-whoami.mjs --detail 23373 23380  # plus any extra ports to probe
//   node src/tools/beeper-whoami.mjs --json                # the table's rows, machine-readable
//
// Read-only: it GETs /v1/accounts and asks the OS who owns the socket. It changes nothing.
//
// PORTABILITY: the PROBE half is plain fetch and runs anywhere node runs, which is why boot.mjs
// can import it — eGPT is OS-agnostic by design and the spine must never acquire a platform.
// Only the socket-OWNER half (localOwners, below) is Windows-specific, it is guarded by a
// platform check, and its child_process import is INSIDE the function so importing this module
// costs nothing on Linux or macOS. Elsewhere the tool still reports every account and every
// 401 — it just cannot name the pid or the session.
import { pathToFileURL } from 'node:url';
import { hostname, networkInterfaces } from 'node:os';
import { readConfigSync } from './config-io.mjs';

const DEFAULT_PORTS = [23373, 23374, 23375 - 1];   // the two Desktops, and 23372 in case a third install ever lands below them
const TIMEOUT_MS = 6000;

// The connections named in config.yaml: `beeper.<name>` with a token, `use` excluded (it is a
// pointer, not a connection). base_url absent ⇒ the bridge default, which is what the spine
// would ride — so it is reported as the default, never as "unset".
export function connectionsOf(cfg = {}) {
  const b = cfg.beeper;
  if (!b || typeof b !== 'object') return [];
  // A CONNECTION MAY CARRY SEVERAL CANDIDATE ENDPOINTS (`endpoints:`), and each has its OWN
  // token — that is the whole point of the shape: one account, several installs, and the spine
  // binds whichever answers. Flattening them here means every token this node holds gets tried,
  // which is what makes the difference between "that install refused us" and "we never asked"
  // reportable at all. Reading only the top-level `token` silently loses every candidate and
  // then reports a perfectly healthy install as NOT LOGGED IN — measured live, 2026-09-04.
  const rows = [];
  for (const [name, v] of Object.entries(b)) {
    if (name === 'use' || !v || typeof v !== 'object') continue;
    const eps = Array.isArray(v.endpoints) && v.endpoints.length ? v.endpoints : null;
    const common = { account: v.account ?? null, ownerNode: v.owner_node ?? null, isUse: b.use === name };
    if (!eps) {
      rows.push({ name, baseUrl: v.base_url ?? 'http://127.0.0.1:23373', token: v.token ?? null, ...common });
      continue;
    }
    // Labelled by their port so the operator can tell two candidates of ONE connection apart —
    // `main` alone would print twice and look like a bug.
    eps.forEach((e, i) => {
      const baseUrl = e?.base_url ?? 'http://127.0.0.1:23373';
      let tag = String(i);
      try { tag = new URL(baseUrl).port || String(i); } catch { /* keep the index */ }
      rows.push({ name: `${name}:${tag}`, baseUrl, token: e?.token ?? v.token ?? null, ...common });
    });
  }
  return rows;
}

// GET /v1/accounts. Returns {ok, status, loginID, email, networks} — a 401 is a RESULT, not an
// error: it means something is serving there and this token is not its install's.
export async function probe(baseUrl, token, { timeoutMs = TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(new URL('/v1/accounts', baseUrl), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: ctl.signal,
    });
    if (!res.ok) return { ok: false, status: res.status };
    const list = await res.json();
    const rows = Array.isArray(list) ? list : [];
    const matrix = rows.find((r) => r?.accountID === 'matrix') ?? rows[0] ?? null;
    return {
      ok: true,
      status: res.status,
      loginID: matrix?.loginID ?? null,
      email: matrix?.user?.email ?? null,
      networks: rows.map((r) => r?.network).filter(Boolean),
    };
  } catch (e) {
    return { ok: false, status: 0, error: e?.name === 'AbortError' ? 'timeout' : (e?.message ?? String(e)) };
  } finally { clearTimeout(t); }
}

// WHO HOLDS THE SOCKET — pid, Windows session, image name. This is the half that says
// "Session 0" out loud instead of inferring it from a port number. Windows only, and
// best-effort: no answer here never invalidates the API answer above.
export async function localOwners(ports) {
  if (process.platform !== 'win32') return new Map();
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const ps = `Get-NetTCPConnection -State Listen -LocalPort ${ports.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)"; '{0} {1} {2} {3}' -f $_.LocalPort,$_.OwningProcess,$p.SessionId,$p.Name }`;
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 15000 });
    const out = new Map();
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)$/);
      if (m) out.set(Number(m[1]), { pid: Number(m[2]), session: Number(m[3]), image: m[4] });
    }
    return out;
  } catch { return new Map(); }
}

const portOf = (url) => { try { return Number(new URL(url).port) || (new URL(url).protocol === 'https:' ? 443 : 80); } catch { return null; } };

export async function report({ cfg = readConfigSync(), extraPorts = [], deps = {} } = {}) {
  const conns = connectionsOf(cfg);
  const ports = [...new Set([...conns.map((c) => portOf(c.baseUrl)), ...DEFAULT_PORTS, ...extraPorts].filter(Boolean))].sort((a, b) => a - b);
  const owners = await (deps.localOwners ?? localOwners)(ports);
  const p = deps.probe ?? probe;

  const lines = [];
  lines.push(`node ${cfg.node_name ?? '?'} — beeper.use = ${cfg.beeper?.use ?? '(none)'}`);
  lines.push('');
  for (const port of ports) {
    const o = owners.get(port);
    const where = o ? `pid ${o.pid}, SESSION ${o.session}, ${o.image}` : 'nothing listening (or not visible from here)';
    lines.push(`:${port}  ${where}`);
    if (!o && !conns.some((c) => portOf(c.baseUrl) === port)) continue;
    // EVERY token against THIS port. The one that answers 200 names the install; the 401s are
    // the proof that the others are different installs, which is the whole point.
    for (const c of conns) {
      const tag = `${c.name}${c.isUse ? ' (use)' : ''}${c.ownerNode ? ` owner_node=${c.ownerNode}` : ''}`;
      // NO TOKEN IS ASKED FIRST, before the probe is even believed. An unauthenticated request
      // comes back 401 exactly like a foreign install's token does, and the two mean opposite
      // things: "a different Desktop is here" versus "we never asked". Reading the second as
      // the first is a confident wrong answer, which is the one failure this tool must not have.
      if (!c.token) { lines.push(`        ${tag}: no token in config — cannot ask`); continue; }
      const r = await p(`http://127.0.0.1:${port}`, c.token);
      if (r.ok) lines.push(`        ${tag}: 200  ${r.loginID ?? '?'}  ${r.email ?? ''}  [${(r.networks ?? []).join(', ')}]`);
      else if (r.status === 401) lines.push(`        ${tag}: 401  a different install answers here`);
      else lines.push(`        ${tag}: ${r.status || '—'} ${r.error ?? ''}`);
    }
  }
  lines.push('');
  for (const c of conns) {
    const port = portOf(c.baseUrl);
    const o = owners.get(port);
    lines.push(`config beeper.${c.name} → ${c.baseUrl}${c.baseUrl.includes(':2337') ? '' : ' (bridge default)'}  account: ${c.account ?? '?'}${o ? `  → SESSION ${o.session}` : '  → nobody listening'}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// THE MAP — one table, every port, every node the operator can name.
//
// report() above prints the EVIDENCE: the whole token x port matrix, 401s and all. This half
// prints the CONCLUSION, one line per port, because the question in practice is not "what does
// the matrix say" but "which number do I type" (operator 2026-09-04, lost in the port numbers):
//
//   host | ip | node | port | S0/S1 | account | state
//
// ROLES, NEVER NAMES. A node runs the operator's PRIMARY account and usually a SECONDARY one the
// agents wear; which is which is DATA — it arrives from /v1/accounts, is printed, and is never
// baked in. Nothing here is named after a person, a machine, an account or a service: the S0
// Desktop is found by the socket it holds, exactly as setup/beeper-update.ps1 finds its service
// by Application path rather than by a service name that differs on every install.
const API_SCAN = { from: 23373, to: 23385 };  // Beeper takes the NEXT FREE port from 23373 up
const CDP_SCAN = { from: 9222, to: 9230 };    // the Chrome/Electron debugger — the number a driver is aimed at
const DEFAULT_SHELL_PORT = 23375;
const SCAN_TIMEOUT_MS = 2500;                 // a scan is ~25 loopback ports; a black hole must not hold the table
const range = ({ from, to }) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

// The spine console's port (config `shell.port`, else 23375). Read HERE rather than imported
// from src/bridges/shell-port.mjs, which owns shellPortFrom(): that module imports reap-port,
// which imports node:child_process AT TOP LEVEL — and boot.mjs imports THIS file, so borrowing
// the accessor would hand the spine a platform at import time and trip tests/integrity.test.mjs
// ("gives the spine no platform"). Same key, same fallback, same range check.
export function shellPortOf(cfg) {
  const n = Number(cfg?.shell?.port);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_SHELL_PORT;
}

// Is anything holding this port? A raw TCP connect, because the console is a WebSocket server
// and answers nothing useful over plain HTTP — "did the socket open" is the entire question.
// node:net is portable; the import stays inside the function so importing this module is free.
export async function tcpListening(port, { host = '127.0.0.1', timeoutMs = SCAN_TIMEOUT_MS } = {}) {
  const { connect } = await import('node:net');
  return new Promise((resolve) => {
    const sock = connect({ port, host });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

// WHAT is behind a CDP port. /json/version names the browser and its user agent, and an Electron
// app says so there — which is how a headless Desktop being driven is told apart from a browser
// the operator drives by hand. Both are legitimate things to find on 9222; confusing them is how
// a driver ends up typing into the wrong window.
export async function cdpProbe(port, { timeoutMs = SCAN_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/json/version`, { signal: ctl.signal });
    if (!res.ok) return { ok: false };
    const v = await res.json();
    const blob = `${v?.Browser ?? ''} ${v?.['User-Agent'] ?? ''}`;
    // Beeper first: an Electron user agent also says Chrome, so the looser tests must come last.
    const label = /beeper/i.test(blob) ? 'Beeper'
      : /electron/i.test(blob) ? 'Electron'
      : /chrom(e|ium)/i.test(blob) ? 'Chrome'
      : 'unknown';
    return { ok: true, label };
  } catch { return { ok: false }; }
  finally { clearTimeout(t); }
}

// THE ADDRESS A PEER WOULD REACH THIS NODE ON — plural, honestly. A machine has several (loopback,
// LAN, VPN, hypervisor switches) so this returns the LIST and lets the table print `?` rather than
// crown a favourite: a confidently wrong address is worse than no address. Host-side virtual
// switches are dropped because nothing off-box can reach them. A VPN / overlay address is KEPT —
// an eGPT node can be off-LAN entirely, and that may be the only way in.
const HOST_ONLY_IFACE = /^(vethernet|virtualbox|vmware|hyper-v|docker|wsl|loopback|npcap)/i;
export function localAddresses(ifaces = networkInterfaces()) {
  const pick = (skipVirtual) => {
    const out = [];
    for (const [name, addrs] of Object.entries(ifaces ?? {})) {
      if (skipVirtual && HOST_ONLY_IFACE.test(name)) continue;
      for (const a of addrs ?? []) {
        if (!a || a.internal) continue;
        if (a.family !== 'IPv4' && a.family !== 4) continue;
        if (a.address.startsWith('169.254.')) continue;   // link-local: self-assigned, reaches nobody
        out.push(a.address);
      }
    }
    return [...new Set(out)];
  };
  const real = pick(true);
  return real.length ? real : pick(false);   // filtered everything away ⇒ better a virtual one than nothing
}

// THE NODES THE OPERATOR RUNS — `egpt_nodes` in config.yaml (config/config-schema.mjs), so the
// topology stops living in chat and stops being retyped as --host flags (operator 2026-09-04:
// "the table needs to be outputted by a tool, not only here"). OPTIONAL: with no block this
// returns nothing at all and every path below behaves exactly as it did before it existed.
//
// A peer is EVERY entry that is not `type: self`, and it is reached by `host` — DEFAULTING TO THE
// MAP KEY, never derived from `ip`. That distinction is the point of the block: an eGPT node can
// be off-LAN, reachable only by a tailscale/DNS name, with no meaningful `ip` at all.
//
// TWO `self` ENTRIES ARE REPORTED, NOT RESOLVED. Picking one would be inventing an answer to a
// question only the operator can settle, and the wrong pick prints a confidently wrong local row.
export function nodesOf(cfg = {}) {
  const block = cfg?.egpt_nodes;
  if (!block || typeof block !== 'object') return { self: null, peers: [], notes: [] };
  const entries = Object.entries(block).filter(([, v]) => v && typeof v === 'object');
  const node = (key, v) => ({ key, host: v.host ?? key, name: v.name ?? null, ip: v.ip ?? null });
  const selves = entries.filter(([, v]) => v.type === 'self');
  const peers = entries.filter(([, v]) => v.type !== 'self').map(([k, v]) => node(k, v));
  const notes = [];
  if (selves.length > 1) {
    notes.push(`egpt_nodes: ${selves.map(([k]) => k).join(', ')} all say type: self - exactly ONE entry is this machine. None is used, so the local row stays auto-detected.`);
  }
  return { self: selves.length === 1 ? node(...selves[0]) : null, peers, notes };
}

// MEASURED BEATS DECLARED, and neither beats a blank: the first real address wins, '?' and absent
// both count as no answer. (`r.ip ?? row.ip` alone could never fall through to config, because a
// node that cannot pick among its own addresses reports the STRING '?' rather than nothing.)
const firstAddr = (...candidates) => candidates.find((a) => a && a !== '?') ?? '?';

// A REMOTE NODE IS WHATEVER egpt_nodes OR --host NAMES: a hostname, a bare IP, an ssh alias, an
// overlay-VPN name, a box on the far side of the internet. It is an OPAQUE ssh target. Nothing
// here scans, broadcasts, reads an ARP table or assumes a subnet, because an eGPT node can be
// off-LAN and there is no local network to enumerate. The remote runs THIS SAME tool in --json
// mode — the probing logic exists once, here, and is never re-implemented over there.
//
// Failure is reported as `unreachable` and nothing else. Slow is not dead, a closed laptop is
// not "off the network", and this tool cannot tell those apart — so it does not pretend to.
export const DEFAULT_REMOTE_PATH = 'src/egpt/src/tools/beeper-whoami.mjs';  // relative ⇒ resolved against the login home by both cmd.exe and sh

const sshIp = (stderr = '') => (stderr.match(/Connecting to \S+ \[([^\]]+)\] port/) ?? [])[1] ?? null;
const sshWhy = (stderr = '') => stderr.split(/\r?\n/).map((l) => l.trim())
  .find((l) => l && !/^(debug\d|OpenSSH_|Warning: Permanently)/.test(l)) ?? 'ssh failed';

export async function remoteProbe(host, { remotePath = DEFAULT_REMOTE_PATH, connectTimeoutSec = 6, timeoutMs = 20_000 } = {}) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  // -v ONLY so ssh prints the address it actually connected to (the ip column for this row is
  // then measured, not guessed). BatchMode so an unknown host or a missing key FAILS instead of
  // prompting forever. ConnectTimeout explicit because an off-LAN node can be slow rather than
  // dead and ssh's own default wait is minutes. `timeout` on top of that kills a session that
  // connects and then hangs — one asleep node must never hold the table.
  const args = ['-v', '-o', 'BatchMode=yes', '-o', `ConnectTimeout=${connectTimeoutSec}`, host, 'node', remotePath, '--json'];
  try {
    const { stdout, stderr } = await run('ssh', args, { timeout: timeoutMs, maxBuffer: 4_000_000 });
    let rows = null;
    try { rows = JSON.parse(stdout); } catch { /* not our JSON — handled below */ }
    if (!Array.isArray(rows)) return { ok: false, ip: sshIp(stderr), error: `connected, but no --json from ${remotePath} (pass --remote-path)` };
    return { ok: true, ip: sshIp(stderr), rows };
  } catch (e) {
    if (e?.code === 'ENOENT') return { ok: false, noSsh: true };   // no ssh client here at all
    return { ok: false, ip: sshIp(e?.stderr ?? ''), error: sshWhy(e?.stderr ?? String(e?.message ?? e)) };
  }
}

// ONE PORT'S VERDICT. Every token in config is tried against it, because a token belongs to an
// INSTALL: the one that answers 200 names the account, and the 401s are proof the others are
// different installs. Two readings must never be conflated — "401 to every token we hold" means
// something is up there that no connection of ours can talk to, while "we hold no token at all"
// means we never asked. The second dressed as the first is a confident wrong answer.
async function apiState(port, conns, probeImpl) {
  const base = `http://127.0.0.1:${port}`;
  const tokened = conns.filter((c) => c.token);
  if (!tokened.length) {
    const r = await probeImpl(base, null, { timeoutMs: SCAN_TIMEOUT_MS });
    return r.status ? { account: '-', state: 'no token in config' } : { account: '-', state: 'not listening' };
  }
  const statuses = [];
  for (const c of tokened) {
    const r = await probeImpl(base, c.token, { timeoutMs: SCAN_TIMEOUT_MS });
    if (r.ok) return { account: r.loginID ?? r.email ?? '?', state: 'logged in' };
    if (!r.status) break;            // nothing answered — the other tokens would fail the same way
    statuses.push(r.status);
  }
  if (!statuses.length) return { account: '-', state: 'not listening' };
  if (statuses.every((s) => s === 401)) return { account: '-', state: 'NOT LOGGED IN' };
  return { account: '-', state: `listening (HTTP ${statuses[statuses.length - 1]})` };
}

export async function topology({ cfg = readConfigSync(), hosts = [], extraPorts = [], remotePath, configPeers = true, deps = {} } = {}) {
  const conns = connectionsOf(cfg);
  const shellPort = shellPortOf(cfg);
  const { self, peers, notes: nodeNotes } = nodesOf(cfg);
  // CONFIG PEERS FIRST, then any --host the config does not already name. Deduplicated by SSH
  // TARGET, which is the only identity either source has: `--host peer-two` and an egpt_nodes
  // entry reaching peer-two are ONE probe. Two spellings of one machine (an alias and its bare
  // IP) stay two, because telling them apart would take exactly the discovery this tool refuses.
  const targets = [];
  for (const t of [...(configPeers ? peers : []), ...hosts.map((h) => ({ key: h, host: h, name: null, ip: null }))]) {
    if (!targets.some((x) => x.host === t.host)) targets.push(t);
  }
  // A port named in config (or on the command line) EARNS a row even when nothing answers —
  // "the port you configured is dead" is exactly the answer the operator came for. A scan port
  // that is merely empty does not. The console port is subtracted from the API scan because it
  // sits inside 23373..23385 and answers HTTP: without this it would appear twice, once
  // truthfully as the console and once as a nonsense API row.
  const named = new Set([...conns.map((c) => portOf(c.baseUrl)), ...extraPorts].filter(Boolean));
  const apiPorts = [...new Set([...range(API_SCAN), ...named])].filter((p) => p !== shellPort).sort((a, b) => a - b);
  const cdpPorts = range(CDP_SCAN);

  const owners = await (deps.localOwners ?? localOwners)([...apiPorts, shellPort, ...cdpPorts]);
  const probeImpl = deps.probe ?? probe;
  const cdp = deps.cdpProbe ?? cdpProbe;
  const listening = deps.tcpListening ?? tcpListening;
  const addrs = (deps.localAddresses ?? localAddresses)();
  // THE SELF ENTRY OUTRANKS THE INTERFACE LIST. os.networkInterfaces() can only enumerate; it
  // cannot say which of a machine's addresses is the one peers use, and the operator can — so a
  // declared name/ip wins here. With no egpt_nodes (or no self in it) this is exactly the old
  // auto-detection, unchanged.
  const host = self?.name ?? (deps.hostname ?? hostname)();
  const node = cfg.node_name ?? '?';
  const ip = self?.ip ?? (addrs.length === 1 ? addrs[0] : '?');
  // S0/S1 is a WINDOWS fact and localOwners already returns an empty Map everywhere else, so
  // off win32 every row reads `-`. There is no POSIX equivalent and inventing one would be a lie.
  const sessionOf = (port) => { const o = owners.get(port); return o ? `S${o.session}` : '-'; };
  const here = { host, ip, node };

  const [apiRows, consoleRow, cdpRows] = await Promise.all([
    Promise.all(apiPorts.map(async (port) => ({ ...here, port, role: 'api', session: sessionOf(port), ...(await apiState(port, conns, probeImpl)) })))
      .then((rs) => rs.filter((r) => r.state !== 'not listening' || named.has(r.port))),
    listening(shellPort).then((up) => ({ ...here, port: shellPort, role: 'console', session: sessionOf(shellPort), account: '-', state: up ? 'listening' : 'not listening' })),
    Promise.all(cdpPorts.map(async (port) => {
      const r = await cdp(port);
      return r.ok ? { ...here, port, role: 'cdp', session: sessionOf(port), account: '-', state: `listening (${r.label})` } : null;
    })).then((rs) => rs.filter(Boolean)),
  ]);

  const rows = [...apiRows, consoleRow].sort((a, b) => a.port - b.port).concat(cdpRows);

  // The printed text is ASCII on purpose: this is a DOUBLE-CLICKED tool, and a console still
  // opens on the machine's OEM codepage, where a UTF-8 em-dash arrives as mojibake.
  const notes = [...nodeNotes];
  // The ip column only needs explaining when the tool had to CHOOSE. A self entry settles it, so
  // saying "none of them is THE one" over a declared address would be answering a live question.
  if (!self?.ip) {
    if (addrs.length > 1) notes.push(`${host}: several addresses (${addrs.join(', ')}) - none of them is THE one, so ip reads ?`);
    else if (!addrs.length) notes.push(`${host}: no non-internal IPv4 address found, so ip reads ?`);
  }

  // Remote hosts CONCURRENTLY: N asleep nodes must cost one timeout, not N.
  const remote = deps.remoteProbe ?? remoteProbe;
  const results = await Promise.all(targets.map(async (t) => [t, await remote(t.host, { remotePath })]));
  for (const [t, r] of results) {
    if (r?.noSsh) continue;   // no ssh client on this machine — skip remote silently, as asked
    // The NOTE keeps the ssh target, always: `name` is a label, and the thing that failed is the
    // target you would retype.
    const label = t.name ?? t.host;
    if (r?.ok) { rows.push(...r.rows.map((row) => ({ ...row, host: label, ip: firstAddr(r.ip, row.ip, t.ip) }))); continue; }
    rows.push({ host: label, ip: firstAddr(r?.ip, t.ip), node: '?', port: '-', role: '', session: '-', account: '-', state: 'unreachable' });
    if (r?.error) notes.push(`${t.host}: unreachable - ${r.error}`);
  }
  if (!targets.length) notes.push('remote nodes: list them in config.yaml under egpt_nodes (see config/config-schema.mjs), or name one with --host <ssh target> (repeatable). None is ever guessed - and none is ever discovered, because a node can be off-LAN.');

  return { rows, notes };
}

const COLUMNS = [
  ['host', (r) => r.host],
  ['ip', (r) => r.ip],
  ['node', (r) => r.node],
  // The role rides in the PORT cell: a bare number does not say what it is, and "which number do
  // I type" is the whole question. api = the Beeper HTTP API, console = the spine's operator
  // console, cdp = the debugger a driver attaches to. The number is right-aligned inside the cell
  // so a 4-digit CDP port and a 5-digit API port keep their role words in one column.
  ['port', (r, pw) => (r.role ? `${String(r.port).padStart(pw)} ${r.role}` : String(r.port))],
  ['S0/S1', (r) => r.session],
  ['account', (r) => r.account],
  ['state', (r) => r.state],
];

export function renderTable(rows, notes = []) {
  const pw = Math.max(0, ...rows.map((r) => String(r.port).length));
  const cells = [COLUMNS.map(([h]) => h), ...rows.map((r) => COLUMNS.map(([, f]) => String(f(r, pw) ?? '-')))];
  const width = COLUMNS.map((_, i) => Math.max(...cells.map((c) => c[i].length)));
  const line = (c) => c.map((v, i) => (i === c.length - 1 ? v : v.padEnd(width[i]))).join('  ').trimEnd();
  const out = [line(cells[0]), width.map((n) => '-'.repeat(n)).join('  ')];
  for (const c of cells.slice(1)) out.push(line(c));
  if (notes.length) out.push('', ...notes);
  return out.join('\n');
}

// pathToFileURL, not a hand-built `file:///` string: the string form only ever matches on
// Windows — a POSIX argv[1] is already absolute, so it renders file:////home/... and never
// matches — which would make this CLI silently do nothing on Linux and macOS. eGPT is
// OS-agnostic by design; that is the whole reason it is node + Beeper, and a tool must not
// quietly become Windows-only. Same idiom as src/tools/compact-being.mjs.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const hosts = [], extraPorts = [];
  let json = false, detail = false, remotePath;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host') hosts.push(argv[++i]);
    else if (a === '--remote-path') remotePath = argv[++i];
    else if (a === '--json') json = true;
    else if (a === '--detail') detail = true;
    else if (/^\d+$/.test(a)) extraPorts.push(Number(a));
  }
  if (detail) console.log(await report({ extraPorts }));
  else {
    // --json IS THE LEAF SHAPE: it is what a remote node returns to whoever asked, so it fans out
    // to NOTHING — neither --host nor the peers in its own egpt_nodes. A node that fanned out here
    // would ssh onward across the mesh and, with two nodes listing each other, never come back.
    const { rows, notes } = await topology({ hosts: json ? [] : hosts, configPeers: !json, extraPorts, remotePath });
    console.log(json ? JSON.stringify(rows) : renderTable(rows, notes));
  }
}
