// slash/inject.mjs — drop a saved summary into the room or push it to a brain.
//
// /inject <name>           — system note in the current room
// /inject <name> <session> — sent directly to that brain session

export const meta = {
  cmd: '/inject',
  section: 'BRAINS',
  surface: 'shell',
  usage: '/inject <name> [session]',
  desc: 'drop a saved summary into the room or push it to a brain session',
};

export async function run({ arg, ctx }) {
  // ctx keys consumed:
  //   sysOut, setBusy
  //   sessions, resolveAddressedSession
  //   isSafeName, injectSummary
  const { sysOut, setBusy, sessions,
          resolveAddressedSession, isSafeName, injectSummary } = ctx;

  const parts = arg.split(/\s+/).filter(Boolean);
  const [name, targetSpec] = parts;
  if (!isSafeName(name)) {
    sysOut('usage: /inject <name> [session]\n  no session: drops the summary into this room as a system note\n  with session: sends the summary directly to that brain. /summaries to list.');
    return true;
  }
  if (parts.length > 2) {
    sysOut('usage: /inject <name> [session]');
    return true;
  }
  const target = targetSpec ? resolveAddressedSession(targetSpec, sessions) : null;
  if (targetSpec && !target) {
    sysOut(`no session or unambiguous brain named "${targetSpec}"`);
    return true;
  }
  try {
    if (target) {
      setBusy(true);
      const { body } = await injectSummary(name, target);
      setBusy(false);
      sysOut(`injected "${name}" into ${target} (${body.length} chars)`);
    } else {
      const { body } = await injectSummary(name);
      sysOut(`injected "${name}" (${body.length} chars)`);
    }
  } catch (e) {
    setBusy(false);
    if (e.code === 'ENOENT') sysOut(`no summary named "${name}". /summaries to list.`);
    else sysOut(`!! ${e.message}`);
  }
  return true;
}
