// transcription-service.mjs — the per-ENTITY transcription service config.
//
// Operator 2026-06-15: "transcription is surface independent … in
// conversations.yaml, or room.yaml for the room: transcription_service_enabled
// and transcription_service_posts_back. transcriptions are always made if
// service enabled (default) in a room or conversation, and surfaced if
// posts_back (default)."
//
// So transcription is a ROOM DEFAULT SERVICE (GENOME §2.5), NOT E and NOT a
// transport concern — its config lives in the ENTITY's own config.yaml (a
// conversation slug dir OR ~/.egpt/rooms/<name>/), exactly like the heartbeat
// service (src/heartbeats.mjs). Surface-independent by construction.
//
// Two orthogonal flags, both default ON — they map onto the GENOME heart
// (idea #2: everything is HEARD and recorded; only some is SPOKEN):
//   enabled    → HEARD: run the transcription at all (model + transcript.md get it)
//   posts_back → SPOKEN: surface the 👂 <transcript> back into the chat
// `enabled:true, posts_back:false` = transcribe for the model/log but stay silent.
//
//   <dir>/config.yaml → { transcription: { enabled: true, posts_back: true } }
//
// Block absent / file absent / malformed → both default ON (auto-enroll). Only an
// explicit `false` disables. Keyed off the entity FOLDER, never a display name.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as YAML from 'yaml';

export const DEFAULT_SERVICE = { enabled: true, postsBack: true };

// Pure: raw config.yaml text (or null/'' when absent) → { enabled, postsBack }.
// Default ON; only an explicit `false` turns a flag off.
export function parseTranscriptionConfig(yamlText) {
  let doc = {};
  if (yamlText && yamlText.trim()) {
    try { doc = YAML.parse(yamlText) ?? {}; } catch { doc = {}; }
  }
  const t = (doc && typeof doc === 'object' && doc.transcription && typeof doc.transcription === 'object')
    ? doc.transcription : {};
  return {
    enabled: t.enabled !== false,
    postsBack: t.posts_back !== false,
  };
}

// best-effort IO (never throws): read the entity folder's config.yaml.
export async function readTranscriptionConfig(dir) {
  let text = null;
  try { text = await readFile(join(dir, 'config.yaml'), 'utf8'); } catch { /* none = defaults */ }
  return parseTranscriptionConfig(text);
}
