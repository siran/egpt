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

import { startNew, rewind as rewindFn, listHistory, summarize, setBrain } from '../src/persona-state.mjs';
import {
  CONV_YAML_PATH,
  readState as readConvState,
  writeState as writeConvState,
  findContactByJid,
  findContactsByName,
  patchContact,
  installPersonaIntoSlugDir,
  buildRebootAnnouncement,
  resolvePersonalityFile,
} from '../conversations-state.mjs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { writeFile as writeFileAsync } from 'node:fs/promises';

export const meta = {
  cmd: '/egpt',
  section: 'PERSONA',
  surface: 'both',
  usage: '/egpt [status | new [<persona>] [<name-search>] | persona [<persona>] [<name-search>] | list | brain <type> [<ref>] | rewind [<n>|<ref-prefix>]]',
  desc: 'manage @egpt persona session-history state; reboot conversation-e in any chat by name search',
};

// Resolve a name-search term to a single contact. Returns one of:
//   { ok: true, jid, slug, entry, pushedName, surface }
//   { ok: false, reason: 'none' | 'multi', candidates? }
async function _resolveNameSearch(term) {
  const cs = await readConvState(CONV_YAML_PATH);
  const matches = findContactsByName(cs, term);   // cross-surface
  if (matches.length === 0) return { ok: false, reason: 'none' };
  if (matches.length > 1)  return { ok: false, reason: 'multi', candidates: matches };
  const [hit] = matches;
  return { ok: true, jid: hit.jid, slug: hit.slug, entry: hit.entry, pushedName: hit.pushedName, surface: hit.surface };
}

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
  // ── /egpt persona [<persona>] [<name-search…>] ──────────────────
  // Install (or re-install) a persona on an EXISTING thread, identified
  // by name-search. Without name-search → current chat (alias of /e persona).
  if (sub === 'persona') {
    const positional = parts.slice(1).filter(t => !t.startsWith('--'));
    const personaName = positional[0] || 'default';
    const searchTerm = positional.slice(1).join(' ').trim();
    const originJid = meta?.waChatId ?? null;

    let targetJid;
    let surface = 'whatsapp';   // default when invoked from a WA chat
    if (!searchTerm) {
      if (!originJid) {
        sysOut('!! /egpt persona: no name-search and no chat context. Try `/egpt persona <persona> <name-search>` from the shell.');
        return true;
      }
      targetJid = originJid;
    } else {
      const r = await _resolveNameSearch(searchTerm);
      if (!r.ok && r.reason === 'none') {
        sysOut(`!! /egpt persona: no chat matches "${searchTerm}"`);
        return true;
      }
      if (!r.ok && r.reason === 'multi') {
        const lines = r.candidates.map(c => `  - ${c.pushedName || '(no name)'} [${c.slug}] @ ${c.surface} — ${c.jid}`).join('\n');
        sysOut(`!! /egpt persona: "${searchTerm}" matches multiple chats — pick one:\n${lines}`);
        return true;
      }
      targetJid = r.jid;
      surface = r.surface;
      sysOut(`/egpt persona: target → ${r.pushedName || '(no name)'} [${r.slug}] @ ${r.surface}`);
    }
    const { _runReboot } = await import('./e.mjs');
    return await _runReboot({ resetThread: false, personaName, targetJid, sysOut, ctx, originJid, surface });
  }

  if (sub === 'new') {
    // New positional shape: /egpt new [<persona>] [<name-search…>]
    // Detected when there are positional (non-`--`) tokens after 'new'.
    // Falls through to flag-based form otherwise (--all / --slug / --jid /
    // --personality), preserved for back-compat with older muscle memory.
    const positional = parts.slice(1).filter(t => !t.startsWith('--'));
    const hasPositional = positional.length > 0;
    if (hasPositional) {
      const personaName = positional[0] || 'default';
      const searchTerm = positional.slice(1).join(' ').trim();
      const originJid = meta?.waChatId ?? null;
      let targetJid;
      let surface = 'whatsapp';
      if (!searchTerm) {
        if (!originJid) {
          sysOut('!! /egpt new: no name-search and no chat context. Try `/egpt new <persona> <name-search>` from the shell.');
          return true;
        }
        targetJid = originJid;
      } else {
        const r = await _resolveNameSearch(searchTerm);
        if (!r.ok && r.reason === 'none') {
          sysOut(`!! /egpt new: no chat matches "${searchTerm}"`);
          return true;
        }
        if (!r.ok && r.reason === 'multi') {
          const lines = r.candidates.map(c => `  - ${c.pushedName || '(no name)'} [${c.slug}] @ ${c.surface} — ${c.jid}`).join('\n');
          sysOut(`!! /egpt new: "${searchTerm}" matches multiple chats — pick one:\n${lines}`);
          return true;
        }
        targetJid = r.jid;
        surface = r.surface;
        sysOut(`/egpt new: target → ${r.pushedName || '(no name)'} [${r.slug}] @ ${r.surface}`);
      }
      const { _runReboot } = await import('./e.mjs');
      return await _runReboot({ resetThread: true, personaName, targetJid, sysOut, ctx, originJid, surface });
    }

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

    // --- Branch 1: --all → reset every contact's threadId across all surfaces ---
    if (allFlag) {
      let convState = await readConvState(CONV_YAML_PATH);
      let totalSlugs = 0;
      for (const surface of Object.keys(convState.contacts ?? {})) {
        const bucket = convState.contacts[surface] ?? {};
        for (const [_jid, entry] of Object.entries(bucket)) {
          if (entry?.aliasOf || !entry?.slug) continue;
          convState = patchContact(convState, surface, entry.slug, { threadId: null, identityInjectedAt: null });
          totalSlugs++;
        }
      }
      await writeConvState(CONV_YAML_PATH, convState);
      sysOut(`egpt new --all: cleared threadIds on ${totalSlugs} contacts. Next dispatch to each spawns fresh with their assigned personality.`);
      return true;
    }

    // --- Branch 2: per-contact (--slug, --jid, or origin chat) ---
    if (slugFlag || jidFlag || originJid) {
      let convState = await readConvState(CONV_YAML_PATH);
      // Flag-based form assumes WA (legacy callers). For TG-specific
      // targeting, use the positional name-search form instead.
      const surface = 'whatsapp';
      let targetSlug = slugFlag;
      if (!targetSlug) {
        targetSlug = findContactByJid(convState, surface, jidFlag ?? originJid);
      }
      if (!targetSlug) {
        sysOut(`!! /egpt new: no contact registered for jid "${jidFlag ?? originJid}" under ${surface}. Send a message in that chat first so @e registers it, then try again. Or pass --slug <existing-slug>.`);
        return true;
      }
      const patch = { threadId: null, identityInjectedAt: null };
      if (personality) patch.personality = personality;
      convState = patchContact(convState, surface, targetSlug, patch);
      await writeConvState(CONV_YAML_PATH, convState);

      // Find the entry by slug to get its primary jid for the kickoff turn.
      const bucket = convState.contacts[surface] ?? {};
      const jidEntry = Object.entries(bucket).find(([_j, e]) => e?.slug === targetSlug);
      if (!jidEntry) { sysOut(`!! /egpt new ${targetSlug}: contact disappeared during patch`); return true; }
      const [jid, entry] = jidEntry;

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
          await writeFileAsync(join(homedir(), '.egpt', 'state', 'outbox', id + '.json'), JSON.stringify(ev));
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
      const addDirs = Array.isArray(dbCfg.addDirs) ? dbCfg.addDirs
        : Array.isArray(dbCfg.add_dirs) ? dbCfg.add_dirs
        : undefined;
      const sessionOpts = {
        sessionId: null,
        cwd:       dbCfg.cwd ?? process.cwd(),
        sessionName: 'egpt',
        userName:    USER_NAME,
        ...(['ccode', 'codex'].includes(brainType) ? { allowedTools: dbCfg.allowed_tools ?? 'all' } : {}),
        ...(addDirs                 ? { addDirs } : {}),
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
