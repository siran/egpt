// accum.mjs — the text mode:accum reads for a chat when it is not that chat's transcript alone
// (operator 2026-11-20). A chat and its SI+ side group (reply_in_side_group) are ONE conversation in
// two groups — the same thread and folder, a log of its own for each — so a turn woken in either is
// prompted with the lines of BOTH since the being's last turn, in time order, each line keeping the
// group it was said in (transcript-log.joinTranscripts). A /split is another thread and a /join room
// keeps its own log (the 2026-10-03 rule): for those, and for any chat with no side group, this answers
// null and the caller reads the one transcript (boot's readTranscript), exactly as before.
//
// Effectful deps are injected (the shared contact resolver, fs) so the reader is testable in memory.
import { joinTranscripts } from '../transcript-log.mjs';

export function createAccumReader({
  contacts,                                  // createContacts: accumTargets(surface, chatId, { chatName }) → the files, or null
  surfaceOf = (network) => network,          // boot's network → surface fold (the same one readTranscript uses)
  readFile,                                  // (path, 'utf8') → text; rejects when there is no file yet
  stat = null,                               // (path) → { mtimeMs }: when each file was last written, which dates its last line; null → the clock's day
  now = () => Date.now(),
  timeZone = null,                           // the zone the transcripts' HH:MM were rendered in (config default_time_zone)
} = {}) {
  /**
   * @param {string} chatId
   * @param {{chatName?: string, network?: string, being?: string|string[]}} [opts]  being: the labels
   *        of the being the turn is for (its reply wins a same-minute tie between the files)
   * @returns {Promise<string|null>} the joined text, or null when the chat has no side group to join
   */
  return async function readAccum(chatId, { chatName, network, being = null } = {}) {
    const targets = await contacts.accumTargets(surfaceOf(network), chatId, { chatName });
    if (!targets) return null;
    const sources = await Promise.all(targets.map(async ({ path }) => ({
      text: await readFile(path, 'utf8').catch(() => null),
      at: await Promise.resolve(stat?.(path)).then((s) => s?.mtimeMs, () => undefined),
    })));
    return joinTranscripts(sources, { being, now: now(), timeZone });
  };
}
