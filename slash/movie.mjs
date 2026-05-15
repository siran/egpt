// slash/movie.mjs — play an ASCII / emoji movie inside a single WA
// message by editing it frame-by-frame. The bridge's edit-echo
// handler folds these edits onto the original recent[] entry, so
// /recap won't see N mid-frame rows.
//
// Movies auto-delete by default (message is revoked after a hold
// period). --keep disables. --secret "<text>" supplies the
// punchline; for the alien preset it lands inside the scene as the
// dialog line, for utility presets it appends a final '💬 "<text>"'
// frame.

// ── Alien movie ───────────────────────────────────────────────
//
// A 5-line fixed-frame scene: 4-line starfield + 1 ground line +
// optional 1 dialog line. The frame stays at a constant 25 visible
// columns and the alien plays out a small story on the ground line
// over ~30 beats.
//
// Storyline:
//   sky → UFO drifts in diagonally → lands with dust →
//   👽 emerges, walks to center → pulls 🍾, drinks →
//   pulls 🚬, smokes → burps 💨 revealing the secret →
//   walks back leaving 🍾 → boards UFO → takeoff → warp out →
//   empty sky again (bottle remains for a beat) → auto-delete.

const _SKY = [
  '   . · ✦ . * · ⋆ .  ',
  '  ✦ . · ✦ . * .     ',
  '    . * · . ✦ .     ',
  '  · ⋆ . · *         ',
];

// Sky-only frames where a UFO replaces one cell in one row.
function _skyUfo(line, col) {
  const rows = _SKY.map(l => l);
  const arr = rows[line].split('');
  if (col >= 0 && col < arr.length) arr[col] = '🛸';
  rows[line] = arr.join('');
  return [...rows, '─────────────────────────'].join('\n');
}

function _buildAlienFrames(secret) {
  const dialog = (secret || 'la verdad está allá afuera').trim().slice(0, 60) || 'la verdad está allá afuera';
  const sky = _SKY.join('\n');
  return [
    // 1. Empty sky.
    sky + '\n─────────────────────────',
    // 2-7. UFO drifts in diagonally from upper-right.
    _skyUfo(0, 18),
    _skyUfo(0, 14),
    _skyUfo(1, 12),
    _skyUfo(2, 10),
    _skyUfo(2, 8),
    _skyUfo(3, 6),
    // 8. Touchdown — UFO on the ground line.
    sky + '\n─────🛸──────────────────',
    // 9. Dust kick.
    sky + '\n~~~~~🛸~~~~~~────────────',
    // 10. Door opens.
    sky + '\n─────🛸◎─────────────────',
    // 11. 👽 emerges next to the UFO.
    sky + '\n─────🛸 👽───────────────',
    // 12-14. 👽 walks toward center.
    sky + '\n─────🛸   👽─────────────',
    sky + '\n─────🛸     👽───────────',
    sky + '\n─────🛸       👽─────────',
    // 15. Pulls out a bottle.
    sky + '\n─────🛸       👽 🍾──────',
    // 16-17. Drinks (bottle close).
    sky + '\n─────🛸       👽🍾───────',
    sky + '\n─────🛸       👽🍾───────',
    // 18. Sets the bottle aside; pulls a cigarette.
    sky + '\n─────🛸       👽 🚬──────',
    // 19-20. Smokes — first puff, then a longer drag.
    sky + '\n─────🛸       👽🚬💨─────',
    sky + '\n─────🛸       👽 💨💨────',
    // 21-23. The BURP — secret materializes in the cloud.
    sky + '\n─────🛸       👽💨───────\n     "' + dialog + '"',
    sky + '\n─────🛸       👽💨───────\n     "' + dialog + '"',
    sky + '\n─────🛸       👽💨───────\n     "' + dialog + '"',
    // 24-26. Walks back leaving the empty bottle.
    sky + '\n─────🛸     👽   🍾──────',
    sky + '\n─────🛸   👽     🍾──────',
    sky + '\n─────🛸 👽       🍾──────',
    // 27. Boards the UFO.
    sky + '\n─────🛸          🍾──────',
    // 28-31. UFO takes off, ascends, warps out.
    _skyUfoWithBottle(3, 5,  '🍾', 15),
    _skyUfoWithBottle(2, 7,  '🍾', 15),
    _skyUfoWithBottle(1, 10, '🍾', 15),
    _skyUfoWithBottle(0, 14, '🍾', 15),
    // 32. Warp flash.
    [
      '   . · ✦ . * ✨💫⋆ .  ',
      '  ✦ . · ✦ . * .     ',
      '    . * · . ✦ .     ',
      '  · ⋆ . · *         ',
      '────────────────🍾───────',
    ].join('\n'),
    // 33. Empty sky, bottle still on the ridge (for one beat).
    sky + '\n────────────────🍾───────',
    // 34. Even the bottle's gone — clean sky for the final hold
    //     before auto-delete revokes the whole message.
    sky + '\n─────────────────────────',
  ];
}
function _skyUfoWithBottle(line, col, bottle, bottleCol) {
  const rows = _SKY.map(l => l);
  const arr = rows[line].split('');
  if (col >= 0 && col < arr.length) arr[col] = '🛸';
  rows[line] = arr.join('');
  const ground = Array(25).fill('─');
  if (bottleCol >= 0 && bottleCol < ground.length) ground[bottleCol] = bottle;
  return [...rows, ground.join('')].join('\n');
}

const PRESETS = {
  // ── Showcase ─────────────────────────────────────────────────
  alien: {
    ms: 600, monospace: true, autoDelete: true, holdMs: 2500,
    params: '[--secret "<dialog>"]',
    desc: 'UFO lands, 👽 emerges, drinks 🍾, smokes 🚬, burps 💨 ' +
          'revealing the secret, returns to ship, flies away. Whole ' +
          'message auto-deletes.',
    build: (arg) => _buildAlienFrames(arg),
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

export const meta = {
  cmd: '/movie',
  section: 'ROOM',
  surface: 'shell',
  usage: '/movie @waN <preset> [args] [--secret "<text>"] [--keep] [--ms N]',
  desc:
    'play an emoji / ASCII animation in a WA chat. movies auto-delete ' +
    'after the last frame unless --keep. --secret flashes a punchline ' +
    'before deletion (alien folds it inside the scene; other presets ' +
    'append it). /movie list enumerates presets with their args.',
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
      '\nusage: ' + meta.usage,
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

  let frameMs = null;
  let customFrames = null;
  let presetName = null;
  let positional = '';
  let secret = null;
  let keep = false;
  for (let i = 1; i < tokens.length; i++) {
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
    sysOut(`!! /movie: unknown preset "${presetName ?? '(none)'}". /movie list to see options.`);
    return true;
  }

  if (frames.length > 60) {
    sysOut(`!! /movie: ${frames.length} frames exceeds the 60-frame ceiling — split into shorter movies.`);
    return true;
  }

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
