// CONFINEMENT CONTRACT for the SDK→CLI engine move (operator 2026-06-12):
// every hard-earned feature in claude-sdk.mjs buildSdkOptions must survive in the
// claude-code CLI argv. This locks the mapping so the move can't silently regress
// directory access control / tool limitation / settings isolation.
import { describe, it, expect } from 'vitest';
import { buildClaudeArgs, BASE_ARGS, FILE_TOOLS, WRITE_TOOLS, readOnlyDenyRules, DEFAULT_ALLOWED_TOOLS } from '../src/claude-args.mjs';

// argv is flat: ['--flag','val','--flag2', ...]. Helpers to read it.
const valsOf = (args, flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
const has = (args, flag) => args.includes(flag);
const addDirs = (args) => valsOf(args, '--add-dir');

describe('buildClaudeArgs — base + thinking stream', () => {
  it('always headless + stream-json (carries the thinking stream)', () => {
    const a = buildClaudeArgs({});
    for (const f of BASE_ARGS) expect(a).toContain(f);
    expect(valsOf(a, '--output-format')).toEqual(['stream-json']);
  });
});

describe('tool limitation + trusted access', () => {
  it("allowedTools 'all' is REJECTED — NO bypass, coerced to the explicit default list (operator 2026-07-03)", () => {
    const a = buildClaudeArgs({ allowedTools: 'all' });
    // No escape hatches at all: no skip-permissions, no bypassPermissions.
    expect(has(a, '--dangerously-skip-permissions')).toBe(false);
    expect(valsOf(a, '--permission-mode')).not.toContain('bypassPermissions');
    // Coerced to DEFAULT_ALLOWED_TOOLS (unconfined → allow-listed as the safe 8).
    expect(valsOf(a, '--allowedTools')).toEqual([DEFAULT_ALLOWED_TOOLS.join(' ')]);
    expect(has(a, '--disallowedTools')).toBe(false);   // no bare Bash/Agent to disallow — they're just not in the list
  });
  it("'*' is rejected the same as 'all'", () => {
    expect(valsOf(buildClaudeArgs({ allowedTools: '*' }), '--allowedTools')).toEqual([DEFAULT_ALLOWED_TOOLS.join(' ')]);
    expect(has(buildClaudeArgs({ allowedTools: '*' }), '--dangerously-skip-permissions')).toBe(false);
  });
  it("'all'/'*' NEVER grant bare Bash or Agent — the coerced list contains neither", () => {
    for (const at of ['all', '*']) {
      const allow = valsOf(buildClaudeArgs({ allowedTools: at }), '--allowedTools')[0].split(' ');
      expect(allow).not.toContain('Bash');
      expect(allow).not.toContain('Agent');
    }
  });
  it('plain allowedTools list (no sandbox) → --allowedTools, NO bypass, NO isolation, NO --disallowedTools', () => {
    const a = buildClaudeArgs({ allowedTools: ['Read', 'WebFetch'] });
    expect(valsOf(a, '--allowedTools')).toEqual(['Read WebFetch']);
    expect(has(a, '--dangerously-skip-permissions')).toBe(false);
    expect(has(a, '--permission-mode')).toBe(false);
    expect(has(a, '--setting-sources')).toBe(false);
    expect(has(a, '--disallowedTools')).toBe(false);   // a LIST is already fail-closed
  });
  it('an explicit list containing a scoped Bash(git:*) keeps working, no --disallowedTools added', () => {
    const a = buildClaudeArgs({ allowedTools: ['Read', 'Bash(git:*)'] });
    expect(valsOf(a, '--allowedTools')).toEqual(['Read Bash(git:*)']);
    expect(has(a, '--disallowedTools')).toBe(false);
  });
});

describe('sandbox (confineToDirs) — directory access control + settings isolation', () => {
  const a = buildClaudeArgs({
    allowedTools: ['Read', 'Grep', 'WebFetch', 'Bash'],
    confineToDirs: ['/sandbox'],
    addDirs: ['/extra'],
  });
  it('does NOT inherit ~/.claude bypass (the Read-leak fix)', () => {
    expect(valsOf(a, '--setting-sources')).toEqual(['']);   // settingSources:[]
  });
  it('engine enforces (permission-mode default, NOT bypass)', () => {
    expect(valsOf(a, '--permission-mode')).toEqual(['default']);
    expect(has(a, '--dangerously-skip-permissions')).toBe(false);
  });
  it('file tools are NOT pre-approved (stay path-confined); non-file tools are', () => {
    const allow = valsOf(a, '--allowedTools')[0].split(' ');
    expect(allow).toContain('WebFetch');
    expect(allow).toContain('Bash');
    for (const ft of ['Read', 'Grep']) expect(allow).not.toContain(ft);   // path-confined, not allow-listed
  });
  it('Route B: scoped Bash rules (Bash(ffmpeg:*)) pass through pre-approved', () => {
    const b = buildClaudeArgs({
      allowedTools: ['Read', 'WebSearch', 'Bash(ffmpeg:*)', 'Bash(yt-dlp:*)'],
      confineToDirs: ['/sandbox'],
    });
    const allow = valsOf(b, '--allowedTools')[0].split(' ');
    expect(allow).toContain('Bash(ffmpeg:*)');
    expect(allow).toContain('Bash(yt-dlp:*)');
    expect(allow).toContain('WebSearch');
    expect(allow).not.toContain('Read');   // file tool stays path-confined
  });
  it('confine roots + addDirs both land in --add-dir (deduped)', () => {
    expect(addDirs(a)).toEqual(expect.arrayContaining(['/sandbox', '/extra']));
    const dd = buildClaudeArgs({ confineToDirs: ['/x'], addDirs: ['/x'] });
    expect(addDirs(dd)).toEqual(['/x']);   // deduped
  });
});

describe('read-only grants — NATIVE deny rules (Claude permissions, not a hook)', () => {
  it('readOnlyDenyRules: write-class tools denied under each dir; reads untouched', () => {
    const rules = readOnlyDenyRules(['/ro', 'C:\\proj\\vendor\\']);   // real Windows path
    // every write tool × every dir, glob-normalized, trailing slash stripped
    for (const t of WRITE_TOOLS) {
      expect(rules).toContain(`${t}(/ro/**)`);
      expect(rules).toContain(`${t}(C:/proj/vendor/**)`);
    }
    expect(rules.some((r) => /^Read\(/.test(r))).toBe(false);   // reads never denied
    expect(rules.length).toBe(WRITE_TOOLS.length * 2);
  });
  it('buildClaudeArgs emits --settings permissions.deny + keeps the dir READABLE (--add-dir)', () => {
    const a = buildClaudeArgs({ readOnlyDirs: ['/ro'] });
    expect(valsOf(a, '--add-dir')).toContain('/ro');             // reads work
    const settings = JSON.parse(valsOf(a, '--settings')[0]);
    expect(settings.permissions.deny).toEqual(readOnlyDenyRules(['/ro']));
    expect(settings.permissions.deny).toContain('Write(/ro/**)');
  });
  it('--settings deny holds INSIDE the sandbox (loads even with --setting-sources "")', () => {
    const a = buildClaudeArgs({ readOnlyDirs: ['/ro'], confineToDirs: ['/sb'], allowedTools: ['Read'] });
    expect(valsOf(a, '--setting-sources')).toEqual(['']);        // no ~/.claude inherit
    expect(a).toContain('--settings');                          // RO deny still applied
  });
  it('absent/empty readOnlyDirs → no --settings, no throw', () => {
    expect(() => buildClaudeArgs({})).not.toThrow();
    expect(buildClaudeArgs({ readOnlyDirs: [] })).not.toContain('--settings');
  });
});

describe('passthrough: model, effort, resume, append-system-prompt, add-dir', () => {
  it('maps each option to its flag', () => {
    const a = buildClaudeArgs({
      model: 'opus', effort: 'xhigh', sessionId: 'sess-123',
      appendSystemPrompt: 'be terse', addDirs: ['/a', '/b'],
    });
    expect(valsOf(a, '--model')).toEqual(['opus']);
    expect(valsOf(a, '--effort')).toEqual(['xhigh']);       // the lever the SDK can't set
    expect(valsOf(a, '--resume')).toEqual(['sess-123']);
    expect(valsOf(a, '--append-system-prompt')).toEqual(['be terse']);
    expect(addDirs(a)).toEqual(['/a', '/b']);
  });
  it('drops empty/whitespace values', () => {
    const a = buildClaudeArgs({ model: '  ', effort: '', addDirs: ['', null, '/ok'] });
    expect(has(a, '--model')).toBe(false);
    expect(has(a, '--effort')).toBe(false);
    expect(addDirs(a)).toEqual(['/ok']);
  });
});

describe('FILE_TOOLS sanity', () => {
  it('covers the write/read-class tools', () => {
    for (const t of ['read', 'write', 'edit', 'glob', 'grep']) expect(FILE_TOOLS.has(t)).toBe(true);
    expect(FILE_TOOLS.has('webfetch')).toBe(false);
  });
});
