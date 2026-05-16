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

// ── Hi movie ──────────────────────────────────────────────────
//
// The simplest personalized preset: a waving 👋 hand greets
// whoever opened the message. Animation starts on first read,
// the greeting text appears with the wave, and each subsequent
// reader's pushName appends to the <username> list.
//
// Default template: "hi, <username>!" — operator can override
// with --template. The bridge handles <username> substitution
// at frame-emit time; the resolver here masks any phone-number-
// shaped pushName with a friendly fallback ("you", "friend", ...).

function _buildHiFrames(text) {
  const motto = (text || 'hi, <username>!').trim().slice(0, 100);
  const F = [];
  // Frame 0 — pre-anim placeholder. Static hand, no greeting, no
  // counter. This is what the operator sees BEFORE any viewer
  // opens — the bridge's read-receipt listener holds animation
  // start until someone reads, so the message lives in this state
  // until then. placeholderFrames:1 on the preset config tells the
  // bridge to SKIP frame 0 on re-animation so the names don't
  // flicker out between viewers.
  F.push('   👋');
  // Animation frames — hand alternates 👋 ↔ 🖐️ at slightly
  // different column offsets to read as a wave. Greeting + names
  // visible throughout. The bridge substitutes <username> at each
  // frame emit using the running viewers list.
  F.push('  👋  ' + motto);
  F.push('   👋 ' + motto);
  F.push('  🖐️  ' + motto);
  F.push('   👋 ' + motto);
  F.push('  🖐️  ' + motto);
  // Rest frame — what the message rests on between viewers. The
  // counter shows unique viewers + total read events; both
  // substitute at emit time so the resting message always reflects
  // the latest tally even when no animation is playing.
  F.push('   👋  ' + motto + '    👁 <viewercount> seen · <readcount> reads');
  return F;
}

// ── Bomb movie ────────────────────────────────────────────────
//
// Multi-row bomb: bomb sits, fuse grows up from it, spark lights
// at the top of the fuse and travels down, BOOM fills the canvas,
// smoke clears, secret/template reveal appears in the cleared
// space. 5-row × 28-col canvas; same _padR conventions as the
// other multi-row presets.
//
// With --template "...<username>...", the reveal frame's dialog
// is the template (substituted by the WA bridge at emit time
// using the running viewers list).

function _buildBombFrames(dialog) {
  const motto = (dialog || '').trim().slice(0, 60);
  const W = 28;
  const padR = (s) => s.length >= W ? s : s + ' '.repeat(W - s.length);
  const empty = ' '.repeat(W);

  // Compose a 5-row frame.
  const frame = (rows) => {
    const r = [...rows];
    while (r.length < 5) r.push(empty);
    return r.map(padR).join('\n');
  };

  const F = [];

  // F1. Bomb sits, fuse-free.
  F.push(frame([
    empty, empty, empty,
    '            💣',
    empty,
  ]));

  // F2-3. Fuse grows up from the bomb.
  F.push(frame([
    empty, empty,
    '            |',
    '            💣',
    empty,
  ]));
  F.push(frame([
    empty,
    '            |',
    '            |',
    '            💣',
    empty,
  ]));

  // F4. Spark appears at top of fuse — lit.
  F.push(frame([
    '            *',
    '            |',
    '            |',
    '            💣',
    empty,
  ]));

  // F5-7. Spark travels down the fuse toward the bomb.
  F.push(frame([
    empty,
    '            *',
    '            |',
    '            💣',
    empty,
  ]));
  F.push(frame([
    empty, empty,
    '            *',
    '            💣',
    empty,
  ]));
  F.push(frame([
    empty, empty, empty,
    '            💣*',
    empty,
  ]));

  // F8. Pre-flash — small burst at the bomb.
  F.push(frame([
    empty, empty, empty,
    '          💥💥💥',
    empty,
  ]));

  // F9. BOOM — fills the canvas radially.
  F.push(frame([
    '          💥  💥',
    '         💥💥💥💥',
    '        💥💥💥💥💥💥',
    '         💥💥💥💥',
    '          💥  💥',
  ]));

  // F10. Bigger BOOM with sparkles at the corners.
  F.push(frame([
    '       ✨💥  💥✨',
    '       💥💥💥💥💥💥',
    '      💥💥💥💥💥💥💥',
    '       💥💥💥💥💥💥',
    '       ✨💥  💥✨',
  ]));

  // F11-12. Smoke disperses.
  F.push(frame([
    empty,
    '         💨   💨',
    '          💨💨',
    '         💨   💨',
    empty,
  ]));
  F.push(frame([
    empty, empty,
    '          💨',
    empty, empty,
  ]));

  // F13. Reveal — secret/template appears in the cleared space.
  F.push(frame([
    empty, empty,
    '   💌 "' + motto + '"',
    empty, empty,
  ]));

  return F;
}

