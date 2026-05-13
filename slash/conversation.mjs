// slash/conversation.mjs — list / switch the active conversation file.
//
// /conversations               list .md files in the search dirs
// /conversation                show the current path
// /conversation <name|path>    switch to that file (creates if missing)

import { mkdir, stat } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

export const meta = [
  {
    cmd: '/conversations',
    section: 'ROOM',
    surface: 'shell',
    usage: '/conversations',
    desc: 'list available conversation files',
  },
  {
    cmd: '/conversation',
    section: 'ROOM',
    surface: 'shell',
    usage: '/conversation <name|path>',
    desc: 'switch to a conversation file',
  },
];

export async function run({ cmd, arg, ctx }) {
  // ctx keys consumed:
  //   sysOut(text)
  //   setItems(updater)
  //   getFile() / setFile(path)        — read + assign the mutable FILE
  //   dp(p)                            — path display formatter
  //   listConversationFiles()          — scan the search dirs (local helper)
  //   CONVERSATION_DIRS                — search dirs constant (for empty-state hint)
  //   resolveConversationSpec(spec)    — name/path → absolute path
  //   sentItemsCountRef                — clear on switch so the items-mirror
  //                                      effect doesn't replay the new room's
  //                                      seeded line to bridges
  const { sysOut, setItems, getFile, setFile, dp,
          listConversationFiles, CONVERSATION_DIRS,
          resolveConversationSpec, sentItemsCountRef } = ctx;

  if (cmd === '/conversations') {
    try {
      const files = await listConversationFiles();
      if (!files.length) {
        sysOut(
          `(no conversation files found)\n  search dirs:\n    ` +
          `${CONVERSATION_DIRS.map(dp).join('\n    ')}\n    ` +
          `${dp(resolve(process.cwd(), 'conversation.md'))}`
        );
        return true;
      }
      const rows = await Promise.all(files.map(async (f) => {
        let mtime = 0, size = 0;
        try { const st = await stat(f.path); mtime = st.mtimeMs; size = st.size; } catch {}
        const active = f.path === resolve(getFile()) ? ' ← active' : '';
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
      sysOut(
        `current: ${dp(getFile())}\n` +
        `  /conversations          list available\n` +
        `  /conversation <name>    switch to <name> (creates if missing)`
      );
      return true;
    }
    let nextPath;
    try { nextPath = resolveConversationSpec(spec); }
    catch (e) { sysOut(`!! ${e.message}`); return true; }
    if (!nextPath) { sysOut('!! could not resolve conversation path'); return true; }
    try {
      await mkdir(dirname(nextPath), { recursive: true });
      if (!existsSync(nextPath)) writeFileSync(nextPath, `# Conversation\n\n---\n\n`);
      setFile(nextPath);
      // Clear the displayed transcript so the user sees the new room fresh.
      // Sessions are kept — the user may want to reuse attached brains.
      setItems([{
        id: Date.now() + Math.random(), author: 'system',
        body: `switched conversation -> ${dp(nextPath)}`,
      }]);
      sentItemsCountRef.current = 0;
    } catch (e) { sysOut(`!! /conversation: ${e.message}`); }
    return true;
  }

  return false;
}
