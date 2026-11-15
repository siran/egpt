// 0053 — the logon Beeper watcher is gone: the egpt-daemon supervises the primary Beeper.
//
// share-beeper-primary-profile.ps1 wrote an HKCU Run value `egpt-beeper-window` (wscript
// beeper-window.vbs) that started setup\beeper-window.ps1 at logon as a separate, killable watcher
// of the operator's window. Operator 2026-11-15: on Windows everything runs as a service (S0) or a
// scheduled task (S1); the Session 1 daemon now runs beeper-window.ps1 -Once on its own tick
// (src/daemon-runtime.mjs). This removes the Run value and stops a watcher still running from the
// old code (it holds the profile's claim, so the daemon's pass would defer to it until logoff).
// Beeper itself is left alone: the watcher never killed it, and stopping the watcher does not close it.
//
// NOT ELEVATED: the Run value is the user's own (HKCU) and the watcher runs as that user.
export const elevated = false;
export const summary = 'the egpt-beeper-window Run value and its watcher are gone: the Session 1 egpt daemon keeps the Beeper window open';

export const RUN_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const RUN_VALUE = 'egpt-beeper-window';

// Read-only: the Run value (or null) and the pids of watchers (beeper-window.ps1 without -Once).
export const probeScript = () => `# egpt-0053:probe
$run = (Get-ItemProperty -Path '${RUN_KEY}' -Name '${RUN_VALUE}' -ErrorAction SilentlyContinue).'${RUN_VALUE}'
$w = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { [string]$_.CommandLine -match 'beeper-window\\.ps1' -and [string]$_.CommandLine -notmatch '-Once' } | ForEach-Object { [int]$_.ProcessId })
ConvertTo-Json -Compress -InputObject ([ordered]@{ run = $run; watchers = $w })
`;

export const removeRunScript = () => `# egpt-0053:remove-run
Remove-ItemProperty -Path '${RUN_KEY}' -Name '${RUN_VALUE}' -ErrorAction Stop
`;

export const stopWatcherScript = (pid) => `# egpt-0053:stop ${pid}
Stop-Process -Id ${Number(pid)} -Force -ErrorAction Stop
`;

export async function plan(ctx) {
  if (ctx.platform !== 'win32') return { satisfied: true, notes: [`no HKCU Run on ${ctx.platform}`] };
  const probe = () => {
    const o = JSON.parse(ctx.ps(probeScript()) || '{}');
    return { run: o.run ?? null, watchers: [].concat(o.watchers ?? []) };
  };
  const found = probe();
  if (!found.run && !found.watchers.length) return { satisfied: true, notes: [`no ${RUN_VALUE} Run value and no beeper-window watcher running`] };
  return {
    satisfied: false,
    changes: [
      ...(found.run ? [`remove the HKCU Run value ${RUN_VALUE} (${found.run})`] : []),
      ...found.watchers.map((pid) => `stop the beeper-window watcher pid ${pid} (Beeper stays open; the Session 1 egpt daemon supervises it)`),
    ],
    apply: async () => {
      const now = probe();
      if (now.run) { ctx.log(`removing the Run value ${RUN_VALUE}`); ctx.ps(removeRunScript()); }
      for (const pid of now.watchers) { ctx.log(`stopping beeper-window pid ${pid}`); ctx.ps(stopWatcherScript(pid)); }
    },
  };
}
