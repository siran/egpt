// tests/radio-relay.test.mjs — src/radio-relay.mjs: the station uploader (PUT
// <endpoint>/host/relay/<speaker>/<filename>) + its two pure helpers. `fetch` is always
// injected — this suite must NEVER touch radio.wildnloyal.org. `sleep` is injected too so
// the retry/backoff tests run instantly (no real timers).
import { describe, it, expect, vi } from 'vitest';
import { uploadNote, radioNoteFilename, pickSpeaker, MAX_UPLOAD_BYTES } from '../src/radio-relay.mjs';

const radio = { endpoint: 'https://radio.wildnloyal.org', relay_user: 'egpt', relay_password: 'shh' };
const noSleep = async () => {};   // instant backoff — the retry tests must not actually wait

describe('uploadNote — THE LOCK: transport failure then success must air (retry works)', () => {
  it('a fetch REJECTION (transport failure — the live "curl 000" case) followed by a 201 succeeds', async () => {
    const calls = [];
    const fetchFn = vi.fn(async (url, opts) => {
      calls.push({ url, opts });
      if (calls.length === 1) throw new Error('ECONNRESET');
      return { status: 201 };
    });
    const onLog = vi.fn();
    const result = await uploadNote({ radio, speaker: 'roger', filename: 'note.ogg', bytes: Buffer.from('x'), fetch: fetchFn, sleep: noSleep, onLog });
    expect(result).toEqual({ ok: true, status: 201 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    // both attempts hit the SAME URL/auth — a retry is not a different request
    expect(calls[0].url).toBe(calls[1].url);
    expect(calls[0].url).toBe('https://radio.wildnloyal.org/host/relay/roger/note.ogg');
    expect(calls[0].opts.headers.Authorization).toBe(`Basic ${Buffer.from('egpt:shh').toString('base64')}`);
  });
});

describe('uploadNote — THE LOCK: a 404 must NOT be retried', () => {
  it('one 404 call, no retry, distinctly reported', async () => {
    const fetchFn = vi.fn(async () => ({ status: 404 }));
    const onLog = vi.fn();
    const result = await uploadNote({ radio, speaker: 'roger', filename: 'note.ogg', bytes: Buffer.from('x'), fetch: fetchFn, sleep: noSleep, onLog });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(onLog.mock.calls.some(([m]) => m.includes('404') && m.includes('not been minted'))).toBe(true);
  });
});

describe('uploadNote — 5xx is retried, then given up on', () => {
  it('a persistent 503 is retried up to maxAttempts, then gives up', async () => {
    const fetchFn = vi.fn(async () => ({ status: 503 }));
    const onLog = vi.fn();
    const result = await uploadNote({ radio, speaker: 'roger', filename: 'note.ogg', bytes: Buffer.from('x'), fetch: fetchFn, sleep: noSleep, onLog, maxAttempts: 3 });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(onLog.mock.calls.some(([m]) => m.includes('gave up after 3 attempts'))).toBe(true);
  });

  it('a transport failure that never recovers is retried up to maxAttempts, then gives up', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('ETIMEDOUT'); });
    const result = await uploadNote({ radio, speaker: 'roger', filename: 'note.ogg', bytes: Buffer.from('x'), fetch: fetchFn, sleep: noSleep, maxAttempts: 3 });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ ok: false, error: 'transport' });
  });
});

describe('uploadNote — 401/403/413/415 are NOT retried and each is reported distinctly', () => {
  const cases = [401, 403, 413, 415];
  for (const status of cases) {
    it(`status ${status}: one call, permanent, distinct log`, async () => {
      const fetchFn = vi.fn(async () => ({ status }));
      const onLog = vi.fn();
      const result = await uploadNote({ radio, speaker: 'roger', filename: 'note.ogg', bytes: Buffer.from('x'), fetch: fetchFn, sleep: noSleep, onLog });
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(false);
      expect(result.status).toBe(status);
    });
  }

  it('every one of the four permanent codes produces a DIFFERENT log message — none read the same', async () => {
    const messages = [];
    for (const status of cases) {
      const fetchFn = vi.fn(async () => ({ status }));
      const onLog = (m) => messages.push(m);
      await uploadNote({ radio, speaker: 'roger', filename: 'note.ogg', bytes: Buffer.from('x'), fetch: fetchFn, sleep: noSleep, onLog });
    }
    expect(new Set(messages).size).toBe(cases.length);   // no two permanent codes share a message
  });
});

describe('uploadNote — the size guard refuses BEFORE any fetch', () => {
  it('bytes over the 16MB cap never reach fetch', async () => {
    const fetchFn = vi.fn();
    const bytes = Buffer.alloc(MAX_UPLOAD_BYTES + 1);
    const result = await uploadNote({ radio, speaker: 'roger', filename: 'note.ogg', bytes, fetch: fetchFn, sleep: noSleep });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, error: 'too-large' });
  });

  it('exactly at the cap is fine (only OVER refuses)', async () => {
    const fetchFn = vi.fn(async () => ({ status: 201 }));
    const bytes = Buffer.alloc(MAX_UPLOAD_BYTES);
    const result = await uploadNote({ radio, speaker: 'roger', filename: 'note.ogg', bytes, fetch: fetchFn, sleep: noSleep });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });
});

describe('radioNoteFilename — ISO-timestamped, keeps the source extension', () => {
  it('renders the exact ISO shape from the spec, dashed, plus a short suffix and the given ext', () => {
    const name = radioNoteFilename(new Date('2026-08-08T17:51:32.000Z'), 'ogg', () => 0.123456789);
    expect(name).toMatch(/^2026-08-08T17-51-32-000Z-[0-9a-z]{6}\.ogg$/);
  });

  it('keeps whatever extension it is handed — opus, m4a, wav, … — never normalises it', () => {
    for (const ext of ['webm', 'ogg', 'oga', 'opus', 'mp3', 'm4a', 'wav']) {
      expect(radioNoteFilename(Date.now(), ext)).toMatch(new RegExp(`\\.${ext}$`));
    }
  });

  it('two notes in the same second get different filenames (the random suffix)', () => {
    const t = new Date('2026-08-08T17:51:32.000Z');
    const a = radioNoteFilename(t, 'ogg', () => 0.111111);
    const b = radioNoteFilename(t, 'ogg', () => 0.999999);
    expect(a).not.toBe(b);
  });
});

describe('pickSpeaker — sender id -> station speaker, via radio.hosts, falling back to default_speaker', () => {
  it('a mapped sender resolves to its host name', () => {
    expect(pickSpeaker({ '16468217865': 'roger' }, '16468217865', 'egpt')).toBe('roger');
  });
  it('an unmapped sender falls back to default_speaker', () => {
    expect(pickSpeaker({ '16468217865': 'roger' }, '99999', 'egpt')).toBe('egpt');
  });
  it('neither a mapping nor a default_speaker -> null', () => {
    expect(pickSpeaker({}, '99999', undefined)).toBeNull();
  });
  it('a malformed hosts value (not an object) is tolerated, falling back to default_speaker', () => {
    expect(pickSpeaker(null, '99999', 'egpt')).toBe('egpt');
    expect(pickSpeaker(['not', 'a', 'map'], '99999', 'egpt')).toBe('egpt');
  });
});
