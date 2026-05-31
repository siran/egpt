// slash/room.mjs — multi-member rooms (operator 2026-05-26, supersedes the
// legacy shell-session-bundle /room).
//
// A room is a named shared space whose members are WhatsApp groups, Telegram
// groups, or brains. Every member RECEIVES the room; per-member state gates
// what it CONTRIBUTES (mirrors the auto-modes): muted / mention / active.
// Members join muted.
//
//   /room                          list rooms + members
//   /room create <name>            make a room
//   /room <name>                   show a room's members + states
//   /room <name> join <member>     add a member (enters muted)
//   /room <name> active|mute|mention <member>   set a member's contribution
//   /room <name> leave <member>    remove a member
//   /room <name> members           list members
//   /room <name> delete            delete the room
//
// <member> is @waN (from the last /channels) or a WA jid, tg:<chatId>, or a
// brain (@e / @l / <name>).

import { resolveChatTarget } from '../conversations-state.mjs';
import {
  loadRooms, saveRooms, createRoom, deleteRoom, addMember, removeMember,
  setMemberState, getRoom, listRooms, ROOM_MEMBER_STATES, normalizeMemberState,
} from '../src/rooms.mjs';

export const meta = {
  cmd: '/room',
  section: 'ROOM',
  surface: 'both',
  usage: '/room | create <name> | <name> [join|active|mute|mention|leave <member> | members | delete]',
  desc: 'multi-member rooms: WA/TG groups + brains share one space. Members join muted (lurk); active = full two-way; mention = only @mentions enter. <member> = @waN | jid | tg:<id> | @e/@l/<brain>.',
  subs: [
    { name: 'create',  usage: '/room create <name>',                 desc: 'create a room', example: '/room create estudio' },
    { name: 'join',    usage: '/room <name> join <member>',          desc: 'add a member (WA group/jid, tg:<id>, or @e/@l/<brain>) — enters muted', example: '/room estudio join @e' },
    { name: 'enter',   usage: '/room <name> enter',                  desc: 'shell-only, per-session: start CONTRIBUTING this shell to <name>. Persisted member state is unchanged; opt-out via `leave` or just exit the shell.', example: '/room test enter' },
    { name: 'leave-here', usage: '/room <name> leave (no member)',   desc: 'shell-only, per-session: stop CONTRIBUTING this shell to <name>. Persisted membership unchanged.', example: '/room test leave' },
    { name: 'active',  usage: '/room <name> active <member>',        desc: 'full two-way: the member contributes everything to the room', example: '/room estudio active @wa3' },
    { name: 'mention', usage: '/room <name> mention <member>',       desc: 'only the member messages that @mention a room participant enter the room', example: '/room estudio mention @wa3' },
    { name: 'mute',    usage: '/room <name> mute <member>',          desc: 'lurk: the member receives the room but contributes nothing', example: '/room estudio mute @wa3' },
    { name: 'members', usage: '/room <name> members [search]',       desc: "list a room's members + states (names resolved); optional search narrows by group name/jid", example: '/room estudio members egpt2' },
    { name: 'leave',   usage: '/room <name> leave <member>',         desc: 'remove a member from the room (persisted)', example: '/room estudio leave @wa3' },
    { name: 'delete',  usage: '/room <name> delete',                 desc: 'delete the room', example: '/room estudio delete' },
  ],
  notes: [
    'state aliases: active = on / unmute / unmuted / open  ·  muted = mute / silent  ·  mention (no aliases)',
    '<member> omitted from shell: defaults to "shell"; from a WA chat: defaults to the current WA chat',
    '<member> formats: @waN (from /channels) · raw jid · tg:<chatId> · @e / @l / <brain-name>',
    'shell membership is PER-SESSION: each new shell starts contributing to NO rooms. `/room <name> enter` opts in for this session only; persisted shell-active members in config.yaml are no longer auto-contributing (operator 2026-05-31).',
  ],
};

const KIND_ICON = { 'wa-group': '💬', 'tg-group': '📱', brain: '🧠', shell: '🖥️', extension: '🧩' };
const STATE_ICON = { muted: '🔇', mention: '@', active: '🔊' };

