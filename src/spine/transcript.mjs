// transcript.mjs — the §2c transcript service: "the file is the conversation"
// (contracts C1.2/C1.4). Every inbound message AND every being reply — surfaced
// or withheld — lands in conversations/<surface>/<slug>/transcript.md. This is a
// faithful port of the old spine's `_logChatLine` + sibling-reply append, behind
// the kept pure libs (conversations-state for the slug/path, transcript-log for
// the bytes).
//
// Effectful deps are injected (conv-state load/write, fs) so the service is
// testable in-memory; the pure path helpers are imported directly.
import { slugDir, getContact, ensureContact } from '../../conversations-state.mjs';
import { transcriptAppend, replyLine } from '../transcript-log.mjs';
import { appendFile as fsAppendFile, mkdir as fsMkdir } from 'node:fs/promises';
import { existsSync as fsExistsSync } from 'node:fs';
import { join } from 'node:path';

export function createTranscript({
  loadState, writeState,                 // conversations-state YAML IO (injected)
  persona = null,
  io = {},                               // { appendFile, mkdir, existsSync } — real by default
  now = () => new Date(),
  onLog = () => {},
} = {}) {
  if (typeof loadState !== 'function' || typeof writeState !== 'function') {
    throw new Error('createTranscript: loadState + writeState are required');
  }
  const appendFile = io.appendFile ?? fsAppendFile;
  const mkdir = io.mkdir ?? fsMkdir;
  const existsSync = io.existsSync ?? fsExistsSync;

  // chatId → slug, registering the contact on first sight (same self-heal path
  // _logChatLine used: a new chat gets a contact + slug, and we persist it).
  async function resolveSlug(ev) {
    const state = await loadState();
    let slug = getContact(state, ev.surface, ev.chatId)?.slug ?? null;
    if (!slug) {
      const ens = ensureContact(state, ev.surface, ev.chatId, { pushedName: ev.chatName, slugHint: ev.chatName });
      slug = ens?.slug ?? null;
      if (slug && ens.state !== state) await writeState(ens.state);
    }
    return slug;
  }

  return {
    /**
     * Append the inbound line, then — when present — the being's reply line.
     * Called with no reply on the gated-out branches (inbound still recorded).
     * @param {object} ev  the InboundEvent
     * @param {string|{text:string,being?:string,surfaced?:boolean}} [reply]
     */
    async log(ev, reply) {
      try {
        if (!ev?.chatId) return false;
        const slug = await resolveSlug(ev);
        if (!slug) return false;
        const dir = slugDir(ev.surface, slug);
        await mkdir(dir, { recursive: true });
        const fpath = join(dir, 'transcript.md');
        // The inbound line is the dispatch line (the conversation-readable form,
        // C7.6); transcriptAppend prepends front matter on a fresh file.
        await appendFile(fpath, transcriptAppend({
          existing: existsSync(fpath), body: ev.line ?? ev.body,
          name: ev.chatName, surface: ev.surface, slug, threadId: ev.chatId, persona,
        }), 'utf8');
        if (reply != null) {
          const text = typeof reply === 'string' ? reply : reply.text;
          const being = (typeof reply === 'object' && reply.being) || 'e';
          const surfaced = typeof reply === 'object' ? reply.surfaced !== false : true;
          await appendFile(fpath, replyLine({ being, body: text, surfaced, now: now() }) + '\n\n', 'utf8');
        }
        return true;
      } catch (e) { onLog(`transcript ${ev?.surface}/${ev?.chatId}: ${e?.message ?? e}`); return false; }
    },
  };
}
