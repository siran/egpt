// slash/recipients.mjs — /use /unuse /join /unjoin
//
// "Recipients" is the active set that plain-text input routes to without
// requiring an @-mention. Two parallel layers:
//
//   activeSessions   set of brain session names (e.g. cgpt1, claude1)
//   waJoined         set of WA chats from /channels, each with a direction:
//                      'both'  — bidirectional (default)
//                      'in'    — listen-only; shell-typed text doesn't
//                                fan out to them, but their arrivals
//                                render and reach the brain
//                      'out'   — write-only; shell typing fans out, but
//                                arrivals don't render
//
// /use and /unuse manage both layers in one place. /join and /unjoin are
// WA-only conveniences (with the same direction grammar) and additionally
// broadcast a wa-join event on the bus so peers with whatsapp.follow_join
// enabled adopt the binding.

const DIR_WORDS = {
  incoming: 'in',  in:  'in',  '<-':  'in',  '←': 'in',
  outgoing: 'out', out: 'out', '->':  'out', '→': 'out',
  both:     'both', bi: 'both', '<->': 'both', '↔': 'both',
};

const dirArrow = (d) => d === 'in' ? '←' : d === 'out' ? '→' : '↔';

export const meta = [
  {
    cmd: '/use',
    section: 'ROOM',
    surface: 'both',
    usage: '/use [<name>[,<name>...]|clear] [incoming|outgoing|both]',
    desc:
      'set the sessions / WA chats that plain-text routes to. For @waN tokens, ' +
      'an optional direction word applies to all of them (see /join). Multiple ' +
      '/use calls accumulate; "clear" empties the list.',
  },
  {
    cmd: '/unuse',
    section: 'ROOM',
    surface: 'both',
    usage: '/unuse [<name>|@waN]',
    desc: 'remove one recipient from the active set (no arg = clear all)',
  },
  {
    cmd: '/join',
    section: 'ROOM',
    surface: 'both',
    usage: '/join @waN[,@waM,...] [incoming|outgoing|both]',
    desc:
      "bind shell to one or more WA chats. Direction (default both): both = " +
      "bidirectional; outgoing = shell typing fans out, their incoming does NOT " +
      "stream to shell; incoming = their messages stream to shell, shell typing " +
      "does NOT go to them (use @waN to reply). Aliases: in/←/<-, out/→/->, " +
      "bi/↔/<->. Subsequent /join calls overwrite a chat's direction. /unjoin " +
      "releases all.",
  },
  {
    cmd: '/unjoin',
    section: 'ROOM',
    surface: 'both',
    usage: '/unjoin [@waN]',
    desc: 'release the /join binding (no arg releases all)',
  },
];

