import { describe, it, expect } from 'vitest';
import { cleanForSpeech } from '../src/speech-clean.mjs';

describe('cleanForSpeech (@ev voice-out text prep)', () => {
  it('strips bold/italic/strike/code markers', () => {
    expect(cleanForSpeech('**bold** *italic* ~~gone~~ `code`')).toBe('bold italic gone code');
    expect(cleanForSpeech('__bold__ _italic_')).toBe('bold italic');
  });

  it('turns links into their text, drops images', () => {
    expect(cleanForSpeech('mira [esto](https://x.com/p)')).toBe('mira esto');
    expect(cleanForSpeech('![alt](https://x.com/i.png) resto')).toBe('resto');
  });

  it('strips headings, blockquotes, and list markers', () => {
    expect(cleanForSpeech('# Título\ntexto')).toBe('Título\ntexto');
    expect(cleanForSpeech('> cita')).toBe('cita');
    expect(cleanForSpeech('- uno\n- dos\n1. tres')).toBe('uno\ndos\ntres');
  });

  it('drops a trailing Sources section entirely', () => {
    expect(cleanForSpeech('la respuesta es 42\n\nSources:\n- https://a.com\n- https://b.com')).toBe('la respuesta es 42');
    expect(cleanForSpeech('respuesta\n\n**Sources:**\n1. https://a.com')).toBe('respuesta');
    expect(cleanForSpeech('respuesta\n\nReferences:\nfoo')).toBe('respuesta');
  });

  it('is a no-op on plain prose', () => {
    expect(cleanForSpeech('hola mundo, ¿cómo estás?')).toBe('hola mundo, ¿cómo estás?');
  });

  it('returns empty for null/undefined/empty', () => {
    expect(cleanForSpeech(null)).toBe('');
    expect(cleanForSpeech(undefined)).toBe('');
    expect(cleanForSpeech('')).toBe('');
  });
});
