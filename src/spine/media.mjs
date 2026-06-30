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
import { extractKeyframes } from '../video-frames.mjs';
import { transcribeAudioFile } from '../tools/transcribe.mjs';
import { copyFile as fsCopyFile, mkdir as fsMkdir, appendFile as fsAppendFile } from 'node:fs/promises';
import { join } from 'node:path';

export function createMedia({
  loadState, writeState, surface = 'whatsapp',
  transcribeCfg = {},                   // whisper-cli profile (ffmpeg_command, command, model_path, language)
  transcribe = transcribeAudioFile,     // (path, cfg, log) -> transcript (reads video audio too)
  extractFrames = extractKeyframes,     // (path, { ffmpeg, outDir, baseName, count, log }) -> [absolute frame paths]
  frameCount = 3,
  io = {}, onLog = () => {},
} = {}) {
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

        // ROUTE A — a video gets keyframes + an audio transcript so E can SEE it
        // (it has no ffmpeg in its sandbox). The .jpg frames land in this chat's
        // media/, the transcript rides the dispatch line. Best-effort, never fatal.
        if (meta.kind === 'video') {
          const ffmpeg = transcribeCfg?.ffmpeg_command || 'ffmpeg';
          const baseName = name.replace(/\.[^.]+$/, '');
          let framePaths = [];
          try { framePaths = await extractFrames(dest, { ffmpeg, outDir: dir, baseName, count: frameCount, log: (x) => onLog(`video-frames: ${x}`) }); }
          catch (e) { onLog(`video frames ${meta.chatID}: ${e?.message ?? e}`); }
          let transcript = null;
          try { transcript = await transcribe(dest, transcribeCfg, (x) => onLog(`video-transcribe: ${x}`)); }
          catch (e) { onLog(`video transcribe ${meta.chatID}: ${e?.message ?? e}`); }
          return { savedPath: dest, framePaths, transcript };
        }
        return dest;
      } catch (e) { onLog(`media save ${meta?.chatID}: ${e?.message ?? e}`); return null; }
    },
  };
}
