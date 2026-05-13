// slash/pin.mjs — eGPT-side pin layer for WhatsApp chats.
//
// This file is the pilot for the "slash commands as files" pattern:
// each slash command lives in its own file with a `meta` (or array of
// metas) describing the registry entry, and a `run({cmd, arg, ctx})`
// implementing the behavior. The scanner in egpt.mjs picks the file up
// at startup and the dispatcher in handleSlash routes by cmd before
// falling through to the legacy inline if-chain.
//
// ctx is the shell's syscall table — the closures and refs the command
// needs. Document every key consumed here at the top of run() so the
// dependency footprint is grep-able as the pattern scales.

export const meta = [
  {
    cmd: '/pin',
    section: 'ROOM',
    surface: 'shell',
    usage: '/pin [@waN ...|clear]',
    desc:
      "eGPT-side pin for WA chats — surfaces in /channels + logon summary " +
      "alongside WhatsApp's own pin (unlimited; WA caps phone-side at 3). " +
      "No-arg lists current eGPT pins. /pin clear removes all.",
  },
  {
    cmd: '/unpin',
    section: 'ROOM',
    surface: 'shell',
    usage: '/unpin @waN [@waM ...]',
    desc: 'remove eGPT pin from one or more chats (resolved against the last /channels listing).',
  },
];

export async function run({ cmd, arg, ctx }) {
  // ctx keys consumed:
  //   sysOut(text)              — print a system line to the room
  //   waBridgeRef               — React ref → WhatsApp bridge instance
  //   waChannelsCacheRef        — React ref → last /channels output array
  //                               (entries: { jid, name, isGroup, ... })
  const { sysOut, waBridgeRef, waChannelsCacheRef } = ctx;

  if (!waBridgeRef.current) {
    sysOut('!! whatsapp bridge not running');
    return true;
  }

  const args = arg.trim().split(/\s+/).filter(Boolean);

  // No-arg /pin lists; /unpin without args is a no-op (use /pin clear).
  if (cmd === '/pin' && args.length === 0) {
    const pins = waBridgeRef.current.listEgptPinned();
    if (!pins.length) {
      sysOut('eGPT pins: (none)\nuse /pin @waN to pin a chat from the last /channels listing');
    } else {
      const lines = pins.map((p, i) => {
        const kind = p.isGroup ? '[group]' : '[1:1]';
        const ago = _ageLabel(p.egptPinned);
        return `  ${i + 1}. ${kind.padEnd(7)} ${p.name || p.jid.split('@')[0]}  (pinned ${ago})`;
      });
      sysOut(`eGPT pins (${pins.length}):\n${lines.join('\n')}\n\n/unpin @waN to remove`);
    }
    return true;
  }

  if (cmd === '/pin' && args[0] === 'clear') {
    const pins = waBridgeRef.current.listEgptPinned();
    for (const p of pins) waBridgeRef.current.setEgptPin(p.jid, false);
    sysOut(`cleared ${pins.length} eGPT pin${pins.length === 1 ? '' : 's'}`);
    return true;
  }

  const setOn = cmd === '/pin';
  const waTokens = args.filter(t => /^@wa\d+$/i.test(t));
  if (!waTokens.length) {
    sysOut(`!! usage: ${cmd} @waN [@waM ...] — /channels first to populate indices`);
    return true;
  }

  const results = [];
  for (const t of waTokens) {
    const idx = parseInt(t.match(/^@wa(\d+)$/i)[1], 10) - 1;
    const chat = waChannelsCacheRef.current[idx];
    if (!chat) {
      sysOut(`!! ${t}: no channel at that index. Run /channels first.`);
      continue;
    }
    const state = waBridgeRef.current.setEgptPin(chat.jid, setOn);
    results.push(`${t} "${chat.name}" → ${state}`);
  }
  if (results.length) sysOut(results.join('\n'));
  return true;
}

// Compact "Nm ago" / "Nh ago" / "Nd ago" — same shape as the older
// inline ageLabel inside /channels and the prior /pin branch. Kept
// here so the file is self-contained; if a second command later needs
// it, we'll lift to a shared util.
function _ageLabel(ts) {
  if (!ts) return 'unknown';
  const ms = Date.now() - ts;
  if (ms < 60_000)        return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000)     return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000)    return `${(ms / 3_600_000).toFixed(1)}h ago`;
  return `${(ms / 86_400_000).toFixed(1)}d ago`;
}
