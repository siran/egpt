// slash/movie.mjs — play a short emoji / ASCII animation in a WA
// chat by editing a single message frame-by-frame. The edit echo
// handler in the bridge folds these edits onto the original
// recent[] entry, so /recap won't see N mid-frame rows.
//
// Multi-line ASCII frames wrap in ```...``` so WA renders them
// monospace + preserves whitespace (column alignment stays intact
// across the animation).
//
// Some presets are parametrized — pass an argument after the
// preset name: /movie @wa1 heart-name "Marta" / /movie @wa1
// greedy "marketing" / /movie @wa1 typewriter "hola, mundo".

// Multi-line frame helpers. Each frame is the literal block; the
// monospace flag on the preset tells playFrames to wrap in ```.
const STARFIELD = [
  '   *    .     ✦  *',
  ' .   ✦    .    *  ',
  '  *     .    ✦   .',
  ' .    *    .  *   ',
];
const _starWithAt = (line, col, glyph) => {
  const row = STARFIELD[line].split('');
  const g = [...glyph];
  for (let i = 0; i < g.length && col + i < row.length; i++) row[col + i] = g[i];
  return row.join('');
};
const _alienFrame = (line, col, glyph) => {
  const fr = [...STARFIELD];
  if (line >= 0 && line < fr.length) fr[line] = _starWithAt(line, col, glyph);
  return fr.join('\n');
};

