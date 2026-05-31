// slash/open.mjs — open a new tab/subprocess and register a session.

import * as cdp from '../src/tools/cdp.mjs';
import { sanitizeName } from '../src/rooms.mjs';

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
  //   getCurrentRoom / setCurrentRoom — lobby auto-creates a room (was: refused)
  //   sessions / setSessions          — shadowed below when leaving the lobby
  //   roomSessionsMap / setRoomSessionsMap
  //   canonicalBrainName, brainForName, brainNamesForHelp
  //   nextName, nextEmoji
  const { sysOut,
          sessions: roomSessions, setSessions: setRoomSessions,
          getCurrentRoom, setCurrentRoom,
          roomSessionsMap, setRoomSessionsMap,
          canonicalBrainName, brainForName, brainNamesForHelp,
          nextName, nextEmoji } = ctx;

  // Parse + validate FIRST so `/open` with no args always prints the brain
  // list — the lobby auto-create below shouldn't fire on a help-style call.
  const parts = arg.split(/\s+/).filter(Boolean);
  const brainName = canonicalBrainName(parts[0]);
  let sessionName = parts[1];
  if (!brainName) {
    sysOut('usage: /open <brain> [name]\n  name auto-generated (e.g. cgpt2) if omitted.\n  brains: ' + brainNamesForHelp().join(', '));
    return true;
  }
  const brain = brainForName(brainName);
  if (!brain) { sysOut(`unknown brain: ${brainName}`); return true; }

  // Lobby auto-room (mirrors /attach so /open works as a single command).
  // Was: refused with a "create a room first" message that suggested
  // `/room join <name>` — fictional syntax, the new /room never switches the
  // legacy currentRoom (only /attach did).
  let targetRoom = getCurrentRoom();
  if (targetRoom === 'default') {
    // Sanitize: room name is used as a filesystem path component (the
    // transcript file ~/.egpt/rooms/<name>.md). Unsanitized URLs / weird
    // tokens contain `://` or `/` and Windows mkdir ENOENTs. See attach.mjs
    // matching change (operator 2026-05-31).
    const autoRoomName = sanitizeName(sessionName || brainName || 'work');
    if (!roomSessionsMap[autoRoomName]) {
      setRoomSessionsMap(rs => ({ ...rs, [autoRoomName]: {} }));
      sysOut(`auto-created room "${autoRoomName}"`);
    }
    setCurrentRoom(autoRoomName);
    sysOut(`joined room "${autoRoomName}" — continuing /open`);
    targetRoom = autoRoomName;
  }
  // Shadow sessions/setSessions to write into targetRoom now — setCurrentRoom
  // above takes effect next render, but the rest of /open runs RIGHT NOW.
  const sessions = roomSessionsMap[targetRoom] ?? {};
  const setSessions = (updater) => {
    setRoomSessionsMap(rs => {
      const cur = rs[targetRoom] ?? {};
      const next = typeof updater === 'function' ? updater(cur) : updater;
      return { ...rs, [targetRoom]: next };
    });
  };

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
