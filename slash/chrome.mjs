// slash/chrome.mjs — explicit launch of the brain Chrome profile.
//
// The shell no longer auto-spawns Chrome at startup; it only attaches
// when Chrome is already running. /chrome launches a fresh Chrome with
// the extension loaded under ~/.egpt/chrome/profiles/brain. Auto-
// migrates from the legacy ~/.egpt/egpt-brain on first clean launch.

export const meta = {
  cmd: '/chrome',
  section: 'BRAINS',
  surface: 'shell',
  usage: '/chrome',
  desc: 'launch the persistent Chrome profile with the egpt extension',
};

export async function run({ ctx }) {
  // ctx keys consumed:
  //   spawnChromeWithExtension()  — App-scope helper that spawns Chrome
  //                                 with the right flags + profile dir
  await ctx.spawnChromeWithExtension();
  return true;
}
