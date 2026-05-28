import { describe, it, expect } from 'vitest';
import {
  emptyGrants, grantedPaths, grantedEntries, addGrant, removeGrant, normalizeAccess,
} from '../src/conv-grants.mjs';

describe('conversation-e custom dir grants', () => {
  it('adds a path under a slug (default full access)', () => {
    const s = addGrant(emptyGrants(), 'daniel', 'C:\\refs\\manual');
    expect(grantedPaths(s, 'daniel')).toEqual(['C:\\refs\\manual']);
    expect(grantedEntries(s, 'daniel')).toEqual([{ path: 'C:\\refs\\manual', access: 'full' }]);
  });

  it('stores and reports per-path access', () => {
    let s = addGrant(emptyGrants(), 'daniel', 'C:\\ro', 'ro');
    s = addGrant(s, 'daniel', 'C:\\rw', 'full');
    expect(grantedEntries(s, 'daniel')).toEqual([
      { path: 'C:\\ro', access: 'read' },
      { path: 'C:\\rw', access: 'full' },
    ]);
  });

  it('re-adding a path updates its access level', () => {
    let s = addGrant(emptyGrants(), 'daniel', 'C:\\x', 'full');
    s = addGrant(s, 'daniel', 'C:\\x', 'ro');
    expect(grantedEntries(s, 'daniel')).toEqual([{ path: 'C:\\x', access: 'read' }]);
  });

  it('reads a legacy bare-string entry as full access', () => {
    const s = { grants: { daniel: { paths: ['C:\\legacy'] } } };
    expect(grantedEntries(s, 'daniel')).toEqual([{ path: 'C:\\legacy', access: 'full' }]);
  });

  it('normalizeAccess maps tokens', () => {
    expect(normalizeAccess('ro')).toBe('read');
    expect(normalizeAccess('read-only')).toBe('read');
    expect(normalizeAccess('rw')).toBe('full');
    expect(normalizeAccess('whatever')).toBe('full');
  });

  it('is idempotent on duplicate add', () => {
    let s = addGrant(emptyGrants(), 'daniel', 'C:\\a');
    s = addGrant(s, 'daniel', 'C:\\a');
    expect(grantedPaths(s, 'daniel')).toEqual(['C:\\a']);
  });

  it('keeps grants per-slug isolated', () => {
    let s = addGrant(emptyGrants(), 'daniel', 'C:\\a');
    s = addGrant(s, 'mara', 'C:\\b');
    expect(grantedPaths(s, 'daniel')).toEqual(['C:\\a']);
    expect(grantedPaths(s, 'mara')).toEqual(['C:\\b']);
  });

  it('removes a path and drops the slug when empty', () => {
    let s = addGrant(emptyGrants(), 'daniel', 'C:\\a');
    s = removeGrant(s, 'daniel', 'C:\\a');
    expect(grantedPaths(s, 'daniel')).toEqual([]);
    expect(s.grants.daniel).toBeUndefined();
  });

  it('returns [] for an unknown slug', () => {
    expect(grantedPaths(emptyGrants(), 'nobody')).toEqual([]);
  });

  it('rejects add without slug or path', () => {
    expect(() => addGrant(emptyGrants(), '', 'C:\\a')).toThrow();
    expect(() => addGrant(emptyGrants(), 'daniel', '')).toThrow();
  });
});
