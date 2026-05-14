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
    // Comma-separated multi-target. Trailing direction word (incoming/in,
    // outgoing/out, both/bi + arrow aliases) applies to all @waN tokens in
    // this call; subsequent /use calls can mix.
    const allTokens = target.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    let dir = 'both';
    const positional = [];
    for (const t of allTokens) {
      const dn = DIR_WORDS[t.toLowerCase()];
      if (dn) dir = dn;
      else positional.push(t);
    }
    const waTokens = positional.filter(t => /^@wa\d+$/i.test(t));
    const brainTokens = positional.filter(t => !/^@wa\d+$/i.test(t));
    const unknown = brainTokens.filter(n => !sessions[n]);
    if (unknown.length) {
      sysOut(`!! unknown session(s): ${unknown.join(', ')} — /sessions to list`);
      return true;
    }
    const waAdds = [];
    for (const t of waTokens) {
      const idx = parseInt(t.match(/^@wa(\d+)$/i)[1], 10) - 1;
      const chat = waChannelsCacheRef.current[idx];
      if (!chat) {
        sysOut(`!! /use ${t}: no channel at that index. Run /channels first.`);
        return true;
      }
      if (!waBridgeRef.current) {
        sysOut(`!! /use ${t}: whatsapp bridge not running`);
        return true;
      }
      waAdds.push({ jid: chat.jid, name: chat.name, idx, dir });
    }
    if (brainTokens.length) {
      const merged = [...new Set([...activeSessions, ...brainTokens])];
      setActiveSessions(merged);
    }
    for (const e of waAdds) waJoined.add(e);
    sysOut(`active recipients -> ${[
      activeSessions.length || brainTokens.length
        ? [...new Set([...activeSessions, ...brainTokens])].join(', ')
        : null,
      waJoined.size() > 0 ? fmtWaTargets() : null,
    ].filter(Boolean).join(' + ')}  (↔ bidirectional, → outgoing, ← incoming)`);
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

  if (cmd === '/join') {
    const toks = arg.trim().split(/[\s,]+/).filter(Boolean);
    let dir = 'both';
    const waTokens = [];
    for (const t of toks) {
      const d = DIR_WORDS[t.toLowerCase()];
      if (d) dir = d;
      else if (/^@wa\d+$/i.test(t)) waTokens.push(t);
      else { sysOut(`!! /join: "${t}" isn't @waN or a direction word (incoming | outgoing | both)`); return true; }
    }
    if (!waTokens.length) {
      sysOut('usage: /join @waN[,@waM,…] [incoming|outgoing|both]   (N from /channels)');
      return true;
    }
    if (!waBridgeRef.current) {
      sysOut('!! /join: whatsapp bridge not running');
      return true;
    }
    const adds = [];
    for (const t of waTokens) {
      const idx = parseInt(t.match(/^@wa(\d+)$/i)[1], 10) - 1;
      const chat = waChannelsCacheRef.current[idx];
      if (!chat) {
        sysOut(`!! /join: no @wa${idx + 1} in cache — run /channels first`);
        return true;
      }
      adds.push({ jid: chat.jid, name: chat.name, idx, dir });
    }
    for (const e of adds) waJoined.add(e);
    const chat = adds[0];
    const idx = chat.idx;
    // Broadcast on the bus so peers with whatsapp.follow_join adopt.
    const tid = busTargetIdRef.current;
    if (tid) {
      for (const a of adds) {
        bus.postEvent(tid, {
          type: 'wa-join', from: BUS_NODE_ID, ts: Date.now(),
          jid: a.jid, name: a.name,
        }).catch(() => {});
      }
    }
    const dirNote =
      dir === 'in'  ? ' (incoming only — they reach shell, shell-typed text does not)' :
      dir === 'out' ? ' (outgoing only — shell-typed text reaches them, their arrivals do not render)' :
      '';
    sysOut(
      `joined ${adds.map(a => `@wa${a.idx + 1} "${a.name}"`).join(', ')}${dirNote}. ` +
      (waJoined.size() > adds.length ? `Currently ${waJoined.size()} WA chats joined. ` : '') +
      `/unjoin to release${waJoined.size() > 1 ? ' all, /unjoin @waN to drop one' : ''}.`
    );
    return true;
  }

  if (cmd === '/unjoin') {
    const target = arg.trim();
    if (!waJoined.size()) {
      sysOut('/unjoin: not joined');
      return true;
    }
    if (target) {
      const m = target.match(/^@wa(\d+)$/i);
      if (!m) { sysOut('usage: /unjoin [@waN]   (omit to release all)'); return true; }
      const idx = parseInt(m[1], 10) - 1;
      const chat = waChannelsCacheRef.current[idx];
      if (!chat || !waJoined.remove(chat.jid)) {
        sysOut(`!! @wa${idx + 1} not currently joined`);
        return true;
      }
      const tid = busTargetIdRef.current;
      if (tid) {
        bus.postEvent(tid, {
          type: 'wa-join', from: BUS_NODE_ID, ts: Date.now(), jid: null,
          removed: chat.jid,
        }).catch(() => {});
      }
      sysOut(`released @wa${idx + 1} "${chat.name}"  (${waJoined.size()} remaining)`);
      return true;
    }
    const all = waJoined.all();
    waJoined.clear();
    const tid = busTargetIdRef.current;
    if (tid) {
      bus.postEvent(tid, {
        type: 'wa-join', from: BUS_NODE_ID, ts: Date.now(), jid: null,
      }).catch(() => {});
    }
    sysOut(`released ${all.length === 1
      ? `@wa${all[0].idx + 1} "${all[0].name}"`
      : `${all.length} WA chats`}`);
    return true;
  }

  return false;
}
