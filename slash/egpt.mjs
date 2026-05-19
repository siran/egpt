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
import {
  CONV_YAML_PATH,
  readState as readConvState,
  writeState as writeConvState,
  findContactByJid,
  patchContact,
} from '../conversations-state.mjs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { writeFile as writeFileAsync } from 'node:fs/promises';

export const meta = {
  cmd: '/egpt',
  section: 'PERSONA',
  surface: 'shell',
  usage: '/egpt [status | new [--personality <name>] [--jid <jid>] [--slug <slug>] [--all] | list | brain <type> [<ref>] | rewind [<n>|<ref-prefix>]]',
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
  //   computeBrainTurn — for per-contact thread kickoff
  const { sysOut, readDefaultBrainState, persistDefaultBrainState,
          canonicalBrainName, brainForName, humanAge,
          EGPT_CONFIG, injectIdentityIntoPersona, USER_NAME,
          computeBrainTurn } = ctx;

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
    // Flag parsing: --personality <name>, --jid <jid>, --slug <slug>, --all
    let personality = null;
    let jidFlag = null;
    let slugFlag = null;
    let allFlag = false;
    for (let i = 1; i < parts.length; i++) {
      const t = parts[i];
      if (t === '--personality' && parts[i + 1]) { personality = parts[++i]; continue; }
      if (t === '--jid'         && parts[i + 1]) { jidFlag    = parts[++i]; continue; }
      if (t === '--slug'        && parts[i + 1]) { slugFlag   = parts[++i]; continue; }
      if (t === '--all')                         { allFlag    = true;       continue; }
    }
    const originJid = meta?.waChatId ?? null;

    // --- Branch 1: --all → reset every contact's threadId ---
    if (allFlag) {
      const convState = await readConvState(CONV_YAML_PATH);
      const slugs = Object.keys(convState.contacts ?? {});
      let next = convState;
      for (const sl of slugs) {
        next = patchContact(next, sl, { threadId: null, identityInjectedAt: null });
      }
      await writeConvState(CONV_YAML_PATH, next);
      sysOut(`egpt new --all: cleared threadIds on ${slugs.length} contacts. Next dispatch to each spawns fresh with their assigned personality.`);
      return true;
    }

    // --- Branch 2: per-contact (--slug, --jid, or origin chat) ---
    if (slugFlag || jidFlag || originJid) {
      let convState = await readConvState(CONV_YAML_PATH);
      let targetSlug = slugFlag;
      if (!targetSlug) {
        targetSlug = findContactByJid(convState, jidFlag ?? originJid);
      }
      if (!targetSlug) {
        sysOut(`!! /egpt new: no contact registered for jid "${jidFlag ?? originJid}". Send a message in that chat first so @e registers it, then try again. Or pass --slug <existing-slug>.`);
        return true;
      }
      const patch = { threadId: null, identityInjectedAt: null };
      if (personality) patch.personality = personality;
      convState = patchContact(convState, targetSlug, patch);
      await writeConvState(CONV_YAML_PATH, convState);

      const entry = convState.contacts[targetSlug];
      const jid = entry.jids?.[0];
      if (!jid) { sysOut(`!! /egpt new ${targetSlug}: contact has no JIDs registered`); return true; }

      // Kickoff turn — runDefaultBrainTurn's per-contact branch sees
      // threadId=null on the entry, treats this as new contact,
      // bundles personality into the first user message. The brain's
      // reply is @e's introduction in that personality.
      const kickoff = `... operator just reset this thread${personality ? ` to the '${personality}' personality` : ''}. Introduce yourself briefly in character (1-2 sentences). ...`;
      try {
        const reply = await computeBrainTurn('e', kickoff, {
          threadId: jid,
          surface:  'wa',
          slug:     targetSlug,
          name:     entry.pushedName || targetSlug,
        });
        const ackText = String(reply ?? '').trim();
        if (!ackText) {
          sysOut(`!! /egpt new ${targetSlug}: kickoff produced empty reply — thread may not be initialized. Check /log; consider re-running.`);
        } else {
          sysOut(`egpt new ${targetSlug}: thread reset, personality=${entry.personality} (@e: "${ackText.slice(0, 80)}${ackText.length > 80 ? '…' : ''}")`);
        }
        // Relay ack to originating chat if invoked from WA.
        if (originJid && ackText && ackText !== '...' && ackText !== '…') {
          const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
          const ev = { type: 'wa-send', from: 'e', ts: Date.now(), jid: originJid, body: ackText };
          await writeFileAsync(join(homedir(), '.egpt', 'outbox', id + '.json'), JSON.stringify(ev));
        }
      } catch (e) {
        sysOut(`!! /egpt new ${targetSlug}: kickoff failed — ${e?.message ?? e}`);
      }
      return true;
    }

    // --- Branch 3: no flag, no origin chat → reset heartbeat (default_brain) thread ---
    // Legacy global behavior preserved for the heartbeat session.
    const next = startNew(state);
    if (next !== state) await persistDefaultBrainState(next);
    try {
      const dbCfg = { ...EGPT_CONFIG.default_brain, session_id: null, url: null };
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
      const ackText = String(ack ?? '').trim();
      if (!ackText) {
        sysOut('!! /egpt new: identity inject empty — heartbeat session may not be initialized. Check /log.');
      } else {
        sysOut(`egpt new: heartbeat thread reset (@e: "${ackText.slice(0, 80)}${ackText.length > 80 ? '…' : ''}")`);
      }
    } catch (e) {
      sysOut(`!! /egpt new: identity inject failed — ${e?.message ?? e}`);
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
