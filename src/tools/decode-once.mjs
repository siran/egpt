// decode-once.mjs — the same bytes are decoded once (operator 2026-09-16).
//
// One voice note or video reaches transcription several times: on each node, and within a node once
// per Beeper connection whose account is in the chat. The downloaded bytes are identical on every
// arrival (sha256 compared on kg and do; only the file names differ). On 2026-09-15 do's worker
// decoded one 22,740-byte note twice back to back, 24.4 s then 10.3 s, identical transcripts.
//
// So a decode is keyed on the sha256 of the bytes (sha256Hex), never on a path or a message id:
//   - a decode of the same bytes already started (running, or queued behind others) is JOINED: its
//     caller gets that decode's result instead of starting another;
//   - a recent SUCCESSFUL result is answered as it is. The memory is small: RECENT_MAX results, each
//     kept RECENT_TTL_MS;
//   - an empty transcript, a null, or a decode that threw is never remembered, so the next arrival of
//     those bytes decodes again.
//
// A DURABLE MEMORY (operator 2026-09-17). With a `store` the recent results outlive the process and
// last much longer: DURABLE_MAX results, each kept DURABLE_TTL_MS. do's log, 2026-09-17: kg's bridge
// came back at 07:09 and sent notes do had decoded for its own chats between 05:45 and 07:03, and do
// decoded five again because they were past the 10-minute memory. A week covers a node asleep or down
// over a weekend and catching up; 512 results cover a week at ~70 notes a day. A result is a sha and a
// transcript (a one-minute note is about 1 KB of text), so the file stays well under a megabyte, and
// rewriting it after a decode costs nothing next to the seconds the decode took. The store is
// `{ load() -> [[key, { at, value }], ...] oldest first, save(entries) }`; fileStore below is the file.
//
// EXACTLY TWO CALLERS: the pipeline's transcribe() (src/transcription-pipeline.mjs, node-local, both
// voice notes and videos, in memory) and the worker (src/tools/transcriptor.mjs, across nodes, durable):
// its POST /v1/transcribe, and its lookup GET /v1/transcript/<sha256>, which asks without a `start`.
// `start()` begins the decode and returns a job whose `result` resolves to
// { transcript, meta }, where `meta` is what the decode wrote (durationSec), for every caller that
// shares it. The job is handed unchanged to the callers that join it, so it can carry the caller's own
// bookkeeping (the worker's queue turn).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const RECENT_MAX = 32;
export const RECENT_TTL_MS = 10 * 60_000;
export const DURABLE_MAX = 512;
export const DURABLE_TTL_MS = 7 * 24 * 60 * 60_000;

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function createDecodeOnce({ now = () => Date.now(), store = null } = {}) {
  const max = store ? DURABLE_MAX : RECENT_MAX;
  const ttlMs = store ? DURABLE_TTL_MS : RECENT_TTL_MS;
  const running = new Map();                      // sha256 -> job
  const recent = new Map(store?.load() ?? []);    // sha256 -> { at, value }, oldest first
  while (recent.size > max) recent.delete(recent.keys().next().value);

  // -> { served, job }. served: null (this call started the decode, or, with no `start`, nothing is
  // known and job is null), 'running', or 'recent'.
  return function decodeOnce(key, start = null) {
    for (const [k, r] of recent) { if (now() - r.at <= ttlMs) break; recent.delete(k); }
    const hit = recent.get(key);
    if (hit) return { served: 'recent', job: { result: Promise.resolve(hit.value) } };
    if (running.has(key)) return { served: 'running', job: running.get(key) };
    if (!start) return { served: null, job: null };
    const job = start();
    running.set(key, job);
    job.result.then((value) => {
      if (!value?.transcript) return;
      recent.set(key, { at: now(), value });
      if (recent.size > max) recent.delete(recent.keys().next().value);
      store?.save([...recent]);
    }, () => {}).finally(() => running.delete(key));
    return { served: null, job };
  };
}

// The durable memory as one JSON file, [[sha256, { at, value }], ...] oldest first, rewritten whole
// (tmp, then rename) each time a result is kept. Written synchronously, so the result is on disk before
// the request that decoded it is answered. Missing or unreadable: the memory starts empty and says so.
export function fileStore(path, onLog = () => {}) {
  const valid = (e) => Array.isArray(e) && typeof e[0] === 'string' && Number.isFinite(e[1]?.at) && typeof e[1]?.value?.transcript === 'string';
  return {
    load() {
      try {
        const entries = JSON.parse(readFileSync(path, 'utf8'));
        if (!Array.isArray(entries) || !entries.every(valid)) throw new Error('not a list of [sha256, { at, value }]');
        return entries;
      } catch (e) {
        onLog(e?.code === 'ENOENT'
          ? `no memory of decoded transcripts at ${path} yet — starting empty`
          : `the memory of decoded transcripts at ${path} is UNREADABLE (${e?.message ?? e}) — starting empty`);
        return [];
      }
    },
    save(entries) {
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(`${path}.tmp`, JSON.stringify(entries));
        renameSync(`${path}.tmp`, path);
      } catch (e) {
        onLog(`could NOT save the memory of decoded transcripts to ${path} — ${e?.message ?? e}`);
      }
    },
  };
}
