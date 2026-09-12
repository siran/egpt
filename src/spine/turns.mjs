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
// WHICH CONNECTION AN OUTBOUND GOES OUT ON, asked of the ONE resolver rather than answered again
// here. sender.mjs owns it because sender.mjs is THE reply path, and the steer ack below has to
// agree with the reply or it announces which account is really listening (see its header).
import { makeOutbound } from './sender.mjs';

// THE TWO REACTIONS, AND THEY ARE A PAIR (operator 2026-09-09, after `Joyce Vicente-2606301852`
// swallowed ~90 minutes of the operator's messages behind four confident 👀s and total silence).
//
//   📩  THE BRIDGE HAS IT. Placed on arrival, the moment this node accepts a message as destined
//       for an agent's live turn. It is a claim about THIS PROCESS and nothing else — "a message
//       to the bridge should be reacted to immediately by the bridge" — so it is honest by
//       construction and can never be wrong.
//   👀  THE MODEL TOOK IT. Placed only on evidence of ingestion from the CLI itself (the
//       `--replay-user-messages` echo, see warm-cli-session.mjs's header). This is the one that
//       lied: it used to fire because `inject()` returned true, and `inject()` returned true
//       because a write to a live process's pipe succeeded — which says nothing about whether
//       anything on the other end ever read it.
//
// 📩 WITH NO 👀 FOLLOWING IS NOW A VISIBLE SYMPTOM, in the chat, at the time. That is the whole
// point of keeping both: in the Joyce incident the operator would have seen four 📩 and no 👀 —
// received, never ingested — instead of four 👀 that each claimed the model had it.
//
// SCOPE, deliberately narrow: only traffic ADMITTED into a live turn (below, once admitsNewInput
// has said yes) — which is exactly the population that carried the 👀 before. Not every passing
// message in every group; that would be noise, and a group's ordinary chatter is not addressed
// to anyone here. A message that is NOT admitted queues and gets its own placeholder, which is
// already a visible receipt.
//
// Same reactionKey convention as the /react limb (reply-actions.mjs's EMOJI_ALIASES): "seen", not
// "thinking" — that's the placeholder's job, and a woven message gets no placeholder.
const RECEIPT_EMOJI = '📩';
const STEER_ACK_EMOJI = '👀';

/**
 * @param {{ brain: object, bridge?: object, bridgeOf?: Function, log?: {line?: Function} }} deps
 *        brain     — the Brain port (turn/scopeOf/allowNewInput/steer). Only the optional seams
 *                    are read here; a Brain without them can never steer and never re-scopes,
 *                    which is byte-identical to the pre-extraction spine.
 *        bridge /  — the steer ACK's send path, resolved through the ONE outbound resolver
 *        bridgeOf /   (sender.mjs makeOutbound): the being's own connection, and — when another
 *        peerMouth    account is the mouth for this chat — whatever lets THAT mouth place the ack
 *                     instead (peerMouth.react), whether it is a peer spine across a socket or a
 *                     second connection on this node. Absent peerMouth (every single-account
 *                     node, every test fake) ⇒ no mouth is ever consulted and this is
 *                     byte-identical to before.
 */
