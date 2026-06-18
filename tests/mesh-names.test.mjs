import { describe, expect, it } from 'vitest';
import {
  meshNamesFromSiblings,
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

  it('resolves same-node fully-qualified addresses locally', () => {
    expect(resolveMeshAddress('@don.morgan', {
      localNode: 'morgan',
      localNames: ['don'],
    })).toEqual({
      kind: 'local',
      qualified: true,
      name: 'don',
      node: 'morgan',
      fqid: 'don.morgan',
    });
  });

  it('marks other-node fully-qualified addresses foreign', () => {
    expect(resolveMeshAddress('@don.reve', {
      localNode: 'morgan',
      localNames: ['don'],
    })).toEqual({
      kind: 'foreign',
      qualified: true,
      name: 'don',
      node: 'reve',
      fqid: 'don.reve',
    });
  });

  it('reports ambiguous bare names across local and peer nodes', () => {
    expect(resolveMeshAddress('@don', {
      localNode: 'morgan',
      localNames: ['don'],
      peerNodes: { reve: ['don'] },
    })).toEqual({
      kind: 'ambiguous',
      qualified: false,
      name: 'don',
      candidates: ['don', 'don.reve'],
    });
  });

  it('resolves a bare name to a single peer when local node lacks it', () => {
    expect(resolveMeshAddress('@don', {
      localNode: 'morgan',
      localNames: ['e'],
      peerNodes: { reve: ['don'] },
    })).toEqual({
      kind: 'foreign',
      qualified: false,
      name: 'don',
      node: 'reve',
      fqid: 'don.reve',
    });
  });

  it('reports invalid and missing addresses explicitly', () => {
    expect(resolveMeshAddress('@bad/name')).toEqual({
      kind: 'invalid',
      token: '@bad/name',
    });
    expect(resolveMeshAddress('@don.morgan', {
      localNode: 'morgan',
      localNames: ['e'],
    })).toEqual({
      kind: 'missing',
      qualified: true,
      name: 'don',
      node: 'morgan',
      fqid: 'don.morgan',
    });
    expect(resolveMeshAddress('@don', {
      localNode: 'morgan',
      localNames: ['e'],
    })).toEqual({
      kind: 'missing',
      qualified: false,
      name: 'don',
      node: 'morgan',
      fqid: null,
    });
  });

  it('accepts map and array peer registries', () => {
    expect(resolveMeshAddress('@don', {
      localNode: 'morgan',
      peerNodes: new Map([
        ['reve', new Map([['don', {}]])],
      ]),
    })).toMatchObject({ kind: 'foreign', node: 'reve', fqid: 'don.reve' });

    expect(resolveMeshAddress('@jay', {
      localNode: 'morgan',
      peerNodes: [
        ['reve', [{ name: 'jay', aliases: ['j'] }]],
      ],
    })).toMatchObject({ kind: 'foreign', node: 'reve', fqid: 'jay.reve' });
  });

  it('accepts object-shaped peer rosters', () => {
    expect(resolveMeshAddress('@don', {
      localNode: 'morgan',
      peerNodes: { reve: { siblings: { don: {} } } },
    })).toMatchObject({ kind: 'foreign', node: 'reve', fqid: 'don.reve' });

    expect(resolveMeshAddress('@jay', {
      localNode: 'morgan',
      peerNodes: { reve: { names: ['jay'] } },
    })).toMatchObject({ kind: 'foreign', node: 'reve', fqid: 'jay.reve' });

    expect(resolveMeshAddress('@e', {
      localNode: 'morgan',
      peerNodes: { reve: { sessions: [{ name: 'e' }] } },
    })).toMatchObject({ kind: 'foreign', node: 'reve', fqid: 'e.reve' });
  });

  it('ignores malformed peer registries', () => {
    expect(resolveMeshAddress('@don', {
      localNode: 'morgan',
      peerNodes: 'not-a-registry',
    })).toMatchObject({ kind: 'missing', name: 'don' });
  });
});
