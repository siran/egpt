// transcript.mjs — the §2c transcript service: "the file is the conversation"
// (contracts C1.2/C1.4). Every inbound message AND every being reply — surfaced
// or withheld — lands in conversations/<surface>/<slug>/transcript.md. This is a
// faithful port of the old spine's `_logChatLine` + sibling-reply append, behind
// the kept pure libs (conversations-state for the slug/path, transcript-log for
// the bytes).
//
// ONE call appends ONE line. The spine records the message at its single ingestion
// point (log(ev)) and each answering turn appends its own reply (log(ev, reply)) —
// so message order in the file is ARRIVAL order and N agents answering one message
// produce one inbound line and N reply lines beneath it.
//
// Effectful deps are injected (conv-state load/write via the shared contacts
// resolver, fs) so the service is testable in-memory; the pure path helpers are
// imported directly.
import { recordMemberStat, isoFromMs } from '../conversations-state.mjs';
import { Room } from '../room-core.mjs';
import { transcriptAppend, replyLine } from '../transcript-log.mjs';
import { isLiveStreamFrame } from '../dispatch-line.mjs';
import { appendFile as fsAppendFile, mkdir as fsMkdir } from 'node:fs/promises';
import { existsSync as fsExistsSync } from 'node:fs';

export function createTranscript({
  contacts,                              // the shared contact-resolver (createContacts) — chatId → slug + rename self-heal
  persona = null,
  defaultKey = 'e',                      // the persona being-id (its map key), injected by boot — the fallback label when a reply carries no being
  node_name = null,                      // this node's name — qualifies the being's reply label as <being>.<node_name> so the record shows WHICH node produced a line (provenance; operator 2026-07-10). null → bare being label unchanged
  timeZone = null,                       // the node's config default_time_zone (boot-resolved via the heartbeat loader's resolveTimeZone) — the zone the reply line's HH:MM renders in. null → UTC, unchanged
  io = {},                               // { appendFile, mkdir, existsSync } — real by default
  now = () => new Date(),
  onLog = () => {},
  // RECORD-KEEPING TARGET, not dispatch (operator, room-join transcript-routing fix): (surface)
  // => slug|null, boot-wired to commands.currentRoomOf (the SAME reader redirectShellToRoom
  // already uses for dispatch). This service is the ONE ingestion point every caller funnels
  // through (see the module docstring) — so resolving "which room does this write actually
  // belong to" HERE, once, means neither of the two callers (spine.mjs's handleFast, boot.mjs's
  // wrapCommandsForTranscript) needs to know rooms exist at all. Default `() => null` (this
  // repo's convention for an optional seam nobody wired) = every write lands on ev's own native
  // (surface, chatId), byte-identical to before this option existed.
  currentRoomOf = () => null,
} = {}) {
  if (typeof contacts?.resolve !== 'function') {
    throw new Error('createTranscript: contacts (createContacts) is required');
  }
  const appendFile = io.appendFile ?? fsAppendFile;
  const mkdir = io.mkdir ?? fsMkdir;
  const existsSync = io.existsSync ?? fsExistsSync;

  return {
    /**
     * Append ONE line to the conversation's transcript.md. Which line is decided by the
     * `reply` argument alone — there is no third mode and no flag:
     *   log(ev)         → the INBOUND line (+ the stats side-effect). The spine calls this
     *                     from its single ingestion point, once per received message.
     *   log(ev, reply)  → the being's REPLY line, under the inbound line already written.
     *                     Whatever agents answer a message, each appends exactly one.
     * @param {object} ev  the InboundEvent
     * @param {string|{text:string,being?:string,surfaced?:boolean}} [reply]
     */
    async log(ev, reply) {
      try {
        if (!ev?.chatId) return false;
        // A LIVING-MIRROR STREAM FRAME IS NOT HISTORY (operator 2026-07-26: "it's better if
        // the streaming is not logged"). A streamed reply is ONE message rewritten in place,
        // so a node observing a peer's reply on this shared account receives every frame as
        // an incoming edit — 492 of them, 35% of the live SPOILER transcript, burying the
        // operator's own messages under five-plus giant near-identical blocks per reply.
        // Only the SETTLED text is the record; the settle frame carries no live marker and
        // still lands. A human's edit of an earlier message never carries one either, so it
        // stays on the record — see isLiveStreamFrame.
        if (reply == null && ev.kind === 'edit' && isLiveStreamFrame(ev.body)) return false;
        // WHERE this write lands: a joined room wins over ev's own native (surface, chatId) —
        // the same "joined room wins" rule redirectShellToRoom applies to dispatch (boot.mjs).
        // 'lobby' is sugar for "no room" (same rule redirectShellToRoom applies): /room join
        // lobby resolves to "no redirect", not to a literal room named lobby. Already-redirected
        // PROSE arrives here with ev.surface === 'room' — a key currentRoom never holds (roomJoin
        // only ever writes under 'shell') — so currentRoomOf('room') is always null and this
        // naturally no-ops for it: prose's own redirect already happened upstream (boot.mjs), and
        // this must never re-target it a second time.
        //
        // `ev` itself is NEVER mutated — only targetSurface/targetChatId (used below in place of
        // ev.surface/ev.chatId) decide WHERE the write lands. Deliberate per-field split on what
        // follows the redirect vs what stays literal ev metadata:
        //   - contacts.resolve/Room.forChat (the slug + path) and recordMemberStat's own
        //     (surface, chatId) key ALL follow the target: a stat is "who's active in WHICH
        //     conversation", so a redirected write's activity belongs to the room it actually
        //     landed in — exactly what an already-redirected prose ev gets for free today, since
        //     redirectShellToRoom rewrites ev.surface/chatId themselves before ev is ever built.
        //   - ev.chatName/ev.line/ev.body/ev.senderName stay literal everywhere below: they are
        //     the event's own metadata (what was said, by whom, its display context), never the
        //     routing decision of where it's filed — again matching prose, whose chatName is
        //     unchanged by redirectShellToRoom.
        const joinedRoom = currentRoomOf(ev.surface);
        const redirected = joinedRoom && joinedRoom !== 'lobby';
        const targetSurface = redirected ? 'room' : ev.surface;
        const targetChatId = redirected ? joinedRoom : ev.chatId;
        const slug = await contacts.resolve(targetSurface, targetChatId, { chatName: ev.chatName });
        if (!slug) return false;
        // The path comes from the Room (room-core.mjs), not a hand-rolled join — every
        // Room answers baseDir()/transcriptPath with the SAME getters, so an
        // operator-named room (surface `room`) lands here too (operator 2026-08-07).
        const room = Room.forChat(targetSurface, slug);
        await mkdir(room.baseDir(), { recursive: true });
        const fpath = room.transcriptPath;
        if (reply == null) {
          // §3.1: every received message passes ASYNCHRONOUSLY to the stats collector —
          // fire-and-forget (never awaited, so it can't block or delay the transcript
          // append), any rejection swallowed into onLog exactly like the catch below.
          recordMemberStat(targetSurface, targetChatId, ev.senderId, isoFromMs(ev.ts), { io, senderName: ev.senderName, chatName: ev.chatName })
            .catch((e) => onLog(`stats ${ev?.surface}/${ev?.chatId}: ${e?.message ?? e}`));
          // The inbound line is the dispatch line (the conversation-readable form,
          // C7.6); transcriptAppend prepends front matter on a fresh file.
          await appendFile(fpath, transcriptAppend({
            existing: existsSync(fpath), body: ev.line ?? ev.body,
            name: ev.chatName, surface: targetSurface, slug, chatId: targetChatId, persona,
          }), 'utf8');
        } else {
          const text = typeof reply === 'string' ? reply : reply.text;
          const being = (typeof reply === 'object' && reply.being) || defaultKey;
          const surfaced = typeof reply === 'object' ? reply.surfaced !== false : true;
          // Node-qualify the being label (operator 2026-07-10): <being>.<node_name> (e.g. e.kg,
          // wren.do) so the record shows WHICH node on this shared account produced the line.
          // Applies to whatever beings the transcript labels — it's this node's node_name for all.
          const label = node_name ? `${being}.${node_name}` : being;
          await appendFile(fpath, replyLine({ being: label, body: text, surfaced, now: now(), timeZone }) + '\n\n', 'utf8');
        }
        return true;
      } catch (e) { onLog(`transcript ${ev?.surface}/${ev?.chatId}: ${e?.message ?? e}`); return false; }
    },
  };
}
