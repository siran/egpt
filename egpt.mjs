#!/usr/bin/env node
// egpt.mjs — file IS the conversation; Ink shell; sessions = named participants
import React from 'react';
import { render, Box, Text, Static, useInput, useApp } from 'ink';
import YAML from 'yaml';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync, createWriteStream } from 'node:fs';
import { PassThrough } from 'node:stream';
import { readFile, writeFile, appendFile, readdir, stat, open, mkdir, unlink, rm, rename } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as ccode from './brains/claude-code.mjs';
import * as codex from './brains/codex.mjs';
import * as chatgptCdp from './brains/chatgpt-cdp.mjs';
import * as claudeCdp from './brains/claude-cdp.mjs';
import * as cdp from './tools/cdp.mjs';
import * as bus from './tools/bus.mjs';
import { loadTemplate, buildCommandPrompt } from './tools/template.mjs';
import { loadTheme, listThemes } from './tools/theme.mjs';
import { startTelegramBridge } from './bridges/telegram.mjs';
import { startWhatsAppBridge } from './bridges/whatsapp.mjs';
import { classifyWhatsAppChat } from './bridges/whatsapp-classify.mjs';
import { recordSession, startNew, rewind, listHistory, summarize, setBrain, isUrlBrain } from './persona-state.mjs';
import { emojiForAuthor as _emojiForAuthor } from './author-emoji.mjs';
import { parseInput, helpText, helpHtml } from './interpreter.mjs';
import { resolveRoute, planMirrors } from './room.mjs';
import { CONFIG_SCHEMA } from './config-schema.mjs';
import { buildWelcomeBack, resetCountersOnDisk, writeLastLogonNow } from './tools/logon-summary.mjs';
import { waListToStableCache as _waListToStableCache } from './tools/wa-bindings.mjs';
import { summonGenie as _summonGenieFromBridge } from './tools/genie.mjs';
import { buildMoviePayload as _buildMoviePayload } from './slash/movie.mjs';

const { createElement: h, useState, useEffect, useRef, useCallback, Fragment } = React;
const APP_DIR = dirname(fileURLToPath(import.meta.url));
const EGPT_HOME = join(homedir(), '.egpt');

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
  try { entries = readdirSync(slashDir); } catch (_) { /* dir missing — empty registry */ }
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
// Pidfile: single-writer ownership of the WA pairing (baileys can only
// authenticate one client at a time). Headless engine writes its PID
// here at startup; a subsequent interactive shell reads it, SIGTERMs
// the old process, polls until it exits, then takes over. Cleared on
// clean exit (signal handler + process.exit). See takeoverIfRunning().
const EGPT_PID_PATH = join(EGPT_HOME, 'egpt.pid');
// Headless mode log: Ink renders nowhere visible (no tty), so any
// console.log / sysOut that would have hit the terminal lands here for
// post-mortem. Bridges + room.md are still the canonical record;
// this is auxiliary.
const EGPT_HEADLESS_LOG = join(EGPT_HOME, 'headless.log');

// Read the existing pidfile if any. Returns the PID number when the
// process is still alive, otherwise null (and silently clears stale
// entries). Uses `process.kill(pid, 0)` — the POSIX "are you there"
// probe that throws ESRCH for dead PIDs. On Windows, Node maps this
// to OpenProcess + check; same semantics.
function _readLivePid() {
  try {
    const raw = readFileSync(EGPT_PID_PATH, 'utf8').trim();
    const pid = Number(raw);
    if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) return null;
    try { process.kill(pid, 0); return pid; }
    catch { try { unlinkSync(EGPT_PID_PATH); } catch {} return null; }
  } catch { return null; }
}

async function takeoverIfRunning() {
  const pid = _readLivePid();
  if (!pid) return false;
  try { process.kill(pid, 'SIGTERM'); } catch {}
  // Poll up to 10s for the old process to release the pairing. 200ms
  // ticks; on a clean exit, baileys.logout takes ~1-2s. If the old
  // process is wedged, we proceed anyway with a warning — baileys
  // will simply knock it off the WA server on its own connect.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch {
      try { unlinkSync(EGPT_PID_PATH); } catch {}
      return true;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  // eslint-disable-next-line no-console
  console.error(`egpt: previous instance (pid ${pid}) did not exit within 10s; continuing anyway`);
  return true;
}

function writePidfile() {
  try {
    mkdirSync(EGPT_HOME, { recursive: true });
    writeFileSync(EGPT_PID_PATH, String(process.pid), { mode: 0o600 });
  } catch {}
}

function clearPidfile() {
  try {
    const raw = readFileSync(EGPT_PID_PATH, 'utf8').trim();
    if (Number(raw) === process.pid) unlinkSync(EGPT_PID_PATH);
  } catch {}
}

// Load config: global (~/.egpt/config.json) then local (.egpt/config.json).
// Local keys override global ones. Both files are optional.
let EGPT_CONFIG = {};
try { EGPT_CONFIG = JSON.parse(readFileSync(join(EGPT_HOME, 'config.json'), 'utf8')); } catch {}
const LOCAL_CONFIG_PATH = join(process.cwd(), '.egpt', 'config.json');
try { EGPT_CONFIG = { ...EGPT_CONFIG, ...JSON.parse(readFileSync(LOCAL_CONFIG_PATH, 'utf8')) }; } catch {}
const T = loadTheme(EGPT_CONFIG.theme ?? 'catppuccin');
let _currentTheme = EGPT_CONFIG.theme ?? 'catppuccin';
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
try { _defaultOp = readFileSync(DEFAULT_OP_FILE, 'utf8').trim() || null; } catch {}

function persistDefaultOp(name) {
  try {
    mkdirSync(EGPT_HOME, { recursive: true });
    if (name) writeFileSync(DEFAULT_OP_FILE, name, 'utf8');
    else { try { unlinkSync(DEFAULT_OP_FILE); } catch {} }
  } catch {}
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
  [codex.name]: codex,
  [chatgptCdp.name]: chatgptCdp,
  [claudeCdp.name]:  claudeCdp,
};

const BRAIN_ALIASES = Object.fromEntries(
  Object.values(BRAINS).flatMap(brain => (brain.legacyNames ?? []).map(alias => [alias, brain.name])),
);

