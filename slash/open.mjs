// slash/open.mjs — open a new tab/subprocess and register a session.

import * as cdp from '../src/tools/cdp.mjs';

export const meta = {
  cmd: '/open',
  section: 'SESSIONS',
  surface: 'both',
  usage: '/open <brain> [name]',
  desc: 'open a new tab/subprocess and register a session',
};

export async function run({ arg, ctx }) {
  // ctx keys consumed:
  //   sysOut
  //   getCurrentRoom                 — lobby blocks /open
  //   sessions, setSessions
  //   canonicalBrainName, brainForName, brainNamesForHelp
  //   nextName, nextEmoji
  const { sysOut, getCurrentRoom,
          sessions, setSessions,
          canonicalBrainName, brainForName, brainNamesForHelp,
          nextName, nextEmoji } = ctx;

  if (getCurrentRoom() === 'default') {
    sysOut('!! default room is the lobby and cannot host brains. Create a room first:\n  /room create <name>\n  /room join <name>\n  /open …');
    return true;
  }
  const parts = arg.split(/\s+/);
  const brainName = canonicalBrainName(parts[0]);
  let sessionName = parts[1];
  if (!brainName) {
    sysOut('usage: /open <brain> [name]\n  name auto-generated (e.g. cgpt2) if omitted.\n  brains: ' + brainNamesForHelp().join(', '));
    return true;
  }
  const brain = brainForName(brainName);
  if (!brain) { sysOut(`unknown brain: ${brainName}`); return true; }
  if (!sessionName) sessionName = nextName(brainName, sessions);
  if (sessions[sessionName]) { sysOut(`session "${sessionName}" already exists`); return true; }
  try {
    const options = {};
    if (brain.homeUrl) {
      sysOut(`opening tab -> ${brain.homeUrl}`);
      options.targetId = await cdp.openTab(brain.homeUrl);
    }
    const emoji = nextEmoji(sessions);
    setSessions(s => ({ ...s, [sessionName]: { brain: brainName, options, emoji } }));
    sysOut(`session "${sessionName}" -> ${emoji} ${brainName}` +
      (options.targetId ? ` (target: ${options.targetId.slice(0, 8)}...)` : '') +
      `\n  address it as @${sessionName} for a single-recipient turn`);
  } catch (e) {
    sysOut(`!! ${e.message}`);
  }
  return true;
}