export function createTurns({ brain, bridge = null, bridgeOf = null, peerMouth = null, log = null } = {}) {
  const note = (s) => { try { log?.line?.(s); } catch {} };
  const outbound = makeOutbound({ bridge, bridgeOf, peerMouth, onLog: note });

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

  // PLACE ONE OF THE TWO REACTIONS ON THE INBOUND MESSAGE. ONE function, called twice, because
  // 📩 and 👀 differ only in what they mean — never in where they go or who says them.
  //
  // AND IT RIDES THE MOUTH THE REPLY RIDES (operator 2026-09-07). This asked `bridgeOf(being) ??
  // bridge` and stopped there, while the reply path additionally asked the peer mouth — two
  // answers to one question, and in a group holding both accounts they disagreed in public: the
  // 👀 came from the PRIMARY and the answer from the SECONDARY, which is precisely what betrays
  // which account is doing the listening. Both now ask makeOutbound.
  //
  // WHICHEVER MOUTH SAYS THE REPLY PLACES THE REACTION (operator 2026-09-07). It sits ON the
  // inbound message, and the two accounts see one real message as two different Matrix events in
  // two different rooms — id 2901 here, 1118 there, measured — so for one release this was
  // SUPPRESSED: the mouth had no way to be told which message and this account must not react
  // when it is not the one answering. A message is now named the same way a chat has always been
  // named, by a key both accounts compute alike (beeper.crossAccountMsgKey), so the ack goes
  // where the answer goes — over the link when the mouth is a peer spine (src/shell/mouth.mjs
  // `say: react`), and straight onto that connection's own bridge when the mouth is a second
  // connection on THIS node (src/spine/boot.mjs makePeerMouth, reactLocally). Nothing here has to
  // know which: route() answers, react() serves whichever it answered.
  //
  // SUPPRESSION IS THE FALLBACK, NOT THE ANSWER. Every way the mouth can fail to place it — it
  // cannot key the message, the link is down, it finds no match, it finds two — ends with NO
  // REACTION ANYWHERE and a log line naming the reason. That is the OLD behaviour, kept exactly,
  // as the floor: a missing reaction is cosmetic, a reaction from the wrong account is the bug.
  //
  // Best-effort by contract: it never throws, so a reaction fault can never undo a steer that
  // already landed, and never becomes an unhandled rejection on the 👀's deferred path below.
  async function placeReaction(to, ev, emoji) {
    const { bridge: mouth, route } = outbound(to, ev.chatId);
    const says = route();                             // null with no mouth wired — never awaited, so that path is untouched
    const mouthChat = says ? await says : null;
    if (mouthChat) {
      // The mouth's own refusals are logged by name where they happen; this line says what it cost.
      const who = mouthChat.connection ? `'${mouthChat.connection}'` : 'the peer';
      let r = null;
      try { r = await peerMouth.react?.(mouthChat, { msgKey: ev.msgHash, timestamp: ev.msgTs, emoji }); }
      catch (e) { note(`steer-ack ${to}/${ev.chatId}: asking ${who} to react threw — ${e?.message ?? e}`); }
      if (r?.ok) note(`steer-ack ${to}/${ev.chatId}: ${who} is saying this reply and placed the ${emoji} on its own copy (its chat ${r.chatId})`);
      else note(`steer-ack ${to}/${ev.chatId}: ${who} is saying this reply but could not place the ${emoji} (${r?.reason ?? 'no answer'}${r?.detail ? `: ${r.detail}` : ''}) — no reaction from this account either, it is not the one answering`);
    } else {
      try { await mouth.react?.(ev.chatId, ev.msgId, emoji); }
      catch (e) { note(`steer-ack ${to}/${ev.chatId}: ${e?.message ?? e}`); }
    }
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
  // TRUE means the message was HANDED TO the live turn, and the caller must then produce NOTHING
  // NEW FOR THE CONVERSATION: no placeholder, no reply, no train — only the reactions on the
  // inbound message itself (above), because silently absorbing it read as dropped (operator
  // 2026-08-30). FALSE means NOTHING HAPPENED — not "it half happened" — so the caller falls
  // straight through to openAndRunReply, i.e. today's behavior. That sharpness is the whole
  // safety story: the pool's `steer` never runs a turn as a fallback (warm-sessions.mjs), so a
  // false can never leave a turn running that nobody delivers.
  //
  // HANDED TO IS NOT INGESTED BY, AND THE RETURN VALUE STILL CANNOT TELL THEM APART (operator
  // 2026-09-09, OPEN). Whether the model TOOK the line is knowable — that is what `handed.ack`
  // answers — but not in time to be this function's answer: measured on the real CLI, the ack
  // lands in ~1.2s inside an agentic turn and only at the turn's END for a pure-text one (1.03s
  // there, but the turn was short; on a long turn it is the whole turn). This function runs
  // inside the spine's SINGLE node-wide inbound pump (spine.mjs `pump`), so awaiting the ack
  // here would stall every other conversation on the node for the length of one model's turn.
  // Deciding queue-vs-steer on the ack therefore needs the decision to move off the pump, which
  // is a reshape of the dispatch order rather than a change here — flagged for a ruling, not
  // invented. What IS fixed: the 👀 no longer rides the return value, so the chat now shows the
  // difference even where this boolean cannot.
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

    // 📩 — THE BRIDGE'S OWN RECEIPT, PLACED BEFORE THE STEER IS EVEN ATTEMPTED (operator
    // 2026-09-09: "a message to the bridge should be reacted to immediately by the bridge").
    // Its truth does not depend on anything below it, which is the entire reason it exists.
    // STARTED here rather than awaited, so it never delays the write into the live turn, and
    // JOINED before either exit below, so it can never land after the 👀 or after the caller
    // has already opened a queued placeholder.
    const receipt = ack ? placeReaction(to, ev, RECEIPT_EMOJI) : null;

    const who = ev.senderName ?? ev.senderId ?? '?';
    let handed = false;
    try { handed = await brain.steer(to, ev); }
    catch (e) {
      if (receipt) await receipt;
      note(`steer FAILED ${to}/${ev.chatId}: the brain threw handing ${who}'s message to the live turn — ${e?.message ?? e}; queueing it instead`);
      return false;
    }
    if (receipt) await receipt;
    // NOTHING WAS HANDED OVER — and it is an error, not a shrug. The caller queues (that
    // fallthrough is unchanged and is what keeps a false structurally safe), but the reason it
    // had to is now in the log instead of nowhere. The layers below name it more precisely
    // still: warm-sessions.mjs says WHICH refusal, warm-cli-session.mjs says why the session
    // could not take it.
    if (!handed) { note(`steer FAILED ${to}/${ev.chatId}: nothing was handed to the live turn for ${who}'s message — queueing it instead`); return false; }
    // HANDED OVER IS NOT INGESTED, AND THIS LINE NO LONGER PRETENDS OTHERWISE. It used to read
    // "wove … into the live turn", said on the strength of a successful stdin write.
    note(`steer ${to}/${ev.chatId}: handed ${who}'s message to the live turn (allow_new_input=${allow})`);

    // 👀 — THE MODEL'S OWN ACKNOWLEDGEMENT, AND ONLY THAT (operator 2026-09-09). `handed.ack`
    // settles from CLI events alone (warm-cli-session.mjs: the `--replay-user-messages` echo of
    // the very line, or the turn ending/failing/closing without one) — never from a clock. It is
    // deliberately NOT awaited: it can take the rest of a pure-text turn to answer, and this
    // function runs inside the spine's single node-wide inbound pump, which must not stall behind
    // one conversation's model. A reaction has no deadline, so it is placed when the evidence
    // arrives, and never at all when it does not — which is exactly the Joyce symptom made
    // visible: 📩 alone, in the chat, with the reason in the log.
    //
    // A `steer` seam that answers a bare `true` (an older Brain, every test fake) carries no
    // evidence, so it gets no 👀. That is the contract stated as a default rather than enforced
    // with a branch.
    const evidence = handed?.ack;
    if (ack && typeof evidence?.then === 'function') {
      evidence.then(async (r) => {
        if (r?.ok) {
          note(`steer ${to}/${ev.chatId}: the model took the steered message — placing the ${STEER_ACK_EMOJI}`);
          await placeReaction(to, ev, STEER_ACK_EMOJI);
        } else {
          note(`steer NEVER INGESTED ${to}/${ev.chatId}: ${who}'s message was handed to the live turn and the model never took it (${r?.reason ?? 'no reason given'}) — the ${RECEIPT_EMOJI} stands alone; there is no ${STEER_ACK_EMOJI} to place`);
        }
      }).catch((e) => note(`steer-ack ${to}/${ev.chatId}: ${e?.message ?? e}`));
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
