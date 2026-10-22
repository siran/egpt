// 0048 — the session 1 logon task egpt-daemon says it takes the node over from the egpt-daemon service.
//
// 0043 stamped "... the only eGPT runner on this node. Disable it and the node stays silent." on kg
// and do. Since 2026-10-22 (GENOME 6) the egpt-daemon service runs the node while nobody is logged
// on and the task takes over at logon, so that line is false. The new text comes from
// setup/egpt-daemon-task-labels.ps1, which the registrar also stamps.
//
// Same mechanism as 0005 / 0043 (readTask and reRegisterLossless: IN PLACE, the running instance
// left alone, exactly the <Description> line). Only the 0043 line is replaced; any other text is
// refused - replacing it is a human decision.
//
// NOT ELEVATED, as 0005: the task's DACL gives the owning user full access. The service itself has
// no migration: installing it needs the user's password at the console (setup/install-nssm-service.cmd).
import { readTask, reRegisterLossless } from './0005-daemon-task-has-description.mjs';

export const elevated = false;
export const summary = 'the egpt-daemon task Description says it takes the node over from the egpt-daemon service at logon';

// What the labels module said from 2026-10-17 (0043) until 2026-10-22.
export const onlyRunnerDescription = 'eGPT spine supervisor (egpt-daemon.mjs) in session 1, started at logon - the only eGPT runner on this node. Disable it and the node stays silent.';

const refuse = (why) => { throw new Error(`0048 refuses: ${why}`); };

export async function plan(ctx) {
  if (ctx.platform !== 'win32') return { satisfied: true, notes: [`no scheduled tasks on ${ctx.platform}`] };

  const { name, probe, facts, current } = readTask(ctx, refuse);
  if (!facts.exists) return { satisfied: true, notes: [`no ${name} scheduled task on this node`] };
  const { xml, dacl, target } = facts;
  if (current.length === 1 && current[0] === target) return { satisfied: true, notes: [`${name}: "${target}"`] };
  if (!current.length) return { satisfied: true, notes: [`${name} carries no Description - nothing says it is the only runner`] };
  if (current.length !== 1 || current[0] !== onlyRunnerDescription) {
    refuse(`${name} carries a Description that is neither this one nor the 0043 one (${JSON.stringify(current.join(' | '))}) - replacing it is a human decision`);
  }

  const next = xml.replace(`<Description>${onlyRunnerDescription}</Description>`, () => `<Description>${target}</Description>`);
  const running = facts.state === 4;
  return {
    satisfied: false,
    changes: [
      `re-register scheduled task ${name} from its own exported XML, with its Description replaced:`,
      `  - ${onlyRunnerDescription}`,
      `  + ${target}`,
      `verify: the re-export equals that byte for byte and the DACL is unchanged (${dacl}) - else re-register the original export and refuse`,
      running
        ? `${name} is RUNNING: that instance is left running - an update of the registration does not stop or restart it`
        : `${name} is not running (state ${facts.state}); nothing is started or stopped`,
    ],
    apply: async () => reRegisterLossless(ctx, { name, xml, dacl, next, probe, refuse }),
  };
}
