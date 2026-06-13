// Locks the transcript front-matter contract (operator 2026-06-13): a transcript
// opens with a YAML block { name, thread_id, surface, slug, persona, notes, … },
// and any reader must be able to strip it cleanly so front-matter keys never
// reach a model as conversation turns. renderFrontMatter ⟷ stripFrontMatter.
import { describe, it, expect } from 'vitest';
import { renderFrontMatter, stripFrontMatter } from '../src/transcript-meta.mjs';

describe('renderFrontMatter', () => {
  it('fences the block, emits populated fields, always emits a notes slot', () => {
    const fm = renderFrontMatter({ name: 'morgan', surface: 'tg', slug: 'morgan', thread_id: '120da173', persona: 'e' });
    expect(fm.startsWith('---\n')).toBe(true);
    expect(fm.trimEnd().endsWith('---')).toBe(true);
    expect(fm).toContain('name: morgan');
    expect(fm).toContain('surface: tg');
    expect(fm).toContain('thread_id: 120da173');
    expect(fm).toContain('persona: e');
    expect(fm).toMatch(/\nnotes:\s*\n/);     // empty editable slot
    expect(fm.endsWith('\n\n')).toBe(true);   // trailing blank line before turns
  });

  it('omits empty/absent fields (collector fills them later)', () => {
    const fm = renderFrontMatter({ name: 'x', phone: '', network: undefined });
    expect(fm).not.toContain('phone:');
    expect(fm).not.toContain('network:');
  });

  it('renders a group roster as a YAML inline list', () => {
    const fm = renderFrontMatter({ name: 'crew', type: 'group', participants: ['ana', 'me'] });
    expect(fm).toContain('type: group');
    expect(fm).toContain('participants: [ana, me]');
  });
});

describe('stripFrontMatter', () => {
  it('removes the block and the blank lines after it', () => {
    const fm = renderFrontMatter({ name: 'morgan', surface: 'tg' });
    expect(stripFrontMatter(fm + 'first turn\n\nsecond')).toBe('first turn\n\nsecond');
  });

  it('leaves a transcript with no front matter untouched (legacy header)', () => {
    const legacy = '# @e conversation — morgan\n\nthread: 120da173  ·  surface: tg\n\nhola';
    expect(stripFrontMatter(legacy)).toBe(legacy);
  });

  it('is a no-op on plain text and tolerates an unterminated fence', () => {
    expect(stripFrontMatter('just turns')).toBe('just turns');
    expect(stripFrontMatter('---\nname: x\nno close')).toBe('---\nname: x\nno close');
  });

  it('round-trips: render then strip yields just the body', () => {
    const body = '[An (12:00)]: hi\n\n[@e (12:01)]: hey';
    expect(stripFrontMatter(renderFrontMatter({ name: 'a', persona: 'e' }) + body)).toBe(body);
  });
});
