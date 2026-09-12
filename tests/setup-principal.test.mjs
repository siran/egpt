// setup-principal.test.mjs - the Windows principal the setup scripts run things AS.
//
// THE BUG THIS LOCKS (measured on dolly 2026-09-12, over ssh - which is the ordinary way
// this repo is administered across its two nodes):
//
//   $env:USERDOMAIN   = WORKGROUP        <- not the machine, not a domain
//   $env:USERNAME     = an
//   WindowsIdentity   = DOLLY\an         <- the authoritative answer
//
// Three setup scripts built their principal as "$env:USERDOMAIN\$env:USERNAME", i.e.
// WORKGROUP\an, which maps to no SID on a workgroup machine. register-session1-daemon-task.ps1
// died with "No mapping between account names and security IDs was done" (0x80070534), and
// install-nssm-service.ps1 would hand the same unresolvable name to NSSM's ObjectName.
//
// WHY THIS TEST LIVES IN VITEST AND NOT IN PESTER. setup/ does have a Pester file
// (sandbox-account.Tests.ps1), but it works by DOT-SOURCING sandbox-account.ps1, which is a
// library of variables and functions with no top-level side effects. The three scripts here
// are imperative: dot-sourcing them registers a scheduled task, prompts for a password, or
// writes a STOP file and stops a service. On top of that the Pester file says of itself "NOT
// part of vitest -- `npm test` never runs a .ps1. Run it by hand", so a lock placed there
// would never run in the suite. tests/stop-file.test.mjs already reads setup/*.ps1 as text
// from vitest; this follows that precedent, and adds a real child-powershell evaluation so it
// is not merely a grep.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SETUP = join(ROOT, 'setup');
const read = (name) => readFileSync(join(SETUP, name), 'utf8');

// Each site: the assignment whose right-hand side IS the principal that script hands to
// Windows. The regexes deliberately capture the EXPRESSION, so the evaluation below runs the
// real source line rather than a copy of it.
const SITES = [
  { file: 'register-session1-daemon-task.ps1', re: /^\$User\s+=\s+(.+)$/m, used: 'New-ScheduledTaskPrincipal -UserId / New-ScheduledTaskTrigger -User' },
  { file: 'install-nssm-service.ps1', re: /^\$svcUser\s+=\s+(.+)$/m, used: "Get-Credential -UserName, then NSSM's ObjectName" },
  { file: 'stop-egpt.ps1', re: /^\s+\$who\s+=\s+(.+)$/m, used: 'the "who:" provenance line in the STOP file' },
];

describe('setup scripts derive the Windows principal from WindowsIdentity, not from env vars', () => {
  for (const site of SITES) {
    it(`${site.file} captures a principal expression (${site.used})`, () => {
      const m = site.re.exec(read(site.file));
      expect(m, `no principal assignment found in setup/${site.file} - did the variable get renamed?`).toBeTruthy();
      expect(m[1].trim().length).toBeGreaterThan(0);
    });
  }

  it('no setup script builds a principal by concatenating $env:USERDOMAIN with $env:USERNAME', () => {
    // The whole directory, not just the three: this is the anti-reintroduction lock. Whole-line
    // comments are skipped because the three fixed sites QUOTE the bad idiom to say why it is
    // wrong, and a lock that forbids naming the bug is a lock that forbids explaining it.
    const offenders = readdirSync(SETUP)
      .filter((f) => f.endsWith('.ps1'))
      .filter((f) =>
        readFileSync(join(SETUP, f), 'utf8')
          .split('\n')
          .some((l) => !l.trimStart().startsWith('#') && l.includes('"$env:USERDOMAIN\\$env:USERNAME"')),
      );
    expect(
      offenders,
      'USERDOMAIN is WORKGROUP on a workgroup machine and over ssh, so this builds an ' +
        'unresolvable principal. Use [Security.Principal.WindowsIdentity]::GetCurrent().Name.',
    ).toEqual([]);
  });
});

// The behavioural half: take the expression straight out of each script, poison USERDOMAIN the
// way a workgroup box does, and require the result to still resolve to a real SID. On the old
// code this fails ("Some or all identity references could not be translated"); on the new code
// it resolves, because WindowsIdentity never consults the environment.
describe.skipIf(process.platform !== 'win32')('the captured expression resolves to a real SID with USERDOMAIN poisoned', () => {
  const exprs = SITES.map((s) => {
    const m = s.re.exec(read(s.file));
    return m ? m[1].trim() : null;
  });

  const script = [
    "$env:USERDOMAIN = 'EGPT-BOGUS-DOMAIN'",
    ...exprs.map(
      (e, i) =>
        `try { $v = ${e}; ` +
        `Write-Output ("${i}=" + (New-Object System.Security.Principal.NTAccount($v)).Translate([System.Security.Principal.SecurityIdentifier]).Value) } ` +
        `catch { Write-Output ("${i}=ERR " + $_.Exception.Message) }`,
    ),
  ].join('\n');

  const tmp = join(os.tmpdir(), `egpt-principal-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
  let out = '';
  try {
    writeFileSync(tmp, script, 'ascii');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmp], {
      encoding: 'utf8',
      timeout: 60000,
    });
    out = `${r.stdout || ''}${r.stderr || ''}`;
  } finally {
    rmSync(tmp, { force: true });
  }

  SITES.forEach((site, i) => {
    it(`${site.file}: ${site.used}`, () => {
      const line = out.split(/\r?\n/).find((l) => l.startsWith(`${i}=`));
      expect(line, `no result for ${site.file}; powershell said: ${out}`).toBeTruthy();
      expect(line.slice(2)).toMatch(/^S-1-5-/);
    });
  });
});

// The SECOND half of the same 2026-09-12 failure: Register-ScheduledTask raised a
// NON-TERMINATING error, control fell straight past the try/catch, and the script printed
// "Registered scheduled task" in green for a task Get-ScheduledTask could not find. Nothing in
// eGPT may report a success it did not have.
describe('register-session1-daemon-task.ps1 cannot report a registration or removal that failed', () => {
  const src = read('register-session1-daemon-task.ps1');

  it('the Register-ScheduledTask call is -ErrorAction Stop, so the catch below it can fire', () => {
    expect(src).toMatch(/Register-ScheduledTask[^\n]*\n?[^\n]*-Force -ErrorAction Stop/);
  });

  it('the -Remove path Unregister-ScheduledTask call is -ErrorAction Stop too', () => {
    expect(src).toContain('Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop');
  });
});
