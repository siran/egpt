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
import { slugDir, ensureContact, renameLogLine, mutateState } from '../conversations-state.mjs';
import { rename as fsRename, appendFile as fsAppendFile } from 'node:fs/promises';
import { join } from 'node:path';

export function createContacts({ loadState, writeState, io = {}, onLog = () => {} } = {}) {
  if (typeof loadState !== 'function' || typeof writeState !== 'function') {
    throw new Error('createContacts: loadState + writeState are required');
  }
  const rename = io.rename ?? fsRename;
  const appendFile = io.appendFile ?? fsAppendFile;

  return {
    /**
     * Resolve (and self-heal) the slug for a chat. ALWAYS calls ensureContact —
     * for new AND known contacts — which is what re-arms the pushedName refresh,
     * the conversation_path backfill, and the name-tracking rename. ensureContact
     * only reports `changed` when a field actually differs, so a steady-state
     * re-sight (same title, nothing to backfill) does no write.
     * @returns {Promise<string|null>} the slug, or null when unresolvable (caller treats null as skip)
     */
    async resolve(surface, chatId, { chatName } = {}) {
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
        // (keeping the -yymmddhhmm suffix) and NULLED the thread state (a claude
        // session is keyed on cwd, so the renamed dir invalidates it — the same
        // trade-off migrateToSurfaceLayout makes; the conversation's brain simply
        // starts a fresh session in the new cwd). The pushedName-only rename logic
        // lives entirely in ensureContact; here we only do the filesystem half the
        // old dispatcher did: move the slug dir so transcript.md + media/ follow the
        // name, then record the rename inside the NEW folder's own history.
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
    },
  };
}
