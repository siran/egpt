// slash/movie.mjs — play an ASCII / emoji movie inside a single WA
// message by editing it frame-by-frame. The bridge's edit-echo
// handler folds these edits onto the original recent[] entry so
// /recap won't see N mid-frame rows.
//
// Movies auto-delete by default (revoked after a hold). --keep
// disables. --secret "<text>" supplies the punchline.

import { standing as _figStanding, couple as _figCouple } from '../tools/stickfig.mjs';

// ── Alien movie ───────────────────────────────────────────────
//
// 9-line frame, constant height:
//   4 sky rows  (starfield, sometimes a UFO drifting through)
//   4 figure rows  (head / chest / spine / legs — blank when no figure)
//   1 ground row  (sometimes carries a UFO or a dust kick)
//   + 1 optional dialog row below the ground for the burp line
//
// The alien is a stick figure: 👽 head, /---\ chest+arms, | spine,
// /\ or || legs alternating to read as a walk. Props ride on the
// head row next to the emoji (🍾 / 🚬 / 💨).

const _SKY = [
  '   . · ✦ . * · ⋆ .  ',
  '  ✦ . · ✦ . * .     ',
  '    . * · . ✦ .     ',
  '  · ⋆ . · *         ',
];
const _GROUND_EMPTY = '─────────────────────────';
const _GROUND_UFO   = '─────🛸──────────────────';
const _GROUND_DUST  = '~~~~~🛸~~~~~~~~~~~~~~~~~~';
const _EMPTY_FIG    = ['', '', '', ''];

// Stick figure poses at column `c` (where the head emoji sits).
// The body wraps around the head — /---\ chest starts one column
// to the left so the emoji visually centers above it. Each pose
// returns the 4-row figure block; the caller composes it into the
// 9-line scene below.
//
// `prop` (optional) attaches a held item to the right of the head:
//   🍾 (held out) / 🍾 close (drinking) / 🚬 (held) / 🚬 close + 💨 (smoking)
//   💨 (burp)
// Two leg styles ('apart' = /\, 'together' = ||) alternate to make
// the walk read as motion rather than translation.
function _fig(c, opts = {}) {
  const { prop = '', legs = 'apart' } = opts;
  const sp = (n) => ' '.repeat(Math.max(0, n));
  const head = sp(c) + '👽' + (prop ? prop : '');
  const chest = sp(c - 1) + '/---\\';
  const spine = sp(c) + '|';
  const feet = sp(c) + (legs === 'apart' ? '/\\' : '||');
  return [head, chest, spine, feet];
}

function _scene(fig, ground, dialog) {
  const lines = [..._SKY, ...(fig?.length === 4 ? fig : _EMPTY_FIG), ground];
  if (dialog) lines.push(dialog);
  return lines.join('\n');
}

// Sky frames where a UFO replaces one cell in one sky row.
function _skyUfo(line, col) {
  const rows = _SKY.map(l => l);
  const arr = rows[line].split('');
  if (col >= 0 && col < arr.length) arr[col] = '🛸';
  rows[line] = arr.join('');
  return [...rows, ..._EMPTY_FIG, _GROUND_EMPTY].join('\n');
}

function _buildAlienFrames(secret) {
  const dialog = (secret || 'la verdad está allá afuera').trim().slice(0, 60) || 'la verdad está allá afuera';
  const F = [];

  // 1. Empty nightscape.
  F.push(_scene(null, _GROUND_EMPTY));

  // 2-7. UFO drifts diagonally in from the upper-right.
  F.push(_skyUfo(0, 18));
  F.push(_skyUfo(0, 14));
  F.push(_skyUfo(1, 12));
  F.push(_skyUfo(2, 10));
  F.push(_skyUfo(2, 8));
  F.push(_skyUfo(3, 6));

  // 8. Touchdown.
  F.push(_scene(null, _GROUND_UFO));
  // 9. Dust kick.
  F.push(_scene(null, _GROUND_DUST));

  // 10. 👽 emerges next to the UFO (col 8, just to its right).
  F.push(_scene(_fig(8, { legs: 'apart' }),    _GROUND_UFO));
  // 11-13. Walks to center, legs alternating.
  F.push(_scene(_fig(10, { legs: 'together' }), _GROUND_UFO));
  F.push(_scene(_fig(12, { legs: 'apart' }),    _GROUND_UFO));
  F.push(_scene(_fig(14, { legs: 'together' }), _GROUND_UFO));

  // 14. Pulls a 🍾 out (held to the right of head).
  F.push(_scene(_fig(14, { prop: ' 🍾' }),       _GROUND_UFO));
  // 15-16. Drinks (bottle moved tight against the head).
  F.push(_scene(_fig(14, { prop: '🍾' }),         _GROUND_UFO));
  F.push(_scene(_fig(14, { prop: '🍾' }),         _GROUND_UFO));
  // 17. Bottle's empty — it disappears with the alien, no litter.
  F.push(_scene(_fig(14, {}),                     _GROUND_UFO));

  // 18. Pulls a 🚬.
  F.push(_scene(_fig(14, { prop: ' 🚬' }),       _GROUND_UFO));
  // 19-20. Smokes — first puff, longer drag.
  F.push(_scene(_fig(14, { prop: '🚬💨' }),       _GROUND_UFO));
  F.push(_scene(_fig(14, { prop: '🚬💨💨' }),     _GROUND_UFO));

  // 21-23. BURP — 💨 cloud carries the secret line.
  F.push(_scene(_fig(14, { prop: '💨' }),         _GROUND_UFO, '         "' + dialog + '"'));
  F.push(_scene(_fig(14, { prop: '💨' }),         _GROUND_UFO, '         "' + dialog + '"'));
  F.push(_scene(_fig(14, { prop: '💨' }),         _GROUND_UFO, '         "' + dialog + '"'));

  // 24. Cigarette also disappears (no litter).
  F.push(_scene(_fig(14, {}),                     _GROUND_UFO));

  // 25-27. Walks back to the UFO, legs alternating.
  F.push(_scene(_fig(12, { legs: 'apart' }),      _GROUND_UFO));
  F.push(_scene(_fig(10, { legs: 'together' }),   _GROUND_UFO));
  F.push(_scene(_fig(8,  { legs: 'apart' }),      _GROUND_UFO));

  // 28. Boards the UFO — figure gone.
  F.push(_scene(null, _GROUND_UFO));

  // 29-32. UFO takes off, ascends along the reverse diagonal.
  F.push(_skyUfo(3, 5));
  F.push(_skyUfo(2, 7));
  F.push(_skyUfo(1, 10));
  F.push(_skyUfo(0, 14));

  // 33. Warp flash.
  F.push([
    '   . · ✦ . *✨💫⋆ .  ',
    '  ✦ . · ✦ . * .     ',
    '    . * · . ✦ .     ',
    '  · ⋆ . · *         ',
    ..._EMPTY_FIG,
    _GROUND_EMPTY,
  ].join('\n'));

  // 34. Clean sky. Whole message auto-deletes after the hold.
  F.push(_scene(null, _GROUND_EMPTY));

  return F;
}

