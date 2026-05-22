// slash/e.mjs — operator controls for conversation-e in the current chat.
//
// `/e` always acts on the chat where it was typed (its `waChatId`). For
// targeting a chat from outside, use `/egpt <verb> [<persona>] <name-search>`.
//
// Subcommands:
//
//   /e new [<persona>]             — reboot conversation-e: clear the
//                                    claude thread, install <persona>
//                                    (default 'default'), copy
//                                    identity/rules/pointers into the
//                                    slug-dir, and send the "Reboot
//                                    complete" announcement.
//   /e persona [<persona>]         — install (or re-install) a persona
//                                    on the EXISTING thread. Same
//                                    announcement frame, threadId
//                                    preserved.
//
//   /e auto on|off [<jid>]         — toggle auto_e_chats membership
//   /e auto pause|resume           — globally suspend / re-enable dispatch
//   /e auto status                 — list configured chats + paused state
//
//   /e heartbeat on|off            — opt the current contact in/out of
//                                    per-contact heartbeats
//   /e heartbeat interval <min>    — set per-contact heartbeat cadence
//                                    (minutes; default 30)
//   /e butler <prompt>             — ephemeral haiku sub-agent (no
//                                    session memory, default all-tools)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CONV_YAML_PATH,
  readState as readConvState,
  writeState as writeConvState,
  findContactByJid,
  patchContact,
  installPersonaIntoSlugDir,
  buildRebootAnnouncement,
  resolvePersonalityFile,
} from '../conversations-state.mjs';
import { readConfig, writeConfig } from '../src/tools/config-io.mjs';
import { homedir } from 'node:os';

export const meta = {
  cmd: '/e',
  section: 'PERSONA',
  surface: 'both',
  usage: '/e new [<persona>] | /e persona [<persona>] | /e auto on|off [<jid>] | /e auto pause|resume|status | /e heartbeat on|off|interval <min> [--slug|--jid]',
  desc: 'reboot conversation-e in this chat; control auto-dispatch and heartbeats',
};

// Legacy stub kept only because other call paths may import it. The
// /e auto branch now reads/writes directly via config-io.
async function _persistWaConfig() {
  const saved = await readConfig();
  if (!saved.whatsapp || typeof saved.whatsapp !== 'object') saved.whatsapp = {};
  return { saved };
}

// Shared kickoff used by /e new (resetThread=true) and /e persona (false).
// Both fire the same "Reboot complete" announcement frame; the difference
// is whether the underlying claude thread is cleared first or continued.
// Exported so /egpt new and /egpt persona can call it with a JID resolved
// from a name-search.
export async function _runReboot({ resetThread, personaName, targetJid, sysOut, ctx, originJid, surface = 'whatsapp' }) {
  const { computeBrainTurn } = ctx;
  // Validate persona exists before touching state.
  const personaFile = resolvePersonalityFile(personaName);
  if (!personaFile) {
    sysOut(`!! /e ${resetThread ? 'new' : 'persona'}: no personality "${personaName}" (looked under personalities/ and ~/.egpt/personalities/)`);
    return true;
  }

  let cs = await readConvState(CONV_YAML_PATH);
  const slug = findContactByJid(cs, surface, targetJid);
  if (!slug) {
    sysOut(`!! /e ${resetThread ? 'new' : 'persona'}: no contact registered for jid "${targetJid}" under surface "${surface}". Send a message in that chat first so @e registers it.`);
    return true;
  }

  // Patch persona + (for /e new) clear thread state. Both branches re-stamp
  // identityInjectedAt because both are doing an identity install.
  const patch = { personality: personaName, identityInjectedAt: null };
  if (resetThread) { patch.threadId = null; patch.threadCreatedAt = null; }
  cs = patchContact(cs, surface, slug, patch);
  await writeConvState(CONV_YAML_PATH, cs);

  // Copy identity.md, rules.md, pointers.md into the slug-dir.
  // Conversation-e is sandboxed to that dir and will read them at ./*.md.
  let bundle;
  try {
    bundle = await installPersonaIntoSlugDir(surface, slug, personaName);
  } catch (e) {
    sysOut(`!! /e ${resetThread ? 'new' : 'persona'}: copying persona files failed — ${e?.message ?? e}`);
    return true;
  }

  // Build the announcement frame (same for /e new and /e persona).
  const announcement = buildRebootAnnouncement(personaName, bundle);

  // 1) Send announcement to the chat directly via outbox, framed as system-e.
  try {
    const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const ev = {
      type: 'wa-send', from: 'e', ts: Date.now(),
      jid: targetJid,
      body: `🧠 eGPT:\n\n${announcement}`,
    };
    await writeFile(join(homedir(), '.egpt', 'outbox', id + '.json'), JSON.stringify(ev));
  } catch (e) {
    sysOut(`!! /e ${resetThread ? 'new' : 'persona'}: outbox write failed — ${e?.message ?? e}`);
    // Continue anyway — the kickoff turn below may still succeed.
  }

  // 2) Kick off the conversation-e thread with the same announcement as
  //    its first user-turn. bypassAutoWrap skips the lineage auto-wrap so
  //    we don't double-embed identity.
  const entry = cs.contacts[surface]?.[targetJid] ?? null;
  const pushedName = entry?.pushedName ?? slug;
  try {
    const reply = await computeBrainTurn('e', announcement, {
      threadId: targetJid,
      surface:  'wa',
      slug,
      name:     pushedName,
      bypassAutoWrap: true,
    });
    const ackText = String(reply ?? '').trim();
    if (!ackText) {
      sysOut(`!! /e ${resetThread ? 'new' : 'persona'} ${slug}: kickoff produced empty reply — check /log.`);
    } else {
      sysOut(`/e ${resetThread ? 'new' : 'persona'} ${slug}: persona=${personaName} (@e: "${ackText.slice(0, 80)}${ackText.length > 80 ? '…' : ''}")`);
    }
    // Relay conversation-e's reply to the chat if we have a different
    // originating chat (so the operator who typed the slash sees it too).
    if (originJid && originJid !== targetJid && ackText && ackText !== '...' && ackText !== '…') {
      const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      const ev = { type: 'wa-send', from: 'e', ts: Date.now(), jid: originJid, body: ackText };
      await writeFile(join(homedir(), '.egpt', 'outbox', id + '.json'), JSON.stringify(ev));
    }
  } catch (e) {
    sysOut(`!! /e ${resetThread ? 'new' : 'persona'} ${slug}: kickoff failed — ${e?.message ?? e}`);
  }
  return true;
}

