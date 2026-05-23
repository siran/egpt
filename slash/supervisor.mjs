// slash/supervisor.mjs — install / check the egpt supervisor
// scheduled tasks (Windows Task Scheduler).
//
// The supervisor chain (operator 2026-05-23):
//   egpt-daemon-headless — boot → daemon-wrap.ps1 → daemon (respawns)
//   egpt-watchdog        — every 1 min → kills wedged daemon
//
// Creating a boot-triggered task needs admin elevation. `install`
// launches setup/install-tasks.ps1 via Start-Process -Verb RunAs,
// which raises the UAC prompt — approve it and both tasks register.
// No stored password needed (the XMLs use InteractiveToken).

import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';

export const meta = {
  cmd: '/supervisor',
  section: 'ROOM',
  surface: 'shell',
  usage: '/supervisor [status|install|uninstall]',
  desc: 'install / check the Windows scheduled tasks that keep egpt alive (daemon respawn + wedge watchdog)',
};

const TASKS = ['egpt-daemon-headless', 'egpt-watchdog'];

function queryTask(name) {
  const r = spawnSync('schtasks', ['/Query', '/TN', name, '/FO', 'LIST'], { stdio: 'pipe' });
  const out = (r.stdout?.toString() ?? '');
  if (r.status !== 0 || /ERROR/i.test(out)) return null;
  // Pull the "Status" + "Next Run Time" lines for a compact summary.
  const status = out.match(/^Status:\s*(.+)$/mi)?.[1]?.trim() ?? '?';
  const next   = out.match(/^Next Run Time:\s*(.+)$/mi)?.[1]?.trim() ?? '?';
  return { status, next };
}

function showStatus(sysOut) {
  const lines = ['supervisor tasks:'];
  for (const t of TASKS) {
    const q = queryTask(t);
    lines.push(q
      ? `  ✓ ${t} — status=${q.status} next=${q.next}`
      : `  ✗ ${t} — NOT INSTALLED`);
  }
  sysOut(lines.join('\n'));
}

export async function run({ ctx, arg }) {
  const { sysOut, APP_DIR } = ctx;
  const sub = (arg ?? '').trim().split(/\s+/)[0] || 'status';

  if (sub === 'status') {
    showStatus(sysOut);
    return true;
  }

  if (sub === 'install') {
    const ps1 = join(APP_DIR, 'setup', 'install-tasks.ps1');
    // Launch an ELEVATED PowerShell that runs the installer. The
    // -Verb RunAs raises the UAC prompt on the operator's screen.
    // We can't await the UAC approval, so fire-and-forget + tell the
    // operator to approve and re-run `/supervisor status`.
    const inner = `Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${ps1}'`;
    try {
      const child = spawn('powershell', ['-NoProfile', '-Command', inner], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      sysOut(
        'supervisor install: launched elevated installer.\n' +
        '  → Approve the UAC prompt on your screen.\n' +
        '  → An elevated window will create both tasks, then close in ~8s.\n' +
        '  → Then run /supervisor status to confirm.',
      );
    } catch (e) {
      sysOut(`!! supervisor install: ${e?.message ?? e}\n` +
        'Fallback — run this elevated yourself:\n' +
        `  powershell -ExecutionPolicy Bypass -File "${ps1}"`);
    }
    return true;
  }

  if (sub === 'uninstall') {
    const inner = TASKS.map(t => `schtasks /Delete /TN ${t} /F`).join('; ');
    const cmd = `Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-Command','${inner}'`;
    try {
      const child = spawn('powershell', ['-NoProfile', '-Command', cmd], {
        detached: true, stdio: 'ignore',
      });
      child.unref();
      sysOut('supervisor uninstall: launched elevated removal. Approve UAC, then /supervisor status.');
    } catch (e) {
      sysOut(`!! supervisor uninstall: ${e?.message ?? e}`);
    }
    return true;
  }

  sysOut(`usage: ${meta.usage}`);
  return true;
}
