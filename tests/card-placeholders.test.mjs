import { describe, it, expect } from 'vitest';
import { fillCardPlaceholders } from '../src/conversations-state.mjs';

// Cards quote CONFIG rather than hardcoding paths: operator 2026-08-24 —
// "both the path to the chrome browser and the profile path need to be told in
// pointers, and configured in config.yaml".
describe('card placeholders', () => {
  const cfg = { chrome: { bin: 'C:/chrome.exe', profile_dir: 'C:/prof/brain' } };

  it('fills a dotted config key', () => {
    expect(fillCardPlaceholders('chrome {{chrome.bin}}', cfg)).toBe('chrome C:/chrome.exe');
  });

  it('fills several on one line', () => {
    expect(fillCardPlaceholders('{{chrome.bin}} + {{chrome.profile_dir}}', cfg))
      .toBe('C:/chrome.exe + C:/prof/brain');
  });

  it('DROPS the whole line when the key is unset — never advertises a path this node lacks', () => {
    const out = fillCardPlaceholders('keep me\n  chrome {{chrome.bin}}\nkeep me too', {});
    expect(out).toBe('keep me\nkeep me too');
  });

  it('drops the line when the value is present but blank', () => {
    expect(fillCardPlaceholders('x {{chrome.bin}}', { chrome: { bin: '   ' } })).toBe('');
  });

  it('leaves ordinary text alone', () => {
    expect(fillCardPlaceholders('./transcript.md   this thread', cfg))
      .toBe('./transcript.md   this thread');
  });

  // THE LOCK behind shipping 00-identity as a TEMPLATE (operator 2026-09-01): every node's
  // EXISTING hand-written profile identity file — no {{...}} anywhere in it — must keep feeding
  // BYTE-FOR-BYTE as it does today, CRLF and blank lines included. A card only changes when it
  // actually quotes config; nothing else is touched on the way through.
  it('a card with NO placeholder passes through byte-identical (CRLF, blanks and all)', () => {
    const card = '# I am eGPT\r\n\r\nI am a loop around a mind.\r\n\r\n  indented   spacing kept\r\n';
    expect(fillCardPlaceholders(card, cfg)).toBe(card);
    expect(fillCardPlaceholders(card, {})).toBe(card);   // …and with no config at all
  });

  // The three keys the identity template quotes (agent_name / agent_handles from the brainpool's
  // feedConfig, node_name straight off the node config) are ordinary dotted lookups — nothing in
  // fillCardPlaceholders knows about them, which is the point: the caller supplies the facts.
  it('fills the identity-template keys, and drops the stamp line for an agent with no name:', () => {
    const feedCfg = { node_name: 'kg', agent_name: 'egpt', agent_handles: '@ekg, @egptkg' };
    expect(fillCardPlaceholders('I am {{agent_name}} on {{node_name}}, answering to {{agent_handles}}.', feedCfg))
      .toBe('I am egpt on kg, answering to @ekg, @egptkg.');
    expect(fillCardPlaceholders('# I am {{agent_name}}\nI live on node {{node_name}}.', { ...feedCfg, agent_name: '' }))
      .toBe('I live on node kg.');
  });
});
