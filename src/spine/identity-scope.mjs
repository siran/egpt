// identity-scope.mjs — WHICH CONVERSATION a being's INSTANCE lives in.
//
// A being's instance is keyed FOUR ways, and every one of them is derived from a
// (being, surface, chatId) address:
//   1. its THREAD          — `agents.<being>.threadId` (conversations.yaml / rooms.yaml)
//   2. its WARM PROCESS    — the warm-pool key `<being>:<engine>:<surface>:<slug>`
//   3. its TURN FIFO       — the spine's per-conversation queue key
//   4. its RUN CONFIG      — access_level / allowed_users / sandboxed / verbose_thinking /
//                            allow_new_input, all read per-being per-conversation
// ALL FOUR MUST AGREE. Sharing a thread without collapsing the warm key is not a shortcut
// to sharing an instance, it is CORRUPTION: two `claude --resume <same id>` processes
// appending to one session file.
//
// This module is the ONE place that address is widened, resolved BEFORE any of the four is
// derived. It answers one question — for THIS being, in THIS conversation, which
// conversation is the instance? — and its default answer is "itself": null. A node with no
// scope configured therefore derives exactly the four keys it derives today, from the same
// inputs, with nothing extra read.
//
// WHY IT EXISTS (operator 2026-08-31). room/acim's `egpt` had been doing translation work
// for weeks — thread 892d0ee4, `access_level: all`, its own warm CLI. He then made a
// WhatsApp group ("perrito traducciones") and invited it into that room as a `wa-group`
// member: *"when executing command in shell to make a whatsapp group a member, i think the
// best is to 'join the agents' … we need to use the same key for the agent to use the same
// warm cli (however, it might be that the group/room name also enter in the cache-key and
// so perhaps we need to find a workaround)"*. He is right that the chat name is in the
// cache key, and that is the crux: without this the group's `egpt` is a DIFFERENT
// being-instance — different thread, different warm process, `access_level: regular` from
// the global default. He wants ONE E: same memory, same process, same hands.
//
// NOT A COPY, DELIBERATELY. The obvious alternative — write room/acim's threadId into the
// group's own conversation entry — makes two records that must be kept equal, and two
// records that must be kept equal drift; it also breaks the moment the membership changes.
// Here there is ONE record, on the scope, and the invited group has no thread of its own at
// all. Nothing to sync, nothing to unwind when the group leaves the room.
//
// THE `being` PARAMETER IS LOAD-BEARING, and the FIRST rule below is why: a being pinned
// node-wide to ONE scope, so every conversation it is addressed in resolves to the same
// instance (wren, operator 2026-09-01). It reads `being` and nothing else. It was predicted
// here before it was written, and it went in without this contract changing — same
// `resolveScope(being, surface, chatId)`, same `{surface, chatId}` or null.
import { SHELL_SURFACE, surfaceOf } from './identity.mjs';

/**
 * @param {object} deps
 * @param {(surface: string, chatId: string) => Promise<any>} deps.resolveMembers
 *   boot.mjs's createMemberResolver — the SAME reverse lookup room-relay's fan-out reads
 *   `roster.tunnelRooms` from. REUSED, never re-scanned: one scan of config/rooms.yaml
 *   decides both "which rooms does this message tunnel into" and "whose instance is this
 *   conversation", so the tunnel and the identity can never disagree about membership.
 * @param {() => any} [deps.getConfig] boot.mjs's already-read config accessor — the SAME one
 *   createBrainPool takes. Nothing here is read from disk; this module still touches no file.
 * @returns {(being: string, surface: string, chatId: string) => Promise<{surface: string, chatId: string}|null>}
 *   the scope, or null when the conversation is its own scope (the default).
 */
export function createIdentityScope({ resolveMembers, getConfig = () => ({}), onLog = () => {} } = {}) {
  if (typeof resolveMembers !== 'function') throw new Error('createIdentityScope: resolveMembers is required');
  return async function resolveScope(being, surface, chatId) {
    // THE PIN — `agents.<being>.scope: <surface>/<chatId>`, flat on the agent (NOT under
    // `conversation_defaults`, which means "a node-wide default a conversation MAY override" —
    // the exact opposite of a pin). Split on the FIRST `/` only; room ids are slugs.
    //
    // AHEAD OF THE MEMBERSHIP RULE ON PURPOSE. Both can fire for one chat — a pinned being
    // addressed in a group that is also a room member — and the pin wins: it is an explicit
    // operator declaration about a BEING, while membership is an inference about a CHAT. When it
    // fires no membership lookup happens at all.
    const pin = getConfig()?.agents?.[being]?.scope;
    if (pin !== undefined && pin !== null && pin !== '') {
      const cut = typeof pin === 'string' ? pin.indexOf('/') : -1;
      // The surface goes through surfaceOf — THE one place network→surface is decided — so a pin
      // written `shell/wren` and one written `room/wren` name the SAME address. The console’s
      // NETWORK is `shell` while its SURFACE is `room` (identity.mjs TRANSPORT_SURFACE), so an
      // operator writing the former would otherwise open a SECOND instance that reads correctly
      // in the config and shares nothing with the first.
      if (cut > 0 && cut < pin.length - 1) return { surface: surfaceOf(pin.slice(0, cut)), chatId: pin.slice(cut + 1) };
      // Half an address is never guessed at: a scope that will not parse falls back to the
      // conversation itself, the same safe direction every other failure here takes.
      onLog(`agents.${being}.scope is not <surface>/<chatId> (${JSON.stringify(pin)}) — ignored, ${being} keeps its own instance in ${surface}/${chatId}`);
    }
    let roster;
    // The resolver already swallows its own faults (returns []); this is the belt. A scope
    // that cannot be resolved must fall back to the conversation itself — being your own
    // instance is never WRONG, only narrower.
    try { roster = await resolveMembers(surface, chatId); }
    catch { return null; }
    const rooms = Array.isArray(roster?.tunnelRooms) ? roster.tunnelRooms : [];
    // EXACTLY ONE, or none. A chat invited into TWO rooms has no single instance to join —
    // there is no answer, and picking one arbitrarily would hand the operator's live thread
    // to whichever room config/rooms.yaml happened to list first. It keeps its own instance
    // (today's behavior, and the safe direction) and the log says why.
    if (rooms.length !== 1) {
      if (rooms.length > 1) onLog(`${surface}/${chatId} is a wa-group member of ${rooms.length} rooms (${rooms.join(', ')}) — no single instance to join, so it keeps its own`);
      return null;
    }
    // A room's own conversation lives on surface `room`, addressed by its NAME — the slug
    // half of the `room/<slug>` rooms.yaml key the reverse lookup already returns. That is
    // byte-for-byte the address room-relay.mjs's tunnelOf re-enters the group's message at,
    // which is the point: the group's OWN turn and the tunnelled ROOM turn now land on one
    // thread, one warm process and one queue instead of racing each other across two.
    return { surface: SHELL_SURFACE, chatId: rooms[0] };
  };
}
