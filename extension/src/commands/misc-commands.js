// extension/src/commands/misc-commands.js — pure handlers for the
// remaining slash commands: /config, /telegram, /clear, /help.
// Same DI pattern as wa-commands.js / session-commands.js.

// /config [key] [value]
//   no args: dump sync + local storage
//   key only: not supported in current code (falls through to set with empty val)
//   key value: chrome.storage.sync.set({ [key]: parsed-or-raw })
//   When key === 'telegram', kick the bridge to restart with the new value.
//
// ctx:
//   log(text)
//   storageSync   chrome.storage.sync ({ get, set })
//   storageLocal  chrome.storage.local ({ get })
//   onTelegramConfigChange()      hook called when key === 'telegram'
export async function config(rest, ctx) {
  const { log, storageSync, storageLocal, onTelegramConfigChange } = ctx;
  const parts = (rest ?? '').trim().split(/\s+/);
  const key = parts[0];
  const valParts = parts.slice(1);
  if (!key) {
    const sync = await storageSync.get(null);
    const local = await storageLocal.get(null);
    log(JSON.stringify({ sync, local }, null, 2));
    return;
  }
  const raw = valParts.join(' ');
  let val = raw;
  try { val = JSON.parse(raw); } catch (_) { /* keep raw string */ }
  await storageSync.set({ [key]: val });
  log(`Set ${key} = ${JSON.stringify(val)}`);
  if (key === 'telegram') {
    try { await onTelegramConfigChange?.(); } catch (_) {}
  }
}

// /telegram                 status report (this node + peers)
// /telegram disconnect      stop polling on this node
// /telegram allow <id>      append numeric Telegram user id to allowed list
// /telegram revoke <id>     remove from allowed list
// /telegram allowed         list authorized users
// /telegram <node|role>     handoff polling to that peer (or self)
//
// ctx:
//   log(text), error(text)
//   storageSync                 ({ get, set })
//   getNodeId()                 → BUS_NODE_ID
//   getTgPolling()              → boolean
//   startBridge() / stopBridge()
//   getPeerNodes()              → Map of peer nodes
//   busTargetId()               → bus-relay tid (null when not joined)
//   postBusEvent(tid, event)    bus.postEvent wrapper
export async function telegram(rest, ctx) {
  const {
    log, error, storageSync,
    getNodeId, getTgPolling, startBridge, stopBridge,
    getPeerNodes, busTargetId, postBusEvent,
  } = ctx;
  const parts = (rest ?? '').trim().split(/\s+/).filter(Boolean);
  const sub = parts[0];
  const subArg = parts.slice(1).join(' ').trim();
  const NODE = getNodeId();
  const tgPolling = getTgPolling();
  const peers = getPeerNodes();

  // No-arg status report
  if (!sub) {
    const me = `  ${NODE}  (this extension)  ${tgPolling ? 'polling' : 'idle'}`;
    const peerLines = [];
    for (const [nodeId, peer] of peers) {
      peerLines.push(`  ${nodeId}  (${peer.role ?? '?'})  ${peer.polling ? 'polling' : 'idle'}`);
    }
    log(
      `telegram polling status:\n${me}` +
      (peerLines.length ? '\n' + peerLines.join('\n') : '\n  (no peers on bus)') +
      `\n\n/telegram <node>            hand polling to that node` +
      `\n/telegram disconnect         stop polling on this node` +
      `\n/telegram allow <userId>     authorize a Telegram user to issue commands` +
      `\n/telegram revoke <userId>    remove a user's authorization` +
      `\n/telegram allowed            list authorized users`,
    );
    return;
  }

  if (sub === 'disconnect') {
    if (tgPolling) { await stopBridge(); log('telegram: disconnected'); }
    else log('telegram: not polling on this extension');
    return;
  }

  if (sub === 'allow' || sub === 'revoke') {
    const idStr = subArg.replace(/^@/, '');
    const userId = parseInt(idStr, 10);
    if (!Number.isFinite(userId)) {
      error(`/telegram ${sub} <userId> — userId must be the numeric Telegram id`);
      return;
    }
    const got = await storageSync.get('telegram');
    const tg = got?.telegram ?? {};
    const allowed = Array.isArray(tg.allowed_users) ? [...tg.allowed_users] : [];
    if (sub === 'allow') {
      if (!allowed.includes(userId)) allowed.push(userId);
    } else {
      const idx = allowed.indexOf(userId);
      if (idx >= 0) allowed.splice(idx, 1);
    }
    await storageSync.set({ telegram: { ...tg, allowed_users: allowed } });
    log(`telegram: ${sub === 'allow' ? 'allowed' : 'revoked'} user ${userId}`);
    return;
  }

  if (sub === 'allowed') {
    const got = await storageSync.get('telegram');
    const ids = got?.telegram?.allowed_users ?? [];
    if (ids.length === 0) {
      log('telegram: no allowed users — commands and mentions from any Telegram user are rejected');
    } else {
      log(`telegram allowed users:\n${ids.map(id => `  ${id}`).join('\n')}`);
    }
    return;
  }

  // Handoff to another node (or back to self)
  const tid = busTargetId();
  if (!tid) { error('bus not joined — handoff requires bus'); return; }
  const to = sub.replace(/^@/, '');
  if (to === NODE || to === 'chrome' || to === 'extension') {
    await startBridge();
    return;
  }
  const peer = peers.get(to);
  if (!peer) {
    const candidates = [...peers.entries()].filter(([_, p]) => p.role === to);
    if (candidates.length === 1) {
      const [nodeId] = candidates[0];
      if (tgPolling) await stopBridge();
      await postBusEvent(tid, { type: 'telegram-handoff', from: NODE, ts: Date.now(), to: nodeId });
      log(`telegram: handoff posted to ${nodeId}`);
      return;
    }
    if (candidates.length > 1) {
      error(`ambiguous role "${to}"; pick one of: ${candidates.map(([n]) => n).join(', ')}`);
      return;
    }
    error(`no peer "${to}" on bus — /telegram with no arg lists peers`);
    return;
  }
  if (tgPolling) await stopBridge();
  await postBusEvent(tid, { type: 'telegram-handoff', from: NODE, ts: Date.now(), to });
  log(`telegram: handoff posted to ${to}`);
}

// /clear — drop the visible message log.
// ctx: clearMessages()
export async function clear(_rest, ctx) {
  ctx.clearMessages();
}

// /help — print help text.
// ctx: log(text), getBrainNames() → string[], formatHelp(brains) → string
export async function help(_rest, ctx) {
  ctx.log(ctx.formatHelp(ctx.getBrainNames()));
}
