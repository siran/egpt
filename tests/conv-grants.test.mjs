import { describe, it, expect } from 'vitest';
import {
  emptyGrants, grantedPaths, addGrant, removeGrant,
} from '../src/conv-grants.mjs';

describe('conversation-e custom dir grants', () => {
  it('adds a path under a slug', () => {
    const s = addGrant(emptyGrants(), 'daniel', 'C:\\refs\\manual');
    expect(grantedPaths(s, 'daniel')).toEqual(['C:\\refs\\manual']);
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
