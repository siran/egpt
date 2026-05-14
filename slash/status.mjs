// slash/status.mjs — room snapshot: file, interfaces, participants.

import * as cdp from '../tools/cdp.mjs';

export const meta = {
  cmd: '/status',
  section: 'ROOM',
  surface: 'shell',
  usage: '/status',
  desc: 'room snapshot: sessions, files, config',
};

export async function run({ ctx }) {
  // ctx keys consumed:
  //   sysOut(text)
  //   getFile()       — current conversation md path
  //   dp(p)           — path display formatter
  //   tgBridgeRef     — React ref → telegram bridge (chatId, etc.)
  //   sessions        — sessions object snapshot
  const { sysOut, getFile, dp, tgBridgeRef, sessions } = ctx;

  let tabsByid = new Map();
  try {
    const tabs = await cdp.listTabs();
    for (const t of tabs) tabsByid.set(t.id, t);
  } catch {}

  const lines = [
    '── STATUS ───────────────────────────────────────────',
    `file:  ${dp(getFile())}`,
    '',
    '── INTERFACES ───────────────────────────────────────',
    '  console     active',
  ];

  const tgBridge = tgBridgeRef.current;
  if (tgBridge) {
    const chatInfo = tgBridge.chatId
      ? `connected · chat ${tgBridge.chatId}`
      : 'connected (no incoming messages yet)';
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
          : opts.targetId
            ? `tab: ${opts.targetId.slice(0, 8)}… (not found in Chrome)`
            : 'no tab bound';
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
  sysOut(lines.join('\n'), { _themed: true });
  return true;
}
