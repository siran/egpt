// agent-wizard.mjs — guided per-conversation resident creation.
//
// Mirrors help-menu's model/step shape: a small state machine the spine arms (per
// chat) and feeds the operator's numbered/typed answers into, until it yields a
// complete resident spec. Renderer-neutral: wizardPrompt() returns plain text;
// wizardStep() advances. No I/O here — the spine writes the resident block on `done`.
//
// Steps: name → brain → model → effort → identity. `name` is free text (type "e" to
// configure the chat's default E — WhatsApp can't send a blank, though blank still
// maps to E); the rest are numbered picks from option lists the spine supplies
// (brains from the siblings/brain registry, models, efforts, identities from identities/).

const STEPS = [
  { key: 'name',        label: 'name / @handle?  (free text · type "e" to configure E)', free: true },
  { key: 'brain',       label: 'brain?',    optKey: 'brains' },
  { key: 'model',       label: 'model?',    optKey: 'models' },
  { key: 'effort',      label: 'effort?',   optKey: 'efforts' },
  { key: 'personality', label: 'identity?', optKey: 'identities' },
];

// options: { brains:[…], models:[…], efforts:[…], identities:[…] }
export function initWizard({ slug, jid, options = {} }) {
  return { slug, jid, options, idx: 0, answers: {} };
}

function numbered(label, opts, n, total) {
  const lines = (opts ?? []).map((o, i) => `  ${i + 1}) ${o}`);
  return `${n}/${total}  ${label}\n${lines.join('\n')}\n  (number · b back · x cancel)`;
}

export function wizardPrompt(state) {
  const s = STEPS[state.idx];
  const n = state.idx + 1, total = STEPS.length;
  if (s.free) return `new agent in «${state.slug}» — ${n}/${total}  ${s.label}`;
  return numbered(s.label, state.options[s.optKey], n, total);
}

// One step. Returns { state, prompt } | { cancelled: true } | { done: true, result }.
export function wizardStep(state, input) {
  const t = String(input ?? '').trim();
  if (/^(x|cancel|q|quit)$/i.test(t)) return { cancelled: true };
  if (/^(b|back)$/i.test(t)) {
    const ns = { ...state, idx: Math.max(0, state.idx - 1) };
    return { state: ns, prompt: wizardPrompt(ns) };
  }
  const s = STEPS[state.idx];
  let value;
  if (s.free) {
    value = t || 'e';
  } else {
    const opts = state.options[s.optKey] ?? [];
    value = /^\d+$/.test(t) ? opts[parseInt(t, 10) - 1] : (opts.find((o) => o.toLowerCase() === t.toLowerCase()) ?? null);
    if (!value) return { state, prompt: `pick 1–${opts.length} (or b back · x cancel)\n` + wizardPrompt(state) };
  }
  const answers = { ...state.answers, [s.key]: value };
  const idx = state.idx + 1;
  if (idx >= STEPS.length) {
    return { done: true, result: {
      slug: state.slug, jid: state.jid,
      name: answers.name, brain: answers.brain, model: answers.model,
      effort: answers.effort, personality: answers.personality,
    } };
  }
  const ns = { ...state, idx, answers };
  return { state: ns, prompt: wizardPrompt(ns) };
}
