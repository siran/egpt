// help-menu.mjs — surface-agnostic interactive help / config menu.
//
// Phone-first but renderer-neutral: the menu is a MODEL (numbered options +
// labels + short hints + leaf detail) and a small navigation state machine.
// `renderText` turns a view into plain numbered lines for shell / WhatsApp /
// Telegram; a future TTS renderer consumes the SAME view object (speak the
// labels by number), and STT feeds the same `step()` input. So phone and voice
// are one model, different renderers.
//
// Built from the interpreter COMMANDS registry + config keys. Navigation:
//   number → drill into a section / open a leaf's detail
//   text   → fuzzy search across commands + config keys
//   0/b    → up one level     q/exit → leave help mode
// Leaves SHOW (command usage, or a config key's doc + how to set it); running /
// setting by number is a later layer (navigate-then-confirm, voice-safe).

const firstLine = (s) => String(s ?? '').split(/(?<=[.!?])\s|\n/)[0].trim();
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

// Build the model. `commands` is the interpreter COMMANDS array (section
// headers interleaved with command descriptors). `configEntries` is
// [{ key, doc }] from the config schema. `surface` filters commands:
// 'shell' (also used for WA/TG, which run via the host) hides extension-only
// commands; 'extension' hides shell-only ones.
export function buildMenu(commands = [], configEntries = [], { surface = 'shell' } = {}) {
  const entries = [];
  let section = 'MISC';
  for (const c of commands) {
    // A header row carries `section` and no `cmd`. A command descriptor may
    // ALSO carry its own `section` (slash-file metas do, for grouping) — that
    // names its section directly, it is NOT a header.
    if (c.section && !c.cmd) { section = c.section; continue; }
    if (!c.cmd) continue;
    if (c.surface && c.surface !== 'both' && c.surface !== surface) continue;
    const sec = c.section || section;
    // A command may declare subcommands ([{ name, usage, desc }]) — used by
    // slash-file commands like /e whose verbs (source, auto, residents…) are
    // otherwise invisible. Subs become drillable leaves under the parent and
    // are searchable in their own right.
    const subs = Array.isArray(c.subs) ? c.subs.map(s => ({
      kind: 'command', id: `${c.cmd} ${s.name}`, label: `${c.cmd} ${s.name}`,
      section: sec, usage: s.usage ?? `${c.cmd} ${s.name}`, desc: s.desc ?? '', parentId: c.cmd,
    })) : [];
    entries.push({ kind: 'command', id: c.cmd, label: c.cmd, section: sec, usage: c.usage ?? c.cmd, desc: c.desc ?? '', subs });
  }
  for (const e of configEntries) {
    if (!e?.key) continue;
    entries.push({ kind: 'config', id: `cfg:${e.key}`, label: e.key, section: 'CONFIG', usage: `/config ${e.key} [value]`, desc: e.doc ?? '', subs: [] });
  }
  const sections = [];
  for (const e of entries) if (!sections.includes(e.section)) sections.push(e.section);
  // Flat id→entry index that also reaches subs, so detail/search can resolve a
  // subcommand id even though it isn't a top-level section member.
  const index = new Map();
  for (const e of entries) { index.set(e.id, e); for (const s of e.subs) index.set(s.id, s); }
  return { entries, sections, surface, index };
}

export const initState = () => ({ stack: [{ mode: 'top' }] });
const cur = (state) => state.stack[state.stack.length - 1] ?? { mode: 'top' };

function matches(model, term) {
  const n = term.toLowerCase();
  const hit = (e) =>
    e.label.toLowerCase().includes(n) ||
    e.usage.toLowerCase().includes(n) ||
    e.desc.toLowerCase().includes(n);
  const out = [];
  for (const e of model.entries) {
    if (hit(e)) out.push(e);
    for (const s of e.subs ?? []) if (hit(s)) out.push(s);
  }
  return out;
}

