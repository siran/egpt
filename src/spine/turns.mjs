// turns.mjs — the TURN MACHINERY, extracted from createSpine so the mesh can share it
// (operator 2026-08-31, after the live fault: the operator wrote in a WhatsApp group, E began
// answering, he wrote again, and got a SECOND bare "🤔 thinking…" instead of a queued indication
// or his line woven into the running turn).
//
// WHY IT HAD TO MOVE. Every one of these — the per-conversation FIFO, the in-flight/queued
// count that drives the queued placeholder, WHOSE message the live turn is answering, and the
// allow_new_input steer verdict — was closure-private to createSpine. src/spine/mesh.mjs's
// relayDispatch therefore called `brain.turn` DIRECTLY, and a relayed turn reached NONE of it.
// Measured on the responder, two envelopes for one origin conversation:
//
//     brain.turn calls  : 2     ← both in flight; warm-sessions.mjs chains them at the POOL
//     scopeOf consulted : 0     ← the spine never sees either
//     allowNewInput     : 0
//     steer             : 0
//     frames            : [ '🤔 thinking…', '🤔 thinking…' ]
//
// The turns WERE serialized — by the warm pool — so nothing raced the session file. What was
// missing is everything the spine would have provided around them. Since f70edce a relayed turn
// runs in the ORIGIN conversation, so a relayed turn and a LOCAL turn in the same chat derive the
// SAME key here and collide correctly; that is what makes ONE shared instance the whole fix.
//
// THIS IS A PURE MOVE. Every line below came out of spine.mjs unchanged in behaviour; the only
// behavioural tidy is folding the `keyOf` derivation that was DUPLICATED at spine.mjs's primary
// dispatch and its fan-out into the one definition here. boot.mjs builds ONE instance and injects
// it into BOTH createMeshService and createSpine — never two, because two queues keyed the same
// way is exactly the concurrency the queue exists to prevent.
import { makeSerialByKey } from '../serial-by-key.mjs';

// The steer ack's reactionKey — same convention as the /react limb (reply-actions.mjs's
// EMOJI_ALIASES 'eyes'): "seen", not "thinking" (that's the placeholder's job, and a woven
// message gets no placeholder).
const STEER_ACK_EMOJI = '👀';

/**
 * @param {{ brain: object, bridge?: object, bridgeOf?: Function, log?: {line?: Function} }} deps
 *        brain     — the Brain port (turn/scopeOf/allowNewInput/steer). Only the optional seams
 *                    are read here; a Brain without them can never steer and never re-scopes,
 *                    which is byte-identical to the pre-extraction spine.
 *        bridge /  — the steer ACK's send path, resolved per being exactly as the spine resolved
 *        bridgeOf    it (bridgeOf(being) ?? bridge, operator 2026-08-30 multi-connection Beeper).
 */