// ── Pirate movie ──────────────────────────────────────────────
//
// 3D tilted-plane scene: sky → horizon → trapezoid sea →
// shore → 5-row stick-figure space → beach. The sea narrows
// toward the back so the row a sprite sits on reads as
// distance from the viewer — top = far (horizon), bottom =
// near (foreground). The pirate is a narrow 5-row ASCII stick
// figure (head O, chest /-\, spine |, hip -, legs | |),
// chosen for clean alignment under the head column — emoji
// heads + parrot shoulders silently drifted the body off-
// center across overlays. Operator preference (2026-05).
//
// 12-row × 28-col canvas. Base rows are ASCII-only so column
// offsets count visual cells 1:1; sprites overlay at known
// (row, col). The dirt pile during digging stacks vertically
// onto the empty figure rows above the beach so the pile
// grows upward as the hole grows downward.

const _CANVAS_W = 28;

function _padR(s) {
  // Right-pad a base row to canvas width. Base rows are ASCII-only
  // so .length == visual width. Sprite overlays preserve width
  // (always 2 cu out, 2 cu in), so a padded base stays valid for
  // any later overlay at any col within range.
  const n = s.length;
  return n >= _CANVAS_W ? s : s + ' '.repeat(_CANVAS_W - n);
}

const _SKY_P = [
  _padR('  *  .  ✦  .  *  .  ✦  . '),
  _padR('     ✦  .  *  .  ✦       '),
];
// Sea trapezoid — one row trimmed (was 5) to make room for the
// 5-row figure space below the shore line while keeping the canvas
// at 12 rows.
const _SEA = [
  _padR('       ╱─────────────╲    '),   // 0 horizon (back edge)
  _padR('      ╱ ~ ~ ~ ~ ~ ~ ~ ╲   '),   // 1 far sea
  _padR('     ╱ ~ ~ ~ ~ ~ ~ ~ ~ ╲  '),   // 2
  _padR('    ╱ ~ ~ ~ ~ ~ ~ ~ ~ ~ ╲ '),   // 3 near sea
];
const _SHORE_P = '═'.repeat(_CANVAS_W);
const _BEACH_P = '.:'.repeat(_CANVAS_W / 2);
const _EMPTY_FIG_ROW = ' '.repeat(_CANVAS_W);

// Sprite constants — every sprite MUST be exactly 2 UTF-16 code units
// (a surrogate pair, OR a BMP codepoint + VS16) so that `_overlay`
// stays correct after multiple compositions on the same row. Base
// rows are ASCII (1 cu = 1 cell); a 2-cu sprite replaces 2 cu
// without shifting downstream col→cu alignment for subsequent
// overlays. Single-cu BMP emojis (e.g. bare '❌', U+274C) drift the
// row after they're placed and break later overlays at fixed cols.
const _SH_SHIP     = '🚢';
const _SH_HEAD     = '🧔';
const _SH_PARROT   = '🦜';
const _SH_MAP      = '\u{1F5FA}';        // 🗺 surrogate pair, 2 cu (no VS16)
const _SH_SHOVEL   = '⛏️';     // ⛏️ BMP + VS16, 2 cu
const _SH_GOLD     = '💰';
const _SH_SCROLL   = '📜';
const _SH_SPLASH   = '💦';
const _SH_DIRT     = '🟫';
const _SH_X        = '❌️';     // ❌ BMP + VS16, 2 cu

