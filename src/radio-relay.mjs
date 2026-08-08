// radio-relay.mjs — PUT one voice note to the internet radio relay route a room is
// joined to (617148a/48a6ee8 built radio_service + /radio join|leave; this is what makes
// them do something). ONE job: take bytes the transcription path already downloaded and
// hand them to the station, retrying only the failures that are worth retrying.
//
// THE ROUTE IS REAL AND VERIFIED (live, 2026-08-08):
//   PUT <endpoint>/host/relay/<speaker>/<filename>, basic auth relay_user/relay_password
//   -> 201 Created            success
//   -> 404                    unknown speaker — NOT minted on the station; do not retry
//   -> 401 / 403              our credential is wrong/refused; do not retry
//   -> 413 / 415              the note itself is unusable (too big / wrong type); do not retry
//   -> transport failure      SEEN LIVE TWICE on this station on two endpoints — a curl got
//                             no HTTP status at all (000) on one attempt and 201 on an
//                             identical retry seconds later. This is why 5xx + transport
//                             failure DO retry and nothing else does.
//
// `fetch` is injected — no test, no caller default, ever touches the real network except
// the real Node/global fetch a live node hands in.

// The station's cap (operator-verified): guard BEFORE any fetch — never stream 16MB at a
// server that will refuse it.
export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;

// Codes that mean "this exact request will never succeed" — retrying only delays the
// diagnosis. Each gets its own DISTINCT, actionable log line: read the same, every one of
// them gets diagnosed as the wrong problem.
const PERMANENT_MESSAGE = {
  401: (speaker, endpoint) => `radio upload 401 [${speaker}] — our credential is wrong or revoked on ${endpoint}`,
  403: (speaker, endpoint) => `radio upload 403 [${speaker}] — our credential is refused on ${endpoint}`,
  404: (speaker, endpoint) => `radio upload 404 [${speaker}] — that speaker has not been minted on ${endpoint}; ask the operator to create it`,
  413: (speaker, _endpoint, filename) => `radio upload 413 [${speaker}] ${filename} — note too large for the station`,
  415: (speaker, _endpoint, filename) => `radio upload 415 [${speaker}] ${filename} — unsupported audio type`,
};

function basicAuth(user, pass) {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

/**
 * PUT one voice note to the station. Retries ONLY a 5xx response or a transport failure
 * (fetch rejecting — the "curl returned 000" case), with backoff, a small bounded number
 * of attempts. Every other non-2xx is permanent and returns immediately.
 *
 * @param {object} o
 * @param {{endpoint:string, relay_user:string, relay_password:string}} o.radio  this
 *   radio's radio_service block (config/config-schema.mjs)
 * @param {string} o.speaker    the station speaker name (already resolved by the caller:
 *   the room's radio.hosts[senderId], or the radio's default_speaker)
 * @param {string} o.filename   ISO-timestamped, original extension kept (radioNoteFilename)
 * @param {Buffer|Uint8Array} o.bytes  the note's raw audio bytes, untouched
 * @param {Function} [o.fetch]  injected fetch — defaults to the global fetch
 * @param {Function} [o.onLog]
 * @param {number}   [o.maxAttempts]  bounded retry count (default 3: 1 try + 2 retries)
 * @param {Function} [o.sleep]  injected backoff sleep — tests pass a no-op
 * @param {number}   [o.backoffMs]  base backoff; attempt N waits backoffMs*N
 * @returns {Promise<{ok:boolean, status?:number, error?:string}>}
 */
export async function uploadNote({
  radio, speaker, filename, bytes,
  fetch: fetchFn = globalThis.fetch,
  onLog = () => {},
  maxAttempts = 3,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  backoffMs = 500,
} = {}) {
  const size = bytes?.length ?? bytes?.byteLength ?? 0;
  if (!bytes || size > MAX_UPLOAD_BYTES) {
    onLog(`radio upload refused [${speaker}] ${filename} — ${size} bytes over the station's ${MAX_UPLOAD_BYTES}-byte cap`);
    return { ok: false, error: 'too-large' };
  }
  const endpoint = String(radio?.endpoint ?? '').replace(/\/+$/, '');
  const url = `${endpoint}/host/relay/${encodeURIComponent(speaker)}/${encodeURIComponent(filename)}`;
  const auth = basicAuth(radio?.relay_user, radio?.relay_password);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res;
    try {
      res = await fetchFn(url, { method: 'PUT', headers: { Authorization: auth }, body: bytes });
    } catch (e) {
      const msg = e?.message ?? e;
      if (attempt < maxAttempts) {
        onLog(`radio upload transport failure (attempt ${attempt}/${maxAttempts}) [${speaker}] ${filename}: ${msg} — retrying`);
        await sleep(backoffMs * attempt);
        continue;
      }
      onLog(`radio upload gave up after ${maxAttempts} attempts (transport failure) [${speaker}] ${filename}: ${msg}`);
      return { ok: false, error: 'transport' };
    }
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
    const permanent = PERMANENT_MESSAGE[res.status];
    if (permanent) { onLog(permanent(speaker, endpoint, filename)); return { ok: false, status: res.status, error: 'permanent' }; }
    if (res.status >= 500) {
      if (attempt < maxAttempts) {
        onLog(`radio upload ${res.status} (attempt ${attempt}/${maxAttempts}) [${speaker}] ${filename} — station error, retrying`);
        await sleep(backoffMs * attempt);
        continue;
      }
      onLog(`radio upload gave up after ${maxAttempts} attempts (last status ${res.status}) [${speaker}] ${filename}`);
      return { ok: false, status: res.status, error: 'station' };
    }
    // Any other unlisted status: treated as permanent — retrying an unrecognized 4xx would
    // only delay the diagnosis the same way a 401/404 would.
    onLog(`radio upload unexpected status ${res.status} [${speaker}] ${filename} — not retrying`);
    return { ok: false, status: res.status, error: 'unexpected' };
  }
  /* c8 ignore next */
  return { ok: false, error: 'transport' };   // unreachable — the loop above always returns
}

// The station folder-sorts by filename, so it must be ISO-timestamped for playback order:
// 2026-08-08T17-51-32-000Z-<short>.<ext> — ':' and '.' aren't filename-safe, dashed instead.
// `ext` is the SOURCE file's own extension (never transcoded/normalised — a WhatsApp voice
// note is opus-in-ogg and must reach the station exactly as it arrived).
export function radioNoteFilename(when, ext, rng = Math.random) {
  const iso = new Date(when ?? Date.now()).toISOString().replace(/[:.]/g, '-');
  const short = rng().toString(36).slice(2, 8);
  return `${iso}-${short}.${ext}`;
}

// senderId -> station speaker, via the room's radio.hosts map (operator-maintained by
// hand — /radio never writes it) — falling back to the radio's default_speaker for a
// sender not in that map. null when neither resolves (nothing to upload as).
export function pickSpeaker(hosts, senderId, defaultSpeaker) {
  const h = (hosts && typeof hosts === 'object' && !Array.isArray(hosts)) ? hosts : {};
  if (senderId != null && h[senderId]) return h[senderId];
  return defaultSpeaker || null;
}
