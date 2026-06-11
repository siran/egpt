// tests/codex-brain.test.mjs — pure-function tests for the codex brain's
// tool-scoping helper. Verifies that per-personality allowedTools maps
// correctly to codex's bypass-vs-sandbox flag.

import { describe, it, expect } from 'vitest';
import { codexConfigArgs, codexPermissionArgs, codexTrustArgs } from '../config/brains/codex.mjs';

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

describe('codexConfigArgs - model runtime config', () => {
  it('always sets model_reasoning_effort', () => {
    expect(codexConfigArgs({ reasoningEffort: 'low' })).toEqual([
      '-c',
      'model_reasoning_effort="low"',
    ]);
  });

  it('passes service_tier when configured', () => {
    expect(codexConfigArgs({ reasoningEffort: 'low', serviceTier: 'fast' })).toEqual([
      '-c',
      'model_reasoning_effort="low"',
      '--enable',
      'fast_mode',
      '-c',
      'service_tier="fast"',
    ]);
  });

  it('accepts YAML-style service_tier but ignores unsafe values', () => {
    expect(codexConfigArgs({ reasoningEffort: 'low', service_tier: 'priority' })).toContain('service_tier="priority"');
    expect(codexConfigArgs({ reasoningEffort: 'low', service_tier: 'fast"; sandbox_mode="danger-full-access' })).toEqual([
      '-c',
      'model_reasoning_effort="low"',
    ]);
  });
});