function _overlay(row, col, sprite) {
  // Replace 2 visual cells starting at `col` with one 2-cell sprite.
  // Base rows are ASCII (1 cu = 1 cell) so col indexes code units
  // directly; sprites must be 2 cu so the net code-unit count is
  // preserved, keeping later col-based overlays aligned. Callers
  // placing a head + prop pair must call _overlay twice (head at
  // col, prop at col + 2) — concatenating sprites into a single
  // overlay would only consume 2 cells but draw 4, widening the row.
  return row.slice(0, col) + sprite + row.slice(col + 2);
}

// Overwrite N visual cells of `row` at `col` with `text` (text is
// plain ASCII, so cu count == cell count). Sister to _overlay,
// which is for 2-cu emoji sprites.
function _drawText(row, col, text) {
  return row.slice(0, col) + text + row.slice(col + text.length);
}

// Compose a pirate scene frame.
//   ship:    { seaRow: 0..3, col }        — null = no ship
//   figure:  { col, prop?, legs? }        — 5-row ASCII stick figure
//              standing on the beach. `legs` is 'together' (default),
//              'apart', or 'cross' — picks the foot row variant.
//              `prop` is an optional 2-cell sprite at the head's
//              right (⛏️ shovel, 🗺 map, 📜 scroll, 💰 gold).
//   beachOverlays: array of { col, sprite } — beach-row decorations
//   pile:    array of { row: 0..3, col, sprite } — vertical overlay
//              into the figure-rows space (row 0 = legs/beach, row 1
//              = hip, row 2 = spine, row 3 = chest, row 4 = head).
//              Lets the dig sequence stack a dirt mound that rises
//              into the empty rows above the beach.
//   shoreOverlay: { col, sprite }
//   dialog:  string — shown beneath the scene (omit when no secret)
function _pirateScene({ ship, figure, beachOverlays = [], pile = [], shoreOverlay, dialog }) {
  const sea = [..._SEA];
  let shore = _SHORE_P;
  // Five figure-space rows above the beach. Pile/figure parts
  // overlay onto these; the bottom row (legs) IS the beach.
  let head  = _EMPTY_FIG_ROW;
  let chest = _EMPTY_FIG_ROW;
  let spine = _EMPTY_FIG_ROW;
  let hip   = _EMPTY_FIG_ROW;
  let beach = _BEACH_P;

  if (ship && ship.seaRow >= 0 && ship.seaRow < sea.length) {
    sea[ship.seaRow] = _overlay(sea[ship.seaRow], ship.col, _SH_SHIP);
  }
  if (shoreOverlay) {
    shore = _overlay(shore, shoreOverlay.col, shoreOverlay.sprite);
  }

  // Pile overlays first — figure parts go on top of them so a figure
  // standing next to a tall pile doesn't get clipped by the pile
  // sprite. The pile typically sits to one side of the figure anyway.
  for (const p of pile) {
    if (p.row === 0)      beach = _overlay(beach, p.col, p.sprite);
    else if (p.row === 1) hip   = _overlay(hip,   p.col, p.sprite);
    else if (p.row === 2) spine = _overlay(spine, p.col, p.sprite);
    else if (p.row === 3) chest = _overlay(chest, p.col, p.sprite);
    else if (p.row === 4) head  = _overlay(head,  p.col, p.sprite);
  }

  // Stick figure: every part written at its own column so we don't
  // erase the beach pattern (`.:.:.`) to the left of the figure
  // with leading spaces, and so earlier pile/decoration overlays
  // on the same row but at different cols survive. Layout
  // matches tools/stickfig.mjs's standing() shape: O head, /-\
  // chest (3 cells), | spine, - hip, 3-cell legs.
  if (figure) {
    const c = figure.col;
    const propText = figure.prop || '';
    const legSprite = figure.legs === 'apart' ? '/ \\'
                    : figure.legs === 'cross' ? '\\ /'
                    : '| |';
    head = _drawText(head, c, 'O');
    if (propText) head = _overlay(head, c + 1, propText);
    chest = _drawText(chest, c - 1, '/-\\');
    spine = _drawText(spine, c, '|');
    hip   = _drawText(hip,   c, '-');
    beach = _drawText(beach, c - 1, legSprite);
  }

  for (const o of beachOverlays) {
    beach = _overlay(beach, o.col, o.sprite);
  }

  const lines = [..._SKY_P, ...sea, shore, head, chest, spine, hip, beach];
  if (dialog) lines.push('       "' + dialog + '"');
  return lines.join('\n');
}

