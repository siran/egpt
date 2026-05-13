// slash/rooms.mjs — /rooms (list saved rooms) and /save-room (snapshot
// current sessions + telegram chat_id to ~/.egpt/rooms/<name>.yaml).

import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as cdp from '../tools/cdp.mjs';

const ROOMS_DIR = join(homedir(), '.egpt', 'rooms');

export const meta = [
  {
    cmd: '/rooms',
    section: 'ROOM',
    surface: 'shell',
    usage: '/rooms',
    desc: 'list saved rooms',
  },
  {
    cmd: '/save-room',
    section: 'ROOM',
    surface: 'shell',
    usage: '/save-room [name]',
    desc: 'snapshot current sessions + telegram chat_id to ~/.egpt/rooms/<name>.yaml',
  },
];

export async function run({ cmd, arg, ctx }) {
  // ctx keys consumed:
  //   sysOut(text)
  //   dp(p)
  //   sessions
  //   tgBridgeRef           — telegram chat_id source
  //   ts()                  — timestamp formatter
  const { sysOut, dp, sessions, tgBridgeRef, ts } = ctx;

  if (cmd === '/rooms') {
    try {
      let files = [];
      try { files = (await readdir(ROOMS_DIR)).filter(f => f.endsWith('.yaml')); } catch {}
      if (!files.length) {
        sysOut(`(no saved rooms)\n  /save-room <name> to save current room`);
        return true;
      }
      sysOut(
        `Saved rooms in ${dp(ROOMS_DIR)}:\n` +
        `${files.map(f => `  ${f.replace('.yaml', '')}`).join('\n')}\n\n` +
        `/room join <name> to enter (and restore its sessions)`
      );
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
        if (s.bio)   lines.push(`    bio: "${s.bio.replace(/"/g, '\\"')}"`);
        const opts = s.options ?? {};
        if (opts.targetId) {
          const tab = tabsByid.get(opts.targetId);
          if (tab?.url && !tab.url.startsWith('chrome')) lines.push(`    url: ${tab.url}`);
        }
        if (opts.sessionId)   lines.push(`    session_id: ${opts.sessionId}`);
        if (opts.cwd)         lines.push(`    cwd: ${opts.cwd}`);
        if (opts.model)       lines.push(`    model: ${opts.model}`);
        if (opts.effort)      lines.push(`    effort: ${opts.effort}`);
        if (opts.profileName) lines.push(`    profile: ${opts.profileName}`);
      }
      const tgChatId = tgBridgeRef.current?.chatId;
      if (tgChatId) {
        lines.push(``, `telegram:`, `  chat_id: ${tgChatId}`);
      }
      await mkdir(ROOMS_DIR, { recursive: true });
      const roomFile = join(ROOMS_DIR, `${roomName}.yaml`);
      await writeFile(roomFile, lines.join('\n') + '\n');
      sysOut(`room "${roomName}" saved -> ${dp(roomFile)}`);
    } catch (e) { sysOut(`!! ${e.message}`); }
    return true;
  }

  return false;
}
