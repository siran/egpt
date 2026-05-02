#!/usr/bin/env node
// egpt.mjs — file IS the conversation; Ink shell; sessions = named participants
import React from 'react';
import { render, Box, Text, Static, useInput, useApp } from 'ink';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { readFile, appendFile } from 'node:fs/promises';

import * as claudeCode from './brains/claude-code.mjs';
import * as chatgptCdp from './brains/chatgpt-cdp.mjs';
import * as claudeCdp from './brains/claude-cdp.mjs';
import * as cdp from './brains/cdp.mjs';

const { createElement: h, useState, Fragment } = React;

const BRAINS = {
  [claudeCode.name]: claudeCode,
  [chatgptCdp.name]: chatgptCdp,
  [claudeCdp.name]:  claudeCdp,
};

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
// Render line content with visible spaces (· in dim gray). Returns array of children.
function renderInputContent(line) {
  const out = [];
  let buf = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === ' ') {
      if (buf) { out.push(buf); buf = ''; }
      out.push(h(Text, { key: 's' + i, color: 'gray', dimColor: true }, '·'));
    } else {
      buf += line[i];
    }
  }
  if (buf) out.push(buf);
  return out;
}

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
      next[r] = next[r].slice(0, c) + input + next[r].slice(c);
      setLines(next); setC(c + input.length);
    }
  });

  return h(Box, { flexDirection: 'column' },
    lines.map((line, i) => {
      const pre = i === 0 ? '› ' : '  ';
      if (i !== r) return h(Text, { key: i }, pre, ...renderInputContent(line));
      // Cursor: distinguish between "on a character" vs "at end of line"
      const onChar = c < line.length;
      const at = line[c];
      const cursorIsTypedSpace = onChar && at === ' ';
      return h(Text, { key: i },
        pre,
        ...renderInputContent(line.slice(0, c)),
        onChar
          ? h(Text, cursorIsTypedSpace ? { inverse: true, color: 'gray' } : { inverse: true },
              cursorIsTypedSpace ? '·' : at)
          : h(Text, { inverse: true }, ' '),
        ...renderInputContent(onChar ? line.slice(c + 1) : ''));
    }));
}

