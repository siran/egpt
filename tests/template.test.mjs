// tests/template.test.mjs — THE fill for config text templates. Each call site's variables are checked
// against TEMPLATES where its behaviour is locked: fork-command, spine-compaction, spine-heartbeat-loader.
import { describe, it, expect } from 'vitest';
import { fill, TEMPLATES } from '../src/tools/template.mjs';

describe('fill', () => {
  it('fills known variables, every occurrence; an unknown {x} stays as written', () => {
    expect(fill('/{handle} join {name}, {name}! {nmae}', { name: 'viaje', handle: 'e' })).toBe('/e join viaje, viaje! {nmae}');
  });

  it('a name may carry a dash', () => {
    expect(fill('handoffs/{agent}.{YYMMDD-HHMM}.md', { agent: 'e', 'YYMMDD-HHMM': '261021-2030' })).toBe('handoffs/e.261021-2030.md');
  });

  it('null/undefined → empty; numbers as text', () => {
    expect(fill('[{a}][{b}][{c}]', { a: null, b: undefined, c: 18 })).toBe('[][][18]');
  });

  it('a value is inserted as given: never re-filled, $ patterns kept', () => {
    expect(fill('{group}-{name}', { group: 'A {name} $& $$', name: 'n' })).toBe('A {name} $& $$-n');
  });

  it('every documented variable has a plain-words description', () => {
    for (const [key, vars] of Object.entries(TEMPLATES)) {
      for (const [v, words] of Object.entries(vars)) expect(typeof words === 'string' && words.trim(), `${key}.{${v}}`).toBeTruthy();
    }
  });
});
