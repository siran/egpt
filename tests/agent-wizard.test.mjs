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
    const r = wizardStep(mk(), '9');      // no configuration 9 (2 types + custom = 1–3)
    expect(r.state.idx).toBe(before);
    expect(r.prompt).toMatch(/pick 1–3/);
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

describe('agent wizard: structured-yaml type view + custom branch', () => {
  const yamlOpts = {
    configurations: [
      { name: 'egpt', model: 'sonnet', effort: 'high', personality: 'default' },
      { name: 'default', model: 'sonnet', effort: 'high' },   // omits personality → field hidden
    ],
    models: ['haiku', 'sonnet', 'opus', 'fable'], efforts: ['low', 'medium', 'high'],
    personalities: ['default', 'secretary', 'poet'], takenNames: ['egpt', 'default'],
  };
  const mkY = (extra = {}) => initWizard({ slug: 's', jid: 'j', surface: 'whatsapp', options: yamlOpts, ...extra });

  it('renders each type\'s composition inline, marks current, lists custom last', () => {
    const p = wizardPrompt(mkY({ current: { configurations: 'egpt' } }));
    expect(p).toMatch(/1\) egpt:\s+\(current\)/);
    expect(p).toMatch(/model: sonnet/);
    expect(p).toMatch(/effort: high/);
    expect(p).toMatch(/personality: default/);
    // the 'default' type has no personality field set → it is omitted from ITS block
    expect(p).toMatch(/2\) default:/);
    // custom is always the last option
    expect(p).toMatch(/3\) custom:/);
    expect(p).toMatch(/model → effort → personality → name/);
  });

  it('custom branch: custom → model → effort → personality(free text) → name → done', () => {
    let r = wizardStep(mkY(), '3');            // custom (option 3 = 2 types + custom)
    expect(r.state.mode).toBe('custom');
    r = wizardStep(r.state, '2');              // model → sonnet
    r = wizardStep(r.state, '3');              // effort → high
    // personality step: [default, secretary, poet] + "describe it" = option 4
    expect(r.prompt).toMatch(/personality\?/);
    expect(r.prompt).toMatch(/4\) describe it \(free text\)/);
    r = wizardStep(r.state, '4');              // describe it → free capture
    expect(r.state.freeKey).toBe('personality');
    expect(r.prompt).toMatch(/describe the new agent/);
    r = wizardStep(r.state, 'You are terse.'); // free text → name step
    expect(r.prompt).toMatch(/name the new type/);
    r = wizardStep(r.state, 'Ops Bot');        // name (sanitized → ops-bot)
    expect(r.done).toBe(true);
    expect(r.result).toMatchObject({ custom: true, model: 'sonnet', effort: 'high', personalityText: 'You are terse.', name: 'ops-bot' });
    expect(r.result.personalityLayer).toBe(null);
  });

  it('custom branch: picking an existing personality layer (not free text)', () => {
    let r = wizardStep(mkY(), '3');            // custom
    r = wizardStep(r.state, '1');              // model
    r = wizardStep(r.state, '1');              // effort
    r = wizardStep(r.state, '2');              // personality → secretary (option 2)
    r = wizardStep(r.state, 'newtype');        // name → done
    expect(r.done).toBe(true);
    expect(r.result).toMatchObject({ custom: true, personalityLayer: 'secretary', personalityText: null, name: 'newtype' });
  });

  it('re-prompts when the new type name collides with an existing type', () => {
    let r = wizardStep(mkY(), '3');            // custom
    r = wizardStep(r.state, '1');              // model
    r = wizardStep(r.state, '1');              // effort
    r = wizardStep(r.state, '1');              // personality → default
    r = wizardStep(r.state, 'egpt');           // taken!
    expect(r.done).toBeUndefined();
    expect(r.prompt).toMatch(/name taken/);
    r = wizardStep(r.state, 'fresh');          // ok → done
    expect(r.done).toBe(true);
    expect(r.result.name).toBe('fresh');
  });

  it('b out of the free-text capture returns to the personality pick', () => {
    let r = wizardStep(mkY(), '3');            // custom
    r = wizardStep(r.state, '1');              // model
    r = wizardStep(r.state, '1');              // effort → personality
    r = wizardStep(r.state, '4');              // describe it → free capture
    expect(r.state.freeKey).toBe('personality');
    r = wizardStep(r.state, 'b');              // back out of free capture
    expect(r.state.freeKey).toBe(null);
    expect(r.prompt).toMatch(/personality\?/);
  });

  it('re-picking an existing type after custom flips the branch back', () => {
    let r = wizardStep(mkY(), '3');            // custom → model step (idx 1, mode custom)
    r = wizardStep(r.state, 'b');              // back to type (idx 0)
    r = wizardStep(r.state, '1');              // pick egpt (existing)
    expect(r.state.mode).toBe('existing');
    r = wizardStep(r.state, '2');              // model
    r = wizardStep(r.state, '3');              // effort → done (existing, 3 steps)
    expect(r.done).toBe(true);
    expect(r.result).toMatchObject({ configuration: 'egpt' });
    expect(r.result.custom).toBeUndefined();
  });
});
