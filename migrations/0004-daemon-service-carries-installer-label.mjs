// 0004 — the egpt-daemon service carries the labels its installer stamps.
//
// setup/install-nssm-service.ps1 stamps DisplayName `eGPT node supervisor (<service>)` and
// Description `eGPT spine supervisor (egpt-daemon.mjs) for profile(s) <list>. Stop it and this node
// goes silent.` Measured on 2026-09-16: kg carried exactly that; do still carried the labels of an
// older hand install ("egpt personal AI bridge daemon", and a Description naming the retired
// egpt-spine task), so the Services list on do did not say what stopping it costs.
//
// <list> IS THE SERVICE'S OWN, never this run's profile: it is read from the service's nssm
// AppEnvironmentExtra - EGPT_HOMES if it carries one, else EGPT_HOME - split on `;` or `,`, trimmed,
// empties dropped, joined with ', ', in order. That is the installer's own rule for -EgptHomes, and
// the installer writes EGPT_HOMES from that same list, so the text reads back exactly as it was
// stamped. kg (EGPT_HOME and EGPT_HOMES both C:/Users/an/.egpt) reads already satisfied from it.
//
// LABELS ONLY, NEVER A REINSTALL. The service runs as .\an, so reinstalling it needs that account's
// password, and the installer asks with Get-Credential - which hangs forever over ssh (measured
// 2026-09-15). This migration runs `sc.exe config <svc> DisplayName= <text>` and
// `sc.exe description <svc> <text>`, for whichever of the two differs, and nothing else. Nothing is
// stopped or restarted.
//
// VERIFIED BY CONSTRUCTION, not by a hand-picked list. The probe reads EVERY value under the
// service's registry key, subkeys included (ImagePath, ObjectName, Start, DelayedAutostart,
// FailureActions, Parameters\AppParameters, Parameters\AppEnvironmentExtra, Parameters\AppExit...).
// After sc.exe, every one of them except the root DisplayName and Description must be identical -
// same kind, same value, none added or removed - or this refuses and names each difference. The
// labels are already written by then, so the refusal is a report for a human, not a rollback.
//
// ELEVATED: changing a service's configuration needs administrator rights. Reading its registry key
// does not, so an unelevated run still recognises a node that is already there.
import { basename } from 'node:path';

export const elevated = true;
export const summary = 'the egpt-daemon service carries its installer labels (DisplayName, Description)';

const refuse = (why) => { throw new Error(`0004 refuses: ${why}`); };
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Read-only. Every value of HKLM\SYSTEM\CurrentControlSet\Services\<name> and of every subkey,
// keyed by subkey path ('' = the service key itself). REG_EXPAND_SZ stays unexpanded, binary is base64.
export const probeScript = (name) => `# egpt-0004:probe
$name = ${q(name)}
$key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey("SYSTEM\\CurrentControlSet\\Services\\$name")
if (-not $key) { ConvertTo-Json -Compress -InputObject @{ exists = $false }; return }
$keys = [ordered]@{}
function Read-Key($k, $path) {
  $values = [ordered]@{}
  foreach ($n in $k.GetValueNames()) {
    $v = $k.GetValue($n, $null, 'DoNotExpandEnvironmentNames')
    if ($v -is [byte[]]) { $v = [Convert]::ToBase64String($v) }
    $values[$n] = [ordered]@{ kind = [string]$k.GetValueKind($n); value = $v }
  }
  $keys[$path] = $values
  foreach ($s in $k.GetSubKeyNames()) {
    $sub = $k.OpenSubKey($s)
    try { Read-Key $sub $(if ($path) { "$path\\$s" } else { $s }) } finally { $sub.Close() }
  }
}
try { Read-Key $key '' } finally { $key.Close() }
ConvertTo-Json -Depth 8 -Compress -InputObject @{ exists = $true; keys = $keys }
`;

// Sets only the labels passed. sc.exe prints its failures on stdout and exits nonzero.
export const labelScript = (name, { displayName, description }) => `# egpt-0004:label ${name}
${displayName === undefined ? '' : `$out = & sc.exe config ${q(name)} DisplayName= ${q(displayName)}
if ($LASTEXITCODE -ne 0) { throw "sc.exe config DisplayName exited $LASTEXITCODE - $out" }
`}${description === undefined ? '' : `$out = & sc.exe description ${q(name)} ${q(description)}
if ($LASTEXITCODE -ne 0) { throw "sc.exe description exited $LASTEXITCODE - $out" }
`}`;

const LABELS = new Set(['DisplayName', 'Description']);
const valueOf = (keys, path, name) => keys?.[path]?.[name]?.value;

