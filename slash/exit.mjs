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
  //   exitClean(code) — bridge stops + baileys close-handshake wait +
  //                     forced process.exit(code). The SAME path Ctrl-C
  //                     (SIGINT) takes. Pre-fix /exit just called Ink's
  //                     useApp().exit which unmounted the UI but left the
  //                     process draining its own event loop (WA socket, TG
  //                     polling, intervals) — many seconds, while Ctrl-C
  //                     finished in ~800ms (operator 2026-05-29).
  await ctx.exitClean(0);
  return true;
}
