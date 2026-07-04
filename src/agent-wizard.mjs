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
// v2 vocabulary: picking an EXISTING agent TYPE (a `configuration`: an agent-type file
// name) IS the answer (operator 2026-07-03) — it applies IMMEDIATELY with the type's
// PINNED model/effort (shown inline in step 1), no separate model/effort steps. Step 1's
// options render each type's COMPOSITION inline (model/effort/personality, structured-yaml
// style) so the operator sees exactly what a pick applies; the conversation's CURRENT value
// is marked `(current)`.
//
// CUSTOM branch (operator 2026-07-03): a final `custom` option (always last in step
// 1) BUILDS a new agent type, named at the END: model → effort → personality → name.
// The personality step lists the available identity layers + a "describe it (free
// text)" option (free text = the operator types behavior instructions the spine saves
// as a new identity layer named after the type). The name step is free text; a name
// that collides with an existing agent type re-prompts.
//
// TOOLS branch (operator 2026-07-03): a `tools` option (second-to-last in step 1, right
// before `custom`) edits ONLY allowed_tools — the current agent type/model/effort are
// untouched. One extra step: a small fixed menu (default / read-only / keep current /
// custom free text). Free text is space-separated tool names, validated here so an
// invalid answer re-prompts instead of freezing garbage; bare `Bash`/`Agent` are always
// rejected (the two escape hatches, never implicit — operator 2026-07-03) and 'all' is
// never one of the choices.
import { sanitizeName } from './sanitize.mjs';
import { DEFAULT_ALLOWED_TOOLS, READONLY_ALLOWED_TOOLS, WRITE_TOOLS } from './claude-args.mjs';

const CFG_STEP     = { key: 'configuration', label: 'agent type?' };                                  // yaml-composition render; tools + custom appended
const MODEL_STEP   = { key: 'model',       label: 'model?',       optKey: 'models' };
const EFFORT_STEP  = { key: 'effort',      label: 'effort?',      optKey: 'efforts' };
const PERSONA_STEP = { key: 'personality', label: 'personality?', optKey: 'personalities', freeText: 'describe it (free text)' };
const NAME_STEP    = { key: 'name',        label: 'name the new type', free: true };
const TOOLS_STEP   = { key: 'tools',       label: 'tools?' };                                         // fixed 4-option menu, hand-rendered

const STEPS_EXISTING = [CFG_STEP];               // picking an existing type IS the answer — its model/effort are pinned
const STEPS_CUSTOM   = [CFG_STEP, MODEL_STEP, EFFORT_STEP, PERSONA_STEP, NAME_STEP];
const STEPS_TOOLS    = [CFG_STEP, TOOLS_STEP];   // keep the current agent type, edit allowed_tools only

const steps = (state) => (state.mode === 'custom' ? STEPS_CUSTOM : state.mode === 'tools' ? STEPS_TOOLS : STEPS_EXISTING);
const CUSTOM_HINT = 'build a new type — model → effort → personality → name';
const TOOLS_HINT = 'change allowed_tools only — keep the current agent type';

// Known tool vocabulary for the tools branch's custom free-text answer (operator
// 2026-07-03): DEFAULT_ALLOWED_TOOLS ∪ the write-class tools DEFAULT omits
// (MultiEdit/NotebookEdit) — one source of truth (claude-args.mjs), not a hand-kept list.
const KNOWN_TOOLS = [...new Set([...DEFAULT_ALLOWED_TOOLS, ...WRITE_TOOLS])];
const SCOPED_BASH_RE = /^Bash\(([^()\s]+):\*\)$/;

// Validate a tools-branch custom free-text answer: space-separated tool names, each
// either a KNOWN_TOOLS member or a scoped `Bash(<bin>:*)` rule (never a `Bash(*:*)`
// wildcard — that's bare Bash by another name). Bare `Bash`/`Agent` are rejected
// explicitly, not silently dropped, so a typo doesn't quietly narrow scope. Returns
// { tools: [...] } or { error: 'reason' }.
function parseCustomTools(text) {
  const tokens = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { error: 'type at least one tool name' };
  const out = [];
  for (const raw of tokens) {
    if (/^(bash|agent)$/i.test(raw)) return { error: `bare "${raw}" isn't allowed — use a scoped Bash(<bin>:*) rule instead` };
    const known = KNOWN_TOOLS.find((k) => k.toLowerCase() === raw.toLowerCase());
    if (known) { out.push(known); continue; }
    const scoped = raw.match(SCOPED_BASH_RE);
    if (scoped && scoped[1] !== '*') { out.push(raw); continue; }
    return { error: `unknown tool "${raw}" — known: ${KNOWN_TOOLS.join(' ')}, or Bash(<bin>:*)` };
  }
  return { tools: out };
}

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
  out.push(`  ${cfgs.length + 1}) tools:  (${TOOLS_HINT})`);
  out.push(`  ${cfgs.length + 2}) custom:  (${CUSTOM_HINT})`);
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

// The tools branch's fixed 4-option menu — a numbered pick, but each option shows its
// actual composition (like renderConfig does for agent types) rather than a bare name.
// 'keep current' shows the conversation's live (already-coerced — never 'all') list, or
// '?' pre-instance.
function renderTools(state, n, total) {
  const cur = state.current?.tools ?? null;
  const curTxt = Array.isArray(cur) && cur.length ? cur.join(' ') : '?';
  const out = [`${n}/${total}  tools?`];
  out.push(`  1) default:  ${DEFAULT_ALLOWED_TOOLS.join(' ')}`);
  out.push(`  2) read-only:  ${READONLY_ALLOWED_TOOLS.join(' ')}`);
  out.push(`  3) keep current:  ${curTxt}`);
  out.push('  4) custom:  (space-separated tool names)');
  out.push('  (number · b back · x cancel)');
  return out.join('\n');
}

