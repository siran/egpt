// tests/codex-brain.test.mjs — pure-function tests for the codex brain's
// tool-scoping helper. Verifies that per-personality allowedTools maps
// correctly to codex's bypass-vs-sandbox flag.

import { describe, it, expect } from 'vitest';
import { codexPermissionArgs, codexRuntimeArgs, codexTrustArgs } from '../config/brains/codex.mjs';

const BYPASS = '--dangerously-bypass-approvals-and-sandbox';

describe('codexTrustArgs — per-personality tool scoping', () => {
  it("returns bypass flag for allowedTools='all'", () => {
    expect(codexTrustArgs('all', undefined)).toEqual([BYPASS]);
  });
  it("returns bypass flag for allowedTools='*'", () => {
    expect(codexTrustArgs('*', undefined)).toEqual([BYPASS]);
  });
  it("returns bypass flag when allowedTools is undefined (legacy callers)", () => {
    expect(codexTrustArgs(undefined, undefined)).toEqual([BYPASS]);
  });
  it("returns NO bypass for an empty array", () => {
    expect(codexTrustArgs([], undefined)).toEqual([]);
  });
  it("returns NO bypass for a restricted array (e.g. default personality)", () => {
    expect(codexTrustArgs(['Read', 'Grep', 'Glob'], undefined)).toEqual([]);
  });
  it("returns NO bypass when env override EGPT_CODEX_TRUST='0' regardless of allowedTools", () => {
    expect(codexTrustArgs('all', '0')).toEqual([]);
    expect(codexTrustArgs(undefined, '0')).toEqual([]);
    expect(codexTrustArgs(['Read'], '0')).toEqual([]);
  });
  it("returns bypass when env is set to anything other than '0'", () => {
    expect(codexTrustArgs('all', '1')).toEqual([BYPASS]);
    expect(codexTrustArgs('all', undefined)).toEqual([BYPASS]);
    expect(codexTrustArgs('all', '')).toEqual([BYPASS]);
  });
});

describe('codexPermissionArgs - workspace-write scope', () => {
  it("uses bypass for allowedTools='all'", () => {
    expect(codexPermissionArgs({ allowedTools: 'all', addDirs: ['C:\\work'] }, undefined)).toEqual([BYPASS]);
  });

  it('uses workspace-write plus add-dir roots for restricted tools', () => {
    expect(codexPermissionArgs({
      allowedTools: ['Read', 'Grep', 'Glob'],
      addDirs: ['C:\\work', 'C:\\media'],
    }, undefined)).toEqual([
      '--sandbox', 'workspace-write',
      '--add-dir', 'C:\\work',
      '--add-dir', 'C:\\media',
    ]);
  });

  it("EGPT_CODEX_TRUST='0' forces workspace-write even for all tools", () => {
    expect(codexPermissionArgs({ allowedTools: 'all', addDirs: ['C:\\work'] }, '0')).toEqual([
      '--sandbox', 'workspace-write',
      '--add-dir', 'C:\\work',
    ]);
  });
});

describe('codexRuntimeArgs - invocation controls', () => {
  it('adds no runtime flags by default', () => {
    expect(codexRuntimeArgs({})).toEqual([]);
  });

  it('maps ephemeral:true to --ephemeral', () => {
    expect(codexRuntimeArgs({ ephemeral: true })).toEqual(['--ephemeral']);
  });

  it('accepts string booleans for config-loaded values', () => {
    expect(codexRuntimeArgs({ ephemeral: 'true', ignore_rules: 'yes' })).toEqual([
      '--ephemeral',
      '--ignore-rules',
    ]);
  });

  it('maps ignoreRules to --ignore-rules', () => {
    expect(codexRuntimeArgs({ ignoreRules: true })).toEqual(['--ignore-rules']);
  });
});
