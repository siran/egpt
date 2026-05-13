// slash/file.mjs — show the current conversation file path.

export const meta = {
  cmd: '/file',
  section: 'ROOM',
  surface: 'shell',
  usage: '/file',
  desc: 'show conversation file path',
};

export async function run({ ctx }) {
  // ctx keys consumed:
  //   sysOut(text)  — print a system line
  //   getFile()     — getter for the mutable FILE binding. /conversation
  //                   can switch this at runtime, so a snapshot at scan
  //                   time would go stale; the getter always reads live.
  ctx.sysOut(ctx.getFile());
  return true;
}
