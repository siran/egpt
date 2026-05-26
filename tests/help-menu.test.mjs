// Surface-agnostic help menu: model build (surface filter + config keys),
// navigation state machine (drill / search / back / quit), and the text render.
import { describe, it, expect } from 'vitest';
import { buildMenu, initState, view, step, searchView, renderText } from '../src/help-menu.mjs';

const CMDS = [
  { section: 'ROOM' },
  { cmd: '/rules',  surface: 'shell',     usage: '/rules',  desc: 'write room etiquette' },
  { cmd: '/clear',  surface: 'extension', usage: '/clear',  desc: 'clear display' },
  { cmd: '/channels', surface: 'both',    usage: '/channels [N]', desc: 'list WA chats. Pinned float.' },
  { section: 'PERSONA' },
  { cmd: '/e', surface: 'both', usage: '/e ...', desc: 'conversation-e controls', subs: [
    { name: 'source', usage: '/e source [<path>]', desc: 'which checkout the daemon runs' },
    { name: 'auto',   usage: '/e auto <mode>',     desc: 'per-chat reply mode' },
  ] },
  { section: 'MISC' },
  { cmd: '/config', surface: 'both',      usage: '/config [key [value]]', desc: 'read or write config' },
];
const CFG = [{ key: 'theme', doc: 'color theme name' }, { key: 'auto_e_modes', doc: 'per-chat mode map' }];

describe('buildMenu', () => {
  it('filters by surface (shell hides extension-only) and folds in config keys', () => {
    const m = buildMenu(CMDS, CFG, { surface: 'shell' });
    const labels = m.entries.map(e => e.label);
    expect(labels).toContain('/rules');       // shell
    expect(labels).toContain('/channels');    // both
    expect(labels).not.toContain('/clear');   // extension-only → hidden
    expect(labels).toContain('theme');        // config key
    expect(m.sections).toEqual(['ROOM', 'PERSONA', 'MISC', 'CONFIG']);
  });
  it('extension surface hides shell-only', () => {
    const m = buildMenu(CMDS, [], { surface: 'extension' });
    const labels = m.entries.map(e => e.label);
    expect(labels).toContain('/clear');
    expect(labels).not.toContain('/rules');
  });
});

describe('navigation', () => {
  const m = buildMenu(CMDS, CFG, { surface: 'shell' });
  it('top lists sections; a number drills into one; another opens a leaf detail', () => {
    let st = initState();
    const top = view(m, st);
    expect(top.kind).toBe('top');
    expect(top.lines.map(l => l.label)).toEqual(['ROOM', 'PERSONA', 'MISC', 'CONFIG']);

    let r = step(m, st, '1');              // ROOM
    expect(r.view.kind).toBe('section');
    expect(r.view.title).toBe('ROOM');
    expect(r.view.lines.map(l => l.label)).toEqual(['/rules', '/channels']);

    r = step(m, r.state, '1');             // /rules detail
    expect(r.view.kind).toBe('detail');
    expect(r.view.detail.label).toBe('/rules');

    r = step(m, r.state, '0');             // back to ROOM
    expect(r.view.kind).toBe('section');
    expect(r.view.title).toBe('ROOM');
  });
  it('text searches across commands + config keys', () => {
    const r = step(m, initState(), 'config');
    expect(r.view.kind).toBe('search');
    const labels = r.view.lines.map(l => l.label);
    expect(labels).toContain('/config');
    expect(labels).toContain('auto_e_modes');  // matched via desc "per-chat mode map"? no — via key
  });
  it('q exits', () => {
    expect(step(m, initState(), 'q')).toEqual({ exit: true });
    expect(step(m, initState(), 'quit')).toEqual({ exit: true });
  });
  it('an out-of-range number is a no-op with a note', () => {
    const r = step(m, initState(), '99');
    expect(r.view.note).toMatch(/no option 99/);
    expect(r.state).toEqual(initState());
  });
});

describe('subcommands', () => {
  const m = buildMenu(CMDS, CFG, { surface: 'shell' });
  it('drills a command with subs into its verbs, then a leaf detail', () => {
    let r = step(m, initState(), '2');     // PERSONA
    expect(r.view.title).toBe('PERSONA');
    // /e carries subs → label gets the ▸ drill marker
    expect(r.view.lines[0].label).toBe('/e ▸');
    r = step(m, r.state, '1');             // /e → subs view
    expect(r.view.kind).toBe('subs');
    expect(r.view.lines.map(l => l.label)).toEqual(['/e source', '/e auto']);
    r = step(m, r.state, '1');             // /e source detail
    expect(r.view.kind).toBe('detail');
    expect(r.view.detail.label).toBe('/e source');
    expect(r.view.detail.usage).toMatch(/\/e source/);
  });
  it('search reaches into subcommands', () => {
    const v = searchView(m, 'checkout');     // only in /e source desc
    expect(v.lines.map(l => l.label)).toContain('/e source');
  });
});

describe('searchView (one-shot /h <term>)', () => {
  it('lists matches without state', () => {
    const m = buildMenu(CMDS, CFG, { surface: 'shell' });
    const v = searchView(m, 'theme');
    expect(v.kind).toBe('search');
    expect(v.lines.map(l => l.label)).toContain('theme');
  });
});

describe('renderText', () => {
  const m = buildMenu(CMDS, CFG, { surface: 'shell' });
  it('renders a numbered top view + footer', () => {
    const out = renderText(view(m, initState()));
    expect(out).toMatch(/1\. ROOM/);
    expect(out).toMatch(/quit/);
  });
  it('renders a leaf detail with usage', () => {
    let r = step(m, initState(), '1'); r = step(m, r.state, '1');   // /rules detail
    const out = renderText(r.view);
    expect(out).toMatch(/\/rules/);
    expect(out).toMatch(/write room etiquette/);
  });
});
