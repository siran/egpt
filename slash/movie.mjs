// slash/movie.mjs — play an ASCII / emoji movie inside a single WA
// message by editing it frame-by-frame. The bridge's edit-echo
// handler folds these edits onto the original recent[] entry so
// /recap won't see N mid-frame rows.
//
// Movies auto-delete by default (revoked after a hold). --keep
// disables. --secret "<text>" supplies the punchline.

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
// shore → beach. The sea is drawn as a trapezoid that narrows
// toward the back, so the row a sprite sits on reads as
// distance from the viewer — top = far (horizon), bottom =
// near (foreground).
//
// 9-row canvas, all base rows ASCII-only so column offsets
// count visual cells 1:1. Emoji sprites overlay at known
// (row, col) — each emoji takes 2 visual cells, so _overlay
// slices out 2 chars from the base before splicing the sprite
// in. Row widths are padded to ~26 cols so overlays near the
// right edge don't fall off.

const _SKY_P = [
  '  *  .  ✦  .  *  .  ✦  . ',
  '     ✦  .  *  .  ✦       ',
  '                          ',
];
const _SEA = [
  '      ╱─────────────╲    ', // 0  horizon (back edge of plane)
  '     ╱ ~ ~ ~ ~ ~ ~ ~ ╲   ', // 1
  '    ╱ ~ ~ ~ ~ ~ ~ ~ ~ ╲  ', // 2
  '   ╱ ~ ~ ~ ~ ~ ~ ~ ~ ~ ╲ ', // 3  near sea
];
const _SHORE_P = '═════════════════════════';
const _BEACH_P = '.:.:.:.:.:.:.:.:.:.:.:.:.';

// Sprite constants — every sprite MUST be exactly 2 UTF-16 code units
// (a surrogate pair, OR a BMP codepoint + VS16) so that `_overlay`
// stays correct after multiple compositions on the same row. Base
// rows are ASCII (1 cu = 1 cell); a 2-cu sprite replaces 2 cu
// without shifting downstream col→cu alignment for subsequent
// overlays. Single-cu BMP emojis (e.g. bare '❌', U+274C) drift the
// row after they're placed and break later overlays at fixed cols.
const _SH_SHIP     = '🚢';
const _SH_PIRATE   = '🧔';
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

function _pirateScene({ ship, pirate, beachOverlays = [], shoreOverlay, dialog }) {
  const sea = [..._SEA];
  let shore = _SHORE_P;
  let beach = _BEACH_P;

  if (ship && ship.seaRow >= 0 && ship.seaRow < sea.length) {
    sea[ship.seaRow] = _overlay(sea[ship.seaRow], ship.col, _SH_SHIP);
  }
  if (shoreOverlay) {
    shore = _overlay(shore, shoreOverlay.col, shoreOverlay.sprite);
  }
  for (const o of beachOverlays) {
    beach = _overlay(beach, o.col, o.sprite);
  }
  if (pirate) {
    beach = _overlay(beach, pirate.col, _SH_PIRATE);
    if (pirate.prop) beach = _overlay(beach, pirate.col + 2, pirate.prop);
  }

  const lines = [..._SKY_P, ...sea, shore, beach];
  if (dialog) lines.push('       "' + dialog + '"');
  return lines.join('\n');
}

