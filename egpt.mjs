#!/usr/bin/env node
// egpt.mjs — file IS the conversation; Ink shell; sessions = named participants
import React from 'react';
import { render, Box, Text, Static, useInput, useApp } from 'ink';
import YAML from 'yaml';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { readFile, writeFile, appendFile, readdir, stat, open, mkdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import * as ccode from './brains/claude-code.mjs';
import * as codex from './brains/codex.mjs';
import * as chatgptCdp from './brains/chatgpt-cdp.mjs';
import * as claudeCdp from './brains/claude-cdp.mjs';
import * as cdp from './brains/cdp.mjs';
import { startTelegramBridge } from './bridges/telegram.mjs';

const { createElement: h, useState, useEffect, useRef, Fragment } = React;
const APP_DIR = dirname(fileURLToPath(import.meta.url));
const EGPT_HOME = join(homedir(), '.egpt');

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
  return [...Object.keys(BRAINS), ...aliases].join(', ');
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

function buildSendFilePrepPrompt({ sourcePath, preparedPath, targetName, instruction }) {
  const sourceHint = sourcePath
    ? sourcePath
    : '(none provided; infer/find the source file from the preparation instruction, cwd, and nearby repo context)';
  return [
    `[system]: Prepare a local file excerpt for egpt to paste into @${targetName}.`,
    '',
    `Source path or search hint from the user:`,
    sourceHint,
    '',
    `Preparation instruction from the user:`,
    instruction,
    '',
    `Write the prepared excerpt to this exact UTF-8 Markdown file path:`,
    preparedPath,
    '',
    `Rules:`,
    `- Resolve the user's source path/search hint yourself. If no path was provided, find the intended file from the instruction and local repo context.`,
    `- If a relative path or fuzzy source hint is provided, use your current cwd and nearby repo context.`,
    `- Preserve exact source text for the selected excerpt. Do not summarize unless the user explicitly requested a summary.`,
    `- For natural instructions like "before chapter 8", identify the heading/marker in the source and include content before that chapter.`,
    `- Do not include the excerpt in your reply.`,
    `- After writing the file, reply with exactly one short line: prepared: ${preparedPath}`,
  ].join('\n');
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

const FILE = cliArg ?? './conversation.md';

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

const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 16);
const append = (who, body) => appendFile(FILE, `## ${ts()} — ${who}\n${body}\n\n`);
const fmtTs = (ms) => {
  const d = new Date(ms);
  return `${d.getMonth()+1}/${d.getDate()}/${d.getFullYear()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
};

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

// Render an item for the Telegram chat. Uses HTML parse_mode (not Markdown
// — brains often emit markdown that breaks Telegram's strict MarkdownV2).
// system messages render in italic, user/sessions get an emoji + bold name.
function formatItemForTelegram(item, sessions) {
  const body = escapeHtml(item.body);
  if (item.author === 'system') return `${EGPT_EMOJI} <i>${body}</i>`;
  if (item.author === 'You') return `${USER_EMOJI} <b>${escapeHtml(USER_NAME)}</b>\n${body}`;
  const sess = sessions[item.author];
  const emoji = sess?.emoji ?? '❓';
  return `${emoji} <b>${escapeHtml(item.author)}</b>\n${body}`;
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
  // sessions: map of participant-name → { brain: brainName, options: {...} }
  // The room starts empty — egpt is the host, not a participant. Use /open
  // or /attach to bring brains in. Auto-attach at startup picks up CDP tabs
  // if Chrome is already running.
  const [sessions, setSessions] = useState({});
  // Elapsed-time tracking so the user has progress feedback during the
  // brain's pre-generation "thinking" phase (which can be 5-15s for a long
  // conversation file). When busy goes true we record the start; an interval
  // bumps `now` every 250ms to drive re-renders.
  const [busyStart, setBusyStart] = useState(null);
  const [now, setNow] = useState(Date.now());
  const { exit } = useApp();

  // Refs so background bridges (Telegram) can call submit() and forward new
  // items without depending on render closures. submitRef updated each render.
  const submitRef = useRef(null);
  const bridgeRef = useRef(null);
  const wizardRef = useRef(null);
  const sentItemsCountRef = useRef(0);

  useEffect(() => {
    if (!busy) { setBusyStart(null); return; }
    setBusyStart(Date.now());
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [busy]);

  // Start Telegram bridge once if ~/.egpt/config.json has telegram.bot_token.
  // Bridge calls submitRef.current(text) on incoming Telegram messages and
  // we forward every new item from `items` back to the chat (see effect below).
  useEffect(() => {
    let bridge = null;
    (async () => {
      let cfg;
      try { cfg = JSON.parse(await readFile(join(homedir(), '.egpt', 'config.json'), 'utf8')); }
      catch { return; }
      if (!cfg.telegram?.bot_token) return;
      bridge = startTelegramBridge({
        botToken: cfg.telegram.bot_token,
        allowedUsers: cfg.telegram.allowed_users ?? [],
        chatId: cfg.telegram.chat_id ?? null,
        onIncoming: async (text, from) => {
          const who = from.username || from.firstName || `tg:${from.userId}`;
          // Local-only system note so the shell viewer sees Telegram traffic
          // arriving. Tagged so it isn't echoed back to the Telegram user
          // (they sent the message; they don't need to see the arrival
          // notification).
          setItems(p => [...p, {
            id: Date.now() + Math.random(), author: 'system',
            body: `(telegram message from ${who}) → ${text}`,
            _localOnly: true,
          }]);
          if (submitRef.current) await submitRef.current(text, { fromTelegram: true });
        },
        onLog:   (msg) => setItems(p => [...p, { id: Date.now() + Math.random(), author: 'system', body: `telegram: ${msg}`, _localOnly: true }]),
        onError: (msg) => setItems(p => [...p, { id: Date.now() + Math.random(), author: 'system', body: `!! telegram: ${msg}`, _localOnly: true }]),
      });
      bridgeRef.current = bridge;
      _globalBridge = bridge;
      setItems(p => [...p, { id: Date.now() + Math.random(), author: 'system', body: 'telegram bridge enabled', _localOnly: true }]);
    })();
    return () => { bridge?.stop(); _globalBridge = null; };
  }, []);

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

  // Startup auto-attach: if Chrome is already running with chatgpt/claude tabs
  // open, register each as a session with an auto-generated name (cgpt1,
  // claude1, etc.) so they're addressable as @cgpt1, @claude1, ... right away.
  // Silently does nothing if Chrome isn't running.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const tabs = await cdp.listTabs();
        if (cancelled) return;
        let working = {};
        const additions = {};
        for (const tab of tabs) {
          if (isInternalUrl(tab.url)) continue;
          const brainName = brainForUrl(tab.url);
          if (!brainName) continue;
          // skip if the targetId is already attached
          if (Object.values(working).some(s => s.options?.targetId === tab.id)) continue;
          const name = nextName(brainName, working);
          const emoji = nextEmoji(working);
          additions[name] = { brain: brainName, options: { targetId: tab.id }, emoji };
          working[name] = additions[name];
        }
        if (Object.keys(additions).length > 0 && !cancelled) {
          setSessions(s => ({ ...s, ...additions }));
          const summary = Object.entries(additions)
            .map(([n, s]) => `${s.emoji} ${n} (${s.brain})`).join(', ');
          setItems(p => [...p, {
            id: Date.now() + Math.random(), author: 'system',
            body: `auto-attached ${Object.keys(additions).length} tab(s): ${summary}`,
          }]);
        }
      } catch { /* Chrome not running — empty room, fine */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Top-level escape hatch: Ctrl+R force-resets state when the brain hangs.
  // The in-flight WebSocket / subprocess is orphaned (will eventually GC)
  // but the UI returns control. Last-resort, not a graceful cancel.
  useInput((input, key) => {
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
    setItems(p => [...p, { id: Date.now() + Math.random(), author: 'system', body }]);

  async function injectSummary(name, target = null, sessionMap = sessions) {
    const path = summaryPath(name);
    const body = await readFile(path, 'utf8');
    const note = `[injected summary "${name}" from ${path}${target ? ` into ${target}` : ''}]\n\n${body.trim()}`;
    await append('system', note);
    setItems(p => [...p, { id: Date.now() + Math.random(), author: 'system', body: note }]);
    if (target) {
      await runBrainTurn(
        target,
        `[system]: Please absorb this injected context for future turns. Reply with exactly "..." unless you need to report a problem.\n\n${note}`,
        sessionMap,
      );
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
        sysOut(`profile "${data.name}" saved → ${profilePath}\n\n  /attach ${data.name}        start it\n  /profiles                 list all profiles`);
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
      const activeSessions = { ...sessions, [sessionName]: session };
      setSessions(activeSessions);
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
            const { body } = await injectSummary(summaryName, sessionName, activeSessions);
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
    if (cmd === '/file') { sysOut(FILE); return true; }
    if (cmd === '/help') {
      setItems(p => [...p, { id: Date.now() + Math.random(), author: 'system', _bright: true, body: [
        '── ROOM ─────────────────────────────────────────────',
        '<message>          broadcast to every session (each may reply or send "...")',
        '@<name> <message>  address one session only (still logged in the .md)',
        '/rules             write room rules into the file (silence, @, politeness)',
        '/last [N]          tail N messages from the file (default 10)',
        '/file              show current conversation file path',
        '/exit              quit egpt',
        '',
        '── SESSIONS ─────────────────────────────────────────',
        '/sessions          list active sessions with emoji, brain, tab/thread',
        '/rooms             list saved rooms',
        '/save-room [name]  save current sessions + tabs to ~/.egpt/rooms/<name>.yaml',
        '/open <brain> [name]               open a fresh tab + register session',
        '/attach                            re-scan Chrome, attach new tabs',
        '/attach <brain> [name] [tabSpec]   attach specific brain/tab',
        '/attach <profile>                  start a YAML brain profile',
        '/detach <name>     remove from room (brain keeps running)',
        '/handle <old> <new>                rename a session',
        '/emoji [<name> <emoji>]            show/set avatar emoji',
        '/bio [<name> [text]]               show/set session bio (echoed in room)',
        '',
        '── BRAIN PROFILES (~/.egpt/brains/*.yaml) ───────────',
        '/profiles                          list all YAML profiles',
        '/create-profile [name]             interactive wizard — asks type, model,',
        '                   effort, cwd, url, emoji, bio; saves the YAML file',
        '/profile <name> <url-or-id>        quick-create profile from ChatGPT/Claude URL',
        '/attach <profile> [session-name]   start profile (optional session name override)',
        'Profile fields: name · type (codex|ccode|cdp_chat|cdp_claude)',
        '                model · effort (low|medium|high) · cwd · url',
        '                emoji · bio · summary (codex thread name)',
        '',
        '── BROWSER BRAINS (CDP) ─────────────────────────────',
        '/brain [status|stop]               Chrome lifecycle',
        '/tabs [all]        list pages in brain Chrome',
        '/refresh [@<name>] CDP: re-poll tab, append latest text (use if stream cut off)',
        '                   operator: replay last user message → fresh response',
        '/mirror                            last non-You message → all other CDP tabs',
        '/mirror @<tgt>                     last non-You message → one target',
        '/mirror @<src> @<tgt>              <src>\'s last message → <tgt>',
        '                   src: session name or @egpt (= system/egpt messages)',
        '                   tgt: active CDP session name',
        '/send-file [via=<op>] [<path>] @<session> ["<instruction>"] [--ask "<q>"]',
        '                   operator prepares/excerpts file, pastes into session',
        '/paste-file <session> <path> [--before/--after/--ask "<q>"]',
        '                   paste raw file or excerpt directly (no operator)',
        '',
        '── OPERATORS (local CLI: ccode / codex) ─────────────',
        '/history [N]                       list recent ccode sessions on disk (default 10)',
        '/session <name> [<id>|none] [cwd]  resume/clear a ccode session',
        '                   <name> = ccode session name; omit if only one ccode in room',
        '                   <id>   = session UUID or prefix from /history',
        '                   none   = back to stateless (re-reads file each turn)',
        '@codex exec: <cmd> run a shell command in codex\'s cwd',
        '@codex exec: cd <dir>              change codex\'s persistent cwd',
        '',
        '── SUMMARIES (~/.egpt/summaries/) ───────────────────',
        '/summarize [all|last N] <name> [brain]',
        '                   fresh agent reads room, writes summary',
        '/save <name>       save latest non-system message verbatim',
        '/summaries         list saved summaries  (alias: /list-saved)',
        '/inject <name> [session]           drop summary into room or one session',
        '',
        '── REFERENCE ────────────────────────────────────────',
        'tabSpec: full URL · UUID · targetId · 6+ char prefix',
        'Brains:  ' + brainNamesForHelp(),
        '─────────────────────────────────────────────────────',
      ].join('\n') }]);
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
        sysOut(`profile "${profile.name}" saved -> ${path}\n  type: ${profile.type}\n  url: ${profile.url}\n  attach with: /attach ${profile.name}`);
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
            sysOut(`prepared path is not a file: ${directPreparedPath}`);
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
              `${directPreparedPath}\n` +
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
          await runBrainTurn(
            via,
            buildSendFilePrepPrompt({
              sourcePath: parsed.path,
              preparedPath,
              targetName: parsed.targetName,
              instruction: parsed.instruction,
            }),
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
            `${preparedPath}\n` +
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
      sysOut(`${target}.sessionId → ${sid}` +
             (expandedFromPrefix ? '  (expanded from prefix)' : '') +
             (cwd ? `\n${target}.cwd → ${cwd}` + (detectedCwd ? '  (auto-detected from JSONL)' : '') : '\n(no cwd; pass one if claude --resume fails)') +
             `\n(claude --resume mode active for ${target})`);
      return true;
    }
    if (cmd === '/rules') {
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
      await append('system', rules);
      setItems(p => [...p, { id: Date.now(), author: 'system', body: rules }]);
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
      sysOut(`mirroring [${source}] → ${targets.join(', ')}\n${mkMirrorPreview(lastBody)}`);
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
      //   Operator:   replay the last user message that was addressed to (or
      //               broadcast to) this session — triggers a fresh response.
      const target = arg.trim().replace(/^@/, '');
      let session, sessionName;
      if (target) {
        if (!sessions[target]) { sysOut(`no session named "${target}"`); return true; }
        sessionName = target; session = sessions[target];
      } else {
        const cdps = Object.entries(sessions).filter(([_, s]) => brainForName(s.brain)?.urlMatch);
        if (cdps.length !== 1) {
          sysOut(`usage: /refresh [@<session>]\n  ${cdps.length === 0 ? 'no CDP sessions in the room' : `multiple CDP sessions — specify one: ${cdps.map(([n]) => n).join(', ')}`}`);
          return true;
        }
        sessionName = cdps[0][0]; session = cdps[0][1];
      }
      const brain = brainForName(session.brain);
      if (brain?.peek) {
        // CDP path: re-poll tab
        try {
          const text = await brain.peek(session.options);
          if (!text || !text.trim()) { sysOut('(tab has no assistant message right now)'); return true; }
          setItems(p => [...p, { id: Date.now(), author: sessionName, body: text }]);
          await append(sessionName, text);
          sysOut(`(refreshed ${sessionName} from tab — appended to file)`);
        } catch (e) { sysOut(`!! ${e.message}`); }
      } else {
        // Operator path: replay last user message sent to (or broadcast to) this session
        const fileText = await readFile(FILE, 'utf8');
        const msgs = parseMessages(fileText);
        const lastUserMsg = [...msgs].reverse().find(m =>
          m.author === 'You' &&
          (!m.body.startsWith('@') || m.body.startsWith(`@${sessionName} `) || m.body.startsWith(`@${sessionName}\n`))
        );
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
        sysOut(`saved → ${summaryPath(name)}\n  (${last.body.length} chars from ${last.author})`);
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
            : 'fresh chatgpt-cdp tab → claude-cdp → fresh ccode') + '\n' +
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
        const prompt =
          `Please summarize this conversation faithfully. ` +
          `Preserve participants, key decisions, and any open questions or loose threads. ` +
          `Aim for under 600 words. Plain markdown, no preamble. ` +
          `Output ONLY the summary text — no "Here is the summary:" boilerplate.\n\n` +
          `---\n\n${formatted}`;

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
        sysOut(`saved → ${summaryPath(name)}  (${summary.length} chars)`);
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
    if (cmd === '/brain') {
      const sub = (arg.split(/\s+/)[0] || 'status').toLowerCase();
      if (sub === 'status') {
        try {
          const tabs = await cdp.listTabs();
          sysOut(`brain running on ${cdp.cdpHost} · ${tabs.length} pages`);
        } catch (e) {
          sysOut(`brain not reachable on ${cdp.cdpHost}: ${e.message}`);
        }
        return true;
      }
      if (sub === 'stop' || sub === 'close') {
        try {
          await cdp.closeBrowser();
          sysOut('brain closed');
        } catch (e) {
          sysOut(`!! ${e.message}`);
        }
        return true;
      }
      sysOut('usage: /brain [status|stop]');
      return true;
    }
    if (cmd === '/sessions') {
      // Best-effort: if a session has a targetId, look up the live tab title
      // and show that. Falls back to just the targetId if Chrome isn't reachable.
      let tabsByid = new Map();
      try {
        const tabs = await cdp.listTabs();
        for (const t of tabs) tabsByid.set(t.id, t);
      } catch { /* Chrome not running — that's fine for non-CDP sessions */ }

      const rows = Object.entries(sessions).map(([name, s]) => {
        const emojiPad = (s.emoji ?? '❓') + ' ';
        const namePad = name.padEnd(14);
        const brainPad = s.brain.padEnd(13);
        const brain = brainForName(s.brain);
        let detail = '';
        if (s.options.targetId) {
          const live = tabsByid.get(s.options.targetId);
          detail = live ? `"${live.title || '(untitled)'}"` : `(tab gone — ${s.options.targetId.slice(0, 8)}…)`;
        } else if (s.options.sessionId) {
          detail = `claude --resume ${s.options.sessionId.slice(0, 8)}…`;
        } else if (brain?.stateDetail) {
          detail = brain.stateDetail(s.options);
        }
        if (s.options.profileName) {
          detail = [`profile: ${s.options.profileName}`, detail].filter(Boolean).join(' | ');
        }
        const bio = s.bio ? `\n  bio: ${s.bio}` : '';
        return `${emojiPad}${namePad}${brainPad}${detail}${bio}`;
      });
      sysOut(rows.join('\n') || '(none)');
      return true;
    }
    if (cmd === '/rooms') {
      try {
        const dir = join(homedir(), '.egpt', 'rooms');
        let files = [];
        try { files = (await readdir(dir)).filter(f => f.endsWith('.yaml')); } catch {}
        if (!files.length) { sysOut(`(no saved rooms)\n  /save-room <name> to save current room`); return true; }
        sysOut(`Saved rooms in ${dir}:\n${files.map(f => `  ${f.replace('.yaml', '')}`).join('\n')}\n\n/load-room <name> to restore`);
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
        sysOut(`room "${roomName}" saved → ${roomFile}`);
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
        body: `${target} avatar → ${emoji}`,
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
               'brains: ' + brainNamesForHelp() +
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
          sysOut(`session "${name}" â†’ ${emoji} ${brainName}` +
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
      sysOut(`session "${sessionName}" → ${emoji} ${brainName}` +
        (options.targetId ? ` (tab ${options.targetId.slice(0, 8)}…)` : '') +
        `\n  address it as @${sessionName} for a single-recipient turn`);
      return true;
    }
    if (cmd === '/open') {
      const parts = arg.split(/\s+/);
      const brainName = canonicalBrainName(parts[0]);
      let sessionName = parts[1];
      if (!brainName) {
        sysOut('usage: /open <brain> [name]\n  name auto-generated (e.g. cgpt2) if omitted.\n  brains: ' + brainNamesForHelp());
        return true;
      }
      const brain = brainForName(brainName);
      if (!brain) { sysOut(`unknown brain: ${brainName}`); return true; }
      if (!sessionName) sessionName = nextName(brainName, sessions);
      if (sessions[sessionName]) { sysOut(`session "${sessionName}" already exists`); return true; }
      try {
        const options = {};
        if (brain.homeUrl) {
          sysOut(`opening tab → ${brain.homeUrl}`);
          options.targetId = await cdp.openTab(brain.homeUrl);
        }
        const emoji = nextEmoji(sessions);
        setSessions(s => ({ ...s, [sessionName]: { brain: brainName, options, emoji } }));
        sysOut(`session "${sessionName}" → ${emoji} ${brainName}` +
          (options.targetId ? ` (target: ${options.targetId.slice(0, 8)}…)` : '') +
          `\n  address it as @${sessionName} for a single-recipient turn`);
      } catch (e) {
        sysOut(`!! ${e.message}`);
      }
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

  // Run a single brain-turn for one session.
  // `messageText` is exactly what gets injected into the brain (or piped to
  // ccode in resume mode). The caller is responsible for prefixing
  // with [author]: when broadcasting or mirroring. Returns the brain's reply
  // text (string) on a substantive answer, or null on silence/error so the
  // caller knows whether to mirror it.
  async function runBrainTurn(routedTo, messageOrObj, sessionMap = sessions) {
    const messageText = typeof messageOrObj === 'string' ? messageOrObj : (messageOrObj?.message ?? '');
    const askText    = typeof messageOrObj === 'string' ? null : (messageOrObj?.ask ?? null);
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
    const authorPrefix = `${sessEmoji} <b>${escapeHtml(routedTo)}</b>`;
    const tg = bridgeRef.current?.startStreamMessage?.(`${authorPrefix}\n⌛ thinking…`);
    const tgFmt = (text) => {
      // Show only the trailing ~3500 chars during streaming so it fits in
      // Telegram's 4096-char message cap (even with our prefix).
      const tail = text.length > 3500 ? '…' + text.slice(-3500) : text;
      return `${authorPrefix}\n${escapeHtml(tail)} ⌛`;
    };

    try {
      const history = await readFile(FILE, 'utf8');
      const result = await brain.stream(
        { history, message: messageText, ask: askText },
        partial => {
          setStreaming({ author: routedTo, text: partial });
          tg?.update(tgFmt(partial));
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
      const isSilence = /^(\.{3,}|…+)$/.test(trimmed);
      if (isSilence) {
        // Quiet ack: render as the session itself with a single em-dash body,
        // both locally and on Telegram. The local entry carries _localOnly
        // when Telegram already saw the streaming msg, to avoid double-post.
        await tg?.finish(`${authorPrefix}\n—`);
        setItems(p => [...p, {
          id: Date.now() + Math.random(), author: routedTo, body: '—',
          _silent: true,
          _localOnly: !!tg,
        }]);
        return null;
      }
      // Finalize the streaming Telegram msg with the full text. The local
      // item carries _localOnly when Telegram already received it via the
      // streaming edit, to avoid sending the reply twice.
      const finalTail = final.length > 3900 ? '…' + final.slice(-3900) : final;
      await tg?.finish(`${authorPrefix}\n${escapeHtml(finalTail)}`);
      setItems(p => [...p, {
        id: Date.now() + Math.random(), author: routedTo, body: final,
        _localOnly: !!tg,
      }]);
      await append(routedTo, final);
      return final;
    } catch (e) {
      setStreaming(null);
      await tg?.finish(`${authorPrefix}\n!! ${escapeHtml(e.message)}`);
      sysOut(`!! ${routedTo}: ${e.message}`);
      return null;
    }
  }

  const submit = async (raw, meta = {}) => {
    const text = raw.trim();
    if (!text) return;

    // Wizard mode: /create-profile interactive questions intercept all input.
    if (wizardRef.current) {
      setItems(p => [...p, { id: Date.now(), author: 'You', body: text }]);
      wizardRef.current.answer(text);
      return;
    }

    // Echo everything the user types into the transcript. If the input came
    // from Telegram, tag the echo _localOnly so it doesn't get sent back to
    // the same Telegram user — they already saw their own message in their
    // app. Echoes from the local shell still forward to Telegram so a
    // remote viewer sees what the shell user typed.
    setItems(p => [...p, {
      id: Date.now(), author: 'You', body: text,
      ...(meta.fromTelegram ? { _localOnly: true } : {}),
    }]);

    if (text.startsWith('/')) {
      const handled = await handleSlash(text);
      if (handled) return;
    }

    // Routing:
    //   - "@name ..." → that single session only. The full text (with @name
    //     prefix) lands in the .md; only the addressed brain's tab gets the
    //     payload injected.
    //   - any other message → broadcasts to every session in the room (CDP
    //     brains and local operators alike). Each may reply or stay silent
    //     per the polite-silence convention.
    const mention = text.match(/^@(\S+)(?:\s+([\s\S]*))?$/);
    let activeSessions = sessions;
    let recipients;
    let userPayload;
    if (mention) {
      const token = mention[1];
      let target = resolveAddressedSession(token, activeSessions);
      const brainName = canonicalBrainName(token);
      const brain = brainForName(token);
      if (!target && brain && !brain.urlMatch) {
        const emoji = nextEmoji(activeSessions);
        const sessionName = nextName(brainName, activeSessions);
        activeSessions = {
          ...activeSessions,
          [sessionName]: { brain: brainName, options: { cwd: process.cwd() }, emoji },
        };
        setSessions(activeSessions);
        sysOut(`session "${sessionName}" -> ${emoji} ${brainName} (auto-opened for @${token})`);
        target = sessionName;
      }
      if (target) {
        recipients = [target];
        userPayload = (mention[2] ?? '').trim() || '?';
      } else if (brain) {
        const matches = Object.entries(activeSessions)
          .filter(([_, s]) => canonicalBrainName(s.brain) === brainName)
          .map(([n]) => n);
        sysOut(matches.length
          ? `@${token} is ambiguous; address one of: ${matches.join(', ')}`
          : `no ${token} session; /open ${token} [name]`);
        return;
      } else {
        recipients = Object.keys(activeSessions);
        userPayload = text;
      }
    } else {
      recipients = Object.keys(activeSessions);
      userPayload = text;
    }
    if (recipients.length === 0) {
      // Egpt is the room itself; with nobody in it, just echo back. Slash
      // commands still work for managing files, sessions, summaries, etc.
      // We don't append the user's text to .md here — nothing to address it
      // to, and the transcript becomes confusing if it has lone messages.
      sysOut('the room is empty — /attach to bring in CDP tabs, /open <brain> to register a participant, or /help for slash commands that work without a brain');
      return;
    }

    // The .md keeps the original text (including any @mention prefix).
    await append('You', text);

    setBusy(true);
    setError(null);

    // Phase A — broadcast/single. Each brain receives just `[An]: <message>`
    // (no fancy framing; the brain's tab keeps its own native history).
    const messageForBrains = `[${USER_NAME}]: ${userPayload}`;
    if (recipients.length > 1) {
      sysOut(`broadcasting to ${recipients.length} session(s): ${recipients.join(', ')}`);
    }
    const replies = [];
    for (const recipient of recipients) {
      const reply = await runBrainTurn(recipient, messageForBrains, activeSessions);
      if (reply !== null) replies.push({ author: recipient, text: reply });
    }

    // Phase B — one-hop mirror among CDP recipients. When brain B replied
    // substantively, push "[B]: <reply>" into every OTHER CDP brain's tab so
    // they see it. Receiving brains may reply or stay silent (per /rules).
    // We do NOT mirror the secondary replies; cascade is bounded to one hop.
    const cdpRecipients = recipients.filter(r => brainForName(activeSessions[r]?.brain)?.urlMatch);
    if (cdpRecipients.length > 1 && replies.length > 0) {
      const mirrorables = replies.filter(r => brainForName(activeSessions[r.author]?.brain)?.urlMatch);
      if (mirrorables.length > 0) {
        sysOut(`mirroring ${mirrorables.length} reply/replies to other CDP brains…`);
        for (const { author, text: replyText } of mirrorables) {
          const mirrorMsg = `[${author}]: ${replyText}`;
          for (const other of cdpRecipients) {
            if (other === author) continue;
            await runBrainTurn(other, mirrorMsg, activeSessions);
          }
        }
      }
    }

    setBusy(false);
  };

  // Keep the bridge's reference to submit() up to date with each render so
  // background message arrivals always run against the current closure.
  submitRef.current = submit;

  const color = a =>
    a === 'You' ? 'cyan' : a === 'system' ? 'gray' : 'green';

  return h(Fragment, null,
    h(Static, { items }, item => {
      const isSystem = item.author === 'system';
      const isUser = item.author === 'You';
      const sess = sessions[item.author];
      const emoji = isSystem ? `${EGPT_EMOJI} ` : isUser ? `${USER_EMOJI} ` : sess?.emoji ? `${sess.emoji} ` : '';
      const label = isUser ? USER_NAME : item.author;
      const time = fmtTs(Math.floor(item.id));
      return h(Box, { key: item.id, flexDirection: 'column', marginBottom: 1 },
        h(Text, { color: color(item.author), bold: true },
          `${emoji}${label} `, h(Text, { color: 'gray', dimColor: true }, `(${time})`)),
          item._bright
          ? h(Box, { flexDirection: 'column' },
              ...item.body.split('\n').map((line, i) => {
                if (/^──/.test(line)) return h(Text, { key: i, color: 'cyan', bold: true }, line);
                if (/^[/@<]/.test(line)) return h(Text, { key: i, color: 'yellow' }, line);
                if (/^\s{2,}/.test(line)) return h(Text, { key: i, color: 'gray' }, line);
                if (line === '') return h(Text, { key: i }, ' ');
                return h(Text, { key: i }, line);
              }))
          : h(Text, { italic: isSystem, dimColor: isSystem }, item.body));
    }),
    h(Box, { flexDirection: 'column', marginTop: 1 },
      h(Text, null,
        h(Text, { color: 'cyan', bold: true }, `${EGPT_EMOJI} egpt`),
        h(Text, { color: 'gray' }, `  ${basename(FILE)}  `),
        h(Text, { color: 'gray', dimColor: true },
          Object.keys(sessions).length
            ? Object.entries(sessions).map(([n, s]) => `${s.emoji ?? ''}${n}`).join(' ')
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
          h(Text, { color: 'green', bold: true },
            `${sessions[streaming.author]?.emoji ? sessions[streaming.author].emoji + ' ' : ''}${streaming.author}  `,
            h(Text, { color: 'gray', dimColor: true },
              `(${charCount} chars · ${elapsed}s · Ctrl+R to abort)`)),
          hidden > 0 && h(Text, { color: 'gray', dimColor: true },
            `… ${hidden} earlier line${hidden > 1 ? 's' : ''} hidden …`),
          h(Text, null, tail + '▎'));
      })(),
      busy && !streaming?.text && (() => {
        // While the brain is processing input but hasn't started streaming
        // yet, show an elapsed counter and a spinner so the UI looks alive.
        const elapsed = busyStart ? ((now - busyStart) / 1000).toFixed(1) : '0.0';
        const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
        const ch = SPIN[Math.floor(now / 100) % SPIN.length];
        return h(Text, { color: 'yellow' },
          `${ch} thinking… `,
          h(Text, { color: 'gray', dimColor: true },
            `${elapsed}s · Ctrl+R to abort`));
      })(),
      error && h(Text, { color: 'red' }, '!! ' + error),
      !busy && h(Box, { flexDirection: 'column' },
        h(Text, { color: 'gray', dimColor: true },
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
