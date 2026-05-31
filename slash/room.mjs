// slash/room.mjs — multi-member rooms (operator 2026-05-26, simplified
// 2026-05-31 to drop the per-session set / dual-truth UX).
//
// A room is a named shared space whose members are WhatsApp groups, Telegram
// groups, brains, or the shell. Every member RECEIVES the room; per-member
// state gates what it CONTRIBUTES (mirrors the auto-modes): muted / mention
// / active.
//
// Persistence rule (KISS, operator 2026-05-31):
//   - wa-group / tg-group / brain memberships PERSIST in config.yaml.
//   - shell membership is SESSION-ONLY (stripped at load + save in
//     src/rooms.mjs). Each new shell starts outside all rooms; operator
//     joins per-session via `/room <name> join`.
//
// Command shape:
//   /room                          list rooms + member counts
//   /room create <name>            make a room
//   /room <name>                   show the room's members + states
//   /room <name> members [search]  same, with optional name/jid filter
//   /room <name> join [<member>]   add member. <member> defaults to current
//                                  surface (shell from shell, current WA
//                                  chat from WA). Already a member? say so.
//   /room <name> active <member>   require member; set to active
//   /room <name> mention <member>  require member; set to mention
//   /room <name> mute <member>     require member; set to muted
//   /room <name> leave             no member arg; current surface leaves
//   /room <name> delete            delete the room
//
// <member> formats: @waN (from /channels) · raw jid · tg:<chatId> ·
// @e / @l / <brain-name> · shell / @shell · extension / @extension.

import { resolveChatTarget } from '../conversations-state.mjs';
import {
  loadRooms, saveRooms, createRoom, deleteRoom, addMember, removeMember,
  setMemberState, getRoom, listRooms, normalizeMemberState,
} from '../src/rooms.mjs';

export const meta = {
  cmd: '/room',
  section: 'ROOM',
  surface: 'both',
  usage: '/room | create <name> | <name> [members [search] | join [<member>] | active|mute|mention <member> | leave | delete]',
  desc: 'multi-member rooms: WA/TG groups + brains + this shell share one space. Members join muted (lurk); active = full two-way; mention = only @mentions enter.',
  subs: [
    { name: 'create',  usage: '/room create <name>',                 desc: 'create a room', example: '/room create estudio' },
    { name: 'join',    usage: '/room <name> join [<member>]',        desc: 'add a member. <member> defaults to current surface (shell from shell, current WA chat from WA). Re-joining an existing member is informational; no state change.', example: '/room estudio join @e' },
    { name: 'active',  usage: '/room <name> active <member>',        desc: 'full two-way: the member contributes everything to the room. <member> REQUIRED.', example: '/room estudio active @wa3' },
    { name: 'mention', usage: '/room <name> mention <member>',       desc: 'only the member messages that @mention a room participant enter. <member> REQUIRED.', example: '/room estudio mention @wa3' },
    { name: 'mute',    usage: '/room <name> mute <member>',          desc: 'lurk: the member receives the room but contributes nothing. <member> REQUIRED.', example: '/room estudio mute @wa3' },
    { name: 'members', usage: '/room <name> members [search]',       desc: "list a room's members + states; optional search narrows by name/jid", example: '/room estudio members egpt2' },
    { name: 'leave',   usage: '/room <name> leave',                  desc: 'current surface leaves the room (no <member> arg accepted)', example: '/room estudio leave' },
    { name: 'delete',  usage: '/room <name> delete',                 desc: 'delete the room', example: '/room estudio delete' },
  ],
  notes: [
    'state aliases: active = on / unmute / unmuted / open  ·  muted = mute / silent  ·  mention (no aliases)',
    '<member> formats: @waN (from /channels) · raw jid · tg:<chatId> · @e / @l / <brain-name> · shell / @shell',
    'shell membership is SESSION-ONLY: each new interactive shell starts outside ALL rooms. Persisted config.yaml never stores shell entries.',
  ],
};

const KIND_ICON = { 'wa-group': '💬', 'tg-group': '📱', brain: '🧠', shell: '🖥️', extension: '🧩' };
const STATE_ICON = { muted: '🔇', mention: '@', active: '🔊' };

