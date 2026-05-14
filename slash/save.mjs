// slash/save.mjs — save the room's most recent non-system message to
// ~/.egpt/summaries/<name>.md. Cheap, no LLM call — useful for capturing
// a clean answer (a paragraph of yours, or a brain's last reply) for
// later /inject into another conversation.

import { readFile, writeFile } from 'node:fs/promises';

export const meta = {
  cmd: '/save',
  section: 'BRAINS',
  surface: 'shell',
  usage: '/save <name>',
  desc: 'save the last non-system message to ~/.egpt/summaries/<name>.md',
};

export async function run({ arg, ctx }) {
  // ctx keys consumed:
  //   sysOut, dp, getFile
  //   parseMessages          — shared md parser
  //   ensureSummariesDir()
  //   summaryPath(name)      — name → absolute path
  //   isSafeName(name)       — validator
  const { sysOut, dp, getFile, parseMessages,
          ensureSummariesDir, summaryPath, isSafeName } = ctx;

  const name = arg.trim();
  if (!isSafeName(name)) {
    sysOut('usage: /save <name>\n  name: letters/digits/dot/dash/underscore only');
    return true;
  }
  try {
    const FILE = getFile();
    const text = await readFile(FILE, 'utf8');
    const turns = parseMessages(text).filter(m => m.author !== 'system');
    if (!turns.length) { sysOut('(nothing to save — the room is empty)'); return true; }
    const last = turns[turns.length - 1];
    await ensureSummariesDir();
    const body =
      `# ${name}\n\n` +
      `_Saved ${new Date().toISOString().slice(0, 16).replace('T', ' ')} from ${FILE}_\n` +
      `_Author: ${last.author}_\n\n---\n\n${last.body}\n`;
    await writeFile(summaryPath(name), body);
    sysOut(`saved -> ${dp(summaryPath(name))}\n  (${last.body.length} chars from ${last.author})`);
  } catch (e) { sysOut(`!! ${e.message}`); }
  return true;
}
