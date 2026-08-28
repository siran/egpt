import { describe, it, expect } from 'vitest';
import { shapeOf, diffShapes, dropPerNode } from '../src/tools/config-shape.mjs';

describe('config shape — keys, never values', () => {
  it('emits dotted key paths and NOT the values', () => {
    const s = shapeOf('beeper_token: SECRET-abc\nnode_name: kg\n');
    expect(s).toEqual(['beeper_token', 'node_name']);
    expect(s.join()).not.toMatch(/SECRET/);
  });

  it('a secret nested deep still never appears', () => {
    const s = shapeOf('radio_service:\n  wild:\n    relay_password: hunter2\n');
    expect(s).toContain('radio_service.wild.relay_password');
    expect(s.join()).not.toMatch(/hunter2/);
  });

  it('collapses arrays — three members and five are the same shape', () => {
    const three = shapeOf('members:\n  - {kind: brain, id: a}\n  - {kind: brain, id: b}\n  - {kind: brain, id: c}\n');
    const five  = shapeOf('members:\n  - {kind: brain, id: a}\n  - {kind: brain, id: b}\n  - {kind: brain, id: c}\n  - {kind: brain, id: d}\n  - {kind: brain, id: e}\n');
    expect(three).toEqual(five);
    expect(three).toContain('members[]');
  });

  it('malformed or empty yaml is a shape of nothing, never a throw', () => {
    expect(shapeOf('')).toEqual([]);
    expect(shapeOf(': : :')).toEqual([]);
    expect(shapeOf(null)).toEqual([]);
  });

  it('diff reports keys present on exactly one side', () => {
    const d = diffShapes(['a', 'b', 'shared'], ['shared', 'c']);
    expect(d.onlyA).toEqual(['a', 'b']);
    expect(d.onlyB).toEqual(['c']);
  });

  it('identical shapes diff to nothing — the passing case', () => {
    const keys = shapeOf('agents:\n  pi:\n    model: x\n');
    expect(diffShapes(keys, keys)).toEqual({ onlyA: [], onlyB: [] });
  });

  it('drops per-node identity so the roster is not reported as drift', () => {
    const keys = ['agents.pi.model', 'contacts.whatsapp.abc123.agents.pi', 'rooms.room/dj-son.heartbeats', 'node_name'];
    expect(dropPerNode(keys)).toEqual(['agents.pi.model']);
  });

  it("a real drift survives the per-node filter — that is the point", () => {
    // reve has an agent dolly lacks: exactly today's divergence.
    const reve  = dropPerNode(shapeOf('agents:\n  egpt: {}\n  pi: {}\n  llama: {}\n'));
    const dolly = dropPerNode(shapeOf('agents:\n  egpt: {}\n  pi: {}\n'));
    expect(diffShapes(reve, dolly).onlyA).toEqual(['agents.llama']);
  });
});
