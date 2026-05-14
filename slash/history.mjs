// slash/history.mjs — list recent Claude Code sessions on disk.
//
// Scans ~/.claude/projects/*/*.jsonl, newest first. Shows short id,
// "Nm/Nh ago", file size, original cwd, first user-line preview. Used
// as input to /session <sessionId> for resume.

import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const meta = {
  cmd: '/history',
  section: 'BRAINS',
  surface: 'shell',
  usage: '/history [N]',
  desc: 'list recent Claude Code sessions on disk (default 10)',
};

export async function run({ arg, ctx }) {
  // ctx keys consumed:
  //   sysOut(text)
  //   readJsonlMetadata(path)  — parse a session JSONL header for cwd + preview
  const { sysOut, readJsonlMetadata } = ctx;

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
      const m = await readJsonlMetadata(it.fullPath);
      return { ...it, ...m };
    }));

    const fmtTime = (d) => {
      const sec = Math.max(0, (Date.now() - d.getTime()) / 1000);
      if (sec < 60)    return `${Math.floor(sec)}s ago`;
      if (sec < 3600)  return `${Math.floor(sec / 60)}m ago`;
      if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
      return `${Math.floor(sec / 86400)}d ago`;
    };
    const fmtSize = (b) =>
      b < 1024         ? `${b}B` :
      b < 1024 * 1024  ? `${(b / 1024).toFixed(0)}K` :
                         `${(b / (1024 * 1024)).toFixed(1)}M`;

    const lines = enriched.map(it => {
      const id = it.sessionId.slice(0, 8);
      const cwd = it.cwd ?? `(slug: ${it.slug})`;
      const preview = it.preview ? `"${it.preview}"` : '(no preview)';
      return `${id}…  ${fmtTime(it.mtime).padEnd(8)} ${fmtSize(it.size).padEnd(6)} ${preview}\n` +
             `             cwd: ${cwd}`;
    });
    sysOut(
      `Last ${enriched.length} of ${items.length} ccode session(s) on disk:\n\n` +
      lines.join('\n\n') +
      `\n\nto resume: /session <sessionId>   (cwd auto-detected from the JSONL)`
    );
  } catch (e) { sysOut(`!! ${e.message}`); }
  return true;
}
