// persona-wrap.test.mjs — the SHARED persona stamp + concentric wrap (operator 2026-07-25).
// Extracted from beeper-port so both surface ports (beeper, shell) render a persona reply
// through ONE definition. These assertions are ported from the beeper-port wrap tests: the
// shared module must behave identically to the code beeper-port carried before the move.
import { describe, it, expect } from 'vitest';
import { personaStamp, makeWrapPersona } from '../src/bridges/persona-wrap.mjs';

describe('personaStamp — the bridge-enforced persona identifier', () => {
  it('no body_emoji → text passes through untouched (system sends)', () => {
    expect(personaStamp(undefined, 'egpt', 'hola')).toBe('hola');
    expect(personaStamp('', 'egpt', 'hola')).toBe('hola');
  });

  it('body_emoji but no label → inline emoji only, no header line (echo sends)', () => {
    expect(personaStamp('🐶', null, 'hola')).toBe('🐶 hola');
  });

  it('body_emoji + label → two-line persona header, and a model self-label is stripped', () => {
    expect(personaStamp('🐶', 'egpt', 'Aquí estoy')).toBe('🐶 egpt\nAquí estoy');
    expect(personaStamp('🐶', 'egpt', 'egpt: Aquí estoy')).toBe('🐶 egpt\nAquí estoy');   // self-label stripped
  });
});

describe('makeWrapPersona — concentric [bridge, agent] wrap around the stamped core', () => {
  it('all slots empty → byte-identical to the bare stamp (regression lock)', () => {
    const wrap = makeWrapPersona({});
    expect(wrap({ bodyEmoji: '🐶', label: 'egpt' }, 'Hola')).toBe('🐶 egpt\nHola');
  });

  it('bridge + agent both set → bridge_open, agent_open, CORE, agent_close, bridge_close', () => {
    const wrap = makeWrapPersona({ bridgeSignatureOpen: '🌉kg', bridgeSignatureClose: '💸' });
    const out = wrap({ bodyEmoji: '🐶', label: 'egpt', agentSigOpen: '— e —', agentSigClose: '~ e' }, 'Hola mundo');
    expect(out).toBe('🌉kg\n— e —\n🐶 egpt\nHola mundo\n~ e\n💸');
  });

  it('agent layer alone (bridge empty) wraps just the inner layer', () => {
    const wrap = makeWrapPersona({});
    expect(wrap({ bodyEmoji: '🐶', label: 'egpt', agentSigOpen: 'A_open', agentSigClose: 'A_close' }, 'Hola'))
      .toBe('A_open\n🐶 egpt\nHola\nA_close');
  });

  it('bridge layer alone (agent empty) wraps just the outer layer', () => {
    const wrap = makeWrapPersona({ bridgeSignatureOpen: 'B_open', bridgeSignatureClose: 'B_close' });
    expect(wrap({ bodyEmoji: '🐶', label: 'egpt' }, 'Hola')).toBe('B_open\n🐶 egpt\nHola\nB_close');
  });

  it('no full persona header (plain/auto) → no stamp, no layers, passes through unwrapped', () => {
    const wrap = makeWrapPersona({ bridgeSignatureOpen: '🌉', bridgeSignatureClose: '💸' });
    expect(wrap({}, 'Hey, all good')).toBe('Hey, all good');
  });
});
