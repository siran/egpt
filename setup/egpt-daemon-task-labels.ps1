# egpt-daemon-task-labels.ps1 - the ONE place that says how the session 1 logon task describes
# itself. Dot-sourced by register-session1-daemon-task.ps1, which stamps it when it registers the
# task, and by migrations\0005, which stamps it on a task registered before this file existed -
# so a fresh node and a migrated node carry the same line.
#
# WHY IT EXISTS (2026-09-16). On both nodes the `egpt-daemon` task had an empty Description, so
# Task Scheduler said nothing about what it runs or what turning it off costs - part of why the
# operator could not tell what runs where. The Windows service of the same name already said so
# (install-nssm-service.ps1); the task now says it in the same voice.
#
# ONE LINE, what it is first and what disabling it costs last - the same order as the service's
# Description. DISABLE, not stop: disabling has one measurable consequence at the next logon,
# while what ending a running instance does to the node.exe under wscript.exe is not measured.
#
# NO XML METACHARACTERS (< > & " '). migrations\0005 writes this text into the task's exported
# XML verbatim and requires the re-export to match byte for byte; Task Scheduler would escape
# them, and the lossless check would then refuse. setup\egpt-daemon-task-labels.Tests.ps1 holds it.
#
# NO TOP-LEVEL SIDE EFFECTS - dot-sourced, including by Pester. ASCII ONLY: PowerShell 5.1 reads
# a BOM-less UTF-8 script as ANSI.

# -Name is the task's name. The task and the session 0 service share it (NODE-SHAPE.md: Task
# Scheduler and the SCM are separate namespaces), so it also names the service it falls back to.
function Get-EgptDaemonTaskDescription {
  param([Parameter(Mandatory = $true)][string] $Name)
  return "eGPT spine supervisor (egpt-daemon.mjs) in session 1, started at logon. Disable it and the spine stays in session 0 (the $Name service), where any browser it starts is invisible."
}
