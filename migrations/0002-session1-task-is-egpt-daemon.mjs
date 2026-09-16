// 0002 — the session 1 logon task is named `egpt-daemon`, not `egpt-session1-daemon`.
//
// NODE-SHAPE.md: one egpt per session type, so nothing carries a session in its name. The task
// shares `egpt-daemon` with the Windows service - Task Scheduler and the SCM are separate
// namespaces. The name is derived from the profile folder exactly as
// setup/register-session1-daemon-task.ps1 derives it: ~/.egpt -> egpt-daemon.
//
// THIS TASK DRIVES THE S0 -> S1 HANDOVER, so the rename is LOSSLESS BY CONSTRUCTION, not by
// belief. It is never rebuilt from what its parameters are thought to be (a hand-picked list is
// how the Beeper service rename silently dropped nine parameters). Instead:
//   1. export the task's own XML, and change exactly one element - <URI> - to the new name
//   2. register the new task from that XML (no -Force: an existing egpt-daemon task is refused)
//   3. export the NEW task and require it to equal step 1's XML byte for byte, and its DACL to
//      equal the old task's DACL. Anything else: unregister the new task, keep the old one,
//      refuse, and say which line differed.
//   4. only then unregister the old task.
// Nothing is destroyed before its lossless replacement is proven to exist.
//
// THE RUNNING INSTANCE IS LEFT ALONE. This migration never stops or starts anything:
// unregistering removes a registration, and ending running instances is Stop-ScheduledTask's
// job. NOT YET MEASURED on a node: that Task Scheduler leaves the instance running when its task
// is unregistered. Even if it ended the process it started, that is wscript.exe, and the cmd.exe
// and node.exe under it are separate processes. The expectation is that the session 1 daemon
// the old task started at this logon keeps running and keeps the profile. What differs until the next
// logon: `Get-ScheduledTask egpt-daemon` shows Ready and "has not yet run", and Task Scheduler's
// restart-on-failure no longer covers THAT instance, because the task that started it is gone. If
// it dies before the next logon, the session 0 daemon takes the profile back - the designed
// safety net, and the logoff direction that has not yet been exercised. Starting the new task
// by hand would launch a SECOND session 1 daemon; do not. At the next logon egpt-daemon fires.
//
// NOT ELEVATED: measured 2026-09-16 on kg and do, both tasks carry the default DACL, in which
// the owning user has full access (A;ID;FA;;;<user SID>) and the root task folder grants
// Authenticated Users write, so the user who owns the task can register and unregister it
// without administrator rights. If a node's task says otherwise, the steps above fail and
// refuse; they do not half-apply.
import { basename } from 'node:path';

export const elevated = false;
export const summary = 'the session 1 logon task is named egpt-daemon';

const refuse = (why) => { throw new Error(`0002 refuses: ${why}`); };
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Read-only. For each name: does a task of that name exist in the root folder, and if so its
// exported XML, its state (4 = running) and its DACL.
export const probeScript = (from, to) => `# egpt-0002:probe
$names = [ordered]@{ from = ${q(from)}; to = ${q(to)} }
$scheduler = New-Object -ComObject Schedule.Service
$scheduler.Connect()
$folder = $scheduler.GetFolder('\\')
$out = @{}
foreach ($k in $names.Keys) {
  $t = $null
  try { $t = $folder.GetTask($names[$k]) } catch { }
  if (-not $t) { $out[$k] = @{ exists = $false }; continue }
  $xml = Export-ScheduledTask -TaskName $names[$k] -TaskPath '\\'
  $out[$k] = @{ exists = $true; xml = [string]$xml; state = [int]$t.State; dacl = [string]$t.GetSecurityDescriptor(4) }
}
ConvertTo-Json -Depth 4 -Compress -InputObject $out
`;

export const registerScript = (name, xml) => `# egpt-0002:register ${name}
$xml = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(xml, 'utf8').toString('base64')}'))
Register-ScheduledTask -Xml $xml -TaskName ${q(name)} -TaskPath '\\' -ErrorAction Stop | Out-Null
`;

