// slash/telegram.mjs — telegram polling management + authorization.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const EGPT_HOME = join(homedir(), '.egpt');

export const meta = {
  cmd: '/telegram',
  section: 'MISC',
  surface: 'both',
  usage: '/telegram [<node>|disconnect|allow <id>|revoke <id>|allowed]',
  desc: 'manage telegram polling, handoff, and authorized users',
};

export async function run({ arg, ctx }) {
  // ctx keys consumed:
  //   sysOut(text)
  //   BUS_NODE_ID
  //   tgPolling                — bool flag for current shell's polling state
  //   peerNodesRef             — bus peers
  //   stopTgBridge / startTgBridge
  //   bus / busTargetIdRef
  //   tgCfgRef                 — live config ref (for in-place allowed_users edits)
  //   tgBridgeRef              — ref → bridge (for restart fallback)
  const { sysOut, BUS_NODE_ID, tgPolling, peerNodesRef,
          stopTgBridge, startTgBridge, bus, busTargetIdRef,
          tgCfgRef, tgBridgeRef } = ctx;

  const argParts = arg.trim().split(/\s+/).filter(Boolean);
  const sub = argParts[0] ?? '';
  const subArg = argParts.slice(1).join(' ').trim();

  // No-arg: status report.
  if (!sub) {
    const me = `  ${BUS_NODE_ID}  (this shell)  ${tgPolling ? 'polling' : 'idle'}`;
    const peerLines = [];
    for (const [nodeId, peer] of peerNodesRef.current) {
      peerLines.push(`  ${nodeId}  (${peer.role ?? '?'})  ${peer.polling ? 'polling' : 'idle'}`);
    }
    sysOut(
      `telegram polling status:\n${me}` +
      (peerLines.length ? '\n' + peerLines.join('\n') : '\n  (no peers on bus)') +
      `\n\n/telegram <node>            hand polling to that node` +
      `\n/telegram disconnect         stop polling on this node` +
      `\n/telegram allow <userId>     authorize a Telegram user to issue commands` +
      `\n/telegram revoke <userId>    remove a user's authorization` +
      `\n/telegram allowed            list authorized users`
    );
    return true;
  }

  if (sub === 'disconnect') {
    if (tgPolling) stopTgBridge();
    else sysOut('telegram: not polling on this node');
    return true;
  }

  if (sub === 'allow' || sub === 'revoke') {
    const idStr = subArg.replace(/^@/, '');
    const userId = parseInt(idStr, 10);
    if (!Number.isFinite(userId)) {
      sysOut(`!! /telegram ${sub} <userId> — userId must be the numeric Telegram id (the bot prints it when an unauthorized user tries a command)`);
      return true;
    }
    // Read ~/.egpt/config.json, update telegram.allowed_users, write back.
    // Prefer mutating the live tgCfgRef array in place so the running
    // bridge's closure sees the change without a restart.
    const { readConfig, writeConfig } = await import('../tools/config-io.mjs');
    const cfg = await readConfig();
    if (!cfg.telegram || typeof cfg.telegram !== 'object') cfg.telegram = {};
    if (!Array.isArray(cfg.telegram.allowed_users)) cfg.telegram.allowed_users = [];
    if (sub === 'allow') {
      if (!cfg.telegram.allowed_users.includes(userId)) cfg.telegram.allowed_users.push(userId);
    } else {
      cfg.telegram.allowed_users = cfg.telegram.allowed_users.filter(id => id !== userId);
    }
    await writeConfig(cfg);

    const live = tgCfgRef.current?.telegram?.allowed_users;
    if (Array.isArray(live)) {
      live.splice(0, live.length, ...cfg.telegram.allowed_users);
      sysOut(`telegram: ${sub === 'allow' ? 'allowed' : 'revoked'} user ${userId} (live)`);
    } else if (tgBridgeRef.current) {
      // Bridge had a different reference — restart to pick up the new list.
      stopTgBridge();
      tgCfgRef.current = cfg;
      await startTgBridge();
      sysOut(`telegram: ${sub === 'allow' ? 'allowed' : 'revoked'} user ${userId} (bridge restarted)`);
    } else {
      sysOut(`telegram: ${sub === 'allow' ? 'allowed' : 'revoked'} user ${userId} (no bridge running here; will apply when this node next polls)`);
    }
    return true;
  }

  if (sub === 'allowed') {
    const cfgPath = join(EGPT_HOME, 'config.json');
    let cfg = {};
    try { cfg = JSON.parse(await readFile(cfgPath, 'utf8')); } catch {}
    const ids = cfg.telegram?.allowed_users ?? [];
    if (ids.length === 0) {
      sysOut('telegram: no allowed users — commands and mentions from any Telegram user are rejected');
    } else {
      sysOut(`telegram allowed users (~/.egpt/config.json):\n${ids.map(id => `  ${id}`).join('\n')}`);
    }
    return true;
  }

  // Hand off to a peer (or to ourselves to reclaim).
  const tid = busTargetIdRef.current;
  if (!tid) { sysOut('!! bus not joined — handoff requires bus'); return true; }
  const to = sub.replace(/^@/, '');

  if (to === BUS_NODE_ID || to === 'shell') {
    // Self-reclaim: broadcast handoff first so any peer holding the
    // slot yields, then start ours after a 1.5s settle (Bot API
    // 409s for several seconds after a polling stop).
    await bus.postEvent(tid, { type: 'telegram-handoff', from: BUS_NODE_ID,
      ts: Date.now(), to: BUS_NODE_ID });
    await new Promise(r => setTimeout(r, 1500));
    await startTgBridge();
    return true;
  }

  // Validate peer; if no exact id match, try role-based dispatch.
  const peer = peerNodesRef.current.get(to);
  if (!peer) {
    const candidates = [...peerNodesRef.current.entries()].filter(([_, p]) => p.role === to);
    if (candidates.length === 1) {
      const [nodeId] = candidates[0];
      if (tgPolling) stopTgBridge();
      await bus.postEvent(tid, { type: 'telegram-handoff', from: BUS_NODE_ID,
        ts: Date.now(), to: nodeId });
      sysOut(`telegram: handoff posted to ${nodeId}`);
      return true;
    }
    if (candidates.length > 1) {
      sysOut(`!! ambiguous role "${to}"; pick one of: ${candidates.map(([n]) => n).join(', ')}`);
      return true;
    }
    sysOut(`!! no peer "${to}" on bus — /telegram with no arg lists peers`);
    return true;
  }
  if (tgPolling) stopTgBridge();
  await bus.postEvent(tid, { type: 'telegram-handoff', from: BUS_NODE_ID,
    ts: Date.now(), to });
  sysOut(`telegram: handoff posted to ${to}`);
  return true;
}
