// slash/wa-pending.mjs — hold-and-review for pre-connect WhatsApp messages.
//
// When baileys reconnects after a daemon stop or network blip, the
// history-set arrives with timestamps that predate connectedAt by
// more than whatsapp.max_backlog_seconds. Those messages get parked
// in the bridge's held queue instead of auto-dispatching, so a stale
// "@e <please run this big thing>" from 2 hours ago doesn't trigger
// the brain on reconnect. The operator reviews + decides per item.

export const meta = {
  cmd: '/wa-pending',
  section: 'ROOM',
  surface: 'shell',
  usage: '/wa-pending [dispatch <idx|all> | clear]',
  desc:
    'review WhatsApp messages received but not auto-dispatched because they ' +
    'predate the bridge connect (whatsapp.max_backlog_seconds). dispatch <idx> ' +
    'runs one through the brain pipeline; dispatch all runs the lot; clear ' +
    'discards them.',
};

export async function run({ arg, ctx }) {
  // ctx keys consumed:
  //   sysOut(text)
  //   waBridgeRef     — React ref; bridge exposes listHeld/clearHeld/dispatchHeld
  const { sysOut, waBridgeRef } = ctx;

  const wa = waBridgeRef.current;
  if (!wa || typeof wa.listHeld !== 'function') {
    sysOut('!! /wa-pending: whatsapp bridge not running');
    return true;
  }
  const parts = arg.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0];

  if (!sub) {
    const held = wa.listHeld();
    if (!held.length) { sysOut('(no held messages)', { _themed: true }); return true; }
    const ageLabel = (ts) => {
      const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
      if (s < 60)    return `${s}s ago`;
      if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
      if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
      return `${Math.floor(s / 86400)}d ago`;
    };
    const lines = held.map(h => {
      const who = h.author ?? (h.jid?.split('@')[0] ?? '?');
      const preview = h.text.length > 100 ? h.text.slice(0, 99) + '…' : h.text;
      return `  [${h.idx}] ${who} (${ageLabel(h.ts)}): ${preview}`;
    });
    sysOut(
      `held ${held.length} pre-connect message(s):\n${lines.join('\n')}\n\n` +
      `/wa-pending dispatch <idx>   dispatch one through the brain pipeline\n` +
      `/wa-pending dispatch all     dispatch every held message\n` +
      `/wa-pending clear            discard without dispatch`,
      { _themed: true },
    );
    return true;
  }

  if (sub === 'clear') {
    const n = wa.clearHeld();
    sysOut(`discarded ${n} held message(s)`);
    return true;
  }

  if (sub === 'dispatch') {
    const which = parts[1];
    if (!which) { sysOut('usage: /wa-pending dispatch <idx|all>'); return true; }
    if (which === 'all') {
      const held = wa.listHeld();
      let ok = 0, fail = 0;
      // Walk high-to-low so dispatchHeld's splice doesn't renumber
      // entries we haven't gotten to yet.
      for (let i = held.length - 1; i >= 0; i--) {
        const r = await wa.dispatchHeld(i);
        if (r.ok) ok++; else fail++;
      }
      sysOut(`dispatched ${ok}/${held.length}${fail ? `  (${fail} failed)` : ''}`);
      return true;
    }
    const idx = parseInt(which, 10);
    if (!Number.isInteger(idx)) { sysOut(`!! /wa-pending dispatch: "${which}" is not a number`); return true; }
    const r = await wa.dispatchHeld(idx);
    sysOut(r.ok ? `dispatched [${idx}]` : `!! dispatch [${idx}] failed: ${r.reason}`);
    return true;
  }

  sysOut('usage: /wa-pending [dispatch <idx|all> | clear]');
  return true;
}
