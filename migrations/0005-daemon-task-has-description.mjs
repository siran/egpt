// 0005 — the session 1 logon task `egpt-daemon` says what it is.
//
// Measured on 2026-09-16: on kg and on do the task's Description was empty, so Task Scheduler said
// nothing about what it runs or what disabling it costs. The text comes from the ONE place
// setup/egpt-daemon-task-labels.ps1, which setup/register-session1-daemon-task.ps1 also stamps
// when it registers the task - a freshly registered node already reads satisfied here.
//
// LOSSLESS BY CONSTRUCTION, like 0002, and IN PLACE - the name stays, so there is no second task
// to build beside it:
//   1. export the task's own XML, and add exactly one element - <Description> in
//      <RegistrationInfo>, on its own line directly above <URI>, which is where Task Scheduler
//      itself exports it (the task schema orders Description before URI; measured on a task
//      registered with -Description).
//   2. re-register the task from that XML (Register-ScheduledTask -Xml -Force, an update)
//   3. export it again and require it to equal step 1's XML byte for byte, and its DACL to equal
//      the DACL before. Anything else: re-register the ORIGINAL export, say whether that put it
//      back byte for byte, and refuse naming the line that differed.
//
// THE RUNNING INSTANCE IS LEFT ALONE. Measured on reve 2026-09-16 on a throwaway task with the
// same principal (InteractiveToken), settings and default DACL, unelevated: while an instance was
// running, re-registering the task from its export with a Description added kept that instance
// running - same wscript.exe pid, state Running, one running instance - and the re-export equalled
// the XML given byte for byte, DACL unchanged. Nothing here stops or starts a task.
//
// A DESCRIPTION THAT IS SOME OTHER TEXT is refused, not overwritten: both nodes measured empty,
// so any other text was put there by someone, and replacing it is a human decision.
//
// NOT ELEVATED: that same measurement ran in reve's UAC-filtered shell. The live task's DACL on
// both nodes is the default one a freshly registered task gets, in which the owning user has full
// access (A;ID;FA;;;<user SID>). A node whose task says otherwise fails at step 2 and refuses.
import { basename, join } from 'node:path';
import { firstDifference } from './0002-session1-task-is-egpt-daemon.mjs';

export const elevated = false;
export const summary = 'the session 1 logon task egpt-daemon carries a Description';

const refuse = (why) => { throw new Error(`0005 refuses: ${why}`); };
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Read-only. The Description the labels module gives this task, and - if the task exists in the
// root folder - its exported XML, its state (4 = running) and its DACL.
export const probeScript = (repo, name) => `# egpt-0005:probe
. ${q(join(repo, 'setup', 'egpt-daemon-task-labels.ps1'))}
$name = ${q(name)}
$out = @{ target = (Get-EgptDaemonTaskDescription -Name $name) }
$scheduler = New-Object -ComObject Schedule.Service
$scheduler.Connect()
$t = $null
try { $t = $scheduler.GetFolder('\\').GetTask($name) } catch { }
if (-not $t) { $out.exists = $false } else {
  $out.exists = $true
  $out.xml = [string](Export-ScheduledTask -TaskName $name -TaskPath '\\')
  $out.state = [int]$t.State
  $out.dacl = [string]$t.GetSecurityDescriptor(4)
}
ConvertTo-Json -Depth 4 -Compress -InputObject $out
`;

// -Force makes it an update of the existing registration. The task's security descriptor is not
// in its XML and is not passed, so an update keeps it (measured; and verified after every update).
export const updateScript = (name, xml) => `# egpt-0005:update ${name}
$xml = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(xml, 'utf8').toString('base64')}'))
Register-ScheduledTask -Xml $xml -TaskName ${q(name)} -TaskPath '\\' -Force -ErrorAction Stop | Out-Null
`;