export const PRESETS = {
  // ── Showcase ─────────────────────────────────────────────────
  alien: {
    ms: 600, monospace: true, autoDelete: true, holdMs: 2500,
    consumesSecret: true,
    params: '[--secret "<dialog>"] [--template "...<username>..."]',
    desc: 'UFO lands → 👽 stick figure emerges, walks, drinks 🍾, ' +
          'smokes 🚬, burps 💨 revealing the secret, walks back, ' +
          'UFO flies away. Whole message auto-deletes; alien takes ' +
          'its props with it (no litter). With --template containing ' +
          '<username>, the burp dialog personalizes to whoever read ' +
          'the message.',
    build: (arg, opts = {}) => _buildAlienFrames(opts.template || arg),
  },
  hi: {
    ms: 350, monospace: true, autoDelete: false,
    consumesSecret: true,
    placeholderFrames: 1,
    params: '[--template "...<username>..."]',
    desc: 'a static 👋 hand that waves when anyone reads the message; ' +
          'each new viewer triggers a fresh wave and gets their ' +
          'pushName appended to the greeting. Hand stays put between ' +
          'viewers (no auto-delete). Phone-number-shaped pushNames ' +
          'are masked with a friendly fallback ("you", "friend", ...) ' +
          'so the greeting never renders as a raw phone number. ' +
          'Operator self-reads are skipped (the phone auto-marks-as-' +
          'read on send and would otherwise consume the first-reader ' +
          'greeting). Default template: "hi, <username>!" — override ' +
          'with --template.',
    build: (arg, opts = {}) => _buildHiFrames(opts.template || arg),
  },
  bomb: {
    ms: 600, monospace: true, autoDelete: true, holdMs: 3500,
    consumesSecret: true,
    params: '[--secret "<message>"] [--template "...<username>..."]',
    desc: '5-row bomb cartoon: bomb sits, fuse grows up, spark lights ' +
          'and travels down, BOOM fills the canvas, smoke clears, ' +
          'secret/template reveals in the cleared space. With ' +
          '--template containing <username>, the reveal personalizes ' +
          "to whoever read the message.",
    build: (arg, opts = {}) => _buildBombFrames(opts.template || arg),
  },

  // ── Utility presets ──────────────────────────────────────────
  typewriter: {
    ms: 100, autoDelete: false,
    consumesSecret: true,
    params: '<text> | [--template "...<username>..."]',
    desc: 'reveals text character by character with a ▌ cursor. With ' +
          '--template containing <username>, the typed text personalizes ' +
          'to whoever read the message.',
    build: (arg, opts = {}) => {
      const text = (opts.template || arg || 'hello, world').trim().slice(0, 200);
      const out = [];
      for (let i = 0; i <= text.length; i++) out.push(text.slice(0, i) + (i < text.length ? '▌' : ''));
      out.push(text);
      return out;
    },
  },
  loading: {
    ms: 200, autoDelete: false,
    desc: 'braille spinner → ✅',
    frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏', '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '✅'],
  },
  scan: {
    ms: 400, autoDelete: false,
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
  // Personalization (read-receipt driven):
  //   template: dialog string with `<username>` placeholder; the WA
  //             bridge substitutes at each frame's emit time using
  //             the running list of readers' pushNames.
  //   mode:     'append' (default) — list grows; 'first' — one-shot.
  //   joiner:   how names separate in the rendered list (default ', ').
  // When template is set, the bridge holds animation start until the
  // first read receipt arrives.
  let template = null;
  let mode = 'append';
  let joiner = ', ';
  // includeSelf: by default the operator's own read on their
  // outgoing message is skipped (auto-mark-as-read on send would
  // otherwise consume the first-viewer slot). Pass --include-self
  // to count yourself — useful for testing without a second device.
  let includeSelf = false;
  // Multi-word flag collector: grabs tokens until the next --flag,
  // then strips one surrounding pair of quotes. Shared by --secret,
  // --template, --frames so they all handle "spaces in quotes" the
  // same way.
  const collectMultiWord = (i) => {
    const rest = [];
    while (i < tokens.length && !tokens[i].startsWith('--')) {
      rest.push(tokens[i]);
      i++;
    }
    return { value: rest.join(' ').replace(/^["']|["']$/g, ''), nextI: i - 1 };
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--ms' && tokens[i + 1]) {
      const n = parseInt(tokens[i + 1], 10);
      if (Number.isFinite(n) && n > 0) frameMs = Math.max(80, n);
      i++;
    } else if (t === '--keep') {
      keep = true;
    } else if (t === '--include-self') {
      includeSelf = true;
    } else if (t === '--secret' && tokens[i + 1]) {
      const r = collectMultiWord(i + 1);
      secret = r.value;
      i = r.nextI;
    } else if (t === '--template' && tokens[i + 1]) {
      const r = collectMultiWord(i + 1);
      template = r.value;
      i = r.nextI;
    } else if (t === '--mode' && tokens[i + 1]) {
      mode = tokens[++i].replace(/^["']|["']$/g, '');
    } else if (t === '--joiner' && tokens[i + 1]) {
      joiner = tokens[++i].replace(/^["']|["']$/g, '');
    } else if (t === '--frames' && tokens[i + 1]) {
      const r = collectMultiWord(i + 1);
      customFrames = r.value.split('|').map(s => s.trim()).filter(Boolean);
      i = r.nextI;
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
    // build(arg, opts) — opts.template wins over arg for the
    // dialog/headline slot when present. The frame text includes
    // <username> as a literal placeholder; the WA bridge resolves
    // it at emit time from the running viewers list.
    frames = p.frames ?? p.build(buildArg, { template, mode, joiner, secret });
    if (!p.consumesSecret && secret) frames = [...frames, `💬 "${secret}"`];
    if (p.monospace) frames = frames.map(f => '```\n' + f + '\n```');
    ms = frameMs ?? p.ms;
    autoDelete = keep ? false : (p.autoDelete ?? true);
    holdMs = (secret || template) ? Math.max(p.holdMs ?? 2000, 3500) : (p.holdMs ?? 2000);
  } else {
    return { error: `unknown preset "${presetName ?? '(none)'}"` };
  }

  if (frames.length > 60) {
    return { error: `${frames.length} frames exceeds the 60-frame ceiling — split into shorter movies` };
  }
  // placeholderFrames: how many leading frames are pre-animation
  // placeholders (the message's resting state before the first
  // read). The bridge skips these on re-animation so the names
  // don't flicker out between viewers. Default 0 — preset opts in.
  const placeholderFrames = (presetName && PRESETS[presetName]?.placeholderFrames) || 0;
  return { frames, frameMs: ms, autoDelete, holdMs, presetName, secret, positional, template, mode, joiner, placeholderFrames, includeSelf };
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
  const { frames, frameMs: ms, autoDelete, holdMs, presetName, secret, positional, template, mode, joiner, placeholderFrames, includeSelf } = payload;

  const totalMs = frames.length * ms + (autoDelete ? holdMs : 0);
  const tag = positional || secret
    ? `${presetName ?? 'custom'} ${secret ? `--secret "${secret}"` : `"${positional}"`}`
    : (presetName ?? 'custom');
  const fate = autoDelete ? `auto-delete after ${holdMs}ms` : 'keep';
  const personalizedNote = template ? `  · personalized (waiting for first read)` : '';
  sysOut(`🎬 /movie ${tag} → ${targetTok} "${chat.name}" (${frames.length} frames · ${ms}ms · ~${(totalMs / 1000).toFixed(1)}s · ${fate}${personalizedNote})`);
  const r = await wa.playFrames({ chatId: chat.jid, frames, frameMs: ms, autoDelete, holdMs, template, mode, joiner, placeholderFrames, includeSelf });
  if (!r?.key) sysOut(`!! /movie: bridge returned no key — initial send may have failed`);
  return true;
}
