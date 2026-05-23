// slash/identity.mjs — install the egpt persona manifest into a brain.
//
// /identity [@<session>]    re-install into one (or @e for the persona)
// /identity                 inject into ALL active sessions + @e
// /identity show            print the identity file to the shell
//
// Forces injection regardless of the previously-set identityInjected
// flag — useful after editing e_identity.md (or whatever
// brains.identity points at) so brains pick up the new content.

import * as cdp from '../src/tools/cdp.mjs';
import { isUrlBrain } from '../src/persona-state.mjs';

export const meta = {
  cmd: '/identity',
  section: 'BRAINS',
  surface: 'shell',
  usage: '/identity [@<session> | show | reset [all]]',
  desc:
    'install the egpt persona manifest (brains.identity, default ./e_identity.md) ' +
    'into a brain. New sessions auto-install on first dispatch; this command forces ' +
    'a fresh install (e.g. after editing the identity file). No arg = install into ' +
    '@e + every active session. "show" prints the manifest.',
};

export async function run({ arg, meta, ctx }) {
  // ctx keys consumed:
  //   sysOut, EGPT_CONFIG
  //   sessions, USER_NAME
  //   canonicalBrainName(s) / brainForName(s)
  //   loadIdentity() / injectIdentityIntoPersona() / injectIdentityIfNeeded()
  const { sysOut, EGPT_CONFIG, sessions, USER_NAME,
          canonicalBrainName, brainForName,
          loadIdentity, injectIdentityIntoPersona, injectIdentityIfNeeded } = ctx;

  const a = arg.trim();

  // /identity reset [all] — wipe threadIds on per-contact threads so
  // next dispatch to each spawns a fresh thread with the current
  // personality bundled. Without `all`: only contacts with the
  // default personality (the un-customized ones). With `all`: every
  // contact regardless of personality. Operator (2026-05-19): use
  // this after rewriting personalities/default.md to refresh the
  // un-customized fleet without disturbing custom personas.
  if (a === 'reset' || a === 'reset all') {
    const all = (a === 'reset all');
    try {
      const { CONV_YAML_PATH, readState, writeState, patchContact } = await import('../conversations-state.mjs');
      const cs = await readState(CONV_YAML_PATH);
      let next = cs;
      let touched = 0;
      const skipped = [];
      // Surface-nested schema: iterate each surface bucket.
      for (const surface of Object.keys(cs.contacts ?? {})) {
        const bucket = cs.contacts[surface] ?? {};
        for (const [_jid, entry] of Object.entries(bucket)) {
          if (entry?.aliasOf || !entry?.slug) continue;
          const slug = entry.slug;
          const isDefault = (entry.personality || 'default') === 'default';
          if (!all && !isDefault) { skipped.push(`${surface}/${slug}(${entry.personality})`); continue; }
          next = patchContact(next, surface, slug, { threadId: null, identityInjectedAt: null });
          touched++;
        }
      }
      await writeState(CONV_YAML_PATH, next);
      const skippedMsg = skipped.length ? `; skipped ${skipped.length} customized: ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? '…' : ''}` : '';
      sysOut(`/identity reset${all ? ' all' : ''}: cleared threadIds on ${touched} contacts. Next dispatch to each spawns fresh with their current personality${skippedMsg}.`);
    } catch (e) {
      sysOut(`!! /identity reset: ${e?.message ?? e}`);
    }
    return true;
  }

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
        const addDirs = Array.isArray(dbCfg.addDirs) ? dbCfg.addDirs
          : Array.isArray(dbCfg.add_dirs) ? dbCfg.add_dirs
          : undefined;
        sessionOpts = {
          sessionId: dbCfg.session_id ?? null,
          cwd:       dbCfg.cwd ?? process.cwd(),
          sessionName: 'egpt',
          userName:    USER_NAME,
          ...(['ccode', 'codex'].includes(brainType) ? { allowedTools: dbCfg.allowed_tools ?? 'all' } : {}),
          ...(addDirs                 ? { addDirs } : {}),
          ...(dbCfg.system_prompt     ? { appendSystemPrompt: dbCfg.system_prompt   } : {}),
        };
      }
      const ack = await injectIdentityIntoPersona({ brain, sessionOpts, dbCfg, forced: true });
      // Operator (2026-05-19): "replies should be sent to originating
      // chat." Relay @e's identity-install ack back to the WA chat that
      // invoked /identity, via wa-send outbox event. Silence-protocol
      // replies are skipped.
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
          sysOut(`!! /identity: failed to relay @e's ack to ${originJid}: ${e?.message ?? e}`);
        }
      }
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
