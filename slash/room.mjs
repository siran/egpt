// slash/room.mjs — /room create / join / leave / delete / info.
//
// Rooms group sessions into reattachable bundles. Each room has its
// own /use recipients (active sessions are per-room). Joining a room
// can optionally eager-attach saved CDP sessions; see EGPT_CONFIG.room.on_join.

import * as cdp from '../src/tools/cdp.mjs';

export const meta = {
  cmd: '/room',
  section: 'ROOM',
  surface: 'shell',
  usage: '/room [create|join|leave|delete <name>]',
  desc: 'manage rooms (per-room session bundles); no arg = show current',
};

export async function run({ arg, ctx }) {
  // ctx keys consumed:
  //   sysOut, EGPT_CONFIG, brainForName
  //   roomSessionsMap, setRoomSessionsMap
  //   getCurrentRoom() / setCurrentRoom(name)
  //   setActiveSessions               — /use list is per-room
  //   spawnChromeWithExtension        — eager-attach Chrome bootstrap
  const { sysOut, EGPT_CONFIG, brainForName,
          roomSessionsMap, setRoomSessionsMap,
          getCurrentRoom, setCurrentRoom,
          setActiveSessions, spawnChromeWithExtension } = ctx;

  const argParts = arg.split(/\s+/).filter(Boolean);
  const sub = argParts[0];
  const target = argParts[1];
  const currentRoom = getCurrentRoom();

  const fmtRoom = (name) => {
    const sess = roomSessionsMap[name];
    if (sess === undefined) {
      return `room "${name}" doesn't exist — /room create ${name} to make it`;
    }
    const here = name === currentRoom ? '  (current)' : '';
    const memberCount = Object.keys(sess).length;
    const list = memberCount === 0
      ? '(no members)'
      : Object.entries(sess).map(([n, s]) => `${s.emoji ?? ''}${n} (${s.brain})`).join(', ');
    return `room "${name}"${here}\n  members: ${list}`;
  };

  if (!sub) {
    const all = Object.keys(roomSessionsMap).filter(r => r !== currentRoom);
    const others = all.length ? `\n  other rooms: ${all.join(', ')}` : '';
    sysOut(fmtRoom(currentRoom) + others);
    return true;
  }

  if (sub === 'create') {
    if (!target) { sysOut('usage: /room create <name>'); return true; }
    if (roomSessionsMap[target]) { sysOut(`!! room "${target}" already exists`); return true; }
    setRoomSessionsMap(rs => ({ ...rs, [target]: {} }));
    sysOut(`room "${target}" created — /room join ${target} to enter`);
    return true;
  }

  if (sub === 'join') {
    if (!target) { sysOut('usage: /room join <name>'); return true; }
    if (!roomSessionsMap[target]) {
      sysOut(`!! room "${target}" doesn't exist — /room create ${target}`);
      return true;
    }
    if (target === currentRoom) { sysOut(`already in "${target}"`); return true; }
    setCurrentRoom(target);
    setActiveSessions([]);   // /use is per-room
    sysOut(`joined room "${target}"`);
    // Re-attach behaviour controlled by EGPT_CONFIG.room.on_join:
    //   'lazy' (default)  saved sessions stay as data; first @session use triggers attach
    //   'eager'           auto-/attach every CDP session: open tab at saved url + wire targetId
    //   'off'             keep the data loaded but don't restore sessions on join
    const onJoin = EGPT_CONFIG.room?.on_join ?? 'lazy';
    if (onJoin === 'eager') {
      const targetSessions = roomSessionsMap[target] ?? {};
      const cdpSessions = Object.entries(targetSessions)
        .filter(([, s]) => {
          const b = brainForName(s.brain);
          return b?.urlMatch && s.options?.url;
        });
      if (cdpSessions.length) {
        sysOut(`eager-attach: spinning up ${cdpSessions.length} CDP session(s)…`);
        for (const [name, s] of cdpSessions) {
          try {
            if (!(await cdp.isRunning())) {
              sysOut('  chrome not reachable — starting…');
              await spawnChromeWithExtension();
            }
            const tid = await cdp.openTab(s.options.url);
            // Patch this session's options with the live targetId.
            setRoomSessionsMap(rs => {
              const cur = rs[target] ?? {};
              const sNow = cur[name] ?? {};
              const opts = { ...(sNow.options ?? {}), targetId: tid };
              return { ...rs, [target]: { ...cur, [name]: { ...sNow, options: opts } } };
            });
            sysOut(`  ${s.emoji ?? ''} ${name} → ${s.brain} (tab ${tid.slice(0, 8)}…)`);
          } catch (e) {
            sysOut(`  !! could not attach ${name}: ${e.message}`);
          }
        }
      }
    }
    return true;
  }

  if (sub === 'leave') {
    if (currentRoom === 'default') { sysOut('already in default room'); return true; }
    const left = currentRoom;
    setCurrentRoom('default');
    setActiveSessions([]);
    sysOut(`left "${left}" — back in default room`);
    return true;
  }

  if (sub === 'delete') {
    if (!target) { sysOut('usage: /room delete <name>'); return true; }
    if (target === 'default') { sysOut('!! cannot delete default room'); return true; }
    if (!roomSessionsMap[target]) { sysOut(`!! room "${target}" doesn't exist`); return true; }
    // Bug fix during migration: was 'setActiveSession(null)' (singular,
    // not defined) — now plural to match the actual React setter.
    if (currentRoom === target) { setCurrentRoom('default'); setActiveSessions([]); }
    setRoomSessionsMap(rs => {
      const next = { ...rs };
      delete next[target];
      return next;
    });
    sysOut(`room "${target}" deleted`);
    return true;
  }

  // /room <name>: show info on that room.
  sysOut(fmtRoom(sub));
  return true;
}