// Short, recognizable session-name prefixes per brain. Sessions are
// auto-named <prefix><N> where N grows to the first unused integer.
const BRAIN_PREFIX = {
  'chatgpt-cdp': 'cgpt',
  'claude-cdp':  'claude',
  'ccode':       'ccode',
  'codex':       'codex',
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
const cliArgs = _rawCliArgs.filter(a => a !== '--headless');
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
  } catch { return new Map(); }
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

const ROOMS_DIR = join(EGPT_HOME, 'rooms');

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
    } catch (_) { /* skip malformed */ }
  }
  return out;
}

async function saveRoomToDisk(name, sessionsMap) {
  if (name === 'default') return;
  await mkdir(ROOMS_DIR, { recursive: true });
  const data = { name, saved: new Date().toISOString(), sessions: sessionsMap ?? {} };
  await writeFile(join(ROOMS_DIR, `${name}.yaml`), YAML.stringify(data));
}

async function deleteRoomFile(name) {
  try { await unlink(join(ROOMS_DIR, `${name}.yaml`)); } catch (_) {}
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
const HISTORY_DIR = join(EGPT_HOME, 'history');
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
  } catch {}
}
_migrateLegacyHistory();

function _loadInputHistory(roomName) {
  try {
    const p = _historyPath(roomName);
    if (!existsSync(p)) return [];
    const raw = readFileSync(p, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(s => typeof s === 'string') : [];
  } catch { return []; }
}
function _saveInputHistory(roomName, arr) {
  try {
    if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });
    const trimmed = arr.length > HISTORY_CAP ? arr.slice(-HISTORY_CAP) : arr;
    writeFileSync(_historyPath(roomName), JSON.stringify(trimmed), { mode: 0o600 });
  } catch {}
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

  useEffect(() => {
    if (!busy) { setBusyStart(null); return; }
    setBusyStart(Date.now());
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [busy]);

  // Poll for ~/.egpt/browser-pause.txt — written by browser.waitForHuman() inside
  // an operator script. When found, show a banner prompting the user to act in
  // the browser and type /continue.
  useEffect(() => {
    const pauseFile = join(EGPT_HOME, 'browser-pause.txt');
    const id = setInterval(() => {
      if (!existsSync(pauseFile)) return;
      let msg = 'please act in the browser';
      try { msg = readFileSync(pauseFile, 'utf8').trim() || msg; unlinkSync(pauseFile); } catch {}
      setBrowserWaiting(msg);
    }, 800);
    return () => clearInterval(id);
  }, []);

  // Telegram bridge management. Auto-starts if ~/.egpt/config.json has a
  // bot_token; /telegram <node> stops this node's bridge and hands polling to
  // a peer over the bus; the named peer's startTgBridge() picks it up.
  const tgCfgRef = useRef(null);

  const startTgBridge = useCallback(async () => {
    if (bridgeRef.current) return true;
    let cfg = tgCfgRef.current;
    if (!cfg) {
      try { cfg = JSON.parse(await readFile(join(homedir(), '.egpt', 'config.json'), 'utf8')); }
      catch { return false; }
      tgCfgRef.current = cfg;
    }
    if (!cfg.telegram?.bot_token) return false;
    const bridge = startTelegramBridge({
      botToken:     cfg.telegram.bot_token,
      nodeName:     cfg.telegram.node_name ?? 'egpt-shell',
      allowedUsers: cfg.telegram.allowed_users ?? [],
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
      onIncoming: async (text, from) => {
        const who = from.username ? `@${from.username}` : (from.firstName || `tg:${from.userId}`);
        logOut(`(telegram message from ${who}) -> ${text}`);

        const isCommand = text.trimStart().startsWith('/') || /^@\S+/.test(text.trimStart());

        if (isCommand && !from.authorized) {
          bridge.send(`${who} (${from.userId}) is not authorized to emit commands or mentions`);
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

        // Replication is unconditional: every Telegram message in the
        // room is part of the room. The legacy `mirror` policy now only
        // controls whether a plain-text Telegram message ALSO triggers
        // a brain call (broadcast to local sessions). skipRoute tells
        // submitInner to post room-utterance and stop, without routing.
        let skipRoute = false;
        if (!isCommand && parseInput(text.trim()).type === 'message') {
          const mirror = cfg.telegram?.mirror ?? 'none';
          const canRoute = mirror === 'all' || (mirror === 'allowed' && from.authorized);
          skipRoute = !canRoute;
        }

        if (submitRef.current) await submitRef.current(text, {
          fromTelegram: true,
          telegramChatId: from.chatId,
          telegramUser: who,
          telegramMessageId: from.tgMessageId ?? null,
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
        setItems(p => [...p, {
          id: Date.now() + Math.random(), author: 'system', _localOnly: true,
          body: `telegram: yielded — another node holds the polling slot. Will auto-resume when they release; /telegram ${BUS_NODE_ID} to force-reclaim.`,
        }]);
      },
      onChatId: async (id) => {
        // First captured chat — persist so future runs know the outbound
        // target without waiting for an inbound. Also update the live
        // ref + bridge.chatId getter so /telegram (no arg) reflects it.
        const cfgPath = join(EGPT_HOME, 'config.json');
        let saved = {};
        try { saved = JSON.parse(await readFile(cfgPath, 'utf8')); } catch {}
        if (!saved.telegram || typeof saved.telegram !== 'object') saved.telegram = {};
        if (saved.telegram.chat_id === id) return;
        saved.telegram.chat_id = id;
        try {
          await mkdir(EGPT_HOME, { recursive: true });
          await writeFile(cfgPath, JSON.stringify(saved, null, 2) + '\n');
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
    setItems(p => [...p, { id: Date.now() + Math.random(), author: 'system', body: 'telegram bridge stopped', _localOnly: true }]);
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
            ts: Date.now(), to: BUS_NODE_ID }).catch(() => {});
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

  // ── WhatsApp bridge (baileys, personal account) ──────────────────────
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
    // Keep the WA bridge's awareness-bypass set aligned with the
    // current joined set. Without this, joining a group with
    // awareness:'mentions' (default) would drop every non-@-tag
    // message at the bridge before the items-mirror got a chance
    // to bridge it to the other joined chats.
    const wa = waBridgeRef.current;
    if (!wa || typeof wa.setBypassChats !== 'function') return;
    wa.setBypassChats(_waJoinedAll().map(e => e.jid));
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
    if (waBridgeRef.current) return true;
    const cfg = EGPT_CONFIG.whatsapp;
    if (!cfg || cfg.enabled === false) return false;
    // Don't auto-pair on first run — would print a QR unprompted.
    // `force` is set by /whatsapp pair to bypass this.
    const credsPath = join(EGPT_HOME, 'wa-auth', 'creds.json');
    if (!force && !existsSync(credsPath)) {
      setItems(p => [...p, {
        id: Date.now() + Math.random(), author: 'system', _localOnly: true,
        body: 'whatsapp configured but not paired. Run /whatsapp pair to scan a QR with your phone.',
      }]);
      return false;
    }
    try {
      const bridge = await startWhatsAppBridge({
        allowedUsers:      cfg.allowed_users ?? [],
        awareness:         cfg.awareness ?? {},
        debug:             cfg.debug === true,
        // Default to the bridge's own default (5) instead of falling
        // through to 0 — '|| 0' was a latent bug that disabled the
        // hold whenever max_backlog_seconds wasn't explicitly
        // configured. cfg-side value still wins when present.
        maxBacklogSeconds: cfg.max_backlog_seconds != null
          ? Number(cfg.max_backlog_seconds)
          : 5,
        // Pass through whatsapp.media to the bridge. Defaults (set
        // inside the bridge) are { download: 'all', max_size_mb: 25 }
        // — every image / video / voice note / document / sticker is
        // saved automatically to ~/.egpt/media/<chat>/<msgId>.<ext>.
        media:             cfg.media ?? {},
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
          } catch (_) {}
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
          const { frames, frameMs: ms, autoDelete, holdMs, presetName, template, mode, joiner } = payload;
          const totalMs = frames.length * ms + (autoDelete ? holdMs : 0);
          const personalizedNote = template ? ' · personalized (waiting for first read)' : '';
          sysOut(`🎬 @movie ${presetName} in "${chatName}"  (${frames.length} fr · ${ms}ms · ~${(totalMs / 1000).toFixed(1)}s${autoDelete ? ' · auto-delete' : ''}${personalizedNote})`);
          try {
            await wa.playFrames({
              chatId, frames, frameMs: ms, autoDelete, holdMs,
              existingKey: triggerKey,
              template, mode, joiner,
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
            // Silently drop. The bridge used to post a 'not authorized'
            // reply back into the originating chat, which leaked the
            // bot's existence to the unauthorized sender (and to
            // everyone else in a group). The arrival note in the
            // shell is enough audit trail for the operator.
            return;
          }
          // Lifecycle commands restricted to 1:1 chats, same as Telegram.
          const LIFECYCLE = new Set(['/rewind', '/upgrade', '/restart', '/exit', '/chrome']);
          const firstTok = text.trimStart().split(/\s+/)[0];
          if (LIFECYCLE.has(firstTok) && from.chatType !== 'private') {
            bridge.send(`${firstTok} only works in a 1:1 chat — DM me and try again`,
              { chatId: from.chatId });
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
          if (submitRef.current) await submitRef.current(text, {
            fromWhatsApp: true,
            waChatId: from.chatId,
            waUser: from.username ? `@${from.username}` : `wa:${from.userId}`,
            waClientLabel,
            waMsgKey: from.msgKey ?? null,
            waMsgRaw: from.msgRaw ?? null,
            observeOnly,
          });
        },
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
          const cfgPath = join(EGPT_HOME, 'config.json');
          let saved = {};
          try { saved = JSON.parse(await readFile(cfgPath, 'utf8')); } catch {}
          if (!saved.whatsapp || typeof saved.whatsapp !== 'object') saved.whatsapp = {};
          if (saved.whatsapp.chat_id === id) return;
          saved.whatsapp.chat_id = id;
          try {
            await mkdir(EGPT_HOME, { recursive: true });
            await writeFile(cfgPath, JSON.stringify(saved, null, 2) + '\n');
            logOut(`whatsapp: outbound chat ${id} captured and saved`);
          } catch (_) {}
        },
      });
      waBridgeRef.current = bridge;
      _globalWaBridge = bridge;
      logOut('whatsapp bridge enabled');
      return true;
    } catch (e) {
      setItems(p => [...p, { id: Date.now() + Math.random(), author: 'system', body: `!! whatsapp: ${e.message}`, _localOnly: true }]);
      return false;
    }
  }, []);

  const stopWaBridge = useCallback(() => {
    if (!waBridgeRef.current) return false;
    waBridgeRef.current.stop();
    waBridgeRef.current = null;
    _globalWaBridge = null;
    setItems(p => [...p, { id: Date.now() + Math.random(), author: 'system', body: 'whatsapp bridge stopped', _localOnly: true }]);
    return true;
  }, []);

  useEffect(() => {
    startWaBridge();
    return () => stopWaBridge();
  }, [startWaBridge, stopWaBridge]);

  // Broadcast our local sessions to the bus on change. Peers use this to
  // know which @<name> they can forward our way. No-op until the bus is joined.
  useEffect(() => {
    const tid = busTargetIdRef.current;
    if (!tid) return;
    bus.postEvent(tid, {
      type: 'sessions-update', from: BUS_NODE_ID, ts: Date.now(),
      sessions: Object.entries(sessions).map(([n, s]) => ({ name: n, brain: s.brain })),
    }).catch(() => {});
  }, [sessions]);

  // Broadcast our polling state on change so /telegram (no arg) on peers
  // can show a fresh picture without round-trips.
  useEffect(() => {
    const tid = busTargetIdRef.current;
    if (!tid) return;
    bus.postEvent(tid, {
      type: 'telegram-status', from: BUS_NODE_ID, ts: Date.now(),
      polling: tgPolling,
    }).catch(() => {});
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
    // Mirror targets — every chat in waJoinedRef gets the item. When
    // none are joined, fall back to the default mirror target
    // (whatsapp.mirror_chat_id, or self-DM). Tagging an item with
    // _sourceChatId means it CAME from a WA chat (Alice in @wa5);
    // we skip sending it BACK to that chat (no self-echo) but DO
    // send it to every OTHER joined chat — that's the cross-chat
    // bridge: @wa5 ↔ @wa6 when both are in /use.
    // Outgoing direction filter: 'in'-only joined chats receive
    // nothing from shell — they're listen-only bindings.
    const joinedTargets = _waJoinedOutgoing().map(e => e.jid);
    const fallbackTarget = (typeof opt === 'string' && opt) ? opt : wa.selfDmJid;
    const targets = joinedTargets.length ? joinedTargets : (fallbackTarget ? [fallbackTarget] : []);
    // Match Telegram's pattern: advance the counter even when target
    // isn't ready yet, so items already on screen don't all flush as
    // a backlog the moment the bridge connects.
    while (sentToWaItemsCountRef.current < items.length) {
      const item = items[sentToWaItemsCountRef.current++];
      if (item._localOnly) continue;
      if (item._directWa) continue;             // already direct-sent (@waN / /join)
      if (item._target && item._target !== 'whatsapp') continue;
      const formatted = formatItemForWhatsApp(item, sessions);
      for (const t of targets) {
        if (item._sourceChatId === t) continue;  // skip echo to origin
        // Items from WA that have no specific origin tag fall back
        // to the old skip rule (don't fan whatsapp-source items into
        // the default self-DM target when no joins are set).
        if (!joinedTargets.length && item._source === 'whatsapp') continue;
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
      })().catch(() => {});
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
      const launcher = await import('./tools/chrome-launcher.mjs');
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
      setItems(p => [...p, {
        id: Date.now() + Math.random(), author: 'system',
        _localOnly: opts._localOnly ?? true, _log: true, body,
      }]);
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
            notice(`found ${matching.length} brain tab(s) but you're in the default lobby. To attach: /room create <name> && /room join <name> && /attach`);
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
      setItems(p => [...p, {
        id: Date.now() + Math.random(), author: 'system',
        body: '(reset by Ctrl+R — any in-flight brain stream is abandoned; the underlying tab/process may still be running)',
      }]);
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
    : join(ROOMS_DIR, `${room}.md`);
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
      try { resetCountersOnDisk(); } catch {}
      try { writeLastLogonNow(); } catch {}
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
      try { await _saveReplyTargets(transcriptFileForRoom(currentRoom), merged); } catch {}
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
    setItems(p => [...p, {
      id: Date.now() + Math.random(), author: 'system', body,
      ...meta,
      // extras lets callers attach _replyTarget (or other item flags)
      // to a system line. Used by the WA media-saved handler so the
      // 'image saved' notice carries the WA reply-target of the
      // originating message — '@wa-<msgId> body' then replies to the
      // photo. Without this, _stableIdForItem falls back to 's-<rnd>'
      // and the system line is unaddressable.
      ...extras,
    }]);
    // Full-clarity logging: every system output (slash command
    // responses, status notes, errors) goes into the room transcript
    // too. Fire-and-forget — queuedAppend serialises so order is
    // preserved without making every sysOut caller async. View
    // commands (/last) set _suppressTranscriptRef to keep their
    // re-rendered noise out of the permanent log.
    if (!_suppressTranscriptRef.current) void append('system', body);
  };

  // logOut is for telemetry/audit lines — bridge connection events,
  // room-state coaching ("the room is empty"), peer announces, debug
  // dumps. They don't belong in the conversation transcript view; the
  // shell hides _log:true items by default and exposes them via /log.
  // sysOut stays for command responses (slash output) which the user
  // explicitly asked for and should see inline.
  const logOut = body =>
    setItems(p => [...p, {
      id: Date.now() + Math.random(), author: 'system', body,
      _localOnly: true, _log: true,
    }]);

  // errOut is for error/failure lines that the operator needs to see
  // RIGHT NOW — bridge sends that failed, brain dispatch errors, any
  // '!!' status that previously got buried in /log. Visible in the
  // shell like sysOut, but local-only (doesn't mirror to bridges and
  // doesn't append to the room md — errors are operational noise, not
  // conversation). _bright marks them for the renderer so they stand
  // out from regular system messages.
  const errOut = body =>
    setItems(p => [...p, {
      id: Date.now() + Math.random(), author: 'system', body,
      _localOnly: true, _bright: true,
    }]);

  async function injectSummary(name, target = null, sessionMap = sessions) {
    const path = summaryPath(name);
    const body = await readFile(path, 'utf8');
    const note = `[injected summary "${name}" from ${path}${target ? ` into ${target}` : ''}]\n\n${body.trim()}`;
    await append('system', note);
    setItems(p => [...p, { id: Date.now() + Math.random(), author: 'system', body: note }]);
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
        hint: (d) => d.type === 'codex' ? 'gpt-4o · o4-mini · gpt-5' : 'leave blank to use ccode default',
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
        waBridgeRef,
        waChannelsCacheRef: _waChannelsCacheRef,
        stormRef:           _stormRef,
        exit,
        exitClean:          _exitClean,
        APP_DIR,
        EGPT_HOME,
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
        computeBrainTurn: async (routedTo, question) => {
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
            try { await bus.postEvent(tid, { type: 'node-offline', from: oldName, ts: Date.now() }); } catch (_) {}
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
            } catch (_) {}
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
  function formatPersonaPrompt(meta, body) {
    const stamp = ts();
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
      } catch (_) {}
      return `[${stamp}, in ${kind} ${where}, ${user} said:]\n${body}`;
    }
    return `[${stamp}, from shell (${USER_NAME}@${SURFACE_TAG}):]\n${body}`;
  }

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
  async function runDefaultBrainTurn(text, onPartial = () => {}) {
    const dbCfg = EGPT_CONFIG.default_brain ?? { type: 'claude-code' };
    const brainType = canonicalBrainName(dbCfg.type ?? 'claude-code');
    const brain = brainForName(brainType);
    if (!brain) return `!! default brain "${brainType}" not found. /config default_brain {"type":"claude-code"}`;

    // URL-based brains (chatgpt-cdp, claude-cdp): the "thread" is the
    // tab's URL. Find an open tab at that URL via CDP; auto-open if
    // none exists. Then stream via brain.stream({...}, _, {targetId}).
    // History (.url) is recorded after each turn so /egpt list/rewind
    // works on URLs the same way it does on session_ids.
    if (isUrlBrain(brainType)) {
      const url = dbCfg.url;
      if (!url) {
        return `!! @e: ${brainType} is configured but no URL is set. Try /egpt brain ${brainType} <url> or use a CDP brain with a thread.`;
      }
      let targetId = null;
      try {
        const tabs = await cdp.listTabs(brain.urlMatch);
        const m = tabs.find(t => t.url === url || t.url.startsWith(url));
        if (m) targetId = m.id;
        else {
          // Open in a detached window so the brain has its own visible
          // space — same pattern as the extension's ensureEThread.
          // openTab returns the CDP target id directly.
          targetId = await cdp.openTab(url);
        }
      } catch (e) {
        return `!! @e: couldn't reach a ${brainType} tab at ${url} (${e.message})`;
      }
      // Bring the brain's Chrome tab to the foreground so the
      // operator can watch the streaming response. CDP + OS-level
      // — see runBrainTurn comment block for the why-two-layers.
      if (targetId) {
        cdp.activateTarget(targetId).catch(() => {});
        _osFocusBrainChrome();
      }
      try {
        const result = await brain.stream(
          { message: text },
          onPartial,
          { targetId },
        );
        const final = typeof result === 'object' ? (result.text ?? '') : (result ?? '');
        // Record the URL in history (no session_id for URL brains).
        // Re-record on every turn so the timestamp stays fresh in
        // /egpt list.
        const next = recordSession(readDefaultBrainState(), url, { type: brainType });
        await persistDefaultBrainState(next);
        return final.trim() || '(no reply)';
      } catch (e) {
        return `!! @e: ${e.message}`;
      }
    }

    // CLI brains (claude-code, codex, ccode): session_id + cwd path.
    const sessionOpts = {
      sessionId: dbCfg.session_id ?? null,
      cwd: dbCfg.cwd ?? process.cwd(),
      sessionName: 'egpt',
      userName: USER_NAME,
      ...(brainType === 'ccode'    ? { allowedTools: dbCfg.allowed_tools ?? 'all' } : {}),
      ...(dbCfg.system_prompt      ? { appendSystemPrompt: dbCfg.system_prompt   } : {}),
    };
    // Identity install for @e — same protocol as runBrainTurn but
    // the persona has its own state in EGPT_CONFIG.default_brain
    // rather than sessions[]. Persisted via default_brain.identity-
    // Injected so restart skips it.
    await _injectIdentityIntoPersona({ brain, sessionOpts, dbCfg });
    try {
      const result = await brain.stream(
        { history: text, message: text },
        onPartial,
        sessionOpts,
      );
      const final = typeof result === 'object' ? (result.text ?? '') : (result ?? '');
      const newSessionId = result?.optionsPatch?.sessionId;
      if (newSessionId) {
        // Record into history (dedupes / refreshes timestamp if the
        // brain returned the same id on a resumed turn). Always persist
        // so the in-disk shape stays current — write is once per @egpt
        // turn, cheap.
        const next = recordSession(readDefaultBrainState(), newSessionId, { type: brainType });
        await persistDefaultBrainState(next);
      }
      return final.trim() || '(no reply)';
    } catch (e) {
      return `!! egpt: ${e.message}`;
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
      type:       cfg.type        ?? 'claude-code',
      session_id: cfg.session_id  ?? null,
      url:        cfg.url         ?? null,
      history:    Array.isArray(cfg.history) ? cfg.history : [],
    };
  }

  // Persist a persona-state.mjs state object back to ~/.egpt/config.json
  // and EGPT_CONFIG.default_brain. Preserves any unrelated fields the
  // user has set on default_brain (allowed_tools, system_prompt, cwd).
  async function persistDefaultBrainState(state) {
    const cfgPath = join(EGPT_HOME, 'config.json');
    let cfg = {};
    try { cfg = JSON.parse(await readFile(cfgPath, 'utf8')); } catch (_) {}
    if (!cfg.default_brain || typeof cfg.default_brain !== 'object') cfg.default_brain = {};
    // Merge in-memory default_brain fields that may not yet be on
    // disk (e.g. identityInjected flag set during the install turn
    // earlier this session). Disk-first, memory-overrides keeps the
    // 'last write wins' shape for fields the user edited externally
    // while still preserving in-session flips.
    cfg.default_brain = { ...cfg.default_brain, ...(EGPT_CONFIG.default_brain ?? {}) };
    cfg.default_brain.type        = state.type;
    cfg.default_brain.session_id  = state.session_id;
    cfg.default_brain.url         = state.url;
    cfg.default_brain.history     = state.history;
    EGPT_CONFIG.default_brain = cfg.default_brain;
    try {
      await mkdir(EGPT_HOME, { recursive: true });
      await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    } catch (e) { sysOut(`!! couldn't persist default_brain: ${e.message}`); }
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
    } catch { return null; }
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
      if (hasThread) return;
    }
    const identity = await _loadIdentity();
    if (!identity) return;
    sysOut(`(installing persona into @e…)`);
    if (sessionOpts.targetId && brain.urlMatch) {
      cdp.activateTarget(sessionOpts.targetId).catch(() => {});
      _osFocusBrainChrome();
    }
    let captured = '';
    try {
      const r = await brain.stream(
        { history: '', message: `... system restarted, new persona installed ...\n\n${identity}` },
        (p) => { captured = p; },
        sessionOpts,
      );
      const final = (typeof r === 'object' ? (r.text ?? captured) : (r ?? captured) ?? '').trim();
      if (final) {
        setItems(p => [...p, {
          id: Date.now() + Math.random(),
          author: `egpt@${SURFACE_TAG}`,
          body: final,
          _localOnly: true,
        }]);
      }
    } catch (e) { sysOut(`!! identity install (@e) failed: ${e.message}`); }
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
      cdp.activateTarget(opts.targetId).catch(() => {});
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
      setItems(p => [...p, {
        id: Date.now() + Math.random(),
        author: routedTo,
        body: trimmed,
        _localOnly: true,
      }]);
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
    const tgChatId = callOpts.tgChatId ?? null;
    const waChatId = callOpts.waChatId ?? null;
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

    // Identity injection (silent setup turn) before the first real
    // user message of this session. Persisted via
    // session.options.identityInjected so a restart doesn't re-fire.
    await _injectIdentityIfNeeded({ routedTo, session, brain, opts });

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
      cdp.activateTarget(opts.targetId).catch(() => {});
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
    const tg = (!fromAnyBridge || tgChatId)
      ? bridgeRef.current?.startStreamMessage?.(`${authorPrefix}\n⌛ thinking…`, { chatId: tgChatId })
      : null;
    // WhatsApp doesn't render HTML — strip tags for the WA stream.
    // Pick the WA stream target:
    //   1. waChatId if the turn came from a WA arrival (route back there)
    //   2. first joined chat (waJoinedRef) — the binding the operator
    //      explicitly set. When multiple are joined we stream to the
    //      first; the others get the final reply via items-mirror
    //      (no per-chat streaming since WA's edit-stream is one
    //      message per chat).
    //   3. undefined → bridge falls back to lastChat (default behaviour)
    // Without (2) a shell-typed @cgpt1 while joined to @wa6 would
    // stream the reply to whatever WA chat was last active in the
    // bridge — typically self-DM — instead of @wa6, defeating /join.
    const waStreamChatId = waChatId ?? _waJoinedFirst()?.jid;
    const waPrefix = `${routedTo}@${SURFACE_TAG}`;
    const wa = (!fromAnyBridge || waChatId)
      ? waBridgeRef.current?.startStreamMessage?.(`${waPrefix}\n⌛ thinking…`,
          waStreamChatId ? { chatId: waStreamChatId } : {})
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
          tg?.update(tgFmt(partial));
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
      if (streamSnapshot && streamSnapshot !== trimmed) {
        setItems(p => [...p, {
          id: Date.now() + Math.random(),
          author: routedTo,
          body: streamSnapshot,
          _thinking: true,
          _localOnly: true,
        }]);
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
        ...(wa
          ? (waStreamChatId
              ? { _sourceChatId: waStreamChatId }
              : { _localOnly: true })
          : {}),
      };
      const isSilence = /^(\.{3,}|…+)$/.test(trimmed);
      if (isSilence) {
        // Quiet ack: render as the session itself with a single em-dash body,
        // both locally and on Telegram.
        await tg?.finish(`${authorPrefix}\n—`);
        await wa?.finish(`${waPrefix}\n—`);
        setItems(p => [...p, {
          id: Date.now() + Math.random(), author: routedTo, body: '—',
          _silent: true,
          ...tagsAlreadySent,
        }]);
        return null;
      }
      // Finalize the streaming bridge messages with the full text.
      const finalTail = final.length > 3900 ? '…' + final.slice(-3900) : final;
      await tg?.finish(`${authorPrefix}\n${mdToTgHtml(finalTail)}`);
      await wa?.finish(`${waPrefix}\n${final}`);
      setItems(p => [...p, {
        id: Date.now() + Math.random(), author: routedTo, body: final,
        ...tagsAlreadySent,
      }]);
      await append(`${routedTo}@${SURFACE_TAG}`, final);
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

    // Wizard mode: /create-profile interactive questions intercept all input.
    if (wizardRef.current) {
      setItems(p => [...p, { id: Date.now() + Math.random(), author: 'You', body: text }]);
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
          setItems(p => [...p, {
            id: Date.now() + Math.random(),
            author: 'You', body: text, _localOnly: true,
          }]);
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
          setItems(p => [...p, {
            id: Date.now() + Math.random(), author: 'You',
            body: text,
            _directWa: !!waTargets.length,
            _localOnly: !waTargets.length && !!tgTargets.length,
            ...(rt ? { _replyTarget: rt } : {}),
          }]);
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
          setItems(p => [...p, {
            id: Date.now() + Math.random(), author: 'You',
            body: text,
          }]);
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
    if (!meta.observeOnly) {
      setItems(p => [...p, {
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
      }]);
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

    // Mirror the utterance to peer surfaces on the bus so the room shows
    // the same conversation regardless of which surface someone is looking
    // at. Pure visibility — peer surfaces render the line and do NOT
    // re-route to their brains (we already drove ours below).
    //
    // Slash commands DON'T ride the bus: they're operator tooling
    // (e.g. /restart, /sessions, /upgrade), channel-specific, and
    // exposing them to bridges would have peers mirror them to
    // telegram / extension where they'd surface as conversational
    // noise. The local _localOnly flag also keeps them out of the
    // local items-mirror, but that doesn't reach peers.
    //
    // observeOnly also skips the bus broadcast — the same logic as the
    // local echo. Other surfaces don't need to see chats the operator
    // isn't actively participating in via egpt.
    {
      const tid = busTargetIdRef.current;
      // Observed chats stay off the bus — only egpt chats and chats the
      // operator has /join'd reach peers. By the time we get here,
      // meta.observeOnly has already been resolved against the /join
      // state in the bridge's onIncoming, so this single gate covers
      // both cases.
      if (tid && !isSlashCommand && !meta.observeOnly) {
        // When the input came from Telegram or WhatsApp, attribute the
        // utterance to the upstream user and tag the surface as
        // 'telegram[chatId]' / 'whatsapp[chatId]' so peers see where it
        // actually originated, not the shell node carrying the bridge.
        const fromTg = !!meta.fromTelegram;
        const fromWa = !!meta.fromWhatsApp;
        const via = fromTg ? `telegram[${meta.telegramChatId ?? '?'}]`
          : fromWa ? `whatsapp[${meta.waChatId ?? '?'}]`
          : null;
        const utteranceUser = fromTg ? (meta.telegramUser ?? USER_NAME)
          : fromWa ? (meta.waUser ?? USER_NAME)
          : USER_NAME;
        // client: which surface this came from — 'tg' / 'wa' /
        // user-renamed (e.g. 'moto'). Peers use this to render
        // 'handle@client[.node]'. null when shell-typed: shell has no
        // client_name by default and the tag stays 'handle@node'.
        const client = fromTg ? tgClient
          : fromWa ? (meta.waClientLabel ?? waClient)
          : null;
        bus.postEvent(tid, {
          type: 'room-utterance', from: BUS_NODE_ID, ts: Date.now(),
          role: 'shell', user: utteranceUser, body: text,
          ...(client ? { client } : {}),
          ...(via ? { via } : {}),
        }).catch(() => {});
      }
    }

    // skipRoute: replication-only mode. Used when a Telegram plain-text
    // message reaches the room but the mirror policy says don't trigger
    // brain calls. The room-utterance is already on the bus; we stop
    // before resolveRoute dispatches anywhere.
    if (meta.skipRoute) return;

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
    const decision = resolveRoute(parsed, text, {
      sessions: sessionsView, peerSessions: peerSessionsView,
      brainForName, canonicalBrainName, activeSessions,
    });

    // Observed chats: egpt only acts on @<persona> wake-words. Any
    // other decision kind (commands, brain turns, peer-mentions, even
    // contextual hints) is suppressed — the user didn't ask egpt to
    // do anything; they're just chatting in a non-egpt chat that
    // egpt happens to listen to. Persona dispatch (above) handles the
    // @egpt case and replies directly to the originating chat.
    if (meta.observeOnly && decision.kind !== 'persona') return;

    if (decision.kind === 'command') {
      const handled = await handleSlash(text, meta);
      if (!handled) sysOut(`!! unknown command: ${decision.cmd}`);
      return;
    }

    // /join @waN binding: every plain shell message goes to the joined
    // chat in addition to whatever local routing decides next. The
    // echo item is tagged _directWa so the wa-items-mirror skips
    // (otherwise this would also land in self-DM). Explicit @waN
    // takes precedence — that handler runs immediately after and
    // returns, so the user can address a different chat ad-hoc
    // without /unjoining first.
    if (_waJoinedSize() > 0 && !meta.fromTelegram && !meta.fromWhatsApp
        && !isAtWaNExplicit) {
      const wa = waBridgeRef.current;
      if (wa) {
        // Fan out the user's plain text to every joined WA chat.
        // 'in'-only joined chats are listen-only — they don't
        // receive shell-typed text; the outgoing filter drops them.
        // Capture each send's returned key so '@m<N>' on the echo
        // item can reply-to-self via a proper WA quote. Sends are
        // awaited in parallel — they don't block each other.
        const settled = await Promise.allSettled(
          _waJoinedOutgoing().map(entry => wa.send(text, { chatId: entry.jid })
            .then(r => ({ entry, result: r }))),
        );
        const replyTargets = [];
        for (const s of settled) {
          if (s.status === 'fulfilled' && s.value?.result?.key) {
            replyTargets.push({
              kind: 'wa',
              chatId: s.value.entry.jid,
              key: s.value.result.key,
              raw: { conversation: text },
            });
          } else if (s.status === 'rejected') {
            sysOut(`!! /use send failed: ${s.reason?.message ?? s.reason}`);
          }
        }
        // Patch the echo item with its reply targets (one per chat
        // we successfully sent to). Single entry → object; multiple
        // → array; @m<N> reply handler accepts both shapes.
        if (replyTargets.length) {
          const rt = replyTargets.length === 1 ? replyTargets[0] : replyTargets;
          setItems(p => p.map(item =>
            item.id === echoItemId ? { ...item, _replyTarget: rt } : item));
          // setItems above changes items.length? no — same length, just
          // a new array. The .length-effect won't refire. Trigger save
          // manually so the new _replyTarget lands in the sidecar.
          _scheduleReplyTargetSave();
        }
      }
    }
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
      // Input was already logged at the top-of-submitInner echo block.
      setBusy(true);
      try {
        const personaPrompt = formatPersonaPrompt(meta, decision.body);

        // Bridge-originated @egpt gets streaming UX: open a stream
        // message with a 'thinking…' placeholder, debounced edits as
        // tokens arrive, typing indicator alongside (WA), final flush
        // on completion. Shell-originated @egpt sees the reply in
        // items at the end (no per-bridge stream — items-mirror
        // already broadcasts cross-surface).
        const tgPrefix = `${EGPT_PERSONA_EMOJI} <b>egpt</b>\n`;
        const waPrefix = `${EGPT_PERSONA_EMOJI} egpt\n`;
        const tgStream = (meta.fromTelegram && bridgeRef.current?.startStreamMessage)
          ? bridgeRef.current.startStreamMessage(`${tgPrefix}⌛ thinking…`,
              { chatId: meta.telegramChatId })
          : null;
        const waStream = (meta.fromWhatsApp && waBridgeRef.current?.startStreamMessage)
          ? waBridgeRef.current.startStreamMessage(`${waPrefix}⌛ thinking…`,
              { chatId: meta.waChatId })
          : null;

        const reply = await runDefaultBrainTurn(personaPrompt, (partial) => {
          if (tgStream) tgStream.update(`${tgPrefix}${mdToTgHtml(partial)}`);
          if (waStream) waStream.update(`${waPrefix}${partial}`);
        });

        // Final delivery: prefer stream.finish() so the placeholder
        // message becomes the final reply (rather than us sending a
        // second message). Fallback to bridge.send() for surfaces
        // that didn't have streamMessage (or weren't engaged).
        if (tgStream) {
          await tgStream.finish(`${tgPrefix}${mdToTgHtml(reply)}`);
        } else if (meta.fromTelegram && bridgeRef.current) {
          bridgeRef.current.send(`${tgPrefix}${mdToTgHtml(reply)}`,
            { chatId: meta.telegramChatId });
        }
        if (waStream) {
          await waStream.finish(`${waPrefix}${reply}`);
          // Defensive: if the streaming path silently failed (initial
          // send rate-limited, WS blipped, edit rejected, etc) the user
          // sees nothing on WA. Fall back to a plain send; if THAT also
          // returns null (bridge.send swallows errors and returns null
          // on failure), surface to the operator's shell so the human
          // knows their reply didn't reach the chat. Without this both
          // failure paths log to /log only — invisible by default.
          if (!waStream.delivered && meta.fromWhatsApp && waBridgeRef.current) {
            const r = await waBridgeRef.current.send(
              `${EGPT_PERSONA_EMOJI} egpt: ${reply}`,
              { chatId: meta.waChatId },
            );
            if (!r) {
              const errSuffix = waStream.lastError ? `  (stream: ${waStream.lastError})` : '';
              // errOut, not sysOut: WA is what's failing — routing the
              // error back through the same broken bridge would just
              // generate a second silent failure. Keep it shell-local.
              errOut(`!! @e: WA reply did NOT deliver to ${meta.waChatId}${errSuffix}\nreply was: ${reply.length > 200 ? reply.slice(0, 199) + '…' : reply}`);
            }
          }
        } else if (meta.fromWhatsApp && waBridgeRef.current) {
          const r = await waBridgeRef.current.send(
            `${EGPT_PERSONA_EMOJI} egpt: ${reply}`,
            { chatId: meta.waChatId },
          );
          if (!r) {
            errOut(`!! @e: WA reply did NOT deliver to ${meta.waChatId}\nreply was: ${reply.length > 200 ? reply.slice(0, 199) + '…' : reply}`);
          }
        }

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
          setItems(p => [...p, {
            id: Date.now() + Math.random(),
            author: replyAuthor,
            body: reply,
            ...(replySource ? { _source: replySource } : {}),
            ...(meta.fromWhatsApp && meta.waChatId
              ? { _sourceChatId: meta.waChatId } : {}),
          }]);
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
            }).catch(() => {});
          }
        }
      } finally {
        setBusy(false);
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
    const tgChatId = meta.fromTelegram ? meta.telegramChatId ?? null : null;
    const waChatId = meta.fromWhatsApp ? meta.waChatId ?? null : null;
    const replies = [];
    for (const recipient of recipients) {
      const reply = await runBrainTurn(recipient, messageForBrains, effectiveSessions, { tgChatId, waChatId });
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
          }).catch(() => {});
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
  handleBusEventRef.current = async (ev) => {
    if (ev.from === BUS_NODE_ID) return; // ignore self-echoes

    const log = (msg) => setItems(p => [...p, {
      id: Date.now() + Math.random(), author: 'system', _localOnly: true, body: msg,
    }]);
    const post = async (event) => {
      const tid = busTargetIdRef.current;
      if (!tid) return;
      try { await bus.postEvent(tid, { ts: Date.now(), from: BUS_NODE_ID, ...event }); } catch {}
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
          setItems(p => [...p, {
            id: Date.now() + Math.random(), author, body: ev.body ?? '(empty)',
            _node: ev.from, _localOnly: tgRouted,
          }]);
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
        // stripped by the originator.
        if (ev.to_node && ev.to_node !== BUS_NODE_ID) return;
        const wa = waBridgeRef.current;
        if (!wa) { log(`bus: wa-send from ${ev.from} dropped — no baileys bridge here`); return; }
        if (!ev.jid || !ev.body) { log(`bus: wa-send from ${ev.from} dropped — missing jid/body`); return; }
        try {
          wa.send(ev.body, { chatId: ev.jid });
          log(`bus: wa-send → ${ev.jid} for ${ev.from} (${(ev.body || '').slice(0, 40)}${ev.body.length > 40 ? '…' : ''})`);
        } catch (e) {
          log(`!! wa-send failed: ${e.message}`);
        }
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
        setItems(p => [...p, {
          id: Date.now() + Math.random(), author: tag, body,
          ...(isPeerSlashCommand ? { _localOnly: true } : {}),
          ...(sourceFromVia ? { _source: sourceFromVia } : {}),
        }]);
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
        setItems(p => [...p, {
          id: Date.now() + Math.random(), author: tag, body: ev.body ?? '',
          ...(sourceFromVia ? { _source: sourceFromVia } : {}),
        }]);
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
  // Let baileys' WebSocket close handshake reach WA's server before
  // process.exit. Without this, the close packet may not have left
  // the kernel buffer when the process dies — WA's server still
  // thinks we're connected, and the NEXT shell's authenticate trips
  // 'connectionReplaced' (reason 440), looping until the stale entry
  // times out server-side (~minutes). 800ms is empirically enough on
  // a reachable network; if the WS was already dead it's just dead
  // wait. process.on('exit') below catches synchronous-exit paths
  // (uncaught throws, etc.) where we can't await.
  try { await new Promise(r => setTimeout(r, 800)); } catch (_) {}
  if (!HEADLESS) writeLastLogonNow();
  clearPidfile();
  process.exit(code);
};
process.on('SIGINT',  () => { _exitClean(0); });
process.on('SIGHUP',  () => { _exitClean(0); });
process.on('SIGTERM', () => { _exitClean(0); });

// Pidfile handshake: if an older instance is running (most commonly the
// headless engine from Task Scheduler / systemd / launchd), ask it to
// exit, wait for it to release the WA pairing, then take ownership.
// Same code path for interactive AND headless mode — both honor the
// single-writer invariant. Symmetric: a headless process started while
// an interactive shell is up will also take over (rare but valid).
await takeoverIfRunning();
writePidfile();

// "while you were away" summary moved into the App mount effect (see
// _welcomeBackEffect below). The previous pre-mount console.log path
// couldn't register reply-target ids in the sidecar (the sidecar
// lives inside App state), so /recap-style reply-by-id only worked
// after the operator ran /recap manually. By dispatching the welcome-
// back from inside the App we get reply-able rows on the very first
// frame, and Ink owns the screen end-to-end.

if (HEADLESS) {
  // Ink wants tty-like stdin/stdout. Stub both so the render call
  // doesn't crash on setRawMode() / cursor positioning. ANSI escapes
  // end up in headless.log — ugly but harmless; the canonical record
  // is the room .md, chats-cache.json, and .media-index.json files
  // the bridges write directly. This log is just post-mortem.
  const stdoutLog = createWriteStream(EGPT_HEADLESS_LOG, { flags: 'a' });
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
  console.log(`egpt | ${FILE}`);
  console.log('Enter=newline · Ctrl+D=send · Ctrl+C=exit · /help for commands\n');
  render(h(App), { exitOnCtrlC: false });
}
process.on('exit', () => { _globalBridge?.stop(); _globalWaBridge?.stop(); clearPidfile(); });
