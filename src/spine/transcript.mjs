// transcript.mjs — the §2c transcript service: "the file is the conversation"
// (contracts C1.2/C1.4). Every inbound message AND every being reply — surfaced
// or withheld — lands in conversations/<surface>/<slug>/transcript.md. This is a
// faithful port of the old spine's `_logChatLine` + sibling-reply append, behind
// the kept pure libs (conversations-state for the slug/path, transcript-log for
// the bytes).
//
// Effectful deps are injected (conv-state load/write via the shared contacts
// resolver, fs) so the service is testable in-memory; the pure path helpers are
// imported directly.
import { slugDir, recordMemberStat, isoFromMs } from '../conversations-state.mjs';
import { transcriptAppend, replyLine } from '../transcript-log.mjs';
import { appendFile as fsAppendFile, mkdir as fsMkdir } from 'node:fs/promises';
import { existsSync as fsExistsSync } from 'node:fs';
import { join } from 'node:path';

export function createTranscript({
  contacts,                              // the shared contact-resolver (createContacts) — chatId → slug + rename self-heal
  persona = null,
  defaultKey = 'e',                      // the persona being-id (its map key), injected by boot — the fallback label when a reply carries no being
  node_name = null,                      // this node's name — qualifies the being's reply label as <being>.<node_name> so the record shows WHICH node produced a line (provenance; operator 2026-07-10). null → bare being label unchanged
  io = {},                               // { appendFile, mkdir, existsSync } — real by default
  now = () => new Date(),
  onLog = () => {},
} = {}) {
  if (typeof contacts?.resolve !== 'function') {
    throw new Error('createTranscript: contacts (createContacts) is required');
  }
  const appendFile = io.appendFile ?? fsAppendFile;
  const mkdir = io.mkdir ?? fsMkdir;
  const existsSync = io.existsSync ?? fsExistsSync;

  return {
    /**
     * Append the inbound line, then — when present — the being's reply line.
     * Called with no reply on the gated-out branches (inbound still recorded).
     * @param {object} ev  the InboundEvent
     * @param {string|{text:string,being?:string,surfaced?:boolean}} [reply]
     * @param {{replyOnly?:boolean}} [opts]  replyOnly: skip the inbound append + stats
     *        (the inbound was already recorded at arrival — the auto-dwell path logs each
     *        burst message as it lands, then the fired turn records ONLY its reply here).
     */
    async log(ev, reply, { replyOnly = false } = {}) {
      try {
        if (!ev?.chatId) return false;
        const slug = await contacts.resolve(ev.surface, ev.chatId, { chatName: ev.chatName });
        if (!slug) return false;
        const dir = slugDir(ev.surface, slug);
        await mkdir(dir, { recursive: true });
        const fpath = join(dir, 'transcript.md');
        if (!replyOnly) {
          // §3.1: every received message passes ASYNCHRONOUSLY to the stats collector —
          // fire-and-forget (never awaited, so it can't block or delay the transcript
          // append), any rejection swallowed into onLog exactly like the catch below.
          recordMemberStat(ev.surface, ev.chatId, ev.senderId, isoFromMs(ev.ts), { io, senderName: ev.senderName, chatName: ev.chatName })
            .catch((e) => onLog(`stats ${ev?.surface}/${ev?.chatId}: ${e?.message ?? e}`));
          // The inbound line is the dispatch line (the conversation-readable form,
          // C7.6); transcriptAppend prepends front matter on a fresh file.
          await appendFile(fpath, transcriptAppend({
            existing: existsSync(fpath), body: ev.line ?? ev.body,
            name: ev.chatName, surface: ev.surface, slug, threadId: ev.chatId, persona,
          }), 'utf8');
        }
        if (reply != null) {
          const text = typeof reply === 'string' ? reply : reply.text;
          const being = (typeof reply === 'object' && reply.being) || defaultKey;
          const surfaced = typeof reply === 'object' ? reply.surfaced !== false : true;
          // Node-qualify the being label (operator 2026-07-10): <being>.<node_name> (e.g. e.kg,
          // wren.do) so the record shows WHICH node on this shared account produced the line.
          // Applies to whatever beings the transcript labels — it's this node's node_name for all.
          const label = node_name ? `${being}.${node_name}` : being;
          await appendFile(fpath, replyLine({ being: label, body: text, surfaced, now: now() }) + '\n\n', 'utf8');
        }
        return true;
      } catch (e) { onLog(`transcript ${ev?.surface}/${ev?.chatId}: ${e?.message ?? e}`); return false; }
    },
  };
}
