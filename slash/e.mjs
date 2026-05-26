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

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  CONV_YAML_PATH,
  readState as readConvState,
  writeState as writeConvState,
  findContactByJid,
  resolveChatTarget,
  normalizeResidents,
  patchContact,
  populateIdentityDir,
  writeIdentityPersonality,
  readIdentityDir,
  buildIdentityAnnouncement,
  buildPersonaAnnouncement,
  resolvePersonalityFile,
  slugDir,
  slugTranscriptPath,
} from '../conversations-state.mjs';
import { readConfig, writeConfig } from '../src/tools/config-io.mjs';
import { AUTO_MODES, DEFAULT_AUTO_MODE } from '../src/auto-mode.mjs';
import { homedir } from 'node:os';

export const meta = {
  cmd: '/e',
  section: 'PERSONA',
  surface: 'both',
  usage: '/e new [<persona>] | /e identity [<persona>] | /e persona [<persona>] | /e auto on|accum|mute|mention-direct|mention|off [<name|jid>|all] | /e auto pause|resume|status | /e residents <e,l|e|l|off> [<name|jid>] | /e llama on|off | /e source [<path>] | /e heartbeat on|off|interval <min> | /e transcribe on|off|status|global [--streaming] | /e confirm [<name|jid>] on|off|status [self|shell|egptbot|all] | /e tool allow|deny|ask [all|<toolname>] | /e cmd allow|deny <command>|status',
  desc: 'operator controls for conversation-e in the current chat: reboot/persona, reply mode, residents, local @l, daemon source, heartbeat, transcription, wiretap, tool perms',
  subs: [
    { name: 'new',        usage: '/e new [<persona>]',                                       desc: 'reset the thread + rebuild & feed the WHOLE identity.d bundle (manifest + personality + rules + pointers)', example: '/e new default' },
    { name: 'identity',   usage: '/e identity [<persona>]',                                  desc: 'rebuild & feed the whole identity.d bundle but KEEP the thread — refresh after editing e_identity.md or dropping a file in identity.d/', example: '/e identity' },
    { name: 'persona',    usage: '/e persona [<persona>]',                                   desc: 'swap ONLY the personality (rewrite 20-personality.md, feed only it); keeps thread + manifest', example: '/e persona banter' },
    { name: 'auto',       usage: '/e auto <on|accum|mute|mention-direct|mention|off> [<name|jid>|all] | pause|resume|status', desc: 'per-chat reply mode (default mention; reply GATE, not reception); pause/resume dispatch globally; status lists chats', example: '/e auto mention all' },
    { name: 'residents',  usage: '/e residents <e,l|e|l|off> [<name|jid>]',                   desc: 'which beings reply in this chat — conversation-e and/or local @l', example: '/e residents e,l' },
    { name: 'llama',      usage: '/e llama on|off',                                          desc: 'enable/disable the local @l brain (alias: /e local)', example: '/e llama on' },
    { name: 'source',     usage: '/e source [<path>]',                                       desc: 'which checkout the daemon runs the app from; no arg reports running + persisted source (relative paths resolve under ~/src/, first switch needs a wrapper restart)', example: '/e source egpt-dev' },
    { name: 'heartbeat',  usage: '/e heartbeat on|off | interval <min> [--slug|--jid]',      desc: 'opt this contact in/out of per-contact heartbeats; set the cadence in minutes', example: '/e heartbeat interval 30' },
    { name: 'transcribe', usage: '/e transcribe on|off|status|global [--streaming|--batch] [<jid>]', desc: 'voice-note transcription, per chat or global', example: '/e transcribe on' },
    { name: 'confirm',    usage: '/e confirm [<name|jid>] on|off|status [self|shell|egptbot|all]', desc: 'wiretap a chat: mirror VERBATIM what each resident brain is fed and its raw reply to the chosen destination(s)', example: '/e confirm on self' },
    { name: 'tool',       usage: '/e tool allow|deny|ask [all|<toolname>]',                  desc: "per-tool permission for E's brain (e.g. /e tool deny all, then /e tool allow read_file)", example: '/e tool deny all' },
    { name: 'cmd',        usage: '/e cmd allow|deny <command> | status',                     desc: 'which slash commands conversation-e may EXECUTE from its own reply (allowlist; default /react). Known-but-unlisted commands are stripped, never run', example: '/e cmd allow react' },
    { name: 'butler',     usage: '/e butler <prompt>',                                       desc: 'ephemeral haiku sub-agent — no session memory, default all-tools', example: '/e butler summarize my unread chats' },
    { name: 'supervisor', usage: '/e supervisor [status|install|uninstall|restart]',         desc: 'manage the supervisor watchdog', example: '/e supervisor status' },
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

  const personaFile = resolvePersonalityFile(personaName);
  if (!personaFile) {
    sysOut(`!! /e ${mode}: no personality "${personaName}" (looked under personalities/ and ~/.egpt/personalities/)`);
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

  // Patch personality; clear thread only on 'new'. Full installs re-stamp
  // identityInjectedAt; a persona-only swap leaves it.
  const patch = { personality: personaName };
  if (mode !== 'persona') patch.identityInjectedAt = null;
  if (mode === 'new') { patch.threadId = null; patch.threadCreatedAt = null; }
  cs = patchContact(cs, surface, slug, patch);
  await writeConvState(CONV_YAML_PATH, cs);

  // Build the feed + announcement.
  let announcement;
  let ackDetail;
  try {
    if (mode === 'persona') {
      const personality = await writeIdentityPersonality(surface, slug, personaName);
      announcement = buildPersonaAnnouncement(personaName, personality);
      ackDetail = `persona:${personaName} (personality only)`;
    } else {
      const manifest = (ctx.loadIdentity ? await ctx.loadIdentity() : '') ?? '';
      await populateIdentityDir(surface, slug, personaName, { manifest });
      const feed = await readIdentityDir(surface, slug);
      announcement = buildIdentityAnnouncement(personaName, feed);
      ackDetail = `manifest${manifest ? '' : '(empty)'} + persona:${personaName} + rules + pointers`;
    }
  } catch (e) {
    sysOut(`!! /e ${mode} ${slug}: building identity feed failed — ${e?.message ?? e}`);
    return true;
  }

  // The CHAT gets only a short reboot marker — never the manifest/feed (that's
  // internal and would leak into the group). The full feed goes to the brain
  // via the kickoff turn below.
  try {
    const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const body = mode === 'persona' ? `🧠 eGPT: persona → ${personaName}` : `🧠 eGPT: reboot — persona "${personaName}"`;
    const ev = { type: 'wa-send', from: 'e', ts: Date.now(), jid: targetJid, body };
    await writeFile(join(homedir(), '.egpt', 'outbox', id + '.json'), JSON.stringify(ev));
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
      await writeFile(join(homedir(), '.egpt', 'outbox', id + '.json'), JSON.stringify(ev));
    }
  } catch (e) {
    sysOut(`!! /e ${mode} ${slug}: kickoff failed — ${e?.message ?? e}`);
  }
  return true;
}

export async function run({ arg, meta: dispatchMeta, ctx }) {
  const { sysOut, EGPT_CONFIG, EGPT_HOME, waBridgeRef } = ctx;
  const tokens = arg.split(/\s+/).filter(Boolean);
  const [sub, action, jidArg] = tokens;

  // Thin wrapper over the shared resolveChatTarget (conversations-state.mjs),
  // binding this run's live WA bridge. Used by every jid-taking /e subcommand.
  const _resolveChatTarget = (term, surface = 'whatsapp') =>
    resolveChatTarget(term, { waBridge: waBridgeRef?.current ?? null, surface });

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

  // ── /e persona [<persona>] ──────────────────────────────────────
  // Swap ONLY the personality (rewrite 20-personality.md, feed only it).
  // Keeps the thread and the manifest — no full re-install.
  if (sub === 'persona') {
    const personaName = tokens[1] || 'default';
    const targetJid = dispatchMeta?.waChatId;
    if (!targetJid) {
      sysOut('!! /e persona: no chat context. Use `/egpt persona [<persona>] <name-search>` from the shell instead.');
      return true;
    }
    return await _runReboot({ mode: 'persona', personaName, targetJid, sysOut, ctx, originJid: targetJid });
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

  // /e cmd allow|deny|status [<command>] — which SLASH COMMANDS conversation-e
  // may execute when it emits one on its own line in a reply (whatsapp.e_commands
  // allowlist). SAFETY: E's output is model-generated and it reads messages from
  // chat partners, so a crafted message could try to coax a command out of it.
  // The allowlist is the gate — default ['react'] only; known-but-unlisted
  // commands are stripped + logged, never run, never leaked to the chat.
  if (sub === 'cmd') {
    const action = (tokens[1] ?? '').toLowerCase();
    const name = (tokens[2] ?? '').replace(/^\//, '').toLowerCase();
    const cur = Array.isArray(EGPT_CONFIG.whatsapp?.e_commands)
      ? EGPT_CONFIG.whatsapp.e_commands.map(s => String(s).replace(/^\//, '').toLowerCase())
      : ['react'];
    if (!action || action === 'status' || action === 'list') {
      sysOut(`/e cmd allowlist (whatsapp.e_commands): ${cur.length ? cur.map(c => '/' + c).join(' ') : '(none)'}`);
      return true;
    }
    if ((action !== 'allow' && action !== 'deny') || !name) {
      sysOut('usage: /e cmd allow|deny <command> | status   (e.g. `/e cmd allow react`)');
      return true;
    }
    const next = action === 'allow'
      ? Array.from(new Set([...cur, name]))
      : cur.filter(c => c !== name);
    try {
      const saved = await readConfig();
      if (!saved.whatsapp || typeof saved.whatsapp !== 'object') saved.whatsapp = {};
      saved.whatsapp.e_commands = next;
      await writeConfig(saved);
      if (!EGPT_CONFIG.whatsapp || typeof EGPT_CONFIG.whatsapp !== 'object') EGPT_CONFIG.whatsapp = {};
      EGPT_CONFIG.whatsapp.e_commands = next;
    } catch (e) { sysOut(`!! /e cmd: persist failed: ${e.message}`); return true; }
    sysOut(`/e cmd ${action}: /${name} → allowlist now ${next.length ? next.map(c => '/' + c).join(' ') : '(none)'}`);
    return true;
  }

  // /e source [path] — which checkout the daemon runs the app from. No arg:
  // report the running source (dir + branch + commit) and the persisted
  // setting. With a path (relative to ~/src/, or absolute, fwd or back slash):
  // validate it has egpt.mjs, persist it to ~/.egpt/source-root.txt, and
  // restart — the wrapper launches egpt.mjs from there. The wrapper itself
  // stays stable; only the app follows. Default (no source file) = stable.
  if (sub === 'source') {
    const SRC_FILE = join(EGPT_HOME, 'source-root.txt');
    const running = ctx.APP_DIR ?? process.cwd();
    const gitAt = (dir) => {
      try {
        const br = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir }).toString().trim();
        const sh = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir }).toString().trim();
        return `${br} @ ${sh}`;
      } catch { return '?'; }
    };
    const pathArg = tokens.slice(1).join(' ').trim();
    if (!pathArg) {
      let persisted = '(none → stable default)';
      try { const p = readFileSync(SRC_FILE, 'utf8').trim(); if (p) persisted = p; } catch {}
      sysOut(`/e source: running ${running} (${gitAt(running)})\n  persisted: ${persisted}`);
      return true;
    }
    // Resolve: ~ → home; relative (no drive, not absolute) → ~/src/<path>.
    let p = pathArg.replace(/[\\/]+$/, '');
    if (p.startsWith('~')) p = join(homedir(), p.slice(1).replace(/^[\\/]+/, ''));
    else if (!isAbsolute(p) && !/^[A-Za-z]:[\\/]/.test(p)) p = join(homedir(), 'src', p);
    p = resolve(p);
    if (!existsSync(join(p, 'egpt.mjs'))) {
      sysOut(`/e source: no egpt.mjs at ${p} — not a valid egpt checkout. (relative paths resolve under ~/src/)`);
      return true;
    }
    try {
      mkdirSync(EGPT_HOME, { recursive: true });
      writeFileSync(SRC_FILE, p + '\n');
      // back-online announce: the respawned daemon (running from p) re-reads
      // HEAD, so it reports p's branch/commit when it comes up.
      const selfJid = dispatchMeta?.waChatId || EGPT_CONFIG.whatsapp?.chat_id || null;
      if (selfJid) {
        mkdirSync(join(EGPT_HOME, 'state'), { recursive: true });
        writeFileSync(join(EGPT_HOME, 'state', 'restart-announce.json'),
          JSON.stringify({ jid: selfJid, at: Date.now() }));
      }
    } catch (e) { sysOut(`!! /e source: ${e.message}`); return true; }
    sysOut(`/e source → ${p} (${gitAt(p)}) — restarting to run it (wrapper restart needed first time)`);
    if (typeof ctx.exitClean === 'function') setTimeout(() => ctx.exitClean(43), 150);
    return true;
  }

  // Enable/disable the local llama-server (@l's backend). Persists
  // local_llm.enabled; takes effect on the next /restart (the supervisor reads
  // enabled at boot). whisper-server has the parallel toggle via /e transcribe.
  if (sub === 'llama' || sub === 'local') {
    if (!EGPT_CONFIG.local_llm || typeof EGPT_CONFIG.local_llm !== 'object') EGPT_CONFIG.local_llm = {};
    const ll = EGPT_CONFIG.local_llm;
    const a = String(action ?? '').toLowerCase();
    if (a === 'on' || a === 'off') {
      ll.enabled = (a === 'on');
      try {
        const saved = await readConfig();
        if (!saved.local_llm || typeof saved.local_llm !== 'object') saved.local_llm = {};
        saved.local_llm.enabled = ll.enabled;
        await writeConfig(saved);
      } catch (e) { sysOut(`!! /e llama: persist failed: ${e.message}`); return true; }
      sysOut(`/e llama ${a}: local_llm.enabled = ${ll.enabled} (takes effect on /restart)`);
    } else {
      const state = ll.enabled === false ? 'off' : 'on';
      sysOut(`/e llama: ${state} — port ${ll.port ?? 11434}, model ${String(ll.model_path ?? '?').split(/[\\/]/).pop()}. Usage: /e llama on|off`);
    }
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
      const g = normalizeResidents(wa.residents);
      const glob = g.length ? g.join(', ') : '(persona only)';
      const ents = Object.entries(wa.residents_per_chat);
      let lines = '  (none — every chat uses the global list)';
      if (ents.length) {
        const rows = await Promise.all(ents.map(async ([j, r]) => {
          const { name } = await _resolveChatTarget(j);
          const label = name ? `«${name}» ${j}` : j;
          return `  - ${label}: ${normalizeResidents(r).join(', ')}`;
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
      sysOut(`/e residents: ${label} → cleared (uses global: ${normalizeResidents(wa.residents).join(', ') || 'persona'})`);
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
    sysOut('usage: /e new [<persona>] | /e persona [<persona>] | /e auto on|accum|mute|mention-direct|mention|off [<name|jid>] | /e auto pause|resume|status | /e residents <e,l|e|l|off> [<name|jid>] | /e llama on|off | /e source [<path>] | /e heartbeat on|off|interval <min> | /e transcribe on|off|status|global [--streaming] | /e confirm [<name|jid>] on|off|status [self|shell|egptbot|all] | /e tool allow|deny|ask [all|<toolname>]');
    return true;
  }

  if (!EGPT_CONFIG.whatsapp || typeof EGPT_CONFIG.whatsapp !== 'object') {
    EGPT_CONFIG.whatsapp = {};
  }
  const wa = EGPT_CONFIG.whatsapp;
  if (!Array.isArray(wa.auto_e_chats)) wa.auto_e_chats = [];

  if (!wa.auto_e_modes || typeof wa.auto_e_modes !== 'object') wa.auto_e_modes = {};
  const MODES = AUTO_MODES;   // on, accum, mute, mention-direct, mention, off

  if (action === 'status') {
    // Merge legacy auto_e_chats (→ 'on') with explicit auto_e_modes.
    const merged = {};
    for (const j of (Array.isArray(wa.auto_e_chats) ? wa.auto_e_chats : [])) merged[j] = 'on';
    for (const [j, m] of Object.entries(wa.auto_e_modes)) merged[j] = m;
    const ents = Object.entries(merged);
    let list = `  (none set — every chat defaults to "${DEFAULT_AUTO_MODE}")`;
    if (ents.length) {
      const rows = await Promise.all(ents.map(async ([j, m]) => {
        const { name } = await _resolveChatTarget(j);
        return `  - ${name ? `«${name}» ${j}` : j}: ${m}`;
      }));
      list = rows.join('\n');
    }
    const paused = wa.auto_e_paused ? 'PAUSED (global kill on)' : 'active';
    const def = wa.auto_e_default_mode || DEFAULT_AUTO_MODE;
    sysOut(`auto: ${paused}  (default mode: ${def})\nper-chat modes:\n${list}`);
    return true;
  }

  let autoLabel = null;   // what the echo reports
  if (action === 'pause') {
    wa.auto_e_paused = true; autoLabel = 'PAUSED (global kill on)';
  } else if (action === 'resume') {
    wa.auto_e_paused = false; autoLabel = 'active (resumed)';
  } else if (MODES.includes(action)) {
    const target = jidArg ? String(jidArg).trim() : null;
    if (target && target.toLowerCase() === 'all') {
      // 'all' makes EVERY chat this mode: set the global default + clear all
      // per-chat overrides so nothing deviates. (Use /e auto pause for a
      // temporary global kill that preserves per-chat config.)
      wa.auto_e_default_mode = action;
      wa.auto_e_modes = {};
      wa.auto_e_chats = [];
      autoLabel = `all chats → ${action} (global default; per-chat overrides cleared)`;
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
      wa.auto_e_modes[chatId] = action;
      // Drop the jid from the legacy list so auto_e_modes is authoritative.
      if (Array.isArray(wa.auto_e_chats)) wa.auto_e_chats = wa.auto_e_chats.filter(j => j !== chatId);
      autoLabel = `${resolvedName ? `«${resolvedName}» ` : ''}${chatId} → ${action}`;
    }
  } else {
    sysOut(`usage: /e auto <${MODES.join('|')}> [<name|jid>|all] | pause | resume | status`);
    return true;
  }

  // Persist to ~/.egpt/config.yaml (merge with whatever else is there).
  try {
    const saved = await readConfig();
    if (!saved.whatsapp || typeof saved.whatsapp !== 'object') saved.whatsapp = {};
    saved.whatsapp.auto_e_modes = wa.auto_e_modes;
    saved.whatsapp.auto_e_chats = wa.auto_e_chats;     // kept as legacy fallback
    saved.whatsapp.auto_e_paused = !!wa.auto_e_paused;
    if (wa.auto_e_default_mode) saved.whatsapp.auto_e_default_mode = wa.auto_e_default_mode;
    await writeConfig(saved);
  } catch (e) {
    sysOut(`!! /e auto: persist failed: ${e.message}`);
    return true;
  }

  sysOut(`/e auto ${action}: ${autoLabel ?? action}`);
  return true;
}
