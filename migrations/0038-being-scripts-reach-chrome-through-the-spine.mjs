// 0038 — being scripts and prompts reach the chat's group Chrome through the spine, not localhost:9221.
//
// Chunk C of the named browser groups (plans/2610091931, rev 2026-10-11); chunk D closes the port.
// Every being session carries EGPT_CDP (src/tools/being-cdp.mjs): a fetch + WebSocket that serve
// :9221's /json and devtools URLs from the chat's group Chrome, over the being link.
//
// SCRIPTS: every .mjs under conversations/ and rooms/ that dials localhost|127.0.0.1:9221 (literally,
// or as `localhost:${PORT}` beside a 9221 literal) gets INSERT after any shebang, in its own line
// endings. Skipped, with the reason: declares its own fetch/WebSocket; reaches CDP another way; not
// UTF-8; would not parse with the line (node --check). A script of any other kind is never edited, only
// listed as a proposal. Not walked: node_modules, .git, transcripts, links.
//
// PROMPTS (TEXT): exact-line replacements. No such file on this node: nothing to do. A file with
// neither the line nor its replacement verbatim REFUSES, and nothing is changed.
//
// Backups: <profile>/disposable/migration-0038-<timestamp>/<same relative path>. A file that changed
// since it was planned refuses. A script that fails node --check after the write is restored, and the
// run fails naming it.
import { readFileSync, writeFileSync, readdirSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

export const elevated = false;
export const summary = "being scripts and prompts reach the chat's group Chrome through the spine ($EGPT_CDP), not localhost:9221";

export const INSERT = 'const { fetch, WebSocket } = process.env.EGPT_CDP ? await import(process.env.EGPT_CDP) : globalThis;';

const ROOTS = ['conversations', 'rooms'];
const UNWALKED = new Set(['node_modules', '.git', 'transcripts']);
const OTHER_SCRIPT = /\.(?:js|cjs|ts|sh|bash|py|ps1|cmd|bat)$|\.x\.md$/i;
const DIALS = /(?:localhost|127\.0\.0\.1):9221(?!\d)/;
const DIALS_VIA = /(?:localhost|127\.0\.0\.1):\$\{/;
const PORT_LITERAL = /(?<![\w.])9221(?!\w)/;
const OWN_BINDING = [
  /\b(?:const|let|var|function\*?|class)\s+(?:fetch|WebSocket)\b/,
  /\bimport\s+(?:\*\s+as\s+)?(?:fetch|WebSocket)\b/,
  /\bimport\s*(?:\w+\s*,\s*)?\{[^}]*\b(?:fetch|WebSocket)\b[^}]*\}\s*from\b/,
  /\b(?:const|let|var)\s*\{[^}]*\b(?:fetch|WebSocket)\b[^}]*\}\s*=/,
];
const OTHER_WAY = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"](?:node:)?(?:https?|net|ws|undici|puppeteer(?:-core)?|playwright(?:-core)?|chrome-remote-interface)['"]|\b(?:globalThis|global|window)\.(?:fetch|WebSocket)\b/;

const CARD_ANCHOR = 'profile myself — it comes up logged out, and it can damage the profile.';
export const CARD_LINES = [
  "My scripts reach it only through the spine. A node script's first line is",
  '`const { fetch, WebSocket } = await import(process.env.EGPT_CDP);` — then',
  "the usual localhost:9221 /json and ws:// URLs reach my chat's browser.",
];
const VIA_SPINE = 'a node script reaches it with const { fetch, WebSocket } = await import(process.env.EGPT_CDP), and the same localhost:9221 /json and ws URLs keep working';
const GMAIL = (where) => `  3-hourly Gmail watch (07,10,13,16,19,22) for An (anaprueba@example.org; Gmail is logged in in ${where}). HARD RULES: never delete, archive, send, reply,`;
const DOJO = (where) => `  info (registration dates, session dates, fees, and the Amilia registration link) in (a) the ClassDojo feed in ${where}`;
const RODZ = 'eGPT Rodz Lola An';

