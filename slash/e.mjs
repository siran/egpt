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
//   /e auto on|off [<jid>|all]         — set a chat's reply mode (per-conversation)
//   /e auto pause|resume           — globally suspend / re-enable dispatch
//   /e auto status                 — list configured chats + paused state

import { writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONV_YAML_PATH,
  readState as readConvState,
  writeState as writeConvState,
  findContactByJid,
  resolveChatTarget,
  normalizeResidents,
  getBeing,
  residentsOf,
  patchContact,
  installIdentity,
  resolveIdentityDir,
  buildIdentityAnnouncement,
  slugDir,
  slugTranscriptPath,
} from '../conversations-state.mjs';
import { readConfig, writeConfig } from '../src/tools/config-io.mjs';
import { AUTO_MODES, DEFAULT_AUTO_MODE } from '../src/auto-mode.mjs';
import { Room, normalizeMemberState, DEFAULT_MEMBER_STATE } from '../src/room-core.mjs';
import { homedir } from 'node:os';

export const meta = {
  cmd: '/e',
  section: 'PERSONA',
  surface: 'both',
  usage: '/e new [<identity>] | /e identity [<identity>] | /e auto on|accum|mute|mention-direct|mention|off [<name|jid>|all] | /e auto pause|resume|status | /e residents <e,l|e|l|off> [<name|jid>] | /e transcribe on|off|status|global [--streaming]',
  desc: 'operator controls for conversation-e in the current chat: reboot/persona, reply mode, residents, local @l, transcription, tool perms',
  subs: [
    { name: 'new',        usage: '/e new [<identity>]',                                      desc: 'reset thread + install identity folder (all its files from identities/<name>/, fed in NN order)', example: '/e new default' },
    { name: 'identity',   usage: '/e identity [<identity>]',                                 desc: 'reinstall/refresh the identity folder, KEEP the thread — after editing identities/<name>/', example: '/e identity' },
    { name: 'auto',       usage: '/e auto <on|accum|mute|mention-direct|mention|off> [<name|jid>|all] | pause|resume|status [<search>] | show-think on|off [<chat>]', desc: 'per-chat reply mode (default mention; reply GATE, not reception); pause/resume dispatch globally; status [<search>] lists chats; show-think on/off toggles two-message Telegram mode (thinking stream frozen 💭, final sent as new reply)', example: '/e auto show-think on' },
    { name: 'residents',  usage: '/e residents <e,l|e|l|off> [<name|jid>]',                   desc: 'which beings reply in this chat — conversation-e and/or local @l', example: '/e residents e,l' },
    { name: 'transcribe', usage: '/e transcribe on|off|status|global [--streaming|--batch] [<jid>]', desc: 'voice-note transcription, per chat or global', example: '/e transcribe on' },
  ],
};

// Legacy stub kept only because other call paths may import it. The
// /e auto branch now reads/writes directly via config-io.
async function _persistWaConfig() {
  const saved = await readConfig();
  if (!saved.whatsapp || typeof saved.whatsapp !== 'object') saved.whatsapp = {};
  return { saved };
}

// _resolveChatTarget is defined as a closure inside run() so it can reach the
// live WA bridge (real group subjects) via ctx.waBridgeRef — see there.

