// slash/storm.mjs — firehose mode: every WA arrival renders here.
//
// While storm is on the bridge bypasses every awareness gate (self_chat,
// personal, groups:mentions) and the media-save notifier surfaces
// status@broadcast too. /storm off restores the normal filters. Useful
// as an explicit "show me everything" pass — not a default.

export const meta = {
  cmd: '/storm',
  section: 'ROOM',
  surface: 'shell',
  usage: '/storm [off | status]',
  desc:
    'firehose mode: every WhatsApp arrival renders in shell — group chatter, ' +
    'status updates, broadcasts, every observed-chat line — and media ' +
    'notifications include status@broadcast saves. Awareness gates restored ' +
    'when /storm off. Useful for a deliberate "show me everything" pass.',
};

export async function run({ arg, ctx }) {
  // ctx keys consumed:
  //   sysOut(text)    — print a system line
  //   waBridgeRef     — React ref → WhatsApp bridge (setStorm method)
  //   stormRef        — React ref → in-process storm flag; the bridge's
  //                     own _storm is the authority for awareness, but
  //                     the host also reads stormRef in onMediaSaved
  //                     (status@broadcast suppression).
  const { sysOut, waBridgeRef, stormRef } = ctx;
  const a = arg.trim().toLowerCase();
  const wa = waBridgeRef.current;
  if (a === 'off' || a === 'stop' || a === 'no') {
    stormRef.current = false;
    wa?.setStorm?.(false);
    sysOut('storm: off — awareness gates restored, status saves quiet.');
    return true;
  }
  if (a === 'status' || a === '?') {
    sysOut(stormRef.current ? '⛈ storm: ON' : 'storm: off');
    return true;
  }
  stormRef.current = true;
  wa?.setStorm?.(true);
  sysOut('⛈ storm: ON — every WA arrival renders here (chats, groups, status, broadcasts, media). /storm off to stop.');
  return true;
}
