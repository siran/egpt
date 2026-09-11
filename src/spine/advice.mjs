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

// WHICH CONNECTION AN OUTBOUND GOES OUT ON — the ONE resolver (sender.mjs makeOutbound), not a
// local copy of `bridgeOf(being, chatId) ?? bridge`. The ask is an outbound like any other and
// asks the same question; see the header on createAdvice below for why the answer matters more
// here than anywhere else.
import { makeOutbound } from './sender.mjs';

// ── WHICH CONNECTION THE ASK RIDES (operator 2026-09-11) ──────────────────────────────────────
// *"self doesn't have mouth. if mouth is available always use mouth."* This service held ONE
// frozen bridge — boot's fan-out facade, which delegates postStatus to the node's DEFAULT MOUTH —
// and asked nothing. `bridgeOf(being, chatId)` is the SAME per-chat resolver the reply path, the
// limbs, the member sender and every node-level announce already ask (src/spine/boot.mjs
// outboundConnectionFor): the mouth whenever it can reach the chat, the connection the chat lives
// on when it cannot. No being — an ask is the NODE consulting its operator, not a persona
// speaking — so `null` is passed, exactly as the announces do.
//
// AND THIS ONE IS NOT COSMETIC, because the ADVICE CHANNEL MUST BE A CHANNEL THIS NODE HEARS.
// `ask` stores the id postStatus hands back; `isAnswer(ev)` matches an INBOUND event's replyToId
// against those ids. An inbound only ever arrives on one of this node's EARS — every other
// connection boot opens is wrapped outbound-only and its onMessage is a no-op (boot's
// outboundOnly). So an ask posted on a connection this node does not hear can never be answered:
// the operator's quote-reply carries ids minted by a different account, in a different Matrix
// room, and the routing map can never match. On the live kg node — ear `primary` (anrodz42),
// default mouth `secondary` (dolly.egpt) — the frozen bridge posted every ask into an account
// whose answers this node is deaf to, so the whole mode:auto consult loop was open-circuit.
//
// Absent (every unit test, and any caller that has not been rewired) ⇒ the injected `bridge`, so
// nothing changes for a node with one connection, which is every node that has ever had one.
export function createAdvice({ bridge, bridgeOf = null, getConfig = () => ({}), onLog = () => {} } = {}) {
  if (!bridge) throw new Error('createAdvice: bridge is required');
  const cfg = () => getConfig() ?? {};
  // The advice channel: a chat NAME or a raw Beeper room id — bridge.send/postStatus
  // resolve names for us (same as agents.relay_channel). Empty/absent → not configured.
  const channel = () => { const c = cfg().advice_channel; const s = c == null ? '' : String(c).trim(); return s || null; };
  // …and the bridge that channel is posted on, asked per POST rather than frozen at construction:
  // `advice_channel` is re-read from config on every ask (a hot reload may change it), so the
  // connection question has to be re-asked with it. `route` is never consulted — no peerMouth is
  // passed and an ask is never said by the peer: it is this node consulting its own operator, in
  // a chat this node must HEAR the answer in.
  const outbound = makeOutbound({ bridge, bridgeOf });
  const bridgeFor = (to) => outbound(null, to).bridge;

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
      try { id = await bridgeFor(to).postStatus(to, text); } catch (e) { onLog(`ask: post to advice channel failed — ${e?.message ?? e}`); return false; }
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
