// slash/exit.mjs — quit egpt cleanly.

export const meta = {
  cmd: '/exit',
  section: 'ROOM',
  surface: 'shell',
  usage: '/exit',
  desc: 'quit egpt',
};

export async function run({ ctx }) {
  // ctx keys consumed:
  //   exit()  — Ink's useApp().exit, unmounts the app and ends the
  //             process. Pidfile cleanup + bridge stops run via the
  //             process.on('exit') handler wired in egpt.mjs.
  ctx.exit();
  return true;
}
