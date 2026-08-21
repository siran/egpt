# sandbox-account.ps1  - one-time idempotent provisioning of the shared
# unprivileged local account (egpt-sandbox) used by sandbox-logon-launcher.ps1's
# per-session LogonUser flow. New-LocalUser/Set-LocalUser require local-
# Administrator rights. Dot-sourced by sandbox-logon-launcher.ps1 and by
# provision-sandbox-account.ps1 (which self-elevates before dot-sourcing this).

$SandboxUser = 'egpt-sandbox'
# DPAPI (Export-Clixml's SecureString protection) is scoped to the Windows
# account that encrypts it  - only decryptable by that same account. Fine
# here: this daemon always runs under one fixed operator account (Startup-
# folder supervisor), never as a rotating service identity.
$CredDir = Join-Path $env:ProgramData 'egpt'
$CredPath = Join-Path $CredDir 'sandbox-cred.xml'

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

# (a) Ensure the ONE shared account exists  - idempotent, local-admin only,
# fail loudly (never silently degrade) if creation is not possible.
function Get-SandboxCredential {
  $existing = Get-LocalUser -Name $SandboxUser -ErrorAction SilentlyContinue
  if ($existing -and (Test-Path -LiteralPath $CredPath)) {
    try { return Import-Clixml -Path $CredPath }
    catch { throw "sandbox-logon-launcher: account '$SandboxUser' exists but its stored credential at $CredPath could not be read ($($_.Exception.Message))  - delete that file to force a self-heal, or fix its permissions" }
  }
  $securePwd = ConvertTo-SecureString -String (New-RandomPassword) -AsPlainText -Force
  if (-not $existing) {
    Log "creating shared local account '$SandboxUser' (first sandboxed run on this node)"
    try {
      New-LocalUser -Name $SandboxUser -Password $securePwd `
        -FullName 'egpt sandbox' `
        -Description 'egpt sandboxed:true logon (managed)' `
        -PasswordNeverExpires -UserMayNotChangePassword -AccountNeverExpires -ErrorAction Stop | Out-Null
    } catch {
      throw "sandbox-logon-launcher: failed to create local account '$SandboxUser'  - $($_.Exception.Message) (this must run as a local Administrator)"
    }
  } else {
    # Account exists but the credential file we'd need to LogonUser it is
    # gone (deleted, moved node, etc.)  - self-heal by resetting its password
    # to a freshly generated one we DO have, rather than getting stuck.
    Log "account '$SandboxUser' exists but its credential file is missing  - resetting its password to restore a known credential"
    try { Set-LocalUser -Name $SandboxUser -Password $securePwd -ErrorAction Stop }
    catch { throw "sandbox-logon-launcher: account '$SandboxUser' exists but its password could not be reset to restore a known credential  - $($_.Exception.Message) (must run as a local Administrator)" }
  }
  $cred = New-Object System.Management.Automation.PSCredential($SandboxUser, $securePwd)
  try {
    New-Item -ItemType Directory -Path $CredDir -Force -ErrorAction Stop | Out-Null
    $cred | Export-Clixml -Path $CredPath -Force
  } catch {
    throw "sandbox-logon-launcher: account '$SandboxUser' is ready but its credential could not be persisted to $CredPath  - $($_.Exception.Message)"
  }
  return $cred
}
