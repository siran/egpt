// slash/log.mjs — surface the hidden _log items in the room.
//
// Telemetry, room-state hints, debug dumps, peer announces — they
// live in items[] tagged _log so the main render hides them. This
// command pulls the last N (default 30) on demand. Output goes only
// to the issuer's surface — sysOut already respects outputSinkRef
// so a /log issued from Telegram doesn't flood the shell.

export const meta = [
  {
    cmd: '/log',
    section: 'MISC',
    surface: 'shell',
    usage: '/log [N]',
    desc: 'show the last N hidden log items (default 30)',
  },
  {
    cmd: '/logs',
    section: 'MISC',
    surface: 'shell',
    usage: '/logs [N]',
    desc: 'alias for /log',
  },
];

export async function run({ arg, ctx }) {
  // ctx keys consumed:
  //   sysOut(text)       — output respects outputSinkRef
  //   items              — current items[] snapshot
  //   fmtTimeOnly(ms)    — "HH:MM TZ" formatter shared with the renderer
  const { sysOut, items, fmtTimeOnly } = ctx;
  const n = parseInt(arg.trim(), 10) || 30;
  const logs = items.filter(i => i._log).slice(-n);
  if (!logs.length) { sysOut('(log is empty)'); return true; }
  const lines = logs.map(i => {
    const t = fmtTimeOnly(Math.floor(i.id));
    return `${t}  ${i.body}`;
  });
  sysOut(`── log (last ${logs.length}) ──\n${lines.join('\n')}`);
  return true;
}
