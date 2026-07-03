// agent-wizard.mjs — the `/e` wizard: guided RE-POINT of a conversation's E instance.
//
// A small renderer-neutral state machine the spine arms (per chat) and feeds the
// operator's numbered/typed answers into, until it yields a complete brain spec.
// wizardPrompt() returns plain text; wizardStep() advances; there is NO fs/network
// I/O here (only a pure sanitizer import) — the spine writes the conversation's
// `readonly` block on `done` (and evicts its warm session so the next turn respawns
// with the new def), and — for the custom branch — authors the new agent-type + any
// identity-layer files.
//
// v2 vocabulary (operator 2026-07-02): three numbered picks — 1) agent TYPE (a
// `configuration`: an agent-type file name), 2) model, 3) effort. Step 1's options
// render each type's COMPOSITION inline (model/effort/personality, structured-yaml
// style) so the operator sees what they're picking; the conversation's CURRENT value
// is marked `(current)`.
//
// CUSTOM branch (operator 2026-07-03): a final `custom` option (always last in step
// 1) BUILDS a new agent type, named at the END: model → effort → personality → name.
// The personality step lists the available identity layers + a "describe it (free
// text)" option (free text = the operator types behavior instructions the spine saves
// as a new identity layer named after the type). The name step is free text; a name
// that collides with an existing agent type re-prompts.
import { sanitizeName } from './sanitize.mjs';

const CFG_STEP     = { key: 'configuration', label: 'agent type?' };                                  // yaml-composition render; custom appended
const MODEL_STEP   = { key: 'model',       label: 'model?',       optKey: 'models' };
const EFFORT_STEP  = { key: 'effort',      label: 'effort?',      optKey: 'efforts' };
const PERSONA_STEP = { key: 'personality', label: 'personality?', optKey: 'personalities', freeText: 'describe it (free text)' };
const NAME_STEP    = { key: 'name',        label: 'name the new type', free: true };

const STEPS_EXISTING = [CFG_STEP, MODEL_STEP, EFFORT_STEP];
const STEPS_CUSTOM   = [CFG_STEP, MODEL_STEP, EFFORT_STEP, PERSONA_STEP, NAME_STEP];

const steps = (state) => (state.mode === 'custom' ? STEPS_CUSTOM : STEPS_EXISTING);
const CUSTOM_HINT = 'build a new type — model → effort → personality → name';

// options: { configurations:[{ name, model?, effort?, personality? } | 'name'],
//            models:[…], efforts:[…], personalities:[…], takenNames:[…] }
// current (optional): { configurations, models, efforts } — the conversation's present
// value per step, marked `(current)`. `personalities`/`takenNames` feed the custom branch.
export function initWizard({ slug, jid, surface = null, options = {}, current = {} }) {
  return { slug, jid, surface, options, current, idx: 0, answers: {}, mode: 'existing', freeKey: null };
}

const optName = (o) => (typeof o === 'string' ? o : (o?.name ?? ''));

// Step 1 (agent type) — each option's composition inline, custom last.
function renderConfig(state, n, total) {
  const cfgs = state.options.configurations ?? [];
  const cur = state.current?.configurations ?? null;
  const out = [`${n}/${total}  agent type?`];
  cfgs.forEach((o, i) => {
    const name = optName(o);
    const fields = typeof o === 'string' ? {} : (o ?? {});
    const marker = cur != null && name === cur ? '  (current)' : '';
    const comp = ['model', 'effort', 'personality'].filter((k) => fields[k] != null);
    out.push(comp.length ? `  ${i + 1}) ${name}:${marker}` : `  ${i + 1}) ${name}${marker}`);
    for (const k of comp) out.push(`       ${k}: ${fields[k]}`);
  });
  out.push(`  ${cfgs.length + 1}) custom:  (${CUSTOM_HINT})`);
  out.push('  (number · b back · x cancel)');
  return out.join('\n');
}

// A plain numbered pick (model / effort / personality). `freeText`, when set, appends
// a final free-text option.
function renderPick(state, step, n, total) {
  const opts = state.options[step.optKey] ?? [];
  const cur = state.current?.[step.optKey] ?? null;
  const out = [`${n}/${total}  ${step.label}`];
  opts.forEach((o, i) => out.push(`  ${i + 1}) ${o}${cur === o ? '  (current)' : ''}`));
  if (step.freeText) out.push(`  ${opts.length + 1}) ${step.freeText}`);
  out.push('  (number · b back · x cancel)');
  return out.join('\n');
}

const renderName = (n, total) => `${n}/${total}  name the new type (type it) — names the new agent-type file.\n  (b back · x cancel)`;
const renderFreePersona = () => 'describe the new agent — who it is, how it behaves, its tone (type it).\n  (b back · x cancel)';

