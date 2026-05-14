// slash/egpt.mjs — manage the @egpt persona's session-history state.
//
// Subcommands:
//   status (default)
//   brain [<type> [<ref>]]
//   list
//   new
//   rewind [<n>|<ref-prefix>]
//
// Pure persona logic lives in persona-state.mjs (tested in
// tests/persona-state.test.mjs); this handler is just I/O.

import { startNew, rewind as rewindFn, listHistory, summarize, setBrain } from '../persona-state.mjs';

export const meta = {
  cmd: '/egpt',
  section: 'PERSONA',
  surface: 'shell',
  usage: '/egpt [status | new | list | brain <type> [<ref>] | rewind [<n>|<ref-prefix>]]',
  desc: 'manage @egpt persona session-history state',
};

export async function run({ arg, ctx }) {
  // ctx keys consumed:
  //   sysOut(text)
  //   readDefaultBrainState()                    — read persisted state
  //   persistDefaultBrainState(next)             — write
  //   canonicalBrainName(s) / brainForName(s)    — type lookups
  //   humanAge(ts)                               — '5m ago' formatter
  const { sysOut, readDefaultBrainState, persistDefaultBrainState,
          canonicalBrainName, brainForName, humanAge } = ctx;

  const parts = arg.trim().split(/\s+/);
  const sub = (parts[0] || 'status').toLowerCase();
  const subArg = parts.slice(1).join(' ').trim();
  const state = readDefaultBrainState();

  if (sub === 'help') {
    sysOut('usage: /egpt [status | new | list | brain <type> [<ref>] | rewind [<n>|<ref-prefix>]]');
    return true;
  }
  if (sub === 'status') {
    const sum = summarize(state);
    const kind = sum.activeKind ? ` (${sum.activeKind})` : '';
    sysOut(`egpt: ${sum.type}${kind}  active=${sum.activeShort}  history=${sum.historyCount}`);
    return true;
  }
  if (sub === 'brain') {
    const newType = (parts[1] || '').trim();
    const ref     = parts.slice(2).join(' ').trim();
    if (!newType) {
      const sum = summarize(state);
      sysOut(`egpt brain: ${sum.type}  active=${sum.activeShort}  (use /egpt brain <type> [<ref>] to switch)`);
      return true;
    }
    const canonical = canonicalBrainName(newType);
    const brain = brainForName(canonical);
    if (!brain) { sysOut(`!! /egpt brain: unknown brain "${newType}"`); return true; }
    const next = setBrain(state, canonical, ref || null);
    await persistDefaultBrainState(next);
    const sum = summarize(next);
    sysOut(`egpt: brain → ${sum.type}${sum.activeShort && sum.activeFull
      ? `  active=${sum.activeShort}`
      : ' (no ref — next @e starts fresh)'}`);
    return true;
  }
  if (sub === 'list') {
    const list = listHistory(state);
    if (!list.length) { sysOut('egpt: no sessions yet'); return true; }
    const lines = list.map(h => {
      const age = humanAge(h.at);
      const marker = h.isActive ? '*' : ' ';
      return `${marker} ${String(h.index).padStart(2)}  ${h.short}  ${h.type.padEnd(11)}  ${age}`;
    });
    sysOut(['egpt: sessions (newest first, * = active):', ...lines].join('\n'));
    return true;
  }
  if (sub === 'new') {
    const next = startNew(state);
    if (next === state) {
      sysOut('egpt: already on a fresh state — next @egpt starts a new thread');
      return true;
    }
    await persistDefaultBrainState(next);
    sysOut('egpt: cleared active session — next @egpt starts a new thread');
    return true;
  }
  if (sub === 'rewind') {
    let target = subArg;
    if (target === '') target = 0;
    else if (/^\d+$/.test(target)) target = parseInt(target, 10);
    try {
      const next = rewindFn(state, target);
      await persistDefaultBrainState(next);
      const sum = summarize(next);
      sysOut(`egpt: rewound to ${sum.activeShort} (${next.type})`);
    } catch (e) {
      sysOut(`!! /egpt rewind: ${e.message}`);
    }
    return true;
  }
  sysOut(`!! /egpt: unknown subcommand "${sub}". usage: /egpt [status | new | list | brain <type> [<ref>] | rewind [<n>|<ref-prefix>]]`);
  return true;
}
