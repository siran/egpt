import { describe, it, expect } from 'vitest';
import { registrySurface } from '../dispatch.mjs';

// registrySurface decides whether a thread is a per-contact WA/TG conversation
// (→ gets its OWN slug folder + transcript) or unrouted. A null result sends the
// chat to the _unrouted catch-all instead of its own transcript.md — which is
// how every Beeper chat silently lost its per-chat transcript when the transport
// moved from baileys (JIDs carry '@') to Beeper ('!room:beeper.local', no '@').
// Transcripts are first-class: every WA chat MUST resolve to a real surface.
describe('registrySurface — every WA chat resolves to a surface (transcript invariant)', () => {
  it('Beeper room ids (no @) resolve to whatsapp', () => {
    expect(registrySurface({ threadId: '!6ljZJkx0OaY9ZVhEzFgi:beeper.local' })).toBe('whatsapp');
    expect(registrySurface({ threadId: '!yz3kJjWXsQJofK9naaVb:beeper.local', surface: 'beeper' })).toBe('whatsapp');
  });

  it('baileys JIDs still resolve to whatsapp', () => {
    expect(registrySurface({ threadId: '120363@g.us' })).toBe('whatsapp');
    expect(registrySurface({ threadId: '16468217865@s.whatsapp.net' })).toBe('whatsapp');
  });

  it('explicit surface labels win', () => {
    expect(registrySurface({ surface: 'wa', threadId: 'whatever' })).toBe('whatsapp');
    expect(registrySurface({ surface: 'tg', threadId: 'x' })).toBe('telegram');
    expect(registrySurface({ surface: 'telegram', threadId: 'x' })).toBe('telegram');
    expect(registrySurface({ surface: 'gmail', threadId: '18d3f' })).toBe('gmail');
  });

  it('non-chat / system threads stay null (→ not per-contact)', () => {
    expect(registrySurface({ threadId: 'heartbeat' })).toBe(null);
    expect(registrySurface({ threadId: 'shell' })).toBe(null);
    expect(registrySurface({})).toBe(null);
  });
});
