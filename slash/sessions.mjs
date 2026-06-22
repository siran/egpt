// slash/sessions.mjs — list sessions and manage the default operator.

import * as cdp from '../src/tools/cdp.mjs';

export const meta = {
  cmd: '/sessions',
  section: 'SESSIONS',
  surface: 'both',
  usage: '/sessions [default [name|clear]]',
  desc: 'list sessions; manage default operator',
};

export async function run({ arg, ctx }) {
  // ctx keys consumed:
  //   sysOut(text)
  //   sessions                       — snapshot
  //   getDefaultOp() / setDefaultOp(name|null)  — manages _defaultOp let
  //   brainForName(name)             — brain spec lookup for stateDetail()
  //   peerNodesRef                   — bus peers + their zombie sessions
  const { sysOut, sessions, getDefaultOp, setDefaultOp,
          brainForName, peerNodesRef } = ctx;

  const parts = arg.split(/\s+/).filter(Boolean);
  if (parts[0] === 'default') {
    const target = parts[1];
    if (!target || target === 'clear' || target === 'none') {
      setDefaultOp(null);
      sysOut('default operator cleared');
    } else if (!sessions[target]) {
      sysOut(`!! no session named "${target}"`);
    } else {
      setDefaultOp(target);
      sysOut(`default operator -> ${target} (this session)`);
    }
    return true;
  }

  // Best-effort: live tab title lookup. Falls back to targetId when
  // Chrome isn't reachable.
  let tabsByid = new Map();
  try {
    const tabs = await cdp.listTabs();
    for (const t of tabs) tabsByid.set(t.id, t);
  } catch { /* Chrome not running — non-CDP sessions still render */ }

  const defaultOp = getDefaultOp();
  const rows = Object.entries(sessions).map(([name, s]) => {
    const star = name === defaultOp ? '* ' : '  ';
    const emojiPad = (s.emoji ?? '❓') + ' ';
    const namePad = name.padEnd(14);
    const brainPad = (s.brain ?? '?').padEnd(13);
    const brain = brainForName(s.brain);
    const opts = s.options ?? {};
    let detail = '';
    if (opts.targetId) {
      const live = tabsByid.get(opts.targetId);
      detail = live
        ? `"${live.title || '(untitled)'}"`
        : `(tab gone — ${opts.targetId.slice(0, 8)}...)`;
    } else if (opts.sessionId) {
      const idShort = opts.sessionId.slice(0, 8) + '...';
      detail = s.brain === 'codex' ? `thread: ${idShort}` : `claude --resume ${idShort}`;
    } else if (opts.url) {
      detail = opts.url.replace(/^https?:\/\//, '');
    } else if (brain?.stateDetail) {
      detail = brain.stateDetail(opts);
    }
    if (opts.profileName) {
      detail = [`profile: ${opts.profileName}`, detail].filter(Boolean).join(' | ');
    }
    const bio = s.bio ? `\n     bio: ${s.bio}` : '';
    return `${star}${emojiPad}${namePad}${brainPad}${detail}${bio}`;
  });
  const footer = defaultOp
    ? `\n* = default operator (${defaultOp})  /sessions default clear to unset`
    : '';

  // Append peer (zombie) sessions: participants owned by other nodes.
  // Visible here so the user sees the whole room and can address any
  // of them with @<name>; the bus routes the mention to the owner.
  const peerLines = [];
  for (const [nodeId, peer] of peerNodesRef.current) {
    const head = `~ ${nodeId}  (${peer.role ?? 'node'})${peer.polling ? '  [polling]' : ''}`;
    peerLines.push(head);
    for (const sess of peer.sessions ?? []) {
      peerLines.push(`    ${(sess.name ?? '?').padEnd(14)}${sess.brain ?? '?'}`);
    }
  }
  const peerBlock = peerLines.length
    ? `\n\n── peers (zombie sessions) ───────────────────\n${peerLines.join('\n')}`
    : '';

  sysOut((rows.join('\n') || '(none)') + footer + peerBlock, { _themed: true });
  return true;
}
