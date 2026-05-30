// slash/rooms.mjs — /rooms (alias of /room for listing) and /save-room
// (legacy snapshot of current sessions). Active room CONFIG (members +
// states) lives in ~/.egpt/rooms/config.yaml and is owned by /room;
// /rooms info dumps that file.
//
//   /rooms                    list rooms with member counts (alias of /room)
//   /rooms info [<name>|all]  dump the YAML config — one room or every room

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';
import * as cdp from '../src/tools/cdp.mjs';
import { loadRooms, listRooms, getRoom, ROOMS_CONFIG_PATH, sanitizeName } from '../src/rooms.mjs';

const ROOMS_DIR = join(homedir(), '.egpt', 'rooms');

export const meta = [
  {
    cmd: '/rooms',
    section: 'ROOM',
    surface: 'both',
    usage: '/rooms [info [<name>|all]]',
    desc: 'alias of /room for listing rooms; "/rooms info <name>" or "/rooms info all" dumps the YAML config',
    subs: [
      { name: 'info', usage: '/rooms info [<name>|all]',
        desc: 'dump the YAML config for one room or every room',
        example: '/rooms info test' },
    ],
  },
  {
    cmd: '/save-room',
    section: 'ROOM',
    surface: 'shell',
    usage: '/save-room [name]',
    desc: 'snapshot current sessions + telegram chat_id to ~/.egpt/rooms/<name>.yaml (legacy)',
  },
];

export async function run({ cmd, arg, ctx }) {
  // ctx keys consumed:
  //   sysOut(text)
  //   dp(p)
  //   sessions, tgBridgeRef, ts        — /save-room only
  const { sysOut, dp, sessions, tgBridgeRef, ts } = ctx;

  if (cmd === '/rooms') {
    const parts = String(arg ?? '').trim().split(/\s+/).filter(Boolean);

    // Resolved view of a room: wa-group members get a `name` annotation from
    // the bridge so the dump shows the readable handle next to the opaque jid.
    // Operator 2026-05-30 ("it is not showing how a group could be mentioned"):
    // the jid alone doesn't tell you which group is which; the name is what
    // resolveChatTarget matches against, so it's what the operator addresses
    // a member by. Brain/shell/extension/tg members already carry their id.
    const _annotate = (room) => {
      const waBridge = ctx.waBridgeRef?.current;
      const members = (room?.members ?? []).map(m => {
        if (m.kind !== 'wa-group') return m;
        const nm = waBridge?.getChatName?.(m.id);
        return (nm && nm !== m.id) ? { kind: m.kind, id: m.id, name: nm, state: m.state } : m;
      });
      return { ...room, members };
    };

    // /rooms info [<name>|all] — YAML dump (annotated view; not the raw file)
    if (parts[0] === 'info') {
      const which = (parts[1] ?? 'all').toLowerCase();
      if (!existsSync(ROOMS_CONFIG_PATH)) {
        sysOut(`(no rooms yet — config at ${dp(ROOMS_CONFIG_PATH)} does not exist; /room create <name> to start)`);
        return true;
      }
      const state = await loadRooms();
      if (which === 'all' || which === '*') {
        const annotated = { rooms: Object.fromEntries(
          Object.entries(state?.rooms ?? {}).map(([k, r]) => [k, _annotate(r)])) };
        const yaml = YAML.stringify(annotated, { lineWidth: 100 });
        sysOut(`# ${dp(ROOMS_CONFIG_PATH)} (annotated: wa-group .name resolved from the bridge)\n${yaml.trimEnd()}`);
        return true;
      }
      const room = getRoom(state, which);
      if (!room) {
        const names = Object.keys(state?.rooms ?? {});
        sysOut(`!! no room "${which}"${names.length ? ` — available: ${names.join(', ')}` : ' — none defined yet'}`);
        return true;
      }
      const block = YAML.stringify({ rooms: { [sanitizeName(which)]: _annotate(room) } }, { lineWidth: 100 });
      sysOut(`# ${dp(ROOMS_CONFIG_PATH)} · room "${sanitizeName(which)}" (annotated: wa-group .name resolved from the bridge)\n${block.trimEnd()}`);
      return true;
    }

    // /rooms — list (alias of /room with no args). One source of truth via loadRooms.
    if (!parts.length) {
      const state = await loadRooms();
      const rooms = listRooms(state);
      if (!rooms.length) { sysOut('no rooms yet — /room create <name>'); return true; }
      sysOut(rooms.map(r =>
        `📂 ${r.name} (${r.members.length} member${r.members.length === 1 ? '' : 's'})`).join('\n'));
      return true;
    }

    sysOut(`!! /rooms: unknown subcommand "${parts[0]}". usage: /rooms [info [<name>|all]]`);
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
