import { describe, it, expect } from 'vitest';
import { initWizard, wizardStep, wizardPrompt } from '../src/agent-wizard.mjs';

// Bare-name options (no inline composition) — the fallback render.
const opts = { configurations: ['egpt', 'sonnet-high'], models: ['haiku', 'sonnet', 'opus', 'fable'], efforts: ['low', 'medium', 'high'] };
const mk = (extra = {}) => initWizard({ slug: 'spoiler', jid: '!x:beeper.local', surface: 'whatsapp', options: opts, ...extra });

// Composition options — each type carries its PINNED model/effort (what a pick applies).
const compOpts = {
  configurations: [{ name: 'egpt', model: 'sonnet', effort: 'high' }, { name: 'sonnet-high', model: 'opus', effort: 'high' }],
  models: ['haiku', 'sonnet', 'opus', 'fable'], efforts: ['low', 'medium', 'high'],
};
const mkC = (extra = {}) => initWizard({ slug: 'spoiler', jid: '!x:beeper.local', surface: 'whatsapp', options: compOpts, ...extra });

describe('agent wizard (v2: picking an existing type applies immediately)', () => {
  it('picking an existing type IS the answer — done in ONE step, carrying its pinned model/effort', () => {
    const r = wizardStep(mkC(), '2');     // sonnet-high → done
    expect(r.done).toBe(true);
    expect(r.result).toMatchObject({ slug: 'spoiler', jid: '!x:beeper.local', surface: 'whatsapp', configuration: 'sonnet-high', model: 'opus', effort: 'high' });
  });

  it('a bare-name type (no composition) applies with null model/effort (the spine fills the floor)', () => {
    const r = wizardStep(mk(), '1');      // egpt (bare) → done
    expect(r.done).toBe(true);
    expect(r.result).toMatchObject({ configuration: 'egpt', model: null, effort: null });
  });

  it('accepts a value by text as well as by number', () => {
    const r = wizardStep(mk(), 'egpt');   // configuration by name → done immediately
    expect(r.done).toBe(true);
    expect(r.result.configuration).toBe('egpt');
  });

  it('rejects an out-of-range pick and stays on the step', () => {
    const before = mk().idx;
    const r = wizardStep(mk(), '9');      // no configuration 9 (2 types + tools + custom = 1–4)
    expect(r.state.idx).toBe(before);
    expect(r.prompt).toMatch(/pick 1–4/);
  });

  it('b goes back, x cancels (through the custom branch, which still has multiple steps)', () => {
    let r = wizardStep(mk(), '4');        // custom (2 types + tools + custom = option 4) → model step
    expect(r.state.idx).toBe(1);
    expect(r.state.mode).toBe('custom');
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
    // tools sits just before custom, which is always the last option
    expect(p).toMatch(/3\) tools:/);
    expect(p).toMatch(/4\) custom:/);
    expect(p).toMatch(/model → effort → personality → name/);
  });

  it('picking an existing type from the yaml view applies immediately with its pinned values', () => {
    const r = wizardStep(mkY(), '1');          // egpt → done
    expect(r.done).toBe(true);
    expect(r.result).toMatchObject({ configuration: 'egpt', model: 'sonnet', effort: 'high' });
    expect(r.result.custom).toBeUndefined();
  });

  it('custom branch: custom → model → effort → personality(free text) → name → done', () => {
    let r = wizardStep(mkY(), '4');            // custom (option 4 = 2 types + tools + custom)
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
    let r = wizardStep(mkY(), '4');            // custom
    r = wizardStep(r.state, '1');              // model
    r = wizardStep(r.state, '1');              // effort
    r = wizardStep(r.state, '2');              // personality → secretary (option 2)
    r = wizardStep(r.state, 'newtype');        // name → done
    expect(r.done).toBe(true);
    expect(r.result).toMatchObject({ custom: true, personalityLayer: 'secretary', personalityText: null, name: 'newtype' });
  });

  it('re-prompts when the new type name collides with an existing type', () => {
    let r = wizardStep(mkY(), '4');            // custom
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
    let r = wizardStep(mkY(), '4');            // custom
    r = wizardStep(r.state, '1');              // model
    r = wizardStep(r.state, '1');              // effort → personality
    r = wizardStep(r.state, '4');              // describe it → free capture
    expect(r.state.freeKey).toBe('personality');
    r = wizardStep(r.state, 'b');              // back out of free capture
    expect(r.state.freeKey).toBe(null);
    expect(r.prompt).toMatch(/personality\?/);
  });

  it('re-picking an existing type after custom flips the branch back and applies immediately', () => {
    let r = wizardStep(mkY(), '4');            // custom → model step (idx 1, mode custom)
    r = wizardStep(r.state, 'b');              // back to type (idx 0, mode still custom)
    r = wizardStep(r.state, '1');              // pick egpt (existing) → DONE immediately
    expect(r.done).toBe(true);
    expect(r.result).toMatchObject({ configuration: 'egpt', model: 'sonnet', effort: 'high' });
    expect(r.result.custom).toBeUndefined();
  });
});