const renderName = (n, total) => `${n}/${total}  name the new type (type it) — names the new agent-type file.\n  (b back · x cancel)`;
const renderFreePersona = () => 'describe the new agent — who it is, how it behaves, its tone (type it).\n  (b back · x cancel)';
const renderFreeTools = () => `type space-separated tool names — known: ${KNOWN_TOOLS.join(' ')}, or a scoped Bash(<bin>:*) rule (bare Bash/Agent rejected).\n  (b back · x cancel)`;

export function wizardPrompt(state) {
  if (state.freeKey === 'personality') return renderFreePersona();
  if (state.freeKey === 'tools') return renderFreeTools();
  const list = steps(state);
  const n = state.idx + 1, total = list.length, step = list[state.idx];
  if (step.key === 'configuration') return renderConfig(state, n, total);
  if (step.key === 'tools') return renderTools(state, n, total);
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
  if (state.mode === 'tools') {
    return { ...base, toolsOnly: true, tools: a.tools, toolsCustom: a.toolsCustom ?? null };
  }
  // Existing pick: the configuration + its pinned model/effort (captured from the picked
  // option's composition; null when the option carried none → the spine applies the floor).
  return { ...base, configuration: a.configuration, model: a.model ?? null, effort: a.effort ?? null };
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

  // Free-text capture pending (tools branch "custom"): validate the space-separated
  // tool list; an invalid answer re-prompts with the reason INSTEAD of advancing, so a
  // bad list is never frozen.
  if (state.freeKey === 'tools') {
    if (!t) return { state, prompt: 'type space-separated tool names (or b back · x cancel)\n' + renderFreeTools() };
    const parsed = parseCustomTools(t);
    if (parsed.error) return { state, prompt: `${parsed.error} (or b back · x cancel)\n` + renderFreeTools() };
    const answers = { ...state.answers, tools: 'custom', toolsCustom: parsed.tools };
    return advance({ ...state, freeKey: null, answers });
  }

  const list = steps(state);
  const step = list[state.idx];

  // Step 1 — agent type (branching): a real type continues the existing flow; `tools`
  // switches into the tools-only branch; the final `custom` option switches into the
  // build-a-new-type branch (custom stays LAST — tools sits just before it).
  if (step.key === 'configuration') {
    const cfgs = state.options.configurations ?? [];
    const toolsPos = cfgs.length + 1;
    const customPos = cfgs.length + 2;
    let picked = null, isCustom = false, isTools = false;
    if (/^\d+$/.test(t)) {
      const k = parseInt(t, 10);
      if (k === customPos) isCustom = true;
      else if (k === toolsPos) isTools = true;
      else if (k >= 1 && k <= cfgs.length) picked = cfgs[k - 1];
    } else if (t.toLowerCase() === 'custom') {
      isCustom = true;
    } else if (t.toLowerCase() === 'tools') {
      isTools = true;
    } else {
      picked = cfgs.find((o) => optName(o).toLowerCase() === t.toLowerCase()) ?? null;
    }
    if (isCustom) return advance({ ...state, mode: 'custom', answers: { ...state.answers, configuration: 'custom' } });
    if (isTools) return advance({ ...state, mode: 'tools', answers: { ...state.answers, configuration: null } });
    if (!picked) return { state, prompt: `pick 1–${customPos} (or b back · x cancel)\n` + wizardPrompt(state) };
    // Existing pick applies immediately (mode existing = 1 step): capture the picked type's
    // pinned model/effort from its composition so the result is self-describing.
    const fields = typeof picked === 'string' ? {} : (picked ?? {});
    return advance({ ...state, mode: 'existing', answers: { ...state.answers, configuration: optName(picked), model: fields.model ?? null, effort: fields.effort ?? null } });
  }

  // Step 2 (tools branch only) — the fixed 4-option menu: default / read-only / keep
  // current / custom (free text, captured above via freeKey). The picked KEYWORD is
  // resolved to an actual tool list by the caller (which knows the conversation's
  // current frozen value) — this state machine stays tool-list-agnostic.
  if (step.key === 'tools') {
    const menu = ['default', 'readonly', 'current'];
    const freePos = menu.length + 1;
    if ((/^\d+$/.test(t) && parseInt(t, 10) === freePos) || /^custom$/i.test(t)) {
      const ns = { ...state, freeKey: 'tools' };
      return { state: ns, prompt: renderFreeTools() };
    }
    let picked = null;
    if (/^\d+$/.test(t)) { const k = parseInt(t, 10); if (k >= 1 && k <= menu.length) picked = menu[k - 1]; }
    else if (/^read-?only$/i.test(t)) picked = 'readonly';
    else if (/^keep current$/i.test(t)) picked = 'current';
    else if (menu.includes(t.toLowerCase())) picked = t.toLowerCase();
    if (!picked) return { state, prompt: `pick 1–${freePos} (or b back · x cancel)\n` + wizardPrompt(state) };
    return advance({ ...state, answers: { ...state.answers, tools: picked } });
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
