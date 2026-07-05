import { describe, expect, it } from 'vitest';
import {
  meshNamesFromSiblings,
  meshSiblingKind,
  normalizeMeshPart,
  parseMeshAddress,
  resolveMeshAddress,
  sameMeshNode,
} from '../src/mesh/names.mjs';

describe('mesh names', () => {
  it('normalizes address parts', () => {
    expect(normalizeMeshPart('@Don')).toBe('don');
    expect(normalizeMeshPart('  MORGAN  ')).toBe('morgan');
    expect(normalizeMeshPart('')).toBeNull();
  });

  it('parses bare and fully-qualified addresses', () => {
    expect(parseMeshAddress('@Don.Morgan')).toEqual({
      qualified: true,
      name: 'don',
      node: 'morgan',
      fqid: 'don.morgan',
      raw: 'don.morgan',
    });
    expect(parseMeshAddress('don')).toEqual({
      qualified: false,
      name: 'don',
      node: null,
      fqid: null,
      raw: 'don',
    });
  });

  it('rejects malformed addresses', () => {
    expect(parseMeshAddress('don.morgan.extra')).toBeNull();
    expect(parseMeshAddress('don/morgan')).toBeNull();
    expect(parseMeshAddress('.morgan')).toBeNull();
  });

  it('compares node names case-insensitively', () => {
    expect(sameMeshNode('Morgan', '@morgan')).toBe(true);
    expect(sameMeshNode('morgan', 'reve')).toBe(false);
  });

  it('collects canonical sibling names and aliases', () => {
    const names = meshNamesFromSiblings(new Map([
      ['e', {}],
      ['wren', { aliases: ['me'] }],
    ]));
    expect([...names].sort()).toEqual(['e', 'me', 'wren']);
  });

  it('classifies sibling kinds (the one typed registry)', () => {
    expect(meshSiblingKind({ type: 'ccode' })).toBe('local');
    expect(meshSiblingKind({ node: 'do' })).toBe('remote');
    expect(meshSiblingKind({ to: 'wren.kg' })).toBe('relay');
    expect(meshSiblingKind(undefined)).toBe('local');
  });

  it('resolves a same-node fully-qualified address locally', () => {
    expect(resolveMeshAddress('@don.morgan', { localNode: 'morgan', siblings: { don: {} } }))
      .toEqual({ kind: 'local', qualified: true, name: 'don', node: 'morgan', fqid: 'don.morgan' });
  });

  it('marks an other-node fully-qualified address foreign', () => {
    expect(resolveMeshAddress('@don.reve', { localNode: 'morgan', siblings: { don: {} } }))
      .toEqual({ kind: 'foreign', qualified: true, name: 'don', node: 'reve', fqid: 'don.reve' });
  });

  it('treats a qualified address on an ALIAS node as one of ours, not foreign (node_alias)', () => {
    // node_name kg + aliases [do, mo]: @wren.do is LOCAL (do is a self-identity) …
    expect(resolveMeshAddress('@wren.do', { localNode: 'kg', localAliases: ['do', 'mo'], siblings: { wren: { type: 'ccode' } } }))
      .toEqual({ kind: 'local', qualified: true, name: 'wren', node: 'do', fqid: 'wren.do' });
    // … a self-alias node we don't run that being on → missing (ours, but no such local being) …
    expect(resolveMeshAddress('@ghost.mo', { localNode: 'kg', localAliases: ['do', 'mo'], siblings: { wren: {} } }))
      .toMatchObject({ kind: 'missing', name: 'ghost', node: 'mo' });
    // … but a genuinely other node stays foreign (the alias set must not swallow it).
    expect(resolveMeshAddress('@wren.reve', { localNode: 'kg', localAliases: ['do', 'mo'], siblings: { wren: { type: 'ccode' } } }))
      .toMatchObject({ kind: 'foreign', node: 'reve' });
  });

  it('resolves a bare LOCAL sibling', () => {
    expect(resolveMeshAddress('@wren', { localNode: 'kg', siblings: { wren: { type: 'ccode' }, e: {} } }))
      .toEqual({ kind: 'local', qualified: false, name: 'wren', node: 'kg' });
  });

  it('resolves a bare REMOTE sibling to its node (foreign)', () => {
    expect(resolveMeshAddress('@don', { localNode: 'kg', siblings: { don: { node: 'do' } } }))
      .toEqual({ kind: 'foreign', qualified: false, name: 'don', node: 'do', fqid: 'don.do' });
  });

  it('resolves a bare RELAY sibling to its target (relay)', () => {
    expect(resolveMeshAddress('@wren2', { localNode: 'kg', siblings: { wren2: { to: 'wren.do' } } }))
      .toEqual({ kind: 'relay', qualified: false, name: 'wren2', target: 'wren.do', being: 'wren', node: 'do' });
  });

  it('resolves a bare name by ALIAS', () => {
    expect(resolveMeshAddress('@me', { localNode: 'kg', siblings: { wren: { aliases: ['me'] } } }))
      .toMatchObject({ kind: 'local', name: 'wren' });
  });

  it('reports a missing bare name (not in the registry)', () => {
    expect(resolveMeshAddress('@ghost', { localNode: 'kg', siblings: { wren: {} } }))
      .toEqual({ kind: 'missing', qualified: false, name: 'ghost', node: 'kg', fqid: null });
  });

  it('a same-node qualified name we do not run is missing', () => {
    expect(resolveMeshAddress('@don.kg', { localNode: 'kg', siblings: { wren: {} } }))
      .toEqual({ kind: 'missing', qualified: true, name: 'don', node: 'kg', fqid: 'don.kg' });
  });

  it('a relay-record is NOT local even on a same-node qualified address', () => {
    expect(resolveMeshAddress('@don.kg', { localNode: 'kg', siblings: { don: { to: 'wren.do' } } }))
      .toMatchObject({ kind: 'missing', name: 'don', node: 'kg' });
  });

  it('reports invalid addresses', () => {
    expect(resolveMeshAddress('@bad/name')).toEqual({ kind: 'invalid', token: '@bad/name' });
  });
});
