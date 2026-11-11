// tests/migrations-0052-the-verified-user-lives-on-the-desk.test.mjs — migrations/0052-the-verified-user-lives-on-the-desk.mjs.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan } from '../migrations/0052-the-verified-user-lives-on-the-desk.mjs';

const ctxFor = (h) => ({ egptHome: h, log: () => {} });
function home(convs) {
  const h = join(mkdtempSync(join(tmpdir(), 'egpt-0052-')), '.egpt');
  for (const [slug, files] of Object.entries(convs)) {
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(h, 'conversations', 'http', slug, ...rel.split('/').slice(0, -1)), { recursive: true });
      writeFileSync(join(h, 'conversations', 'http', slug, rel), text);
    }
  }
  return h;
}
const at = (h, slug, rel) => join(h, 'conversations', 'http', slug, rel);

describe('0052', () => {
  it('REPRODUCE: moves usuario.json/usuario.md to desktop/user.json/user.md, content intact; a re-plan is satisfied', async () => {
    const h = home({ 'a-1': { 'usuario.json': '{"short_name":"Ana"}\n', 'usuario.md': 'Usuario verificado.\n', 'transcript.md': 'x' } });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);
    expect(p.changes).toEqual(['a-1/usuario.json -> a-1/desktop/user.json', 'a-1/usuario.md -> a-1/desktop/user.md']);
    await p.apply();
    expect(readFileSync(at(h, 'a-1', 'desktop/user.json'), 'utf8')).toBe('{"short_name":"Ana"}\n');
    expect(readFileSync(at(h, 'a-1', 'desktop/user.md'), 'utf8')).toBe('Usuario verificado.\n');
    expect(existsSync(at(h, 'a-1', 'usuario.json'))).toBe(false);
    expect(existsSync(at(h, 'a-1', 'usuario.md'))).toBe(false);
    expect(readFileSync(at(h, 'a-1', 'transcript.md'), 'utf8')).toBe('x');
    expect((await plan(ctxFor(h))).satisfied).toBe(true);
  });

  it('never overwrites: a target already there stays, the old file stays, with a note; the other file still moves', async () => {
    const h = home({ 'b-1': { 'usuario.json': 'old', 'desktop/user.json': 'new', 'usuario.md': 'md' } });
    const p = await plan(ctxFor(h));
    expect(p.changes).toEqual(['b-1/usuario.md -> b-1/desktop/user.md', 'b-1/ has both usuario.json and desktop/user.json - left']);
    await p.apply();
    expect(readFileSync(at(h, 'b-1', 'desktop/user.json'), 'utf8')).toBe('new');
    expect(readFileSync(at(h, 'b-1', 'usuario.json'), 'utf8')).toBe('old');
    expect(readFileSync(at(h, 'b-1', 'desktop/user.md'), 'utf8')).toBe('md');
    const again = await plan(ctxFor(h));
    expect(again.satisfied).toBe(true);
    expect(again.notes).toEqual(['b-1/ has both usuario.json and desktop/user.json - left']);
  });

  it('satisfied, touching nothing: no http conversations, or conversations already on the desk', async () => {
    expect((await plan(ctxFor(join(mkdtempSync(join(tmpdir(), 'egpt-0052-')), '.egpt')))).satisfied).toBe(true);
    const h = home({ 'c-1': { 'desktop/user.json': '{}' }, 'c-2': { 'transcript.md': 'x' } });
    expect((await plan(ctxFor(h))).satisfied).toBe(true);
    expect(readFileSync(at(h, 'c-1', 'desktop/user.json'), 'utf8')).toBe('{}');
  });
});
