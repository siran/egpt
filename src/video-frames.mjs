// video-frames.mjs — extract a few representative keyframes from a video, so the
// nucleus can hand conversation-e the FRAMES on a silver platter (Route A,
// operator 2026-06-16): E never runs ffmpeg (no Bash in its chroot) — the host
// does the privileged work OUTSIDE the jail and drops the .jpg frames INTO the
// chat's media/ (inside E's sandbox), where E's vision can Read them. Mirrors how
// a voice note is transcribed for E. The video's audio transcript is handled
// separately by the existing transcriber (convertToWav16k reads video too).
//
// Node-only (spawns ffmpeg/ffprobe). The pure helpers (timestamp picking, the
// ffprobe-path derivation) are exported + unit-tested; the spawn is verified live.
import { join, dirname } from 'node:path';
import { _run } from './tools/transcribe.mjs';

// ffprobe usually ships beside ffmpeg — derive its path from the ffmpeg path so a
// single config knob (ffmpeg_command) covers both.
export function ffprobeFromFfmpeg(ffmpeg = 'ffmpeg') {
  return String(ffmpeg).replace(/ffmpeg(\.exe)?$/i, (_, ext) => `ffprobe${ext || ''}`);
}

// Evenly-spaced timestamps across the video, avoiding the very start/end (black
// frames / intros): for count=3 → 1/4, 2/4, 3/4 of the duration. Unknown/zero
// duration → a single early frame (so we still hand E something).
export function pickFrameTimestamps(durationSec, count = 3) {
  const d = Number(durationSec);
  const n = Math.max(1, Math.floor(count));
  if (!Number.isFinite(d) || d <= 0) return [1];
  const out = [];
  for (let i = 1; i <= n; i++) out.push(Math.round((d * i / (n + 1)) * 100) / 100);
  return out;
}

export async function videoDurationSec(videoPath, ffprobe) {
  try {
    const out = await _run(ffprobe, [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', videoPath,
    ], { captureStdout: true });
    const d = parseFloat(String(out).trim());
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch { return null; }
}

/**
 * Extract up to `count` keyframes from a video. Returns the absolute paths of the
 * frames actually written (best-effort — a failed frame is logged, not fatal).
 * Frames are JPEGs named `<baseName>-frame-NN.jpg` in `outDir` (default: the
 * video's own dir). One quick `-ss` seek per frame (simple + reliable).
 */
export async function extractKeyframes(videoPath, {
  ffmpeg = 'ffmpeg', ffprobe, count = 3, outDir, baseName, log = () => {},
} = {}) {
  if (!videoPath) return [];
  const probe = ffprobe || ffprobeFromFfmpeg(ffmpeg);
  const dir = outDir || dirname(videoPath);
  const base = baseName || (videoPath.split(/[\\/]/).pop() || 'video').replace(/\.[^.]+$/, '');
  const dur = await videoDurationSec(videoPath, probe);
  const times = pickFrameTimestamps(dur, count);
  const paths = [];
  for (let i = 0; i < times.length; i++) {
    const out = join(dir, `${base}-frame-${String(i + 1).padStart(2, '0')}.jpg`);
    try {
      // -ss before -i = fast input seek; one frame; quality 3 (good, small).
      await _run(ffmpeg, ['-ss', String(times[i]), '-i', videoPath, '-frames:v', '1', '-q:v', '3', '-y', out]);
      paths.push(out);
    } catch (e) { log(`video-frames: frame ${i + 1} @${times[i]}s failed — ${e?.message ?? e}`); }
  }
  log(`video-frames: ${base} → ${paths.length}/${times.length} frames (dur=${dur ?? '?'}s)`);
  return paths;
}
