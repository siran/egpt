// slash/e.mjs — operator controls for the @e persona's behavior.
//
// Subcommands:
//
//   /e auto on|off [<jid>]         — toggle auto_e_chats membership
//   /e auto pause|resume           — globally suspend / re-enable dispatch
//   /e auto status                 — list configured chats + paused state
//
//   /e personality <name>          — set personality on the current
//                                    chat's contact (or --slug / --jid)
//   /e heartbeat on|off            — opt the current contact in/out of
//                                    per-contact heartbeats
//   /e heartbeat interval <min>    — set per-contact heartbeat cadence
//                                    (minutes; default 30)
//
// "Current chat" = where the slash was invoked. WA-originated invocations
// use the WA chat JID. Shell-originated invocations require an explicit
// --jid <jid> or --slug <slug>.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CONV_YAML_PATH,
  readState as readConvState,
  writeState as writeConvState,
  findContactByJid,
  patchContact,
} from '../conversations-state.mjs';

export const meta = {
  cmd: '/e',
  section: 'PERSONA',
  surface: 'shell',
  usage: '/e auto on|off [<jid>] | /e auto pause|resume|status | /e personality <name> [--slug|--jid] | /e heartbeat on|off|interval <min> [--slug|--jid]',
  desc: 'control @e auto-dispatch, personality, and heartbeats per contact',
};

async function _persistWaConfig(EGPT_HOME) {
  const cfgPath = join(EGPT_HOME, 'config.json');
  let saved = {};
  try { saved = JSON.parse(await readFile(cfgPath, 'utf8')); } catch {}
  if (!saved.whatsapp || typeof saved.whatsapp !== 'object') saved.whatsapp = {};
  return { cfgPath, saved };
}

