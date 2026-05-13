// slash/session.mjs — manage a ccode session's resume state.
//
// /session <session-name>                 show resume state
// /session <session-name> <id> [cwd]      set resume id (cwd auto-detected from JSONL)
// /session <session-name> none|clear      clear (back to stateless)
// /session <id> [cwd]                     shorthand: applies to the only ccode
//                                         session if there's exactly one

export const meta = {
  cmd: '/session',
  section: 'SESSIONS',
  surface: 'shell',
  usage: '/session <session-name> [<id>|none] [cwd]',
  desc: 'set or clear a ccode session\'s resume id (cwd auto-detected from JSONL)',
};

export async function run({ arg, ctx }) {
  // ctx keys consumed:
  //   sysOut(text)
  //   sessions / setSessions
  //   canonicalBrainName(s)
  //   findSessionJsonl(idOrPrefix)
  //   readJsonlMetadata(path)
  //   writeBrainProfileState(name, sess)
  const { sysOut, sessions, setSessions, canonicalBrainName,
          findSessionJsonl, readJsonlMetadata, writeBrainProfileState } = ctx;

  const parts = arg.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    sysOut('usage: /session <session-name> [<id>|none] [cwd]\n  shorthand /session <id> works if there is exactly one ccode session');
    return true;
  }

  let target;
  let restParts;
  if (sessions[parts[0]]) {
    target = parts[0];
    restParts = parts.slice(1);
  } else {
    const codeSessions = Object.entries(sessions).filter(([_, s]) => canonicalBrainName(s.brain) === 'ccode');
    if (codeSessions.length === 1) {
      target = codeSessions[0][0];
      restParts = parts;
    } else if (codeSessions.length > 1) {
      sysOut(`multiple ccode sessions: ${codeSessions.map(([n]) => n).join(', ')}\n  /session <session-name> <id>`);
      return true;
    } else {
      sysOut(`no session named "${parts[0]}" and no ccode session to default to`);
      return true;
    }
  }

  if (restParts.length === 0) {
    const opts = sessions[target].options;
    sysOut(`${target}.sessionId: ${opts.sessionId ?? '(none)'}\n${target}.cwd: ${opts.cwd ?? '(none)'}`);
    return true;
  }

  let sid = restParts[0];
  let cwd = restParts.slice(1).join(' ').trim() || undefined;
  if (sid === 'none' || sid === 'clear') {
    const nextSession = {
      ...sessions[target],
      options: Object.fromEntries(
        Object.entries(sessions[target].options).filter(([k]) => k !== 'sessionId' && k !== 'cwd')
      ),
    };
    setSessions(s => ({ ...s, [target]: nextSession }));
    await writeBrainProfileState(target, nextSession).catch(e => sysOut(`!! profile state: ${e.message}`));
    sysOut(`${target}: resume cleared (back to stateless mode)`);
    return true;
  }

  // Resolve a prefix to the full session UUID and auto-detect cwd.
  let expandedFromPrefix = false;
  let detectedCwd = false;
  try {
    const found = await findSessionJsonl(sid);
    if (!found) {
      sysOut(`!! no session matches "${sid}". /history to list, /session ${target} none to clear.`);
      return true;
    }
    if (found.sessionId !== sid) { sid = found.sessionId; expandedFromPrefix = true; }
    if (!cwd) {
      const m = await readJsonlMetadata(found.path);
      if (m.cwd) { cwd = m.cwd; detectedCwd = true; }
    }
  } catch (e) {
    sysOut(`!! ${e.message}`);
    return true;
  }

  const nextSession = {
    ...sessions[target],
    options: { ...sessions[target].options, sessionId: sid, ...(cwd ? { cwd } : {}) },
  };
  setSessions(s => ({ ...s, [target]: nextSession }));
  await writeBrainProfileState(target, nextSession).catch(e => sysOut(`!! profile state: ${e.message}`));
  sysOut(`${target}.sessionId -> ${sid}` +
         (expandedFromPrefix ? '  (expanded from prefix)' : '') +
         (cwd ? `\n${target}.cwd -> ${cwd}` + (detectedCwd ? '  (auto-detected from JSONL)' : '')
              : '\n(no cwd; pass one if claude --resume fails)') +
         `\n(claude --resume mode active for ${target})`);
  return true;
}
