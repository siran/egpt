// text-similarity.mjs — normalized word-token overlap for the 👂 echo-coverage query.
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
