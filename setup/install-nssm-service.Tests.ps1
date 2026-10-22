# Unit coverage for setup\install-nssm-service.ps1's plan (loaded with -LoadFunctionsOnly), fed the
# recorded machine states in setup\fixtures (reve measured, dolly inferred) and variations of them.
# No service, credential, LSA policy, ACL or task is touched; the -StateFile runs are child processes.
#   Invoke-Pester -Script setup\install-nssm-service.Tests.ps1   (Pester 3.4: `Should Be`)
# ASCII ONLY.

. (Join-Path $PSScriptRoot 'install-nssm-service.ps1') -LoadFunctionsOnly

$script:Fixtures = Join-Path $PSScriptRoot 'fixtures'
function Get-Fixture([string] $Node) { Get-Content (Join-Path $script:Fixtures "s0-service-state-$Node.json") -Raw | ConvertFrom-Json }
function Get-Changed($Plan) { @($Plan.steps | Where-Object { $_ -match '^  set ([^:]+):' } | ForEach-Object { ($_ -replace '^  set ([^:]+):.*$', '$1') }) }

Describe 'Get-S0ServicePlan - reve (measured): reconfigured in place' {
  $p = Get-S0ServicePlan (Get-Fixture 'reve')
  It 'keeps the service and its host, and changes exactly what the S0 runner needs' {
    $p.ok | Should Be $true
    $p.mode | Should Be 'reconfigure'
    (Get-Changed $p) -join ',' | Should Be 'Start,DisplayName,Description,AppEnvironmentExtra,AppExit 0'
  }
  It 'enables it, drops EGPT_HOMES, adds AppExit 0 = Exit' {
    $p.steps -contains '  set Start: Disabled -> Auto' | Should Be $true
    $p.steps -contains '  set AppEnvironmentExtra: EGPT_HOME=C:/Users/an/.egpt + EGPT_HOMES=C:/Users/an/.egpt -> EGPT_HOME=C:\Users\an\.egpt (EGPT_HOMES dropped: the multi-profile knob is retired)' | Should Be $true
    $p.steps -contains '  set AppExit 0: (none) -> Exit' | Should Be $true
  }
  It 'grants the one ACE its SDDL lacks, and keeps the registered backstop' {
    ($p.steps | Where-Object { $_ -like 'access:*' }) | Should Be 'access: .\an may stop and start egpt-daemon unelevated: add (A;;CCLCSWRPWPLORC;;;S-1-5-21-2140830422-4106283080-3982958092-1001)'
    ($p.steps | Where-Object { $_ -like 'backstop:*' }) | Should Match 'is registered'
  }
  It 'does not start beside the running Session 1 daemon of older code (no s1.claim), and says how to fix it' {
    $p.start | Should Be $false
    $p.steps[-1] | Should Match '^start: NOT started - the Session 1 daemon \(pid 29500\) does not hold state\\s1\.claim'
    $p.steps[-1] | Should Match ([regex]::Escape('setup\stop-egpt.cmd, then setup\start-egpt.cmd'))
  }
  It 'asks the password first, before anything changes, and never runs as LocalSystem' {
    $p.steps[0] | Should Match '^credential: .*before anything changes'
    ($p.steps | Where-Object { $_ -like 'account:*' }) | Should Match 'log on as \.\\an.*never LocalSystem'
  }
}

Describe 'Get-S0ServicePlan - dolly (inferred): an older install is removed and installed again' {
  $p = Get-S0ServicePlan (Get-Fixture 'dolly')
  It 'reinstalls: its host sits in the profile, not in setup\bin' {
    $p.mode | Should Be 'reinstall'
    ($p.steps | Where-Object { $_ -like 'service: stop and remove*' }) | Should Match ([regex]::Escape('C:\Users\an\.egpt\bin\egpt-service.exe is not C:\Users\an\bin\egpt\setup\bin\egpt-service.exe'))
  }
  It 'sets every value, logs to daemon-*.log, EGPT_HOME only, AppExit Default Restart and 0 Exit' {
    (Get-Changed $p).Count | Should Be @($p.settings).Count
    $p.steps -contains '  set AppStdout: C:\Users\an\.egpt\config\logs\daemon-stdout.log' | Should Be $true
    $p.steps -contains '  set AppEnvironmentExtra: EGPT_HOME=C:\Users\an\.egpt' | Should Be $true
    $p.steps -contains '  set AppExit Default: Restart' | Should Be $true
    $p.steps -contains '  set AppExit 0: Exit' | Should Be $true
    $p.steps -contains '  set AppRotateBytes: 10485760' | Should Be $true
  }
  It 'registers the missing backstop and starts the service: no Session 1 daemon there' {
    ($p.steps | Where-Object { $_ -like 'backstop:*' }) | Should Match '^backstop: register egpt-s0-identity as DOLLY\\an \(S4U'
    $p.start | Should Be $true
    $p.steps[-1] | Should Be 'start: egpt-daemon - no Session 1 daemon: the service runs the node'
  }
}

