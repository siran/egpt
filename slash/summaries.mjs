// slash/summaries.mjs — list saved summaries in ~/.egpt/summaries/.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SUMMARIES_DIR = join(homedir(), '.egpt', 'summaries');

export const meta = [
  { cmd: '/summaries',  section: 'BRAINS', surface: 'shell', usage: '/summaries',  desc: 'list saved summaries' },
  { cmd: '/list-saved', section: 'BRAINS', surface: 'shell', usage: '/list-saved', desc: 'alias for /summaries' },
  { cmd: '/saved',      section: 'BRAINS', surface: 'shell', usage: '/saved',      desc: 'alias for /summaries' },
];

export async function run({ ctx }) {
  // ctx keys consumed:
  //   sysOut(text)
  //   ensureSummariesDir()  — mkdir -p the summaries dir
  const { sysOut, ensureSummariesDir } = ctx;

  try {
    await ensureSummariesDir();
    const files = (await readdir(SUMMARIES_DIR)).filter(f => f.endsWith('.md'));
    if (!files.length) {
      sysOut(`(no summaries yet — try /save <name> or /summarize <name>)\n  dir: ${SUMMARIES_DIR}`, { _themed: true });
      return true;
    }
    const rows = await Promise.all(files.map(async (f) => {
      const p = join(SUMMARIES_DIR, f);
      const st = await stat(p);
      const head = (await readFile(p, 'utf8')).slice(0, 80).replace(/\s+/g, ' ');
      return { name: f.replace(/\.md$/, ''), size: st.size, mtime: st.mtime, head };
    }));
    rows.sort((a, b) => b.mtime - a.mtime);
    const fmtSize = (b) => b < 1024 ? `${b}B` : `${(b / 1024).toFixed(1)}K`;
    sysOut(
      'saved summaries:\n' +
      rows.map(r =>
        `  ${r.name.padEnd(20)} ${fmtSize(r.size).padEnd(7)} ` +
        `"${r.head}${r.head.length >= 80 ? '…' : ''}"`
      ).join('\n') +
      `\n\ndir: ${SUMMARIES_DIR}`,
      { _themed: true },
    );
  } catch (e) { sysOut(`!! ${e.message}`); }
  return true;
}
