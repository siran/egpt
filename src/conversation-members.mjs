// conversation-members.mjs — seed a conversation's unified members[] from the
// legacy config (Phase 1b-ii of the conversations↔rooms merge, GENOME §2.5).
//
// The end-state: a conversation's residents + their reply gate live in ONE place
// — the Room's config.yaml members[] (Room.members(), Phase 1a). Until a chat has
// an explicit members[], we SEED it from the two legacy stores so nothing breaks:
//   whatsapp.residents_per_chat[chat]  → WHICH brains participate (the roster)
//   the per-being auto-mode            → each member's STATE (its reply gate)
// Member state IS the auto-mode (Phase 1b-i), so the mode maps in losslessly
// (on→active, mute→muted; the other four are identical tokens).
//
// PURE: the per-being mode resolver is INJECTED (`modeFor`), so this module has
// no dependency on EGPT_CONFIG or the live resolvers and is fully testable. The
// host (egpt-spine.mjs, Phase 1b-iii) supplies `modeFor` = the existing E/sibling
// auto-mode resolution, so wiring this in preserves behavior exactly.

import { normalizeResidents } from './conversations-state.mjs';
import { normalizeMemberState, DEFAULT_MEMBER_STATE } from './room-core.mjs';

/**
 * Resolve the resident roster for a chat — an EXACT reproduction of the legacy
 * egpt-spine.mjs logic: a per-chat override wins, else the global list, else the
 * persona alone; disabled siblings (enabled:false) are dropped; never empty.
 * @returns {string[]} being names
 */
export function resolveRoster({ chatId, residentsPerChat = {}, globalResidents = null, personaBeing = 'e', siblings = {} } = {}) {
  const perChat = normalizeResidents(residentsPerChat?.[chatId]);
  const global = normalizeResidents(globalResidents);
  let roster = perChat.length ? perChat : (global.length ? global : [personaBeing]);
  roster = roster.filter((r) => siblings?.[r]?.enabled !== false);
  if (!roster.length) roster = [personaBeing];
  return roster;
}

/**
 * Seed members[] from a roster + a per-being mode resolver. Each resident becomes
 * a brain member whose state is its auto-mode mapped losslessly into a member
 * state. `modeFor(being)` → an auto-mode token (e.g. 'on'/'mention'/'off').
 * @returns {Array<{kind:'brain', id:string, state:string}>}
 */
export function seedMembers({ roster = [], modeFor = () => DEFAULT_MEMBER_STATE } = {}) {
  return roster.map((being) => ({
    kind: 'brain',
    id: String(being),
    state: normalizeMemberState(modeFor(being)) ?? DEFAULT_MEMBER_STATE,
  }));
}

/**
 * The unified resolution: an explicit members[] (the config.yaml store, Phase 1a)
 * WINS; otherwise seed from the legacy config. This is the bridge from "two
 * half-implementations" to "one members store" — once a chat has an explicit
 * members[], its legacy residents_per_chat/auto-mode seed is ignored.
 */
export function resolveMembers({ explicitMembers = [], roster = [], modeFor } = {}) {
  if (Array.isArray(explicitMembers) && explicitMembers.length) return explicitMembers;
  return seedMembers({ roster, modeFor });
}

/**
 * The dispatch roster from a resolved member list: the brain members that
 * RECEIVE the chat (every state except 'off' — mirrors auto-mode receives()).
 * A 'muted' member still receives (it just won't reply), so it stays a resident.
 * @returns {string[]} being names
 */
export function residentsFromMembers(members = []) {
  return members
    .filter((m) => m && m.kind === 'brain' && m.id != null && m.state !== 'off')
    .map((m) => String(m.id));
}
