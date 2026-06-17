// Reply-target sidecars and stable ids.
//
// This module is deliberately engine-safe: no React/Ink, no config globals, and
// no spine-local refs. It supports the current App-shaped spine today and the
// plain engine runtime after the App is deleted.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { swallow } from './swallow.mjs';

const STABLE_ALPHA = 'abcdefghijkmnpqrstuvwxyz23456789';

function randomStableSuffix() {
  let s = '';
  for (let i = 0; i < 6; i++) s += STABLE_ALPHA[Math.floor(Math.random() * STABLE_ALPHA.length)];
  return s;
}

// Sidecar path for reply-target persistence, per transcript file. Living next
// to the transcript keeps room-sidecar coupling obvious and lets multiple rooms
// coexist without collision.
export function replyTargetsSidecarPath(transcriptFile) {
  return String(transcriptFile).replace(/\.md$/i, '') + '.replytargets.json';
}

export async function loadReplyTargets(transcriptFile) {
  try {
    const raw = await readFile(replyTargetsSidecarPath(transcriptFile), 'utf8');
    const obj = JSON.parse(raw);
    return new Map(Object.entries(obj));
  } catch (e) {
    swallow('reply-targets.load', e, { expect: ['ENOENT'] });
    return new Map();
  }
}

export async function saveReplyTargets(transcriptFile, mapLike) {
  const obj = Object.fromEntries(mapLike);
  const path = replyTargetsSidecarPath(transcriptFile);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2));
}

// Stable id assignment for an item: prefer bridge-given ids because those
// survive restarts. Fall back to short random ids by author kind.
export function stableIdForItem(item, sessions) {
  if (item?._stableId) return item._stableId;
  if (item?._replyTarget) {
    const rt = Array.isArray(item._replyTarget) ? item._replyTarget[0] : item._replyTarget;
    if (rt?.kind === 'wa' && rt.key?.id) return `wa-${rt.key.id}`;
    if (rt?.kind === 'tg' && rt.msgId) return `tg-${rt.chatId}-${rt.msgId}`;
  }
  if (item?.author === 'system') return `s-${randomStableSuffix()}`;
  if (item?.author === 'You') return `u-${randomStableSuffix()}`;
  const bare = String(item?.author ?? '').split('@')[0];
  if (sessions?.[bare]) return `b-${randomStableSuffix()}`;
  return `p-${randomStableSuffix()}`;
}
