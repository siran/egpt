// contacts.mjs — the ONE shared contact-resolver service (§2c). Three services
// used to each carry a private `resolveSlug` that called ensureContact ONLY when
// the contact was missing, so for a KNOWN chat the pushedName refresh /
// conversation_path backfill / RENAME tracking never re-armed — a renamed group
// kept its stale slug forever, and none of the three moved the on-disk folder if a
// rename HAD fired (transcript.md + media/ orphaned in the old dir). This service
// centralizes that resolution and carries the v1-parity rename side-effect the old
// dispatcher owned (dispatch.mjs: fs.rename oldDir→newDir + a renames.log line).
//
// Effectful deps (conv-state load/write, fs) are injected so it's testable
// in-memory; the pure slug/rename helpers are imported directly.
import { slugDir, ensureContact, renameLogLine, mutateState, aliasTargetOf, aliasTranscriptKeyOf } from '../conversations-state.mjs';
import { Room } from '../room-core.mjs';
import { shortChatId } from '../bridges/chat-id.mjs';
import { rename as fsRename, appendFile as fsAppendFile } from 'node:fs/promises';
import { join } from 'node:path';

export function createContacts({ loadState, writeState, io = {}, onLog = () => {} } = {}) {
  if (typeof loadState !== 'function' || typeof writeState !== 'function') {
    throw new Error('createContacts: loadState + writeState are required');
  }
  const rename = io.rename ?? fsRename;
  const appendFile = io.appendFile ?? fsAppendFile;

  /**
   * Resolve (and self-heal) the slug for a chat. ALWAYS calls ensureContact —
   * for new AND known contacts — which is what re-arms the pushedName refresh,
   * the conversation_path backfill, and the name-tracking rename. ensureContact
   * only reports `changed` when a field actually differs, so a steady-state
   * re-sight (same title, nothing to backfill) does no write.
   * @returns {Promise<string|null>} the slug, or null when unresolvable (caller treats null as skip)
   */
  async function resolve(surface, chatId, { chatName } = {}) {
      // Serialize the whole load→mutate→write against the shared registry so two
      // DIFFERENT conversations' first-seen registrations (now concurrent, per the
      // per-conversation turn FIFO) can't interleave and lose one contact.
      return mutateState(writeState, async () => {
      try {
        if (!chatId) return null;
        const state = await loadState();
        const ens = ensureContact(state, surface, chatId, { pushedName: chatName, slugHint: chatName });

        // Rename: the chat's TITLE changed (a group renamed, or a placeholder
        // learning its real name) → ensureContact already recomputed the slug
        // (keeping the -yymmddhhmm suffix). The thread is NOT reset (operator
        // ruling 2026-07-26: a rename is the SAME conversation under a new name) —
        // the nested per-being threadId carries over untouched. The pushedName-only
        // rename logic lives entirely in ensureContact; here we only do the
        // filesystem half the old dispatcher did: move the slug dir so
        // transcript.md + media/ follow the name, then record the rename inside the
        // NEW folder's own history.
        if (ens.renamedFrom && ens.renamedTo) {
          const newDir = slugDir(surface, ens.renamedTo);
          try {
            // ENOENT-tolerant: the first message after a rename may predate any
            // folder — nothing to move, the transcript/media services mkdir the new
            // dir on their next write.
            await rename(slugDir(surface, ens.renamedFrom), newDir);
            // appendRenameLog hard-codes the real fs, so append via the io seam to
            // stay in-memory-testable (operator: renames logged in the conv folder).
            await appendFile(join(newDir, 'renames.log'), renameLogLine(ens.renamedFrom, ens.renamedTo, 'name changed'), 'utf8');
            onLog(`re-slugged "${ens.renamedFrom}" → "${ens.renamedTo}" (name changed)`);
          } catch (e) {
            if (e?.code !== 'ENOENT') onLog(`re-slug rename "${ens.renamedFrom}"→"${ens.renamedTo}" failed: ${e?.message ?? e}`);
          }
        }

        if (ens.changed) await writeState(ens.state);
        return ens.slug ?? null;
      } catch (e) { onLog(`resolve ${surface}/${chatId}: ${e?.message ?? e}`); return null; }
      });
  }

  /**
   * WHERE a chat's transcript is filed — BOTH the shared folder AND the per-surface FILE, the ONE
   * helper the write path (src/spine/transcript.mjs) and the read paths (boot.readTranscript for
   * mode:accum + the voice-note reuse, commands.mjs /send + /read quoted-lookup) all go through, so
   * a side-room's log can never land in one file on write and be read back from another.
   *
   * The FOLDER is canonical/shared, exactly as resolve() follows the `aliasOf` today — a `/join`
   * side-room shares the original's slug, folder, media and being thread. ONLY the transcript
   * FILENAME is per-surface: transcript.md for the original chat (not an alias), transcript-<key>.md
   * for a side-room, where <key> is the side-room's STORED key — its sanitized title, which /join
   * wrote onto the alias entry at creation (aliasTranscriptKeyOf). It is read off state keyed by
   * chatId, so it is identical at every write and read site and never depends on a live ev.chatName;
   * a side-room made before the key was stored falls back to its short chatId. aliasTargetOf is the
   * RAW read of the alias map — what distinguishes "this chatId IS a side-room" from "the primary".
   * @returns {Promise<{slug:string, room:Room, path:string}|null>} null when unresolvable
   */
  async function transcriptTarget(surface, chatId, { chatName } = {}) {
    const slug = await resolve(surface, chatId, { chatName });
    if (!slug) return null;
    const room = Room.forChat(surface, slug);
    const state = await loadState();
    // aliasTargetOf non-null ⇒ a side-room ⇒ transcript-<key>.md, key = its stored title (else the
    // short chatId); a primary/standalone chat ⇒ null ⇒ transcript.md.
    const aliased = aliasTargetOf(state, surface, chatId);
    const key = aliased ? (aliasTranscriptKeyOf(state, surface, chatId) ?? shortChatId(chatId)) : null;
    return { slug, room, path: room.transcriptPathFor(key) };
  }

  return { resolve, transcriptTarget };
}
