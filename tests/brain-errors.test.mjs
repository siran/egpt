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

describe('isBrainFailureResult', () => {
  it('matches the tool/infra failure shapes', () => {
    expect(isBrainFailureResult('!! spawn claude ENOENT')).toBe(true);
    expect(isBrainFailureResult('[codex exit 1]')).toBe(true);
    expect(isBrainFailureResult('boom: invalid_request_error')).toBe(true);
    expect(isBrainFailureResult('rate limited: 429')).toBe(true);
  });

  it('does not match a plain reply', () => {
    expect(isBrainFailureResult('¡Hola hermano! Wren aquí.')).toBe(false);
  });
});
