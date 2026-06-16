import { describe, it, expect } from 'vitest';
import { buildWhisperArgs, wavDurationSec } from '../src/tools/transcribe.mjs';

describe('buildWhisperArgs — whisper-native anti-repetition', () => {
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