export const unregisterScript = (name) => `# egpt-0002:unregister ${name}
Unregister-ScheduledTask -TaskName ${q(name)} -TaskPath '\\' -Confirm:$false -ErrorAction Stop
`;

export function firstDifference(a, b) {
  const la = a.split(/\r?\n/);
  const lb = b.split(/\r?\n/);
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) return `line ${i + 1}: expected ${JSON.stringify(la[i])}, got ${JSON.stringify(lb[i])}`;
  }
  return a === b ? 'none' : 'line endings differ';
}

export async function plan(ctx) {
  if (ctx.platform !== 'win32') return { satisfied: true, notes: [`no scheduled tasks on ${ctx.platform}`] };

  const base = basename(ctx.egptHome).replace(/^\./, '');
  if (!base) refuse(`cannot derive a task name from the profile folder ${ctx.egptHome}`);
  const from = `${base}-session1-daemon`;
  const to = `${base}-daemon`;
  const probe = () => JSON.parse(ctx.ps(probeScript(from, to)));

  const facts = probe();
  if (!facts.from.exists) {
    return { satisfied: true, notes: [facts.to.exists ? `scheduled task ${to} is registered` : `no session 1 task on this node (neither ${from} nor ${to})`] };
  }
  if (facts.to.exists) refuse(`BOTH ${from} and ${to} are registered - two logon tasks start two session 1 daemons. Which one is right is a human decision.`);

  const xml = facts.from.xml;
  const uriOld = `<URI>\\${from}</URI>`;
  const uriNew = `<URI>\\${to}</URI>`;
  if (xml.split(uriOld).length !== 2) refuse(`the exported XML of ${from} does not carry exactly one ${uriOld}, so the one element this rename changes is not there to change`);
  if (!/session1-daemon-launcher\.vbs/i.test(xml)) refuse(`${from} does not run setup\\session1-daemon-launcher.vbs - it is not the session 1 daemon task this migration knows`);
  const renamed = xml.replace(uriOld, uriNew);
  const running = facts.from.state === 4;

  const changes = [
    `register scheduled task ${to} from ${from}'s own exported XML, with only <URI> changed:`,
    `  - ${uriOld}`,
    `  + ${uriNew}`,
    `verify: ${to}'s exported XML equals that byte for byte, and its DACL equals ${from}'s (${facts.from.dacl}) - else remove ${to}, keep ${from}, refuse`,
    `unregister scheduled task ${from}`,
    running
      ? `${from} is RUNNING: that session 1 daemon is left running - not stopped, and ${to} is not started. Until the next logon ${to} shows Ready / never run, and nothing restarts that instance if it dies (the session 0 daemon takes the profile back).`
      : `${from} is not running (state ${facts.from.state}); ${to} fires at the next logon`,
  ];

  return {
    satisfied: false,
    changes,
    apply: async () => {
      const now = probe();
      if (!now.from.exists || now.from.xml !== xml || now.from.dacl !== facts.from.dacl) refuse(`${from} changed since it was planned - re-run`);
      if (now.to.exists) refuse(`${to} appeared since it was planned - re-run`);

      ctx.log(`registering ${to} from ${from}'s XML`);
      ctx.ps(registerScript(to, renamed));

      const after = probe();
      const problem = !after.to.exists ? `${to} is not registered after Register-ScheduledTask returned`
        : after.to.xml !== renamed ? `${to}'s exported XML differs from the source - ${firstDifference(renamed, after.to.xml)}`
          : after.to.dacl !== facts.from.dacl ? `${to}'s DACL is ${after.to.dacl}, ${from}'s is ${facts.from.dacl}`
            : null;
      if (problem) {
        if (after.to.exists) {
          ctx.log(`NOT lossless - removing ${to}; ${from} is untouched`);
          ctx.ps(unregisterScript(to));
        }
        refuse(`the rename is not lossless on this node: ${problem}. ${from} is still registered and unchanged.`);
      }

      ctx.log(`${to} verified identical; unregistering ${from}`);
      ctx.ps(unregisterScript(from));
    },
  };
}
