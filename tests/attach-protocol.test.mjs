// Attach wire-protocol codec. NDJSON framing is the contract between the nucleus
// and every thin client, so these tests pin: round-trip, partial-chunk
// buffering (TCP splits writes anywhere), multiple frames per chunk, and
// malformed-line isolation (one bad frame must not desync the stream).
import { describe, it, expect } from 'vitest';
import { encodeFrame, createFrameDecoder, C2N, N2C, isKnownType } from '../src/attach/protocol.mjs';

describe('attach protocol codec', () => {
  it('encodes a frame to one NDJSON line and round-trips', () => {
    const line = encodeFrame({ t: C2N.INPUT, text: 'hi' });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.indexOf('\n')).toBe(line.length - 1);   // exactly one newline, at the end
    const decode = createFrameDecoder();
    expect(decode(line)).toEqual([{ t: 'input', text: 'hi' }]);
  });

  it('rejects frames without a string type on encode', () => {
    expect(() => encodeFrame({ text: 'x' })).toThrow(/\.t/);
    expect(() => encodeFrame(null)).toThrow();
  });

  it('reassembles frames split across arbitrary chunk boundaries', () => {
    const decode = createFrameDecoder();
    const full = encodeFrame({ t: N2C.ITEM, author: 'wa', body: 'hello world' });
    const mid = Math.floor(full.length / 2);
    expect(decode(full.slice(0, mid))).toEqual([]);          // partial — nothing yet
    const out = decode(full.slice(mid));
    expect(out).toEqual([{ t: 'item', author: 'wa', body: 'hello world' }]);
  });

  it('returns multiple frames delivered in one chunk and buffers a trailing partial', () => {
    const decode = createFrameDecoder();
    const a = encodeFrame({ t: 'ping' });
    const b = encodeFrame({ t: 'pong' });
    const c = encodeFrame({ t: 'sys', body: 'z' });
    const out = decode(a + b + c.slice(0, 4));               // c is incomplete
    expect(out.map(f => f.t)).toEqual(['ping', 'pong']);
    expect(decode(c.slice(4))).toEqual([{ t: 'sys', body: 'z' }]);   // c completes next feed
  });

  it('skips malformed lines via onError without desyncing good frames', () => {
    const errs = [];
    const decode = createFrameDecoder({ onError: (e, line) => errs.push([e.message, line]) });
    const good = encodeFrame({ t: 'item', body: 'ok' });
    const out = decode('not json\n' + '{"no":"type"}\n' + good);
    expect(out).toEqual([{ t: 'item', body: 'ok' }]);
    expect(errs.length).toBe(2);
    expect(errs[0][0]).toMatch(/bad frame JSON/);
    expect(errs[1][0]).toMatch(/missing string \.t/);
  });

  it('accepts Buffer chunks and tolerates blank keepalive lines', () => {
    const decode = createFrameDecoder();
    const out = decode(Buffer.from('\n\n' + encodeFrame({ t: 'pong' }), 'utf8'));
    expect(out).toEqual([{ t: 'pong' }]);
  });

  it('isKnownType recognizes both directions', () => {
    expect(isKnownType(C2N.HELLO)).toBe(true);
    expect(isKnownType(N2C.BYE)).toBe(true);
    expect(isKnownType('nonsense')).toBe(false);
  });
});
