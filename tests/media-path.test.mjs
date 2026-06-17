import { describe, it, expect } from 'vitest';
import { relMediaPath } from '../src/media-path.mjs';

describe('relMediaPath — saved paths surface relative to the conversation folder', () => {
  it('collapses an absolute Windows host path to media/<name>', () => {
    expect(
      relMediaPath('C:\\Users\\an\\.egpt\\conversations\\whatsapp\\HFM-2606112207\\media\\20260617-120623-video-142664.mp4'),
    ).toBe('media/20260617-120623-video-142664.mp4');
  });

  it('collapses an absolute POSIX path to media/<name>', () => {
    expect(relMediaPath('/m/clip-frame-01.jpg')).toBe('media/clip-frame-01.jpg');
  });

  it('never leaks the absolute host prefix', () => {
    const out = relMediaPath('C:\\Users\\an\\.egpt\\conversations\\x\\media\\foo.jpg');
    expect(out).not.toContain('C:\\');
    expect(out).not.toContain('.egpt');
  });

  it('is idempotent on an already-relative media/<name>', () => {
    expect(relMediaPath('media/foo.jpg')).toBe('media/foo.jpg');
  });

  it('handles a bare filename', () => {
    expect(relMediaPath('foo.mp4')).toBe('media/foo.mp4');
  });

  it('is null/undefined-safe', () => {
    expect(relMediaPath(null)).toBe('media/');
    expect(relMediaPath(undefined)).toBe('media/');
  });
});
