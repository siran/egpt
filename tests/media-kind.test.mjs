import { describe, it, expect } from 'vitest';
import { mediaKind, MIME_BY_EXT } from '../src/media-kind.mjs';

describe('mediaKind', () => {
  it('prefers the mimetype', () => {
    expect(mediaKind('image/png', 'bin')).toBe('image');
    expect(mediaKind('video/mp4', '')).toBe('video');
    expect(mediaKind('audio/ogg', '')).toBe('audio');
    expect(mediaKind('application/pdf', '')).toBe('document');
  });
  it('falls back to the extension', () => {
    expect(mediaKind(null, 'jpg')).toBe('image');
    expect(mediaKind(undefined, 'mov')).toBe('video');
    expect(mediaKind('', 'opus')).toBe('audio');
    expect(mediaKind(null, 'xyz')).toBe('document');
  });
  it('maps common extensions to mimetypes', () => {
    expect(MIME_BY_EXT.png).toBe('image/png');
    expect(MIME_BY_EXT.pdf).toBe('application/pdf');
    expect(MIME_BY_EXT.opus).toBe('audio/ogg');
  });
});
