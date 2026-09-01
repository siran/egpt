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
import { recordMemberStat, isoFromMs, LOBBY_SLUG } from '../conversations-state.mjs';
import { Room } from '../room-core.mjs';
import { transcriptAppend, replyLine } from '../transcript-log.mjs';
import { renderFrontMatter } from '../transcript-meta.mjs';
import { isLiveStreamFrame, liveFrameRecord, streamRecord, dayBoundary, formatDispatchLine, limbAction } from '../dispatch-line.mjs';
import { appendFile as fsAppendFile, mkdir as fsMkdir } from 'node:fs/promises';
import { existsSync as fsExistsSync } from 'node:fs';

export function createTranscript({
  contacts,                              // the shared contact-resolver (createContacts) — chatId → slug + rename self-heal
  persona = null,
  defaultKey = 'egpt',                   // the persona being-id (its `agents:` MAP KEY), injected by boot — the fallback label when a reply carries no being. NOT a handle: `e` is one of the persona's handles (`handles: [e, egpt, ev]`), and this value is written into the record as the speaker, so a handle here labels the file with something no reader can route on (operator 2026-08-28)
  labelOf = (being) => String(being ?? ''),   // THE being→display-name resolver (boot.mjs labelOf: the agents-registry `name:`, else the map key), injected — the SAME function createSender and createReplyActions already take, so the record and the chat call an agent by one name. Default identity (tests) = the key
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
  // THE AGENT NAME IS THE IDENTIFIER (operator 2026-08-28: "the only agent named egpt lives in
  // kg. in do there is don"). The label is labelOf(being) and nothing else — not the `agents:`
  // MAP KEY (DOLLY's persona is keyed `egpt` but is `name: don`, so the record used to name an
  // agent nobody calls that), and no `.<node_name>` qualifier either: names are unique across the
  // shared Beeper account by construction, since both nodes hear every message. What the record
  // says is now exactly what the bridge stamps on the message in the chat.
  //
  // The chat/surface half of a reply line, since a being's reply now renders through the SAME
  // formatter as the inbound line beside it (transcript-log.replyLine → formatDispatchLine).
  // These are ev's OWN metadata, kept LITERAL exactly like ev.line/ev.body/ev.senderName at the
  // call sites below — never the routing decision of where the write is filed (see target()) —
  // so a being's line and the inbound line it answers render the same chat and the same surface
  // tag, byte for byte, in whichever file they land.
  const lineContext = (ev) => ({ chatName: ev.chatName, node: ev.node, surface: ev.surface });

  // WHERE a write lands: a joined room wins over ev's own native (surface, chatId) — the same
  // "joined room wins" rule redirectShellToRoom applies to dispatch (boot.mjs). 'lobby' is
  // "no redirect": it is the console's OWN home room (rooms/lobby/), so /rooms join lobby
  // means "go home", never a second hop. Already-redirected PROSE arrives here with
  // ev.chatId ALREADY equal to the joined room (that is what the upstream redirect set it
  // to), so recomputing the target here lands on the identical (surface, chatId) and this is
  // a no-op for it — prose's own redirect happened upstream and is never applied twice.
  // Since 2026-08-28 the shell IS surface `room`, so both sides of the map read one key.
  //
  // `ev` itself is NEVER mutated — only the returned surface/chatId (used in place of
  // ev.surface/ev.chatId) decide WHERE the write lands. Deliberate per-field split on what
  // follows the redirect vs what stays literal ev metadata:
  //   - contacts.resolve/Room.forChat (the slug + path) and recordMemberStat's own
  //     (surface, chatId) key ALL follow the target: a stat is "who's active in WHICH
  //     conversation", so a redirected write's activity belongs to the room it actually
  //     landed in — exactly what an already-redirected prose ev gets for free today, since
  //     redirectShellToRoom rewrites ev.surface/chatId themselves before ev is ever built.
  //   - ev.chatName/ev.line/ev.body/ev.senderName stay literal at the call sites: they are
  //     the event's own metadata (what was said, by whom, its display context), never the
  //     routing decision of where it's filed — again matching prose, whose chatName is
  //     unchanged by redirectShellToRoom.
  // The path comes from the Room (room-core.mjs), not a hand-rolled join — every Room answers
  // baseDir()/transcriptPath with the SAME getters, so an operator-named room (surface `room`)
  // lands here too (operator 2026-08-07).
  async function target(ev) {
    const joinedRoom = currentRoomOf(ev.surface);
    // Surface 'room' is BOTH identity.SHELL_SURFACE (the shell's own transport) AND the literal
    // surface a caller uses to address a room DIRECTLY with an already-resolved chatId (e.g. the
    // room-relay tunnel's re-entry, which carries a wa-group's line into the room it joined as a
    // turn of that room's own). currentRoomOf('room') answers the SAME map key for both, so on this one
    // surface the redirect must additionally confirm ev.chatId is still the shell's own default
    // home (LOBBY_SLUG) — an event that already names a specific, non-default room is final and
    // must never be reinterpreted onto whatever room the console happens to have joined. Every
    // OTHER surface keeps its existing per-surface redirect (no such collision exists there).
    const redirected = joinedRoom && joinedRoom !== LOBBY_SLUG && (ev.surface !== 'room' || ev.chatId === LOBBY_SLUG);
    const surface = redirected ? 'room' : ev.surface;
    const chatId = redirected ? joinedRoom : ev.chatId;
    const slug = await contacts.resolve(surface, chatId, { chatName: ev.chatName });
    if (!slug) return null;
    return { surface, chatId, slug, room: Room.forChat(surface, slug) };
  }

  // Stream appends are SERIALIZED through one chain. "In order" is the whole ruling, and
  // appendFile is open-write-close: token deltas fire faster than that round-trip, so
  // concurrent calls could land out of order. The chain never rejects (appendStream owns its
  // own catch), so nothing accumulates on it.
  let chain = Promise.resolve();
  // Transcript paths whose last write left a stream block UNTERMINATED (no trailing blank
  // line). A transcript entry is one blank-line-separated block (transcriptAppend/replyLine
  // both end '\n\n'), and a stream block is written a few bytes at a time — so it stays open
  // until the next ordinary entry closes it. This is the ONLY state the feature keeps, and it
  // is per FILE, not per message: an observing node holds nothing naming a peer's message
  // (372c17f) and does not need to.
  const openBlocks = new Set();
  // WHICH DAY THE RECORD IS ON, per FILE (operator 2026-09-01, from his own live SPOILER
  // transcript: "Ron Tomkins@… (22:40)", "Mauricio Castro@… (00:18)", "José Velarde@… (06:20)"
  // — midnight passed between two adjacent lines and nothing marked it, so no reader could
  // tell which day any line belonged to). A line carries HH:MM only, by operator mandate
  // (dispatch-line.formatDispatchLine), so the DAY is stated once, where it CHANGES — lighter
  // than dating thousands of lines to repeat the same fact.
  //
  // The value is the rendered marker itself, so "did the day change" is one string compare in
  // the CONFIGURED zone (`timeZone`, the node's default_time_zone — never UTC, never the
  // machine's local zone; the operator reads at −0400 and a UTC boundary would land four hours
  // late, at the wrong line). Second state this service keeps, per file exactly like
  // openBlocks, and for the same reason: this is the ONE ingestion point every write funnels
  // through, so one Map answers it for every caller.
  //
  // KNOWN GAP, deliberately not papered over: this is PROCESS memory, and a transcript is
  // months long and never re-read (the files are MB-scale; a tail-read per chat per boot is
  // not worth it). So the first entry a process writes to a file NEVER carries a boundary —
  // which is exactly what keeps a same-day transcript byte-identical to what it was before
  // this existed, and what a restart costs is one unmarked midnight.
  const lastDay = new Map();

  // The boundary block to prepend to an entry, or ''. NEVER on a file that does not exist yet:
  // renderFrontMatter's `---` block must start at byte 0 or stripFrontMatter stops recognising
  // it, and a brand-new file has no previous day to differ from anyway.
  function dayMark(fpath, when) {
    const mark = dayBoundary(when, timeZone);
    const prev = lastDay.get(fpath);
    lastDay.set(fpath, mark);
    return (prev && prev !== mark && existsSync(fpath)) ? `${mark}\n\n` : '';
  }

  // Close an open stream block before an ordinary entry lands under it, so the train and the
  // record are two blocks and every reader that splits on blank lines keeps working.
  async function closeBlock(fpath) {
    if (!openBlocks.has(fpath)) return;
    openBlocks.delete(fpath);
    await appendFile(fpath, '\n\n', 'utf8');
  }

  // THE BYTES, INTO transcript.md (operator 2026-08-27: "whatever reply is emitted by model
  // (the bytes) gets written into the transcript (aka logged)"). Not a sidecar: the record a
  // human reads and a being is prompted with is the thing the interim content was vanishing
  // from, so that is where it goes.
  //
  // `being` names the block's author and is written ONCE, when the block opens. An OBSERVING
  // node passes null: a peer's frames carry the peer's own persona stamp inside the bytes
  // (`🤝 don …`), and this node cannot honestly label them — the frames arrive as INBOUND
  // edits on a shared account, so ev.senderName is the account, not the being. An unlabelled
  // block is the honest form; nothing is invented.
  async function appendStream(ev, inc, { being }) {
    try {
      const t = await target(ev);
      if (!t) return false;
      await mkdir(t.room.baseDir(), { recursive: true });
      const fpath = t.room.transcriptPath;
      let head = '';
      if (!openBlocks.has(fpath)) {
        // Same front-matter rule transcriptAppend applies, for the case where a stream is the
        // first thing this file ever receives (normally the inbound line is already in: the
        // spine records at ingestion, before any turn is dispatched).
        if (!existsSync(fpath)) head += renderFrontMatter({ name: ev.chatName ?? t.chatId ?? t.slug, surface: t.surface, slug: t.slug, chat_id: t.chatId, persona });
        // A train that OPENS on a new day says so, like any other entry. It rides the block
        // HEAD, so the marker lands above the first byte of the stream and never inside it —
        // which is also why dayMark is called here and not per increment: one entry, one day.
        head += dayMark(fpath, now());
        if (being) head += replyLine({ being: labelOf(being), body: '', streaming: true, now: now(), timeZone, ...lineContext(ev) });
        openBlocks.add(fpath);
      }
      await appendFile(fpath, head + inc, 'utf8');
      return true;
    } catch (e) { onLog(`stream ${ev?.surface}/${ev?.chatId}: ${e?.message ?? e}`); return false; }
  }

  return {
    /**
     * THE EMITTING HALF (operator 2026-08-27): "every byte coming out of the model gets logged
     * in order. period. no deletions in log, no custom delta formats: whatever the model says,
     * whatever it is, gets logged."
     *
     * This node is running the CLI, so there is nothing to reconstruct — but the seam it
     * receives the stream through hands it the ACCUMULATED text, not the delta (every engine:
     * warm-cli-session `pending.acc += d.text; onUpdate(pending.acc)`, pi-cli-session the
     * same, codex-cli-session, and cdp.mjs which POLLS a page and cannot produce a delta at
     * all). So the caller keeps what it has already logged and the tail is DERIVED here,
     * through the same streamIncrement an observing node uses — one derivation, not two.
     *
     * The NON-APPEND case is the point: a turn's accumulated text is replaced wholesale by a
     * later frame (codex-cli-session's `item/completed` sets `currentTurn.text = item.text`;
     * warm-cli's final `result` supersedes the narration), which is the operator's "boom, it
     * changes, and the previous output is not even getting transcribed". A divergent update is
     * LOGGED, not dropped for failing a prefix test — and the text already written stays
     * written. This file is append-only; nothing in it is ever removed or rewritten.
     *
     * AND WHAT IT TOOK BACK (operator 2026-09-01: "forward edits means keeping the diffs after
     * every backwards edit of the model"). Recording only the ADDITION made a retraction
     * invisible — `abcd`→`abef` logged `ef` and said nothing at all about `cd` disappearing
     * from a surface a human was already reading, so the record could not show that the model
     * wrote something and then withdrew it. streamRecord puts the retracted text on its own
     * `    - ` line ahead of whatever replaced it, and ONLY when something was retracted: a
     * pure append (`after.startsWith(before)`) still costs exactly the appended bytes, so the
     * 2026-08-27 anti-flood ruling is untouched and the rare reversal is the thing that shows.
     *
     * Not awaited by the caller (a token delta must not wait on fs); returns the chain so a
     * test can. Order is guaranteed by the chain, not by the caller.
     * @param {object} ev            the InboundEvent this turn is answering
     * @param {string} before        the accumulated text ALREADY logged for this turn ('' at turn start)
     * @param {string} after         the accumulated text as it now stands
     */
    logStream(ev, before, after, { being = defaultKey } = {}) {
      if (!ev?.chatId) return chain;
      const bytes = streamRecord(before, after);
      if (!bytes) return chain;
      chain = chain.then(() => appendStream(ev, bytes, { being }));
      return chain;
    },

    /**
     * ONE LIMB, as an EVENT (operator 2026-09-01: "if model replies '/react ...', we need to put
     * in transcript its reaction … so that there is legible record of what happened"). A being
     * drove an action from inside its own reply, the 🤝 landed in WhatsApp, and the record held
     * only the raw reply line — so reading back what happened meant resolving per-account ids by
     * hand. The line takes the stage-direction shape the bridge already writes for everyone
     * else's reactions and edits ('[ don@[chat].wa (08:27): reacted 🤝 to #563 ]'), because it IS
     * the same kind of thing: a meta-event, not an utterance.
     *
     * Written AFTER execution, once per limb that LANDED (spine.mjs reads execute()'s `ran`), so
     * the record never claims a react the bridge refused. Same target()/closeBlock/front-matter
     * path every other write takes — the service stays the ONE ingestion point. NO stats: a limb
     * is this node's own action, not a member's message.
     * @param {object} ev      the InboundEvent the turn was answering (supplies chat + surface)
     * @param {object} action  one entry of createReplyActions' parsed `run`
     */
    async logAction(ev, action, { being = defaultKey } = {}) {
      try {
        if (!ev?.chatId) return false;
        const body = limbAction(action);
        if (!body) return false;                                   // an unknown limb invents no vocabulary
        const t = await target(ev);
        if (!t) return false;
        await mkdir(t.room.baseDir(), { recursive: true });
        const fpath = t.room.transcriptPath;
        await chain;
        await closeBlock(fpath);
        const line = formatDispatchLine({ senderName: labelOf(being), ...lineContext(ev), timeZone, ts: now(), body, stageDirection: true });
        // The entry is built BEFORE the day is marked: transcriptAppend throws on an empty
        // body, and a dayMark whose entry never landed would leave the file's day advanced
        // with no boundary written in it. Same order at every write site below.
        const entry = transcriptAppend({
          existing: existsSync(fpath), body: line,
          name: ev.chatName, surface: t.surface, slug: t.slug, chatId: t.chatId, persona,
        });
        await appendFile(fpath, dayMark(fpath, now()) + entry, 'utf8');
        return true;
      } catch (e) { onLog(`limb ${ev?.surface}/${ev?.chatId}: ${e?.message ?? e}`); return false; }
    },

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
        //
        // THE OBSERVING HALF of the 2026-08-27 ruling: the frame is still not an ENTRY — no
        // `edited #<id>` block, no stats — but what it ADDED joins the stream block, so the
        // peer's reply is on the record as it is written instead of only once it settles. A
        // peer only ever hands this node before/after text, so the increment is DERIVED
        // (liveFrameRecord); the `-` side is never written WHOLESALE, which is what keeps the
        // flood dead — a reply of N bytes costs N bytes here, not five snapshots of it.
        //
        // AND WHAT THE FRAME TOOK BACK (operator 2026-09-01: "forward edits means keeping the
        // diffs after every backwards edit of the model"). Dropping removals silently meant a
        // peer frame `abcd`→`abef` logged `ef` and lost the fact that `cd` had been on the
        // surface and was withdrawn. Still not the `-` side wholesale: only the middle that
        // `after` does not keep, once, on its own `    - ` line. A pure append — nearly every
        // frame — writes nothing extra, so the 2026-08-27 anti-flood ruling is untouched.
        if (reply == null && ev.kind === 'edit' && isLiveStreamFrame(ev.body)) {
          const bytes = liveFrameRecord(ev.body);
          if (bytes) { chain = chain.then(() => appendStream(ev, bytes, { being: null })); await chain; }
          return false;   // still NOT an entry: no dispatch line, no stats side-effect
        }
        const t = await target(ev);
        if (!t) return false;
        const { surface: targetSurface, chatId: targetChatId, slug, room } = t;
        await mkdir(room.baseDir(), { recursive: true });
        const fpath = room.transcriptPath;
        // An ordinary entry lands UNDER the train, never inside it: drain whatever bytes are
        // still queued, then terminate the open block. Append-only — closing writes the blank
        // line that separates two blocks and touches nothing already written.
        await chain;
        await closeBlock(fpath);
        if (reply == null) {
          // §3.1: every received message passes ASYNCHRONOUSLY to the stats collector —
          // fire-and-forget (never awaited, so it can't block or delay the transcript
          // append), any rejection swallowed into onLog exactly like the catch below.
          recordMemberStat(targetSurface, targetChatId, ev.senderId, isoFromMs(ev.ts), { io, senderName: ev.senderName, chatName: ev.chatName })
            .catch((e) => onLog(`stats ${ev?.surface}/${ev?.chatId}: ${e?.message ?? e}`));
          // The inbound line is the dispatch line (the conversation-readable form,
          // C7.6); transcriptAppend prepends front matter on a fresh file.
          const entry = transcriptAppend({
            existing: existsSync(fpath), body: ev.line ?? ev.body,
            name: ev.chatName, surface: targetSurface, slug, chatId: targetChatId, persona,
          });
          // ev.ts, not now(): the inbound line's own HH:MM was rendered from it (identity.build),
          // so the boundary and the line under it must answer to the same clock — a backlog
          // replay is the case that makes the difference visible.
          await appendFile(fpath, dayMark(fpath, ev.ts) + entry, 'utf8');
        } else {
          const text = typeof reply === 'string' ? reply : reply.text;
          const being = (typeof reply === 'object' && reply.being) || defaultKey;
          const surfaced = typeof reply === 'object' ? reply.surfaced !== false : true;
          // `msgId` — the id of the message this reply was POSTED as, which makes the line
          // addressable (`#<id>`) the way an inbound line is. No caller carries one yet: the
          // spine records the reply BEFORE delivering it (record-first is durability), so at
          // this point the surface has not assigned an id. Absent → the tag is omitted.
          const msgId = (typeof reply === 'object' ? reply.msgId : null) ?? null;
          const entry = replyLine({ being: labelOf(being), body: text, surfaced, msgId, now: now(), timeZone, ...lineContext(ev) }) + '\n\n';
          await appendFile(fpath, dayMark(fpath, now()) + entry, 'utf8');
        }
        return true;
      } catch (e) { onLog(`transcript ${ev?.surface}/${ev?.chatId}: ${e?.message ?? e}`); return false; }
    },
  };
}