// Resolve a member token → { kind, id, label } or { error }.
async function resolveMember(token, ctx) {
  const t = String(token ?? '').trim();
  if (!t) return { error: 'no member given' };
  // Brain: @e / @l / bare name that isn't a chat token.
  if (/^@?(e|egpt|l|local|[a-z][a-z0-9_-]{0,23})$/i.test(t) && !t.includes('.') && !t.startsWith('tg:') && !/^@wa\d+$/i.test(t) && !t.includes('@g.us') && !t.includes('@s.whatsapp') && !t.includes('@lid')) {
    const id = t.replace(/^@/, '').toLowerCase();
    return { kind: 'brain', id, label: `@${id}` };
  }
  // Telegram group.
  if (t.toLowerCase().startsWith('tg:')) {
    return { kind: 'tg-group', id: t.slice(3), label: `tg:${t.slice(3)}` };
  }
  // WA by @waN index (last /channels listing).
  const waN = t.match(/^@wa(\d+)$/i);
  if (waN) {
    const chat = ctx.waChannelsCacheRef?.current?.[parseInt(waN[1], 10) - 1];
    if (!chat) return { error: `no chat at ${t} — run /channels first to populate indices` };
    return { kind: 'wa-group', id: chat.jid, label: chat.name ?? chat.jid };
  }
  // WA by raw jid or a name search.
  const r = await resolveChatTarget(t, { waBridge: ctx.waBridgeRef?.current ?? null, surface: 'whatsapp' });
  if (r.error) return { error: r.error };
  if (r.jid) return { kind: 'wa-group', id: r.jid, label: r.name ?? r.jid };
  return { error: `could not resolve member "${t}"` };
}

// Display name for a member, or null when the id is the only handle we have.
// wa-group jids are opaque (120363…@g.us), so resolve to the group's name via
// the bridge; tg/brain/shell/extension carry their id as the label already.
function memberName(m, ctx) {
  if (m.kind === 'wa-group') {
    const nm = ctx?.waBridgeRef?.current?.getChatName?.(m.id);
    return nm && nm !== m.id ? nm : null;
  }
  return null;
}

// Render a room's members, numbered. With `search`, filter to members whose
// name OR jid contains the term (case-insensitive) — so `/room test members
// egpt2` narrows by group name even though the jid is opaque. Numbering mirrors
// the help-menu Nx pattern: when several match, the operator can eyeball which.
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

