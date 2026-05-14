// slash/profiles.mjs — list brain profiles found on disk.

export const meta = [
  {
    cmd: '/profiles',
    section: 'BRAINS',
    surface: 'shell',
    usage: '/profiles',
    desc: 'list brain profiles',
  },
  {
    cmd: '/brain-profiles',
    section: 'BRAINS',
    surface: 'shell',
    usage: '/brain-profiles',
    desc: 'alias for /profiles',
  },
];

export async function run({ ctx }) {
  // ctx keys consumed:
  //   sysOut(text)
  //   listBrainProfiles()  — scan profile dirs, return descriptors
  //   profileDirsText()    — text describing the search dirs
  const { sysOut, listBrainProfiles, profileDirsText } = ctx;
  try {
    const profiles = await listBrainProfiles();
    if (!profiles.length) {
      sysOut(`(no brain profiles found)\nprofile dirs:\n${profileDirsText()}`);
      return true;
    }
    const rows = profiles.map(p => {
      const base = `${p.name.padEnd(16)} ${p.brain.padEnd(13)} ${p.source}  ${p.path}`;
      return p.error ? `${base}\n  !! ${p.error}` : base;
    });
    sysOut(
      `Brain profiles:\n\n${rows.join('\n')}\n\n` +
      `/attach <profile> starts one.\nprofile dirs:\n${profileDirsText()}`
    );
  } catch (e) {
    sysOut(`!! ${e.message}`);
  }
  return true;
}
