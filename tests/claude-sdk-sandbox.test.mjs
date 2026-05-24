// conversation-e confinement is claude-NATIVE, not hand-rolled path parsing.
// The leak (verified live 2026-05-23: @e read ~/.egpt/config.yaml and
// returned `main_engineer: jay`) was the SDK inheriting ~/.claude's
// defaultMode:bypassPermissions + blanket Read/Write allow. buildSdkOptions
// confines a contact turn by loading NO settings files (settingSources:[])
// and scoping the readable roots to the contact's own dir. These tests lock
// the wiring; the live probes (throwaway) confirmed the runtime behaviour:
// inside=allowed, cross-contact=denied, config.yaml=denied.
import { describe, it, expect } from 'vitest';
import { buildSdkOptions } from '../config/brains/claude-sdk.mjs';

describe('buildSdkOptions — confined contact turn', () => {
  const confined = buildSdkOptions({
    cwd: 'C:/Users/an/.egpt/conversations/whatsapp/daniel',
    addDirs: ['C:/Users/an/.egpt/conversations/whatsapp/daniel'],
    confineToDirs: ['C:/Users/an/.egpt/conversations/whatsapp/daniel'],
    allowedTools: ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'WebFetch'],
    model: 'haiku',
  });

  it('loads NO settings files — does not inherit the ~/.claude bypass', () => {
    expect(confined.settingSources).toEqual([]);
  });

  it('uses default permission mode, NOT bypass', () => {
    expect(confined.permissionMode).toBe('default');
    expect(confined.allowDangerouslySkipPermissions).toBeUndefined();
  });

  it('scopes the readable roots to the conversation dir', () => {
    expect(confined.additionalDirectories).toContain('C:/Users/an/.egpt/conversations/whatsapp/daniel');
    // crucially NOT the home/secrets or another contact's dir
    expect(confined.additionalDirectories).not.toContain('C:/Users/an/.egpt');
  });

  it('pre-approves ONLY non-file tools; file tools stay engine-confined', () => {
    // File tools (Read/Write/Edit/Grep/Glob) must NOT be pre-approved —
    // an allowedTools entry bypasses the path engine for any path (the
    // original leak). Only WebFetch (non-file) is pre-approved.
    expect(confined.allowedTools).toEqual(['WebFetch']);
    expect(confined.allowedTools).not.toContain('Read');
  });
});

describe('buildSdkOptions — trusted turn (system-e / engineers)', () => {
  const trusted = buildSdkOptions({ cwd: 'C:/x', allowedTools: 'all', model: 'opus' });

  it('uses bypass and inherits normal config (no settingSources override)', () => {
    expect(trusted.permissionMode).toBe('bypassPermissions');
    expect(trusted.allowDangerouslySkipPermissions).toBe(true);
    expect(trusted.settingSources).toBeUndefined();
  });
});

describe('buildSdkOptions — restricted list WITHOUT confineToDirs (legacy)', () => {
  const r = buildSdkOptions({ allowedTools: ['Read', 'Grep'] });

  it('sets allowedTools but does NOT engage the sandbox', () => {
    expect(r.allowedTools).toEqual(['Read', 'Grep']);
    expect(r.settingSources).toBeUndefined();
    expect(r.permissionMode).toBeUndefined();
  });
});
