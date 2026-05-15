// slash/movie.mjs — play a short emoji / ASCII animation in a WA
// chat by editing a single message frame-by-frame. The edit echo
// handler in the bridge folds these edits onto the original
// recent[] entry, so /recap won't see N mid-frame rows.
//
// Movies auto-delete by default. The animation plays, the recipient
// sees it, then the whole message is revoked (delete-for-everyone)
// after a hold period. Pass --keep to disable the deletion.
//
// --secret "<text>" inserts a final dialogue frame carrying that
// text, then deletes everything (including the secret) after a
// longer hold. Useful for ephemeral messages: "alien lands, hands
// the recipient a note, takes off, the whole thing vanishes".
//
// Multi-line ASCII frames wrap in ```...``` so WA renders them
// monospace + preserves whitespace (column alignment stays intact
// across the animation).

// ── Alien landing — the showcase ──────────────────────────────
//
// Five-line nightscape; the UFO drifts diagonally in, hovers,
// kicks up dust on the ridge, an 👽 hops out, says a line (the
// --secret if provided, else a default), the UFO ascends and
// warps out, message deletes.
const _SKY = [
  '   .  ·  ✦  .   *  ·  ⋆ .',
  '  ✦   .  ·    ✦   .  *  ',
  '    .  *   ·   .   ✦   .',
  '  ·   ⋆   .  ·    *     ',
];
const _HORIZON  = '─────────────────────────';
const _DUST     = '──~~~──~──~~~~──~──~~~──~';
const _SCENERY  = ['🌲', '        🌲', '             🌲', '                  🌲'];

const _alienAt = (col, line = -1) => {
  // line: which sky row 0..3 (default last → just above horizon)
  const row = line < 0 ? _SKY.length - 1 : line;
  const target = _SKY[row].split('');
  // Replace 2 chars (UFO emoji width) at `col` with 🛸
  for (let i = 0; i < 4; i++) if (col + i < target.length) target[col + i] = i === 0 ? '🛸' : ' ';
  const out = _SKY.map((l, i) => i === row ? target.join('') : l);
  return out;
};
const _withHorizon = (skyArr, line) => [...skyArr, line ?? _HORIZON];
const _withGround = (skyArr, ground) => [...skyArr, _HORIZON, ground ?? ''];

function _buildAlienFrames(secret) {
  const dialogDefault = 'saludos terrícolas';
  const dialog = (secret ?? dialogDefault).trim().slice(0, 80) || dialogDefault;
  const frames = [];

  // Phase 1: just sky.
  frames.push(_SKY.join('\n'));

  // Phase 2: UFO drifts diagonally in from upper-right.
  frames.push(_alienAt(22, 0).join('\n'));
  frames.push(_alienAt(18, 0).join('\n'));
  frames.push(_alienAt(14, 1).join('\n'));
  frames.push(_alienAt(10, 1).join('\n'));
  frames.push(_alienAt(8,  2).join('\n'));
  frames.push(_alienAt(6,  3).join('\n'));

  // Phase 3: hover above the ridge.
  frames.push([..._alienAt(6, 3), _HORIZON].join('\n'));
  frames.push([..._alienAt(6, 3), _DUST].join('\n'));
  frames.push([..._alienAt(6, 3), _DUST].join('\n'));

  // Phase 4: 👽 hops out under the UFO; UFO holds. Dialog frame.
  const groundAlien = '      👽                 ';
  frames.push([..._alienAt(6, 3), _DUST,    groundAlien].join('\n'));
  frames.push([..._alienAt(6, 3), _HORIZON, groundAlien].join('\n'));
  frames.push([..._alienAt(6, 3), _HORIZON, groundAlien, '   "' + dialog + '"'].join('\n'));

  // Phase 5: 👽 hops back; UFO begins ascent.
  frames.push([..._alienAt(6, 3), _HORIZON, groundAlien].join('\n'));
  frames.push([..._alienAt(8, 2), _HORIZON].join('\n'));
  frames.push([..._alienAt(12, 1), _HORIZON].join('\n'));
  frames.push([..._alienAt(16, 0), _HORIZON].join('\n'));
  frames.push([..._alienAt(22, 0), _HORIZON].join('\n'));

  // Phase 6: warp-flash and back to sky.
  frames.push([..._SKY.slice(0, 1), '              ✨💫', ..._SKY.slice(2), _HORIZON].join('\n'));
  frames.push([..._SKY, _HORIZON].join('\n'));
  frames.push(_SKY.join('\n'));

  return frames;
}

