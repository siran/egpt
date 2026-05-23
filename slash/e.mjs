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
      const { runButler } = await import('../src/tools/butler.mjs');
      const r = await runButler({ prompt });
      const head = r.error ? `!! butler: ${r.error}` : `butler-e (${r.durationMs}ms):`;
      sysOut([head, '', r.text || '(no output)'].join('\n'));
    } catch (e) {
      sysOut(`!! /e butler: ${e?.message ?? e}`);
    }
    return true;
  }

  // ── /e supervisor [status|install|uninstall] ────────────────────
  // Manage the Windows scheduled tasks that keep egpt alive:
  //   egpt-daemon-headless — logon trigger → daemon-wrap.ps1 → daemon
  //   egpt-watchdog        — every 1 min → kills wedged daemon
  // LogonTrigger (not BootTrigger) means NO admin elevation needed —
  // a user can create a task that runs as themselves on logon. So
  // this runs schtasks synchronously, captured stdio, no UAC dance,
  // no detached spawn (the detached Start-Process -Verb RunAs in the
  // old standalone /supervisor crashed the Ink TUI — operator
  // 2026-05-23). Windows-only; no-op elsewhere.
  if (sub === 'supervisor') {
    const { spawnSync } = await import('node:child_process');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');
    if (process.platform !== 'win32') {
      sysOut('/e supervisor: Windows-only (Task Scheduler). No-op on this platform.');
      return true;
    }
    const action = (arg ?? '').trim().split(/\s+/)[1] || 'status';
    const setupDir = join(homedir(), 'src', 'egpt', 'setup');
    const tasks = [
      { name: 'egpt-daemon-headless', xml: join(setupDir, 'egpt-daemon-headless.xml') },
      { name: 'egpt-watchdog',        xml: join(setupDir, 'egpt-watchdog.xml') },
    ];
    const q = (name) => {
      const r = spawnSync('schtasks', ['/Query', '/TN', name, '/FO', 'LIST'], { stdio: 'pipe' });
      const out = r.stdout?.toString() ?? '';
      if (r.status !== 0 || /ERROR/i.test(out)) return null;
      return {
        status: out.match(/^Status:\s*(.+)$/mi)?.[1]?.trim() ?? '?',
        next:   out.match(/^Next Run Time:\s*(.+)$/mi)?.[1]?.trim() ?? '?',
      };
    };

    if (action === 'status') {
      const lines = ['supervisor tasks:'];
      for (const t of tasks) {
        const r = q(t.name);
        lines.push(r ? `  ✓ ${t.name} — status=${r.status} next=${r.next}`
                     : `  ✗ ${t.name} — NOT INSTALLED`);
      }
      sysOut(lines.join('\n'));
      return true;
    }

    if (action === 'install') {
      // The tasks are boot-triggered + S4U ("run whether or not
      // logged on") so they survive Windows reboots without a login.
      // Creating a boot-triggered task needs ADMIN (UAC) — S4U means
      // no stored password, just the elevation. We launch the
      // self-elevating setup/install-tasks.ps1 DETACHED with stdio
      // ignored (a synchronous schtasks /Create here would just hit
      // "Access is denied" since the daemon isn't elevated; a
      // detached self-elevating script raises UAC in its own process
      // without touching the TUI's console — the earlier crash came
      // from a fragile nested -Verb RunAs spawn, avoided here).
      const { spawn } = await import('node:child_process');
      const ps1 = join(setupDir, 'install-tasks.ps1');
      try {
        const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], {
          detached: true, stdio: 'ignore', windowsHide: true,
        });
        child.unref();
        sysOut(
          'supervisor install: launched self-elevating installer.\n' +
          '  → Approve the UAC prompt on your screen.\n' +
          '  → An elevated window creates both tasks (boot + logon, S4U =\n' +
          '    runs whether or not you are logged on), then closes in ~6s.\n' +
          '  → Then run /e supervisor status to confirm.',
        );
      } catch (e) {
        sysOut(`!! supervisor install: ${e?.message ?? e}\n` +
          `Fallback — run elevated yourself:\n  powershell -ExecutionPolicy Bypass -File "${ps1}"`);
      }
      return true;
    }

    if (action === 'uninstall') {
      // Deleting tasks also needs admin (they were created elevated).
      // Self-elevating one-liner via the same detached pattern.
      const { spawn } = await import('node:child_process');
      const inner = tasks.map(t => `schtasks /Delete /TN ${t.name} /F`).join('; ');
      const selfElev =
        `$me=[Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent();` +
        `if(-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){` +
        `Start-Process powershell -Verb RunAs -ArgumentList @('-NoProfile','-Command','${inner}'); exit}; ${inner}`;
      try {
        const child = spawn('powershell', ['-NoProfile', '-Command', selfElev], {
          detached: true, stdio: 'ignore', windowsHide: true,
        });
        child.unref();
        sysOut('supervisor uninstall: launched elevated removal. Approve UAC, then /e supervisor status.');
      } catch (e) {
        sysOut(`!! supervisor uninstall: ${e?.message ?? e}`);
      }
      return true;
    }

    sysOut('usage: /e supervisor [status|install|uninstall]');
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

  if (sub !== 'auto') {
    sysOut('usage: /e new [<persona>] | /e persona [<persona>] | /e auto on|off [<jid>] | /e auto pause|resume|status | /e heartbeat on|off|interval <min> | /e transcribe on|off|status|global [--streaming]');
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
