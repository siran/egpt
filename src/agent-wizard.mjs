// agent-wizard.mjs — the `/e` wizard: guided RE-POINT of a conversation's E instance.
//
// A small renderer-neutral state machine the spine arms (per chat) and feeds the
// operator's numbered/typed answers into, until it yields a complete brain spec.
// wizardPrompt() returns plain text; wizardStep() advances; there is NO I/O here —
// the spine writes the conversation's `readonly` block on `done` (and evicts its
// warm session so the next turn respawns with the new def).
//
// v2 vocabulary (operator 2026-07-02, post config-legacy-excision): three numbered
// picks — 1) agent TYPE (a `configuration`: an agent-type file name), 2) model,
// 3) effort. The v1 `name` step is gone (the wizard configures THIS chat's E, not a
// new named resident) and so is the `identity` step (identity is a property of the
// agent TYPE now, not the conversation). Each step's option list is supplied by the
// spine; the conversation's CURRENT value (when known) is marked `(current)`.

const STEPS = [
  { key: 'configuration', label: 'agent type?', optKey: 'configurations' },
  { key: 'model',         label: 'model?',      optKey: 'models' },
  { key: 'effort',        label: 'effort?',     optKey: 'efforts' },
];

// options: { configurations:[…], models:[…], efforts:[…] }
// current (optional): { configurations, models, efforts } — the conversation's
// present value per step, marked `(current)` in the rendered list.
export function initWizard({ slug, jid, surface = null, options = {}, current = {} }) {
  return { slug, jid, surface, options, current, idx: 0, answers: {} };
}

function numbered(label, opts, n, total, currentVal) {
  const lines = (opts ?? []).map((o, i) => `  ${i + 1}) ${o}${o === currentVal ? '  (current)' : ''}`);
  return `${n}/${total}  ${label}\n${lines.join('\n')}\n  (number · b back · x cancel)`;
}

export function wizardPrompt(state) {
  const s = STEPS[state.idx];
  const n = state.idx + 1, total = STEPS.length;
  return numbered(s.label, state.options[s.optKey], n, total, state.current?.[s.optKey]);
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
  const opts = state.options[s.optKey] ?? [];
  const value = /^\d+$/.test(t) ? opts[parseInt(t, 10) - 1] : (opts.find((o) => o.toLowerCase() === t.toLowerCase()) ?? null);
  if (!value) return { state, prompt: `pick 1–${opts.length} (or b back · x cancel)\n` + wizardPrompt(state) };
  const answers = { ...state.answers, [s.key]: value };
  const idx = state.idx + 1;
  if (idx >= STEPS.length) {
    return { done: true, result: {
      slug: state.slug, jid: state.jid, surface: state.surface,
      configuration: answers.configuration, model: answers.model, effort: answers.effort,
    } };
  }
  const ns = { ...state, idx, answers };
  return { state: ns, prompt: wizardPrompt(ns) };
}