export async function run({ arg, meta: dispatchMeta, ctx }) {
  const { sysOut, EGPT_CONFIG, EGPT_HOME } = ctx;
  const tokens = arg.split(/\s+/).filter(Boolean);
  const [sub, action, jidArg] = tokens;

  // ── /e personality <name> [--slug <s> | --jid <j>] ──────────────
  if (sub === 'personality') {
    const tokens2 = arg.split(/\s+/).filter(Boolean);
    let name = tokens2[1] ?? null;
    let slugFlag = null;
    let jidFlag = null;
    for (let i = 2; i < tokens2.length; i++) {
      if (tokens2[i] === '--slug' && tokens2[i + 1]) slugFlag = tokens2[++i];
      if (tokens2[i] === '--jid'  && tokens2[i + 1]) jidFlag  = tokens2[++i];
    }
    if (!name) { sysOut('usage: /e personality <name> [--slug <s> | --jid <j>]'); return true; }
    const cs = await readConvState(CONV_YAML_PATH);
    const targetSlug = slugFlag ?? findContactByJid(cs, jidFlag ?? dispatchMeta?.waChatId);
    if (!targetSlug) {
      sysOut(`!! /e personality: no contact for ${slugFlag ?? jidFlag ?? dispatchMeta?.waChatId ?? '<no chat context>'}`);
      return true;
    }
    const next = patchContact(cs, targetSlug, { personality: name });
    await writeConvState(CONV_YAML_PATH, next);
    sysOut(`/e personality: ${targetSlug} → ${name} (run /egpt new --slug ${targetSlug} to apply on a fresh thread)`);
    return true;
  }

  // ── /e heartbeat on|off | interval <min> [--slug | --jid] ────────
  if (sub === 'heartbeat') {
    const tokens2 = arg.split(/\s+/).filter(Boolean);
    const hbAction = tokens2[1] ?? null;
    let value = tokens2[2] ?? null;
    let slugFlag = null;
    let jidFlag = null;
    for (let i = 1; i < tokens2.length; i++) {
      if (tokens2[i] === '--slug' && tokens2[i + 1]) slugFlag = tokens2[++i];
      if (tokens2[i] === '--jid'  && tokens2[i + 1]) jidFlag  = tokens2[++i];
    }
    if (!hbAction || !['on','off','interval'].includes(hbAction)) {
      sysOut('usage: /e heartbeat on|off | /e heartbeat interval <min> [--slug | --jid]');
      return true;
    }
    const cs = await readConvState(CONV_YAML_PATH);
    const targetSlug = slugFlag ?? findContactByJid(cs, jidFlag ?? dispatchMeta?.waChatId);
    if (!targetSlug) {
      sysOut(`!! /e heartbeat: no contact for ${slugFlag ?? jidFlag ?? dispatchMeta?.waChatId ?? '<no chat context>'}`);
      return true;
    }
    let patch = {};
    if (hbAction === 'on')  patch.heartbeatEnabled = true;
    if (hbAction === 'off') patch.heartbeatEnabled = false;
    if (hbAction === 'interval') {
      const mins = parseInt(value, 10);
      if (!Number.isFinite(mins) || mins < 1) {
        sysOut('!! /e heartbeat interval: minutes must be a positive integer'); return true;
      }
      patch.heartbeatIntervalMin = mins;
    }
    const next = patchContact(cs, targetSlug, patch);
    await writeConvState(CONV_YAML_PATH, next);
    const e = next.contacts[targetSlug];
    sysOut(`/e heartbeat: ${targetSlug} enabled=${!!e.heartbeatEnabled} interval=${e.heartbeatIntervalMin ?? 30}min`);
    return true;
  }

  if (sub !== 'auto') {
    sysOut('usage: /e auto on|off [<jid>] | /e auto pause|resume|status | /e personality <name> | /e heartbeat on|off|interval <min>');
    return true;
  }

  if (!EGPT_CONFIG.whatsapp || typeof EGPT_CONFIG.whatsapp !== 'object') {
    EGPT_CONFIG.whatsapp = {};
  }
  const wa = EGPT_CONFIG.whatsapp;
  if (!Array.isArray(wa.auto_e_chats)) wa.auto_e_chats = [];

  const resolveChatId = () => {
    if (jidArg) return jidArg;
    if (dispatchMeta?.waChatId) return dispatchMeta.waChatId;
    return null;
  };

  if (action === 'status') {
    const list = wa.auto_e_chats.length
      ? wa.auto_e_chats.map(j => `  - ${j}`).join('\n')
      : '  (none)';
    const paused = wa.auto_e_paused ? 'PAUSED (global kill on)' : 'active';
    sysOut(`auto_e_chats: ${paused}\n${list}`);
    return true;
  }

  if (action === 'pause') {
    wa.auto_e_paused = true;
  } else if (action === 'resume') {
    wa.auto_e_paused = false;
  } else if (action === 'on' || action === 'off') {
    const chatId = resolveChatId();
    if (!chatId) {
      sysOut('/e auto on|off: no chat context — pass a JID explicitly (e.g. `/e auto on 120363407494846096@g.us`)');
      return true;
    }
    if (action === 'on') {
      if (!wa.auto_e_chats.includes(chatId)) wa.auto_e_chats.push(chatId);
    } else {
      wa.auto_e_chats = wa.auto_e_chats.filter(j => j !== chatId);
    }
  } else {
    sysOut('usage: /e auto on|off [<jid>] | pause | resume | status');
    return true;
  }

  // Persist to ~/.egpt/config.json (merge with whatever else is there).
  try {
    const { cfgPath, saved } = await _persistWaConfig(EGPT_HOME);
    saved.whatsapp.auto_e_chats = wa.auto_e_chats;
    saved.whatsapp.auto_e_paused = !!wa.auto_e_paused;
    await mkdir(EGPT_HOME, { recursive: true });
    await writeFile(cfgPath, JSON.stringify(saved, null, 2) + '\n');
  } catch (e) {
    sysOut(`!! /e auto: persist failed: ${e.message}`);
    return true;
  }

  if (action === 'on' || action === 'off') {
    const chatId = resolveChatId();
    sysOut(`/e auto ${action}: ${chatId}`);
  } else {
    sysOut(`/e auto ${action}`);
  }
  return true;
}
