// tools/stickfig.mjs — narrow ASCII stick-figure poses for movies.
//
// Replaces ad-hoc 4-row figures (alien-style 👽 head + /---\ chest)
// when alignment matters more than character flavor. Every limb is
// anchored to the head column `c`, so head, spine, hip, and feet
// sit dead-center under each other:
//
//     ' O '        col c                head    (1 cell)
//     '/-\'        cols c-1..c+1        chest   (3 cells)
//     ' | '        col c                spine   (1 cell)
//     ' - '        col c                hip     (1 cell)
//     '| |'        cols c-1..c+1        legs    (3 cells)
//
// Returns 5-row arrays. Caller composes them into the scene at known
// y offsets and overlays decorations (props, dirt, treasure) using
// the same _overlay/_drawText helpers from slash/movie.mjs.
//
// Output rows are plain strings, NOT padded to canvas width — the
// caller pads when stitching into the scene. Keeps the helpers
// agnostic to scene width.

const sp = (n) => ' '.repeat(Math.max(0, n));

// Standing pose. `prop` is an optional 2-cell sprite glued to the
// right of the head (alien-style held item: ⛏️ shovel, 🗺 map, 📜
// scroll, 💰 gold, 🍾 bottle). `legs` selects the foot variant:
//   'together' (default) — | |  resting
//   'apart'              — / \  step out
//   'cross'              — \ /  step in (the other phase of the walk)
//   'sit'                — J L  squat / sit
export function standing(c, { prop = '', legs = 'together' } = {}) {
  const head  = sp(c) + 'O' + (prop ? prop : '');
  const chest = sp(c - 1) + '/-\\';
  const spine = sp(c) + '|';
  const hip   = sp(c) + '-';
  let feet;
  switch (legs) {
    case 'apart': feet = sp(c - 1) + '/ \\'; break;
    case 'cross': feet = sp(c - 1) + '\\ /'; break;
    case 'sit':   feet = sp(c - 1) + 'J L';  break;
    default:      feet = sp(c - 1) + '| |';
  }
  return [head, chest, spine, hip, feet];
}

// Arms-up celebration pose — chest row replaced with \O/ to read
// as raised arms. Same five-row footprint.
export function armsUp(c, { legs = 'together' } = {}) {
  const head  = sp(c) + 'O';
  const chest = sp(c - 1) + '\\O/';
  const spine = sp(c) + '|';
  const hip   = sp(c) + '-';
  const feet  = legs === 'apart' ? sp(c - 1) + '/ \\' : sp(c - 1) + '| |';
  return [head, chest, spine, hip, feet];
}

