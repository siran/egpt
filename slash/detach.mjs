// slash/detach.mjs — remove a session from the room (brain keeps running).

export const meta = {
  cmd: '/detach',
  section: 'SESSIONS',
  surface: 'both',
  usage: '/detach <name>',
  desc: 'remove session from room',
};

export async function run({ arg, ctx }) {
  // ctx keys consumed:
  //   sysOut(text)
  //   setItems(updater)
  //   sessions                — snapshot
  //   setSessions(updater)    — React setter
  const { sysOut, setItems, sessions, setSessions } = ctx;
  const name = arg.trim();
  if (!name) {
    sysOut('usage: /detach <session>  — remove from room (brain keeps running)');
    return true;
  }
  if (!sessions[name]) { sysOut(`no session named "${name}"`); return true; }
  const { emoji = '', brain: brainName } = sessions[name];
  setSessions(s => { const n = { ...s }; delete n[name]; return n; });
  setItems(p => [...p, {
    id: Date.now() + Math.random(), author: 'system',
    body: `${emoji} ${name} (${brainName}) detached from room`,
  }]);
  return true;
}
