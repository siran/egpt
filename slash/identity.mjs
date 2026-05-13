// slash/identity.mjs — install the egpt persona manifest into a brain.
//
// /identity [@<session>]    re-install into one (or @e for the persona)
// /identity                 inject into ALL active sessions + @e
// /identity show            print the identity file to the shell
//
// Forces injection regardless of the previously-set identityInjected
// flag — useful after editing e_identity.md (or whatever
// brains.identity points at) so brains pick up the new content.

import * as cdp from '../tools/cdp.mjs';
import { isUrlBrain } from '../persona-state.mjs';

export const meta = {
  cmd: '/identity',
  section: 'BRAINS',
  surface: 'shell',
  usage: '/identity [@<session> | show]',
  desc:
    'install the egpt persona manifest (brains.identity, default ./e_identity.md) ' +
    'into a brain. New sessions auto-install on first dispatch; this command forces ' +
    'a fresh install (e.g. after editing the identity file). No arg = install into ' +
    '@e + every active session. "show" prints the manifest.',
};

export async function run({ arg, ctx }) {
  // ctx keys consumed:
  //   sysOut, EGPT_CONFIG
  //   sessions, USER_NAME
  //   canonicalBrainName(s) / brainForName(s)
  //   loadIdentity() / injectIdentityIntoPersona() / injectIdentityIfNeeded()
  const { sysOut, EGPT_CONFIG, sessions, USER_NAME,
          canonicalBrainName, brainForName,
          loadIdentity, injectIdentityIntoPersona, injectIdentityIfNeeded } = ctx;

  const a = arg.trim();
  const identity = await loadIdentity();
  if (!identity) {
    sysOut(`!! /identity: no identity file (brains.identity = "${EGPT_CONFIG.brains?.identity ?? './e_identity.md'}", set or check path; "off" disables)`);
    return true;
  }
  if (a === 'show') {
    sysOut(identity);
    return true;
  }
  const targets = [];
  if (a.startsWith('@')) {
    const name = a.slice(1);
    if (name === 'e' || name === 'egpt') targets.push({ kind: 'persona' });
    else if (sessions[name]) targets.push({ kind: 'session', name });
    else { sysOut(`!! /identity: no session "${name}"`); return true; }
  } else if (!a) {
    targets.push({ kind: 'persona' });
    for (const n of Object.keys(sessions)) targets.push({ kind: 'session', name: n });
  } else {
    sysOut('usage: /identity [@<session> | @e | show]');
    return true;
  }

  for (const t of targets) {
    if (t.kind === 'persona') {
      // Force install into the @e persona's CURRENT thread (don't
      // wipe url / session_id — that'd lose continuity). Build the
      // same sessionOpts runDefaultBrainTurn would.
      const dbCfg = EGPT_CONFIG.default_brain ?? { type: 'claude-code' };
      const brainType = canonicalBrainName(dbCfg.type ?? 'claude-code');
      const brain = brainForName(brainType);
      if (!brain) { sysOut(`!! @e: brain ${brainType} not found`); continue; }
      let sessionOpts;
      if (isUrlBrain(brainType)) {
        // Resolve the existing thread URL → live targetId so the
        // install lands in the right tab.
        let targetId = null;
        try {
          const tabs = await cdp.listTabs(brain.urlMatch);
          const m = dbCfg.url ? tabs.find(t => t.url === dbCfg.url || t.url.startsWith(dbCfg.url)) : null;
          if (m) targetId = m.id;
        } catch {}
        sessionOpts = { targetId };
      } else {
        sessionOpts = {
          sessionId: dbCfg.session_id ?? null,
          cwd:       dbCfg.cwd ?? process.cwd(),
          sessionName: 'egpt',
          userName:    USER_NAME,
          ...(brainType === 'ccode'   ? { allowedTools: dbCfg.allowed_tools ?? 'all' } : {}),
          ...(dbCfg.system_prompt     ? { appendSystemPrompt: dbCfg.system_prompt   } : {}),
        };
      }
      await injectIdentityIntoPersona({ brain, sessionOpts, dbCfg, forced: true });
    } else {
      const s = sessions[t.name];
      if (!s) continue;
      const brain = brainForName(s.brain);
      if (!brain) { sysOut(`!! /identity @${t.name}: brain ${s.brain} not found`); continue; }
      await injectIdentityIfNeeded({
        routedTo: t.name, session: s, brain, opts: s.options ?? {}, forced: true,
      });
    }
  }
  return true;
}
