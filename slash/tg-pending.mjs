// slash/tg-pending.mjs — hold-and-review for pre-connect Telegram messages.
//
// Mirror of /wa-pending. On daemon restart / bridge reconnect, the
// TG bridge parks messages older than telegram.max_backlog_seconds
// in a held queue instead of auto-dispatching to the brain. The
// operator reviews + decides per item via this command. Without
// this hold (or its WA twin), a stale "@e <please run this big
// thing>" queued overnight executes the brain on next bridge start
// — surprising and unsafe.

export const meta = {
  cmd: '/tg-pending',
  section: 'ROOM',
  surface: 'shell',
  usage: '/tg-pending [dispatch <idx|all> | clear]',
  desc:
    'review Telegram messages received but not auto-dispatched because they ' +
    'predate the bridge connect (telegram.max_backlog_seconds). dispatch <idx> ' +
    'runs one through the brain pipeline; dispatch all runs the lot; clear ' +
    'discards them.',
};

export async function run({ arg, ctx }) {
  // ctx keys consumed:
  //   sysOut(text)
  //   tgBridgeRef     — React ref; bridge exposes listHeld/clearHeld/dispatchHeld
  const { sysOut, tgBridgeRef } = ctx;

  const tg = tgBridgeRef.current;
  if (!tg || typeof tg.listHeld !== 'function') {
    sysOut('!! /tg-pending: telegram bridge not running (or older build without held-queue support)');
    return true;
  }
  const parts = arg.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0];

  if (!sub) {
    const held = tg.listHeld();
    if (!held.length) { sysOut('(no held messages)'); return true; }
    const ageLabel = (ts) => {
      const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
      if (s < 60)    return `${s}s ago`;
      if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
      if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
      return `${Math.floor(s / 86400)}d ago`;
    };
    const lines = held.map(h => {
      const who = h.author ?? `chat ${h.chatId ?? '?'}`;
      const preview = h.text.length > 100 ? h.text.slice(0, 99) + '…' : h.text;
      return `  [${h.idx}] ${who} (${ageLabel(h.ts)}): ${preview}`;
    });
    sysOut(
      `held ${held.length} pre-connect Telegram message(s):\n${lines.join('\n')}\n\n` +
      `/tg-pending dispatch <idx>   dispatch one through the brain pipeline\n` +
      `/tg-pending dispatch all     dispatch every held message\n` +
      `/tg-pending clear            discard without dispatch`
    );
    return true;
  }

  if (sub === 'clear') {
    const n = tg.clearHeld();
    sysOut(`discarded ${n} held Telegram message(s)`);
    return true;
  }

  if (sub === 'dispatch') {
    const which = parts[1];
    if (!which) { sysOut('usage: /tg-pending dispatch <idx|all>'); return true; }
    if (which === 'all') {
      const held = tg.listHeld();
      let ok = 0, fail = 0;
      // Walk high-to-low so dispatchHeld's splice doesn't renumber
      // entries we haven't gotten to yet.
      for (let i = held.length - 1; i >= 0; i--) {
        const r = await tg.dispatchHeld(i);
        if (r.ok) ok++; else fail++;
      }
      sysOut(`dispatched ${ok}/${held.length}${fail ? `  (${fail} failed)` : ''}`);
      return true;
    }
    const idx = parseInt(which, 10);
    if (!Number.isInteger(idx)) { sysOut(`!! /tg-pending dispatch: "${which}" is not a number`); return true; }
    const r = await tg.dispatchHeld(idx);
    sysOut(r.ok ? `dispatched [${idx}]` : `!! dispatch [${idx}] failed: ${r.reason}`);
    return true;
  }

  sysOut('usage: /tg-pending [dispatch <idx|all> | clear]');
  return true;
}
