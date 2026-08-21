# sandbox-account.ps1  - one-time idempotent provisioning of the POOL of
# disposable unprivileged local accounts (egpt-sbx-00..NN) used by
# sandbox-logon-launcher.ps1's per-turn leasing flow. New-LocalUser/
# Set-LocalUser require local-Administrator rights. Dot-sourced by
# sandbox-logon-launcher.ps1 and by provision-sandbox-account.ps1 (which
# self-elevates before dot-sourcing this).

# Pool size: headroom over config.yaml's warm.max: 10 concurrent sessions.
$SandboxPoolSize = 16
$SandboxPoolPrefix = 'egpt-sbx-'
# DPAPI (Export-Clixml's SecureString protection) is scoped to the Windows
# account that encrypts it  - only decryptable by that same account. Fine
# here: this daemon always runs under one fixed operator account (Startup-
# folder supervisor), never as a rotating service identity.
$CredDir = Join-Path $env:ProgramData 'egpt'

# Every diagnostic goes to STDERR ONLY. The inner process's stdout is wired
# straight through to THIS script's own stdout handle (step e)  - anything
# this script itself wrote to stdout would land in the same pipe Node is
# parsing as claude's stream-json output and could corrupt it.
function Log([string]$msg) { [Console]::Error.WriteLine("sandbox-logon-launcher: $msg") }

function New-RandomPassword {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  # base64 already mixes upper/lower/digits/symbols (+, /, =); append a fixed
  # symbol+digit+letter run so complexity policy is satisfied even if the
  # random draw happens to omit a category.
  return ([Convert]::ToBase64String($bytes) + '!Aa1')
}

# Single source of truth for the pool account names  - both the provisioner
# and the launcher call this, never hardcode the list twice.
function Get-SandboxPoolAccountNames {
  0..($SandboxPoolSize - 1) | ForEach-Object { "{0}{1:D2}" -f $SandboxPoolPrefix, $_ }
}

# (a) Ensure ONE named account exists  - idempotent, local-admin only,
# fail loudly (never silently degrade) if creation is not possible.
function Get-SandboxCredential {
  param(
    [Parameter(Mandatory = $true)][string]$AccountName
  )
  $credPath = Join-Path $CredDir "sandbox-cred-$AccountName.xml"
  $existing = Get-LocalUser -Name $AccountName -ErrorAction SilentlyContinue
  if ($existing -and (Test-Path -LiteralPath $credPath)) {
    try { return Import-Clixml -Path $credPath }
    catch { throw "sandbox-logon-launcher: account '$AccountName' exists but its stored credential at $credPath could not be read ($($_.Exception.Message))  - delete that file to force a self-heal, or fix its permissions" }
  }
  $securePwd = ConvertTo-SecureString -String (New-RandomPassword) -AsPlainText -Force
  if (-not $existing) {
    Log "creating sandbox pool account '$AccountName' (first use on this node)"
    try {
      New-LocalUser -Name $AccountName -Password $securePwd `
        -FullName 'egpt sandbox' `
        -Description 'egpt sandboxed:true logon (managed)' `
        -PasswordNeverExpires -UserMayNotChangePassword -AccountNeverExpires -ErrorAction Stop | Out-Null
    } catch {
      throw "sandbox-logon-launcher: failed to create local account '$AccountName'  - $($_.Exception.Message) (this must run as a local Administrator)"
    }
  } else {
    # Account exists but the credential file we'd need to LogonUser it is
    # gone (deleted, moved node, etc.)  - self-heal by resetting its password
    # to a freshly generated one we DO have, rather than getting stuck.
    Log "account '$AccountName' exists but its credential file is missing  - resetting its password to restore a known credential"
    try { Set-LocalUser -Name $AccountName -Password $securePwd -ErrorAction Stop }
    catch { throw "sandbox-logon-launcher: account '$AccountName' exists but its password could not be reset to restore a known credential  - $($_.Exception.Message) (must run as a local Administrator)" }
  }
  $cred = New-Object System.Management.Automation.PSCredential($AccountName, $securePwd)
  try {
    New-Item -ItemType Directory -Path $CredDir -Force -ErrorAction Stop | Out-Null
    $cred | Export-Clixml -Path $credPath -Force
  } catch {
    throw "sandbox-logon-launcher: account '$AccountName' is ready but its credential could not be persisted to $credPath  - $($_.Exception.Message)"
  }
  return $cred
}

# Ensure every pool account exists  - idempotent, same self-heal as
# Get-SandboxCredential above, just looped over the whole pool. Returns how
# many accounts were freshly created vs already existed, for the provisioner
# script to report.
function Ensure-SandboxPool {
  $created = 0
  $existed = 0
  foreach ($name in (Get-SandboxPoolAccountNames)) {
    $existedBefore = [bool](Get-LocalUser -Name $name -ErrorAction SilentlyContinue)
    Get-SandboxCredential -AccountName $name | Out-Null
    if ($existedBefore) { $existed++ } else { $created++ }
  }
  [PSCustomObject]@{ Created = $created; Existed = $existed }
}
