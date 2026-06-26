import { describe, it, expect } from 'vitest';
import { initWizard, wizardStep, wizardPrompt } from '../src/agent-wizard.mjs';

const opts = { brains: ['claude-code', 'codex'], models: ['haiku', 'sonnet', 'opus'], efforts: ['low', 'medium', 'high'], identities: ['default', 'banter'] };
const mk = () => initWizard({ slug: 'spoiler', jid: '!x:beeper.local', options: opts });

describe('agent wizard', () => {
  it('walks name → brain → model → effort → identity → done', () => {
    let r = wizardStep(mk(), 'wren');     // name (free text)
    r = wizardStep(r.state, '1');         // brain → claude-code
    r = wizardStep(r.state, '3');         // model → opus
    r = wizardStep(r.state, '3');         // effort → high
    r = wizardStep(r.state, '2');         // identity → banter
    expect(r.done).toBe(true);
    expect(r.result).toMatchObject({ slug: 'spoiler', name: 'wren', brain: 'claude-code', model: 'opus', effort: 'high', personality: 'banter' });
  });

  it('blank name → configures E', () => {
    expect(wizardStep(mk(), '').state.answers.name).toBe('e');
  });

  it('accepts a value by text as well as by number', () => {
    let r = wizardStep(mk(), 'wren');
    r = wizardStep(r.state, 'codex');     // brain by name
    expect(r.state.answers.brain).toBe('codex');
  });

  it('rejects an out-of-range pick and stays on the step', () => {
    let r = wizardStep(mk(), 'wren');
    const before = r.state.idx;
    r = wizardStep(r.state, '9');         // no brain 9
    expect(r.state.idx).toBe(before);
    expect(r.prompt).toMatch(/pick 1–2/);
  });

  it('b goes back, x cancels', () => {
    let r = wizardStep(mk(), 'wren');     // now on brain
    r = wizardStep(r.state, 'b');         // back to name
    expect(r.state.idx).toBe(0);
    expect(wizardStep(r.state, 'x').cancelled).toBe(true);
  });

  it('wizardPrompt numbers the options', () => {
    let r = wizardStep(mk(), 'wren');
    expect(wizardPrompt(r.state)).toMatch(/1\) claude-code/);
  });
});