// --- main app ---
function App() {
  const [items, setItems] = useState([]);
  const [streaming, setStreaming] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // sessions: map of participant-name → { brain: brainName, options: {...} }
  const [sessions, setSessions] = useState({
    'claude-code': { brain: 'claude-code', options: {} },
  });
  const [principal, setPrincipal] = useState('claude-code');
  const { exit } = useApp();

  const sysOut = body =>
    setItems(p => [...p, { id: Date.now() + Math.random(), author: 'system', body }]);

  const handleSlash = async (text) => {
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(' ').trim();

    if (cmd === '/exit') { exit(); return true; }
    if (cmd === '/file') { sysOut(FILE); return true; }
    if (cmd === '/help') {
      sysOut(
        '/exit · /file · /help\n' +
        '/open <brain> <name>            open a fresh tab and register a new session\n' +
        '/principal [name [tabSpec]]     switch (or create) principal session.\n' +
        '                                tabSpec: targetId | url | uuid | prefix\n' +
        '/sessions                       list registered sessions\n' +
        '/tabs [all]                     list pages in the brain Chrome (chrome:// hidden)\n' +
        '/brain [status|stop]            brain Chrome lifecycle (CDP-based)\n' +
        '/session [<id> [cwd]]           extend an existing claude-code session via --resume\n' +
        '                                (instead of stateless re-imitation each turn)\n' +
        '/rules                          write room-rules system message into the file\n' +
        '                                (silence convention, @mentions, politeness)\n' +
        '/refresh                        re-poll current CDP tab; append full text\n' +
        '                                (use when streaming was cut off)\n' +
        '/last [N]                       show last N messages from the file (default 10)\n\n' +
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
      const sid = parts[0];
      const cwd = parts.slice(1).join(' ').trim() || undefined;
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
      setSessions(s => ({
        ...s,
        [principal]: {
          ...s[principal],
          options: { ...s[principal].options, sessionId: sid, ...(cwd ? { cwd } : {}) },
        },
      }));
      sysOut(`${principal}.sessionId → ${sid}` +
             (cwd ? `\n${principal}.cwd → ${cwd}` : '') +
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
      const lines = Object.entries(sessions).map(([name, s]) =>
        `${name === principal ? '*' : ' '} ${name}  ${s.brain}` +
        (s.options.targetId ? `  (target: ${s.options.targetId.slice(0, 8)}…)` : ''));
      sysOut(lines.join('\n') || '(none)');
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

      // 2) brain name — auto-create session named after the brain
      const brain = BRAINS[target];
      if (brain) {
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
                sysOut(`no open ${target} tabs. /open ${target} <name> opens one, or pass a tabSpec.`);
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
        setSessions(s => ({ ...s, [target]: { brain: target, options } }));
        setPrincipal(target);
        sysOut(`session "${target}" → ${target}` +
          (options.targetId ? ` (tab ${options.targetId.slice(0, 8)}…)` : '') +
          `\nprincipal → ${target}`);
        return true;
      }

      sysOut(`no session or brain named "${target}". one of: ${Object.keys(BRAINS).join(', ')}`);
      return true;
    }
    if (cmd === '/open') {
      const [brainName, sessionName] = arg.split(/\s+/);
      if (!brainName || !sessionName) {
        sysOut('usage: /open <brain> <name>\nbrains: ' + Object.keys(BRAINS).join(', '));
        return true;
      }
      const brain = BRAINS[brainName];
      if (!brain) { sysOut(`unknown brain: ${brainName}`); return true; }
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
        sysOut(header + tabs.map(t =>
          `${t.id.slice(0, 8)}…  ${matchBrain(t.url).padEnd(12)}  ${t.url}\n            → ${t.title || '(untitled)'}`
        ).join('\n'));
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

    const session = sessions[principal];
    if (!session) { setError(`no session "${principal}"`); return; }
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
            setSessions(s => ({ ...s, [principal]: { ...s[principal], options: opts } }));
            sysOut(`(auto-bound ${principal} to tab ${opts.targetId.slice(0, 8)}…)`);
          } else if (matches.length === 0) {
            setError(`no open ${session.brain} tabs. open one in the brain Chrome, or /open ${session.brain} <name>`);
            return;
          } else {
            const lst = matches.map(t => `  ${t.id.slice(0, 8)}…  ${t.url}`).join('\n');
            setError(`multiple ${session.brain} tabs open — pick one:\n${lst}\nuse: /principal ${principal} <urlOrId>`);
            return;
          }
        } catch (e) { setError(`!! ${e.message}`); return; }
      }
    }
    for (const req of (brain.requires ?? [])) {
      if (!opts[req]) {
        setError(`session ${principal} (${session.brain}) still missing ${req}. try /open ${session.brain} <name>.`);
        return;
      }
    }

    const id = Date.now();
    await append('You', text);

    setBusy(true);
    setError(null);
    setStreaming({ author: principal, text: '' });

    try {
      const history = await readFile(FILE, 'utf8');
      const final = await brain.stream(
        { history, message: text },
        partial => setStreaming({ author: principal, text: partial }),
        opts,
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
          body: `${principal} acknowledged silently (${trimmed})`,
        }]);
        // intentionally NOT appending to FILE — silence stays out of the log
      } else {
        setItems(p => [...p, { id: id + 1, author: principal, body: final }]);
        await append(principal, final);
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
      streaming && h(Box, { flexDirection: 'column', marginTop: 1 },
        h(Text, { color: 'green', bold: true }, streaming.author),
        h(Text, null, streaming.text + '▎')),
      busy && !streaming?.text && h(Text, { color: 'yellow' }, '… thinking'),
      error && h(Text, { color: 'red' }, '!! ' + error),
      !busy && h(MultiLineInput, { onSubmit: submit })));
}

console.log(`egpt | ${FILE}`);
console.log('Enter=newline · Ctrl+D=send · Ctrl+C=exit · /help for commands\n');
render(h(App));