// `chat` = a chat NAME: conversations/<surface>/<name>-<10 digits>/<file>, on whichever node has it.
export const TEXT = [
  { file: ['config', 'skeletons', 'room', '30-pointers.md'], before: CARD_ANCHOR, after: [CARD_ANCHOR, ...CARD_LINES] },
  ...['0700', '1000', '1300', '1600', '1900', '2200'].map((t) => ({
    chat: RODZ, file: ['heartbeats', `gmail-watch3-${t}.yaml`],
    before: GMAIL('the CDP chrome, localhost:9221'), after: [GMAIL(`this chat's browser: ${VIA_SPINE}`)],
  })),
  {
    chat: RODZ, file: ['heartbeats', 'afterschool-session2-watch.yaml'],
    before: DOJO('the CDP chrome (home.classdojo.com, #/story)'), after: [DOJO(`this chat's browser (home.classdojo.com, #/story; ${VIA_SPINE})`)],
  },
];

const refuse = (why) => { throw new Error(`0038 refuses: ${why}`); };
const utf8 = (bytes) => { const t = bytes.toString('utf8'); return Buffer.from(t, 'utf8').equals(bytes) ? t : null; };
const eol = (text) => (text.includes('\r\n') ? '\r\n' : '\n');
const dials = (text) => DIALS.test(text) || (DIALS_VIA.test(text) && PORT_LITERAL.test(text));
const firstLine = (s) => String(s).split(/\r?\n/).find((l) => /Error/.test(l))?.trim() ?? String(s).trim().split(/\r?\n/)[0];

export function nodeCheck({ file, source }) {
  const r = file
    ? spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true })
    : spawnSync(process.execPath, ['--check', '--input-type=module', '-'], { input: source.replace(/^﻿/, ''), encoding: 'utf8', windowsHide: true });
  if (r.error) throw r.error;
  return r.status === 0 ? { ok: true } : { ok: false, error: firstLine(r.stderr || r.stdout) };
}

export function withInsert(text) {
  const bom = text.startsWith('﻿') ? '﻿' : '';
  const body = text.slice(bom.length);
  const nl = eol(body);
  const shebang = /^#![^\r\n]*(?:\r?\n|$)/.exec(body)?.[0];
  if (shebang === undefined) return `${bom}${INSERT}${nl}${body}`;
  return `${bom}${shebang}${/\n$/.test(shebang) ? '' : nl}${INSERT}${nl}${body.slice(shebang.length)}`;
}

function* walk(dir, unreadable) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch (e) { unreadable.push(`${dir} (${e.code ?? e.message})`); return; }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!UNWALKED.has(e.name)) yield* walk(p, unreadable); } else if (e.isFile()) yield p;
  }
}