export async function run({ cmd, arg, ctx }) {
  // ctx keys consumed:
  //   sysOut(text)
  //   sessions, activeSessions, setActiveSessions  — brain recipient layer
  //   waBridgeRef, waChannelsCacheRef              — WA chat resolution
  //   waJoined: { add, remove, clear, has, size, all, first }
  //     — _waJoinedAdd/_waJoinedRemove/etc, bundled into one struct so
  //     this file doesn't carry six individual ctx keys
  //   bus, busTargetIdRef, BUS_NODE_ID             — for wa-join broadcast
  const { sysOut, sessions, activeSessions, setActiveSessions,
          waBridgeRef, waChannelsCacheRef, waJoined,
          bus, busTargetIdRef, BUS_NODE_ID } = ctx;

  const fmtWaTargets = () => waJoined.all()
    .map(e => `${dirArrow(e.dir ?? 'both')}@wa${e.idx + 1} "${e.name}"`).join(' + ');

  if (cmd === '/use') {
    const target = arg.trim();
    if (!target) {
      const brains = activeSessions.length ? activeSessions.join(', ') : null;
      const wa = waJoined.size() > 0 ? fmtWaTargets() : null;
      const parts = [brains, wa].filter(Boolean);
      sysOut(parts.length
        ? `active recipients: ${parts.join(' + ')}\n  (↔ both | → outgoing only | ← incoming only)`
        : 'no active recipients — plain text stays in the room.\n' +
          '  /use <name>                 brain\n' +
          '  /use @waN                   WA chat, bidirectional\n' +
          '  /use @waN,@waM incoming     listen-only on those chats\n' +
          '  /use @waN outgoing          write-only (no arrivals render)\n' +
          '  /use clear                  reset; /unuse <name|@waN> drops one');
      return true;
    }
    if (target === 'clear' || target === 'none') {
      setActiveSessions([]);
      waJoined.clear();
      sysOut('active recipients cleared — plain text no longer auto-routes');
      return true;
    }
    // /use is for BRAIN SESSIONS only now. WA chats are routed by the ROOM
    // model (a group is a room member), never by a per-shell binding — the
    // legacy /use @waN / /join set bypassed rooms and leaked (operator
    // 2026-06-02). Reject @waN (and stray direction words) with a pointer.
    const tokens = target.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    const waTokens = tokens.filter(t => /^@wa\d+$/i.test(t) || DIR_WORDS[t.toLowerCase()]);
    const brainTokens = tokens.filter(t => !/^@wa\d+$/i.test(t) && !DIR_WORDS[t.toLowerCase()]);
    if (waTokens.length) {
      sysOut('!! /use no longer routes to WA chats — the ROOM is the router. ' +
             'Add the group as a member of a room (see /room), or send ad-hoc with `@waN <text>`. ' +
             '/use is for brain sessions only.');
      return true;
    }
    const unknown = brainTokens.filter(n => !sessions[n]);
    if (unknown.length) {
      sysOut(`!! unknown session(s): ${unknown.join(', ')} — /sessions to list`);
      return true;
    }
    if (brainTokens.length) setActiveSessions([...new Set([...activeSessions, ...brainTokens])]);
    sysOut(`active recipients -> ${[...new Set([...activeSessions, ...brainTokens])].join(', ') || '(none)'}`);
    return true;
  }

  if (cmd === '/unuse') {
    const target = arg.trim();
    if (!target) {
      setActiveSessions([]);
      waJoined.clear();
      sysOut('active recipients cleared');
      return true;
    }
    const waMatch = target.match(/^@wa(\d+)$/i);
    if (waMatch) {
      const idx = parseInt(waMatch[1], 10) - 1;
      const chat = waChannelsCacheRef.current[idx];
      if (chat && waJoined.remove(chat.jid)) {
        sysOut(`removed @wa${idx + 1} "${chat.name}"`);
      } else {
        sysOut(`!! no @wa${idx + 1} in active recipients`);
      }
      return true;
    }
    if (activeSessions.includes(target)) {
      setActiveSessions(activeSessions.filter(n => n !== target));
      sysOut(`removed "${target}"`);
    } else {
      sysOut(`!! "${target}" not an active recipient`);
    }
    return true;
  }

  // /join + /unjoin are REMOVED. They bound WA chats to a per-shell, in-memory,
  // invisible set that fanned every shell item to those chats — bypassing the
  // room router and leaking a private /use cgpt2 test into the HFM group
  // (operator 2026-06-02). The room is the single routing table now: to send a
  // shell's traffic to a WhatsApp group, make the group a MEMBER of a room
  // (see /room); per-member state (active|mention|mute) gates it. For a one-off
  // send without binding, use `@waN <text>`.
  if (cmd === '/join' || cmd === '/unjoin') {
    sysOut(`${cmd} is removed — the room is the single router (it leaked otherwise). ` +
           `Add the WhatsApp group as a member of a room (see /room) so it routes by ` +
           `membership + state, or send ad-hoc with \`@waN <text>\`. No hidden per-shell binding.`);
    return true;
  }

  return false;
}
