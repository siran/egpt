// CONFINEMENT CONTRACT for the SDK→CLI engine move (operator 2026-06-12):
// every hard-earned feature in claude-sdk.mjs buildSdkOptions must survive in the
// claude-code CLI argv. This locks the mapping so the move can't silently regress
// directory access control / tool limitation / settings isolation.
import { describe, it, expect } from 'vitest';
import { buildClaudeArgs, BASE_ARGS, FILE_TOOLS } from '../src/claude-args.mjs';

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
  it("allowedTools 'all' → bypass (trusted engineers/system-e), no sandbox isolation", () => {
    const a = buildClaudeArgs({ allowedTools: 'all' });
    expect(has(a, '--dangerously-skip-permissions')).toBe(true);
    expect(valsOf(a, '--permission-mode')).toEqual(['bypassPermissions']);
    expect(has(a, '--setting-sources')).toBe(false);     // full access — not sandboxed
    expect(has(a, '--allowedTools')).toBe(false);
  });
  it("'*' is treated the same as 'all'", () => {
    expect(valsOf(buildClaudeArgs({ allowedTools: '*' }), '--permission-mode')).toEqual(['bypassPermissions']);
  });
  it('plain allowedTools list (no sandbox) → --allowedTools, NO bypass, NO isolation', () => {
    const a = buildClaudeArgs({ allowedTools: ['Read', 'WebFetch'] });
    expect(valsOf(a, '--allowedTools')).toEqual(['Read WebFetch']);
    expect(has(a, '--dangerously-skip-permissions')).toBe(false);
    expect(has(a, '--permission-mode')).toBe(false);
    expect(has(a, '--setting-sources')).toBe(false);
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
  it('confine roots + addDirs both land in --add-dir (deduped)', () => {
    expect(addDirs(a)).toEqual(expect.arrayContaining(['/sandbox', '/extra']));
    const dd = buildClaudeArgs({ confineToDirs: ['/x'], addDirs: ['/x'] });
    expect(addDirs(dd)).toEqual(['/x']);   // deduped
  });
});

describe('read-only grants — never silently dropped', () => {
  it('readOnlyDirs THROWS (write-deny hook not yet wired for CLI — refuse to drop it)', () => {
    expect(() => buildClaudeArgs({ readOnlyDirs: ['/ro'] })).toThrow(/readOnlyDirs/);
  });
  it('empty/absent readOnlyDirs is fine', () => {
    expect(() => buildClaudeArgs({ readOnlyDirs: [] })).not.toThrow();
    expect(() => buildClaudeArgs({})).not.toThrow();
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
