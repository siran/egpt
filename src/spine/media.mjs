// media.mjs — the §2c media service: persist an incoming attachment into the
// chat's media/ folder (CONTRACT C2). The bridge downloads the file + hands us a
// local path via onMedia(meta); we copy it into conversations/<surface>/<slug>/
// media/ with a meaningful name + an index line, and return the saved path so the
// bridge can ANNOUNCE the media to E (a photo/doc/video reaches the persona, not
// just disk). Voice notes are transcribed by the bridge into the message body —
// that flows through the normal pipe; this service only persists files.
//
// The pure naming/index helpers are kept (media-save.mjs); the effectful copy +
// conv-state resolution are injected so the save is testable in-memory.
import { slugDir, getContact, ensureContact } from '../../conversations-state.mjs';
import { mediaFileName, mediaIndexLine } from '../media-save.mjs';
import { copyFile as fsCopyFile, mkdir as fsMkdir, appendFile as fsAppendFile } from 'node:fs/promises';
import { join } from 'node:path';

export function createMedia({ loadState, writeState, surface = 'whatsapp', io = {}, onLog = () => {} } = {}) {
  if (typeof loadState !== 'function' || typeof writeState !== 'function') {
    throw new Error('createMedia: loadState + writeState are required');
  }
  const copyFile = io.copyFile ?? fsCopyFile;
  const mkdir = io.mkdir ?? fsMkdir;
  const appendFile = io.appendFile ?? fsAppendFile;

  async function resolveSlug(chatID, chatName) {
    let state = await loadState();
    let slug = getContact(state, surface, chatID)?.slug ?? null;
    if (!slug) {
      const ens = ensureContact(state, surface, chatID, { pushedName: chatName, slugHint: chatName });
      slug = ens?.slug ?? null;
      if (slug && ens.state !== state) { state = ens.state; await writeState(state); }
    }
    return slug;
  }

  return {
    // The bridge's onMedia(meta): meta = { chatID, chatName, msgId, senderName,
    // ts, kind, mime, fileName, localPath, caption, isVoiceNote, ... }. Returns
    // the saved path, or null on failure (never throws — media must not block text).
    async save(meta) {
      try {
        if (!meta?.localPath || !meta?.chatID) return null;
        const slug = await resolveSlug(meta.chatID, meta.chatName);
        if (!slug) return null;
        const dir = join(slugDir(surface, slug), 'media');
        await mkdir(dir, { recursive: true });
        const name = mediaFileName(meta);
        const dest = join(dir, name);
        await copyFile(meta.localPath, dest);
        await appendFile(join(dir, 'index.md'), mediaIndexLine({ ...meta, savedName: name }), 'utf8');
        return dest;
      } catch (e) { onLog(`media save ${meta?.chatID}: ${e?.message ?? e}`); return null; }
    },
  };
}