describe('agent wizard: tools branch', () => {
  const yamlOpts = {
    configurations: [{ name: 'egpt', model: 'sonnet', effort: 'high' }, { name: 'default', model: 'sonnet', effort: 'high' }],
    models: ['haiku', 'sonnet', 'opus', 'fable'], efforts: ['low', 'medium', 'high'],
  };
  const mkT = (extra = {}) => initWizard({ slug: 's', jid: 'j', surface: 'whatsapp', options: yamlOpts, ...extra });

  it('the "tools" option sits right before custom (3 with 2 configs) and shows the fixed 4-option menu', () => {
    let r = wizardStep(mkT(), '3');
    expect(r.state.mode).toBe('tools');
    expect(r.state.idx).toBe(1);
    expect(r.prompt).toMatch(/2\/2  tools\?/);
    expect(r.prompt).toMatch(/1\) default:.*Read.*Write.*Edit/);
    expect(r.prompt).toMatch(/2\) read-only:.*Read.*Glob.*Grep/);
    expect(r.prompt).toMatch(/3\) keep current:/);
    expect(r.prompt).toMatch(/4\) custom:/);
    expect(r.prompt).not.toMatch(/\ball\b/i);   // 'all' is never one of the choices
  });

  it('picking "default" (1) is done immediately, tools = \'default\'', () => {
    let r = wizardStep(mkT(), '3');
    r = wizardStep(r.state, '1');
    expect(r.done).toBe(true);
    expect(r.result).toMatchObject({ toolsOnly: true, tools: 'default', toolsCustom: null });
  });

  it('picking "read-only" (2), tools = \'readonly\'', () => {
    let r = wizardStep(mkT(), '3');
    r = wizardStep(r.state, '2');
    expect(r.done).toBe(true);
    expect(r.result.tools).toBe('readonly');
  });

  it('picking "keep current" (3), tools = \'current\'', () => {
    let r = wizardStep(mkT(), '3');
    r = wizardStep(r.state, '3');
    expect(r.done).toBe(true);
    expect(r.result.tools).toBe('current');
  });

  it('"keep current" shows the conversation\'s live list', () => {
    const r = wizardStep(mkT({ current: { tools: ['Read', 'Grep'] } }), '3');
    expect(r.prompt).toMatch(/3\) keep current:  Read Grep/);
  });

  it('custom (4) free-text: a valid space-separated list is frozen verbatim', () => {
    let r = wizardStep(mkT(), '3');
    r = wizardStep(r.state, '4');
    expect(r.state.freeKey).toBe('tools');
    r = wizardStep(r.state, 'Read Grep WebFetch Bash(git:*)');
    expect(r.done).toBe(true);
    expect(r.result).toMatchObject({ toolsOnly: true, tools: 'custom', toolsCustom: ['Read', 'Grep', 'WebFetch', 'Bash(git:*)'] });
  });

  it('custom free-text rejects a bare "Bash" and re-prompts (stays in free capture)', () => {
    let r = wizardStep(mkT(), '3');
    r = wizardStep(r.state, '4');
    r = wizardStep(r.state, 'Read Bash');
    expect(r.done).toBeUndefined();
    expect(r.state.freeKey).toBe('tools');
    expect(r.prompt).toMatch(/bare "Bash" isn't allowed/);
  });

  it('custom free-text rejects a bare "Agent" and re-prompts', () => {
    let r = wizardStep(mkT(), '3');
    r = wizardStep(r.state, '4');
    r = wizardStep(r.state, 'Agent');
    expect(r.done).toBeUndefined();
    expect(r.prompt).toMatch(/bare "Agent" isn't allowed/);
  });

  it('custom free-text rejects an unknown tool name and re-prompts', () => {
    let r = wizardStep(mkT(), '3');
    r = wizardStep(r.state, '4');
    r = wizardStep(r.state, 'Frobnicate');
    expect(r.done).toBeUndefined();
    expect(r.prompt).toMatch(/unknown tool "Frobnicate"/);
  });

  it('custom free-text rejects a wildcard Bash(*:*) — not a real scoped bin', () => {
    let r = wizardStep(mkT(), '3');
    r = wizardStep(r.state, '4');
    r = wizardStep(r.state, 'Bash(*:*)');
    expect(r.done).toBeUndefined();
    expect(r.prompt).toMatch(/unknown tool/);
  });

  it('b out of the free-text capture returns to the tools menu', () => {
    let r = wizardStep(mkT(), '3');
    r = wizardStep(r.state, '4');
    expect(r.state.freeKey).toBe('tools');
    r = wizardStep(r.state, 'b');
    expect(r.state.freeKey).toBe(null);
    expect(r.prompt).toMatch(/tools\?/);
  });

  it('b out of the tools step goes back to the agent-type step', () => {
    let r = wizardStep(mkT(), '3');
    r = wizardStep(r.state, 'b');
    expect(r.state.idx).toBe(0);
    expect(r.prompt).toMatch(/agent type\?/);
  });

  it('typed "tools" (not the number) also enters the branch', () => {
    const r = wizardStep(mkT(), 'tools');
    expect(r.state.mode).toBe('tools');
  });
});
