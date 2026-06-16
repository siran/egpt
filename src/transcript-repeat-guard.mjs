// transcript-repeat-guard.mjs — detect degenerate whisper output (the
// repetition / hallucination loop) and flag it instead of surfacing garbage.
//
// whisper.cpp, fed silence / music / background noise / a too-long segment, can
// fall into a loop that emits one short phrase over and over ("Gracias,
// Michelle. Michelle. Michelle. …" ×17 — operator 2026-06-16, the `morgan`
// voice-note thread). The transcript then misrepresents what was actually said.
// We cannot always prevent it at the whisper layer (the useful flags —
// `--no-context`, `--entropy-thold`, temperature fallback — depend on the
// whisper.cpp build, and a wrong flag breaks ALL transcription), so the nucleus
// runs this cheap post-pass on EVERY transcript at the shared
// `transcribeVoiceNote` chokepoint (every limb, both transcriber backends) and
// replaces an obvious loop with an honest "(transcription unreliable …)" marker,
// keeping one instance of the phrase for context.
//
// Pure + Node-free: it lives in the shared incoming-media path, which is bundled
// into the browser extension, so it must import nothing Node-only.

function eqWindow(words, a, b, len) {
  for (let i = 0; i < len; i++) if (words[a + i] !== words[b + i]) return false;
  return true;
}

/**
 * Find the longest run of a back-to-back repeated word-window (window length
 * 1..maxLen). Returns { isLoop, start, len, count, covered, phrase } — `isLoop`
 * is true only when the repeated span both repeats enough (>= minRepeats) AND
 * covers enough of the text (>= minCoverage), so emphatic human repetition
 * ("no no no") below the threshold passes through untouched.
 *
 * @param {string} text
 * @param {object} [o]
 * @param {number} [o.minRepeats=6]  consecutive repeats to count as a loop
 * @param {number} [o.minCoverage=0.6] fraction of the text the loop must cover
 * @param {number} [o.maxLen=5]      longest phrase (in words) to consider
 */
export function detectRepeatLoop(text, { minRepeats = 6, minCoverage = 0.6, maxLen = 5 } = {}) {
  const s = String(text ?? '').trim();
  if (!s) return { isLoop: false };
  const words = s.split(/\s+/);
  const n = words.length;
  if (n < minRepeats) return { isLoop: false };
  let best = null;
  for (let len = 1; len <= Math.min(maxLen, Math.floor(n / 2)); len++) {
    for (let start = 0; start + 2 * len <= n; start++) {
      let count = 1;
      while (start + (count + 1) * len <= n && eqWindow(words, start, start + count * len, len)) count++;
      if (count >= minRepeats) {
        const covered = count * len;
        if (!best || covered > best.covered) {
          best = { start, len, count, covered, phrase: words.slice(start, start + len).join(' ') };
        }
      }
      // Skip past this run so a long loop stays roughly linear, not O(n²).
      if (count > 1) start += (count - 1) * len;
    }
  }
  if (best && best.covered / n >= minCoverage) return { isLoop: true, ...best };
  return { isLoop: false };
}

/**
 * If `text` is a degenerate repetition loop, collapse it: keep everything before
 * the loop + ONE instance of the looped phrase, then append an honest marker.
 * Otherwise return `text` unchanged. The result is what reaches the model, the
 * transcript, and the 👂 ack — a fidelity fix, not a cosmetic one.
 */
export function flagDegenerateTranscript(text, opts = {}) {
  const r = detectRepeatLoop(text, opts);
  if (!r.isLoop) return text;
  const words = String(text).trim().split(/\s+/);
  const prefix = words.slice(0, r.start).join(' ');
  const kept = [prefix, r.phrase].filter(Boolean).join(' ');
  return `${kept} [transcription unreliable — “${r.phrase}” repeated ${r.count}×]`.trim();
}
