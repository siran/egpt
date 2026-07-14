// port-explicit-tools.test.mjs — the PURE transform of setup/port-explicit-tools.mjs
// (the one-shot registry port). Importing the module does NOT run main() (gated on
// direct invocation), so this only exercises portExplicitTools's in-memory logic —
// no disk I/O here (the Document round-trip is covered by conversations-state's own
// serialize/parse tests + a manual scratch-copy dry run, per the operator's ask).
import { describe, it, expect } from 'vitest';
import { portExplicitTools } from '../setup/port-explicit-tools.mjs';
import { DEFAULT_ALLOWED_TOOLS } from '../src/conversations-state.mjs';

const baseEntry = (allowed_tools) => ({
  slug: 'diego-2605200133',
  pushedName: 'Diego',
  readonly: { agent: 'egpt', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools },
});

describe('portExplicitTools', () => {
  it('coerces a flat readonly.allowed_tools: all to the explicit DEFAULT_ALLOWED_TOOLS list', () => {
    const state = { contacts: { whatsapp: { j1: baseEntry('all') } } };
    const { state: next, touched } = portExplicitTools(state);
    expect(next.contacts.whatsapp.j1.readonly.allowed_tools).toEqual(DEFAULT_ALLOWED_TOOLS);
    expect(touched).toEqual([{ surface: 'whatsapp', jid: 'j1', being: 'e' }]);
  });

  it('coerces \'*\' the same as \'all\'', () => {
    const state = { contacts: { whatsapp: { j1: baseEntry('*') } } };
    const { state: next } = portExplicitTools(state);
    expect(next.contacts.whatsapp.j1.readonly.allowed_tools).toEqual(DEFAULT_ALLOWED_TOOLS);
  });

  it('coerces a NESTED per-being readonly.allowed_tools: all (a sibling, not the flat "e")', () => {
    const entry = { ...baseEntry(['Read']), wren: { mode: 'on', readonly: { agent: 'wren', type: 'ccode', allowed_tools: 'all' } } };
    const state = { contacts: { whatsapp: { j1: entry } } };
    const { state: next, touched } = portExplicitTools(state);
    expect(next.contacts.whatsapp.j1.wren.readonly.allowed_tools).toEqual(DEFAULT_ALLOWED_TOOLS);
    expect(next.contacts.whatsapp.j1.readonly.allowed_tools).toEqual(['Read']);   // the flat 'e' block untouched
    expect(touched).toEqual([{ surface: 'whatsapp', jid: 'j1', being: 'wren' }]);
  });

  it('leaves an already-explicit list untouched (idempotent)', () => {
    const state = { contacts: { whatsapp: { j1: baseEntry(['Read', 'Grep']) } } };
    const { state: next, touched } = portExplicitTools(state);
    expect(next.contacts.whatsapp.j1.readonly.allowed_tools).toEqual(['Read', 'Grep']);
    expect(touched).toEqual([]);
  });

  it('running it twice is a no-op the second time', () => {
    const state = { contacts: { whatsapp: { j1: baseEntry('all') } } };
    const once = portExplicitTools(state);
    const twice = portExplicitTools(once.state);
    expect(twice.touched).toEqual([]);
    expect(twice.state).toEqual(once.state);
  });

  it('leaves an entry with no readonly (never instanced) and an alias entry untouched', () => {
    const state = { contacts: { whatsapp: { fresh: { slug: 'fresh-1' }, alias: { aliasOf: 'fresh' } } } };
    const { state: next, touched } = portExplicitTools(state);
    expect(next).toEqual(state);
    expect(touched).toEqual([]);
  });

  it('each touched entry gets its OWN array (no shared reference across entries)', () => {
    const state = { contacts: { whatsapp: { a: baseEntry('all'), b: baseEntry('all') } } };
    const { state: next } = portExplicitTools(state);
    expect(next.contacts.whatsapp.a.readonly.allowed_tools).not.toBe(next.contacts.whatsapp.b.readonly.allowed_tools);
  });

  it('touches multiple surfaces/contacts in one pass', () => {
    const state = {
      contacts: {
        whatsapp: { j1: baseEntry('all') },
        telegram: { j2: baseEntry(['Read']) },
      },
    };
    const { touched } = portExplicitTools(state);
    expect(touched).toEqual([{ surface: 'whatsapp', jid: 'j1', being: 'e' }]);
  });
});
