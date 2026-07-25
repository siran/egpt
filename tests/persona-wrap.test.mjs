// persona-wrap.test.mjs — the SHARED persona stamp + concentric wrap (operator 2026-07-25).
// Extracted from beeper-port so both surface ports (beeper, shell) render a persona reply
// through ONE definition. These assertions are ported from the beeper-port wrap tests: the
// shared module must behave identically to the code beeper-port carried before the move.
import { describe, it, expect } from 'vitest';
import { personaStamp, makeWrapPersona } from '../src/bridges/persona-wrap.mjs';
import { encodeMesh, parseMesh } from '../src/mesh/relay.mjs';

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

  // THE PERIOD (operator 2026-07-25: "all messages coming out from a spine to any surface are
  // signed. period."). Was: "no full persona header (plain/auto) → no stamp, no layers". That gate
  // made "sign it" and "stamp it" ONE switch, so a node could not sign a body it had not stamped —
  // the mesh nugget (a remote being's reply) and the 👂 echo both fell through it, and the echo grew
  // its own private copy of the wrap in beeper.mjs to get signed at all. Signing is a property of
  // the SEND; only the persona STAMP still depends on there being an identity to stamp.
  it('a plain/auto send carries the node bridge layer — signing does NOT depend on a persona header', () => {
    const wrap = makeWrapPersona({ bridgeSignatureOpen: '🌉', bridgeSignatureClose: '💸' });
    expect(wrap({}, 'Hey, all good')).toBe('🌉\nHey, all good\n💸');   // no stamp (nothing to stamp) — but signed
  });

  it('with every slot empty a plain send is still byte-identical to the bare text (unsigned node unchanged)', () => {
    expect(makeWrapPersona({})({}, 'Hey, all good')).toBe('Hey, all good');
  });

  // THE 👂 ECHO through the ONE path (operator 2026-07-25). beeper.mjs used to apply
  // applyLayers([bridge, transcription]) ITSELF (`withEchoLayers`, now deleted) because this wrap
  // refused a core with no persona header. The echo core arrives already carrying its 👂 marker, so
  // personaStamp adds nothing; the layers are the same two, in the same order — the render is
  // byte-identical to the deleted copy (tests/beeper-bridge.test.mjs locks the live beeper output).
  it('a 👂 echo core (no persona header) renders through the SHARED wrap: bridge outside, transcription inside', () => {
    const wrap = makeWrapPersona({ bridgeSignatureOpen: 'BO', bridgeSignatureClose: 'BC' });
    expect(wrap({ agentSigOpen: 'TO', agentSigClose: 'TC' }, '👂 hola')).toBe('BO\nTO\n👂 hola\nTC\nBC');
  });
});

// TRANSPORT IS NOT A SURFACE — the ONE thing the "period" does not cover. A mesh envelope posted
// into a relay channel is spine→spine: its signature already rides INSIDE the fence (the responder
// renders the nugget through this wrap before encodeMesh), and a close line appended BELOW the
// provenance tail would make parseMesh stop recognising the envelope — the mesh would go deaf.
describe('makeWrapPersona — a mesh envelope is transport, never signed', () => {
  it('an encoded envelope passes through VERBATIM and still parses', () => {
    const wrap = makeWrapPersona({ bridgeSignatureOpen: '🌉kg', bridgeSignatureClose: '🌉' });
    const env = encodeMesh({ by: 'don.do', body: '🤝 Yep, still here', re: 'HFM.kg', post_id: 'p1', done: true });
    expect(wrap({}, env)).toBe(env);                                  // byte-identical — nothing added
    expect(parseMesh(wrap({}, env))).toMatchObject({ by: 'don.do', done: true });
  });

  it('ordinary prose that merely ENDS in a provenance-looking line is still signed (the fence is required)', () => {
    const wrap = makeWrapPersona({ bridgeSignatureOpen: '🌉kg', bridgeSignatureClose: '🌉' });
    expect(wrap({}, 'shipping it\nby: An')).toBe('🌉kg\nshipping it\nby: An\n🌉');
  });
});
