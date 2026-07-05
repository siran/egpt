// advice.mjs — the `mode: auto` consult channel (ROADMAP §3, operator 2026-07-04).
//
// In an auto conversation E plays the operator's role; when it is unsure it consults
// the operator via the /ask limb (src/spine/reply-actions.mjs). This service is the
// ONE sanctioned cross-chat path E has: it posts that question to a SINGLE config-named
// chat (`advice_channel`, same trust shape as agents.relay_channel) and routes the
// operator's reply back into the origin conversation.
//
//   ask({ ev, question })  — post the question to the advice channel, tagged with the
//                            origin conversation's name; store originMsgId → origin so a
//                            quote-reply can find its way home. Fail-closed (drop + log)
//                            when advice_channel is unset. Called by the /ask limb.
//   isAnswer(ev)           — true iff ev is a quote-reply to one of our posted asks (the
//                            reply-to id is a stored ask id — which, by construction, was
//                            only ever posted into the advice channel). Consulted EARLY in
//                            the spine (before gating), so the operator's answer never
//                            triggers a normal reply in the advice channel.
//   routeAnswer(ev)        — inject the operator's answer as a turn into the ORIGIN
//                            conversation (private guidance, framed so the participants
//                            there never saw it). Fire-and-forget via the bound dispatch
//                            (spine.handleInbound) so the pump stays fast.
//   useDispatch(fn)        — late-bind the spine's dispatch (createSpine returns it AFTER
//                            this service is constructed).
//
// The pending map is in-memory (like the mesh origin-wait): a restart between an /ask and
// its answer simply loses the routing — the operator's reply then falls through to normal
// gating in the advice channel (harmless), never a wrong route.

export function createAdvice({ bridge, getConfig = () => ({}), onLog = () => {} } = {}) {
  if (!bridge) throw new Error('createAdvice: bridge is required');
  const cfg = () => getConfig() ?? {};
  // The advice channel: a chat NAME or a raw Beeper room id — bridge.send/postStatus
  // resolve names for us (same as agents.relay_channel). Empty/absent → not configured.
  const channel = () => { const c = cfg().advice_channel; const s = c == null ? '' : String(c).trim(); return s || null; };

  let _dispatch = null;                          // late-bound spine.handleInbound

  // originMsgId (the CONFIRMED id of an ask we posted) → the origin conversation. Bounded
  // so a chatty node can't grow it without limit (oldest ask evicted first).
  const pending = new Map();
  const PENDING_CAP = 500;
  function remember(id, origin) {
    if (id == null) return;
    pending.set(String(id), origin);
    if (pending.size > PENDING_CAP) pending.delete(pending.keys().next().value);
  }

  return {
    useDispatch(fn) { _dispatch = typeof fn === 'function' ? fn : null; },

    // Post E's question to the advice channel. Returns true iff it was delivered (and
    // the origin mapping stored). Fail-closed: no advice_channel → log + false, so the
    // /ask is a no-op and E's prose still surfaced in its own chat.
    async ask({ ev, question } = {}) {
      const to = channel();
      const q = String(question ?? '').trim();
      if (!to) { onLog(`ask: advice_channel not configured — question dropped (fail-closed): ${JSON.stringify(q.slice(0, 120))}`); return false; }
      if (!q) { onLog('ask: empty question — dropped'); return false; }
      const originName = ev?.chatName ?? ev?.chatId ?? 'a conversation';
      const surface = ev?.surface ?? 'whatsapp';
      const text = `❓ eGPT needs advice — «${originName}» (${surface}):\n${q}\n\n↩ reply to this message to answer.`;
      // postStatus resolves the CONFIRMED message id (the same id the operator's
      // quote-reply will carry as replyToId) — the routing key. A name resolves to a
      // room id inside the bridge; a plain send can't hand back the confirmed id.
      let id = null;
      try { id = await bridge.postStatus(to, text); } catch (e) { onLog(`ask: post to advice channel failed — ${e?.message ?? e}`); return false; }
      if (id == null) { onLog(`ask: advice channel post returned no id (chat ${JSON.stringify(to)}) — not routable`); return false; }
      remember(id, { surface, chatId: ev?.chatId, chatName: ev?.chatName ?? ev?.chatId });
      onLog(`ask: posted from «${originName}» → advice channel (#${id})`);
      return true;
    },

    // A quote-reply to one of our asks? The reply-to id being a KNOWN ask id is precise
    // and self-contained: those ids were only ever posted into the advice channel, so no
    // chat-id comparison (name-vs-id) is needed.
    isAnswer(ev) { return !!(ev?.replyToId && pending.has(String(ev.replyToId))); },

    // Route the operator's answer into the origin conversation as a turn. Framed as
    // PRIVATE guidance (the origin participants never saw the ask/answer). Fire-and-forget
    // through the bound dispatch — the origin chat's own per-conversation FIFO still
    // serializes it — so the spine pump isn't blocked on the origin turn.
    async routeAnswer(ev) {
      const key = String(ev?.replyToId ?? '');
      const origin = pending.get(key);
      if (!origin) return false;
      pending.delete(key);                          // one answer per ask (v1)
      if (!_dispatch) { onLog('advice: dispatch not bound — answer not routed'); return false; }
      const answer = String(ev?.body ?? '').trim();
      if (!answer) { onLog('advice: empty answer — not routed'); return false; }
      const body = `[operator guidance for this chat, relayed privately from the advice channel — the people here did not see this]: ${answer}`;
      // A synthetic inbound for the ORIGIN chat. from.network = the origin surface (the
      // surface names are also recognized network prefixes, so identity.build re-derives
      // the same surface). No msgKey → no quote; auto/on mode replies regardless of mention.
      const from = {
        network: origin.surface, chatId: origin.chatId, chatName: origin.chatName,
        userId: ev?.senderId ?? null, senderName: 'operator',
        authorized: true, isSender: !!ev?.isSender, msgKey: null,
      };
      onLog(`advice: routing operator answer → «${origin.chatName ?? origin.chatId}»`);
      Promise.resolve(_dispatch({ body, from })).catch((e) => onLog(`advice: route failed — ${e?.message ?? e}`));
      return true;
    },
  };
}