function _buildPirateFrames(secret) {
  // Only show dialog when the operator actually passed --secret.
  // The treasure dig is itself the climax visually; no need to
  // narrate "X marks the spot" when no secret is set.
  const motto = secret ? secret.trim().slice(0, 60) : '';
  const F = [];

  // Anchored-ship positions for the beach scene. The ship gently
  // bobs left/right between two near-shore cols so it feels rocked
  // by waves while the pirate is ashore. Index this with frame
  // parity to alternate.
  const ANCHOR = [
    { seaRow: 3, col: 14 },
    { seaRow: 3, col: 15 },
  ];
  const bob = (i) => ANCHOR[i % 2];
  let beat = 0;

  // 1. Empty bay.
  F.push(_pirateScene({}));

  // 2-4. Ship appears at the horizon (right) and drifts toward center.
  F.push(_pirateScene({ ship: { seaRow: 0, col: 19 } }));
  F.push(_pirateScene({ ship: { seaRow: 0, col: 15 } }));
  F.push(_pirateScene({ ship: { seaRow: 1, col: 13 } }));

  // 5-7. Ship descends through the trapezoid (closer = lower row).
  F.push(_pirateScene({ ship: { seaRow: 2, col: 13 } }));
  F.push(_pirateScene({ ship: { seaRow: 2, col: 14 } }));
  F.push(_pirateScene({ ship: { seaRow: 3, col: 14 } }));

  // 8. Anchor splash on the shore line in front of the ship.
  F.push(_pirateScene({
    ship: bob(beat++),
    shoreOverlay: { col: 16, sprite: _SH_SPLASH },
  }));

  // 9-11. Pirate disembarks and walks toward the center of the beach.
  F.push(_pirateScene({
    ship: bob(beat++),
    figure: { col: 18, legs: 'apart' },
  }));
  F.push(_pirateScene({
    ship: bob(beat++),
    figure: { col: 14, legs: 'together' },
  }));
  F.push(_pirateScene({
    ship: bob(beat++),
    figure: { col: 10, legs: 'apart' },
  }));

  // 12. Pulls out the map.
  F.push(_pirateScene({
    ship: bob(beat++),
    figure: { col: 10, prop: _SH_MAP, legs: 'together' },
  }));

  // 13-15. X appears further left on the beach; pirate walks to it.
  F.push(_pirateScene({
    ship: bob(beat++),
    figure: { col: 8, prop: _SH_MAP, legs: 'apart' },
    beachOverlays: [{ col: 2, sprite: _SH_X }],
  }));
  F.push(_pirateScene({
    ship: bob(beat++),
    figure: { col: 6, prop: _SH_MAP, legs: 'together' },
    beachOverlays: [{ col: 2, sprite: _SH_X }],
  }));
  F.push(_pirateScene({
    ship: bob(beat++),
    figure: { col: 5, legs: 'apart' },
    beachOverlays: [{ col: 2, sprite: _SH_X }],
  }));

  // 16-19. Digging — shovel out, dirt mound rises upward into the
  // formerly-empty rows above the beach (the pile occupies the
  // figure-row space at col 2, growing taller each frame).
  F.push(_pirateScene({
    ship: bob(beat++),
    figure: { col: 5, prop: _SH_SHOVEL, legs: 'together' },
    pile: [{ row: 0, col: 2, sprite: _SH_DIRT }],
  }));
  F.push(_pirateScene({
    ship: bob(beat++),
    figure: { col: 5, prop: _SH_SHOVEL, legs: 'apart' },
    pile: [
      { row: 0, col: 2, sprite: _SH_DIRT },
      { row: 1, col: 2, sprite: _SH_DIRT },
    ],
  }));
  F.push(_pirateScene({
    ship: bob(beat++),
    figure: { col: 5, prop: _SH_SHOVEL, legs: 'together' },
    pile: [
      { row: 0, col: 2, sprite: _SH_DIRT },
      { row: 1, col: 2, sprite: _SH_DIRT },
      { row: 2, col: 2, sprite: _SH_DIRT },
    ],
  }));
  F.push(_pirateScene({
    ship: bob(beat++),
    figure: { col: 5, prop: _SH_SHOVEL, legs: 'apart' },
    pile: [
      { row: 0, col: 2, sprite: _SH_DIRT },
      { row: 1, col: 2, sprite: _SH_DIRT },
      { row: 2, col: 2, sprite: _SH_DIRT },
      { row: 3, col: 2, sprite: _SH_DIRT },
    ],
  }));

  // 20. Hits the chest — treasure appears at the bottom of the hole,
  // pile collapses (sand slid back when chest popped up).
  F.push(_pirateScene({
    ship: bob(beat++),
    figure: { col: 5, legs: 'together' },
    beachOverlays: [{ col: 2, sprite: _SH_GOLD }],
  }));

  // 21-23. Pirate opens the scroll. Dialog (the secret) appears
  // beneath the scene — held for three frames so it's legible.
  for (let i = 0; i < 3; i++) {
    F.push(_pirateScene({
      ship: bob(beat++),
      figure: { col: 5, prop: _SH_SCROLL, legs: 'together' },
      beachOverlays: [{ col: 2, sprite: _SH_GOLD }],
      dialog: motto,
    }));
  }

  // 24. Pirate pockets the gold (it becomes his prop), beach clears.
  F.push(_pirateScene({
    ship: bob(beat++),
    figure: { col: 5, prop: _SH_GOLD, legs: 'apart' },
  }));

  // 25-27. Walks back to the ship.
  F.push(_pirateScene({
    ship: bob(beat++),
    figure: { col: 9, prop: _SH_GOLD, legs: 'together' },
  }));
  F.push(_pirateScene({
    ship: bob(beat++),
    figure: { col: 13, prop: _SH_GOLD, legs: 'apart' },
  }));
  F.push(_pirateScene({
    ship: bob(beat++),
    figure: { col: 17, prop: _SH_GOLD, legs: 'together' },
  }));

  // 28. Boards — figure gone (and the gold went with him).
  F.push(_pirateScene({ ship: bob(beat++) }));

  // 29-31. Ship sails back to the horizon (up + right).
  F.push(_pirateScene({ ship: { seaRow: 3, col: 15 } }));
  F.push(_pirateScene({ ship: { seaRow: 2, col: 16 } }));
  F.push(_pirateScene({ ship: { seaRow: 1, col: 17 } }));
  F.push(_pirateScene({ ship: { seaRow: 0, col: 18 } }));

  // 32. Vanished — empty bay, message auto-deletes.
  F.push(_pirateScene({}));

  return F;
}

