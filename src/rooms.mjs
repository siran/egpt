// rooms.mjs — the multi-member "room" data model (operator 2026-05-26).
//
// A room is a named shared space whose MEMBERS are WhatsApp groups, Telegram
// groups, or brains (residents). Every member RECEIVES the room; a member's
// `state` gates only what it CONTRIBUTES, mirroring the per-chat auto-modes:
//   muted   — nothing the member says enters the room (lurk)
//   mention — only messages that @mention a room participant enter
//   active  — everything the member says echoes into the room
// Members join `muted`. Roster persists in ~/.egpt/rooms/config.yaml; each
// room also has a files dir (~/.egpt/rooms/<name>/files/) for /inject.
//
// This module is the PURE state model + thin YAML load/save. The runtime
// routing engine (moving messages between members per state) is separate.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import * as YAML from 'yaml';

export const ROOM_MEMBER_STATES = ['muted', 'mention', 'active'];
export const ROOM_MEMBER_KINDS  = ['wa-group', 'tg-group', 'brain', 'shell', 'extension'];
export const DEFAULT_MEMBER_STATE = 'muted';

// Operator-friendly aliases for the room member state — `/room test on shell`
// or `/room test unmute shell` reads more naturally than `active`, but they
// all mean the same input gate. Normalize to the canonical word here so the
// stored state stays predictable. Unknown tokens return null.
const _MEMBER_STATE_ALIASES = {
  muted:    'muted',  mute:    'muted', silent: 'muted',
  mention:  'mention',
  active:   'active', on:      'active', unmute: 'active', unmuted: 'active', open: 'active',
};

export function normalizeMemberState(token) {
  const t = String(token ?? '').trim().toLowerCase();
  return _MEMBER_STATE_ALIASES[t] ?? null;
}

// Recognized — useful for the CLI to know "this looks like a state word" before
// it commits to the parse (e.g. distinguishing a state token from a member id).
export function isMemberStateAlias(token) {
  return normalizeMemberState(token) !== null;
}

export const ROOMS_CONFIG_PATH = join(homedir(), '.egpt', 'rooms', 'config.yaml');
export const roomFilesDir = (name) => join(homedir(), '.egpt', 'rooms', sanitizeName(name), 'files');

