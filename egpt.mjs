#!/usr/bin/env node
// egpt.mjs — file IS the conversation; Ink shell; sessions = named participants
import React from 'react';
import { render, Box, Text, Static, useInput, useApp } from 'ink';
import YAML from 'yaml';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync, createWriteStream, watch as fsWatch, statSync, renameSync, appendFileSync } from 'node:fs';
import { PassThrough, Writable } from 'node:stream';
import { readFile, writeFile, appendFile, readdir, stat, open, mkdir, unlink, rm, rename, symlink, copyFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as ccode from './config/brains/claude-code.mjs';
import * as claudeSdk from './config/brains/claude-sdk.mjs';
import * as codex from './config/brains/codex.mjs';
import * as chatgptCdp from './config/brains/chatgpt-cdp.mjs';
import * as claudeCdp from './config/brains/claude-cdp.mjs';
import * as llama from './config/brains/llama.mjs';
import * as cdp from './src/tools/cdp.mjs';
import * as bus from './src/tools/bus.mjs';
import { reapPort } from './src/tools/reap-port.mjs';
import { stripFrontMatter } from './src/transcript-meta.mjs';
import { transcriptAppend, replyLine } from './src/transcript-log.mjs';
import { DEFAULT_AUTO_MODE, replyAllowed as autoReplyAllowed, receives as autoReceives, isAutoMode as autoIsMode, mayEmit as autoMayEmit, mayEmitChat as autoMayEmitChat, mentionStatus as autoMentionStatus } from './src/auto-mode.mjs';
import { formatDispatchLine } from './src/dispatch-line.mjs';
import { renderThink } from './src/show-think.mjs';
import { mediaFileName, mediaIndexLine } from './src/media-save.mjs';
import { loadTemplate, buildCommandPrompt } from './src/tools/template.mjs';
import { loadTheme, listThemes } from './src/tools/theme.mjs';
import { startTelegramBridge } from './src/bridges/telegram.mjs';
// Baileys init goes through egpt-comm-handler.mjs — the keeper side
// of the twin-soul split. Today it's a thin in-process wrapper; in
// Phase 2 the keeper runs in its own process and the handler reaches
// WA via file IPC (~/.egpt/inbox + ~/.egpt/outbox).
import { classifyWhatsAppChat } from './src/bridges/whatsapp-classify.mjs';
import { createDispatchRuntime, dispatchPersonaTurn } from './dispatch.mjs';
import { startOutboxWatcher, createInProcessStreamChannel, startInboxWatcher } from './src/egpt-comm-handler.mjs';
import { startWhatsAppCdpBridge } from './src/bridges/whatsapp-cdp.mjs';
import { startBeeperBridge } from './src/bridges/beeper.mjs';
import { recordSession, startNew, rewind, listHistory, summarize, setBrain, isUrlBrain } from './src/persona-state.mjs';
import * as conversationsState from './conversations-state.mjs';
import { emojiForAuthor as _emojiForAuthor } from './author-emoji.mjs';
import { parseInput, helpText, helpHtml, COMMANDS } from './src/interpreter.mjs';
import { buildMenu, initState, view as helpView, step as helpStep, searchView as helpSearchView, renderText as helpRenderText } from './src/help-menu.mjs';
import { loadRooms, saveRooms, roomsForMember, sanitizeName, createRoom, getRoom, addMember, sessionsMapFromMembers, roomDir } from './src/rooms.mjs';
import * as hb from './src/heartbeats.mjs';
import { acquireStayAwake } from './src/tools/stay-awake.mjs';
import { entriesForSlug } from './src/conv-grants.mjs';
import { createWarmPool } from './src/warm-sessions.mjs';
import { createWarmCliSession } from './src/warm-cli-session.mjs';
// Warm-session pool singleton at MODULE scope — the _warmPool() helper lives in
// a per-dispatch closure, so a local `let` reset every turn → a brand-new empty
// pool each turn (no warm reuse). Module scope persists across dispatches.
let _warmPoolSingleton = null;
import { planFanout, roomEnvelope, isRoomEnvelope } from './src/room-routing.mjs';
import { resolveRoute, planMirrors } from './src/room.mjs';
import { CONFIG_SCHEMA } from './config/config-schema.mjs';
import { buildWelcomeBack, resetCountersOnDisk, writeLastLogonNow } from './src/tools/logon-summary.mjs';
import { waListToStableCache as _waListToStableCache } from './src/tools/wa-bindings.mjs';
import { summonGenie as _summonGenieFromBridge } from './src/tools/genie.mjs';
import { buildMoviePayload as _buildMoviePayload } from './slash/movie.mjs';
import { createOutputChannel } from './src/engine/output.mjs';
import { startAttachHost } from './src/nucleus.mjs';
import { clearNucleusInfoSync, readNucleusInfo } from './src/attach/discovery.mjs';
import { connectAttachClient } from './src/attach/client.mjs';
import { N2C } from './src/attach/protocol.mjs';
import { swallow } from './src/swallow.mjs';
import { runVoiceStreamTurn } from './src/voice-stream.mjs';
import { makeRemoteFirstTranscriber, startTranscriptorServer, TRANSCRIPTOR_DEFAULT_PORT } from './src/tools/transcriptor.mjs';
import { startWhisperServer, makeWhisperServerTranscriber } from './src/tools/whisper-server.mjs';
import { transcribeAudioFile } from './src/tools/transcribe.mjs';

const { createElement: h, useState, useEffect, useRef, useCallback, Fragment } = React;
const APP_DIR = dirname(fileURLToPath(import.meta.url));
const EGPT_HOME = join(homedir(), '.egpt');
// Logs subdir (operator 2026-06-05 cleanup): wa-bridge.log, headless.log,
// restart.log, and other rolling traces live here instead of polluting the
// top of ~/.egpt with a dozen .log files. Code paths that wrote at the old
// location are updated in lockstep. Existing top-level *.log files are
// historical artifacts and can be archived/deleted manually; the daemon
// won't write to them anymore.
const EGPT_LOGS = join(EGPT_HOME, 'logs');
// If this mkdir fails, EVERY file log below (wa-bridge.log, headless.log,
// restart.log, swallowed.log) silently dies with it — shout while we still
// have a console.
try { mkdirSync(EGPT_LOGS, { recursive: true }); }
catch (e) { console.error(`!! egpt boot: cannot create ${EGPT_LOGS} — all file logging will fail: ${e?.message ?? e}`); }
// state subdir holds runtime state files (alive.txt, nucleus.json,
// restart-announce.json, egpt.pid as of beta-19). Created here at
// module load so any module-level constants that reference state/
// can use it without their own mkdir.
const EGPT_STATE = join(EGPT_HOME, 'state');
try { mkdirSync(EGPT_STATE, { recursive: true }); }
catch (e) { console.error(`!! egpt boot: cannot create ${EGPT_STATE} — pidfile/heartbeat/crash.log will fail: ${e?.message ?? e}`); }

// ── One-shot migration on startup (operator 2026-06-05) ──────────
// beta-18 left a handful of files at the top of ~/.egpt that beta-19
// relocated. Files that COULDN'T be moved while the daemon was running
// (because the daemon held them open) get nuked here on the next start
// — by which point either (a) the daemon already wrote the new copy
// in EGPT_LOGS / EGPT_STATE, making the top-level copy a stale orphan,
// or (b) the daemon never opened them again. Idempotent: silently
// no-ops once the top-level path is gone.
//
// /restart from Self triggers this naturally — the dying engine
// releases its handles, the new engine boots, this block runs, the
// orphans are cleaned up. No external script required.
try {
  // egpt.pid: ~/.egpt/egpt.pid -> ~/.egpt/state/egpt.pid
  const oldPid = join(EGPT_HOME, 'egpt.pid');
  if (existsSync(oldPid)) { try { unlinkSync(oldPid); } catch (e) { swallow('boot.migrate-unlink', e); } }

  // *.log: ~/.egpt/<name>.log -> ~/.egpt/logs/<name>.log. Includes
  // service-{stdout,stderr}.log which the prior NSSM install kept
  // open at the top-level path; the reinstall released them but a
  // stale 0-byte file can linger.
  for (const name of [
    'wa-bridge.log', 'headless.log', 'headless.log.1',
    'restart.log', 'wrap.log', 'keeper.log', 'install-windows.log',
    'service-stdout.log', 'service-stderr.log',
    'egpt-service.out.log', 'egpt-service.err.log',
  ]) {
    const p = join(EGPT_HOME, name);
    if (existsSync(p)) { try { unlinkSync(p); } catch (e) { swallow('boot.migrate-unlink', e); } }
  }
} catch (e) { swallow('boot.migrate', e); /* best-effort — never block startup */ }

// Engine OUTPUT chokepoint (Phase B — ENGINE-SURFACE-SEPARATION.md). Every
// rendered item flows through this one channel; the Ink renderer subscribes
// (see the App mount effect) and code emits via pushItem() instead of calling
// setItems() directly. That decoupling is what lets Phase D's attached clients
// subscribe to the same output stream. Module-scope for now; it moves into the
// engine module when the engine is extracted from the App (Phase C).
const outputChannel = createOutputChannel();
const pushItem = (item) => outputChannel.emit(item);
// The engine attach host (Phase C) — limbs (the thin TTY client, the extension)
// connect here over loopback TCP. Module-scope handle so the process 'exit'
// handler can clear its discovery sidecar. Set by the App's host-start effect.
let _globalAttachHost = null;

// slash/*.mjs file-command registry. Each file in slash/ exports a
// `meta` (object or array of objects, one per cmd it registers) and
// an async `run({ cmd, arg, ctx })`. The scanner loads them once at
// shell startup; the dispatcher in handleSlash routes by cmd before
// falling through to the legacy inline if-chain. Migration is
// incremental: a command living in a slash/ file overrides any
// inline branch with the same cmd, and inline branches stay
// untouched until their file lands.
import { readdirSync } from 'node:fs';
const SLASH_REGISTRY = new Map();
{
  const slashDir = join(APP_DIR, 'slash');
  let entries = [];
  try { entries = readdirSync(slashDir); } catch (e) { console.error(`!! egpt.mjs:[catch] ${e?.message ?? e}`); /* dir missing — empty registry */ }
  for (const f of entries) {
    if (!f.endsWith('.mjs')) continue;
    try {
      const mod = await import(`./slash/${f}`);
      const metaList = Array.isArray(mod.meta) ? mod.meta : (mod.meta ? [mod.meta] : []);
      for (const m of metaList) {
        if (m?.cmd && typeof mod.run === 'function') {
          SLASH_REGISTRY.set(m.cmd, { meta: m, run: mod.run, source: f });
        }
      }
    } catch (e) {
      console.error(`!! slash/${f} failed to load: ${e.message}`);
    }
  }
}
// Help-menu source of commands. COMMANDS is the CURATED menu (hand-grouped
// sections + descriptions) and stays authoritative — most commands have been
// migrated to slash/*.mjs for dispatch, but their menu descriptors still live
// here. A slash-only command (one with no COMMANDS entry, e.g. /e) opts INTO
// the menu by declaring `section` in its meta; it's appended under that
// section (existing names merge by name, so /e joins PERSONA next to
// /identity). Slash files without a section stay out of the menu — they're
// operational, not user-facing. This is what makes /e and its verbs (source,
// auto, residents…) discoverable without disturbing the curated list.
function _mergedHelpCommands() {
  const inCommands = new Set(COMMANDS.filter(c => c.cmd).map(c => c.cmd));
  const extra = [...SLASH_REGISTRY.values()]
    .map(s => s.meta)
    .filter(m => m?.cmd && m.section && !inCommands.has(m.cmd));
  // Each meta carries its own `section`, so buildMenu places it directly;
  // names matching a curated COMMANDS section (e.g. PERSONA) merge into it.
  return extra.length ? [...COMMANDS, ...extra] : COMMANDS;
}
// Pidfile: single-writer ownership of the WA pairing (baileys can only
// authenticate one client at a time). Headless engine writes its PID
// here at startup; a subsequent interactive shell reads it, SIGTERMs
// the old process, polls until it exits, then takes over. Cleared on
// clean exit (signal handler + process.exit). See takeoverIfRunning().
const EGPT_PID_PATH = join(EGPT_STATE, 'egpt.pid');
// Headless mode log: Ink renders nowhere visible (no tty), so any
// console.log / sysOut that would have hit the terminal lands here for
// post-mortem. Bridges + room.md are still the canonical record;
// this is auxiliary.
const EGPT_HEADLESS_LOG = join(EGPT_LOGS, 'headless.log');
// fs-direct host-side trace into the SAME wa-bridge.log the bridge writes, so
// the bridge lifecycle (bridge side) and the host's waBridgeRef set/clear +
// every outbox send attempt interleave on ONE timestamped timeline. Resolves
// the "socket OPEN but outbox says 'no baileys bridge here'" contradiction
// (operator 2026-06-02). Append-only, best-effort.
const _WA_BRIDGE_LOG = join(EGPT_LOGS, 'wa-bridge.log');
const _walog = (m) => { try { appendFileSync(_WA_BRIDGE_LOG, `${new Date().toISOString()} [${process.pid}] host: ${m}\n`, { mode: 0o600 }); } catch { /* best effort */ } };

// Read the existing pidfile if any. Returns the PID number when the
// process is still alive, otherwise null (and silently clears stale
// entries). Uses `process.kill(pid, 0)` — the POSIX "are you there"
// probe that throws ESRCH for dead PIDs. On Windows, Node maps this
// to OpenProcess + check; same semantics.
// Returns { pid, mode } of the live incumbent, or null. mode is
// 'interactive' | 'headless' | 'unknown' (legacy bare-number pidfile).
// Clears the pidfile when the recorded pid is dead.
function _readLiveIncumbent() {
  let raw;
  try { raw = readFileSync(EGPT_PID_PATH, 'utf8').trim(); }
  catch (e) { swallow('pidfile.read', e, { expect: ['ENOENT'] }); return null; }
  let pid = NaN, mode = 'unknown';
  try {
    if (raw.startsWith('{')) {
      const o = JSON.parse(raw);
      pid = Number(o.pid); mode = o.mode ?? 'unknown';
    } else {
      pid = Number(raw);   // legacy format
    }
  } catch { /* corrupt JSON — falls through to the !isFinite branch below */ }
  if (pid === process.pid) return null;   // our own pidfile — leave it
  if (!Number.isFinite(pid) || pid <= 0) {
    // A corrupt pidfile is worse than a missing one: returning null and
    // LEAVING it would let every newcomer skip the takeover handshake and
    // fight the incumbent over the WA pairing. Clear it and shout.
    console.error(`!! egpt: pidfile ${EGPT_PID_PATH} is corrupt (${JSON.stringify(raw.slice(0, 80))}) — clearing it`);
    try { unlinkSync(EGPT_PID_PATH); } catch (e) { swallow('pidfile.clear-corrupt', e); }
    return null;
  }
  try { process.kill(pid, 0); return { pid, mode }; }
  catch { try { unlinkSync(EGPT_PID_PATH); } catch (e) { swallow('pidfile.clear-stale', e); } return null; }
}

// Cooperative takeover (operator 2026-05-23: "the two supervisors
// should see each other... if the other is in control, perhaps a
// Hi!"). Instead of always SIGTERM-warring the incumbent, we honor
// roles:
//   - interactive newcomer: takes the helm (the operator wants the
//     shell). SIGTERMs the incumbent, waits for release.
//   - headless newcomer + interactive incumbent: DEFERS. Logs a
//     greeting and enters a quiet standby poll — stays alive (so the
//     supervisor doesn't respawn-loop) until the interactive shell
//     exits, then takes over. This is what stops the two-supervisor
//     war: the background daemon never fights the active shell.
//   - headless newcomer + headless incumbent: takes over (a fresh
//     headless replaces a stale one — normal restart).
//   - unknown (legacy) incumbent: takes over (back-compat).
async function _waitForRelease(pid) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch { try { unlinkSync(EGPT_PID_PATH); } catch (e) { swallow('pidfile.clear-released', e); } return true; }
    await new Promise(r => setTimeout(r, 200));
  }
  console.error(`egpt: previous instance (pid ${pid}) did not exit within 10s; continuing anyway`);
  return true;
}
async function takeoverIfRunning(myMode = 'interactive') {
  let greeted = false;
  while (true) {
    const inc = _readLiveIncumbent();
    if (!inc) return false;   // helm is free

    if (myMode === 'headless' && inc.mode === 'interactive') {
      // Defer to the active shell. Greet once, then poll quietly.
      if (!greeted) {
        console.error(`👋 egpt headless: Hi — interactive shell (pid ${inc.pid}) has the helm; standing by. Will take over when it exits.`);
        greeted = true;
      }
      await new Promise(r => setTimeout(r, 10_000));
      continue;   // re-check; loop exits when inc becomes null
    }

    // interactive newcomer, OR headless-replacing-headless, OR legacy.
    console.error(`egpt ${myMode}: taking the helm from ${inc.mode} (pid ${inc.pid})`);
    try { process.kill(inc.pid, 'SIGTERM'); } catch {}
    return await _waitForRelease(inc.pid);
  }
}

function writePidfile(mode = 'interactive') {
  try {
    mkdirSync(EGPT_HOME, { recursive: true });
    writeFileSync(EGPT_PID_PATH, JSON.stringify({ pid: process.pid, mode }), { mode: 0o600 });
  } catch (e) {
    // No pidfile = no single-writer handshake: the next process can't see
    // us and will start a second WA client against the same pairing.
    console.error(`!! egpt: pidfile write FAILED (${e?.message ?? e}) — takeover handshake is broken; a second instance may fight over WhatsApp`);
  }
}

function clearPidfile() {
  try {
    const raw = readFileSync(EGPT_PID_PATH, 'utf8').trim();
    const pid = raw.startsWith('{') ? Number(JSON.parse(raw).pid) : Number(raw);
    if (pid === process.pid) unlinkSync(EGPT_PID_PATH);
  } catch (e) { swallow('pidfile.clear', e, { expect: ['ENOENT'] }); }
}

// Heartbeat-to-file aliveness pattern (operator 2026-05-23):
//   - the supervised daemon writes ~/.egpt/state/alive.txt every interval
//     with an ISO timestamp + pid (tic/toc, below).
//   - the ONLY consumer now is the daemon SINGLETON GUARD: a second
//     `egpt-daemon` reads this file (liveDaemonPid) and refuses to start
//     when a live daemon's beat is fresh — so two daemons never fight over
//     WhatsApp. A human `cat` can also read "is it alive / last beat".
//   - NO watchdog kills based on this anymore. The heartbeat-kill watchdog
//     (setup/watchdog.ps1) was removed: it killed healthy/reconnecting
//     daemons (the "daemon got confused with the heartbeat" failure). One
//     trivial supervisor, no liveness-kill — a wedged bridge reconnects on
//     its own; it is not a reason to SIGKILL the engine.
const ALIVE_PATH = join(EGPT_HOME, 'state', 'alive.txt');   // .txt so it opens cleanly in Explorer / anywhere
// Cross-process shell mirror — NDJSON append log, one event per line of the
// form {"ts","pid","room","env"}. Producer: every egpt process appends here
// when _deliverToRoom fans an envelope to a shell/extension member. Consumer:
// every egpt process tails it and skips own-pid lines, so a deferred shell
// can show traffic the daemon's bridge surfaced (operator 2026-05-29).
const SHELL_MIRROR_PATH = join(EGPT_HOME, 'state', 'shell-mirror.jsonl');
// Resolved lazily inside startAliveHeartbeat() — NOT at module-eval
// time, because EGPT_CONFIG is declared ~65 lines below this and a
// const referencing it here threw "Cannot access 'EGPT_CONFIG'
// before initialization" (TDZ) on EVERY startup → instant crash-loop,
// daemon never reached the heartbeat. Operator 2026-05-23: that
// crash-loop is what masqueraded as a "dead/wedged" daemon.
const ALIVE_INTERVAL_DEFAULT_MS = 60_000;   // 15s was excessive disk I/O
let _aliveTimer = null;
// tic/toc heartbeat (operator 2026-05-23). The file holds at most two
// lines; the daemon alternates:
//   - if a `toc` line is present → write `tic <iso>` truncating the
//     file (erases the old toc)
//   - else → append `toc <iso>`
// So the file cycles:  "toc T1"  →  "tic T2"  →  "tic T2\ntoc T3"  → …
// Freshness = the most recent of whatever tic/toc timestamps are
// present. The alternation proves RHYTHM (two recent beats ~one
// interval apart), not just that a single write happened; and the
// two lines record the last-two-beats so the singleton guard (and a human
// `cat`) can read both "is it alive" and "time of last beat / death".
// Option A architecture (operator 2026-05-29): one ~/.egpt/ = one egpt node
// = one supervised daemon. Only the supervised daemon writes alive.txt and
// whatsapp-alive.txt; an interactive shell sharing the home is a thin client
// that defers to the daemon and never touches these files. A separate egpt
// node (parallel daemon, eventual egptbot account) gets its own ~/.egpt-<name>
// home with its own wa-auth — naturally parallel-safe, no shared state.
function _writeAliveNow() {
  if (!process.env.EGPT_SUPERVISED) return;   // only the daemon writes
  try {
    const now = new Date().toISOString();
    // Each line carries the pid so the singleton guard can identify the
    // live daemon straight from alive.txt — no dependency on a separate
    // egpt.pid (which can go missing). Format: "<tic|toc> <iso> <pid>".
    const beat = (label) => `${label} ${now} ${process.pid}\n`;
    let content = '';
    try { content = readFileSync(ALIVE_PATH, 'utf8'); } catch (e) { swallow('alive.read', e, { expect: ['ENOENT'] }); }
    if (/^toc /m.test(content)) {
      // toc present → write tic, truncating (erases the rest).
      writeFileSync(ALIVE_PATH, beat('tic'), { mode: 0o600 });
    } else {
      // no toc → append it.
      appendFileSync(ALIVE_PATH, beat('toc'), { mode: 0o600 });
    }
  } catch (e) {
    // A heartbeat write failure is real signal (disk full, perms,
    // path gone) — log it so it's not silently lost; crash.log records
    // WHY. Operator 2026-05-23: "crash logger also captures tictoc
    // failures?" — yes.
    try { mkdirSync(join(EGPT_HOME, 'state'), { recursive: true }); } catch {}
    try { _logCrash('heartbeat-write', e); } catch {}
  }
}
function startAliveHeartbeat() {
  // Config read here (runtime), not at module-eval — EGPT_CONFIG is
  // loaded by the time this is called from the startup sequence.
  const intervalMs = Number(EGPT_CONFIG?.heartbeat?.interval_ms) > 0
    ? Number(EGPT_CONFIG.heartbeat.interval_ms)
    : ALIVE_INTERVAL_DEFAULT_MS;
  try { mkdirSync(join(EGPT_HOME, 'state'), { recursive: true }); } catch {}
  _writeAliveNow();   // no-op for non-supervised processes
  if (_aliveTimer) clearInterval(_aliveTimer);
  _aliveTimer = setInterval(_writeAliveNow, intervalMs);
  _aliveTimer.unref?.();
}
function stopAliveHeartbeat() {
  if (_aliveTimer) { clearInterval(_aliveTimer); _aliveTimer = null; }
  if (process.env.EGPT_SUPERVISED) {
    try { unlinkSync(ALIVE_PATH); } catch (e) { swallow('alive.unlink', e, { expect: ['ENOENT'] }); }
  }
}

// Load config: global (~/.egpt/config.json) then local (.egpt/config.json).
// Local keys override global ones. Both files are optional.
//
// Merge is ONE-LEVEL DEEP for plain-object values (telegram, whatsapp,
// default_brain, meta_brain, siblings, oracle, etc.) so a local file
// that overrides ONE sub-key (e.g. {whatsapp:{client_name:"moto"}})
// doesn't clobber the rest of the global whatsapp block (chat_id,
// auto_e_chats, allowed_users, awareness, etc.). Shipped 2026-05-17
// after a silent config-clobber bug caused auto_e_chats to vanish
// in-memory, dropping fromMe messages at the bridge awareness gate.
let EGPT_CONFIG = {};
// Config now reads ~/.egpt/config.yaml (operator-editable YAML). Sync
// reader auto-migrates from legacy config.json on first call.
//
// Failure here is CRITICAL — without config, the bridge starts with
// no auto_e_chats, no allowed_users, no chat_id; every operator
// message becomes observe-only-SKIPped and outbound sends BLOCK. We
// observed this exact bug on 2026-05-22 when a repo move broke the
// dynamic import path (silent catch hid it for hours). The catch
// below now SHOUTS and queues a Self DM alert.
try {
  const { readConfigSync } = await import('./src/tools/config-io.mjs');
  EGPT_CONFIG = readConfigSync();
} catch (e) {
  // eslint-disable-next-line no-console
  console.error(`!! egpt boot: readConfigSync FAILED — ${e?.stack ?? e?.message ?? e}\n!! EGPT_CONFIG will be empty; auto_e_chats / allowed_users / chat_id undefined → every chat will observe-only-SKIP and every brain outbound send will BLOCK.`);
  // Best-effort operator alert: write a wa-send event targeting the
  // OPERATOR's hard-coded Self DM jid (we can't read it from config
  // since config didn't load). Comm-handler picks this up the next
  // time it sweeps the outbox; the operator sees a Self DM warning
  // even if the bridge boots into a broken state.
  try {
    const _bootAlertJid = '34836563681438@lid';   // operator's WA Self DM lid form
    const _id = Date.now() + '-bootfail';
    writeFileSync(join(homedir(), '.egpt', 'outbox', `${_id}.json`), JSON.stringify({
      type: 'wa-send', from: 'system', ts: Date.now(),
      jid: _bootAlertJid,
      body: `⚠ egpt boot warning: config load FAILED — ${(e?.message ?? String(e)).slice(0, 200)}. Bridge running with empty config; every chat is observe-only. Restart after fixing.`,
    }));
  } catch (e2) { console.error(`!! egpt boot: alert write failed — ${e2?.message ?? e2}`); }
}
// Post-load sanity check: even if readConfigSync didn't throw, the
// resulting object might be missing critical keys (operator removed
// them by accident, file got truncated, etc.). Surface explicitly.
(() => {
  const wa = EGPT_CONFIG?.whatsapp;
  const missing = [];
  if (!wa || typeof wa !== 'object') missing.push('whatsapp (whole section)');
  else {
    if (!wa.chat_id) missing.push('whatsapp.chat_id');
    if (!Array.isArray(wa.allowed_users)) missing.push('whatsapp.allowed_users');
    if (!Array.isArray(wa.auto_e_chats)) missing.push('whatsapp.auto_e_chats');
  }
  if (missing.length) {
    // eslint-disable-next-line no-console
    console.error(`!! egpt boot sanity: config loaded but missing required keys: ${missing.join(', ')}`);
  }
})();
// /restart back-online announcement. If the previous process exited via
// /restart it left state/restart-announce.json (target chat + the commit it
// respawned on). Drop a "back online" wa-send into the outbox — delivered
// once the bridge reconnects — so the operator sees the restart completed in
// Self, with the exact running version. Delete the sidecar so a plain
// boot/crash (no /restart) never re-announces. Best-effort; never blocks boot.
(() => {
  const _rlogPath = join(EGPT_LOGS, 'restart.log');
  const _rlog = (m) => { try { appendFileSync(_rlogPath, `${new Date().toISOString()} [${process.pid}] boot: ${m}\n`, { mode: 0o600 }); } catch {} };
  try {
    const _sidecar = join(homedir(), '.egpt', 'state', 'restart-announce.json');
    if (!existsSync(_sidecar)) { _rlog('no restart-announce sidecar (cold boot / crash / non-/restart) → no "egpt back!"'); return; }
    const _info = JSON.parse(readFileSync(_sidecar, 'utf8'));
    _rlog(`sidecar FOUND: jid=${_info?.jid ?? 'none'} sha=${_info?.sha ?? '?'}`);
    if (_info?.jid) {
      const _down = _info.at ? Math.max(0, Math.round((Date.now() - _info.at) / 1000)) : null;
      // Re-read HEAD: /upgrade changes the commit across the bounce, so the
      // sidecar's pre-bounce sha would be stale. Report the ACTUALLY running
      // commit; fall back to the sidecar values if git is unavailable.
      let _sha = _info.sha ?? '?', _subj = _info.subj ?? '';
      try {
        const _r = spawnSync('git', ['log', '-1', '--format=%h\t%s'], { cwd: APP_DIR });
        if (_r.status === 0) {
          const [_h, _s] = (_r.stdout?.toString() ?? '').trim().split('\t');
          if (_h) { _sha = _h; _subj = _s ?? _subj; }
        }
      } catch { /* git optional */ }
      // Report BOTH ends so a restart is verifiable in Self: the booted pid +
      // commit ("booted"), and the outgoing pid + commit ("before"). PID change
      // proves a real respawn; matching sha = /restart, differing sha = /upgrade.
      const _oldPid = _info.pid ?? null;
      const _oldSha = _info.sha ?? '?';
      const _hashLine = _oldSha && _oldSha !== _sha ? `${_oldSha} → ${_sha}` : _sha;
      const _postFile = join(homedir(), '.egpt', 'outbox', `${Date.now()}-restart-post.json`);
      writeFileSync(_postFile, JSON.stringify({
        type: 'wa-send', from: 'system', ts: Date.now(), jid: _info.jid,
        body: `🧠 egpt back! pid ${process.pid}${_oldPid ? ` (was ${_oldPid})` : ''} · ${_hashLine}${_subj ? ` "${_subj}"` : ''}${_down != null ? ` · ${_down}s down` : ''}`,
      }));
      _rlog(`queued "egpt back!" → outbox ${_postFile} (jid=${_info.jid}) — delivers when the bridge is up`);
    } else {
      _rlog('sidecar had NO jid → nothing queued');
    }
    unlinkSync(_sidecar);
  } catch (e) { const _m = `restart-announce FAILED — ${e?.message ?? e}`; try { appendFileSync(join(EGPT_LOGS, 'restart.log'), `${new Date().toISOString()} [${process.pid}] boot: ${_m}\n`); } catch {} console.error(`!! egpt boot: ${_m}`); }
})();
// Runtime overlay config (JSON) that /config writes to — kept SEPARATE from
// config.yaml so /config never has to YAML-round-trip the operator's
// hand-written config (which would drop all the `_note` comments). Anchored to
// a STABLE ~/.egpt path, NOT process.cwd(): the daemon's cwd flips between
// worktrees with /e source, and a cwd-relative overlay scattered /config writes
// into src/egpt/.egpt vs src/egpt-dev/.egpt and silently "lost" settings
// (routing_enabled) across restarts (operator 2026-05-27).
const LOCAL_CONFIG_PATH = join(EGPT_HOME, 'config.local.json');
function _isPlainObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function _shallowDeepMerge(base, override) {
  if (!_isPlainObject(override)) return override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = _isPlainObject(v) && _isPlainObject(base?.[k]) ? { ...base[k], ...v } : v;
  }
  return out;
}
try {
  const local = JSON.parse(readFileSync(LOCAL_CONFIG_PATH, 'utf8'));
  EGPT_CONFIG = _shallowDeepMerge(EGPT_CONFIG, local);
} catch (e) {
  // Missing overlay is normal; a CORRUPT one silently dropping every
  // /config-written setting (routing_enabled, …) is the exact bug class
  // from 2026-05-27 — shout instead of swallowing.
  if (e?.code !== 'ENOENT') {
    console.error(`!! egpt boot: ${LOCAL_CONFIG_PATH} unreadable/corrupt — ALL /config overlay settings are dropped this run: ${e?.message ?? e}`);
  }
}
const T = loadTheme(EGPT_CONFIG.theme ?? 'catppuccin');
let _currentTheme = EGPT_CONFIG.theme ?? 'catppuccin';

// WhatsApp transport resolution (operator 2026-06-10: "baileys never.
// chrome-cdp is fallback. beeper default and preferred." — and later the
// same day: "remove baileys completely"; it is GONE, not deprecated).
// beeper is the default; cdp must be chosen explicitly. A config still
// saying 'baileys' gets beeper + a loud notice rather than a dead bridge.
function resolveWaTransport(cfg = {}) {
  return cfg.transport === 'cdp' ? 'cdp' : 'beeper';
}
// dp(path) — display a filesystem path, converting to POSIX style when
// unix_paths:true is set in config. Useful in MSYS2 / WSL environments.
const dp = (p) => EGPT_CONFIG.unix_paths ? p.replace(/\\/g, '/') : p;

// clickable(displayText, absPath) — wrap a label in an OSC 8 hyperlink
// pointing at file://<absPath>. Modern terminals (Windows Terminal,
// iTerm2, GNOME Terminal, VS Code's integrated terminal) render the
// text underlined and open it in the OS default viewer on Ctrl/Cmd+click.
// Terminals that don't recognize OSC 8 silently strip the escape and
// display the plain text — no fallback handling needed. We always
// build the file URL from the native absolute path (forward slashes,
// drive letter preserved) regardless of how dp() formats the display.
const _OSC8 = ']8;;';
const _ST   = '';
const clickablePath = (displayText, absPath) => {
  if (!absPath) return displayText;
  let url;
  try { url = pathToFileURL(absPath).href; }
  catch { return displayText; }
  return `${_OSC8}${url}${_ST}${displayText}${_OSC8}${_ST}`;
};

// _isMetaMessage(body) — heuristic for "this transcript line is operator
// tooling, not conversation." /last filters these out so the scrollback
// reads like a chat history, not a noisy systems log. The conversation
// .md still records everything for forensics; this is purely a view
// filter. Keep persona/brain replies and file-save notes (those carry
// real content); drop slash command echoes, prior /last headers, bus /
// telegram / whatsapp lifecycle one-liners.
const _META_PATTERNS = [
  /^bus: peer (online|offline)/,
  /^telegram: (yielded|re-claimed|outbound|not running|disconnected|bridge stopped)/,
  /^whatsapp: (outbound|not running|disconnected|bridge stopped|configured but)/,
  /^exiting with code/,
  /^⛈ storm:/,
  /^\(no held messages\)/,
  /^\(no messages yet\)/,
  /^\(empty room\)/,
  /^--- last \d+/,
  /^default operator/,
  /^!! /,
];
function _isMetaMessage(body) {
  if (!body || typeof body !== 'string') return false;
  const text = body.trim();
  if (!text) return true;
  if (text.startsWith('/')) return true;          // slash command echo
  const firstLine = text.split('\n', 1)[0];
  return _META_PATTERNS.some(re => re.test(firstLine));
}

// show_prompts: when true, the full task/prompt text is printed to the shell
// before each operator turn. Toggle with /prompts on|off, or set in config.
let _showPrompts = EGPT_CONFIG.show_prompts ?? false;

// default operator session name — used when a command needs an operator and
// none is specified. Persisted to ~/.egpt/default-op.txt.
const DEFAULT_OP_FILE = join(EGPT_HOME, 'default-op.txt');
let _defaultOp = null;
try { _defaultOp = readFileSync(DEFAULT_OP_FILE, 'utf8').trim() || null; } catch (e) { swallow('default-op.read', e, { expect: ['ENOENT'] }); }

function persistDefaultOp(name) {
  try {
    mkdirSync(EGPT_HOME, { recursive: true });
    if (name) writeFileSync(DEFAULT_OP_FILE, name, 'utf8');
    else { try { unlinkSync(DEFAULT_OP_FILE); } catch (e) { swallow('default-op.clear', e, { expect: ['ENOENT'] }); } }
  } catch (e) { swallow('default-op.persist', e); }
}

// Return the operator session name to use for a command:
// 1. explicit (passed in) — always wins
// 2. _defaultOp if it's in the session map
// 3. the only operator session if there's exactly one
// Returns null (caller should prompt) if none found.
function resolveOperatorSession(explicit, sessions) {
  if (explicit) return explicit;
  const isOp = ([_, s]) => s.brain === 'ccode' || s.brain === 'codex';
  if (_defaultOp && sessions[_defaultOp] && isOp(['', sessions[_defaultOp]])) return _defaultOp;
  const ops = Object.entries(sessions).filter(isOp);
  return ops.length === 1 ? ops[0][0] : null;
}

const BRAINS = {
  [ccode.name]: ccode,
  [claudeSdk.name]: claudeSdk,
  [codex.name]: codex,
  [chatgptCdp.name]: chatgptCdp,
  [claudeCdp.name]:  claudeCdp,
  [llama.name]:      llama,
};

const DEFAULT_PERSONA_BRAIN = { type: 'codex', model: 'gpt-5.4-mini' };

function defaultPersonaBrainConfig(cfg) {
  const out = cfg && typeof cfg === 'object' ? { ...cfg } : { ...DEFAULT_PERSONA_BRAIN };
  out.type ??= DEFAULT_PERSONA_BRAIN.type;
  if (canonicalBrainName(out.type) === 'codex') out.model ??= DEFAULT_PERSONA_BRAIN.model;
  return out;
}

function latestDefaultBrainSessionForType(cfg, type) {
  const want = canonicalBrainName(type);
  for (const h of (cfg?.history ?? [])) {
    if (h?.id && canonicalBrainName(h.type) === want) return h.id;
  }
  return null;
}

function defaultPersonaFallbackConfig(primaryCfg) {
  if (EGPT_CONFIG.default_brain_fallback === false) return null;
  if (EGPT_CONFIG.default_brain_fallback && typeof EGPT_CONFIG.default_brain_fallback === 'object') {
    return defaultPersonaBrainConfig(EGPT_CONFIG.default_brain_fallback);
  }

  const primary = defaultPersonaBrainConfig(primaryCfg);
  const primaryType = canonicalBrainName(primary.type);
  if (primaryType === 'codex') {
    return {
      type: 'claude-sdk',
      model: 'haiku',
      cwd: primary.cwd ?? process.cwd(),
      allowed_tools: primary.allowed_tools ?? 'all',
      session_id: latestDefaultBrainSessionForType(primary, 'claude-sdk'),
    };
  }
  if (primaryType === 'claude-sdk' || primaryType === 'ccode') {
    return {
      type: 'codex',
      model: DEFAULT_PERSONA_BRAIN.model,
      cwd: primary.cwd ?? process.cwd(),
      allowed_tools: primary.allowed_tools ?? 'all',
      session_id: latestDefaultBrainSessionForType(primary, 'codex'),
    };
  }
  return null;
}

function isMissingResumeErrorText(text) {
  const msg = String(text ?? '');
  return /thread\/resume failed/i.test(msg)
    || /no rollout found for thread id/i.test(msg)
    || /no rollout found/i.test(msg)
    || /resume failed/i.test(msg);
}

const BRAIN_ALIASES = Object.fromEntries(
  Object.values(BRAINS).flatMap(brain => (brain.legacyNames ?? []).map(alias => [alias, brain.name])),
);

// Short, recognizable session-name prefixes per brain. Sessions are
// auto-named <prefix><N> where N grows to the first unused integer.
const BRAIN_PREFIX = {
  'chatgpt-cdp': 'cgpt',
  'claude-cdp':  'claude',
  'ccode':       'ccode',
  'claude-sdk':  'csdk',
  'codex':       'codex',
  'llama':       'l',
};

function canonicalBrainName(name) {
  return BRAIN_ALIASES[name] ?? name;
}

function brainForName(name) {
  return BRAINS[canonicalBrainName(name)];
}

function brainNamesForHelp() {
  const aliases = Object.entries(BRAIN_ALIASES).map(([alias, target]) => `${alias}->${target}`);
  return [...Object.keys(BRAINS), ...aliases];
}

function nextName(brainName, sessions) {
  brainName = canonicalBrainName(brainName);
  const prefix = BRAIN_PREFIX[brainName] ?? brainName;
  let n = 1;
  while (sessions[`${prefix}${n}`]) n++;
  return `${prefix}${n}`;
}

function resolveAddressedSession(token, sessions) {
  token = String(token ?? '').replace(/^@+/, '');
  if (sessions[token]) return token;
  const brainName = canonicalBrainName(token);
  if (!BRAINS[brainName]) return null;
  const matches = Object.entries(sessions).filter(([_, s]) => canonicalBrainName(s.brain) === brainName);
  return matches.length === 1 ? matches[0][0] : null;
}

const isInternalUrl = (u) =>
  u.startsWith('chrome://') || u.startsWith('chrome-extension://') ||
  u.startsWith('devtools://') || u.startsWith('about:');

function brainForUrl(url) {
  for (const b of Object.values(BRAINS)) {
    if (b.urlMatch && b.urlMatch.test(url)) return b.name;
  }
  return null;
}

// Read the first chunk of a Claude Code session JSONL and pull out:
//   - cwd: the working directory the session was started in (truth source for /session)
//   - preview: the first non-empty user text message (for human recognition)
// We read only ~64 KB so this stays fast even when scanning many sessions.
async function readJsonlMetadata(path) {
  let cwd = null;
  let preview = null;
  try {
    const handle = await open(path, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    await handle.close();
    const text = buf.slice(0, bytesRead).toString('utf8');
    // Quick regex: find any "cwd": "..." in the chunk
    const m = text.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m) cwd = m[1].replace(/\\\\/g, '\\').replace(/\\"/g, '"');
    // Walk lines for the first user text
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.type === 'user' && o.message?.role === 'user') {
        const c = o.message.content;
        let t = '';
        if (typeof c === 'string') t = c;
        else if (Array.isArray(c)) {
          t = c.filter(x => x.type === 'text').map(x => x.text).join(' ');
        }
        // Strip system-reminder / command-* tag blocks
        t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
             .replace(/<command-[^>]+>[\s\S]*?<\/command-[^>]+>/g, '')
             .replace(/<local-command-[^>]+>[\s\S]*?<\/local-command-[^>]+>/g, '')
             .trim();
        if (t) { preview = t.slice(0, 80); break; }
      }
    }
  } catch { /* unreadable, return what we have */ }
  return { cwd, preview };
}

// Summaries live in ~/.egpt/summaries/<name>.md as plain Markdown so they're
// vim-editable, grep-able, and portable. /save writes one. /summarize asks a
// brain to compose one. /inject drops one into the current room as a system
// note or sends it directly to one session. /summaries lists what's available.
const SUMMARIES_DIR = join(EGPT_HOME, 'summaries');
const BRAIN_STATE_DIR = join(EGPT_HOME, 'brain-state');
// Persistent Chrome user-data-dirs the shell controls. The 'brain' profile
// hosts the headed Chrome where you log into chatgpt.com / claude.ai; the
// shell launches it from /chrome with --remote-debugging-port=9221 and
// --load-extension=<repo>/extension/dist. Renamed from ~/.egpt/egpt-brain
// in 2026-05 so chrome/ groups all chrome-related state under one root,
// leaving room for chrome/profiles/extension/ etc. when the extension
// gets its own dedicated browser. The legacy path is still recognized
// for one-time auto-migration when Chrome isn't holding it open.
const CHROME_BRAIN_PROFILE        = join(EGPT_HOME, 'chrome', 'profiles', 'brain');
const LEGACY_CHROME_BRAIN_PROFILE = join(EGPT_HOME, 'egpt-brain');
const USER_BRAIN_PROFILE_DIR = join(EGPT_HOME, 'brains');
const PROJECT_BRAIN_PROFILE_DIR = join(process.cwd(), '.egpt', 'brains');
const REPO_BRAIN_PROFILE_DIR = join(APP_DIR, 'brains', 'type');
const BRAIN_PROFILE_DIRS = [
  { label: 'project', dir: PROJECT_BRAIN_PROFILE_DIR },
  { label: 'user', dir: USER_BRAIN_PROFILE_DIR },
  { label: 'repo', dir: REPO_BRAIN_PROFILE_DIR },
  { label: 'repo', dir: join(APP_DIR, 'brains', 'types') },
];

const PROFILE_TYPE_ALIASES = {
  code: 'ccode',
  ccode: 'ccode',
  'claude-code': 'ccode',
  codex: 'codex',
  cdp_chat: 'chatgpt-cdp',
  chat: 'chatgpt-cdp',
  chatgpt: 'chatgpt-cdp',
  'chatgpt-cdp': 'chatgpt-cdp',
  cdp_claude: 'claude-cdp',
  claude: 'claude-cdp',
  'claude-cdp': 'claude-cdp',
};

const CHATGPT_CONVERSATION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_PASTE_FILE_MAX_CHARS = 120_000;
const PREPARED_FILES_DIR = join(EGPT_HOME, 'prepared-files');

const PROFILE_CREATE_SCOPES = {
  user: USER_BRAIN_PROFILE_DIR,
  project: PROJECT_BRAIN_PROFILE_DIR,
  repo: REPO_BRAIN_PROFILE_DIR,
};

function isSafeName(name) {
  return /^[A-Za-z0-9._-]+$/.test(name) && name !== '.' && name !== '..';
}
function summaryPath(name) {
  return join(SUMMARIES_DIR, `${name}.md`);
}
async function ensureSummariesDir() {
  await mkdir(SUMMARIES_DIR, { recursive: true });
}

function canonicalProfileType(type) {
  const raw = String(type ?? '').trim();
  const key = raw.toLowerCase();
  return canonicalBrainName(PROFILE_TYPE_ALIASES[key] ?? key);
}

function statePathForProfile(profileName) {
  return join(BRAIN_STATE_DIR, `${profileName}.json`);
}

function profileDirsText() {
  return BRAIN_PROFILE_DIRS.map(d => `  ${d.dir}`).join('\n');
}

function profileCreateUsage() {
  return [
    'usage: /profile <name> <urlOrId> [--attach] [--force] [--user|--project|--repo]',
    '       /profile <urlOrId> <name> [--attach] [--force] [--user|--project|--repo]',
    '  bare ids become https://chatgpt.com/c/<id>',
    '  writes YAML to ~/.egpt/brains by default',
  ].join('\n');
}

function pasteFileUsage() {
  return [
    'usage: /paste-file <session> <path> [--before <marker>] [--after <marker>] [--from <marker>] [--to <marker>]',
    '       /paste-file <session> <path> [--ask <prompt>] [--max <chars>|--max 0]',
    '  quote paths or markers with spaces',
    '  example: /paste-file alex "C:\\path\\book.md" --before "# 8."',
  ].join('\n');
}

function sendFileUsage() {
  return [
    'usage: /send-file [via=<operator>] [<path>] @<session> ["<prep instruction>"] [--ask "<prompt>"] [--max <chars>|--all]',
    '  example: /send-file via=codex1 "C:\\path\\book.md" @cgpt1 "before chapter 8"',
    '  example: /send-file via=codex1 @cgpt1 "find the TPOEF book and send everything before chapter 8"',
    '  prepared shortcut: /send-file "C:\\Users\\an\\.egpt\\prepared-files\\..." @cgpt1',
    '  target @session must already be registered',
  ].join('\n');
}

function parseCommandWords(input) {
  const words = [];
  let cur = '';
  let quote = null;
  let hasToken = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = null;
      else {
        cur += ch;
        hasToken = true;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
    } else if (/\s/.test(ch)) {
      if (hasToken) {
        words.push(cur);
        cur = '';
        hasToken = false;
      }
    } else {
      cur += ch;
      hasToken = true;
    }
  }
  if (quote) throw new Error(`unterminated ${quote} quote`);
  if (hasToken) words.push(cur);
  return words;
}

function expandUserPath(path, base = process.cwd()) {
  let out = String(path ?? '').trim();
  if (!out) throw new Error('missing path');
  if (out === '~') out = homedir();
  else if (out.startsWith('~/') || out.startsWith('~\\')) out = join(homedir(), out.slice(2));
  return isAbsolute(out) ? resolve(out) : resolve(base, out);
}

function parsePositiveLimit(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid --max value: ${value}`);
  return n;
}

function safeFileSlug(value, fallback = 'file') {
  const s = String(value ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return s || fallback;
}

function isPathInsideDir(path, dir) {
  const rel = relative(resolve(dir), resolve(path));
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

function parsePasteFileArgs(arg) {
  const words = parseCommandWords(arg);
  if (words.length < 2) throw new Error(pasteFileUsage());
  const targetSpec = words.shift();
  const path = words.shift();
  const opts = {
    targetSpec,
    path,
    maxChars: DEFAULT_PASTE_FILE_MAX_CHARS,
  };

  while (words.length) {
    const key = words.shift();
    if (key === '--before' || key === '--after' || key === '--from' || key === '--to' || key === '--ask' || key === '--max') {
      if (!words.length) throw new Error(`${key} requires a value`);
      const value = words.shift();
      if (key === '--max') opts.maxChars = parsePositiveLimit(value, DEFAULT_PASTE_FILE_MAX_CHARS);
      else opts[key.slice(2)] = value;
    } else if (key === '--all') {
      opts.maxChars = 0;
    } else {
      throw new Error(`unknown option ${key}\n\n${pasteFileUsage()}`);
    }
  }

  return opts;
}

function parseSendFileArgs(arg) {
  const words = parseCommandWords(arg);
  if (!words.length) throw new Error(sendFileUsage());
  const opts = {
    viaSpec: null,
    maxChars: DEFAULT_PASTE_FILE_MAX_CHARS,
    maxProvided: false,
    ask: null,
  };

  const positional = [];
  while (words.length) {
    const token = words.shift();
    const viaMatch = token.match(/^\[?via=([A-Za-z0-9._-]+)\]?$/);
    if (viaMatch) {
      opts.viaSpec = viaMatch[1];
    } else if (token === '--via') {
      if (!words.length) throw new Error('--via requires a session name');
      opts.viaSpec = words.shift();
    } else if (token === '--ask') {
      if (!words.length) throw new Error('--ask requires a prompt');
      opts.ask = words.shift();
    } else if (token === '--max') {
      if (!words.length) throw new Error('--max requires a value');
      opts.maxChars = parsePositiveLimit(words.shift(), DEFAULT_PASTE_FILE_MAX_CHARS);
      opts.maxProvided = true;
    } else if (token === '--all') {
      opts.maxChars = 0;
      opts.maxProvided = true;
    } else if (token.startsWith('--')) {
      throw new Error(`unknown option ${token}\n\n${sendFileUsage()}`);
    } else {
      positional.push(token);
    }
  }

  const targetIndex = positional.findIndex(w => w.startsWith('@'));
  if (targetIndex < 0) throw new Error(`missing target @session\n\n${sendFileUsage()}`);
  let pathParts = positional.slice(0, targetIndex);
  if (['to', '[to]'].includes(pathParts[pathParts.length - 1]?.toLowerCase())) {
    pathParts = pathParts.slice(0, -1);
  }
  opts.path = pathParts.length ? pathParts.join(' ') : null;
  opts.targetName = positional[targetIndex].slice(1);
  const instructionParts = positional.slice(targetIndex + 1);
  opts.instructionProvided = instructionParts.some(part => part.trim());
  opts.instruction = instructionParts.join(' ').trim() || 'prepare the relevant excerpt';
  if (!opts.path && !opts.instructionProvided) {
    throw new Error(`missing source path or preparation instruction\n\n${sendFileUsage()}`);
  }
  return opts;
}

function markerIndexOrThrow(text, marker, startAt = 0, label = 'marker') {
  const idx = text.indexOf(marker, startAt);
  if (idx < 0) throw new Error(`${label} not found: ${marker}`);
  return idx;
}

function sliceTextByMarkers(text, options) {
  let start = 0;
  let end = text.length;
  const notes = [];

  if (options.after) {
    const idx = markerIndexOrThrow(text, options.after, 0, '--after');
    start = idx + options.after.length;
    notes.push(`after ${JSON.stringify(options.after)}`);
  }
  if (options.from) {
    const idx = markerIndexOrThrow(text, options.from, start, '--from');
    start = idx;
    notes.push(`from ${JSON.stringify(options.from)}`);
  }
  if (options.before) {
    const idx = markerIndexOrThrow(text, options.before, start, '--before');
    end = Math.min(end, idx);
    notes.push(`before ${JSON.stringify(options.before)}`);
  }
  if (options.to) {
    const idx = markerIndexOrThrow(text, options.to, start, '--to');
    end = Math.min(end, idx + options.to.length);
    notes.push(`to ${JSON.stringify(options.to)}`);
  }
  if (end < start) throw new Error('marker range is empty or inverted');

  return {
    text: text.slice(start, end),
    start,
    end,
    label: notes.length ? notes.join(', ') : 'whole file',
  };
}

async function readPasteFilePayload(options) {
  const path = expandUserPath(options.path);
  const original = await readFile(path, 'utf8');
  const sliced = sliceTextByMarkers(original, options);
  const maxChars = parsePositiveLimit(options.maxChars, DEFAULT_PASTE_FILE_MAX_CHARS);
  if (maxChars > 0 && sliced.text.length > maxChars) {
    throw new Error(
      `selected excerpt is ${sliced.text.length} chars, over --max ${maxChars}. ` +
      'Use a narrower marker range or --max 0 / --all to send it anyway.',
    );
  }
  return {
    path,
    originalChars: original.length,
    excerpt: sliced.text,
    start: sliced.start,
    end: sliced.end,
    rangeLabel: sliced.label,
  };
}

function buildPasteFileMessage(payload, options) {
  // Returns { message, ask } so CDP brains can paste content and type ask separately.
  return { message: payload.excerpt, ask: options.ask ?? null };
}

function defaultOperatorSession(sessions) {
  const matches = Object.entries(sessions)
    .filter(([_, s]) => ['codex', 'ccode'].includes(canonicalBrainName(s.brain)))
    .map(([name]) => name);
  return matches.length === 1 ? matches[0] : null;
}

function assertOperatorSession(name, sessions) {
  const session = sessions[name];
  if (!session) throw new Error(`no operator session named "${name}"`);
  const brainName = canonicalBrainName(session.brain);
  if (!['codex', 'ccode'].includes(brainName)) {
    throw new Error(`${name} is ${session.brain}; /send-file needs a local operator such as codex or ccode`);
  }
}

async function preparedFilePathFor(via, sourcePath) {
  await mkdir(PREPARED_FILES_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const sourceName = sourcePath
    ? safeFileSlug(basename(sourcePath), 'excerpt')
    : 'operator-selected-excerpt.md';
  return join(PREPARED_FILES_DIR, `${stamp}-${safeFileSlug(via)}-${sourceName}`);
}

function directPreparedPathFromSource(sourcePath) {
  if (!sourcePath) return null;
  const path = expandUserPath(sourcePath);
  return isPathInsideDir(path, PREPARED_FILES_DIR) ? path : null;
}

function quoteRoomArg(value) {
  const s = String(value);
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  return s;
}

function sendFilePrepVars({ sourcePath, preparedPath, targetName, instruction }) {
  return {
    target:       targetName,
    source_hint:  sourcePath ?? '(none provided; infer from the instruction, cwd, and nearby repo context)',
    instruction:  instruction,
    output_path:  preparedPath,
  };
}

async function findBrainProfilePath(name) {
  if (!isSafeName(name)) return null;
  for (const { label, dir } of BRAIN_PROFILE_DIRS) {
    for (const ext of ['yaml', 'yml']) {
      const path = join(dir, `${name}.${ext}`);
      try {
        const st = await stat(path);
        if (st.isFile()) return { path, label, dir };
      } catch { /* not here */ }
    }
  }
  return null;
}

async function loadBrainProfile(name) {
  const found = await findBrainProfilePath(name);
  if (!found) return null;

  let parsed;
  const raw = await readFile(found.path, 'utf8');
  try {
    parsed = YAML.parse(raw);
  } catch (e) {
    throw new Error(`${found.path}: ${e.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${found.path}: profile must be a YAML mapping`);
  }

  const profileName = String(parsed.name ?? name).trim();
  if (!isSafeName(profileName)) {
    throw new Error(`${found.path}: name must use letters, numbers, dot, dash, or underscore`);
  }
  const brainName = canonicalProfileType(parsed.type ?? parsed.brain);
  if (!brainForName(brainName)) {
    throw new Error(`${found.path}: unknown type "${parsed.type ?? parsed.brain ?? ''}"`);
  }

  return {
    ...parsed,
    name: profileName,
    brain: brainName,
    __path: found.path,
    __source: found.label,
  };
}

function looksLikeConversationUrlOrId(value) {
  const raw = String(value ?? '').trim();
  return /^https?:\/\//i.test(raw) ||
    CHATGPT_CONVERSATION_ID_RE.test(raw) ||
    /^\/?c\/[^/\s?#]+/i.test(raw);
}

function conversationProfileFromSpec(spec) {
  const raw = String(spec ?? '').trim();
  if (!raw) throw new Error('missing urlOrId');

  const bareId = raw.match(CHATGPT_CONVERSATION_ID_RE)?.[0];
  if (bareId) {
    return { type: 'cdp_chat', url: `https://chatgpt.com/c/${bareId}` };
  }

  const pathId = raw.match(/^\/?c\/([^/\s?#]+)/i)?.[1];
  if (pathId) {
    return { type: 'cdp_chat', url: `https://chatgpt.com/c/${pathId}` };
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`"${raw}" is not a full URL or ChatGPT conversation id`);
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'chatgpt.com' || host === 'chat.openai.com') {
    const id = url.pathname.match(/\/c\/([^/?#]+)/i)?.[1];
    return {
      type: 'cdp_chat',
      url: id ? `https://chatgpt.com/c/${id}` : url.href,
    };
  }
  if (host === 'claude.ai' || host.endsWith('.claude.ai')) {
    return { type: 'cdp_claude', url: url.href };
  }

  const brainName = brainForUrl(url.href);
  if (brainName === 'chatgpt-cdp') return { type: 'cdp_chat', url: url.href };
  if (brainName === 'claude-cdp') return { type: 'cdp_claude', url: url.href };
  throw new Error(`cannot infer brain type from URL host "${host}"`);
}

function parseProfileCreateArgs(arg) {
  const tokens = arg.split(/\s+/).filter(Boolean);
  const positional = [];
  let scope = 'user';
  let force = false;
  let attach = false;

  for (const token of tokens) {
    if (token === '--force') force = true;
    else if (token === '--attach') attach = true;
    else if (token === '--user') scope = 'user';
    else if (token === '--project') scope = 'project';
    else if (token === '--repo') scope = 'repo';
    else if (token.startsWith('--')) throw new Error(`unknown option ${token}`);
    else positional.push(token);
  }

  if (positional.length !== 2) throw new Error(profileCreateUsage());

  let name = positional[0];
  let spec = positional[1];
  if (looksLikeConversationUrlOrId(positional[0]) && isSafeName(positional[1])) {
    spec = positional[0];
    name = positional[1];
  }
  if (!isSafeName(name)) {
    throw new Error('profile name must use letters, numbers, dot, dash, or underscore');
  }

  return { name, spec, scope, force, attach };
}

async function writeConversationProfile({ name, spec, scope = 'user', force = false }) {
  const dir = PROFILE_CREATE_SCOPES[scope];
  if (!dir) throw new Error(`unknown profile scope "${scope}"`);
  const path = join(dir, `${name}.yaml`);
  const existing = await findBrainProfilePath(name);
  if (existing && !force) {
    throw new Error(`profile "${name}" already exists at ${existing.path}\n  use --force to overwrite or choose another name`);
  }
  if (existing && existing.path !== path) {
    throw new Error(`profile "${name}" resolves to ${existing.path}\n  ${path} would be shadowed; choose another name or scope`);
  }

  const profile = {
    name,
    ...conversationProfileFromSpec(spec),
  };
  await mkdir(dir, { recursive: true });
  await writeFile(path, YAML.stringify(profile, { lineWidth: 0 }));
  return { path, profile };
}

async function listBrainProfiles() {
  const seen = new Set();
  const out = [];
  for (const { label, dir } of BRAIN_PROFILE_DIRS) {
    let files = [];
    try { files = await readdir(dir); } catch { continue; }
    for (const file of files) {
      const m = file.match(/^(.+)\.ya?ml$/i);
      if (!m || !isSafeName(m[1]) || seen.has(m[1])) continue;
      seen.add(m[1]);
      try {
        const profile = await loadBrainProfile(m[1]);
        out.push({ name: profile.name, brain: profile.brain, path: profile.__path, source: label });
      } catch (e) {
        out.push({ name: m[1], brain: '(invalid)', path: join(dir, file), source: label, error: e.message });
      }
    }
  }
  return out;
}

function boolOpt(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function asStringArray(value) {
  if (value === undefined || value === null || value === false) return [];
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
  return [String(value).trim()].filter(Boolean);
}

function profileStartupSummaries(profile) {
  const startup = profile.startup && typeof profile.startup === 'object' ? profile.startup : {};
  const policy = String(profile.context_policy ?? profile.contextPolicy ?? 'summary').toLowerCase();
  if (['manual', 'none', 'off', 'false'].includes(policy)) return [];
  const names = [
    ...asStringArray(profile.summary),
    ...asStringArray(profile.summaries),
    ...asStringArray(profile.inject),
    ...asStringArray(startup.inject),
  ];
  return [...new Set(names)].filter(isSafeName);
}

async function readBrainProfileState(profileName) {
  if (!isSafeName(profileName)) return null;
  try {
    return JSON.parse(await readFile(statePathForProfile(profileName), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function writeBrainProfileState(sessionName, session) {
  const profileName = session?.options?.profileName;
  if (!profileName || !isSafeName(profileName)) return;
  await mkdir(BRAIN_STATE_DIR, { recursive: true });
  const body = {
    profile: profileName,
    session: sessionName,
    brain: session.brain,
    emoji: session.emoji ?? null,
    bio: session.bio ?? null,
    options: session.options ?? {},
    updatedAt: new Date().toISOString(),
  };
  await writeFile(statePathForProfile(profileName), JSON.stringify(body, null, 2) + '\n');
}

function optionFromPath(object, path) {
  let cur = object;
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

function profileOptions(profile, previousState = null) {
  const previous = previousState?.options && typeof previousState.options === 'object'
    ? previousState.options
    : {};
  const resumeNative = boolOpt(
    profile.resume_native ?? profile.resumeNative ?? profile.resume_thread ?? profile.resumeThread ?? profile.resume,
    false,
  );
  const options = {
    profileName: profile.name,
    profilePath: profile.__path,
  };

  const cwd = profile.cwd ?? optionFromPath(profile, ['operator', 'cwd']) ?? previous.cwd;
  if (cwd) options.cwd = String(cwd);
  const model = profile.model ?? optionFromPath(profile, [profile.brain, 'model']);
  if (model) options.model = String(model);
  const effort = profile.effort ?? profile.reasoningEffort ?? profile.reasoning_effort ??
    optionFromPath(profile, [profile.brain, 'effort']);
  if (effort) options.reasoningEffort = String(effort);
  else if (previous.reasoningEffort) options.reasoningEffort = previous.reasoningEffort;

  const explicitSessionId = profile.session_id ?? profile.sessionId ?? profile.thread_id ?? profile.threadId;
  if (explicitSessionId) options.sessionId = String(explicitSessionId);
  else if (resumeNative && previous.sessionId) options.sessionId = previous.sessionId;

  if (previous.previousCwd) options.previousCwd = previous.previousCwd;
  if (profile.log_path ?? profile.logPath) options.logPath = String(profile.log_path ?? profile.logPath);
  else if (previous.logPath) options.logPath = previous.logPath;

  return options;
}

// Find the JSONL for a given session ID *or prefix*. Returns { path, slug, sessionId }
// where sessionId is always the FULL UUID (the disk filename minus .jsonl), even if
// the caller passed a short prefix. Throws if a prefix matches multiple sessions.
async function findSessionJsonl(sessionIdOrPrefix) {
  const projectsDir = join(homedir(), '.claude', 'projects');
  let projects = [];
  try { projects = await readdir(projectsDir); } catch { return null; }

  // First pass: exact filename match (fast path for full UUIDs)
  for (const slug of projects) {
    const candidate = join(projectsDir, slug, `${sessionIdOrPrefix}.jsonl`);
    try {
      const st = await stat(candidate);
      if (st.isFile()) return { path: candidate, slug, sessionId: sessionIdOrPrefix };
    } catch { /* not in this project */ }
  }

  // Second pass: prefix match. Require ≥6 chars to avoid weird short collisions.
  if (sessionIdOrPrefix.length < 6) return null;
  const lower = sessionIdOrPrefix.toLowerCase();
  const matches = [];
  for (const slug of projects) {
    const dir = join(projectsDir, slug);
    let files = [];
    try { files = await readdir(dir); } catch { continue; }
    for (const f of files) {
      if (f.endsWith('.jsonl') && f.toLowerCase().startsWith(lower)) {
        matches.push({
          path: join(dir, f),
          slug,
          sessionId: f.slice(0, -'.jsonl'.length),
        });
      }
    }
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const ids = matches.map(m => m.sessionId).join(', ');
    throw new Error(`prefix "${sessionIdOrPrefix}" matches multiple sessions: ${ids}`);
  }
  return null;
}

// --headless: run the bridges + bus + room logging without mounting the
// Ink terminal UI. Designed for Windows Task Scheduler "Run whether user
// is logged on or not" / launchd / systemd --user — eGPT keeps capturing
// WhatsApp / Telegram traffic to disk while no operator is signed in.
// When a real shell starts later, it SIGTERMs the headless process via
// the pidfile handshake (~/.egpt/egpt.pid) and takes over the WA pairing
// — only one process at a time can hold baileys creds, so ownership
// transfers cleanly via signal + poll instead of a live socket attach.
const _rawCliArgs = process.argv.slice(2);
const HEADLESS = _rawCliArgs.includes('--headless');
// --client: run as a LIMB that attaches to a running spine over loopback TCP
// instead of being the engine. Full Ink UI, but it starts NONE of the engine
// subsystems (WA/TG bridges, control-plane bus, CDP, outbox/inbox, attach host)
// — input is forwarded to the spine, output is rendered from it, so a limb can
// never contend for the WhatsApp pairing. (Phase D; becomes the default once
// auto-detect — "attach if a spine exists, else become one" — lands.)
// Role: --client forces a limb; --spine/--engine (or --headless) forces the
// spine. With neither, the role is AUTO-DETECTED at boot (see spineIsLive() and
// the boot section below): attach as a limb if a live spine answers, else
// become the spine. `let` because auto-detect refines it before the App renders.
let CLIENT = _rawCliArgs.includes('--client');
const FORCE_SPINE = _rawCliArgs.includes('--spine') || _rawCliArgs.includes('--engine');
const cliArgs = _rawCliArgs.filter(a => !['--headless', '--client', '--spine', '--engine'].includes(a));
if (cliArgs[0] === 'profile' || cliArgs[0] === 'profile-url') {
  try {
    const spec = parseProfileCreateArgs(cliArgs.slice(1).join(' '));
    if (spec.attach) throw new Error('--attach only works inside the egpt room');
    const { path, profile } = await writeConversationProfile(spec);
    console.log(`profile "${profile.name}" saved -> ${path}`);
    console.log(`type: ${profile.type}`);
    console.log(`url: ${profile.url}`);
    console.log(`attach with: /attach ${profile.name}`);
    process.exit(0);
  } catch (e) {
    console.error(e.message.includes('usage: /profile') ? e.message.replaceAll('/profile', 'egpt profile') : `egpt profile: ${e.message}`);
    process.exit(2);
  }
}

const cliArg = cliArgs[0];
if (cliArg === '--help' || cliArg === '-h') {
  console.log(`usage: egpt [conversation.md]
       egpt profile <name> <urlOrId> [--force] [--user|--project|--repo]

Starts the egpt room using ./conversation.md by default.

Arguments:
  conversation.md   optional Markdown conversation file

Inside egpt:
  /help             show room commands
  /profiles         list YAML brain profiles
  /profile name url create a ChatGPT/Claude URL profile
  /attach <profile> start a configured brain profile
  /open <brain>     register a participant, e.g. /open ccode or /open codex
  @codex exec: pwd  run an operator command in the codex session cwd`);
  process.exit(0);
}
if (cliArgs.length > 1) {
  console.error('egpt: expected at most one conversation file');
  console.error('usage: egpt [conversation.md]');
  console.error('       egpt profile <name> <urlOrId>');
  process.exit(2);
}
if (cliArg?.startsWith('-')) {
  console.error(`egpt: unknown option ${cliArg}`);
  console.error('usage: egpt [conversation.md]');
  console.error('try: egpt --help');
  process.exit(2);
}

// FILE is mutable: /conversation <id> can switch the room to a different
// conversation file at runtime. All async handlers read FILE from this
// module-level binding, so a switch propagates immediately.
let FILE = cliArg ?? './conversation.md';

// Search dirs for `/conversations` (list) and `/conversation <name>` resolution.
// First match wins. ./conversations/ is the primary working dir.
const CONVERSATION_DIRS = [
  resolve(process.cwd(), 'conversations'),
  join(homedir(), 'conversations'),
];

async function listConversationFiles() {
  const out = [];
  const seen = new Set();
  // Top-level conversation.md in cwd is always shown if present.
  const topLevel = resolve(process.cwd(), 'conversation.md');
  try {
    const st = await stat(topLevel);
    if (st.isFile()) { out.push({ path: topLevel, label: 'cwd' }); seen.add(topLevel); }
  } catch {}
  // CONVERSATION_DIRS[0] = ./conversations (project-local)
  // CONVERSATION_DIRS[1] = ~/conversations (user-level)
  const dirLabels = ['./conversations', '~/conversations'];
  for (let i = 0; i < CONVERSATION_DIRS.length; i++) {
    const dir = CONVERSATION_DIRS[i];
    let entries = [];
    try { entries = await readdir(dir); } catch { continue; }
    for (const f of entries.sort()) {
      if (!f.endsWith('.md')) continue;
      const path = join(dir, f);
      if (seen.has(path)) continue;
      seen.add(path);
      out.push({ path, label: dirLabels[i] });
    }
  }
  return out;
}

function resolveConversationSpec(spec) {
  const raw = String(spec ?? '').trim();
  if (!raw) return null;
  // Absolute / ~ / explicit relative path
  if (isAbsolute(raw) || raw.startsWith('~') || raw.startsWith('./') || raw.startsWith('../') || raw.startsWith('.\\') || raw.startsWith('..\\')) {
    return expandUserPath(raw);
  }
  // Bare name: try `<name>.md` (or use as-is if it already ends in .md) in
  // each conversation dir, then cwd.
  const base = raw.endsWith('.md') ? raw : `${raw}.md`;
  for (const dir of CONVERSATION_DIRS) {
    const candidate = join(dir, base);
    if (existsSync(candidate)) return candidate;
  }
  const cwdCandidate = resolve(process.cwd(), base);
  if (existsSync(cwdCandidate)) return cwdCandidate;
  // Default: write into ./conversations/ if that exists, else cwd.
  if (existsSync(CONVERSATION_DIRS[0])) return join(CONVERSATION_DIRS[0], base);
  return cwdCandidate;
}

// preflight: warn if claude is missing but don't refuse to start. egpt is
// the room itself; CDP brains and most slash commands work without claude.
// Only invocations of the ccode brain (/open ccode or addressed
// turns) actually need the binary.
{
  const r = spawnSync('claude', ['--version'], { stdio: 'pipe' });
  if (r.error?.code === 'ENOENT') {
    console.error('warning: `claude` CLI not found on PATH.');
    console.error('  CDP brains work without it; install only if you want ccode.');
    console.error('    npm install -g @anthropic-ai/claude-code\n');
  }
}

if (!existsSync(FILE)) writeFileSync(FILE, `# Conversation\n\n---\n\n`);

const _pad2 = (n) => String(n).padStart(2, '0');
// Timezone label shown next to local-time stamps. Defaults to the system's
// short tz name (EST, EDT, GMT-5, etc.) via Intl. Override with config
// key `tz_label` for cities like "NYC", "MAD", "BEI" — distributed rooms
// where readers want to know the speaker's geography at a glance.
function tzLabel() {
  if (EGPT_CONFIG.tz_label) return String(EGPT_CONFIG.tz_label);
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(new Date());
    return parts.find(p => p.type === 'timeZoneName')?.value ?? '';
  } catch { return ''; }
}
const _stamp = (d) => {
  const tz = tzLabel();
  const base = `${d.getFullYear()}-${_pad2(d.getMonth()+1)}-${_pad2(d.getDate())} ${_pad2(d.getHours())}:${_pad2(d.getMinutes())}`;
  return tz ? `${base} ${tz}` : base;
};
// On-disk timestamp in conversation.md. Local time + tz label.
const ts = () => _stamp(new Date());
// Default-room transcript writer. Named rooms shadow this with a
// component-local `append` that targets ~/.egpt/rooms/<name>.md.
const append = (who, body) => appendFile(FILE, `## ${ts()} — ${who}\n${body}\n\n`);
// Sidecar path for reply-target persistence (per transcript file).
// Living next to the transcript keeps room↔sidecar coupling obvious
// and lets multiple rooms coexist without collision.
function _sidecarPath(transcriptFile) {
  return transcriptFile.replace(/\.md$/i, '') + '.replytargets.json';
}
async function _loadReplyTargets(transcriptFile) {
  try {
    const raw = await readFile(_sidecarPath(transcriptFile), 'utf8');
    const obj = JSON.parse(raw);
    return new Map(Object.entries(obj));
  } catch (e) { swallow('reply-targets.load', e, { expect: ['ENOENT'] }); return new Map(); }
}
async function _saveReplyTargets(transcriptFile, mapLike) {
  const obj = Object.fromEntries(mapLike);
  const path = _sidecarPath(transcriptFile);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2));
}
// FIFO queue for transcript writes so multiple fire-and-forget
// appends (from sysOut) can't race each other and land out of order.
let _transcriptQueue = Promise.resolve();
function queuedAppend(fn) {
  _transcriptQueue = _transcriptQueue.then(fn, () => fn());
  return _transcriptQueue;
}
const fmtTs = (ms) => _stamp(new Date(ms));

// ── Room persistence ───────────────────────────────────────────────────────
// One YAML file per room at ~/.egpt/rooms/<name>.yaml. Default room is
// the lobby — never persisted, never has brains.

// Rooms — shell-local channels analogous to WhatsApp groups, hence
// nested under conversations/ (operator 2026-05-22: "a room is
// basically same structure as a whatsapp group"). Migrate the legacy
// ~/.egpt/rooms/ on first boot.
const ROOMS_DIR = join(EGPT_HOME, 'conversations', '_rooms');
(function _migrateRoomsDir() {
  try {
    const old = join(EGPT_HOME, 'rooms');
    if (existsSync(old) && !existsSync(ROOMS_DIR)) {
      mkdirSync(dirname(ROOMS_DIR), { recursive: true });
      renameSync(old, ROOMS_DIR);
    }
  } catch (e) { /* best effort */ }
})();

// Normalise the on-disk session shape into the canonical nested form
// used in-memory. /save-room writes brain-specific fields FLAT at the
// top level (url, session_id, cwd, model, …); auto-save writes them
// NESTED under options. Either format may show up in a yaml. We
// always produce { brain, emoji, [bio], options: {...} } from here so
// the rest of the shell never has to think about it.
function normalizeSession(s) {
  if (!s || typeof s !== 'object') return null;
  if (s.options && typeof s.options === 'object') {
    return { ...s, options: { ...s.options } };
  }
  const options = {};
  if (s.url)         options.url         = s.url;
  if (s.targetId)    options.targetId    = s.targetId;
  if (s.session_id)  options.sessionId   = s.session_id;
  if (s.sessionId)   options.sessionId   = s.sessionId;
  if (s.cwd)         options.cwd         = s.cwd;
  if (s.model)       options.model       = s.model;
  if (s.effort)      options.effort      = s.effort;
  if (s.profile)     options.profileName = s.profile;
  if (s.profileName) options.profileName = s.profileName;
  return {
    brain: s.brain,
    ...(s.emoji ? { emoji: s.emoji } : {}),
    ...(s.bio ? { bio: s.bio } : {}),
    options,
  };
}

async function loadAllRooms() {
  const out = {};
  let files = [];
  try { files = (await readdir(ROOMS_DIR)).filter(f => f.endsWith('.yaml')); }
  catch { return out; }
  for (const f of files) {
    try {
      const text = await readFile(join(ROOMS_DIR, f), 'utf8');
      const parsed = YAML.parse(text) ?? {};
      const name = (parsed.name ?? f.replace(/\.yaml$/, '')).trim();
      if (name === 'default') continue;   // lobby is never persisted
      const sessions = {};
      for (const [sname, sval] of Object.entries(parsed.sessions ?? {})) {
        const norm = normalizeSession(sval);
        if (norm) sessions[sname] = norm;
      }
      out[name] = sessions;
    } catch (e) { console.error(`!! egpt.mjs:[catch] ${e?.message ?? e}`); /* skip malformed */ }
  }
  return out;
}

function configAddDirs(cfg) {
  return Array.isArray(cfg?.addDirs) ? cfg.addDirs
    : Array.isArray(cfg?.add_dirs) ? cfg.add_dirs
    : undefined;
}

async function saveRoomToDisk(name, sessionsMap) {
  if (name === 'default') return;
  await mkdir(ROOMS_DIR, { recursive: true });
  const data = { name, saved: new Date().toISOString(), sessions: sessionsMap ?? {} };
  await writeFile(join(ROOMS_DIR, `${sanitizeName(name)}.yaml`), YAML.stringify(data));
}

async function deleteRoomFile(name) {
  try { await unlink(join(ROOMS_DIR, `${sanitizeName(name)}.yaml`)); } catch (e) { console.error(`!! egpt.mjs:[catch] ${e?.message ?? e}`); }
}

// On-screen time only (HH:MM + short tz). Date is shown via day-change
// separators inserted into the rendered list, like a chat client.
const fmtTimeOnly = (ms) => {
  const d = new Date(ms);
  const tz = tzLabel();
  const hhmm = `${_pad2(d.getHours())}:${_pad2(d.getMinutes())}`;
  return tz ? `${hhmm} ${tz}` : hhmm;
};

// Day label for the separator row. "Today" / "Yesterday" / weekday + date.
function _dayLabel(d) {
  const dayKey = d.toDateString();
  const today = new Date().toDateString();
  if (dayKey === today) return 'Today';
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (dayKey === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
}

// Walk the items list and interleave separator items at day boundaries.
// Stable across renders (deterministic on `items`), so Ink's <Static>
// only emits the new tail on each call.
function withDaySeparators(items) {
  const out = [];
  let lastDay = null;
  for (const item of items) {
    const d = new Date(Math.floor(item.id));
    const dayKey = d.toDateString();
    if (dayKey !== lastDay) {
      out.push({ id: `day-${dayKey}`, _separator: true, body: _dayLabel(d) });
      lastDay = dayKey;
    }
    out.push(item);
  }
  return out;
}

// Resolve a user-typed tab spec to a chrome targetId.
// Accepts: full chrome targetId, targetId prefix (≥6 chars), full URL, partial URL, UUID inside URL.
async function resolveTabId(spec, brain = null) {
  const all = await cdp.listTabs();
  const norm = spec.trim();
  // exact URL
  let m = all.find(t => t.url === norm);
  if (m) return m.id;
  // URL contains the spec (catches UUIDs and partial URLs)
  m = all.find(t => t.url.includes(norm));
  if (m) return m.id;
  // exact targetId (case-insensitive)
  m = all.find(t => t.id.toLowerCase() === norm.toLowerCase());
  if (m) return m.id;
  // targetId prefix (e.g. the 8-char form shown in /tabs)
  if (norm.length >= 6) {
    m = all.find(t => t.id.toLowerCase().startsWith(norm.toLowerCase()));
    if (m) return m.id;
  }
  // brain-scoped fallback: if a brain was given and only one of its tabs is open
  if (brain?.urlMatch) {
    const candidates = all.filter(t => brain.urlMatch.test(t.url));
    if (candidates.length === 1) return candidates[0].id;
  }
  return null;
}

// User name as it appears to brains and across surfaces. Resolution
// order: EGPT_CONFIG.user_name (per-user / per-project config.json) →
// EGPT_USER_NAME env var → 'egptbot' default. Set user_name in your
// config to control the handle peers see.
// `let` so /config user_name <new> can update it at runtime without
// a shell restart. Initial value reads from config / env / default.
let USER_NAME = EGPT_CONFIG?.user_name ?? process.env.EGPT_USER_NAME ?? 'egptbot';

// Strip a leading '@' from a handle string. WhatsApp's pushName comes
// through as '@An' (we prepended @ in the bridge); Telegram usernames
// already include '@'; some unnamed senders are 'wa:<digits>'. Drop
// the lead so we don't render '@@An@wa' or similar in author tags.
const stripAt = (s) => (s ?? '').replace(/^@/, '');

// Build a display tag: handle[@client][.node].
// Rules:
//   * client absent → 'handle@node' (shell default — preserves the
//     longstanding 'An@kg' look).
//   * client present, same node as viewer → 'handle@client'
//     (e.g. 'An@wa' or 'An@moto' — node is implicit since we're
//     reading transcript at our local node).
//   * client present, different node → 'handle@client.node'
//     (e.g. 'An@ext.home' — peer node makes it explicit).
function formatHandleClientNode(handle, client, node, localNode) {
  const h = stripAt(handle);
  if (!client) return `${h}@${node ?? '?'}`;
  if (node && node !== localNode) return `${h}@${client}.${node}`;
  return `${h}@${client}`;
}
// Author-emoji defaults. Each is overridable via EGPT_CONFIG.emojis.{user, egpt, persona, human}
// (set per-user in ~/.egpt/config.json or per-project in .egpt/config.json).
// Resolved once at module load — change requires shell restart.
const USER_EMOJI         = EGPT_CONFIG?.emojis?.user    ?? '🦅';   // shell user (USER_NAME)
const EGPT_EMOJI         = EGPT_CONFIG?.emojis?.egpt    ?? '🧠';   // egpt system voice — status, hints, errors
const EGPT_PERSONA_EMOJI = EGPT_CONFIG?.emojis?.persona ?? '🐶';   // egpt persona reply voice — @egpt answers
const HUMAN_EMOJI        = EGPT_CONFIG?.emojis?.human   ?? '🌐';   // extension's default 'human' tag — distinct surface

// Identifier this shell uses on the CDP control-plane bus. PID makes it
// unique per process so two shells don't collide.
// User-friendly node name. Set EGPT_CONFIG.node_name (in
// ~/.egpt/config.json or .egpt/config.json) to something like 'home',
// 'work', 'shell1' and the room sees you under that name. Default is
// shell-<pid> when no name is configured. Collision risk is the user's
// responsibility — same room, same names mean same names on the bus.
//
// `let` (not const) so /config node_name can rename live: the handler
// posts node-offline under the old name, updates these, then posts
// node-online with the new one.
let BUS_NODE_ID = EGPT_CONFIG.node_name ?? `shell-${process.pid}`;
let SURFACE_TAG = BUS_NODE_ID;

// Visual avatars for sessions. Auto-assigned on session creation; users can
// rebind with /emoji <session> <new>. The palette runs ~20 distinct critters
// before recycling — collisions are visually noisy but not functional.
const EMOJI_PALETTE = ['🦊', '🐻', '🐯', '🐶', '🐱', '🦁', '🐮', '🐷', '🐸', '🐵',
                       '🦝', '🐲', '🐳', '🦅', '🦉', '🐝', '🐢', '🐙', '🦄', '🐺'];

function nextEmoji(sessions) {
  const used = new Set(Object.values(sessions).map(s => s.emoji).filter(Boolean));
  for (const e of EMOJI_PALETTE) if (!used.has(e)) return e;
  return EMOJI_PALETTE[Object.keys(sessions).length % EMOJI_PALETTE.length];
}

// HTML-safe version of arbitrary text for Telegram parse_mode='HTML'.
const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Convert Markdown to Telegram HTML (parse_mode: HTML).
// Strategy: HTML-escape the source first (so < > & become entities and are safe
// inside tags), then apply markdown patterns — the markdown characters * _ ` [ ]
// are not HTML-special so they survive the escaping untouched.
// Fenced code blocks are handled before inline patterns to avoid double-processing.
function mdToTgHtml(text) {
  const s = String(text ?? '');
  // Split on fenced code blocks so we don't mangle markdown-like chars inside them.
  const parts = s.split(/(```[\w]*\n?[\s\S]*?```)/g);
  return parts.map((part, i) => {
    if (i % 2 === 1) {
      const inner = part.replace(/^```[\w]*\n?/, '').replace(/```$/, '');
      return `<pre>${escapeHtml(inner.trim())}</pre>`;
    }
    let r = escapeHtml(part);
    r = r
      .replace(/\*\*([^*\n]+)\*\*/g,         '<b>$1</b>')
      .replace(/__([^_\n]+)__/g,              '<b>$1</b>')
      .replace(/\*([^*\n]+)\*/g,              '<i>$1</i>')
      .replace(/(?<!\w)_([^_\n]+)_(?!\w)/g,  '<i>$1</i>')
      .replace(/`([^`\n]+)`/g,               '<code>$1</code>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g,   '<a href="$2">$1</a>')
      .replace(/^#{1,6}\s+(.+)$/gm,          '<b>$1</b>');
    return r;
  }).join('');
}

// Pick an emoji for an item author when mirroring to a bridge.
//   'system'         → EGPT_EMOJI (egpt's status/hint voice)
//   'You'            → USER_EMOJI
//   'egpt' / 'egpt@*'→ EGPT_PERSONA_EMOJI (persona reply voice)
//   USER_NAME / USER_NAME@*  → USER_EMOJI (the user typing from any surface)
//   '<name>@<surf>'  → sessions[<name>].emoji  (strip the @suffix for lookup;
//                       sessions are keyed by bare name like 'cx', not 'cx@kg')
//   fallback         → ❓ (should be rare — only truly unknown peer authors)
// Resolved opts for the pure helper in author-emoji.mjs. Module-level so
// the lookup is constant-time and tests can exercise the helper with
// synthetic option sets without touching this file.
const _AUTHOR_EMOJI_OPTS = {
  user_name:     USER_NAME,
  user_emoji:    USER_EMOJI,
  egpt_emoji:    EGPT_EMOJI,
  persona_emoji: EGPT_PERSONA_EMOJI,
  human_emoji:   HUMAN_EMOJI,
};
function emojiForAuthor(author, sessions) {
  return _emojiForAuthor(author, sessions, _AUTHOR_EMOJI_OPTS);
}

// Render an item for the Telegram chat. Uses HTML parse_mode.
// System messages render italic; brain/session bodies get markdown rendered.
function formatItemForTelegram(item, sessions) {
  if (item.author === 'system') {
    if (item._tgBody) return item._tgBody;
    return `${EGPT_EMOJI} <b>egpt@${SURFACE_TAG}</b>\n<i>${escapeHtml(item.body)}</i>`;
  }
  if (item.author === 'You') return `${USER_EMOJI} <b>${escapeHtml(USER_NAME)}@${SURFACE_TAG}</b>\n${escapeHtml(item.body)}`;
  // Peer brain replies arrive with author already tagged ('codex1@shell-3232'
  // from the mention-reply dispatcher) — preserve that. Local sessions get
  // the local SURFACE_TAG appended.
  const tagged = item.author.includes('@') ? item.author : `${item.author}@${SURFACE_TAG}`;
  const emoji = emojiForAuthor(item.author, sessions);
  return `${emoji} <b>${escapeHtml(tagged)}</b>\n${mdToTgHtml(item.body)}`;
}

// Same shape, plain text. WhatsApp bodies don't support HTML so we
// just emit author + content separated by a newline.
//
// Header policy (whatsapp.mirror_headers in config):
//   'all'        — every item carries its 'handle@surface' header (default)
//   'brain_only' — only brain/persona/system items carry headers; messages
//                  authored by the user (You, peer-user tags like An@moto)
//                  go without — the WA recipient just sees the text, no
//                  device or bridge tell-tale. This is what most operators
//                  want for groups: brain replies are tagged for context,
//                  the user's own typing looks like a normal message
//                  regardless of where they sent it from.
//   'none'       — no headers at all
function isBrainAuthor(item, sessions) {
  if (item.author === 'system') return true;
  const bare = String(item.author ?? '').split('@')[0];
  if (bare === 'egpt' || bare === 'e') return true;
  if (sessions?.[bare]) return true;
  return false;
}
function formatItemForWhatsApp(item, sessions) {
  const headerPolicy = EGPT_CONFIG.whatsapp?.mirror_headers ?? 'all';
  const keepHeader = headerPolicy === 'all'
    || (headerPolicy === 'brain_only' && isBrainAuthor(item, sessions));
  if (!keepHeader) return item.body;
  if (item.author === 'system') return `${EGPT_EMOJI} egpt@${SURFACE_TAG}\n${item.body}`;
  if (item.author === 'You')    return `${USER_EMOJI} ${USER_NAME}@${SURFACE_TAG}\n${item.body}`;
  const tagged = item.author.includes('@') ? item.author : `${item.author}@${SURFACE_TAG}`;
  const emoji = emojiForAuthor(item.author, sessions);
  return `${emoji} ${tagged}\n${item.body}`;
}

// Parse messages.md back into objects (for /last).
function parseMessages(text) {
  const out = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const m = line.match(/^## (\S.*?) — (.+)$/);
    if (m) {
      if (cur) out.push({ ...cur, body: cur.body.replace(/\n+$/, '') });
      cur = { ts: m[1], author: m[2], body: '' };
    } else if (cur) {
      cur.body += line + '\n';
    }
  }
  if (cur) out.push({ ...cur, body: cur.body.replace(/\n+$/, '') });
  return out;
}

// Persistent input history — the up-arrow recall ring. Per-room file
// at ~/.egpt/history/<room>.json. Rooms scope sessions, brain context
// and transcripts already, so the up-arrow recall stays inside the
// room the operator is currently in (a quick "@e qué tal" up-arrow
// in room A doesn't surface a /upgrade typed in room B).
//
// 500-entry cap per room is mostly belt-and-suspenders — keeps the
// disk footprint bounded (~100KB worst case per room) without ever
// biting in practice since recall almost never reaches past 50.
// Writes are tiny so we don't bother debouncing. Concurrent shells
// in the same room last-write-wins each other's submissions; that's
// acceptable for the typical one-shell-per-room setup.
// Shell input history per room (operator 2026-05-22 declutter — moved
// into state/ since the operator never edits these directly). Migrate
// the old root-level history/ on first boot.
const HISTORY_DIR = join(EGPT_HOME, 'state', 'history');
(function _migrateHistoryDir() {
  try {
    const old = join(EGPT_HOME, 'history');
    if (existsSync(old) && !existsSync(HISTORY_DIR)) {
      mkdirSync(dirname(HISTORY_DIR), { recursive: true });
      renameSync(old, HISTORY_DIR);
    }
  } catch (e) { /* best effort */ }
})();
const HISTORY_CAP = 500;
function _historyPath(roomName) {
  const safe = (roomName || 'default').replace(/[^A-Za-z0-9._-]/g, '_');
  return join(HISTORY_DIR, `${safe}.json`);
}
// One-shot migration: the brief global-history window (commit 4901b74)
// wrote ~/.egpt/input-history.json before the per-room layout shipped.
// If that file is still on disk when the default room loads, fold it
// into history/default.json so the operator doesn't lose the hour's
// worth of recalls. Idempotent (deletes the source after the merge).
function _migrateLegacyHistory() {
  try {
    const legacy = join(EGPT_HOME, 'input-history.json');
    if (!existsSync(legacy)) return;
    const raw = readFileSync(legacy, 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length) {
      const dest = _historyPath('default');
      if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });
      const existing = existsSync(dest)
        ? JSON.parse(readFileSync(dest, 'utf8'))
        : [];
      const merged = [...existing, ...arr].filter(s => typeof s === 'string');
      const trimmed = merged.length > HISTORY_CAP ? merged.slice(-HISTORY_CAP) : merged;
      writeFileSync(dest, JSON.stringify(trimmed), { mode: 0o600 });
    }
    unlinkSync(legacy);
  } catch (e) { swallow('history.migrate', e, { expect: ['ENOENT'] }); }
}
_migrateLegacyHistory();

function _loadInputHistory(roomName) {
  try {
    const p = _historyPath(roomName);
    if (!existsSync(p)) return [];
    const raw = readFileSync(p, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(s => typeof s === 'string') : [];
  } catch (e) { swallow('history.load', e, { expect: ['ENOENT'] }); return []; }
}
function _saveInputHistory(roomName, arr) {
  try {
    if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });
    const trimmed = arr.length > HISTORY_CAP ? arr.slice(-HISTORY_CAP) : arr;
    writeFileSync(_historyPath(roomName), JSON.stringify(trimmed), { mode: 0o600 });
  } catch (e) { swallow('history.save', e); }
}

// --- multi-line input ---
function MultiLineInput({ onSubmit, currentRoom }) {
  const [lines, setLines] = useState(['']);
  const [r, setR] = useState(0);
  const [c, setC] = useState(0);
  // input history: list of submitted entries; hIdx counts from 0=now, +N=N steps back.
  // Lazy initializer reads the current room's persisted file once on
  // mount; useEffect below swaps history when the operator switches
  // rooms so up-arrow recall scopes to the room they're in.
  const [history, setHistory] = useState(() => _loadInputHistory(currentRoom));
  const [hIdx, setHIdx] = useState(0);
  useEffect(() => {
    setHistory(_loadInputHistory(currentRoom));
    setHIdx(0);
  }, [currentRoom]);

  const loadEntry = (text) => {
    const lns = text.split('\n');
    setLines(lns);
    setR(lns.length - 1);
    setC(lns[lns.length - 1].length);
  };

  // Draft snapshot: when the operator starts typing then up-arrows into
  // history, the in-progress text used to vanish — down-arrowing back
  // to hIdx=0 reset to an empty input. We now save the draft on the
  // first up-arrow leaving hIdx=0, and restore it when returning. The
  // ref is cleared on submit (Ctrl+D) since the draft is no longer
  // "in progress" at that point.
  const draftRef = useRef(null);
  const recall = (delta) => {
    const newIdx = hIdx + delta;
    if (newIdx < 0 || newIdx > history.length) return;
    // Snapshot the draft on the first step out of hIdx=0 so the round
    // trip back returns the operator to exactly what they were typing.
    if (hIdx === 0 && newIdx > 0) {
      draftRef.current = lines.join('\n');
    }
    setHIdx(newIdx);
    if (newIdx === 0) {
      if (draftRef.current != null) {
        loadEntry(draftRef.current);
        draftRef.current = null;
      } else {
        setLines(['']); setR(0); setC(0);
      }
    } else {
      loadEntry(history[history.length - newIdx]);
    }
  };

  // Ink 7 surfaces key.home / key.end / key.pageUp / key.pageDown as
  // first-class flags AND fires key.ctrl + key.leftArrow/rightArrow
  // for Ctrl+Arrow, so every special-key dispatch we used to do
  // through a parallel stdin listener now lives inside useInput
  // below. The old internal_eventEmitter listener was carrying our
  // Ink 5 workaround for non-alphanumeric keys (input='' there,
  // raw chunk needed to recover the sequence); it's gone in this
  // branch.

  useInput((input, key) => {
    if (key.ctrl && input === 'd') {
      const text = lines.join('\n');
      if (text.trim()) {
        // Append + persist. closure-captured `history` is the current
        // render's value; useInput re-binds each render so it's not
        // stale at submit time. Cap inline so the in-memory state and
        // the saved file stay in lockstep.
        const next = [...history, text];
        const capped = next.length > HISTORY_CAP ? next.slice(-HISTORY_CAP) : next;
        setHistory(capped);
        _saveInputHistory(currentRoom, capped);
      }
      // Submitting clears the draft snapshot — the in-progress text
      // just became "submitted" and recall(-1) back to hIdx=0 should
      // land on a fresh empty line, not the just-sent message.
      draftRef.current = null;
      setHIdx(0); setLines(['']); setR(0); setC(0);
      onSubmit(text); return;
    }
    if (key.return) {
      const next = [...lines]; const tail = next[r].slice(c);
      next[r] = next[r].slice(0, c); next.splice(r + 1, 0, tail);
      setLines(next); setR(r + 1); setC(0); return;
    }
    if (key.backspace || key.delete) {
      const next = [...lines];
      if (c > 0) { next[r] = next[r].slice(0, c - 1) + next[r].slice(c); setLines(next); setC(c - 1); }
      else if (r > 0) {
        const pl = next[r - 1].length;
        next[r - 1] += next[r]; next.splice(r, 1);
        setLines(next); setR(r - 1); setC(pl);
      }
      return;
    }
    if (key.upArrow) {
      if (r > 0) { const nr = r - 1; setR(nr); setC(Math.min(c, lines[nr].length)); }
      else recall(+1); // older
      return;
    }
    if (key.downArrow) {
      if (r < lines.length - 1) { const nr = r + 1; setR(nr); setC(Math.min(c, lines[nr].length)); }
      else recall(-1); // newer (or back to now)
      return;
    }
    // Ctrl+Left / Ctrl+Right — word-wise motion within the current row.
    // Branches above plain leftArrow / rightArrow so ctrl+arrow doesn't
    // first slip into the single-char move. Doesn't cross row
    // boundaries — "fix this line" intent, not bash-readline behavior.
    // Standard "skip whitespace then skip word" semantics. Ink 7 sets
    // both key.leftArrow + key.ctrl on Ctrl+Left, so the native flags
    // drive the dispatch — the raw-chunk fallback we used to keep is
    // gone.
    if (key.ctrl && key.leftArrow) {
      const cur = lines[r] ?? '';
      let i = c;
      while (i > 0 && /\s/.test(cur[i - 1])) i--;
      while (i > 0 && !/\s/.test(cur[i - 1])) i--;
      setC(i);
      return;
    }
    if (key.ctrl && key.rightArrow) {
      const cur = lines[r] ?? '';
      let i = c;
      while (i < cur.length && !/\s/.test(cur[i])) i++;
      while (i < cur.length && /\s/.test(cur[i])) i++;
      setC(i);
      return;
    }
    if (key.leftArrow) {
      if (c > 0) setC(c - 1);
      else if (r > 0) { setR(r - 1); setC(lines[r - 1].length); }
      return;
    }
    if (key.rightArrow) {
      if (c < lines[r].length) setC(c + 1);
      else if (r < lines.length - 1) { setR(r + 1); setC(0); }
      return;
    }
    if (key.ctrl && input === 'a') { setC(0); return; }
    if (key.ctrl && input === 'e') { setC(lines[r].length); return; }
    // Home / End. Different terminals surface these differently:
    //   - Ink may parse and expose key.home / key.end (Windows
    //     Terminal often, modern xterm sometimes).
    //   - Or the raw escape sequence arrives in `input`:
    //       \x1b[H / \x1b[F    xterm CSI
    //       \x1b[1~ / \x1b[4~  Linux console / urxvt
    //       \x1b[7~ / \x1b[8~  rxvt / putty
    //       \x1bOH / \x1bOF    VT100 application mode
    // Ctrl+Home / Ctrl+End jump to start / end of the multi-line input.
    if (key.home || input === '\x1b[H' || input === '\x1b[1~' || input === '\x1b[7~' || input === '\x1bOH') {
      if (key.ctrl) { setR(0); setC(0); }
      else setC(0);
      return;
    }
    if (key.end || input === '\x1b[F' || input === '\x1b[4~' || input === '\x1b[8~' || input === '\x1bOF') {
      if (key.ctrl) { setR(lines.length - 1); setC(lines[lines.length - 1].length); }
      else setC(lines[r].length);
      return;
    }
    if (input === '\x1b[1;5H') { setR(0); setC(0); return; }
    if (input === '\x1b[1;5F') { setR(lines.length - 1); setC(lines[lines.length - 1].length); return; }
    if (input && !key.ctrl && !key.meta) {
      const next = [...lines];
      // Multi-line paste: split on \n, splice into the lines array, set cursor
      // to the end of the last pasted line. Without this, an embedded \n would
      // render weirdly inside a single Ink Text component.
      if (input.includes('\n') || input.includes('\r')) {
        const chunks = input.replace(/\r\n?/g, '\n').split('\n');
        const before = next[r].slice(0, c);
        const after = next[r].slice(c);
        next[r] = before + chunks[0];
        for (let i = 1; i < chunks.length; i++) {
          next.splice(r + i, 0, chunks[i]);
        }
        const last = r + chunks.length - 1;
        next[last] += after;
        setLines(next);
        setR(last);
        setC(chunks[chunks.length - 1].length);
      } else {
        next[r] = next[r].slice(0, c) + input + next[r].slice(c);
        setLines(next); setC(c + input.length);
      }
    }
  });

  return h(Box, { flexDirection: 'column' },
    lines.map((line, i) => {
      const pre = i === 0 ? '› ' : '  ';
      if (i !== r) return h(Text, { key: i }, pre + line);
      const onChar = c < line.length;
      const at = onChar ? line[c] : ' ';
      return h(Text, { key: i },
        pre + line.slice(0, c),
        h(Text, { inverse: true }, at),
        onChar ? line.slice(c + 1) : '');
    }));
}

// Stable id alphabet — no 1/l/I/0/O ambiguity in case the operator
// has to type one. Short random ids for non-bridge items.
const _STABLE_ALPHA = 'abcdefghijkmnpqrstuvwxyz23456789';
function _randStableSuffix() {
  let s = '';
  for (let i = 0; i < 6; i++) s += _STABLE_ALPHA[Math.floor(Math.random() * _STABLE_ALPHA.length)];
  return s;
}
// Stable id assignment for an item: prefer bridge-given id (WA stanza
// id, TG chat+msg pair) when available — those survive across
// restarts because the underlying wire id doesn't change. Fall back
// to '<kind>-<random6>' by author kind. Used by '@<stable-id> body'
// for cross-restart replies via the persisted sidecar.
function _stableIdForItem(item, sessions) {
  if (item._stableId) return item._stableId;
  // Already-known bridge keys (set on bridge-arrived echo or after a
  // /use direct-send / /mirror succeeded).
  if (item._replyTarget) {
    const rt = Array.isArray(item._replyTarget) ? item._replyTarget[0] : item._replyTarget;
    if (rt?.kind === 'wa' && rt.key?.id) return `wa-${rt.key.id}`;
    if (rt?.kind === 'tg' && rt.msgId)   return `tg-${rt.chatId}-${rt.msgId}`;
  }
  if (item.author === 'system') return `s-${_randStableSuffix()}`;
  if (item.author === 'You')    return `u-${_randStableSuffix()}`;
  const bare = String(item.author ?? '').split('@')[0];
  if (sessions?.[bare]) return `b-${_randStableSuffix()}`;
  return `p-${_randStableSuffix()}`;
}

// --- main app ---
function App() {
  const [items, setItems] = useState([]);
  // Render every item the engine output channel emits (Phase B). The flow is
  // pushItem(x) → outputChannel.emit(x) → this subscriber → setItems append.
  // This is the sole render sink; Phase D adds attached-client subscribers
  // alongside it. subscribe() returns its unsubscribe, used as effect cleanup.
  // NB: uses prev.concat (not [...prev, item]) so it is NOT itself a
  // "setItems append" — pushItem must never feed back into pushItem.
  useEffect(() => outputChannel.subscribe(item => setItems(prev => prev.concat(item))), []);
  const [streaming, setStreaming] = useState(null);
  const [busy, setBusy] = useState(false);
  // Custom spinner label per operation; defaults to 'thinking…' for
  // brain turns. Set alongside setBusy(true), cleared in the finally.
  const [busyLabel, setBusyLabel] = useState(null);
  const [error, setError] = useState(null);
  // Short message ids — 'm<N>' assigned to each visible item in
  // insertion order. Lets the operator type '@m42 <body>' to reply
  // to a specific message and route through the originating bridge.
  // Per-session: counter resets on shell restart.
  const _shortIdCounter = useRef(0);
  const shortIdByItemId = useRef(new Map());
  const itemByShortId = useRef(new Map());
  // Stable ids — survive restart. Bridge-derived (wa-<key>, tg-<chat>-<msg>)
  // when an item has bridge provenance, random short otherwise (b-<rnd>,
  // u-<rnd>, s-<rnd>, p-<rnd> by author kind). Displayed alongside [m<N>]
  // so the operator can read it off any message and use '@<stable-id>'
  // later (including after a restart, where m-ids start over but the
  // stable id was persisted in the sidecar map below).
  const stableIdByItemId = useRef(new Map());
  const itemByStableId = useRef(new Map());
  // Persisted reply-target map (loaded from sidecar on mount). Keyed
  // by stableId. '@<stable-id> body' falls back to this when the
  // referenced item is no longer in the in-memory items array (e.g.
  // post-restart).
  const persistedReplyTargets = useRef(new Map());
  // auto_e_chats per-chat busy/queue state. Keyed by chatId (WA JID).
  // Each entry: { inFlight: boolean, queue: [{body, senderName, ts}] }.
  // While e is mid-turn for a chat in auto_e_chats, additional arrivals
  // pile in `queue`; on turn-completion the pile drains as one combined
  // dispatch formatted "<name>: <body> [HH:MM]" per line, so e can issue
  // a joint reply. See [[project-egpt-auto-e-chats]] semantics.
  const _personaChatQueues = useRef(new Map());
  // Per (being, chat) coalescing queue for the META dispatch path (@l and any
  // other resident sibling). Mirrors the persona queue above, but @l is the
  // one that actually needs it: it's slow (local CPU inference, one slot), so
  // firing one inference per group message buries it under a backlog. While @l
  // is mid-turn for a chat, further arrivals pile here and drain as ONE
  // combined turn — the model processes the whole burst in its next run.
  // @l is no longer sessionless (conversation-L is injected each turn), so it
  // belongs on the same backpressure as @e. Keyed `${being}\0${chatId}` so
  // each resident has an independent queue per chat.
  // @l runs on ONE local server with ONE inference slot, so every @l turn is
  // serialized GLOBALLY (one at a time, across every chat). Each chat keeps its
  // own pile of messages that arrived while @l was busy; when @l frees it ships
  // the OLDEST-waiting chat's WHOLE pile as one combined, STATELESS turn. @l
  // carries no history: a turn is persona + that pile only. Voice notes are
  // transcribed upstream before a message reaches a pile, so a pile never holds
  // a raw [voice note].
  const _llamaBusy  = useRef(false);            // is an @l inference in flight?
  const _llamaPiles = useRef(new Map());        // chatId -> [{body, senderName, ts}]
  const _isLlamaBeing = (being) => {
    const t = String((EGPT_CONFIG.siblings ?? {})[String(being).toLowerCase()]?.type ?? '').toLowerCase();
    return t === 'llama' || t === 'llamacpp' || t === 'llama-cpp' || t === 'local';
  };
  // Gate an @l turn. Returns true if the message was PILED (caller must return),
  // false to run it now. Only @l (the single local slot) is gated; other meta
  // beings (engineers) run inline. Piling is per-chat, so each chat coalesces
  // its own burst.
  const _llamaGate = (being, meta, body) => {
    if (!_isLlamaBeing(being) || !meta.waChatId) return false;
    if (!_llamaBusy.current) logOut(`@${being} gate ${meta.waChatId}: CLAIM (replyAllowed=${meta.replyAllowed})`);
    if (_llamaBusy.current) {
      const pile = _llamaPiles.current.get(meta.waChatId) ?? [];
      pile.push({ body, senderName: meta.waSenderName ?? 'someone', ts: Date.now() });
      _llamaPiles.current.set(meta.waChatId, pile);
      logOut(`@l: server busy, piling ${meta.waChatId} (pile=${pile.length})`);
      return true;
    }
    _llamaBusy.current = true;                   // claim the slot (sync, no await before this)
    return false;
  };
  // Free the slot and ship the next chat's whole pile (oldest pending message
  // first, so no chat starves) as ONE combined, stateless turn via forceTarget
  // + _personaBodyOverride. Fire-and-forget; cascades as each turn ends until
  // all piles drain.
  const _llamaReleaseAndDrain = (being, meta) => {
    if (!_isLlamaBeing(being)) return;           // engineer turn never claimed the slot
    _llamaBusy.current = false;
    let nextChat = null, oldest = Infinity;
    for (const [cid, pile] of _llamaPiles.current) {
      if (pile.length && pile[0].ts < oldest) { oldest = pile[0].ts; nextChat = cid; }
    }
    if (nextChat === null) return;               // nothing waiting
    const pile = _llamaPiles.current.get(nextChat);
    _llamaPiles.current.delete(nextChat);
    if (!submitRef.current) return;
    const surface = buildWaSurfaceTag(nextChat);
    const idStr = String(nextChat);
    const chatType = idStr.endsWith('@g.us') ? 'group'
      : idStr === 'status@broadcast' ? 'status' : 'private';
    const chatName = waBridgeRef.current?.getChatName?.(nextChat) ?? null;
    const fullPrompt = pile.map(it => formatAutoDispatchLine({
      senderName: it.senderName, body: it.body, ts: it.ts, surface, chatType, chatName,
    })).join('\n');
    submitRef.current(`@${being} (pile)`, {
      fromWhatsApp: true,
      waChatId: nextChat,
      waSenderName: 'multiple',
      autoDispatched: true,
      forceTarget: being,
      // ADDRESSED: a pile only ever holds messages that were dispatched to @l,
      // and @l is dispatched ONLY when explicitly @-mentioned (there are no
      // configured residents). The ORIGINAL dispatch carried replyAllowed:true
      // (egpt.mjs ~3998); the drain MUST carry it too. Without it the drained
      // turn has replyAllowed:undefined, so _dropResident → _eMayReplyToChat in
      // 'mention' mode → autoMayEmit('mention',{replyAllowed:false}) → DROP: @l
      // runs the inference then stays SILENT. This is the "@l silent in bursty
      // groups" bug — a group's burst makes @l busy → pile → drop. (2026-06-11)
      replyAllowed: true,
      _personaBodyOverride: fullPrompt,
    }).catch(e => errOut(`!! @l pile drain failed (${nextChat}): ${e.message}`));
  };
  // 'accum' mode: instead of invoking E per burst, buffer a chat's messages and
  // flush them as ONE combined turn on the heartbeat. Cheaper than 'mention'
  // (≤1 invocation per chat per heartbeat). Reply only if the batch was
  // mentioned (mention semantics), carrying the accumulated context.
  const _accumBuffers = useRef(new Map());   // chatId -> { msgs:[{body,senderName,ts}], mentioned, meta }
  const _accumPush = (chatId, msg, status, baseMeta) => {
    let b = _accumBuffers.current.get(chatId);
    if (!b) { b = { msgs: [], mentioned: false, meta: null }; _accumBuffers.current.set(chatId, b); }
    b.msgs.push(msg);
    b.mentioned = b.mentioned || !!status.atEAnywhere || !!status.replyToBot;
    b.meta = baseMeta;   // last sample — enough for the flush dispatch (waChatId etc.)
    logOut(`@e accum: buffered ${chatId} (n=${b.msgs.length}${b.mentioned ? ', mentioned' : ''})`);
  };
  // Flush all accum buffers (called by the heartbeat). One combined turn per
  // chat with pending messages; replyAllowed = whether the batch was mentioned.
  const _accumFlush = () => {
    if (!submitRef.current) return;
    for (const [chatId, b] of [..._accumBuffers.current.entries()]) {
      if (!b.msgs.length) continue;
      _accumBuffers.current.delete(chatId);
      const surface = buildWaSurfaceTag(chatId);
      const idStr = String(chatId);
      const chatType = idStr.endsWith('@g.us') ? 'group'
        : idStr === 'status@broadcast' ? 'status' : 'private';
      const chatName = waBridgeRef.current?.getChatName?.(chatId) ?? null;
      const fullPrompt = b.msgs.map(it => formatAutoDispatchLine({
        senderName: it.senderName, body: it.body, ts: it.ts, surface, chatType, chatName,
      })).join('\n');
      const residents = conversationsState.normalizeResidents(EGPT_CONFIG.whatsapp?.residents_per_chat?.[chatId]);
      const globalRes = conversationsState.normalizeResidents(EGPT_CONFIG.whatsapp?.residents);
      const beings = residents.length ? residents : (globalRes.length ? globalRes : [EGPT_CONFIG.persona ?? 'e']);
      for (const being of beings) {
        submitRef.current(`@${being} (accum flush)`, {
          fromWhatsApp: true,
          waChatId: chatId,
          waUser: b.meta?.waUser,
          waClientLabel: b.meta?.waClientLabel,
          waSenderName: 'multiple',
          replyAllowed: b.mentioned,        // mention semantics over the batch
          autoDispatched: true,
          forceTarget: being,
          _chainDepth: 0,
          _personaBodyOverride: fullPrompt,
        }).catch(e => errOut(`!! @e accum flush failed (${chatId}): ${e.message}`));
      }
    }
  };
  // ── Backlog catch-up accumulator (operator 2026-06-04 "as-if always on") ──
  // Messages that arrived while we were offline (sleep / restart) are tagged
  // backlog:true by the bridge. Rather than a brain dispatch per stale message,
  // we buffer them per chat and feed E ONE consolidated, timestamped turn —
  // prefixed with a "resumed after Nh offline" hint so E knows it's catch-up and
  // can be sensible about stale items. Reply is mode-gated EXACTLY like live
  // (replyAllowed OR'd across the batch — if any message warranted a reply under
  // the chat's mode, E may reply once to the whole chunk).
  //
  // The flush is driven by the bridge's onBacklogDelivered signal (fired after
  // it finishes processing an offline-backlog upsert batch) — NOT a timer. There
  // is nothing to wait for: baileys hands the offline queue over in a delivery,
  // and the reconnect is now clean (single-socket), so the old fragmented-across-
  // reconnects delivery that motivated a debounce no longer happens. No hold of
  // our own either: the bridge's transcription hold and the engine's brain-busy
  // hold (acquireStayAwake while `busy`) cover the burst, and the 30s stay-awake
  // release-linger cushions the handoff + leaves a grace window for any
  // follow-up after the catch-up posts (operator 2026-06-04).
  const _backlogBuffers = useRef(new Map());   // chatId -> { msgs:[{body,senderName,ts}], replyAllowed, meta, firstTs }
  const _backlogFlush = () => {
    if (!submitRef.current) return;
    for (const [chatId, b] of [..._backlogBuffers.current.entries()]) {
      _backlogBuffers.current.delete(chatId);
      if (!b.msgs.length) continue;
      const surface = buildWaSurfaceTag(chatId);
      const idStr = String(chatId);
      const chatType = idStr.endsWith('@g.us') ? 'group'
        : idStr === 'status@broadcast' ? 'status' : 'private';
      const chatName = waBridgeRef.current?.getChatName?.(chatId) ?? null;
      // Chronological: E reads the catch-up oldest-first, with real timestamps.
      const ordered = [...b.msgs].sort((x, y) => (x.ts || 0) - (y.ts || 0));
      const lines = ordered.map(it => formatAutoDispatchLine({
        senderName: it.senderName, body: it.body, ts: it.ts, surface, chatType, chatName,
      })).join('\n');
      // Nap hint. Offline duration proxied by the age of the oldest unprocessed
      // message (≈ when we dropped). Frames it for E so a 10h gap reads
      // differently than a 3-min nap, without a hard staleness cutoff.
      const napMs = b.firstTs ? Math.max(0, Date.now() - b.firstTs) : 0;
      const napH = napMs / 3_600_000;
      const napStr = napH >= 1 ? `~${napH.toFixed(napH >= 10 ? 0 : 1)}h` : `~${Math.max(1, Math.round(napMs / 60000))}m`;
      const nowHHMM = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      const hint = `⏰ (resumed at ${nowHHMM} after ${napStr} offline — catch-up below, oldest first; reply once and mind the timestamps)`;
      const fullPrompt = `${hint}\n${lines}`;
      const residents = conversationsState.normalizeResidents(EGPT_CONFIG.whatsapp?.residents_per_chat?.[chatId]);
      const globalRes = conversationsState.normalizeResidents(EGPT_CONFIG.whatsapp?.residents);
      const beings = residents.length ? residents : (globalRes.length ? globalRes : [EGPT_CONFIG.persona ?? 'e']);
      for (const being of beings) {
        submitRef.current(`@${being} (backlog catch-up)`, {
          fromWhatsApp: true,
          waChatId: chatId,
          waUser: b.meta?.waUser,
          waClientLabel: b.meta?.waClientLabel,
          waSenderName: 'multiple',
          replyAllowed: b.replyAllowed,   // chat-mode gate, OR'd across the batch
          autoDispatched: true,
          forceTarget: being,
          _chainDepth: 0,
          _personaBodyOverride: fullPrompt,
        }).catch(e => errOut(`!! backlog flush failed (${chatId}): ${e.message}`));
      }
    }
  };
  const _backlogPush = (chatId, msg, replyAllowed, baseMeta) => {
    let b = _backlogBuffers.current.get(chatId);
    if (!b) { b = { msgs: [], replyAllowed: false, meta: null, firstTs: msg.ts }; _backlogBuffers.current.set(chatId, b); }
    b.msgs.push(msg);
    b.replyAllowed = b.replyAllowed || !!replyAllowed;
    b.meta = baseMeta;
    if (msg.ts && (!b.firstTs || msg.ts < b.firstTs)) b.firstTs = msg.ts;
    logOut(`backlog: buffered ${chatId} (n=${b.msgs.length}${b.replyAllowed ? ', reply-allowed' : ''})`);
  };
  // ── Interactive help/config menu (/h · /? · /help) ──────────────────────
  // Surface-agnostic: src/help-menu.mjs holds the model + nav + render. Here we
  // arm a per-chat menu (operator-only) and feed the owner's numbers/text into
  // it, replying on the originating surface. `/h <term>` is a one-shot fuzzy
  // list (no arm); `/help all` prints the legacy full wall.
  const _helpMenuRef = useRef(null);
  const _helpMode = useRef(new Map());   // chatKey -> { state, ts }
  const _HELP_TTL_MS = 3 * 60 * 1000;
  const _getHelpMenu = () => (_helpMenuRef.current ??= buildMenu(
    _mergedHelpCommands(),
    Object.entries(CONFIG_SCHEMA).map(([key, v]) => ({ key, doc: typeof v === 'string' ? v : (v?.doc ?? '') })),
    { surface: 'shell' },   // shell + WA/TG run host commands; hides extension-only
  ));
  const _helpReply = (surface, chatId, body) => {
    if (surface === 'whatsapp' && chatId && waBridgeRef.current) waBridgeRef.current.send(body, { chatId });
    else if (surface === 'telegram' && chatId && bridgeRef.current) bridgeRef.current.send(body, { chatId });
    else sysOut(body);
  };
  // Returns true if the message was consumed by the menu (caller stops).
  // Only the account OWNER (isOperator) drives it — others' messages pass through.
  const _maybeHandleHelp = (text, { surface, chatKey, isOperator, chatId }) => {
    if (!isOperator) return false;
    const t = String(text ?? '').trim();
    const menu = _getHelpMenu();
    const m = /^\/(?:h|\?|help)(?:\s+([\s\S]*))?$/i.exec(t);
    if (m) {
      const term = (m[1] ?? '').trim();
      if (term.toLowerCase() === 'all') { _helpReply(surface, chatId, helpText(surface === 'extension' ? 'extension' : 'shell')); return true; }
      if (term) { _helpReply(surface, chatId, helpRenderText(helpSearchView(menu, term))); return true; }   // one-shot, no arm
      _helpMode.current.set(chatKey, { state: initState(), ts: Date.now() });
      _helpReply(surface, chatId, helpRenderText(helpView(menu, initState())));
      return true;
    }
    const hm = _helpMode.current.get(chatKey);
    if (hm && !t.startsWith('/')) {
      if (Date.now() - hm.ts > _HELP_TTL_MS) { _helpMode.current.delete(chatKey); return false; }
      const r = helpStep(menu, hm.state, t);
      if (r.exit) { _helpMode.current.delete(chatKey); _helpReply(surface, chatId, '(help closed)'); return true; }
      hm.state = r.state; hm.ts = Date.now();
      // `Nx`/`xN` example: send only the bare command in its own message, so
      // it's trivial to copy-paste on a phone. Nav state is unchanged.
      if (r.example != null) { _helpReply(surface, chatId, r.example); return true; }
      _helpReply(surface, chatId, helpRenderText(r.view));
      return true;
    }
    return false;
  };

  // Mode note: a ONE-LINE statement of the chat's current reply mode, told to
  // @e ONCE per change (operator 2026-05-26: "you don't have to repeat the same
  // instructions every prompt — E remembers; just say it per change of mode").
  // We track the last mode announced per chat; the note is injected only when
  // it differs (or on the first dispatch to that chat). Covers every mode, not
  // just the gated ones, so E always knows its current engagement contract.
  const _MODE_NOTES = {
    on:               '(Chat reply mode: all. You can reply at will, and your replies are surfaced to the chat.)',
    accum:            '(Chat reply mode: accum. Messages are batched and shown to you together; you reply only when @mentioned, and that reply carries the batch.)',
    mute:             '(Chat reply mode: mute. You receive messages for context, but your replies are never surfaced.)',
    'mention-direct': '(Chat reply mode: mention-direct. You can reply at will, but a reply is only surfaced when @e starts a message or someone replies to you.)',
    mention:          '(Chat reply mode: mention. You can reply at will, but a reply is only surfaced when you are @mentioned.)',
    off:              '(Chat reply mode: off.)',
  };
  const _modeNote = (mode) => _MODE_NOTES[mode] ?? _MODE_NOTES.mention;
  const _announcedMode = useRef(new Map());   // chatId -> last auto-mode announced to @e

  // Room fan-out (operator 2026-05-26). SAFETY: gated behind
  // rooms.routing_enabled (default OFF) — a loop bug here would spam real
  // groups, so live fan-out stays dark until the operator enables it on a test
  // room. All surfaces are first-class peers.
  const _ROOM_CHAIN_CAP = 4;
  // Does the body @mention a brain by name (@e/@egpt for 'e', else @<id>)?
  const _bodyMentionsBrain = (body, id) => {
    const alts = (id === 'e' || id === 'egpt') ? ['e', 'egpt'] : [String(id)];
    const esc = alts.map(a => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    return new RegExp(`(^|\\s)@(?:${esc})\\b`, 'i').test(String(body ?? ''));
  };
  // Does the body @mention ANY of these names (a sibling's canonical name OR
  // aliases)? Drives unified @<sibling> routing: one mention-parser, shared by
  // every surface, so an addressed sibling reaches its brain through the nucleus
  // dispatch regardless of which limb delivered the message.
  const _bodyMentionsAny = (body, names) => {
    const esc = names.map(a => String(a).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).filter(Boolean).join('|');
    if (!esc) return false;
    return new RegExp(`(^|\\s)@(?:${esc})\\b`, 'i').test(String(body ?? ''));
  };
  // Deliver one message into a room: append to the shared transcript + fan to
  // members. Groups/shell receive unconditionally; a brain receives only when
  // @mentioned (blind) or marked 'active', and its reply re-circulates into the
  // room (chain-capped). `depth` guards brain↔brain loops; bridge sends are
  // rememberSent so a fanned copy echoes back fromMe and is never re-routed.
  // Synthetic per-chat dispatch for a wa-group room fan-out (operator
  // 2026-05-28). When the room delivers a message to a wa-group, the bot's
  // outbound send doesn't loop back through onIncoming, so the receiving
  // group's per-chat E mode never gets consulted on routed traffic. This
  // helper fires E for that group with the routed body so its per-chat mode
  // (on/mention/mute) applies, and re-routes E's reply (if any) back into the
  // room with E as the sender — marked _personaReply so receiving groups
  // don't re-fire E on E's own reply (no second-order loop).
  const _firePerChatRoutedDispatch = async ({ chatId, body, roomName, depth }) => {
    const convEntry = _convStateCache?.contacts?.whatsapp?.[chatId];
    if (!convEntry) return;             // first-contact via routing needs full install — out of scope here
    const mode = _resolveChatAutoMode(chatId);
    if (!autoReceives(mode)) return;    // 'off' — no read, no reply
    const status = autoMentionStatus(body);
    const replyAllowed = autoReplyAllowed(mode, status);
    // For routed traffic, skip the brain when its reply wouldn't fire anyway
    // (mute always, mention with no @-mention). The per-chat E that's set up
    // to read-for-context still gets context via the routed envelope arriving
    // as a regular WA message; running the brain again here would just burn
    // tokens for no emission.
    if (mode !== 'on' && !replyAllowed) return;
    const personaName = EGPT_CONFIG.persona ?? 'e';
    const personaCfg = (EGPT_CONFIG.siblings ?? {})[personaName] ?? {};
    const personaEmoji = personaCfg.body_emoji ?? EGPT_PERSONA_EMOJI;
    const threadCtx = {
      threadId: chatId,
      surface: 'wa',
      slug: convEntry.slug ?? null,
      name: convEntry.pushedName ?? null,
    };
    const reply = await runDefaultBrainTurn(body, () => {}, threadCtx);
    const trimmed = String(reply ?? '').trim();
    if (!trimmed || trimmed === '...' || trimmed === '…') return;
    if (!_eMayReplyToChat(chatId, { replyAllowed })) return;
    // Send E's reply to the receiving group (it lives in their chat history).
    try { waBridgeRef.current?.send(`${personaEmoji} ${personaName}\n${trimmed}`, { chatId, personaReply: personaName }); }
    catch (e) { logOut(`!! room ${roomName} → ${chatId}: send E reply: ${e?.message ?? e}`); }
    // Re-enter the room as E. fromId=chatId so the originating group doesn't
    // re-receive its own E reply; _personaReply=true so receiving wa-group
    // members display E's reply but DO NOT fire their per-chat E again.
    await _deliverToRoom(roomName, {
      fromId: chatId,
      senderLabel: `${personaEmoji} ${personaName}`,
      body: trimmed,
      depth: depth + 1,
      _personaReply: true,
    });
  };

  // Brain-free conversation logger. The transcript is normally written by the
  // @e dispatch (dispatch.mjs:appendTranscript). But when @e is PAUSED a chat's
  // messages take the no-dispatch path and would vanish from the record —
  // pausing @e must silence its REPLIES, never drop the conversation (operator
  // principle: "don't drop any message from anyone"; observed 2026-06-03 on the
  // Joyce DM, where only fromMe reactions logged while paused). This appends an
  // inbound message to the conversation transcript with NO brain turn (no token
  // cost). Called ONLY for messages we are NOT dispatching, so it never
  // double-logs the ones the dispatch already records.
  const _recordInboundOnly = async (from, body) => {
    try {
      const surface = 'whatsapp';
      const cs = await _loadConvState();
      const entry = conversationsState.getContact(cs, surface, from.chatId);
      const slug = entry?.slug;
      if (!slug) return;   // no contact folder yet — the next dispatched message creates it
      const dir = conversationsState.slugDir(surface, slug);
      await mkdir(dir, { recursive: true });
      const chatName = waBridgeRef.current?.getChatName?.(from.chatId) ?? String(from.chatId ?? '').split('@')[0];
      const line = formatAutoDispatchLine({
        senderName: from.senderName ?? 'someone',
        body,
        ts: Date.now(),
        chatName,
        node: 'wa',
      });
      await appendFile(join(dir, 'transcript.md'), `${line}\n\n`, 'utf8');
    } catch (e) { errOut(`!! inbound-log ${from?.chatId ?? '?'}: ${e?.message ?? e}`); }
  };

  // CONTRACT C2 — persist an incoming attachment the bridge handed us into the
  // chat's own media/ folder. The bridge downloaded it + decided to save it
  // (whatsapp.media.download); here we resolve the chat's slug (ensuring the
  // contact so a media-first chat doesn't lose the file), copy the file in with
  // a meaningful name, write a sidecar caption, and append an index line. Copy,
  // not move — the source is the bridge's own asset cache.
  const _saveIncomingMedia = async (m) => {
    try {
      if (!m?.localPath || !m?.chatID) return;
      // Surface-aware (limb-agnostic): WhatsApp/Beeper omit it (default), but a
      // Telegram (or any future) limb passes its own surface so media lands in
      // conversations/<surface>/<slug>/media/, not misfiled under whatsapp.
      const surface = m.surface ?? 'whatsapp';
      const cs = await _loadConvState();
      let slug = conversationsState.getContact(cs, surface, m.chatID)?.slug ?? null;
      if (!slug) {
        const ens = conversationsState.ensureContact(cs, surface, m.chatID, { pushedName: m.chatName, slugHint: m.chatName });
        slug = ens?.slug ?? null;
        if (slug && ens.state !== cs) await _writeConvState(ens.state);
      }
      if (!slug) { logOut(`media: no slug for ${m.chatID} — not saved`); return; }
      const mediaDir = join(conversationsState.slugDir(surface, slug), 'media');
      await mkdir(mediaDir, { recursive: true });
      const savedName = mediaFileName({
        ts: m.ts, senderName: m.senderName, kind: m.kind, msgId: m.msgId, fileName: m.fileName, mime: m.mime,
      });
      await copyFile(m.localPath, join(mediaDir, savedName));
      if (m.caption && String(m.caption).trim()) {
        await writeFile(join(mediaDir, `${savedName}.txt`), `${String(m.caption).trim()}\n`, 'utf8');
      }
      await appendFile(join(mediaDir, 'index.md'),
        mediaIndexLine({ ts: m.ts, senderName: m.senderName, kind: m.kind, savedName, caption: m.caption }), 'utf8');
      logOut(`media: saved [${m.chatName ?? m.chatID}] ${savedName} (${m.kind})`);
      // Return the absolute saved path so a limb can reference it in the
      // dispatch (e.g. "(image) [saved: <path>]") for a vision-capable brain to
      // Read. Beeper's persistMedia ignores it; the Telegram limb uses it.
      return join(mediaDir, savedName);
    } catch (e) { errOut(`!! media-save ${m?.chatID ?? '?'}: ${e?.message ?? e}`); }
  };

  // @l (and any sessionless sibling) draws its CHANNEL MEMORY from the chat's
  // own transcript.md — the single durable record — not a parallel chat.json.
  // Read the recent tail (capped) to feed as context each turn, and append the
  // sibling's reply so it persists and @l sees what it just said. Operator
  // 2026-06-11: "feed l.md + transcript.md per turn"; transcript.md is the one
  // source of truth. (The legacy conversation-L chat.json store is retired.)
  const _readTranscriptTail = async (chatId, maxChars = 2000) => {
    try {
      const cs = await _loadConvState();
      const slug = conversationsState.getContact(cs, 'whatsapp', chatId)?.slug;
      if (!slug) return '';
      const fpath = join(conversationsState.slugDir('whatsapp', slug), 'transcript.md');
      const content = await readFile(fpath, 'utf8').catch(() => '');
      if (!content) return '';
      // Keep only real conversation lines. A small local model REGURGITATES
      // system noise (transcript headers, mode-notes, '[@e]: …' silences,
      // 'egpt back!'/restart announces, Debug:) when it's in the context — it
      // summarised the noise instead of chatting (operator 2026-06-11). Strip it
      // so the tail is just the human/sibling exchange.
      const keep = stripFrontMatter(content).split('\n').filter((l) => {
        const t = l.trim();
        if (!t) return false;
        if (t.startsWith('#') || t.startsWith('thread:')) return false;            // header / date section
        if (t.startsWith('(Chat reply mode')) return false;                        // mode note
        if (/^\[@\w+[^\]]*\]:\s*(…|\.\.\.|\(No response|$)/.test(t)) return false;  // @e/@l silences
        if (/egpt back!|restart initiated|respawning|going down|Debug:/.test(t)) return false; // system
        return true;
      });
      const filtered = keep.join('\n');
      if (filtered.length <= maxChars) return filtered.trim();
      const cut = filtered.slice(filtered.length - maxChars);   // start at a line boundary
      const nl = cut.indexOf('\n');
      return (nl >= 0 ? cut.slice(nl + 1) : cut).trim();
    } catch { return ''; }
  };
  // Parse the filtered transcript tail into ALTERNATING chat turns for a chat
  // model — '[@<self> ..]:' lines → assistant, everyone else (humans, @e) →
  // user. Bodies only (drop the sender@chat (time) prefix), @<self> mentions
  // stripped so the model doesn't echo its own handle, consecutive same-role
  // turns merged (chat templates want alternation). The new message is appended
  // as the final user turn. This is how a chat model wants its history — far
  // less echo/garble on a small model than one cramped prompt. 2026-06-11.
  const _buildSiblingTurns = async (chatId, sibName, newBody, maxChars) => {
    const _strip = (s) => String(s ?? '').replace(new RegExp(`@${sibName}\\b`, 'gi'), '').replace(/[ \t]+/g, ' ').trim();
    const turns = [];
    const _push = (role, content) => {
      const c = _strip(content);
      if (!c) return;
      const last = turns[turns.length - 1];
      if (last && last.role === role) last.content += `\n${c}`;
      else turns.push({ role, content: c });
    };
    const tail = await _readTranscriptTail(chatId, maxChars);
    for (const line of String(tail).split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const mSelf = t.match(/^\[@(\w+)[^\]]*\]:\s*(.*)$/);              // [@l (..)]: reply / [@e (..)]: …
      if (mSelf) { _push(mSelf[1].toLowerCase() === String(sibName).toLowerCase() ? 'assistant' : 'user', mSelf[2]); continue; }
      const mBody = t.match(/\)\s*:\s*(.*)$/);                          // Sender@[chat] (HH:MM): body → body
      _push('user', mBody ? mBody[1] : t);
    }
    _push('user', newBody);
    return turns;
  };
  // Limb-agnostic transcript line (C1.2/I3): ensure the contact for `surface`,
  // create the transcript with front matter if new, append the line. Used by the
  // sibling/forceTarget route (Telegram→Wren) which bypasses runDefaultBrainTurn's
  // logger. Surface-aware — never assume whatsapp.
  const _logChatLine = async (surface, chatId, chatName, persona, body) => {
    try {
      if (!chatId || !String(body ?? '').trim()) return false;
      const cs = await _loadConvState();
      let slug = conversationsState.getContact(cs, surface, chatId)?.slug ?? null;
      if (!slug) {
        const ens = conversationsState.ensureContact(cs, surface, chatId, { pushedName: chatName, slugHint: chatName });
        slug = ens?.slug ?? null;
        if (slug && ens.state !== cs) await _writeConvState(ens.state);
      }
      if (!slug) return false;
      const dir = conversationsState.slugDir(surface, slug);
      await mkdir(dir, { recursive: true });
      const fpath = join(dir, 'transcript.md');
      await appendFile(fpath, transcriptAppend({
        existing: existsSync(fpath), body, name: chatName, surface, slug, threadId: chatId, persona,
      }), 'utf8');
      return true;
    } catch (e) { errOut(`!! transcript-log ${surface}/${chatId}: ${e?.message ?? e}`); return false; }
  };

  const _appendSiblingReply = async (chatId, sibName, reply, surfaced) => {
    try {
      const text = String(reply ?? '').trim();
      if (!text || !chatId) return;
      const cs = await _loadConvState();
      const slug = conversationsState.getContact(cs, 'whatsapp', chatId)?.slug;
      if (!slug) return;   // chat not registered yet — the @e turn registers it
      const fpath = join(conversationsState.slugDir('whatsapp', slug), 'transcript.md');
      if (!existsSync(fpath)) return;   // the @e turn creates the file + header
      const d = new Date(); const pad = (n) => String(n).padStart(2, '0');
      const t = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
      const line = surfaced ? `[@${sibName} (${t})]: ${text}` : `[@${sibName} (${t})]: (not surfaced) ${text}`;
      await appendFile(fpath, `${line}\n\n`, 'utf8');
    } catch (e) { errOut(`!! sibling-reply-log ${chatId}: ${e?.message ?? e}`); }
  };

  const _deliverToRoom = async (roomName, { fromId, senderLabel, body, depth = 0, _personaReply = false, logOnly = false }) => {
    let state; try { state = await loadRooms(); } catch { return; }
    const room = state.rooms?.[roomName];
    if (!room) return;
    const env = roomEnvelope({ room: roomName, senderLabel, body });
    try {
      const dir = join(EGPT_HOME, 'rooms', roomName);
      await mkdir(dir, { recursive: true });
      await appendFile(join(dir, 'transcript.md'), `[${new Date().toISOString()}] ${env}\n`, 'utf8');
    } catch (e) { logOut(`!! room transcript ${roomName}: ${e?.message ?? e}`); }
    // logOnly: the utterance is RECORDED as room activity but NEVER fanned to
    // surface members and never dispatched to brains. Used for /commands —
    // operator tooling that is part of the room's history ("all that is said in
    // a room must be logged", operator 2026-06-03) but must not be blasted as
    // text into a wa-group (leak) or re-executed via room membership. It still
    // lands in the room transcript above + the operator's own conversation.md +
    // the operator's shell view, so the record is complete on every operator
    // surface; external members simply don't receive a command.
    if (logOnly) {
      pushItem({ id: Date.now() + Math.random(), author: `room@${roomName}`, body: env, _localOnly: true });
      void append(`room@${roomName}`, env);
      return;
    }
    // Persist a room utterance into the operator's conversation.md too — not
    // just the room's own transcript + the per-contact WA log — so it's
    // retained in every member's view (operator 2026-05-31: "it should live in
    // the three places"). Guarded to fire ONCE per delivery even if both a
    // shell and an extension member exist, and only when an operator surface
    // is actually a member (a room the operator isn't in stays out of their file).
    let _opPersisted = false;
    for (const m of (room.members ?? [])) {
      if (m.id === fromId) continue;
      try {
        if (m.kind === 'wa-group') {
          // Guard: a wa-group id must be a real jid — a malformed one (e.g. a
          // stray shell handle mis-stored as wa-group) makes baileys hang until
          // the 12s send timeout, starving real sends. Skip + log instead.
          if (!/@(g\.us|s\.whatsapp\.net|lid)$/i.test(String(m.id))) {
            logOut(`room ${roomName}: skipping wa-group member with non-jid id "${m.id}"`);
            continue;
          }
          waBridgeRef.current?.send(env, { chatId: m.id });
          // Fire E for this group's per-chat mode on the routed body — unless
          // this delivery is E's own reply re-entering the room (no recursion).
          if (!_personaReply && depth < _ROOM_CHAIN_CAP) {
            _firePerChatRoutedDispatch({ chatId: m.id, body, roomName, depth })
              .catch(e => logOut(`!! room ${roomName} → ${m.id} routed E: ${e?.message ?? e}`));
          }
        }
        else if (m.kind === 'tg-group') bridgeRef.current?.send(env, { chatId: m.id });
        else if (m.kind === 'shell' || m.kind === 'extension') {
          // Show the envelope so the operator can read along.
          pushItem({ id: Date.now() + Math.random(), author: `room@${roomName}`, body: env });
          // …and retain it in conversation.md (the operator's persistent file),
          // parallel to the room transcript above. Once per delivery.
          if (!_opPersisted) { _opPersisted = true; void append(`room@${roomName}`, env); }
          // Cross-process shell mirror: append the rendered envelope to a
          // tiny NDJSON stream so OTHER egpt processes (a deferred interactive
          // shell while the headless daemon owns WA) can pick it up and
          // display it too. The tail watcher below filters out self-pid lines
          // so the writer never re-renders its own write (operator 2026-05-29:
          // "a message typed in eGPT2 should also be delivered to shell").
          try {
            appendFileSync(SHELL_MIRROR_PATH,
              JSON.stringify({ ts: Date.now(), pid: process.pid, room: roomName, env }) + '\n',
              { mode: 0o600 });
          } catch (e) { logOut(`!! shell-mirror append: ${e?.message ?? e}`); }
          // ALSO feed the body through the shell's normal submit pipeline so
          // @-mentions (`@cgpt1 hello`) actually reach their addressed brain.
          // Without this the shell is display-only and a routed `@cgpt1`
          // looks delivered but never reaches cgpt1 (operator 2026-05-28).
          //
          // SLASH COMMANDS are deliberately EXCLUDED: they belong to the
          // originating surface (it already executes them — `/room test
          // members` typed in eGPT2 replies in eGPT2). Re-executing here
          // would also race the shared outputSinkRef so the sysOut text
          // could leak to the wrong surface, and would duplicate state-
          // mutating commands across surfaces. Display still happens (the
          // setItems above renders the envelope).
          //
          // _routedFromRoom is the loop guard the shell-submit routing
          // check honors so we don't re-fan to room. Skipped when this is
          // a persona reply re-entering the room (no brain re-dispatch).
          if (!_personaReply && m.kind === 'shell' && submitRef.current
              && !String(body).trimStart().startsWith('/')) {
            try { submitRef.current(body, { _routedFromRoom: roomName, _routedFromMember: fromId }); }
            catch (e) { logOut(`!! room ${roomName} → shell submit: ${e?.message ?? e}`); }
          }
        }
        else if (m.kind === 'brain') {
          // Brain attention by state (refined 2026-06-01, ROOMS-UNIFICATION.md):
          //   muted   → never prompted, NOT EVEN by @mention (absolute, checked first)
          //   active  → every room message is dispatched to the brain
          //   mention → only messages whose body @mentions it
          // Its reply ALWAYS mirrors back so all read it.
          if (m.state === 'muted') continue;
          if (!(m.state === 'active' || _bodyMentionsBrain(body, m.id))) continue;
          if (depth >= _ROOM_CHAIN_CAP) { logOut(`room ${roomName}: chain cap (${_ROOM_CHAIN_CAP}) — not dispatching @${m.id}`); continue; }
          // @e is the default-brain persona (runDefaultBrainTurn). ANY other
          // brain member (cgpt1/2/3, codex, llama, …) dispatches to ITS session
          // via runBrainTurn, resolving its brain + options (e.g. chatgpt-cdp +
          // targetId) from the room's members. noBridge:true makes the reply
          // text return ONLY — it never touches a bridge's lastChat; we then
          // mirror it to the room's members below (the single router).
          let reply;
          if (m.id === 'e' || m.id === 'egpt') {
            reply = await runDefaultBrainTurn(env, () => {}, { threadId: `room:${roomName}`, surface: 'system', name: `room:${roomName}` });
          } else {
            const roomSessions = sessionsMapFromMembers(state, roomName);
            if (!roomSessions[m.id]?.brain) { logOut(`room ${roomName}: brain @${m.id} has no brain/session — skipping`); continue; }
            reply = await runBrainTurn(m.id, env, roomSessions, { noBridge: true });
          }
          const txt = String(reply ?? '').trim();
          if (txt && txt !== '...' && txt !== '…') {
            await _deliverToRoom(roomName, { fromId: m.id, senderLabel: `${m.emoji ?? '🧠'} ${m.id}`, body: txt, depth: depth + 1 });
          }
        }
      } catch (e) { logOut(`!! room deliver ${roomName}→${m.id}: ${e?.message ?? e}`); }
    }
  };
  // Entry: a contributing member's inbound message (active, or mention + an
  // @mention of any room participant) seeds the room. planFanout is the
  // contribution gate. Surface-agnostic: the mention flag is any "@word" in the
  // body (not @e-specific), so WA and TG route identically.
  // Resolve a WA chat's auto-mode the same way onIncoming does — the single
  // source of truth, callable from any emit path. (operator 2026-05-28)
  const _resolveChatAutoMode = (chatId) => {
    const waCfg = EGPT_CONFIG.whatsapp ?? {};
    // (Used to short-circuit to 'on' for system-personality chats so the
    // operator's Self DM was always responsive. Removed 2026-06-05: it
    // overrode explicit auto_e_modes config — operator caught a leak
    // where a Self DM they had configured as 'mention' kept getting
    // @e replies. Now the precedence is purely: explicit entry > auto_e_chats
    // membership > auto_e_default_mode > DEFAULT_AUTO_MODE. To keep the
    // old "Self always responsive" behavior, add an explicit entry, e.g.
    //   auto_e_modes:
    //     34836563681438@lid: on)
    const modes = waCfg.auto_e_modes;
    if (modes && typeof modes === 'object' && modes[chatId]) return modes[chatId];
    if (Array.isArray(waCfg.auto_e_chats) && waCfg.auto_e_chats.includes(chatId)) return 'on';
    if (autoIsMode(waCfg.auto_e_default_mode)) return waCfg.auto_e_default_mode;
    return DEFAULT_AUTO_MODE;
  };
  // The outbound backstop: may E SEND a reply to this WA chat right now? Every
  // E-emit path (text, voice, emitted-command, future) funnels through here so
  // 'mute'/'off' is a HARD block independent of any per-path flag — reception
  // stays unconditional, only emission is vetted. Logs every block.
  const _eMayReplyToChat = (chatId, { replyAllowed, isReaction = false } = {}) => {
    // Global pause is an ABSOLUTE @e emit kill — it overrides mode/mention. The
    // dispatch-side autoPaused gate only stops the AUTO broadcast; an explicit
    // '@e …' still reaches @e via the submit() else-branch, so without this
    // backstop a PAUSED @e still replied to '@e estas?' (operator 2026-06-03,
    // /e auto status = PAUSED). Checked here so NO emit path (text, voice, the
    // mention else-branch) can speak while paused.
    const paused = !!EGPT_CONFIG.whatsapp?.auto_e_paused;
    const mode = _resolveChatAutoMode(chatId);
    // Single source of truth (tested in auto-mode.test.mjs): pause-kill layered
    // over the per-chat mode gate. Keep the two distinct log lines for triage.
    const ok = autoMayEmitChat({ paused, mode, replyAllowed, isReaction });
    if (!ok) {
      if (paused) logOut(`auto-mode: E emit to ${chatId} BLOCKED — auto_e_paused (global kill)`);
      else logOut(`auto-mode: E emit to ${chatId} BLOCKED (mode=${mode}, replyAllowed=${replyAllowed}${isReaction ? ', reaction' : ''})`);
    }
    return ok;
  };

  const _maybeRouteToRooms = async ({ memberId, senderLabel, body }) => {
    if (!EGPT_CONFIG.rooms?.routing_enabled) return;
    if (!body || !memberId) return;
    // Echo/loop guard: a message that's already a room envelope was fanned BY
    // us — never re-route it, or two active groups bounce it forever. (This is
    // an idempotency check on the router's OWN output marker, not a content
    // classification — same as a network layer ignoring its own broadcast.)
    if (isRoomEnvelope(body)) return;
    let state; try { state = await loadRooms(); } catch { return; }
    // A /command is operator tooling. It must NOT be fanned as text to room
    // surfaces (sending "/restart" into a WhatsApp group would leak it +
    // entangle command handling with room membership) NOR dispatched to brains
    // — commands are interpreted by the engine's one command path, independent
    // of rooms. BUT it IS part of the room's activity, so it must be RECORDED:
    // log-only delivery writes it to each member-room's transcript (+ the
    // operator's view) without fanning (operator 2026-06-03: "slash commands …
    // are part of the chatter being seen in the room. all that is said in a
    // room must be logged"). This guard covers EVERY surface (WA/TG/shell all
    // route inbound through here).
    const _isCommand = String(body).trimStart().startsWith('/');
    // Contribution is now uniform: active|mention contribute, muted doesn't
    // (refined 2026-06-01). The old @mention gate moved to brain dispatch below.
    for (const plan of planFanout(state, memberId)) {
      await _deliverToRoom(plan.room, { fromId: memberId, senderLabel, body, depth: 0, logOnly: _isCommand });
    }
  };

  // When a view command (/last, etc.) wants its echo + sysOut output
  // kept out of the persistent transcript, it flips this on for the
  // duration of its run. Restored in a finally so a crashing handler
  // doesn't leak the suppression to later commands.
  const _suppressTranscriptRef = useRef(false);
  // /storm toggle — every WA arrival renders, awareness gates
  // bypassed. The bridge owns its own _storm flag (set via
  // setStorm). This ref mirrors it for host-side reads (media
  // notify filtering, observeOnly override).
  const _stormRef = useRef(false);
  const [, setThemeRev] = useState(0);
  // sessions: map of participant-name → { brain: brainName, options: {...} }
  // The room starts empty — egpt is the host, not a participant. Use /open
  // or /attach to bring brains in. Auto-attach at startup picks up CDP tabs
  // if Chrome is already running.
  // Rooms scope sessions so a node can hold multiple working contexts at
  // once and switch between them. Each room is persisted as a YAML file
  // under ~/.egpt/rooms/<name>.yaml. Session metadata (brain type,
  // emoji, options) is saved; live runtime state (chrome targetIds,
  // codex sessionIds) is also written but may go stale across restarts.
  // Existing rebind logic (CDP brains find a tab by urlMatch; codex
  // resumes by sessionId) handles staleness on first use.
  //
  // The shim keeps `sessions` and `setSessions` working for the existing
  // brain code: read = current room's session map, write = update under
  // current room key. So /open, /attach, runBrainTurn, etc. don't need to
  // know about rooms — they always operate on the current one.
  const [roomSessionsMap, setRoomSessionsMap] = useState({ default: {} });
  const [currentRoom, setCurrentRoom] = useState('default');
  const sessions = roomSessionsMap[currentRoom] ?? {};
  const setSessions = (updater) => {
    setRoomSessionsMap(rs => {
      const cur = rs[currentRoom] ?? {};
      const next = typeof updater === 'function' ? updater(cur) : updater;
      return { ...rs, [currentRoom]: next };
    });
  };
  // Track which room state is already on disk so we can auto-save only
  // changed rooms and clean up deleted ones. Set is mutated in place.
  const persistedRoomsRef = useRef(new Set());
  // True after the on-disk rooms have been merged in. Auto-save effect
  // waits for this to avoid wiping the disk with empty initial state.
  const roomsLoadedRef = useRef(false);
  // currentRoom mirrored as a ref so the long-lived bus polling closure
  // can read the latest value without a stale capture.
  const currentRoomRef = useRef('default');
  currentRoomRef.current = currentRoom;
  // One-time hint when auto-attach finds tabs but we're in the lobby.
  const defaultRoomHintShown = useRef(false);
  // activeSessions: brains that plain-text input routes to (no @-mention
  // needed). Set with `/use a,b,c` for multi-AI broadcast or `/use a` to
  // switch to one. Cleared with `/use clear`. Without any active
  // sessions, plain text stays in the room (mirrored to peers via
  // room-utterance) but never auto-broadcasts to brains.
  const [activeSessions, setActiveSessions] = useState([]);
  // Elapsed-time tracking so the user has progress feedback during the
  // brain's pre-generation "thinking" phase (which can be 5-15s for a long
  // conversation file). When busy goes true we record the start; an interval
  // bumps `now` every 250ms to drive re-renders.
  const [busyStart, setBusyStart] = useState(null);
  const [now, setNow] = useState(Date.now());
  // Banner shown when an operator calls browser.waitForHuman() — pauses until /continue.
  const [browserWaiting, setBrowserWaiting] = useState(null);
  const { exit } = useApp();

  // Refs so background bridges (Telegram) can call submit() and forward new
  // items without depending on render closures. submitRef updated each render.
  const submitRef = useRef(null);
  const bridgeRef = useRef(null);
  const wizardRef = useRef(null);
  // Limb (CLIENT) → spine connection handle (set by the attach-client effect).
  // submit() forwards typed lines through this instead of running locally.
  const _attachClientRef = useRef(null);
  const sentItemsCountRef = useRef(0);
  // Where sysOut output should land. 'local' = mark items _localOnly so
  // they don't bounce to Telegram or peers; 'remote' = let them through.
  // The submit handler flips this to 'remote' when meta.fromTelegram so
  // /help and /sessions issued from Telegram reach Telegram. Default is
  // 'local' — most sysOut calls (startup status, bus dispatcher logs,
  // local slash commands) are operational noise that doesn't belong in
  // the conversation feed.
  const outputSinkRef = useRef('local');
  // Bus (control-plane CDP tab) state: targetId + subscription handle.
  const busTargetIdRef = useRef(null);
  const busSubRef = useRef(null);
  // Peer nodes seen on the bus. nodeId -> { role, sessions:[{name,brain}], polling, lastSeen }.
  // These are "zombie" sessions: registered as participants but owned elsewhere.
  // /sessions surfaces them; @<name> falls through to peer lookup; /telegram
  // <node> uses this to route handoff.
  const peerNodesRef = useRef(new Map());
  const [peersRev, setPeersRev] = useState(0);
  // Whether THIS node currently owns Telegram polling. Broadcast on change.
  const [tgPolling, setTgPolling] = useState(false);
  // Latest sessions snapshot accessible from bus event handlers (which run in
  // a closure with stale state). Updated each render.
  const sessionsLatestRef = useRef({});
  // Bus event dispatcher — populated each render with the current closure
  // so bus events always read fresh state. Keeps the bus subscription
  // useEffect's [] deps stable.
  const handleBusEventRef = useRef(null);
  // Shared wa-send dispatcher. Set each render (closes over the latest
  // waBridgeRef + setItems); called by the 'wa-send' bus case AND by the
  // outbox file watcher. Returns true iff the send was issued — the
  // watcher uses that to leave the file in place when no bridge is up
  // (retry on the next sweep instead of losing the message).
  const dispatchWaSendRef = useRef(null);
  // Stream factory ref — set when the WA bridge starts (twin-soul
  // phase 2b). makeStream(initialText, {chatId}) is the proxy-aware
  // replacement for waBridgeRef.current.startStreamMessage. Today
  // it's an in-process wrapper around bridge.startStreamMessage;
  // when the keeper runs in its own process the same call site
  // gets a file-IPC implementation, transparent to callers.
  const streamFactoryRef = useRef(null);

  useEffect(() => {
    if (!busy) { setBusyStart(null); return; }
    setBusyStart(Date.now());
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [busy]);

  // Keep the host awake while the engine is BUSY (a brain turn / processing is
  // in flight), so a scheduled wake can finish its work before the machine
  // idle-sleeps. Reference-counted in stay-awake.mjs, so this nests with the
  // bridge's post-wake + transcription holds; released the moment we go idle.
  useEffect(() => {
    if (!busy) return;
    return acquireStayAwake();
  }, [busy]);

  // Poll for ~/.egpt/browser-pause.txt — written by browser.waitForHuman() inside
  // an operator script. When found, show a banner prompting the user to act in
  // the browser and type /continue.
  useEffect(() => {
    const pauseFile = join(EGPT_HOME, 'browser-pause.txt');
    const id = setInterval(() => {
      if (!existsSync(pauseFile)) return;
      let msg = 'please act in the browser';
      try { msg = readFileSync(pauseFile, 'utf8').trim() || msg; unlinkSync(pauseFile); } catch (e) { swallow('browser-pause.consume', e); }
      setBrowserWaiting(msg);
    }, 800);
    return () => clearInterval(id);
  }, []);

  // Cross-process shell mirror tail (operator 2026-05-29). Tail the NDJSON
  // append log SHELL_MIRROR_PATH; for each new line written by ANOTHER pid,
  // render it as a room@<name> item. Lets a deferred interactive shell see
  // room traffic the headless daemon's bridge fanned out.
  //
  // Don't trust statSync.size cross-process on Windows: the size pulled
  // from the directory entry can lag the writer's actual fs.write by an
  // interval (operator 2026-05-29: eGPT3 message was in the file but the
  // tail never picked it up). Just read the whole content every poll and
  // diff against our cursor — the file is tiny, this is cheap.
  useEffect(() => {
    // A limb receives ALL room/engine output over the attach socket already;
    // shell-mirror.jsonl is the PRE-ATTACH cross-process mirror, so reading it
    // in a limb double-renders every fanned room message (operator 2026-06-01:
    // writing in eGPT3 appeared twice in the limb). Engine-side only now — the
    // attach transport supersedes the file mirror; the writer is vestigial.
    if (CLIENT) return;
    let cursor = 0;
    try { cursor = readFileSync(SHELL_MIRROR_PATH, 'utf8').length; } catch (e) { swallow('shell-mirror.read', e, { expect: ['ENOENT'] }); cursor = 0; }
    let buf = '';
    const id = setInterval(() => {
      let content;
      try { content = readFileSync(SHELL_MIRROR_PATH, 'utf8'); } catch (e) { swallow('shell-mirror.read', e, { expect: ['ENOENT'] }); return; }
      if (content.length <= cursor) return;
      const chunk = content.slice(cursor);
      cursor = content.length;
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';   // last fragment may be incomplete; carry over
      for (const line of lines) {
        const s = line.trim();
        if (!s) continue;
        let ev;
        try { ev = JSON.parse(s); } catch { continue; }
        if (!ev || ev.pid === process.pid || !ev.env) continue;
        pushItem({
          id: Date.now() + Math.random(),
          author: `room@${ev.room ?? '?'}`,
          body: ev.env,
        });
      }
    }, 800);
    return () => clearInterval(id);
  }, []);

  // Telegram bridge management. Auto-starts if ~/.egpt/config.json has a
  // bot_token; /telegram <node> stops this node's bridge and hands polling to
  // a peer over the bus; the named peer's startTgBridge() picks it up.
  const tgCfgRef = useRef(null);

  const startTgBridge = useCallback(async () => {
    if (CLIENT) return false;   // a limb never owns Telegram — the spine does
    if (bridgeRef.current) return true;
    let cfg = tgCfgRef.current;
    if (!cfg) {
      try {
        const { readConfig } = await import('./src/tools/config-io.mjs');
        cfg = await readConfig();
      } catch (e) {
        // Same failure class as the boot readConfigSync SHOUT: a config
        // read error here means Telegram silently never starts.
        errOut(`!! telegram: config read failed — bridge NOT started: ${e?.message ?? e}`);
        return false;
      }
      tgCfgRef.current = cfg;
    }
    // bot_token is a SECRET → it lives in config.local.json, which the fresh
    // readConfig() above does NOT merge (it reads config.yaml only — the local
    // overlay is folded into EGPT_CONFIG once at boot). Prefer the already-
    // merged EGPT_CONFIG for the token, same as beeper_token — otherwise a token
    // in config.local.json silently never starts the bridge (2026-06-12 trap).
    const botToken = EGPT_CONFIG.telegram?.bot_token ?? cfg.telegram?.bot_token;
    if (!botToken) {
      // Loud only when telegram is meant to be on — a bare unconfigured node
      // stays quiet (startTgBridge is called speculatively on peer events).
      if (EGPT_CONFIG.telegram?.enabled ?? cfg.telegram?.enabled) {
        errOut('!! telegram: enabled but no bot_token resolvable (checked config.local.json + config.yaml) — bridge NOT started');
      }
      return false;
    }
    const bridge = startTelegramBridge({
      botToken,
      nodeName:     cfg.telegram.node_name ?? 'egpt-shell',
      allowedUsers: cfg.telegram.allowed_users ?? [],
      // The bot IS the meta-bot (Wren) — let the operator address it by the
      // egpt handle they know (@wren) and not just the clunky @<bot_username>.
      agentHandle:  cfg.telegram.agent ?? 'wren',
      // Hold-on-reconnect grace window. Same semantic as WA:
      //   N > 0  grace seconds
      //   N == 0 strict (hold anything older than connectedAt)
      //   N == -1 disable hold
      // Default 5 = only in-flight live messages dispatch; daemon
      // restart sends overnight @e's to /tg-pending for review.
      maxBacklogSeconds: cfg.telegram.max_backlog_seconds != null
        ? Number(cfg.telegram.max_backlog_seconds)
        : 5,
      chatId:       cfg.telegram.chat_id ?? null,
      // Media: the SAME host callbacks the WhatsApp limb uses, so a photo /
      // voice note / document sent to egpt_reve_bot is processed at the bridge
      // level (saved to conversations/telegram/<slug>/media/, voice transcribed
      // + 👂 ack via the shared src/incoming-media.mjs), not dropped. The bot is
      // Wren — its operator's media always acks; transcripts reach Wren as text.
      onMedia:      _saveIncomingMedia,
      audioCfg:     EGPT_CONFIG.whatsapp?.media?.audio_transcribe ?? {},
      transcribe:   (EGPT_CONFIG.transcription_endpoint && EGPT_CONFIG.transcription_token)
        ? makeRemoteFirstTranscriber({
            endpoint: EGPT_CONFIG.transcription_endpoint,
            getKey: () => EGPT_CONFIG.transcription_token,
          })
        : transcribeAudioFile,   // local whisper-cli fallback (host is Node — fine to import)
      onIncoming: async (text, from) => {
        const who = from.username ? `@${from.username}` : (from.firstName || `tg:${from.userId}`);
        logOut(`(telegram message from ${who}) -> ${text}`);

        const isSlashCommand = text.trimStart().startsWith('/');
        const isCommand = isSlashCommand || /^@\S+/.test(text.trimStart());

        // Authorization gates privileged actions, not whether the agent HEARS
        // the room. Reject unauthorized slash commands always (host control),
        // and unauthorized @being directives in a 1:1. But in a GROUP the bot
        // IS Wren and forwards all chatter to it — non-operators talking in
        // the room (e.g. reve in DOLLY-REVE) is the whole point, so don't
        // reject their messages with a noisy "not authorized" reply.
        const blockedUnauth = !from.authorized && (
          isSlashCommand || (from.chatType === 'private' && /^@\S+/.test(text.trimStart())));
        if (blockedUnauth) {
          bridge.send(`${who} (${from.userId}) is not authorized to emit commands or mentions`,
            { chatId: from.chatId });
          return;
        }

        // Lifecycle / process-control commands are only allowed in 1:1
        // chats with the bot. Even with @us-addressing in a group, we
        // refuse — group members shouldn't be able to crash, upgrade,
        // or rewind the bot's host. DM the bot if you need these.
        const LIFECYCLE = new Set(['/rewind', '/upgrade', '/restart', '/exit', '/chrome']);
        const firstTok = text.trimStart().split(/\s+/)[0];
        if (LIFECYCLE.has(firstTok) && from.chatType && from.chatType !== 'private') {
          bridge.send(`${firstTok} only works in a 1:1 chat with this bot — DM me and try again`,
            { chatId: from.chatId });
          return;
        }

        // Interactive help menu — owner-only, consumes their numbers/text.
        if (_maybeHandleHelp(text, { surface: 'telegram', chatKey: from.chatId, isOperator: !!from.authorized, chatId: from.chatId })) {
          return;
        }

        // Room fan-out (gated + loop-safe; no-op unless this TG chat is a
        // contributing room member). Routing is parallel to the bridge's own
        // command execution — both happen, neither depends on the other.
        // tg-group members are keyed by the bare chat id (joined as
        // `tg:<id>`), matching String(from.chatId) here.
        _maybeRouteToRooms({ memberId: String(from.chatId ?? ''), senderLabel: who, body: text })
          .catch(e => errOut(`!! _maybeRouteToRooms(tg): ${e?.message ?? e}`));

        // Replication is unconditional: every Telegram message in the
        // room is part of the room. The legacy `mirror` policy now only
        // controls whether a plain-text Telegram message ALSO triggers
        // a brain call (broadcast to local sessions). skipRoute tells
        // submitInner to post room-utterance and stop, without routing.
        let skipRoute = false;
        let dispatchTgText = text;
        let _forceTarget = null;
        // System-personality contacts (operator's own bot-DM with themselves,
        // future operator-DMs) auto-dispatch plain text to @e, same as WA
        // Self DM. Operator (2026-05-22): personality='system' is the
        // canonical "operator talking to themselves" marker. Honor it on
        // TG too — bypass the mirror policy gate, auto-prefix the message.
        const tgChatIdStr = String(from.chatId ?? '');
        const isSystemTgContact = (() => {
          try {
            const entry = _convStateCache?.contacts?.telegram?.[tgChatIdStr];
            if (!entry) return false;
            if (entry.aliasOf) {
              const primary = _convStateCache.contacts.telegram[entry.aliasOf];
              return primary?.personality === 'system';
            }
            return entry.personality === 'system';
          } catch (e) { return false; }
        })();
        if (!isCommand && parseInput(text.trim()).type === 'message') {
          const mirror = cfg.telegram?.mirror ?? 'none';
          // An explicit @bot mention / reply-to-bot in a group is addressed
          // to us by IDENTITY — honor it regardless of the mirror policy,
          // same as a self-DM. (from.addressedToBot is set by the bridge
          // only after it has verified the message names this bot.)
          const canRoute = from.addressedToBot
            || mirror === 'all' || (mirror === 'allowed' && from.authorized) || (isSystemTgContact && from.authorized);
          skipRoute = !canRoute;
          // NO @e auto-prefix. The bot IS the meta-bot (Wren): a message
          // addressed to the bot routes to its own agent by IDENTITY
          // (forceTarget), not by mangling text onto creation-E. A group
          // message is addressedToBot regardless of sender (the bot's presence
          // = Wren's presence), so Wren joins the actual conversation with
          // everyone, not just the operator; in a 1:1 the operator's own text
          // still routes here. Skip only when the message explicitly
          // @-addresses someone else. agent overridable via telegram.agent
          // (default 'wren').
          if (canRoute && (from.addressedToBot || from.authorized)
              && !/^@[\w-]+/.test(text.trimStart())) {
            _forceTarget = cfg.telegram?.agent ?? 'wren';
          }
        }

        if (submitRef.current) await submitRef.current(dispatchTgText, {
          fromTelegram: true,
          telegramChatId: from.chatId,
          telegramUser: who,
          telegramMessageId: from.tgMessageId ?? null,
          ...(_forceTarget ? { forceTarget: _forceTarget } : {}),
          skipRoute,
        });
      },
      onLog:   (msg) => logOut(`telegram: ${msg}`),
      onError: (msg) => errOut(`!! telegram: ${msg}`),
      onYield: () => {
        // 409 from Telegram means another node holds the polling slot.
        // Drop our bridge state so we stop showing as 'polling' on the
        // bus; an auto-claim will fire on the next peer release event.
        bridgeRef.current = null;
        _globalBridge = null;
        setTgPolling(false);
        pushItem({
          id: Date.now() + Math.random(), author: 'system', _localOnly: true,
          body: `telegram: yielded — another node holds the polling slot. Will auto-resume when they release; /telegram ${BUS_NODE_ID} to force-reclaim.`,
        });
      },
      onChatId: async (id) => {
        // First captured chat — persist so future runs know the outbound
        // target without waiting for an inbound. Also update the live
        // ref + bridge.chatId getter so /telegram (no arg) reflects it.
        const { readConfig, writeConfig } = await import('./src/tools/config-io.mjs');
        const saved = await readConfig();
        if (!saved.telegram || typeof saved.telegram !== 'object') saved.telegram = {};
        if (saved.telegram.chat_id === id) return;
        saved.telegram.chat_id = id;
        try {
          await writeConfig(saved);
          if (tgCfgRef.current?.telegram) tgCfgRef.current.telegram.chat_id = id;
          logOut(`telegram: outbound chat ${id} captured and saved`);
        } catch (e) {
          errOut(`!! telegram: could not persist chat_id (${e.message})`);
        }
      },
    });
    bridgeRef.current = bridge;
    _globalBridge = bridge;
    setTgPolling(true);
    logOut('telegram bridge enabled');
    return true;
  }, []);

  const stopTgBridge = useCallback(() => {
    if (!bridgeRef.current) return false;
    bridgeRef.current.stop();
    bridgeRef.current = null;
    _globalBridge = null;
    setTgPolling(false);
    pushItem({ id: Date.now() + Math.random(), author: 'system', body: 'telegram bridge stopped', _localOnly: true });
    return true;
  }, []);

  // Bus-aware Telegram startup, once per shell lifetime.
  //
  // Boot phase (first 2s of bus-stable peers): consult peerNodesRef
  // and apply shell-priority policy. Shells are the natural Telegram
  // owner — they also run WA, brains, file logging, and the bus.
  // The chrome extension is a viewer surface that holds the slot
  // opportunistically when no shell is around. So:
  //   - polling SHELL peer present → defer (auto-resume on their yield)
  //   - polling CHROME peer present → preempt via self-handoff
  //   - nobody polling → start
  // The chrome extension's telegram-handoff handler does the
  // symmetric thing on its side: ev.to !== its own id → stop polling.
  //
  // The peersRev dependency is here ONLY to extend the 2s timer when
  // peers churn before the timer fires; once the timer has fired, the
  // attempted ref guard makes this a no-op for future changes.
  // Without that guard the previous version oscillated: 409 → yield
  // → peer announce → 2s timer → start → 409 → ... — exactly the
  // race the user called out as wrong (the right semantic is "saw
  // 409, somebody else is polling, stop").
  const tgBootAttempted = useRef(false);
  useEffect(() => {
    if (tgBootAttempted.current) return;
    if (bridgeRef.current) return;
    const t = setTimeout(() => {
      if (tgBootAttempted.current) return;
      tgBootAttempted.current = true;
      if (bridgeRef.current) return;
      const peers = [...peerNodesRef.current.values()];
      const otherShellPolling = peers.some(p => p.polling && p.role !== 'chrome');
      if (otherShellPolling) return;       // another shell owns it
      const chromePolling = peers.some(p => p.polling && p.role === 'chrome');
      if (chromePolling) {
        // Preempt the extension. Post a self-handoff; the extension's
        // telegram-handoff handler will stopBridge() since ev.to is
        // not its own id. 1.5s settle lets the yield reach Telegram
        // before our getUpdates opens (Bot API still 409s for several
        // seconds after a polling stop).
        const tid = busTargetIdRef.current;
        if (tid) {
          bus.postEvent(tid, { type: 'telegram-handoff', from: BUS_NODE_ID,
            ts: Date.now(), to: BUS_NODE_ID }).catch(e => console.error(`!! egpt.mjs:[promise-catch] ${e?.message ?? e}`));
          setTimeout(() => startTgBridge(), 1500);
          return;
        }
      }
      startTgBridge();
    }, 2000);
    return () => clearTimeout(t);
  }, [peersRev, startTgBridge]);

  // Stop the bridge on unmount regardless of who started it.
  useEffect(() => {
    return () => stopTgBridge();
  }, [stopTgBridge]);

  // ── WhatsApp bridge (beeper default / cdp fallback, personal account) ──
  // Enabled when EGPT_CONFIG.whatsapp.enabled === true (or any truthy
  // whatsapp config block is present). First run shows a QR to scan with
  // your phone; auth state persists at ~/.egpt/wa-auth/.
  // Brain Chrome PID — captured at spawn time so OS-level focus
  // theft (chrome.focus_on_dispatch) can target the right window
  // rather than 'some Chrome with the matching title'.
  const _chromeBrainPidRef = useRef(null);
  // OS-level Chrome focus — Target.activateTarget + Page.bringToFront
  // do their best at the CDP layer, but Windows / X11 / macOS each
  // have anti-focus-stealing rules that can leave Chrome behind the
  // foreground app. This calls into the OS to force the window
  // forward, targeting the brain Chrome by PID when we have one.
  // Config gate: chrome.focus_on_dispatch ('on' default | 'off').
  const _osFocusBrainChrome = () => {
    if ((EGPT_CONFIG.chrome?.focus_on_dispatch ?? 'on') === 'off') return;
    const pid = _chromeBrainPidRef.current;
    if (process.platform === 'win32') {
      // Prefer PID-targeted AppActivate (precise — picks the exact
      // brain Chrome window). Fall back to app-name AppActivate when
      // we don't have a PID (Chrome was already running before shell
      // started, so spawnChromeWithExtension returned without spawning).
      // Best-effort either way; failures are silent.
      const command = pid
        ? `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { (New-Object -ComObject WScript.Shell).AppActivate($p.Id) | Out-Null }`
        : `(New-Object -ComObject WScript.Shell).AppActivate("Google Chrome") | Out-Null`;
      const ps = spawn('powershell', ['-NoProfile', '-Command', command], { stdio: 'ignore', windowsHide: true });
      ps.on('error', () => {});
    } else if (process.platform === 'darwin') {
      // osascript by app name (PID targeting needs another route).
      const ps = spawn('osascript', ['-e', 'tell application "Google Chrome" to activate'], { stdio: 'ignore' });
      ps.on('error', () => {});
    } else {
      // Linux: wmctrl by class. -p flag would target a PID specifically
      // but app-name covers the common 'one Chrome' case fine.
      const ps = spawn('wmctrl', ['-x', '-a', 'Google-chrome'], { stdio: 'ignore' });
      ps.on('error', () => {});
    }
  };
  const waBridgeRef = useRef(null);
  // /e confirm watcher — set in startWaBridge, called from the broadcast
  // (incoming) tap and the per-being dispatch taps (persona + meta handlers).
  const confirmMirrorRef = useRef(null);
  // Cache the most recent /channels output so @waN can resolve N to a
  // chat by the index the user just saw. Reset every /channels so the
  // numbers always line up with the freshest view.
  const _waChannelsCacheRef = useRef([]);
  // /use @waN and /join @waN populate this set. plain shell-typed
  // text fans out to every chat in it; WA-arriving messages from a
  // chat in the set get mirrored to every OTHER chat in the set
  // (bridge mode — Alice in @wa5 shows up in @wa6 too). Map keyed
  // by jid → { jid, name, idx, dir }. dir is one of:
  //   'both' (default)  — bidirectional: shell↔chat, chat↔chat
  //   'in'              — incoming only: chat→shell (and to other
  //                       joined chats), shell text does NOT fan out
  //                       to this chat
  //   'out'             — outgoing only: shell→chat, chat's own
  //                       arrivals do NOT render in shell
  // Empty / null means "no WA binding".
  const waJoinedRef = useRef(null);
  // Helpers — keep callers from special-casing the empty / single /
  // multi cases everywhere.
  const _waJoinedAll = () =>
    waJoinedRef.current ? [...waJoinedRef.current.values()] : [];
  // Direction filters. Outgoing-targets = chats that should receive
  // shell-typed text. Incoming-allowed = chats whose arrivals
  // should render in shell (and bridge to other joined chats).
  const _waJoinedOutgoing = () => _waJoinedAll().filter(e => (e.dir ?? 'both') !== 'in');
  const _waJoinedIncomingAllowed = (jid) => {
    const e = waJoinedRef.current?.get(jid);
    if (!e) return false;
    return (e.dir ?? 'both') !== 'out';
  };
  const _waJoinedFirst = () =>
    waJoinedRef.current && waJoinedRef.current.size > 0
      ? waJoinedRef.current.values().next().value
      : null;
  const _waJoinedHas = (jid) =>
    !!(waJoinedRef.current && waJoinedRef.current.has(jid));
  const _syncBypassToBridge = () => {
    // Keep the WA bridge's awareness-bypass set aligned with chats
    // we want EVERY message from, not just @-tagged ones:
    //   - joined chats (/use, /join binds)
    //   - auto_e_chats (operator-configured @e participation groups)
    // Without this, a group with the default 'mentions' awareness
    // would drop the operator's own fromMe posts AND every non-
    // mentioned member message before reaching auto_e_chats dispatch.
    // Operator (2026-05-17): "obviously do not skip my own messages."
    const wa = waBridgeRef.current;
    if (!wa || typeof wa.setBypassChats !== 'function') return;
    const joined = _waJoinedAll().map(e => e.jid);
    const auto = Array.isArray(EGPT_CONFIG.whatsapp?.auto_e_chats)
      ? EGPT_CONFIG.whatsapp.auto_e_chats
      : [];
    wa.setBypassChats([...new Set([...joined, ...auto])]);
  };
  const _waJoinedAdd = (entry) => {
    if (!waJoinedRef.current) waJoinedRef.current = new Map();
    waJoinedRef.current.set(entry.jid, entry);
    _syncBypassToBridge();
  };
  const _waJoinedRemove = (jid) => {
    if (!waJoinedRef.current) return false;
    const removed = waJoinedRef.current.delete(jid);
    if (waJoinedRef.current.size === 0) waJoinedRef.current = null;
    _syncBypassToBridge();
    return removed;
  };
  const _waJoinedClear = () => {
    waJoinedRef.current = null;
    _syncBypassToBridge();
  };
  const _waJoinedSize = () => waJoinedRef.current?.size ?? 0;
  const startWaBridge = useCallback(async (force = false) => {
    if (CLIENT) return false;   // a limb never owns WhatsApp — the spine does
    if (waBridgeRef.current) return true;
    const cfg = EGPT_CONFIG.whatsapp;
    if (!cfg || typeof cfg !== 'object') return false;   // guard: a malformed override (e.g. a string) must not proceed
    if (cfg.enabled === false) return false;
    // No pairing gate: baileys (and its QR dance) is gone. Both remaining
    // transports ride an existing login — beeper the Beeper Desktop app,
    // cdp the logged-in WhatsApp Web tab in egpt's Chrome.
    try {
      // Derive the valid persona-reply names from the sibling registry
      // (canonical names + aliases). cf77999 in the bridge uses this
      // to recognize "🦅 jay:" / "🐦 wren:" / "🧠 e:" reply prefixes.
      // Legacy fallback when no registry: hardcoded list inside the bridge.
      const sibs = EGPT_CONFIG.siblings;
      const personaNames = (sibs && typeof sibs === 'object')
        ? [...new Set(
            Object.entries(sibs).flatMap(([n, e]) => [
              n.toLowerCase(),
              ...((e?.aliases ?? []).map(a => String(a).toLowerCase())),
            ])
          )]
        : undefined;  // bridge default applies
      // /e confirm watcher — see whatsapp.confirm_chats. For a watched jid we
      // mirror, VERBATIM and per-being, the RAW string each side actually
      // exchanges: the incoming message, the exact prompt each resident brain
      // is handed, and each brain's raw reply (tags: "📥 in", "→ <being>",
      // "<being> →"). Content is wrapped in a ``` fence so the operator's Self
      // view renders it monospaced. Copies sent to self go via the outbox →
      // wa.send, which rememberSent's them, so they never loop back into
      // dispatch even though the self-DM is itself an auto_e chat. Exposed via
      // confirmMirrorRef so the per-being dispatch taps can reach it.
      confirmMirrorRef.current = async (jid, header, content) => {
        try {
          if (!jid) return;
          const watch = EGPT_CONFIG.whatsapp?.confirm_chats;
          const dests = watch && Array.isArray(watch[jid]) ? watch[jid] : null;
          if (!dests || !dests.length) return;
          // Directional debug header that traces the flow — "Debug: ->E"
          // (human prompted E), "Debug: <-E" (reply received from E),
          // "Debug: E->L" (E's reply re-circulated as L's prompt) — followed
          // by the exact envelope as fenced content.
          const body = String(content ?? '');
          const hdr = header ? `Debug: ${header}` : null;
          const waBody = hdr ? `${hdr}\n\`\`\`\n${body}\n\`\`\`` : `\`\`\`\n${body}\n\`\`\``;
          const shellBody = hdr ? `${hdr}\n${body}` : body;
          const selfDm = EGPT_CONFIG.whatsapp?.chat_id ?? null;
          for (const dest of dests) {
            if (dest === 'shell') {
              pushItem({ id: Date.now() + Math.random(), author: 'system', _localOnly: true, body: shellBody });
            } else if (dest === 'self' || dest === 'egptbot') {
              const targetJid = dest === 'self' ? selfDm : (EGPT_CONFIG.whatsapp?.egptbot_jid ?? null);
              if (!targetJid) {
                if (dest === 'egptbot') pushItem({ id: Date.now() + Math.random(), author: 'system', _localOnly: true,
                  body: `!! /e confirm: dest "egptbot" needs whatsapp.egptbot_jid configured (no bot account yet) — skipped` });
                continue;
              }
              if (targetJid === jid) continue;  // don't echo a watched chat into itself
              const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
              // deliverEcho: the debug mirror is a normal Self message — let it
              // reach the Self residents (system-e / system-l) instead of being
              // dropped as a self-echo. They see it and may react.
              const ev = { type: 'wa-send', from: 'system', ts: Date.now(), jid: targetJid, body: waBody, deliverEcho: true };
              await writeFile(join(EGPT_HOME, 'outbox', id + '.json'), JSON.stringify(ev));
            }
          }
        } catch (e) { console.error(`!! confirmMirror: ${e?.message ?? e}`); }
      };

      const _bridgeOpts = {
        allowedUsers:      cfg.allowed_users ?? [],
        awareness:         cfg.awareness ?? {},
        ...(personaNames ? { personaNames } : {}),
        // Default true: mid-body @e/@egpt routes to @e instead of
        // falling through to plain-text. Opt out with at_e_anywhere:false.
        atEAnywhere:       cfg.at_e_anywhere !== false,
        // Per-instance timing knobs (uncapped principle — operator
        // owns the limits, bridge ships with safe defaults that
        // protect against WA-protocol floors). undefined = bridge
        // default; any explicit number wins.
        editCadenceMs:     cfg.edit_cadence_ms,
        typingRefreshMs:   cfg.typing_refresh_ms,
        sendTimeoutMs:     cfg.send_timeout_ms,
        chunkChars:        cfg.chunk_chars,
        debug:             cfg.debug === true,
        // STRICT default 0 (operator 2026-05-23): "nothing that
        // happened pre-online is ever autodelivered." Any message
        // older than connectedAt is held → /wa-pending. cfg-side
        // value still wins when present (e.g. set to -1 to disable
        // the hold entirely, or a positive N for a grace window).
        maxBacklogSeconds: cfg.max_backlog_seconds != null
          ? Number(cfg.max_backlog_seconds)
          : 0,
        // Pass through whatsapp.media to the bridge. Defaults (set
        // inside the bridge) are { download: 'all', max_size_mb: 25 }
        // — every image / video / voice note / document / sticker is
        // saved automatically.
        media:             cfg.media ?? {},
        // CONTRACT C2: the bridge downloads each attachment + decides (via
        // whatsapp.media.download), then hands it here to land in the chat's
        // own media/ folder. Best-effort; never blocks the text dispatch.
        onMedia:           _saveIncomingMedia,
        // Beeper Desktop API token (transport: 'beeper'). config.local.json
        // beeper_token, or whatsapp.beeper_token, or BEEPER_ACCESS_TOKEN env.
        beeperToken:       EGPT_CONFIG.beeper_token ?? cfg.beeper_token ?? process.env.BEEPER_ACCESS_TOKEN,
        // Enrolled-chats rule for bridge-initiated sends (the beeper limb's
        // 👂 transcript ack) — SAME whitelist as the outbox: auto_e_chats +
        // self-DM. Reads EGPT_CONFIG live so /config edits apply without a
        // bridge restart. NOTE (transport=beeper): entries must match the
        // Beeper chatIDs the limb sees; the suppression log line in
        // ~/.egpt/logs/beeper.log prints the id to enroll.
        // Enrollment is an AUTHORIZATION boundary — matched on the STABLE
        // chat id ONLY, never a display name (operator 2026-06-10: "for
        // authorization, never rely on contact names; a stable id must be
        // used"). Chat titles are attacker-controllable (a contact can
        // rename a chat to impersonate an enrolled one); the Beeper room
        // id / WA jid is not. Deterministic NAMES are for conversation
        // storage + display + outbound addressing, never for the gate.
        isEnrolledChat:    (chatId) => {
          const wa = EGPT_CONFIG.whatsapp ?? {};
          return new Set([
            ...(Array.isArray(wa.auto_e_chats) ? wa.auto_e_chats : []),
            wa.chat_id,
          ].filter(Boolean)).has(chatId);
        },
        // Remote-first transcription (operator 2026-06-10): when
        // transcription_endpoint is set, voice notes go to the GPU worker
        // spine; ANY failure or timeout falls back to local whisper, so a
        // dead/asleep worker only costs speed. Null endpoint (or no token)
        // = pure local (the bridge's own default transcriber). Auth is the
        // shared transcription_token, same value on both machines.
        transcribe:        (EGPT_CONFIG.transcription_endpoint && EGPT_CONFIG.transcription_token)
          ? makeRemoteFirstTranscriber({
              endpoint: EGPT_CONFIG.transcription_endpoint,
              getKey: () => EGPT_CONFIG.transcription_token,
            })
          : undefined,
        // Override per-chat media destination so files land inside
        // the contact's slug-dir (operator 2026-05-20). Sync callback;
        // bridge falls back to the legacy ~/.egpt/media/<jid>/ path
        // when this returns null (chat not yet registered).
        mediaDirForChat:   (jid) => {
          try {
            const cs = _convStateCache;
            if (!cs) return null;
            // WA bridge only — every JID this callback sees is a WA jid.
            const r = conversationsState.getContact(cs, 'whatsapp', jid);
            if (!r) return null;
            // System-personality contacts share a single tree under
            // _system/system-e/ so voice notes + their transcripts +
            // brain dispatch records all live in one place. Operator
            // (2026-05-22): "media in conversations/whatsapp/ but the
            // transcript in system-e? all should live in _system/."
            if (r.entry?.personality === 'system') {
              return join(conversationsState.SYSTEM_SLUG_DIR, 'media');
            }
            return join(conversationsState.slugDir('whatsapp', r.slug), 'media');
          } catch (e) { console.error(`!! egpt.mjs:[catch] ${e?.message ?? e}`); return null; }
        },
        // Visible shell notice when a file is saved. Filters out
        // status@broadcast (the WA Status feed — every contact's
        // 24h stories, would flood the room) unless the config
        // explicitly opts in. notify: 'on' (default — chats only),
        // 'all' (include status), 'off' (silent — files still save,
        // shell just doesn't say so).
        onMediaSaved: ({ kind, chatJid, msgId, path, sizeBytes, deleted, msgKey, msgRaw, preConnect }) => {
          const notify = cfg.media?.notify ?? 'on';
          if (notify === 'off' && !_stormRef.current) return;
          // Normal mode silences status@broadcast (the high-volume
          // 24h-stories feed); storm and 'all' surface it too.
          if (notify === 'on' && !_stormRef.current && chatJid === 'status@broadcast') return;
          // Pre-connect (backlog) files: save to disk (already done by
          // the bridge), record to .media-index.json (already done),
          // but skip the visible 📎 sysOut. Files still surface in
          // the next logon summary's '📎 N files saved' tally; the
          // related WA message lives in /wa-pending and the operator
          // will see the 📎 line at dispatch time. Matches the
          // operator-trust principle: nothing pre-connect is
          // mirrored to shell / bridges / room md until reviewed.
          if (preConnect && !_stormRef.current) return;
          const sizeKB = (sizeBytes / 1024).toFixed(1);
          let chatLabel = chatJid.split('@')[0] ?? chatJid;
          try {
            const name = bridge?.getChatName?.(chatJid);
            if (name) chatLabel = name;
          } catch (e) { console.error(`!! egpt.mjs:[catch] ${e?.message ?? e}`); }
          // Wrap the displayed path in OSC 8 so terminals that support
          // hyperlinks (Windows Terminal, iTerm2, VS Code, GNOME
          // Terminal, etc.) let the operator Ctrl/Cmd-click to open
          // the file in the OS default viewer. Others see plain text.
          const pathDisplay = clickablePath(dp(path), path);
          // Attach a WA _replyTarget so '@wa-<msgId> body' (or any
          // unique prefix) replies to the original message that carried
          // the media. _stableIdForItem reads this and renders the
          // system line's stable id as wa-<msgId> instead of a random
          // s-<rnd>, making the reference both meaningful and
          // restart-stable. msgRaw enables proper WA-native quote
          // context; null is acceptable (replyTo falls back to an
          // empty quoted body).
          const replyTarget = msgKey && chatJid
            ? { kind: 'wa', chatId: chatJid, key: msgKey, raw: msgRaw ?? null }
            : null;
          const extras = replyTarget ? { _replyTarget: replyTarget } : {};
          if (deleted) {
            sysOut(`🗑 ${kind} deleted by sender (kept) from ${chatLabel}  ${pathDisplay}`, extras);
          } else {
            sysOut(`📎 ${kind} saved (${sizeKB}KB) from ${chatLabel}  ${pathDisplay}`, extras);
          }
        },
        // '@?' in-chat genie summon. The bridge fires this when the
        // operator (fromMe) types '@?' in any chat and no genie is
        // already running there. Default 3 wishes (genie default),
        // brain = oracle.brain config (default @e). Same code path
        // as the /oracle slash command, via tools/genie.mjs.
        onSummonGenie: async ({ chatId }) => {
          const wa = waBridgeRef.current;
          if (!wa) return;
          const chatName = wa.getChatName?.(chatId) || chatId;
          const brainName = EGPT_CONFIG?.oracle?.brain ?? 'e';
          const isPersona = (brainName === 'e' || brainName === 'egpt');
          if (!isPersona && !sessions[brainName]) {
            errOut(`@? summon: brain "${brainName}" not in room; set oracle.brain to "e" or /attach`);
            return;
          }
          // Inline compute-only brain dispatcher — same shape as
          // ctx.computeBrainTurn, can't borrow it from ctx since
          // this callback runs at bridge-setup time before any
          // slash invocation has populated a ctx for us.
          const computeBrainTurn = async (routedTo, question) => {
            if (routedTo === 'e' || routedTo === 'egpt') {
              try { return await runDefaultBrainTurn(question, () => {}); }
              catch (e) { return `!! @e failed: ${e.message}`; }
            }
            const session = sessions[routedTo];
            if (!session) return null;
            const brain = brainForName(session.brain);
            if (!brain?.stream) return null;
            const history = await readFile(FILE, 'utf8').catch(() => '');
            try {
              const result = await brain.stream(
                { history, message: question, ask: null },
                () => {},
                { ...session.options, sessionName: routedTo, userName: USER_NAME },
              );
              return typeof result === 'string'
                ? result
                : (result?.text ?? result?.content ?? '');
            } catch (e) {
              return `!! brain "${routedTo}" failed: ${e.message}`;
            }
          };
          try {
            const handle = await _summonGenieFromBridge({
              wa, chatId, chatName,
              questionsLeft: 3,
              brainName,
              computeBrainTurn,
              sysOut,
              busyBehavior: EGPT_CONFIG?.oracle?.busy_behavior ?? 'polite',
              frameMs: Number(EGPT_CONFIG?.oracle?.frame_ms) || 3000,
            });
            if (handle) sysOut(`🧞 @? summoned in "${chatName}"  (brain: @${brainName}, 3 wishes)`);
          } catch (e) {
            errOut(`@? summon failed: ${e.message}`);
          }
        },
        // '@movie' in-chat trigger. Operator (or an allowed_users
        // contact) types '@movie <preset> [args]' anywhere in a
        // message; the bridge passes us the trigger key and the
        // raw args. We share the parser with the /movie slash
        // command via buildMoviePayload, then call wa.playFrames
        // with existingKey set to the trigger message — so the
        // chat ends up with one message that morphs from the
        // typed command into the movie, and autoDelete revokes
        // it cleanly when the animation ends.
        onSummonMovie: async ({ chatId, triggerKey, argsStr }) => {
          const wa = waBridgeRef.current;
          if (!wa?.playFrames) return;
          const payload = _buildMoviePayload(argsStr);
          if (payload.error) {
            errOut(`@movie: ${payload.error}`);
            return;
          }
          const chatName = wa.getChatName?.(chatId) || chatId;
          const { frames, frameMs: ms, autoDelete, holdMs, presetName } = payload;
          const totalMs = frames.length * ms + (autoDelete ? holdMs : 0);
          sysOut(`🎬 @movie ${presetName} in "${chatName}"  (${frames.length} fr · ${ms}ms · ~${(totalMs / 1000).toFixed(1)}s${autoDelete ? ' · auto-delete' : ''})`);
          try {
            await wa.playFrames({
              chatId, frames, frameMs: ms, autoDelete, holdMs,
              existingKey: triggerKey,
            });
          } catch (e) {
            errOut(`@movie failed: ${e.message}`);
          }
        },
        onIncoming: async (text, from) => {
          const who = from.username ? `${from.username} (wa:${from.userId})` : `wa:${from.userId}`;
          logOut(`(whatsapp message from ${who}) -> ${text}`);
          const isCommand = text.trimStart().startsWith('/') || /^@\S+/.test(text.trimStart());
          if (isCommand && !from.authorized) {
            // Non-authorized sender. Slash commands are operator-only —
            // always drop (no /restart etc. from randos). A DIRECT @e/@egpt
            // wake-word is an explicit summon, so it ALWAYS reaches the persona
            // (operator 2026-05-25: "a mention to @e in a group should go to
            // conversation e") — this also covers the case where the operator's
            // own group message arrives without a clean fromMe (e.g. via
            // Beeper) and so reads as unauthorized. Other @-mentions (@someone,
            // @l, …) are allowed inside an auto_e_chat but dropped in merely
            // observed chats, so a random chat can't trigger the bot. Silent
            // drop either way — never reply to an unauthorized sender.
            const _t = text.trimStart();
            const _isSlash = _t.startsWith('/');
            const _isPersonaWake = /@(?:egpt|e)\b/i.test(_t);
            const _waCfg0 = EGPT_CONFIG.whatsapp ?? {};
            const _isAutoE0 = Array.isArray(_waCfg0.auto_e_chats)
              && _waCfg0.auto_e_chats.includes(from.chatId);
            if (_isSlash) return;
            if (!_isAutoE0 && !_isPersonaWake) return;
          }
          // Lifecycle commands restricted to 1:1 chats, same as Telegram.
          const LIFECYCLE = new Set(['/rewind', '/upgrade', '/restart', '/exit', '/chrome']);
          const firstTok = text.trimStart().split(/\s+/)[0];
          if (LIFECYCLE.has(firstTok)) {
            if (from.chatType !== 'private') {
              bridge.send(`${firstTok} only works in a 1:1 chat — DM me and try again`,
                { chatId: from.chatId });
              return;
            }
            // Immediate WA ack, sent on the LIVE socket BEFORE dispatch+exit.
            // Otherwise the operator gets no WhatsApp feedback and "can't tell if
            // it's running" (operator 2026-06-01): the announceBounce pre-ack is
            // queued to the outbox, but the process exits in ~1s — faster than the
            // 2s outbox sweep — so the dying process never flushes it, and the
            // engine's "exiting…" sysOut only reaches the shell. The respawned
            // spine still posts "✅ back online" once it reconnects.
            if (firstTok === '/restart' || firstTok === '/upgrade' || firstTok === '/rewind') {
              // Send the ack and give it up to ~1.5s to flush on the live socket
              // — but NEVER let it block the exit. A bare `await bridge.send`
              // hangs (it waits on a socket about to be torn down), so the spine
              // ack'd "on it" but never reached exitClean (operator 2026-06-01:
              // "stays saying 'on it' but doesn't harakiri"). The RESTART is the
              // priority; the ack is best-effort within the 1.5s window (plus
              // _exitClean's 800ms WS-close flush).
              // This ack is a SYSTEM message → it may ONLY go to the operator's
              // self-DM (configured chat_id), NEVER the chat /restart happened
              // to arrive in (operator 2026-06-04: system messages are
              // structurally limited to Self). If no chat_id is configured, skip
              // the immediate ack entirely — the respawned spine still posts
              // "egpt back!" (also self-gated via the outbox). The self-DM also
              // dodges the @lid-doesn't-surface problem from 2026-06-03.
              const _ackJid = EGPT_CONFIG.whatsapp?.chat_id || null;
              if (_ackJid) try {
                await Promise.race([
                  bridge.send(`🧠 ${firstTok.slice(1)} initiated… (pid ${process.pid} going down)`, { chatId: _ackJid }).catch(() => {}),
                  new Promise(res => setTimeout(res, 1500)),
                ]);
              } catch {}
            }
          }
          // Interactive help menu — only the account owner (authorized) drives
          // it, in whichever chat /help was invoked. Consumes the owner's
          // numbers/text before the auto-mode broadcast; others pass through.
          if (_maybeHandleHelp(text, { surface: 'whatsapp', chatKey: from.chatId, isOperator: !!from.authorized, chatId: from.chatId })) {
            return;
          }
          // Egpt-chat vs observed-chat distinction lives in
          // bridges/whatsapp-classify.mjs so the rule set is
          // testable. Read EGPT_CONFIG.whatsapp fresh — onChatId
          // updates in-memory before any await, so the very message
          // that triggered the capture sees the correct chat_id on
          // this same tick.
          const { observeOnly: classifiedObserve } = classifyWhatsAppChat({
            chatId: from.chatId,
            bridgeInfo: {
              myJid:        waBridgeRef.current?.myJid ?? null,
              myLid:        waBridgeRef.current?.myLid ?? null,
              myLidNumber:  waBridgeRef.current?.myLidNumber ?? null,
              selfDmJid:    waBridgeRef.current?.selfDmJid ?? null,
            },
            waConfig: EGPT_CONFIG.whatsapp ?? {},
          });
          // /join @waN lifts an otherwise-observed chat into full
          // visibility: render in the transcript, broadcast on the bus,
          // mirror to peer bridges. Single-chat opt-in — every other
          // observed chat stays silent. /storm overrides everything
          // (storm = render every WA arrival regardless).
          // Incoming gate: only let the chat into shell if its
          // direction allows inbound (default 'both' or 'in').
          // 'out'-only bindings are write-only — we don't render
          // arrivals from those.
          const joinedToThis = _waJoinedHas(from.chatId) && _waJoinedIncomingAllowed(from.chatId);
          const observeOnly = !_stormRef.current && classifiedObserve && !joinedToThis;
          // Swap the @<client> segment of the cross-surface handle
          // based on chat type, so the operator (and the brain) sees
          // WHERE the message came from at a glance:
          //   - group     -> '<group-slug>.wa'  (e.g. 'An@auge_family.wa')
          //   - status    -> 'status.wa'        (WhatsApp status broadcast feed)
          //   - private   -> bridge client_name  (DM kept as 'An@moto')
          // The 1:1 case keeps the device tag because a DM really IS a
          // chat with one person via that device; the group/status
          // cases override because the channel identity matters more
          // than which phone happens to be running the bridge.
          let waClientLabel = null;
          if (from.chatType === 'group') {
            const slug = waBridgeRef.current?.getChatSlug?.(from.chatId);
            if (slug) waClientLabel = `${slug}.wa`;
          } else if (from.chatType === 'status') {
            waClientLabel = 'status.wa';
          }
          // @e auto-dispatch: every notify-type message reaching
          // onIncoming gets @e-prefixed so @e reads every chat the
          // operator does. Operator (2026-05-17): "e must reply only
          // on authorized channels, but read everything." Read = all
          // chats that survive the bridge's awareness gate. Write =
          // restricted to whatsapp.auto_e_chats + self_dm by 35c740d
          // (enforced bridge-side on outbox wa-sends from 'e'). The
          // auto_e_chats list is now exclusively the write-whitelist
          // (also the bridge-bypass list per 05e1f82 — same chats).
          //
          // Skipped when:
          //   - operator-level pause is set (auto_e_paused === true)
          //   - text already begins with @<mention> (operator/another
          //     persona is explicitly addressed; honor that)
          //   - text is a slash command (starts with /)
          //   - chat is NOT in auto_e_chats — only enrolled chats get
          //     the free-post @e dispatch. Operator (2026-05-20):
          //     'router-wise, e can only answer to direct mention or
          //     post freely in auto_e_chats.' Direct @e mentions still
          //     work everywhere because hasMention catches them above
          //     and submitInner routes them through @-resolution.
          const waCfg = EGPT_CONFIG.whatsapp ?? {};
          const autoPaused = !!waCfg.auto_e_paused;
          const isAutoEChat = Array.isArray(waCfg.auto_e_chats)
            && waCfg.auto_e_chats.includes(from.chatId);
          // Implicit auto-dispatch: any contact whose personality is
          // 'system' (operator's own surfaces — Self DM lid form, Self
          // DM phone-number form, etc.) gets the same plain-text
          // auto-prefix as auto_e_chats members. Operator (2026-05-22):
          // saw their s.whatsapp.net Self get silently observed-only
          // because the lid form was the only one in auto_e_chats.
          // personality='system' is the canonical "this is the operator
          // talking to themselves" marker — honor it everywhere.
          const isSystemContact = (() => {
            try {
              const entry = _convStateCache?.contacts?.whatsapp?.[from.chatId];
              if (!entry) return false;
              if (entry.aliasOf) {
                const primary = _convStateCache.contacts.whatsapp[entry.aliasOf];
                return primary?.personality === 'system';
              }
              return entry.personality === 'system';
            } catch (e) { return false; }
          })();
          const trimmed = String(text ?? '').trimStart();
          const isSlash = trimmed.startsWith('/');
          const _personaBeing = EGPT_CONFIG.persona ?? 'e';
          // Per-chat auto mode. The operator's own surfaces (system contact)
          // are always 'on'. A per-chat mode wins; then legacy auto_e_chats
          // membership (→ 'on'); then the global default (auto_e_default_mode,
          // set by `/e auto <mode> all`); then the built-in default ('mention').
          const _autoMode = _resolveChatAutoMode(from.chatId);
          // 'off' = NO egpt on this chat at all: no room routing, no transcript,
          // no command execution, no @e (operator 2026-06-03: "off means no egpt
          // whatsoever in that surface/channel/group … not even logging should
          // occur, nor commands be processed"). The engine treats the chat as
          // nonexistent; manage its mode from an active chat (Self) via
          // `/e auto <mode> --slug <name>`. NOTE: media download + lid-learning
          // still run bridge-side (before onIncoming) — pushing the off-filter
          // fully into the bridge/awareness layer is a follow-up.
          if (!autoReceives(_autoMode)) return;
          // replyAllowed: does this message's mention-status permit a reply
          // under the chat's mode? (E may still be invoked for context when
          // false.) Unused for accum (buffered + flushed on the heartbeat).
          const _replyAllowed = autoReplyAllowed(_autoMode, {
            atEStart:    !!from.atEStart,
            atEAnywhere: !!from.atEAnywhere,
            replyToBot:  !!from.replyToBot,
          });
          // Announce the reply mode to @e only when it CHANGED (or first contact
          // this run) — E remembers; no need to repeat it every turn.
          const _modeChanged = _announcedMode.current.get(from.chatId) !== _autoMode;
          if (_modeChanged) _announcedMode.current.set(from.chatId, _autoMode);
          // Room fan-out (independent of the per-chat auto-mode dispatch below).
          // Gated + loop-safe; no-op unless this chat is a contributing room member.
          // Route every inbound — execution (the bridge's own command handling)
          // and routing (transcript + mirror to room members) are independent.
          // Whether a member CONTRIBUTES is the room member's state (active /
          // mention / mute), not the message kind.
          //
          // Enriched senderLabel — when a room aggregates multiple WA groups,
          // a bare "An:" in the envelope is ambiguous; readers can't tell
          // WHICH group it came from (operator 2026-05-29: "the identification
          // of who is writing is missing the group name"). Format:
          //   {pushName}@{chatName}.wa (HH:MM)
          // Falls back to the jid prefix when the chat name isn't resolvable.
          {
            const _chatName = waBridgeRef.current?.getChatName?.(from.chatId)
              ?? String(from.chatId ?? '').split('@')[0]
              ?? '?';
            const _hhmm = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
            const _routedSender = `${from.senderName ?? '?'}@${_chatName}.wa (${_hhmm})`;
            _maybeRouteToRooms({ memberId: from.chatId, senderLabel: _routedSender, body: text })
              .catch(e => errOut(`!! _maybeRouteToRooms(wa): ${e?.message ?? e}`));
          }
          const baseMeta = {
            fromWhatsApp: true,
            waChatId: from.chatId,
            waUser: from.username ? `@${from.username}` : `wa:${from.userId}`,
            waClientLabel,
            waMsgKey: from.msgKey ?? null,
            waMsgRaw: from.msgRaw ?? null,
            observeOnly,
            // A reaction notification — E may read it for context but must NEVER
            // reply to it, in ANY mode (mayEmit hard-blocks on this).
            isReaction: !!from.isReaction,
            // Per-chat auto-mode reply gate: when false, residents still RUN
            // (E reads for context) but their reply is NOT sent to the chat.
            replyAllowed: _replyAllowed,
            // One-line statement of the chat's reply mode — injected only when
            // the mode changed (see _modeChanged), so E learns its engagement
            // contract once per change instead of every turn.
            modeNote: _modeChanged ? _modeNote(_autoMode) : null,
            // Operator's whitelisted spaces (auto_e_chats + self) — lets the
            // resident-broadcast meta dispatches (e.g. @l) bypass observe-only
            // suppression.
            waWhitelisted: isAutoEChat || isSystemContact,
            // Did the OPERATOR (account owner, any device) send this? isSender
            // is the only trustworthy operator signal. Lets an operator-typed
            // @<sibling> bypass observe-only in ANY chat (their deliberate
            // intent), while a non-operator's @<sibling> stays suppressed in
            // non-whitelisted chats — so random members can't invoke siblings.
            authorized: !!from.authorized,
            // Voice transcript marker → envelope hint "(transcript from voice
            // note)". Every resident reads the transcript.
            isTranscriptFromVoice: !!from.isTranscriptFromVoice,
            replyPersona: from.replyPersona ?? null,
            waSenderName: from.senderName ?? null,
            voiceStream: from.voiceStream ?? null,
          };
          // RESIDENT BROADCAST — operator 2026-05-24 ("no faking anymore").
          // In auto_e_chats / self, every non-command message is sent RAW to
          // each resident brain (no "@e " text injection). Each being self-
          // selects whether to answer (a '…' reply is dropped), so @e AND @l
          // (and any future resident) both SEE every message — including
          // voice transcripts and image/video placeholders — and reply only
          // when they should. An explicit "@l ..." is just content the brains
          // read: @l answers, @e sees it and stays quiet via /rules. Slash
          // commands + non-resident chats fall through to one normal dispatch
          // (observe-only / wake-word handling downstream).
          if (submitRef.current) {
            // CATCH-UP first: a message tagged backlog (arrived while we were
            // offline) is buffered per chat and flushed to E as ONE timestamped
            // chunk once the burst settles — not a dispatch per stale message
            // (see _backlogPush). 'off' already returned above; paused or slash
            // backlog falls through to the normal record/handle path (we don't
            // auto-run a stale brain turn while paused, nor execute a stale
            // slash). The chat-mode reply gate (_replyAllowed) rides along so
            // the consolidated turn replies only where the mode permits.
            if (from.backlog && !isSlash && !autoPaused) {
              _backlogPush(from.chatId,
                { body: text, senderName: from.senderName ?? 'someone', ts: from.backlogTsMs || Date.now() },
                _replyAllowed,
                baseMeta);
              return;
            }
            // Reception: every mode except 'off' broadcasts to the residents so
            // E (haiku) reads the chat. The per-message `replyAllowed` (in
            // baseMeta) gates whether each reply is actually sent. 'off' falls
            // through to the slash-only else branch (E never sees it).
            if (!isSlash && !autoPaused && _autoMode === 'accum') {
              // accum: buffer this message; the heartbeat flushes the batch as
              // one combined turn (reply only if the batch was mentioned).
              _accumPush(from.chatId,
                { body: text, senderName: from.senderName ?? 'someone', ts: Date.now() },
                { atEAnywhere: !!from.atEAnywhere, replyToBot: !!from.replyToBot },
                baseMeta);
            } else if (!isSlash && !autoPaused && autoReceives(_autoMode)) {
              // Each resident is fed the canonical [Sender@chat (HH:MM)]: body
              // envelope (built in the dispatch handlers) and that exact string
              // is mirrored to Self by the watcher tap. _chainDepth:0 marks
              // these as broadcast turns — replies re-circulate to the other
              // residents (see _recirculateResidentReply) up to the cap.
              // Resident list for THIS chat: a per-chat override
              // (whatsapp.residents_per_chat[jid]) wins, else the global
              // residents list, else the persona alone. Lets a chat run @l-only
              // (drop @e there to spare the Claude plan's 5h window) or @e-only.
              // residents accepts a plain list (["e","l"]), a list of toggles
              // ([{e:true},{l:false}]), or an enable-map ({e:true,l:false}) —
              // normalizeResidents flattens any of them to the enabled names.
              const _perChatResidents = conversationsState.normalizeResidents(EGPT_CONFIG.whatsapp?.residents_per_chat?.[from.chatId]);
              const _globalResidents  = conversationsState.normalizeResidents(EGPT_CONFIG.whatsapp?.residents);
              let residents = _perChatResidents.length ? _perChatResidents
                : (_globalResidents.length ? _globalResidents : [_personaBeing]);
              // UNIFIED @<mention> ROUTING (Wren, 2026-06-10): a message that
              // explicitly @<mention>s a registered sibling NOT already resident
              // joins THIS turn's dispatch — so @me/@jay/@l2/etc. route through
              // the SAME nucleus path the shell uses (the limb is a dumb pipe).
              // Matched by canonical name OR alias; the persona is already a
              // resident (its @e gate rides baseMeta.replyAllowed).
              const _mentionedSiblings = [];
              for (const [_sn, _se] of Object.entries(EGPT_CONFIG.siblings ?? {})) {
                if (_sn === _personaBeing) continue;
                if (_bodyMentionsAny(text, [_sn, ...((_se?.aliases) ?? [])])) _mentionedSiblings.push(_sn);
              }
              if (_mentionedSiblings.length) residents = [...new Set([...residents, ..._mentionedSiblings])];
              // Debug-mirror telemetry (the /e confirm "Debug: …" lines that
              // deliverEcho posts into the Self DM) must be SEEN by the Self
              // residents but must NOT drive the residents-converse engine —
              // otherwise the high-volume debug stream + re-circulation form a
              // self-sustaining loop in the Self chat (operator 2026-05-25:
              // "keeps recircling in telegram"). Omit _chainDepth for them, so
              // replies to debug never re-circulate.
              const isDebugMirror = /^Debug:\s/.test(String(text).trimStart());
              // (@l is stateless — no conversation-L transcript is recorded.)
              // ORDER: dispatch explicitly-@<mentioned> siblings FIRST so a
              // direct address (@jay/@me/@l) isn't stuck behind @e's turn —
              // @e's session is large/slow, and on a sibling-addressed message
              // @e is usually silent anyway. @e still runs (for context), just
              // after the addressed sibling has already replied. Serial model
              // unchanged (safe w.r.t. the residents-converse recirculation);
              // only the order changes. (operator 2026-06-11: kill the wait.)
              const _residentOrder = [
                ...residents.filter((r) => _mentionedSiblings.includes(r)),
                ...residents.filter((r) => !_mentionedSiblings.includes(r)),
              ];
              for (const being of _residentOrder) {
                // An explicitly-@<mentioned> sibling was ADDRESSED → it may emit;
                // its reply isn't gated by @e's mention status. Persona +
                // unmentioned residents keep baseMeta.replyAllowed.
                const _addressed = _mentionedSiblings.includes(being);
                if (_isLlamaBeing(being)) logOut(`@${being} dispatch ${baseMeta.waChatId ?? from.chatId}: addressed=${_addressed}`);
                await submitRef.current(text, {
                  ...baseMeta,
                  forceTarget: being,
                  ...(_addressed ? { replyAllowed: true } : {}),
                  ...(isDebugMirror ? {} : { _chainDepth: 0 }),
                  // Every resident gets per-chat coalescing backpressure now:
                  // @e via the persona queue, @l (and other siblings) via the
                  // resident queue in the meta branch. A burst of group
                  // messages drains as one combined turn instead of one
                  // inference per message (which buried the slow local @l).
                  autoDispatched: true,
                });
              }
            } else {
              // Record to the CHAT's OWN transcript (the 1:1 or group), brain-
              // free + no fan. Every utterance lands in its chat transcript, and
              // ADDITIONALLY in any room transcript the chat belongs to (handled
              // by _maybeRouteToRooms above) — operator 2026-06-03: "written both
              // in room transcript (if she's in a room) and in the group's or
              // 1:1's chat transcript". This branch is reached, for a non-'off'
              // chat, by:
              //   - a /command (always lands here): recorded as part of the
              //     chat's history; submit below still EXECUTES it (it is not
              //     dispatched/fanned as chatter), and
              //   - @e PAUSED chatter, which would otherwise vanish.
              // Skip the messages the submit below itself dispatches+logs to the
              // chat transcript (an @e-mention or reaction while paused) to avoid
              // a double entry. 'off' chats are never logged (deliberate ignore).
              const _logToChat = autoReceives(_autoMode)
                && (isSlash || (!from.isReaction && !from.atEAnywhere && !from.atEStart));
              if (_logToChat) {
                _recordInboundOnly(from, text).catch(e => errOut(`!! inbound-log: ${e?.message ?? e}`));
              }
              await submitRef.current(text, { ...baseMeta, autoDispatched: false });
            }
          }
        },
        // The bridge fires this after it finishes processing an offline-backlog
        // upsert batch (sleep/restart catch-up). Flush the accumulated per-chat
        // catch-up to E now — one consolidated turn per chat. No timer: this is
        // the real delivery boundary.
        onBacklogDelivered: () => { try { _backlogFlush(); } catch (e) { errOut(`!! backlog flush: ${e?.message ?? e}`); } },
        onLog:   (msg) => logOut(`whatsapp: ${msg}`),
        onError: (msg) => errOut(`!! whatsapp: ${msg}`),
        onQR: (_qrText, msgWithHeader) => {
          // QR code goes to sysOut (visible main transcript), not the
          // hidden /log buffer. Otherwise `/whatsapp pair` would wipe
          // auth, print 'restarting bridge — QR coming up', and then
          // bury the QR where the user can't see it.
          sysOut(msgWithHeader);
        },
        onChatId: async (id) => {
          // CRITICAL: update the in-memory EGPT_CONFIG SYNCHRONOUSLY
          // before any await. The bridge calls onChatId fire-and-
          // forget and immediately fires onIncoming on the same
          // message — if we delay the in-memory write behind an
          // await readFile / writeFile, onIncoming sees stale state
          // and classifies the very message that triggered the
          // capture as observe-only. With this synchronous update,
          // the egpt-chat check (which reads EGPT_CONFIG.whatsapp
          // .chat_id fresh) sees the new value on the same tick.
          if (typeof EGPT_CONFIG.whatsapp !== 'object' || EGPT_CONFIG.whatsapp === null) {
            EGPT_CONFIG.whatsapp = {};
          }
          EGPT_CONFIG.whatsapp.chat_id = id;
          // Then async-persist to disk so future runs default to
          // this chat without recapture.
          const { readConfig, writeConfig } = await import('./src/tools/config-io.mjs');
          const saved = await readConfig();
          if (!saved.whatsapp || typeof saved.whatsapp !== 'object') saved.whatsapp = {};
          if (saved.whatsapp.chat_id === id) return;
          saved.whatsapp.chat_id = id;
          try {
            await writeConfig(saved);
            logOut(`whatsapp: outbound chat ${id} captured and saved`);
          } catch (e) { console.error(`!! egpt.mjs:[catch] ${e?.message ?? e}`); }
        },
        // The WA bridge self-detected a WEDGED socket it can't recover in-
        // process. Supervision model: one egpt-daemon, respawn on process
        // EXIT, NO external liveness-kill. So the SUPERVISED spine exits with a
        // crash code (non 0/42/43/44 → egpt-daemon.mjs's backoff respawn path)
        // and a clean process re-establishes WA. A bare `node egpt.mjs` has NO
        // supervisor, so exiting would just kill the operator's shell — there
        // we only log loudly and leave it for an explicit /restart.
        wedgedGraceMs: Number(EGPT_CONFIG.whatsapp?.wedged_grace_ms) > 0
          ? Number(EGPT_CONFIG.whatsapp.wedged_grace_ms) : undefined,
        onFatal: (reason) => {
          const supervised = !!process.env.EGPT_SUPERVISED;
          const line = `whatsapp bridge WEDGED — ${reason} — ${supervised ? 'exiting (code 75) for egpt-daemon respawn' : 'no supervisor; staying up, use /restart'}`;
          try { errOut(`!! ${line}`); } catch { /* Ink may be torn down */ }
          try {
            appendFileSync(join(EGPT_LOGS, 'headless.log'),
              `[${new Date().toISOString()}] FATAL ${line}\n`, { mode: 0o600 });
          } catch { /* best effort */ }
          if (!supervised) return;
          // Brief delay so the log lines flush, then crash-exit; the daemon
          // respawns with backoff (capped 60s), so a persistent outage can't
          // hot-loop.
          setTimeout(() => { try { process.exit(75); } catch { /* already exiting */ } }, 300);
        },
      };
      // Transport policy (operator 2026-06-10): beeper default + preferred,
      // cdp explicit fallback, baileys REMOVED ("remove baileys completely").
      const _waTransport = resolveWaTransport(EGPT_CONFIG.whatsapp ?? {});
      logOut(`whatsapp: transport=${_waTransport}${EGPT_CONFIG.whatsapp?.transport ? '' : ' (default)'}`);
      if (EGPT_CONFIG.whatsapp?.transport === 'baileys') {
        logOut('whatsapp: transport "baileys" was REMOVED (operator 2026-06-10) — starting beeper instead. Set whatsapp.transport: beeper (+ beeper_token) or cdp.');
      }
      const _starter = _waTransport === 'cdp' ? startWhatsAppCdpBridge : startBeeperBridge;
      const bridge = await _starter(_bridgeOpts);
      waBridgeRef.current = bridge;
      _globalWaBridge = bridge;
      _walog(`waBridgeRef SET (bridge=${!!bridge}) — outbound should now work`);
      // Seed the bypass set with auto_e_chats jids so fromMe + non-
      // mentioned member messages reach the auto-dispatch path (vs
      // being dropped by the default 'mentions' awareness gate).
      // Joined chats merge in via _waJoinedAdd → _syncBypassToBridge.
      _syncBypassToBridge();
      // Twin-soul phase 2b: spin up the stream factory bound to this
      // bridge. Reads streaming knobs fresh from EGPT_CONFIG so the
      // operator can re-tune update_coalesce_ms / finish_timeout_ms
      // without restart. createInProcessStreamChannel wraps the
      // bridge in-process today; the file-IPC variant slots in later
      // when the keeper runs as its own process.
      const streamCfg = EGPT_CONFIG.streaming ?? {};
      const streamChannel = createInProcessStreamChannel(bridge);
      streamFactoryRef.current = (initialText, opts = {}) => {
        // ── THE single WhatsApp emit chokepoint ──────────────────────────────
        // EVERY model reply that reaches a WA chat is a stream opened HERE (the
        // "⌛ thinking…" placeholder + its updates/finish). Gating here makes a
        // leak structurally impossible: the only way to put text in a WA chat is
        // through this gate, so a path that forgets to gate (or a future new
        // path) CANNOT leak — it just gets nothing.
        //
        // FAILS CLOSED: a caller that omits replyAllowed, or a chat whose mode
        // forbids a reply (mute/off/mention-without-@e) or the global
        // auto_e_paused kill, gets `null` — NOT a no-op stream. Returning null
        // (vs a dead handle) matters: a dead handle would later report
        // `!delivered` and trip the raw fallback-send, re-leaking. With null the
        // caller's `?.` no-ops and its `if (stream)` branch is skipped entirely.
        // The lone bypass is opts.system (restart acks etc., separately gated).
        if (!opts.system &&
            !_eMayReplyToChat(opts.chatId, { replyAllowed: opts.replyAllowed, isReaction: opts.isReaction })) {
          return null;
        }
        return streamChannel.makeStream(initialText, opts, {
          ...(typeof streamCfg.update_coalesce_ms === 'number'
            ? { updateCoalesceMs: streamCfg.update_coalesce_ms } : {}),
          ...(typeof streamCfg.finish_timeout_ms === 'number'
            ? { finishTimeoutMs: streamCfg.finish_timeout_ms } : {}),
        });
      };
      logOut('whatsapp bridge enabled');
      return true;
    } catch (e) {
      pushItem({ id: Date.now() + Math.random(), author: 'system', body: `!! whatsapp: ${e.message}`, _localOnly: true });
      return false;
    }
  }, []);

  const stopWaBridge = useCallback(() => {
    if (!waBridgeRef.current) return false;
    _walog('waBridgeRef CLEARED (stopWaBridge called) — outbound will now drop until re-set');
    waBridgeRef.current.stop();
    waBridgeRef.current = null;
    streamFactoryRef.current = null;
    _globalWaBridge = null;
    pushItem({ id: Date.now() + Math.random(), author: 'system', body: 'whatsapp bridge stopped', _localOnly: true });
    return true;
  }, []);

  useEffect(() => {
    startWaBridge();
    return () => stopWaBridge();
  }, [startWaBridge, stopWaBridge]);

  // ── Local LLM (@l) supervisor ────────────────────────────────────
  // Operator 2026-05-24: @l kept failing "fetch failed" because
  // llama-server isn't auto-managed (dies on crash, never relaunched).
  // The DAEMON spawns it at startup and respawns on exit (same proven
  // node-spawn as whisper-server). The daemon's own boot-trigger covers
  // reboots → llama returns whenever the daemon does. Only the headless
  // daemon supervises (interactive shells must not spawn a duplicate that
  // would fight for the port). Config: EGPT_CONFIG.local_llm
  // { enabled, bin, cwd?, model_path, port, threads, extra_args }.
  useEffect(() => {
    if (!HEADLESS) return;
    const cfg = EGPT_CONFIG.local_llm;
    // OPT-IN: the local llama-server only starts when local_llm.enabled is
    // explicitly true (default off — most installs have no local model, and a
    // missing/wrong model_path would just spam respawn errors). Toggle with
    // /e llama on (persists enabled:true). whatsapp, by contrast, defaults on.
    if (!cfg || cfg.enabled !== true) return;
    const bin = cfg.bin;
    const model = cfg.model_path;
    const cwd = cfg.cwd || (bin ? dirname(bin) : undefined);
    if (!bin || !existsSync(bin) || !model || !existsSync(model)) {
      errOut(`!! local_llm: bin/model missing (bin=${bin}, model=${model}) — @l won't auto-start`);
      return;
    }
    const port = Number(cfg.port) || 11434;
    const threads = Number(cfg.threads) || 8;
    const args = ['-m', model, '--port', String(port), '-t', String(threads),
      ...(Array.isArray(cfg.extra_args) ? cfg.extra_args.map(String) : [])];
    let proc = null, stopped = false, backoff = 2000, stableTimer = null;
    const spawnIt = () => {
      if (stopped) return;
      // Free :port first — a llama-server orphaned by a soft /restart (Windows
      // doesn't kill the child with its parent) would still hold it and block
      // this bind, silently pinning @l to the OLD model. The daemon is elevated
      // so it can reap it; no manual taskkill. See reap-port.mjs.
      reapPort(port, logOut);
      logOut(`local_llm: starting llama-server :${port} (${String(model).split(/[\\/]/).pop()})`);
      try {
        proc = spawn(bin, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        _globalLlamaProc = proc;   // so _exitClean can kill it — see /restart
      } catch (e) {
        errOut(`!! local_llm spawn: ${e?.message ?? e}; retry in ${backoff}ms`);
        setTimeout(spawnIt, backoff); backoff = Math.min(backoff * 2, 30000); return;
      }
      proc.stderr?.on('data', (d) => {
        const s = d.toString();
        if (/error|fail|listening|model loaded|couldn't bind/i.test(s)) logOut(`local_llm: ${s.trim().slice(0, 160)}`);
      });
      proc.on('exit', (code) => {
        if (_globalLlamaProc === proc) _globalLlamaProc = null;
        proc = null;
        if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
        if (stopped) return;
        errOut(`local_llm: llama-server exited code=${code}; respawning in ${backoff}ms`);
        setTimeout(spawnIt, backoff); backoff = Math.min(backoff * 2, 30000);
      });
      stableTimer = setTimeout(() => { if (proc && !stopped) backoff = 2000; }, 60000);
    };
    spawnIt();
    return () => { stopped = true; if (stableTimer) clearTimeout(stableTimer); try { proc?.kill(); } catch {} _globalLlamaProc = null; };
  }, []);

  // Outbox watcher — extracted to ./egpt-comm-handler.mjs as the first
  // step of the twin-soul split (see projects/egpt/play.md). Still
  // in-process this commit; future phases move it to its own process
  // and add inbox-side WA inbound delivery via the same file IPC.
  // dispatchWaSend goes through the ref so this useEffect doesn't
  // re-mount on every change.
  useEffect(() => {
    if (CLIENT) return;   // outbox is a spine-side WA-send queue, not a limb's job
    const sysLog = (msg) => pushItem({
      id: Date.now() + Math.random(), author: 'system', _localOnly: true, body: msg,
    });
    return startOutboxWatcher({
      outboxDir:              join(EGPT_HOME, 'outbox'),
      dispatchWaSend:         (payload, src) => dispatchWaSendRef.current?.(payload, src),
      dispatchWaGroupSubject: (payload, src) => dispatchWaGroupSubjectRef.current?.(payload, src),
      dispatchWaGroupMembers: (payload, src) => dispatchWaGroupMembersRef.current?.(payload, src),
      dispatchSlash:          (payload, src) => dispatchSlashRef.current?.(payload, src),
      dispatchButlerTask:     (payload, src) => dispatchButlerTaskRef.current?.(payload, src),
      log:                    sysLog,
      // process.exit(0) → wrapper's while-loop respawns. Post-split
      // this becomes a restart-handler event the keeper sends to
      // the wrapper, without exiting the keeper itself.
      signalRestart:  () => setTimeout(() => process.exit(0), 100),
    });
  }, []);

  // Phase 2c step 3a (passive listener): handler-side inbox watcher.
  // Today the handler still owns baileys via startWaBridge, so any
  // wa-inbound events arriving in ~/.egpt/inbox/ would double-dispatch
  // if we routed them through submitRef. Until the keeper is the SOLE
  // baileys owner (Phase 2c step 4: handler stops calling
  // startBaileysBridge, daemon-wrap.ps1 spawns keeper alongside),
  // the listener is passive: it logs every received event to /log
  // but does NOT dispatch. That proves the wire works end-to-end
  // (file IPC → handler) without risking the double-dispatch.
  // When the operator flips the handler-side gate (config flag or
  // env var, TBD), this onEvent gets replaced with real dispatch
  // via the extracted processWaIncoming function.
  useEffect(() => {
    if (CLIENT) return;   // inbox is a spine-side WA-inbound watcher
    const sysLog = (msg) => pushItem({
      id: Date.now() + Math.random(), author: 'system', _localOnly: true, body: msg,
    });
    return startInboxWatcher({
      inboxDir: join(EGPT_HOME, 'inbox'),
      log: sysLog,
      onEvent: (ev) => {
        // Passive: log and consume so files don't pile up. Real
        // dispatch lands when the keeper actually owns baileys.
        const t = ev?.type ?? '<missing>';
        const from = ev?.from ?? '?';
        const preview =
          t === 'wa-inbound' ? ` chat=${ev.chatId} body=${JSON.stringify(String(ev.body ?? '').slice(0, 60))}`
          : t === 'wa-chat-id' ? ` chat=${ev.chatId}`
          : t === 'wa-media-saved' ? ` ${ev.kind} ${ev.chatJid} ${(ev.sizeBytes ?? 0)}b`
          : '';
        sysLog(`inbox[${from}]: ${t}${preview}  (passive — not dispatched, keeper-as-baileys-owner not yet wired)`);
        return true;  // consume so the file is unlinked
      },
    });
  }, []);

  // Periodic background ticks: accum-mode flush, the (confined) per-contact
  // heartbeat scanner, and the play.md rotator. There is deliberately NO
  // global @e heartbeat here anymore — see the note in `tick` below.
  useEffect(() => {
    const HEARTBEAT_MS = 5 * 60 * 1000;

    // sysLog → visible system line (errors / notable events). Routine per-tick
    // telemetry stays out of the shell.
    const sysLog = (msg) => pushItem({
      id: Date.now() + Math.random(), author: 'system', _localOnly: true, body: msg,
    });

    let stopped = false;

    const tick = async () => {
      if (stopped) return;
      // accum-mode chats: buffer bursts, flush as ONE combined turn on this
      // cadence.
      //
      // The old GLOBAL @e heartbeat that fired here was REMOVED (operator
      // 2026-06-03: "remove this rogue, legacy heartbeat completely"). It was
      // an UNCONFINED runDefaultBrainTurn on the 'system' surface — cwd = the
      // repo, Bash enabled — whose prompt told @e to self-emit by writing
      // wa-send files into ~/.egpt/outbox/. That was both conversation-e's
      // path into the repo AND an ungated emit side-channel. A heartbeat is
      // now a property of a CONVERSATION or a ROOM, dispatched through the
      // same confined + bridge-gated path as any reply — see perContactTick
      // below (and the per-room heartbeat, [[heartbeat-per-room-config]]).
      try { _accumFlush(); } catch (e) { sysLog(`!! accum flush: ${e?.message ?? e}`); }
    };

    // ── Heartbeat scanner ──────────────────────────────────────────────
    // A heartbeat is a property of an ENTITY (a conversation or a room),
    // configured by files in that entity's own folder and read FRESH each
    // scan (config.yaml + heartbeat.md; see src/heartbeats.mjs). Every
    // heartbeat is dispatched through the SAME confined + bridge-gated path
    // as a normal reply — it can never reach a surface a reply couldn't.
    // The sidecar heartbeat.state.json tracks lastFiredAt per entity.

    // Conversation heartbeat: run @e CONFINED for the chat (threadId=jid →
    // per-contact confine branch → cwd = the conversation folder, not the
    // repo), then emit only if the chat's gate permits an UNPROMPTED message.
    // A heartbeat carries no incoming @mention, so we gate with
    // replyAllowed:false → _eMayReplyToChat lets it through in 'on' mode only,
    // and NEVER when muted/off/mention(-direct) or auto_e_paused. WhatsApp
    // only — that is where the auto-mode gate + bridge live.
    const _fireConversationHeartbeat = async ({ chatId, surface, slug, name, prompt }) => {
      if (surface !== 'whatsapp' && surface !== 'wa') return;
      const reply = await runDefaultBrainTurn(prompt, () => {}, { threadId: chatId, surface: 'wa', slug, name });
      const trimmed = String(reply ?? '').trim();
      if (!trimmed || trimmed === '...' || trimmed === '…') return;
      if (!_eMayReplyToChat(chatId, { replyAllowed: false })) return;   // gate: 'on' & not paused only
      const personaName = EGPT_CONFIG.persona ?? 'e';
      const personaEmoji = (EGPT_CONFIG.siblings ?? {})[personaName]?.body_emoji ?? EGPT_PERSONA_EMOJI;
      try { waBridgeRef.current?.send(`${personaEmoji} ${personaName}\n${trimmed}`, { chatId, personaReply: personaName }); }
      catch (e) { sysLog(`!! heartbeat send ${chatId}: ${e?.message ?? e}`); }
    };

    // Room heartbeat: prompt each ACTIVE brain member PRIVATELY — the prompt
    // text is NEVER delivered to wa-group/tg members (that would leak it) —
    // then fan only their REPLIES via _deliverToRoom, which gates each member
    // by state. Muted/mention brains aren't prompted (a heartbeat @mentions
    // no one). @e goes via the confined runDefaultBrainTurn; other brains via
    // runBrainTurn(noBridge) so their reply only returns, then mirrors.
    const _fireRoomHeartbeat = async (roomName, prompt) => {
      let rstate; try { rstate = await loadRooms(); } catch { return; }
      const room = rstate.rooms?.[roomName];
      if (!room) return;
      for (const m of room.members ?? []) {
        if (stopped) break;
        if (m.kind !== 'brain' || m.state !== 'active') continue;
        let reply;
        try {
          if (m.id === 'e' || m.id === 'egpt') {
            reply = await runDefaultBrainTurn(prompt, () => {}, { threadId: `room:${roomName}`, surface: 'system', name: `room:${roomName}` });
          } else {
            const roomSessions = sessionsMapFromMembers(rstate, roomName);
            if (!roomSessions[m.id]?.brain) continue;
            reply = await runBrainTurn(m.id, prompt, roomSessions, { noBridge: true });
          }
        } catch (e) { sysLog(`!! heartbeat room ${roomName}→${m.id}: ${e?.message ?? e}`); continue; }
        const txt = String(reply ?? '').trim();
        if (txt && txt !== '...' && txt !== '…') {
          await _deliverToRoom(roomName, { fromId: m.id, senderLabel: `${m.emoji ?? '🧠'} ${m.id}`, body: txt, depth: 1 });
        }
      }
    };

    let heartbeatScanBusy = false;
    const heartbeatScanTick = async () => {
      if (stopped || heartbeatScanBusy) return;
      heartbeatScanBusy = true;
      try {
        const now = Date.now();
        // Conversations — each contact with a slug maps to its folder.
        const cs = await _loadConvState();
        for (const surface of Object.keys(cs.contacts ?? {})) {
          const bucket = cs.contacts[surface] ?? {};
          for (const [jid, entry] of Object.entries(bucket)) {
            if (stopped) break;
            if (entry?.aliasOf || !entry?.slug) continue;
            if (conversationsState.isMuted(entry)) continue;
            const dir = conversationsState.slugDir(surface, entry.slug);
            const cfg = await hb.readConfig(dir);
            if (!cfg.enabled) continue;   // common case: no heartbeat block — skip the state read
            if (!hb.shouldFire(cfg, await hb.readLastFiredMs(dir), now)) continue;
            const prompt = await hb.readPrompt(dir);
            if (!prompt) continue;   // no / blank heartbeat.md = nothing to fire
            try {
              await _fireConversationHeartbeat({ chatId: jid, surface, slug: entry.slug, name: entry.pushedName || entry.slug, prompt });
            } catch (e) { sysLog(`!! heartbeat[${surface}/${entry.slug}]: ${e?.message ?? e}`); }
            await hb.markFired(dir);   // mark even when gated-silent, so it doesn't re-attempt every scan
          }
        }
        // Rooms — each room maps to ~/.egpt/rooms/<name>/.
        let rstate; try { rstate = await loadRooms(); } catch { rstate = null; }
        for (const roomName of Object.keys(rstate?.rooms ?? {})) {
          if (stopped) break;
          const dir = roomDir(roomName);
          const cfg = await hb.readConfig(dir);
          if (!cfg.enabled) continue;
          if (!hb.shouldFire(cfg, await hb.readLastFiredMs(dir), now)) continue;
          const prompt = await hb.readPrompt(dir);
          if (!prompt) continue;
          try { await _fireRoomHeartbeat(roomName, prompt); }
          catch (e) { sysLog(`!! heartbeat room ${roomName}: ${e?.message ?? e}`); }
          await hb.markFired(dir);
        }
      } finally { heartbeatScanBusy = false; }
    };

    const timer = setInterval(tick, HEARTBEAT_MS);
    const HEARTBEAT_SCAN_MS = 30 * 1000;  // 30s scan; enables fractional-minute intervals
    const perContactTimer = setInterval(heartbeatScanTick, HEARTBEAT_SCAN_MS);

    // play.md hard-cap rotator — runs on the same 5-min cadence as the
    // heartbeat. play.md is loaded into every sibling's context on every
    // cross-resume; unchecked growth is a direct token-cost multiplier.
    // Policy-driven rotation (reader-ack) is the social layer; this is
    // the machine safety net.
    const PLAY_PATH    = join(homedir(), 'Documents', 'notes-markdown', 'projects', 'egpt', 'play.md');
    const HISTORY_PATH = join(homedir(), 'Documents', 'notes-markdown', 'projects', 'egpt', 'play.history.md');
    const rotateTick = async () => {
      if (stopped) return;
      try {
        const m = await import('./src/tools/play-rotate.mjs');
        const r = await m.rotatePlay({ playPath: PLAY_PATH, historyPath: HISTORY_PATH });
        if (r) {
          sysLog(`play-rotate: ${r.rotated} entries → history (${r.reason}, ${r.beforeBytes}→${r.afterBytes} bytes)`);
        }
        // Nudges: stale partial entries missing acks. Surface every tick so
        // operator (or a sibling reading /log) can see who's behind.
        const m2 = await import('./src/tools/play-rotate.mjs');
        try {
          const text = await (await import('node:fs/promises')).readFile(PLAY_PATH, 'utf8');
          const { entries } = m2.parsePlay(text);
          const stat = await (await import('node:fs/promises')).stat(PLAY_PATH);
          const ageHours = (Date.now() - stat.mtimeMs) / 3_600_000;
          if (ageHours >= 4) {
            for (const raw of entries) {
              const p = m2.parseEntry(raw);
              const c = m2.classifyEntry(p);
              if (p && c.status === 'partial') {
                sysLog(`play-nudge: ${p.author} [${p.time}] still waiting on: ${c.missing.join(', ')}`);
              }
            }
          }
        } catch (e) { console.error(`!! egpt.mjs:[catch] ${e?.message ?? e}`); }
      } catch (e) {
        sysLog(`!! play-rotate: ${e.message}`);
      }
    };
    const playTimer = setInterval(rotateTick, HEARTBEAT_MS);

    return () => {
      stopped = true;
      clearInterval(timer);
      clearInterval(playTimer);
      clearInterval(perContactTimer);
    };
  }, []);

  // Broadcast our local sessions to the bus on change. Peers use this to
  // know which @<name> they can forward our way. No-op until the bus is joined.
  useEffect(() => {
    const tid = busTargetIdRef.current;
    if (!tid) return;
    bus.postEvent(tid, {
      type: 'sessions-update', from: BUS_NODE_ID, ts: Date.now(),
      sessions: Object.entries(sessions).map(([n, s]) => ({ name: n, brain: s.brain })),
    }).catch(e => console.error(`!! egpt.mjs:[promise-catch] ${e?.message ?? e}`));
  }, [sessions]);

  // Broadcast our polling state on change so /telegram (no arg) on peers
  // can show a fresh picture without round-trips.
  useEffect(() => {
    const tid = busTargetIdRef.current;
    if (!tid) return;
    bus.postEvent(tid, {
      type: 'telegram-status', from: BUS_NODE_ID, ts: Date.now(),
      polling: tgPolling,
    }).catch(e => console.error(`!! egpt.mjs:[promise-catch] ${e?.message ?? e}`));
  }, [tgPolling]);

  // Forward every NEW item to the Telegram bridge. Track sent count via ref so
  // bulk additions (/last replays) flush all of them, not just the tail.
  // Items tagged _localOnly stay out of Telegram (e.g. the "(telegram message
  // from X)" arrival note, the user's own [You] echo when they typed via
  // Telegram). The bridge itself drops sends until a chat_id is known, so
  // pre-Telegram backlog never floods the chat when someone connects later.
  //
  // The counter advances even when bridgeRef is null (we yielded the polling
  // slot). That avoids a backlog flood + duplicate-with-peer-mirror when we
  // later reclaim: items typed during the yield should be carried to telegram
  // by whichever peer holds the slot at that moment, not retroactively by us.
  useEffect(() => {
    const b = bridgeRef.current;
    while (sentItemsCountRef.current < items.length) {
      const item = items[sentItemsCountRef.current++];
      if (item._localOnly) continue;
      // _source tags the surface this item came from. Skip mirroring
      // back to its own surface (avoid echo loops).
      if (item._source === 'telegram') continue;
      // _target restricts a sysOut response to one bridge — used for
      // slash command output so /sessions in WA doesn't leak to TG.
      if (item._target && item._target !== 'telegram') continue;
      if (b) b.send(formatItemForTelegram(item, sessions));
    }
  }, [items.length]);

  // Symmetric mirror to WhatsApp. Default target is the user's
  // 'Message Yourself' chat (selfDmJid, derived from the bridge's
  // own JID). Override via config: whatsapp.mirror_chat_id (a JID
  // string), or 'none' to disable. _localOnly items stay out, same
  // as Telegram — the (whatsapp message from X) arrival note and
  // user-echo would just get echoed back to the same chat.
  const sentToWaItemsCountRef = useRef(0);
  useEffect(() => {
    const wa = waBridgeRef.current;
    if (!wa) return;
    const opt = EGPT_CONFIG.whatsapp?.mirror_chat_id;
    if (opt === 'none' || opt === false) return;
    // Operator-only self-DM mirror: shell items go to the operator's own self-DM
    // (or whatsapp.mirror_chat_id) so they can watch the shell from their phone.
    // This is NOT routing to others — the single router is the ROOM model
    // (_deliverToRoom, fans to a room's members per their state). The legacy
    // /join "fan every shell item to a bound waJoinedRef set" was REMOVED: it
    // bypassed rooms and leaked a private `/use cgpt2` test into the HFM group
    // (operator 2026-06-02). To send to a group, add it as a ROOM member.
    const fallbackTarget = (typeof opt === 'string' && opt) ? opt : wa.selfDmJid;
    const targets = fallbackTarget ? [fallbackTarget] : [];
    // Match Telegram's pattern: advance the counter even when target
    // isn't ready yet, so items already on screen don't all flush as
    // a backlog the moment the bridge connects.
    while (sentToWaItemsCountRef.current < items.length) {
      const item = items[sentToWaItemsCountRef.current++];
      if (item._localOnly) continue;
      if (item._directWa) continue;             // already direct-sent (@waN / /join)
      if (item._target && item._target !== 'whatsapp') continue;
      // SECURITY — never mirror an attached brain session's reply into joined WA
      // chats. /attach'd ChatGPT-CDP tabs (cgpt1/2/3), codex, llama, etc. are
      // shell-WORKSPACE tools, NOT chat participants: a private `/use cgpt2`
      // test leaked into the HFM group through this tap (operator 2026-06-02:
      // "no sabía que eso se estaba leakeando"). Only the operator's own
      // messages ('You') and the public @e persona belong in a joined group;
      // any other session-authored item is shell-local. To put a brain in a
      // group deliberately, add it as an explicit room member, not via /join.
      const _bareAuthor = String(item.author ?? '').split('@')[0];
      const _persona = EGPT_CONFIG.persona ?? 'e';
      if (sessions[_bareAuthor] && _bareAuthor !== _persona && _bareAuthor !== 'e' && _bareAuthor !== 'egpt') {
        logOut(`mirror: NOT fanning ${_bareAuthor}'s reply to joined WA chats (attached brain session — shell-local)`);
        continue;
      }
      const formatted = formatItemForWhatsApp(item, sessions);
      for (const t of targets) {
        if (item._sourceChatId === t) continue;  // skip echo to origin
        // Never mirror WA-sourced items back to the self-DM (would loop).
        if (item._source === 'whatsapp') continue;
        wa.send(formatted, { chatId: t });
      }
    }
  }, [items.length]);

  // Load persisted rooms from disk on mount. Default room is in-memory
  // only and not loaded. After load, mark roomsLoadedRef so the
  // auto-save effect starts running.
  useEffect(() => {
    (async () => {
      const loaded = await loadAllRooms();
      const names = Object.keys(loaded);
      if (names.length > 0) {
        setRoomSessionsMap(rs => ({ ...rs, ...loaded }));
        for (const n of names) persistedRoomsRef.current.add(n);
        logOut(`loaded ${names.length} room(s) from disk: ${names.join(', ')}`);
      }
      roomsLoadedRef.current = true;
    })().catch(e => sysOut(`!! room load: ${e.message}`));
  }, []);

  // Auto-save rooms whenever the per-room session map changes. Default
  // room is skipped (lobby — never persisted). Save is per-room so
  // unrelated rooms aren't rewritten on every keystroke.
  useEffect(() => {
    if (!roomsLoadedRef.current) return;
    const t = setTimeout(() => {
      (async () => {
        const seen = new Set();
        for (const [name, sess] of Object.entries(roomSessionsMap)) {
          if (name === 'default') continue;
          seen.add(name);
          try { await saveRoomToDisk(name, sess); persistedRoomsRef.current.add(name); }
          catch (e) { sysOut(`!! room save (${name}): ${e.message}`); }
        }
        // Clean up rooms that were deleted in memory but still on disk.
        for (const name of [...persistedRoomsRef.current]) {
          if (!seen.has(name)) {
            await deleteRoomFile(name);
            persistedRoomsRef.current.delete(name);
          }
        }
        // Dual-write (unification 1b — ROOMS-UNIFICATION.md): mirror each
        // session-room's brain sessions into the MEMBERSHIP config
        // (~/.egpt/rooms/config.yaml — a SEPARATE file from the main config)
        // as brain members carrying {brain, options}. This populates the store
        // Phase 2 will flip resolveRoute onto. Upsert-only for now: routing
        // still reads roomSessionsMap, so stale members are harmless; pruning
        // (on /detach) and the read-flip arrive with Phase 2.
        try {
          let mstate = await loadRooms();
          let dirty = false;
          for (const [room, sess] of Object.entries(roomSessionsMap)) {
            if (room === 'default') continue;
            for (const [sname, s] of Object.entries(sess || {})) {
              if (!getRoom(mstate, room)) mstate = createRoom(mstate, room);
              mstate = addMember(mstate, room, { kind: 'brain', id: sname, brain: s.brain, options: s.options ?? {}, emoji: s.emoji });
              dirty = true;
            }
          }
          if (dirty) await saveRooms(mstate);
        } catch (e) { sysOut(`!! membership brain-member sync: ${e?.message ?? e}`); }
      })().catch(e => console.error(`!! egpt.mjs:[promise-catch] ${e?.message ?? e}`));
    }, 500);
    return () => clearTimeout(t);
  }, [roomSessionsMap]);

  // Startup: auto-start CDP proxy if Chrome is on :9221 but proxy not yet on
  // :9222, then auto-attach any chatgpt/claude tabs already open. Does
  // NOT spawn Chrome — the user invokes /chrome for that, or starts
  // their own Chrome with --remote-debugging-port=9221.
  // Explicit spawn — bound to /chrome. Idempotent (no-op if Chrome is
  // already up), and waits until CDP responds before returning.
  const spawnChromeWithExtension = async () => {
    try {
      await fetch('http://localhost:9221/json/version');
      sysOut('Chrome already running on :9221');
      return true;
    } catch { /* not yet — proceed to spawn */ }
    if (await cdp.isRunning()) {
      sysOut('Chrome already running (proxy up on :9222)');
      return true;
    }
    const extDist = join(APP_DIR, 'extension', 'dist');
    if (!existsSync(join(extDist, 'background.js'))) {
      sysOut('!! extension/dist not built — run: npm run build:ext');
      return false;
    }
    try {
      const launcher = await import('./src/tools/chrome-launcher.mjs');
      if (!launcher.findChromeExecutable()) {
        sysOut('!! Chrome executable not found in standard locations');
        return false;
      }
      // Resolve the brain profile dir, auto-migrating from the legacy
      // ~/.egpt/egpt-brain path if Chrome isn't holding it open. Chrome
      // creates SingletonLock / SingletonCookie inside its user-data-dir
      // while it owns the profile, so their absence means it's safe to
      // move. If Chrome is still running on the old dir we just use it
      // and tell the user how to migrate; the next clean start will do it.
      let brainProfile = CHROME_BRAIN_PROFILE;
      if (!existsSync(CHROME_BRAIN_PROFILE) && existsSync(LEGACY_CHROME_BRAIN_PROFILE)) {
        const locked = existsSync(join(LEGACY_CHROME_BRAIN_PROFILE, 'SingletonLock'))
                    || existsSync(join(LEGACY_CHROME_BRAIN_PROFILE, 'SingletonCookie'));
        if (locked) {
          sysOut('!! brain profile at legacy path (~/.egpt/egpt-brain). Close Chrome and run /chrome again to auto-migrate to ~/.egpt/chrome/profiles/brain');
          brainProfile = LEGACY_CHROME_BRAIN_PROFILE;
        } else {
          try {
            await mkdir(dirname(CHROME_BRAIN_PROFILE), { recursive: true });
            await rename(LEGACY_CHROME_BRAIN_PROFILE, CHROME_BRAIN_PROFILE);
            sysOut('migrated brain profile: ~/.egpt/egpt-brain → ~/.egpt/chrome/profiles/brain');
          } catch (e) {
            sysOut(`!! profile migration failed: ${e.message} — using legacy path`);
            brainProfile = LEGACY_CHROME_BRAIN_PROFILE;
          }
        }
      }
      sysOut('starting Chrome with extension…');
      const _spawnResult = await launcher.spawnChrome({
        port: 9221,
        userDataDir: brainProfile,
        extensionDir: extDist,
      });
      _chromeBrainPidRef.current = _spawnResult?.pid ?? null;
      await launcher.waitForChromeReady(9221);
      sysOut('Chrome ready');
      return true;
    } catch (e) {
      sysOut(`!! could not start Chrome: ${e.message}`);
      return false;
    }
  };

  useEffect(() => {
    if (CLIENT) return;   // Chrome/CDP discovery + the control-plane bus are spine-side
    let cancelled = false;
    let pollHandle = null;
    let lastNoticeBody = null;

    const notice = (body, opts = {}) => {
      // Avoid spamming the transcript when the polling loop reports the
      // same state repeatedly; only append a system row when the message
      // text changes. notice() is operator-side audit (proxy state, peer
      // online/offline, bus tab attached) — _log:true so it stays out of
      // the conversation view and shows only via /log when asked.
      if (body === lastNoticeBody) return;
      lastNoticeBody = body;
      pushItem({
        id: Date.now() + Math.random(), author: 'system',
        _localOnly: opts._localOnly ?? true, _log: true, body,
      });
    };

    // Idempotent: each tick checks current state and only does work that
    // is missing. Safe to call from both initial mount and the poll
    // interval. The poll picks up Chrome the user launches via /chrome
    // or starts manually with --remote-debugging-port=9221, and Chrome
    // that comes back from a crash. We never spawn Chrome here — that's
    // /chrome's job, not a side effect of running egpt.
    const tryConnect = async () => {
      if (cancelled) return;
      if (busSubRef.current) return; // already fully connected — nothing to do.

      // 1. Ensure Chrome is reachable on :9221 (its own loopback CDP
      //    port). No proxy — we trust same-machine processes; LAN
      //    coordination is a future axis that would re-introduce
      //    proxy + token + TLS together, with proper justification.
      if (!(await cdp.isRunning())) {
        notice('Chrome not running — type /chrome to launch it with the extension, or start it yourself with --remote-debugging-port=9221 --remote-allow-origins=*');
        return;
      }

      if (cancelled) return;

      // 2. Auto-attach any chatgpt/claude tabs already open. Idempotent
      //    against `sessionsLatestRef` so a second tick doesn't duplicate.
      //    Skipped in default room — that's the lobby and can't host
      //    brains (one-time hint shown so the user knows what to do).
      //    The bus-join below is NOT skipped: cross-node coordination
      //    (extension <-> shell, telegram polling handoff, etc.) must
      //    work in the lobby too — that's where most users start.
      try {
        if (currentRoomRef.current === 'default') {
          const tabs = await cdp.listTabs().catch(() => []);
          const matching = tabs.filter(t => !isInternalUrl(t.url) && brainForUrl(t.url));
          if (matching.length > 0 && !defaultRoomHintShown.current) {
            defaultRoomHintShown.current = true;
            notice(`found ${matching.length} brain tab(s) but you're in the default lobby. To attach them: /attach <brain> (auto-creates a room and switches you in).`);
          }
        } else {
        const tabs = await cdp.listTabs();
        if (cancelled) return;
        const claimed = new Set(
          Object.values(sessionsLatestRef.current).map(s => s.options?.targetId).filter(Boolean),
        );
        let working = { ...sessionsLatestRef.current };
        const additions = {};
        for (const tab of tabs) {
          if (isInternalUrl(tab.url)) continue;
          if (claimed.has(tab.id)) continue;
          const brainName = brainForUrl(tab.url);
          if (!brainName) continue;
          const name = nextName(brainName, working);
          const emoji = nextEmoji(working);
          additions[name] = { brain: brainName, options: { targetId: tab.id }, emoji };
          working[name] = additions[name];
          claimed.add(tab.id);
        }
        if (Object.keys(additions).length > 0 && !cancelled) {
          setSessions(s => ({ ...s, ...additions }));
          const summary = Object.entries(additions)
            .map(([n, s]) => `${s.emoji} ${n} (${s.brain})`).join(', ');
          logOut(`auto-attached ${Object.keys(additions).length} tab(s): ${summary}`);
        }
        }
      } catch { /* proxy up but listTabs failed — try again next tick */ }

      // 3. Bus tab: open or find the shared control-plane tab and subscribe.
      //    Cross-process events (extension <-> shell) ride this.
      //    Shell never opens the bus tab — only finds and attaches.
      //    The extension hosts bus.html (chrome-extension://<id>/bus.html
      //    bundled); its background.js opens the tab on extension load.
      //    If we tried to open one ourselves, the URL would resolve to
      //    http://localhost:9221/bus.html which Chrome doesn't serve,
      //    leaving a tab pointing at a 404 page with no window.bus —
      //    silent failure that breaks every cross-surface event.
      try {
        if (cancelled) return;
        const located = await bus.findOrOpenBusTab({ open: false });
        if (!located) return;
        busTargetIdRef.current = located.targetId;
        // Load / generate the shared bus signing key, push it into
        // the extension's chrome.storage.local so both halves verify
        // each other. Shell drives pairing — it's the trusted half
        // (controls CDP), generates first or reuses ~/.egpt/bus.key.
        // Threat boundary: anyone with CDP access could already do
        // anything; using CDP here to SET the key isn't a new vector,
        // it's the pairing channel.
        try {
          const key = await bus.loadOrCreateBusKey();
          bus.setBusKey(key);
          const result = await bus.pairBusKeyToExtension(located.targetId, key);
          if (result?.state === 'set')         notice('bus: signing key generated + paired with extension');
          else if (result?.state === 'replaced') notice('bus: signing key replaced extension\'s');
          else if (result?.state === 'unchanged') notice('bus: signing key matches extension');
          else if (result?.state === 'no-storage') notice('bus: extension storage not reachable — signing on shell side only');
          else if (result?.state === 'error')  notice(`bus: pair error — ${result.error}`);
        } catch (e) {
          notice(`bus: key pair failed — ${e.message}; continuing without signing`);
          bus.setBusKey(null);
        }
        const sub = await bus.subscribeBusEvents(located.targetId, (ev) => {
          if (cancelled) return;
          handleBusEventRef.current?.(ev);
        }, {
          // When the bus tab dies (user closed it, extension respawned
          // it, Chrome killed it for memory), clear our refs so the
          // 5s tryConnect re-attaches to whichever tab is now live
          // instead of short-circuiting on the dead subscription.
          onClose: () => {
            if (cancelled) return;
            busTargetIdRef.current = null;
            busSubRef.current = null;
            notice('bus tab gone — reattaching on next tick');
          },
        });
        busSubRef.current = sub;
        await bus.postEvent(located.targetId, {
          type: 'node-online', from: BUS_NODE_ID, ts: Date.now(), role: 'shell',
          sessions: Object.entries(sessionsLatestRef.current).map(([n, s]) => ({ name: n, brain: s.brain })),
          polling: tgPolling,
          // wa: true → shell is actively handling WhatsApp via baileys.
          // The extension's handleIncomingWaCdp checks this to decide
          // whether to yield brain dispatch. If shell is on the bus
          // but baileys is disconnected, extension stays in charge.
          wa: !!waBridgeRef.current,
        });
        notice(located.opened ? `bus tab opened (${await bus.busUrl()})` : `bus tab attached`);
      } catch (e) {
        notice(`bus: not joined yet (${e.message})`);
      }
    };

    tryConnect();
    // Poll every 5s. Cheap (one /json/version fetch per tick when Chrome is
    // up; one fetch + immediate failure when it isn't). Stops doing real
    // work as soon as busSubRef is set.
    pollHandle = setInterval(tryConnect, 5000);

    return () => {
      cancelled = true;
      if (pollHandle) clearInterval(pollHandle);
      // Best-effort node-offline announce, then stop subscription.
      // Chrome is left running on purpose: it was spawned detached so the
      // user keeps their brain tabs and the bus across shell restarts.
      const tid = busTargetIdRef.current;
      const sub = busSubRef.current;
      busTargetIdRef.current = null;
      busSubRef.current = null;
      (async () => {
        if (tid) {
          try { await bus.postEvent(tid, { type: 'node-offline', from: BUS_NODE_ID }); } catch {}
        }
        sub?.stop?.();
      })();
    };
  }, []);

  // Top-level hotkeys. Ctrl+C exits cleanly (raw-mode means SIGINT never fires
  // when exitOnCtrlC:false, so we handle it here instead). Ctrl+R force-resets.
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      _exitClean(0);
      return;
    }
    if (key.ctrl && input === 'r' && (busy || streaming)) {
      setBusy(false);
      setStreaming(null);
      pushItem({
        id: Date.now() + Math.random(), author: 'system',
        body: '(reset by Ctrl+R — any in-flight brain stream is abandoned; the underlying tab/process may still be running)',
      });
    }
  });

  // outputSinkRef tracks where this submit's responses should land:
  // 'local' (shell only, _localOnly=true) or a specific bridge name
  // ('telegram' / 'whatsapp', goes to that bridge's chat ONLY via
  // _target, not to other bridges). The previous design used 'remote'
  // (binary), which made _localOnly=false and items-mirror ship the
  // response to EVERY bridge — so /sessions in WA leaked to TG too.
  // Per-room transcript writer. Default room keeps writing to the
  // CLI-passed FILE (./conversation.md) so a fresh egpt run still has
  // a natural home. Named rooms get their own file at
  // ~/.egpt/rooms/<name>.md — the shared ledger for everyone in that
  // room, distinct from other rooms. On first write for a new room
  // we drop a header so the file is well-formed.
  const transcriptFileForRoom = (room) => room === 'default'
    ? FILE
    : join(ROOMS_DIR, `${sanitizeName(room)}.md`);
  const append = async (who, body) => {
    const file = transcriptFileForRoom(currentRoom);
    return queuedAppend(async () => {
      try { await stat(file); }
      catch {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, `# Conversation\n\n---\n\n`);
      }
      await appendFile(file, `## ${ts()} — ${who}\n${body}\n\n`);
    });
  };
  // Reply-target sidecar: stableId → _replyTarget, persisted next to
  // the current room's transcript so '@<stable-id> body' works after
  // a shell restart. Debounced save (1.5s) so frequent items churn
  // doesn't beat the disk; load runs once on mount per the effect
  // further down.
  const _welcomeBackRanRef = useRef(false);
  useEffect(() => {
    // One-time load at mount + on room switch. Wraps in a try because
    // a missing sidecar is expected for fresh rooms.
    (async () => {
      try {
        const map = await _loadReplyTargets(transcriptFileForRoom(currentRoom));
        persistedReplyTargets.current = map;
      } catch {}
      // Welcome-back runs after the sidecar load lands so registered
      // entries merge into the live map instead of being clobbered.
      // Gated by a ref so room switches don't re-print the report.
      if (_welcomeBackRanRef.current) return;
      _welcomeBackRanRef.current = true;
      try {
        const out = await buildWelcomeBack({
          // Inherit the bumped default (200) so the welcome-back
          // reflects the operator's full overnight, not a 30-row
          // preview that hid most of what arrived.
          includeDms: false,
          emojis: {
            pinned: T.recapEmojiPinned,
            group:  T.recapEmojiGroup,
            status: T.recapEmojiStatus,
            dm:     T.recapEmojiDm,
          },
        });
        if (out) {
          for (const e of out.entries) {
            if (e.stableId && e.replyTarget) {
              persistedReplyTargets.current.set(e.stableId, e.replyTarget);
            }
          }
          if (out.entries.length) _scheduleReplyTargetSave();
          // Seed the @waN cache from the welcome-back's chat order so
          // the operator can /join @wa3 or /pin @wa3 right off the
          // first frame — no need to bounce through /channels.
          if (Array.isArray(out.chatList) && out.chatList.length) {
            // Wrap through waListToStableCache so @waN tokens stay
            // session-stable across this seed and any later
            // /channels / /recap rebuilds — see tools/wa-bindings.mjs.
            _waChannelsCacheRef.current = _waListToStableCache(out.chatList);
          }
          // Fire-and-forget group-name backfill for any group whose
          // disk record lacks a subject. Same idea as the /recap
          // post-render hook — kicks an ensureGroupName lookup so
          // the NEXT /recap shows the real subject instead of the
          // bare JID prefix.
          const wa = waBridgeRef?.current;
          if (wa?.ensureGroupName && Array.isArray(out.chatList)) {
            for (const c of out.chatList) {
              if (c.isGroup && (!c.name || c.name.length <= 1)) {
                try { wa.ensureGroupName(c.jid); } catch {}
              }
            }
          }
          // Suppress transcript append — the welcome-back is a per-
          // session UI affordance, not a chat message; logging it on
          // every shell start would bloat the room md with reprints
          // of the same recap. Operator can re-render via /recap.
          _suppressTranscriptRef.current = true;
          try { sysOut(out.text, { _recap: true, _recapRows: out.rows }); }
          finally { _suppressTranscriptRef.current = false; }
        }
      } catch (e) {
        errOut(`welcome-back failed: ${e.message}`);
      }
      try { resetCountersOnDisk(); } catch (e) { swallow('logon.reset-counters', e); }
      try { writeLastLogonNow(); } catch (e) { swallow('logon.write-last', e); }
    })();
  }, [currentRoom]);
  const _saveTimerRef = useRef(null);
  const _scheduleReplyTargetSave = () => {
    if (_saveTimerRef.current) clearTimeout(_saveTimerRef.current);
    _saveTimerRef.current = setTimeout(async () => {
      // Build the live map from current items, then merge with
      // entries that fell out of memory (e.g. items rotated away
      // after /last reload). Persisted entries WIN if not present
      // in the current build, so stable ids stay resolvable across
      // restarts even when the originating item left memory.
      const live = new Map();
      for (const it of items) {
        const sid = stableIdByItemId.current.get(it.id);
        if (sid && it._replyTarget) live.set(sid, it._replyTarget);
      }
      const merged = new Map(persistedReplyTargets.current);
      for (const [k, v] of live) merged.set(k, v);
      persistedReplyTargets.current = merged;
      // A persistent save failure here means '@<stable-id>' replies stop
      // resolving after the next restart — rate-limited trail, not silence.
      try { await _saveReplyTargets(transcriptFileForRoom(currentRoom), merged); } catch (e) { swallow('reply-targets.save', e); }
    }, 1500);
  };
  // Auto-save whenever items mutate. In-place _replyTarget patches
  // (the /use direct-send loop, /mirror after-send) don't change
  // items.length, so those paths call _scheduleReplyTargetSave()
  // directly. The effect handles the common 'item added' path.
  useEffect(() => { _scheduleReplyTargetSave(); }, [items.length]);
  const sysOut = (body, extras = {}) => {
    const sink = outputSinkRef.current;
    const meta = sink === 'local'
      ? { _localOnly: true }
      : { _target: sink };
    pushItem({
      id: Date.now() + Math.random(), author: 'system', body,
      ...meta,
      // extras lets callers attach _replyTarget (or other item flags)
      // to a system line. Used by the WA media-saved handler so the
      // 'image saved' notice carries the WA reply-target of the
      // originating message — '@wa-<msgId> body' then replies to the
      // photo. Without this, _stableIdForItem falls back to 's-<rnd>'
      // and the system line is unaddressable.
      ...extras,
    });
    // Full-clarity logging: every system output (slash command
    // responses, status notes, errors) goes into the room transcript
    // too. Fire-and-forget — queuedAppend serialises so order is
    // preserved without making every sysOut caller async. View
    // commands (/last) set _suppressTranscriptRef to keep their
    // re-rendered noise out of the permanent log.
    if (!_suppressTranscriptRef.current) void append('system', body);
  };

  // True file log. The Ink shell only renders logOut/errOut to the headless
  // frame-dump (overwritten frames — the "don't trust headless.log" problem),
  // so the daemon's own telemetry + errors were never durably recorded and
  // had to be debugged with ad-hoc traces. egpt.log is the append-only,
  // greppable source of truth (operator 2026-06-11: "we need true logs").
  // Best-effort — logging must never throw or block the engine.
  const _egptLogFile = join(EGPT_LOGS, 'egpt.log');
  const _fileLog = (lvl, body) => {
    try { appendFileSync(_egptLogFile, `${new Date().toISOString()} [${lvl}] ${String(body ?? '').replace(/\r?\n/g, ' ⏎ ')}\n`); } catch { /* never throw from logging */ }
  };

  // logOut is for telemetry/audit lines — bridge connection events,
  // room-state coaching ("the room is empty"), peer announces, debug
  // dumps. They don't belong in the conversation transcript view; the
  // shell hides _log:true items by default and exposes them via /log.
  // sysOut stays for command responses (slash output) which the user
  // explicitly asked for and should see inline.
  const logOut = body => {
    _fileLog('log', body);
    return pushItem({
      id: Date.now() + Math.random(), author: 'system', body,
      _localOnly: true, _log: true,
    });
  };

  // errOut is for error/failure lines that the operator needs to see
  // RIGHT NOW — bridge sends that failed, brain dispatch errors, any
  // '!!' status that previously got buried in /log. Visible in the
  // shell like sysOut, but local-only (doesn't mirror to bridges and
  // doesn't append to the room md — errors are operational noise, not
  // conversation). _bright marks them for the renderer so they stand
  // out from regular system messages.
  const errOut = body => {
    _fileLog('err', body);
    return pushItem({
      id: Date.now() + Math.random(), author: 'system', body,
      _localOnly: true, _bright: true,
    });
  };

  // Engine attach host (Phase C — ENGINE-SURFACE-SEPARATION.md). Limbs (the thin
  // TTY client, the extension) attach over loopback TCP. OUTPUT: every item the
  // engine emits is fanned to attached limbs (outputChannel → host.pushItem).
  // INPUT: a limb's typed line goes straight into submit, exactly like local
  // shell input. The host advertises its port in ~/.egpt/state/nucleus.json.
  // Started once; closed on unmount. (A future thin-client limb won't run this —
  // it attaches instead; the engine-vs-client gate lands with Phase D.)
  useEffect(() => {
    if (CLIENT) return;   // a limb attaches to the spine's host; it doesn't host one
    let host = null, unsub = null, closed = false;
    (async () => {
      try {
        const keyB64 = await bus.loadOrCreateBusKey();
        const h = await startAttachHost({
          keyB64,
          onInput: ({ text }) => {
            try { submitRef.current?.(String(text ?? '')); }
            catch (e) { errOut(`!! attach input: ${e?.message ?? e}`); }
          },
          logger: { error: (m) => { try { errOut(String(m)); } catch {} } },
        });
        if (closed) { await h.close(); return; }   // unmounted mid-start
        host = h; _globalAttachHost = h;
        unsub = outputChannel.subscribe(item => { try { h.pushItem(item); } catch (e) { swallow('attach.push-item', e); } });
        sysOut(`attach host on 127.0.0.1:${h.port} — limbs may attach`);
      } catch (e) { errOut(`!! attach host failed to start: ${e?.message ?? e}`); }
    })();
    return () => { closed = true; try { unsub?.(); } catch {} try { host?.close?.(); } catch {} _globalAttachHost = null; };
  }, []);

  // Worker role: transcriptor (operator 2026-06-10). When config
  // `transcriptor.enabled` is true, this spine serves POST /v1/transcribe
  // for the MAIN spine's voice notes — see src/tools/transcriptor.mjs for
  // the topology (one main spine owns context + sends; workers compute).
  // Auth: the shared ~/.egpt/bus.key (copy it from the main spine once).
  // Default bind 127.0.0.1 — set transcriptor.bind to the LAN ip to expose.
  useEffect(() => {
    if (CLIENT) return;   // a worker is an ENGINE in a worker role, not a limb
    const tcfg = EGPT_CONFIG.transcriptor;
    if (!tcfg?.enabled) return;
    const token = EGPT_CONFIG.transcription_token;
    if (!token) { errOut('!! transcriptor enabled but transcription_token unset — refusing to start an unauthenticated server. Set transcription_token (same value as the main spine) in config.local.json.'); return; }
    const audioCfg = EGPT_CONFIG.whatsapp?.media?.audio_transcribe ?? {};
    const wlog = (m) => { try { appendFileSync(join(EGPT_LOGS, 'transcriptor.log'), `${new Date().toISOString()} ${m}\n`, { mode: 0o600 }); } catch (e) { swallow('transcriptor.log', e); } };
    let server = null, whisper = null, closed = false;
    (async () => {
      try {
        // Resident whisper-server (audio_transcribe.server.enabled): load
        // the GGUF ONCE instead of per-note. Spawned + supervised here;
        // the transcriptor's per-request transcribe POSTs to it. Falls
        // back to the per-note whisper-cli default when not enabled.
        let transcribe;
        const scfg = audioCfg.server;
        if (scfg?.enabled) {
          whisper = await startWhisperServer({
            command: scfg.command,
            model: audioCfg.model_path,
            host: scfg.host || '127.0.0.1',
            port: Number(scfg.port) > 0 ? Number(scfg.port) : 8089,
            language: audioCfg.language,
            extraArgs: Array.isArray(scfg.extra_args) ? scfg.extra_args : [],
            onLog: wlog,
          });
          if (closed) { whisper.stop(); return; }
          transcribe = makeWhisperServerTranscriber({ url: whisper.url, ffmpeg: audioCfg.ffmpeg_command, language: audioCfg.language });
        }
        const s = await startTranscriptorServer({
          port: Number(tcfg.port) > 0 ? Number(tcfg.port) : TRANSCRIPTOR_DEFAULT_PORT,
          bind: tcfg.bind || '127.0.0.1',
          keyB64: token,
          audioCfg,
          transcribe,   // undefined → startTranscriptorServer uses whisper-cli per-note
          onLog: wlog,
        });
        if (closed) { s.close(); whisper?.stop(); return; }   // unmounted mid-start
        server = s;
        sysOut(`transcriptor: worker role up on ${tcfg.bind || '127.0.0.1'}:${s.port}${scfg?.enabled ? ' (resident whisper-server)' : ' (whisper-cli per-note)'} (log: ~/.egpt/logs/transcriptor.log)`);
      } catch (e) { errOut(`!! transcriptor failed to start: ${e?.message ?? e}`); }
    })();
    return () => { closed = true; try { server?.close(); } catch (e) { swallow('transcriptor.close', e); } try { whisper?.stop(); } catch (e) { swallow('whisper-server.stop', e); } };
  }, []);

  // @d/Don LAN agent endpoint REMOVED 2026-06-13 — no bot<->bot backchannel;
  // agent<->agent is bridge-controlled Telegram only (GENOME I8 / CONTRACTS C8.3).

  // Limb (CLIENT): attach to the running spine over loopback TCP. Reads the port
  // from ~/.egpt/state/nucleus.json + the shared ~/.egpt/bus.key, connects, and
  // renders the spine's output frames through the SAME pushItem sink the local
  // renderer already subscribes to. INPUT flows the other way (submit →
  // handle.input). Reconnects on drop / spine restart. With the engine
  // subsystems all gated off, this is the limb's only live wire.
  useEffect(() => {
    if (!CLIENT) return;
    let handle = null, stopped = false, retryTimer = null;
    const renderFrame = (frame) => {
      if (frame.t === N2C.ITEM) { const { t, ...item } = frame; pushItem(item); }
      else if (frame.t === N2C.SYS) pushItem({ id: Date.now() + Math.random(), author: 'system', body: frame.body, _localOnly: true });
      else if (frame.t === N2C.BYE) sysOut(`spine going down (${frame.reason ?? 'bye'}) — will reattach`);
      // STREAM / STREAM_END (live-typing partials): the engine output channel
      // only fans finalized items today, so they don't arrive here yet; the
      // final reply still lands as an ITEM. Streaming over attach is a TODO.
    };
    const connect = async () => {
      if (stopped) return;
      let info = null;
      try { info = await readNucleusInfo(); } catch {}
      if (!info?.port) {
        errOut('no spine found (no nucleus.json) — start the engine; this limb will attach once it is up');
        retryTimer = setTimeout(connect, 2000); return;
      }
      try {
        const keyB64 = await bus.loadOrCreateBusKey();
        handle = await connectAttachClient({
          host: info.host ?? '127.0.0.1', port: info.port, keyB64, kind: 'shell',
          cols: process.stdout?.columns ?? null, rows: process.stdout?.rows ?? null,
          onFrame: renderFrame,
          onClose: () => {
            _attachClientRef.current = null;
            if (!stopped) { sysOut('spine connection closed — reattaching…'); retryTimer = setTimeout(connect, 1000); }
          },
        });
        _attachClientRef.current = handle;
        sysOut(`attached to spine on ${info.host ?? '127.0.0.1'}:${info.port} (pid ${handle.welcome?.nucleusPid ?? '?'})`);
      } catch (e) {
        _attachClientRef.current = null;
        if (!stopped) { errOut(`attach failed (${e?.message ?? e}) — retrying`); retryTimer = setTimeout(connect, 1500); }
      }
    };
    connect();
    return () => { stopped = true; if (retryTimer) clearTimeout(retryTimer); try { handle?.close?.(); } catch {} _attachClientRef.current = null; };
  }, []);

  async function injectSummary(name, target = null, sessionMap = sessions) {
    const path = summaryPath(name);
    const body = await readFile(path, 'utf8');
    const note = `[injected summary "${name}" from ${path}${target ? ` into ${target}` : ''}]\n\n${body.trim()}`;
    await append('system', note);
    pushItem({ id: Date.now() + Math.random(), author: 'system', body: note });
    if (target) {
      await dispatchToOperator('inject', { content: note }, target, sessionMap);
    }
    return { path, body };
  }

  function startProfileWizard(initialName) {
    const STEPS = [
      { key: 'name', when: (d) => !d.name,
        ask: () => 'Profile name (alphanumeric, dash, underscore):',
        hint: () => 'saved to ~/.egpt/brains/<name>.yaml',
        validate: v => /^[A-Za-z0-9_-]+$/.test(v) ? null : 'must be alphanumeric (dash/underscore ok)',
      },
      { key: 'type',
        ask: () => 'Brain type:',
        hint: () => 'codex  ccode  cdp_chat  cdp_claude',
        validate: v => ['codex','ccode','cdp_chat','cdp_claude'].includes(v) ? null : 'invalid type — codex ccode cdp_chat cdp_claude',
      },
      { key: 'model', when: (d) => ['codex','ccode'].includes(d.type),
        ask: (d) => `Model (Enter = default for ${d.type}):`,
        hint: (d) => d.type === 'codex' ? 'gpt-5.4-mini · gpt-5.4 · gpt-5.5' : 'leave blank to use ccode default',
        optional: true,
      },
      { key: 'effort', when: (d) => d.type === 'codex',
        ask: () => 'Reasoning effort (Enter = medium):',
        hint: () => 'low · medium · high',
        optional: true,
        validate: v => !v || ['low','medium','high'].includes(v) ? null : 'must be low / medium / high',
      },
      { key: 'cwd', when: (d) => ['codex','ccode'].includes(d.type),
        ask: () => `Working directory (Enter = ${process.cwd()}):`,
        hint: () => 'directory where the operator subprocess runs',
        optional: true,
      },
      { key: 'url', when: (d) => ['cdp_chat','cdp_claude'].includes(d.type),
        ask: () => 'Conversation URL (Enter = open fresh tab):',
        hint: () => 'e.g. https://chatgpt.com/c/abc123…   or use /profile <name> <url>',
        optional: true,
      },
      { key: 'emoji',
        ask: () => 'Emoji avatar (Enter = auto-assigned):',
        hint: () => 'e.g. 🦊 🐻 🤖 🧙',
        optional: true,
      },
      { key: 'bio',
        ask: () => 'Short bio (Enter = none):',
        hint: () => 'shown in /sessions and /rules',
        optional: true,
      },
    ];

    const data = { name: initialName ?? '' };
    let step = 0;

    const advance = () => {
      step++;
      while (step < STEPS.length && STEPS[step].when && !STEPS[step].when(data)) step++;
    };

    const showCurrent = () => {
      if (step >= STEPS.length) { finish(); return; }
      const s = STEPS[step];
      const total = STEPS.filter(q => !q.when || q.when(data)).length;
      const done = STEPS.slice(0, step).filter(q => !q.when || q.when(data)).length;
      sysOut(`[${done + 1}/${total}] ${typeof s.ask === 'function' ? s.ask(data) : s.ask}\n  hint: ${typeof s.hint === 'function' ? s.hint(data) : s.hint}${s.optional ? '\n  (Enter to skip)' : ''}`);
    };

    const finish = async () => {
      wizardRef.current = null;
      try {
        const lines = [`# egpt brain profile — created ${ts()}`, `name: ${data.name}`, `type: ${data.type}`];
        if (data.model) lines.push(`model: ${data.model}`);
        if (data.effort) lines.push(`effort: ${data.effort}`);
        if (data.cwd) lines.push(`cwd: ${data.cwd}`);
        if (data.url) lines.push(`url: ${data.url}`);
        if (data.emoji) lines.push(`emoji: ${data.emoji}`);
        if (data.bio) lines.push(`bio: "${data.bio.replace(/"/g, '\\"')}"`);
        const dir = join(homedir(), '.egpt', 'brains');
        await mkdir(dir, { recursive: true });
        const profilePath = join(dir, `${data.name}.yaml`);
        await writeFile(profilePath, lines.join('\n') + '\n');
        sysOut(`profile "${data.name}" saved -> ${dp(profilePath)}\n\n  /attach ${data.name}        start it\n  /profiles                 list all profiles`);
      } catch (e) { sysOut(`!! save failed: ${e.message}`); }
    };

    wizardRef.current = {
      answer(input) {
        const s = STEPS[step];
        const trimmed = input.trim();
        if (!trimmed && !s.optional) { sysOut(`(field required — Enter to skip is not allowed here)\n  hint: ${typeof s.hint === 'function' ? s.hint(data) : s.hint}`); return; }
        if (trimmed && s.validate) {
          const err = s.validate(trimmed);
          if (err) { sysOut(`!! ${err}\n  hint: ${typeof s.hint === 'function' ? s.hint(data) : s.hint}`); return; }
        }
        data[s.key] = trimmed || '';
        advance();
        showCurrent();
      },
    };

    // Skip already-satisfied steps
    while (step < STEPS.length && STEPS[step].when && !STEPS[step].when(data)) step++;
    sysOut(`Creating profile${initialName ? ` "${initialName}"` : ''}. Answer each question (Ctrl+C to cancel):`);
    showCurrent();
  }

  async function attachProfile(profile, nameOverride) {
    const brainName = profile.brain;
    const brain = brainForName(brainName);
    const sessionName = String(nameOverride ?? profile.session ?? profile.handle ?? profile.name).trim();
    if (!isSafeName(sessionName)) {
      sysOut(`profile "${profile.name}" has invalid session/handle "${sessionName}"`);
      return;
    }
    if (sessions[sessionName]) {
      sysOut(`session "${sessionName}" already exists`);
      return;
    }

    const previousState = await readBrainProfileState(profile.name);
    const options = profileOptions(profile, previousState);
    const url = profile.url ?? profile.conversation_url ?? profile.conversationUrl ??
      optionFromPath(profile, ['cdp', 'url']);
    try {
      if (brain.urlMatch) {
        const openUrl = url || brain.homeUrl;
        if (!openUrl) {
          sysOut(`profile "${profile.name}" has no url and ${brainName} has no homeUrl`);
          return;
        }
        sysOut(`opening ${brainName} profile "${profile.name}" -> ${openUrl}`);
        options.targetId = await cdp.openTab(String(openUrl));
        if (url) options.url = String(url);
      }

      const emoji = profile.emoji ? String(profile.emoji) : nextEmoji(sessions);
      const bio = profile.chat_name ?? profile.chatName ?? profile.description;
      const session = {
        brain: brainName,
        options,
        emoji,
        ...(bio ? { bio: String(bio) } : {}),
      };
      const effectiveSessions = { ...sessions, [sessionName]: session };
      // Functional updater so a concurrent attach can't overwrite us.
      setSessions(s => ({ ...s, [sessionName]: session }));
      await writeBrainProfileState(sessionName, session);

      const summaries = profileStartupSummaries(profile);
      sysOut(`profile "${profile.name}" -> session "${sessionName}" (${brainName})` +
        (options.model ? ` | model: ${options.model}` : '') +
        (options.reasoningEffort ? ` | effort: ${options.reasoningEffort}` : '') +
        (options.cwd ? ` | cwd: ${options.cwd}` : '') +
        `\n  state: ${statePathForProfile(profile.name)}` +
        `\n  address it as @${sessionName} for a single-recipient turn`);

      if (summaries.length) {
        setBusy(true);
        try {
          for (const summaryName of summaries) {
            const { body } = await injectSummary(summaryName, sessionName, effectiveSessions);
            sysOut(`profile "${profile.name}" injected "${summaryName}" into ${sessionName} (${body.length} chars)`);
          }
        } finally {
          setBusy(false);
        }
      }
    } catch (e) {
      setBusy(false);
      sysOut(`!! ${e.message}`);
    }
  }

  const handleSlash = async (text, meta = {}) => {
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(' ').trim();

    // File-command dispatch lane. Any cmd registered by a slash/*.mjs
    // file takes precedence over the inline if-chain below. ctx is
    // the syscall table — closures + refs the file commands need.
    // Grows as more commands migrate; document new keys in each
    // file's run() header so the surface area stays grep-able.
    const entry = SLASH_REGISTRY.get(cmd);
    if (entry) {
      // meta carries the dispatch origin (fromWhatsApp/fromTelegram +
      // chatId/userId). /config uses it for bridge-context key inference.
      // Other files can read it via { meta } in their run signature.
      const ctx = {
        sysOut,
        // Auto-dispatch helpers — slash commands (notably /rules) need
        // these to format synthesized messages that enter e's session
        // in the SAME shape as real auto_e_chats arrivals, so e
        // treats them as natural conversation rather than out-of-band
        // system instructions.
        buildWaSurfaceTag,
        formatAutoDispatchLine,
        waBridgeRef,
        waChannelsCacheRef: _waChannelsCacheRef,
        stormRef:           _stormRef,
        exit,
        exitClean:          _exitClean,
        APP_DIR,
        EGPT_HOME,
        // announceBounce (slash/lifecycle.mjs) falls back to the operator's
        // self-DM jid via EGPT_CONFIG.whatsapp.chat_id when meta.waChatId is
        // absent (limb/shell-initiated /restart). Without this in ctx that
        // fallback was always undefined → no restart-announce sidecar → no
        // "egpt back!" for non-WA restarts (operator 2026-06-02).
        EGPT_CONFIG,
        getFile:            () => FILE,
        // Theme setter wraps the three side-effects (T mutation,
        // _currentTheme reassignment, themeRev bump for re-render)
        // so file commands don't have to know about them.
        getTheme:           () => _currentTheme,
        // Live theme palette — read-through to the module-level T
        // (mutated in place by setTheme via Object.assign, so this
        // reference stays valid across switches). Slash commands
        // that want theme-aware output (/recap section emojis,
        // future colored renderers) read keys off this.
        theme:              T,
        setTheme:           (name) => {
          Object.assign(T, loadTheme(name));
          _currentTheme = name;
          setThemeRev(n => n + 1);
        },
        // Snapshots of mutable bindings — sessions is React state,
        // USER_NAME is a module-level let. handleSlash is invoked
        // once per command, so capturing them as values at call
        // time is sufficient for read-only consumers.
        sessions,
        USER_NAME,
        append,
        setItems,
        // Batch 3 additions
        items,                                       // snapshot for /log
        fmtTimeOnly,                                 // shared time formatter
        getShowPrompts: () => _showPrompts,
        setShowPrompts: (v) => { _showPrompts = !!v; },
        dp,                                          // path display
        parseMessages,                               // shared internal — pass-thru
        isMetaMessage: _isMetaMessage,               // /last filter
        suppressTranscriptRef: _suppressTranscriptRef,
        // Batch 4 additions
        outputSinkRef,                               // for /help to respect sink
        brainNamesForHelp,                           // help template substitutions
        tgBridgeRef:           bridgeRef,            // for /status
        listConversationFiles,                       // for /conversations
        CONVERSATION_DIRS,                           // search-dir constants
        resolveConversationSpec,                     // name/path → absolute
        setFile: (p) => { FILE = p; },               // /conversation mutates FILE
        sentItemsCountRef,                           // reset on conversation swap
        // Batch 5 additions
        setSessions,                                 // mutate sessions React state
        writeBrainProfileState,                      // persist a session to disk
        handleSlashRecurse: (t) => handleSlash(t, meta),  // re-enter dispatcher
        // Batch 6 additions
        readDefaultBrainState,
        persistDefaultBrainState,
        canonicalBrainName,
        brainForName,
        humanAge,
        ts,
        getDefaultOp: () => _defaultOp,
        setDefaultOp: (v) => { _defaultOp = v; },
        persistDefaultOp,
        peerNodesRef,
        // Batch 7 additions
        spawnChromeWithExtension,
        BRAINS,
        readJsonlMetadata,
        listBrainProfiles,
        profileDirsText,
        // Batch 8 additions
        setBrowserWaiting,
        ensureSummariesDir,
        summaryPath,
        isSafeName,
        // Batch 9 additions
        activeSessions,
        setActiveSessions,
        bus,
        busTargetIdRef,
        BUS_NODE_ID,
        // Bundle the six _waJoined* helpers into one struct so the
        // recipients.mjs file imports a single ctx key. Keeps the
        // top-level ctx surface from ballooning while preserving
        // each operation's existing semantics.
        waJoined: {
          add:    _waJoinedAdd,
          remove: _waJoinedRemove,
          clear:  _waJoinedClear,
          has:    _waJoinedHas,
          size:   _waJoinedSize,
          all:    _waJoinedAll,
          first:  _waJoinedFirst,
        },
        // Batch 10 additions
        EGPT_CONFIG,
        SURFACE_TAG,
        fmtTs,
        setBusy,
        itemByShortId,
        scheduleReplyTargetSave: _scheduleReplyTargetSave,
        // Direct sidecar write — used by /recap to register the WA
        // reply-target of every shown row so '@wa-<id> body' resolves
        // even for messages the operator hasn't directly rendered.
        // Debounced disk save piggybacks on the existing scheduler.
        registerReplyTarget: (stableId, rt) => {
          if (!stableId || !rt) return;
          persistedReplyTargets.current.set(stableId, rt);
          _scheduleReplyTargetSave();
        },
        runBrainTurn,
        // Compute-only brain turn — call brain.stream() with no UI
        // mirroring (no setItems, no bridge update / finish, no
        // transcript append). Returns just the brain's final text.
        // Used by /oracle so the slash command can render the
        // answer however it wants (as a WA reply edit into a
        // "thinking…" placeholder) without the normal dispatch
        // path firing alongside.
        //
        // @e / @egpt is special: the persona lives in
        // EGPT_CONFIG.default_brain, NOT sessions[]. It's a node-
        // global butler with its own persistent thread, available
        // in every room without /attach. Route those calls through
        // runDefaultBrainTurn which manages that thread.
        computeBrainTurn: async (routedTo, question, threadCtx = {}) => {
          if (routedTo === 'e' || routedTo === 'egpt') {
            try { return await runDefaultBrainTurn(question, () => {}, threadCtx); }
            catch (e) { return `!! @e failed: ${e.message}`; }
          }
          const session = sessions[routedTo];
          if (!session) return null;
          const brain = brainForName(session.brain);
          if (!brain?.stream) return null;
          const history = await readFile(FILE, 'utf8').catch(() => '');
          try {
            const result = await brain.stream(
              { history, message: question, ask: null },
              () => {},   // discard partials — we only want the final text
              { ...session.options, sessionName: routedTo, userName: USER_NAME },
            );
            return typeof result === 'string'
              ? result
              : (result?.text ?? result?.content ?? '');
          } catch (e) {
            return `!! brain "${routedTo}" failed: ${e.message}`;
          }
        },
        findSessionJsonl,
        // Batch 11 additions
        loadIdentity:                _loadIdentity,
        injectIdentityIntoPersona:   _injectIdentityIntoPersona,
        injectIdentityIfNeeded:      _injectIdentityIfNeeded,
        // Batch 12 additions
        startProfileWizard,
        parseProfileCreateArgs,
        writeConversationProfile,
        loadBrainProfile,
        attachProfile,
        profileCreateUsage,
        // Batch 13 additions
        tgPolling,
        stopTgBridge,
        startTgBridge,
        tgCfgRef,
        // Batch 14 additions
        clearGlobalWaBridge: () => { _globalWaBridge = null; },
        startWaBridge,
        setBusyLabel,
        // Batch 15 additions
        roomSessionsMap,
        setRoomSessionsMap,
        getCurrentRoom: () => currentRoom,
        setCurrentRoom,
        LOCAL_CONFIG_PATH,
        setUserName:    (v) => { USER_NAME = String(v); },
        nodeRename:     async (newName) => {
          // Live rename: announce node-offline under the old name first
          // so peers drop the old entry, swap BUS_NODE_ID + SURFACE_TAG,
          // then re-announce as node-online. Local UI + Telegram tags
          // pick up the new SURFACE_TAG on next render; past rows keep
          // their original tag (locked by Ink's <Static>).
          const oldName = BUS_NODE_ID;
          const tid = busTargetIdRef.current;
          if (tid && oldName !== newName) {
            try { await bus.postEvent(tid, { type: 'node-offline', from: oldName, ts: Date.now() }); } catch (e) { console.error(`!! egpt.mjs:[catch] ${e?.message ?? e}`); }
          }
          BUS_NODE_ID = newName;
          SURFACE_TAG = newName;
          if (tid && oldName !== newName) {
            try {
              await bus.postEvent(tid, {
                type: 'node-online', from: BUS_NODE_ID, ts: Date.now(), role: 'shell',
                sessions: Object.entries(sessions).map(([n, s]) => ({ name: n, brain: s.brain })),
                polling: tgPolling,
                wa: !!waBridgeRef.current,
              });
            } catch (e) { console.error(`!! egpt.mjs:[catch] ${e?.message ?? e}`); }
          }
        },
        // Batch 16 additions
        parseSendFileArgs,
        sendFileUsage,
        directPreparedPathFromSource,
        quoteRoomArg,
        defaultOperatorSession,
        assertOperatorSession,
        preparedFilePathFor,
        sendFilePrepVars,
        buildPasteFileMessage,
        parsePositiveLimit,
        DEFAULT_PASTE_FILE_MAX_CHARS,
        dispatchToOperator,
        parsePasteFileArgs,
        readPasteFilePayload,
        pasteFileUsage,
        resolveAddressedSession,
        setStreaming,
        parseCommandWords,
        resolveOperatorSession,
        nextName,
        nextEmoji,
        injectSummary,
        // Batch 17 additions (final batch — /attach and /open)
        brainForUrl,
        isInternalUrl,
        resolveTabId,
      };
      return await entry.run({ cmd, arg, meta, ctx });
    }

    // /exit and /version migrated to slash/exit.mjs and slash/version.mjs.
    // /use + /unuse migrated to slash/recipients.mjs.
    // /room migrated to slash/room.mjs.
    // /restart, /upgrade, /rewind migrated to slash/lifecycle.mjs.
    // /file migrated to slash/file.mjs.
    // /conversations + /conversation migrated to slash/conversation.mjs.
    // /egpt migrated to slash/egpt.mjs.
    // /log + /logs migrated to slash/log.mjs.
    // /help migrated to slash/help.mjs.
    // /status migrated to slash/status.mjs.
    // /prompts migrated to slash/prompts.mjs.
    // /theme + /themes migrated to slash/theme.mjs.
    // /telegram migrated to slash/telegram.mjs.
    // /channels migrated to slash/channels.mjs.
    // /join + /unjoin migrated to slash/recipients.mjs.
    // /pin and /unpin migrated to slash/pin.mjs — see SLASH_REGISTRY
    // dispatch lane above. Add new commands as slash/*.mjs files and
    // delete their inline branches here.

    // /wa-pending migrated to slash/wa-pending.mjs.
    // /whatsapp migrated to slash/whatsapp.mjs.
    // /config migrated to slash/config.mjs.
    // /create-profile + /profile + /profile-url migrated to slash/profile.mjs.
    // /send-file migrated to slash/send-file.mjs.
    // /paste-file + aliases migrated to slash/paste-file.mjs.
    // /browse migrated to slash/browse.mjs.
    // /continue migrated to slash/continue.mjs.
    // /session migrated to slash/session.mjs.
    // /rules migrated to slash/rules.mjs.
    // /mirror migrated to slash/mirror.mjs.  (Dead earlier CDP-only
    // duplicate was deleted as part of this migration — the second
    // inline /mirror block was unreachable; tested via grep that
    // only one cmd === '/mirror' branch existed before migration.)
    // /refresh migrated to slash/refresh.mjs.
    // /summaries (and aliases) + /save migrated to slash/summaries.mjs + slash/save.mjs.
    // /summarize (+ aliases) migrated to slash/summarize.mjs.
    // /inject migrated to slash/inject.mjs.
    // /history migrated to slash/history.mjs.
    // /last migrated to slash/last.mjs.
    // /sessions migrated to slash/sessions.mjs.
    // /rooms + /save-room migrated to slash/rooms.mjs.
    // /detach migrated to slash/detach.mjs.
    // (canonical /mirror has been migrated above; see slash/mirror.mjs)
    // /storm migrated to slash/storm.mjs.
    // /identity migrated to slash/identity.mjs.
    // /handle, /emoji, /bio migrated to slash/session-identity.mjs.
    // /attach migrated to slash/attach.mjs.
    // /open migrated to slash/open.mjs.
    // /chrome + /tabs migrated to slash/chrome.mjs + slash/tabs.mjs.
    return false;
  };

  // Build a command prompt from its template and run it on an operator session.
  // Handles template loading, /prompts display, and runBrainTurn dispatch.
  // Callers manage setBusy/cleanup around this call.
  async function dispatchToOperator(cmdName, vars, opSession, sessionMap) {
    const result = await buildCommandPrompt(cmdName, vars);
    if (!result) { sysOut(`!! no template found for command "${cmdName}" — check commands/${cmdName}.md`); return null; }
    if (_showPrompts) {
      const bar = '─'.repeat(53);
      sysOut(`[prompt -> ${opSession}  (${cmdName})]\n${bar}\n${result.text}\n${bar}`);
    }
    return runBrainTurn(opSession, result.text, sessionMap ?? sessions);
  }

  // Identify the persona prompt with the originating surface, chat,
  // and user — claude-code needs context to know "who am I talking to
  // and where" since the same thread spans WA / TG / shell / extension.
  // The body the user typed is below the identifier. Without this, an
  // @egpt question from a friend's DM looks indistinguishable from a
  // self-DM or shell input, and replies lose their conversational
  // anchoring across the play.
  //
  // Header enrichments (in response to direct persona feedback that
  // raw JIDs and missing timestamps were ambiguous):
  //   - Timestamp: ts() up front so the persona has a fixed anchor
  //     instead of having to read it out of message bodies.
  //   - WA chat name: getChatName(jid) when known, alongside the JID.
  //     Lets the persona say "in Auge family" instead of just
  //     "in 120363100@g.us".
  //   - 1:1 vs group vs status: explicit label from JID-suffix
  //     classification, so the persona doesn't have to infer.
  //   - Shell: includes USER_NAME@SURFACE_TAG, matching the [handle]
  //     convention used in the items renderer + room md.
  // Stable surface tag for a WhatsApp chat — used in the
  // [Name@surface (HH:MM)]: <body> format e sees for auto-dispatched
  // messages. Includes the JID NUMBER (immutable group identifier)
  // so e can distinguish groups even if their human-facing name/slug
  // changes. Shape:
  //   group        slug.<jid-num>.wa        e.g. compren_bitcoin.120363407494846096.wa
  //   group (no slug)  wa.<jid-num>         fallback if slug lookup fails
  //   non-group     wa.<jid>               DMs, status broadcast etc.
  function buildWaSurfaceTag(chatId) {
    if (!chatId) return 'wa';
    const idStr = String(chatId);
    const isGroup = idStr.endsWith('@g.us');
    if (isGroup) {
      // Group surface = '<slug>.wa' per operator's preferred shape:
      // '[Sender@compren-bitcoin.wa (HH:MM)]: msg'. Slug is the
      // kebab/underscore form of the chat's name; renames re-derive
      // it on next bridge refresh. Bare-jid fallback if the bridge
      // hasn't observed a slug yet.
      const slug = waBridgeRef.current?.getChatSlug?.(chatId);
      const jidNum = idStr.replace(/@g\.us$/, '');
      return slug ? `${slug}.wa` : `wa.${jidNum}`;
    }
    return `wa.${idStr}`;
  }

  // Format a single auto-dispatched message for a resident's eyes. Canonical
  // operator shape (2026-06-12): `Sender@[Chat/Group name].{node} (HH:MM): body`
  // — the human-readable chat NAME in brackets, then `.{node}` = the ENTRY POINT
  // the message came through ('wa'/'kg'/'chrome'), resolved from the surface
  // identity, never hardcoded.
  //
  //   group:    An@[HFM High Frequency Masturbation].wa (14:06): like tears in the rain
  //   private:  Mauricio@[Mauricio].wa (14:06): hola
  //
  // Thin wrapper over the pure, tested src/dispatch-line.mjs (CONTRACT C7.6) so
  // every call site here AND the by-reference callers (dispatch.mjs,
  // slash/rules.mjs) share one formatter the shape test guards. `chatType` is
  // accepted-and-ignored for back-compat with existing call sites.
  function formatAutoDispatchLine(opts) {
    return formatDispatchLine(opts);
  }

  function formatPersonaPrompt(meta, body) {
    // UTC ISO 'YYYY-MM-DD HH:MM' — consistent with reply envelope in
    // runDefaultBrainTurn. Operator (2026-05-21): no mixed local/UTC.
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    if (meta.fromTelegram) {
      const user = meta.telegramUser ?? 'someone';
      const chat = meta.telegramChatId ?? 'unknown';
      // TG chat-name lookup isn't wired yet (the TG bridge doesn't
      // track titles by chat_id — defer to a follow-up). The chatId
      // alone still distinguishes which TG conversation it is.
      return `[${stamp}, in Telegram chat ${chat}, ${user} said:]\n${body}`;
    }
    if (meta.fromWhatsApp) {
      const user = meta.waUser ?? 'someone';
      const chat = meta.waChatId ?? 'unknown';
      const isGroup = typeof chat === 'string' && chat.endsWith('@g.us');
      const isStatus = chat === 'status@broadcast';
      const kind = isStatus ? 'WhatsApp status broadcast'
        : isGroup ? 'WhatsApp group'
        : 'WhatsApp DM';
      let where = chat;
      try {
        const name = waBridgeRef.current?.getChatName?.(chat);
        if (name) where = `"${name}" (${chat})`;
      } catch (e) { console.error(`!! egpt.mjs:[catch] ${e?.message ?? e}`); }
      // Operator 2026-05-23: annotate voice-transcript inputs so the
      // brain knows the source. The body itself is the bare transcript
      // (sugar lives in the WA-visible ack message, not in the brain
      // prompt).
      const transcriptHint = meta.isTranscriptFromVoice ? ' (transcript from voice note)' : '';
      return `[${stamp}, in ${kind} ${where}, ${user} said${transcriptHint}:]\n${body}`;
    }
    return `[${stamp}, from shell (${USER_NAME}@${SURFACE_TAG}):]\n${body}`;
  }

  // Durable per-chat conversation state for SESSIONLESS residents (e.g. @l),
  // giving them PARITY with conversation-E. Each chat has its own conversation-L
  // (system-L for the Self DM): the identity (l.md) is captured ONCE at the
  // start as the seed, then the chat's envelope lines accumulate after it.
  // Persisted to ~/.egpt/agent/l/<chat>.json so a /restart RESUMES instead of
  // amnesia (the gap vs @e's session-on-disk). Bounded by
  // whatsapp.resident_history_chars (default 30000) to fit llama's context;
  // oldest lines roll off. The /confirm watcher shows only the per-turn delta —
  // this is the invisible, durable memory.
  const _residentDir = join(EGPT_HOME, 'agent', 'l');
  const _residentMem = useRef(new Map());   // chatId -> { identity, lines }
  const _residentSan = (id) => String(id).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  const _residentPath = (chatId) => join(_residentDir, `${_residentSan(chatId)}.json`);
  const _residentState = (chatId) => {
    let st = _residentMem.current.get(chatId);
    if (st) return st;
    try {
      const j = JSON.parse(readFileSync(_residentPath(chatId), 'utf8'));   // resume from disk
      st = { identity: typeof j.identity === 'string' ? j.identity : null, lines: Array.isArray(j.lines) ? j.lines : [] };
    } catch (e) { swallow('resident.load', e, { expect: ['ENOENT'] }); st = { identity: null, lines: [] }; }
    _residentMem.current.set(chatId, st);
    return st;
  };
  const _residentPersist = (chatId, st) => {
    try { mkdirSync(_residentDir, { recursive: true }); writeFileSync(_residentPath(chatId), JSON.stringify(st)); }
    catch (e) { errOut(`!! resident persist ${chatId}: ${e?.message ?? e}`); }
  };
  // Capture the identity (l.md) ONCE per conversation; later l.md edits apply
  // only to a fresh/reset conversation (mirrors @e installing a persona once).
  const _residentIdentity = (chatId, seed) => {
    const st = _residentState(chatId);
    if (!st.identity && seed) { st.identity = String(seed); _residentPersist(chatId, st); }
    return st.identity ?? seed ?? null;
  };
  const _appendResidentHistory = (chatId, line) => {
    if (!chatId || !line) return;
    const cap = Number(EGPT_CONFIG.whatsapp?.resident_history_chars ?? 30000);
    const st = _residentState(chatId);
    st.lines.push(String(line));
    let total = st.lines.reduce((n, s) => n + s.length + 1, 0);
    while (st.lines.length > 1 && total > cap) total -= (st.lines.shift().length + 1);
    _residentPersist(chatId, st);
  };
  const _residentHistory = (chatId) => _residentState(chatId).lines.join('\n');
  // Reset a chat's conversation-L: clear history + re-capture identity on the
  // next turn (the way to apply an edited l.md). Used by the reset command.
  const _residentReset = (chatId) => {
    _residentMem.current.set(chatId, { identity: null, lines: [] });
    try { unlinkSync(_residentPath(chatId)); } catch (e) { /* not yet persisted */ }
  };

  // Resident brains converse. After a resident (a being in
  // whatsapp.residents) replies in an auto_e broadcast turn, feed that reply
  // — even '…' — to every OTHER resident as a fresh turn, framed as the
  // canonical [being@chat (HH:MM)]: body envelope, so the brains see each
  // other and can answer ("why silent?"). Bounded by
  // whatsapp.resident_chain_cap (default 10) on meta._chainDepth so two
  // brains can't ping-pong forever. ONLY broadcast-originated turns carry
  // _chainDepth, so operator / engineer turns never re-circulate; and only a
  // reply from a being that is itself a resident converses. A reply that
  // can't be re-fed (cap hit, or no other residents) is still mirrored to
  // Self so the /confirm transcript stays complete.
  const _recirculateResidentReply = ({ being, reply, meta }) => {
    try {
      if (meta?._chainDepth == null) return;
      if (!meta.fromWhatsApp || !meta.waChatId) return;
      const body = String(reply ?? '');
      if (!body) return;
      const lc = (s) => String(s).toLowerCase();
      const residents = (Array.isArray(EGPT_CONFIG.whatsapp?.residents) && EGPT_CONFIG.whatsapp.residents.length)
        ? EGPT_CONFIG.whatsapp.residents
        : [EGPT_CONFIG.persona ?? 'e'];
      if (!residents.some(r => lc(r) === lc(being))) return;
      // "Debug: <-E" — reply received from this resident, in envelope form,
      // mirrored to the Self/egptbot debug watcher. Forwarding it below (when
      // not an infra error / 2nd-layer silence) fires the recipient's tap as
      // "Debug: E->L", echoing the same reply as the next brain's prompt.
      const env = formatAutoDispatchLine({ senderName: being, body, ts: Date.now(), chatName: waBridgeRef.current?.getChatName?.(meta.waChatId) ?? null, node: 'wa', surface: buildWaSurfaceTag(meta.waChatId) });
      confirmMirrorRef.current?.(meta.waChatId, `<-${String(being).toUpperCase()}`, env);
      // Infra errors ("!! @l: llama: fetch failed …") MUST be visible in the
      // debug (operator 2026-05-25) — so they are mirrored above — but they are
      // NOT a brain reply: don't store them in @l's memory and don't
      // re-circulate them to the other residents. (The chat send drops them via
      // _dropResident, so humans in the group never see them — only the
      // operator's Self/egptbot debug does.)
      if (/^!!\s*@/.test(body.trim())) return;
      const others = residents.filter(r => lc(r) !== lc(being));
      const depth = Number(meta._chainDepth) || 0;
      const cap = Number(EGPT_CONFIG.whatsapp?.resident_chain_cap ?? 10);
      if (depth >= cap || others.length === 0) return;   // terminal: received, not forwarded
      // Silence chain breaker (operator 2026-05-25): forward the INITIAL '…'
      // (a being staying quiet about real content — the other may get curious
      // and ask), but do NOT forward a '…' that is itself answering a '…'
      // (meta._silenceForward). Two brains mutually shrugging otherwise burns
      // the whole chain on empty turns. Content replies always forward (a
      // curious "why silent?" keeps the conversation alive) and reset the flag.
      const _isSilence = /^(?:\.{3,}|…+)$/.test(body.trim());
      if (_isSilence && meta._silenceForward) return;    // second-layer silence: received, not forwarded
      const persona = EGPT_CONFIG.persona ?? 'e';
      for (const other of others) {
        submitRef.current?.(body, {
          fromWhatsApp: true,
          waChatId: meta.waChatId,
          waUser: meta.waUser,
          waClientLabel: meta.waClientLabel,
          waSenderName: being,                 // envelope speaker = the replying brain
          observeOnly: meta.observeOnly,
          waWhitelisted: meta.waWhitelisted,
          autoDispatched: lc(other) === lc(persona),
          forceTarget: other,
          _chainDepth: depth + 1,
          _silenceForward: _isSilence,         // recipient is being prompted with a '…'
        })?.catch?.(e => errOut(`!! resident re-circulate ${being}→${other}: ${e?.message ?? e}`));
      }
    } catch (e) { errOut(`!! _recirculateResidentReply: ${e?.message ?? e}`); }
  };

  // Run the node-global "@egpt" persona — same brain machinery as a
  // /attach-ed session, just lives outside any room (omnipresent
  // butler giving continuity across rooms / bridges).
  //
  // Each brain runs with the option set it actually understands. No
  // cross-brain knobs, no system-prompt nudges — both claude-code and
  // codex behave the way the user knows them from the console:
  //   claude-code: pass allowed_tools (default 'all' = the
  //                non-interactive equivalent of clicking 'yes' on
  //                claude-code's permission prompts)
  //   codex:       no extra options — codex CLI handles tools natively
  // Override per deployment via /config default_brain {...}.
  // Conversation continuity: brain returns optionsPatch.sessionId on
  // the first turn; we persist it to ~/.egpt/config.json and pass it
  // back as --resume on subsequent turns.
  // Sanitize a JID / arbitrary string for use as a filename.
  function _sanitizeForFilename(s) {
    return String(s ?? '')
      .replace(/[@:.\\/]/g, '_')
      .replace(/[^A-Za-z0-9_-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 80);
  }

  // Conversations table — single source of truth for JID → display
  // names. Operator (2026-05-19): "we can have a conversations-table,
  // and we list JID:PushedName:CustomName."
  //
  // Stored as JSON at ~/.egpt/conversations/e/conversations.json:
  //   { "<jid>": { "pushedName": "...", "customName": "..." } }
  //
  // Daemon auto-adds entries when @e first encounters a chat
  // (pushedName from bridge.getChatName, customName left blank).
  // Operator fills customName to override the per-thread filename
  // suffix. Daemon-side updates only refresh pushedName when it
  // changes; customName is never touched by the daemon.
  //
  // Privacy: pushedName comes from bridge's getChatName which uses
  // group-subject / WA pushName (the contact's self-declared name),
  // never the operator's address book labels.
  function _readConversationsTable() {
    try {
      const p = join(EGPT_HOME, 'conversations', 'e', 'conversations.json');
      if (!existsSync(p)) return {};
      const m = JSON.parse(readFileSync(p, 'utf8'));
      return (m && typeof m === 'object') ? m : {};
    } catch (e) {
      console.error(`!! _readConversationsTable: ${e?.stack ?? e?.message ?? e}`);
      return {};
    }
  }
  function _writeConversationsTable(table) {
    try {
      const dir = join(EGPT_HOME, 'conversations', 'e');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'conversations.json'),
        JSON.stringify(table, null, 2) + '\n',
      );
    } catch (e) { console.error(`!! egpt.mjs:[catch] ${e?.message ?? e}`); /* best-effort */ }
  }
  function _upsertConversationEntry(threadId, ctx = {}) {
    if (!threadId || threadId === 'heartbeat' || threadId === 'shell') return;
    const table = _readConversationsTable();
    const pushedName = ctx.name ?? null;
    let cur = table[threadId];
    let changed = false;
    if (!cur) {
      cur = { pushedName: pushedName ?? '', customName: '' };
      table[threadId] = cur;
      changed = true;
    } else if (pushedName && cur.pushedName !== pushedName) {
      cur.pushedName = pushedName;
      changed = true;
    }
    // Fire-once customName auto-fill — operator (2026-05-19) sets a
    // per-row 'customNameSource' field on a row in conversations.json
    // ('pushname' | 'pushedname' | 'jid'); on the next message we
    // fill customName from that source and clear the flag. Lets the
    // operator pre-seed customName without manually typing it,
    // useful when one JID for a multi-JID contact has empty
    // pushedName until the contact replies.
    if (cur.customNameSource && !cur.customName) {
      const src = String(cur.customNameSource).toLowerCase();
      let val = '';
      if (src === 'pushname' || src === 'pushedname') val = cur.pushedName || threadId;
      else if (src === 'jid')                          val = threadId;
      if (val) {
        cur.customName = val;
        delete cur.customNameSource;
        changed = true;
      }
    }
    if (changed) _writeConversationsTable(table);
  }

  // Build a per-thread filename for ~/.egpt/conversations/e/.
  //
  // Priority (operator 2026-05-19: "always pushname or whatsapp
  // stable id" — auto-merge contacts without manual config):
  //   1. customName (operator override) → '<customName>.md'.
  //      Manual escape hatch when auto-merge can't link two JIDs.
  //   2. pushedName from table → '<pushedName>.md' (NO JID prefix).
  //      Two JIDs with the same pushedName share one file —
  //      auto-merges the WA lid/pn split for one contact.
  //   3. ctx.slug or ctx.name from bridge → '<slug-or-name>.md'.
  //   4. Fallback → '<jid>.md'.
  //
  // Caveat: full cross-JID auto-merge (lid ↔ phone-number) requires
  // both rows to have the same pushedName. WA only fills pushedName
  // when the contact sends a message; outbound-only JIDs may stay
  // unmerged until they reply. customName remains as manual fix.
  function _sanitizeForFilenameSuffix(s) { return _sanitizeForFilename(s); }
  function _threadFileName(threadId, ctx = {}) {
    const idPart = _sanitizeForFilename(threadId ?? 'unknown') || 'unknown';
    const table = _readConversationsTable();
    const row = table[threadId] ?? {};
    if (row.customName) {
      const alias = _sanitizeForFilenameSuffix(row.customName);
      if (alias) return `${alias}.md`;
    }
    if (row.pushedName) {
      const name = _sanitizeForFilenameSuffix(row.pushedName);
      if (name) return `${name}.md`;
    }
    const fallback = _sanitizeForFilenameSuffix(ctx.slug || ctx.name || '');
    return fallback ? `${fallback}.md` : `${idPart}.md`;
  }

  // Per-contact YAML registry lives at ~/.egpt/conversations.yaml
  // (outside any per-slug dir so conversation-e cannot read it).
  // Dispatch owns the state queue, migrations, transcript/activity
  // writes, lineage prelude, cwd recovery, and operator-failure notice.
  let _convStateCache = null;
  const _dispatchRuntimeRef = useRef(null);
  if (!_dispatchRuntimeRef.current) {
    _dispatchRuntimeRef.current = createDispatchRuntime({
      stateDir: EGPT_HOME,
      getSelfDmConfig: () => ({
        whatsapp: EGPT_CONFIG.whatsapp?.chat_id ?? null,
        telegram: EGPT_CONFIG.telegram?.chat_id ?? null,
      }),
      readPersonality: (personality) => conversationsState.readPersonality(personality),
      readPersonalityMeta: (personality) => conversationsState.readPersonalityMeta(personality),
      loadManifest: () => _loadIdentity(),
      loadIdentityFeed: (name) => conversationsState.readIdentityFeed(name),
      // Full access to the folders of any room this contact's jids belong to,
      // so a per-contact E can read the shared transcript / room files when a
      // member asks about the room. Membership (any state) grants it; reception
      // is unconditional so even a muted member can inspect the transcript.
      roomDirsForJids: async (jids) => {
        try {
          const state = await loadRooms();
          const names = new Set();
          for (const j of jids ?? []) {
            for (const r of roomsForMember(state, j)) names.add(r.name);
          }
          return [...names].map(n => join(EGPT_HOME, 'rooms', n));
        } catch { return []; }
      },
      // Operator-configured custom dir grants from conversations/config.yaml
      // (outside the sandbox; managed via /e path). Keyed by contact slug.
      // Returns { path, access } entries; read-only ones get a write-deny hook.
      grantDirsForContact: async ({ slug } = {}) => {
        try { return await entriesForSlug(slug); } catch (e) { swallow('grants.entries-for-slug', e); return []; }
      },
      findThreadJsonl: conversationsState.findThreadJsonl,
      logger: { error: (msg) => console.error(msg) },
      sysLog: (msg) => console.error(msg),
      systemCwd: homedir(),
      onStateChange: (state) => { _convStateCache = state; },
      onTranscriptInbound: (threadId, ctx) => _upsertConversationEntry(threadId, ctx),
      migrations: [
        async () => {
          try {
            const r = await conversationsState.migrateLayoutIfNeeded();
            if (r && r.migrated != null) {
              console.error(`conversations: migrated ${r.migrated} contacts → per-slug dirs (${r.moved} transcripts relocated)`);
            }
          } catch (e) { console.error(`!! conversations migration: ${e?.message ?? e}`); }
        },
        async () => {
          try {
            const r = await conversationsState.migrateSlugSuffix();
            if (r && r.renamed > 0) {
              console.error(`conversations: slug-suffix added to ${r.renamed} contacts (skipped ${r.skipped} already-suffixed)`);
            }
          } catch (e) { console.error(`!! slug-suffix migration: ${e?.message ?? e}`); }
        },
        async () => {
          try {
            const r = await conversationsState.migrateMediaToSlugDirs();
            if (r && r.files > 0) {
              console.error(`conversations: migrated ${r.files} media files across ${r.migrated} contacts into slug-dirs`);
            }
          } catch (e) { console.error(`!! media migration: ${e?.message ?? e}`); }
        },
        async () => {
          try {
            const r = await conversationsState.migrateConversationsToJidKey();
            if (r && r.migrated != null) {
              console.error(`conversations: rekeyed by JID — ${r.migrated} primaries, ${r.aliases} aliases (${r.dangling} dangling without JIDs)`);
            }
          } catch (e) { console.error(`!! jid-key migration: ${e?.message ?? e}`); }
        },
        async () => {
          try {
            const r = await conversationsState.migrateToSurfaceLayout();
            if (r && r.migrated != null) {
              console.error(`conversations: surface-layout migration — ${r.migrated} contacts moved under whatsapp/, ${r.dirsMoved} dirs renamed (${r.missingDirs} missing)`);
            }
          } catch (e) { console.error(`!! surface-layout migration: ${e?.message ?? e}`); }
        },
      ],
      resolveBrain: () => {
        const dbCfg = defaultPersonaBrainConfig(EGPT_CONFIG.default_brain);
        const brainType = canonicalBrainName(dbCfg.type ?? DEFAULT_PERSONA_BRAIN.type);
        const fbCfg = defaultPersonaFallbackConfig(dbCfg);
        const fbType = fbCfg ? canonicalBrainName(fbCfg.type ?? DEFAULT_PERSONA_BRAIN.type) : null;
        return {
          brain: brainForName(brainType),
          brainType,
          dbCfg,
          fallback: fbCfg && fbType && !isUrlBrain(fbType)
            ? { brain: brainForName(fbType), brainType: fbType, dbCfg: fbCfg }
            : null,
          isUrlBrain: isUrlBrain(brainType),
          missingMessage: `!! default brain "${brainType}" not found. /config default_brain {"type":"codex","model":"gpt-5.4-mini"}`,
        };
      },
      sessionOptions: ({ brainType, dbCfg }) => ({
        sessionId: dbCfg.session_id ?? null,
        cwd: dbCfg.cwd ?? process.cwd(),
        sessionName: 'egpt',
        userName: USER_NAME,
        ...(['ccode', 'codex', 'claude-sdk'].includes(brainType) ? { allowedTools: dbCfg.allowed_tools ?? 'all' } : {}),
        ...(configAddDirs(dbCfg) ? { addDirs: configAddDirs(dbCfg) } : {}),
        ...(dbCfg.system_prompt ? { appendSystemPrompt: dbCfg.system_prompt } : {}),
        ...(dbCfg.model ? { model: dbCfg.model } : {}),
        ...(brainType === 'codex' && dbCfg.service_tier ? { serviceTier: dbCfg.service_tier } : {}),
      }),
      recordDefaultSession: async ({ sessionId, brainType }) => {
        const next = recordSession(readDefaultBrainState(), sessionId, { type: brainType });
        await persistDefaultBrainState(next);
      },
      notifyOperator: async (message) => {
        const selfDm = EGPT_CONFIG.whatsapp?.chat_id;
        if (!selfDm) return;
        const ev = { type: 'wa-send', from: 'system', ts: Date.now(), jid: selfDm, body: message };
        const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        await writeFile(join(EGPT_HOME, 'outbox', id + '.json'), JSON.stringify(ev));
      },
      runUrlBrainTurn: async ({ brain, brainType, dbCfg, text, onPartial, threadCtx, logActivity }) => {
        const url = dbCfg.url;
        if (!url) {
          return `!! @e: ${brainType} is configured but no URL is set. Try /egpt brain ${brainType} <url> or use a CDP brain with a thread.`;
        }
        const started = Date.now();
        try {
          await logActivity('RECV', threadCtx.surface ?? '?', threadCtx.threadId ?? '?', `${text.length}ch`, brainType);
        } catch (e) { console.error(`!! urlbrain activity RECV: ${e?.message ?? e}`); }

        let targetId = null;
        try {
          const tabs = await cdp.listTabs(brain.urlMatch);
          const match = tabs.find(t => t.url === url || t.url.startsWith(url));
          targetId = match ? match.id : await cdp.openTab(url);
        } catch (e) {
          try {
            await logActivity('ERROR', threadCtx.surface ?? '?', threadCtx.threadId ?? '?', `${Date.now() - started}ms`, `cdp listTabs/openTab: ${(e?.message ?? '').slice(0, 200)}`);
          } catch (e2) { console.error(`!! urlbrain activity ERROR: ${e2?.message ?? e2}`); }
          return `!! @e: couldn't reach a ${brainType} tab at ${url} (${e.message})`;
        }

        if (targetId) {
          cdp.activateTarget(targetId).catch(e => console.error(`!! egpt.mjs:[promise-catch] ${e?.message ?? e}`));
          _osFocusBrainChrome();
        }
        try {
          const result = await brain.stream({ message: text }, onPartial, { targetId });
          const final = typeof result === 'object' ? (result.text ?? '') : (result ?? '');
          const next = recordSession(readDefaultBrainState(), url, { type: brainType });
          await persistDefaultBrainState(next);
          try {
            await logActivity('REPLY', threadCtx.surface ?? '?', threadCtx.threadId ?? '?', `${final.length}ch`, `${Date.now() - started}ms`, brainType);
          } catch (e) { console.error(`!! urlbrain activity REPLY: ${e?.message ?? e}`); }
          return final.trim() || '...';
        } catch (e) {
          try {
            await logActivity('ERROR', threadCtx.surface ?? '?', threadCtx.threadId ?? '?', `${Date.now() - started}ms`, (e?.message ?? '').slice(0, 200));
          } catch (e2) { console.error(`!! urlbrain activity ERROR: ${e2?.message ?? e2}`); }
          return `!! @e: ${e.message}`;
        }
      },
    });
  }
  const _dispatchRuntime = _dispatchRuntimeRef.current;

  // Pre-warm _convStateCache at boot so the bridge's mediaDirForChat
  // callback can resolve slug-dirs from the FIRST inbound media,
  // not just after the first dispatch. Without this seeding, a voice
  // note arriving before any text dispatch fell back to the legacy
  // ~/.egpt/media/<jid-sanitized>/ tree — the conversation-e for that
  // chat (sandboxed to its slug-dir) couldn't see its own transcript.
  // Operator 2026-05-22.
  _dispatchRuntime.readState()
    .then((s) => { if (s && !_convStateCache) _convStateCache = s; })
    .catch((e) => console.error(`!! boot: pre-warm conv state: ${e?.message ?? e}`));

  async function _loadConvState() {
    try {
      return await _dispatchRuntime.readState();
    } catch (e) {
      console.error(`!! _loadConvState: ${e?.stack ?? e?.message ?? e}`);
      return conversationsState.emptyState();
    }
  }

  async function _writeConvState(state) {
    try {
      await _dispatchRuntime.writeState(state);
    } catch (e) { console.error(`!! conversations: write failed — ${e?.message ?? e}`); }
  }

  async function runDefaultBrainTurn(text, onPartial = () => {}, threadCtx = {}) {
    return _dispatchRuntime.runDefaultBrainTurn(text, onPartial, threadCtx);
  }

  // WARM-SESSION POOL (Unit 4). Lazily built from EGPT_CONFIG.brains.warm.
  // Holds RESIDENT `claude` CLI background agents (createWarmCliSession — one
  // persistent stream-json process per being) so a turn is warm, not a cold
  // spawn. The pool owns the residency policy: lazy-warm, idle-evict per class
  // (`resident`=0 → never evict for Wren/D; `conversation`=5min reap for the
  // per-chat E's), LRU, per-key serialization. Engine stays the CLI (I11).
  // Lazy creation avoids module-eval ordering; logOut/EGPT_CONFIG exist at call time.
  const _warmEnabled = () => EGPT_CONFIG.brains?.warm?.enabled !== false;   // default ON
  function _warmPool() {
    if (_warmPoolSingleton) return _warmPoolSingleton;   // module-scope singleton (survives dispatches)
    const w = EGPT_CONFIG.brains?.warm ?? {};
    _warmPoolSingleton = createWarmPool({
      makeSession: createWarmCliSession,   // resident CLI background agent (no SDK — I11)
      max: Number(w.max) || 6,
      idleTtlMs: Number(w.idle_ttl_ms) || 180_000,
      idleTtlByClass: w.idle_ttl_by_class ?? { system: 0, resident: 0, conversation: 300_000, sibling: 300_000 },
      dispatchTimeoutMs: Number(w.dispatch_timeout_ms) || 600_000,
      injectWhileBusy: w.inject_while_busy ?? true,
      onLog: (m) => { try { logOut(m); } catch { /* ignore */ } },
    });
    return _warmPoolSingleton;
  }

  // Run @me / @wren / sibling engineer turns. Claude siblings may use
  // pinned /branch session ids; Codex siblings can start fresh and then
  // persist the Codex thread id back into config for later resumes.
  //
  // See project-egpt-at-me-identity + project-egpt-design-relationship
  // in memory for the role this fills.
  async function runMetaBrainTurn(text, onPartial = () => {}, name = 'wren', opts = {}) {
    // Resolution order: EGPT_CONFIG.siblings[name] first (the registry
    // shape — supports @jay / @wren / future siblings as distinct
    // sessions). Falls back to EGPT_CONFIG.meta_brain only when no
    // registry match (legacy single-pinned-sibling shape, preserved
    // so old configs keep working).
    const sibs = EGPT_CONFIG.siblings ?? null;
    let mbCfg = null;
    let source = '';
    // @me → resolved via top-level main_engineer config (operator
    // 2026-05-19: 'main_engineer' is a top-level key naming the
    // sibling @me should route to). Falls back to alias-on-sibling
    // when main_engineer isn't set.
    if (String(name).toLowerCase() === 'me' && EGPT_CONFIG.main_engineer && sibs?.[EGPT_CONFIG.main_engineer]) {
      mbCfg = sibs[EGPT_CONFIG.main_engineer];
      name = EGPT_CONFIG.main_engineer;
      source = `siblings.${name} (via main_engineer)`;
    } else if (sibs && typeof sibs === 'object') {
      // Direct hit on canonical name, then alias scan.
      if (sibs[name] && typeof sibs[name] === 'object') {
        mbCfg = sibs[name]; source = `siblings.${name}`;
      } else {
        for (const [n, e] of Object.entries(sibs)) {
          if (e?.aliases?.some(a => String(a).toLowerCase() === String(name).toLowerCase())) {
            mbCfg = e; name = n; source = `siblings.${n} (via alias)`; break;
          }
        }
      }
    }
    if (!mbCfg) {
      mbCfg = EGPT_CONFIG.meta_brain ?? null;
      source = 'meta_brain (legacy fallback)';
    }
    if (!mbCfg) {
      return `!! @${name}: not configured. Add EGPT_CONFIG.siblings.${name}.{session_id, cwd, model?} (preferred) or set EGPT_CONFIG.meta_brain.session_id (legacy single-sibling shape).`;
    }
    // LIVE-TERMINAL GUARD (feat/sibling-reply): a sibling whose session is a LIVE
    // claude-code terminal (e.g. @me/@wren = the operator's own running session)
    // must NOT be daemon-resumed — `claude --resume` on a live session hangs and
    // wedges the message queue (heartbeat keeps ticking, turns stall). Refuse
    // immediately and point at the dormant copy. No resume = no wedge.
    if (mbCfg.live_terminal) {
      logOut(`@${name}: live-terminal — refusing daemon resume (use the dormant alias)`);
      return `(@${name} is a live terminal session — I can't resume it from here. Address @jay instead.)`;
    }
    const brainType = canonicalBrainName(mbCfg.type ?? 'claude-code');
    const brain = brainForName(brainType);
    if (!brain) return `!! @${name}: brain "${brainType}" not found.`;
    const selectedName = name;
    async function persistSiblingSession(sessionId) {
      try {
        if (source.startsWith('siblings.')) {
          if (!EGPT_CONFIG.siblings || typeof EGPT_CONFIG.siblings !== 'object') EGPT_CONFIG.siblings = {};
          if (!EGPT_CONFIG.siblings[selectedName] || typeof EGPT_CONFIG.siblings[selectedName] !== 'object') EGPT_CONFIG.siblings[selectedName] = {};
          EGPT_CONFIG.siblings[selectedName].session_id = sessionId ?? null;
        } else {
          if (!EGPT_CONFIG.meta_brain || typeof EGPT_CONFIG.meta_brain !== 'object') EGPT_CONFIG.meta_brain = {};
          EGPT_CONFIG.meta_brain.session_id = sessionId ?? null;
        }
        const { readConfig, writeConfig } = await import('./src/tools/config-io.mjs');
        const cfg = await readConfig();
        if (source.startsWith('siblings.')) {
          if (!cfg.siblings || typeof cfg.siblings !== 'object') cfg.siblings = {};
          if (!cfg.siblings[selectedName] || typeof cfg.siblings[selectedName] !== 'object') cfg.siblings[selectedName] = {};
          cfg.siblings[selectedName].session_id = sessionId ?? null;
        } else {
          if (!cfg.meta_brain || typeof cfg.meta_brain !== 'object') cfg.meta_brain = {};
          cfg.meta_brain.session_id = sessionId ?? null;
        }
        await writeConfig(cfg);
      } catch (e) {
        sysOut(`!! @${selectedName}: couldn't persist session_id: ${e.message}`);
      }
    }
    // Sessionless brains (e.g. llama — local llama.cpp) have no --resume:
    // the host must not gate them on a session_id. codex is also exempt
    // (it auto-creates + persists its own thread on first turn). claude-sdk is
    // exempt too: with no session_id it starts a FRESH session (the SDK assigns
    // an id; the warm pool keeps it warm in-process for the daemon's lifetime).
    // codex, claude-sdk, AND ccode (claude-code) all AUTO-CREATE + persist their
    // own thread on the first turn: the engine mints a session id, the brain
    // captures it (claude-code.mjs:236 from the stream-json init event) and returns
    // it in optionsPatch, which the dispatch persists → resumed thereafter. So none
    // of them need a pinned session_id. (ccode was missing here — the bug that made
    // a fresh @wren on the CLI engine refuse to run.)
    if (!mbCfg.session_id && brainType !== 'codex' && brainType !== 'claude-sdk' && brainType !== 'ccode' && !brain.sessionless) {
      return `!! @${name}: session_id missing in ${source}. After running Claude Code /branch in the source conversation, paste the new session id into the config.`;
    }
    // Prompt profile: `system_prompt_file` points to a standalone file
    // (path absolute or relative to ~/.egpt) holding the sibling's prompt.
    // Read FRESH every turn so editing the profile is live — no daemon
    // restart needed. Falls back to the inline `system_prompt` string.
    let _sysPrompt = mbCfg.system_prompt ?? null;
    if (mbCfg.system_prompt_file) {
      try {
        const _pf = isAbsolute(mbCfg.system_prompt_file)
          ? mbCfg.system_prompt_file
          : join(EGPT_HOME, mbCfg.system_prompt_file);
        const _txt = await readFile(_pf, 'utf8');
        if (_txt.trim()) _sysPrompt = _txt;
      } catch (e) {
        sysOut(`!! @${name}: system_prompt_file (${mbCfg.system_prompt_file}) read failed: ${e.message}`);
      }
    }
    // Sessionless residents (@l) keep a durable per-chat conversation: capture
    // the identity ONCE (the first turn's l.md becomes this conversation-L's
    // seed) instead of re-reading it every turn. opts.chatId is supplied only
    // for resident broadcast turns; edits to l.md apply after a reset.
    if (brain.sessionless && opts.chatId) {
      _sysPrompt = _residentIdentity(opts.chatId, _sysPrompt);
    }
    // Suppress Qwen3 thinking at the MODEL level. llama-server's --reasoning
    // flag only controls how reasoning is PARSED, not whether the model emits
    // <think>…</think> — so a Qwen3 @l kept reasoning (slow on CPU, and noise).
    // Qwen3 honors a literal /no_think switch in the prompt; append it to the
    // system prompt. Per-sibling siblings.<name>.no_think wins (central L config,
    // operator 2026-06-11), falling back to local_llm.no_think. Set false for a
    // NON-thinking model (e.g. Qwen2.5) where /no_think is just dead weight.
    if (brain.sessionless && (mbCfg.no_think ?? EGPT_CONFIG.local_llm?.no_think) !== false) {
      _sysPrompt = `${_sysPrompt ? _sysPrompt + '\n\n' : ''}/no_think`;
    }
    const sessionOpts = {
      sessionId: mbCfg.session_id ?? null,
      cwd: mbCfg.cwd ?? process.cwd(),
      sessionName: name,
      userName: USER_NAME,
      ...(['ccode', 'codex'].includes(brainType) ? { allowedTools: mbCfg.allowed_tools ?? 'all' } : {}),
      ...(configAddDirs(mbCfg)     ? { addDirs: configAddDirs(mbCfg) } : {}),
      ...(_sysPrompt               ? { appendSystemPrompt: _sysPrompt } : {}),
      ...(mbCfg.model              ? { model: mbCfg.model                        } : {}),
      ...(brainType === 'codex' && mbCfg.service_tier ? { serviceTier: mbCfg.service_tier } : {}),
      ...(mbCfg.url                ? { url: mbCfg.url                            } : {}),
      // Reasoning depth for the claude-code CLI engine (--effort) — the lever the
      // Agent SDK can't set (issues #168/#180/#182). siblings.<name>.effort (e.g.
      // Wren = xhigh); ignored by non-CLI brains.
      ...(mbCfg.effort             ? { effort: mbCfg.effort                      } : {}),
      // Local CPU brain (@l): a cold prompt-eval of a big conversation-L can be
      // silent for a while; give the stall watchdog room (configurable).
      ...(brain.sessionless ? {
        stallTimeoutMs: Number(EGPT_CONFIG.local_llm?.stall_timeout_ms) || 300_000,
        hardTimeoutMs:  Number(EGPT_CONFIG.local_llm?.hard_timeout_ms)  || 600_000,
        // Cap @l's reply to a chat-sized message — a small model otherwise
        // rambles to the server's max (finish=length). siblings.<name>.max_tokens
        // overrides; default 256 (~a few sentences). 2026-06-11.
        maxTokens: Number(mbCfg.max_tokens ?? EGPT_CONFIG.local_llm?.max_tokens ?? 256),
      } : {}),
    };
    try {
      // Agentic @l (opt-in via local_llm.agentic): a sessionless local brain
      // with tools runs the ReAct loop instead of a plain chat turn — it can
      // call the permission-gated agent tools (read_file, web_fetch, …) to
      // actually DO things. OFF by default; @l stays a pure chatter until the
      // operator sets local_llm.agentic:true and grants tools via /e tool.
      if (brain.sessionless && EGPT_CONFIG.local_llm?.agentic === true) {
        const { runAgentLoop } = await import('./src/tools/agent-loop.mjs');
        const _sbCfg = EGPT_CONFIG.tools?.sandbox;
        const sandboxRoot = _sbCfg
          ? (isAbsolute(_sbCfg) ? _sbCfg : join(EGPT_HOME, _sbCfg))
          : join(EGPT_HOME, 'agent-sandbox');
        try { mkdirSync(sandboxRoot, { recursive: true }); } catch (e) { errOut(`!! agent sandbox mkdir: ${e?.message ?? e}`); }
        const selfDm = EGPT_CONFIG.whatsapp?.chat_id ?? null;
        const _outboxSend = async (jid, body, from) => {
          const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
          await writeFile(join(EGPT_HOME, 'outbox', id + '.json'),
            JSON.stringify({ type: 'wa-send', from, ts: Date.now(), jid, body: String(body) }));
        };
        const final = await runAgentLoop({
          systemPrompt: _sysPrompt,
          userText: text,
          toolsCfg: EGPT_CONFIG.tools,
          sandboxRoot,
          url: mbCfg.url,
          model: mbCfg.model,
          maxIters: Number(EGPT_CONFIG.local_llm?.agentic_max_iters) || 8,
          sendMessage: (jid, body) => _outboxSend(jid, body, name),
          // Phase-1 'ask' gate: notify the operator + DEFER (don't run). They
          // promote the tool with `/e tool allow <name>` to permit. Interactive
          // in-chat y/n is a later refinement; the hook is here for the swap.
          confirm: async (toolName, toolArgs) => {
            if (selfDm) {
              await _outboxSend(selfDm,
                `🔧 @${name} wants \`${toolName}\` ${JSON.stringify(toolArgs).slice(0, 200)} — it's set to "ask". Run \`/e tool allow ${toolName}\` to permit.`,
                'system').catch(() => {});
            }
            return false;
          },
          onLog: (m) => logOut(`agent[@${name}]: ${m}`),
        });
        return String(final ?? '').trim() || '...';
      }
      // WARM PATH (feat/sibling-reply): an in-process claude-sdk sibling runs on
      // a persistent pooled session — no per-turn cold start / subprocess spawn.
      // Keyed per sibling+session so a re-pin opens a fresh one; errors surface
      // as text so the missing-resume retry below still fires. ccode (the CLI
      // engine — Wren/D) and the legacy claude-sdk run through the warm pool as
      // RESIDENT background agents (Unit 4); codex/llama keep the cold path.
      // siblings.<name>.resident:true → never idle-evict (meta-engineers).
      let result;
      if ((brainType === 'ccode' || brainType === 'claude-sdk') && _warmEnabled()) {
        const _warmKey = `sib:${selectedName}:${mbCfg.session_id ?? 'new'}`;
        try {
          const r = await _warmPool().run(_warmKey, text, onPartial, {
            brainOptions: { ...sessionOpts, allowedTools: mbCfg.allowed_tools ?? 'all' },
            klass: mbCfg.resident ? 'resident' : 'sibling',
          });
          if (r?.injected) {
            // This message was woven into a turn already streaming on this
            // sibling (operator 2026-06-13: "inject into running turn"). That
            // turn emits the combined reply, so drop this dispatch silently —
            // '...' is the silence marker the dispatcher treats as "no message".
            logOut(`@${selectedName}: injected into the running turn (no separate reply)`);
            return '...';
          }
          result = { text: r.text, optionsPatch: r.sessionId ? { sessionId: r.sessionId } : null };
        } catch (e) {
          result = { text: `!! ${e?.message ?? e}`, optionsPatch: null };
        }
      } else {
        result = await brain.stream(
          // Sessionless brains (e.g. llama @l) have no server-side thread, so
          // the host supplies the conversation as opts.history — the per-chat
          // rolling transcript that mimics @e's session memory. Falls back to
          // the single turn when no history is supplied (engineer turns, etc.).
          { history: opts.history ?? text, message: text },
          onPartial,
          sessionOpts,
        );
      }
      const final = typeof result === 'object' ? (result.text ?? '') : (result ?? '');
      if (mbCfg.session_id && !opts._retried && isMissingResumeErrorText(final)) {
        await persistSiblingSession(null);
        mbCfg.session_id = null;
        sysOut(`@${selectedName}: stored thread could not be resumed; cleared it and retrying fresh.`);
        return runMetaBrainTurn(text, onPartial, selectedName, { ...opts, _retried: true });
      }
      const newSessionId = result?.optionsPatch?.sessionId;
      if (brainType === 'codex' && newSessionId && newSessionId !== mbCfg.session_id) {
        mbCfg.session_id = newSessionId;
        await persistSiblingSession(newSessionId);
      }
      // Empty successful reply → silence protocol marker. Was previously
      // the verbose string '(no reply)' which the dispatcher would ship
      // to chat as a real message. Now: empty == '...' == drop.
      return final.trim() || '...';
    } catch (e) {
      return `!! @${name}: ${e.message}`;
    }
  }

  // Compact "Ns/Nm/Nh/Nd ago" for /egpt list. Local to this scope to
  // keep the slash handler self-contained.
  function humanAge(at) {
    const sec = Math.max(0, Math.floor((Date.now() - at) / 1000));
    if (sec < 60)    return `${sec}s ago`;
    if (sec < 3600)  return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return `${Math.floor(sec / 86400)}d ago`;
  }

  // Read the persona state out of EGPT_CONFIG.default_brain into the
  // shape persona-state.mjs functions expect. Reverse of
  // persistDefaultBrainState below.
  function readDefaultBrainState() {
    const cfg = EGPT_CONFIG.default_brain ?? {};
    return {
      type:       cfg.type        ?? DEFAULT_PERSONA_BRAIN.type,
      session_id: cfg.session_id  ?? null,
      url:        cfg.url         ?? null,
      history:    Array.isArray(cfg.history) ? cfg.history : [],
    };
  }

  // Persist a persona-state.mjs state object back to ~/.egpt/config.json
  // and EGPT_CONFIG.default_brain. Preserves any unrelated fields the
  // user has set on default_brain (allowed_tools, system_prompt, cwd).
  async function persistDefaultBrainState(state) {
    const { readConfig, writeConfig } = await import('./src/tools/config-io.mjs');
    const cfg = await readConfig();
    if (!cfg.default_brain || typeof cfg.default_brain !== 'object') cfg.default_brain = {};
    // Merge in-memory default_brain fields that may not yet be on
    // disk (e.g. identityInjected flag set during the install turn
    // earlier this session).
    cfg.default_brain = { ...cfg.default_brain, ...(EGPT_CONFIG.default_brain ?? {}) };
    cfg.default_brain.type        = state.type;
    cfg.default_brain.session_id  = state.session_id;
    cfg.default_brain.url         = state.url;
    cfg.default_brain.history     = state.history;
    EGPT_CONFIG.default_brain = cfg.default_brain;
    try { await writeConfig(cfg); }
    catch (e) { sysOut(`!! couldn't persist default_brain: ${e.message}`); }
  }

  // Run a single brain-turn for one session.
  // `messageText` is exactly what gets injected into the brain (or piped to
  // ccode in resume mode). The caller is responsible for prefixing
  // with [author]: when broadcasting or mirroring. Returns the brain's reply
  // text (string) on a substantive answer, or null on silence/error so the
  // caller knows whether to mirror it.
  // Load the identity file (path from config.brains.identity, default
  // ./e_identity.md). Returns null when set to 'off' or unreadable so
  // callers can skip silently.
  async function _loadIdentity() {
    const path = EGPT_CONFIG.brains?.identity ?? './e_identity.md';
    if (path === 'off' || !path) return null;
    try {
      const resolved = path.startsWith('/') || /^[A-Z]:[\\/]/i.test(path)
        ? path
        : join(APP_DIR, path);
      return await readFile(resolved, 'utf8');
    } catch (e) { swallow('identity.load', e, { expect: ['ENOENT'] }); return null; }
  }
  // Send the identity as a silent setup turn — '... system restarted,
  // new persona installed ...\n\n<content>' framing tells the brain
  // it's reading a system message, not a user prompt. Brain's ack is
  // discarded (no shell render); the in-tab / in-history conversation
  // keeps it, which is what matters for subsequent turns. Forced=true
  // bypasses the per-session 'already injected' check (used by
  // /identity to re-install on demand).
  // Install the manifest into the @e persona. Gate: only on a fresh
  // thread (no url / no session_id) unless forced. Used from
  // runDefaultBrainTurn (first @e dispatch) and from /identity @e
  // (operator's explicit re-install on the existing thread).
  async function _injectIdentityIntoPersona({ brain, sessionOpts, dbCfg, forced = false }) {
    if (!forced) {
      const hasThread = !!(dbCfg?.url || dbCfg?.session_id);
      if (hasThread) return '';
    }
    const identity = await _loadIdentity();
    if (!identity) return '';
    sysOut(`(installing persona into @e…)`);
    if (sessionOpts.targetId && brain.urlMatch) {
      cdp.activateTarget(sessionOpts.targetId).catch(e => console.error(`!! egpt.mjs:[promise-catch] ${e?.message ?? e}`));
      _osFocusBrainChrome();
    }
    let captured = '';
    try {
      // brains/claude-code writes `history` to stdin in stateless mode
      // (when sessionOpts.sessionId is null) and `message` in --resume
      // mode (when sessionId is set). Setting both to the same prompt
      // covers both paths — required for /egpt new (sessionId=null)
      // which previously crashed with "Input must be provided either
      // through stdin or as a prompt argument" because history was ''.
      const prompt = `... system restarted, new persona installed ...\n\n${identity}`;
      const r = await brain.stream(
        { history: prompt, message: prompt },
        (p) => { captured = p; },
        sessionOpts,
      );
      const final = (typeof r === 'object' ? (r.text ?? captured) : (r ?? captured) ?? '').trim();
      // Capture + persist the new session_id when claude spawned a fresh
      // session (sessionOpts.sessionId was null going in — typical for
      // /egpt new -> /identity chain). Without this, the next @e turn
      // would spawn YET ANOTHER fresh session and lose the identity we
      // just installed.
      const newSessionId = r?.optionsPatch?.sessionId;
      if (newSessionId && dbCfg && !isUrlBrain(canonicalBrainName(dbCfg.type ?? DEFAULT_PERSONA_BRAIN.type))) {
        try {
          const cur = readDefaultBrainState();
          if (cur.session_id !== newSessionId) {
            const next = recordSession(cur, newSessionId, { type: dbCfg.type ?? DEFAULT_PERSONA_BRAIN.type });
            await persistDefaultBrainState(next);
          }
        } catch (e) { console.error(`!! egpt.mjs:[catch] ${e?.message ?? e}`); /* best-effort persist */ }
      }
      if (final) {
        pushItem({
          id: Date.now() + Math.random(),
          author: `egpt@${SURFACE_TAG}`,
          body: final,
          _localOnly: true,
        });
      }
      return final;
    } catch (e) {
      sysOut(`!! identity install (@e) failed: ${e.message}`);
      return '';
    }
  }

  async function _injectIdentityIfNeeded({ routedTo, session, brain, opts, forced = false }) {
    // Only inject when this is genuinely a FRESH thread — no URL
    // for CDP brains, no session_id for CLI brains, both meaning
    // the brain has no prior conversation state to draw from.
    // /identity (forced=true) overrides this for explicit re-installs.
    if (!forced) {
      const hasThread = !!(opts?.url || opts?.sessionId || session.options?.url || session.options?.sessionId);
      if (hasThread) return;
    }
    const content = await _loadIdentity();
    if (!content) return;
    sysOut(`(installing persona into ${routedTo}…)`);
    // Bring Chrome forward BEFORE the install turn — chatgpt-cdp /
    // claude-cdp need their page focused to reliably accept typed
    // input. Without this, the install message is typed but the
    // page sits behind another window and the model never sees it
    // until the operator clicks Chrome by hand.
    if (brain.urlMatch && opts.targetId) {
      cdp.activateTarget(opts.targetId).catch(e => console.error(`!! egpt.mjs:[promise-catch] ${e?.message ?? e}`));
      _osFocusBrainChrome();
    }
    const setupMessage = `... system restarted, new persona installed ...\n\n${content}`;
    let captured = '';
    let final;
    try {
      const result = await brain.stream(
        { history: '', message: setupMessage },
        (partial) => { captured = partial; },
        opts,
      );
      final = typeof result === 'object' ? (result.text ?? captured) : (result ?? captured);
    } catch (e) {
      sysOut(`!! identity install failed for ${routedTo}: ${e.message}`);
      return;
    }
    // Render the brain's response so the operator can see how it
    // received the install. _localOnly keeps it out of the bridge
    // mirrors — this is setup chatter, not conversation. The author
    // tag matches the session so it looks like a brain turn in shell.
    const trimmed = (final ?? '').trim();
    if (trimmed) {
      pushItem({
        id: Date.now() + Math.random(),
        author: routedTo,
        body: trimmed,
        _localOnly: true,
      });
    }
    // No flag to persist — the thread's own url / session_id (which
    // the brain assigns and we record on the next turn) is the
    // signal that the identity is already in the conversation.
    // Subsequent dispatches see opts.url / opts.sessionId set and
    // skip the install gate above.
  }

  async function runBrainTurn(routedTo, messageOrObj, sessionMap = sessions, callOpts = {}) {
    const messageText = typeof messageOrObj === 'string' ? messageOrObj : (messageOrObj?.message ?? '');
    const askText    = typeof messageOrObj === 'string' ? null : (messageOrObj?.ask ?? null);
    const tgChatId  = callOpts.tgChatId  ?? null;
    const tgReplyTo = callOpts.tgReplyTo ?? null;
    const waChatId  = callOpts.waChatId  ?? null;
    // ROOM DISPATCH: when true, this turn produces ONLY a return value — no
    // bridge streams, no committed shell item, no conversation.md append. The
    // caller (_deliverToRoom) mirrors the text to the room's members itself.
    // Without this, a room brain reply with no tg/wa chat id falls back to the
    // bridge's lastChat — re-introducing the leak class we just removed. Default
    // off, so the normal shell @session path is unchanged.
    const noBridge = !!callOpts.noBridge;
    // show-think: when true for this TG chat, the streaming "thinking" message
    // is frozen in place and the clean final reply is posted as a NEW message
    // (a reply to the original message that triggered the turn).
    // Toggle via: /e auto show-think on|off
    const tgShowThink = !!(tgChatId && (EGPT_CONFIG.telegram?.show_think_chats ?? []).includes(String(tgChatId)));
    // Bridge selection rule: when a turn was triggered by an upstream
    // bridge (Telegram OR WhatsApp), only that bridge gets the reply
    // (route back to the chat that asked). For local typing, both
    // bridges send (each to their lastChat).
    const fromAnyBridge = !!tgChatId || !!waChatId;
    const session = sessionMap[routedTo];
    if (!session) { sysOut(`!! no session "${routedTo}"`); return null; }
    const brain = brainForName(session.brain);
    if (!brain) { sysOut(`!! brain not found: ${session.brain}`); return null; }

    let opts = session.options;
    if (brain.urlMatch) {
      // Same pre-flight as /attach: if Chrome isn't reachable for a
      // CDP brain, auto-spawn it. The operator opted into Chrome
      // auto-start (chrome.focus_on_dispatch defaults align), and
      // bouncing them with 'Cannot reach Chrome at localhost:9221'
      // when the session already exists is the wrong shape.
      if (!(await cdp.isRunning())) {
        sysOut('chrome not reachable — starting it with the extension…');
        try { await spawnChromeWithExtension(); }
        catch (e) { sysOut(`!! chrome start failed: ${e.message}`); return null; }
      }
      let needsRebind = !opts.targetId;
      if (opts.targetId) {
        try {
          const live = await cdp.findTab(opts.targetId);
          if (!live) needsRebind = true;
        } catch (e) { sysOut(`!! ${routedTo}: ${e.message}`); return; }
      }
      if (needsRebind) {
        try {
          let matches = (await cdp.listTabs()).filter(t => brain.urlMatch.test(t.url));
          if (matches.length === 0 && brain.homeUrl) {
            // No tab matches — auto-open at brain.homeUrl (or the
            // session's saved url if we have one). Mirrors the
            // /attach pre-flight so the operator doesn't have to
            // run /open <brain> as a separate step.
            const openUrl = session.options?.url || brain.homeUrl;
            sysOut(`no ${session.brain} tab open — opening ${openUrl}…`);
            try {
              const tid = await cdp.openTab(openUrl);
              opts = { ...opts, targetId: tid };
              session.options = opts;
              setSessions(s => ({ ...s, [routedTo]: { ...(s[routedTo] ?? session), options: opts } }));
              matches = [{ id: tid }];        // pretend the tab was already there
            } catch (e) { sysOut(`!! could not open ${session.brain} tab for ${routedTo}: ${e.message}`); return null; }
          }
          if (matches.length === 1) {
            opts = { ...opts, targetId: matches[0].id };
            session.options = opts;
            setSessions(s => ({ ...s, [routedTo]: { ...(s[routedTo] ?? session), options: opts } }));
            await writeBrainProfileState(routedTo, { ...session, options: opts })
              .catch(e => sysOut(`!! profile state: ${e.message}`));
            sysOut(`(auto-bound ${routedTo} to tab ${opts.targetId.slice(0, 8)}…)`);
          } else if (matches.length === 0) {
            sysOut(`!! no open ${session.brain} tabs for ${routedTo}. open one in the brain Chrome.`);
            return;
          } else {
            const lst = matches.map(t => `  ${t.id.slice(0, 8)}…  ${t.url}`).join('\n');
            sysOut(`!! multiple ${session.brain} tabs open for ${routedTo} — pick one:\n${lst}`);
            return;
          }
        } catch (e) { sysOut(`!! ${routedTo}: ${e.message}`); return null; }
      }
    }
    for (const req of (brain.requires ?? [])) {
      if (!opts[req]) {
        sysOut(`!! session ${routedTo} (${session.brain}) missing ${req}. /open ${session.brain} <name>.`);
        return null;
      }
    }

    // Identity auto-injection disabled per operator (2026-05-19):
    // "never inject identity. sysadmin inject on demand." Run
    // /identity @<session> to force inject. The slash command still
    // calls _injectIdentityIntoPersona / _injectIdentityIfNeeded
    // directly; only the auto path is off.

    setStreaming({ author: routedTo, text: '' });

    // Activate the brain tab so the operator can watch the streaming
    // reply in Chrome without having to alt-tab to it. Only fires for
    // CDP brains that have a live targetId. Two layers:
    //   1. CDP: Target.activateTarget + Page.bringToFront. Best-effort;
    //      CDP errors are swallowed inside activateTarget.
    //   2. OS-level focus theft (chrome.focus_on_dispatch='on' default).
    //      Windows AppActivate-by-PID, macOS osascript, Linux wmctrl.
    //      Fixes the case where Chrome window itself is behind another
    //      app — CDP alone often can't break Windows' SetForegroundWindow
    //      restrictions, so the OS path actually clicks Chrome forward.
    if (brain.urlMatch && opts.targetId) {
      cdp.activateTarget(opts.targetId).catch(e => console.error(`!! egpt.mjs:[promise-catch] ${e?.message ?? e}`));
      _osFocusBrainChrome();
    }

    // If Telegram is connected, send a placeholder message that we'll edit
    // in place as the stream progresses. This gives Telegram users the
    // same "thinking → text" experience as the local shell. The eventual
    // committed item is tagged _localOnly so we don't double-deliver.
    const sessEmoji = sessionMap[routedTo]?.emoji ?? '❓';
    const authorPrefix = `${sessEmoji} <b>${escapeHtml(routedTo)}@${SURFACE_TAG}</b>`;
    // tgChatId / waChatId route the streaming reply to the chat that
    // originated the request. When fromAnyBridge is true we only call
    // the originating bridge; for local typing we call both (each goes
    // to its target chat — see resolveWaStreamTarget below for the
    // /join-aware WA target).
    // Stream to a bridge ONLY when this turn explicitly came from that bridge
    // (route the reply back to the chat that asked). NEVER fall back to the
    // bridge's lastChat: that sends a shell/room-initiated reply to whatever
    // WA/TG chat happened to message last — which leaked @e's answer to the
    // operator into Eduardo's chat (operator 2026-06-02). Shell/room replies
    // reach the operator via the shell + self-DM mirror + the room — never a
    // bridge guess. (Removing the legacy /join deleted _waJoinedFirst, which had
    // been masking this lastChat fallback.)
    const tg = (!noBridge && tgChatId)
      ? bridgeRef.current?.startStreamMessage?.(
          tgShowThink
            ? renderThink({ header: `💭 ${authorPrefix}`, body: '', escape: escapeHtml })
            : `${authorPrefix}\n⌛ thinking…`,
          { chatId: tgChatId })
      : null;
    const waPrefix = `${routedTo}@${SURFACE_TAG}`;
    // Named-brain reply: replyAllowed:true because the brain was explicitly
    // addressed (the caller already nulled waChatId for mute/off/paused chats);
    // the chokepoint re-confirms via the same gate. waChatId here is only set
    // for a chat the gate already permitted.
    const wa = (!noBridge && waChatId)
      ? streamFactoryRef.current?.(`${waPrefix}\n⌛ thinking…`, { chatId: waChatId, replyAllowed: true, persona: routedTo })
      : null;
    const tgFmt = (text) => {
      // Show only the trailing ~3500 chars during streaming so it fits in
      // Telegram's 4096-char message cap (even with our prefix).
      const tail = text.length > 3500 ? '…' + text.slice(-3500) : text;
      return `${authorPrefix}\n${escapeHtml(tail)} ⌛`;
    };

    let lastStreamingText = '';
    try {
      const history = await readFile(FILE, 'utf8');
      const result = await brain.stream(
        { history, message: messageText, ask: askText },
        partial => {
          lastStreamingText = partial;
          setStreaming({ author: routedTo, text: partial });
          // show-think streams the live thinking with the "(thinking... 🤔)"
          // suffix (HTML-escaped body); otherwise the plain "… ⌛" stream.
          tg?.update(tgShowThink
            ? renderThink({ header: `💭 ${authorPrefix}`, body: partial, escape: escapeHtml })
            : tgFmt(partial));
          // WhatsApp doesn't support edit-streaming the way Telegram
          // does. We only forward update() so the bridge's buffer stays
          // current; finish() does the single send.
          wa?.update(`${waPrefix}\n${partial}`);
        },
        { ...opts, sessionName: routedTo, userName: USER_NAME },
      );
      const final = typeof result === 'object' && result !== null
        ? (result.text ?? '')
        : (result ?? '');
      if (result?.optionsPatch) {
        const patchedOptions = { ...opts, ...result.optionsPatch };
        session.options = patchedOptions;
        setSessions(s => {
          const base = s[routedTo] ?? session;
          return {
            ...s,
            [routedTo]: {
              ...base,
              options: { ...base.options, ...result.optionsPatch },
            },
          };
        });
        await writeBrainProfileState(routedTo, { ...session, options: patchedOptions })
          .catch(e => sysOut(`!! profile state: ${e.message}`));
      }
      setStreaming(null);
      const trimmed = (final ?? '').trim();
      const streamSnapshot = lastStreamingText.trim();
      if (!noBridge && streamSnapshot && streamSnapshot !== trimmed) {
        pushItem({
          id: Date.now() + Math.random(),
          author: routedTo,
          body: streamSnapshot,
          _thinking: true,
          _localOnly: true,
        });
      }
      // Per-bridge "already-streamed" tags. The reply has just been
      // streamed-and-finished into tg (if any) and into one WA chat
      // (waStreamChatId — origin chat for WA-arrived, first joined
      // for local). Tag the local item so the items-mirror skips the
      // bridges/chats that already got it WITHOUT blocking fan-out
      // to OTHER joined WA chats. _localOnly fallback only when we
      // streamed to WA via lastChat (unknown chat) and there are no
      // joined targets to fan out to.
      const tagsAlreadySent = {
        ...(tg ? { _source: 'telegram' } : {}),
        ...(wa ? { _sourceChatId: waChatId } : {}),   // wa only set when waChatId is explicit
      };
      const isSilence = /^(\.{3,}|…+)$/.test(trimmed);
      if (isSilence) {
        // Quiet ack: render as the session itself with a single em-dash body,
        // both locally and on Telegram.
        await tg?.finish(`${authorPrefix}\n—`);
        await wa?.finish(`${waPrefix}\n—`);
        if (!noBridge) pushItem({
          id: Date.now() + Math.random(), author: routedTo, body: '—',
          _silent: true,
          ...tagsAlreadySent,
        });
        return null;
      }
      // Finalize the streaming bridge messages with the full text.
      const finalTail = final.length > 3900 ? '…' + final.slice(-3900) : final;
      if (tgShowThink && tg) {
        // show-think mode: freeze the in-progress streaming message as the
        // "thinking" artifact (💭 + the last streamed snapshot) with the
        // "(done ✅)" finished signal, then post the clean final as a NEW reply
        // to the original message.
        const snap = lastStreamingText.trim();
        await tg.finish(renderThink({ header: `💭 ${authorPrefix}`, body: snap, escape: escapeHtml, done: true }));
        bridgeRef.current?.send?.(`${authorPrefix}\n${mdToTgHtml(finalTail)}`,
          { chatId: tgChatId, replyTo: tgReplyTo ?? undefined });
      } else {
        await tg?.finish(`${authorPrefix}\n${mdToTgHtml(finalTail)}`);
      }
      await wa?.finish(`${waPrefix}\n${final}`);
      if (!noBridge) {
        pushItem({
          id: Date.now() + Math.random(), author: routedTo, body: final,
          ...tagsAlreadySent,
        });
        await append(`${routedTo}@${SURFACE_TAG}`, final);
      }
      return final;
    } catch (e) {
      setStreaming(null);
      await tg?.finish(`${authorPrefix}\n!! ${escapeHtml(e.message)}`);
      await wa?.finish(`${waPrefix}\n!! ${e.message}`);
      sysOut(`!! ${routedTo}: ${e.message}`);
      return null;
    }
  }

  const submit = async (raw, meta = {}) => {
    const text = raw.trim();
    if (!text) return;

    // Limb (CLIENT): forward the typed line to the spine over the socket and
    // stop. The spine runs the interpreter and echoes the input + any reply
    // back as ITEM frames, which the attach-client effect renders — so a limb
    // never runs the engine pipeline locally (no double-dispatch, no local
    // room/state writes). Bridge-arrival / re-dispatch metas don't exist on a
    // limb (those subsystems are gated off), so this covers all limb input.
    if (CLIENT) {
      const h = _attachClientRef.current;
      if (h?.connected) h.input(text);
      else errOut('not attached to a spine yet — is the engine running? retrying…');
      return;
    }

    // Shell user input (bare meta — not a bridge arrival or a broadcast
    // re-dispatch) goes through the interactive help menu first.
    if (!meta.fromWhatsApp && !meta.fromTelegram && !meta.forceTarget && !meta.autoDispatched
        && _maybeHandleHelp(text, { surface: 'shell', chatKey: 'shell', isOperator: true })) {
      return;
    }

    // Shell as a first-class room member: the operator's own shell text fans
    // into any room the shell is an active/mention member of. Additive (doesn't
    // replace /use routing), gated + loop-safe inside _maybeRouteToRooms.
    // Bare-meta only — re-dispatched / bridge-arrival items aren't shell input.
    // No content classification: the per-member state (active/mention/mute) is
    // what controls whether the shell contributes, not the message kind.
    // Loop guard: a submit that ITSELF originated from room delivery (so a
    // routed @cgpt1 hello gets dispatched to cgpt1) must not re-route — that
    // would re-fan the same body back into the room. Loop-safe on the same
    // principle as isRoomEnvelope on the wa-group side.
    if (!meta.fromWhatsApp && !meta.fromTelegram && !meta.forceTarget && !meta.autoDispatched && !meta._routedFromRoom) {
      // Enriched senderLabel: {user}@{node}.shell (HH:MM) — same shape as
      // the WA route's {pushName}@{chatName}.wa (HH:MM), so readers can tell
      // which surface and which node a routed line came from.
      const _hhmm = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      _maybeRouteToRooms({
        memberId: 'shell',
        senderLabel: `${USER_NAME}@${BUS_NODE_ID}.shell (${_hhmm})`,
        body: text,
      }).catch(e => errOut(`!! _maybeRouteToRooms(shell): ${e?.message ?? e}`));
    }

    // Tell sysOut where this submit's output should go. fromTelegram means
    // the user issued the command from Telegram and the response should
    // flow back there; otherwise it stays local. Reset in finally so a
    // crashing submit doesn't leak the 'remote' sink to later sysOut calls
    // (e.g. bus event logs).
    outputSinkRef.current = meta.fromTelegram ? 'telegram'
      : meta.fromWhatsApp ? 'whatsapp'
      : 'local';
    try {
    return await submitInner(raw, text, meta);
    } finally {
      outputSinkRef.current = 'local';
    }
  };

  const submitInner = async (raw, text, meta = {}) => {

    // Voice-streaming branch (operator 2026-05-22). When a WA voice
    // note arrived in streaming mode, the bridge fires onIncoming
    // immediately (before transcription completes) with a handle in
    // meta.voiceStream. The whole turn — chunk subscription, per-chunk
    // brain passes, the evolving WA stream message, the final '.'
    // marker — lives in src/voice-stream.mjs (Phase C extraction);
    // this branch just wires the App's live deps into it.
    if (meta.voiceStream && meta.fromWhatsApp) {
      const personaName = 'e';
      const personaCfg = (EGPT_CONFIG.siblings ?? {})[personaName] ?? {};
      await runVoiceStreamTurn(meta, {
        personaName,
        personaEmoji: personaCfg.body_emoji ?? EGPT_PERSONA_EMOJI,
        eMayReplyToChat: _eMayReplyToChat,
        openStream: (body, opts) => streamFactoryRef.current?.(body, opts),
        getChatSlug: (id) => waBridgeRef.current?.getChatSlug?.(id) ?? null,
        getChatName: (id) => waBridgeRef.current?.getChatName?.(id) ?? null,
        runDefaultBrainTurn,
        errOut,
        pushItem,
        surfaceTag: SURFACE_TAG,
      });
      return;
    }

    // Wizard mode: /create-profile interactive questions intercept all input.
    if (wizardRef.current) {
      pushItem({ id: Date.now() + Math.random(), author: 'You', body: text });
      wizardRef.current.answer(text);
      return;
    }

    // @m<N> reply syntax — shell-typed only. Looks up the short id
    // (assigned in render order) and routes the body as a reply via
    // the originating bridge:
    //   WA: sock.sendMessage with quoted (carries the original key)
    //   TG: bot.sendMessage with reply_to_message_id
    //   brain reply: dispatch to that brain as a follow-up
    //   local typing / system: refuses with a hint
    if (!meta.fromTelegram && !meta.fromWhatsApp) {
      // Two reply forms:
      //   @m<N> body         — session-local short id (resets on restart)
      //   @<stable-id> body  — stable id (wa-<key>, tg-<chat>-<msg>, or
      //                        the kind-prefixed random for non-bridge
      //                        items). Survives restart because the
      //                        sidecar persists the target.
      const mShortMatch = text.match(/^@m(\d+)\s+([\s\S]+)$/i);
      // Accept either '@wa-XXX' or '@wa_XXX' as the leading separator.
      // /recap displays ids with underscore so terminal double-click
      // selects the whole token; the canonical sidecar form keeps
      // the hyphen, so we normalize underscore → hyphen below before
      // any lookup. Internal hyphens (tg-<chatId>-<msgId>) stay.
      const mStableMatch = !mShortMatch && text.match(/^@((?:wa|tg|b|u|s|p)[-_][A-Za-z0-9-]+)\s+([\s\S]+)$/i);
      if (mShortMatch || mStableMatch) {
        // What the operator typed is the sacred record — echo it
        // BEFORE the lookup runs, so that even when the lookup fails
        // (missing target, ambiguous prefix) the input still lands in
        // the transcript verbatim. Errors surface as separate system
        // lines AFTER. _localOnly because failed lookups must NOT
        // mirror to bridges — we don't know where the reply was meant
        // to go, and broadcasting "@u-uucdp3 …" to TG/WA as plain
        // text would be confusing.
        const _echoFailedReply = () => {
          pushItem({
            id: Date.now() + Math.random(),
            author: 'You', body: text, _localOnly: true,
          });
          if (!_suppressTranscriptRef.current) void append('You', text);
        };
        let shortId, body, target, rt;
        if (mShortMatch) {
          shortId = `m${mShortMatch[1]}`;
          body = mShortMatch[2].trim();
          target = itemByShortId.current.get(shortId);
          if (!target) {
            _echoFailedReply();
            sysOut(`!! ${shortId}: no message with that id in this session — try @<stable-id> for cross-session reference`);
            return;
          }
          rt = target._replyTarget;
        } else {
          // Normalize underscore form to the canonical hyphen form
          // before any sidecar lookup. Operator can type either; the
          // shell internally tracks 'wa-X' / 'tg-X' / etc.
          const stableId = mStableMatch[1].replace(/^([a-z]+)_/, '$1-');
          body = mStableMatch[2].trim();
          shortId = stableId;        // for echo / log labels
          // Try in-memory first (faster + has all fields), fall back
          // to persisted sidecar (item may have rotated out / be from
          // a previous session). Prefix-match against persisted keys
          // so the operator can type just enough of a long bridge id.
          target = itemByStableId.current.get(stableId) ?? null;
          if (target) {
            rt = target._replyTarget;
          } else {
            // Exact match first.
            rt = persistedReplyTargets.current.get(stableId) ?? null;
            if (!rt) {
              // Prefix-match (single hit only — ambiguous prefixes refuse).
              const matches = [...persistedReplyTargets.current.keys()].filter(k => k.startsWith(stableId));
              if (matches.length === 1) {
                rt = persistedReplyTargets.current.get(matches[0]);
                shortId = matches[0];
              } else if (matches.length > 1) {
                _echoFailedReply();
                sysOut(`!! @${stableId}: ambiguous, matches ${matches.length} ids:\n  ${matches.slice(0, 5).join('\n  ')}${matches.length > 5 ? `\n  …` : ''}`);
                return;
              }
            }
          }
          if (!rt) {
            _echoFailedReply();
            sysOut(`!! @${stableId}: no message with that id (current session or persisted sidecar)`);
            return;
          }
          // Synthesise a minimal 'target' so the brain-fallback branch
          // below doesn't crash on a null target. It can't have a body
          // (we don't persist message bodies in the sidecar, only the
          // reply key), but the bridge paths only need _replyTarget.
          if (!target) target = { author: '', body: '', _replyTarget: rt };
        }
        // Normalize to an array — _replyTarget can be a single
        // {kind, …} (most common: bridge-arrived or single-target
        // shell send) or an array (multi-WA fan-out via /use). All
        // are dispatched the same way.
        const rtList = Array.isArray(rt) ? rt : (rt ? [rt] : []);
        const waTargets = rtList.filter(t => t?.kind === 'wa');
        const tgTargets = rtList.filter(t => t?.kind === 'tg');
        // Collect the WA send-result keys so the echo can carry the
        // resulting messages as _replyTarget — that makes the echo's
        // stable id wa-<key.id> (instead of a random u-<rnd>) and
        // future '@wa-<key> body' references can quote it.
        const echoReplyTargets = [];
        if (waTargets.length) {
          const wa = waBridgeRef.current;
          for (const t of waTargets) {
            if (!wa?.replyTo) {
              try {
                const r = await wa?.send?.(body, { chatId: t.chatId });
                if (r?.key) echoReplyTargets.push({
                  kind: 'wa', chatId: t.chatId, key: r.key, raw: { conversation: body },
                });
              } catch (e) { sysOut(`!! @${shortId} wa send failed: ${e.message}`); }
            } else {
              try {
                const r = await wa.replyTo({ chatId: t.chatId, key: t.key, raw: t.raw, text: body });
                if (r?.key) echoReplyTargets.push({
                  kind: 'wa', chatId: t.chatId, key: r.key, raw: { conversation: body },
                });
              } catch (e) { sysOut(`!! @${shortId} wa reply failed: ${e.message}`); }
            }
          }
        }
        if (tgTargets.length) {
          const tg = bridgeRef.current;
          for (const t of tgTargets) {
            if (tg) {
              try {
                const r = tg.send(body, { chatId: t.chatId, replyTo: t.msgId });
                // TG bridge.send isn't awaitable in the same way; if a
                // future change makes it return the message id we can
                // collect it the same way as wa above.
                void r;
              } catch (e) { sysOut(`!! @${shortId} tg reply failed: ${e.message}`); }
            }
          }
        }
        if (waTargets.length || tgTargets.length) {
          // Echo + record locally — typed prompt is sacred, so the
          // body is the operator's raw input verbatim (text), not a
          // reconstructed '↳ @<full-id>\n<body>'. If the operator
          // typed '@wa-3AE05786 hola' we echo exactly that; the
          // resolved full key still drives the actual WA send via rt,
          // it just doesn't pollute the visible/logged form.
          const rt = echoReplyTargets.length === 1
            ? echoReplyTargets[0]
            : (echoReplyTargets.length > 1 ? echoReplyTargets : undefined);
          pushItem({
            id: Date.now() + Math.random(), author: 'You',
            body: text,
            _directWa: !!waTargets.length,
            _localOnly: !waTargets.length && !!tgTargets.length,
            ...(rt ? { _replyTarget: rt } : {}),
          });
          void append('You', text);
          if (rt) _scheduleReplyTargetSave();
          return;
        }
        // No bridge origin (brain reply, peer message, local-typed
        // without /use). Brain replies route as a follow-up to that
        // brain session: echo preserves '@m<N>' as the user typed
        // it, the brain prompt embeds the quoted message + a
        // qualified sender header so it has the conversational
        // context to answer 'what about <body>' against the line
        // the operator was actually replying to.
        const targetSession = (target.author ?? '').split('@')[0];
        if (sessions[targetSession]) {
          // Typed prompt is sacred — echo the raw input. The brain
          // prompt below still gets the resolved quote + sender
          // header; only the visible/transcript form stays verbatim.
          pushItem({
            id: Date.now() + Math.random(), author: 'You',
            body: text,
          });
          void append('You', text);
          // Brain prompt: include the quoted message + qualified
          // sender header. Brain has no concept of m-ids, so we
          // resolve to the actual previous text.
          const quoted = (target.body ?? '').split('\n')[0].slice(0, 280);
          const senderTag = `${USER_NAME}@${SURFACE_TAG}`;
          const brainPrompt = `[${senderTag} ${ts()}]: > ${quoted}\n${body}`;
          await runBrainTurn(targetSession, brainPrompt, sessions);
          return;
        }
        // Same sacred-input rule as the lookup-failure branches above:
        // echo what the operator typed BEFORE reporting that the
        // target's neither a bridge message (no _replyTarget) nor a
        // brain session. Without the echo, the operator's text just
        // disappears, leaving only the error.
        _echoFailedReply();
        sysOut(`!! @${shortId}: no bridge origin recorded — can only reply to bridge or brain messages`);
        return;
      }
    }

    // Echo everything the user types into the transcript. If the input came
    // from Telegram, attribute the echo to the actual Telegram user (with
    // the via tag) instead of the local 'You', and tag _localOnly so the
    // echo doesn't get sent back to the same Telegram chat — that user
    // already saw their own message.
    //
    // Slash commands are operations, not conversation — even local ones
    // should NOT replicate to Telegram. Otherwise viewers see noise like
    // 'An@home /sessions' / 'An@home /restart'. So _localOnly fires
    // either when the input came from Telegram OR when it's a command.
    // Author tag for the visible echo: handle@client[.node].
    //   * shell-typed: 'You' (resolved to USER_NAME@SURFACE_TAG by the
    //     renderer; preserves the existing 'An@kg' look — shell has no
    //     client_name by default, so the tag drops the client part).
    //   * bridge-typed: stripAt(handle)@<client_name> where client_name
    //     comes from cfg.<bridge>.client_name (default 'wa', 'tg').
    //     User can rename, e.g. whatsapp.client_name='moto' for a phone.
    // The chatId stays in the bus event's via:`<surface>[<chatId>]` for
    // routing back to the originating chat, but observers reading the
    // transcript don't need the JID.
    const waClient = EGPT_CONFIG.whatsapp?.client_name ?? 'wa';
    const tgClient = EGPT_CONFIG.telegram?.client_name ?? 'tg';
    // waClientLabel: when the WA arrival is from a group, the bridge
    // overrides the bare client_name with '<group-slug>.wa' so the
    // handle conveys the group. Falls back to waClient for 1:1 chats.
    const waClientForTag = meta.waClientLabel ?? waClient;
    const echoAuthor = (meta.fromTelegram && meta.telegramUser)
      ? `${stripAt(meta.telegramUser)}@${tgClient}`
      : (meta.fromWhatsApp && meta.waUser)
      ? `${stripAt(meta.waUser)}@${waClientForTag}`
      : 'You';
    const isSlashCommand = text.startsWith('/');
    // Direct-WA send detection. Two shell-typed shapes route a message
    // straight to a specific WA chat instead of the default self-DM
    // mirror: explicit '@waN <body>' (the handler further down does
    // the send), and the /join-bound mode where every plain message
    // is destined for the joined chat. In either case we tag the echo
    // _directWa so the wa-items-mirror skips it — otherwise the same
    // message also lands in 'Message Yourself', which was the bug.
    const isAtWaNExplicit = !meta.fromTelegram && !meta.fromWhatsApp
      && /^@wa\d+\s+/i.test(text);
    const willDirectWa = !isSlashCommand && !meta.fromTelegram && !meta.fromWhatsApp
      && (isAtWaNExplicit || _waJoinedSize() > 0);
    // Slash commands are operator tooling, not part of the conversation
    // — they stay local. Bridge-arrived messages mirror to OTHER bridges
    // (e.g. WA arrival → TG mirror) but skip the bridge they came from
    // (no echo loop). _source carries the origin so each surface's
    // items-mirror can decide.
    const echoSource = meta.fromTelegram ? 'telegram'
      : meta.fromWhatsApp ? 'whatsapp'
      : null;
    // observeOnly: this submit came from a chat the operator hasn't
    // designated as an egpt chat (e.g. a friend's WhatsApp DM) AND
    // hasn't /join'd. egpt stays silent on every surface for those —
    // listens for @persona wake-words and replies to the originating
    // chat, but the line itself doesn't appear in the transcript or
    // ride the bus. /join @waN opts a specific chat into full
    // visibility; that override happens upstream of submitInner so by
    // the time we get here, meta.observeOnly already reflects whether
    // this message should be surfaced.
    const echoItemId = Date.now() + Math.random();
    // _routedFromRoom: this submit is a room delivery re-dispatched ONLY so a
    // routed `@cgpt1 …` reaches its brain. The room envelope was already shown
    // + persisted by _deliverToRoom, so suppress the echo here (else the same
    // line duplicates as a wrong-author 'You' entry). resolveRoute below still
    // runs, so the @mention dispatch is unaffected.
    if (!meta.observeOnly && !meta._routedFromRoom) {
      pushItem({
        id: echoItemId, author: echoAuthor, body: text,
        ...(isSlashCommand ? { _localOnly: true } : {}),
        ...(echoSource ? { _source: echoSource } : {}),
        // _sourceChatId carries the WA chat this message arrived from
        // so the items-mirror can skip re-sending to the same chat
        // (origin) while still bridging to OTHER joined chats.
        ...(meta.fromWhatsApp && meta.waChatId ? { _sourceChatId: meta.waChatId } : {}),
        // _replyTarget — minimal info needed to send a proper reply
        // back to this message via '@m<N>' from the operator. For
        // bridge-arrived messages we have the original key here.
        // For shell-typed messages routed via /use @waN the keys are
        // captured AFTER the awaited wa.send below and patched onto
        // this same item id.
        ...(meta.fromWhatsApp && meta.waMsgKey
          ? { _replyTarget: { kind: 'wa', chatId: meta.waChatId, key: meta.waMsgKey, raw: meta.waMsgRaw ?? null } }
          : meta.fromTelegram && meta.telegramMessageId
          ? { _replyTarget: { kind: 'tg', chatId: meta.telegramChatId, msgId: meta.telegramMessageId } }
          : {}),
        ...(willDirectWa ? { _directWa: true } : {}),
      });
      // Full-clarity logging: persist every input — slash commands,
      // mentions, plain text — to the room transcript. Same FIFO
      // queue that sysOut uses, so input and the system output that
      // follows land in order. Later appends in the @e / peer-mention
      // / brain-dispatch paths used to do this only for non-slash
      // inputs; with this here they'd duplicate, so those have been
      // removed.
      //
      // View commands like /last suppress this — they're querying
      // history, not adding to it. Detected at parse time so the
      // echo line itself never makes it to disk for those.
      const isViewCommand = /^\/(last)(\s|$)/.test(text);
      if (!isViewCommand) void append(echoAuthor, text);
    } else {
      logOut(`(observed) ${echoAuthor}: ${text}`);
    }

    // Bus broadcast of the operator's utterance moved to AFTER
    // resolveRoute (search below for `// bus broadcast (room-utterance)`).
    // Operator (2026-05-21): "router first, then {brain dispatch, mirror}"
    // — TG mirror shouldn't happen before the routing decision has been
    // made and (for persona dispatches) the brain has been kicked off.
    // The broadcast is still fire-and-forget so it doesn't delay the
    // brain.

    // skipRoute: replication-only mode. Used when a Telegram plain-text
    // message reaches the room but the mirror policy says don't trigger
    // brain calls. The room-utterance broadcast happens below after
    // resolveRoute (but for skipRoute we ALSO want the broadcast since
    // the whole point is mirror-without-routing) — handled by the
    // doBroadcast() call before the early return.
    const _broadcastRoomUtterance = () => {
      const tid = busTargetIdRef.current;
      if (!tid || isSlashCommand || meta.observeOnly) return;
      const fromTg = !!meta.fromTelegram;
      const fromWa = !!meta.fromWhatsApp;
      const via = fromTg ? `telegram[${meta.telegramChatId ?? '?'}]`
        : fromWa ? `whatsapp[${meta.waChatId ?? '?'}]`
        : null;
      const utteranceUser = fromTg ? (meta.telegramUser ?? USER_NAME)
        : fromWa ? (meta.waUser ?? USER_NAME)
        : USER_NAME;
      const client = fromTg ? tgClient
        : fromWa ? (meta.waClientLabel ?? waClient)
        : null;
      bus.postEvent(tid, {
        type: 'room-utterance', from: BUS_NODE_ID, ts: Date.now(),
        role: 'shell', user: utteranceUser, body: text,
        ...(client ? { client } : {}),
        ...(via ? { via } : {}),
      }).catch(e => console.error(`!! egpt.mjs:[promise-catch] ${e?.message ?? e}`));
    };

    if (meta.skipRoute) {
      // Plain-text TG with mirror policy = "mirror only" — still
      // broadcast so peers see it, just don't route to a brain.
      _broadcastRoomUtterance();
      return;
    }

    const parsed = parseInput(text);

    // Pure routing decision. resolveRoute looks at sessions + peerSessions
    // and returns one of: command, turn, auto-open, peer-mention, error,
    // empty. The dispatch below handles each kind with the side effects
    // (state updates, .md writes, bus posts, brain calls).
    const sessionsView = new Map(
      Object.entries(sessions).map(([n, s]) => [n, { brainName: s.brain }]),
    );
    const peerSessionsView = new Map(
      [...peerNodesRef.current.entries()].map(([id, p]) => [id, p.sessions ?? []]),
    );
    // Sibling registry (EGPT_CONFIG.siblings) — when present, becomes the
    // source of truth for @<name> routing in room.mjs. Each entry is
    // { session_id, cwd?, model?, emoji?, body_emoji?, aliases?[], type? } —
    // NO 'kind' tag; who is the chat persona is the top-level EGPT_CONFIG.
    // persona role pointer (default 'e'), resolved by name in room.mjs.
    // Absent / empty registry → legacy hardcoded routing (egpt/e/me/wren).
    const sibCfg = EGPT_CONFIG.siblings;
    const siblingsView = (sibCfg && typeof sibCfg === 'object')
      ? new Map(Object.entries(sibCfg).filter(([, v]) => v && typeof v === 'object'))
      : new Map();
    const decision = resolveRoute(parsed, text, {
      sessions: sessionsView, peerSessions: peerSessionsView,
      brainForName, canonicalBrainName, activeSessions,
      siblings: siblingsView,
      // @me is a PRONOUN that maps to a profile name (operator
      // 2026-05-23: "it should be me: name1 ... profiles are brains
      // that can be mentioned"). main_engineer names that profile.
      // Resolved in resolveRoute, NOT via a per-sibling aliases:[me]
      // (which collides if two profiles both claim "me").
      mainEngineer: EGPT_CONFIG.main_engineer ?? null,
      // persona names which being is the public chat voice (routes to
      // the persona path). A top-level role pointer, not a per-being
      // 'kind' tag. Default 'e'.
      personaName: EGPT_CONFIG.persona ?? 'e',
      // forceTarget — broadcast dispatch: route this raw message to the
      // named being regardless of any @-mention in the text. Set by the
      // auto_e bridge broadcast (one submit per resident). 2026-05-24.
      forceTarget: meta.forceTarget ?? null,
    });

    // Observed chats: egpt only acts on @<persona> wake-words. Any
    // other decision kind (commands, brain turns, peer-mentions, even
    // contextual hints) is suppressed — the user didn't ask egpt to
    // do anything; they're just chatting in a non-egpt chat that
    // egpt happens to listen to. Persona dispatch (above) handles the
    // @egpt case and replies directly to the originating chat.
    // Observed chats normally don't surface in the shell or trigger
    // commands — but slash commands from the operator's own account
    // (meta.fromWhatsApp + authorized === true) ARE operator intent
    // and should always run regardless of chat status. Without this
    // exception, /e auto on from inside an auto_e_chats group can
    // never enable that group (a chicken-and-egg: the chat is
    // observe-only UNTIL added to auto_e_chats, but the command to
    // add it is filtered out by the same observe-only gate).
    const isOperatorCommand = decision.kind === 'command' && meta.fromWhatsApp;
    // An explicit @<being> mention (meta dispatch) that is deliberate operator
    // intent bypasses observe-only suppression, same as operator commands —
    // either because the chat is whitelisted (auto_e_chats / self) OR because
    // the OPERATOR themself sent it (authorized = isSender). Without the
    // operator-authorship clause, "@l hola" the operator types in a plain
    // observed group (not in auto_e_chats) was SKIP'd as "observe-only meta"
    // and @l stayed silent (operator 2026-06-11). A NON-operator's @<being> in
    // a non-whitelisted chat is still suppressed, so random members can't
    // trigger @jay/@l there. 2026-05-24 / 2026-06-11.
    const isOperatorBeingMention = decision.kind === 'meta' && meta.fromWhatsApp && (!!meta.waWhitelisted || !!meta.authorized);
    if (meta.observeOnly && decision.kind !== 'persona' && !isOperatorCommand && !isOperatorBeingMention) {
      // Observed chat, no @e mention, not an operator command → no
      // dispatch. Log to activity log so "did @e see my message?" has
      // a grep-able answer: the message arrived, was observed, not
      // dispatched (because the chat is observe-only and the message
      // didn't include a @persona wake-word).
      try {
        const chatId = meta.waChatId ?? meta.telegramChatId ?? 'shell';
        const surface = meta.fromWhatsApp ? 'wa' : meta.fromTelegram ? 'tg' : 'shell';
        await mkdir(join(EGPT_HOME, 'state'), { recursive: true });
        const preview = String(text ?? '').slice(0, 80).replace(/\n/g, '↵');
        await appendFile(join(EGPT_HOME, 'state', 'e-activity.log'),
          `${new Date().toISOString()}\tSKIP\t${surface}/${chatId}\tobserve-only ${decision.kind}\t${preview}\n`);
      } catch (e) { console.error(`!! observe-skip activity-log: ${e?.message ?? e}`); }
      return;
    }

    // bus broadcast (room-utterance) — happens AFTER the router decision
    // is made, so peers see the message only once we know it's going to
    // be routed somewhere (persona / turn / peer-mention / etc.). Slash
    // commands and observed chats still don't broadcast. The call is
    // fire-and-forget, so it runs in parallel with the brain dispatch
    // below; the brain isn't delayed by the broadcast.
    _broadcastRoomUtterance();

    if (decision.kind === 'command') {
      const handled = await handleSlash(text, meta);
      if (!handled) {
        // Operator (2026-05-19): any unrecognized slash typed in Self
        // DM should route as a free-form prompt to system-e (instead
        // of '!! unknown command'). Lets operator say things like
        // '/whats diego's code-word' and get a real answer back.
        const selfDm = EGPT_CONFIG.whatsapp?.chat_id;
        const isSelfDm = meta?.fromWhatsApp && meta.waChatId && selfDm && meta.waChatId === selfDm;
        if (isSelfDm) {
          const prompt = text.replace(/^\s*\/+\s*/, '').trim();
          if (prompt) {
            try {
              // Dispatch as a normal turn to the Self DM @e thread.
              // ensureContact + system-personality routing happens
              // inside runDefaultBrainTurn; result flows back to the
              // chat the same way an auto-dispatch would.
              const cs = await _loadConvState();
              const selfContact = conversationsState.getContact(cs, 'whatsapp', selfDm);
              const slug = selfContact?.slug ?? null;
              const ctxForTurn = {
                threadId: selfDm,
                surface:  'whatsapp',
                slug,
                name:     selfContact?.entry?.pushedName || slug || 'self',
              };
              const reply = await runDefaultBrainTurn(prompt, () => {}, ctxForTurn);
              const replyText = String(reply ?? '').trim();
              if (replyText && replyText !== '...' && replyText !== '…') {
                const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
                const ev = { type: 'wa-send', from: 'e', ts: Date.now(), jid: selfDm, body: replyText };
                await writeFile(join(EGPT_HOME, 'outbox', id + '.json'), JSON.stringify(ev));
              }
            } catch (e) {
              sysOut(`!! /-prompt-to-system-e failed: ${e?.message ?? e}`);
            }
            return;
          }
        }
        sysOut(`!! unknown command: ${decision.cmd}`);
      }
      return;
    }

    // (Legacy /join "fan every plain shell message to a bound waJoinedRef set"
    // REMOVED 2026-06-02 — it bypassed the room router and leaked. Shell→group
    // is now ONLY via room membership (_deliverToRoom) or an explicit ad-hoc
    // @waN below. To bind a group to the shell, add it as a room member.)
    // @waN <body> — ad-hoc send to the Nth chat from the most-recent
    // /channels listing. Mirrors the extension's behavior. Only fires
    // for shell-typed input (a bridge-sourced @waN would loop). The
    // output line references the chat NAME so the user can confirm
    // they're hitting the right group, not just a number.
    if (!meta.fromTelegram && !meta.fromWhatsApp) {
      const waMatch = text.match(/^@wa(\d+)\s+([\s\S]+)$/i);
      if (waMatch) {
        const idx = parseInt(waMatch[1], 10) - 1;
        const body = waMatch[2].trim();
        const chat = _waChannelsCacheRef.current[idx];
        if (!chat) {
          sysOut(`!! @wa${idx + 1}: no channel at that index. Run /channels first.`);
          return;
        }
        const wa = waBridgeRef.current;
        if (!wa) { sysOut('!! @wa send: whatsapp bridge not running'); return; }
        try {
          const r = await wa.send(body, { chatId: chat.jid });
          sysOut(`→ @wa${idx + 1} "${chat.name}"`);
          // Same reply-to-self plumbing as the /use direct-send loop:
          // capture the WA msg key and patch the echo item so '@m<N>'
          // can quote it later.
          if (r?.key) {
            setItems(p => p.map(item =>
              item.id === echoItemId
                ? { ...item, _replyTarget: { kind: 'wa', chatId: chat.jid, key: r.key, raw: { conversation: body } } }
                : item));
            _scheduleReplyTargetSave();
          }
        } catch (e) {
          sysOut(`!! @wa send failed: ${e.message}`);
        }
        return;
      }
    }
    if (decision.kind === 'error') {
      sysOut(`!! ${decision.message}`);
      return;
    }
    if (decision.kind === 'empty') {
      // No local participants. The room may still have peer participants
      // — the room-utterance event already mirrored what was typed, so
      // those peers see it. Only show the "empty room" hint when nobody,
      // local or peer, can hear AND the message came from the local
      // shell (the hint coaches the operator typing here; bridge users
      // weren't asking for advice — they were chatting / replicating).
      const fromBridge = !!meta.fromTelegram || !!meta.fromWhatsApp;
      if (peerNodesRef.current.size === 0 && !fromBridge) {
        logOut('the room is empty — /attach to bring in CDP tabs, /open <brain> to register a participant, or /help for slash commands that work without a brain');
      }
      return;
    }
    if (decision.kind === 'idle') {
      // Plain text but no /use'd sessions. The message is already on the
      // bus (room-utterance posted earlier) so peers see it; we just
      // don't auto-call a brain. Hint how to opt in — but only for
      // shell-local input. Bridge-arrived text is conversational, not
      // an attempt to address a brain; the hint would be noise.
      if (meta.fromTelegram || meta.fromWhatsApp) return;
      const names = Object.keys(sessions).slice(0, 3).join(', ') || '(none)';
      logOut(`message stayed in the room — no active brain. Address one with @<name> (e.g. ${names}), or /use <name> (single) or /use a,b,c (multi-AI) for plain-text routing.`);
      return;
    }
    if (decision.kind === 'persona') {
      // @egpt — node-global default brain. Lives outside any room.
      // Persistent thread; replies go back through whichever bridge
      // (if any) carried the request.
      //
      // For an egpt chat (shell, TG bot DM, WA self-DM, or an
      // explicit egpt_chats entry) the reply ALSO mirrors to other
      // surfaces as a play-script reproduction. For an observed
      // chat (friend's DM, group), the reply is sent ONLY to the
      // originating chat — never mirrored anywhere. The operator
      // gets a /log entry as audit.

      // auto_e_chats busy/queue gate: if this message was
      // auto-dispatched (chatId ∈ auto_e_chats), check the per-chat
      // in-flight state. If e is already mid-turn for this chat,
      // pile the message into the queue and return immediately —
      // the running turn's finally block will drain the queue as
      // one combined dispatch after it completes.
      let queueState = null;
      if (meta.autoDispatched && meta.waChatId) {
        const chatId = meta.waChatId;
        queueState = _personaChatQueues.current.get(chatId);
        if (!queueState) {
          queueState = { inFlight: false, queue: [] };
          _personaChatQueues.current.set(chatId, queueState);
        }
        if (queueState.inFlight) {
          queueState.queue.push({
            body: decision.body,
            senderName: meta.waSenderName ?? 'someone',
            ts: Date.now(),
          });
          logOut(`auto_e_chats: piling msg for ${chatId} (queue=${queueState.queue.length})`);
          return;
        }
        queueState.inFlight = true;
      }

      // Input was already logged at the top-of-submitInner echo block.
      setBusy(true);
      try {
        // Persona prefix from siblings registry: name + body_emoji are
        // both registry-derived so @e ↔ 🐶 e (haiku), @egpt ↔ 🧠 egpt
        // (infrastructure), or whatever the operator wires. Falls back
        // to the legacy EGPT_PERSONA_EMOJI + 'egpt' label when the
        // registry is absent. Per operator (2026-05-17): "all llm must
        // have an id emoji" — every reply path consults the registry.
        const personaName = decision.name ?? 'egpt';
        const personaCfg  = (EGPT_CONFIG.siblings ?? {})[personaName] ?? {};
        const personaEmoji = personaCfg.body_emoji ?? personaCfg.emoji ?? EGPT_PERSONA_EMOJI;
        const bridgeForReply = meta.fromWhatsApp ? waBridgeRef.current
          : meta.fromTelegram ? bridgeRef.current
          : null;
        // Let the resident DRIVE commands: an own-line slash command in its
        // reply runs through the same handleSlash pipeline the operator uses,
        // in this chat's context. Gated by an allowlist (whatsapp.e_commands,
        // default ['react']); known-but-disallowed commands are stripped +
        // logged (never leak a raw "/restart" to the chat); unknown slashy
        // lines fold back into prose. Only reached past the reply gate.
        const runEmittedCommand = async (line, m) => {
          const cmdTok = line.trim().split(/\s+/)[0] ?? '';
          const name = cmdTok.replace(/^\//, '').toLowerCase();
          if (!name) return { isCommand: false };
          const known = SLASH_REGISTRY.has(cmdTok);
          const allow = Array.isArray(EGPT_CONFIG.whatsapp?.e_commands)
            ? EGPT_CONFIG.whatsapp.e_commands.map(s => String(s).replace(/^\//, '').toLowerCase())
            : ['react'];
          if (!allow.includes(name)) {
            if (known) logOut(`@e command BLOCKED: ${cmdTok} (not in whatsapp.e_commands allowlist)`);
            return { isCommand: known };
          }
          const eMeta = { fromWhatsApp: true, waChatId: m.waChatId, waMsgKey: m.waMsgKey, _emittedByE: true };
          logOut(`@e → ${line}`);
          const handled = await handleSlash(line, eMeta);
          return { isCommand: true, handled: !!handled };
        };
        const turn = await dispatchPersonaTurn({
          bridge: bridgeForReply,
          buildWaSurfaceTag,
          decision,
          errOut,
          formatAutoDispatchLine,
          formatPersonaPrompt,
          getWaChatName: (chatId) => waBridgeRef.current?.getChatName?.(chatId) ?? null,
          getWaChatSlug: (chatId) => waBridgeRef.current?.getChatSlug?.(chatId) ?? null,
          logOut,
          mdToTgHtml,
          meta,
          personaEmoji,
          personaName,
          runDefaultBrainTurn,
          runEmittedCommand,
          stateDir: EGPT_HOME,
        });
        // Watcher: "->E" (human prompt) or "S->E" (resident S's reply
        // re-circulated); content = the exact envelope fed to @e. Then feed
        // @e's reply (even '…') onward — before the silence early-return so a
        // quiet @e still reaches @l (which may react).
        {
          // Use the resident name the broadcast TARGETED (forceTarget — always
          // a residents[] entry like 'e'/'l'), not decision.name, which for the
          // persona resolves to an alias ('egpt') that doesn't match residents
          // and made re-circulation bail. Falls back to personaName off-broadcast.
          const _being = meta.forceTarget ?? personaName;
          const _t = String(_being).toUpperCase();
          const _arrow = (Number(meta._chainDepth) || 0) >= 1
            ? `${String(meta.waSenderName ?? '?').toUpperCase()}->${_t}` : `->${_t}`;
          confirmMirrorRef.current?.(meta.waChatId, _arrow, turn.personaPrompt);
        }
        _recirculateResidentReply({ being: meta.forceTarget ?? personaName, reply: turn.reply, meta });
        // 'silence' = @e chose '…'; 'suppressed' = mode gate withheld the reply
        // (E read it for context but this chat/mode doesn't permit replying now);
        // 'commands' = the reply was only an emitted command (it already ran,
        // there's no prose to send). Any of these: nothing renders or sends.
        if (turn.kind === 'silence' || turn.kind === 'suppressed' || turn.kind === 'commands') return;
        const reply = turn.reply;

        if (meta.observeOnly) {
          // Observed-chat invocation: reply went to the originating
          // chat above. Log to /log for operator audit; don't
          // populate the transcript or broadcast on the bus.
          const where = meta.waChatId ?? meta.telegramChatId ?? '?';
          const preview = reply.length > 200 ? reply.slice(0, 200) + '…' : reply;
          logOut(`(observed @egpt in ${where}): ${preview}`);
        } else {
          const replyAuthor = `egpt@${SURFACE_TAG}`;
          // _source tag: the bridge that asked. Items-mirror to that
          // bridge will skip (we direct-send above); items-mirror to
          // OTHER bridges still fires (cross-surface visibility).
          const replySource = meta.fromTelegram ? 'telegram'
            : meta.fromWhatsApp ? 'whatsapp'
            : null;
          // _sourceChatId: the WA chat the streamed reply already
          // landed in (via waStream.finish above). Items-mirror's
          // per-target loop uses this to skip that ONE chat while
          // still fanning out to OTHER joined chats — without it,
          // the brain reply double-posts in the origin chat. Set
          // for WA-arrived @e turns; left unset for local / TG.
          pushItem({
            id: Date.now() + Math.random(),
            author: replyAuthor,
            body: reply,
            ...(replySource ? { _source: replySource } : {}),
            ...(meta.fromWhatsApp && meta.waChatId
              ? { _sourceChatId: meta.waChatId } : {}),
          });
          await append(replyAuthor, reply);
          // Broadcast on bus so peers (extension, future surfaces) see
          // the persona reply as a play-script line. via: tags the
          // originating chat so peers' mirrors don't echo back to the
          // same bridge we already direct-sent to.
          const tid = busTargetIdRef.current;
          if (tid) {
            const via = meta.fromTelegram ? `telegram[${meta.telegramChatId ?? '?'}]`
              : meta.fromWhatsApp ? `whatsapp[${meta.waChatId ?? '?'}]`
              : null;
            bus.postEvent(tid, {
              type: 'room-reply', from: BUS_NODE_ID, ts: Date.now(),
              session: 'egpt', body: reply,
              ...(via ? { via } : {}),
            }).catch(e => console.error(`!! egpt.mjs:[promise-catch] ${e?.message ?? e}`));
          }
        }
      } finally {
        setBusy(false);
        // auto_e_chats queue drain: if we were the in-flight turn
        // for an auto-dispatched chat and messages piled while we
        // were thinking, format them as one combined dispatch and
        // re-enter via submitRef. The combined text is the literal
        // shape an asked for: "<name>: <body> [HH:MM]" per line.
        // Fire-and-forget so this finally returns promptly; if the
        // re-entry itself errors, surface to shell.
        if (queueState) {
          const drained = queueState.queue.splice(0);
          queueState.inFlight = false;
          if (drained.length > 0 && submitRef.current) {
            // Build the persona prompt here (one formatted line per
            // piled message) and pass it via _personaBodyOverride
            // so persona dispatch uses it verbatim instead of
            // re-formatting a single-message body. Keeps all the
            // dispatch goodies (`...` filter, send paths, re-queue)
            // while letting the drain decide its own prompt shape.
            // No per-turn rules prefix — e remembers from prior
            // /rules injection (slash/rules.mjs).
            const surface = buildWaSurfaceTag(meta.waChatId);
            const idStr = String(meta.waChatId ?? '');
            const chatType = idStr.endsWith('@g.us')
              ? 'group'
              : idStr === 'status@broadcast' ? 'status' : 'private';
            const chatName = waBridgeRef.current?.getChatName?.(meta.waChatId) ?? null;
            const fullPrompt = drained.map(it => formatAutoDispatchLine({
              senderName: it.senderName, body: it.body, ts: it.ts,
              surface, chatType, chatName,
            })).join('\n');
            const drainMeta = {
              fromWhatsApp: meta.fromWhatsApp,
              waChatId: meta.waChatId,
              waUser: meta.waUser,
              waClientLabel: meta.waClientLabel,
              waMsgKey: null,
              waMsgRaw: null,
              observeOnly: meta.observeOnly,
              replyPersona: null,
              waSenderName: 'multiple',
              autoDispatched: true,
              _personaBodyOverride: fullPrompt,
            };
            // The text-arg doesn't matter since override is set;
            // still pass '@e' so the router classifies as persona.
            submitRef.current('@e (drained pile)', drainMeta).catch(e =>
              errOut(`!! auto_e_chats drain failed: ${e.message}`));
          }
        }
      }
      return;
    }
    if (decision.kind === 'meta') {
      // @<sibling> — engineer co-pilot. With the registry shape live,
      // decision.name is the canonical sibling (wren, jay, …).
      // Each entry in EGPT_CONFIG.siblings can carry its own
      // body_emoji + emoji for the outbound tag prefix; falls back
      // to 🐦 for backwards compat with the wren-only era.
      // Global @l gate: @l has one server/one slot, so only one @l turn runs
      // at a time across all chats. If the slot is busy, this message piles in
      // its chat's pile and we bail; the running turn drains the next pile when
      // it finishes. Non-@l beings (engineers) run inline.
      const _qBeing = meta.forceTarget ?? (decision.name ?? 'wren');
      if (_llamaGate(_qBeing, meta, decision.body)) return;   // @l busy → piled
      setBusy(true);
      try {
        const sibName = decision.name ?? 'wren';
        const sibsCfg = EGPT_CONFIG.siblings ?? {};
        const sibEntry = sibsCfg[sibName] ?? {};
        const sibEmoji = sibEntry.body_emoji ?? sibEntry.emoji ?? '🐦';
        // Sessionless siblings (@l): operator 2026-05-24 — "only the words
        // i mentioned... let him be free." Hand the brain ONLY the raw
        // message body — no [timestamp/chat/speaker] envelope, no injected
        // history. His persona (system_prompt) is all the framing he gets.
        // Brains with their own session (claude/codex) keep the full
        // envelope so they know who/where/when.
        const _sibBrain = brainForName(canonicalBrainName(sibEntry.type ?? 'claude-code'));
        // Envelope for every RESIDENT, including sessionless @l (operator
        // 2026-05-24: "envelope for everyone" — now that residents converse,
        // @l needs the [speaker@chat]: tag to know who is talking, vs the
        // old raw-words-only feed). WA residents get the canonical one-line
        // [Sender@surface (HH:MM)]: body form (same as @e); engineers /
        // non-residents keep the verbose persona prompt.
        const _isResident = (Array.isArray(EGPT_CONFIG.whatsapp?.residents) ? EGPT_CONFIG.whatsapp.residents : [])
          .some(r => String(r).toLowerCase() === String(sibName).toLowerCase());
        // Sessionless siblings (@l) get the clean speaker-tagged line too, not
        // just configured residents — without this @l fell through to the
        // verbose formatPersonaPrompt envelope ([…UTC, in WhatsApp DM "…"
        // (chatId), @@… said:]) which mislabels Beeper GROUPS as DMs and which
        // @l parroted back (operator 2026-06-11). chatName resolves the
        // human-readable group/contact name for the bracket.
        let personaPrompt = meta._personaBodyOverride
          ? meta._personaBodyOverride                         // drained pile — verbatim combined prompt
          : (meta.fromWhatsApp && (_isResident || _sibBrain?.sessionless))
            ? formatAutoDispatchLine({ senderName: meta.waSenderName, body: decision.body, ts: Date.now(), surface: buildWaSurfaceTag(meta.waChatId), chatName: waBridgeRef.current?.getChatName?.(meta.waChatId) ?? null })
            : formatPersonaPrompt(meta, decision.body);
        // Channel MEMORY for sessionless siblings (@l): prepend a capped tail of
        // the chat's transcript.md so a stateless model has recent context
        // (operator 2026-06-11: feed l.md + transcript.md per turn). The legacy
        // conversation-L chat.json is retired — transcript.md is the one source.
        // Memory is on by default; siblings.<name>.memory:false makes it a clean
        // stateless chatter again (a 3B handles a short clean tail OK, but it's
        // not brilliant — the framing tells it to REPLY, not summarise, which is
        // what a small model defaults to when handed a conversation blob).
        // Build the sessionless sibling's MEMORY as real alternating chat turns
        // (multi-turn) from the chat transcript — passed via opts.history so the
        // model gets a proper conversation, not one cramped prompt (operator
        // 2026-06-11). siblings.<name>.memory:false → stateless one-shot again.
        let _siblingTurns = null;
        if (meta.fromWhatsApp && _sibBrain?.sessionless && meta.waChatId
            && EGPT_CONFIG.siblings?.[sibName]?.memory !== false) {
          _siblingTurns = await _buildSiblingTurns(meta.waChatId, sibName, decision.body, Number(EGPT_CONFIG.siblings?.[sibName]?.history_chars ?? 4000));
        }
        const tgPrefix = `${sibEmoji} <b>${sibName}</b>\n`;
        const waPrefix = `${sibEmoji} ${sibName}\n`;
        // A resident being can self-select OUT of a message by replying with
        // '…' (or empty) — we then post nothing. Operator 2026-05-24: "can
        // an unreasoning @l be quiet?" Yes — its profile instructs it to
        // answer '…' when not addressed/relevant, and this drops it.
        const _silentReply = (r) => { const t = String(r ?? '').trim(); return t === '' || /^(\.{3,}|…+)$/.test(t); };
        // For sessionless residents (@l), an infra error ("!! @l: llama:
        // fetch failed…") is NOT a chat reply — it's already logged to the
        // shell; don't ALSO dump it into the group. Operator 2026-05-24.
        const _dropResident = (r) => _silentReply(r)
          // Per-chat auto-mode gate. For WA, route through the shared emit
          // backstop (hard-blocks mute/off regardless of the flag); other
          // surfaces keep the plain per-turn flag.
          || (meta.fromWhatsApp
              ? !_eMayReplyToChat(meta.waChatId, { replyAllowed: meta.replyAllowed, isReaction: meta.isReaction })
              : meta.replyAllowed === false)
          || (_sibBrain?.sessionless && /^!!\s*@/.test(String(r ?? '').trimStart()));
        // Sessionless residents (@l) don't stream a "thinking…" placeholder —
        // we can't know they'll stay quiet until the reply is in, and a
        // placeholder we'd have to delete is ugly. Collect, then send only if
        // non-silent (below). Session siblings (claude/codex) keep streaming.
        const _streaming = !_sibBrain?.sessionless;
        // CRITICAL: open the WA stream ONLY if E may emit to this chat. The
        // streaming path (`waStream.finish(...)` below) does not consult
        // _dropResident — it always delivers — so opening a stream in a muted
        // chat bypasses every gate (operator 2026-05-28: Cristina). With
        // waStream null, the fallback non-streaming send-path at the bottom of
        // this block correctly drops on _dropResident. Even the placeholder
        // "⌛ thinking…" delivery is a send → must be gated. Same for TG.
        const _waMayEmit = meta.fromWhatsApp
          ? _eMayReplyToChat(meta.waChatId, { replyAllowed: meta.replyAllowed, isReaction: meta.isReaction })
          : true;
        const _tgMayEmit = meta.fromTelegram ? (meta.replyAllowed !== false) : true;
        // show-think: per-chat two-message Telegram mode. The streaming reply
        // carries the LIVE thinking (marked 💭 …, suffixed "(thinking... 🤔)" so
        // an in-progress turn is unmistakable); on finish it is FROZEN as the
        // thinking artifact and the clean final answer is posted as a NEW reply
        // to the original message — the arriving reply IS the "finished" signal.
        // Computed once here (not just at finish) so the live updates can mark
        // the thinking too. Toggle via: /e auto show-think on|off.
        const _tgShowThink = !!(meta.fromTelegram && meta.telegramChatId &&
          (EGPT_CONFIG.telegram?.show_think_chats ?? []).includes(String(meta.telegramChatId)));
        const tgStream = (_streaming && meta.fromTelegram && bridgeRef.current?.startStreamMessage && _tgMayEmit)
          ? bridgeRef.current.startStreamMessage(
              // show-think: 💭 header, blank line, then the live thinking body
              // (renderThink → src/show-think.mjs spaces the statements + adds
              // the "(thinking... 🤔)" suffix on each update).
              _tgShowThink
                ? renderThink({ header: `💭 ${tgPrefix}`, body: '', escape: escapeHtml })
                : `${tgPrefix}⌛ thinking…`,
              { chatId: meta.telegramChatId })
          : null;
        const waStream = (_streaming && meta.fromWhatsApp && streamFactoryRef.current && _waMayEmit)
          ? streamFactoryRef.current(`${waPrefix}⌛ thinking…`,
              { chatId: meta.waChatId, replyAllowed: meta.replyAllowed, isReaction: meta.isReaction, persona: meta.forceTarget ?? sibName })
          : null;
        // WA two-message split for thinking models (@l). Operator
        // 2026-05-24: "the thinking response should reply once, after
        // </think> another reply with the last message." While the brain
        // is still inside <think>…</think>, stream into message 1; the
        // moment </think> appears, freeze msg1 and stream the final answer
        // into a SEPARATE message 2. Brains that emit no </think> (the
        // Claude engineers) never split → single message, as before.
        const THINK_END = /<\/think\s*>/i;
        const splitThink = (full) => {
          const m = THINK_END.exec(full);
          if (!m) return { think: full, answer: null };
          const cut = m.index + m[0].length;
          return { think: full.slice(0, cut), answer: full.slice(cut).replace(/^\s+/, '') };
        };
        let waAnswerStream = null;   // message 2 (the final answer)
        let waSplit = false;
        // Watcher: "->L" (human prompt) or "S->L" (resident S's reply
        // re-circulated); content = the exact envelope fed to this being.
        {
          const _being = meta.forceTarget ?? sibName;   // resident name the broadcast targeted
          const _t = String(_being).toUpperCase();
          const _arrow = (Number(meta._chainDepth) || 0) >= 1
            ? `${String(meta.waSenderName ?? '?').toUpperCase()}->${_t}` : `->${_t}`;
          confirmMirrorRef.current?.(meta.waChatId, _arrow, personaPrompt);
        }
        let _tgLastPartial = '';   // last streamed snapshot — frozen as the thinking in show-think mode
        let reply = await runMetaBrainTurn(personaPrompt, (partial) => {
          if (tgStream) {
            _tgLastPartial = partial;
            // show-think body is HTML-ESCAPED, not md-rendered: a partial tail
            // with an unbalanced ** / <tag> makes Telegram reject the edit, which
            // is why the "(thinking... 🤔)" suffix wasn't appearing. The clean
            // final answer (below) is the only md-rendered message.
            tgStream.update(_tgShowThink
              ? renderThink({ header: `💭 ${tgPrefix}`, body: partial, escape: escapeHtml })
              : `${tgPrefix}${mdToTgHtml(partial)}`);
          }
          if (waStream) {
            const { think, answer } = splitThink(partial);
            if (answer === null) {
              waStream.update(`${waPrefix}${think}`);
            } else {
              if (!waSplit) {
                waSplit = true;
                waStream.finish(`${waPrefix}${think}`);     // freeze the thinking message
                waAnswerStream = streamFactoryRef.current?.(`${waPrefix}…`, { chatId: meta.waChatId, replyAllowed: meta.replyAllowed, isReaction: meta.isReaction, persona: meta.forceTarget ?? sibName });
              }
              if (waAnswerStream) waAnswerStream.update(`${waPrefix}${answer || '…'}`);
            }
          }
        }, sibName, _siblingTurns ? { history: _siblingTurns } : {});   // @l memory: opts.history = multi-turn chat from transcript.md (null ⇒ stateless one-shot)
        // Route <think>…</think> reasoning to the Self DM only (operator
        // 2026-05-25: "if it can't be turned off, send to Self"). Strip it so
        // the chat / memory / re-circulation get JUST the answer; post the
        // thinking to Self for the operator. (No-think at the model level is
        // still the goal — this keeps the conversation clean meanwhile.)
        {
          const _tm = reply.match(/<think>([\s\S]*?)<\/think>/i);
          if (_tm) {
            const _think = _tm[1].trim();
            reply = reply.slice(_tm.index + _tm[0].length).replace(/^\s+/, '');   // answer only ('' → treated as silence)
            const _selfDm = EGPT_CONFIG.whatsapp?.chat_id;
            if (_think && _selfDm) {
              const _id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
              writeFile(join(EGPT_HOME, 'outbox', _id + '.json'),
                JSON.stringify({ type: 'wa-send', from: 'system', ts: Date.now(), jid: _selfDm, body: `🦙 ${sibName} 💭\n${_think}` }))
                .catch(() => {});
            }
          }
        }
        // Brains converse: feed this resident's reply (even '…') to the
        // other residents. The recipient's dispatch tap mirrors it to Self as
        // their next prompt, so the reply is echoed there as the formatted
        // string it is prompted to them with.
        _recirculateResidentReply({ being: meta.forceTarget ?? sibName, reply, meta });
        // @l (sessionless) emit verdict → egpt.log. Localises why a sessionless
        // sibling stayed quiet: DROP:silent (model self-selected out with '…'),
        // DROP:gate (chat mode/replyAllowed blocked it), DROP:infra (fetch
        // error), or SEND. The streaming siblings (claude/codex) don't need it.
        if (meta.fromWhatsApp && _sibBrain?.sessionless) {
          const _r = String(reply ?? '');
          const _silent = _silentReply(_r);
          const _gateOk = _eMayReplyToChat(meta.waChatId, { replyAllowed: meta.replyAllowed, isReaction: meta.isReaction });
          const _infra = /^!!\s*@/.test(_r.trimStart());
          const _verdict = _silent ? 'DROP:silent' : !_gateOk ? 'DROP:gate' : _infra ? 'DROP:infra' : 'SEND';
          logOut(`@${sibName} emit ${meta.waChatId}: verdict=${_verdict} replyAllowed=${meta.replyAllowed} reply=${JSON.stringify(_r.slice(0, 80))}`);
          // Record the sibling's reply to the chat transcript — surfaced OR
          // withheld-by-mode (operator 2026-06-11: log every response, even
          // non-surfaced). '…'/infra aren't real replies, so they're skipped.
          if (_verdict === 'SEND' || _verdict === 'DROP:gate') {
            _appendSiblingReply(meta.waChatId, sibName, _r, _verdict === 'SEND').catch(() => {});
          }
        }
        if (tgStream) {
          if (_tgShowThink) {
            // show-think: FREEZE the streamed thinking in place (the last
            // snapshot the operator watched stream, kept as the 💭 artifact)
            // with the "(done ✅)" suffix — the finished signal that tells the
            // operator the turn is over — then post the clean final answer as a
            // NEW reply to the original message.
            const _snap = String(_tgLastPartial ?? '').trim();
            await tgStream.finish(renderThink({ header: `💭 ${tgPrefix}`, body: _snap, escape: escapeHtml, done: true }));
            if (!_dropResident(reply)) {
              bridgeRef.current?.send?.(`${tgPrefix}${mdToTgHtml(reply)}`,
                { chatId: meta.telegramChatId, replyTo: meta.telegramMessageId ?? undefined });
            }
          } else {
            await tgStream.finish(`${tgPrefix}${mdToTgHtml(reply)}`);
          }
        } else if (meta.fromTelegram && bridgeRef.current && !_dropResident(reply)) {
          bridgeRef.current.send(`${tgPrefix}${mdToTgHtml(reply)}`,
            { chatId: meta.telegramChatId });
        }
        // C1.2/I3: log the Telegram conversation (inbound + reply). The
        // sibling/forceTarget route (Telegram→Wren) bypasses runDefaultBrainTurn's
        // logger, so log here, surface-aware. (WhatsApp logs via the default-brain
        // path.) Inbound logged always; reply logged unless silent/infra-error.
        if (meta.fromTelegram && meta.telegramChatId != null) {
          const _tgChat = String(meta.telegramChatId);
          const _tgName = meta.telegramChatName ?? meta.telegramUser ?? _tgChat;
          await _logChatLine('telegram', _tgChat, _tgName, sibName, personaPrompt);
          const _r = String(reply ?? '').trim();
          if (_r && !_silentReply(_r) && !/^!!\s*@/.test(_r)) {
            await _logChatLine('telegram', _tgChat, _tgName, sibName,
              replyLine({ being: sibName, body: _r, surfaced: !_dropResident(reply) }));
          }
        }
        if (waStream) {
          const { think, answer } = splitThink(reply);
          let primaryStream = waStream;
          if (answer !== null) {
            if (!waSplit) {
              waSplit = true;
              await waStream.finish(`${waPrefix}${think}`);
              waAnswerStream = streamFactoryRef.current?.(`${waPrefix}…`, { chatId: meta.waChatId, replyAllowed: meta.replyAllowed, isReaction: meta.isReaction });
            }
            if (waAnswerStream) { await waAnswerStream.finish(`${waPrefix}${answer || '…'}`); primaryStream = waAnswerStream; }
          } else {
            await waStream.finish(`${waPrefix}${reply}`);
          }
          if (!primaryStream?.delivered && meta.fromWhatsApp && waBridgeRef.current) {
            const fallbackText = answer !== null ? (answer || reply) : reply;
            const r = await waBridgeRef.current.send(
              `${waPrefix}${fallbackText}`,
              { chatId: meta.waChatId },
            );
            if (!r) {
              const errSuffix = primaryStream?.lastError ? `  (stream: ${primaryStream.lastError})` : '';
              errOut(`!! @${sibName}: WA reply did NOT deliver to ${meta.waChatId}${errSuffix}\nreply was: ${reply.length > 200 ? reply.slice(0, 199) + '…' : reply}`);
            }
          }
        } else if (meta.fromWhatsApp && waBridgeRef.current && !_dropResident(reply)) {
          const r = await waBridgeRef.current.send(
            `${waPrefix}${reply}`,
            { chatId: meta.waChatId },
          );
          if (!r) {
            errOut(`!! @${sibName}: WA reply did NOT deliver to ${meta.waChatId}\nreply was: ${reply.length > 200 ? reply.slice(0, 199) + '…' : reply}`);
          }
        }
        if (meta.observeOnly) {
          const where = meta.waChatId ?? meta.telegramChatId ?? '?';
          const preview = reply.length > 200 ? reply.slice(0, 200) + '…' : reply;
          logOut(`(observed @me in ${where}): ${preview}`);
        } else if (!_dropResident(reply)) {
          // Same drop rule as the chat send above: a '…' (or a sessionless
          // infra error) is NOT a real reply — keep it out of the shell items,
          // the cross-surface mirror (this was leaking @l's '…' to Telegram
          // even though WA dropped it), and the bus. Silence still re-circulates
          // (initial) + shows in the /confirm debug; it just doesn't surface
          // as a chat message anywhere.
          const replyAuthor = `wren@${SURFACE_TAG}`;
          const replySource = meta.fromTelegram ? 'telegram'
            : meta.fromWhatsApp ? 'whatsapp'
            : null;
          pushItem({
            id: Date.now() + Math.random(),
            author: replyAuthor,
            body: reply,
            ...(replySource ? { _source: replySource } : {}),
            ...(meta.fromWhatsApp && meta.waChatId
              ? { _sourceChatId: meta.waChatId } : {}),
          });
          await append(replyAuthor, reply);
          const tid = busTargetIdRef.current;
          if (tid) {
            const via = meta.fromTelegram ? `telegram[${meta.telegramChatId ?? '?'}]`
              : meta.fromWhatsApp ? `whatsapp[${meta.waChatId ?? '?'}]`
              : null;
            bus.postEvent(tid, {
              type: 'room-reply', from: BUS_NODE_ID, ts: Date.now(),
              session: 'wren', body: reply,
              ...(via ? { via } : {}),
            }).catch(e => console.error(`!! egpt.mjs:[promise-catch] ${e?.message ?? e}`));
          }
        }
      } finally {
        setBusy(false);
        _llamaReleaseAndDrain(_qBeing, meta);
      }
      return;
    }
    if (decision.kind === 'peer-mention') {
      const tid = busTargetIdRef.current;
      if (!tid) { sysOut(`!! bus not joined — can't forward @${decision.target}`); return; }
      // Input already logged in submitInner's echo block.
      try {
        await bus.postEvent(tid, {
          type: 'mention', from: BUS_NODE_ID, ts: Date.now(),
          target: decision.target, to_node: decision.toNode,
          body: decision.body, user: meta.telegramUser ?? USER_NAME,
          // tg_chat_id rides along so the responding node can route its
          // mention-reply back to the same Telegram chat that asked.
          ...(meta.fromTelegram && meta.telegramChatId
            ? { tg_chat_id: meta.telegramChatId, tg_via: `telegram[${meta.telegramChatId}]` }
            : {}),
        });
        sysOut(`@${decision.target} -> ${decision.toNode} via bus`);
      } catch (e) {
        sysOut(`!! forward failed: ${e.message}`);
      }
      return;
    }

    // From here on it's a local turn (kind === 'turn' or 'auto-open').
    let effectiveSessions = sessions;
    let recipients;
    let userPayload;
    if (decision.kind === 'auto-open') {
      const emoji = nextEmoji(effectiveSessions);
      const sessionName = nextName(decision.brainName, effectiveSessions);
      const newEntry = { brain: decision.brainName, options: { cwd: process.cwd() }, emoji };
      effectiveSessions = { ...effectiveSessions, [sessionName]: newEntry };
      setSessions(s => ({ ...s, [sessionName]: newEntry }));
      sysOut(`session "${sessionName}" -> ${emoji} ${decision.brainName} (auto-opened for @${decision.originalToken})`);
      recipients = [sessionName];
      userPayload = decision.payload;
    } else {
      recipients = decision.recipients;
      userPayload = decision.payload;
    }

    // Input already logged in submitInner's echo block.
    setBusy(true);
    setError(null);

    // Phase A — broadcast/single. Each brain receives a qualified
    // header so it knows who sent the message, from where, and when.
    // Format: '[handle@client.node 2026-05-11 19:14 EDT]: body'.
    // For shell typing client is omitted (just handle@node); for
    // bridge-arrived messages client is the bridge client_name
    // ('tg', 'wa', or whatever the operator renamed to). The
    // brain's tab keeps its own native history; this header is the
    // per-turn context that varies turn-to-turn.
    const brainAuthor = (meta.fromTelegram && meta.telegramUser)
      ? `${stripAt(meta.telegramUser)}@${tgClient}.${SURFACE_TAG}`
      : (meta.fromWhatsApp && meta.waUser)
      ? `${stripAt(meta.waUser)}@${meta.waClientLabel ?? waClient}.${SURFACE_TAG}`
      : `${USER_NAME}@${SURFACE_TAG}`;
    const messageForBrains = `[${brainAuthor} ${ts()}]: ${userPayload}`;
    if (decision.broadcast) {
      sysOut(`broadcasting to ${recipients.length} session(s): ${recipients.join(', ')}`);
    }
    const tgChatId  = meta.fromTelegram ? meta.telegramChatId  ?? null : null;
    const tgReplyTo = meta.fromTelegram ? meta.telegramMessageId ?? null : null;
    // ALL model replies are gated (operator 2026-06-04). runBrainTurn opens its
    // WA stream on waChatId ALONE (no mode gate), so a NAMED brain (cgpt/codex/
    // llama) addressed in a mute/off/paused chat would stream its reply there.
    // Gate HERE: pass waChatId only when the chat permits an emit. replyAllowed
    // is true because the brain WAS explicitly addressed; _eMayReplyToChat still
    // hard-blocks mute/off and the global auto_e_paused kill.
    const _waRaw = meta.fromWhatsApp ? meta.waChatId ?? null : null;
    const waChatId = (_waRaw && _eMayReplyToChat(_waRaw, { replyAllowed: true, isReaction: meta.isReaction }))
      ? _waRaw : null;
    const replies = [];
    for (const recipient of recipients) {
      const reply = await runBrainTurn(recipient, messageForBrains, effectiveSessions, { tgChatId, tgReplyTo, waChatId });
      if (reply !== null) {
        replies.push({ author: recipient, text: reply });
        // Broadcast every brain reply to peer surfaces. The room is
        // noisy by design — peers see the same conversation regardless
        // of which surface they're looking at.
        const tid = busTargetIdRef.current;
        if (tid) {
          bus.postEvent(tid, {
            type: 'room-reply', from: BUS_NODE_ID, ts: Date.now(),
            role: 'shell', session: recipient, body: reply,
          }).catch(e => console.error(`!! egpt.mjs:[promise-catch] ${e?.message ?? e}`));
        }
      }
    }

    // Phase B — one-hop mirror among CDP recipients. planMirrors decides
    // which (recipient, message) pairs need a mirror push.
    const sessionsForMirror = new Map(
      Object.entries(effectiveSessions).map(([n, s]) => [n, { brainName: s.brain }]),
    );
    const mirrorPlan = planMirrors(replies, recipients, sessionsForMirror, brainForName);
    if (mirrorPlan.length > 0) {
      sysOut(`mirroring ${mirrorPlan.length} reply/replies to other CDP brains…`);
      for (const { to, message } of mirrorPlan) {
        await runBrainTurn(to, message, effectiveSessions);
      }
    }
    setBusy(false);
  };

  // Keep the bridge's reference to submit() up to date with each render so
  // background message arrivals always run against the current closure.
  submitRef.current = submit;

  // Refresh refs that bus events depend on. These run during render (legal
  // because they are ref writes, not state mutations).
  sessionsLatestRef.current = sessions;

  // Bus event dispatcher — re-installed each render so it captures the latest
  // sessions/runBrainTurn/tgPolling closures. The bus subscription was set up
  // once with [] deps and just calls handleBusEventRef.current(ev), so it
  // always runs through this fresh closure.
  // wa-send dispatcher used by both the bus 'wa-send' case and the
  // outbox file watcher. Pure-ish: only side effect is wa.send + a log
  // item. Returns true iff the send was issued so the watcher can
  // decide whether to unlink the file or leave it for the next sweep.
  dispatchWaSendRef.current = async (ev, source = 'outbox') => {
    const log = (msg) => pushItem({
      id: Date.now() + Math.random(), author: 'system', _localOnly: true, body: msg,
    });
    const wa = waBridgeRef.current;
    const _isBack = typeof ev.body === 'string' && ev.body.includes('egpt back!');
    if (_isBack || ev.from === 'system') _walog(`dispatchWaSend(${source}): wa=${wa ? 'SET' : 'NULL'} from=${ev.from} jid=${ev.jid} body="${String(ev.body ?? '').slice(0, 40)}"`);
    if (!wa) { log(`${source}: wa-send from ${ev.from} dropped — no baileys bridge here`); return false; }
    if (!ev.jid || !ev.body) { log(`${source}: wa-send from ${ev.from} dropped — missing jid/body`); return false; }
    // Silence protocol: literal '...' or '…' = brain's signed contract
    // to stay silent. Drop without sending. NO heuristic filtering of
    // model output beyond this — per operator (2026-05-19): the rules
    // tell @e how to behave; if leaks happen, fix the rules / identity,
    // not the regex.
    const trimmedBody = (ev.body ?? '').trim();
    if (trimmedBody === '...' || trimmedBody === '…') {
      log(`${source}: wa-send from ${ev.from} to ${ev.jid} dropped — polite '...' (not sent)`);
      return true;
    }
    // OUTBOX WRITE-WHITELIST — applies to EVERY wa-send, regardless of the
    // 'from' label. The label is display, NOT auth: conversation-e is a
    // Bash-capable subprocess and can write any outbox file with any 'from'
    // (e.g. 'from:system' to dodge an @e-only check). So the outbox can only
    // reach the operator's explicitly-enrolled chats (auto_e_chats) + the
    // self-DM (chat_id). Anything else is BLOCKED + logged. This makes the
    // outbox NOT a bypass: E's ONLY routes to WA are the gated persona/room
    // dispatch and a whitelisted chat here — never one nobody enrolled.
    // (operator 2026-06-03: leaks are unacceptable; never trust 'from'. A
    // legitimate send to a new chat is enrolled via auto_e_chats / sent with an
    // explicit operator @waN, not by labelling an outbox file.)
    {
      const waCfg = EGPT_CONFIG.whatsapp ?? {};
      // SYSTEM messages (operator notices: restart acks, debug echo, <think>)
      // are structurally limited to the operator's OWN destinations — the
      // self-DM (chat_id) and the optional debug-bot — NEVER a contact's chat,
      // not even an enrolled one (operator 2026-06-04: "even system-messages
      // should be structurally limited to Self"). The 'from' label is NOT
      // trusted (conversation-e can spoof 'from:system'), but spoofing it only
      // makes a send MORE restricted (Self-only), never a bypass. Model/persona
      // sends use the enrolled write-whitelist (auto_e_chats + self-DM).
      const allowed = ev.from === 'system'
        ? new Set([waCfg.chat_id, waCfg.egptbot_jid].filter(Boolean))
        : new Set([
            ...(Array.isArray(waCfg.auto_e_chats) ? waCfg.auto_e_chats : []),
            waCfg.chat_id,
          ].filter(Boolean));
      // The whitelist is matched on the STABLE chat id (ev.jid) ONLY —
      // never a display name (operator 2026-06-10: authorization must use
      // a stable id). The outbox is the highest-value leak path; a chat
      // title is attacker-controllable, so names are deliberately NOT
      // accepted here even though they're allowed for outbound addressing.
      if (!allowed.has(ev.jid)) {
        const why = ev.from === 'system'
          ? 'a system message may ONLY reach the operator self-DM / debug-bot — never a contact chat'
          : 'not in auto_e_chats or self-DM';
        log(`!! ${source}: wa-send (from ${ev.from}) to ${ev.jid} BLOCKED — ${why}. The outbox is gated by CHAT, never the 'from' label. body="${(ev.body || '').slice(0, 60)}${(ev.body || '').length > 60 ? '…' : ''}"`);
        return true;  // consume — don't retry; operator audits via /log
      }
    }
    // Persona emoji prefix: per operator (2026-05-17), the bridge — not
    // the sibling — owns the "<emoji> <name>: " label on outbox-originated
    // wa-sends. Look up siblings[ev.from].body_emoji and prepend if the
    // sender's body doesn't already start with it. Backward-compat:
    // siblings that include their own emoji prefix (legacy convention)
    // skip the auto-prefix. Skip entirely when the sender isn't in the
    // registry (or has no body_emoji configured).
    let body = ev.body;
    const sib = (EGPT_CONFIG.siblings ?? {})[ev.from];
    const emoji = sib?.body_emoji;
    if (emoji && !body.startsWith(emoji)) {
      body = `${emoji} ${ev.from}: ${body}`;
    }
    try {
      // deliverEcho (set by the /e confirm watcher's self-sends): don't
      // rememberSent, so the message flows back through onIncoming and the
      // Self residents see it as a normal chat message.
      // _noRelay (operator 2026-05-29): if our bridge is deferred, do NOT
      // let send() spool ANOTHER outbox event — that's a CPU-burning
      // infinite loop (we'd just pick it up next sweep). Return null in
      // that case so we leave the file in place for the next attempt.
      const r = await wa.send(body, {
        chatId: ev.jid,
        deliverEcho: ev.deliverEcho === true,
        _noRelay: true,
      });
      if (r === null) {
        // Bridge unavailable right now (deferred or not connected). Leave
        // the outbox file in place; the watcher will retry next sweep,
        // and once a bridge comes online it'll dispatch normally.
        return false;
      }
      log(`${source}: wa-send → ${ev.jid} for ${ev.from} (${(body || '').slice(0, 40)}${body.length > 40 ? '…' : ''})`);
      return true;
    } catch (e) {
      log(`!! wa-send failed: ${e.message}`);
      return false;
    }
  };

  // wa-group-subject dispatcher — mirrors dispatchWaSendRef's shape.
  // Called by outbox watcher (file IPC) and the bus 'wa-group-subject'
  // case below. Returns truthy on success (consumed/unlinked), falsy
  // on transient failure (retry on next sweep). Permanent failures
  // (not admin, malformed jid) log + return truthy to unlink — we
  // don't loop forever on rejection.
  const dispatchWaGroupSubjectRef = useRef(null);
  dispatchWaGroupSubjectRef.current = async (ev, source = 'outbox') => {
    const log = (msg) => pushItem({
      id: Date.now() + Math.random(), author: 'system', _localOnly: true, body: msg,
    });
    const wa = waBridgeRef.current;
    if (!wa) { log(`${source}: wa-group-subject from ${ev.from} dropped — no baileys bridge here`); return false; }
    if (!wa.setGroupSubject) { log(`${source}: wa-group-subject from ${ev.from} dropped — bridge lacks setGroupSubject (older code?)`); return true; }
    if (!ev.jid || typeof ev.subject !== 'string') {
      log(`!! ${source}: wa-group-subject from ${ev.from} malformed — needs {jid, subject:string}; unlinking`);
      return true;
    }
    try {
      await wa.setGroupSubject({ jid: ev.jid, subject: ev.subject });
      log(`${source}: wa-group-subject → ${ev.jid} for ${ev.from} ("${ev.subject.slice(0, 60)}${ev.subject.length > 60 ? '…' : ''}")`);
      return true;
    } catch (e) {
      // Common failure: bot account isn't admin → baileys throws.
      // That's permanent for this attempt; unlink so we don't loop.
      log(`!! ${source}: wa-group-subject failed for ${ev.from} → ${ev.jid}: ${e.message}`);
      return true;
    }
  };

  // wa-group-members dispatcher — fetch group members and log them
  const dispatchWaGroupMembersRef = useRef(null);
  // Butler-task dispatcher (C4). Conversation-e (or operator) drops
  // { type: 'butler-task', from, prompt, relayToSlug?, model?,
  //   allowedTools? } in outbox. Butler is an ephemeral haiku
  // subprocess: no --resume (no session memory), default all-tools.
  // Output optionally relays back to a contact thread.
  const dispatchButlerTaskRef = useRef(null);
  dispatchButlerTaskRef.current = async (ev, source = 'outbox') => {
    const log = (msg) => pushItem({
      id: Date.now() + Math.random(), author: 'system', _localOnly: true, body: msg,
    });
    const prompt = (ev.prompt ?? '').trim();
    if (!prompt) { log(`!! ${source}: butler-task from ${ev.from} dropped — empty prompt`); return true; }
    log(`${source}: butler-task from ${ev.from} (${prompt.length} chars) — spawning haiku…`);
    try {
      const { runButler } = await import('./src/tools/butler.mjs');
      const r = await runButler({
        prompt,
        model: ev.model ?? 'haiku',
        allowedTools: ev.allowedTools ?? 'all',
      });
      const archive = join(EGPT_HOME, 'butler-outbox');
      try {
        await mkdir(archive, { recursive: true });
        const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        await writeFile(join(archive, id + '.md'), [
          `# butler-task from ${ev.from} (${new Date().toISOString()})`,
          `duration: ${r.durationMs}ms`,
          `exit: ${r.exitCode}`,
          r.error ? `error: ${r.error}` : '',
          '',
          '## prompt',
          prompt,
          '',
          '## result',
          r.text || '(empty)',
        ].filter(Boolean).join('\n'));
      } catch (e) { console.error(`!! egpt.mjs:[catch] ${e?.message ?? e}`); }
      if (r.error) { log(`!! butler: ${r.error}`); }
      else { log(`butler-e done (${r.durationMs}ms, ${r.text.length} chars)`); }
      // Optional relay: dispatch butler's output as a system turn
      // into the requesting contact's thread so conversation-e sees
      // the result on its next round.
      if (ev.relayToSlug && r.text) {
        const cs = await _loadConvState();
        const entry = cs.contacts?.[ev.relayToSlug];
        const jid = entry?.jids?.[0];
        if (jid) {
          try {
            await runDefaultBrainTurn(
              `... butler-e returned the following for the task you delegated ...\n\n${r.text}`,
              undefined,
              { threadId: jid, surface: 'wa', slug: ev.relayToSlug, name: entry.pushedName || ev.relayToSlug },
            );
          } catch (e) {
            log(`!! butler-relay → ${ev.relayToSlug}: ${e.message}`);
          }
        } else {
          log(`!! butler-relay: contact "${ev.relayToSlug}" has no JIDs registered`);
        }
      }
    } catch (e) {
      log(`!! ${source}: butler-task threw: ${e.message}`);
    }
    return true;
  };

  // Programmatic slash dispatcher — siblings / scripts drop a
  // { type: 'slash', from, cmd } outbox event to invoke any slash
  // command without round-tripping through a bridge. Operator
  // (2026-05-19) needed this when /identity-via-self-DM failed
  // because the bridge dedupes its own sent messages.
  const dispatchSlashRef = useRef(null);
  dispatchSlashRef.current = async (ev, source = 'outbox') => {
    const log = (msg) => pushItem({
      id: Date.now() + Math.random(), author: 'system', _localOnly: true, body: msg,
    });
    const cmd = (ev.cmd ?? '').trim();
    if (!cmd.startsWith('/')) {
      log(`!! ${source}: slash from ${ev.from} malformed — needs {cmd: '/...'}; got "${cmd.slice(0, 40)}"`);
      return true;
    }
    log(`${source}: slash from ${ev.from} → ${cmd}`);
    try {
      const meta = { ...(ev.meta ?? {}), fromOutboxSlash: true };
      const handled = await handleSlash(cmd, meta);
      if (!handled) log(`!! ${source}: slash "${cmd}" from ${ev.from} — handleSlash returned false`);
    } catch (e) {
      log(`!! ${source}: slash "${cmd}" from ${ev.from} threw: ${e.message}`);
    }
    return true;
  };

  dispatchWaGroupMembersRef.current = async (ev, source = 'outbox') => {
    const log = (msg) => pushItem({
      id: Date.now() + Math.random(), author: 'system', _localOnly: true, body: msg,
    });
    const wa = waBridgeRef.current;
    if (!wa) { log(`${source}: wa-group-members from ${ev.from} dropped — no baileys bridge here`); return false; }
    if (!wa.getGroupMembers) { log(`${source}: wa-group-members from ${ev.from} dropped — bridge lacks getGroupMembers`); return true; }
    if (!ev.jid) {
      log(`!! ${source}: wa-group-members from ${ev.from} malformed — needs {jid}; unlinking`);
      return true;
    }
    try {
      const members = await wa.getGroupMembers({ jid: ev.jid });
      const memberList = members.map(m => `  ${m.pushName || '(no name)'} (${m.jid})${m.admin ? ' [admin]' : ''}`).join('\n');
      log(`${source}: Group members for ${ev.jid}:\n${memberList}`);
      return true;
    } catch (e) {
      log(`!! ${source}: wa-group-members failed for ${ev.from} → ${ev.jid}: ${e.message}`);
      return true;
    }
  };

  handleBusEventRef.current = async (ev) => {
    if (ev.from === BUS_NODE_ID) return; // ignore self-echoes

    const log = (msg) => pushItem({
      id: Date.now() + Math.random(), author: 'system', _localOnly: true, body: msg,
    });
    const post = async (event) => {
      const tid = busTargetIdRef.current;
      if (!tid) return;
      try { await bus.postEvent(tid, { ts: Date.now(), from: BUS_NODE_ID, ...event }); } catch (e) { swallow('bus.post-event', e); }
    };

    switch (ev.type) {
      case 'egpt-thread': {
        // A peer (typically the extension) is announcing its current
        // @e thread. Adopt it as our default brain so /e in shell
        // continues the same conversation. Only acts on live events
        // (skip replays so a stale broadcast doesn't override the
        // user's local /egpt brain choice) and only when the peer's
        // brain_type + url shape is sane.
        if (ev._replayed) return;
        if (!ev.brain_type || !ev.url) return;
        if (!isUrlBrain(ev.brain_type)) return;
        const cur = readDefaultBrainState();
        if (cur.url === ev.url && cur.type === ev.brain_type) return;
        const next = setBrain(cur, ev.brain_type, ev.url);
        await persistDefaultBrainState(next);
        const sum = summarize(next);
        log(`bus: adopted @e thread from ${ev.from} → ${sum.type}  ${sum.activeShort}`);
        return;
      }
      case 'node-online': {
        peerNodesRef.current.set(ev.from, {
          role: ev.role, sessions: ev.sessions ?? [],
          polling: !!ev.polling, lastSeen: ev.ts ?? Date.now(),
        });
        setPeersRev(r => r + 1);
        if (!ev._replayed) {
          log(`bus: peer online ${ev.from}${ev.role ? ` (${ev.role})` : ''}${ev.polling ? ' [polling]' : ''}`);
        }
        // Mutual discovery: pong with our state so the new peer learns about
        // us. pong:true on the reply prevents an infinite ping-pong.
        // Skip on replayed events — peers already saw our live announce
        // when we joined; ponging again would be bus noise.
        if (!ev.pong && !ev._replayed) {
          await post({
            type: 'node-online', role: 'shell', pong: true,
            sessions: Object.entries(sessions).map(([n, s]) => ({ name: n, brain: s.brain })),
            polling: tgPolling,
            wa: !!waBridgeRef.current,
          });
        }
        return;
      }
      case 'node-offline': {
        const wasPolling = !!peerNodesRef.current.get(ev.from)?.polling;
        peerNodesRef.current.delete(ev.from);
        setPeersRev(r => r + 1);
        log(`bus: peer offline ${ev.from}`);
        // The polling slot just opened up. If we have a bot_token but
        // aren't currently bridged (likely because we yielded earlier),
        // schedule a claim attempt with jitter so multiple yielded
        // peers don't all start simultaneously and re-409 each other.
        if (wasPolling && !bridgeRef.current) {
          const delay = 500 + Math.random() * 1500;
          setTimeout(() => { if (!bridgeRef.current) startTgBridge(); }, delay);
        }
        return;
      }
      case 'sessions-update': {
        const peer = peerNodesRef.current.get(ev.from);
        if (peer) { peer.sessions = ev.sessions ?? []; peer.lastSeen = ev.ts ?? Date.now(); }
        setPeersRev(r => r + 1);
        return;
      }
      case 'telegram-status': {
        const peer = peerNodesRef.current.get(ev.from);
        const wasPolling = !!peer?.polling;
        if (peer) { peer.polling = !!ev.polling; peer.lastSeen = ev.ts ?? Date.now(); }
        setPeersRev(r => r + 1);
        // A peer voluntarily released polling. Same auto-claim logic
        // as node-offline.
        if (wasPolling && !ev.polling && !bridgeRef.current) {
          const delay = 500 + Math.random() * 1500;
          setTimeout(() => { if (!bridgeRef.current) startTgBridge(); }, delay);
        }
        return;
      }
      case 'mention': {
        if (ev.to_node !== BUS_NODE_ID) return;
        // Chain-depth guard: a mention that itself originated as a
        // reply-cascade past the room.max_chain limit returns "…"
        // (the polite no-reply convention) instead of calling the
        // brain. This is the runaway-orchestra guard the user asked
        // for — once the depth exceeds the cap, replies politely
        // tail off rather than infinite-looping. Counter is carried
        // on the mention event itself; outgoing room-reply /
        // mention-reply events increment it so peers can see how
        // deep the chain is.
        const incomingChain = Math.max(0, Number(ev.chain_depth ?? 0) | 0);
        const maxChain = Math.max(1, Number(EGPT_CONFIG.room?.max_chain ?? 3) | 0);
        if (incomingChain >= maxChain) {
          log(`bus: chain cap hit (depth ${incomingChain}/${maxChain}) — replying "…" to ${ev.from}`);
          await post({ type: 'mention-reply', to_node: ev.from,
            target: ev.target, body: '…', chain_depth: incomingChain + 1,
            ...(ev.tg_chat_id ? { tg_chat_id: ev.tg_chat_id } : {}) });
          return;
        }
        const nextChain = incomingChain + 1;
        // 'egpt' is the node-global persona, not a /attach session —
        // route to runDefaultBrainTurn so peers (like the extension)
        // can address @egpt and the shell does the brain work on
        // their behalf, then mention-reply back over the bus.
        if (ev.target === 'egpt' || ev.target === 'e') {
          log(`bus: running @egpt for ${ev.from}${ev.user ? ` (${ev.user})` : ''} (chain ${nextChain}/${maxChain})`);
          try {
            const reply = await runDefaultBrainTurn(`[${ev.user ?? 'remote'}]: ${ev.body}`);
            await post({ type: 'mention-reply', to_node: ev.from,
              target: 'egpt', body: reply ?? '', chain_depth: nextChain });
            // Broadcast to the room too — cross-surface visibility,
            // same as a /attach session reply.
            if (reply !== null && reply !== undefined) {
              await post({ type: 'room-reply', role: 'shell',
                session: 'egpt', body: reply, chain_depth: nextChain });
            }
          } catch (e) {
            await post({ type: 'mention-reply', to_node: ev.from,
              target: 'egpt', error: e.message, chain_depth: nextChain });
          }
          return;
        }
        if (ev.target === 'me' || ev.target === 'wren') {
          log(`bus: running @me for ${ev.from}${ev.user ? ` (${ev.user})` : ''} (chain ${nextChain}/${maxChain})`);
          try {
            const reply = await runMetaBrainTurn(`[${ev.user ?? 'remote'}]: ${ev.body}`);
            await post({ type: 'mention-reply', to_node: ev.from,
              target: 'wren', body: reply ?? '', chain_depth: nextChain });
            if (reply !== null && reply !== undefined) {
              await post({ type: 'room-reply', role: 'shell',
                session: 'wren', body: reply, chain_depth: nextChain });
            }
          } catch (e) {
            await post({ type: 'mention-reply', to_node: ev.from,
              target: 'wren', error: e.message, chain_depth: nextChain });
          }
          return;
        }
        if (!sessions[ev.target]) {
          await post({ type: 'mention-reply', to_node: ev.from,
            target: ev.target, error: `no session "${ev.target}" on this node`,
            chain_depth: nextChain,
            ...(ev.tg_chat_id ? { tg_chat_id: ev.tg_chat_id } : {}) });
          return;
        }
        log(`bus: running ${ev.target} for ${ev.from}${ev.user ? ` (${ev.user})` : ''} (chain ${nextChain}/${maxChain})`);
        try {
          const reply = await runBrainTurn(ev.target, `[${ev.user ?? 'remote'}]: ${ev.body}`, sessions);
          // Directed reply to the asker (may carry error). Echo
          // tg_chat_id back so the asker can route to the originating
          // Telegram chat instead of the asker's lastChat.
          await post({ type: 'mention-reply', to_node: ev.from,
            target: ev.target, body: reply ?? '', chain_depth: nextChain,
            ...(ev.tg_chat_id ? { tg_chat_id: ev.tg_chat_id } : {}) });
          // Broadcast reply to the whole room so every peer sees it.
          // The asker also receives this in addition to the directed
          // mention-reply — by design, rooms don't filter messages.
          if (reply !== null && reply !== undefined) {
            await post({ type: 'room-reply', role: 'shell',
              session: ev.target, body: reply, chain_depth: nextChain });
          }
        } catch (e) {
          await post({ type: 'mention-reply', to_node: ev.from,
            target: ev.target, error: e.message,
            ...(ev.tg_chat_id ? { tg_chat_id: ev.tg_chat_id } : {}) });
        }
        return;
      }
      case 'mention-reply': {
        if (ev.to_node !== BUS_NODE_ID) return;
        const target = ev.target ?? ev.from;
        // Tag the brain reply with the peer's BUS_NODE_ID directly.
        // Auto-generated IDs already carry the role prefix
        // ('shell-13232'); user-named nodes carry the chosen name
        // ('home'). Either way, ev.from is the right tag.
        const author = `${target}@${ev.from ?? 'unknown'}`;
        if (ev.error) {
          log(`!! ${author}: ${ev.error}`);
          // Errors still go to the originating Telegram chat if known.
          if (ev.tg_chat_id && bridgeRef.current) {
            const formatted = `${EGPT_EMOJI} <i>!! ${escapeHtml(`${author}: ${ev.error}`)}</i>`;
            bridgeRef.current.send(formatted, { chatId: ev.tg_chat_id });
          }
        } else {
          // tg_chat_id means the original request came from a Telegram
          // chat; route the reply back there directly. Mark the item
          // _localOnly so items-flush doesn't ALSO send it (which would
          // hit lastChat — possibly a different chat).
          const tgRouted = ev.tg_chat_id != null;
          pushItem({
            id: Date.now() + Math.random(), author, body: ev.body ?? '(empty)',
            _node: ev.from, _localOnly: tgRouted,
          });
          await append(author, ev.body ?? '');
          if (tgRouted && bridgeRef.current) {
            const sess = sessions[author] ?? sessions[target];
            const emoji = sess?.emoji ?? '❓';
            const formatted = `${emoji} <b>${escapeHtml(author)}</b>\n${mdToTgHtml(ev.body ?? '')}`;
            bridgeRef.current.send(formatted, { chatId: ev.tg_chat_id });
          }
        }
        return;
      }
      case 'wa-join': {
        if (ev._replayed) return;
        const peer = peerNodesRef.current.get(ev.from);
        const peerRole = peer?.role ?? 'unknown';
        if (ev.jid) {
          log(`bus: ${ev.from} (${peerRole}) joined "${ev.name ?? ev.jid}"`);
        } else {
          log(`bus: ${ev.from} (${peerRole}) unjoined`);
        }
        // Configurable follow: 'never' (default), 'from_shell', 'always'.
        // 'from_shell' only adopts when the announcing peer is the
        // shell node — useful for chrome instances that want to track
        // their shell's binding without auto-following each other.
        const followCfg = EGPT_CONFIG.whatsapp?.follow_join ?? 'never';
        const shouldFollow =
          followCfg === 'always' ||
          (followCfg === 'from_shell' && peerRole === 'shell');
        if (!shouldFollow) return;
        if (ev.jid) {
          // Adopt accumulating semantics — peer added a join, we add it.
          _waJoinedAdd({ jid: ev.jid, name: ev.name ?? ev.jid, idx: -1 });
          log(`wa: following ${ev.from} — added "${ev.name ?? ev.jid}"`);
        } else if (ev.removed) {
          // Peer dropped one specific binding.
          if (_waJoinedRemove(ev.removed)) {
            log(`wa: following ${ev.from} — removed "${ev.removed}"`);
          }
        } else if (_waJoinedSize() > 0) {
          // Peer cleared everything.
          _waJoinedClear();
          log(`wa: following ${ev.from} — cleared all WA bindings`);
        }
        return;
      }
      case 'wa-send': {
        // Ad-hoc WA send routed via bus (typically @waN from a peer's
        // bridge inbound that doesn't have baileys locally). to_node
        // narrows delivery; if absent, any baileys-holding peer may
        // process. Body is sent as-is; the @waN prefix is already
        // stripped by the originator. Headless-side equivalent of this
        // path is the ~/.egpt/outbox/ file watcher below.
        if (ev.to_node && ev.to_node !== BUS_NODE_ID) return;
        dispatchWaSendRef.current?.(ev, 'bus');
        return;
      }
      case 'wa-group-subject': {
        // Bus-side equivalent of the outbox file dispatcher. Peers can
        // request a group-name change here; the baileys-holding node
        // executes (must be admin). to_node narrows like wa-send.
        if (ev.to_node && ev.to_node !== BUS_NODE_ID) return;
        await dispatchWaGroupSubjectRef.current?.(ev, 'bus');
        return;
      }
      case 'telegram-handoff': {
        if (ev.to !== BUS_NODE_ID) {
          if (tgPolling) { stopTgBridge(); }
          return;
        }
        log(`bus: handoff request from ${ev.from} — starting bridge`);
        const ok = await startTgBridge();
        if (!ok) log(`!! could not start bridge — bot_token missing in ~/.egpt/config.json?`);
        return;
      }
      case 'command': {
        if (ev.to_node !== BUS_NODE_ID) return;
        log(`bus: running ${ev.cmd} for ${ev.from}${ev.user ? ` (${ev.user})` : ''}`);
        try {
          const handled = await handleSlash(ev.cmd);
          if (!handled) sysOut(`!! unknown command from bus: ${ev.cmd.split(/\s+/)[0]}`);
        } catch (e) {
          sysOut(`!! bus command failed: ${e.message}`);
        }
        return;
      }
      case 'room-utterance': {
        // Faithful echo of what a user typed on another surface.
        // ev.client (post-Phase 1) carries the client_name; ev.via is
        // kept for older peers and used as fallback. Tag becomes
        // handle@client[.node].
        const fallbackClient =
          ev.via?.startsWith?.('telegram') ? 'tg'
          : ev.via?.startsWith?.('whatsapp') ? 'wa'
          : null;
        const client = ev.client ?? fallbackClient;
        const tag = formatHandleClientNode(ev.user ?? 'human', client, ev.from, BUS_NODE_ID);
        const body = ev.body ?? '';
        const isPeerSlashCommand = body.trimStart().startsWith('/');
        // _source mirrors the surface for items-mirror echo-suppression
        // (don't echo a wa-arrived item back to wa). Independent of
        // client_name renames — it's about the underlying transport.
        const sourceFromVia =
          ev.via?.startsWith?.('telegram') ? 'telegram'
          : ev.via?.startsWith?.('whatsapp') ? 'whatsapp'
          : null;
        pushItem({
          id: Date.now() + Math.random(), author: tag, body,
          ...(isPeerSlashCommand ? { _localOnly: true } : {}),
          ...(sourceFromVia ? { _source: sourceFromVia } : {}),
        });
        return;
      }
      case 'room-reply': {
        // Broadcast brain reply (or persona reply) from a peer. Render
        // with session@node tag. The peer either tags via:<surface>[id]
        // when the reply was direct-sent to a specific bridge chat
        // already (so we don't double-deliver via items-mirror), or
        // leaves via blank for plain shell replies that should
        // replicate to every connected bridge.
        const tag = `${ev.session ?? '?'}@${ev.from ?? 'unknown'}`;
        const sourceFromVia =
          ev.via?.startsWith?.('telegram') ? 'telegram'
          : ev.via?.startsWith?.('whatsapp') ? 'whatsapp'
          : null;
        pushItem({
          id: Date.now() + Math.random(), author: tag, body: ev.body ?? '',
          ...(sourceFromVia ? { _source: sourceFromVia } : {}),
        });
        return;
      }
      default:
        log(`bus: ${ev.type} from ${ev.from ?? '?'}`);
    }
  };

  const color = a =>
    a === 'You' ? T.authorYou : a === 'system' ? T.authorSystem : T.authorBrain;

  // Hide log items (telemetry, room hints, debug) from the conversation
  // transcript. They're still in `items` and reachable via /log.
  const visibleItems = items.filter(item => !item._log);

  // Short + stable message ids: assigned in insertion order on first
  // sight, persisted in refs so they survive React's re-render cycles.
  // Short m-id is convenience (resets on shell restart); stable id is
  // for cross-restart reference — bridge-derived when we have a key,
  // random short otherwise. Both shown in the author line; @<either>
  // resolves to the same reply path.
  for (const item of visibleItems) {
    if (!shortIdByItemId.current.has(item.id)) {
      const shortId = `m${++_shortIdCounter.current}`;
      shortIdByItemId.current.set(item.id, shortId);
      itemByShortId.current.set(shortId, item);
      if (!stableIdByItemId.current.has(item.id)) {
        const stableId = _stableIdForItem(item, sessions);
        stableIdByItemId.current.set(item.id, stableId);
        itemByStableId.current.set(stableId, item);
      }
    }
  }
  return h(Fragment, null,
    h(Static, { items: withDaySeparators(visibleItems) }, item => {
      // Day-change separator — chat-style: "── Today ──", "── Yesterday ──",
      // or "── Wednesday, May 6, 2026 ──".
      if (item._separator) {
        return h(Box, { key: item.id, marginTop: 1 },
          h(Text, { color: T.meta }, `── ${item.body} ──`));
      }
      const isSystem = item.author === 'system';
      const isUser = item.author === 'You';
      const sess = sessions[item.author];
      const emoji = isSystem ? `${EGPT_EMOJI} ` : isUser ? `${USER_EMOJI} ` : sess?.emoji ? `${sess.emoji} ` : '';
      const baseLabel = isUser ? USER_NAME : isSystem ? 'egpt' : item.author;
      // Always show @whereami so a transcript reader knows where each
      // line was uttered. Peer-rendered items (mention-reply, room-reply,
      // room-utterance dispatchers) already include @<peer-id>; only
      // tag with our SURFACE_TAG when one isn't already present.
      const label = baseLabel.includes('@') ? baseLabel : `${baseLabel}@${SURFACE_TAG}`;
      const time = fmtTimeOnly(Math.floor(item.id));
      const shortId = shortIdByItemId.current.get(item.id);
      const stableId = stableIdByItemId.current.get(item.id);
      // Trim stable id to the first 14 chars for display — bridge ids
      // (WA stanza, TG chat+msg) can be long, and the operator only
      // needs enough to type unambiguously; '@<prefix>' resolves by
      // prefix match in the reply handler.
      // Display id swaps the leading kind dash for underscore so
      // double-click selects the whole token. The @-handler accepts
      // either form for input.
      const stableDispRaw = stableId ? stableId.replace(/^([a-z]+)-/, '$1_') : '';
      const stableDisp = stableDispRaw ? ` ${stableDispRaw.length > 14 ? stableDispRaw.slice(0, 13) + '…' : stableDispRaw}` : '';
      return h(Box, { key: item.id, flexDirection: 'column', marginBottom: 1 },
        h(Text, { color: color(item.author), bold: !item._thinking },
          `${emoji}${label} `,
          item._thinking
            ? h(Text, { color: T.meta }, '(thinking…)')
            : h(Text, { color: T.meta },
                shortId ? `(${time}) [${shortId}${stableDisp}]` : `(${time})`)),
          item._thinking
          ? h(Box, { flexDirection: 'column' },
              h(Text, { italic: true }, item.body),
              h(Text, { color: T.meta }, '  ╌╌╌'))
          : item._themed
          ? h(Box, { flexDirection: 'column' },
              // Generic list theming for commands that opt in via
              // sysOut(body, { _themed: true }). A per-line classifier
              // picks a theme color from a small palette; commands keep
              // emitting plain strings without restructuring into typed
              // rows the way /recap does. Patterns are conservative —
              // when nothing matches, the line renders in listItem
              // (default white) so opt-in is always a visual upgrade.
              ...item.body.split('\n').map((line, i) => {
                if (line === '') return h(Text, { key: i }, ' ');
                if (/^!! /.test(line))
                  return h(Text, { key: i, color: T.error, bold: true }, line);
                if (/^[─━=]{3,}/.test(line) || /^\s*──\s+.+\s+──+\s*$/.test(line))
                  return h(Text, { key: i, color: T.listSection, bold: true }, line);
                if (/\(no\s.+\)$|\(none\)$/.test(line))
                  return h(Text, { key: i, color: T.listMuted, italic: true }, line);
                if (/^\s*\/[a-z]/.test(line) || /^use\s+@/.test(line))
                  return h(Text, { key: i, color: T.listHint }, line);
                // /channels-shape chat header — '  [📌 ]@waN  [kind]  name  (age)'.
                // Splits each segment into its own colored span so the
                // operator can pick the addressable @waN out of a row
                // without scanning. Same regex matches the welcome-back's
                // legacy chat lines and anything else that adopts this
                // shape. Pin marker is optional; `[kind]` covers
                // [group], [1:1], [status]; `(age)` is anything in
                // trailing parens.
                const ch = line.match(/^(\s+)(📌\s+)?(\s*)(@wa\d+)(\s+)(\[[^\]]+\])(\s+)(.+?)(\s\s+)(\([^)]+\))\s*$/);
                if (ch) {
                  const [, indent, pin, padBeforeHandle, handle, sp1, tag, sp2, name, sp3, age] = ch;
                  return h(Text, { key: i },
                    indent,
                    pin ? h(Text, { color: T.listAccent }, pin) : '',
                    padBeforeHandle ?? '',
                    h(Text, { color: T.recapId, bold: true }, handle),
                    sp1,
                    h(Text, { color: T.listHint }, tag),
                    sp2,
                    h(Text, { color: T.listAccent, bold: true }, name),
                    sp3,
                    h(Text, { color: T.listMuted }, age));
                }
                // Preview line — '      [Author] body'. The bracketed
                // author block is the meta; the body's the content.
                const pv = line.match(/^(\s{4,})\[([^\]]+)\]\s+(.+)$/);
                if (pv) {
                  const [, indent, author, body] = pv;
                  return h(Text, { key: i },
                    indent,
                    h(Text, { color: T.listMuted }, '['),
                    h(Text, { color: T.recapAuthor }, author),
                    h(Text, { color: T.listMuted }, '] '),
                    h(Text, { color: T.recapBody }, body));
                }
                // Lines containing the pin marker (but didn't match
                // the chat-header regex above) get the accent tint on
                // the whole row.
                if (/📌/.test(line))
                  return h(Text, { key: i, color: T.listAccent }, line);
                // First non-blank line is usually a header ("chats
                // (top 10…):" / "Saved rooms in <path>:"). Detect by
                // trailing colon and no leading whitespace.
                if (/^\S.*:$/.test(line))
                  return h(Text, { key: i, color: T.listHeader, bold: true }, line);
                // Indented sub-rows (>=6 spaces of leading whitespace,
                // typical of previews or bios under a main row). Less
                // emphasized than the main item color.
                if (/^ {6,}\S/.test(line))
                  return h(Text, { key: i, color: T.listSub }, line);
                return h(Text, { key: i, color: T.listItem }, line);
              }))
          : item._recap && Array.isArray(item._recapRows)
          ? h(Box, { flexDirection: 'column' },
              ...item._recapRows.map((row, i) => {
                const sectionColor = (sec) => {
                  if (sec === 'pinned') return T.recapColorPinned;
                  if (sec === 'group')  return T.recapColorGroup;
                  if (sec === 'status') return T.recapColorStatus;
                  if (sec === 'dm')     return T.recapColorDm;
                  return undefined;
                };
                if (row.type === 'blank') return h(Text, { key: i }, ' ');
                if (row.type === 'title')
                  return h(Text, { key: i, color: T.recapHeader, bold: true }, row.text);
                if (row.type === 'section')
                  return h(Text, { key: i, color: sectionColor(row.section), bold: true },
                    `  ${row.emoji} ${row.label}`);
                if (row.type === 'chat')
                  // Legacy 'chat' row (compatibility). New chat headers
                  // emit type 'chat-header' below with the richer
                  // /channels-shape (📌 + @waN + [kind] + name + age).
                  return h(Text, { key: i, color: sectionColor(row.section), bold: true },
                    `    `,
                    h(Text, { color: T.recapId }, row.waIdx ? `@wa${row.waIdx}  ` : ''),
                    row.chatLabel);
                if (row.type === 'chat-header') {
                  // 📌 (if pinned) @waN [kind] name (age)
                  // Each segment colors independently so the eye can
                  // grab the addressable @waN without parsing.
                  return h(Text, { key: i },
                    '    ',
                    row.pinned ? h(Text, { color: T.recapColorPinned }, '📌 ') : '',
                    h(Text, { color: T.recapId, bold: true }, `@wa${row.waIdx}`),
                    h(Text, { color: T.recapHint }, `  [${row.kindTag}]  `),
                    h(Text, { color: sectionColor(row.section), bold: true }, row.chatLabel),
                    h(Text, { color: T.recapHint }, `  (${row.age})`));
                }
                if (row.type === 'preview') {
                  // Preview line: '       author: body  wa_XXXXXXXX  HH:MM'
                  // id + time at the end so the operator can reach
                  // for a specific message to reply to without
                  // opening /last. underscore form of the id keeps
                  // double-click selection one token.
                  const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
                  const body = oneLine(row.body);
                  const bdDisp = row.mediaPath
                    ? clickablePath(body, row.mediaPath)
                    : body;
                  const folderDisp = row.mediaPath
                    ? '  ' + clickablePath('📁', dirname(row.mediaPath))
                    : '';
                  const idDisp = (row.stableId || '').replace(/^([a-z]+)-/, '$1_').slice(0, 11);
                  let hhmm = '';
                  if (row.ts) {
                    const d = new Date(row.ts);
                    hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
                  }
                  return h(Text, { key: i },
                    '       ',
                    h(Text, { color: T.recapAuthor }, row.author),
                    h(Text, { color: T.recapHint }, ': '),
                    h(Text, { color: T.recapBody }, bdDisp + folderDisp),
                    idDisp ? h(Text, null, '  ') : '',
                    idDisp ? h(Text, { color: T.recapId }, idDisp) : '',
                    hhmm ? h(Text, null, '  ') : '',
                    hhmm ? h(Text, { color: T.recapTimestamp }, hhmm) : '');
                }
                if (row.type === 'hint')
                  return h(Text, { key: i, color: T.recapHint }, `  ${row.text}`);
                if (row.type === 'row') {
                  // Chat header sits above on its own line; rows just
                  // carry `<author>: <body>  <id>  <time>`. When the
                  // speaker is the same as the previous row (`cont`),
                  // we drop the author label entirely and indent two
                  // more spaces — the speaker's thread reads as a
                  // vertical run of bodies under a single name above.
                  const d = new Date(row.ts);
                  const hh = String(d.getHours()).padStart(2, '0');
                  const mm = String(d.getMinutes()).padStart(2, '0');
                  const trim = (s, w) => (s.length <= w ? s : s.slice(0, w - 1) + '…');
                  // Flatten newlines but don't truncate — operator
                  // wants full message text "like a play". The
                  // terminal soft-wraps long lines on its own.
                  const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
                  // Display id swaps the leading kind dash for
                  // underscore — double-click selects the whole id
                  // in modern terminals ('wa_AC8AD42D' is one token,
                  // 'wa-AC8AD42D' splits at the hyphen). Internal
                  // hyphens stay; the @-handler accepts either form.
                  const idDisp = ((row.stableId || '').replace(/^([a-z]+)-/, '$1_')).slice(0, 11);
                  // Media body wraps in an OSC 8 hyperlink to the
                  // saved file; trailing 📁 wraps the containing
                  // folder so the operator can jump to Explorer /
                  // Finder instead.
                  const bodyText = oneLine(row.body);
                  const bdDisp = row.mediaPath
                    ? clickablePath(bodyText, row.mediaPath)
                    : bodyText;
                  const folderDisp = row.mediaPath
                    ? '  ' + clickablePath('📁', dirname(row.mediaPath))
                    : '';
                  if (row.cont) {
                    return h(Text, { key: i },
                      '      ',
                      h(Text, { color: T.recapBody }, bdDisp + folderDisp),
                      '  ',
                      h(Text, { color: T.recapId }, idDisp),
                      '  ',
                      h(Text, { color: T.recapTimestamp }, `${hh}:${mm}`));
                  }
                  const auDisp = trim(row.author || '?', 28);
                  return h(Text, { key: i },
                    '    ',
                    h(Text, { color: T.recapAuthor }, auDisp),
                    h(Text, { color: T.recapHint }, ': '),
                    h(Text, { color: T.recapBody }, bdDisp + folderDisp),
                    '  ',
                    h(Text, { color: T.recapId }, idDisp),
                    '  ',
                    h(Text, { color: T.recapTimestamp }, `${hh}:${mm}`));
                }
                return h(Text, { key: i }, row.text ?? '');
              }))
          : item._bright
          ? h(Box, { flexDirection: 'column' },
              ...item.body.split('\n').map((line, i) => {
                if (/^──/.test(line)) return h(Text, { key: i, color: T.helpSeparator, bold: true }, line);
                if (line === '') return h(Text, { key: i }, ' ');
                if (/^\s{2,}/.test(line)) return h(Text, { key: i, color: T.helpIndent }, line);
                const dash = line.indexOf(' — ');
                if (dash > 0) return h(Text, { key: i },
                  h(Text, { color: T.helpCommand }, line.slice(0, dash)),
                  h(Text, { color: T.helpDash }, ' — '),
                  h(Text, { color: T.helpDescription }, line.slice(dash + 3)));
                return h(Text, { key: i, color: T.helpCommand }, line);
              }))
          : h(Text, { italic: isSystem, color: isSystem ? T.systemBody : undefined }, item.body));
    }),
    h(Box, { flexDirection: 'column', marginTop: 1 },
      h(Text, null,
        h(Text, { color: T.statusBrand, bold: true }, `${EGPT_EMOJI} egpt`),
        h(Text, { color: T.statusFile }, `  ${basename(FILE)}  `),
        currentRoom !== 'default'
          ? h(Text, { color: T.statusFile }, `[${currentRoom}]  `)
          : null,
        h(Text, { color: T.statusSessions }, (() => {
          // Status line: show what's actually in the room AND what
          // plain text routes to. Empty in-room sessions + no /use
          // bindings = '(empty room)'; otherwise list local brains
          // (* = active for plain text via /use) and any joined WA
          // chats (→ @waN "name") so the operator can see at a
          // glance where their typing goes.
          const localBrains = Object.entries(sessions).map(([n, s]) => {
            const star = activeSessions.includes(n) ? '*' : '';
            return `${star}${s.emoji ?? ''}${n}`;
          });
          const waChats = _waJoinedAll().map(e =>
            `→@wa${e.idx >= 0 ? e.idx + 1 : '?'} "${(e.name ?? '').slice(0, 24)}"`);
          if (!localBrains.length && !waChats.length) return '(empty room)';
          const parts = [];
          if (localBrains.length) parts.push(localBrains.join(' '));
          if (waChats.length) parts.push(waChats.join(' '));
          return parts.join('  ');
        })())),
      streaming && (() => {
        // Show only the trailing portion of long streamed text — keeps the
        // dynamic area small even for multi-page replies, and reduces Ink's
        // re-render cost. Full text gets committed to <Static> once finalized.
        const lines = streaming.text.split('\n');
        const tail = lines.slice(-8).join('\n');
        const hidden = Math.max(0, lines.length - 8);
        const charCount = streaming.text.length;
        const elapsed = busyStart ? ((now - busyStart) / 1000).toFixed(1) : '0.0';
        return h(Box, { flexDirection: 'column', marginTop: 1 },
          h(Text, { color: T.authorBrain, bold: true },
            `${sessions[streaming.author]?.emoji ? sessions[streaming.author].emoji + ' ' : ''}${streaming.author}  `,
            h(Text, { color: T.streamingStats },
              `(${charCount} chars · ${elapsed}s · Ctrl+R to abort)`)),
          hidden > 0 && h(Text, { color: T.streamingStats },
            `… ${hidden} earlier line${hidden > 1 ? 's' : ''} hidden …`),
          h(Text, null, tail + '▎'));
      })(),
      busy && !streaming?.text && (() => {
        // While the brain is processing input but hasn't started streaming
        // yet, show an elapsed counter and a spinner so the UI looks alive.
        const elapsed = busyStart ? ((now - busyStart) / 1000).toFixed(1) : '0.0';
        const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
        const ch = SPIN[Math.floor(now / 100) % SPIN.length];
        return h(Text, { color: T.spinnerLabel },
          `${ch} ${busyLabel ?? 'thinking…'} `,
          h(Text, { color: T.spinnerElapsed },
            `${elapsed}s · Ctrl+R to abort`));
      })(),
      browserWaiting && h(Box, { flexDirection: 'column', marginTop: 1 },
        h(Text, { color: T.spinnerLabel, bold: true },
          '⏸  WAITING FOR YOU: ',
          h(Text, { color: 'white' }, browserWaiting)),
        h(Text, { color: T.hint }, '   type /continue when ready')),
      error && h(Text, { color: T.error }, '!! ' + error),
      !busy && h(Box, { flexDirection: 'column' },
        h(Text, { color: T.hint },
          'Enter=newline · Ctrl+D=send · Ctrl+C=exit · /help'),
        h(MultiLineInput, { onSubmit: submit, currentRoom }))));
}

// Module-level bridge references so SIGINT/SIGHUP/SIGTERM handlers can
// abort long-poll fetches and flush per-bridge state (chats-cache,
// reaction-counts) synchronously before the process exits. Two slots
// because the bridges are independent — TG and WA each register the
// instance they own. React refs aren't reachable from a top-level
// signal handler, so this is the seam.
let _globalBridge = null;       // telegram bridge
let _globalWaBridge = null;     // whatsapp bridge — owns the logon-summary counters
// llama-server child (the @l supervisor's proc). Lifted to module scope so
// _exitClean / process.on('exit') can kill it: it's a child process and
// Windows doesn't kill children with the parent, so a hard process.exit(43)
// (from /restart) would otherwise ORPHAN it and the respawned egpt.mjs
// couldn't rebind the port — leaving the stale llama (and its backlog) alive.
// Killing it here makes /restart a full restart: fresh egpt + fresh llama.
let _globalLlamaProc = null;    // llama-server (@l) — killed on exit so /restart cycles it
// On clean exit from the interactive shell, stamp last-logon so the
// NEXT interactive shell's summary covers the window between then and
// its takeover. Headless processes don't stamp — they're the
// accumulator, not the consumer.
const _exitClean = async (code = 0) => {
  _globalBridge?.stop();
  // WA bridge.stop() synchronously flushes wa-chats.json and
  // reaction-counts.json — critical so the next interactive shell's
  // summary sees the latest counts. Order matters: stop both bridges
  // before clearing the pidfile (otherwise a racing successor could
  // re-enter takeover before we're done writing).
  _globalWaBridge?.stop();
  // Kill the llama-server child on RESTART-family exits (non-zero: /restart=43,
  // /upgrade=42, /rewind=44, crash) so the respawned egpt.mjs gets a fresh
  // llama on a freed port instead of orphaning the old one. On code 0
  // (interactive takeover / clean stop) we deliberately LEAVE it: takeover
  // hands the port to the new shell, which doesn't run the supervisor, so a
  // surviving llama is what keeps @l alive across the handoff.
  if (code !== 0) {
    try { _globalLlamaProc?.kill(); } catch (e) { console.error(`!! egpt.mjs: kill llama: ${e?.message ?? e}`); }
    _globalLlamaProc = null;
  }
  // Let baileys' WebSocket close handshake reach WA's server before
  // process.exit. Without this, the close packet may not have left
  // the kernel buffer when the process dies — WA's server still
  // thinks we're connected, and the NEXT shell's authenticate trips
  // 'connectionReplaced' (reason 440), looping until the stale entry
  // times out server-side (~minutes). 800ms is empirically enough on
  // a reachable network; if the WS was already dead it's just dead
  // wait. process.on('exit') below catches synchronous-exit paths
  // (uncaught throws, etc.) where we can't await.
  try { await new Promise(r => setTimeout(r, 800)); } catch (e) { console.error(`!! egpt.mjs:[catch] ${e?.message ?? e}`); }
  if (!HEADLESS) writeLastLogonNow();
  clearPidfile();
  process.exit(code);
};
process.on('SIGINT',  () => { _exitClean(0); });
process.on('SIGHUP',  () => { _exitClean(0); });
process.on('SIGTERM', () => { _exitClean(0); });

// Auto-detect the role (D3): does a live spine already answer on the port in
// nucleus.json? A successful signed handshake means yes → run as a limb. A
// missing/stale sidecar, or a refused/timed-out connect, means no → become the
// spine. The probe connects then immediately closes; the App's attach-client
// effect makes the real, persistent connection.
async function spineIsLive() {
  let info = null;
  try { info = await readNucleusInfo(); } catch { return false; }
  if (!info?.port) return false;
  try {
    const keyB64 = await bus.loadOrCreateBusKey();
    const probe = await connectAttachClient({
      host: info.host ?? '127.0.0.1', port: info.port, keyB64, kind: 'shell',
      onFrame: () => {}, onClose: () => {},
    });
    try { probe.close(); } catch {}
    return true;
  } catch { return false; }
}

// Unless a role was forced (--client / --spine / --engine / --headless), decide
// now: attach to a live spine if one answers, else become the spine ourselves.
// This is "just run egpt and it does the right thing" — a second `node egpt.mjs`
// now ATTACHES instead of taking the helm from the running one.
if (!CLIENT && !FORCE_SPINE && !HEADLESS) {
  CLIENT = await spineIsLive();
  console.log(CLIENT
    ? 'egpt: a spine is already running — attaching as a limb'
    : 'egpt: no spine found — becoming the spine');
}

// Pidfile handshake: if an older instance is running (most commonly the
// headless engine from Task Scheduler / systemd / launchd), ask it to
// exit, wait for it to release the WA pairing, then take ownership.
// Same code path for interactive AND headless mode — both honor the
// single-writer invariant. Symmetric: a headless process started while
// an interactive shell is up will also take over (rare but valid).
const _egptMode = HEADLESS ? 'headless' : 'interactive';
// A limb (client) never enters the WA-helm handshake: it attaches to the spine
// over the socket, owns no WhatsApp pairing, and must NOT SIGTERM the running
// spine (takeoverIfRunning) nor claim the owner pidfile. The takeover/pidfile/
// heartbeat dance is strictly the engine's.
if (!CLIENT) {
  await takeoverIfRunning(_egptMode);
  writePidfile(_egptMode);
  startAliveHeartbeat();
}

// "while you were away" summary moved into the App mount effect (see
// _welcomeBackEffect below). The previous pre-mount console.log path
// couldn't register reply-target ids in the sidecar (the sidecar
// lives inside App state), so /recap-style reply-by-id only worked
// after the operator ran /recap manually. By dispatching the welcome-
// back from inside the App we get reply-able rows on the very first
// frame, and Ink owns the screen end-to-end.

if (HEADLESS) {
  // Ink wants tty-like stdin/stdout. Stub both so the render call
  // doesn't crash on setRawMode() / cursor positioning. Ink emits
  // ANSI escape sequences (cursor save/restore, clear-line, alt-screen
  // mode) on every redraw — when the destination is a plain file these
  // pollute the log AND trip VS Code's ambiguous-unicode warning.
  // Strip them on the way out + collapse the consecutive duplicate
  // lines Ink's churn produces. Operator (2026-05-21).
  //
  // Size-based rotation (operator 2026-05-22): when headless.log
  // exceeds HEADLESS_LOG_MAX_BYTES, rotate to .log.1 (replacing any
  // previous backup) and open a fresh .log. Check happens at startup
  // AND periodically during runs (every Nth write). Keeps logs
  // bounded without external logrotate.
  const HEADLESS_LOG_MAX_BYTES = 500 * 1024;          // 500 KB (operator 2026-05-22: "shouldn't be more than 5k, at most... why keep it so long")
  const HEADLESS_LOG_BACKUP = EGPT_HEADLESS_LOG + '.1';
  const ROTATE_CHECK_EVERY_WRITES = 200;
  const _rotateIfBig = () => {
    try {
      const st = statSync(EGPT_HEADLESS_LOG);
      if (st.size <= HEADLESS_LOG_MAX_BYTES) return false;
      try { unlinkSync(HEADLESS_LOG_BACKUP); } catch (e) { /* no prior backup — fine */ }
      renameSync(EGPT_HEADLESS_LOG, HEADLESS_LOG_BACKUP);
      return true;
    } catch (e) { return false; }
  };
  // Startup rotation: if log is already huge from a prior session.
  _rotateIfBig();
  let rawFile = createWriteStream(EGPT_HEADLESS_LOG, { flags: 'a' });
  let _writeCount = 0;
  const _maybeRotateDuringRun = () => {
    _writeCount++;
    if (_writeCount % ROTATE_CHECK_EVERY_WRITES !== 0) return;
    if (!_rotateIfBig()) return;
    try { rawFile.end(); } catch (e) { /* swallow — about to replace */ }
    rawFile = createWriteStream(EGPT_HEADLESS_LOG, { flags: 'a' });
  };
  // CSI sequences (\x1b[...letter), OSC (\x1b]...\x07 or \x1b\\), and
  // 2-char designation escapes (\x1b(B etc.).
  const ANSI_REGEX = /\x1b\[[\d;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z]/g;
  let _lastNonEmptyLine = '';
  let _pendingTail = '';
  const stdoutLog = new Writable({
    write(chunk, enc, cb) {
      const str = (typeof chunk === 'string') ? chunk : chunk.toString('utf8');
      const cleaned = (_pendingTail + str).replace(ANSI_REGEX, '');
      // Buffer the final partial line so we don't dedupe mid-write.
      const lastNl = cleaned.lastIndexOf('\n');
      const complete = lastNl >= 0 ? cleaned.slice(0, lastNl + 1) : '';
      _pendingTail = lastNl >= 0 ? cleaned.slice(lastNl + 1) : cleaned;
      if (!complete) { cb(); return; }
      const lines = complete.split('\n');
      const out = [];
      // Spinner/progress lines from the Ink "thinking…" indicator —
      // every animation frame is a unique line (rotating braille char +
      // monotonically-advancing seconds), so the dedup below can't
      // suppress them. These are pure UI noise; the headless.log
      // shouldn't carry per-frame thinking ticks. Drop entirely.
      // Operator 2026-05-22: "headless shouldn't be more than 5k...
      // we only log final transcript and the final reply."
      const SPINNER_RE = /[⠁⠂⠃⠄⠅⠆⠇⠈⠉⠊⠋⠌⠍⠎⠏⠐⠑⠒⠓⠔⠕⠖⠗⠘⠙⠚⠛⠜⠝⠞⠟⠠⠡⠢⠣⠤⠥⠦⠧⠨⠩⠪⠫⠬⠭⠮⠯⠰⠱⠲⠳⠴⠵⠶⠷⠸⠹⠺⠻⠼⠽⠾⠿]\s*thinking…\s*\d+(?:\.\d+)?s/;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (i === lines.length - 1 && line === '') { out.push(''); continue; }
        if (line !== '' && SPINNER_RE.test(line)) continue;
        // Suppress consecutive identical non-empty lines (Ink redraw churn).
        if (line !== '' && line === _lastNonEmptyLine) continue;
        out.push(line);
        if (line !== '') _lastNonEmptyLine = line;
      }
      _maybeRotateDuringRun();
      rawFile.write(out.join('\n'), cb);
    },
    final(cb) {
      if (_pendingTail) rawFile.write(_pendingTail);
      rawFile.end(cb);
    },
  });
  stdoutLog.isTTY = true;
  stdoutLog.columns = 120;
  stdoutLog.rows = 40;
  const stdinNull = new PassThrough();
  stdinNull.isTTY = true;
  stdinNull.setRawMode = () => stdinNull;
  stdinNull.ref = () => {};
  stdinNull.unref = () => {};
  stdoutLog.write(`\n[${new Date().toISOString()}] egpt --headless starting (pid ${process.pid}, file ${FILE})\n`);
  render(h(App), {
    stdin: stdinNull,
    stdout: stdoutLog,
    stderr: stdoutLog,
    exitOnCtrlC: false,
  });
} else {
  console.log(`egpt | ${FILE}${CLIENT ? ' (limb — attached to spine)' : ' (spine)'}`);
  console.log('Enter=newline · Ctrl+D=send · Ctrl+C=exit · /help for commands\n');
  render(h(App), { exitOnCtrlC: false });
}
process.on('exit', (code) => { _globalBridge?.stop(); _globalWaBridge?.stop(); try { clearNucleusInfoSync(); } catch {} if (code !== 0) { try { _globalLlamaProc?.kill(); } catch {} } clearPidfile(); stopAliveHeartbeat(); });

// Crash logger (operator 2026-05-23: shell crash-loops code=1, stack
// lost to the inherited TTY). Persist the stack to ~/.egpt/state/
// crash.log so post-mortem is possible. Per operator's "errors must
// bubble and be logged" rule. unhandledRejection: log + SWALLOW (most
// stray rejections aren't fatal; swallowing stops the disruptive
// crash-restart loop while we diagnose). uncaughtException: log +
// exit (process state may be corrupt; let the supervisor restart).
function _logCrash(kind, err) {
  const stack = err?.stack ?? String(err);
  try {
    mkdirSync(join(EGPT_HOME, 'state'), { recursive: true });
    appendFileSync(join(EGPT_HOME, 'state', 'crash.log'),
      `[${new Date().toISOString()}] ${kind} (pid ${process.pid}):\n${stack}\n\n`);
  } catch {}
  try { console.error(`!! ${kind}: ${stack}`); } catch {}
}
process.on('unhandledRejection', (reason) => { _logCrash('unhandledRejection', reason); });
process.on('uncaughtException',  (err)    => { _logCrash('uncaughtException', err); process.exit(1); });