Describe 'Get-S0ServiceSettings' {
  It 'the nssm set arguments: Start, both AppExit codes, and plain name/value pairs' {
    $s = @(Get-S0ServiceSettings (Get-Fixture 'reve'))
    ($s | Where-Object { $_.name -eq 'Start' }).set -join ' ' | Should Be 'Start SERVICE_AUTO_START'
    ($s | Where-Object { $_.name -eq 'AppExit Default' }).set -join ' ' | Should Be 'AppExit Default Restart'
    ($s | Where-Object { $_.name -eq 'AppExit 0' }).set -join ' ' | Should Be 'AppExit 0 Exit'
    ($s | Where-Object { $_.name -eq 'AppStopMethodConsole' }).set -join ' ' | Should Be 'AppStopMethodConsole 10000'
    ($s | Where-Object { $_.name -eq 'AppParameters' }).want | Should Be 'C:\Users\an\bin\egpt\egpt-daemon.mjs'
  }
  It 'never carries EGPT_HOMES' {
    (@(Get-S0ServiceSettings (Get-Fixture 'reve')) | Where-Object { $_.name -eq 'AppEnvironmentExtra' }).want | Should Be 'EGPT_HOME=C:\Users\an\.egpt'
  }
}

Describe 'Get-S0ServicePlan - variations' {
  It 'refuses SYSTEM and LocalSystem: the service runs as the desktop user' {
    $s = Get-Fixture 'reve'; $s.user = 'NT AUTHORITY\SYSTEM'; $s.sid = 'S-1-5-18'
    (Get-S0ServicePlan $s).step | Should Be 'account'
    $s = Get-Fixture 'reve'; $s.user = 'LocalSystem'
    (Get-S0ServicePlan $s).step | Should Be 'account'
  }
  It 'refuses a tree that is not the deployed checkout, unless told so' {
    $s = Get-Fixture 'reve'; $s.repo = 'C:\Users\an\src\egpt'
    $r = Get-S0ServicePlan $s
    $r.step | Should Be 'repo'
    $r.remedy | Should Match 'AllowThisTree'
    (Get-S0ServicePlan $s $true).ok | Should Be $true
  }
  It 'refuses a tree with no egpt-daemon.mjs, and no node' {
    $s = Get-Fixture 'reve'; $s.repoHasDaemon = $false
    (Get-S0ServicePlan $s).step | Should Be 'repo'
    $s = Get-Fixture 'reve'; $s.node = $null
    (Get-S0ServicePlan $s).step | Should Be 'node'
  }
  It 'installs when there is no service yet' {
    $s = Get-Fixture 'dolly'; $s.service = [pscustomobject]@{ exists = $false }
    $p = Get-S0ServicePlan $s
    $p.mode | Should Be 'install'
    @($p.steps | Where-Object { $_ -like 'service: stop and remove*' }).Count | Should Be 0
    ($p.steps | Where-Object { $_ -like 'account:*' }) | Should Match 'now LocalSystem, as nssm installs it'
  }
  It 'a reconfigured service that already has every value and the ACE: nothing to set, ACE already there' {
    $s = Get-Fixture 'reve'
    foreach ($c in @(Get-S0ServiceSettings $s)) {
      switch ($c.name) {
        'Start' { $s.service.startMode = 'Auto' } 'DisplayName' { $s.service.displayName = $c.want } 'Description' { $s.service.description = $c.want }
        'AppEnvironmentExtra' { $s.service.env = @($c.want) } 'AppExit 0' { $s.service.exit0 = 'Exit' }
      }
    }
    $s.service.sddl = Add-BeeperServiceAce $s.service.sddl $s.sid
    $p = Get-S0ServicePlan $s
    @(Get-Changed $p).Count | Should Be 0
    $p.steps -contains '  every setting is already as wanted' | Should Be $true
    ($p.steps | Where-Object { $_ -like 'access:*' }) | Should Match 'already there$'
  }
  It 'a Running service is stopped first' {
    $s = Get-Fixture 'reve'; $s.service.state = 'Running'
    (Get-S0ServicePlan $s).steps | Where-Object { $_ -like 'service: reconfigure*' } | Should Match 'stop it first, it is Running$'
  }
  It 'never past a STOP file; beside a Session 1 daemon that holds s1.claim it starts and holds off' {
    $s = Get-Fixture 'dolly'; $s.stopFile = $true
    (Get-S0ServicePlan $s).steps[-1] | Should Match '^start: NOT started - the STOP file is there'
    $s = Get-Fixture 'reve'; $s.s1Claimed = $true
    $p = Get-S0ServicePlan $s
    $p.start | Should Be $true
    $p.steps[-1] | Should Match 'holds the profile; the service holds off until it ends$'
  }
}

Describe 'install-nssm-service.ps1 -StateFile (a child process; implies -DryRun)' {
  $script:Ps1 = Join-Path $PSScriptRoot 'install-nssm-service.ps1'
  foreach ($n in 'reve', 'dolly') {
    It "prints the $n plan, changes nothing and exits 0" {
      $out = @(& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script:Ps1 -StateFile (Join-Path $script:Fixtures "s0-service-state-$n.json"))
      $LASTEXITCODE | Should Be 0
      ($out -join "`n") | Should Match ([regex]::Escape('[s0-service] -DryRun: nothing changed'))
      ($out[-1] | ConvertFrom-Json).dryRun | Should Be $true
    }
  }
}
