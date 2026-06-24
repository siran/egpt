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
//
//   /e heartbeat [<slug>]          — show heartbeat status (current chat or <slug>)
//   /e heartbeat [<slug>] on|off   — enable/disable a conversation's heartbeat
//   /e heartbeat [<slug>] interval <min> — set its cadence (writes <slug>/config.yaml)
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
  installIdentity,
  injectIdentityFile,
  resolveIdentityDir,
  buildIdentityAnnouncement,
  buildPersonaAnnouncement,
  slugDir,
  slugTranscriptPath,
} from '../conversations-state.mjs';
import { readConfig, writeConfig } from '../src/tools/config-io.mjs';
import { AUTO_MODES, DEFAULT_AUTO_MODE } from '../src/auto-mode.mjs';
import { Room, normalizeMemberState, DEFAULT_MEMBER_STATE } from '../src/room-core.mjs';
import {
  loadGrants, saveGrants, grantedEntries, addGrant, removeGrant, normalizeAccess,
} from '../src/conv-grants.mjs';
import { loadRooms, roomsForMember } from '../src/rooms.mjs';
import { homedir } from 'node:os';
import * as YAML from 'yaml';

export const meta = {
  cmd: '/e',
  section: 'PERSONA',
  surface: 'both',
  usage: '/e new [<identity>] | /e identity [<identity>] | /e persona [<identity>] [<file>] | /e auto on|accum|mute|mention-direct|mention|off [<name|jid>|all] | /e auto pause|resume|status | /e residents <e,l|e|l|off> [<name|jid>] | /e llama on|off | /e source [<path>] | /e heartbeat [<slug>] [on|off|interval <min>] | /e transcribe on|off|status|global [--streaming] | /e confirm [<name|jid>] on|off|status [self|shell|egptbot|all] | /e tool allow|deny|ask [all|<toolname>] | /e cmd allow|deny <command>|status | /e path [list|add|rm] [<path>] [<slug>]',
  desc: 'operator controls for conversation-e in the current chat: reboot/persona, reply mode, residents, local @l, daemon source, heartbeat, transcription, wiretap, tool perms',
  subs: [
    { name: 'new',        usage: '/e new [<identity>]',                                      desc: 'reset thread + install identity folder (all its files from identities/<name>/, fed in NN order)', example: '/e new default' },
    { name: 'identity',   usage: '/e identity [<identity>]',                                 desc: 'reinstall/refresh the identity folder, KEEP the thread — after editing identities/<name>/', example: '/e identity' },
    { name: 'persona',    usage: '/e persona [<identity>] [<file>]',                         desc: 'no file: switch identity (keep thread). with file: inject ONE file from any identity (e.g. /e persona banter personality) — pull a file without the rest', example: '/e persona banter' },
    { name: 'auto',       usage: '/e auto <on|accum|mute|mention-direct|mention|off> [<name|jid>|all] | pause|resume|status [<search>] | show-think on|off [<chat>]', desc: 'per-chat reply mode (default mention; reply GATE, not reception); pause/resume dispatch globally; status [<search>] lists chats; show-think on/off toggles two-message Telegram mode (thinking stream frozen 💭, final sent as new reply)', example: '/e auto show-think on' },
    { name: 'residents',  usage: '/e residents <e,l|e|l|off> [<name|jid>]',                   desc: 'which beings reply in this chat — conversation-e and/or local @l', example: '/e residents e,l' },
    { name: 'llama',      usage: '/e llama on|off',                                          desc: 'enable/disable the local @l brain (alias: /e local)', example: '/e llama on' },
    { name: 'source',     usage: '/e source [<path>]',                                       desc: 'which checkout the daemon runs the app from; no arg reports running + persisted source (relative paths resolve under ~/src/, first switch needs a wrapper restart)', example: '/e source egpt-dev' },
    { name: 'heartbeat',  usage: '/e heartbeat [<slug>] [on|off|interval <min>]',      desc: 'per-conversation heartbeat (writes <slug>/config.yaml); bare or <slug> alone shows status; needs a heartbeat.md prompt in the folder to fire', example: '/e heartbeat diego on' },
    { name: 'transcribe', usage: '/e transcribe on|off|status|global [--streaming|--batch] [<jid>]', desc: 'voice-note transcription, per chat or global', example: '/e transcribe on' },
    { name: 'confirm',    usage: '/e confirm [<name|jid>] on|off|status [self|shell|egptbot|all]', desc: 'wiretap a chat: mirror VERBATIM what each resident brain is fed and its raw reply to the chosen destination(s)', example: '/e confirm on self' },
    { name: 'tool',       usage: '/e tool allow|deny|ask [all|<toolname>]',                  desc: "per-tool permission for E's brain (e.g. /e tool deny all, then /e tool allow read_file)", example: '/e tool deny all' },
    { name: 'cmd',        usage: '/e cmd allow|deny <command> | status',                     desc: 'which slash commands conversation-e may EXECUTE from its own reply (allowlist; default /react). Known-but-unlisted commands are stripped, never run', example: '/e cmd allow react' },
    { name: 'path',       usage: '/e path [list|add|rm] [<path>] [ro|rw] [<slug>]',          desc: 'custom directory grants for conversation-e (conversations/config.yaml, outside its sandbox). access ro=read-only, rw/full=read+write (default). Bare /e path lists effective access; <slug> defaults to the current chat', example: '/e path add C:\\refs\\manual ro' },
    { name: 'butler',     usage: '/e butler <prompt>',                                       desc: 'ephemeral haiku sub-agent — no session memory, default all-tools', example: '/e butler summarize my unread chats' },
    { name: 'supervisor', usage: '/e supervisor [status|restart|bounce|install|uninstall]',   desc: 'manage the NSSM egpt-daemon service: status; restart (in-band exit-43 spine reload); bounce/install/uninstall print the elevated command', example: '/e supervisor status' },
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

  // ── /e persona [<persona>] [<file>] ─────────────────────────────
  // No file → switch to identity <persona> (full install, keep thread) = alias
  // of /e identity. With a file → inject ONLY that file from identity <persona>
  // (e.g. `/e persona banter 20-personality.md`, or `/e persona banter
  // personality`) — pull one file from any identity without disturbing the rest.
  if (sub === 'persona') {
    const personaName = tokens[1] || 'default';
    const fileTok = tokens[2] || null;
    const targetJid = dispatchMeta?.waChatId;
    if (!targetJid) {
      sysOut('!! /e persona: no chat context. Use `/egpt persona [<persona>] <name-search>` from the shell instead.');
      return true;
    }
    if (!fileTok) {
      return await _runReboot({ mode: 'persona', personaName, targetJid, sysOut, ctx, originJid: targetJid });
    }
    // Single-file inject from identity <persona>.
    const cs = await readConvState(CONV_YAML_PATH);
    const slug = findContactByJid(cs, 'whatsapp', targetJid);
    if (!slug) { sysOut(`!! /e persona: no contact for ${targetJid} — send a message there first`); return true; }
    if (!resolveIdentityDir(personaName)) { sysOut(`!! /e persona: no identity "${personaName}"`); return true; }
    const injected = await injectIdentityFile('whatsapp', slug, personaName, fileTok);
    if (!injected) { sysOut(`!! /e persona: no file "${fileTok}" in identity "${personaName}"`); return true; }
    try {
      const pushedName = cs.contacts?.whatsapp?.[targetJid]?.pushedName ?? slug;
      const reply = await ctx.computeBrainTurn('e', buildPersonaAnnouncement(`${personaName}/${injected.name}`, injected.content), {
        threadId: targetJid, surface: 'wa', slug, name: pushedName, bypassAutoWrap: true,
      });
      const r = String(reply ?? '').trim();
      sysOut(`✓ /e persona ${slug}: injected ${personaName}/${injected.name}${r && r !== '...' && r !== '…' ? ` — @e: "${r.slice(0, 80)}"` : ''}`);
    } catch (e) { sysOut(`!! /e persona inject: ${e?.message ?? e}`); }
    return true;
  }

  // ── /e path [list|add|rm] [<path>] [<slug>] ─────────────────────
  // Manage conversation-e's custom directory grants (conversations/config.yaml,
  // outside its sandbox). Bare `/e path` lists the current chat's effective
  // access. <slug> defaults to the current chat; from the shell, pass it.
  if (sub === 'path') {
    const action = tokens[1] && /^(list|add|rm|remove|ls)$/i.test(tokens[1]) ? tokens[1].toLowerCase() : 'list';
    const cs = await readConvState(CONV_YAML_PATH);
    const here = dispatchMeta?.waChatId ? findContactByJid(cs, 'whatsapp', dispatchMeta.waChatId) : null;

    // Collect every jid that maps to a slug (for the room-membership view).
    const jidsForSlug = (slug) => {
      const out = new Set();
      for (const surf of Object.keys(cs.contacts ?? {})) {
        for (const [key, e] of Object.entries(cs.contacts[surf] ?? {})) {
          if (e?.slug === slug) { out.add(key); for (const j of e?.jids ?? []) out.add(j); }
        }
      }
      return [...out];
    };

    if (action === 'list' || action === 'ls') {
      const slug = tokens[2] || here;
      if (!slug) { sysOut('!! /e path: no chat context — pass a slug: `/e path list <slug>`'); return true; }
      const grants = await loadGrants();
      const custom = grantedEntries(grants, slug);
      const ownDir = slugDir('whatsapp', slug);
      let roomNames = [];
      try {
        const rs = await loadRooms();
        const seen = new Set();
        for (const j of jidsForSlug(slug)) for (const r of roomsForMember(rs, j)) seen.add(r.name);
        roomNames = [...seen];
      } catch { /* best effort */ }
      const lines = [`📂 conversation-e access for "${slug}":`];
      lines.push(`  own   (full) · ${ownDir}`);
      for (const n of roomNames) lines.push(`  room  (full) · ${join(homedir(), '.egpt', 'rooms', n)}   — member of "${n}"`);
      if (custom.length) for (const e of custom) lines.push(`  grant (${e.access}) · ${e.path}`);
      else lines.push('  (no custom grants — add with `/e path add <path> [ro]`)');
      sysOut(lines.join('\n'));
      return true;
    }

    // add | rm: `<path> [<access>] [<slug>]`. An access token (ro/read/rw/full)
    // anywhere in the tail is pulled out first; then, of what remains, an
    // explicit slug is the LAST token (so a path with spaces survives) and the
    // path is everything before it. With no explicit slug, the whole remainder
    // is the path and the target is the current chat. (rm ignores access.)
    let tail = tokens.slice(2);
    let access = 'full';
    const accIdx = tail.findIndex(t => /^(ro|read|readonly|read-only|rw|full|write)$/i.test(t));
    if (accIdx !== -1) { access = normalizeAccess(tail[accIdx]); tail = tail.filter((_, i) => i !== accIdx); }
    if (!tail.length) { sysOut(`usage: /e path ${action} <path> [ro|rw] [<slug>]`); return true; }
    let path, slug;
    if (tail.length >= 2) { slug = tail[tail.length - 1]; path = tail.slice(0, -1).join(' '); }
    else { path = tail[0]; slug = here; }
    if (!slug) { sysOut(`!! /e path ${action}: no chat context — pass a slug: \`/e path ${action} <path> [ro|rw] <slug>\``); return true; }
    if (!isAbsolute(path)) { sysOut(`!! /e path ${action}: "${path}" is not an absolute path`); return true; }

    const grants = await loadGrants();
    try {
      const next = action === 'add' ? addGrant(grants, slug, path, access) : removeGrant(grants, slug, path);
      await saveGrants(next);
      const now = grantedEntries(next, slug);
      const shown = now.length ? now.map(e => `${e.path} (${e.access})`).join(', ') : '(none)';
      const what = action === 'add' ? `granted ${path} (${access})` : `removed ${path}`;
      sysOut(`✓ /e path ${action} "${slug}": ${what}\n  grants now: ${shown}\n  (takes effect on this contact's next turn)`);
    } catch (e) { sysOut(`!! /e path ${action}: ${e?.message ?? e}`); }
    return true;
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

  // ── /e supervisor [status|restart|bounce|install|uninstall] ─────────
  // egpt runs as the NSSM Windows service `egpt-daemon`:
  //   NSSM (egpt-service.exe) → node egpt-daemon.mjs (supervisor) → node egpt.mjs (spine)
  // NSSM keeps the supervisor alive (SCM recovery, survives a kill); the supervisor
  // owns the in-band lifecycle (/upgrade pull+build, /restart, /rewind, /e source,
  // crash backoff). The legacy Task Scheduler + daemon-wrap.ps1 path is gone.
  // A plain code reload needs NO admin: /restart (exit 43) and the supervisor
  // respawns the spine. Service-level ops (install/uninstall/bounce) DO need admin
  // and a UAC prompt CANNOT surface from the headless service — so those print the
  // exact elevated command to run in your own terminal. Windows-only; no-op else.
  if (sub === 'supervisor') {
    const { spawnSync } = await import('node:child_process');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');
    if (process.platform !== 'win32') {
      sysOut('/e supervisor: Windows-only (NSSM service). No-op on this platform.');
      return true;
    }
    const action = (arg ?? '').trim().split(/\s+/)[1] || 'status';
    const setupDir = join(homedir(), 'src', 'egpt', 'setup');
    const SERVICE = 'egpt-daemon';
    const elevatedCmd = (script) => `powershell -ExecutionPolicy Bypass -File "${join(setupDir, script)}"`;

    if (action === 'status') {
      const r = spawnSync('powershell', ['-NoProfile', '-Command',
        `$s=Get-Service ${SERVICE} -ErrorAction SilentlyContinue; if($s){"$($s.Status) ($($s.StartType))"}else{"NOT INSTALLED"}`],
        { encoding: 'utf8' });
      const svc = (r.stdout ?? '').trim() || '(query failed)';
      const n = spawnSync('powershell', ['-NoProfile', '-Command',
        `@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'egpt(-daemon)?\\.mjs' }).Count`],
        { encoding: 'utf8' });
      sysOut(`/e supervisor: NSSM service ${SERVICE} = ${svc}; egpt node procs = ${(n.stdout ?? '').trim() || '?'}`);
      return true;
    }

    if (action === 'restart' || action === 'update') {
      // In-band code reload: the supervisor (egpt-daemon.mjs) respawns the spine
      // on exit 43. No admin, no service bounce, no UAC. (For the FIRST load of
      // code the running supervisor doesn't have yet, /upgrade pulls it first.)
      sysOut('/e supervisor restart: reloading the spine via exit 43 — the supervisor respawns it from current disk in ~3s (this surface drops then reconnects).\n'
        + `  For a FULL service bounce (wedged supervisor / NSSM), run elevated: ${elevatedCmd('restart-egpt-service.ps1')}`);
      if (typeof ctx.exitClean === 'function') setTimeout(() => ctx.exitClean(43), 150);
      return true;
    }

    // Service-level ops need admin; UAC can't reach the headless service, so we
    // hand the operator the exact elevated command instead of failing silently.
    const scripts = { install: 'install-nssm-service.ps1', uninstall: 'uninstall-nssm-service.ps1', bounce: 'restart-egpt-service.ps1' };
    if (scripts[action]) {
      sysOut(`/e supervisor ${action}: needs an elevated terminal (UAC can't surface from the headless service). Run:\n  ${elevatedCmd(scripts[action])}`);
      return true;
    }

    sysOut('usage: /e supervisor [status|restart|bounce|install|uninstall]');
    return true;
  }

  // ── /e heartbeat [<slug>] [on|off|interval <min>] [--slug|--jid <x>] ──
  // Forms:
  //   /e heartbeat                       → status for the CURRENT chat
  //   /e heartbeat on|off|interval <min> → set the CURRENT chat (or --slug/--jid)
  //   /e heartbeat <slug>                → status for <slug>   (works from Self)
  //   /e heartbeat <slug> on|off|interval <min> → set <slug>   (works from Self)
  if (sub === 'heartbeat') {
    const tokens2 = arg.split(/\s+/).filter(Boolean);   // ['heartbeat', ...]
    const ACTIONS = ['on', 'off', 'interval'];
    // Pull --slug/--jid out anywhere; keep the rest as positionals.
    let slugFlag = null, jidFlag = null;
    const pos = [];
    for (let i = 1; i < tokens2.length; i++) {
      if (tokens2[i] === '--slug' && tokens2[i + 1]) { slugFlag = tokens2[++i]; continue; }
      if (tokens2[i] === '--jid'  && tokens2[i + 1]) { jidFlag  = tokens2[++i]; continue; }
      pos.push(tokens2[i]);
    }
    // Disambiguate the positionals: a leading on|off|interval acts on the
    // current chat; otherwise the first positional is a target SLUG and the
    // (optional) second is the action. No action → status (read-only).
    let posSlug = null, hbAction = null, value = null;
    if (pos.length === 0) {
      hbAction = null;                                   // status, current chat
    } else if (ACTIONS.includes(pos[0])) {
      hbAction = pos[0]; value = pos[1] ?? null;         // act on current chat / flagged
    } else {
      posSlug = pos[0];                                  // first positional is the slug
      if (pos[1] && ACTIONS.includes(pos[1])) { hbAction = pos[1]; value = pos[2] ?? null; }
    }
    if (hbAction === 'interval' && value == null) {
      sysOut('usage: /e heartbeat [<slug>] interval <min>'); return true;
    }
    // Per-entity heartbeat config lives in the conversation's OWN folder:
    //   <slugDir>/config.yaml  → { heartbeat: { enabled, interval_min } }
    // read each scan by the daemon via src/heartbeats.mjs. The prompt body is
    // a sibling heartbeat.md the operator drops in the same folder — without
    // it the heartbeat has nothing to say and does not fire.
    const cs = await readConvState(CONV_YAML_PATH);
    // /e is WA-scoped by default — dispatchMeta.waChatId is a WA jid.
    // TG-side equivalent will be added with task #20.
    const surface = 'whatsapp';
    const targetSlug = posSlug ?? slugFlag ?? findContactByJid(cs, surface, jidFlag ?? dispatchMeta?.waChatId);
    if (!targetSlug) {
      sysOut(`!! /e heartbeat: no contact for ${posSlug ?? slugFlag ?? jidFlag ?? dispatchMeta?.waChatId ?? '<no chat context>'} — try /e heartbeat <slug> [on|off|interval <min>]`);
      return true;
    }
    const hbDir = slugDir(surface, targetSlug);
    const hbCfgPath = join(hbDir, 'config.yaml');
    let hbDoc = {};
    try { hbDoc = YAML.parse(await readFile(hbCfgPath, 'utf8')) ?? {}; } catch { /* no config.yaml yet */ }
    if (!hbDoc || typeof hbDoc !== 'object') hbDoc = {};
    const block = (hbDoc.heartbeat && typeof hbDoc.heartbeat === 'object') ? hbDoc.heartbeat : {};

    // Status form (no action) — read-only report, no write.
    if (!hbAction) {
      const hasPrompt = existsSync(join(hbDir, 'heartbeat.md'));
      let lastFired = 'never';
      try {
        const st = JSON.parse(readFileSync(join(hbDir, 'heartbeat.state.json'), 'utf8'));
        if (st?.lastFiredAt) lastFired = st.lastFiredAt;
      } catch { /* never fired */ }
      sysOut(`/e heartbeat ${targetSlug}: enabled=${block.enabled === true} interval=${block.interval_min ?? 30}min prompt=${hasPrompt ? 'heartbeat.md ✓' : "✗ none (won't fire)"} lastFired=${lastFired}`);
      return true;
    }

    if (hbAction === 'on')  block.enabled = true;
    if (hbAction === 'off') block.enabled = false;
    if (hbAction === 'interval') {
      const mins = parseFloat(value);
      if (!Number.isFinite(mins) || mins < 0.1) {
        sysOut('!! /e heartbeat interval: minutes must be a positive number (>= 0.1, fractional OK)'); return true;
      }
      block.interval_min = mins;
    }
    hbDoc.heartbeat = block;
    try {
      await mkdir(hbDir, { recursive: true });
      await writeFile(hbCfgPath, YAML.stringify(hbDoc, { lineWidth: 100 }), 'utf8');
    } catch (e) { sysOut(`!! /e heartbeat: write ${hbCfgPath} failed — ${e?.message ?? e}`); return true; }
    const noPrompt = block.enabled === true && !existsSync(join(hbDir, 'heartbeat.md'));
    sysOut(`/e heartbeat: ${targetSlug} enabled=${block.enabled === true} interval=${block.interval_min ?? 30}min (config.yaml)${noPrompt ? " — ⚠ no heartbeat.md in the folder yet; it won't fire until you add one" : ''}`);
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
    sysOut('usage: /e new [<persona>] | /e persona [<persona>] | /e auto on|accum|mute|mention-direct|mention|off [<name|jid>] | /e auto pause|resume|status | /e residents <e,l|e|l|off> [<name|jid>] | /e llama on|off | /e source [<path>] | /e heartbeat [<slug>] [on|off|interval <min>] | /e transcribe on|off|status|global [--streaming] | /e confirm [<name|jid>] on|off|status [self|shell|egptbot|all] | /e tool allow|deny|ask [all|<toolname>]');
    return true;
  }

  if (!EGPT_CONFIG.whatsapp || typeof EGPT_CONFIG.whatsapp !== 'object') {
    EGPT_CONFIG.whatsapp = {};
  }
  const wa = EGPT_CONFIG.whatsapp;
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

    const paused = wa.auto_e_paused ? 'PAUSED (global kill on)' : 'active';
    const def = wa.auto_e_default_mode || DEFAULT_AUTO_MODE;
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
    wa.auto_e_paused = true; autoLabel = 'PAUSED (global kill on)';
  } else if (action === 'resume') {
    wa.auto_e_paused = false; autoLabel = 'active (resumed)';
  } else if (MODES.includes(action)) {
    const target = jidArg ? String(jidArg).trim() : null;
    if (target && target.toLowerCase() === 'all') {
      // 'all' makes EVERY chat this mode: set the global default + clear all
      // per-chat overrides so nothing deviates. The per-chat overrides now live
      // in each conversation entry's `mode`, so clear those (not a flat key).
      // (Use /e auto pause for a temporary global kill that preserves config.)
      wa.auto_e_default_mode = action;
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
    if (!saved.whatsapp || typeof saved.whatsapp !== 'object') saved.whatsapp = {};
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
