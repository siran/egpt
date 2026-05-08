#!/usr/bin/env node
// egpt.mjs — file IS the conversation; Ink shell; sessions = named participants
import React from 'react';
import { render, Box, Text, Static, useInput, useApp } from 'ink';
import YAML from 'yaml';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { readFile, writeFile, appendFile, readdir, stat, open, mkdir, unlink, rm, rename } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

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
import { parseInput, helpText, helpHtml } from './interpreter.mjs';
import { resolveRoute, planMirrors } from './room.mjs';
import { CONFIG_SCHEMA } from './config-schema.mjs';

const { createElement: h, useState, useEffect, useRef, useCallback, Fragment } = React;
const APP_DIR = dirname(fileURLToPath(import.meta.url));
const EGPT_HOME = join(homedir(), '.egpt');

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

const cliArgs = process.argv.slice(2);
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
const append = (who, body) => appendFile(FILE, `## ${ts()} — ${who}\n${body}\n\n`);
const fmtTs = (ms) => _stamp(new Date(ms));

// ── Room persistence ───────────────────────────────────────────────────────
// One YAML file per room at ~/.egpt/rooms/<name>.yaml. Default room is
// the lobby — never persisted, never has brains.

const ROOMS_DIR = join(EGPT_HOME, 'rooms');

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
      out[name] = parsed.sessions ?? {};
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

// User name as it appears to brains (in [An]: prefixes when broadcasting/mirroring).
// Override with EGPT_USER_NAME if you're not An.
const USER_NAME = process.env.EGPT_USER_NAME ?? 'An';
const USER_EMOJI = '👤';
const EGPT_EMOJI = '🧠';

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
  const sess = sessions[item.author];
  const emoji = sess?.emoji ?? '❓';
  return `${emoji} <b>${escapeHtml(tagged)}</b>\n${mdToTgHtml(item.body)}`;
}

