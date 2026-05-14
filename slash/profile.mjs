// slash/profile.mjs — create a brain profile yaml, optionally attach.
//
// /create-profile     interactive wizard for a CDP brain profile
// /profile <name> <url>          create from args; saves to profile dirs
// /profile-url ...               alias for /profile
//
// Profile yamls drive /attach <profile> — they bundle brain type, url,
// and any per-session options into a reusable definition.

export const meta = [
  {
    cmd: '/create-profile',
    section: 'BRAINS',
    surface: 'shell',
    usage: '/create-profile [name]',
    desc: 'interactive wizard for a CDP brain profile',
  },
  {
    cmd: '/profile',
    section: 'BRAINS',
    surface: 'shell',
    usage: '/profile <name> <urlOrId> [--user|--project|--repo] [--force]',
    desc: 'create a brain profile from args (saves yaml + optionally attaches)',
  },
  {
    cmd: '/profile-url',
    section: 'BRAINS',
    surface: 'shell',
    usage: '/profile-url <name> <url> [...]',
    desc: 'alias for /profile',
  },
];

export async function run({ cmd, arg, ctx }) {
  // ctx keys consumed:
  //   sysOut(text), dp(p)
  //   startProfileWizard(name)
  //   parseProfileCreateArgs(arg)
  //   writeConversationProfile(spec)
  //   loadBrainProfile(name)
  //   attachProfile(loaded)
  //   profileCreateUsage()
  const { sysOut, dp, startProfileWizard,
          parseProfileCreateArgs, writeConversationProfile,
          loadBrainProfile, attachProfile, profileCreateUsage } = ctx;

  if (cmd === '/create-profile') {
    startProfileWizard(arg.trim() || undefined);
    return true;
  }

  // /profile and /profile-url share behavior.
  try {
    const spec = parseProfileCreateArgs(arg);
    const { path, profile } = await writeConversationProfile(spec);
    sysOut(
      `profile "${profile.name}" saved -> ${dp(path)}\n` +
      `  type: ${profile.type}\n` +
      `  url: ${profile.url}\n` +
      `  attach with: /attach ${profile.name}`
    );
    if (spec.attach) {
      const loaded = await loadBrainProfile(profile.name);
      await attachProfile(loaded);
    }
  } catch (e) {
    sysOut(e.message.includes('usage: /profile')
      ? e.message
      : `!! ${e.message}\n\n${profileCreateUsage()}`);
  }
  return true;
}
