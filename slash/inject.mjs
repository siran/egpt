// slash/inject.mjs — deliver a FILE to a room or an @mention, in the target's
// native format (operator 2026-05-26; supersedes the old summary-/inject).
//
//   /inject <file> <room>            deliver to every room member, format-aware
//   /inject <file> @waN | <jid>      send to a WA chat as its native attachment
//   /inject <file> @e | @l | <brain> feed the file's content to a brain
//   ... --inline                     force the file's TEXT inline (no attachment)
//
// <file> resolves from: an absolute path, the room's files dir
// (~/.egpt/rooms/<room>/files/), ~/.egpt/, or the cwd. WA groups get a real
// attachment via bridge.sendMedia (image/video/document); brains get the
// content as context; TG groups get the text inline (no TG media path yet).

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join, basename } from 'node:path';
import { homedir } from 'node:os';
import { loadRooms, getRoom, roomFilesDir, sanitizeName } from '../src/rooms.mjs';

export const meta = {
  cmd: '/inject',
  section: 'BRAINS',
  surface: 'both',
  usage: '/inject <file> <room|@waN|@brain> [--inline]',
  desc: 'deliver a FILE to a room or @mention in the target\'s native format — WA attachment (image/video/doc) to a group, content as context to a brain. --inline forces the file text inline. Resolves the file from the room files dir, an absolute path, ~/.egpt, or the cwd.',
  subs: [
    { name: '<file> <room>',  usage: '/inject <file> <room>',  desc: 'deliver to every room member, format-aware', example: '/inject agenda.pdf estudio' },
    { name: '<file> @waN',    usage: '/inject <file> @waN',    desc: 'send to a WA chat as its native attachment', example: '/inject photo.jpg @wa3' },
    { name: '<file> @brain',  usage: '/inject <file> @e',      desc: 'feed the file content to a brain as context', example: '/inject notes.md @e' },
  ],
};

export async function run({ arg, ctx }) {
  const { sysOut, waBridgeRef, bridgeRef, setItems, computeBrainTurn, waChannelsCacheRef } = ctx;
  const parts = String(arg ?? '').trim().split(/\s+/).filter(Boolean);
  const inline = parts.includes('--inline');
  const rest = parts.filter(p => p !== '--inline');
  const fileArg = rest[0];
  const target = rest[1];
  if (!fileArg || !target) { sysOut(`usage: ${meta.usage}`); return true; }

  // Is the target a known room?
  const rooms = await loadRooms();
  const roomName = getRoom(rooms, target) ? sanitizeName(target) : null;

  // Resolve the file path.
  const candidates = [];
  if (isAbsolute(fileArg)) candidates.push(fileArg);
  else {
    if (roomName) candidates.push(join(roomFilesDir(roomName), fileArg));
    candidates.push(join(homedir(), '.egpt', fileArg));
    candidates.push(join(process.cwd(), fileArg));
  }
  const path = candidates.find(existsSync);
  if (!path) {
    sysOut(`!! /inject: file not found: ${fileArg} (looked in ${roomName ? 'the room files dir, ' : ''}~/.egpt, cwd; or pass an absolute path)`);
    return true;
  }

  const wa = waBridgeRef?.current ?? null;
  const readText = async () => { try { return await readFile(path, 'utf8'); } catch { return null; } };

  const deliverToWa = async (jid, label) => {
    if (inline) {
      const text = await readText();
      if (text == null) { sysOut(`!! /inject --inline: ${basename(path)} isn't text`); return; }
      wa?.send(text, { chatId: jid });
    } else if (wa?.sendMedia) {
      await wa.sendMedia({ chatId: jid, path });
    } else { sysOut('!! /inject: WA bridge has no sendMedia'); return; }
    sysOut(`/inject ${basename(path)} → ${label ?? jid}${inline ? ' (inline)' : ''}`);
  };

  const deliverToTg = async (chatId, label) => {
    const tg = bridgeRef?.current ?? null;
    if (inline || !tg?.sendMedia) {
      const text = await readText();
      if (text == null) { sysOut(`!! /inject: ${basename(path)} isn't text (TG needs sendMedia for binaries)`); return; }
      tg?.send(text, { chatId });
    } else {
      await tg.sendMedia(chatId, { path });
    }
    sysOut(`/inject ${basename(path)} → ${label ?? `tg:${chatId}`}${inline ? ' (inline)' : ''}`);
  };

  const deliverToBrain = async (id) => {
    const text = await readText();
    const body = text != null
      ? `[injected file: ${basename(path)}]\n\n${text}`
      : `[injected file: ${basename(path)} — binary, on disk at ${path}]`;
    try {
      const reply = await computeBrainTurn(id, body, {});
      const r = String(reply ?? '').trim();
      sysOut(`/inject ${basename(path)} → @${id}${r && r !== '...' && r !== '…' ? ` — "${r.slice(0, 80)}${r.length > 80 ? '…' : ''}"` : ''}`);
    } catch (e) { sysOut(`!! /inject → @${id}: ${e?.message ?? e}`); }
  };

  // Room target → fan to all members in their native format.
  if (roomName) {
    const room = getRoom(rooms, roomName);
    for (const m of (room.members ?? [])) {
      if (m.kind === 'wa-group') await deliverToWa(m.id, m.id);
      else if (m.kind === 'tg-group') await deliverToTg(m.id);
      else if (m.kind === 'brain') await deliverToBrain(m.id);
      else if (m.kind === 'shell' || m.kind === 'extension')
        setItems(p => [...p, { id: Date.now() + Math.random(), author: `inject@${roomName}`, body: `📎 ${basename(path)} (${path})` }]);
    }
    sysOut(`/inject ${basename(path)} → room "${roomName}" (${(room.members ?? []).length} members)`);
    return true;
  }

  // @waN → resolve via the last /channels listing.
  const waN = target.match(/^@wa(\d+)$/i);
  if (waN) {
    const chat = waChannelsCacheRef?.current?.[parseInt(waN[1], 10) - 1];
    if (!chat) { sysOut(`!! /inject: no chat at ${target} — /channels first`); return true; }
    await deliverToWa(chat.jid, chat.name ?? chat.jid);
    return true;
  }
  // Raw WA jid.
  if (/@(g\.us|s\.whatsapp\.net|lid)$/i.test(target)) { await deliverToWa(target, target); return true; }
  // Telegram chat.
  if (target.toLowerCase().startsWith('tg:')) { await deliverToTg(target.slice(3), target); return true; }
  // Otherwise a brain (@e / @l / <name>).
  await deliverToBrain(target.replace(/^@/, '').toLowerCase());
  return true;
}