// A view is renderer-agnostic: { kind, title, footer, lines?, detail? }.
//   lines: [{ n, label, hint, _entry|_section }] — numbered, selectable
//   detail: { label, usage, desc, kind } — a leaf
export function view(model, state) {
  const c = cur(state);
  const atTop = state.stack.length <= 1;
  const footer = atTop
    ? 'reply a number · type to search · q to quit'
    : 'number · type to search · 0 back · q quit';
  if (c.mode === 'detail') {
    const e = model.index?.get(c.id) ?? model.entries.find(x => x.id === c.id);
    return { kind: 'detail', title: e?.label ?? c.id, detail: e ?? null, footer };
  }
  if (c.mode === 'subs') {
    const e = model.index?.get(c.id);
    const subs = e?.subs ?? [];
    return {
      kind: 'subs', title: e?.label ?? c.id,
      lines: subs.map((s, i) => ({ n: i + 1, label: s.label, hint: clip(firstLine(s.desc), 60), _entry: s })),
      footer,
    };
  }
  if (c.mode === 'search') {
    const hits = matches(model, c.term);
    return {
      kind: 'search', title: `"${c.term}" — ${hits.length} match${hits.length === 1 ? '' : 'es'}`,
      lines: hits.map((e, i) => ({ n: i + 1, label: e.label, hint: clip(firstLine(e.desc), 60), _entry: e })),
      footer,
    };
  }
  if (c.mode === 'section') {
    const items = model.entries.filter(e => e.section === c.section);
    return {
      kind: 'section', title: c.section,
      lines: items.map((e, i) => ({
        n: i + 1,
        label: e.subs?.length ? `${e.label} ▸` : e.label,
        hint: clip(firstLine(e.desc), 60), _entry: e,
      })),
      footer,
    };
  }
  // top
  return {
    kind: 'top', title: 'egpt · help',
    lines: model.sections.map((s, i) => ({
      n: i + 1, label: s, hint: `${model.entries.filter(e => e.section === s).length} items`, _section: s,
    })),
    footer,
  };
}

// One navigation step. Returns { state, view } or { exit:true }.
export function step(model, state, input) {
  const t = String(input ?? '').trim();
  if (/^(q|quit|exit)$/i.test(t)) return { exit: true };
  if (/^(0|b|back)$/i.test(t)) {
    const stack = state.stack.length > 1 ? state.stack.slice(0, -1) : state.stack;
    const ns = { stack };
    return { state: ns, view: view(model, ns) };
  }
  if (/^\d+$/.test(t)) {
    const v = view(model, state);
    const sel = v.lines?.[parseInt(t, 10) - 1];
    if (!sel) return { state, view: { ...v, note: `no option ${t}` } };
    const next = sel._section
      ? { mode: 'section', section: sel._section }
      : (sel._entry.subs?.length ? { mode: 'subs', id: sel._entry.id } : { mode: 'detail', id: sel._entry.id });
    const ns = { stack: [...state.stack, next] };
    return { state: ns, view: view(model, ns) };
  }
  if (t) {
    const ns = { stack: [...state.stack, { mode: 'search', term: t }] };
    return { state: ns, view: view(model, ns) };
  }
  return { state, view: view(model, state) };
}

// One-shot fuzzy list (for `/h <term>` without entering the mode).
export function searchView(model, term) {
  const hits = matches(model, String(term ?? ''));
  return {
    kind: 'search', title: `"${term}" — ${hits.length} match${hits.length === 1 ? '' : 'es'}`,
    lines: hits.map((e, i) => ({ n: i + 1, label: e.label, hint: clip(firstLine(e.desc), 70), _entry: e })),
    footer: 'type `/h` to open the menu',
  };
}

// Plain-text renderer (shell / WA / TG). A TTS renderer would consume the same
// `v` and speak label-by-number instead.
export function renderText(v) {
  if (!v) return '';
  if (v.kind === 'detail' && v.detail) {
    const d = v.detail;
    const lines = [d.label, `  ${d.usage}`, d.desc ? `  ${clip(d.desc, 280)}` : null];
    if (d.kind === 'config') lines.push('  (set with: ' + d.usage + ')');
    lines.push('', v.footer);
    return lines.filter(x => x != null).join('\n');
  }
  const head = [v.title + (v.note ? `  (${v.note})` : '')];
  const body = (v.lines ?? []).map(l => ` ${String(l.n).padStart(2)}. ${l.label}${l.hint ? `  — ${l.hint}` : ''}`);
  return [...head, ...body, '', v.footer].join('\n');
}