// Shared install path for /e new, /e identity, /e persona.
//   mode 'new'      — reset the thread, rebuild the WHOLE identity.d bundle
//                     (00-manifest ← e_identity, 20-personality, 40-rules,
//                     60-pointers), feed it to a fresh thread.
//   mode 'identity' — rebuild + feed the WHOLE bundle, KEEP the thread
//                     (refresh after editing e_identity.md or adding a file).
//   mode 'persona'  — rewrite ONLY 20-personality.md, feed ONLY the personality
//                     (swap flavor; no manifest re-send), keep the thread.
// Back-compat: callers passing `resetThread` map to 'new' / 'persona'.
// Exported so /egpt can call it with a JID resolved from a name-search.
export async function _runReboot({ resetThread, mode, personaName, targetJid, sysOut, ctx, originJid, surface = 'whatsapp' }) {
  const { computeBrainTurn } = ctx;
  if (!mode) mode = resetThread ? 'new' : 'persona';

  if (!resolveIdentityDir(personaName)) {
    sysOut(`!! /e ${mode}: no identity "${personaName}" (looked in ~/.egpt/identities/ and shipped identities/)`);
    return true;
  }

  let cs = await readConvState(CONV_YAML_PATH);
  const slug = findContactByJid(cs, surface, targetJid);
  if (!slug) {
    sysOut(`!! /e ${mode}: no contact registered for jid "${targetJid}" under surface "${surface}". Send a message in that chat first so @e registers it.`);
    return true;
  }

  // On 'new' (fresh thread): archive the current transcript so each transcript
  // is 1:1 with a conversation thread (operator 2026-05-26). Move
  // <slug>/transcript.md → <slug>/transcripts/<oldThreadId|timestamp>.md; a
  // fresh transcript.md starts for the new thread. The old threadId (the
  // claude session uuid) names the archive so it maps back to its thread.
  if (mode === 'new') {
    try {
      const oldThreadId = cs.contacts?.[surface]?.[targetJid]?.threadId ?? null;
      const tpath = slugTranscriptPath(surface, slug);
      if (existsSync(tpath)) {
        const arcDir = join(slugDir(surface, slug), 'transcripts');
        await mkdir(arcDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const archiveName = `${stamp}${oldThreadId ? '_' + String(oldThreadId).slice(0, 8) : ''}.md`;
        await rename(tpath, join(arcDir, archiveName));
        sysOut(`/e new: archived transcript → transcripts/${archiveName}`);
      }
    } catch (e) { sysOut(`!! /e new: transcript archive failed — ${e.message}`); }
  }

  // Full installs (new / identity / persona-no-file) re-stamp identityInjectedAt;
  // only 'new' resets the thread.
  const patch = { personality: personaName, identityInjectedAt: null };
  if (mode === 'new') { patch.threadId = null; patch.threadCreatedAt = null; }
  cs = patchContact(cs, surface, slug, patch);
  await writeConvState(CONV_YAML_PATH, cs);

  // Install the identity FOLDER (copy its files de-prefixed into the slug-dir)
  // and feed the concat (NN- order) as the kickoff.
  let announcement;
  let ackDetail;
  try {
    const { feed, files } = await installIdentity(surface, slug, personaName);
    announcement = buildIdentityAnnouncement(personaName, feed);
    ackDetail = `identity:${personaName} (${files.join(', ') || 'empty'})`;
  } catch (e) {
    sysOut(`!! /e ${mode} ${slug}: installing identity failed — ${e?.message ?? e}`);
    return true;
  }

  // The CHAT gets only a short reboot marker — never the manifest/feed (that's
  // internal and would leak into the group). The full feed goes to the brain
  // via the kickoff turn below.
  try {
    const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const body = mode === 'persona' ? `🧠 eGPT: persona → ${personaName}` : `🧠 eGPT: reboot — persona "${personaName}"`;
    const ev = { type: 'wa-send', from: 'e', ts: Date.now(), jid: targetJid, body };
    await writeFile(join(homedir(), '.egpt', 'state', 'outbox', id + '.json'), JSON.stringify(ev));
  } catch (e) {
    sysOut(`!! /e ${mode}: outbox marker write failed — ${e?.message ?? e}`);
  }

  // Kick off the conversation-e thread with the full announcement as its first
  // user-turn. bypassAutoWrap skips the lineage auto-wrap so we don't double-feed.
  const entry = cs.contacts[surface]?.[targetJid] ?? null;
  const pushedName = entry?.pushedName ?? slug;
  try {
    const reply = await computeBrainTurn('e', announcement, {
      threadId: targetJid, surface: 'wa', slug, name: pushedName, bypassAutoWrap: true,
    });
    const ackText = String(reply ?? '').trim();
    // Bridge acknowledges delivery to the OPERATOR (system line) — no longer
    // relying on E echoing "I am eGPT".
    sysOut(`✓ /e ${mode} ${slug}: identity.d delivered → ${pushedName} (${ackDetail})`
      + (ackText && ackText !== '...' && ackText !== '…' ? ` — @e: "${ackText.slice(0, 80)}${ackText.length > 80 ? '…' : ''}"` : ''));
    if (originJid && originJid !== targetJid && ackText && ackText !== '...' && ackText !== '…') {
      const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      const ev = { type: 'wa-send', from: 'e', ts: Date.now(), jid: originJid, body: ackText };
      await writeFile(join(homedir(), '.egpt', 'state', 'outbox', id + '.json'), JSON.stringify(ev));
    }
  } catch (e) {
    sysOut(`!! /e ${mode} ${slug}: kickoff failed — ${e?.message ?? e}`);
  }
  return true;
}

export async function run({ arg, meta: dispatchMeta, ctx }) {
  const { sysOut, EGPT_CONFIG, waBridgeRef } = ctx;
  const tokens = arg.split(/\s+/).filter(Boolean);
  const [sub, action, jidArg] = tokens;

  // Thin wrapper over the shared resolveChatTarget (conversations-state.mjs),
  // binding this run's live WA bridge. Used by every jid-taking /e subcommand.
  const _resolveChatTarget = (term, surface = 'whatsapp') =>
    resolveChatTarget(term, { waBridge: waBridgeRef?.current ?? null, surface });

  // ── /e <slug>  — per-conversation console (from Self) ────────────
  // When the first token isn't a known subcommand, treat the whole arg as a chat
  // name/jid and render its resident roster + state (#2 console, read-only v1; the
  // numbered actions arrive with per-conversation targeting + the add-agent wizard).
  const KNOWN_SUBS = new Set(['new', 'identity', 'auto', 'residents', 'transcribe']);
  if (sub && !KNOWN_SUBS.has(sub)) {
    // /e <name> [<action> ...] — the chat name is every token BEFORE the first known
    // action keyword. With an action, run it with that chat as the context (so all the
    // existing per-chat handlers just work); without one, render the console overview.
    const actionIdx = tokens.findIndex((t) => KNOWN_SUBS.has(t));
    const nameTerm = (actionIdx >= 0 ? tokens.slice(0, actionIdx) : tokens).join(' ').trim();
    const r = await _resolveChatTarget(nameTerm);
    if (r?.error || !r?.jid) {
      sysOut(`/e: no chat matches "${nameTerm}" — try a chat name/jid, optionally + an action (new|identity|auto|residents|transcribe).`);
      return true;
    }
    if (actionIdx >= 0) {
      // Re-dispatch the action with the resolved chat as the live context.
      return await run({ arg: tokens.slice(actionIdx).join(' '), meta: { ...(dispatchMeta ?? {}), waChatId: r.jid }, ctx });
    }
    const cs = await readConvState(CONV_YAML_PATH);
    const entry = cs.contacts?.whatsapp?.[r.jid] ?? null;
    const dbModel = EGPT_CONFIG.default_brain?.model ?? '?';
    const lines = residentsOf(entry).map((bn) => {
      const b = getBeing(cs, 'whatsapp', r.jid, bn);
      const model = b.model ?? (bn === 'e' ? dbModel : '?');
      const effort = b.effort ? `/${b.effort}` : '';
      const th = b.threadId ? String(b.threadId).slice(0, 8) : '(none)';
      return `  ${bn}: ${b.mode ?? 'mention'} · ${model}${effort} · identity:${b.personality} · thread:${th}`;
    });
    const tx = entry?.transcribe ?? '(default on)';
    sysOut(
      `«${r.name ?? r.jid}»  [${r.jid}]\n`
      + `siblings:\n${lines.join('\n') || '  (none)'}\n`
      + `transcribe: ${tx}\n`
      + `actions:  /e ${nameTerm} new | identity [<id>] | auto <mode> | transcribe on|off`,
    );
    return true;
  }

  // ── /e new [<persona>] ──────────────────────────────────────────
  // Reset the thread, rebuild the WHOLE identity.d bundle (manifest +
  // personality + rules + pointers), feed it to a fresh thread.
  if (sub === 'new') {
    const personaName = tokens[1] || 'default';
    const targetJid = dispatchMeta?.waChatId;
    if (!targetJid) {
      sysOut('!! /e new: no chat context. Use `/egpt new [<persona>] <name-search>` from the shell instead.');
      return true;
    }
    return await _runReboot({ mode: 'new', personaName, targetJid, sysOut, ctx, originJid: targetJid });
  }

  // ── /e identity [<persona>] ─────────────────────────────────────
  // Rebuild + feed the WHOLE identity.d bundle but KEEP the thread —
  // the per-chat refresh after editing e_identity.md or dropping a file
  // into identity.d/. (Per-chat analog of the top-level /identity.)
  if (sub === 'identity') {
    const cs = await readConvState(CONV_YAML_PATH);
    const personaName = tokens[1]
      || cs.contacts?.[ 'whatsapp' ]?.[ dispatchMeta?.waChatId ]?.personality
      || 'default';
    const targetJid = dispatchMeta?.waChatId;
    if (!targetJid) {
      sysOut('!! /e identity: no chat context. Use `/egpt` from the shell to target a chat by name.');
      return true;
    }
    return await _runReboot({ mode: 'identity', personaName, targetJid, sysOut, ctx, originJid: targetJid });
  }

  // ── /e transcribe on|off|status [--streaming] [<jid>] ─────────────
  // Per-chat (or global) voice-as-reply-transcript toggle. Bridge
  // posts whisper output back as a quoted reply to each voice; with
  // --streaming the reply edit-streams chunks as they arrive.
  if (sub === 'transcribe') {
    const tokens2 = arg.split(/\s+/).filter(Boolean);
    const tAction = tokens2[1] ?? 'status';
    const streamingFlag = tokens2.includes('--streaming');
    const batchFlag = tokens2.includes('--batch');
    const tJidArg = tokens2.find(
      (t, i) => i > 0 && !t.startsWith('--') && !['on','off','status','global'].includes(t),
    );
    const cfg = EGPT_CONFIG.whatsapp?.media?.audio_transcribe ?? {};
    const perChat = cfg.per_chat && typeof cfg.per_chat === 'object' ? { ...cfg.per_chat } : {};

    if (tAction === 'status') {
      const globalLine = `global: post_as_reply=${cfg.post_as_reply === true} post_as_reply_streaming=${cfg.post_as_reply_streaming === true}`;
      const perChatLines = Object.entries(perChat).length
        ? Object.entries(perChat).map(([j, mode]) => `  - ${j} → ${mode}`).join('\n')
        : '  (none)';
      sysOut(`transcribe ${globalLine}\nper-chat overrides:\n${perChatLines}`);
      return true;
    }

    if (tAction === 'global') {
      const onOff = tokens2[2];
      if (!['on','off'].includes(onOff)) {
        sysOut('usage: /e transcribe global on|off [--streaming]');
        return true;
      }
      const saved = await readConfig();
      if (!saved.whatsapp) saved.whatsapp = {};
      if (!saved.whatsapp.media) saved.whatsapp.media = {};
      if (!saved.whatsapp.media.audio_transcribe) saved.whatsapp.media.audio_transcribe = {};
      // Streaming is default; --batch picks the slower whisper-large
      // single-reply variant. operator 2026-05-22.
      const wantStreaming = onOff === 'on' && !batchFlag;
      const wantBatch     = onOff === 'on' && batchFlag;
      saved.whatsapp.media.audio_transcribe.post_as_reply = wantBatch;
      saved.whatsapp.media.audio_transcribe.post_as_reply_streaming = wantStreaming;
      await writeConfig(saved);
      // Mirror to in-memory config so the running bridge picks it up
      // without a restart (bridge reads via media.audio_transcribe.*).
      EGPT_CONFIG.whatsapp ||= {};
      EGPT_CONFIG.whatsapp.media ||= {};
      EGPT_CONFIG.whatsapp.media.audio_transcribe ||= {};
      EGPT_CONFIG.whatsapp.media.audio_transcribe.post_as_reply = wantBatch;
      EGPT_CONFIG.whatsapp.media.audio_transcribe.post_as_reply_streaming = wantStreaming;
      sysOut(`/e transcribe global ${onOff}${batchFlag ? ' --batch' : (onOff === 'on' ? ' --streaming (default)' : '')}`);
      return true;
    }

    const chatId = tJidArg ?? dispatchMeta?.waChatId ?? null;
    if (!chatId) {
      sysOut('/e transcribe: no chat context — pass a JID explicitly (e.g. `/e transcribe on 120363407494846096@g.us --streaming`)');
      return true;
    }
    if (!['on','off'].includes(tAction)) {
      sysOut('usage: /e transcribe on|off|status|global [--streaming|--batch] [<jid>]');
      return true;
    }

    if (tAction === 'off') {
      perChat[chatId] = 'off';
    } else {
      // Streaming is now the default (operator 2026-05-22: "make
      // --batch the option, so that streaming is the default").
      perChat[chatId] = batchFlag ? 'batch' : 'streaming';
    }

    const saved = await readConfig();
    if (!saved.whatsapp) saved.whatsapp = {};
    if (!saved.whatsapp.media) saved.whatsapp.media = {};
    if (!saved.whatsapp.media.audio_transcribe) saved.whatsapp.media.audio_transcribe = {};
    saved.whatsapp.media.audio_transcribe.per_chat = perChat;
    await writeConfig(saved);
    // Mirror to in-memory immediately
    EGPT_CONFIG.whatsapp ||= {};
    EGPT_CONFIG.whatsapp.media ||= {};
    EGPT_CONFIG.whatsapp.media.audio_transcribe ||= {};
    EGPT_CONFIG.whatsapp.media.audio_transcribe.per_chat = perChat;

    sysOut(`/e transcribe ${tAction}${streamingFlag ? ' --streaming' : ''}: ${chatId} → ${perChat[chatId]}`);
    return true;
  }

  // Per-chat resident selection. The global whatsapp.residents list applies
  // everywhere by default; a per-chat override (the conversation's Room
  // members[], conversations/whatsapp/<slug>/config.yaml) lets one chat run a
  // subset — e.g. @l-only to spare the Claude plan's 5h window (@l is
  // local/free; @e is haiku on your subscription).
  if (sub === 'residents') {
    if (!EGPT_CONFIG.whatsapp || typeof EGPT_CONFIG.whatsapp !== 'object') EGPT_CONFIG.whatsapp = {};
    const wa = EGPT_CONFIG.whatsapp;

    if (!action || action === 'status') {
      const g = normalizeResidents(wa.residents);
      const glob = g.length ? g.join(', ') : '(persona only)';
      // Per-chat overrides now live in each conversation's Room members[]
      // (conversations/whatsapp/<slug>/config.yaml). Walk the conversation
      // entries that have a slug and surface any with an explicit members[].
      let lines = '  (none — every chat uses the global list)';
      try {
        const cs = await readConvState(CONV_YAML_PATH);
        const ents = Object.entries(cs.contacts?.whatsapp ?? {})
          .filter(([, e]) => e && !e.aliasOf && e.slug);
        const rows = [];
        for (const [j, e] of ents) {
          const members = await Room.forChat('whatsapp', e.slug).members();
          if (!members.length) continue;
          const { name } = await _resolveChatTarget(j);
          const label = name ? `«${name}» ${j}` : j;
          rows.push(`  - ${label}: ${members.map(m => `${m.id} (${m.state})`).join(', ')}`);
        }
        if (rows.length) lines = rows.join('\n');
      } catch (e) {
        lines = `  (per-chat overrides live in each conversation's members[]; read failed: ${e.message})`;
      }
      sysOut(`residents (global): ${glob}\nper-chat overrides (conversation members[]):\n${lines}`);
      return true;
    }

    let chatId = null, resolvedName = null;
    if (jidArg) {
      const r = await _resolveChatTarget(jidArg);     // @-jid or fuzzy name
      if (r.error) { sysOut(`/e residents: ${r.error}`); return true; }
      chatId = r.jid; resolvedName = r.name;
    }
    if (!chatId) {
      const here = dispatchMeta?.waChatId ?? null;
      const isSelfOrShell = !here || here === EGPT_CONFIG.whatsapp?.chat_id;
      if (isSelfOrShell) {
        sysOut('/e residents: name a chat — a <jid>, a fuzzy name, or run inside the channel. e.g. `/e residents l hector`');
        return true;
      }
      chatId = here;
    }
    if (!resolvedName && chatId) resolvedName = (await _resolveChatTarget(chatId)).name;
    const label = `${resolvedName ? `«${resolvedName}» ` : ''}${chatId}`;

    // Resolve the chat's conversation slug (alias-resolved to the primary entry):
    // per-chat residents now live in the Room store, keyed by slug.
    const cs = await readConvState(CONV_YAML_PATH);
    const entry0 = cs.contacts?.whatsapp?.[chatId];
    const entry = entry0?.aliasOf ? cs.contacts.whatsapp[entry0.aliasOf] : entry0;
    const slug = entry?.slug;
    if (!slug) {
      sysOut(`/e residents: no conversation slug for ${label} — message the chat once first.`);
      return true;
    }
    const room = Room.forChat('whatsapp', slug);

    if (['off', 'clear', 'reset'].includes(String(action).toLowerCase())) {
      // Clear the Room members so the chat falls back to the global residents.
      for (const m of await room.members()) await room.removeMember(m.id);
      sysOut(`/e residents: ${label} → cleared (uses global: ${normalizeResidents(wa.residents).join(', ') || 'persona'})`);
    } else {
      const known = new Set(Object.keys(EGPT_CONFIG.siblings ?? {}).map(s => s.toLowerCase()));
      const list = String(action).toLowerCase().split(/[,\s]+/).filter(Boolean);
      const bad = list.filter(r => !known.has(r));
      if (!list.length || bad.length) {
        sysOut(`/e residents: unknown resident(s): ${bad.join(', ') || '(none)'}. Known: ${[...known].join(', ') || '(none)'}. Usage: /e residents <e,l|e|l|off> [<jid>]`);
        return true;
      }
      // Write the Room members: map the chat's mode to a member state; drop any
      // member not in the new list, then add/keep the new list.
      const state = normalizeMemberState(entry?.mode) ?? DEFAULT_MEMBER_STATE;
      const cur = await room.members();
      for (const m of cur) if (!list.includes(String(m.id))) await room.removeMember(m.id);
      for (const id of list) await room.setMember({ kind: 'brain', id, state });
      sysOut(`/e residents: ${label} → ${list.join(', ')} only`);
    }
    return true;
  }

  if (sub !== 'auto') {
    sysOut('usage: /e new [<persona>] | /e identity [<persona>] | /e auto on|accum|mute|mention-direct|mention|off [<name|jid>] | /e auto pause|resume|status | /e residents <e,l|e|l|off> [<name|jid>] | /e transcribe on|off|status|global [--streaming]');
    return true;
  }

  if (!EGPT_CONFIG.whatsapp || typeof EGPT_CONFIG.whatsapp !== 'object') {
    EGPT_CONFIG.whatsapp = {};
  }
  const wa = EGPT_CONFIG.whatsapp;
  EGPT_CONFIG.dispatch ??= {};
  const disp = EGPT_CONFIG.dispatch;   // global E-routing knobs, OUT of whatsapp: (E is a sibling, not a network) — auto_paused / auto_default_mode
  const MODES = AUTO_MODES;   // on, accum, mute, mention-direct, mention, off

  // ── /e auto show-think [on|off] [<chat>] ────────────────────────
  // Per-chat Telegram show-think toggle. When on, the streaming "⌛ thinking…"
  // message is frozen in place as a 💭 artifact and the clean final reply is
  // posted as a NEW message (replying to the original user message).
  // Config key: telegram.show_think_chats (array of chatIds).
  if (action === 'show-think' || action === 'show-thinking') {
    const toggle  = tokens[2] ?? null;   // 'on' | 'off' | null → status
    const chatArg = tokens.slice(3).join(' ').trim() || null;

    // Resolve chat: explicit arg, else current Telegram chat, else fail.
    let chatId = null;
    if (chatArg) {
      const r = await _resolveChatTarget(chatArg, 'telegram');
      if (r.error) { sysOut(`/e auto show-think: ${r.error}`); return true; }
      chatId = r.jid;
    }
    if (!chatId) chatId = String(dispatchMeta?.telegramChatId ?? dispatchMeta?.waChatId ?? '');
    if (!chatId) {
      sysOut('/e auto show-think: no chat context — pass a chat id or run from inside the channel');
      return true;
    }

    if (!EGPT_CONFIG.telegram || typeof EGPT_CONFIG.telegram !== 'object') EGPT_CONFIG.telegram = {};
    if (!Array.isArray(EGPT_CONFIG.telegram.show_think_chats)) EGPT_CONFIG.telegram.show_think_chats = [];
    const chats = EGPT_CONFIG.telegram.show_think_chats;

    if (!toggle || toggle === 'status') {
      sysOut(`/e auto show-think: ${chatId} → ${chats.includes(String(chatId)) ? 'on' : 'off'}`);
      return true;
    }
    if (!['on', 'off'].includes(toggle)) {
      sysOut('usage: /e auto show-think on|off [<chat>]');
      return true;
    }
    const chatIdStr = String(chatId);
    const next = toggle === 'on'
      ? chats.includes(chatIdStr) ? chats : [...chats, chatIdStr]
      : chats.filter(c => c !== chatIdStr);
    EGPT_CONFIG.telegram.show_think_chats = next;
    try {
      const saved = await readConfig();
      if (!saved.telegram || typeof saved.telegram !== 'object') saved.telegram = {};
      saved.telegram.show_think_chats = next;
      await writeConfig(saved);
    } catch (e) {
      sysOut(`!! /e auto show-think: persist failed — ${e.message}`);
      return true;
    }
    sysOut(`/e auto show-think ${toggle}: ${chatId} → ${toggle === 'on' ? 'on (thinking stream frozen 💭, final sent as reply)' : 'off (single message, current behaviour)'}`);
    return true;
  }

  if (action === 'status') {
    // Optional substring filter: `/e auto status <name|jid>` narrows the list
    // by case-insensitive match against name / jid. A search that finds
    // nothing in the configured list also looks in the contact registry —
    // a contact may fall through to the default mode and still be the one
    // the operator was asking about (operator 2026-05-28).
    const search = String(jidArg ?? '').trim().toLowerCase();

    // Per-chat modes now live in each conversation entry's `mode`
    // (conversations.yaml → contacts.whatsapp[<chatId>].mode), the unified home.
    const cs = await readConvState(CONV_YAML_PATH);
    const merged = {};
    for (const [j, e] of Object.entries(cs.contacts?.whatsapp ?? {})) {
      if (e?.aliasOf || !e?.mode) continue;
      merged[j] = e.mode;
    }
    const ents = Object.entries(merged);
    const rows = await Promise.all(ents.map(async ([j, m]) => {
      const { name } = await _resolveChatTarget(j);
      const label = name ? `«${name}» ${j}` : j;
      return { j, m, name, label, hay: `${label}: ${m}`.toLowerCase() };
    }));
    const shown = search ? rows.filter(r => r.hay.includes(search)) : rows;

    const paused = (disp.auto_paused ?? wa.auto_e_paused) ? 'PAUSED (global kill on)' : 'active';
    const def = disp.auto_default_mode || wa.auto_e_default_mode || DEFAULT_AUTO_MODE;
    const header = search
      ? `auto: ${paused}  (default mode: ${def})  matches for "${jidArg}":`
      : `auto: ${paused}  (default mode: ${def})\nper-chat modes:`;

    let body;
    if (shown.length) {
      body = shown.map(r => `  - ${r.label}: ${r.m}`).join('\n');
    } else if (search) {
      // Fall-through search across BOTH sources a contact may live in but
      // not yet carry an explicit per-chat mode:
      //   - the WA bridge's chat list (groups + DMs the user can reach today,
      //     even if no E conversation has been initiated yet — this is the
      //     same source `_resolveChatTarget` uses, so the listing matches the
      //     setter's reach);
      //   - conversations.yaml (older contacts whose chat may have rolled out
      //     of the bridge's live list but which still have a thread).
      const seenJid = new Set(Object.keys(merged));
      const matches = [];

      try {
        const chats = (await ctx.waBridgeRef?.current?.listChats?.({ all: true })) ?? [];
        for (const c of chats) {
          if (!c?.jid || seenJid.has(c.jid)) continue;
          const hay = `${c?.name ?? ''} ${c.jid}`.toLowerCase();
          if (hay.includes(search)) {
            seenJid.add(c.jid);
            const label = c?.name ? `«${c.name}» ${c.jid}` : c.jid;
            matches.push(`  - ${label}: (default ${def})`);
          }
        }
      } catch { /* offline / not yet connected — fall through to the registry */ }

      for (const [j, e] of Object.entries(cs.contacts?.whatsapp ?? {})) {
        if (seenJid.has(j)) continue;
        const hay = `${e?.pushedName ?? ''} ${e?.slug ?? ''} ${j}`.toLowerCase();
        if (hay.includes(search)) {
          seenJid.add(j);
          const label = e?.pushedName ? `«${e.pushedName}» ${j}` : `«${e?.slug ?? j}» ${j}`;
          matches.push(`  - ${label}: (default ${def})`);
        }
      }

      body = matches.length
        ? `  (no explicit per-chat mode matches "${jidArg}" — these fall through to the default "${def}":)\n${matches.join('\n')}`
        : `  (no matches for "${jidArg}")`;
    } else {
      body = `  (none set — every chat defaults to "${def}")`;
    }

    sysOut(`${header}\n${body}`);
    return true;
  }

  let autoLabel = null;   // what the echo reports
  if (action === 'pause') {
    disp.auto_paused = true; autoLabel = 'PAUSED (global kill on)';
  } else if (action === 'resume') {
    disp.auto_paused = false; autoLabel = 'active (resumed)';
  } else if (MODES.includes(action)) {
    const target = jidArg ? String(jidArg).trim() : null;
    if (target && target.toLowerCase() === 'all') {
      // 'all' makes EVERY chat this mode: set the global default + clear all
      // per-chat overrides so nothing deviates. The per-chat overrides now live
      // in each conversation entry's `mode`, so clear those (not a flat key).
      // (Use /e auto pause for a temporary global kill that preserves config.)
      disp.auto_default_mode = action;
      const cs = await readConvState(CONV_YAML_PATH);
      for (const e of Object.values(cs.contacts?.whatsapp ?? {})) {
        if (e && typeof e === 'object') delete e.mode;
      }
      await writeConvState(CONV_YAML_PATH, cs);
      await ctx.refreshConvState?.();   // make the cleared overrides live now (not next message)
      autoLabel = `all chats → ${action} (global default; per-chat overrides cleared)`;
      // falls through to config persist for the global default
    } else {
      let chatId = null, resolvedName = null;
      if (target) {
        const r = await _resolveChatTarget(target);   // @-jid or fuzzy name
        if (r.error) { sysOut(`/e auto: ${r.error}`); return true; }
        chatId = r.jid; resolvedName = r.name;
      }
      if (!chatId) {
        const here = dispatchMeta?.waChatId ?? null;
        const isSelfOrShell = !here || here === EGPT_CONFIG.whatsapp?.chat_id;
        if (isSelfOrShell) {
          sysOut(`/e auto <mode>: name a target — a <jid>, a fuzzy name, or 'all' (on|off only). e.g. \`/e auto mute hector\`. The current-chat default only autofills inside a channel.`);
          return true;
        }
        chatId = here;
      }
      if (!resolvedName && chatId) resolvedName = (await _resolveChatTarget(chatId)).name;
      // Write the per-chat mode into the conversation entry (the unified home).
      // Alias-resolve to the PRIMARY entry; create a minimal one if never seen.
      const cs = await readConvState(CONV_YAML_PATH);
      const c = cs.contacts?.whatsapp ?? {};
      let key = chatId; if (c[chatId]?.aliasOf) key = c[chatId].aliasOf;
      cs.contacts ??= {}; cs.contacts.whatsapp ??= {};
      cs.contacts.whatsapp[key] ??= { slug: chatId };
      cs.contacts.whatsapp[key].mode = action;
      await writeConvState(CONV_YAML_PATH, cs);
      await ctx.refreshConvState?.();   // make the new mode live now (not next message)
      sysOut(`/e auto ${action}: ${resolvedName ? `«${resolvedName}» ` : ''}${chatId} → ${action}`);
      return true;   // per-chat path persists to conv state only, not config
    }
  } else {
    sysOut(`usage: /e auto <${MODES.join('|')}> [<name|jid>|all] | pause | resume | status`);
    return true;
  }

  // Persist the GLOBAL knobs to ~/.egpt/config.yaml (merge with what's there).
  // Per-chat modes no longer live in config — they're in each conversation entry.
  try {
    const saved = await readConfig();
    if (!saved.dispatch || typeof saved.dispatch !== 'object') saved.dispatch = {};
    saved.dispatch.auto_paused = !!disp.auto_paused;
    if (disp.auto_default_mode) saved.dispatch.auto_default_mode = disp.auto_default_mode;
    await writeConfig(saved);
  } catch (e) {
    sysOut(`!! /e auto: persist failed: ${e.message}`);
    return true;
  }

  sysOut(`/e auto ${action}: ${autoLabel ?? action}`);
  return true;
}
