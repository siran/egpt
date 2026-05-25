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
//   /e auto on|off [<jid>|all]         — toggle auto_e_chats membership
//   /e auto pause|resume           — globally suspend / re-enable dispatch
//   /e auto status                 — list configured chats + paused state
//
//   /e heartbeat on|off            — opt the current contact in/out of
//                                    per-contact heartbeats
//   /e heartbeat interval <min>    — set per-contact heartbeat cadence
//                                    (minutes; default 30)
//   /e butler <prompt>             — ephemeral haiku sub-agent (no
//                                    session memory, default all-tools)
//
//   /e confirm [<jid>] on|off|status [self|shell|egptbot|all]
//                                  — watcher/wiretap on <jid>: mirror VERBATIM
//                                    + per-being exactly what each resident
//                                    brain is FED (→ <being>) and its raw reply
//                                    (<being> →), in a ``` fence, to the chosen
//                                    destination(s). 'on' default dest is self;
//                                    'all' = self+shell+egptbot. bare 'off'
//                                    (or 'off all') stops watching.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CONV_YAML_PATH,
  readState as readConvState,
  writeState as writeConvState,
  findContactByJid,
  findContactsByName,
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
  usage: '/e new [<persona>] | /e persona [<persona>] | /e auto on|off [<jid>|all] | /e auto pause|resume|status | /e heartbeat on|off|interval <min> [--slug|--jid] | /e confirm [<jid>] on|off|status [self|shell|egptbot|all]',
  desc: 'reboot conversation-e in this chat; control auto-dispatch, heartbeats, and the confirm watcher',
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
  const { sysOut, EGPT_CONFIG, EGPT_HOME, waBridgeRef } = ctx;
  const tokens = arg.split(/\s+/).filter(Boolean);
  const [sub, action, jidArg] = tokens;

  // Resolve a target token to { jid, name } or { error }. An @-jid resolves to
  // its LIVE name (the bridge's group subject — cheap/cached); a bare term is a
  // fuzzy search over the bridge's actual chat names (the registered conv-state
  // slugs are auto-generated, e.g. "egpt_an-2605241622", so a human name like
  // "hector" only matches the live WA subjects). Always names the picked chat
  // so a bare jid echo is never the only feedback ([[feedback-verify-wa-chat-name]]).
  const _resolveChatTarget = async (term, surface = 'whatsapp') => {
    if (!term) return {};
    const wa = waBridgeRef?.current ?? null;
    if (String(term).includes('@')) {
      const live = wa?.getChatName?.(term) ?? null;
      if (live) return { jid: term, name: live };
      const cs = await readConvState(CONV_YAML_PATH);
      return { jid: term, name: findContactByJid(cs, surface, term) ?? null };
    }
    const needle = term.trim().toLowerCase();
    const hits = new Map();   // jid -> name
    try {
      const chats = await wa?.listChats?.({ all: true, limit: 2000, messagesPerChat: 0, includeStatus: false }) ?? [];
      for (const c of chats) {
        const nm = String(c.name ?? '');
        if (nm && nm.toLowerCase().includes(needle)) hits.set(c.jid, nm);
      }
    } catch { /* bridge optional */ }
    try {
      const cs = await readConvState(CONV_YAML_PATH);
      for (const m of findContactsByName(cs, term, surface)) {
        if (!hits.has(m.jid)) hits.set(m.jid, m.pushedName || m.slug || m.jid);
      }
    } catch { /* conv-state optional */ }
    const arr = [...hits.entries()];
    if (!arr.length) return { error: `no chat matches "${term}" — try /channels to see exact names, or pass the @-jid` };
    if (arr.length > 1) {
      const names = arr.slice(0, 8).map(([, n]) => n).join(', ');
      return { error: `"${term}" matches ${arr.length}: ${names} — be more specific or pass the @-jid` };
    }
    return { jid: arr[0][0], name: arr[0][1] };
  };

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
      // no stored password, just the elevation.
      //
      // The UAC prompt must reach the interactive desktop. We do the
      // -Verb RunAs DIRECTLY here (not via the script self-elevating —
      // that left the detached parent with no desktop context and UAC
      // never surfaced; operator 2026-05-23 "no UAC prompt"). NOT
      // windowsHide (the elevation UI needs the desktop). The launcher
      // powershell is brief; -Verb RunAs spawns the elevated installer
      // which does the actual work in its own window.
      const { spawn } = await import('node:child_process');
      const ps1 = join(setupDir, 'install-tasks.ps1');
      // Build the elevation command. Single-quote the inner args for
      // PowerShell; the file path is wrapped so spaces survive.
      const elevate =
        `Start-Process powershell -Verb RunAs -ArgumentList ` +
        `'-NoProfile','-ExecutionPolicy','Bypass','-File','${ps1.replace(/'/g, "''")}'`;
      try {
        const child = spawn('powershell', ['-NoProfile', '-Command', elevate], {
          detached: true, stdio: 'ignore',   // NOT windowsHide — UAC needs the desktop
        });
        child.unref();
        sysOut(
          'supervisor install: requesting elevation.\n' +
          '  → A UAC prompt should appear — approve it.\n' +
          '  → An elevated window creates both tasks (boot + logon, S4U =\n' +
          '    runs whether or not you are logged on), then closes in ~6s.\n' +
          '  → Then run /e supervisor status to confirm.\n' +
          `  → If no UAC appears, run this in an admin PowerShell yourself:\n` +
          `      powershell -ExecutionPolicy Bypass -File "${ps1}"`,
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

    if (action === 'restart' || action === 'update') {
      // Restart the daemon to load new code — triggerable from WhatsApp,
      // NO UAC. The daemon runs elevated (S4U / HighestAvailable), so a
      // child it spawns inherits elevation and can kill + re-run the task
      // without a prompt. (Operator 2026-05-24: a tool-launched
      // self-elevating script's UAC never surfaced to the desktop; this
      // dodges UAC entirely.) Detached + unref'd so the cleaner SURVIVES
      // the daemon it's about to kill — the no-self-SIGHUP rule: never
      // Stop your own task mid-call, hand it to a detached child.
      const { spawn } = await import('node:child_process');
      const cleaner =
        `schtasks /End /TN egpt-daemon-headless;` +
        `schtasks /End /TN egpt-watchdog;` +
        `Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | ` +
        `Where-Object { $_.CommandLine -match 'daemon-wrap' } | ` +
        `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue };` +
        `Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue;` +
        `Start-Sleep -Seconds 3;` +
        `schtasks /Run /TN egpt-daemon-headless;` +
        `schtasks /Run /TN egpt-watchdog`;
      try {
        const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cleaner], {
          detached: true, stdio: 'ignore', windowsHide: true,
        });
        child.unref();
        sysOut('supervisor restart: detached cleaner launched (no UAC — daemon is already elevated).\n'
          + '  → daemon dies + respawns on current code in ~5s; this surface drops then reconnects.\n'
          + '  → ONLY works once the running daemon already has this code; for the FIRST load run\n'
          + '    reset-daemon.ps1 from your own terminal (UAC surfaces there).');
      } catch (e) {
        sysOut(`!! supervisor restart: ${e?.message ?? e}`);
      }
      return true;
    }

    sysOut('usage: /e supervisor [status|install|uninstall|restart]');
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

  // ── /e confirm [<jid>] [status|on|off] [self|shell|egptbot|all] ──
  // Watcher / wiretap: for a jid, egpt mirrors VERBATIM both the prompt
  // it sends to the brains (inbound) and the text it writes back into the
  // chat (outbound) to the named destination(s). Tokens are parsed
  // position-independently (jid carries '@', action ∈ status|on|off, dest ∈
  // self|shell|egptbot|all) so the operator can type them in any order.
  if (sub === 'confirm') {
    const rest = tokens.slice(1);
    const ACTIONS = new Set(['status', 'on', 'off']);
    const DESTS   = new Set(['self', 'shell', 'egptbot', 'all']);
    let cJid = null, cAction = null, nameTerm = null;
    const destTokens = [];
    for (const t of rest) {
      const lt = t.toLowerCase();
      if (t.includes('@')) cJid = t;
      else if (ACTIONS.has(lt)) cAction = lt;
      else if (DESTS.has(lt)) destTokens.push(lt);
      else nameTerm = nameTerm ? `${nameTerm} ${t}` : t;   // fuzzy chat-name search
    }
    const expand = (ds) => ds.includes('all') ? ['self', 'shell', 'egptbot'] : [...new Set(ds)];

    if (!EGPT_CONFIG.whatsapp || typeof EGPT_CONFIG.whatsapp !== 'object') EGPT_CONFIG.whatsapp = {};
    const wa2 = EGPT_CONFIG.whatsapp;
    if (!wa2.confirm_chats || typeof wa2.confirm_chats !== 'object') wa2.confirm_chats = {};

    // Bare `/e confirm` (no chat named, no action) → the global watched list,
    // each jid resolved to its group name so the list is readable.
    if (!cAction && !cJid && !nameTerm) {
      const entries = Object.entries(wa2.confirm_chats);
      let list = '  (none)';
      if (entries.length) {
        const rows = await Promise.all(entries.map(async ([j, ds]) => {
          const { name } = await _resolveChatTarget(j);
          const label = name ? `«${name}» ${j}` : j;
          return `  - ${label} → ${(Array.isArray(ds) ? ds : []).join(', ') || '(none)'}`;
        }));
        list = rows.join('\n');
      }
      sysOut(`/e confirm (watched chats):\n${list}`);
      return true;
    }

    // Resolve the target chat — by @-jid or by fuzzy name — so the echo NAMES
    // the group it picked (a bare jid is unverifiable).
    let chatId = cJid, resolvedName = null;
    if (!chatId && nameTerm) {
      const r = await _resolveChatTarget(nameTerm);
      if (r.error) { sysOut(`/e confirm: ${r.error}`); return true; }
      chatId = r.jid; resolvedName = r.name;
    }
    if (!chatId) chatId = dispatchMeta?.waChatId ?? null;
    const isSelfOrShell = !chatId || chatId === EGPT_CONFIG.whatsapp?.chat_id;
    if (!cJid && !nameTerm && isSelfOrShell) {
      sysOut('/e confirm: name a chat — a <jid>, a fuzzy name (e.g. `/e confirm hector on`), or run it inside the target channel.');
      return true;
    }
    // Name jid / current-chat targets too, so every echo identifies the group.
    if (!resolvedName && chatId) resolvedName = (await _resolveChatTarget(chatId)).name;
    const label = `${resolvedName ? `«${resolvedName}» ` : ''}${chatId}`;

    // Named a chat but no on/off → show THAT chat's current watch state.
    if (!cAction) {
      const ds = wa2.confirm_chats[chatId];
      sysOut(`/e confirm: ${label} → ${Array.isArray(ds) && ds.length ? ds.join(', ') : '(not watched)'}`);
      return true;
    }

    if (cAction === 'status') {
      const ds = wa2.confirm_chats[chatId];
      sysOut(`/e confirm: ${label} → ${Array.isArray(ds) && ds.length ? ds.join(', ') : '(not watched)'}`);
      return true;
    }

    if (cAction === 'on') {
      const want = expand(destTokens.length ? destTokens : ['self']);  // default dest = self
      const prev = Array.isArray(wa2.confirm_chats[chatId]) ? wa2.confirm_chats[chatId] : [];
      wa2.confirm_chats[chatId] = [...new Set([...prev, ...want])];
    } else { // off
      const remove = expand(destTokens);
      if (!destTokens.length || destTokens.includes('all')) {
        delete wa2.confirm_chats[chatId];                 // stop watching entirely
      } else {
        const prev = Array.isArray(wa2.confirm_chats[chatId]) ? wa2.confirm_chats[chatId] : [];
        const next = prev.filter(d => !remove.includes(d));
        if (next.length) wa2.confirm_chats[chatId] = next;
        else delete wa2.confirm_chats[chatId];
      }
    }

    try {
      const saved = await readConfig();
      if (!saved.whatsapp || typeof saved.whatsapp !== 'object') saved.whatsapp = {};
      saved.whatsapp.confirm_chats = wa2.confirm_chats;
      await writeConfig(saved);
    } catch (e) {
      sysOut(`!! /e confirm: persist failed: ${e.message}`);
      return true;
    }
    const now = wa2.confirm_chats[chatId];
    sysOut(`/e confirm ${cAction}: ${label} → ${now ? now.join(', ') : '(not watched)'}`);
    return true;
  }

  // ── /e tool allow|deny|ask [all|<toolname>] | status ────────────
  // Per-tool permission for the agentic loop (the @l local operator and any
  // future tool-using brain). Modes: allow (runs freely), ask (confirm via
  // the operator Self DM before running), deny (blocked). 'all' sets the
  // DEFAULT applied to any tool not explicitly listed — so `/e tool deny all`
  // then `/e tool allow read_file` is whitelist mode. SAFETY: an unleashed
  // local model won't self-refuse a destructive tool call, so the HOST gates
  // here — this is the operator's control surface over what @l may do.
  if (sub === 'tool') {
    const rest = tokens.slice(1);
    const MODES = new Set(['allow', 'deny', 'ask']);
    const mode = rest.map(t => t.toLowerCase()).find(t => MODES.has(t)) ?? null;
    const target = rest.find(t => !MODES.has(t.toLowerCase())) ?? null;   // 'all' | tool name
    if (!EGPT_CONFIG.tools || typeof EGPT_CONFIG.tools !== 'object') EGPT_CONFIG.tools = {};
    const t = EGPT_CONFIG.tools;

    if (!mode) {
      const def = t.default ?? 'ask';
      const lines = Object.entries(t).filter(([k]) => k !== 'default').map(([k, v]) => `  - ${k}: ${v}`);
      sysOut(`/e tool (default: ${def}):\n${lines.length ? lines.join('\n') : '  (no per-tool overrides)'}`);
      return true;
    }
    if (!target) {
      sysOut("usage: /e tool allow|deny|ask <toolname>|all   (e.g. `/e tool deny all`, then `/e tool allow read_file`)");
      return true;
    }
    if (target.toLowerCase() === 'all') t.default = mode;
    else t[target] = mode;
    try {
      const saved = await readConfig();
      saved.tools = t;
      await writeConfig(saved);
    } catch (e) { sysOut(`!! /e tool: persist failed: ${e.message}`); return true; }
    sysOut(`/e tool ${mode}: ${target.toLowerCase() === 'all' ? `default → ${mode}` : target}`);
    return true;
  }

  // Per-chat resident selection. The global whatsapp.residents list applies
  // everywhere by default; a per-chat override (whatsapp.residents_per_chat)
  // lets one chat run a subset — e.g. @l-only to spare the Claude plan's 5h
  // window (@l is local/free; @e is haiku on your subscription).
  if (sub === 'residents') {
    if (!EGPT_CONFIG.whatsapp || typeof EGPT_CONFIG.whatsapp !== 'object') EGPT_CONFIG.whatsapp = {};
    const wa = EGPT_CONFIG.whatsapp;
    if (!wa.residents_per_chat || typeof wa.residents_per_chat !== 'object') wa.residents_per_chat = {};

    if (!action || action === 'status') {
      const glob = (Array.isArray(wa.residents) && wa.residents.length) ? wa.residents.join(', ') : '(persona only)';
      const ents = Object.entries(wa.residents_per_chat);
      let lines = '  (none — every chat uses the global list)';
      if (ents.length) {
        const rows = await Promise.all(ents.map(async ([j, r]) => {
          const { name } = await _resolveChatTarget(j);
          const label = name ? `«${name}» ${j}` : j;
          return `  - ${label}: ${Array.isArray(r) ? r.join(', ') : r}`;
        }));
        lines = rows.join('\n');
      }
      sysOut(`residents (global): ${glob}\nper-chat overrides:\n${lines}`);
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

    if (['off', 'clear', 'reset'].includes(String(action).toLowerCase())) {
      delete wa.residents_per_chat[chatId];
      sysOut(`/e residents: ${label} → cleared (uses global: ${(Array.isArray(wa.residents) && wa.residents.length) ? wa.residents.join(', ') : 'persona'})`);
    } else {
      const known = new Set(Object.keys(EGPT_CONFIG.siblings ?? {}).map(s => s.toLowerCase()));
      const list = String(action).toLowerCase().split(/[,\s]+/).filter(Boolean);
      const bad = list.filter(r => !known.has(r));
      if (!list.length || bad.length) {
        sysOut(`/e residents: unknown resident(s): ${bad.join(', ') || '(none)'}. Known: ${[...known].join(', ') || '(none)'}. Usage: /e residents <e,l|e|l|off> [<jid>]`);
        return true;
      }
      wa.residents_per_chat[chatId] = list;
      sysOut(`/e residents: ${label} → ${list.join(', ')} only`);
    }

    try {
      const saved = await readConfig();
      if (!saved.whatsapp || typeof saved.whatsapp !== 'object') saved.whatsapp = {};
      saved.whatsapp.residents_per_chat = wa.residents_per_chat;
      await writeConfig(saved);
    } catch (e) {
      sysOut(`!! /e residents: persist failed: ${e.message}`);
    }
    return true;
  }

  if (sub !== 'auto') {
    sysOut('usage: /e new [<persona>] | /e persona [<persona>] | /e auto on|off [<jid>|all] | /e auto pause|resume|status | /e residents <e,l|e|l|off> [<jid>] | /e heartbeat on|off|interval <min> | /e transcribe on|off|status|global [--streaming] | /e confirm [<jid>] on|off|status [self|shell|egptbot|all] | /e tool allow|deny|ask [all|<toolname>]');
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
    const target = jidArg ? String(jidArg).trim() : null;
    if (target && target.toLowerCase() === 'all') {
      // Global kill switch (operator 2026-05-24): "/e auto off all" pauses
      // ALL brain dispatch in auto_e chats; "/e auto on all" resumes.
      // Non-destructive — keeps the auto_e_chats list (same flag as
      // pause/resume). The broadcast in egpt.mjs is gated on
      // !auto_e_paused, so this stops @e AND @l everywhere instantly.
      wa.auto_e_paused = (action === 'off');
    } else {
      let chatId = target;
      if (!chatId) {
        // Autofill the CURRENT channel's jid — but NOT in Self (self-DM)
        // or the shell, where there's no channel to target. There you must
        // name a <jid> or 'all', so a bare "/e auto off" in Self can't
        // silently toggle the wrong thing (operator 2026-05-24).
        const here = dispatchMeta?.waChatId ?? null;
        const isSelfOrShell = !here || here === EGPT_CONFIG.whatsapp?.chat_id;
        if (isSelfOrShell) {
          sysOut("/e auto on|off: here you must name a target — a <jid> or 'all' "
            + "(e.g. `/e auto off all` to kill every chat, `/e auto off <jid>` for one). "
            + "The current-chat default only autofills inside a channel.");
          return true;
        }
        chatId = here;
      }
      if (action === 'on') {
        if (!wa.auto_e_chats.includes(chatId)) wa.auto_e_chats.push(chatId);
      } else {
        wa.auto_e_chats = wa.auto_e_chats.filter(j => j !== chatId);
      }
    }
  } else {
    sysOut('usage: /e auto on|off [<jid>|all] | pause | resume | status');
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
    const tgt = (jidArg && String(jidArg).toLowerCase() === 'all')
      ? `all → ${wa.auto_e_paused ? 'PAUSED (global kill on)' : 'active (resumed)'}`
      : (jidArg ?? dispatchMeta?.waChatId ?? '?');
    sysOut(`/e auto ${action}: ${tgt}`);
  } else {
    sysOut(`/e auto ${action}`);
  }
  return true;
}
