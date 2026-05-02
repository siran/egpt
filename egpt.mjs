#!/usr/bin/env node
// egpt.mjs — file IS the conversation; Ink shell; sessions = named participants
import React from 'react';
import { render, Box, Text, Static, useInput, useApp } from 'ink';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { readFile, writeFile, appendFile, readdir, stat, open, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

import * as claudeCode from './brains/claude-code.mjs';
import * as chatgptCdp from './brains/chatgpt-cdp.mjs';
import * as claudeCdp from './brains/claude-cdp.mjs';
import * as cdp from './brains/cdp.mjs';

const { createElement: h, useState, useEffect, Fragment } = React;

const BRAINS = {
  [claudeCode.name]: claudeCode,
  [chatgptCdp.name]: chatgptCdp,
  [claudeCdp.name]:  claudeCdp,
};

// Short, recognizable session-name prefixes per brain. Sessions are
// auto-named <prefix><N> where N grows to the first unused integer.
const BRAIN_PREFIX = {
  'chatgpt-cdp': 'cgpt',
  'claude-cdp':  'claude',
  'claude-code': 'code',
  'codex':       'codex',
};

function nextName(brainName, sessions) {
  const prefix = BRAIN_PREFIX[brainName] ?? brainName;
  let n = 1;
  while (sessions[`${prefix}${n}`]) n++;
  return `${prefix}${n}`;
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
// note. /summaries lists what's available.
const SUMMARIES_DIR = join(homedir(), '.egpt', 'summaries');

function isSafeName(name) {
  return /^[A-Za-z0-9._-]+$/.test(name) && name !== '.' && name !== '..';
}
function summaryPath(name) {
  return join(SUMMARIES_DIR, `${name}.md`);
}
async function ensureSummariesDir() {
  await mkdir(SUMMARIES_DIR, { recursive: true });
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

const FILE = process.argv[2] ?? './conversation.md';

// preflight (only fatal if claude-code is the default principal)
{
  const r = spawnSync('claude', ['--version'], { stdio: 'pipe' });
  if (r.error?.code === 'ENOENT') {
    console.error('!! `claude` CLI not found on PATH.');
    console.error('   Install Claude Code: npm install -g @anthropic-ai/claude-code');
    console.error('   (Other brains do not need it; switch with /principal.)');
    process.exit(1);
  }
}

if (!existsSync(FILE)) writeFileSync(FILE, `# Conversation\n\n---\n\n`);

const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 16);
const append = (who, body) => appendFile(FILE, `## ${ts()} — ${who}\n${body}\n\n`);

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
  // Default participant: code1 (claude-code subprocess, no Chrome needed).
  const [sessions, setSessions] = useState({
    'code1': { brain: 'claude-code', options: {} },
  });
  const [principal, setPrincipal] = useState('code1');
  // Elapsed-time tracking so the user has progress feedback during the
  // brain's pre-generation "thinking" phase (which can be 5-15s for a long
  // conversation file). When busy goes true we record the start; an interval
  // bumps `now` every 250ms to drive re-renders.
  const [busyStart, setBusyStart] = useState(null);
  const [now, setNow] = useState(Date.now());
  const { exit } = useApp();

  useEffect(() => {
    if (!busy) { setBusyStart(null); return; }
    setBusyStart(Date.now());
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [busy]);

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
        let working = { 'code1': { brain: 'claude-code', options: {} } };
        const additions = {};
        for (const tab of tabs) {
          if (isInternalUrl(tab.url)) continue;
          const brainName = brainForUrl(tab.url);
          if (!brainName) continue;
          // skip if the targetId is already attached
          if (Object.values(working).some(s => s.options?.targetId === tab.id)) continue;
          const name = nextName(brainName, working);
          additions[name] = { brain: brainName, options: { targetId: tab.id } };
          working[name] = additions[name];
        }
        if (Object.keys(additions).length > 0 && !cancelled) {
          setSessions(s => ({ ...s, ...additions }));
          const summary = Object.entries(additions)
            .map(([n, s]) => `${n} (${s.brain})`).join(', ');
          setItems(p => [...p, {
            id: Date.now() + Math.random(), author: 'system',
            body: `auto-attached ${Object.keys(additions).length} tab(s): ${summary}`,
          }]);
        }
      } catch { /* Chrome not running — fine, only code1 is registered */ }
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

  const handleSlash = async (text) => {
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(' ').trim();

    if (cmd === '/exit') { exit(); return true; }
    if (cmd === '/file') { sysOut(FILE); return true; }
    if (cmd === '/help') {
      sysOut(
        '/exit · /file · /help\n\n' +
        'Sessions (named participants in the room):\n' +
        '  Auto-naming: cgpt1, claude1, code1, codex1 ... per brain.\n' +
        '  Names are auto-generated on /open, /attach, /principal-with-brain.\n' +
        '  At startup egpt scans Chrome and auto-attaches every matching tab.\n\n' +
        '/open <brain> [name]            open a fresh tab + register session\n' +
        '/attach                         re-scan Chrome, attach any new tabs\n' +
        '/attach <brain>                 attach all unattached tabs of that brain\n' +
        '/attach <brain> <name> [tab]    explicit attach to a specific tab\n' +
        '/principal [name [tabSpec]]     show/switch; brain name picks single\n' +
        '                                existing or auto-creates one\n' +
        '/sessions                       list registered sessions (* = principal)\n\n' +
        'Browser brains:\n' +
        '/tabs [all]                     list pages in brain Chrome (chrome:// hidden)\n' +
        '/brain [status|stop]            brain Chrome lifecycle (CDP-based)\n' +
        '/refresh                        re-poll CDP tab; append latest assistant text\n' +
        '                                (use when streaming was cut off)\n\n' +
        'Local brain (claude-code):\n' +
        '/history [N]                    list recent claude-code sessions on disk\n' +
        '                                (newest first; default 10)\n' +
        '/session [<id>]                 continue a claude-code session via --resume\n' +
        '                                (cwd auto-detected from the JSONL)\n' +
        '/session <id> <cwd>             explicit cwd if auto-detection fails\n' +
        '/session none                   back to stateless mode (re-reads file each turn)\n\n' +
        'Conversation:\n' +
        '/rules                          write room rules into file (silence, @, politeness)\n' +
        '/last [N]                       show last N messages from the file (default 10)\n' +
        '@<name> <message>               address a session for THIS turn only,\n' +
        '                                without changing the principal\n\n' +
        'Reusable distillations (~/.egpt/summaries/<name>.md):\n' +
        '/save <name>                    save the latest non-system message verbatim\n' +
        '/summarize <name>               principal compresses the room → summary file\n' +
        '/summaries                      list saved summaries\n' +
        '/inject <name>                  drop a saved summary into the room as a system note\n\n' +
        'tabSpec accepts: full URL · UUID · targetId · 6+ char id prefix\n' +
        'Brains: ' + Object.keys(BRAINS).join(', '));
      return true;
    }
    if (cmd === '/session') {
      // /session                  → show
      // /session <id> [cwd]       → set resume sessionId (and optional cwd)
      //                             on the current principal session.
      // /session none             → clear (revert to stateless mode)
      const session = sessions[principal];
      if (!session) { sysOut(`no current session`); return true; }
      if (!arg) {
        sysOut(`${principal}.sessionId: ${session.options.sessionId ?? '(none)'}` +
               `\n${principal}.cwd: ${session.options.cwd ?? '(none)'}`);
        return true;
      }
      const parts = arg.split(/\s+/);
      let sid = parts[0];
      let cwd = parts.slice(1).join(' ').trim() || undefined;
      if (sid === 'none' || sid === 'clear') {
        setSessions(s => ({
          ...s,
          [principal]: {
            ...s[principal],
            options: Object.fromEntries(
              Object.entries(s[principal].options).filter(([k]) => k !== 'sessionId' && k !== 'cwd')
            ),
          },
        }));
        sysOut(`${principal}: resume cleared (back to stateless mode)`);
        return true;
      }
      // Resolve the session ID to the full UUID. claude --resume requires a
      // full UUID (or a saved title) — the prefix the user typed (e.g. from
      // /history) won't work as-is. While we're at it, auto-detect cwd from
      // the JSONL if not explicitly given.
      let expandedFromPrefix = false;
      let detectedCwd = false;
      try {
        const found = await findSessionJsonl(sid);
        if (!found) {
          sysOut(`!! no session matches "${sid}". /history to list, /session none to clear.`);
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
      setSessions(s => ({
        ...s,
        [principal]: {
          ...s[principal],
          options: { ...s[principal].options, sessionId: sid, ...(cwd ? { cwd } : {}) },
        },
      }));
      sysOut(`${principal}.sessionId → ${sid}` +
             (expandedFromPrefix ? '  (expanded from prefix)' : '') +
             (cwd ? `\n${principal}.cwd → ${cwd}` + (detectedCwd ? '  (auto-detected from JSONL)' : '') : '\n(no cwd; pass one if claude --resume fails)') +
             `\n(claude --resume mode active for this session)`);
      return true;
    }
    if (cmd === '/rules') {
      // Write a room-rules system message into the conversation file. Brains
      // reading the file will see it as ambient context. (Stateless brains and
      // CDP brains absorb this naturally; --resume brains won't see it via the
      // JSONL — for those, paste the rules manually as a turn if you want them.)
      const others = Object.keys(sessions).filter(n => n !== principal).map(n => `${n} (${sessions[n].brain})`);
      const all = [`${principal} (${sessions[principal].brain})`, ...others].join(', ');
      const rules =
        `[Room rules — read once and remember]\n` +
        `Participants right now: ${all}, plus the human admin (An).\n\n` +
        `You don't have to reply to every message. Only speak when:\n` +
        `- you're directly addressed (your name or @mention),\n` +
        `- you have something specifically useful that hasn't been said,\n` +
        `- the admin asks for your input.\n\n` +
        `Otherwise, reply with literally just \`...\` (three dots) and nothing else.\n` +
        `The system reads that as a polite acknowledgement and won't post it to the room.\n\n` +
        `You may @mention another participant to ask them something. The admin\n` +
        `arbitrates when AI-AI exchanges get loud.`;
      await append('system', rules);
      setItems(p => [...p, { id: Date.now(), author: 'system', body: rules }]);
      return true;
    }
    if (cmd === '/refresh') {
      const session = sessions[principal];
      const brain = BRAINS[session?.brain];
      if (!brain?.peek) { sysOut('/refresh only works on CDP brains (chatgpt-cdp, claude-cdp)'); return true; }
      try {
        const text = await brain.peek(session.options);
        if (!text || !text.trim()) { sysOut('(tab has no assistant message right now)'); return true; }
        setItems(p => [...p, { id: Date.now(), author: principal, body: text }]);
        await append(principal, text);
        sysOut('(refreshed from tab — full text appended to file)');
      } catch (e) { sysOut(`!! ${e.message}`); }
      return true;
    }
    if (cmd === '/summaries') {
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
    if (cmd === '/summarize') {
      // /summarize <name> — ask the principal to compress the current room and
      // save the result as <name>.md. Uses the principal's brain via the same
      // dispatch the user does, so the rules-aware turn convention applies.
      const name = arg.trim();
      if (!isSafeName(name)) {
        sysOut('usage: /summarize <name>\n  the current principal will summarize the room into ~/.egpt/summaries/<name>.md');
        return true;
      }
      const session = sessions[principal];
      if (!session) { sysOut(`no session "${principal}"`); return true; }
      const brain = BRAINS[session.brain];
      if (!brain) { sysOut(`brain not found: ${session.brain}`); return true; }
      try {
        await ensureSummariesDir();
        const history = await readFile(FILE, 'utf8');
        const prompt =
          `Summarize the conversation above into a tight, faithful condensation that ` +
          `preserves the participants, the key decisions, and any open questions or ` +
          `loose threads. Aim for under 600 words. Plain markdown, no preamble. ` +
          `When you reply, output ONLY the summary text (no "Here is the summary:" boilerplate).`;
        sysOut(`asking ${principal} to summarize…`);
        setBusy(true);
        setStreaming({ author: principal, text: '' });
        let final;
        try {
          final = await brain.stream(
            { history: `${history}\n\n## ${ts()} — You\n${prompt}\n\n`, message: prompt },
            partial => setStreaming({ author: principal, text: partial }),
            { ...session.options, principal },
          );
        } finally {
          setStreaming(null); setBusy(false);
        }
        const body = `# ${name}\n\n_Summarized ${new Date().toISOString().slice(0, 16).replace('T', ' ')} by ${principal} (${session.brain}) from ${FILE}_\n\n---\n\n${final}\n`;
        await writeFile(summaryPath(name), body);
        sysOut(`saved → ${summaryPath(name)}  (${final.length} chars)`);
      } catch (e) { sysOut(`!! ${e.message}`); }
      return true;
    }
    if (cmd === '/inject') {
      // /inject <name> — drop a saved summary into the current room as a system
      // note, so all brains pick it up as ambient context on their next turn.
      const name = arg.trim();
      if (!isSafeName(name)) {
        sysOut('usage: /inject <name>\n  drops the summary into this room as a system note. /summaries to list.');
        return true;
      }
      try {
        const path = summaryPath(name);
        const body = await readFile(path, 'utf8');
        const note = `[injected summary "${name}" from ${path}]\n\n${body.trim()}`;
        await append('system', note);
        setItems(p => [...p, { id: Date.now() + Math.random(), author: 'system', body: note }]);
        sysOut(`injected "${name}" (${body.length} chars)`);
      } catch (e) {
        if (e.code === 'ENOENT') sysOut(`no summary named "${name}". /summaries to list.`);
        else sysOut(`!! ${e.message}`);
      }
      return true;
    }
    if (cmd === '/history') {
      // List recent claude-code sessions on disk, newest first.
      // Each entry shows: short id, "Nm/Nh ago", size, original cwd, first user line.
      try {
        const projectsDir = join(homedir(), '.claude', 'projects');
        let projects = [];
        try { projects = await readdir(projectsDir); }
        catch { sysOut(`(${projectsDir} not found — no claude-code sessions yet)`); return true; }

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
        if (!items.length) { sysOut('(no claude-code sessions on disk)'); return true; }

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
        sysOut(`Last ${enriched.length} of ${items.length} claude-code session(s) on disk:\n\n` +
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
        const marker = name === principal ? '*' : ' ';
        const namePad = name.padEnd(14);
        const brainPad = s.brain.padEnd(13);
        let detail = '';
        if (s.options.targetId) {
          const live = tabsByid.get(s.options.targetId);
          detail = live ? `"${live.title || '(untitled)'}"` : `(tab gone — ${s.options.targetId.slice(0, 8)}…)`;
        } else if (s.options.sessionId) {
          detail = `claude --resume ${s.options.sessionId.slice(0, 8)}…`;
        }
        return `${marker} ${namePad}${brainPad}${detail}`;
      });
      sysOut(rows.join('\n') || '(none)');
      return true;
    }
    if (cmd === '/attach') {
      // Three forms:
      //   /attach                          → re-scan Chrome, attach any new tabs
      //   /attach <brain> <name> [tabSpec] → explicit attach to a specific tab
      //   /attach <brain>                  → attach all unattached tabs of that brain
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
            additions[name] = { brain: brainName, options: { targetId: tab.id } };
            working[name] = additions[name];
          }
          if (Object.keys(additions).length === 0) {
            sysOut('no new tabs to attach (everything matching is already a session)');
          } else {
            setSessions(s => ({ ...s, ...additions }));
            sysOut(`attached: ${Object.entries(additions).map(([n, s]) => `${n} (${s.brain})`).join(', ')}`);
          }
        } catch (e) { sysOut(`!! ${e.message}`); }
        return true;
      }

      // Form 2 & 3: explicit
      const brainName = parts[0];
      const brain = BRAINS[brainName];
      if (!brain) {
        sysOut('usage: /attach                          rescan and attach new tabs\n' +
               '       /attach <brain>                  attach all unattached tabs of that brain\n' +
               '       /attach <brain> <name> [tabSpec] explicit attach\n' +
               'brains: ' + Object.keys(BRAINS).join(', '));
        return true;
      }
      const sessionName = parts[1];
      const tabSpec = parts.slice(2).join(' ').trim();

      // Form 3: brain only — attach all unattached tabs of that brain
      if (!sessionName) {
        if (!brain.urlMatch) {
          sysOut(`/attach ${brainName} requires a name (non-CDP brains have no tabs to scan).`);
          return true;
        }
        try {
          const matching = (await cdp.listTabs()).filter(t => brain.urlMatch.test(t.url));
          let working = { ...sessions };
          const additions = {};
          for (const tab of matching) {
            if (Object.values(working).some(s => s.options?.targetId === tab.id)) continue;
            const name = nextName(brainName, working);
            additions[name] = { brain: brainName, options: { targetId: tab.id } };
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

      setSessions(s => ({ ...s, [sessionName]: { brain: brainName, options } }));
      setPrincipal(sessionName);
      sysOut(`session "${sessionName}" → ${brainName}` +
        (options.targetId ? ` (tab ${options.targetId.slice(0, 8)}…)` : '') +
        `\nprincipal → ${sessionName}\n` +
        `address it as @${sessionName} for guest turns`);
      return true;
    }
    if (cmd === '/principal') {
      if (!arg) {
        sysOut(`principal: ${principal}\nuse /principal <name> [tabSpec] to switch`);
        return true;
      }
      const [target, ...rest] = arg.split(/\s+/);
      const tabSpec = rest.join(' ').trim();

      // 1) existing session — switch (and optionally rebind tab)
      if (sessions[target]) {
        setPrincipal(target);
        let msg = `principal → ${target}`;
        if (tabSpec) {
          try {
            const tid = await resolveTabId(tabSpec);
            if (tid) {
              setSessions(s => ({ ...s, [target]: { ...s[target], options: { ...s[target].options, targetId: tid } } }));
              msg += `\n${target}.targetId → ${tid.slice(0, 8)}…`;
            } else {
              msg += `\n(could not resolve "${tabSpec}" to a tab; principal switched but tab unchanged)`;
            }
          } catch (e) { msg += `\n!! ${e.message}`; }
        }
        sysOut(msg);
        return true;
      }

      // 2) brain name — switch to single existing session of that brain,
      //    or auto-create a new session with auto-name (cgpt2, claude1, ...).
      const brain = BRAINS[target];
      if (brain) {
        const ofBrain = Object.entries(sessions).filter(([_, s]) => s.brain === target);
        // 2a) one existing session of this brain, no explicit tabSpec → just switch
        if (ofBrain.length === 1 && !tabSpec) {
          const [name] = ofBrain[0];
          setPrincipal(name);
          sysOut(`principal → ${name}`);
          return true;
        }
        // 2b) multiple existing sessions of this brain → ask for disambiguation
        if (ofBrain.length > 1 && !tabSpec) {
          const names = ofBrain.map(([n, s]) =>
            `  ${n}` + (s.options?.targetId ? ` (tab ${s.options.targetId.slice(0, 8)}…)` : '')
          ).join('\n');
          sysOut(`multiple sessions for ${target}:\n${names}\nuse: /principal <name>`);
          return true;
        }
        // 2c) zero existing OR explicit tabSpec → create a new session
        const newName = nextName(target, sessions);
        const options = {};
        if (brain.urlMatch) {
          try {
            if (tabSpec) {
              const tid = await resolveTabId(tabSpec, brain);
              if (!tid) {
                sysOut(`could not resolve "${tabSpec}" to a tab. /tabs to see open tabs.`);
                return true;
              }
              options.targetId = tid;
            } else {
              const tabs = (await cdp.listTabs()).filter(t => brain.urlMatch.test(t.url));
              if (tabs.length === 0) {
                sysOut(`no open ${target} tabs. /open ${target} opens one, or pass a tabSpec.`);
                return true;
              }
              if (tabs.length > 1) {
                const lines = tabs.map(t => `  ${t.id.slice(0, 8)}…  ${t.url}`).join('\n');
                sysOut(`multiple ${target} tabs open. pick one:\n${lines}\nuse: /principal ${target} <urlOrIdOrUuid>`);
                return true;
              }
              options.targetId = tabs[0].id;
            }
          } catch (e) { sysOut(`!! ${e.message}`); return true; }
        }
        setSessions(s => ({ ...s, [newName]: { brain: target, options } }));
        setPrincipal(newName);
        sysOut(`session "${newName}" → ${target}` +
          (options.targetId ? ` (tab ${options.targetId.slice(0, 8)}…)` : '') +
          `\nprincipal → ${newName}`);
        return true;
      }

      sysOut(`no session or brain named "${target}". one of: ${Object.keys(BRAINS).join(', ')}`);
      return true;
    }
    if (cmd === '/open') {
      const parts = arg.split(/\s+/);
      const brainName = parts[0];
      let sessionName = parts[1];
      if (!brainName) {
        sysOut('usage: /open <brain> [name]\n  name auto-generated (e.g. cgpt2) if omitted.\n  brains: ' + Object.keys(BRAINS).join(', '));
        return true;
      }
      const brain = BRAINS[brainName];
      if (!brain) { sysOut(`unknown brain: ${brainName}`); return true; }
      if (!sessionName) sessionName = nextName(brainName, sessions);
      if (sessions[sessionName]) { sysOut(`session "${sessionName}" already exists`); return true; }
      try {
        const options = {};
        if (brain.homeUrl) {
          sysOut(`opening tab → ${brain.homeUrl}`);
          options.targetId = await cdp.openTab(brain.homeUrl);
        }
        setSessions(s => ({ ...s, [sessionName]: { brain: brainName, options } }));
        setPrincipal(sessionName);
        sysOut(`session "${sessionName}" → ${brainName}` +
          (options.targetId ? ` (target: ${options.targetId.slice(0, 8)}…)` : '') +
          `\nprincipal → ${sessionName}`);
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

  const submit = async (raw) => {
    const text = raw.trim();
    if (!text) return;

    // Always echo what the user typed into the transcript (commands + messages alike).
    setItems(p => [...p, { id: Date.now(), author: 'You', body: text }]);

    if (text.startsWith('/')) {
      const handled = await handleSlash(text);
      if (handled) return;
    }

    // @mention routing: "@<name> rest..." at the START of the message routes
    // *this turn only* to that session, without changing the principal. If the
    // name doesn't match a known session, fall through to principal and the
    // "@name" stays as plain text for the principal to read normally.
    let routedTo = principal;
    let messageToBrain = text;
    const mention = text.match(/^@(\S+)(?:\s+([\s\S]*))?$/);
    if (mention && sessions[mention[1]]) {
      routedTo = mention[1];
      messageToBrain = (mention[2] ?? '').trim() || '?';
    }

    const session = sessions[routedTo];
    if (!session) { setError(`no session "${routedTo}"`); return; }
    const brain = BRAINS[session.brain];
    if (!brain) { setError(`brain not found: ${session.brain}`); return; }

    // Auto-recover: if this brain needs a tab and the current targetId is gone
    // (or never set), try to bind to a uniquely-matching open tab.
    let opts = session.options;
    if (brain.urlMatch) {
      let needsRebind = !opts.targetId;
      if (opts.targetId) {
        try {
          const live = await cdp.findTab(opts.targetId);
          if (!live) needsRebind = true;
        } catch (e) { setError(`!! ${e.message}`); return; }
      }
      if (needsRebind) {
        try {
          const matches = (await cdp.listTabs()).filter(t => brain.urlMatch.test(t.url));
          if (matches.length === 1) {
            opts = { ...opts, targetId: matches[0].id };
            setSessions(s => ({ ...s, [routedTo]: { ...s[routedTo], options: opts } }));
            sysOut(`(auto-bound ${routedTo} to tab ${opts.targetId.slice(0, 8)}…)`);
          } else if (matches.length === 0) {
            setError(`no open ${session.brain} tabs. open one in the brain Chrome, or /open ${session.brain} <name>`);
            return;
          } else {
            const lst = matches.map(t => `  ${t.id.slice(0, 8)}…  ${t.url}`).join('\n');
            setError(`multiple ${session.brain} tabs open — pick one:\n${lst}\nuse: /principal ${routedTo} <urlOrId>`);
            return;
          }
        } catch (e) { setError(`!! ${e.message}`); return; }
      }
    }
    for (const req of (brain.requires ?? [])) {
      if (!opts[req]) {
        setError(`session ${routedTo} (${session.brain}) still missing ${req}. try /open ${session.brain} <name>.`);
        return;
      }
    }

    const id = Date.now();
    // The .md keeps the original text including the "@mention" prefix —
    // that's part of the room's record. The brain only gets the clean message.
    await append('You', text);

    setBusy(true);
    setError(null);
    setStreaming({ author: routedTo, text: '' });

    try {
      const history = await readFile(FILE, 'utf8');
      const final = await brain.stream(
        { history, message: messageToBrain },
        partial => setStreaming({ author: routedTo, text: partial }),
        { ...opts, principal: routedTo },
      );
      setStreaming(null);

      // Polite-silence convention: a brain reply that is *just* "..." (3+ dots
      // or the Unicode ellipsis) means "acknowledged, nothing to add". Don't
      // post it to the room — show a small hand-raised note in the transcript.
      const trimmed = (final ?? '').trim();
      const isSilence = /^(\.{3,}|…+)$/.test(trimmed);
      if (isSilence) {
        setItems(p => [...p, {
          id: id + 1, author: 'system',
          body: `${routedTo} acknowledged silently (${trimmed})`,
        }]);
        // intentionally NOT appending to FILE — silence stays out of the log
      } else {
        setItems(p => [...p, { id: id + 1, author: routedTo, body: final }]);
        await append(routedTo, final);
      }
    } catch (e) {
      setStreaming(null);
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const color = a =>
    a === 'You' ? 'cyan' : a === 'system' ? 'gray' : 'green';

  return h(Fragment, null,
    h(Static, { items }, item =>
      h(Box, { key: item.id, flexDirection: 'column', marginBottom: 1 },
        h(Text, { color: color(item.author), bold: true }, item.author),
        h(Text, null, item.body))),
    h(Box, { flexDirection: 'column', marginTop: 1 },
      h(Text, { color: 'gray' },
        `[principal: ${principal} · ${sessions[principal]?.brain ?? '?'}]`),
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
            `${streaming.author}  `,
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
      !busy && h(MultiLineInput, { onSubmit: submit })));
}

console.log(`egpt | ${FILE}`);
console.log('Enter=newline · Ctrl+D=send · Ctrl+C=exit · /help for commands\n');
render(h(App));
