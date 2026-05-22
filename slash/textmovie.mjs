// slash/textmovie.mjs — feed @e a paragraph as a scrolling text "movie"
// of timestamped frames. Each frame is a sliding word window prefixed
// with [M:SS.mmm] An: — same shape voice-stream uses, but driven by a
// known text instead of by whisper output. The experiment: see if the
// brain reacts in real-time to a controlled stream and threads
// continuity across frames.
//
// Operator (2026-05-22): "simulate instead an alien use any random
// paragraph and feed it to brain like a scrolling movie... if model
// reacts to text in real time, it's at least a real time chatbot."
//
// Brain replies print to sysOut (shell). No WA bridge involved.

import { setTimeout as sleep } from 'node:timers/promises';

export const meta = {
  cmd: '/textmovie',
  section: 'BRAIN',
  surface: 'shell',
  usage: '/textmovie "<text>" [--ms N] [--window N] [--stride N]',
  desc:
    'feed @e a text paragraph as alien-style timestamped frames. Tests ' +
    'whether the brain reacts to streaming text. ' +
    'Defaults: --ms 500 --window 5 --stride 1. ' +
    'Dispatches to the system-e shared thread (same session as voice notes).',
};

function _formatTime(sec) {
  const mm = Math.floor(sec / 60);
  const ss = Math.floor(sec % 60);
  const mmm = Math.floor((sec - Math.floor(sec)) * 1000);
  return `[${mm}:${String(ss).padStart(2, '0')}.${String(mmm).padStart(3, '0')}]`;
}

export async function run({ arg, ctx }) {
  const { sysOut, computeBrainTurn } = ctx;
  if (typeof computeBrainTurn !== 'function') {
    sysOut('!! /textmovie: computeBrainTurn unavailable in this ctx');
    return true;
  }

  // Parse: quoted text + optional flags. Quotes are required so the text
  // can contain spaces without being mistaken for flag args.
  const m = arg.match(/^\s*"([^"]+)"\s*(.*)$/);
  if (!m) {
    sysOut('usage: /textmovie "<text>" [--ms N] [--window N] [--stride N]');
    return true;
  }
  const text = m[1];
  const flagStr = m[2] ?? '';
  const ms = parseInt((flagStr.match(/--ms\s+(\d+)/) ?? [])[1], 10) || 500;
  const windowWords = parseInt((flagStr.match(/--window\s+(\d+)/) ?? [])[1], 10) || 5;
  const strideWords = parseInt((flagStr.match(/--stride\s+(\d+)/) ?? [])[1], 10) || 1;

  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) { sysOut('!! /textmovie: empty text'); return true; }

  const totalFrames = Math.max(1, Math.ceil(words.length / strideWords));
  const totalSec = (totalFrames * ms) / 1000;
  sysOut(`🎬 /textmovie ${words.length}w · window ${windowWords} · stride ${strideWords} · ${ms}ms/frame · ~${totalSec.toFixed(1)}s`);

  // Dispatch through the operator's WA Self DM (system-personality, so
  // system_thread carries the conversation). Reuses the brain session
  // shared across voice notes.
  const threadCtx = { threadId: '34836563681438@lid', surface: 'wa', name: 'An (textmovie)' };

  for (let i = 0; i < totalFrames; i++) {
    const wordIdx = i * strideWords;
    const startWord = Math.max(0, wordIdx + 1 - windowWords);
    const endWord = Math.min(words.length, wordIdx + 1);
    const frame = words.slice(startWord, endWord).join(' ');
    const tSec = (i * ms) / 1000;
    const prompt = `${_formatTime(tSec)} An: ${frame}`;

    sysOut(`▶ ${prompt}`);
    let reply = '';
    try {
      reply = await computeBrainTurn('e', prompt, threadCtx);
    } catch (e) {
      sysOut(`!! /textmovie brain error: ${e?.message ?? e}`);
    }
    const trimmed = (reply ?? '').trim();
    if (trimmed && trimmed !== '...' && trimmed !== '…') {
      sysOut(`◀ ${trimmed}`);
    }

    if (i < totalFrames - 1) await sleep(ms);
  }

  sysOut(`🎬 /textmovie done`);
  return true;
}