export function wizardPrompt(state) {
  if (state.freeKey === 'personality') return renderFreePersona();
  const list = steps(state);
  const n = state.idx + 1, total = list.length, step = list[state.idx];
  if (step.key === 'configuration') return renderConfig(state, n, total);
  if (step.free) return renderName(n, total);
  return renderPick(state, step, n, total);
}

// Advance idx (recomputing the step list for the CURRENT mode), or finish.
function advance(state) {
  const idx = state.idx + 1;
  if (idx >= steps(state).length) return { done: true, result: buildResult(state) };
  const ns = { ...state, idx };
  return { state: ns, prompt: wizardPrompt(ns) };
}

function buildResult(state) {
  const a = state.answers;
  const base = { slug: state.slug, jid: state.jid, surface: state.surface };
  if (state.mode === 'custom') {
    return { ...base, custom: true, model: a.model, effort: a.effort,
             personalityLayer: a.personality ?? null, personalityText: a.personalityText ?? null, name: a.name };
  }
  return { ...base, configuration: a.configuration, model: a.model, effort: a.effort };
}

// One step. Returns { state, prompt } | { cancelled: true } | { done: true, result }.
export function wizardStep(state, input) {
  const t = String(input ?? '').trim();
  if (/^(x|cancel|q|quit)$/i.test(t)) return { cancelled: true };
  if (/^(b|back)$/i.test(t)) {
    if (state.freeKey) { const ns = { ...state, freeKey: null }; return { state: ns, prompt: wizardPrompt(ns) }; }
    const ns = { ...state, idx: Math.max(0, state.idx - 1) };
    return { state: ns, prompt: wizardPrompt(ns) };
  }

  // Free-text capture pending (personality "describe it"): store the raw instructions
  // and leave the layer name null (the spine names the layer after the type).
  if (state.freeKey === 'personality') {
    if (!t) return { state, prompt: 'type a description (or b back · x cancel)\n' + renderFreePersona() };
    const answers = { ...state.answers, personalityText: t, personality: null };
    return advance({ ...state, freeKey: null, answers });
  }

  const list = steps(state);
  const step = list[state.idx];

  // Step 1 — agent type (branching): a real type continues the existing flow; the
  // final `custom` option switches into the build-a-new-type branch.
  if (step.key === 'configuration') {
    const cfgs = state.options.configurations ?? [];
    const customPos = cfgs.length + 1;
    let picked = null, isCustom = false;
    if (/^\d+$/.test(t)) {
      const k = parseInt(t, 10);
      if (k === customPos) isCustom = true;
      else if (k >= 1 && k <= cfgs.length) picked = cfgs[k - 1];
    } else if (t.toLowerCase() === 'custom') {
      isCustom = true;
    } else {
      picked = cfgs.find((o) => optName(o).toLowerCase() === t.toLowerCase()) ?? null;
    }
    if (isCustom) return advance({ ...state, mode: 'custom', answers: { ...state.answers, configuration: 'custom' } });
    if (!picked) return { state, prompt: `pick 1–${customPos} (or b back · x cancel)\n` + wizardPrompt(state) };
    return advance({ ...state, mode: 'existing', answers: { ...state.answers, configuration: optName(picked) } });
  }

  // Free step — the new type's name (custom branch). Collision with an existing type
  // re-prompts; the name is sanitized so the wizard's check matches the file it becomes.
  if (step.free) {
    const clean = sanitizeName(t);
    if (!clean) return { state, prompt: `type a name (or x cancel)\n` + wizardPrompt(state) };
    const taken = (state.options.takenNames ?? []).map((x) => String(x).toLowerCase());
    if (taken.includes(clean.toLowerCase())) return { state, prompt: 'name taken — pick another (or x cancel)' };
    return advance({ ...state, answers: { ...state.answers, name: clean } });
  }

  // Numbered pick (model / effort / personality), with an optional trailing free-text option.
  const opts = state.options[step.optKey] ?? [];
  const freePos = step.freeText ? opts.length + 1 : null;
  if (step.freeText && ((/^\d+$/.test(t) && parseInt(t, 10) === freePos) || t.toLowerCase() === step.freeText.toLowerCase())) {
    const ns = { ...state, freeKey: step.key };
    return { state: ns, prompt: renderFreePersona() };
  }
  const value = /^\d+$/.test(t) ? opts[parseInt(t, 10) - 1] : (opts.find((o) => o.toLowerCase() === t.toLowerCase()) ?? null);
  if (!value) return { state, prompt: `pick 1–${freePos ?? opts.length} (or b back · x cancel)\n` + wizardPrompt(state) };
  return advance({ ...state, answers: { ...state.answers, [step.key]: value } });
}
