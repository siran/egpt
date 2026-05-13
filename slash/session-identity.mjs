// slash/session-identity.mjs — /handle /emoji /bio: edit a session's
// visible identity properties. Same shape across the three:
//   - mutate the sessions React state via setSessions
//   - persist via writeBrainProfileState
//   - echo a system message into the room

export const meta = [
  {
    cmd: '/handle',
    section: 'SESSIONS',
    surface: 'shell',
    usage: '/handle [<new>|<old> <new>]',
    desc: 'rename your own handle (1-arg) or a brain session (2-arg)',
  },
  {
    cmd: '/emoji',
    section: 'SESSIONS',
    surface: 'shell',
    usage: '/emoji [name emoji]',
    desc: 'show or set session avatar',
  },
  {
    cmd: '/bio',
    section: 'SESSIONS',
    surface: 'shell',
    usage: '/bio [name [text]]',
    desc: 'show or set session bio',
  },
];

export async function run({ cmd, arg, ctx }) {
  // ctx keys consumed:
  //   sysOut(text)
  //   setItems(updater)
  //   sessions                    — snapshot
  //   setSessions(updater)        — React setter
  //   writeBrainProfileState(name, session)  — persist to disk
  //   handleSlashRecurse(text)    — re-enter handleSlash (for /handle 1-arg
  //                                 routing to /config user_name)
  const { sysOut, setItems, sessions, setSessions,
          writeBrainProfileState, handleSlashRecurse } = ctx;

  if (cmd === '/handle') {
    const parts = arg.split(/\s+/).filter(Boolean);
    if (parts.length === 1) {
      const handle = parts[0];
      if (!/^[A-Za-z0-9_-]+$/.test(handle)) {
        sysOut('handle must be alphanumeric (- and _ ok)');
        return true;
      }
      return handleSlashRecurse(`/config user_name ${handle}`);
    }
    if (parts.length !== 2) {
      sysOut('usage:\n  /handle <new>            change your own handle (user_name)\n  /handle <old> <new>      rename a brain session');
      return true;
    }
    const [oldName, newName] = parts;
    if (!sessions[oldName]) { sysOut(`no session named "${oldName}"`); return true; }
    if (sessions[newName])  { sysOut(`session "${newName}" already exists`); return true; }
    if (!/^[A-Za-z0-9_-]+$/.test(newName)) { sysOut('handle must be alphanumeric (- and _ ok)'); return true; }
    setSessions(s => {
      const next = { ...s };
      next[newName] = next[oldName];
      delete next[oldName];
      return next;
    });
    const emoji = sessions[oldName].emoji ?? '';
    setItems(p => [...p, {
      id: Date.now() + Math.random(), author: 'system',
      body: `${emoji} ${oldName} is now ${newName}`,
    }]);
    await writeBrainProfileState(newName, sessions[oldName])
      .catch(e => sysOut(`!! profile state: ${e.message}`));
    return true;
  }

  if (cmd === '/emoji') {
    const parts = arg.split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      const rows = Object.entries(sessions).map(([n, s]) => `${s.emoji ?? '❓'} ${n}`);
      sysOut(rows.join('\n') || '(no sessions)');
      return true;
    }
    let target, emoji;
    if (parts.length === 1) {
      const all = Object.keys(sessions);
      if (all.length !== 1) { sysOut('usage: /emoji <name> <emoji>'); return true; }
      target = all[0]; emoji = parts[0];
    } else {
      target = parts[0]; emoji = parts[1];
    }
    if (!sessions[target]) { sysOut(`no session named "${target}"`); return true; }
    const nextSession = { ...sessions[target], emoji };
    setSessions(s => ({ ...s, [target]: { ...s[target], emoji } }));
    setItems(p => [...p, {
      id: Date.now() + Math.random(), author: 'system',
      body: `${target} avatar -> ${emoji}`,
    }]);
    await writeBrainProfileState(target, nextSession)
      .catch(e => sysOut(`!! profile state: ${e.message}`));
    return true;
  }

  if (cmd === '/bio') {
    const parts = arg.split(/\s+/);
    const first = parts[0] ?? '';
    if (!first) {
      const rows = Object.entries(sessions)
        .filter(([_, s]) => s.bio)
        .map(([n, s]) => `${s.emoji ?? '❓'} ${n}: ${s.bio}`);
      sysOut(rows.length ? rows.join('\n') : '(no bios set)');
      return true;
    }
    const target = first;
    if (!sessions[target]) { sysOut(`no session named "${target}"`); return true; }
    const text = parts.slice(1).join(' ').trim();
    if (!text) {
      const bio = sessions[target].bio;
      sysOut(bio
        ? `${sessions[target].emoji ?? '❓'} ${target}: ${bio}`
        : `(no bio set for ${target})`);
      return true;
    }
    const nextSession = { ...sessions[target], bio: text };
    setSessions(s => ({ ...s, [target]: { ...s[target], bio: text } }));
    setItems(p => [...p, {
      id: Date.now() + Math.random(), author: 'system',
      body: `${sessions[target].emoji ?? '❓'} ${target} bio: ${text}`,
    }]);
    await writeBrainProfileState(target, nextSession)
      .catch(e => sysOut(`!! profile state: ${e.message}`));
    return true;
  }

  return false;
}
