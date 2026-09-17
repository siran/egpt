// decode-once.mjs — the same bytes are decoded once (operator 2026-09-16).
//
// One voice note or video reaches transcription several times: on each node, and within a node once
// per Beeper connection whose account is in the chat. The downloaded bytes are identical on every
// arrival (sha256 compared on kg and do; only the file names differ). On 2026-09-15 do's worker
// decoded one 22,740-byte note twice back to back, 24.4 s then 10.3 s, identical transcripts.
//
// So a decode is keyed on the sha256 of the bytes, never on a path or a message id:
//   - a decode of the same bytes already started (running, or queued behind others) is JOINED: its
//     caller gets that decode's result instead of starting another;
//   - a recent SUCCESSFUL result is answered as it is. The memory is small: RECENT_MAX results, each
//     kept RECENT_TTL_MS;
//   - an empty transcript, a null, or a decode that threw is never remembered, so the next arrival of
//     those bytes decodes again.
//
// EXACTLY TWO CALLERS: the pipeline's transcribe() (src/transcription-pipeline.mjs, node-local, both
// voice notes and videos) and the worker's POST /v1/transcribe (src/tools/transcriptor.mjs, across
// nodes). `start()` begins the decode and returns a job whose `result` resolves to
// { transcript, meta }, where `meta` is what the decode wrote (durationSec), for every caller that
// shares it. The job is handed unchanged to the callers that join it, so it can carry the caller's own
// bookkeeping (the worker's queue turn).
import { createHash } from 'node:crypto';

export const RECENT_MAX = 32;
export const RECENT_TTL_MS = 10 * 60_000;

export function createDecodeOnce({ now = () => Date.now() } = {}) {
  const running = new Map();   // sha256 -> job
  const recent = new Map();    // sha256 -> { at, value }, oldest first

  // -> { served, job }. served: null (this call started the decode), 'running', or 'recent'.
  return function decodeOnce(bytes, start) {
    const key = createHash('sha256').update(bytes).digest('hex');
    for (const [k, r] of recent) { if (now() - r.at <= RECENT_TTL_MS) break; recent.delete(k); }
    const hit = recent.get(key);
    if (hit) return { served: 'recent', job: { result: Promise.resolve(hit.value) } };
    if (running.has(key)) return { served: 'running', job: running.get(key) };
    const job = start();
    running.set(key, job);
    job.result.then((value) => {
      if (!value?.transcript) return;
      recent.set(key, { at: now(), value });
      if (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value);
    }, () => {}).finally(() => running.delete(key));
    return { served: null, job };
  };
}
