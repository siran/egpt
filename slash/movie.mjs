// slash/movie.mjs — play a short emoji animation in a WA chat by
// editing a single message frame-by-frame. The edit echo handler
// in the bridge folds these edits onto the original recent[] entry,
// so /recap won't see N mid-frame rows.

const PRESETS = {
  // The showcase. Vertical landing — sky → descent → contact.
  alien: {
    ms: 700,
    frames: [
      '✦  ✦   ✦      ✦',
      '✦  ✦ 🛸 ✦      ✦',
      '✦  ✦   ✦ 🛸    ✦',
      '✦  ✦   ✦      🛸',
      '✦  ✦   ✦  🛸',
      '✦  ✦  🛸',
      '✦ 🛸',
      '🛸',
      '🛸 👽',
      '   👽',
      '🌍 👽 — "hola"',
      '🌍 👽 — "ttyl"',
      '🌍',
    ],
  },
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
  rocket: {
    ms: 500,
    frames: [
      '_______\n   🚀\n',
      '_______\n   🚀\n     ·',
      '_______\n   🚀\n     ·\n      ·',
      '          🚀\n_______\n     ·\n      ·\n       ·',
      '   🚀\n\n_______\n     ·\n      ·\n       ·',
      '🚀\n\n\n_______\n     ·',
      '         🚀\n\n\n\n_______',
      '              🌠',
      '                  ✨',
    ],
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
  usage: '/movie @waN <preset> | /movie @waN --frames "a|b|c" [--ms N]',
  desc:
    'play a short emoji animation in a WA chat by editing a single ' +
    'message frame-by-frame. presets: alien, sparkler, fireworks, ' +
    'heart, fire, rocket, dance, rainbow, loading, scan. custom: ' +
    '--frames "f1|f2|f3" [--ms 700]. /movie list to enumerate presets.',
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
  // 'list' enumerates presets without sending anything.
  if (tokens[0] === 'list' || (!tokens.length)) {
    const lines = Object.entries(PRESETS).map(([name, p]) =>
      `  ${name.padEnd(12)} ${p.frames.length} frames @ ${p.ms}ms (${(p.frames.length * p.ms / 1000).toFixed(1)}s)`);
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

  // Parse --ms and --frames out of the remaining tokens.
  let frameMs = null;
  let customFrames = null;
  let presetName = null;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--ms' && tokens[i + 1]) {
      const n = parseInt(tokens[i + 1], 10);
      if (Number.isFinite(n) && n > 0) frameMs = Math.max(200, n);
      i++;
    } else if (t === '--frames' && tokens[i + 1]) {
      // Frames between quotes may have been split by the tokenizer;
      // rejoin everything until the next --flag.
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
    }
  }

  let frames, ms;
  if (customFrames?.length) {
    frames = customFrames;
    ms = frameMs ?? 700;
  } else if (presetName && PRESETS[presetName]) {
    frames = PRESETS[presetName].frames;
    ms = frameMs ?? PRESETS[presetName].ms;
  } else {
    sysOut(`!! /movie: unknown preset "${presetName ?? '(none)'}". /movie list to see options.`);
    return true;
  }

  // Soft cap to keep one /movie from monopolizing the bridge for
  // minutes. 60 frames × 200ms floor = 12s minimum, 60 × 2s = 2min
  // worst case for a long custom sequence.
  if (frames.length > 60) {
    sysOut(`!! /movie: ${frames.length} frames exceeds the 60-frame ceiling — split into shorter movies.`);
    return true;
  }

  sysOut(`🎬 /movie ${presetName ?? 'custom'} → ${targetTok} "${chat.name}" (${frames.length} frames · ${ms}ms · ~${(frames.length * ms / 1000).toFixed(1)}s)`);
  const r = await wa.playFrames({ chatId: chat.jid, frames, frameMs: ms });
  if (!r?.key) sysOut(`!! /movie: bridge returned no key — initial send may have failed`);
  return true;
}