export async function run({ arg, ctx, meta = {} }) {
  const { sysOut } = ctx;
  const parts = String(arg ?? '').trim().split(/\s+/).filter(Boolean);
  let state = await loadRooms();

  // Resolve a member token, or — when omitted and invoked from inside a WA
  // chat — default to THAT chat. Lets join/active/mute/mention/leave be run
  // from within the group itself (no @waN needed).
  const resolveMemberArg = async (tok) => {
    // 'shell' / a shell handle (egptbot@shell-NNN) → the shell, id 'shell'.
    if (tok && (/^@?shell$/i.test(tok) || /@shell\b/i.test(tok))) {
      return { kind: 'shell', id: 'shell', label: 'shell' };
    }
    if (tok && (/^@?ext(ension)?$/i.test(tok) || /@(ext|extension)\b/i.test(tok))) {
      return { kind: 'extension', id: 'extension', label: 'extension' };
    }
    if (!tok) {
      if (meta?.waChatId) {
        const id = meta.waChatId;
        return { kind: 'wa-group', id, label: ctx.waBridgeRef?.current?.getChatName?.(id) ?? id };
      }
      // No member + no WA chat context → invoked from the shell: join the shell.
      return { kind: 'shell', id: 'shell', label: 'shell' };
    }
    return resolveMember(tok, ctx);
  };

  // /room — list all.
  if (!parts.length) {
    const rooms = listRooms(state);
    if (!rooms.length) { sysOut('no rooms yet — /room create <name>'); return true; }
    sysOut(rooms.map(r => `📂 ${r.name} (${r.members.length} member${r.members.length === 1 ? '' : 's'})`).join('\n'));
    return true;
  }

  // /room create <name>
  if (parts[0] === 'create') {
    const name = parts[1];
    if (!name) { sysOut('usage: /room create <name>'); return true; }
    try { state = createRoom(state, name); await saveRooms(state); }
    catch (e) { sysOut(`!! /room create: ${e.message}`); return true; }
    sysOut(`📂 room created — /room ${name} to view, /room ${name} join <member> to add`);
    return true;
  }

  const name = parts[0];
  const action = parts[1];
  if (!getRoom(state, name)) { sysOut(`!! no room "${name}" — /room create ${name}`); return true; }

  // /room <name> [members [search]] — show. The optional search narrows the
  // member list by name/jid substring (numbered output).
  if (!action || action === 'members') {
    const room = getRoom(state, name);
    const search = action === 'members' ? parts.slice(2).join(' ') : '';
    const header = search ? `📂 ${name} members matching "${search}"` : `📂 ${name}`;
    sysOut(`${header}\n${fmtMembers(room, ctx, search)}`);
    return true;
  }

  // Shell per-session contribution: /room <name> enter / leave (no member) —
  // toggles whether THIS shell session contributes to <name>. Persisted
  // membership unchanged. Operator 2026-05-31: shell starts contributing to
  // nothing; opt-in per session via enter.
  if (action === 'enter' || (action === 'leave' && parts[2] === undefined)) {
    if (!ctx.shellSessionRoomsRef) {
      sysOut(`!! /room ${name} ${action}: shell session ref not wired into ctx (caller surface unsupported)`);
      return true;
    }
    if (action === 'enter') {
      ctx.shellSessionRoomsRef.current.add(name);
      ctx.bumpShellSessionRooms?.();
      sysOut(`📂 entered "${name}" — this shell will now mirror typed messages to its members (session-only).`);
    } else {
      ctx.shellSessionRoomsRef.current.delete(name);
      ctx.bumpShellSessionRooms?.();
      sysOut(`📂 left "${name}" — this shell will no longer mirror to its members (persisted membership unchanged).`);
    }
    return true;
  }

  if (action === 'delete') {
    try { state = deleteRoom(state, name); await saveRooms(state); }
    catch (e) { sysOut(`!! /room delete: ${e.message}`); return true; }
    sysOut(`📂 room "${name}" deleted`);
    return true;
  }

  if (action === 'join') {
    const m = await resolveMemberArg(parts[2]);
    if (m.error) { sysOut(`!! /room ${name} join: ${m.error}  (or just \`/room ${name} join\` from inside a WA chat to add it)`); return true; }
    // Groups join 'muted' (lurk — reception always on, contribute nothing).
    // Brains/operators join 'mention' = BLIND: they do NOT see general chatter
    // (cost), only messages that @mention them; their replies always mirror in.
    const joinState = m.kind === 'brain' ? 'mention' : 'muted';
    try { state = addMember(state, name, { kind: m.kind, id: m.id, state: joinState }); await saveRooms(state); }
    catch (e) { sysOut(`!! /room ${name} join: ${e.message}`); return true; }
    const how = m.kind === 'brain'
      ? '@ blind (sees only @mentions; replies always mirror to the room). /room ' + name + ' active <member> to let it see all.'
      : '🔇 muted (lurk). /room ' + name + ' active <member> to open two-way.';
    sysOut(`📂 ${name} ← ${KIND_ICON[m.kind]} ${m.label} (${m.id}) — joined ${how}`);
    return true;
  }

  // Accept any alias the operator might reach for — `on`/`unmute`/`active`
  // all land on `active`, `mute`/`silent`/`muted` on `muted`. Storage stays
  // canonical so the listing + routing logic stay simple.
  const canonicalState = normalizeMemberState(action);
  if (canonicalState) {
    const m = await resolveMemberArg(parts[2]);
    if (m.error) { sysOut(`!! /room ${name} ${action}: ${m.error}`); return true; }
    try { state = setMemberState(state, name, m.id, canonicalState); await saveRooms(state); }
    catch (e) { sysOut(`!! /room ${name} ${action}: ${e.message}`); return true; }
    sysOut(`📂 ${name}: ${KIND_ICON[m.kind]} ${m.label} → ${STATE_ICON[canonicalState]} ${canonicalState}`);
    return true;
  }

  if (action === 'leave') {
    const m = await resolveMemberArg(parts[2]);
    if (m.error) { sysOut(`!! /room ${name} leave: ${m.error}`); return true; }
    try { state = removeMember(state, name, m.id); await saveRooms(state); }
    catch (e) { sysOut(`!! /room ${name} leave: ${e.message}`); return true; }
    sysOut(`📂 ${name}: removed ${m.label}`);
    return true;
  }

  sysOut(`!! /room: unknown action "${action}". ${meta.usage}`);
  return true;
}
