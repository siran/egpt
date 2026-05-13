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
import { classifyWhatsAppChat } from './bridges/whatsapp-classify.mjs';
import { recordSession, startNew, rewind, listHistory, summarize, setBrain, isUrlBrain } from './persona-state.mjs';
import { emojiForAuthor as _emojiForAuthor } from './author-emoji.mjs';
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
      onError: (msg) => logOut(`!! telegram: ${msg}`),
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
          logOut(`telegram: outbound chat ${id} captured and saved`);
        } catch (e) {
          setItems(p => [...p, {
            id: Date.now() + Math.random(), author: 'system', _localOnly: true, _log: true,
            body: `!! telegram: could not persist chat_id (${e.message})`,
          }]);
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
  // by jid → { jid, name, idx }. Empty / null means "no WA binding"
  // — the historical single-chat /join was just this with one entry.
  const waJoinedRef = useRef(null);
  // Helpers — keep callers from special-casing the empty / single /
  // multi cases everywhere.
  const _waJoinedAll = () =>
    waJoinedRef.current ? [...waJoinedRef.current.values()] : [];
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
        maxBacklogSeconds: Number(cfg.max_backlog_seconds) || 0,
        // Pass through whatsapp.media to the bridge. Defaults (set
        // inside the bridge) are { download: 'all', max_size_mb: 25 }
        // — every image / video / voice note / document / sticker is
        // saved automatically to ~/.egpt/media/<chat>/<msgId>.<ext>.
        media:             cfg.media ?? {},
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
          // observed chat stays silent.
          const joinedToThis = _waJoinedHas(from.chatId);
          const observeOnly = classifiedObserve && !joinedToThis;
          if (submitRef.current) await submitRef.current(text, {
            fromWhatsApp: true,
            waChatId: from.chatId,
            waUser: from.username ? `@${from.username}` : `wa:${from.userId}`,
            waMsgKey: from.msgKey ?? null,
            waMsgRaw: from.msgRaw ?? null,
            observeOnly,
          });
        },
        onLog:   (msg) => logOut(`whatsapp: ${msg}`),
        onError: (msg) => logOut(`!! whatsapp: ${msg}`),
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
    const joinedTargets = _waJoinedAll().map(e => e.jid);
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
  useEffect(() => {
    // One-time load at mount + on room switch. Wraps in a try because
    // a missing sidecar is expected for fresh rooms.
    (async () => {
      try {
        const map = await _loadReplyTargets(transcriptFileForRoom(currentRoom));
        persistedReplyTargets.current = map;
      } catch {}
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
  const sysOut = body => {
    const sink = outputSinkRef.current;
    const meta = sink === 'local'
      ? { _localOnly: true }
      : { _target: sink };
    setItems(p => [...p, {
      id: Date.now() + Math.random(), author: 'system', body,
      ...meta,
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
      const fmtWaTargets = () => _waJoinedAll()
        .map(e => `@wa${e.idx + 1} "${e.name}"`).join(' + ');
      if (!target) {
        const brains = activeSessions.length ? activeSessions.join(', ') : null;
        const wa = _waJoinedSize() > 0 ? fmtWaTargets() : null;
        const parts = [brains, wa].filter(Boolean);
        sysOut(parts.length
          ? `active recipients: ${parts.join(' + ')}  (plain text fans out to all)`
          : 'no active recipients — plain text stays in the room. /use <name> for a brain, /use @waN for a WA chat. Calls accumulate; /use clear to reset; /unuse <name|@waN> to drop one.');
        return true;
      }
      if (target === 'clear' || target === 'none') {
        setActiveSessions([]);
        _waJoinedClear();
        sysOut('active recipients cleared — plain text no longer auto-routes');
        return true;
      }
      // Comma-separated list = multi-target. Each call ACCUMULATES;
      // /use @wa5 then /use @wa6 = both, which in practice bridges
      // the two chats (Alice in @wa5 mirrors to @wa6 and vice versa).
      // Tokens may be:
      //   <brain-session>   — local session in this room
      //   @waN              — WA chat from the most-recent /channels
      const tokens = target.split(',').map(s => s.trim()).filter(Boolean);
      const waTokens = tokens.filter(t => /^@wa\d+$/i.test(t));
      const brainTokens = tokens.filter(t => !/^@wa\d+$/i.test(t));
      const unknown = brainTokens.filter(n => !sessions[n]);
      if (unknown.length) {
        sysOut(`!! unknown session(s): ${unknown.join(', ')} — /sessions to list`);
        return true;
      }
      // Resolve all WA tokens before mutating state (atomic-ish).
      const waAdds = [];
      for (const t of waTokens) {
        const m = t.match(/^@wa(\d+)$/i);
        const idx = parseInt(m[1], 10) - 1;
        const chat = _waChannelsCacheRef.current[idx];
        if (!chat) {
          sysOut(`!! /use ${t}: no channel at that index. Run /channels first.`);
          return true;
        }
        if (!waBridgeRef.current) {
          sysOut(`!! /use ${t}: whatsapp bridge not running`);
          return true;
        }
        waAdds.push({ jid: chat.jid, name: chat.name, idx });
      }
      // Merge: brains accumulate (no duplicates), WA targets accumulate.
      if (brainTokens.length) {
        const merged = [...new Set([...activeSessions, ...brainTokens])];
        setActiveSessions(merged);
      }
      for (const e of waAdds) _waJoinedAdd(e);
      sysOut(`active recipients -> ${[
        activeSessions.length || brainTokens.length
          ? [...new Set([...activeSessions, ...brainTokens])].join(', ')
          : null,
        _waJoinedSize() > 0 ? fmtWaTargets() : null,
      ].filter(Boolean).join(' + ')}  (plain text fans out to all)`);
      return true;
    }
    if (cmd === '/unuse') {
      // /unuse <name>     remove one brain or @waN from the set
      // /unuse            same as /use clear
      const target = arg.trim();
      if (!target) {
        setActiveSessions([]);
        _waJoinedClear();
        sysOut('active recipients cleared');
        return true;
      }
      const waMatch = target.match(/^@wa(\d+)$/i);
      if (waMatch) {
        const idx = parseInt(waMatch[1], 10) - 1;
        const chat = _waChannelsCacheRef.current[idx];
        if (chat && _waJoinedRemove(chat.jid)) {
          sysOut(`removed @wa${idx + 1} "${chat.name}"`);
        } else {
          sysOut(`!! no @wa${idx + 1} in active recipients`);
        }
        return true;
      }
      if (activeSessions.includes(target)) {
        setActiveSessions(activeSessions.filter(n => n !== target));
        sysOut(`removed "${target}"`);
      } else {
        sysOut(`!! "${target}" not an active recipient`);
      }
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
        // Re-attach behaviour controlled by config (room.on_join):
        //   'lazy'  (default) — saved sessions stay as data; first
        //                       @session use triggers attach
        //   'eager'           — auto-/attach every CDP session by
        //                       opening a tab at its saved url and
        //                       wiring up targetId. Codex / claude-code
        //                       sessions don't need anything spun up
        //                       up-front; they pick up their saved
        //                       session_id / cwd on first turn.
        //   'off'             — keep the room data loaded but don't
        //                       restore sessions at all on join.
        const onJoin = EGPT_CONFIG.room?.on_join ?? 'lazy';
        if (onJoin === 'eager') {
          const targetSessions = roomSessionsMap[target] ?? {};
          const cdpSessions = Object.entries(targetSessions)
            .filter(([, s]) => {
              const b = brainForName(s.brain);
              return b?.urlMatch && s.options?.url;
            });
          if (cdpSessions.length) {
            sysOut(`eager-attach: spinning up ${cdpSessions.length} CDP session(s)…`);
            for (const [name, s] of cdpSessions) {
              try {
                if (!(await cdp.isRunning())) {
                  sysOut('  chrome not reachable — starting…');
                  await spawnChromeWithExtension();
                }
                const tid = await cdp.openTab(s.options.url);
                // Patch this session's options with the live targetId.
                setRoomSessionsMap(rs => {
                  const cur = rs[target] ?? {};
                  const sNow = cur[name] ?? {};
                  const opts = { ...(sNow.options ?? {}), targetId: tid };
                  return { ...rs, [target]: { ...cur, [name]: { ...sNow, options: opts } } };
                });
                sysOut(`  ${s.emoji ?? ''} ${name} → ${s.brain} (tab ${tid.slice(0, 8)}…)`);
              } catch (e) {
                sysOut(`  !! could not attach ${name}: ${e.message}`);
              }
            }
          }
        }
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
    if (cmd === '/egpt') {
      // Manage the @egpt persona's session-history state.
      // Subcommands: status (default), new, list, rewind [n|id-prefix].
      // Pure logic lives in persona-state.mjs (tested in
      // tests/persona-state.test.mjs); this handler is just I/O.
      const parts = arg.trim().split(/\s+/);
      const sub = (parts[0] || 'status').toLowerCase();
      const subArg = parts.slice(1).join(' ').trim();
      const state = readDefaultBrainState();

      if (sub === 'help') {
        sysOut('usage: /egpt [status | new | list | brain <type> [<ref>] | rewind [<n>|<ref-prefix>]]');
        return true;
      }
      if (sub === 'status') {
        const sum = summarize(state);
        const kind = sum.activeKind ? ` (${sum.activeKind})` : '';
        sysOut(`egpt: ${sum.type}${kind}  active=${sum.activeShort}  history=${sum.historyCount}`);
        return true;
      }
      if (sub === 'brain') {
        // /egpt brain                  — show current
        // /egpt brain <type>           — switch type, no ref (next @e fresh)
        // /egpt brain <type> <ref>     — switch + bind to ref (URL or session_id)
        const newType = (parts[1] || '').trim();
        const ref     = parts.slice(2).join(' ').trim();
        if (!newType) {
          const sum = summarize(state);
          sysOut(`egpt brain: ${sum.type}  active=${sum.activeShort}  (use /egpt brain <type> [<ref>] to switch)`);
          return true;
        }
        const canonical = canonicalBrainName(newType);
        const brain = brainForName(canonical);
        if (!brain) { sysOut(`!! /egpt brain: unknown brain "${newType}"`); return true; }
        const next = setBrain(state, canonical, ref || null);
        await persistDefaultBrainState(next);
        const sum = summarize(next);
        sysOut(`egpt: brain → ${sum.type}${sum.activeShort && sum.activeFull ? `  active=${sum.activeShort}` : ' (no ref — next @e starts fresh)'}`);
        return true;
      }
      if (sub === 'list') {
        const list = listHistory(state);
        if (!list.length) { sysOut('egpt: no sessions yet'); return true; }
        const lines = list.map(h => {
          const age = humanAge(h.at);
          const marker = h.isActive ? '*' : ' ';
          return `${marker} ${String(h.index).padStart(2)}  ${h.short}  ${h.type.padEnd(11)}  ${age}`;
        });
        sysOut(['egpt: sessions (newest first, * = active):', ...lines].join('\n'));
        return true;
      }
      if (sub === 'new') {
        const next = startNew(state);
        if (next === state) { sysOut('egpt: already on a fresh state — next @egpt starts a new thread'); return true; }
        await persistDefaultBrainState(next);
        sysOut('egpt: cleared active session — next @egpt starts a new thread');
        return true;
      }
      if (sub === 'rewind') {
        let target = subArg;
        if (target === '') target = 0;
        else if (/^\d+$/.test(target)) target = parseInt(target, 10);
        try {
          const next = rewind(state, target);
          await persistDefaultBrainState(next);
          const sum = summarize(next);
          sysOut(`egpt: rewound to ${sum.activeShort} (${next.type})`);
        } catch (e) {
          sysOut(`!! /egpt rewind: ${e.message}`);
        }
        return true;
      }
      sysOut(`!! /egpt: unknown subcommand "${sub}". usage: /egpt [status | new | list | brain <type> [<ref>] | rewind [<n>|<ref-prefix>]]`);
      return true;
    }
    if (cmd === '/log' || cmd === '/logs') {
      // Show the last N log items (telemetry, room-state hints, debug
      // dumps, peer announces). Default N=30. They're in items[] but
      // hidden from the main render via _log; this slash command
      // surfaces them on demand. Output goes only to the issuer's
      // surface (sysOut respects outputSinkRef _target).
      const n = parseInt(arg.trim(), 10) || 30;
      const logs = items.filter(i => i._log).slice(-n);
      if (!logs.length) { sysOut('(log is empty)'); return true; }
      const lines = logs.map(i => {
        const t = fmtTimeOnly(Math.floor(i.id));
        return `${t}  ${i.body}`;
      });
      sysOut(`── log (last ${logs.length}) ──\n${lines.join('\n')}`);
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
      // in shell; bridge-issued /help goes back to the originating
      // bridge only (not to other bridges).
      const sink = outputSinkRef.current;
      const localityMeta = sink === 'local'
        ? { _localOnly: true }
        : { _target: sink };
      setItems(p => [...p, { id: Date.now() + Math.random(), author: 'system', _bright: true,
        body: prefix + helpText(bt),
        _tgBody: tgPrefix + helpHtml(bt),
        ...localityMeta,
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
    if (cmd === '/channels') {
      // Best-effort fallback: scrape the WA Web chat-list previews
      // from the extension's own browser instance via CDP. baileys'
      // history sync doesn't reliably deliver group message bodies
      // (verified empirically — out of 50 chats only 2 have any
      // recent[] entries even with shouldSyncHistoryMessage:true).
      // The WhatsApp Web DOM is the source of truth for what the
      // user sees on screen; same scrape the extension content
      // script uses, lifted into one Runtime.evaluate call.
      async function scrapeWaWebPreviews() {
        const previews = new Map();
        try {
          const tabs = await cdp.listTabs(/web\.whatsapp\.com/);
          const waTab = tabs[0];
          if (!waTab) return previews;
          const scrape = `({id:'wa', text: JSON.stringify((() => {
            const panel = document.querySelector('[aria-label="Chat list" i]') ||
                          document.querySelector('[role="grid"][aria-label*="Chat" i]');
            if (!panel) return [];
            const rows = panel.querySelectorAll('[role="listitem"], div[role="row"]');
            const out = [];
            for (const row of rows) {
              const titleEl = row.querySelector('span[dir="auto"][title]') ||
                              row.querySelector('span[dir="auto"]');
              const name = (titleEl?.getAttribute('title') || titleEl?.innerText || '').trim();
              if (!name) continue;
              const fullText = row.innerText || '';
              const preview = fullText
                .split('\\n')
                .map(s => s.trim())
                .filter(line => line && line !== name && !/^\\d+ unread/i.test(line))
                .join(' ')
                .slice(0, 200);
              out.push({ name, preview });
              if (out.length >= 50) break;
            }
            return out;
          })())})`;
          const json = await cdp.peekTab(waTab.id, scrape);
          const arr = JSON.parse(json || '[]');
          for (const r of arr) {
            if (r?.name && r.preview) previews.set(r.name, r.preview);
          }
        } catch (_) { /* WA Web tab not reachable; baileys-only output */ }
        return previews;
      }

      const wa = waBridgeRef.current;
      if (!wa) {
        sysOut('!! /channels: whatsapp bridge not running — /whatsapp pair to start');
        return true;
      }
      if (typeof wa.listChats !== 'function') {
        sysOut('!! /channels: this whatsapp bridge build does not expose listChats — update bridges/whatsapp.mjs');
        return true;
      }
      // /channels                 → top 10, 3 recent messages per chat
      // /channels <N>             → top N, 3 recent per chat
      // /channels <N> <M>         → top N, M recent per chat (M=0 = no preview)
      const tokens = arg.trim().split(/\s+/).filter(t => /^\d+$/.test(t)).map(t => parseInt(t, 10));
      const limit           = tokens[0] && tokens[0] > 0 ? tokens[0] : 10;
      const messagesPerChat = tokens[1] != null ? Math.max(0, tokens[1]) : 3;
      // Block the input while we prefetch, list, and scrape — otherwise
      // the prompt comes back before the channel list and the user can
      // type a follow-up against stale @waN indices. Spinner shows
      // 'building channel list…' instead of the default 'thinking…' so
      // the operator knows what they're waiting on.
      setBusyLabel('building channel list…');
      setBusy(true);
      try {
        // Prefetch deeper history for the top-N chats that have an
        // anchor message. Anchored chats fetch ~M older messages each
        // via sock.fetchMessageHistory; the returned messages arrive
        // through messaging-history.set asynchronously. Wait briefly
        // for those events to settle, then render. Chats without any
        // anchor (recent[] empty) can't be fetched and just render
        // empty — they'll fill once any real message arrives.
        if (typeof wa.prefetchHistoryForTopChats === 'function' && messagesPerChat > 0) {
          const want = Math.max(messagesPerChat, 5);
          try {
            const r = await wa.prefetchHistoryForTopChats({ chatLimit: limit, perChat: want });
            if (r?.requested > 0) {
              // Give baileys a beat to deliver the messages over the
              // WS before we read _chats again. 1.5s is empirically
              // enough for a single round-trip; if the user's network
              // is slow they can just /channels again.
              await new Promise(r => setTimeout(r, 1500));
            }
          } catch (_) { /* fall through; render what we have */ }
        }
        const chats = await wa.listChats({ limit, messagesPerChat });
        if (!chats.length) {
          sysOut('/channels: no chats found (baileys not synced yet — give it a moment after /whatsapp start, or just wait for the first message)');
          return true;
        }
        // Fetch WA Web previews in parallel with the listChats result.
        // Used as a fallback for chats where baileys has no recent[].
        const webPreviews = messagesPerChat > 0
          ? await scrapeWaWebPreviews()
          : new Map();
        // Cache the listing so @waN refers back to the same index the
        // user just saw. Reset on each /channels so the user can
        // re-list and have indexes line up with the freshest view.
        _waChannelsCacheRef.current = chats;
        const ageLabel = (ts) => {
          const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
          if (s < 60)    return `${s}s ago`;
          if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
          if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
          return `${Math.floor(s / 86400)}d ago`;
        };
        // Try to match WA Web's chat-list names to baileys's chat
        // names. baileys's name comes from group subjects / pushName;
        // WA Web's comes from the rendered <header> title. Usually
        // identical; in rare cases (truncation, encoding) they differ.
        // Strip trailing "(You)" suffix we added for self-DMs since
        // WA Web doesn't carry it in the row.
        const lookupWebPreview = (name) => {
          if (!name) return null;
          const stripped = name.replace(/\s+\(You\)\s*$/, '').trim();
          return webPreviews.get(name) ?? webPreviews.get(stripped) ?? null;
        };
        const blocks = chats.map((c, i) => {
          const tag = c.isGroup ? '[group]' : '[1:1]';
          const age = c.lastActivityTs > 0
            ? ageLabel(c.lastActivityTs)
            : (c.creationTs > 0 ? `dormant, created ${ageLabel(c.creationTs)}` : 'dormant');
          const header = `  @wa${i + 1}  ${tag.padEnd(7)} ${c.name}  (${age})`;
          if (!messagesPerChat) return header;
          // Prefer baileys-captured per-message lines when we have them.
          if (Array.isArray(c.recent) && c.recent.length) {
            const previewLines = c.recent.map(r => {
              const speaker = r.author ?? '?';
              const oneLine = (r.text ?? '').replace(/\s+/g, ' ').trim();
              const trimmed = oneLine.length > 80 ? oneLine.slice(0, 79) + '…' : oneLine;
              return `      [${speaker}] ${trimmed}`;
            });
            return [header, ...previewLines].join('\n');
          }
          // Fallback: WA Web's single-line chat-list preview. Marked
          // [last] so the user knows it's a one-line summary, not the
          // per-message breakdown baileys would give.
          const webPrev = lookupWebPreview(c.name);
          if (webPrev) {
            const trimmed = webPrev.length > 120 ? webPrev.slice(0, 119) + '…' : webPrev;
            return `${header}\n      [last via WA Web] ${trimmed}`;
          }
          return header;
        });
        sysOut(`chats (top ${chats.length}, baileys, most-active first):\n${blocks.join('\n')}\n\nuse @wa<N> <message> to send to one of these.`);
      } catch (e) {
        sysOut(`!! /channels: ${e.message}`);
      } finally {
        setBusy(false);
        setBusyLabel(null);
      }
      return true;
    }
    if (cmd === '/join') {
      // /join @waN — bind shell-typed plain text to chat N from the
      // most recent /channels listing. After /join, every plain message
      // typed in shell is sent straight to that chat (in addition to
      // any local routing). Echoed locally so the operator sees the
      // line; the wa-items-mirror skips it (_directWa) so it doesn't
      // also land in the self-DM mirror target.
      const m = text.trim().match(/^\/join\s+@wa(\d+)\s*$/i);
      if (!m) {
        sysOut('usage: /join @waN     (N from /channels)');
        return true;
      }
      const idx = parseInt(m[1], 10) - 1;
      const chat = _waChannelsCacheRef.current[idx];
      if (!chat) {
        sysOut(`!! /join: no @wa${idx + 1} in cache — run /channels first`);
        return true;
      }
      if (!waBridgeRef.current) {
        sysOut('!! /join: whatsapp bridge not running');
        return true;
      }
      // /join accumulates same as /use @waN. Previous single-target
      // behaviour is preserved when called once; calling again adds
      // a second target rather than replacing.
      _waJoinedAdd({ jid: chat.jid, name: chat.name, idx });
      // Broadcast on the bus so peers with whatsapp.follow_join enabled
      // adopt. (Each /join announces just the entry being added; peers
      // who opt to follow can choose to accumulate or replace per
      // their own policy.)
      {
        const tid = busTargetIdRef.current;
        if (tid) {
          bus.postEvent(tid, {
            type: 'wa-join', from: BUS_NODE_ID, ts: Date.now(),
            jid: chat.jid, name: chat.name,
          }).catch(() => {});
        }
      }
      sysOut(`joined @wa${idx + 1} "${chat.name}" — plain messages now route here. ` +
        (_waJoinedSize() > 1 ? `Currently ${_waJoinedSize()} WA chats joined (bridged). ` : '') +
        `/unjoin to release${_waJoinedSize() > 1 ? ' all, /unjoin @waN to drop one' : ''}.`);
      return true;
    }
    if (cmd === '/unjoin') {
      const target = arg.trim();
      if (!_waJoinedSize()) {
        sysOut('/unjoin: not joined');
        return true;
      }
      if (target) {
        const m = target.match(/^@wa(\d+)$/i);
        if (!m) { sysOut('usage: /unjoin [@waN]   (omit to release all)'); return true; }
        const idx = parseInt(m[1], 10) - 1;
        const chat = _waChannelsCacheRef.current[idx];
        if (!chat || !_waJoinedRemove(chat.jid)) {
          sysOut(`!! @wa${idx + 1} not currently joined`);
          return true;
        }
        const tid = busTargetIdRef.current;
        if (tid) {
          bus.postEvent(tid, {
            type: 'wa-join', from: BUS_NODE_ID, ts: Date.now(), jid: null,
            removed: chat.jid,
          }).catch(() => {});
        }
        sysOut(`released @wa${idx + 1} "${chat.name}"  (${_waJoinedSize()} remaining)`);
        return true;
      }
      const all = _waJoinedAll();
      _waJoinedClear();
      const tid = busTargetIdRef.current;
      if (tid) {
        bus.postEvent(tid, {
          type: 'wa-join', from: BUS_NODE_ID, ts: Date.now(), jid: null,
        }).catch(() => {});
      }
      sysOut(`released ${all.length === 1
        ? `@wa${all[0].idx + 1} "${all[0].name}"`
        : `${all.length} WA chats`}`);
      return true;
    }
    if (cmd === '/wa-pending') {
      // Held pre-connect messages — messages baileys delivered after a
      // reconnect but whose timestamp predated connectedAt by more
      // than whatsapp.max_backlog_seconds. These would otherwise have
      // auto-dispatched (potentially running the brain on a stale @e
      // request from before the daemon was even up). The hold-and-
      // review flow makes that decision the operator's instead.
      //   /wa-pending                   — list
      //   /wa-pending dispatch <idx>    — dispatch one (replays
      //                                   through handleMessage)
      //   /wa-pending dispatch all      — dispatch every held message
      //   /wa-pending clear             — discard all without dispatch
      const wa = waBridgeRef.current;
      if (!wa || typeof wa.listHeld !== 'function') {
        sysOut('!! /wa-pending: whatsapp bridge not running');
        return true;
      }
      const parts = arg.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0];
      if (!sub) {
        const held = wa.listHeld();
        if (!held.length) { sysOut('(no held messages)'); return true; }
        const ageLabel = (ts) => {
          const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
          if (s < 60)    return `${s}s ago`;
          if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
          if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
          return `${Math.floor(s / 86400)}d ago`;
        };
        const lines = held.map(h => {
          const who = h.author ?? (h.jid?.split('@')[0] ?? '?');
          const preview = h.text.length > 100 ? h.text.slice(0, 99) + '…' : h.text;
          return `  [${h.idx}] ${who} (${ageLabel(h.ts)}): ${preview}`;
        });
        sysOut(`held ${held.length} pre-connect message(s):\n${lines.join('\n')}\n\n` +
               `/wa-pending dispatch <idx>   dispatch one through the brain pipeline\n` +
               `/wa-pending dispatch all     dispatch every held message\n` +
               `/wa-pending clear            discard without dispatch`);
        return true;
      }
      if (sub === 'clear') {
        const n = wa.clearHeld();
        sysOut(`discarded ${n} held message(s)`);
        return true;
      }
      if (sub === 'dispatch') {
        const which = parts[1];
        if (!which) { sysOut('usage: /wa-pending dispatch <idx|all>'); return true; }
        if (which === 'all') {
          const held = wa.listHeld();
          let ok = 0, fail = 0;
          // Walk indices high-to-low so splice in dispatchHeld doesn't
          // renumber entries we haven't gotten to yet.
          for (let i = held.length - 1; i >= 0; i--) {
            const r = await wa.dispatchHeld(i);
            if (r.ok) ok++; else fail++;
          }
          sysOut(`dispatched ${ok}/${held.length}${fail ? `  (${fail} failed)` : ''}`);
          return true;
        }
        const idx = parseInt(which, 10);
        if (!Number.isInteger(idx)) { sysOut(`!! /wa-pending dispatch: "${which}" is not a number`); return true; }
        const r = await wa.dispatchHeld(idx);
        sysOut(r.ok ? `dispatched [${idx}]` : `!! dispatch [${idx}] failed: ${r.reason}`);
        return true;
      }
      sysOut('usage: /wa-pending [dispatch <idx|all> | clear]');
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
          `\n/whatsapp start               start the bridge with existing auth (use this first)` +
          `\n/whatsapp pair                ONLY when auth is expired/invalid: wipe + show new QR` +
          `\n/whatsapp disconnect          stop the bridge (auth preserved)` +
          `\n/whatsapp allow <number>      authorize a phone number for commands` +
          `\n/whatsapp revoke <number>     remove authorization` +
          `\n/whatsapp allowed             list authorized numbers`);
        return true;
      }
      if (sub === 'start' || sub === 'connect') {
        // Non-destructive: reuse existing auth. Shell auto-runs this
        // on boot via the useEffect that calls startWaBridge(); this
        // command is for manually re-connecting after /whatsapp
        // disconnect, or for kicking a stuck startup, without paying
        // the cost of a re-pair when auth is still valid.
        if (waBridgeRef.current) { sysOut('whatsapp: already running'); return true; }
        const ok = await startWaBridge(false);
        if (!ok) sysOut('whatsapp: start failed — auth may be missing. Run /whatsapp pair to (re-)pair.');
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
      //
      // Three input forms now supported:
      //   /config <key> <val>             — top-level key (e.g. node_name)
      //   /config <key>.<sub> <val>       — nested key inside a top-level
      //                                     block (e.g. whatsapp.client_name moto)
      //   /config <subkey> <val>  (from a bridge) — when typed via
      //                                     telegram or whatsapp, an
      //                                     unknown bare key is interpreted
      //                                     as the bridge's nested key —
      //                                     '/config client_name moto'
      //                                     from WA = whatsapp.client_name.
      const parts = arg.trim().split(/\s+/);
      let key = parts[0];
      const rawVal = parts.slice(1).join(' ');
      let localCfg = {};
      try { localCfg = JSON.parse(readFileSync(LOCAL_CONFIG_PATH, 'utf8')); } catch {}
      if (!key) {
        // One block per key: current value (or '(unset)') + description.
        // Sourced from the local config when present, otherwise the
        // in-memory EGPT_CONFIG (default / inherited). Helps the
        // operator discover what's available without grep-ing.
        const lines = [`config  (${dp(LOCAL_CONFIG_PATH)}):`, ''];
        for (const [k, desc] of Object.entries(CONFIG_SCHEMA)) {
          const hasLocal = Object.prototype.hasOwnProperty.call(localCfg, k);
          const live = EGPT_CONFIG[k];
          const valStr = hasLocal
            ? JSON.stringify(localCfg[k])
            : (live !== undefined ? `${JSON.stringify(live)}  (default)` : '(unset)');
          lines.push(`  ${k} = ${valStr}`);
          lines.push(`    ${desc}`);
          lines.push('');
        }
        lines.push('usage:');
        lines.push('  /config <key> [val]              top-level (e.g. /config user_name An)');
        lines.push('  /config <key>.<sub> [val]        nested (e.g. /config whatsapp.mirror_headers brain_only)');
        sysOut(lines.join('\n'));
        return true;
      }
      // Bridge-context inference: if the user is on whatsapp/telegram
      // and typed a bare key that doesn't match a top-level slot,
      // assume they meant <bridge>.<key>. This matches the user's
      // intuition of 'I'm typing from WA, so I'm configuring WA'.
      if (!key.includes('.') && !(key in CONFIG_SCHEMA)) {
        if (meta.fromWhatsApp) key = `whatsapp.${key}`;
        else if (meta.fromTelegram) key = `telegram.${key}`;
      }
      // Split into top-level + nested sub-key if dotted.
      const dotIdx = key.indexOf('.');
      const topKey = dotIdx > 0 ? key.slice(0, dotIdx) : key;
      const subKey = dotIdx > 0 ? key.slice(dotIdx + 1) : null;
      if (!(topKey in CONFIG_SCHEMA)) {
        const valid = Object.keys(CONFIG_SCHEMA).join(', ');
        sysOut(`!! unknown config key: ${key}\nvalid keys: ${valid}`);
        return true;
      }
      if (!rawVal) {
        const top = localCfg[topKey] ?? EGPT_CONFIG[topKey];
        const v = subKey ? top?.[subKey] : top;
        sysOut(v !== undefined ? `${key}: ${JSON.stringify(v)}` : `${key}: (not set)`);
        return true;
      }
      let val;
      try { val = JSON.parse(rawVal); } catch { val = rawVal; }
      // Apply: nested writes preserve the rest of the block.
      if (subKey) {
        const block = (typeof localCfg[topKey] === 'object' && localCfg[topKey] !== null)
          ? localCfg[topKey] : {};
        block[subKey] = val;
        localCfg[topKey] = block;
      } else {
        localCfg[topKey] = val;
      }
      try {
        await mkdir(dirname(LOCAL_CONFIG_PATH), { recursive: true });
        await writeFile(LOCAL_CONFIG_PATH, JSON.stringify(localCfg, null, 2) + '\n');
        // Mirror into the in-memory EGPT_CONFIG so handlers downstream
        // see the change without a restart.
        if (subKey) {
          if (typeof EGPT_CONFIG[topKey] !== 'object' || EGPT_CONFIG[topKey] === null) {
            EGPT_CONFIG[topKey] = {};
          }
          EGPT_CONFIG[topKey][subKey] = val;
        } else {
          EGPT_CONFIG[topKey] = val;
        }
      } catch (e) { sysOut(`!! config write: ${e.message}`); return true; }
      if (topKey === 'theme' && !subKey) {
        Object.assign(T, loadTheme(val));
        _currentTheme = val;
        setThemeRev(n => n + 1);
      }
      if (topKey === 'user_name' && !subKey) {
        // Live-update USER_NAME so the next brain dispatch / status
        // render uses the new handle without requiring a shell
        // restart. Reflected in subsequent '[handle@node ts]:'
        // brain headers, status line, item author labels, etc.
        USER_NAME = String(val);
      }
      if (topKey === 'show_prompts' && !subKey) _showPrompts = !!val;
      if (topKey === 'node_name' && !subKey) {
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
              wa: !!waBridgeRef.current,
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
      // /last is a VIEW command — re-renders the tail of the transcript
      // in the current shell. Its output must NOT mirror to bridges
      // (we'd flood TG/WA with N old messages) and must NOT be
      // re-appended to the transcript file (those messages are already
      // there; re-appending would duplicate them). Both protections
      // happen here: the re-injected items get _localOnly to keep
      // them out of the items-mirror, and _suppressTranscriptRef
      // makes sysOut + echo skip the append.queue during this command.
      const n = parseInt(arg, 10) || 10;
      _suppressTranscriptRef.current = true;
      try {
        const text = await readFile(FILE, 'utf8');
        const msgs = parseMessages(text).slice(-n);
        if (!msgs.length) { sysOut('(no messages yet)'); return true; }
        sysOut(`--- last ${msgs.length} message(s) from ${dp(FILE)} ---`);
        setItems(p => [...p, ...msgs.map((m, i) => ({
          id: Date.now() + i / 1000,
          author: m.author,
          body: m.body,
          _localOnly: true,           // don't mirror these old lines to bridges
        }))]);
      } catch (e) { sysOut(`!! ${e.message}`); }
      finally { _suppressTranscriptRef.current = false; }
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
        const brainPad = (s.brain ?? '?').padEnd(13);
        const brain = brainForName(s.brain);
        // s.options may be missing on sessions loaded from older yamls
        // that stored brain-specific fields flat at the top level.
        // normalizeSessions on load handles this for fresh restores,
        // but stay defensive here so a stale shape never crashes the
        // shell.
        const opts = s.options ?? {};
        let detail = '';
        if (opts.targetId) {
          const live = tabsByid.get(opts.targetId);
          detail = live ? `"${live.title || '(untitled)'}"` : `(tab gone — ${opts.targetId.slice(0, 8)}...)`;
        } else if (opts.sessionId) {
          const idShort = opts.sessionId.slice(0, 8) + '...';
          detail = s.brain === 'codex' ? `thread: ${idShort}` : `claude --resume ${idShort}`;
        } else if (opts.url) {
          detail = opts.url.replace(/^https?:\/\//, '');
        } else if (brain?.stateDetail) {
          detail = brain.stateDetail(opts);
        }
        if (opts.profileName) {
          detail = [`profile: ${opts.profileName}`, detail].filter(Boolean).join(' | ');
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
        sysOut(`Saved rooms in ${dp(dir)}:\n${files.map(f => `  ${f.replace('.yaml', '')}`).join('\n')}\n\n/room join <name> to enter (and restore its sessions)`);
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
    if (cmd === '/mirror') {
      // /mirror @<target> [mN ...] [--tagged | --no-tag]
      //   Forward existing items' bodies to a destination — no brain
      //   dispatch on WA target; @<session> re-dispatches as if the
      //   body were freshly typed. Default item is the last visible
      //   non-system; explicit mNs pick specific items (in order).
      //   Tagged prefixing (config: mirror.tagged, default 'on')
      //   wraps each body with '[author timestamp]: '. --no-tag /
      //   --tagged override per-call.
      const parts = arg.split(/\s+/).filter(Boolean);
      const flagOn = parts.includes('--tagged') || parts.includes('-t');
      const flagOff = parts.includes('--no-tag') || parts.includes('--no-tagged');
      const positional = parts.filter(t => !t.startsWith('-'));
      const target = positional[0];
      const msgRefs = positional.slice(1);
      const tagDefault = (EGPT_CONFIG.mirror?.tagged ?? 'on') !== 'off';
      // Per-call override wins. Both set → --no-tag wins (off is safer
      // than accidentally surprising a destination with attribution).
      const useTag = flagOff ? false : flagOn ? true : tagDefault;
      if (!target || !target.startsWith('@')) {
        sysOut('usage: /mirror @<target> [mN [mN …]] [--tagged | --no-tag]\n  @waN          forward to WA chat (from /channels)\n  @<session>    re-dispatch the body to that brain as fresh input\n  mN [mN …]     specific item ids; omitted = last visible message\n  --tagged      prefix bodies with [author timestamp]: (overrides config)\n  --no-tag      send bodies raw (overrides config)');
        return true;
      }
      // Resolve items to forward. Empty msgRefs = pick last visible.
      const itemsToForward = [];
      if (msgRefs.length) {
        for (const r of msgRefs) {
          const m = r.match(/^m?(\d+)$/i);
          if (!m) { sysOut(`!! /mirror: "${r}" isn't an mN id`); return true; }
          const it = itemByShortId.current.get(`m${m[1]}`);
          if (!it) { sysOut(`!! /mirror: no message m${m[1]} in this session`); return true; }
          itemsToForward.push(it);
        }
      } else {
        for (let i = items.length - 1; i >= 0; i--) {
          const it = items[i];
          if (it._log) continue;
          if (it._localOnly) continue;
          if (it.author === 'system') continue;
          itemsToForward.push(it);
          break;
        }
        if (!itemsToForward.length) { sysOut('!! /mirror: nothing to mirror (no recent non-system message)'); return true; }
      }
      // Build the body for each item per the tag policy.
      //   'You'    → USER_NAME@SURFACE_TAG (current local handle)
      //   'system' → 'egpt'                (keep it terse)
      //   already qualified (cgpt1@kg, An@moto) → as-is
      const fmtTaggedAuthor = (a) => {
        if (a === 'You') return `${USER_NAME}@${SURFACE_TAG}`;
        if (a === 'system') return 'egpt';
        return a;
      };
      const bodyFor = (it) => {
        const raw = it.body ?? '';
        if (!useTag) return raw;
        return `[${fmtTaggedAuthor(it.author)} ${fmtTs(Math.floor(it.id))}]: ${raw}`;
      };
      // Dispatch by target type.
      const waMatch = target.match(/^@wa(\d+)$/i);
      if (waMatch) {
        const idx = parseInt(waMatch[1], 10) - 1;
        const chat = _waChannelsCacheRef.current[idx];
        if (!chat) { sysOut(`!! /mirror @wa${idx + 1}: no channel at that index. /channels first.`); return true; }
        const wa = waBridgeRef.current;
        if (!wa) { sysOut('!! /mirror: whatsapp bridge not running'); return true; }
        for (const it of itemsToForward) {
          const body = bodyFor(it);
          if (!body.trim()) { sysOut(`!! /mirror: m? body is empty, skipping`); continue; }
          try {
            const r = await wa.send(body, { chatId: chat.jid });
            const preview = body.length > 80 ? body.slice(0, 79) + '…' : body;
            sysOut(`→ /mirror @wa${idx + 1} "${chat.name}":\n  ${preview.replace(/\n/g, '\n  ')}`);
            // Attach the mirror's WA key to the ORIGINAL item's
            // _replyTarget so a later '@m<original> reply' fans out
            // to this destination chat too. Multi-target ready —
            // existing single → array; existing array → push.
            if (r?.key) {
              const existing = it._replyTarget;
              const newTgt = { kind: 'wa', chatId: chat.jid, key: r.key, raw: { conversation: body } };
              const merged = Array.isArray(existing) ? [...existing, newTgt]
                : existing ? [existing, newTgt]
                : newTgt;
              it._replyTarget = merged;
              _scheduleReplyTargetSave();
            }
          } catch (e) { sysOut(`!! /mirror @wa${idx + 1}: ${e.message}`); }
        }
        return true;
      }
      // @<session> — re-dispatch the body to that brain. Joins
      // multiple items into one prompt so the brain sees the full
      // thread in order. Tag policy applies to the prompt
      // (with-tag = '[cgpt1@kg 20:00 EDT]: …' chunks; no-tag = bare).
      const sessionName = target.slice(1);
      if (sessions[sessionName]) {
        const senderTag = `${USER_NAME}@${SURFACE_TAG}`;
        const bodies = itemsToForward.map(bodyFor).join('\n\n');
        const prompt = `[${senderTag} ${ts()}]: ${bodies}`;
        sysOut(`→ /mirror @${sessionName}  (${itemsToForward.length} item${itemsToForward.length === 1 ? '' : 's'})`);
        await runBrainTurn(sessionName, prompt, sessions);
        return true;
      }
      sysOut(`!! /mirror: target "${target}" not recognised. @waN or @<session>.`);
      return true;
    }
    if (cmd === '/identity') {
      // /identity [@<session>]    re-install the identity manifest
      // /identity                 inject into ALL active sessions
      //                           + the @e default brain
      // /identity show            print the identity file to shell
      // Forces injection regardless of the previously-set
      // identityInjected flag. Useful after editing e_identity.md
      // (or whatever brains.identity points at) so the brains pick
      // up the new content.
      const a = arg.trim();
      const identity = await _loadIdentity();
      if (!identity) {
        sysOut(`!! /identity: no identity file (brains.identity = "${EGPT_CONFIG.brains?.identity ?? './e_identity.md'}", set or check path; "off" disables)`);
        return true;
      }
      if (a === 'show') {
        sysOut(identity);
        return true;
      }
      const targets = [];
      if (a.startsWith('@')) {
        const name = a.slice(1);
        if (name === 'e' || name === 'egpt') targets.push({ kind: 'persona' });
        else if (sessions[name]) targets.push({ kind: 'session', name });
        else { sysOut(`!! /identity: no session "${name}"`); return true; }
      } else if (!a) {
        targets.push({ kind: 'persona' });
        for (const n of Object.keys(sessions)) targets.push({ kind: 'session', name: n });
      } else {
        sysOut('usage: /identity [@<session> | @e | show]');
        return true;
      }
      for (const t of targets) {
        if (t.kind === 'persona') {
          // Force the install into the @e persona's CURRENT thread
          // (don't wipe url / session_id — that'd lose continuity).
          // Build the same sessionOpts runDefaultBrainTurn would.
          const dbCfg = EGPT_CONFIG.default_brain ?? { type: 'claude-code' };
          const brainType = canonicalBrainName(dbCfg.type ?? 'claude-code');
          const brain = brainForName(brainType);
          if (!brain) { sysOut(`!! @e: brain ${brainType} not found`); continue; }
          let sessionOpts;
          if (isUrlBrain(brainType)) {
            // Resolve the existing thread URL → live targetId so the
            // install lands in the right tab.
            let targetId = null;
            try {
              const tabs = await cdp.listTabs(brain.urlMatch);
              const m = dbCfg.url ? tabs.find(t => t.url === dbCfg.url || t.url.startsWith(dbCfg.url)) : null;
              if (m) targetId = m.id;
            } catch {}
            sessionOpts = { targetId };
          } else {
            sessionOpts = {
              sessionId: dbCfg.session_id ?? null,
              cwd: dbCfg.cwd ?? process.cwd(),
              sessionName: 'egpt',
              userName: USER_NAME,
              ...(brainType === 'ccode'    ? { allowedTools: dbCfg.allowed_tools ?? 'all' } : {}),
              ...(dbCfg.system_prompt      ? { appendSystemPrompt: dbCfg.system_prompt   } : {}),
            };
          }
          await _injectIdentityIntoPersona({ brain, sessionOpts, dbCfg, forced: true });
        } else {
          const s = sessions[t.name];
          if (!s) continue;
          const brain = brainForName(s.brain);
          if (!brain) { sysOut(`!! /identity @${t.name}: brain ${s.brain} not found`); continue; }
          await _injectIdentityIfNeeded({
            routedTo: t.name, session: s, brain, opts: s.options ?? {}, forced: true,
          });
        }
      }
      return true;
    }
    if (cmd === '/handle') {
      // Two forms:
      //   /handle <new>          — change YOUR OWN handle (user_name).
      //                            Same as '/config user_name <new>'
      //                            but feels like the right command
      //                            to reach for. Operator's '/handle An'
      //                            in the wild used to land here and
      //                            see 'usage: /handle <old> <new>'
      //                            with no hint about the actual fix.
      //   /handle <old> <new>    — rename a brain session. Preserves
      //                            brain, emoji, options, bio.
      const parts = arg.split(/\s+/).filter(Boolean);
      if (parts.length === 1) {
        const handle = parts[0];
        if (!/^[A-Za-z0-9_-]+$/.test(handle)) {
          sysOut('handle must be alphanumeric (- and _ ok)');
          return true;
        }
        return handleSlash(`/config user_name ${handle}`, meta);
      }
      if (parts.length !== 2) {
        sysOut('usage:\n  /handle <new>            change your own handle (user_name)\n  /handle <old> <new>      rename a brain session');
        return true;
      }
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
      // Smart pre-flight: when /attach is invoked without the
      // prerequisites in place, set them up rather than bouncing the
      // operator through 4–5 commands. Lobby → auto-create+join a
      // room named after the session arg; Chrome unreachable →
      // auto-spawn; no matching tab → auto-open one.
      let targetRoom = currentRoom;
      if (currentRoom === 'default') {
        const lobbyParts = arg.split(/\s+/).filter(Boolean);
        const lobbyBrain = canonicalBrainName(lobbyParts[0]);
        const lobbySessName = lobbyParts[1] && brainForName(lobbyBrain) ? lobbyParts[1] : null;
        const autoRoomName = lobbySessName || lobbyBrain || 'work';
        const otherRooms = Object.keys(roomSessionsMap).filter(r => r !== 'default' && r !== autoRoomName);
        if (otherRooms.length) {
          const list = otherRooms.map(r => {
            const sess = roomSessionsMap[r] ?? {};
            const members = Object.entries(sess).map(([n, s]) => `${s.emoji ?? ''}${n}/${s.brain}`).join(', ') || '(empty)';
            return `  · ${r}  (${members})`;
          }).join('\n');
          sysOut(`other rooms available — /room join <name> to resume one with its sessions:\n${list}`);
        }
        if (!roomSessionsMap[autoRoomName]) {
          setRoomSessionsMap(rs => ({ ...rs, [autoRoomName]: {} }));
          sysOut(`auto-created room "${autoRoomName}"`);
        }
        setCurrentRoom(autoRoomName);
        setActiveSessions([]);
        sysOut(`joined room "${autoRoomName}" — continuing /attach`);
        targetRoom = autoRoomName;
      }
      // Shadow sessions/setSessions to write into targetRoom — the React
      // setCurrentRoom above takes effect on the next render, but the
      // rest of /attach runs RIGHT NOW. Without the shadow, attach
      // writes would still go to the lobby.
      const sessions = roomSessionsMap[targetRoom] ?? {};
      const setSessions = (updater) => {
        setRoomSessionsMap(rs => {
          const cur = rs[targetRoom] ?? {};
          const next = typeof updater === 'function' ? updater(cur) : updater;
          return { ...rs, [targetRoom]: next };
        });
      };
      // Auto-spawn Chrome if it isn't reachable. This is heavy but the
      // operator has opted out of the confirmation prompt via
      // whatsapp.follow_join / the discussion log; if the brain needs
      // CDP and Chrome isn't there, spawning is the only forward path.
      const wantsCdp = brainForName(canonicalBrainName(arg.split(/\s+/)[0]))?.urlMatch != null;
      if (wantsCdp && !(await cdp.isRunning())) {
        sysOut('chrome not reachable — starting it with the extension…');
        try { await spawnChromeWithExtension(); }
        catch (e) { sysOut(`!! chrome start failed: ${e.message}`); return true; }
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
            let tabs = (await cdp.listTabs()).filter(t => brain.urlMatch.test(t.url));
            if (tabs.length === 0 && brain.homeUrl) {
              // Auto-open: cheap, expected next step. Without this, the
              // operator gets bounced to /open then back to /attach.
              sysOut(`no ${brainName} tab open — opening ${brain.homeUrl}…`);
              try {
                const tid = await cdp.openTab(brain.homeUrl);
                options.targetId = tid;
              } catch (e) { sysOut(`!! could not open ${brainName} tab: ${e.message}`); return true; }
              // Skip the multiple-tabs branch since we just opened the
              // single one we want.
              tabs = [];
            }
            if (tabs.length === 0 && !options.targetId) { sysOut(`no open ${brainName} tabs to attach. try /open ${brainName} to open one.`); return true; }
            if (tabs.length > 1) {
              const lst = tabs.map(t => `  "${t.title}" — ${t.url}`).join('\n');
              sysOut(`multiple ${brainName} tabs open. specify which:\n${lst}\nuse: /attach ${brainName} ${sessionName} <urlOrUuidOrId>`);
              return true;
            }
            if (tabs.length === 1) options.targetId = tabs[0].id;
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

  // Identify the persona prompt with the originating surface, chat,
  // and user — claude-code needs context to know "who am I talking to
  // and where" since the same thread spans WA / TG / shell / extension.
  // The body the user typed is below the identifier. Without this, an
  // @egpt question from a friend's DM looks indistinguishable from a
  // self-DM or shell input, and replies lose their conversational
  // anchoring across the play.
  function formatPersonaPrompt(meta, body) {
    if (meta.fromTelegram) {
      const user = meta.telegramUser ?? 'someone';
      const chat = meta.telegramChatId ?? 'unknown';
      return `[in Telegram chat ${chat}, ${user} said:]\n${body}`;
    }
    if (meta.fromWhatsApp) {
      const user = meta.waUser ?? 'someone';
      const chat = meta.waChatId ?? 'unknown';
      return `[in WhatsApp chat ${chat}, ${user} said:]\n${body}`;
    }
    return `[from shell:]\n${body}`;
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
      const mStableMatch = !mShortMatch && text.match(/^@((?:wa|tg|b|u|s|p)-[A-Za-z0-9-]+)\s+([\s\S]+)$/i);
      if (mShortMatch || mStableMatch) {
        let shortId, body, target, rt;
        if (mShortMatch) {
          shortId = `m${mShortMatch[1]}`;
          body = mShortMatch[2].trim();
          target = itemByShortId.current.get(shortId);
          if (!target) {
            sysOut(`!! ${shortId}: no message with that id in this session — try @<stable-id> for cross-session reference`);
            return;
          }
          rt = target._replyTarget;
        } else {
          const stableId = mStableMatch[1];
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
                sysOut(`!! @${stableId}: ambiguous, matches ${matches.length} ids:\n  ${matches.slice(0, 5).join('\n  ')}${matches.length > 5 ? `\n  …` : ''}`);
                return;
              }
            }
          }
          if (!rt) {
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
        if (waTargets.length) {
          const wa = waBridgeRef.current;
          for (const t of waTargets) {
            if (!wa?.replyTo) {
              try { wa?.send?.(body, { chatId: t.chatId }); }
              catch (e) { sysOut(`!! @${shortId} wa send failed: ${e.message}`); }
            } else {
              try { await wa.replyTo({ chatId: t.chatId, key: t.key, raw: t.raw, text: body }); }
              catch (e) { sysOut(`!! @${shortId} wa reply failed: ${e.message}`); }
            }
          }
        }
        if (tgTargets.length) {
          const tg = bridgeRef.current;
          for (const t of tgTargets) {
            if (tg) {
              try { tg.send(body, { chatId: t.chatId, replyTo: t.msgId }); }
              catch (e) { sysOut(`!! @${shortId} tg reply failed: ${e.message}`); }
            }
          }
        }
        if (waTargets.length || tgTargets.length) {
          // Echo + record locally so the transcript has the reply too.
          setItems(p => [...p, {
            id: Date.now() + Math.random(), author: 'You',
            body: `↳ @${shortId}\n${body}`,
            _directWa: !!waTargets.length,
            _localOnly: !waTargets.length && !!tgTargets.length,
          }]);
          void append('You', `↳ @${shortId}\n${body}`);
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
          // Echo with reply context preserved (don't rewrite as
          // '@cgpt1 …' — the operator typed '@m<N>' and the
          // transcript should reflect that intent).
          setItems(p => [...p, {
            id: Date.now() + Math.random(), author: 'You',
            body: `↳ @${shortId}\n${body}`,
          }]);
          void append('You', `↳ @${shortId}\n${body}`);
          // Brain prompt: include the quoted message + qualified
          // sender header. Brain has no concept of m-ids, so we
          // resolve to the actual previous text.
          const quoted = (target.body ?? '').split('\n')[0].slice(0, 280);
          const senderTag = `${USER_NAME}@${SURFACE_TAG}`;
          const brainPrompt = `[${senderTag} ${ts()}]: > ${quoted}\n${body}`;
          await runBrainTurn(targetSession, brainPrompt, sessions);
          return;
        }
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
    const echoAuthor = (meta.fromTelegram && meta.telegramUser)
      ? `${stripAt(meta.telegramUser)}@${tgClient}`
      : (meta.fromWhatsApp && meta.waUser)
      ? `${stripAt(meta.waUser)}@${waClient}`
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
        const client = fromTg ? tgClient : fromWa ? waClient : null;
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
        // Capture each send's returned key so '@m<N>' on the echo
        // item can reply-to-self via a proper WA quote. Sends are
        // awaited in parallel — they don't block each other.
        const settled = await Promise.allSettled(
          _waJoinedAll().map(entry => wa.send(text, { chatId: entry.jid })
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
        } else if (meta.fromWhatsApp && waBridgeRef.current) {
          waBridgeRef.current.send(`${EGPT_PERSONA_EMOJI} egpt: ${reply}`,
            { chatId: meta.waChatId });
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
      ? `${stripAt(meta.waUser)}@${waClient}.${SURFACE_TAG}`
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
      const stableDisp = stableId ? ` ${stableId.length > 14 ? stableId.slice(0, 13) + '…' : stableId}` : '';
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
