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

export async function run({ arg, meta, ctx }) {
  // ctx keys consumed:
  //   sysOut(text)
  //   readDefaultBrainState()                    — read persisted state
  //   persistDefaultBrainState(next)             — write
  //   canonicalBrainName(s) / brainForName(s)    — type lookups
  //   humanAge(ts)                               — '5m ago' formatter
  //   EGPT_CONFIG, injectIdentityIntoPersona, USER_NAME — for /egpt new → identity chain
  const { sysOut, readDefaultBrainState, persistDefaultBrainState,
          canonicalBrainName, brainForName, humanAge,
          EGPT_CONFIG, injectIdentityIntoPersona, USER_NAME } = ctx;

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
    const wasFresh = (next === state);
    if (!wasFresh) await persistDefaultBrainState(next);
    sysOut(wasFresh
      ? 'egpt: already on a fresh state — running identity inject now'
      : 'egpt: cleared active session — injecting identity into fresh thread');

    // Operator (2026-05-19): "/e new should inject also identity."
    // Chain straight into a forced identity install so the new
    // session starts with the persona manifest in place — no
    // dangling window where @e is naked claude-code until /identity
    // is run separately. injectIdentityIntoPersona spawns claude
    // with sessionId=null, captures the new session_id via
    // optionsPatch, and persists it back to default_brain.
    try {
      const dbCfg = next.type
        ? { ...EGPT_CONFIG.default_brain, type: next.type, session_id: null, url: null }
        : { ...EGPT_CONFIG.default_brain, session_id: null, url: null };
      const brainType = canonicalBrainName(dbCfg.type ?? 'claude-code');
      const brain = brainForName(brainType);
      if (!brain) { sysOut(`!! /egpt new: brain "${brainType}" not found`); return true; }
      const sessionOpts = {
        sessionId: null,
        cwd:       dbCfg.cwd ?? process.cwd(),
        sessionName: 'egpt',
        userName:    USER_NAME,
        ...(brainType === 'ccode'   ? { allowedTools: dbCfg.allowed_tools ?? 'all' } : {}),
        ...(dbCfg.system_prompt     ? { appendSystemPrompt: dbCfg.system_prompt   } : {}),
        ...(dbCfg.model             ? { model: dbCfg.model                        } : {}),
      };
      const ack = await injectIdentityIntoPersona({ brain, sessionOpts, dbCfg, forced: true });
      sysOut(`egpt: identity installed — fresh session active${ack ? ` (@e: "${String(ack).slice(0, 80)}${String(ack).length > 80 ? '…' : ''}")` : ''}`);

      // Same wa-relay path as /identity: if invoked from a chat,
      // ack lands back in that chat.
      const ackText = String(ack ?? '').trim();
      const originJid = meta?.waChatId;
      if (ackText && ackText !== '...' && ackText !== '…' && originJid) {
        try {
          const fsmod   = await import('node:fs/promises');
          const pathmod = await import('node:path');
          const osmod   = await import('node:os');
          const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
          const ev = { type: 'wa-send', from: 'e', ts: Date.now(), jid: originJid, body: ackText };
          await fsmod.writeFile(
            pathmod.join(osmod.homedir(), '.egpt', 'outbox', id + '.json'),
            JSON.stringify(ev),
          );
        } catch (e) {
          sysOut(`!! /egpt new: failed to relay ack to ${originJid}: ${e?.message ?? e}`);
        }
      }
    } catch (e) {
      sysOut(`!! /egpt new: identity inject failed — ${e?.message ?? e}. session is cleared; run /identity manually after next @e turn.`);
    }
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
