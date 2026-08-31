// text-similarity.mjs — the node's text-closeness primitives, over ONE normalized
// space (normalizeTokens). Pure, Node-free, unit-tested. Two consumers, two metrics:
//
//   · similarity()  — word-token OVERLAP, for the 👂 echo-coverage query
//   · closestNames() — character-level NEARNESS, for "did you mean …?"
//
// The 👂 echo asks the CHAT "is this note already covered?" (src/bridges/beeper.mjs
// noteCovered): does a reply to the note already carry a transcript that matches what
// THIS node would post? "Matches" = the two transcripts' normalized word-token SETS
// overlap by >= a threshold. This module is that scoring — pure, Node-free, unit-tested.
//
// WHY normalize this way: after normalizeTokens, emojis / punctuation / symbols /
// diacritics all VANISH structurally (not special-cased). That is the whole reason
// 👂 / 💸 / 🌉 (persona emoji, bridge-signature markers, the ear marker) can NEVER
// reach a post/no-post decision: they are not tokens, so a covering reply is recognized
// by its WORDS regardless of whether it leads with 👂 or carries wrap layers. Position-
// and marker-independent by construction.

/**
 * Fold `text` to a list of comparable word tokens:
 *   lowercase → NFD + strip combining marks (é→e, ñ→n, í→i) → keep only maximal
 *   runs of [a-z0-9]. Everything else (spaces, punctuation, emoji, symbols) is a
 *   separator and disappears. '' / null / undefined → [].
 */
export function normalizeTokens(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // strip combining diacritical marks
    .match(/[a-z0-9]+/g) ?? [];
}

/**
 * OVERLAP COEFFICIENT of two token lists: |A∩B| / min(|A|,|B|) over the token SETS.
 * Range 0..1; 0 when either side is empty. Chosen over Jaccard because it tolerates
 * one transcript dropping OR adding words (a duration prefix, a trailing marker, a
 * mis-heard tail): dividing by the SMALLER set keeps a near-substring match near 1.0.
 */
export function similarity(aTokens, bTokens) {
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  if (a.size === 0 || b.size === 0) return 0;
  let hit = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) hit++;
  return hit / small.size;
}

// ── "did you mean …?" — CHARACTER-level nearness (operator 2026-08-31) ─────────
// similarity() above compares word SETS, which is exactly the wrong instrument for a
// TYPO. Live console, 2026-08-31: the operator typed `/members add group perrito
// traduciones` for a chat actually named "perrito traducciones" — ONE missing 'c', in a
// group name he did not choose — and got `no chat named '…'` back from a command that
// had just walked the entire chat list and said nothing about what it saw. Four attempts.
// A one-letter difference makes the two words DISJOINT tokens, so the overlap coefficient
// scores that pair 0.5 and a single-word typo 0.0; edit distance sees it as 0.95.
//
// Shares normalizeTokens with the echo scorer, so both compare in the SAME folded space:
// case, punctuation, emoji and diacritics are gone, which means 'Radio WnL' / 'radio wnl'
// are one key and an accent the operator omitted ("traducción") is free.

// Levenshtein, two-row (O(min) memory). Chat names are short; no cutoff needed.
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * The `limit` candidates from `candidates` closest to `input`, nearest first, keeping only
 * those scoring >= `min`. Returns the candidate strings VERBATIM (the folding is only how
 * they are compared) so a caller can quote them straight back at the operator.
 *
 * Score = 1 - editDistance/maxLength over the folded keys, EXCEPT that a key wholly
 * CONTAINED in the other floors at 0.8: someone who types `radio` for "Radio WnL" is not
 * making a typo, he is naming the chat by the part he remembers, and the raw ratio there
 * (0.44) would bury the one candidate he meant beneath the threshold.
 *
 * Deliberately conservative — a wrong suggestion costs the operator another attempt, which
 * is the very thing this exists to prevent. Empty/blank input → [].
 */
export function closestNames(input, candidates, { limit = 3, min = 0.5 } = {}) {
  const fold = (s) => normalizeTokens(s).join(' ');
  const want = fold(input);
  if (!want) return [];
  const scored = [];
  const seen = new Set();
  for (const c of candidates ?? []) {
    const name = String(c ?? '');
    const key = fold(name);
    // De-duplicated on the FOLDED key, first spelling wins: two candidates that differ only
    // in case or accent are one suggestion, not two near-identical lines the operator has to
    // read twice.
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const ratio = 1 - editDistance(want, key) / Math.max(want.length, key.length);
    const score = (key.includes(want) || want.includes(key)) ? Math.max(ratio, 0.8) : ratio;
    if (score >= min) scored.push({ name, score });
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.slice(0, limit).map((s) => s.name);
}