const PRESETS = {
  // The showcase. UFO drifts diagonally across the sky, lands,
  // 👽 hops out, says hi/bye, UFO departs, sky returns.
  alien: {
    ms: 700, monospace: true,
    frames: [
      STARFIELD.join('\n'),
      _alienFrame(0, 10, '🛸'),
      _alienFrame(1, 8, '🛸'),
      _alienFrame(2, 6, '🛸'),
      _alienFrame(3, 4, '🛸'),
      [...STARFIELD, '─────🛸───────────'].join('\n'),
      [...STARFIELD, '   👽            ', '─────🛸───────────'].join('\n'),
      [...STARFIELD, '   👽 "hola"     ', '─────🛸───────────'].join('\n'),
      [...STARFIELD, '   👽 "ttyl"     ', '─────🛸───────────'].join('\n'),
      [...STARFIELD, '           🛸 →  ', '──────────────────'].join('\n'),
      _alienFrame(3, 14, '🛸'),
      _alienFrame(2, 12, '🛸'),
      _alienFrame(1, 10, '🛸'),
      _alienFrame(0, 8, '🛸'),
      STARFIELD.join('\n'),
    ],
  },

  // Stick figure walks across a 30-col baseline. Alternating leg
  // poses make the walk read as motion, not just translation.
  stickman: {
    ms: 350, monospace: true,
    frames: (() => {
      const POSE_A = [' O ', '/|\\', '/ \\'];
      const POSE_B = [' O ', '/|\\', '| |'];
      const POSES = [POSE_A, POSE_B];
      const baseline = '═'.repeat(30);
      const out = [];
      for (let step = 0; step <= 27; step += 2) {
        const pose = POSES[(step / 2) % 2];
        out.push(pose.map(l => ' '.repeat(step) + l).join('\n') + '\n' + baseline);
      }
      return out;
    })(),
  },

  // Choo-choo train rolls right across the panel. Wheels animate
  // via two alternating frames per position.
  train: {
    ms: 280, monospace: true,
    frames: (() => {
      const PANEL_WIDTH = 36;
      const A = [
        ' ___________',
        '/___________|___    💨',
        '|  egpt rail  []|',
        '| O   O   O   O |',
        'o-o-o-o-o-o-o-o-o',
      ];
      const B = [
        ' ___________     💨',
        '/___________|___ ',
        '|  egpt rail  []|',
        '| o   o   o   o |',
        'O-O-O-O-O-O-O-O-O',
      ];
      const POSES = [A, B];
      const out = [];
      for (let step = -10; step <= PANEL_WIDTH; step += 2) {
        const pose = POSES[((step + 10) / 2) % 2];
        const padded = pose.map(l => ' '.repeat(Math.max(0, step)) + l);
        out.push(padded.join('\n'));
      }
      return out;
    })(),
  },

  // Rocket launch: countdown, ignition, ascent with growing
  // exhaust trail.
  rocket: {
    ms: 500, monospace: true,
    frames: [
      '   /\\\n  /  \\\n |    |\n |🚀  |\n |____|\n   ▼\n\n\n  3...',
      '   /\\\n  /  \\\n |    |\n |🚀  |\n |____|\n   ▼\n\n\n  2...',
      '   /\\\n  /  \\\n |    |\n |🚀  |\n |____|\n   ▼\n\n\n  1...',
      '   /\\\n  /  \\\n |    |\n |🚀  |\n |____|\n   🔥\n  💥💥💥\n\n  ignition',
      '   /\\\n  /  \\\n |    |\n |🚀  |\n |____|\n   🔥\n   🔥\n  💥💥💥\n  liftoff!',
      '   /\\\n  /  \\\n |🚀  |\n |____|\n   🔥\n   🔥\n   🔥\n  💥💥💥',
      '  /\\\n /  \\\n|🚀  |\n|____|\n  🔥\n  🔥\n  🔥\n  🔥\n 💥💥💥',
      ' 🚀\n  ↑\n  🔥\n  🔥\n  🔥\n  🔥\n  🔥\n💥💥💥💥',
      '   🚀\n\n   ↑\n   🔥\n   🔥\n   🔥\n  💥💥',
      '       🚀\n\n\n        ↑\n        🔥\n       💥',
      '            🌠\n\n\n\n\n',
      '                 ✨\n\n\n\n\n',
    ],
  },

  // Parametrized — reveals a name inside a growing heart.
  // /movie @wa1 heart-name "Marta"
  'heart-name': {
    ms: 550,
    build: (arg) => {
      const name = (arg || 'You').trim().slice(0, 24) || 'You';
      return [
        '❤️',
        '❤️ ❤️',
        '❤️ ❤️ ❤️',
        '❤️❤️❤️❤️❤️',
        '❤️❤️ ❤️ ❤️❤️',
        `❤️❤️ ${name} ❤️❤️`,
        `💗 ${name} 💗`,
        `💖 ${name} 💖`,
        `💝 ${name} 💝`,
        `💖 ${name} 💖`,
        '💖 💗 💖',
        '❤️',
      ];
    },
  },

  // Parametrized — spells a word with greedy / cheeky money emojis.
  // /movie @wa1 greedy "marketing"
  greedy: {
    ms: 500,
    build: (arg) => {
      const word = (arg || 'money').trim().slice(0, 30) || 'money';
      return [
        '🤑',
        '🤑 💰',
        '🤑 💰 💸',
        '🤑 💰 💸 💵',
        `🤑 ${word} 💵`,
        `💰 ${word} 💸`,
        `💸 ${word} 💵`,
        `🤑💰 ${word} 💸💵`,
        `🤑💰💸 ${word} 💵💸💰`,
        `💸💰🤑 ${word.toUpperCase()} 🤑💰💸`,
        `🤑🤑🤑 ${word.toUpperCase()} 🤑🤑🤑`,
        `${word.toUpperCase()} 💰💰💰`,
        '💸💸💸',
      ];
    },
  },

  // Parametrized — types text character by character.
  // /movie @wa1 typewriter "hola, mundo"
  typewriter: {
    ms: 100,
    build: (arg) => {
      const text = (arg || 'hello, world').trim().slice(0, 200);
      const out = [];
      for (let i = 0; i <= text.length; i++) out.push(text.slice(0, i) + (i < text.length ? '▌' : ''));
      out.push(text);
      return out;
    },
  },

  // Single-line presets (unchanged from initial release).
  sparkler: {
    ms: 500,
    frames: ['·', '✨', '✨💫', '🌟💫✨', '🌟💫✨💥', '🌈🌟💫✨', '🌈🌟💫', '🌈🌟', '🌈'],
  },
  fireworks: {
    ms: 600,
    frames: ['·', '✨', '💥', '🎆', '🎆🎇', '🎇🎆🎇', '✨🎆🎇✨', '🌟🎇🎆🌟', '⭐'],
  },
  heart: {
    ms: 500,
    frames: ['❤️', '💗', '💖', '💘', '💝', '💖', '💗', '❤️'],
  },
  fire: {
    ms: 500,
    frames: ['·', '🔥', '🔥🔥', '🔥🔥🔥', '🔥🔥🔥🔥', '🌋', '💥🌋', '🔥'],
  },
  dance: {
    ms: 500,
    frames: ['🕺', '🕺💃', '💃🕺💃', '🕺💃🕺💃', '💃🕺💃🕺💃', '🎉🕺💃🎉', '🎉🎉🎉'],
  },
  rainbow: {
    ms: 400,
    frames: ['🟥', '🟥🟧', '🟥🟧🟨', '🟥🟧🟨🟩', '🟥🟧🟨🟩🟦', '🟥🟧🟨🟩🟦🟪', '🌈'],
  },
  loading: {
    ms: 200,
    frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏', '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '✅'],
  },
  scan: {
    ms: 400,
    frames: ['▱▱▱▱▱▱▱▱', '▰▱▱▱▱▱▱▱', '▰▰▱▱▱▱▱▱', '▰▰▰▱▱▱▱▱', '▰▰▰▰▱▱▱▱', '▰▰▰▰▰▱▱▱', '▰▰▰▰▰▰▱▱', '▰▰▰▰▰▰▰▱', '▰▰▰▰▰▰▰▰', '✓ done'],
  },
};