export function sanitizeName(name) {
  return String(name ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'room';
}

export function emptyRooms() { return { rooms: {} }; }

function _clone(state) {
  return { rooms: Object.fromEntries(Object.entries(state?.rooms ?? {}).map(([k, v]) => [k, { ...v, members: [...(v.members ?? [])] }])) };
}

export function listRooms(state) {
  return Object.entries(state?.rooms ?? {}).map(([name, r]) => ({ name, members: r.members ?? [], created: r.created ?? null }));
}

export function getRoom(state, name) {
  return state?.rooms?.[sanitizeName(name)] ?? null;
}

export function createRoom(state, name) {
  const key = sanitizeName(name);
  const next = _clone(state);
  if (next.rooms[key]) throw new Error(`room "${key}" already exists`);
  next.rooms[key] = { members: [], created: new Date().toISOString() };
  return next;
}

export function deleteRoom(state, name) {
  const key = sanitizeName(name);
  const next = _clone(state);
  if (!next.rooms[key]) throw new Error(`room "${key}" does not exist`);
  delete next.rooms[key];
  return next;
}

// Add (or update) a member. New members default to `muted`. `id` is the WA jid
// / TG chat id / brain name; identity within a room. For a `brain` member the
// session it represents travels WITH it — `brain` (type) + `options`
// ({url,targetId,sessionId,cwd,model,...}) + optional `emoji`/`bio`. That is the
// sessions→members unification: a brain member IS its session (ROOMS-UNIFICATION.md).
// Re-adding a brain member merges any provided session fields (so /attach can
// update a tab's targetId without losing state); its current `state` is kept.
export function addMember(state, name, { kind, id, state: memberState = DEFAULT_MEMBER_STATE, brain, options, emoji, bio } = {}) {
  const key = sanitizeName(name);
  if (!ROOM_MEMBER_KINDS.includes(kind)) throw new Error(`unknown member kind "${kind}" (expected ${ROOM_MEMBER_KINDS.join('|')})`);
  if (!id) throw new Error('member id required');
  if (!ROOM_MEMBER_STATES.includes(memberState)) throw new Error(`unknown state "${memberState}"`);
  const next = _clone(state);
  if (!next.rooms[key]) throw new Error(`room "${key}" does not exist`);
  const members = next.rooms[key].members;
  const existing = members.find(m => m.id === id);
  const applyBrainFields = (m) => {
    if (kind !== 'brain') return;
    if (brain !== undefined)   m.brain = brain;
    if (options !== undefined) m.options = options;
    if (emoji !== undefined)   m.emoji = emoji;
    if (bio !== undefined)     m.bio = bio;
  };
  if (existing) { existing.kind = kind; applyBrainFields(existing); }   // keep current state on re-add
  else { const m = { kind, id, state: memberState }; applyBrainFields(m); members.push(m); }
  return next;
}

export function removeMember(state, name, id) {
  const key = sanitizeName(name);
  const next = _clone(state);
  if (!next.rooms[key]) throw new Error(`room "${key}" does not exist`);
  next.rooms[key].members = next.rooms[key].members.filter(m => m.id !== id);
  return next;
}

export function setMemberState(state, name, id, memberState) {
  const key = sanitizeName(name);
  if (!ROOM_MEMBER_STATES.includes(memberState)) throw new Error(`unknown state "${memberState}" (expected ${ROOM_MEMBER_STATES.join('|')})`);
  const next = _clone(state);
  const room = next.rooms[key];
  if (!room) throw new Error(`room "${key}" does not exist`);
  const m = room.members.find(x => x.id === id);
  if (!m) throw new Error(`"${id}" is not a member of "${key}"`);
  m.state = memberState;
  return next;
}

// Every room a given member belongs to, with its per-room state — the lookup
// the runtime routing engine will use on each inbound message.
export function roomsForMember(state, id) {
  const out = [];
  for (const [name, r] of Object.entries(state?.rooms ?? {})) {
    const m = (r.members ?? []).find(x => x.id === id);
    if (m) out.push({ name, kind: m.kind, state: m.state });
  }
  return out;
}

// Build the in-memory `sessions` map (id → { brain, options, emoji?, bio? }) from
// a room's brain members — the adapter that lets the App + resolveRoute be fed
// FROM membership (Phase 1 of the sessions→members unification) before the
// routing core is flipped to read members directly. Returns a plain object in
// the same shape as the legacy roomSessionsMap[room]. Non-brain members are
// skipped (they aren't sessions).
export function sessionsMapFromMembers(state, name) {
  const key = sanitizeName(name);
  const room = state?.rooms?.[key];
  const out = {};
  if (!room) return out;
  for (const m of room.members ?? []) {
    if (m.kind !== 'brain') continue;
    const s = { brain: m.brain ?? null, options: m.options ?? {} };
    if (m.emoji) s.emoji = m.emoji;
    if (m.bio)   s.bio = m.bio;
    out[m.id] = s;
  }
  return out;
}

// ── thin fs load/save ──────────────────────────────────────────────────────

export async function loadRooms(path = ROOMS_CONFIG_PATH) {
  try {
    if (!existsSync(path)) return emptyRooms();
    const doc = YAML.parse(await readFile(path, 'utf8'));
    if (!doc || typeof doc !== 'object' || typeof doc.rooms !== 'object') return emptyRooms();
    return { rooms: doc.rooms ?? {} };
  } catch (e) {
    console.error(`!! loadRooms(${path}): ${e?.message ?? e}`);
    return emptyRooms();
  }
}

export async function saveRooms(state, path = ROOMS_CONFIG_PATH) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, YAML.stringify(state, { lineWidth: 100 }), 'utf8');
}
