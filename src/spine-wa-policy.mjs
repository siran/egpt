export function resolveWaTransport(cfg = {}) {
  return cfg.transport === 'cdp' ? 'cdp' : 'beeper';
}

export function createWaBypassSync({
  waBridgeRef,
  getJoinedChats = () => [],
  getAutoChats = () => [],
} = {}) {
  if (!waBridgeRef || typeof waBridgeRef !== 'object') {
    throw new Error('createWaBypassSync: waBridgeRef required');
  }
  return () => {
    const wa = waBridgeRef.current;
    if (!wa || typeof wa.setBypassChats !== 'function') return;
    const joined = getJoinedChats().map((e) => e.jid);
    const auto = Array.isArray(getAutoChats()) ? getAutoChats() : [];
    wa.setBypassChats([...new Set([...joined, ...auto])]);
  };
}

export function createWhatsAppConfirmMirror({
  config = {},
  pushItem = () => {},
  emitOutbox = async () => {},
  now = () => Date.now(),
} = {}) {
  return async (jid, header, content) => {
    try {
      if (!jid) return;
      const watch = config.whatsapp?.confirm_chats;
      const dests = watch && Array.isArray(watch[jid]) ? watch[jid] : null;
      if (!dests || !dests.length) return;
      const body = String(content ?? '');
      const hdr = header ? `Debug: ${header}` : null;
      const waBody = hdr ? `${hdr}\n\`\`\`\n${body}\n\`\`\`` : `\`\`\`\n${body}\n\`\`\``;
      const shellBody = hdr ? `${hdr}\n${body}` : body;
      const selfDm = config.whatsapp?.chat_id ?? null;
      for (const dest of dests) {
        if (dest === 'shell') {
          pushItem({ id: now() + Math.random(), author: 'system', _localOnly: true, body: shellBody });
        } else if (dest === 'self' || dest === 'egptbot') {
          const targetJid = dest === 'self' ? selfDm : (config.whatsapp?.egptbot_jid ?? null);
          if (!targetJid) {
            if (dest === 'egptbot') {
              pushItem({
                id: now() + Math.random(),
                author: 'system',
                _localOnly: true,
                body: '!! /e confirm: dest "egptbot" needs whatsapp.egptbot_jid configured (no bot account yet) — skipped',
              });
            }
            continue;
          }
          if (targetJid === jid) continue;
          await emitOutbox({ jid: targetJid, body: waBody, deliverEcho: true });
        }
      }
    } catch (e) {
      // The confirm mirror is debug-only; keep failures local.
      // eslint-disable-next-line no-console
      console.error(`!! confirmMirror: ${e?.message ?? e}`);
    }
  };
}
