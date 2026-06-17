import { describe, it, expect } from 'vitest';
import { pickFrameTimestamps, ffprobeFromFfmpeg } from '../src/video-frames.mjs';

describe('pickFrameTimestamps — evenly spaced, avoid start/end', () => {
  it('count=3 over 40s → quarters (10,20,30)', () => {
    expect(pickFrameTimestamps(40, 3)).toEqual([10, 20, 30]);
  });
  it('count=1 → the midpoint', () => {
    expect(pickFrameTimestamps(40, 1)).toEqual([20]);
  });
  it('unknown / zero duration → a single early frame', () => {
    expect(pickFrameTimestamps(0, 3)).toEqual([1]);
    expect(pickFrameTimestamps(null, 3)).toEqual([1]);
    expect(pickFrameTimestamps(NaN, 3)).toEqual([1]);
  });
  it('clamps count to >= 1', () => {
    expect(pickFrameTimestamps(40, 0)).toEqual([20]);
  });
});

describe('ffprobeFromFfmpeg — derive the sibling binary', () => {
  it('derives ffprobe from an ffmpeg path (with + without .exe)', () => {
    expect(ffprobeFromFfmpeg('C:\\ffmpeg\\bin\\ffmpeg.exe')).toBe('C:\\ffmpeg\\bin\\ffprobe.exe');
    expect(ffprobeFromFfmpeg('/usr/bin/ffmpeg')).toBe('/usr/bin/ffprobe');
    expect(ffprobeFromFfmpeg('ffmpeg')).toBe('ffprobe');
  });
});
