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
//   node src/tools/beeper-whoami.mjs                 # config's connections + the usual ports
//   node src/tools/beeper-whoami.mjs 23373 23380     # plus any extra ports to probe
//
// Read-only: it GETs /v1/accounts and asks Windows who owns the socket. It changes nothing.
import { readConfigSync } from './config-io.mjs';

const DEFAULT_PORTS = [23373, 23374, 23375 - 1];   // the two Desktops, and 23372 in case a third install ever lands below them
const TIMEOUT_MS = 6000;

// The connections named in config.yaml: `beeper.<name>` with a token, `use` excluded (it is a
// pointer, not a connection). base_url absent ⇒ the bridge default, which is what the spine
// would ride — so it is reported as the default, never as "unset".
export function connectionsOf(cfg = {}) {
  const b = cfg.beeper;
  if (!b || typeof b !== 'object') return [];
  return Object.entries(b)
    .filter(([k, v]) => k !== 'use' && v && typeof v === 'object')
    .map(([name, v]) => ({
      name,
      account: v.account ?? null,
      baseUrl: v.base_url ?? 'http://127.0.0.1:23373',
      token: v.token ?? null,
      ownerNode: v.owner_node ?? null,
      isUse: b.use === name,
    }));
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

const isMain = import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`;
if (isMain) {
  const extraPorts = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  console.log(await report({ extraPorts }));
}
