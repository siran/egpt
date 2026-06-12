// CONTRACT C2 — incoming media is saved to the chat's media/ folder with a
// meaningful name + a caption sidecar + an index line. These pure helpers are
// what the beeper-bridge end-to-end test (onMedia is called, not dropped)
// builds on; locking them here keeps the shape from drifting.
import { describe, it, expect } from 'vitest';
import { extFromMeta, shouldDownload, mediaFileName, mediaIndexLine } from '../src/media-save.mjs';

const TS = Date.UTC(2026, 5, 11, 17, 21, 9); // 2026-06-11 17:21:09 UTC

describe('extFromMeta', () => {
  it('prefers the original fileName extension', () => {
    expect(extFromMeta({ fileName: 'reporte.PDF', mime: 'image/png' })).toBe('pdf');
  });
  it('falls back to the mimetype, then a kind default', () => {
    expect(extFromMeta({ mime: 'image/png' })).toBe('png');
    expect(extFromMeta({ mime: 'audio/ogg' })).toBe('ogg');
    expect(extFromMeta({ kind: 'video' })).toBe('mp4');          // no name, no mime
    expect(extFromMeta({})).toBe('bin');                          // unknown → document default
  });
});

describe('shouldDownload — whatsapp.media.download policy', () => {
  it('off saves nothing', () => {
    for (const k of ['image', 'video', 'audio', 'document']) expect(shouldDownload('off', k)).toBe(false);
  });
  it('images_docs saves only image + document', () => {
    expect(shouldDownload('images_docs', 'image')).toBe(true);
    expect(shouldDownload('images_docs', 'document')).toBe(true);
    expect(shouldDownload('images_docs', 'audio')).toBe(false);
    expect(shouldDownload('images_docs', 'video')).toBe(false);
  });
  it('all (and unknown/undefined) saves everything', () => {
    for (const k of ['image', 'video', 'audio', 'document']) {
      expect(shouldDownload('all', k)).toBe(true);
      expect(shouldDownload(undefined, k)).toBe(true);
    }
  });
});

describe('mediaFileName', () => {
  it('is <YYYYMMDD-HHMMSS>-<sender>-<kind>-<msgId>.<ext>', () => {
    expect(mediaFileName({ ts: TS, senderName: 'An', kind: 'audio', msgId: 488, mime: 'audio/ogg' }))
      .toBe('20260611-172109-an-audio-488.ogg');
  });
  it('sanitizes sender + omits a missing msgId; ext from fileName', () => {
    expect(mediaFileName({ ts: TS, senderName: 'María José', kind: 'document', fileName: 'Acta Final.pdf' }))
      .toBe('20260611-172109-mar-a-jos-document.pdf');
  });
  it('infers kind/ext from mime when kind is absent', () => {
    expect(mediaFileName({ ts: TS, senderName: 'Bea', msgId: 'm1', mime: 'image/jpeg' }))
      .toBe('20260611-172109-bea-image-m1.jpg');
  });
});

describe('mediaIndexLine', () => {
  it('links the saved file and appends the caption when present', () => {
    expect(mediaIndexLine({ ts: TS, senderName: 'An', kind: 'audio', savedName: '20260611-172109-an-audio-488.ogg', caption: 'hola\n  que tal' }))
      .toBe('- 2026-06-11 17:21 · An · audio · [20260611-172109-an-audio-488.ogg](20260611-172109-an-audio-488.ogg) — hola que tal\n');
  });
  it('no caption → no trailing dash', () => {
    expect(mediaIndexLine({ ts: TS, senderName: 'An', kind: 'image', savedName: 'x.png' }))
      .toBe('- 2026-06-11 17:21 · An · image · [x.png](x.png)\n');
  });
});