// Same shape, plain text. WhatsApp bodies don't support HTML so we
// just emit author + content separated by a newline.
function formatItemForWhatsApp(item, sessions) {
  if (item.author === 'system') return `${EGPT_EMOJI} egpt@${SURFACE_TAG}\n${item.body}`;
  if (item.author === 'You')    return `${USER_EMOJI} ${USER_NAME}@${SURFACE_TAG}\n${item.body}`;
  const tagged = item.author.includes('@') ? item.author : `${item.author}@${SURFACE_TAG}`;
  const sess = sessions[item.author];
  const emoji = sess?.emoji ?? '❓';
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

// --- multi-line input ---
function MultiLineInput({ onSubmit }) {
  const [lines, setLines] = useState(['']);
  const [r, setR] = useState(0);
  const [c, setC] = useState(0);
  // input history: list of submitted entries; hIdx counts from 0=now, +N=N steps back
  const [history, setHistory] = useState([]);
  const [hIdx, setHIdx] = useState(0);

  const loadEntry = (text) => {
    const lns = text.split('\n');
    setLines(lns);
    setR(lns.length - 1);
    setC(lns[lns.length - 1].length);
  };

  const recall = (delta) => {
    const newIdx = hIdx + delta;
    if (newIdx < 0 || newIdx > history.length) return;
    setHIdx(newIdx);
    if (newIdx === 0) { setLines(['']); setR(0); setC(0); }
    else loadEntry(history[history.length - newIdx]);
  };

  useInput((input, key) => {
    if (key.ctrl && input === 'd') {
      const text = lines.join('\n');
      if (text.trim()) setHistory(h => [...h, text]);
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
    // Literal Home/End keys arrive as escape sequences on most terminals
    // (xterm, Windows Terminal, mintty). Ink doesn't expose them as a key
    // flag, so match the raw bytes. Same for Ctrl+Home / Ctrl+End to jump
    // to start / end of the whole multi-line input.
    if (input === '\x1b[H' || input === '\x1b[1~' || input === '\x1b[7~') { setC(0); return; }
    if (input === '\x1b[F' || input === '\x1b[4~' || input === '\x1b[8~') { setC(lines[r].length); return; }
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

// --- main app ---
function App() {
  const [items, setItems] = useState([]);
  const [streaming, setStreaming] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
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
      chatId:       cfg.telegram.chat_id ?? null,
      onIncoming: async (text, from) => {
        const who = from.username ? `@${from.username}` : (from.firstName || `tg:${from.userId}`);
        setItems(p => [...p, {
          id: Date.now() + Math.random(), author: 'system',
          body: `(telegram message from ${who}) -> ${text}`,
          _localOnly: true,
        }]);

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
          skipRoute,
        });
      },
      onLog:   (msg) => setItems(p => [...p, { id: Date.now() + Math.random(), author: 'system', body: `telegram: ${msg}`, _localOnly: true }]),
      onError: (msg) => setItems(p => [...p, { id: Date.now() + Math.random(), author: 'system', body: `!! telegram: ${msg}`, _localOnly: true }]),
      onYield: () => {
        // 409 from Telegram means another node holds the polling slot.
        // Drop our bridge state so we stop showing as 'polling' on the
        // bus; an auto-claim will fire on the next peer release event.
        bridgeRef.current = null;
        _globalBridge = null;
        setTgPolling(false);
        setItems(p => [...p, {
          id: Date.now() + Math.random(), author: 'system', _localOnly: true,
          body: 'telegram: yielded — another node holds the polling slot. Will auto-resume when they release; /telegram <self> to force-reclaim.',
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
          setItems(p => [...p, {
            id: Date.now() + Math.random(), author: 'system', _localOnly: true,
            body: `telegram: outbound chat ${id} captured and saved`,
          }]);
        } catch (e) {
          setItems(p => [...p, {
            id: Date.now() + Math.random(), author: 'system', _localOnly: true,
            body: `!! telegram: could not persist chat_id (${e.message})`,
          }]);
        }
      },
    });
    bridgeRef.current = bridge;
    _globalBridge = bridge;
    setTgPolling(true);
    setItems(p => [...p, { id: Date.now() + Math.random(), author: 'system', body: 'telegram bridge enabled', _localOnly: true }]);
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
  // for any peer announcing `polling: true`. If found, defer.
  // If clear, start. After this single attempt, the boot effect is
  // done — all further claim/yield decisions ride the existing
  // bus-event handlers (`node-offline` / `telegram-status` with
  // polling=false → auto-claim with jitter; 409 from Bot API →
  // onYield clears bridgeRef and stays yielded).
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
      for (const [, peer] of peerNodesRef.current) {
        if (peer.polling) return; // they own it; wait for yield event
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
  const waBridgeRef = useRef(null);
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
        allowedUsers: cfg.allowed_users ?? [],
        awareness:    cfg.awareness ?? {},
        debug:        cfg.debug === true,
        onIncoming: async (text, from) => {
          const who = from.username ? `${from.username} (wa:${from.userId})` : `wa:${from.userId}`;
          setItems(p => [...p, {
            id: Date.now() + Math.random(), author: 'system', _localOnly: true,
            body: `(whatsapp message from ${who}) -> ${text}`,
          }]);
          const isCommand = text.trimStart().startsWith('/') || /^@\S+/.test(text.trimStart());
          if (isCommand && !from.authorized) {
            bridge.send(`${who} is not authorized to emit commands or mentions`,
              { chatId: from.chatId });
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
          if (submitRef.current) await submitRef.current(text, {
            fromWhatsApp: true,
            waChatId: from.chatId,
            waUser: from.username ? `@${from.username}` : `wa:${from.userId}`,
          });
        },
        onLog:   (msg) => setItems(p => [...p, { id: Date.now() + Math.random(), author: 'system', body: `whatsapp: ${msg}`, _localOnly: true }]),
        onError: (msg) => setItems(p => [...p, { id: Date.now() + Math.random(), author: 'system', body: `!! whatsapp: ${msg}`, _localOnly: true }]),
        onChatId: async (id) => {
          // First captured chat — persist to ~/.egpt/config.json so future
          // runs default outbound to that JID.
          const cfgPath = join(EGPT_HOME, 'config.json');
          let saved = {};
          try { saved = JSON.parse(await readFile(cfgPath, 'utf8')); } catch {}
          if (!saved.whatsapp || typeof saved.whatsapp !== 'object') saved.whatsapp = {};
          if (saved.whatsapp.chat_id === id) return;
          saved.whatsapp.chat_id = id;
          try {
            await mkdir(EGPT_HOME, { recursive: true });
            await writeFile(cfgPath, JSON.stringify(saved, null, 2) + '\n');
            setItems(p => [...p, {
              id: Date.now() + Math.random(), author: 'system', _localOnly: true,
              body: `whatsapp: outbound chat ${id} captured and saved`,
            }]);
          } catch (_) {}
        },
      });
      waBridgeRef.current = bridge;
      setItems(p => [...p, { id: Date.now() + Math.random(), author: 'system', body: 'whatsapp bridge enabled', _localOnly: true }]);
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
  useEffect(() => {
    const b = bridgeRef.current;
    if (!b) return;
    while (sentItemsCountRef.current < items.length) {
      const item = items[sentItemsCountRef.current++];
      if (item._localOnly) continue;
      b.send(formatItemForTelegram(item, sessions));
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
    const target = (typeof opt === 'string' && opt) ? opt : wa.selfDmJid;
    // Match Telegram's pattern: advance the counter even when target
    // isn't ready yet, so items already on screen don't all flush as
    // a backlog the moment the bridge connects.
    while (sentToWaItemsCountRef.current < items.length) {
      const item = items[sentToWaItemsCountRef.current++];
      if (item._localOnly) continue;
      if (target) wa.send(formatItemForWhatsApp(item, sessions), { chatId: target });
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
        sysOut(`loaded ${names.length} room(s) from disk: ${names.join(', ')}`);
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
      await launcher.spawnChrome({
        port: 9221,
        userDataDir: brainProfile,
        extensionDir: extDist,
      });
      await launcher.waitForChromeReady(9221);
      sysOut('Chrome ready — proxy will auto-attach within 5s');
      return true;
    } catch (e) {
      sysOut(`!! could not start Chrome: ${e.message}`);
      return false;
    }
  };

  useEffect(() => {
    let proxyHandle = null;
    let cancelled = false;
    let pollHandle = null;
    let lastNoticeBody = null;

    const notice = (body, opts = {}) => {
      // Avoid spamming the transcript when the polling loop reports the
      // same state repeatedly; only append a system row when the message
      // text changes.
      if (body === lastNoticeBody) return;
      lastNoticeBody = body;
      setItems(p => [...p, {
        id: Date.now() + Math.random(), author: 'system',
        _localOnly: opts._localOnly ?? true, body,
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

      // 1. Ensure Chrome is reachable, either via the proxy (:9222) or
      //    directly (:9221). If neither is up, surface a hint once and
      //    keep polling — when Chrome appears we'll attach.
      if (!(await cdp.isRunning())) {
        let chromeUp = false;
        try { await fetch('http://localhost:9221/json/version'); chromeUp = true; }
        catch { /* not yet */ }

        if (!chromeUp) {
          notice('Chrome not running — type /chrome to launch it with the extension, or start it yourself with --remote-debugging-port=9221');
          return;
        }

        try {
          const { startCdpProxy } = await import('./tools/cdp-proxy.mjs');
          proxyHandle = await startCdpProxy({ onLog: () => {} });
          notice('CDP proxy auto-started (:9221 → :9222)');
        } catch (e) {
          notice(`CDP proxy failed to start: ${e.message}`);
          return;
        }
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
          setItems(p => [...p, {
            id: Date.now() + Math.random(), author: 'system', _localOnly: true,
            body: `auto-attached ${Object.keys(additions).length} tab(s): ${summary}`,
          }]);
        }
        }
      } catch { /* proxy up but listTabs failed — try again next tick */ }

      // 3. Bus tab: open or find the shared control-plane tab and subscribe.
      //    Cross-process events (extension <-> shell) ride this.
      try {
        if (cancelled) return;
        const located = await bus.findOrOpenBusTab();
        if (!located) return;
        busTargetIdRef.current = located.targetId;
        const sub = await bus.subscribeBusEvents(located.targetId, (ev) => {
          if (cancelled) return;
          handleBusEventRef.current?.(ev);
        });
        busSubRef.current = sub;
        await bus.postEvent(located.targetId, {
          type: 'node-online', from: BUS_NODE_ID, ts: Date.now(), role: 'shell',
          sessions: Object.entries(sessionsLatestRef.current).map(([n, s]) => ({ name: n, brain: s.brain })),
          polling: tgPolling,
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
      // Best-effort node-offline announce, then stop subscription + proxy.
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
        proxyHandle?.stop();
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

  const sysOut = body =>
    setItems(p => [...p, {
      id: Date.now() + Math.random(), author: 'system', body,
      _localOnly: outputSinkRef.current === 'local',
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

  const handleSlash = async (text) => {
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(' ').trim();

    if (cmd === '/exit') { exit(); return true; }
    if (cmd === '/version') {
      // Snapshot current git state so the user can see what's running
      // before /upgrade or /rewind.
      const sha    = spawnSync('git', ['rev-parse', '--short', 'HEAD'],     { cwd: APP_DIR, stdio: 'pipe' });
      const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: APP_DIR, stdio: 'pipe' });
      const tag    = spawnSync('git', ['describe', '--tags', '--abbrev=0'], { cwd: APP_DIR, stdio: 'pipe' });
      const dirty  = spawnSync('git', ['status', '--porcelain'],            { cwd: APP_DIR, stdio: 'pipe' });
      const recent = spawnSync('git', ['tag', '--sort=-creatordate'],       { cwd: APP_DIR, stdio: 'pipe' });
      const get = (r) => (r.stdout?.toString() ?? '').trim();
      const dirtyText = get(dirty) ? '  (working tree dirty)' : '';
      const tagList = get(recent).split('\n').slice(0, 5).filter(Boolean).join(', ');
      sysOut(
        `commit: ${get(sha) || '???'}${dirtyText}\n` +
        `branch: ${get(branch) || '???'}\n` +
        `last tag: ${get(tag) || '(none)'}\n` +
        `recent tags: ${tagList || '(none)'}`,
      );
      return true;
    }
    if (cmd === '/use') {
      const target = arg.trim();
      if (!target) {
        sysOut(activeSessions.length
          ? `active sessions: ${activeSessions.join(', ')} (plain text routes here without @-mention)`
          : 'no active sessions — plain text stays in the room. /use <name> to designate one, /use a,b,c for multi-AI broadcast.');
        return true;
      }
      if (target === 'clear' || target === 'none') {
        setActiveSessions([]);
        sysOut('active sessions cleared — plain text no longer auto-routes');
        return true;
      }
      // Comma-separated list = multi-active. Single name = switch to it.
      const names = target.split(',').map(s => s.trim()).filter(Boolean);
      const unknown = names.filter(n => !sessions[n]);
      if (unknown.length) {
        sysOut(`!! unknown session(s): ${unknown.join(', ')} — /sessions to list`);
        return true;
      }
      setActiveSessions(names);
      sysOut(names.length === 1
        ? `active session -> ${names[0]} (plain text routes here without @-mention)`
        : `active sessions -> ${names.join(', ')} (plain text broadcasts to all without @-mention)`);
      return true;
    }
    if (cmd === '/room') {
      const argParts = arg.split(/\s+/).filter(Boolean);
      const sub = argParts[0];
      const target = argParts[1];

      const fmtRoom = (name) => {
        const sess = roomSessionsMap[name];
        if (sess === undefined) {
          return `room "${name}" doesn't exist — /room create ${name} to make it`;
        }
        const here = name === currentRoom ? '  (current)' : '';
        const memberCount = Object.keys(sess).length;
        const list = memberCount === 0
          ? '(no members)'
          : Object.entries(sess).map(([n, s]) => `${s.emoji ?? ''}${n} (${s.brain})`).join(', ');
        return `room "${name}"${here}\n  members: ${list}`;
      };

      // No arg: show current room.
      if (!sub) {
        const all = Object.keys(roomSessionsMap).filter(r => r !== currentRoom);
        const others = all.length ? `\n  other rooms: ${all.join(', ')}` : '';
        sysOut(fmtRoom(currentRoom) + others);
        return true;
      }
      if (sub === 'create') {
        if (!target) { sysOut('usage: /room create <name>'); return true; }
        if (roomSessionsMap[target]) { sysOut(`!! room "${target}" already exists`); return true; }
        setRoomSessionsMap(rs => ({ ...rs, [target]: {} }));
        sysOut(`room "${target}" created — /room join ${target} to enter`);
        return true;
      }
      if (sub === 'join') {
        if (!target) { sysOut('usage: /room join <name>'); return true; }
        if (!roomSessionsMap[target]) {
          sysOut(`!! room "${target}" doesn't exist — /room create ${target}`);
          return true;
        }
        if (target === currentRoom) { sysOut(`already in "${target}"`); return true; }
        setCurrentRoom(target);
        setActiveSessions([]);   // /use is per-room
        sysOut(`joined room "${target}"`);
        return true;
      }
      if (sub === 'leave') {
        if (currentRoom === 'default') { sysOut('already in default room'); return true; }
        const left = currentRoom;
        setCurrentRoom('default');
        setActiveSessions([]);
        sysOut(`left "${left}" — back in default room`);
        return true;
      }
      if (sub === 'delete') {
        if (!target) { sysOut('usage: /room delete <name>'); return true; }
        if (target === 'default') { sysOut('!! cannot delete default room'); return true; }
        if (!roomSessionsMap[target]) { sysOut(`!! room "${target}" doesn't exist`); return true; }
        if (currentRoom === target) { setCurrentRoom('default'); setActiveSession(null); }
        setRoomSessionsMap(rs => {
          const next = { ...rs };
          delete next[target];
          return next;
        });
        sysOut(`room "${target}" deleted`);
        return true;
      }
      // /room <name>: show info on that room.
      sysOut(fmtRoom(sub));
      return true;
    }
    if (cmd === '/restart') {
      // Exit with code 43 so egpt-daemon respawns the shell without
      // running git pull / npm install / build. NOTE: this still picks
      // up any code changes already on disk — implicit upgrade if you
      // git-pulled externally. /upgrade is the explicit pull-then-restart;
      // /restart is "respawn from current disk state".
      sysOut('exiting with code 43 — egpt-daemon (if running) will respawn the shell');
      setTimeout(() => _exitClean(43), 100);
      return true;
    }
    if (cmd === '/rewind') {
      // /rewind <ref> — checkout a previous git ref (commit, tag, branch),
      // then npm install + build:ext, then restart. For dropping back to
      // a known-good version when an upgrade brought in a regression.
      const ref = arg.trim();
      if (!ref) {
        const tags = spawnSync('git', ['tag', '--sort=-creatordate'], { cwd: APP_DIR });
        const tagList = (tags.stdout?.toString() ?? '').trim().split('\n').slice(0, 10).join(', ');
        sysOut(`usage: /rewind <ref>     (commit SHA, tag, branch, or HEAD~N)\nrecent tags: ${tagList || '(none)'}`);
        return true;
      }
      const verify = spawnSync('git', ['rev-parse', '--verify', ref], { cwd: APP_DIR });
      if (verify.status !== 0) {
        sysOut(`!! unknown git ref "${ref}" — /rewind with no arg lists tags`);
        return true;
      }
      try {
        await mkdir(EGPT_HOME, { recursive: true });
        await writeFile(join(EGPT_HOME, 'rewind-target.txt'), ref);
      } catch (e) {
        sysOut(`!! could not write rewind sidecar: ${e.message}`);
        return true;
      }
      sysOut(`exiting with code 44 — egpt-daemon (if running) will checkout ${ref}, install, build, restart`);
      setTimeout(() => _exitClean(44), 100);
      return true;
    }
    if (cmd === '/upgrade') {
      // Exit with 42 so a wrapping egpt-daemon (egpt-daemon.mjs) runs
      // git pull + npm install + npm run build:ext and restarts. If
      // the daemon isn't running, this just exits with 42 and the
      // user restarts manually.
      sysOut('exiting with code 42 — egpt-daemon (if running) will pull, rebuild, and restart');
      setTimeout(() => _exitClean(42), 100);
      return true;
    }
    if (cmd === '/file') { sysOut(FILE); return true; }
    if (cmd === '/conversations') {
      try {
        const files = await listConversationFiles();
        if (!files.length) {
          sysOut(`(no conversation files found)\n  search dirs:\n    ${CONVERSATION_DIRS.map(dp).join('\n    ')}\n    ${dp(resolve(process.cwd(), 'conversation.md'))}`);
          return true;
        }
        const rows = await Promise.all(files.map(async (f) => {
          let mtime = 0, size = 0;
          try { const st = await stat(f.path); mtime = st.mtimeMs; size = st.size; } catch {}
          const active = f.path === resolve(FILE) ? ' ← active' : '';
          const fmtSize = size < 1024 ? `${size}B` : `${(size / 1024).toFixed(1)}K`;
          return { ...f, mtime, size, fmtSize, active };
        }));
        rows.sort((a, b) => b.mtime - a.mtime);
        const lines = rows.map(r => {
          const name = basename(r.path).replace(/\.md$/, '');
          return `${name.padEnd(28)} ${r.fmtSize.padEnd(7)} ${r.label.padEnd(18)} ${dp(r.path)}${r.active}`;
        });
        sysOut(`conversations:\n${lines.join('\n')}\n\n/conversation <name>  to switch`);
      } catch (e) { sysOut(`!! ${e.message}`); }
      return true;
    }
    if (cmd === '/conversation') {
      const spec = arg.trim();
      if (!spec) {
        sysOut(`current: ${dp(FILE)}\n  /conversations          list available\n  /conversation <name>    switch to <name> (creates if missing)`);
        return true;
      }
      let nextPath;
      try { nextPath = resolveConversationSpec(spec); }
      catch (e) { sysOut(`!! ${e.message}`); return true; }
      if (!nextPath) { sysOut('!! could not resolve conversation path'); return true; }
      try {
        await mkdir(dirname(nextPath), { recursive: true });
        if (!existsSync(nextPath)) writeFileSync(nextPath, `# Conversation\n\n---\n\n`);
        FILE = nextPath;
        // Clear the displayed transcript so the user sees the new room fresh.
        // Sessions are kept — the user may want to reuse attached brains.
        setItems([{
          id: Date.now() + Math.random(), author: 'system',
          body: `switched conversation -> ${dp(FILE)}`,
        }]);
        sentItemsCountRef.current = 0;
      } catch (e) { sysOut(`!! /conversation: ${e.message}`); }
      return true;
    }
    if (cmd === '/help') {
      const bt = brainNamesForHelp();
      // /help @<who> — deliver the help text to that recipient by
      // prepending an @-mention to the body. @<who> in Telegram becomes
      // a clickable mention (notifies the user). On WhatsApp it shows
      // as plain text @-mention; native notification would require
      // mentionedJid wiring (future).
      const recipient = arg.trim().match(/^@(\S+)$/)?.[1] ?? null;
      const prefix = recipient ? `(for @${recipient})\n\n` : '';
      const tgPrefix = recipient ? `<i>(for @${escapeHtml(recipient)})</i>\n\n` : '';
      // Respect outputSinkRef like sysOut does: local-issued /help stays
      // in shell; Telegram-issued /help (sink === 'remote') goes back to
      // Telegram. Avoids dumping the help blob into the chat unprompted.
      setItems(p => [...p, { id: Date.now() + Math.random(), author: 'system', _bright: true,
        body: prefix + helpText(bt),
        _tgBody: tgPrefix + helpHtml(bt),
        _localOnly: outputSinkRef.current === 'local',
      }]);
      return true;
    }
    if (cmd === '/status') {
      let tabsByid = new Map();
      try {
        const tabs = await cdp.listTabs();
        for (const t of tabs) tabsByid.set(t.id, t);
      } catch {}
      const lines = [
        '── STATUS ───────────────────────────────────────────',
        `file:  ${dp(FILE)}`,
        '',
        '── INTERFACES ───────────────────────────────────────',
        '  console     active',
      ];
      const tgBridge = bridgeRef.current;
      if (tgBridge) {
        const chatInfo = tgBridge.chatId ? `connected · chat ${tgBridge.chatId}` : 'connected (no incoming messages yet)';
        lines.push(`  telegram    ${chatInfo}`);
      } else {
        lines.push(`  telegram    not configured`);
      }
      lines.push(`  extension   — coming soon`);
      lines.push('', '── PARTICIPANTS ─────────────────────────────────────');
      const tgSuffix = tgBridge ? ' · telegram' : '';
      lines.push(`  👤 You         human    console${tgSuffix}`);
      if (!Object.keys(sessions).length) {
        lines.push('  (no AI sessions — use /attach or /open)');
      } else {
        for (const [name, s] of Object.entries(sessions)) {
          const emoji = (s.emoji ?? '?') + ' ';
          const brain = s.brain;
          const opts = s.options ?? {};
          let typeLine = '';
          let locLine = '';
          if (brain === 'chatgpt-cdp' || brain === 'claude-cdp') {
            const tab = opts.targetId ? tabsByid.get(opts.targetId) : null;
            const label = brain === 'chatgpt-cdp' ? 'ChatGPT (web)' : 'Claude (web)';
            typeLine = label;
            locLine = tab
              ? `tab: "${(tab.title ?? '').slice(0, 40)}"  ${tab.url.slice(0, 60)}`
              : opts.targetId ? `tab: ${opts.targetId.slice(0, 8)}… (not found in Chrome)` : 'no tab bound';
          } else if (brain === 'ccode') {
            typeLine = `Claude Code · model: ${opts.model ?? 'default'}`;
            if (opts.sessionId) typeLine += `  resume: ${opts.sessionId.slice(0, 8)}…`;
            locLine = `cwd: ${opts.cwd ? dp(opts.cwd) : '(egpt dir)'}`;
          } else if (brain === 'codex') {
            typeLine = `Codex · model: ${opts.model ?? 'gpt-4o'} · effort: ${opts.reasoningEffort ?? 'medium'}`;
            if (opts.thread) typeLine += `  thread: ${opts.thread}`;
            if (opts.sessionId) typeLine += `  thread: ${opts.sessionId.slice(0, 8)}…`;
            locLine = `cwd: ${opts.cwd ? dp(opts.cwd) : '(egpt dir)'}`;
          } else {
            typeLine = brain;
          }
          lines.push(`  ${emoji}${name.padEnd(10)} ${typeLine}`);
          if (locLine) lines.push(`               ${locLine}`);
          if (s.bio) lines.push(`               bio: ${s.bio.slice(0, 70)}${s.bio.length > 70 ? '…' : ''}`);
        }
      }
      lines.push('─────────────────────────────────────────────────────');
      sysOut(lines.join('\n'));
      return true;
    }
    if (cmd === '/prompts') {
      if (arg === 'on')  { _showPrompts = true;  sysOut('prompt display on — full task text shown before each operator turn'); return true; }
      if (arg === 'off') { _showPrompts = false; sysOut('prompt display off'); return true; }
      // No arg: show templates
      const knownCmds = ['browse', 'send-file', 'summarize', 'inject', 'codex-task'];
      const parts = [`prompt display is ${_showPrompts ? 'ON' : 'OFF'}  (/prompts on|off to toggle)\n`];
      for (const c of knownCmds) {
        const tpl = await loadTemplate(c);
        if (tpl) {
          parts.push(`── /${c} ── (${dp(tpl.path)})`);
          parts.push(tpl.body.length > 1200 ? tpl.body.slice(0, 1200) + '\n...[truncated]' : tpl.body);
          parts.push('');
        } else {
          parts.push(`── /${c} ── (no template file found)`);
          parts.push('');
        }
      }
      sysOut(parts.join('\n'));
      return true;
    }
    if (cmd === '/themes') {
      const names = await listThemes();
      const lines = names.map(n => n === _currentTheme ? `/theme ${n} ← active` : `/theme ${n}`);
      sysOut(`themes:\n${lines.join('\n')}`);
      return true;
    }
    if (cmd === '/theme') {
      const name = arg.trim();
      if (!name) {
        sysOut(`active theme: ${_currentTheme}  (use /themes to list, next/prev to rotate)`);
        return true;
      }
      const names = await listThemes();
      let target = name;
      if (name === 'next' || name === 'prev') {
        const idx = names.indexOf(_currentTheme);
        target = name === 'next'
          ? names[(idx + 1) % names.length]
          : names[(idx - 1 + names.length) % names.length];
      }
      Object.assign(T, loadTheme(target));
      _currentTheme = target;
      setThemeRev(n => n + 1);
      sysOut(`theme: ${target}`);
      return true;
    }
    if (cmd === '/telegram') {
      const argParts = arg.trim().split(/\s+/).filter(Boolean);
      const sub = argParts[0] ?? '';
      const subArg = argParts.slice(1).join(' ').trim();

      // No-arg: report who's currently polling + subcommand hints.
      if (!sub) {
        const me = `  ${BUS_NODE_ID}  (this shell)  ${tgPolling ? 'polling' : 'idle'}`;
        const peerLines = [];
        for (const [nodeId, peer] of peerNodesRef.current) {
          peerLines.push(`  ${nodeId}  (${peer.role ?? '?'})  ${peer.polling ? 'polling' : 'idle'}`);
        }
        sysOut(`telegram polling status:\n${me}` +
               (peerLines.length ? '\n' + peerLines.join('\n') : '\n  (no peers on bus)') +
               `\n\n/telegram <node>            hand polling to that node` +
               `\n/telegram disconnect         stop polling on this node` +
               `\n/telegram allow <userId>     authorize a Telegram user to issue commands` +
               `\n/telegram revoke <userId>    remove a user's authorization` +
               `\n/telegram allowed            list authorized users`);
        return true;
      }
      if (sub === 'disconnect') {
        if (tgPolling) stopTgBridge();
        else sysOut('telegram: not polling on this node');
        return true;
      }
      if (sub === 'allow' || sub === 'revoke') {
        const idStr = subArg.replace(/^@/, '');
        const userId = parseInt(idStr, 10);
        if (!Number.isFinite(userId)) {
          sysOut(`!! /telegram ${sub} <userId> — userId must be the numeric Telegram id (the bot prints it when an unauthorized user tries a command)`);
          return true;
        }
        // Read global config (~/.egpt/config.json), update allowed_users,
        // write back. Mutate the live tgCfgRef array in place when possible
        // so the running bridge sees the change without a restart; if the
        // bridge captured a different array reference, restart.
        const cfgPath = join(EGPT_HOME, 'config.json');
        let cfg = {};
        try { cfg = JSON.parse(await readFile(cfgPath, 'utf8')); } catch {}
        if (!cfg.telegram || typeof cfg.telegram !== 'object') cfg.telegram = {};
        if (!Array.isArray(cfg.telegram.allowed_users)) cfg.telegram.allowed_users = [];
        if (sub === 'allow') {
          if (!cfg.telegram.allowed_users.includes(userId)) cfg.telegram.allowed_users.push(userId);
        } else {
          cfg.telegram.allowed_users = cfg.telegram.allowed_users.filter(id => id !== userId);
        }
        await mkdir(EGPT_HOME, { recursive: true });
        await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n');

        const live = tgCfgRef.current?.telegram?.allowed_users;
        if (Array.isArray(live)) {
          // Mutate in place so the bridge's closure picks up the change.
          live.splice(0, live.length, ...cfg.telegram.allowed_users);
          sysOut(`telegram: ${sub === 'allow' ? 'allowed' : 'revoked'} user ${userId} (live)`);
        } else if (bridgeRef.current) {
          // Bridge had a different reference — restart.
          stopTgBridge();
          tgCfgRef.current = cfg;
          await startTgBridge();
          sysOut(`telegram: ${sub === 'allow' ? 'allowed' : 'revoked'} user ${userId} (bridge restarted)`);
        } else {
          sysOut(`telegram: ${sub === 'allow' ? 'allowed' : 'revoked'} user ${userId} (no bridge running here; will apply when this node next polls)`);
        }
        return true;
      }
      if (sub === 'allowed') {
        const cfgPath = join(EGPT_HOME, 'config.json');
        let cfg = {};
        try { cfg = JSON.parse(await readFile(cfgPath, 'utf8')); } catch {}
        const ids = cfg.telegram?.allowed_users ?? [];
        if (ids.length === 0) {
          sysOut('telegram: no allowed users — commands and mentions from any Telegram user are rejected');
        } else {
          sysOut(`telegram allowed users (~/.egpt/config.json):\n${ids.map(id => `  ${id}`).join('\n')}`);
        }
        return true;
      }
      // Hand off to a peer (or to ourselves to reclaim).
      const tid = busTargetIdRef.current;
      if (!tid) { sysOut('!! bus not joined — handoff requires bus'); return true; }
      // Strip leading @ if present.
      const to = sub.replace(/^@/, '');
      if (to === BUS_NODE_ID || to === 'shell') {
        await startTgBridge();
        return true;
      }
      // Validate peer exists; if not, post anyway (peer might join later, or the
      // user knows what they're doing).
      const peer = peerNodesRef.current.get(to);
      if (!peer) {
        // Try matching by role
        const candidates = [...peerNodesRef.current.entries()].filter(([_, p]) => p.role === to);
        if (candidates.length === 1) {
          const [nodeId] = candidates[0];
          if (tgPolling) stopTgBridge();
          await bus.postEvent(tid, { type: 'telegram-handoff', from: BUS_NODE_ID,
            ts: Date.now(), to: nodeId });
          sysOut(`telegram: handoff posted to ${nodeId}`);
          return true;
        }
        if (candidates.length > 1) {
          sysOut(`!! ambiguous role "${to}"; pick one of: ${candidates.map(([n]) => n).join(', ')}`);
          return true;
        }
        sysOut(`!! no peer "${to}" on bus — /telegram with no arg lists peers`);
        return true;
      }
      if (tgPolling) stopTgBridge();
      await bus.postEvent(tid, { type: 'telegram-handoff', from: BUS_NODE_ID,
        ts: Date.now(), to });
      sysOut(`telegram: handoff posted to ${to}`);
      return true;
    }
    if (cmd === '/whatsapp') {
      const argParts = arg.trim().split(/\s+/).filter(Boolean);
      const sub = argParts[0];
      const subArg = argParts.slice(1).join(' ').trim();
      const cfgPath = join(EGPT_HOME, 'config.json');
      const authDir = join(EGPT_HOME, 'wa-auth');

      if (!sub) {
        const status = waBridgeRef.current
          ? `connected as ${waBridgeRef.current.myJid ?? '?'}\n  last chat: ${waBridgeRef.current.chatId ?? '(none)'}`
          : 'not running';
        sysOut(`whatsapp: ${status}\n` +
          `\n/whatsapp pair                pair this device (wipes auth, shows new QR)` +
          `\n/whatsapp disconnect          stop the bridge (auth preserved)` +
          `\n/whatsapp allow <number>      authorize a phone number for commands` +
          `\n/whatsapp revoke <number>     remove authorization` +
          `\n/whatsapp allowed             list authorized numbers`);
        return true;
      }
      if (sub === 'pair') {
        if (waBridgeRef.current) {
          try { waBridgeRef.current.stop(); } catch (_) {}
          waBridgeRef.current = null;
        }
        try { await rm(authDir, { recursive: true, force: true }); }
        catch (e) { sysOut(`!! couldn't wipe ${authDir}: ${e.message}`); return true; }
        sysOut(`whatsapp: auth wiped at ${dp(authDir)}; restarting bridge — QR coming up`);
        await startWaBridge(true);
        return true;
      }
      if (sub === 'disconnect') {
        if (!waBridgeRef.current) { sysOut('whatsapp: not running'); return true; }
        try { waBridgeRef.current.stop(); } catch (_) {}
        waBridgeRef.current = null;
        sysOut('whatsapp: disconnected (auth preserved). /whatsapp pair to start over');
        return true;
      }
      if (sub === 'allow' || sub === 'revoke') {
        const number = subArg.replace(/[^\d]/g, '');
        if (!number) {
          sysOut(`!! /whatsapp ${sub} <number> — number must be the phone digits (with or without +, dashes, spaces)`);
          return true;
        }
        let cfg = {};
        try { cfg = JSON.parse(await readFile(cfgPath, 'utf8')); } catch (_) {}
        if (!cfg.whatsapp || typeof cfg.whatsapp !== 'object') cfg.whatsapp = {};
        if (!Array.isArray(cfg.whatsapp.allowed_users)) cfg.whatsapp.allowed_users = [];
        if (sub === 'allow') {
          if (!cfg.whatsapp.allowed_users.some(u => String(u).replace(/[^\d]/g, '') === number)) {
            cfg.whatsapp.allowed_users.push(number);
          }
        } else {
          cfg.whatsapp.allowed_users = cfg.whatsapp.allowed_users.filter(
            u => String(u).replace(/[^\d]/g, '') !== number,
          );
        }
        await mkdir(EGPT_HOME, { recursive: true });
        await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
        sysOut(`whatsapp: ${sub === 'allow' ? 'allowed' : 'revoked'} ${number} (takes effect on /whatsapp pair or shell restart)`);
        return true;
      }
      if (sub === 'allowed') {
        let cfg = {};
        try { cfg = JSON.parse(await readFile(cfgPath, 'utf8')); } catch (_) {}
        const ids = cfg.whatsapp?.allowed_users ?? [];
        sysOut(ids.length === 0
          ? 'whatsapp: no allowed users — commands and mentions are rejected'
          : `whatsapp allowed users:\n${ids.map(id => `  ${id}`).join('\n')}`);
        return true;
      }
      sysOut(`!! unknown subcommand: ${sub}\n/whatsapp with no args lists subcommands`);
      return true;
    }
    if (cmd === '/config') {
      // Allowed config keys are registered in config-schema.mjs and
      // covered by an integrity test that cross-checks against
      // EGPT_CONFIG references in this file.
      const parts = arg.trim().split(/\s+/);
      const key = parts[0];
      const rawVal = parts.slice(1).join(' ');
      let localCfg = {};
      try { localCfg = JSON.parse(readFileSync(LOCAL_CONFIG_PATH, 'utf8')); } catch {}
      if (!key) {
        const entries = Object.entries(localCfg);
        const schema = Object.entries(CONFIG_SCHEMA).map(([k, d]) => `  ${k} — ${d}`).join('\n');
        sysOut((entries.length
          ? `local config (${dp(LOCAL_CONFIG_PATH)}):\n${entries.map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`).join('\n')}\n`
          : `local config empty  (${dp(LOCAL_CONFIG_PATH)})\n`) + `\nkeys:\n${schema}`);
        return true;
      }
      if (!(key in CONFIG_SCHEMA)) {
        const valid = Object.keys(CONFIG_SCHEMA).join(', ');
        sysOut(`!! unknown config key: ${key}\nvalid keys: ${valid}`);
        return true;
      }
      if (!rawVal) {
        const v = localCfg[key] ?? EGPT_CONFIG[key];
        sysOut(v !== undefined ? `${key}: ${JSON.stringify(v)}` : `${key}: (not set)`);
        return true;
      }
      let val;
      try { val = JSON.parse(rawVal); } catch { val = rawVal; }
      localCfg[key] = val;
      try {
        await mkdir(dirname(LOCAL_CONFIG_PATH), { recursive: true });
        await writeFile(LOCAL_CONFIG_PATH, JSON.stringify(localCfg, null, 2) + '\n');
        EGPT_CONFIG[key] = val;
      } catch (e) { sysOut(`!! config write: ${e.message}`); return true; }
      if (key === 'theme') {
        Object.assign(T, loadTheme(val));
        _currentTheme = val;
        setThemeRev(n => n + 1);
      }
      if (key === 'show_prompts') _showPrompts = !!val;
      if (key === 'node_name') {
        // Live rename: announce node-offline under the old name first
        // so peers drop the old entry, swap BUS_NODE_ID + SURFACE_TAG,
        // then re-announce as node-online with the new name. Local UI
        // and Telegram tags pick up the new SURFACE_TAG on the next
        // render — past rows keep their original tag (they're locked
        // in by Ink's <Static>, which is correct: history is history).
        const oldName = BUS_NODE_ID;
        const newName = String(val);
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
            });
          } catch (_) {}
        }
      }
      sysOut(`config: ${key} = ${JSON.stringify(val)}  →  ${dp(LOCAL_CONFIG_PATH)}`);
      return true;
    }
    if (cmd === '/create-profile') {
      startProfileWizard(arg.trim() || undefined);
      return true;
    }
    if (cmd === '/profiles' || cmd === '/brain-profiles') {
      try {
        const profiles = await listBrainProfiles();
        if (!profiles.length) {
          sysOut(`(no brain profiles found)\nprofile dirs:\n${profileDirsText()}`);
          return true;
        }
        const rows = profiles.map(p => {
          const base = `${p.name.padEnd(16)} ${p.brain.padEnd(13)} ${p.source}  ${p.path}`;
          return p.error ? `${base}\n  !! ${p.error}` : base;
        });
        sysOut(`Brain profiles:\n\n${rows.join('\n')}\n\n/attach <profile> starts one.\nprofile dirs:\n${profileDirsText()}`);
      } catch (e) {
        sysOut(`!! ${e.message}`);
      }
      return true;
    }
    if (cmd === '/profile' || cmd === '/profile-url') {
      try {
        const spec = parseProfileCreateArgs(arg);
        const { path, profile } = await writeConversationProfile(spec);
        sysOut(`profile "${profile.name}" saved -> ${dp(path)}\n  type: ${profile.type}\n  url: ${profile.url}\n  attach with: /attach ${profile.name}`);
        if (spec.attach) {
          const loaded = await loadBrainProfile(profile.name);
          await attachProfile(loaded);
        }
      } catch (e) {
        sysOut(e.message.includes('usage: /profile') ? e.message : `!! ${e.message}\n\n${profileCreateUsage()}`);
      }
      return true;
    }
    if (cmd === '/send-file') {
      let parsed;
      try {
        parsed = parseSendFileArgs(arg);
      } catch (e) {
        sysOut(e.message);
        return true;
      }
      if (!sessions[parsed.targetName]) {
        sysOut(`no registered target session "@${parsed.targetName}"`);
        return true;
      }
      let directPreparedPath = null;
      try {
        directPreparedPath = !parsed.instructionProvided
          ? directPreparedPathFromSource(parsed.path)
          : null;
      } catch (e) {
        sysOut(`!! ${e.message}`);
        return true;
      }
      if (directPreparedPath) {
        try {
          const info = await stat(directPreparedPath);
          if (!info.isFile()) {
            sysOut(`prepared path is not a file: ${dp(directPreparedPath)}`);
            return true;
          }
          const prepared = await readFile(directPreparedPath, 'utf8');
          if (!prepared.trim()) {
            sysOut(`prepared file is empty: ${directPreparedPath}`);
            return true;
          }
          const maxChars = parsed.maxProvided ? parsed.maxChars : 0;
          if (maxChars > 0 && prepared.length > maxChars) {
            const askSuffix = parsed.ask ? ` --ask ${quoteRoomArg(parsed.ask)}` : '';
            sysOut(
              `not pasted into @${parsed.targetName}: prepared file is ${prepared.length} chars, over --max ${maxChars}. It is saved at:\n` +
              `${dp(directPreparedPath)}\n` +
              `Use --all to send it:\n` +
              `/send-file ${quoteRoomArg(directPreparedPath)} @${parsed.targetName} --all${askSuffix}`,
            );
            return true;
          }

          const sendNote =
            `[send-file pasted prepared file into ${parsed.targetName}]\n` +
            `source: ${directPreparedPath}\n` +
            `chars: ${prepared.length}\n` +
            `mode: prepared-file direct` +
            (parsed.ask ? '\nmode: paste + ask' : '');
          await append('system', sendNote);
          setItems(p => [...p, { id: Date.now() + Math.random(), author: 'system', body: sendNote }]);

          setBusy(true);
          try {
            await runBrainTurn(parsed.targetName, buildPasteFileMessage({
              path: directPreparedPath,
              originalChars: prepared.length,
              excerpt: prepared,
              rangeLabel: 'prepared file',
            }, parsed));
          } finally {
            setBusy(false);
          }
          sysOut(`sent ${prepared.length} prepared chars to ${parsed.targetName}`);
        } catch (e) {
          setBusy(false);
          sysOut(`!! ${e.message}\n\n${sendFileUsage()}`);
        }
        return true;
      }

      let via = parsed.viaSpec;
      if (!via) {
        via = defaultOperatorSession(sessions);
        if (!via) {
          sysOut('no unambiguous local operator session; use via=codex1 or via=ccode1');
          return true;
        }
      }
      try {
        assertOperatorSession(via, sessions);
      } catch (e) {
        sysOut(`!! ${e.message}`);
        return true;
      }

      try {
        const preparedPath = await preparedFilePathFor(via, parsed.path);
        const prepNote =
          `[send-file preparing via ${via}]\n` +
          `source: ${parsed.path ?? '(operator will infer)'}\n` +
          `target: @${parsed.targetName}\n` +
          `instruction: ${parsed.instruction}\n` +
          `prepared path: ${preparedPath}`;
        await append('system', prepNote);
        setItems(p => [...p, { id: Date.now() + Math.random(), author: 'system', body: prepNote }]);

        setBusy(true);
        try {
          await dispatchToOperator(
            'send-file',
            sendFilePrepVars({ sourcePath: parsed.path, preparedPath, targetName: parsed.targetName, instruction: parsed.instruction }),
            via,
          );
        } finally {
          setBusy(false);
        }

        const prepared = await readFile(preparedPath, 'utf8');
        const maxChars = parsePositiveLimit(parsed.maxChars, DEFAULT_PASTE_FILE_MAX_CHARS);
        if (!prepared.trim()) {
          sysOut(`${via} created an empty prepared file: ${preparedPath}`);
          return true;
        }
        if (maxChars > 0 && prepared.length > maxChars) {
          const askSuffix = parsed.ask ? ` --ask ${quoteRoomArg(parsed.ask)}` : '';
          sysOut(
            `not pasted into @${parsed.targetName}: prepared file is ${prepared.length} chars, over --max ${maxChars}. It is saved at:\n` +
            `${dp(preparedPath)}\n` +
            `To paste exactly this prepared file, run:\n` +
            `/send-file ${quoteRoomArg(preparedPath)} @${parsed.targetName}${askSuffix}\n` +
            `Or rerun the preparation with --all or a narrower instruction.`,
          );
          return true;
        }

        const sendNote =
          `[send-file pasted prepared excerpt into ${parsed.targetName}]\n` +
          `via: ${via}\n` +
          `source: ${parsed.path ?? '(operator inferred source)'}\n` +
          `instruction: ${parsed.instruction}\n` +
          `prepared: ${preparedPath}\n` +
          `chars: ${prepared.length}`;
        await append('system', sendNote);
        setItems(p => [...p, { id: Date.now() + Math.random(), author: 'system', body: sendNote }]);

        setBusy(true);
        try {
          await runBrainTurn(parsed.targetName, buildPasteFileMessage({
            path: `${parsed.path ?? '(operator inferred source)'} (prepared by ${via} at ${preparedPath})`,
            originalChars: prepared.length,
            excerpt: prepared,
            rangeLabel: `prepared by ${via}: ${parsed.instruction}`,
          }, parsed));
        } finally {
          setBusy(false);
        }
        sysOut(`sent ${prepared.length} prepared chars from ${via} to ${parsed.targetName}`);
      } catch (e) {
        setBusy(false);
        sysOut(`!! ${e.message}\n\n${sendFileUsage()}`);
      }
      return true;
    }
    if (cmd === '/paste-file' || cmd === '/inject-file' || cmd === '/paste') {
      let parsed;
      try {
        parsed = parsePasteFileArgs(arg);
      } catch (e) {
        sysOut(e.message);
        return true;
      }
      const target = resolveAddressedSession(parsed.targetSpec, sessions);
      if (!target) {
        sysOut(`no session or unambiguous brain named "${parsed.targetSpec}"`);
        return true;
      }

      try {
        const payload = await readPasteFilePayload(parsed);
        if (!payload.excerpt.trim()) {
          sysOut('selected file excerpt is empty');
          return true;
        }
        const note =
          `[pasted file excerpt into ${target}]\n` +
          `path: ${payload.path}\n` +
          `range: ${payload.rangeLabel}\n` +
          `chars: ${payload.excerpt.length} of ${payload.originalChars}` +
          (parsed.ask ? '\nmode: paste + ask' : '\nmode: raw paste');
        await append('system', note);
        setItems(p => [...p, { id: Date.now() + Math.random(), author: 'system', body: note }]);
        setBusy(true);
        try {
          await runBrainTurn(target, buildPasteFileMessage(payload, parsed));
        } finally {
          setBusy(false);
        }
        sysOut(`pasted ${payload.excerpt.length} chars into ${target}`);
      } catch (e) {
        setBusy(false);
        sysOut(`!! ${e.message}\n\n${pasteFileUsage()}`);
      }
      return true;
    }
    if (cmd === '/browse') {
      // /browse [via=<op>] <url> [@<session>] ["<instruction>"] [--max <N>] [--keep]
      //
      // via=<op>  delegate entirely to an operator brain — it fetches, parses,
      //           and formats the result itself using its own tools (curl, node,
      //           CDP scripts, etc.). Its reply flows to Telegram automatically.
      //           No CDP tab is opened by egpt in this mode.
      //
      // (no via) egpt opens a Chrome tab, waits for the page to settle, extracts
      //           body text, and drops it into the room or injects into @session.
      const words = parseCommandWords(arg);
      if (!words.length) {
        sysOut([
          'usage: /browse [via=<op>] [<url>] ["<instruction>"] [@<session>] [--max <N>] [--keep]',
          '  via=<op>     delegate to operator (CDP automation via browser-tools.mjs)',
          '               url optional — operator determines where to go if omitted',
          '               instruction = the task; result flows to Telegram automatically',
          '  (no via)     egpt opens tab, extracts text, closes it',
          '               url required; @<session> injects text into that session',
          '               --max N: max chars (default 60000)  --keep: leave tab open',
          'examples:',
          '  /browse via=codex1 "search google for bongo drum inventors, return 3 results"',
          '  /browse via=ccode1 amazon.com "find cheapest bongo drums: image; price; link"',
          '  /browse https://en.wikipedia.org/wiki/Bongo_drum @cgpt1 "summarize history"',
        ].join('\n'));
        return true;
      }

      // Parse: collect via=, url, @target, --flags, and everything else = instruction
      let viaOp = null, browseUrl = null, browseTarget = null;
      let browseInstruction = [], maxChars = 60000, keepTab = false;
      for (let i = 0; i < words.length; i++) {
        const w = words[i];
        if (w.startsWith('via=')) { viaOp = w.slice(4); continue; }
        if (!browseUrl && /^https?:\/\//.test(w)) { browseUrl = w; continue; }
        // Accept bare domains / paths: amazon.com, google.com/search?q=…
        if (!browseUrl && /^[a-zA-Z0-9][-a-zA-Z0-9.]*\.[a-zA-Z]{2,}(\/|$)/.test(w)) {
          browseUrl = 'https://' + w; continue;
        }
        if (w.startsWith('@')) { browseTarget = w.slice(1); continue; }
        if (w === '--max' && i + 1 < words.length) { maxChars = Math.max(1000, parseInt(words[++i], 10) || 60000); continue; }
        if (w === '--keep') { keepTab = true; continue; }
        browseInstruction.push(w);
      }
      const instruction = browseInstruction.join(' ').trim() || null;

      // ── resolve or auto-attach operator ────────────────────────────────────
      // instruction-only (no URL, no via=) always needs an operator
      let extraSessions = {};
      if (!browseUrl && !viaOp) {
        if (!instruction) {
          sysOut('!! /browse: provide a URL, an instruction, or via=<op>');
          return true;
        }
        viaOp = resolveOperatorSession(null, sessions);
        if (!viaOp) {
          // No operator in room — auto-attach a new codex session and make it default
          const name  = nextName('codex', sessions);
          const emoji = nextEmoji(sessions);
          const entry = { brain: 'codex', options: { cwd: process.cwd() }, emoji };
          extraSessions[name] = entry;
          setSessions(s => ({ ...s, [name]: entry }));
          _defaultOp = name;
          persistDefaultOp(name);
          sysOut(`attached ${emoji} ${name} (codex) — new default operator`);
          viaOp = name;
        } else {
          sysOut(`(using operator: ${viaOp})`);
        }
      }

      // ── via=operator mode: delegate the whole task ──────────────────────────
      if (viaOp) {
        // Merge any freshly attached sessions so lookups don't depend on React re-render
        const effectiveSessions = Object.keys(extraSessions).length
          ? { ...sessions, ...extraSessions }
          : sessions;
        viaOp = resolveOperatorSession(viaOp, effectiveSessions);
        if (!viaOp || !effectiveSessions[viaOp]) {
          sysOut(`!! /browse: session "${viaOp ?? '?'}" not found`);
          return true;
        }
        const browseTask = [
          instruction ?? 'fetch the page and summarize its main content',
          ...(browseUrl ? [`URL: ${browseUrl}`] : []),
        ].join('\n');
        const browseVars = { task: browseTask, cdp_host: await cdp.cdpHost() };
        const note = `[browse via ${viaOp}]${browseUrl ? ' ' + browseUrl : ''}${instruction ? '\n  ' + instruction : ''}`;
        setItems(p => [...p, { id: Date.now() + Math.random(), author: 'system', body: note }]);
        await append('system', note);
        setBusy(true);
        try { await dispatchToOperator('browse', browseVars, viaOp, effectiveSessions); }
        finally { setBusy(false); setBrowserWaiting(null); }
        return true;
      }

      // ── direct CDP extraction mode ──────────────────────────────────────────
      if (browseTarget && !sessions[browseTarget]) { sysOut(`!! /browse: no session named "${browseTarget}"`); return true; }

      setBusy(true);
      setStreaming({ author: 'browse', text: `fetching ${browseUrl}…` });
      let browseResult = null;
      try {
        let lastProg = '';
        browseResult = await cdp.browseTab(browseUrl, {
          maxChars,
          onProgress: (href, len, ready) => {
            const t = `${href}\n  ${ready} · ${len.toLocaleString()} chars`;
            if (t !== lastProg) { lastProg = t; setStreaming({ author: 'browse', text: t }); }
          },
        });
        setStreaming(null);
        if (!keepTab) cdp.closeTab(browseResult.targetId).catch(() => {});

        const chars = browseResult.text.length;
        const header = `[browse: ${browseResult.title || browseResult.url}]\n${browseResult.url}  (${chars.toLocaleString()} chars)`;
        const body = browseResult.text.trim();
        const fullContent = `${header}\n\n${body}`;

        if (chars < 300) {
          sysOut(`(only ${chars} chars extracted — dynamic/JS-heavy pages need /browse via=<op> to interact)`);
        }

        if (browseTarget) {
          const note = `[browsed ${browseResult.url} (${chars.toLocaleString()} chars)] -> injecting into ${browseTarget}`;
          setItems(p => [...p, { id: Date.now() + Math.random(), author: 'system', body: note }]);
          await append('system', note);
          const isCDP = !!brainForName(sessions[browseTarget]?.brain)?.urlMatch;
          const msg = isCDP
            ? { message: fullContent, ask: instruction }
            : (instruction ? `${fullContent}\n\n---\n${instruction}` : fullContent);
          await runBrainTurn(browseTarget, msg);
        } else {
          const note = instruction ? `${fullContent}\n\n---\n${instruction}` : fullContent;
          await append('system', note);
          setItems(p => [...p, { id: Date.now() + Math.random(), author: 'system', body: note }]);
        }
      } catch (e) {
        setStreaming(null);
        if (browseResult && !keepTab) cdp.closeTab(browseResult.targetId).catch(() => {});
        sysOut(`!! browse: ${e.message}`);
      } finally {
        setBusy(false);
      }
      return true;
    }
    if (cmd === '/continue') {
      // Resume an operator that called browser.waitForHuman().
      // Creates ~/.egpt/browser-continue.txt which browser-tools.mjs polls for.
      const continueFile = join(EGPT_HOME, 'browser-continue.txt');
      try { writeFileSync(continueFile, '1', 'utf8'); } catch (e) {
        sysOut(`!! /continue: ${e.message}`); return true;
      }
      setBrowserWaiting(null);
      sysOut('browser resumed');
      return true;
    }
    if (cmd === '/session') {
      // /session <session-name>                       → show resume state
      // /session <session-name> <id> [cwd]            → set resume id (cwd auto-detected)
      // /session <session-name> none|clear            → clear (back to stateless)
      // /session <id> [cwd]                           → shorthand: applies to the
      //                                                 only ccode session if
      //                                                 there's exactly one
      const parts = arg.split(/\s+/).filter(Boolean);
      if (parts.length === 0) {
        sysOut('usage: /session <session-name> [<id>|none] [cwd]\n  shorthand /session <id> works if there is exactly one ccode session');
        return true;
      }
      // Resolve the target session
      let target;
      let restParts;
      if (sessions[parts[0]]) {
        target = parts[0];
        restParts = parts.slice(1);
      } else {
        const codeSessions = Object.entries(sessions).filter(([_, s]) => canonicalBrainName(s.brain) === 'ccode');
        if (codeSessions.length === 1) {
          target = codeSessions[0][0];
          restParts = parts;
        } else if (codeSessions.length > 1) {
          sysOut(`multiple ccode sessions: ${codeSessions.map(([n]) => n).join(', ')}\n  /session <session-name> <id>`);
          return true;
        } else {
          sysOut(`no session named "${parts[0]}" and no ccode session to default to`);
          return true;
        }
      }
      if (restParts.length === 0) {
        const opts = sessions[target].options;
        sysOut(`${target}.sessionId: ${opts.sessionId ?? '(none)'}\n${target}.cwd: ${opts.cwd ?? '(none)'}`);
        return true;
      }
      let sid = restParts[0];
      let cwd = restParts.slice(1).join(' ').trim() || undefined;
      if (sid === 'none' || sid === 'clear') {
        const nextSession = {
          ...sessions[target],
          options: Object.fromEntries(
            Object.entries(sessions[target].options).filter(([k]) => k !== 'sessionId' && k !== 'cwd')
          ),
        };
        setSessions(s => ({
          ...s,
          [target]: nextSession,
        }));
        await writeBrainProfileState(target, nextSession).catch(e => sysOut(`!! profile state: ${e.message}`));
        sysOut(`${target}: resume cleared (back to stateless mode)`);
        return true;
      }
      // Resolve a prefix to the full session UUID and auto-detect cwd.
      let expandedFromPrefix = false;
      let detectedCwd = false;
      try {
        const found = await findSessionJsonl(sid);
        if (!found) {
          sysOut(`!! no session matches "${sid}". /history to list, /session ${target} none to clear.`);
          return true;
        }
        if (found.sessionId !== sid) { sid = found.sessionId; expandedFromPrefix = true; }
        if (!cwd) {
          const meta = await readJsonlMetadata(found.path);
          if (meta.cwd) { cwd = meta.cwd; detectedCwd = true; }
        }
      } catch (e) {
        sysOut(`!! ${e.message}`);
        return true;
      }
      const nextSession = {
        ...sessions[target],
        options: { ...sessions[target].options, sessionId: sid, ...(cwd ? { cwd } : {}) },
      };
      setSessions(s => ({
        ...s,
        [target]: nextSession,
      }));
      await writeBrainProfileState(target, nextSession).catch(e => sysOut(`!! profile state: ${e.message}`));
      sysOut(`${target}.sessionId -> ${sid}` +
             (expandedFromPrefix ? '  (expanded from prefix)' : '') +
             (cwd ? `\n${target}.cwd -> ${cwd}` + (detectedCwd ? '  (auto-detected from JSONL)' : '') : '\n(no cwd; pass one if claude --resume fails)') +
             `\n(claude --resume mode active for ${target})`);
      return true;
    }
    if (cmd === '/rules') {
      // /rules @<who> — prepend an @-mention so the recipient is named
      // in the rules message. Same delivery path as plain /rules; the
      // mention is just decorative until per-bridge mention encoding
      // (notifications) is wired.
      const recipient = arg.trim().match(/^@(\S+)$/)?.[1] ?? null;
      // Just emit the rules as a system message: written to the .md, shown in
      // the local transcript, mirrored to Telegram via the items.length effect.
      // CDP brains don't read the .md, so they won't see this until the admin
      // explicitly /mirror's the latest message to them.
      const all = Object.entries(sessions)
        .map(([n, s]) => `${s.emoji ? s.emoji + ' ' : ''}${n} (${s.brain})${s.bio ? ` — ${s.bio}` : ''}`)
        .join(', ');
      const rules =
        `[Room rules — read once and remember]\n` +
        `Participants right now: ${all || '(no brains yet)'}, plus the human admin (${USER_NAME}).\n` +
        `Every participant is equal. No principal. Admins are the human overlords.\n\n` +
        `You don't have to reply to every message. Only speak when:\n` +
        `- you're directly addressed (your name or @mention),\n` +
        `- you have something specifically useful that hasn't been said,\n` +
        `- the admin asks for your input.\n\n` +
        `Otherwise, reply with literally just \`...\` (three dots) and nothing else.\n` +
        `The system reads that as a polite acknowledgement and won't post it to the room.\n\n` +
        `You may @mention another participant to ask them something. The admin\n` +
        `arbitrates when AI-AI exchanges get loud.\n\n` +
        `Identity slash commands (any participant may use):\n` +
        `  /emoji <name> <emoji>   set your avatar emoji (auto-assigned at join)\n` +
        `  /handle <old> <new>     rename yourself\n` +
        `  /bio <name> <text>      set a short bio visible to others in /sessions and /rules\n` +
        `Admins may also /emoji, /handle, /bio any participant.`;
      const finalRules = recipient ? `(for @${recipient})\n\n${rules}` : rules;
      await append('system', finalRules);
      setItems(p => [...p, { id: Date.now() + Math.random(), author: 'system', body: finalRules }]);
      return true;
    }
    if (cmd === '/mirror') {
      // Push a message into one or more CDP tabs.
      // Forms:
      //   /mirror                       → latest non-You non-silence-ack message
      //                                   to all OTHER CDP brains
      //   /mirror <target>              → same source, only that target
      //   /mirror <source> <target>     → <source>'s last message → <target>
      // System messages (e.g. /rules output) are eligible sources; silence
      // Silence acks (body === '—', never written to disk) are naturally absent
      // from parseMessages; this filter is a belt-and-suspenders guard.
      const isSilenceAck = (m) => m.body === '—';
      const isMirrorable = (m) => m.author !== 'You' && !isSilenceAck(m);

      // Resolve a name that may carry an @ prefix, and treat "egpt" as "system".
      const resolveName = (n) => { const s = n.replace(/^@/, ''); return s === 'egpt' ? 'system' : s; };
      const parts = arg.split(/\s+/).filter(Boolean).map(resolveName);
      const text = await readFile(FILE, 'utf8');
      let source, targets;

      if (parts.length >= 2) {
        source = parts[0];
        targets = [parts[1]];
      } else {
        const candidates = parseMessages(text).filter(isMirrorable);
        if (!candidates.length) { sysOut('(nothing to mirror — room has no content yet)'); return true; }
        source = candidates[candidates.length - 1].author;
        if (parts.length === 1) targets = [parts[0]];
        else {
          targets = Object.entries(sessions)
            .filter(([n, s]) => n !== source && brainForName(s.brain)?.urlMatch)
            .map(([n]) => n);
          if (targets.length === 0) {
            sysOut(`no other CDP sessions to mirror to (source: ${source})`);
            return true;
          }
        }
      }

      // Find the source's most recent message of any kind (besides silence acks).
      const sourceTurns = parseMessages(text)
        .filter(t => t.author === source && !isSilenceAck(t));
      if (!sourceTurns.length) { sysOut(`no messages from "${source}" in this room`); return true; }
      const lastBody = sourceTurns[sourceTurns.length - 1].body;

      // Validate targets (must be real sessions — system is only valid as source)
      for (const t of targets) {
        if (!sessions[t]) { sysOut(`no session named "${t}" — targets must be active sessions`); return true; }
      }

      const mirrorMsg = `[${source}]: ${lastBody}`;
      const mkMirrorPreview = (text) => {
        const lines = text.split('\n').filter(l => l.trim());
        if (text.length <= 300 || lines.length <= 6)
          return text.length > 300 ? text.slice(0, 300) + '…' : text;
        return lines.slice(0, 3).join('\n') + '\n  …\n' + lines.slice(-2).join('\n');
      };
      sysOut(`mirroring [${source}] -> ${targets.join(', ')}\n${mkMirrorPreview(lastBody)}`);
      setBusy(true);
      try {
        for (const t of targets) {
          await runBrainTurn(t, mirrorMsg);
        }
      } finally { setBusy(false); }
      return true;
    }
    if (cmd === '/refresh') {
      // /refresh [@<name>]
      //   CDP brain:  re-poll the tab and append whatever the AI currently shows.
      //               Recovery for premature stream-end detection.
      //   Operator:   replay the last user message that was addressed to (or
      //               broadcast to — i.e., NOT addressed to a different session)
      //               this session. Triggers a fresh response from the operator.
      const target = arg.trim().replace(/^@/, '');
      let session, sessionName;
      if (target) {
        if (!sessions[target]) { sysOut(`no session named "${target}"`); return true; }
        sessionName = target; session = sessions[target];
      } else {
        if (Object.keys(sessions).length === 1) {
          sessionName = Object.keys(sessions)[0]; session = sessions[sessionName];
        } else {
          const cdps = Object.entries(sessions).filter(([_, s]) => brainForName(s.brain)?.urlMatch);
          if (cdps.length !== 1) {
            const all = Object.keys(sessions);
            sysOut(`usage: /refresh [@<session>]\n  ${all.length === 0 ? 'no sessions in the room' : `pick one: ${all.join(', ')}`}`);
            return true;
          }
          sessionName = cdps[0][0]; session = cdps[0][1];
        }
      }
      const brain = brainForName(session.brain);
      if (brain?.peek) {
        // CDP path: re-poll the tab and append the latest assistant text.
        try {
          const text = await brain.peek(session.options);
          if (!text || !text.trim()) { sysOut('(tab has no assistant message right now)'); return true; }
          setItems(p => [...p, { id: Date.now() + Math.random(), author: sessionName, body: text }]);
          await append(sessionName, text);
          sysOut(`(refreshed ${sessionName} from tab — appended to file)`);
        } catch (e) { sysOut(`!! ${e.message}`); }
      } else {
        // Operator path: replay the last user message that this session
        // would have seen (broadcast OR explicitly addressed to it). A
        // message addressed to a DIFFERENT session is not replayed.
        const fileText = await readFile(FILE, 'utf8');
        const msgs = parseMessages(fileText);
        const wasForSession = (body) => {
          if (!body.startsWith('@')) return true; // broadcast
          // body looks like "@name ..." — match on @<sessionName> followed by ws/EOL
          return body.startsWith(`@${sessionName} `) || body.startsWith(`@${sessionName}\n`) || body === `@${sessionName}`;
        };
        const lastUserMsg = [...msgs].reverse().find(m => m.author === 'You' && wasForSession(m.body));
        if (!lastUserMsg) { sysOut(`no user message to replay for ${sessionName}`); return true; }
        const payload = lastUserMsg.body.startsWith(`@${sessionName}`)
          ? lastUserMsg.body.slice(sessionName.length + 1).trim()
          : lastUserMsg.body;
        sysOut(`replaying last message to ${sessionName}…`);
        setBusy(true);
        try { await runBrainTurn(sessionName, payload); } finally { setBusy(false); }
      }
      return true;
    }
    if (cmd === '/summaries' || cmd === '/list-saved' || cmd === '/saved') {
      try {
        await ensureSummariesDir();
        const files = (await readdir(SUMMARIES_DIR)).filter(f => f.endsWith('.md'));
        if (!files.length) { sysOut(`(no summaries yet — try /save <name> or /summarize <name>)\n  dir: ${SUMMARIES_DIR}`); return true; }
        const rows = await Promise.all(files.map(async (f) => {
          const p = join(SUMMARIES_DIR, f);
          const st = await stat(p);
          const head = (await readFile(p, 'utf8')).slice(0, 80).replace(/\s+/g, ' ');
          return { name: f.replace(/\.md$/, ''), size: st.size, mtime: st.mtime, head };
        }));
        rows.sort((a, b) => b.mtime - a.mtime);
        const fmtSize = (b) => b < 1024 ? `${b}B` : `${(b / 1024).toFixed(1)}K`;
        sysOut(rows.map(r =>
          `${r.name.padEnd(20)} ${fmtSize(r.size).padEnd(7)} "${r.head}${r.head.length >= 80 ? '…' : ''}"`
        ).join('\n') + `\n\ndir: ${SUMMARIES_DIR}`);
      } catch (e) { sysOut(`!! ${e.message}`); }
      return true;
    }
    if (cmd === '/save') {
      // /save <name> — write the most recent NON-system message in the current
      // room to ~/.egpt/summaries/<name>.md. Cheap, no LLM call. Useful for
      // saving a clean answer (your own paragraph, or claude's last reply) for
      // injection elsewhere later.
      const name = arg.trim();
      if (!isSafeName(name)) {
        sysOut('usage: /save <name>\n  name: letters/digits/dot/dash/underscore only');
        return true;
      }
      try {
        const text = await readFile(FILE, 'utf8');
        const turns = parseMessages(text).filter(m => m.author !== 'system');
        if (!turns.length) { sysOut('(nothing to save — the room is empty)'); return true; }
        const last = turns[turns.length - 1];
        await ensureSummariesDir();
        const body = `# ${name}\n\n_Saved ${new Date().toISOString().slice(0, 16).replace('T', ' ')} from ${FILE}_\n_Author: ${last.author}_\n\n---\n\n${last.body}\n`;
        await writeFile(summaryPath(name), body);
        sysOut(`saved -> ${dp(summaryPath(name))}\n  (${last.body.length} chars from ${last.author})`);
      } catch (e) { sysOut(`!! ${e.message}`); }
      return true;
    }
    if (cmd === '/summarize' || cmd === '/cdp-summarize' || cmd === '/operator-summarize') {
      // Syntax:
      //   /summarize [all|last <N>] <name> [<brain>]
      //   /cdp-summarize ...           (force CDP path: chatgpt-cdp default)
      //   /operator-summarize ...      (force fresh `claude --print` subprocess)
      //
      // The summarizer is always a fresh agent — never a room participant —
      // so it has no bias from being inside the conversation it's summarizing.
      const parts = arg.split(/\s+/).filter(Boolean);
      let scope = 'all', scopeN = null, i = 0;
      if (parts[i] === 'all') { scope = 'all'; i++; }
      else if (parts[i] === 'last' && /^\d+$/.test(parts[i+1] ?? '')) {
        scope = 'last'; scopeN = parseInt(parts[i+1], 10); i += 2;
      }
      const name = parts[i++];
      let brainKey = parts[i];

      if (!isSafeName(name ?? '')) {
        sysOut(
          'usage: ' + cmd + ' [all|last <N>] <name> [<brain>]\n' +
          '  default scope: all room messages\n' +
          '  default brain: ' + (cmd === '/operator-summarize'
            ? 'fresh ccode subprocess'
            : 'fresh chatgpt-cdp tab -> claude-cdp -> fresh ccode') + '\n' +
          '  saves to ~/.egpt/summaries/<name>.md'
        );
        return true;
      }

      try {
        await ensureSummariesDir();
        const text = await readFile(FILE, 'utf8');
        const allTurns = parseMessages(text).filter(t => t.author !== 'system');
        if (!allTurns.length) { sysOut('(nothing to summarize — room is empty)'); return true; }
        const turns = scope === 'last' && scopeN ? allTurns.slice(-scopeN) : allTurns;
        const formatted = turns.map(t => `[${t.author}]: ${t.body}`).join('\n\n');
        const scopeLabel = scope === 'last' ? `last ${scopeN}` : 'all';
        const promptResult = await buildCommandPrompt('summarize', { conversation: formatted });
        const prompt = promptResult?.text ??
          `Please summarize this conversation faithfully. Preserve participants, key decisions, and any open questions or loose threads. Aim for under 600 words. Plain markdown, no preamble. Output ONLY the summary text — no "Here is the summary:" boilerplate.\n\n---\n\n${formatted}`;
        if (_showPrompts) {
          const bar = '─'.repeat(53);
          sysOut(`[prompt -> summarize]\n${bar}\n${prompt.slice(0, 800)}${prompt.length > 800 ? '\n...[truncated for display]' : ''}\n${bar}`);
        }

        // Pick brain
        const forceOperator = cmd === '/operator-summarize';
        if (forceOperator) brainKey = null;
        if (!brainKey && !forceOperator) {
          if (await cdp.isRunning()) {
            if (BRAINS['chatgpt-cdp']) brainKey = 'chatgpt-cdp';
            else if (BRAINS['claude-cdp']) brainKey = 'claude-cdp';
          }
        }

        let summary;
        let summarizer;
        if (brainKey && BRAINS[brainKey]?.homeUrl) {
          summarizer = `${brainKey} (fresh tab)`;
          sysOut(`opening a fresh ${brainKey} tab for summarization (${scopeLabel} of ${allTurns.length} turns)…`);
          const targetId = await cdp.openTab(BRAINS[brainKey].homeUrl);
          await new Promise(r => setTimeout(r, 3500)); // wait for page to mount textarea
          setBusy(true);
          setStreaming({ author: summarizer, text: '' });
          try {
            summary = await BRAINS[brainKey].stream(
              { history: '', message: prompt },
              partial => setStreaming({ author: summarizer, text: partial }),
              { targetId },
            );
          } finally {
            setStreaming(null); setBusy(false);
          }
        } else {
          summarizer = 'fresh ccode';
          sysOut(`asking a fresh ccode subprocess to summarize (${scopeLabel} of ${allTurns.length} turns)…`);
          setBusy(true);
          try {
            summary = await new Promise((resolve, reject) => {
              const proc = spawn('claude', ['--print', '--output-format', 'json'], { stdio: ['pipe', 'pipe', 'pipe'] });
              let out = '', err = '';
              proc.stdout.on('data', c => out += c);
              proc.stderr.on('data', c => err += c);
              proc.on('close', code => {
                if (code !== 0) return reject(new Error(`claude exit ${code}: ${err.trim() || 'no stderr'}`));
                try { resolve((JSON.parse(out).result ?? out).trim()); }
                catch { resolve(out.trim()); }
              });
              proc.on('error', e => reject(e.code === 'ENOENT' ? new Error('claude not found on PATH') : e));
              proc.stdin.write(prompt); proc.stdin.end();
            });
          } finally { setBusy(false); }
        }

        if (!summary) { sysOut('(empty summary)'); return true; }
        const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
        const body = `# ${name}\n\n_Summarized ${stamp} by ${summarizer} from ${FILE}_\n_Scope: ${scopeLabel}${scope === 'last' ? ` (of ${allTurns.length} total)` : ''}_\n\n---\n\n${summary}\n`;
        await writeFile(summaryPath(name), body);
        sysOut(`saved -> ${dp(summaryPath(name))}  (${summary.length} chars)`);
      } catch (e) {
        setBusy(false);
        sysOut(`!! ${e.message}`);
      }
      return true;
    }
    if (cmd === '/inject') {
      // /inject <name>           — drop a saved summary into the current room
      // /inject <name> <session> — send it directly to one brain session
      const parts = arg.split(/\s+/).filter(Boolean);
      const [name, targetSpec] = parts;
      if (!isSafeName(name)) {
        sysOut('usage: /inject <name> [session]\n  no session: drops the summary into this room as a system note\n  with session: sends the summary directly to that brain. /summaries to list.');
        return true;
      }
      if (parts.length > 2) {
        sysOut('usage: /inject <name> [session]');
        return true;
      }
      const target = targetSpec ? resolveAddressedSession(targetSpec, sessions) : null;
      if (targetSpec && !target) {
        sysOut(`no session or unambiguous brain named "${targetSpec}"`);
        return true;
      }
      try {
        if (target) {
          setBusy(true);
          const { body } = await injectSummary(name, target);
          setBusy(false);
          sysOut(`injected "${name}" into ${target} (${body.length} chars)`);
        } else {
          const { body } = await injectSummary(name);
          sysOut(`injected "${name}" (${body.length} chars)`);
        }
      } catch (e) {
        setBusy(false);
        if (e.code === 'ENOENT') sysOut(`no summary named "${name}". /summaries to list.`);
        else sysOut(`!! ${e.message}`);
      }
      return true;
    }
    if (cmd === '/history') {
      // List recent Claude Code sessions on disk, newest first.
      // Each entry shows: short id, "Nm/Nh ago", size, original cwd, first user line.
      try {
        const projectsDir = join(homedir(), '.claude', 'projects');
        let projects = [];
        try { projects = await readdir(projectsDir); }
        catch { sysOut(`(${projectsDir} not found — no ccode sessions yet)`); return true; }

        const items = [];
        for (const slug of projects) {
          const projectPath = join(projectsDir, slug);
          let files = [];
          try { files = await readdir(projectPath); } catch { continue; }
          for (const file of files) {
            if (!file.endsWith('.jsonl')) continue;
            const sessionId = file.replace(/\.jsonl$/, '');
            const fullPath = join(projectPath, file);
            try {
              const st = await stat(fullPath);
              if (st.size === 0) continue;
              items.push({ sessionId, slug, fullPath, mtime: st.mtime, size: st.size });
            } catch { /* skip */ }
          }
        }
        if (!items.length) { sysOut('(no ccode sessions on disk)'); return true; }

        items.sort((a, b) => b.mtime - a.mtime);
        const N = parseInt(arg, 10) || 10;
        const top = items.slice(0, N);
        const enriched = await Promise.all(top.map(async (it) => {
          const meta = await readJsonlMetadata(it.fullPath);
          return { ...it, ...meta };
        }));

        const fmtTime = (d) => {
          const sec = Math.max(0, (Date.now() - d.getTime()) / 1000);
          if (sec < 60) return `${Math.floor(sec)}s ago`;
          if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
          if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
          return `${Math.floor(sec / 86400)}d ago`;
        };
        const fmtSize = (b) =>
          b < 1024 ? `${b}B` :
          b < 1024 * 1024 ? `${(b / 1024).toFixed(0)}K` :
          `${(b / (1024 * 1024)).toFixed(1)}M`;

        const lines = enriched.map(it => {
          const id = it.sessionId.slice(0, 8);
          const cwd = it.cwd ?? `(slug: ${it.slug})`;
          const preview = it.preview ? `"${it.preview}"` : '(no preview)';
          return `${id}…  ${fmtTime(it.mtime).padEnd(8)} ${fmtSize(it.size).padEnd(6)} ${preview}\n` +
                 `             cwd: ${cwd}`;
        });
        sysOut(`Last ${enriched.length} of ${items.length} ccode session(s) on disk:\n\n` +
               lines.join('\n\n') +
               `\n\nto resume: /session <sessionId>   (cwd auto-detected from the JSONL)`);
      } catch (e) { sysOut(`!! ${e.message}`); }
      return true;
    }
    if (cmd === '/last') {
      const n = parseInt(arg, 10) || 10;
      try {
        const text = await readFile(FILE, 'utf8');
        const msgs = parseMessages(text).slice(-n);
        if (!msgs.length) { sysOut('(no messages yet)'); return true; }
        sysOut(`--- last ${msgs.length} message(s) from ${FILE} ---`);
        setItems(p => [...p, ...msgs.map((m, i) => ({
          id: Date.now() + i / 1000,
          author: m.author,
          body: m.body,
        }))]);
      } catch (e) { sysOut(`!! ${e.message}`); }
      return true;
    }
    if (cmd === '/sessions') {
      // /sessions default <name>  — set the default operator session
      // /sessions default clear   — clear the default
      const parts = arg.split(/\s+/).filter(Boolean);
      if (parts[0] === 'default') {
        const target = parts[1];
        if (!target || target === 'clear' || target === 'none') {
          _defaultOp = null;
          persistDefaultOp(null);
          sysOut('default operator cleared');
        } else if (!sessions[target]) {
          sysOut(`!! no session named "${target}"`);
        } else {
          _defaultOp = target;
          persistDefaultOp(target);
          sysOut(`default operator -> ${target} (persisted)`);
        }
        return true;
      }

      // Best-effort: if a session has a targetId, look up the live tab title
      // and show that. Falls back to just the targetId if Chrome isn't reachable.
      let tabsByid = new Map();
      try {
        const tabs = await cdp.listTabs();
        for (const t of tabs) tabsByid.set(t.id, t);
      } catch { /* Chrome not running — that's fine for non-CDP sessions */ }

      const rows = Object.entries(sessions).map(([name, s]) => {
        const star = name === _defaultOp ? '* ' : '  ';
        const emojiPad = (s.emoji ?? '❓') + ' ';
        const namePad = name.padEnd(14);
        const brainPad = s.brain.padEnd(13);
        const brain = brainForName(s.brain);
        let detail = '';
        if (s.options.targetId) {
          const live = tabsByid.get(s.options.targetId);
          detail = live ? `"${live.title || '(untitled)'}"` : `(tab gone — ${s.options.targetId.slice(0, 8)}...)`;
        } else if (s.options.sessionId) {
          const idShort = s.options.sessionId.slice(0, 8) + '...';
          detail = s.brain === 'codex' ? `thread: ${idShort}` : `claude --resume ${idShort}`;
        } else if (brain?.stateDetail) {
          detail = brain.stateDetail(s.options);
        }
        if (s.options.profileName) {
          detail = [`profile: ${s.options.profileName}`, detail].filter(Boolean).join(' | ');
        }
        const bio = s.bio ? `\n     bio: ${s.bio}` : '';
        return `${star}${emojiPad}${namePad}${brainPad}${detail}${bio}`;
      });
      const footer = _defaultOp ? `\n* = default operator (${_defaultOp})  /sessions default clear to unset` : '';

      // Append peer (zombie) sessions: registered participants owned by other
      // nodes. Visible here so the user sees the whole room and can address
      // any of them with @<name>; the bus routes the mention to the owner.
      const peerLines = [];
      for (const [nodeId, peer] of peerNodesRef.current) {
        const head = `~ ${nodeId}  (${peer.role ?? 'node'})${peer.polling ? '  [polling]' : ''}`;
        peerLines.push(head);
        for (const sess of peer.sessions ?? []) {
          peerLines.push(`    ${(sess.name ?? '?').padEnd(14)}${sess.brain ?? '?'}`);
        }
      }
      const peerBlock = peerLines.length
        ? `\n\n── peers (zombie sessions) ───────────────────\n${peerLines.join('\n')}`
        : '';

      sysOut((rows.join('\n') || '(none)') + footer + peerBlock);
      return true;
    }
    if (cmd === '/rooms') {
      try {
        const dir = join(homedir(), '.egpt', 'rooms');
        let files = [];
        try { files = (await readdir(dir)).filter(f => f.endsWith('.yaml')); } catch {}
        if (!files.length) { sysOut(`(no saved rooms)\n  /save-room <name> to save current room`); return true; }
        sysOut(`Saved rooms in ${dp(dir)}:\n${files.map(f => `  ${f.replace('.yaml', '')}`).join('\n')}\n\n/load-room <name> to restore`);
      } catch (e) { sysOut(`!! ${e.message}`); }
      return true;
    }
    if (cmd === '/save-room') {
      const roomName = arg.trim() || 'default';
      try {
        let tabsByid = new Map();
        try { const tabs = await cdp.listTabs(); for (const t of tabs) tabsByid.set(t.id, t); } catch {}
        const lines = [`# egpt room: ${roomName}`, `# saved: ${ts()}`, ``, `sessions:`];
        for (const [name, s] of Object.entries(sessions)) {
          lines.push(`  ${name}:`);
          lines.push(`    brain: ${s.brain}`);
          if (s.emoji) lines.push(`    emoji: ${s.emoji}`);
          if (s.bio) lines.push(`    bio: "${s.bio.replace(/"/g, '\\"')}"`);
          const opts = s.options ?? {};
          if (opts.targetId) {
            const tab = tabsByid.get(opts.targetId);
            if (tab?.url && !tab.url.startsWith('chrome')) lines.push(`    url: ${tab.url}`);
          }
          if (opts.sessionId) lines.push(`    session_id: ${opts.sessionId}`);
          if (opts.cwd) lines.push(`    cwd: ${opts.cwd}`);
          if (opts.model) lines.push(`    model: ${opts.model}`);
          if (opts.effort) lines.push(`    effort: ${opts.effort}`);
          if (opts.profileName) lines.push(`    profile: ${opts.profileName}`);
        }
        const tgChatId = bridgeRef.current?.chatId;
        if (tgChatId) {
          lines.push(``, `telegram:`, `  chat_id: ${tgChatId}`);
        }
        const dir = join(homedir(), '.egpt', 'rooms');
        await mkdir(dir, { recursive: true });
        const roomFile = join(dir, `${roomName}.yaml`);
        await writeFile(roomFile, lines.join('\n') + '\n');
        sysOut(`room "${roomName}" saved -> ${dp(roomFile)}`);
      } catch (e) { sysOut(`!! ${e.message}`); }
      return true;
    }
    if (cmd === '/detach') {
      const name = arg.trim();
      if (!name) { sysOut('usage: /detach <session>  — remove from room (brain keeps running)'); return true; }
      if (!sessions[name]) { sysOut(`no session named "${name}"`); return true; }
      const { emoji = '', brain: brainName } = sessions[name];
      setSessions(s => { const n = { ...s }; delete n[name]; return n; });
      setItems(p => [...p, {
        id: Date.now() + Math.random(), author: 'system',
        body: `${emoji} ${name} (${brainName}) detached from room`,
      }]);
      return true;
    }
    if (cmd === '/handle') {
      // Rename a session: /handle <old> <new>. Preserves brain, emoji, options, bio.
      const parts = arg.split(/\s+/).filter(Boolean);
      if (parts.length !== 2) { sysOut('usage: /handle <old> <new>'); return true; }
      const [oldName, newName] = parts;
      if (!sessions[oldName]) { sysOut(`no session named "${oldName}"`); return true; }
      if (sessions[newName]) { sysOut(`session "${newName}" already exists`); return true; }
      if (!/^[A-Za-z0-9_-]+$/.test(newName)) { sysOut('handle must be alphanumeric (- and _ ok)'); return true; }
      setSessions(s => {
        const next = { ...s };
        next[newName] = next[oldName];
        delete next[oldName];
        return next;
      });
      const emoji = sessions[oldName].emoji ?? '';
      setItems(p => [...p, {
        id: Date.now() + Math.random(), author: 'system',
        body: `${emoji} ${oldName} is now ${newName}`,
      }]);
      await writeBrainProfileState(newName, sessions[oldName]).catch(e => sysOut(`!! profile state: ${e.message}`));
      return true;
    }
    if (cmd === '/emoji') {
      // /emoji                  → list current emoji per session
      // /emoji <name> <emoji>   → set
      // /emoji <emoji>          → set the lone session's emoji (only if 1 session)
      const parts = arg.split(/\s+/).filter(Boolean);
      if (parts.length === 0) {
        const rows = Object.entries(sessions).map(([n, s]) => `${s.emoji ?? '❓'} ${n}`);
        sysOut(rows.join('\n') || '(no sessions)');
        return true;
      }
      let target, emoji;
      if (parts.length === 1) {
        const all = Object.keys(sessions);
        if (all.length !== 1) { sysOut('usage: /emoji <name> <emoji>'); return true; }
        target = all[0]; emoji = parts[0];
      } else {
        target = parts[0]; emoji = parts[1];
      }
      if (!sessions[target]) { sysOut(`no session named "${target}"`); return true; }
      const nextSession = { ...sessions[target], emoji };
      setSessions(s => ({ ...s, [target]: { ...s[target], emoji } }));
      setItems(p => [...p, {
        id: Date.now() + Math.random(), author: 'system',
        body: `${target} avatar -> ${emoji}`,
      }]);
      await writeBrainProfileState(target, nextSession).catch(e => sysOut(`!! profile state: ${e.message}`));
      return true;
    }
    if (cmd === '/bio') {
      // /bio                       → list bios
      // /bio <name>                → show that session's bio
      // /bio <name> <text...>      → set bio; echoes a system message into the room
      const parts = arg.split(/\s+/);
      const first = parts[0] ?? '';
      if (!first) {
        const rows = Object.entries(sessions)
          .filter(([_, s]) => s.bio)
          .map(([n, s]) => `${s.emoji ?? '❓'} ${n}: ${s.bio}`);
        sysOut(rows.length ? rows.join('\n') : '(no bios set)');
        return true;
      }
      const target = first;
      if (!sessions[target]) { sysOut(`no session named "${target}"`); return true; }
      const text = parts.slice(1).join(' ').trim();
      if (!text) {
        const bio = sessions[target].bio;
        sysOut(bio ? `${sessions[target].emoji ?? '❓'} ${target}: ${bio}` : `(no bio set for ${target})`);
        return true;
      }
      const nextSession = { ...sessions[target], bio: text };
      setSessions(s => ({ ...s, [target]: { ...s[target], bio: text } }));
      setItems(p => [...p, {
        id: Date.now() + Math.random(), author: 'system',
        body: `${sessions[target].emoji ?? '❓'} ${target} bio: ${text}`,
      }]);
      await writeBrainProfileState(target, nextSession).catch(e => sysOut(`!! profile state: ${e.message}`));
      return true;
    }
    if (cmd === '/attach') {
      if (currentRoom === 'default') {
        sysOut('!! default room is the lobby and cannot host brains. Create a room first:\n  /room create <name>\n  /room join <name>\n  /attach …');
        return true;
      }
      // Four forms:
      //   /attach <profile>                -> start a YAML brain profile
      //   /attach                          → re-scan Chrome, attach any new tabs
      //   /attach <brain> <name> [tabSpec] → explicit attach to a specific tab
      //   /attach <brain>                  → attach CDP tabs or create local session
      const parts = arg.split(/\s+/).filter(Boolean);

      // Form 1: no args — rescan and attach all unattached matching tabs.
      if (parts.length === 0) {
        try {
          const tabs = await cdp.listTabs();
          let working = { ...sessions };
          const additions = {};
          for (const tab of tabs) {
            if (isInternalUrl(tab.url)) continue;
            const brainName = brainForUrl(tab.url);
            if (!brainName) continue;
            if (Object.values(working).some(s => s.options?.targetId === tab.id)) continue;
            const name = nextName(brainName, working);
            const emoji = nextEmoji(working);
            additions[name] = { brain: brainName, options: { targetId: tab.id }, emoji };
            working[name] = additions[name];
          }
          if (Object.keys(additions).length === 0) {
            sysOut('no new tabs to attach (everything matching is already a session)');
          } else {
            setSessions(s => ({ ...s, ...additions }));
            sysOut(`attached: ${Object.entries(additions).map(([n, s]) => `${s.emoji} ${n} (${s.brain})`).join(', ')}`);
          }
        } catch (e) { sysOut(`!! ${e.message}`); }
        return true;
      }

      // Profile form: /attach <profile> [session-name-override]
      const profileCandidate = parts[0];
      const profileNameOverride = parts.length === 2 && !brainForName(canonicalBrainName(parts[0])) ? parts[1] : null;
      if (parts.length <= 2) {
        try {
          const profile = await loadBrainProfile(profileCandidate);
          if (profile) {
            await attachProfile(profile, profileNameOverride || undefined);
            return true;
          }
        } catch (e) {
          sysOut(`!! profile "${profileCandidate}": ${e.message}`);
          return true;
        }
      }

      // Brain forms: explicit CDP attach or attach all matching CDP tabs.
      const brainName = canonicalBrainName(parts[0]);
      const brain = brainForName(brainName);
      if (!brain) {
        sysOut('usage: /attach                          rescan and attach new tabs\n' +
               '       /attach <profile>                 start a YAML brain profile\n' +
               '       /attach <brain>                  attach CDP tabs or create a local session\n' +
               '       /attach <brain> <name> [tabSpec] explicit attach\n' +
               'brains: ' + brainNamesForHelp().join(', ') +
               '\nprofile dirs:\n' + profileDirsText());
        return true;
      }
      const sessionName = parts[1];
      const tabSpec = parts.slice(2).join(' ').trim();

      // Form 3: brain only. CDP brains attach all unattached tabs; local
      // brains create one auto-named session in the current cwd.
      if (!sessionName) {
        if (!brain.urlMatch) {
          const name = nextName(brainName, sessions);
          const emoji = nextEmoji(sessions);
          const options = { cwd: process.cwd() };
          setSessions(s => ({ ...s, [name]: { brain: brainName, options, emoji } }));
          sysOut(`session "${name}" -> ${emoji} ${brainName}` +
            `\n  cwd: ${options.cwd}` +
            `\n  address it as @${name} for a single-recipient turn`);
          return true;
        }
        try {
          const matching = (await cdp.listTabs()).filter(t => brain.urlMatch.test(t.url));
          let working = { ...sessions };
          const additions = {};
          for (const tab of matching) {
            if (Object.values(working).some(s => s.options?.targetId === tab.id)) continue;
            const name = nextName(brainName, working);
            const emoji = nextEmoji(working);
            additions[name] = { brain: brainName, options: { targetId: tab.id }, emoji };
            working[name] = additions[name];
          }
          if (Object.keys(additions).length === 0) {
            sysOut(`no new ${brainName} tabs to attach`);
          } else {
            setSessions(s => ({ ...s, ...additions }));
            sysOut(`attached: ${Object.keys(additions).join(', ')}`);
          }
        } catch (e) { sysOut(`!! ${e.message}`); }
        return true;
      }

      // Form 2: explicit
      if (sessions[sessionName]) { sysOut(`session "${sessionName}" already exists`); return true; }
      const options = {};
      if (brain.urlMatch) {
        try {
          if (tabSpec) {
            const tid = await resolveTabId(tabSpec, brain);
            if (!tid) { sysOut(`could not resolve "${tabSpec}" to a tab. /tabs to see open tabs.`); return true; }
            options.targetId = tid;
          } else {
            const tabs = (await cdp.listTabs()).filter(t => brain.urlMatch.test(t.url));
            if (tabs.length === 0) { sysOut(`no open ${brainName} tabs to attach. try /open ${brainName} to open one.`); return true; }
            if (tabs.length > 1) {
              const lst = tabs.map(t => `  "${t.title}" — ${t.url}`).join('\n');
              sysOut(`multiple ${brainName} tabs open. specify which:\n${lst}\nuse: /attach ${brainName} ${sessionName} <urlOrUuidOrId>`);
              return true;
            }
            options.targetId = tabs[0].id;
          }
        } catch (e) { sysOut(`!! ${e.message}`); return true; }
      }

      const emoji = nextEmoji(sessions);
      setSessions(s => ({ ...s, [sessionName]: { brain: brainName, options, emoji } }));
      sysOut(`session "${sessionName}" -> ${emoji} ${brainName}` +
        (options.targetId ? ` (tab ${options.targetId.slice(0, 8)}...)` : '') +
        `\n  address it as @${sessionName} for a single-recipient turn`);
      return true;
    }
    if (cmd === '/open') {
      if (currentRoom === 'default') {
        sysOut('!! default room is the lobby and cannot host brains. Create a room first:\n  /room create <name>\n  /room join <name>\n  /open …');
        return true;
      }
      const parts = arg.split(/\s+/);
      const brainName = canonicalBrainName(parts[0]);
      let sessionName = parts[1];
      if (!brainName) {
        sysOut('usage: /open <brain> [name]\n  name auto-generated (e.g. cgpt2) if omitted.\n  brains: ' + brainNamesForHelp().join(', '));
        return true;
      }
      const brain = brainForName(brainName);
      if (!brain) { sysOut(`unknown brain: ${brainName}`); return true; }
      if (!sessionName) sessionName = nextName(brainName, sessions);
      if (sessions[sessionName]) { sysOut(`session "${sessionName}" already exists`); return true; }
      try {
        const options = {};
        if (brain.homeUrl) {
          sysOut(`opening tab -> ${brain.homeUrl}`);
          options.targetId = await cdp.openTab(brain.homeUrl);
        }
        const emoji = nextEmoji(sessions);
        setSessions(s => ({ ...s, [sessionName]: { brain: brainName, options, emoji } }));
        sysOut(`session "${sessionName}" -> ${emoji} ${brainName}` +
          (options.targetId ? ` (target: ${options.targetId.slice(0, 8)}...)` : '') +
          `\n  address it as @${sessionName} for a single-recipient turn`);
      } catch (e) {
        sysOut(`!! ${e.message}`);
      }
      return true;
    }
    if (cmd === '/chrome') {
      // Explicit spawn. Brain Chrome is no longer auto-spawned at startup;
      // shell only attaches if it finds Chrome already running. /chrome
      // launches a fresh Chrome with the extension loaded under the
      // ~/.egpt/chrome/profiles/brain profile (auto-migrating from the
      // legacy ~/.egpt/egpt-brain on first clean launch).
      await spawnChromeWithExtension();
      return true;
    }
    if (cmd === '/tabs') {
      try {
        const all = await cdp.listTabs();
        const showAll = arg === 'all';
        const isInternal = (u) =>
          u.startsWith('chrome://') || u.startsWith('chrome-extension://') || u.startsWith('devtools://') || u.startsWith('about:');
        const tabs = showAll ? all : all.filter(t => !isInternal(t.url));
        if (!tabs.length) {
          sysOut(showAll ? 'no pages found in brain Chrome' : 'no real pages (try /tabs all to see chrome:// internals)');
          return true;
        }
        const matchBrain = (url) => {
          for (const b of Object.values(BRAINS)) {
            if (b.urlMatch && b.urlMatch.test(url)) return b.name;
          }
          return '(unmapped)';
        };
        const hidden = all.length - tabs.length;
        const header = hidden ? `(${hidden} chrome:// page${hidden > 1 ? 's' : ''} hidden — /tabs all to see)\n` : '';
        // Title-first format: humans recognize titles, not target IDs. URL and
        // shortened ID below for /attach lookup. To attach: /attach chatgpt-cdp <name> <urlOrId>
        sysOut(header + tabs.map(t =>
          `"${t.title || '(untitled)'}"   ·   ${matchBrain(t.url)}\n` +
          `   ${t.url}\n` +
          `   id: ${t.id.slice(0, 8)}`
        ).join('\n\n'));
      } catch (e) { sysOut(`!! ${e.message}`); }
      return true;
    }
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

  // Run the node-global "default brain" persona that responds to @egpt
  // mentions. Lives outside any room — has its own persistent
  // conversation thread saved at ~/.egpt/config.json default_brain.session_id.
  // First call spawns fresh; subsequent calls resume.
  async function runDefaultBrainTurn(text) {
    const dbCfg = EGPT_CONFIG.default_brain ?? { type: 'claude-code' };
    const brainType = canonicalBrainName(dbCfg.type ?? 'claude-code');
    const brain = brainForName(brainType);
    if (!brain) return `!! default brain "${brainType}" not found. /config default_brain {"type":"claude-code"}`;
    const sessionOpts = {
      sessionId: dbCfg.session_id ?? null,
      cwd: dbCfg.cwd ?? process.cwd(),
      sessionName: 'egpt',
      userName: USER_NAME,
    };
    try {
      // Both slots get the user text. claude-code's stream pipes
      // 'history' to stdin in cold-start (no sessionId) and 'message'
      // in resume mode. With history='' we got 'Input must be provided'
      // because --print rejects empty stdin.
      const result = await brain.stream(
        { history: text, message: text },
        () => {},   // no streaming UI for persona; deliver final text only
        sessionOpts,
      );
      const final = typeof result === 'object' ? (result.text ?? '') : (result ?? '');
      const newSessionId = result?.optionsPatch?.sessionId;
      if (newSessionId && newSessionId !== dbCfg.session_id) {
        await persistDefaultBrainSessionId(brainType, newSessionId);
      }
      return final.trim() || '(no reply)';
    } catch (e) {
      return `!! egpt: ${e.message}`;
    }
  }

  async function persistDefaultBrainSessionId(brainType, sessionId) {
    const cfgPath = join(EGPT_HOME, 'config.json');
    let cfg = {};
    try { cfg = JSON.parse(await readFile(cfgPath, 'utf8')); } catch (_) {}
    if (!cfg.default_brain || typeof cfg.default_brain !== 'object') cfg.default_brain = {};
    cfg.default_brain.type = brainType;
    cfg.default_brain.session_id = sessionId;
    EGPT_CONFIG.default_brain = cfg.default_brain;
    try {
      await mkdir(EGPT_HOME, { recursive: true });
      await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    } catch (e) { sysOut(`!! couldn't persist default_brain.session_id: ${e.message}`); }
  }

  // Run a single brain-turn for one session.
  // `messageText` is exactly what gets injected into the brain (or piped to
  // ccode in resume mode). The caller is responsible for prefixing
  // with [author]: when broadcasting or mirroring. Returns the brain's reply
  // text (string) on a substantive answer, or null on silence/error so the
  // caller knows whether to mirror it.
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
      let needsRebind = !opts.targetId;
      if (opts.targetId) {
        try {
          const live = await cdp.findTab(opts.targetId);
          if (!live) needsRebind = true;
        } catch (e) { sysOut(`!! ${routedTo}: ${e.message}`); return; }
      }
      if (needsRebind) {
        try {
          const matches = (await cdp.listTabs()).filter(t => brain.urlMatch.test(t.url));
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

    setStreaming({ author: routedTo, text: '' });

    // If Telegram is connected, send a placeholder message that we'll edit
    // in place as the stream progresses. This gives Telegram users the
    // same "thinking → text" experience as the local shell. The eventual
    // committed item is tagged _localOnly so we don't double-deliver.
    const sessEmoji = sessionMap[routedTo]?.emoji ?? '❓';
    const authorPrefix = `${sessEmoji} <b>${escapeHtml(routedTo)}@${SURFACE_TAG}</b>`;
    // tgChatId / waChatId route the streaming reply to the chat that
    // originated the request. When fromAnyBridge is true we only call
    // the originating bridge; for local typing we call both (each goes
    // to its lastChat).
    const tg = (!fromAnyBridge || tgChatId)
      ? bridgeRef.current?.startStreamMessage?.(`${authorPrefix}\n⌛ thinking…`, { chatId: tgChatId })
      : null;
    // WhatsApp doesn't render HTML — strip tags for the WA stream.
    const waPrefix = `${routedTo}@${SURFACE_TAG}`;
    const wa = (!fromAnyBridge || waChatId)
      ? waBridgeRef.current?.startStreamMessage?.(`${waPrefix}\n⌛ thinking…`, { chatId: waChatId })
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
      const isSilence = /^(\.{3,}|…+)$/.test(trimmed);
      if (isSilence) {
        // Quiet ack: render as the session itself with a single em-dash body,
        // both locally and on Telegram. The local entry carries _localOnly
        // when Telegram already saw the streaming msg, to avoid double-post.
        await tg?.finish(`${authorPrefix}\n—`);
        await wa?.finish(`${waPrefix}\n—`);
        setItems(p => [...p, {
          id: Date.now() + Math.random(), author: routedTo, body: '—',
          _silent: true,
          _localOnly: !!tg || !!wa,
        }]);
        return null;
      }
      // Finalize the streaming bridge messages with the full text. Local
      // item is _localOnly when at least one bridge already received the
      // reply, to avoid double-posting.
      const finalTail = final.length > 3900 ? '…' + final.slice(-3900) : final;
      await tg?.finish(`${authorPrefix}\n${mdToTgHtml(finalTail)}`);
      await wa?.finish(`${waPrefix}\n${final}`);
      setItems(p => [...p, {
        id: Date.now() + Math.random(), author: routedTo, body: final,
        _localOnly: !!tg || !!wa,
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
    outputSinkRef.current = (meta.fromTelegram || meta.fromWhatsApp) ? 'remote' : 'local';
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
    const echoAuthor = (meta.fromTelegram && meta.telegramUser)
      ? `${meta.telegramUser}@telegram[${meta.telegramChatId ?? '?'}]`
      : (meta.fromWhatsApp && meta.waUser)
      ? `${meta.waUser}@whatsapp[${meta.waChatId ?? '?'}]`
      : 'You';
    const isSlashCommand = text.startsWith('/');
    const echoLocalOnly = !!meta.fromTelegram || !!meta.fromWhatsApp || isSlashCommand;
    setItems(p => [...p, {
      id: Date.now() + Math.random(), author: echoAuthor, body: text,
      ...(echoLocalOnly ? { _localOnly: true } : {}),
    }]);

    // Mirror the utterance to peer surfaces on the bus so the room shows
    // the same conversation regardless of which surface someone is looking
    // at. Pure visibility — peer surfaces render the line and do NOT
    // re-route to their brains (we already drove ours below).
    {
      const tid = busTargetIdRef.current;
      if (tid) {
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
        bus.postEvent(tid, {
          type: 'room-utterance', from: BUS_NODE_ID, ts: Date.now(),
          role: 'shell', user: utteranceUser, body: text,
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

    if (decision.kind === 'command') {
      const handled = await handleSlash(text);
      if (!handled) sysOut(`!! unknown command: ${decision.cmd}`);
      return;
    }
    if (decision.kind === 'error') {
      sysOut(`!! ${decision.message}`);
      return;
    }
    if (decision.kind === 'empty') {
      // No local participants. The room may still have peer participants
      // — the room-utterance event already mirrored what was typed, so
      // those peers see it. Only show the "empty room" hint when nobody,
      // local or peer, can hear.
      if (peerNodesRef.current.size === 0) {
        sysOut('the room is empty — /attach to bring in CDP tabs, /open <brain> to register a participant, or /help for slash commands that work without a brain');
      }
      return;
    }
    if (decision.kind === 'idle') {
      // Plain text but no /use'd sessions. The message is already on the
      // bus (room-utterance posted earlier) so peers see it; we just
      // don't auto-call a brain. Hint how to opt in.
      const names = Object.keys(sessions).slice(0, 3).join(', ') || '(none)';
      sysOut(`message stayed in the room — no active brain. Address one with @<name> (e.g. ${names}), or /use <name> (single) or /use a,b,c (multi-AI) for plain-text routing.`);
      return;
    }
    if (decision.kind === 'persona') {
      // @egpt — node-global default brain. Lives outside any room.
      // Persistent thread; replies go back through whichever bridge
      // (if any) carried the request.
      await append(echoAuthor, text);
      setBusy(true);
      try {
        const reply = await runDefaultBrainTurn(decision.body);
        const replyAuthor = `egpt@${SURFACE_TAG}`;
        const fromBridge = !!meta.fromTelegram || !!meta.fromWhatsApp;
        setItems(p => [...p, {
          id: Date.now() + Math.random(),
          author: replyAuthor,
          body: reply,
          // Bridges deliver via direct send below; mark _localOnly
          // when we're routing back to a specific chat so items-flush
          // doesn't double-deliver via lastChat.
          _localOnly: fromBridge,
        }]);
        await append(replyAuthor, reply);
        if (meta.fromTelegram && bridgeRef.current) {
          bridgeRef.current.send(`🤖 <b>egpt</b>\n${mdToTgHtml(reply)}`,
            { chatId: meta.telegramChatId });
        }
        if (meta.fromWhatsApp && waBridgeRef.current) {
          waBridgeRef.current.send(`🤖 egpt: ${reply}`, { chatId: meta.waChatId });
        }
      } finally {
        setBusy(false);
      }
      return;
    }
    if (decision.kind === 'peer-mention') {
      const tid = busTargetIdRef.current;
      if (!tid) { sysOut(`!! bus not joined — can't forward @${decision.target}`); return; }
      await append(echoAuthor, text);
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

    // The .md keeps the original text (including any @mention prefix).
    await append(echoAuthor, text);

    setBusy(true);
    setError(null);

    // Phase A — broadcast/single. Each brain receives just `[<author>]: <message>`
    // (no fancy framing; the brain's tab keeps its own native history).
    // For Telegram-originated input, the brain sees the actual Telegram
    // user instead of the local USER_NAME.
    const brainAuthor = (meta.fromTelegram && meta.telegramUser) ? meta.telegramUser
      : (meta.fromWhatsApp && meta.waUser) ? meta.waUser
      : USER_NAME;
    const messageForBrains = `[${brainAuthor}]: ${userPayload}`;
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
      case 'node-online': {
        peerNodesRef.current.set(ev.from, {
          role: ev.role, sessions: ev.sessions ?? [],
          polling: !!ev.polling, lastSeen: ev.ts ?? Date.now(),
        });
        setPeersRev(r => r + 1);
        log(`bus: peer online ${ev.from}${ev.role ? ` (${ev.role})` : ''}${ev.polling ? ' [polling]' : ''}`);
        // Mutual discovery: pong with our state so the new peer learns about
        // us. pong:true on the reply prevents an infinite ping-pong.
        if (!ev.pong) {
          await post({
            type: 'node-online', role: 'shell', pong: true,
            sessions: Object.entries(sessions).map(([n, s]) => ({ name: n, brain: s.brain })),
            polling: tgPolling,
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
        if (!sessions[ev.target]) {
          await post({ type: 'mention-reply', to_node: ev.from,
            target: ev.target, error: `no session "${ev.target}" on this node`,
            ...(ev.tg_chat_id ? { tg_chat_id: ev.tg_chat_id } : {}) });
          return;
        }
        log(`bus: running ${ev.target} for ${ev.from}${ev.user ? ` (${ev.user})` : ''}`);
        try {
          const reply = await runBrainTurn(ev.target, `[${ev.user ?? 'remote'}]: ${ev.body}`, sessions);
          // Directed reply to the asker (may carry error). Echo
          // tg_chat_id back so the asker can route to the originating
          // Telegram chat instead of the asker's lastChat.
          await post({ type: 'mention-reply', to_node: ev.from,
            target: ev.target, body: reply ?? '',
            ...(ev.tg_chat_id ? { tg_chat_id: ev.tg_chat_id } : {}) });
          // Broadcast reply to the whole room so every peer sees it.
          // The asker also receives this in addition to the directed
          // mention-reply — by design, rooms don't filter messages.
          if (reply !== null && reply !== undefined) {
            await post({ type: 'room-reply', role: 'shell',
              session: ev.target, body: reply });
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
        // Faithful echo of what a user typed on another surface. Pure
        // visibility — we do NOT route this through resolveRoute (the
        // originating surface already routed it to its local brains).
        // ev.via overrides ev.from when the message originated from a
        // side-channel like Telegram (carried by a bus node but not
        // typed at it).
        const tag = `${ev.user ?? 'human'}@${ev.via ?? ev.from ?? 'unknown'}`;
        // _localOnly suppression rule for Telegram forwarding:
        //   * via set: message already exists in that side-channel —
        //     forwarding would echo it back. Skip.
        //   * peer typed a slash command: operations are local to the
        //     issuing surface, not part of the conversation. Skip.
        //   * otherwise: forward (the polling node carries peer chat
        //     to Telegram so viewers see what other surfaces say).
        const body = ev.body ?? '';
        const isPeerSlashCommand = body.trimStart().startsWith('/');
        setItems(p => [...p, {
          id: Date.now() + Math.random(), author: tag, body,
          _localOnly: !!ev.via || isPeerSlashCommand,
        }]);
        return;
      }
      case 'room-reply': {
        // Broadcast brain reply from a peer. Render with session@node
        // tag. Don't filter by asker — see room is noisy by design.
        const tag = `${ev.session ?? '?'}@${ev.from ?? 'unknown'}`;
        setItems(p => [...p, {
          id: Date.now() + Math.random(), author: tag, body: ev.body ?? '',
          _localOnly: true,
        }]);
        return;
      }
      default:
        log(`bus: ${ev.type} from ${ev.from ?? '?'}`);
    }
  };

  const color = a =>
    a === 'You' ? T.authorYou : a === 'system' ? T.authorSystem : T.authorBrain;

  return h(Fragment, null,
    h(Static, { items: withDaySeparators(items) }, item => {
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
      return h(Box, { key: item.id, flexDirection: 'column', marginBottom: 1 },
        h(Text, { color: color(item.author), bold: !item._thinking },
          `${emoji}${label} `,
          item._thinking
            ? h(Text, { color: T.meta }, '(thinking…)')
            : h(Text, { color: T.meta }, `(${time})`)),
          item._thinking
          ? h(Box, { flexDirection: 'column' },
              h(Text, { italic: true }, item.body),
              h(Text, { color: T.meta }, '  ╌╌╌'))
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
        h(Text, { color: T.statusSessions },
          Object.keys(sessions).length
            ? Object.entries(sessions).map(([n, s]) => {
                const star = activeSessions.includes(n) ? '*' : '';
                return `${star}${s.emoji ?? ''}${n}`;
              }).join(' ')
            : '(empty room)')),
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
          `${ch} thinking… `,
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
        h(MultiLineInput, { onSubmit: submit }))));
}

// Module-level bridge reference so SIGINT/SIGHUP handlers can abort the
// long-poll fetch immediately, preventing orphaned egpt processes.
let _globalBridge = null;
const _exitClean = (code = 0) => { _globalBridge?.stop(); process.exit(code); };
process.on('SIGINT',  () => _exitClean(0));
process.on('SIGHUP',  () => _exitClean(0));
process.on('SIGTERM', () => _exitClean(0));

console.log(`egpt | ${FILE}`);
console.log('Enter=newline · Ctrl+D=send · Ctrl+C=exit · /help for commands\n');
render(h(App), { exitOnCtrlC: false });
process.on('exit', () => _globalBridge?.stop());
