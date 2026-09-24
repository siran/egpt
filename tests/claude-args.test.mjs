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

describe('dangerouslySkipPermissions:true — the actual bypass (operator 2026-08-17: "make access_level: all finally mean what it says")', () => {
  it('options.dangerouslySkipPermissions === true → BOTH --dangerously-skip-permissions and --permission-mode bypassPermissions, alongside the unconfined --allowedTools push (unchanged)', () => {
    const a = buildClaudeArgs({ dangerouslySkipPermissions: true, allowedTools: ['Read', 'Write', 'Bash', 'Agent'] });
    expect(has(a, '--dangerously-skip-permissions')).toBe(true);
    expect(valsOf(a, '--permission-mode')).toEqual(['bypassPermissions']);
    expect(valsOf(a, '--allowedTools')).toEqual(['Read Write Bash Agent']);   // unchanged: verbatim, in addition to the bypass
  });
  it('options.dangerouslySkipPermissions absent/false → neither flag, for every case this file already covers (regression)', () => {
    for (const opts of [{}, { dangerouslySkipPermissions: false }, { dangerouslySkipPermissions: false, allowedTools: ['Read'] }, { allowedTools: 'all' }]) {
      const a = buildClaudeArgs(opts);
      expect(has(a, '--dangerously-skip-permissions')).toBe(false);
      expect(valsOf(a, '--permission-mode')).not.toContain('bypassPermissions');
    }
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

// ── THE THREE PERMISSION TIERS, SIDE BY SIDE (operator ruling 2026-09-23: "and so
//    --permission-mode [should] be none at all. free roam inside the sandbox", and, asked whether
//    the coherent end state is that a sandboxed being also gets bypassPermissions, "yes").
//
//    WHAT CHANGED: `osConfined` used to be the CONFINED tier minus two flags. It is now the
//    UNCONFINED tier, because for an OS-sandboxed turn the Windows account is the boundary — the
//    leased pool account holds an ACE on its Room, its thread store and its read-only mounts and
//    on nothing else, and the kernel checks every open. The 2026-07-03 Read leak that the middle
//    tier was built around ("an allow-list entry bypasses the path check") has no consequence
//    there: a Read that escapes its root escapes into a directory with no ACE for that account.
//    And the middle tier never actually bounded these beings anyway — they hold bare Bash, which
//    was never path-gated, so the being could always `cat` a file it was not allowed to `Read`.
//
//    THE GUARD IS `osConfined` ALONE. A being with no OS box — access_level regular on a node
//    that does not sandbox, or any non-win32 node — has nothing but this argv between it and the
//    filesystem, and every flag it had it still has. That is the middle case below, and it is
//    the one that must never move. ──
describe('the three permission tiers (2026-09-23)', () => {
  const opts = { allowedTools: ['Read', 'Grep', 'WebFetch'], addDirs: ['/c/work'], readOnlyDirs: ['/c/ro'] };

  it('osConfined (the OS box) — bypass, and NOTHING else: no tool list, not one path in argv', () => {
    const a = buildClaudeArgs({ ...opts, osConfined: true });
    expect(has(a, '--dangerously-skip-permissions')).toBe(true);
    expect(valsOf(a, '--permission-mode')).toEqual(['bypassPermissions']);
    // NO --allowedTools (operator 2026-09-23, the second half of the same ruling). Under the
    // bypass pair on the two lines above an allow-list gates nothing, so emitting one only
    // states a fence that is not there — and DEFAULT_ALLOWED_TOOLS, with no bare Bash and no
    // Agent, stated a narrow one. The list still travels in brainOptions; it just decides
    // nothing here. Emitting a "complete" set instead was rejected: a second hand-written tool
    // list goes stale the next time Claude Code ships a tool.
    expect(has(a, '--allowedTools')).toBe(false);
    // NO roots at all: not the declared addDirs, not the read-only ones. Those paths are real
    // locations under the operator's profile, and naming them is what put the operator's
    // username into every sandboxed being's argv.
    expect(addDirs(a)).toEqual([]);
    // ...and no deny rules and no settings isolation: a CLI gate this tier does not have.
    expect(has(a, '--settings')).toBe(false);
    expect(has(a, '--setting-sources')).toBe(false);
  });

  it('confineToDirs (no OS box) — UNCHANGED: default mode, roots named, file tools withheld', () => {
    // THE GUARD. This is the tier for a being whose only boundary is this argv. If a change to
    // the sandboxed tier ever reaches here, the being it belongs to has just been un-confined.
    const a = buildClaudeArgs({ ...opts, confineToDirs: ['/c/conv'] });
    expect(has(a, '--dangerously-skip-permissions')).toBe(false);
    expect(valsOf(a, '--permission-mode')).toEqual(['default']);
    expect(valsOf(a, '--setting-sources')).toEqual(['']);
    expect(addDirs(a)).toEqual(['/c/work', '/c/conv', '/c/ro']);
    expect(valsOf(a, '--allowedTools')).toEqual(['WebFetch']);             // non-file tools only
    expect(JSON.parse(valsOf(a, '--settings')[0]).permissions.deny).toContain('Write(/c/ro/**)');
  });

  it('dangerouslySkipPermissions — UNCHANGED: it still spells its verbatim list', () => {
    const a = buildClaudeArgs({ ...opts, dangerouslySkipPermissions: true });
    expect(has(a, '--dangerously-skip-permissions')).toBe(true);
    expect(valsOf(a, '--permission-mode')).toEqual(['bypassPermissions']);
    // Inert here too, strictly speaking — but this tier's list is a TYPE FILE's own trusted
    // grant (bare Bash/Agent included), not a fence egpt invented, and the ruling that retired
    // the boxed tier's list was about the box. Not touched.
    expect(valsOf(a, '--allowedTools')).toEqual(['Read Grep WebFetch']);
    // The other thing that still differs from osConfined, and it is not a tier decision: an
    // unconfined turn is not in a box, so its declared roots are still the only thing telling
    // the CLI where it may work.
    expect(addDirs(a)).toEqual(['/c/work', '/c/ro']);
  });

  it('osConfined and dangerouslySkipPermissions together emit the pair ONCE, not twice', () => {
    // Both routes now push the same two flags. A being at access_level `all` on a boxed node
    // takes both paths, and a doubled --permission-mode is an argv the CLI reads as ambiguous.
    const a = buildClaudeArgs({ ...opts, osConfined: true, dangerouslySkipPermissions: true });
    expect(a.filter((x) => x === '--dangerously-skip-permissions')).toHaveLength(1);
    expect(valsOf(a, '--permission-mode')).toEqual(['bypassPermissions']);
  });
});

describe('FILE_TOOLS sanity', () => {
  it('covers the write/read-class tools', () => {
    for (const t of ['read', 'write', 'edit', 'glob', 'grep']) expect(FILE_TOOLS.has(t)).toBe(true);
    expect(FILE_TOOLS.has('webfetch')).toBe(false);
  });
});