// ── Couple movie ──────────────────────────────────────────────
//
// Two narrow ASCII stick figures meet under a moon, engage
// (#====D between chests), oscillate through an in/out motion
// loop, then a climax frame with the --secret as pillow talk,
// then a 💤 lying-down aftermath. Adult cartoon comedy — pure
// ASCII, no anatomy depicted, all the heavy lifting done by
// the #====D meme. Operator-greenlit (2026-05). Access still
// gated by the standard allowed_users awareness layer.
//
// 8-row canvas, 28 cols wide. Sky row + spacer + 5 figure rows
// + floor. Same _overlay/_drawText conventions as pirate; uses
// stickfig.couple() for the two-figure compositions.

const _COUPLE_W   = 28;
const _COUPLE_SKY = '   . * ☾ * . ✦ .            ';
const _COUPLE_EMPTY_ROW = ' '.repeat(_COUPLE_W);
const _COUPLE_FLOOR = '═'.repeat(_COUPLE_W);

function _padRow(s, w = _COUPLE_W) {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

function _coupleFrame(figRows, dialog) {
  const padded = figRows.map(r => _padRow(r));
  let s = [
    _COUPLE_SKY,
    _COUPLE_EMPTY_ROW,
    ...padded,
    _COUPLE_FLOOR,
  ].join('\n');
  if (dialog) s += '\n       "' + dialog + '"';
  return s;
}

function _buildCoupleFrames(secret) {
  const motto = secret ? secret.trim().slice(0, 60) : '';
  const F = [];

  // 1. Apart, idle — wide gap, both standing still.
  F.push(_coupleFrame(_figCouple({
    fig1Col: 4, fig2Col: 22, gap: '                ',
  })));

  // 2. Walking toward each other (legs apart, mid-stride).
  F.push(_coupleFrame(_figCouple({
    fig1Col: 8, fig2Col: 18, gap: '      ',
    fig1Legs: 'apart', fig2Legs: 'apart',
  })));

  // 3. Almost meeting (legs crossed, stepping in).
  F.push(_coupleFrame(_figCouple({
    fig1Col: 11, fig2Col: 15, gap: '  ',
    fig1Legs: 'cross', fig2Legs: 'cross',
  })));

  // 4. First contact — short implement, legs together.
  F.push(_coupleFrame(_figCouple({
    fig1Col: 4, fig2Col: 10, gap: '#=D',
  })));

  // 5-9. In/out loop: long extended (#====D, fig2 far) alternating
  // with short retracted (#=D, fig2 close). Legs swap apart/cross
  // each beat so the motion reads as rhythm rather than two
  // stills cycling.
  for (let i = 0; i < 5; i++) {
    const isOut = (i % 2 === 0);
    F.push(_coupleFrame(_figCouple({
      fig1Col: 4,
      fig2Col: isOut ? 13 : 10,
      gap:    isOut ? '#====D' : '#=D',
      fig1Legs: isOut ? 'apart' : 'cross',
      fig2Legs: isOut ? 'cross' : 'apart',
    })));
  }

  // 10. Climax — extended implement, legs apart, secret as pillow
  // talk. Held longer via the preset's holdMs so the dialog is
  // legible.
  F.push(_coupleFrame(_figCouple({
    fig1Col: 4, fig2Col: 16, gap: '#========D',
    fig1Legs: 'apart', fig2Legs: 'apart',
  }), motto));

  // Aftermath cols — fig2 stays anchored at col 16 (where the
  // climax left them) for frames 11..15 so they don't teleport
  // between beats; fig1 drifts left across the walk-away frames.

  // 11. Slap — 👋 lands at fig2's hip level. No directional
  // cigarette/wind emojis (those break in either orientation);
  // just the contact glyph.
  F.push(_coupleFrame([
    '    O           O           ',
    '   /-\\        /-\\          ',
    '    |           |           ',
    '    -        👋 -           ',
    '   | |         | |          ',
  ]));

  // 12. Cash handoff — 💯💶 between the chests.
  F.push(_coupleFrame([
    '    O           O           ',
    '   /-\\  💯💶  /-\\          ',
    '    |           |           ',
    '    -           -           ',
    '   | |         | |          ',
  ]));

  // 13. Walk away (step 1) — fig1 strides left, fig2 stays put.
  F.push(_coupleFrame(_figCouple({
    fig1Col: 3, fig2Col: 16,
    gap: '          ',       // 10-char gap, c2 = 3+2+10 = 15, ✓ chest2 cols 15-17
    fig1Legs: 'apart', fig2Legs: 'together',
  })));

  // 14. Walk away (step 2) — fig1 near the canvas edge.
  F.push(_coupleFrame(_figCouple({
    fig1Col: 1, fig2Col: 16,
    gap: '            ',     // 12-char gap, c2 = 1+2+12 = 15, ✓
    fig1Legs: 'cross', fig2Legs: 'together',
  })));

  // 15. Alone — fig2 holding the cash, fig1 gone.
  F.push(_coupleFrame([
    '                O           ',
    '               /-\\          ',
    '                |    💯💶   ',
    '                -           ',
    '               | |          ',
  ]));

  return F;
}

// ── Deliver movie ─────────────────────────────────────────────
//
// One-line cartoon: ====D approaches a . on the right. The hole
// is too small, D bounces off; on each bounce the hole opens a
// notch wider (. → o → O → ()). Once it's () the D slides
// inside, the parens engulf, and the --secret "delivers" as
// the final 💌 frame. autoDelete revokes the whole message
// after holdMs, so the secret is genuinely ephemeral — the
// wink-wink "how the message is delivered" the operator asked
// about.
//
// The frame string is a single line; triple-backtick monospace
// wrap (per the preset's monospace:true flag) preserves the
// leading spaces that encode how far the D has approached.

function _buildDeliverFrames(secret) {
  const motto = secret ? secret.trim().slice(0, 60) : '';
  const W = 30;
  const HOLE_COL = 26;

  // Compose one frame. `dCol` = column of the rightmost 'D' char of
  // ====D (5 chars wide, so the ==== starts at dCol-4). `hole` is
  // 1 or 2 ASCII chars at HOLE_COL. Pads to W on the right so the
  // frame width is stable across emits.
  const frame = (dCol, hole) => {
    const lead = Math.max(0, dCol - 4);
    const gap  = Math.max(0, HOLE_COL - dCol - 1);
    let line = ' '.repeat(lead) + '====D' + ' '.repeat(gap) + hole;
    if (line.length < W) line += ' '.repeat(W - line.length);
    return line;
  };

  const F = [];

  // Approach the . from far left — uniform stride, slowing as it
  // nears the dot so the contact feels deliberate, not a fly-by.
  F.push(frame(4,  '.'));
  F.push(frame(8,  '.'));
  F.push(frame(12, '.'));
  F.push(frame(16, '.'));
  F.push(frame(20, '.'));
  F.push(frame(23, '.'));
  F.push(frame(25, '.'));   // touching .

  // Bounce 1 — D recoils, hole opens . → o.
  F.push(frame(22, 'o'));
  F.push(frame(20, 'o'));
  F.push(frame(23, 'o'));
  F.push(frame(25, 'o'));   // touching o

  // Bounce 2 — recoil + o → O.
  F.push(frame(22, 'O'));
  F.push(frame(20, 'O'));
  F.push(frame(23, 'O'));
  F.push(frame(25, 'O'));   // touching O

  // Bounce 3 — recoil + O → (), now wide enough.
  F.push(frame(22, '()'));
  F.push(frame(20, '()'));
  F.push(frame(23, '()'));
  F.push(frame(25, '()'));  // adjacent, primed

  // Entry — parens engulf the D. Two beats: just-in, then settled.
  F.push(' '.repeat(20) + '(====D)' + ' '.repeat(3));
  F.push(' '.repeat(19) + '((====D))' + ' '.repeat(2));

  // Delivery — the secret arrives as a 💌. autoDelete revokes
  // the message after holdMs, so this final frame is the entire
  // "wink wink" payoff: brief, ephemeral, exactly once.
  if (motto) {
    F.push('       💌  "' + motto + '"');
  } else {
    F.push('             💌  delivered');
  }

  return F;
}

export const PRESETS = {
  // ── Showcase ─────────────────────────────────────────────────
  alien: {
    ms: 600, monospace: true, autoDelete: true, holdMs: 2500,
    consumesSecret: true,
    params: '[--secret "<dialog>"]',
    desc: 'UFO lands → 👽 stick figure emerges, walks, drinks 🍾, ' +
          'smokes 🚬, burps 💨 revealing the secret, walks back, ' +
          'UFO flies away. Whole message auto-deletes; alien takes ' +
          'its props with it (no litter).',
    build: (arg) => _buildAlienFrames(arg),
  },
  pirate: {
    ms: 700, monospace: true, autoDelete: true, holdMs: 3000,
    consumesSecret: true,
    params: '[--secret "<treasure note>"]',
    desc: '3D tilted-plane bay: sky / horizon / trapezoid sea / shore / ' +
          'beach. 🚢 sails in from the horizon (bobbing while anchored) ' +
          '→ narrow ASCII stick-figure pirate disembarks, unrolls 🗺, ' +
          'walks to ❌, digs ⛏️ — dirt 🟫 piles upward into the rows ' +
          'above the beach — uncovers 💰, reads 📜 with the secret as ' +
          'the treasure note, walks back with the gold, ship sails back ' +
          'over the horizon. Dialog only shows when --secret is passed.',
    build: (arg) => _buildPirateFrames(arg),
  },
  couple: {
    ms: 600, monospace: true, autoDelete: true, holdMs: 4000,
    consumesSecret: true,
    params: '[--secret "<pillow talk>"]',
    desc: 'two narrow ASCII stick figures meet under a 🌙, approach, ' +
          'engage (#====D between chests), pump through an in/out ' +
          'motion loop, climax with the --secret as pillow talk, then ' +
          '💤 lying-down aftermath, fade to night. Adult cartoon ' +
          'comedy — ASCII only, no anatomy depicted. Trigger from a ' +
          'WA chat with @movie couple --secret "...".',
    build: (arg) => _buildCoupleFrames(arg),
  },
  deliver: {
    ms: 500, monospace: true, autoDelete: true, holdMs: 3500,
    consumesSecret: true,
    params: '[--secret "<message>"]',
    desc: 'one-line cartoon: ====D approaches a . on the right. The ' +
          'hole is too small, D bounces off; each bounce opens the ' +
          'hole a notch wider (. → o → O → ()). When () is wide ' +
          'enough, the D slides inside, the parens engulf, and the ' +
          '--secret "delivers" as the final 💌 frame. autoDelete ' +
          'revokes the message after holdMs — the secret is delivered ' +
          'once and then gone. Triple-backtick monospace preserves ' +
          "the leading-space approach distance. Operator-greenlit; " +
          'lighter touch than the full couple preset.',
    build: (arg) => _buildDeliverFrames(arg),
  },

  // ── Utility presets ──────────────────────────────────────────
  typewriter: {
    ms: 100, autoDelete: true, holdMs: 2500,
    params: '<text>',
    desc: 'reveals text character by character with a ▌ cursor',
    build: (arg) => {
      const text = (arg || 'hello, world').trim().slice(0, 200);
      const out = [];
      for (let i = 0; i <= text.length; i++) out.push(text.slice(0, i) + (i < text.length ? '▌' : ''));
      out.push(text);
      return out;
    },
  },
  loading: {
    ms: 200, autoDelete: true, holdMs: 1000,
    desc: 'braille spinner → ✅',
    frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏', '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '✅'],
  },
  scan: {
    ms: 400, autoDelete: true, holdMs: 1500,
    desc: 'progress bar → ✓ done',
    frames: ['▱▱▱▱▱▱▱▱', '▰▱▱▱▱▱▱▱', '▰▰▱▱▱▱▱▱', '▰▰▰▱▱▱▱▱', '▰▰▰▰▱▱▱▱', '▰▰▰▰▰▱▱▱', '▰▰▰▰▰▰▱▱', '▰▰▰▰▰▰▰▱', '▰▰▰▰▰▰▰▰', '✓ done'],
  },
};