// install-nssm-service.ps1's profile list, from the service's own AppEnvironmentExtra.
export function profileListOf(environmentExtra) {
  let home;
  let homes;
  // Last one wins, as register-session1-daemon-task.ps1 reads the same block.
  for (const e of [environmentExtra ?? []].flat()) {
    if (/^EGPT_HOME=/i.test(e)) home = e.slice('EGPT_HOME='.length);
    if (/^EGPT_HOMES=/i.test(e)) homes = e.slice('EGPT_HOMES='.length);
  }
  // A blank EGPT_HOMES is no list at all - the installer never writes one, and the daemon
  // (src/daemon-runtime.mjs resolveProfiles) falls back to EGPT_HOME for it.
  const list = (homes ?? '').split(/[;,]/).map((s) => s.trim()).filter(Boolean);
  if (list.length) return { from: `EGPT_HOMES=${homes}`, list };
  if (home) return { from: `EGPT_HOME=${home}`, list: [home] };
  return null;
}

export const displayNameFor = (name) => `eGPT node supervisor (${name})`;
export const descriptionFor = (list) => `eGPT spine supervisor (egpt-daemon.mjs) for profile(s) ${list.join(', ')}. Stop it and this node goes silent.`;

// Every registry value except the two labels on the service key itself, compared kind and value.
function differences(before, after) {
  const out = [];
  for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = before[path];
    const a = after[path];
    const where = path ? `${path}\\` : '';
    if (!b || !a) { out.push(`subkey ${path} ${b ? 'was removed' : 'appeared'}`); continue; }
    for (const n of new Set([...Object.keys(b), ...Object.keys(a)])) {
      if (!path && LABELS.has(n)) continue;
      if (JSON.stringify(b[n]) !== JSON.stringify(a[n])) out.push(`${where}${n || '(default)'}: before ${JSON.stringify(b[n] ?? null)}, after ${JSON.stringify(a[n] ?? null)}`);
    }
  }
  return out;
}

export async function plan(ctx) {
  if (ctx.platform !== 'win32') return { satisfied: true, notes: [`no Windows services on ${ctx.platform}`] };

  // Derived from the profile folder exactly as install-nssm-service.ps1 derives it: ~/.egpt -> egpt-daemon.
  const base = basename(ctx.egptHome).replace(/^\./, '');
  if (!base) refuse(`cannot derive a service name from the profile folder ${ctx.egptHome}`);
  const name = `${base}-daemon`;
  const probe = () => JSON.parse(ctx.ps(probeScript(name)));

  const facts = probe();
  if (!facts.exists) return { satisfied: true, notes: [`no ${name} service on this node`] };
  const keys = facts.keys;

  const appParameters = valueOf(keys, 'Parameters', 'AppParameters');
  if (!/egpt-daemon\.mjs/i.test(appParameters ?? '')) refuse(`${name}'s nssm AppParameters (${JSON.stringify(appParameters ?? null)}) do not run egpt-daemon.mjs - it is not the service this migration knows`);
  const env = valueOf(keys, 'Parameters', 'AppEnvironmentExtra');
  const profiles = profileListOf(env);
  if (!profiles) refuse(`${name}'s nssm AppEnvironmentExtra (${JSON.stringify(env ?? null)}) carries neither EGPT_HOMES nor EGPT_HOME, so the profile list its Description names cannot be read`);

  const want = { displayName: displayNameFor(name), description: descriptionFor(profiles.list) };
  const have = { displayName: valueOf(keys, '', 'DisplayName'), description: valueOf(keys, '', 'Description') };
  const set = {};
  if (have.displayName !== want.displayName) set.displayName = want.displayName;
  if (have.description !== want.description) set.description = want.description;
  if (!Object.keys(set).length) {
    return { satisfied: true, notes: [`${name}: "${want.displayName}" - "${want.description}"`] };
  }

  const changes = [
    `service ${name} (runs as ${valueOf(keys, '', 'ObjectName')}) - its labels only, by sc.exe. It is not stopped, restarted or reinstalled.`,
    ...(set.displayName ? ['  DisplayName', `    - ${have.displayName ?? '(none)'}`, `    + ${set.displayName}`] : []),
    ...(set.description ? ['  Description', `    - ${have.description ?? '(none)'}`, `    + ${set.description}`] : []),
    `  the profile list is the service's own, from its AppEnvironmentExtra: ${profiles.from}`,
    `verify: every other value under HKLM\\SYSTEM\\CurrentControlSet\\Services\\${name}, subkeys included (ImagePath, ObjectName, Start, Parameters\\AppParameters, Parameters\\AppEnvironmentExtra, ...), is identical afterwards - else refuse and name what differs`,
  ];

  return {
    satisfied: false,
    changes,
    apply: async () => {
      const now = probe();
      if (!now.exists || JSON.stringify(now.keys) !== JSON.stringify(keys)) refuse(`${name} changed since it was planned - re-run`);

      ctx.log(`setting ${Object.keys(set).join(' and ')} on ${name}`);
      ctx.ps(labelScript(name, set));

      const after = probe();
      if (!after.exists) refuse(`${name} is gone after sc.exe returned`);
      const diff = differences(keys, after.keys);
      if (diff.length) {
        refuse(`setting the labels on ${name} changed more than the labels - ${diff.join('; ')}. The labels are already set; nothing was put back. Inspect the service before its next restart.`);
      }
    },
  };
}
