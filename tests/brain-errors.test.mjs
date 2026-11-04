import { describe, it, expect } from 'vitest';
import { isContextOverflowError, isDeadSessionError, isBrainFailureResult } from '../src/brain-errors.mjs';

describe('isContextOverflowError', () => {
  it('matches the context-overflow phrasings', () => {
    expect(isContextOverflowError('claude: error_during_execution\n  Prompt is too long')).toBe(true);
    expect(isContextOverflowError('Error: maximum context length exceeded')).toBe(true);
    expect(isContextOverflowError('the context window has been exceeded')).toBe(true);
  });

  it('does not match an unrelated message', () => {
    expect(isContextOverflowError('¡Hola hermano! Wren aquí.')).toBe(false);
  });
});

describe('isDeadSessionError', () => {
  it('matches the CLI\'s dead-session string, case-insensitively', () => {
    expect(isDeadSessionError('No conversation found with session id abc')).toBe(true);
  });

  it('does not match an unrelated message', () => {
    expect(isDeadSessionError('¡Hola hermano! Wren aquí.')).toBe(false);
  });
});

// E's reply, live 2026-10-16 17:24 (SI+Contoso), from the logged fragments: swallowed as "failure-shaped".
const E_LIVE_403 ='/reply #32886 Listo, Cuigmar. csi_n ya está en la carpeta protegida.\n'
  + 'Ahora responde 403 y no se puede abrir por web; el .htaccess quedó con:\nRequire all denied';

describe('isBrainFailureResult — the engine\'s flag, never the text', () => {
  it('a turn the engine flagged failed is a failure, whatever its text says', () => {
    expect(isBrainFailureResult({ text: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.', failed: true })).toBe(true);
    expect(isBrainFailureResult({ text: 'Listo, ya está.', failed: true })).toBe(true);
    expect(isBrainFailureResult({ text: '', failed: true })).toBe(true);
  });

  it('E\'s live reply and prose about 401/403/429, authentication, rate limits or quotas are replies', () => {
    for (const text of [
      E_LIVE_403,
      'El endpoint devuelve 401 Unauthorized si el token venció.',
      'Si ves un 429 es el rate limit de la API: espera un minuto.',
      'La authentication del panel usa el mismo usuario de siempre.',
      'Tu quota de correo está al 90%.',
    ]) expect(isBrainFailureResult({ text, sessionId: 's' }), text).toBe(false);
  });

  it('text alone is never read — not even a real CLI error string without the flag', () => {
    expect(isBrainFailureResult('Failed to authenticate. API Error: 401 OAuth access token is invalid.')).toBe(false);
    expect(isBrainFailureResult({ text: '!! spawn claude ENOENT' })).toBe(false);
    expect(isBrainFailureResult(null)).toBe(false);
  });
});
