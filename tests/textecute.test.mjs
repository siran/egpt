// tests/textecute.test.mjs — the textecutable runner (src/tools/textecute.mjs):
// a `*.x.md` plain-text script executed by ONE fresh, stateless Claude turn in the
// script's own folder. All in-memory: a fake makeSession captures the session
// options + prompt and NEVER spawns a real claude; fake io holds the script + log.
import { describe, it, expect } from 'vitest';
import { textecute, parseArgs } from '../src/tools/textecute.mjs';

// A fake session factory: records the options it was built with, the prompt it was
// turned, and whether close() ran; replies (or throws) as configured.
function fakeSessionFactory({ reply = 'done', fail = null } = {}) {
  const rec = { opts: null, prompt: null, closed: false, turns: 0 };
  const make = (opts) => {
    rec.opts = opts;
    return {
      async turn(prompt) {
        rec.prompt = prompt;
        rec.turns++;
        if (fail) throw new Error(fail);
        return { text: reply, sessionId: 'x' };
      },
      close() { rec.closed = true; },
    };
  };
  return { make, rec };
}

// In-memory io keyed by path. appendFile concatenates (append semantics).
function fakeIo(initial = {}) {
  const files = { ...initial };
  return {
    files,
    readFile: async (p) => { if (p in files) return files[p]; const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
    appendFile: async (p, c) => { files[p] = (files[p] ?? '') + c; },
  };
}

const SCRIPT = '/work/reports/daily.x.md';
const BODY = '1. open chrome\n2. read the page\n3. save it\n';

describe('textecute — the runner', () => {
  it('builds a fresh session in the SCRIPT dir, all-tools, null session; turns the framed prompt verbatim; closes', async () => {
    const f = fakeSessionFactory({ reply: 'all four steps done' });
    const io = fakeIo({ [SCRIPT]: BODY });
    const r = await textecute(SCRIPT, { makeSession: f.make, io });

    expect(r).toEqual({ ok: true, text: 'all four steps done' });
    // session options
    expect(f.rec.opts.cwd).toBe('/work/reports');       // the script's directory
    expect(f.rec.opts.allowedTools).toBe('all');         // default trust
    expect(f.rec.opts.sessionId).toBe(null);             // stateless
    // the turned prompt = framing line + the file content VERBATIM
    expect(f.rec.prompt).toContain('This file is a TEXTECUTABLE');
    expect(f.rec.prompt).toContain("EXECUTE its steps in order using your tools, don't discuss them");
    expect(f.rec.prompt).toContain('--- daily.x.md ---');
    expect(f.rec.prompt).toContain(BODY);
    expect(f.rec.closed).toBe(true);
  });

  it('model/effort come from opts (new-config-only: no config.default_brain override)', async () => {
    const f = fakeSessionFactory();
    const io = fakeIo({ [SCRIPT]: BODY });
    await textecute(SCRIPT, { model: 'opus', effort: 'high', makeSession: f.make, io });
    expect(f.rec.opts.model).toBe('opus');
    expect(f.rec.opts.effort).toBe('high');
  });

  it('leaves model/effort undefined (login default) when opts omit them', async () => {
    const f = fakeSessionFactory();
    const io = fakeIo({ [SCRIPT]: BODY });
    await textecute(SCRIPT, { makeSession: f.make, io });
    expect(f.rec.opts.model).toBeUndefined();
    expect(f.rec.opts.effort).toBeUndefined();
  });

  it('opts.tools overrides the all-tools default', async () => {
    const f = fakeSessionFactory();
    const io = fakeIo({ [SCRIPT]: BODY });
    await textecute(SCRIPT, { tools: 'Read Bash', makeSession: f.make, io });
    expect(f.rec.opts.allowedTools).toBe('Read Bash');
  });

  it('appends a run entry next to the script: ISO header + the final text', async () => {
    const f = fakeSessionFactory({ reply: 'the reply body' });
    const io = fakeIo({ [SCRIPT]: BODY });
    await textecute(SCRIPT, { makeSession: f.make, io });
    const log = io.files[`${SCRIPT}.log`];
    expect(log).toMatch(/^--- run \d{4}-\d{2}-\d{2}T[\d:.]+Z ---\nthe reply body\n$/);
  });

  it('a turn failure logs `!! failed`, still closes, and returns { ok:false, error }', async () => {
    const f = fakeSessionFactory({ fail: 'CDP connect refused' });
    const io = fakeIo({ [SCRIPT]: BODY });
    const r = await textecute(SCRIPT, { makeSession: f.make, io });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('CDP connect refused');
    expect(f.rec.closed).toBe(true);
    expect(io.files[`${SCRIPT}.log`]).toMatch(/^--- run \S+ ---\n!! failed: CDP connect refused\n$/);
  });

  it('refuses a plain .md (not .x.md) WITHOUT spawning', async () => {
    const f = fakeSessionFactory();
    const io = fakeIo({ '/work/notes.md': 'not a script' });
    const r = await textecute('/work/notes.md', { makeSession: f.make, io });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/must end in \.x\.md/);
    expect(f.rec.opts).toBe(null);                        // never built a session
    expect(f.rec.turns).toBe(0);
  });

  it('a missing file returns { ok:false } without spawning', async () => {
    const f = fakeSessionFactory();
    const io = fakeIo();                                   // empty — SCRIPT absent
    const r = await textecute(SCRIPT, { makeSession: f.make, io });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cannot read/);
    expect(f.rec.opts).toBe(null);
    expect(f.rec.turns).toBe(0);
  });
});

describe('textecute — parseArgs', () => {
  it('takes the first positional as the path', () => {
    expect(parseArgs(['a.x.md']).path).toBe('a.x.md');
  });
  it('parses --flag value form', () => {
    expect(parseArgs(['a.x.md', '--model', 'opus', '--effort', 'high', '--tools', 'Read Bash']))
      .toEqual({ path: 'a.x.md', model: 'opus', effort: 'high', tools: 'Read Bash' });
  });
  it('parses --flag=value form', () => {
    expect(parseArgs(['--model=opus', 'a.x.md', '--tools=all']))
      .toEqual({ path: 'a.x.md', model: 'opus', tools: 'all' });
  });
  it('undefined path when no positional given', () => {
    expect(parseArgs(['--model', 'opus']).path).toBeUndefined();
  });
});
