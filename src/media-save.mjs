// media-save.mjs — pure helpers for persisting an incoming attachment into a
// chat's media/ folder (CONTRACT C2). Division of labour:
//   bridge  — downloads the attachment + decides whether to (shouldDownload),
//             then hands egpt the local path via onMedia(meta).
//   egpt    — copies it into slugDir/media/ with a meaningful name
//             (mediaFileName) + a sidecar caption + an index line
//             (mediaIndexLine).
// These are the pure pieces, exported so tests/media-save.test.mjs locks the
// shape the bridge end-to-end test guards (the regression: a voice note was
// transcribed but its file dropped instead of saved).

import { MIME_BY_EXT, mediaKind } from './media-kind.mjs';

// Reverse of MIME_BY_EXT: first ext that maps to a given mimetype.
const EXT_BY_MIME = (() => {
  const m = {};
  for (const [ext, mime] of Object.entries(MIME_BY_EXT)) if (!(mime in m)) m[mime] = ext;
  return m;
})();

const KIND_DEFAULT_EXT = { image: 'jpg', video: 'mp4', audio: 'ogg', document: 'bin' };

// Best file extension for an attachment: the original fileName's ext wins (it
// carries the truest type), else derive from the mimetype, else a kind default.
// Lowercased, no leading dot.
export function extFromMeta({ fileName, mime, kind } = {}) {
  const fromName = String(fileName ?? '').match(/\.([A-Za-z0-9]{1,8})$/)?.[1];
  if (fromName) return fromName.toLowerCase();
  const fromMime = EXT_BY_MIME[String(mime ?? '').toLowerCase()];
  if (fromMime) return fromMime;
  return KIND_DEFAULT_EXT[kind ?? mediaKind(mime, '')] ?? 'bin';
}

// Download policy (whatsapp.media.download):
//   'off'         → save nothing
//   'images_docs' → save only image + document (skip audio/video)
//   'all'         → save everything (default; also the fallback for unknowns)
export function shouldDownload(policy, kind) {
  const p = String(policy ?? 'all').toLowerCase();
  if (p === 'off') return false;
  if (p === 'images_docs') return kind === 'image' || kind === 'document';
  return true;
}

const pad = (n) => String(n).padStart(2, '0');

// 'YYYYMMDD-HHMMSS' (UTC) — consistent with the dispatch-line/transcript clocks.
function tsStamp(ts) {
  const d = new Date(ts ?? Date.now());
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
       + `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

function slugPart(s, fallback) {
  const v = String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return v || fallback;
}

// Meaningful, collision-resistant filename:
//   <YYYYMMDD-HHMMSS>-<sender>-<kind>[-<msgId>].<ext>
// The timestamp + msgId keep two notes in the same second distinct; sender+kind
// make the folder human-scannable.
export function mediaFileName({ ts, senderName, kind, msgId, fileName, mime } = {}) {
  const k = kind ?? mediaKind(mime, '');
  const ext = extFromMeta({ fileName, mime, kind: k });
  const parts = [tsStamp(ts), slugPart(senderName, 'someone'), slugPart(k, 'media')];
  if (msgId != null && String(msgId).trim()) parts.push(slugPart(msgId, 'x'));
  return `${parts.join('-')}.${ext}`;
}

// One markdown line appended to media/index.md, linking the saved file.
export function mediaIndexLine({ ts, senderName, kind, savedName, caption } = {}) {
  const d = new Date(ts ?? Date.now());
  const iso = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
            + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  const cap = caption && String(caption).trim()
    ? ` — ${String(caption).trim().replace(/\s+/g, ' ').slice(0, 200)}`
    : '';
  return `- ${iso} · ${senderName ?? 'someone'} · ${kind ?? 'media'} · [${savedName}](${savedName})${cap}\n`;
}
