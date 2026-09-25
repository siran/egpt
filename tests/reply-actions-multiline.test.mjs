// A /reply's text runs on over the lines below it (operator 2026-09-25). King Ken's quote-replies in
// Dagiely Palma arrived as one flat paragraph with "1) ... 2) ... 3)" inline, because the text of
// `/reply #<id> <text>` was the rest of ONE line; the same beings' plain messages keep their
// paragraphs and lists. The live shape below is Ken's own reply, cut down.
import { describe, it, expect } from 'vitest';
import { parseReplyActions, partialProse } from '../src/spine/reply-actions.mjs';

const ev = { surface: 'whatsapp', chatId: 'CYQ7eFSczWl1nuzQaGCX' };
const KEN = [
  '/reply #14499 Dagie, Michel dice que ya casi está todo. Falta esto:',
  '1) Conecta Proton.',
  '2) Abre Terminal y escribe claude --resume.',
  '',
  'Si al clonar sale "Repository not found", Michel tiene que darte permiso.',
].join('\n');
const KEN_TEXT = KEN.slice('/reply #14499 '.length);

describe('a /reply keeps its line breaks', () => {
  it('REPRODUCE: a /reply followed by a list is ONE quote-reply whose text keeps every line', () => {
    const { prose, run, stripped } = parseReplyActions(KEN, ev);
    expect(run).toEqual([{ type: 'reply', chatId: ev.chatId, targetId: '14499', text: KEN_TEXT }]);
    expect(prose).toBe('');
    expect(stripped).toEqual([]);
  });

  it('the text may start on the line below the target', () => {
    const { run, prose } = parseReplyActions('/reply #5\n1) uno\n2) dos', ev);
    expect(run).toEqual([{ type: 'reply', chatId: ev.chatId, targetId: '5', text: '1) uno\n2) dos' }]);
    expect(prose).toBe('');
  });

  it('it runs to the NEXT action line, and that action still runs', () => {
    const { run, prose } = parseReplyActions('/reply #5 uno\ndos\n/react #6 👍', ev);
    expect(run).toEqual([
      { type: 'reply', chatId: ev.chatId, targetId: '5', text: 'uno\ndos' },
      { type: 'react', chatId: ev.chatId, targetId: '6', emoji: '👍' },
    ]);
    expect(prose).toBe('');
  });

  it('prose BEFORE the first action is still the plain message', () => {
    const { run, prose } = parseReplyActions('Hola Dagie.\n/reply #5 uno\ndos', ev);
    expect(prose).toBe('Hola Dagie.');
    expect(run.map((a) => a.text)).toEqual(['uno\ndos']);
  });

  it('only /reply runs on: /edit and /react keep their one-line form', () => {
    const e = parseReplyActions('/edit #5 nuevo\nmás texto', ev);
    expect(e.run).toEqual([{ type: 'edit', chatId: ev.chatId, targetId: '5', text: 'nuevo' }]);
    expect(e.prose).toBe('más texto');
    expect(parseReplyActions('/react #5 👍\nfin', ev).prose).toBe('fin');
  });

  it('a redundant /reply demotes its WHOLE text to prose', () => {
    const { run, prose } = parseReplyActions('/reply #5 uno\n\ndos', ev, { quotedId: '5' });
    expect(run).toEqual([]);
    expect(prose).toBe('uno\n\ndos');
  });

  it('a malformed /reply demotes its whole text and is still logged', () => {
    const { run, prose, stripped } = parseReplyActions('/reply 1108 uno\ndos', ev);
    expect(run).toEqual([]);
    expect(prose).toBe('1108 uno\ndos');
    expect(stripped.map((s) => s.reason)).toEqual(['reply: expected "#<id> <text>"']);
  });

  it('a welded /reply opens the same multi-line text', () => {
    const { run, prose } = parseReplyActions('Listo./reply #5 uno\ndos', ev);
    expect(prose).toBe('Listo.');
    expect(run.map((a) => [a.type, a.text])).toEqual([['reply', 'uno\ndos']]);
  });

  it('a welded action inside the text ends it, and what follows is prose again', () => {
    const { run, prose } = parseReplyActions('/reply #5 uno\ndos./react #6 👍\nfin', ev);
    expect(run.map((a) => [a.type, a.text ?? a.emoji])).toEqual([['reply', 'uno\ndos.'], ['react', '👍']]);
    expect(prose).toBe('fin');
  });
});

describe('the live stream never shows a /reply\'s text', () => {
  // Every frame of the streamed placeholder: never a continuation line, never a frame that
  // shrinks (the message is append-only, so text once shown stays shown).
  const frames = (full, opts = {}) => Array.from({ length: full.length }, (_, i) => partialProse(full.slice(0, i + 1), ev, opts));
  const monotone = (fs) => fs.every((f, i) => i === 0 || f.startsWith(fs[i - 1]));

  it('continuation lines are hidden in every frame, and the frames only grow', () => {
    const fs = frames(`Hola.\n${KEN}`);
    expect(fs.every((f) => !/Conecta|Terminal|Repository|1\)/.test(f))).toBe(true);
    expect(monotone(fs)).toBe(true);
    expect(fs[fs.length - 1]).toBe('Hola.');
  });

  it('a /reply whose text starts on the next line never flashes its target', () => {
    const fs = frames('/reply #5\n1) uno\n2) dos');
    expect(fs.every((f) => !f.includes('#5'))).toBe(true);
    expect(monotone(fs)).toBe(true);
  });

  it('a redundant /reply streams as prose, growing line by line', () => {
    const fs = frames('/reply #5 uno\ndos', { quotedId: '5' });
    expect(monotone(fs)).toBe(true);
    expect(fs[fs.length - 1]).toBe('uno\ndos');
  });
});
