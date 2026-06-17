import { describe, it, expect, vi } from 'vitest';
import { createJoinedChats } from '../src/wa-joined.mjs';

describe('wa-joined (the WA joined/bound chat set — Phase C strangler)', () => {
  it('starts empty', () => {
    const j = createJoinedChats();
    expect(j.all()).toEqual([]);
    expect(j.first()).toBeNull();
    expect(j.has('x')).toBe(false);
    expect(j.size()).toBe(0);
  });

  it('add/remove/clear maintain the set and fire syncBypass', () => {
    const syncBypass = vi.fn();
    const j = createJoinedChats({ syncBypass });
    j.add({ jid: 'a' });
    j.add({ jid: 'b', dir: 'out' });
    expect(j.size()).toBe(2);
    expect(j.has('a')).toBe(true);
    expect(j.first()).toEqual({ jid: 'a' });
    expect(j.remove('a')).toBe(true);
    expect(j.size()).toBe(1);
    j.clear();
    expect(j.size()).toBe(0);
    expect(j.all()).toEqual([]);          // empties back to the null shape
    expect(syncBypass).toHaveBeenCalledTimes(4);   // add, add, remove, clear
  });

  it('direction filters: outgoing excludes "in", incomingAllowed excludes "out"', () => {
    const j = createJoinedChats();
    j.add({ jid: 'both' });               // default 'both'
    j.add({ jid: 'inOnly', dir: 'in' });
    j.add({ jid: 'outOnly', dir: 'out' });
    expect(j.outgoing().map(e => e.jid).sort()).toEqual(['both', 'outOnly']);   // not 'inOnly'
    expect(j.incomingAllowed('both')).toBe(true);
    expect(j.incomingAllowed('inOnly')).toBe(true);
    expect(j.incomingAllowed('outOnly')).toBe(false);
    expect(j.incomingAllowed('missing')).toBe(false);
  });
});