export async function plan(ctx) {
  if (ctx.platform !== 'win32') return { satisfied: true, notes: [`no scheduled tasks on ${ctx.platform}`] };

  // Derived from the profile folder exactly as register-session1-daemon-task.ps1 derives it.
  const base = basename(ctx.egptHome).replace(/^\./, '');
  if (!base) refuse(`cannot derive a task name from the profile folder ${ctx.egptHome}`);
  const name = `${base}-daemon`;
  const probe = () => JSON.parse(ctx.ps(probeScript(ctx.repo, name)));

  const facts = probe();
  if (!facts.exists) return { satisfied: true, notes: [`no ${name} scheduled task on this node`] };
  const { xml, dacl, target } = facts;
  if (typeof target !== 'string' || !target || /[<>&"'\r\n]/.test(target)) {
    refuse(`setup/egpt-daemon-task-labels.ps1 gives ${JSON.stringify(target)} - it must be one non-empty line with no XML metacharacters, or the re-export cannot match byte for byte`);
  }
  if (!/session1-daemon-launcher\.vbs/i.test(xml)) refuse(`${name} does not run setup\\session1-daemon-launcher.vbs - it is not the session 1 daemon task this migration knows`);

  const reg = xml.match(/<RegistrationInfo>([\s\S]*?)<\/RegistrationInfo>/);
  if (!reg) refuse(`the exported XML of ${name} has no <RegistrationInfo>`);
  const current = [...reg[1].matchAll(/<Description>([\s\S]*?)<\/Description>|<Description\s*\/>/g)].map((m) => m[1] ?? '');
  if (current.length === 1 && current[0] === target) return { satisfied: true, notes: [`${name}: "${target}"`] };
  if (current.length) refuse(`${name} already carries a Description that is not this one (${JSON.stringify(current.join(' | '))}) - replacing it is a human decision`);

  const uri = `<URI>\\${name}</URI>`;
  if (xml.split(uri).length !== 2 || !reg[1].includes(uri)) refuse(`the exported XML of ${name} does not carry exactly one ${uri} in <RegistrationInfo>, so there is no place to put the Description`);
  const lineStart = xml.lastIndexOf('\n', xml.indexOf(uri)) + 1;
  const indent = xml.slice(lineStart, xml.indexOf(uri));
  if (!/^[ \t]*$/.test(indent)) refuse(`${uri} is not on a line of its own in the exported XML of ${name}`);
  const eol = xml.includes('\r\n') ? '\r\n' : '\n';
  const described = `${xml.slice(0, lineStart)}${indent}<Description>${target}</Description>${eol}${xml.slice(lineStart)}`;
  const running = facts.state === 4;

  const changes = [
    `re-register scheduled task ${name} from its own exported XML, with one line added in <RegistrationInfo>:`,
    `  + ${indent}<Description>${target}</Description>`,
    `verify: the re-export equals that byte for byte and the DACL is unchanged (${dacl}) - else re-register the original export and refuse`,
    running
      ? `${name} is RUNNING: that instance is left running - an update of the registration does not stop or restart it, and nothing here starts one`
      : `${name} is not running by Task Scheduler's count (state ${facts.state}) - a session 1 daemon started under its old name, before 0002 renamed it, is not counted; nothing is started or stopped either way`,
  ];

  return {
    satisfied: false,
    changes,
    apply: async () => {
      const now = probe();
      if (!now.exists || now.xml !== xml || now.dacl !== dacl) refuse(`${name} changed since it was planned - re-run`);

      ctx.log(`re-registering ${name} with its Description`);
      ctx.ps(updateScript(name, described));

      const after = probe();
      const problem = !after.exists ? `${name} is not registered after Register-ScheduledTask returned`
        : after.xml !== described ? `the re-export differs from the XML given - ${firstDifference(described, after.xml)}`
          : after.dacl !== dacl ? `its DACL is now ${after.dacl}, it was ${dacl}`
            : null;
      if (problem) {
        ctx.log(`NOT lossless - re-registering ${name} from its original export`);
        let back;
        try {
          ctx.ps(updateScript(name, xml));
          const b = probe();
          back = b.exists && b.xml === xml && b.dacl === dacl
            ? `${name} was re-registered from its original export and exports it byte for byte again, with its DACL.`
            : `Re-registering the original export did NOT give it back byte for byte - inspect ${name} (Export-ScheduledTask) before the next logon.`;
        } catch (e) {
          back = `Re-registering the original export FAILED (${e.message}) - inspect ${name} (Export-ScheduledTask) before the next logon.`;
        }
        refuse(`the Description change is not lossless on this node: ${problem}. ${back}`);
      }
    },
  };
}
