// tests/codex-brain.test.mjs — pure-function tests for the codex brain's
// tool-scoping helper. Verifies that per-personality allowedTools maps
// correctly to codex's bypass-vs-sandbox flag.

import { describe, it, expect } from 'vitest';
import { codexTrustArgs } from '../brains/codex.mjs';

describe('codexTrustArgs — per-personality tool scoping', () => {
  const BYPASS = '--dangerously-bypass-approvals-and-sandbox';

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
