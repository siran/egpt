// slash/mirror.mjs — forward items by id (mN) to a destination.
//
//   /mirror @<target> [mN ...] [--tagged | --no-tag]
//
// Targets:
//   @waN          forward to a WA chat (from the last /channels listing)
//   @<session>    re-dispatch the body to that brain as fresh input
//
// Default item is the last visible non-system message; explicit mNs
// pick specific items (in order). Tagged prefixing (config:
// mirror.tagged, default 'on') wraps each body with
// '[author timestamp]: '. --no-tag / --tagged override per-call.

export const meta = {
  cmd: '/mirror',
  section: 'BRAINS',
  surface: 'shell',
  usage: '/mirror @<target> [mN ...] [--tagged | --no-tag]',
  desc: 'forward existing items by mN id to a WA chat or re-dispatch to a brain',
};

export async function run({ arg, ctx }) {
  // ctx keys consumed:
  //   sysOut, EGPT_CONFIG
  //   sessions, USER_NAME, SURFACE_TAG, ts(), fmtTs(ms)
  //   items, itemByShortId
  //   waBridgeRef, waChannelsCacheRef
  //   scheduleReplyTargetSave()
  //   runBrainTurn(name, prompt, sessions)
  const { sysOut, EGPT_CONFIG, sessions, USER_NAME, SURFACE_TAG, ts, fmtTs,
          items, itemByShortId, waBridgeRef, waChannelsCacheRef,
          scheduleReplyTargetSave, runBrainTurn } = ctx;

  const parts = arg.split(/\s+/).filter(Boolean);
  const flagOn  = parts.includes('--tagged')  || parts.includes('-t');
  const flagOff = parts.includes('--no-tag')  || parts.includes('--no-tagged');
  const positional = parts.filter(t => !t.startsWith('-'));
  const target = positional[0];
  const msgRefs = positional.slice(1);
  const tagDefault = (EGPT_CONFIG.mirror?.tagged ?? 'on') !== 'off';
  // Per-call override wins. Both set → --no-tag wins (off is safer
  // than accidentally surprising a destination with attribution).
  const useTag = flagOff ? false : flagOn ? true : tagDefault;
  if (!target || !target.startsWith('@')) {
    sysOut(
      'usage: /mirror @<target> [mN [mN …]] [--tagged | --no-tag]\n' +
      '  @waN          forward to WA chat (from /channels)\n' +
      '  @<session>    re-dispatch the body to that brain as fresh input\n' +
      '  mN [mN …]     specific item ids; omitted = last visible message\n' +
      '  --tagged      prefix bodies with [author timestamp]: (overrides config)\n' +
      '  --no-tag      send bodies raw (overrides config)'
    );
    return true;
  }
  // Resolve items to forward. Empty msgRefs = pick last visible.
  const itemsToForward = [];
  if (msgRefs.length) {
    for (const r of msgRefs) {
      const m = r.match(/^m?(\d+)$/i);
      if (!m) { sysOut(`!! /mirror: "${r}" isn't an mN id`); return true; }
      const it = itemByShortId.current.get(`m${m[1]}`);
      if (!it) { sysOut(`!! /mirror: no message m${m[1]} in this session`); return true; }
      itemsToForward.push(it);
    }
  } else {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it._log) continue;
      if (it._localOnly) continue;
      if (it.author === 'system') continue;
      itemsToForward.push(it);
      break;
    }
    if (!itemsToForward.length) { sysOut('!! /mirror: nothing to mirror (no recent non-system message)'); return true; }
  }
  // Body builder per the tag policy.
  //   'You'    → USER_NAME@SURFACE_TAG (current local handle)
  //   'system' → 'egpt'                (terse)
  //   already qualified (cgpt1@kg, An@moto) → as-is
  const fmtTaggedAuthor = (a) => {
    if (a === 'You') return `${USER_NAME}@${SURFACE_TAG}`;
    if (a === 'system') return 'egpt';
    return a;
  };
  const bodyFor = (it) => {
    const raw = it.body ?? '';
    if (!useTag) return raw;
    return `[${fmtTaggedAuthor(it.author)} ${fmtTs(Math.floor(it.id))}]: ${raw}`;
  };

  // WA target: send each forwarded item via baileys and attach the
  // resulting WA-key as a multi-target _replyTarget on the original
  // item, so '@m<original> reply' fans out to this destination too.
  const waMatch = target.match(/^@wa(\d+)$/i);
  if (waMatch) {
    const idx = parseInt(waMatch[1], 10) - 1;
    const chat = waChannelsCacheRef.current[idx];
    if (!chat) { sysOut(`!! /mirror @wa${idx + 1}: no channel at that index. /channels first.`); return true; }
    const wa = waBridgeRef.current;
    if (!wa) { sysOut('!! /mirror: whatsapp bridge not running'); return true; }
    for (const it of itemsToForward) {
      const body = bodyFor(it);
      if (!body.trim()) { sysOut(`!! /mirror: m? body is empty, skipping`); continue; }
      try {
        const r = await wa.send(body, { chatId: chat.jid });
        const preview = body.length > 80 ? body.slice(0, 79) + '…' : body;
        sysOut(`→ /mirror @wa${idx + 1} "${chat.name}":\n  ${preview.replace(/\n/g, '\n  ')}`);
        if (r?.key) {
          const existing = it._replyTarget;
          const newTgt = { kind: 'wa', chatId: chat.jid, key: r.key, raw: { conversation: body } };
          const merged = Array.isArray(existing) ? [...existing, newTgt]
            : existing ? [existing, newTgt]
            : newTgt;
          it._replyTarget = merged;
          scheduleReplyTargetSave();
        }
      } catch (e) { sysOut(`!! /mirror @wa${idx + 1}: ${e.message}`); }
    }
    return true;
  }

  // @<session> — re-dispatch the body to that brain. Joins multiple
  // items into one prompt so the brain sees the full thread in order.
  // Tag policy applies to the prompt body.
  const sessionName = target.slice(1);
  if (sessions[sessionName]) {
    const senderTag = `${USER_NAME}@${SURFACE_TAG}`;
    const bodies = itemsToForward.map(bodyFor).join('\n\n');
    const prompt = `[${senderTag} ${ts()}]: ${bodies}`;
    sysOut(`→ /mirror @${sessionName}  (${itemsToForward.length} item${itemsToForward.length === 1 ? '' : 's'})`);
    await runBrainTurn(sessionName, prompt, sessions);
    return true;
  }

  sysOut(`!! /mirror: target "${target}" not recognised. @waN or @<session>.`);
  return true;
}
