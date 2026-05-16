// slash/e.mjs — operator controls for the @e persona's behavior.
//
// Subcommands (today: just `auto`, the auto_e_chats toggle):
//
//   /e auto on              add the CURRENT chat to auto_e_chats
//   /e auto off             remove the CURRENT chat
//   /e auto pause           globally suspend auto-dispatch (per-chat list unchanged)
//   /e auto resume          re-enable auto-dispatch
//   /e auto status          list configured chats + paused state
//
// "Current chat" = where the slash was invoked. WA-originated invocations
// use the WA chat JID. Shell-originated invocations have no chat context,
// so on/off require the JID as an explicit second arg: `/e auto on <jid>`.
//
// State lives in EGPT_CONFIG.whatsapp.auto_e_chats (array of JIDs) and
// EGPT_CONFIG.whatsapp.auto_e_paused (boolean). Persisted to
// ~/.egpt/config.json via the same path as other whatsapp config.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const meta = {
  cmd: '/e',
  section: 'PERSONA',
  surface: 'shell',
  usage: '/e auto on|off [<jid>] | /e auto pause|resume | /e auto status',
  desc: 'control @e auto-dispatch in chats (auto_e_chats)',
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

  if (sub !== 'auto') {
    sysOut('usage: /e auto on|off [<jid>] | pause | resume | status');
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