export async function run({ arg, meta: dispatchMeta, ctx }) {
  const { sysOut, EGPT_CONFIG, EGPT_HOME } = ctx;
  const tokens = arg.split(/\s+/).filter(Boolean);
  const [sub, action, jidArg] = tokens;

  // ── /e new [<persona>] ──────────────────────────────────────────
  // Reboot the conversation-e thread in the current chat. Clears
  // threadId so the next dispatch spawns a fresh claude session, sets
  // the personality, and sends the "Reboot complete" announcement.
  if (sub === 'new') {
    const personaName = tokens[1] || 'default';
    const targetJid = dispatchMeta?.waChatId;
    if (!targetJid) {
      sysOut('!! /e new: no chat context. Use `/egpt new [<persona>] <name-search>` from the shell instead.');
      return true;
    }
    return await _runReboot({ resetThread: true, personaName, targetJid, sysOut, ctx, originJid: targetJid });
  }

  // ── /e persona [<persona>] ──────────────────────────────────────
  // Install (or re-install) a persona on the EXISTING conversation-e
  // thread for the current chat. Same announcement frame, but the
  // backend keeps the threadId.
  if (sub === 'persona') {
    const personaName = tokens[1] || 'default';
    const targetJid = dispatchMeta?.waChatId;
    if (!targetJid) {
      sysOut('!! /e persona: no chat context. Use `/egpt persona [<persona>] <name-search>` from the shell instead.');
      return true;
    }
    return await _runReboot({ resetThread: false, personaName, targetJid, sysOut, ctx, originJid: targetJid });
  }

  // ── /e butler <prompt> ──────────────────────────────────────────
  // Ephemeral haiku sub-agent. No session memory; default all-tools.
  // Prints the result to the shell (operator-facing). Programmatic
  // invocations should use the `butler-task` outbox event instead so
  // the result can be relayed back to a specific contact thread.
  if (sub === 'butler') {
    const prompt = arg.replace(/^\s*butler\s*/, '').trim();
    if (!prompt) { sysOut('usage: /e butler <prompt>'); return true; }
    sysOut(`(butler-e working… haiku, no session memory, default all-tools)`);
    try {
      const { runButler } = await import('../tools/butler.mjs');
      const r = await runButler({ prompt });
      const head = r.error ? `!! butler: ${r.error}` : `butler-e (${r.durationMs}ms):`;
      sysOut([head, '', r.text || '(no output)'].join('\n'));
    } catch (e) {
      sysOut(`!! /e butler: ${e?.message ?? e}`);
    }
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
    // /e is WA-scoped by default — dispatchMeta.waChatId is a WA jid.
    // TG-side equivalent will be added with task #20.
    const surface = 'whatsapp';
    const targetSlug = slugFlag ?? findContactByJid(cs, surface, jidFlag ?? dispatchMeta?.waChatId);
    if (!targetSlug) {
      sysOut(`!! /e heartbeat: no contact for ${slugFlag ?? jidFlag ?? dispatchMeta?.waChatId ?? '<no chat context>'}`);
      return true;
    }
    let patch = {};
    if (hbAction === 'on')  patch.heartbeatEnabled = true;
    if (hbAction === 'off') patch.heartbeatEnabled = false;
    if (hbAction === 'interval') {
      const mins = parseFloat(value);
      if (!Number.isFinite(mins) || mins < 0.1) {
        sysOut('!! /e heartbeat interval: minutes must be a positive number (>= 0.1, fractional OK)'); return true;
      }
      patch.heartbeatIntervalMin = mins;
    }
    const next = patchContact(cs, surface, targetSlug, patch);
    await writeConvState(CONV_YAML_PATH, next);
    // Find the updated entry (by slug) for the status line.
    const updated = Object.values(next.contacts[surface] ?? {}).find(e => e?.slug === targetSlug);
    sysOut(`/e heartbeat: ${targetSlug} enabled=${!!updated?.heartbeatEnabled} interval=${updated?.heartbeatIntervalMin ?? 30}min`);
    return true;
  }

  if (sub !== 'auto') {
    sysOut('usage: /e new [<persona>] | /e persona [<persona>] | /e auto on|off [<jid>] | /e auto pause|resume|status | /e heartbeat on|off|interval <min>');
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

  // Persist to ~/.egpt/config.yaml (merge with whatever else is there).
  try {
    const saved = await readConfig();
    if (!saved.whatsapp || typeof saved.whatsapp !== 'object') saved.whatsapp = {};
    saved.whatsapp.auto_e_chats = wa.auto_e_chats;
    saved.whatsapp.auto_e_paused = !!wa.auto_e_paused;
    await writeConfig(saved);
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