export function createTurns({ brain, bridge = null, bridgeOf = null, log = null } = {}) {
  const note = (s) => { try { log?.line?.(s); } catch {} };
  const bridgeFor = (being) => (bridgeOf ? (bridgeOf(being) ?? bridge) : bridge);

  const turnBy = makeSerialByKey();           // per-conversation turn FIFO (the §7 "one turn at a time per key")
  const trains = new Map();                    // convKey -> in-flight+queued turn count (drives the queued placeholder)
  function bumpTrain(key) { const ahead = trains.get(key) ?? 0; trains.set(key, ahead + 1); return ahead; }
  function dropTrain(key) { const n = (trains.get(key) ?? 1) - 1; if (n <= 0) trains.delete(key); else trains.set(key, n); }
  // WHOSE message is the turn currently STREAMING on this key answering (operator 2026-08-30,
  // allow_new_input)? `trains` cannot answer that: it is a COUNT of in-flight+queued turns,
  // which is all the queued-placeholder needs, and it says nothing about identity. The
  // same_sender tier needs identity, so this is the minimum state added beside it.
  //
  // Written by the TURN BODY only — set as its first act (it is already at the front of
  // turnBy, so it IS the live turn) and deleted in the same `finally` that drops the train,
  // which is what makes it correct on the throw path too. A QUEUED turn is deliberately
  // absent: there is no stream to weave into until it reaches the front. runContextTurn is
  // deliberately absent too — its reply is recorded and never surfaced, so a message steered
  // into one would be answered where nobody can read it. Absent ⇒ no steer ⇒ today's
  // queueing, which is the safe direction for every gap.
  //
  // THE CHAT is recorded beside the sender (operator 2026-09-01) because the KEY no longer
  // implies one: keyOf resolves it through brain.scopeOf, so a SHARED SCOPE puts several chats
  // on one key. Every caller that claims the live slot records both — see admitsNewInput.
  const liveTurnBy = new Map();                // convKey -> { senderId, chatId } of the message the LIVE turn is answering

  // Per-conversation turn key = the routed being + the conversation its INSTANCE lives in.
  // It maps 1:1 to the warm-pool key (`<being>:<engine>:<surface>:<slug>`) at the
  // granularity that matters — same being, same instance — so serializing on it is exactly
  // "one turn at a time per warm key". Different instances (or different beings) key apart
  // and run concurrently. Also the CYCLE key: ambient lines accumulate under it so a
  // later queued mention on the same conversation drains exactly this chat's cycle.
  //
  // brain.scopeOf (operator 2026-08-31) is what makes "this conversation" and "its instance"
  // two different questions: a WhatsApp group invited into room/acim as a `wa-group` member
  // runs on the ROOM's thread and the ROOM's warm process, so it has to queue on the ROOM's
  // key too. A per-chat key here beside a per-room warm key is exactly the split that puts
  // two `claude --resume <same id>` processes on one session file. HEAD-OF-LINE BLOCKING IS
  // THE ACCEPTED PRICE (the operator has been told): the room and every group joined to it
  // share ONE queue, and no concurrency is added to dodge it — the concurrency IS the defect.
  // OPTIONAL SEAM: a Brain without scopeOf (every test fake, every older caller) falls back
  // to the event's own address, which is byte-identical to the line this replaces.
  //
  // ONE DEFINITION (2026-08-31): this derivation used to be written out twice in spine.mjs —
  // once for the message's own target, once per fan-out target — which is two places for the
  // warm-key/queue-key correspondence to drift apart. It is now called from four.
  //
  // IT RETURNS THE PIN WITH THE KEY (operator 2026-09-01). A being PINNED node-wide is prompted
  // with the message that arrived, never with the key's accumulated cycle — and this is the ONE
  // place a dispatch resolves the scope, so the flag comes out of the resolve that already
  // happened. Asking brain.scopeOf a second time inside the turn would read config twice per
  // turn and could answer differently from the key the turn is queued on. `pinned` is normalized
  // to a boolean here so every caller compares one shape; a Brain without scopeOf (every test
  // fake, every older caller) falls back to the event, which carries no flag ⇒ false ⇒ unchanged.
  async function keyOf(being, ev) {
    const scope = (await brain.scopeOf?.(being, ev)) ?? ev;
    return { key: `${being}:${scope.surface}:${scope.chatId}`, pinned: scope.pinned === true };
  }

  // THE ONE allow_new_input VERDICT, asked by both halves of the rule (operator 2026-08-31).
  // Returns the RESOLVED policy string when `ev` is admitted into the turn `live` is answering,
  // else false. Split out of steerLiveTurn so the ORIGIN of a mesh relay can ask exactly the same
  // question about a turn running on ANOTHER node — "the mesh is only transport", so the
  // placeholder's lifecycle is decided locally, by this, and nothing new crosses the wire.
  async function admitsNewInput(to, ev, live) {
    if (!live) return false;                          // nothing streaming on this key to steer
    if (typeof brain.allowNewInput !== 'function') return false;
    let allow;
    try { allow = await brain.allowNewInput(to, ev); }
    catch (e) { note(`allow_new_input ${to}/${ev.chatId}: ${e?.message ?? e}`); return false; }
    // 'none' (and any value brainpool could not normalize) reads as "queue" here. Deliberately
    // an allowlist, not a denylist: an unexpected value must fall to today's behavior, never
    // to the widest one.
    //
    // THE CHAT MUST MATCH FOR ANY STEER, IN BOTH TIERS (operator 2026-09-01: "keep the same
    // sender+group: add, different sender+group: enqueue"). The sender alone was enough only
    // while a turn key meant exactly one chat; keyOf resolves the key through brain.scopeOf, so
    // a SHARED SCOPE now puts several chats on one key — room/acim and the WhatsApp group
    // "perrito traduciones" share one today. A group member writing while the ROOM's turn is
    // streaming passed the sender test and was WOVEN IN, which means his caller produced nothing
    // for HIS chat (no placeholder, no reply, just the 👀) while the live turn's answer went to
    // ITS origin, the room, where he cannot read it. This is a NO-OP for every unscoped
    // conversation — there the key already implies one chat, so ev.chatId always equalled
    // live.chatId — and it bites only where a scope is shared, which is exactly where it is
    // needed. Strict, the both-null case included: a caller that forgot to record the chat must
    // fail CLOSED (queue), same reason as the allowlist above.
    const sameChat = (ev.chatId ?? null) === (live.chatId ?? null);
    const admits = sameChat && (allow === 'any' || (allow === 'same_sender' && (ev.senderId ?? null) === live.senderId));
    return admits ? allow : false;
  }

  // STEER THE LIVE TURN (operator's ruling 2026-08-30, `allow_new_input`). A message that
  // arrives while a turn is ALREADY streaming on this key can be WOVEN INTO that turn instead
  // of queueing behind it — the running turn then answers the new instruction, in ONE reply.
  //
  // WHY THIS IS POSSIBLE AT ALL: measured 2026-08-30 against the real `claude --input-format
  // stream-json` CLI. A second user line written to a live stdin mid-turn is ABSORBED by an
  // AGENTIC turn at a tool boundary (one result, answering the new instruction, 4 of 6 planned
  // Reads abandoned, then 143s of silence — no second result), while a pure-text turn instead
  // finishes and answers twice. See warm-cli-session.mjs's header for the full measurement.
  // ONLY ccode was measured; pi is untested and llama has no stream — neither exports `inject`,
  // so both land on the false branch below and queue exactly as they do today.
  //
  // TRUE means the message was genuinely woven in, and the caller must then produce NOTHING
  // NEW FOR THE CONVERSATION: no placeholder, no reply, no train — only a lightweight reaction
  // on the inbound message itself (below), acking that it was received and folded in (operator
  // 2026-08-30: silently absorbing it read as dropped). FALSE means NOTHING HAPPENED — not "it
  // half happened" — so the caller falls straight through to openAndRunReply, i.e. today's
  // behavior. That sharpness is the whole safety story: the pool's `steer` never runs a turn as
  // a fallback (warm-sessions.mjs), so a false can never leave a turn running that nobody delivers.
  //
  // Both brain seams are OPTIONAL. A spine wired with a Brain that has neither (every test
  // fake, every older caller) can never steer, and is byte-identical to before.
  //
  // `ack` (2026-08-31): the 👀 goes on the INBOUND MESSAGE, so it needs a message to sit on. A
  // RELAYED turn's synthetic event has `msgId: null` — the real message lives on the ORIGIN
  // node's account, on the other side of the wire — so the responder passes ack:false and the
  // reaction is simply not attempted. Every local caller omits it and is unchanged.
  async function steerLiveTurn({ to, ev, turnKey, ack = true }) {
    const live = liveTurnBy.get(turnKey);
    if (!live) return false;                          // nothing streaming on this key to steer
    if (typeof brain.steer !== 'function' || typeof brain.allowNewInput !== 'function') return false;
    const allow = await admitsNewInput(to, ev, live);
    if (!allow) return false;
    let woven = false;
    try { woven = await brain.steer(to, ev); }
    catch (e) { note(`steer ${to}/${ev.chatId}: ${e?.message ?? e}`); return false; }
    if (woven !== true) return false;                 // the turn ended between the check and the push — queue it
    note(`steer ${to}/${ev.chatId}: wove ${ev.senderName ?? ev.senderId ?? '?'}'s message into the live turn (allow_new_input=${allow})`);
    // ACK the steered message itself (operator 2026-08-30): a woven message gets no placeholder
    // and no reply of its own — it's folded into the live turn's ONE eventual answer — so without
    // this its sender sees nothing until then. A reaction, not a message: it doesn't open a
    // second train. Same primitive + reactionKey convention as the /react limb (reply-actions.mjs,
    // bridge.react → beeper's sendReaction). Best-effort: a reaction fault must never undo the
    // steer that already landed.
    if (ack) {
      try { await bridgeFor(to).react?.(ev.chatId, ev.msgId, STEER_ACK_EMOJI); }
      catch (e) { note(`steer-ack ${to}/${ev.chatId}: ${e?.message ?? e}`); }
    }
    return true;
  }

  // THE ORIGIN'S HALF OF THE SAME RULE (operator 2026-08-31: "the mesh is only transport").
  //
  // A `@being.node` message whose target lives on ANOTHER node cannot be steered here — there is
  // no local turn to weave into, and asking the responder would need a new wire frame, which the
  // operator ruled against. But the ORIGIN does not need to ask: it sent envelope #1 and has not
  // seen `done:true` come home, so "a turn is in flight over there" is a fact it already holds
  // (mesh.mjs's relayInFlight). Feed that in as the live turn's identity and the SAME
  // allow_new_input verdict decides, at the SAME point in the sequence the local rule decides —
  // BEFORE anything opens a placeholder.
  //
  // TRUE ⇒ forward the line and open NO second placeholder, no origin-wait timer, nothing on the
  // wire that was not already there. It is a bet on the responder weaving, and it is SAFE when
  // the bet loses: the responder that queues instead still answers, and its reply posts FRESH in
  // the origin chat (it carries a synthetic post_id, which openOriginStream never PATCHes) rather
  // than resolving a placeholder that was never opened. Nothing strands either way.
  //
  // NO 👀 HERE. The ack is the local rule's; over the mesh the operator ruled that nothing new
  // crosses, and the answer he is waiting on is already streaming into his chat as the living
  // mirror of turn #1 — the woven line lands inside it.
  async function steerRelayedTurn({ to, ev, live }) {
    const allow = await admitsNewInput(to, ev, live);
    if (!allow) return false;
    note(`steer ${to}/${ev.chatId}: forwarded ${ev.senderName ?? ev.senderId ?? '?'}'s message into the relay already in flight — no second placeholder (allow_new_input=${allow})`);
    return true;
  }

  return {
    // the FIFO itself — serial(key, fn), fn's result awaitable by the caller
    serial: turnBy,
    // bump returns how many turns were ALREADY on this key — the queued placeholder's "N ahead"
    bump: bumpTrain,
    drop: dropTrain,
    // { key, pinned } — the key every seam below takes, and the pin the prompt is built from
    keyOf,
    // the live-turn identity register. Set as the turn body's FIRST act, cleared in the same
    // `finally` that drops the train.
    setLive: (key, live) => { liveTurnBy.set(key, live); },
    clearLive: (key) => { liveTurnBy.delete(key); },
    steerLiveTurn,
    steerRelayedTurn,
  };
}
