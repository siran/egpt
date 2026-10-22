# egpt-daemon-task-labels.ps1 - the ONE place that says how the session 1 logon task describes
# itself. Dot-sourced by register-session1-daemon-task.ps1, which stamps it when it registers the
# task, and by migrations\0005 / 0043 / 0048, which stamp it on a task registered before - so a
# fresh node and a migrated node carry the same line.
#
# ONE LINE, what it is first and what disabling it costs last. Since 2026-10-22 the task takes the
# node over from the egpt-daemon service at logon and the service takes it back at logoff; from
# 2026-10-17 until then the task was the only runner (0048 replaces that line).
#
# NO XML METACHARACTERS (< > & " '). The migrations write this text into the task's exported
# XML verbatim and require the re-export to match byte for byte; Task Scheduler would escape
# them, and the lossless check would then refuse. setup\egpt-daemon-task-labels.Tests.ps1 holds it.
#
# NO TOP-LEVEL SIDE EFFECTS - dot-sourced, including by Pester. ASCII ONLY: PowerShell 5.1 reads
# a BOM-less UTF-8 script as ANSI.

function Get-EgptDaemonTaskDescription {
  return "eGPT spine supervisor (egpt-daemon.mjs) in session 1, started at logon: it takes the node over from the egpt-daemon service, which takes it back at logoff. Disable it and the node stays in session 0, with no browser."
}