function _buildPirateFrames(secret) {
  const motto = (secret || 'X marks the spot').trim().slice(0, 60) || 'X marks the spot';
  const F = [];

  // 1. Empty bay.
  F.push(_pirateScene({}));

  // 2-4. Ship appears at the horizon (right) and drifts toward center.
  F.push(_pirateScene({ ship: { seaRow: 0, col: 17 } }));
  F.push(_pirateScene({ ship: { seaRow: 0, col: 13 } }));
  F.push(_pirateScene({ ship: { seaRow: 0, col: 9  } }));

  // 5-7. Ship descends through the trapezoid (closer = lower row).
  F.push(_pirateScene({ ship: { seaRow: 1, col: 9  } }));
  F.push(_pirateScene({ ship: { seaRow: 2, col: 10 } }));
  F.push(_pirateScene({ ship: { seaRow: 3, col: 11 } }));

  // 8. Anchor splash on the shore line.
  F.push(_pirateScene({
    ship: { seaRow: 3, col: 11 },
    shoreOverlay: { col: 13, sprite: _SH_SPLASH },
  }));

  // 9-11. Pirate disembarks and walks along the beach.
  F.push(_pirateScene({
    ship: { seaRow: 3, col: 11 },
    pirate: { col: 14 },
  }));
  F.push(_pirateScene({
    ship: { seaRow: 3, col: 11 },
    pirate: { col: 11 },
  }));
  F.push(_pirateScene({
    ship: { seaRow: 3, col: 11 },
    pirate: { col: 8 },
  }));

  // 12. Pulls out the map.
  F.push(_pirateScene({
    ship: { seaRow: 3, col: 11 },
    pirate: { col: 8, prop: _SH_MAP },
  }));

  // 13-14. X appears further along the beach; pirate walks to it.
  F.push(_pirateScene({
    ship: { seaRow: 3, col: 11 },
    pirate: { col: 6, prop: _SH_MAP },
    beachOverlays: [{ col: 2, sprite: _SH_X }],
  }));
  F.push(_pirateScene({
    ship: { seaRow: 3, col: 11 },
    pirate: { col: 4, prop: _SH_MAP },
    beachOverlays: [{ col: 2, sprite: _SH_X }],
  }));

  // 15. Pirate arrives at the X.
  F.push(_pirateScene({
    ship: { seaRow: 3, col: 11 },
    pirate: { col: 4 },
    beachOverlays: [{ col: 2, sprite: _SH_X }],
  }));

  // 16-18. Digging — shovel out, sand pile grows.
  F.push(_pirateScene({
    ship: { seaRow: 3, col: 11 },
    pirate: { col: 4, prop: _SH_SHOVEL },
    beachOverlays: [{ col: 2, sprite: _SH_DIRT }],
  }));
  F.push(_pirateScene({
    ship: { seaRow: 3, col: 11 },
    pirate: { col: 4, prop: _SH_SHOVEL },
    beachOverlays: [{ col: 2, sprite: _SH_DIRT }, { col: 0, sprite: _SH_DIRT }],
  }));
  F.push(_pirateScene({
    ship: { seaRow: 3, col: 11 },
    pirate: { col: 4, prop: _SH_SHOVEL },
    beachOverlays: [{ col: 2, sprite: _SH_DIRT }, { col: 0, sprite: _SH_DIRT }],
  }));

  // 19. Treasure chest emerges.
  F.push(_pirateScene({
    ship: { seaRow: 3, col: 11 },
    pirate: { col: 4 },
    beachOverlays: [{ col: 2, sprite: _SH_GOLD }],
  }));

  // 20-22. Pirate reads the scroll — secret reveal (3 holds for legibility).
  for (let i = 0; i < 3; i++) {
    F.push(_pirateScene({
      ship: { seaRow: 3, col: 11 },
      pirate: { col: 4, prop: _SH_SCROLL },
      beachOverlays: [{ col: 2, sprite: _SH_GOLD }],
      dialog: motto,
    }));
  }

  // 23-25. Pirate picks up the gold and walks back to the ship.
  F.push(_pirateScene({
    ship: { seaRow: 3, col: 11 },
    pirate: { col: 7, prop: _SH_GOLD },
  }));
  F.push(_pirateScene({
    ship: { seaRow: 3, col: 11 },
    pirate: { col: 10, prop: _SH_GOLD },
  }));
  F.push(_pirateScene({
    ship: { seaRow: 3, col: 11 },
    pirate: { col: 13, prop: _SH_GOLD },
  }));

  // 26. Boards the ship — pirate gone, treasure gone (he took it with him).
  F.push(_pirateScene({ ship: { seaRow: 3, col: 11 } }));

  // 27-29. Ship sails back to the horizon (up + right).
  F.push(_pirateScene({ ship: { seaRow: 2, col: 12 } }));
  F.push(_pirateScene({ ship: { seaRow: 1, col: 14 } }));
  F.push(_pirateScene({ ship: { seaRow: 0, col: 16 } }));

  // 30. Vanished over the horizon — empty bay, message auto-deletes.
  F.push(_pirateScene({}));

  return F;
}

export const PRESETS = {
  // ── Showcase ─────────────────────────────────────────────────
  alien: {
    ms: 600, monospace: true, autoDelete: true, holdMs: 2500,
    params: '[--secret "<dialog>"]',
    desc: 'UFO lands → 👽 stick figure emerges, walks, drinks 🍾, ' +
          'smokes 🚬, burps 💨 revealing the secret, walks back, ' +
          'UFO flies away. Whole message auto-deletes; alien takes ' +
          'its props with it (no litter).',
    build: (arg) => _buildAlienFrames(arg),
  },
  pirate: {
    ms: 700, monospace: true, autoDelete: true, holdMs: 3000,
    params: '[--secret "<treasure note>"]',
    desc: '3D tilted-plane bay: sky / horizon / trapezoid sea / shore / ' +
          'beach. 🚢 sails in from the horizon → 🧔 pirate disembarks, ' +
          'pulls out 🗺️, walks to the ❌, digs ⛏️ a treasure 💰 out of ' +
          'the sand, reads 📜 with the secret as the treasure note, ' +
          'walks back with the gold, ship sails back over the horizon.',
    build: (arg) => _buildPirateFrames(arg),
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
    let buildArg = positional;
    if (presetName === 'alien' && secret && !positional) buildArg = secret;
    frames = p.frames ?? p.build(buildArg);
    if (presetName !== 'alien' && secret) frames = [...frames, `💬 "${secret}"`];
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
