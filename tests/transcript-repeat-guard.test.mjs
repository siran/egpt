import { describe, it, expect } from 'vitest';
import { detectRepeatLoop, flagDegenerateTranscript } from '../src/transcript-repeat-guard.mjs';

describe('transcript repeat guard', () => {
  it('detects the classic whisper single-word loop and keeps the prefix + one instance', () => {
    const garbage = 'Gracias, ' + Array(17).fill('Michelle.').join(' ');
    const r = detectRepeatLoop(garbage);
    expect(r.isLoop).toBe(true);
    expect(r.phrase).toBe('Michelle.');
    expect(r.count).toBe(17);
    const flagged = flagDegenerateTranscript(garbage);
    expect(flagged).toContain('Gracias, Michelle.');
    expect(flagged).toContain('transcription unreliable');
    expect(flagged).toContain('repeated 17×');
    // the consecutive garbage tail is collapsed — no back-to-back repeats survive
    expect(flagged).not.toContain('Michelle. Michelle.');
  });

  it('detects a multi-word phrase loop', () => {
    const garbage = Array(8).fill('thank you').join(' ');   // "thank you thank you …"
    const r = detectRepeatLoop(garbage);
    expect(r.isLoop).toBe(true);
    expect(r.phrase).toBe('thank you');
    expect(r.count).toBe(8);
  });

  it('leaves ordinary speech untouched', () => {
    const ok = 'hola, te quería preguntar si vienes mañana a la reunión o no';
    expect(detectRepeatLoop(ok).isLoop).toBe(false);
    expect(flagDegenerateTranscript(ok)).toBe(ok);
  });

  it('does not flag light emphatic repetition below the threshold', () => {
    expect(detectRepeatLoop('no no no por favor ven').isLoop).toBe(false);
    expect(flagDegenerateTranscript('no no no por favor ven')).toBe('no no no por favor ven');
  });

  it('is a no-op on empty / short input', () => {
    expect(flagDegenerateTranscript('')).toBe('');
    expect(flagDegenerateTranscript(null)).toBe(null);
    expect(flagDegenerateTranscript('ok')).toBe('ok');
  });
});
