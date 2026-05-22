import { describe, expect, it } from 'vitest';

import { createOrderedCumulativeTranscriptEmitter } from '../bridges/whatsapp.mjs';

describe('WhatsApp voice transcript edit ordering', () => {
  it('emits cumulative edits in sequence even when chunks finish out of order', async () => {
    const edits = [];
    const accept = createOrderedCumulativeTranscriptEmitter(async (text) => edits.push(text));

    await accept(2, 'starting now');
    expect(edits).toEqual([]);

    await accept(0, 'e, guess a number');
    expect(edits).toEqual(['e, guess a number']);

    await accept(1, 'from zero to nine');
    expect(edits).toEqual([
      'e, guess a number',
      'e, guess a number from zero to nine',
      'e, guess a number from zero to nine starting now',
    ]);
  });

  it('skips empty chunks without breaking ordered delivery', async () => {
    const edits = [];
    const accept = createOrderedCumulativeTranscriptEmitter(async (text) => edits.push(text));

    await accept(0, 'hello');
    await accept(1, '');
    await accept(2, 'world');

    expect(edits).toEqual(['hello', 'hello world']);
  });
});
