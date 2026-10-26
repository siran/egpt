import { describe, it, expect } from 'vitest';
import { buildWhisperArgs, wavDurationSec, audioCtxFor } from '../src/tools/transcribe.mjs';

describe('buildWhisperArgs — whisper-native anti-repetition', () => {
  // contract 9.3
  it('includes -mc 0 and -sns by default (whisper owns the loop)', () => {
    const a = buildWhisperArgs({ model: 'm.bin', wav: 'a.wav', language: 'es' });
    expect(a).toEqual(['-m', 'm.bin', '-nt', '-f', 'a.wav', '-l', 'es', '-mc', '0', '-sns']);
  });

  it('anti_repetition:false opts out', () => {
    const a = buildWhisperArgs({ model: 'm.bin', wav: 'a.wav', anti_repetition: false });
    expect(a).toEqual(['-m', 'm.bin', '-nt', '-f', 'a.wav']);
  });

  it('extra_args come AFTER the defaults so they override (last value wins)', () => {
    const a = buildWhisperArgs({ model: 'm.bin', wav: 'a.wav', extra_args: ['-mc', '5'] });
    expect(a).toEqual(['-m', 'm.bin', '-nt', '-f', 'a.wav', '-mc', '0', '-sns', '-mc', '5']);
  });
});

describe('buildWhisperArgs — audio_ctx: auto sizes the encoder window to the note', () => {
  const base = ['-m', 'm.bin', '-nt', '-f', 'a.wav', '-mc', '0', '-sns'];
  const auto = (durationSec, extra = {}) => buildWhisperArgs({ model: 'm.bin', wav: 'a.wav', audio_ctx: 'auto', durationSec, ...extra });

  it('ceil((d + 2) * 50 / 64) * 64, never under 512 — 10.5 s → 640; 5.5 s and 2 s → 512', () => {
    expect(auto(10.5)).toEqual([...base, '-ac', '640']);
    expect(auto(5.5)).toEqual([...base, '-ac', '512']);
    expect(auto(2)).toEqual([...base, '-ac', '512']);
  });

  it('no -ac once N reaches 1500 (28 s+) — long audio keeps the full window', () => {
    expect(auto(28)).toEqual(base);
    expect(auto(60)).toEqual(base);
  });

  it('audio_ctx absent → argv unchanged, whatever the duration', () => {
    expect(buildWhisperArgs({ model: 'm.bin', wav: 'a.wav', durationSec: 5.5 })).toEqual(base);
  });

  it('auto without a usable duration (missing / 0 / NaN) → no -ac', () => {
    expect(auto(undefined)).toEqual(base);
    expect(auto(0)).toEqual(base);
    expect(auto(NaN)).toEqual(base);
  });

  it('extra_args still come last, so they override -ac', () => {
    expect(auto(5.5, { extra_args: ['-ac', '768'] })).toEqual([...base, '-ac', '512', '-ac', '768']);
  });
});

describe('audioCtxFor — the one sizing rule (cli -ac, server audio_ctx)', () => {
  it('512 floor, multiples of 64, null at 1500+ or without a usable duration', () => {
    expect(audioCtxFor(4.5)).toBe(512);
    expect(audioCtxFor(10.5)).toBe(640);
    expect(audioCtxFor(22.5)).toBe(1280);
    expect(audioCtxFor(28)).toBeNull();
    expect(audioCtxFor(0)).toBeNull();
    expect(audioCtxFor(NaN)).toBeNull();
    expect(audioCtxFor(undefined)).toBeNull();
  });
});

describe('wavDurationSec — exact from the ffmpeg WAV', () => {
  it('computes seconds from a 16kHz mono s16le byte length', () => {
    expect(wavDurationSec(44 + 32000)).toBe(1);          // 1 second of audio
    expect(wavDurationSec(44 + 32000 * 8)).toBe(8);      // 8 seconds
  });

  it('clamps tiny/garbage sizes to 0 (never negative)', () => {
    expect(wavDurationSec(10)).toBe(0);
    expect(wavDurationSec(0)).toBe(0);
  });
});