export const meta = {
  cmd: '/movie',
  section: 'ROOM',
  surface: 'shell',
  usage: '/movie @waN <preset> [arg] | --frames "a|b|c" [--ms N]',
  desc:
    'play an emoji / ASCII animation in a WA chat. presets: alien, ' +
    'stickman, train, rocket, sparkler, fireworks, heart, fire, ' +
    'dance, rainbow, loading, scan, plus parametrized heart-name ' +
    '"<name>", greedy "<word>", typewriter "<text>". /movie list ' +
    'enumerates. custom: --frames "f1|f2|f3" [--ms 700].',
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
    const lines = Object.entries(PRESETS).map(([name, p]) => {
      const frameCount = p.frames?.length ?? (p.build ? '?' : 0);
      const dur = p.frames ? (p.frames.length * p.ms / 1000).toFixed(1) + 's' : '~';
      const arg = p.build ? ' <arg>' : '';
      const ml = p.monospace ? '  [multi-line]' : '';
      return `  ${(name + arg).padEnd(20)} ${String(frameCount).padStart(2)} frames @ ${p.ms}ms  (${dur})${ml}`;
    });
    sysOut(`available presets:\n${lines.join('\n')}\n\nusage: ${meta.usage}`);
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

  // Parse remaining tokens: preset name, optional preset arg
  // (everything until next --flag), --ms, --frames.
  let frameMs = null;
  let customFrames = null;
  let presetName = null;
  let presetArg = '';
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--ms' && tokens[i + 1]) {
      const n = parseInt(tokens[i + 1], 10);
      if (Number.isFinite(n) && n > 0) frameMs = Math.max(80, n);
      i++;
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
      // Everything after the preset name (up to a --flag) is the
      // preset's positional argument — typically a quoted string
      // that the tokenizer split on spaces.
      presetArg = (presetArg ? presetArg + ' ' : '') + t;
    }
  }
  presetArg = presetArg.replace(/^["']|["']$/g, '');

  let frames, ms;
  if (customFrames?.length) {
    frames = customFrames;
    ms = frameMs ?? 700;
  } else if (presetName && PRESETS[presetName]) {
    const p = PRESETS[presetName];
    frames = p.frames ?? p.build(presetArg);
    if (p.monospace) frames = frames.map(f => '```\n' + f + '\n```');
    ms = frameMs ?? p.ms;
  } else {
    sysOut(`!! /movie: unknown preset "${presetName ?? '(none)'}". /movie list to see options.`);
    return true;
  }

  if (frames.length > 60) {
    sysOut(`!! /movie: ${frames.length} frames exceeds the 60-frame ceiling — split into shorter movies.`);
    return true;
  }

  const tag = presetArg
    ? `${presetName} "${presetArg}"`
    : (presetName ?? 'custom');
  sysOut(`🎬 /movie ${tag} → ${targetTok} "${chat.name}" (${frames.length} frames · ${ms}ms · ~${(frames.length * ms / 1000).toFixed(1)}s)`);
  const r = await wa.playFrames({ chatId: chat.jid, frames, frameMs: ms });
  if (!r?.key) sysOut(`!! /movie: bridge returned no key — initial send may have failed`);
  return true;
}
