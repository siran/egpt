// extension/src/commands/wa-commands.js — pure command handlers for
// the WA-CDP slash commands. Extracted from App.jsx's handleCommand
// so the side effects (storage reads, bridge calls, state mutations,
// user-visible logs) can be exercised by unit tests with mocked deps.
//
// Each handler takes (rest, ctx) where:
//   rest  — string after the command word, e.g. for '/join @wa3'
//           rest is '@wa3'.
//   ctx   — dependency-injection bag. The React side wires this to
//           waCdpBridgeRef.current, chrome.storage.sync, appendMsg,
//           waChannelsRef, waJoinedRef, etc. Tests pass mocks.
//
// ctx contract (not all commands use every field):
//   bridge          { listChannels({limit}), send(text, opts) } | null
//   storage         { get(key) → Promise<obj> }
//   log(text)       user-visible egpt message (no '!! ' prefix)
//   error(text)     user-visible egpt error  (handler does NOT add
//                   '!! ', the caller's wrapper does)
//   getChannels()   → cached chat list from the most recent /channels
//   setChannels(c)  update the cached chat list
//   getJoined()     → currently /join'd chat or null
//   setJoined(v)    update the /join binding
//   getSessions()   → Map of attached sessions (name → {brain, …})
//   getLastIncoming() → last observed inbound message (for /mirror)
//   runBrainE(text, sender)               dispatch to the dedicated 'e' thread
//   runBrainSession(name, text, sender)   dispatch to a named session

export async function channels(rest, ctx) {
  const { bridge, storage, log, error, setChannels } = ctx;
  if (!bridge) {
    error('/channels: WA-CDP bridge not ready (open web.whatsapp.com)');
    return;
  }
  const got = await storage.get('whatsapp_cdp');
  const cfg = got?.whatsapp_cdp ?? {};
  const configDefault = parseInt(cfg.channels_default, 10);
  const defaultLimit = Number.isFinite(configDefault) && configDefault > 0 ? configDefault : 10;
  const argLimit = parseInt(rest, 10);
  const limit = Number.isFinite(argLimit) && argLimit > 0 ? argLimit : defaultLimit;
  let chats;
  try {
    chats = await bridge.listChannels({ limit });
  } catch (e) {
    error(`/channels: ${e?.message ?? e}`);
    return;
  }
  setChannels(chats);
  if (!chats.length) {
    log('/channels: no chats visible (chat list panel not open?)');
    return;
  }
  const lines = chats.map((c, i) => {
    const jidTag = c.jid ? `  [${c.jid}]` : '  [no-jid]';
    const prev = c.preview ? `  — ${c.preview}` : '';
    return `  @wa${i + 1}  ${c.name}${jidTag}${prev}`;
  });
  log(`chats (top ${chats.length}, use /join @waN to bind):\n${lines.join('\n')}`);
}

export async function join(rest, ctx) {
  const { getChannels, setJoined, log, error } = ctx;
  const arg = (rest ?? '').trim();
  const m = arg.match(/^@wa(\d+)$/i);
  if (!m) {
    error('/join: usage /join @waN  (run /channels first to see N)');
    return;
  }
  const idx = parseInt(m[1], 10) - 1;
  const chat = getChannels()[idx];
  if (!chat) {
    error(`/join: no @wa${idx + 1} in cached list. /channels first.`);
    return;
  }
  setJoined(chat);
  log(`/join: bound to @wa${idx + 1} = "${chat.name}". Outbound goes there. /unjoin to release.`);
}

export async function unjoin(_rest, ctx) {
  const { getJoined, setJoined, log } = ctx;
  const prev = getJoined();
  setJoined(null);
  log(prev ? `/unjoin: released "${prev.name}"` : '/unjoin: nothing was joined');
}

export async function mirror(rest, ctx) {
  const {
    bridge, getLastIncoming, getChannels, getSessions,
    runBrainE, runBrainSession, log, error,
  } = ctx;
  const last = getLastIncoming();
  if (!last) {
    error('/mirror: no recent message to mirror');
    return;
  }
  const arg = (rest ?? '').trim();
  if (!arg.startsWith('@')) {
    log('/mirror: usage /mirror @<target>  (e.g. @e, @wa3, @cgpt1)');
    return;
  }
  const target = arg.slice(1).toLowerCase();
  const formatted = `[${last.sender}]: ${last.text}`;

  // @e / @egpt — dedicated persona thread
  if (target === 'e' || target === 'egpt') {
    try {
      await runBrainE(last.text, last.sender);
    } catch (e) {
      error(`/mirror @e failed: ${e?.message ?? e}`);
    }
    return;
  }

  // @waN — WA channel from /channels cache
  const waMatch = target.match(/^wa(\d+)$/);
  if (waMatch) {
    const idx = parseInt(waMatch[1], 10) - 1;
    const chat = getChannels()[idx];
    if (!chat) {
      error(`/mirror @wa${idx + 1}: not in cached list. /channels first.`);
      return;
    }
    if (!bridge) {
      error('/mirror: WA-CDP bridge not ready');
      return;
    }
    try {
      await bridge.send(formatted, { chatName: chat.name, chatJid: chat.jid });
      log(`→ /mirror @wa${idx + 1} (${chat.name}): ${formatted.slice(0, 60)}…`);
    } catch (e) {
      error(`/mirror @wa${idx + 1} failed: ${e?.message ?? e}`);
    }
    return;
  }

  // @<session> — attached local brain (preserve original case for lookup)
  const sessionName = arg.slice(1);
  if (getSessions().has(sessionName)) {
    try {
      await runBrainSession(sessionName, last.text, last.sender);
    } catch (e) {
      error(`/mirror @${sessionName} failed: ${e?.message ?? e}`);
    }
    return;
  }

  error(`/mirror: unknown target @${arg.slice(1)}. Try @e, @waN (after /channels), or a session name (/sessions to list).`);
}