// Resolve an explicit member token (must be provided by caller). Returns
// { kind, id, label } or { error }. Empty token returns { error } so
// callers that need a defaulted-to-current-surface lookup must do that
// themselves (see resolveMemberArg below).
async function resolveMember(token, ctx) {
  const t = String(token ?? '').trim();
  if (!t) return { error: 'no member given' };
  // shell / @shell -> the shell itself
  if (/^@?shell$/i.test(t) || /@shell\b/i.test(t)) {
    return { kind: 'shell', id: 'shell', label: 'shell' };
  }
  if (/^@?ext(ension)?$/i.test(t) || /@(ext|extension)\b/i.test(t)) {
    return { kind: 'extension', id: 'extension', label: 'extension' };
  }
  // Brain: @e / @l / bare name that isn't a chat token.
  if (/^@?(e|egpt|l|local|[a-z][a-z0-9_-]{0,23})$/i.test(t) && !t.includes('.') && !t.startsWith('tg:') && !/^@wa\d+$/i.test(t) && !t.includes('@g.us') && !t.includes('@s.whatsapp') && !t.includes('@lid')) {
    const id = t.replace(/^@/, '').toLowerCase();
    return { kind: 'brain', id, label: `@${id}` };
  }
  if (t.toLowerCase().startsWith('tg:')) {
    return { kind: 'tg-group', id: t.slice(3), label: `tg:${t.slice(3)}` };
  }
  const waN = t.match(/^@wa(\d+)$/i);
  if (waN) {
    const chat = ctx.waChannelsCacheRef?.current?.[parseInt(waN[1], 10) - 1];
    if (!chat) return { error: `no chat at ${t} — run /channels first to populate indices` };
    return { kind: 'wa-group', id: chat.jid, label: chat.name ?? chat.jid };
  }
  const r = await resolveChatTarget(t, { waBridge: ctx.waBridgeRef?.current ?? null, surface: 'whatsapp' });
  if (r.error) return { error: r.error };
  if (r.jid) return { kind: 'wa-group', id: r.jid, label: r.name ?? r.jid };
  return { error: `could not resolve member "${t}"` };
}

// Display name for a member, or null when the id is the only handle.
function memberName(m, ctx) {
  if (m.kind === 'wa-group') {
    const nm = ctx?.waBridgeRef?.current?.getChatName?.(m.id);
    return nm && nm !== m.id ? nm : null;
  }
  return null;
}

// Build a view of the room that overlays in-memory shell membership from
// ctx.shellRoomsMap onto the persisted (shell-stripped) state. Read paths
// (display, "already a member?" checks) consult this; mutation paths still
// route to persisted state OR the shell map depending on member kind.
function viewRoom(state, roomName, ctx) {
  const room = getRoom(state, roomName);
  if (!room) return null;
  const shellInfo = ctx.shellRoomsMap?.current?.get(roomName);
  if (!shellInfo) return room;
  const members = (room.members ?? []).filter(m => m.id !== 'shell');
  members.push({ kind: 'shell', id: 'shell', state: shellInfo.state });
  return { ...room, members };
}

function fmtMembers(room, ctx, search) {
  const ms = room?.members ?? [];
  if (!ms.length) return '  (no members)';
  const term = String(search ?? '').trim().toLowerCase();
  const rows = ms.map(m => {
    const nm = memberName(m, ctx);
    return { m, nm, hay: `${nm ?? ''} ${m.id}`.toLowerCase() };
  });
  const shown = term ? rows.filter(r => r.hay.includes(term)) : rows;
  if (term && !shown.length) return `  (no member matches "${search}")`;
  return shown.map((r, i) => {
    const icon = KIND_ICON[r.m.kind] ?? '?';
    const st = `${STATE_ICON[r.m.state] ?? ''} ${r.m.state}`.trim();
    const label = r.nm ? `${r.nm} — ` : '';
    return `  ${i + 1}. ${icon} ${st} · ${label}${r.m.id}`;
  }).join('\n');
}

// Mutators that route to shell map (in-memory) or persisted state by kind.
function shellSetState(ctx, roomName, state) {
  ctx.shellRoomsMap?.current?.set(roomName, { state });
  ctx.bumpShellRooms?.();
}
function shellRemove(ctx, roomName) {
  const had = ctx.shellRoomsMap?.current?.delete(roomName);
  if (had) ctx.bumpShellRooms?.();
  return !!had;
}
function shellGetState(ctx, roomName) {
  return ctx.shellRoomsMap?.current?.get(roomName)?.state ?? null;
}

