// slash/refresh.mjs — re-poll a CDP brain's tab (or replay last user msg
// for non-CDP brains).
//
// CDP path: peek the tab and append whatever the AI currently shows in
// it. Recovery for cases where stream-end was detected prematurely.
//
// Operator path: replay the last user message that was addressed to (or
// broadcast to) this session — a message addressed to a DIFFERENT
// session is not replayed. Triggers a fresh response.

import { readFile } from 'node:fs/promises';

export const meta = {
  cmd: '/refresh',
  section: 'BRAINS',
  surface: 'shell',
  usage: '/refresh [@<name>]',
  desc: 're-poll CDP tab and append; or replay last user message for operator brains',
};

export async function run({ arg, ctx }) {
  // ctx keys consumed:
  //   sysOut, setItems, setBusy
  //   sessions, brainForName(name)
  //   append(author, body), getFile(), parseMessages(text)
  //   runBrainTurn(name, prompt)
  const { sysOut, setItems, setBusy, sessions, brainForName,
          append, getFile, parseMessages, runBrainTurn } = ctx;

  const target = arg.trim().replace(/^@/, '');
  let session, sessionName;
  if (target) {
    if (!sessions[target]) { sysOut(`no session named "${target}"`); return true; }
    sessionName = target; session = sessions[target];
  } else {
    if (Object.keys(sessions).length === 1) {
      sessionName = Object.keys(sessions)[0]; session = sessions[sessionName];
    } else {
      const cdps = Object.entries(sessions).filter(([_, s]) => brainForName(s.brain)?.urlMatch);
      if (cdps.length !== 1) {
        const all = Object.keys(sessions);
        sysOut(
          `usage: /refresh [@<session>]\n  ` +
          (all.length === 0 ? 'no sessions in the room' : `pick one: ${all.join(', ')}`)
        );
        return true;
      }
      sessionName = cdps[0][0]; session = cdps[0][1];
    }
  }
  const brain = brainForName(session.brain);
  if (brain?.peek) {
    // CDP path: re-poll the tab + append latest assistant text.
    try {
      const text = await brain.peek(session.options);
      if (!text || !text.trim()) { sysOut('(tab has no assistant message right now)'); return true; }
      setItems(p => [...p, { id: Date.now() + Math.random(), author: sessionName, body: text }]);
      await append(sessionName, text);
      sysOut(`(refreshed ${sessionName} from tab — appended to file)`);
    } catch (e) { sysOut(`!! ${e.message}`); }
    return true;
  }

  // Operator path: replay the last user message addressed to (or
  // broadcast to) this session.
  const fileText = await readFile(getFile(), 'utf8');
  const msgs = parseMessages(fileText);
  const wasForSession = (body) => {
    if (!body.startsWith('@')) return true;       // broadcast
    return body.startsWith(`@${sessionName} `) ||
           body.startsWith(`@${sessionName}\n`) ||
           body === `@${sessionName}`;
  };
  const lastUserMsg = [...msgs].reverse().find(m => m.author === 'You' && wasForSession(m.body));
  if (!lastUserMsg) { sysOut(`no user message to replay for ${sessionName}`); return true; }
  const payload = lastUserMsg.body.startsWith(`@${sessionName}`)
    ? lastUserMsg.body.slice(sessionName.length + 1).trim()
    : lastUserMsg.body;
  sysOut(`replaying last message to ${sessionName}…`);
  setBusy(true);
  try { await runBrainTurn(sessionName, payload); } finally { setBusy(false); }
  return true;
}