// Parse a movie spec string ("alien --secret \"hi\"", "typewriter
// hello there", "loading") and return the ready-to-play payload.
// Used by both the /movie slash command (operator side) and the
// '@movie' wake-word handler in the WA bridge (in-chat side) so
// argument parsing, preset lookup, and frame-building rules stay
// in exactly one place.
//
// The first non-flag token is the preset name; everything else is
// flag-controlled (--ms, --keep, --secret, --frames) or positional
// args forwarded to the preset's build() (e.g. typewriter text).
//
// Returns { frames, frameMs, autoDelete, holdMs, presetName,
//   secret, positional } on success, or { error } on failure.
export function buildMoviePayload(argsStr) {
  const tokens = String(argsStr ?? '').trim().split(/\s+/).filter(Boolean);
  let frameMs = null;
  let customFrames = null;
  let presetName = null;
  let positional = '';
  let secret = null;
  let keep = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--ms' && tokens[i + 1]) {
      const n = parseInt(tokens[i + 1], 10);
      if (Number.isFinite(n) && n > 0) frameMs = Math.max(80, n);
      i++;
    } else if (t === '--keep') {
      keep = true;
    } else if (t === '--secret' && tokens[i + 1]) {
      const rest = [];
      i++;
      while (i < tokens.length && !tokens[i].startsWith('--')) {
        rest.push(tokens[i]);
        i++;
      }
      i--;
      secret = rest.join(' ').replace(/^["']|["']$/g, '');
    } else if (t === '--frames' && tokens[i + 1]) {
      const rest = [];
      i++;
      while (i < tokens.length && !tokens[i].startsWith('--')) {
        rest.push(tokens[i]);
        i++;
      }
      i--;
      customFrames = rest.join(' ').replace(/^["']|["']$/g, '').split('|').map(s => s.trim()).filter(Boolean);
    } else if (!presetName) {
      presetName = t;
    } else {
      positional = (positional ? positional + ' ' : '') + t;
    }
  }
  positional = positional.replace(/^["']|["']$/g, '');

  let frames, ms, autoDelete, holdMs;
  if (customFrames?.length) {
    frames = customFrames;
    ms = frameMs ?? 700;
    autoDelete = !keep;
    holdMs = 1500;
  } else if (presetName && PRESETS[presetName]) {
    const p = PRESETS[presetName];
    // Presets that consume the secret internally (alien, pirate)
    // opt in via `consumesSecret: true` and receive the secret as
    // their build() argument when no positional was given. Other
    // presets (typewriter, scan, loading, ...) get the secret
    // appended as a trailing 💬 frame so it surfaces somewhere.
    let buildArg = positional;
    if (p.consumesSecret && secret && !positional) buildArg = secret;
    frames = p.frames ?? p.build(buildArg);
    if (!p.consumesSecret && secret) frames = [...frames, `💬 "${secret}"`];
    if (p.monospace) frames = frames.map(f => '```\n' + f + '\n```');
    ms = frameMs ?? p.ms;
    autoDelete = keep ? false : (p.autoDelete ?? true);
    holdMs = secret ? Math.max(p.holdMs ?? 2000, 3500) : (p.holdMs ?? 2000);
  } else {
    return { error: `unknown preset "${presetName ?? '(none)'}"` };
  }

  if (frames.length > 60) {
    return { error: `${frames.length} frames exceeds the 60-frame ceiling — split into shorter movies` };
  }
  return { frames, frameMs: ms, autoDelete, holdMs, presetName, secret, positional };
}

export const meta = {
  cmd: '/movie',
  section: 'ROOM',
  surface: 'shell',
  usage: '/movie @waN <preset> [args] [--secret "<text>"] [--keep] [--ms N]',
  desc:
    'play an emoji / ASCII animation in a WA chat. movies auto-delete ' +
    'after the last frame unless --keep. --secret flashes a punchline ' +
    '(alien folds it into the scene as the 👽 burp dialog). /movie ' +
    'list enumerates presets. Also triggerable from inside a WA chat ' +
    'by typing "@movie <preset> [args]" — the operator (or anyone in ' +
    'whatsapp.allowed_users) can summon a movie that replaces the ' +
    'trigger message in place and auto-deletes when done.',
};

export async function run({ arg, ctx }) {
  // ctx keys consumed:
  //   sysOut(text)
  //   waBridgeRef          — WA bridge (exposes playFrames)
  //   waChannelsCacheRef   — @waN → chat object
  const { sysOut, waBridgeRef, waChannelsCacheRef } = ctx;

  const wa = waBridgeRef?.current;
  if (!wa?.playFrames) {
    sysOut('!! /movie: whatsapp bridge not running');
    return true;
  }

  const tokens = arg.trim().split(/\s+/).filter(Boolean);
  if (tokens[0] === 'list' || !tokens.length) {
    const rows = Object.entries(PRESETS).map(([name, p]) => {
      const lhs = `${name}${p.params ? '  ' + p.params : ''}`.padEnd(30);
      const stat = (p.frames ? `${p.frames.length} fr` : 'dynamic') +
                   ` @ ${p.ms}ms` +
                   (p.monospace ? '  multi-line' : '') +
                   (p.autoDelete ? '  auto-delete' : '');
      return `  ${lhs}  — ${p.desc}\n  ${' '.repeat(30)}    ${stat}`;
    });
    sysOut(
      'movie presets (all auto-delete after the last frame unless --keep):\n\n' +
      rows.join('\n\n') +
      '\n\nglobal flags:\n' +
      '  --secret "<text>"   punchline shown before deletion (alien folds it into the scene)\n' +
      '  --keep              don\'t delete after the last frame\n' +
      '  --ms <N>            override per-frame delay (floor 80ms)\n' +
      '  --frames "a|b|c"    custom frame sequence (no preset)\n' +
      '\nusage: ' + meta.usage +
      '\nin-chat: type "@movie <preset> [args]" inside WA — the trigger ' +
      'message becomes the movie (operator + allowed_users only).',
    );
    return true;
  }

  const targetTok = tokens[0];
  const waN = targetTok.match(/^@wa(\d+)$/i);
  if (!waN) {
    sysOut(`!! /movie: "${targetTok}" isn't @waN — /recap or /channels first to populate indices`);
    return true;
  }
  const idx = parseInt(waN[1], 10) - 1;
  const chat = waChannelsCacheRef?.current?.[idx];
  if (!chat) {
    sysOut(`!! /movie: no chat at ${targetTok} — /recap or /channels first`);
    return true;
  }

  // Everything after the @waN target is forwarded as-is to the
  // shared parser. Preset name + flag handling lives there so
  // /movie and the WA '@movie' wake-word stay in lockstep.
  const argsStr = tokens.slice(1).join(' ');
  const payload = buildMoviePayload(argsStr);
  if (payload.error) {
    sysOut(`!! /movie: ${payload.error}. /movie list to see options.`);
    return true;
  }
  const { frames, frameMs: ms, autoDelete, holdMs, presetName, secret, positional } = payload;

  const totalMs = frames.length * ms + (autoDelete ? holdMs : 0);
  const tag = positional || secret
    ? `${presetName ?? 'custom'} ${secret ? `--secret "${secret}"` : `"${positional}"`}`
    : (presetName ?? 'custom');
  const fate = autoDelete ? `auto-delete after ${holdMs}ms` : 'keep';
  sysOut(`🎬 /movie ${tag} → ${targetTok} "${chat.name}" (${frames.length} frames · ${ms}ms · ~${(totalMs / 1000).toFixed(1)}s · ${fate})`);
  const r = await wa.playFrames({ chatId: chat.jid, frames, frameMs: ms, autoDelete, holdMs });
  if (!r?.key) sysOut(`!! /movie: bridge returned no key — initial send may have failed`);
  return true;
}