const PRESETS = {
  // ── The showcase. Dynamic build with optional --secret. ──────
  alien: {
    ms: 600, monospace: true, autoDelete: true, holdMs: 2000,
    params: '[--secret "<dialog>"]',
    desc: 'UFO descends into a nightscape, 👽 emerges, delivers a line, departs',
    build: (arg) => _buildAlienFrames(arg),
  },

  // Stick figure walks across a 30-col baseline. Alternating leg
  // poses make the walk read as motion, not just translation.
  stickman: {
    ms: 350, monospace: true, autoDelete: true, holdMs: 1500,
    desc: 'stick figure walks across the panel',
    frames: (() => {
      const POSE_A = [' O ', '/|\\', '/ \\'];
      const POSE_B = [' O ', '/|\\', '| |'];
      const POSES = [POSE_A, POSE_B];
      const baseline = '═'.repeat(20);
      const out = [];
      for (let step = 0; step <= 17; step += 2) {
        const pose = POSES[(step / 2) % 2];
        out.push(pose.map(l => ' '.repeat(step) + l).join('\n') + '\n' + baseline);
      }
      return out;
    })(),
  },

  train: {
    ms: 280, monospace: true, autoDelete: true, holdMs: 1500,
    desc: 'train rolls across the panel',
    frames: (() => {
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
      for (let step = -10; step <= 36; step += 2) {
        const pose = POSES[((step + 10) / 2) % 2];
        const padded = pose.map(l => ' '.repeat(Math.max(0, step)) + l);
        out.push(padded.join('\n'));
      }
      return out;
    })(),
  },

  // ── Parametrized presets ──────────────────────────────────────
  'heart-name': {
    ms: 550, autoDelete: true, holdMs: 2500,
    params: '<name>',
    desc: 'name grows inside a swelling heart',
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
  greedy: {
    ms: 500, autoDelete: true, holdMs: 2000,
    params: '<word>',
    desc: 'word swells with money / greed emojis',
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

  // ── Single-line presets ──────────────────────────────────────
  sparkler:  { ms: 500, autoDelete: true, holdMs: 1500, desc: '· → ✨ → 🌈',
               frames: ['·', '✨', '✨💫', '🌟💫✨', '🌟💫✨💥', '🌈🌟💫✨', '🌈🌟💫', '🌈🌟', '🌈'] },
  fireworks: { ms: 600, autoDelete: true, holdMs: 1500, desc: 'silent firework',
               frames: ['·', '✨', '💥', '🎆', '🎆🎇', '🎇🎆🎇', '✨🎆🎇✨', '🌟🎇🎆🌟', '⭐'] },
  heart:     { ms: 500, autoDelete: true, holdMs: 1500, desc: 'heart pulses through shapes',
               frames: ['❤️', '💗', '💖', '💘', '💝', '💖', '💗', '❤️'] },
  fire:      { ms: 500, autoDelete: true, holdMs: 1500, desc: '· → 🔥 → 🌋',
               frames: ['·', '🔥', '🔥🔥', '🔥🔥🔥', '🔥🔥🔥🔥', '🌋', '💥🌋', '🔥'] },
  dance:     { ms: 500, autoDelete: true, holdMs: 1500, desc: 'dance party',
               frames: ['🕺', '🕺💃', '💃🕺💃', '🕺💃🕺💃', '💃🕺💃🕺💃', '🎉🕺💃🎉', '🎉🎉🎉'] },
  rainbow:   { ms: 400, autoDelete: true, holdMs: 1500, desc: 'rainbow bands → 🌈',
               frames: ['🟥', '🟥🟧', '🟥🟧🟨', '🟥🟧🟨🟩', '🟥🟧🟨🟩🟦', '🟥🟧🟨🟩🟦🟪', '🌈'] },
  loading:   { ms: 200, autoDelete: true, holdMs: 1000, desc: 'spinner → ✅',
               frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏', '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '✅'] },
  scan:      { ms: 400, autoDelete: true, holdMs: 1500, desc: 'progress bar → ✓ done',
               frames: ['▱▱▱▱▱▱▱▱', '▰▱▱▱▱▱▱▱', '▰▰▱▱▱▱▱▱', '▰▰▰▱▱▱▱▱', '▰▰▰▰▱▱▱▱', '▰▰▰▰▰▱▱▱', '▰▰▰▰▰▰▱▱', '▰▰▰▰▰▰▰▱', '▰▰▰▰▰▰▰▰', '✓ done'] },
};

export const meta = {
  cmd: '/movie',
  section: 'ROOM',
  surface: 'shell',
  usage: '/movie @waN <preset> [args] [--secret "<text>"] [--keep] [--ms N]',
  desc:
    'play an emoji / ASCII animation in a WA chat. movies auto-delete ' +
    'when finished; pass --keep to leave the final frame visible, or ' +
    '--secret "<text>" to flash a punchline before deletion. /movie ' +
    'list enumerates presets with their args.',
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
      const lhs = `${name}${p.params ? '  ' + p.params : ''}`.padEnd(28);
      const stat = (p.frames ? `${p.frames.length} fr` : 'dynamic') +
                   ` @ ${p.ms}ms` +
                   (p.monospace ? '  multi-line' : '') +
                   (p.autoDelete ? '  auto-delete' : '');
      return `  ${lhs}  — ${p.desc}\n  ${' '.repeat(28)}    ${stat}`;
    });
    sysOut(
      'movie presets (all auto-delete after the last frame unless --keep):\n\n' +
      rows.join('\n\n') +
      '\n\nglobal flags:\n' +
      '  --secret "<text>"   flash a final dialog line before deletion (alien renders this inside the scene)\n' +
      '  --keep              don\'t delete after the last frame\n' +
      '  --ms <N>            override per-frame delay (floor 80ms)\n' +
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
      // Collect quoted/unquoted secret text until next --flag.
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
    // The alien preset folds --secret directly into its scene; for
    // every other preset --secret appends a final dialog frame.
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