const subdirs = (dir) => { try { return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.isSymbolicLink()).map((e) => e.name); } catch { return []; } };
function chatDirs(egptHome, name) {
  const conv = join(egptHome, 'conversations');
  const re = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{10}$`);
  return subdirs(conv).flatMap((s) => subdirs(join(conv, s)).filter((d) => re.test(d)).map((d) => join(conv, s, d)));
}

const blockAt = (lines, block) => lines.findIndex((_, i) => block.every((b, j) => lines[i + j] === b));

export async function plan(ctx) {
  const home = ctx.egptHome;
  const check = ctx.nodeCheck ?? nodeCheck;
  const rel = (p) => relative(home, p).split(sep).join('/');

  // ── prompts: every refusal happens here, before anything is planned to change ──
  const textEdits = [];
  let textDone = 0, textAbsent = 0;
  for (const t of TEXT) {
    const paths = t.chat ? chatDirs(home, t.chat).map((d) => join(d, ...t.file)) : [join(home, ...t.file)];
    for (const path of paths) {
      if (!existsSync(path)) { textAbsent++; continue; }
      const bytes = readFileSync(path);
      const text = utf8(bytes);
      if (text === null) refuse(`${path} is not valid UTF-8; an edit would re-encode bytes it never meant to touch`);
      const lines = text.split(/\r?\n/);
      if (blockAt(lines, t.after) >= 0) { textDone++; continue; }
      const at = lines.indexOf(t.before);
      if (at < 0) refuse(`${path} has neither the line to replace nor its replacement verbatim - expected the line:\n${t.before}`);
      const next = [...lines.slice(0, at), ...t.after, ...lines.slice(at + 1)].join(eol(text));
      textEdits.push({ path, bytes, next, show: [`${rel(path)}:${at + 1}`, `  - ${t.before}`, ...t.after.map((l) => `  + ${l}`)] });
    }
  }

  // ── scripts ──
  const scriptEdits = [], skipped = [], proposals = [], unreadable = [];
  let scriptDone = 0;
  for (const root of ROOTS) {
    const top = join(home, root);
    if (!existsSync(top)) continue;
    for (const path of walk(top, unreadable)) {
      const isMjs = /\.mjs$/i.test(path);
      if (!isMjs && !OTHER_SCRIPT.test(path)) continue;
      const bytes = readFileSync(path);
      const text = utf8(bytes);
      if (!dials(text ?? bytes.toString('latin1'))) continue;
      if (!isMjs) { proposals.push(`${rel(path)} - not a .mjs, never edited: move its CDP calls into a .mjs that starts with the line`); continue; }
      if (text === null) { skipped.push(`${rel(path)} - not valid UTF-8`); continue; }
      if (text.split(/\r?\n/).some((l) => l.trim() === INSERT)) { scriptDone++; continue; }
      const own = OWN_BINDING.map((re) => re.exec(text)?.[0]).find(Boolean);
      if (own) { skipped.push(`${rel(path)} - declares its own fetch/WebSocket (\`${own}\`)`); continue; }
      const other = OTHER_WAY.exec(text)?.[0];
      if (other) { skipped.push(`${rel(path)} - reaches CDP another way (\`${other}\`); the line cannot serve it`); continue; }
      const next = withInsert(text);
      const parsed = check({ source: next });
      if (!parsed.ok) {
        const before = check({ source: text });
        skipped.push(`${rel(path)} - ${before.ok ? 'would not parse with the line' : 'does not parse as it is'} (node --check: ${parsed.error})`);
        continue;
      }
      scriptEdits.push({ path, bytes, next });
    }
  }

  const tally = [
    `scripts: ${scriptEdits.length} to edit, ${scriptDone} already carry the line, ${skipped.length} skipped, ${proposals.length} proposals (not .mjs, never edited)`,
    `prompts: ${textEdits.length} lines to replace, ${textDone} already replaced, ${textAbsent} target files absent on this node`,
    ...unreadable.map((u) => `unreadable, not scanned: ${u}`),
    ...skipped.map((s) => `skip      ${s}`),
    ...proposals.map((p) => `proposal  ${p}`),
  ];
  if (!scriptEdits.length && !textEdits.length) return { satisfied: true, notes: tally };

  return {
    satisfied: false,
    changes: [
      ...tally,
      `insert after any shebang:  ${INSERT}`,
      ...scriptEdits.map((e) => `  + ${rel(e.path)}`),
      ...textEdits.flatMap((e) => e.show),
      `backups first: ${rel(join(home, 'disposable', 'migration-0038-<timestamp>'))}/<same relative path>`,
    ],
    apply: async () => {
      for (const e of [...textEdits, ...scriptEdits]) if (!readFileSync(e.path).equals(e.bytes)) refuse(`${e.path} changed since it was planned - re-run`);
      const pad = (n) => String(n).padStart(2, '0');
      const d = new Date();
      const vault = join(home, 'disposable', `migration-0038-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`);
      const backup = (path) => { const to = join(vault, relative(home, path)); mkdirSync(dirname(to), { recursive: true }); copyFileSync(path, to); return to; };
      for (const e of textEdits) { backup(e.path); writeFileSync(e.path, e.next, 'utf8'); }
      const restored = [];
      for (const e of scriptEdits) {
        const saved = backup(e.path);
        writeFileSync(e.path, e.next, 'utf8');
        const parsed = check({ file: e.path });
        if (!parsed.ok) { copyFileSync(saved, e.path); restored.push(`${rel(e.path)} (node --check: ${parsed.error})`); }
      }
      ctx.log(`backups: ${vault}`);
      ctx.log(`replaced ${textEdits.length} prompt lines; inserted the line in ${scriptEdits.length - restored.length} scripts; restored ${restored.length}`);
      if (restored.length) throw new Error(`0038: ${restored.length} script(s) did not parse after the insert and were restored as they were:\n${restored.join('\n')}`);
    },
  };
}
