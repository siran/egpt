import { describe, it, expect } from 'vitest';
import { initWizard, wizardStep, wizardPrompt } from '../src/agent-wizard.mjs';

const opts = { configurations: ['egpt', 'sonnet-high'], models: ['haiku', 'sonnet', 'opus', 'fable'], efforts: ['low', 'medium', 'high'] };
const mk = (extra = {}) => initWizard({ slug: 'spoiler', jid: '!x:beeper.local', surface: 'whatsapp', options: opts, ...extra });

describe('agent wizard (v2: configuration → model → effort)', () => {
  it('walks configuration → model → effort → done', () => {
    let r = wizardStep(mk(), '2');        // configuration → sonnet-high
    r = wizardStep(r.state, '3');         // model → opus
    r = wizardStep(r.state, '3');         // effort → high
    expect(r.done).toBe(true);
    expect(r.result).toMatchObject({ slug: 'spoiler', jid: '!x:beeper.local', surface: 'whatsapp', configuration: 'sonnet-high', model: 'opus', effort: 'high' });
  });

  it('accepts a value by text as well as by number', () => {
    const r = wizardStep(mk(), 'egpt');   // configuration by name
    expect(r.state.answers.configuration).toBe('egpt');
  });

  it('rejects an out-of-range pick and stays on the step', () => {
    const before = mk().idx;
    const r = wizardStep(mk(), '9');      // no configuration 9
    expect(r.state.idx).toBe(before);
    expect(r.prompt).toMatch(/pick 1–2/);
  });

  it('b goes back, x cancels', () => {
    let r = wizardStep(mk(), '1');        // now on model
    r = wizardStep(r.state, 'b');         // back to configuration
    expect(r.state.idx).toBe(0);
    expect(wizardStep(r.state, 'x').cancelled).toBe(true);
  });

  it('wizardPrompt numbers the options', () => {
    expect(wizardPrompt(mk())).toMatch(/1\) egpt/);
  });

  it('marks the conversation\'s current value with (current)', () => {
    const prompt = wizardPrompt(mk({ current: { configurations: 'egpt' } }));
    expect(prompt).toMatch(/egpt {2}\(current\)/);
  });
});