export async function run({ arg, ctx, meta = {} }) {
  const { sysOut } = ctx;
  const parts = String(arg ?? '').trim().split(/\s+/).filter(Boolean);
  let state = await loadRooms();

  // Default-to-current-surface for join/leave only. For active/mute/mention
  // the operator must spell out the member explicitly (operator 2026-05-31).
  const resolveDefaultedToSurface = async (tok) => {
    if (tok) return resolveMember(tok, ctx);
    if (meta?.waChatId) {
      const id = meta.waChatId;
      return { kind: 'wa-group', id, label: ctx.waBridgeRef?.current?.getChatName?.(id) ?? id };
    }
    // No token, no WA chat context => invoked from the shell.
    return { kind: 'shell', id: 'shell', label: 'shell' };
  };

  // /room — list all (with shell-membership overlay for accurate counts).
  if (!parts.length) {
    const rooms = listRooms(state);
    if (!rooms.length) { sysOut('no rooms yet — /room create <name>'); return true; }
    sysOut(rooms.map(r => {
      const view = viewRoom(state, r.name, ctx);
      const n = view?.members?.length ?? 0;
      return `📂 ${r.name} (${n} member${n === 1 ? '' : 's'})`;
    }).join('\n'));
    return true;
  }

  if (parts[0] === 'create') {
    const name = parts[1];
    if (!name) { sysOut('usage: /room create <name>'); return true; }
    try { state = createRoom(state, name); await saveRooms(state); }
    catch (e) { sysOut(`!! /room create: ${e.message}`); return true; }
    sysOut(`📂 room created — /room ${name} to view, /room ${name} join to add yourself`);
    return true;
  }

  const name = parts[0];
  const action = parts[1];
  if (!getRoom(state, name)) { sysOut(`!! no room "${name}" — /room create ${name}`); return true; }

  // /room <name> [members [search]] — show with shell overlay
  if (!action || action === 'members') {
    const view = viewRoom(state, name, ctx);
    const search = action === 'members' ? parts.slice(2).join(' ') : '';
    const header = search ? `📂 ${name} members matching "${search}"` : `📂 ${name}`;
    sysOut(`${header}\n${fmtMembers(view, ctx, search)}`);
    return true;
  }

  if (action === 'delete') {
    try { state = deleteRoom(state, name); await saveRooms(state); }
    catch (e) { sysOut(`!! /room delete: ${e.message}`); return true; }
    // Also drop session shell membership if we had one.
    shellRemove(ctx, name);
    sysOut(`📂 room "${name}" deleted`);
    return true;
  }

  if (action === 'join') {
    const m = await resolveDefaultedToSurface(parts[2]);
    if (m.error) { sysOut(`!! /room ${name} join: ${m.error}`); return true; }
    // Already a member check (informational, no state change).
    if (m.kind === 'shell') {
      const cur = shellGetState(ctx, name);
      if (cur) { sysOut(`shell is already a member of ${name} (state: ${cur})`); return true; }
      shellSetState(ctx, name, 'active');   // explicit shell join => active
      sysOut(`📂 ${name} ← 🖥️ shell — joined 🔊 active (session-only). /room ${name} leave to stop.`);
      return true;
    }
    const existing = (getRoom(state, name)?.members ?? []).find(x => x.id === m.id);
    if (existing) {
      sysOut(`${m.label} (${m.id}) is already a member of ${name} (state: ${existing.state})`);
      return true;
    }
    const joinState = m.kind === 'brain' ? 'mention' : 'muted';
    try { state = addMember(state, name, { kind: m.kind, id: m.id, state: joinState }); await saveRooms(state); }
    catch (e) { sysOut(`!! /room ${name} join: ${e.message}`); return true; }
    const how = m.kind === 'brain'
      ? '@ blind (sees only @mentions; replies always mirror). /room ' + name + ' active <member> to let it see all.'
      : '🔇 muted (lurk). /room ' + name + ' active <member> to open two-way.';
    sysOut(`📂 ${name} ← ${KIND_ICON[m.kind]} ${m.label} (${m.id}) — joined ${how}`);
    return true;
  }

  // active / mute / mention — REQUIRE explicit member (operator 2026-05-31)
  const canonicalState = normalizeMemberState(action);
  if (canonicalState) {
    if (!parts[2]) {
      sysOut(`!! /room ${name} ${action}: missing member. usage: /room ${name} ${action} <member>\n  <member> = @waN | jid | tg:<id> | @e/@l/<brain> | shell`);
      return true;
    }
    const m = await resolveMember(parts[2], ctx);
    if (m.error) { sysOut(`!! /room ${name} ${action}: ${m.error}`); return true; }
    if (m.kind === 'shell') {
      // Shell state lives in the session map. Auto-join if not already a member.
      shellSetState(ctx, name, canonicalState);
      sysOut(`📂 ${name}: 🖥️ shell → ${STATE_ICON[canonicalState]} ${canonicalState} (session-only)`);
      return true;
    }
    try { state = setMemberState(state, name, m.id, canonicalState); await saveRooms(state); }
    catch (e) { sysOut(`!! /room ${name} ${action}: ${e.message}`); return true; }
    sysOut(`📂 ${name}: ${KIND_ICON[m.kind]} ${m.label} → ${STATE_ICON[canonicalState]} ${canonicalState}`);
    return true;
  }

  // leave — NO member arg (operator 2026-05-31). Current surface leaves.
  if (action === 'leave') {
    if (parts[2]) {
      sysOut(`!! /room ${name} leave: does not accept a member arg. To remove a specific member, use /room ${name} delete (room) or run leave from that member's surface.`);
      return true;
    }
    const m = await resolveDefaultedToSurface(null);
    if (m.kind === 'shell') {
      if (!shellRemove(ctx, name)) { sysOut(`shell is not currently in ${name}`); return true; }
      sysOut(`📂 ${name}: 🖥️ shell left (session-only; persisted membership unchanged)`);
      return true;
    }
    try { state = removeMember(state, name, m.id); await saveRooms(state); }
    catch (e) { sysOut(`!! /room ${name} leave: ${e.message}`); return true; }
    sysOut(`📂 ${name}: removed ${m.label}`);
    return true;
  }

  sysOut(`!! /room: unknown action "${action}". ${meta.usage}`);
  return true;
}
