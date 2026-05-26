// media-kind.mjs — infer a WhatsApp attachment kind + mimetype from a file's
// extension/mimetype, for outbound bridge.sendMedia. Unknowns → document.

export const MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', '3gp': 'video/3gpp',
  ogg: 'audio/ogg', opus: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', aac: 'audio/aac',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  json: 'application/json', zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

// 'image' | 'video' | 'audio' | 'document' — prefer the mimetype, fall back to
// the extension, else 'document'.
export function mediaKind(mime, ext) {
  const m = String(mime ?? '');
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m) return 'document';
  const e = String(ext ?? '').toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(e)) return 'image';
  if (['mp4', 'mov', 'webm', 'mkv', '3gp'].includes(e)) return 'video';
  if (['ogg', 'opus', 'mp3', 'm4a', 'wav', 'aac'].includes(e)) return 'audio';
  return 'document';
}
