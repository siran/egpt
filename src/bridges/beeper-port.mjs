// beeper-port.mjs — the real Bridge behind the §2b port (plans/2606291226-SPINE-REWRITE-PLAN.md
// Phase 2). A thin adapter over startBeeperBridge that exposes ONLY the loop's
// Bridge interface, so the spine never sees the bridge's larger surface:
//
//   Bridge { onMessage(cb); onEdit(cb); onMedia(cb); send(chat, text);
//            startStream(chat, init) -> { update, finish }; stop() }
//
// The adapter's whole job is shape translation + late binding:
//   - inbound:  real `onIncoming(body, from)`  →  onMessage({ body, from })
//   - outbound: port `send(chat, text)`        →  real `send(text, { chatId })`   (arg order flips)
//   - stream:   port `startStream(chat, init)` →  real `startStreamMessage(init, { chatId })`
//
// `start` is injected (defaults to the real startBeeperBridge) so the adapter is
// unit-testable with a fake bridge — no Beeper, no network, no live account
// (tests/beeper-port.test.mjs). The live echo verify is tests-manual/phase2-echo.mjs.
import { startBeeperBridge } from './beeper.mjs';
import { makeWrapPersona } from './persona-wrap.mjs';
// THE live-frame marker — THE one definition (dispatch-line.mjs, beside its recogniser
// isLiveStreamFrame), the same '⏳' src/spine/sender.mjs stamps on every intermediate frame of a
// local reply. The showThink stream below reuses it rather than minting a second hour-clock: an
// observing peer classifies a streaming frame by this token's PRESENCE, so a private copy would
// drift the mesh mirror out of that classification the moment either literal changed.
import { LIVE_FRAME_MARK } from '../dispatch-line.mjs';

// The SETTLED counterpart of LIVE_FRAME_MARK for a showThink stream (operator 2026-08-31: "instead
// of 'done' please use an emoji"). ✅ is the very check the retired "✅ Done" carried — kept so the
// state the operator already reads as "finished" is unchanged, now alone and in the marker's own
// position. It lives here rather than in dispatch-line.mjs because, unlike ⏳, nothing classifies a
// frame by it: it is decoration on the settled text, not a signal any reader parses.
const DONE_MARK = '✅';

// NOTE (placeholder id resolution): resolveSentMessageId (beeper.mjs) text-matches
// the recent list and reduces with newerMsgId, which since d7614b8 picks the
// NUMERICALLY-largest id (a string compare ranked "9" > "10" and resolved the OLDER
// match — THAT bug is what the old per-turn nonce papered over). Beeper ids are
// monotonic per-chat sequence numbers, so among identical-text matches the just-posted
// placeholder is by construction the newest. The remaining hazard is TWO coexisting
// placeholders with the SAME text in one chat: the newest-wins reduce would then bind
// both streams to the same id (the live "second train stuck on ⏳ Thinking…" bug when a
// mention arrived mid-train). The v2 spine (spine.mjs) serializes a conversation's
// turns on a per-conversation FIFO queue, so only ONE turn STREAMS at a time per chat —
// its ACTIVE "⏳ Thinking…" placeholder is always the unique one of that text. A mention
// that arrives mid-train still posts its OWN placeholder immediately, but in the QUEUED
// state ("⏳ Queued (N ahead)…", src/spine/sender.mjs) — text that differs from the
// active THINKING and, via N, from every other queued placeholder — so each queued one
// resolves to its own id too. ⇒ no two coexisting placeholders share text; no
// disambiguating nonce needed.

// The persona stamp + concentric wrap live in ./persona-wrap.mjs now (operator 2026-07-25):
// ONE definition, shared with shell-port so the operator console renders a persona reply
// through the EXACT same machinery. personaStamp is the bridge-ENFORCED identifier
// ("🐶 egpt\n<reply>"); makeWrapPersona brackets it with the [bridge, agent] layers.

/**
 * @param {object} opts  forwarded verbatim to startBeeperBridge (beeperToken,
 *   networks, isAllowedUser, userName, media, holdGraceMs, …). The three host
 *   callbacks it carries — onIncoming / onMessageEdit / onMedia — are OWNED by
 *   this adapter and overwritten; pass the rest.
 * @param {{ start?: typeof startBeeperBridge }} [io]  injection seam for tests.
 * @returns {Promise<Bridge>}
 */
export async function createBeeperBridgePort(opts = {}, { start = startBeeperBridge } = {}) {
  // Late-bound handlers: the spine registers these AFTER construction (in
  // spine.start()), but the WS is already live, so onIncoming reads the ref at
  // call time rather than capturing it at construction.
  let onMsg = null, onEditCb = null, onMediaCb = null;

  // Runaway protection is no longer port-level: the SINGLE turn-counter guard
  // (src/stop-guard.mjs, wired at the spine's prompt chokepoint) is the whole loop-breaker
  // now — a provenance-aware count that catches the mesh-as-operator case the old port-level
  // flood guard existed for (plans/260722-COMMAND-SURFACE-ROADMAP.md phase 3). So this
  // adapter just shape-translates; every outbound passes straight through.
  const { ...rest } = opts;   // bridge_* + transcription_* stay in `rest` → forwarded to startBeeperBridge for the 👂 echo layers
  // Per-NODE infra WRAP (operator 2026-07-12): bridge_signature_open/close bracket EVERY fully
  // persona-STAMPED message — open ABOVE, close BELOW — identifying WHICH SPINE posted (REVE `kg`
  // vs DOLLY `do` sharing one Beeper account). Concentric with the per-AGENT agent_signature_open/
  // close (resolved per-being by the sender, delivered in opts). Both default EMPTY → output
  // byte-identical to today. Applied to EVERY send this port makes (operator 2026-07-25: "all
  // messages coming out from a spine to any surface are signed. period.") — a plain/auto post and
  // a system line carry the node's bridge layer too, only the persona STAMP is conditional. The
  // one exception is a mesh envelope (transport, not a surface send). See ./persona-wrap.mjs.
  const bridgeSignatureOpen = opts.bridgeSignatureOpen ?? '';
  const bridgeSignatureClose = opts.bridgeSignatureClose ?? '';
  // The STRUCTURAL layer (operator 2026-07-26): cfg.node_name, tag-encoded into invisible
  // characters and appended to every frame. The visible layers above are "prescindable"; THIS is
  // what identifies the node machine-readably, and boot refuses to start without a node_name.
  const nodeName = opts.nodeName ?? '';
  // Wrap what this node posts concentrically: outer bridge layer (per-node, above), inner agent
  // layer (per-being, from opts.agentSig*), around the stamped core. The composition lives in the
  // shared persona-wrap module (used identically by shell-port and by the 👂 echo one layer down);
  // this closure just binds this node's bridge-signature layer.
  const wrapPersona = makeWrapPersona({ bridgeSignatureOpen, bridgeSignatureClose, nodeName });
  const real = await start({
    ...rest,
    // Forward inbound to the spine. This resolves when the message's TURN completes
    // (spine enqueue awaits its own per-conversation queue), so a DIRECT caller —
    // boot's live-echo verify, tests — can await a message end-to-end. The real bridge
    // (beeper.mjs) deliberately does NOT await this in its dispatch chain: that would
    // re-serialize every conversation's turn and defeat placeholder-on-arrival. The
    // spine's enqueue pushes synchronously, so arrival order is preserved regardless.
    onIncoming: async (body, from) => { if (onMsg) await onMsg({ body, from }); },
    // Raw edit hook → port onEdit. Returns the host's truthy-if-consumed verdict
    // straight back to the bridge (used later by mesh to mirror streamed edits).
    onMessageEdit: async (chatId, msgId, newText, oldText) =>
      onEditCb ? onEditCb({ chatId, msgId, newText, oldText }) : false,
    // Media persistence hook → port onMedia. The bridge expects the saved path
    // (or video descriptor) back, so return whatever the host hands us.
    onMedia: async (m) => (onMediaCb ? onMediaCb(m) : undefined),
  });

  return {
    onMessage(cb) { onMsg = cb; },
    onEdit(cb) { onEditCb = cb; },
    onMedia(cb) { onMediaCb = cb; },

    // chat may be a room id, exact title, or slug — the real send resolves it.
    // The bridge ENFORCES the being's body_emoji (operator contract): prefix it
    // here so no caller can omit it.
    send(chat, text, opts = {}) {
      // wrapPersona brackets EVERY send with the bridge (+ agent) layers — the persona reply's
      // non-streamed §7 fallback, a plain/auto post, a system line. Only the persona STAMP needs
      // a bodyEmoji/label; the node signature does not (a mesh envelope is the one exception).
      return real.send(wrapPersona(opts, text), { chatId: chat, replyToMessageID: opts.replyTo ?? null });
    },

    // In-place edit-stream. Returns the §2b { update, finish, delete } plus
    // delivered / lastError passthrough: the sender's fallback-send must send fresh
    // ONLY when the stream did not deliver in place (§7 invariant — "the host
    // skips its fallback send only when the stream reports delivered").
    //
    // B — the streaming REPLY (the reply train, operator 2026-06-30). Replies to
    // the question (replyTo). This layer ENFORCES the body_emoji prefix + threads
    // the reply-to; the train markers (⏳ / "… ❌ Sending failed.") are the
    // sender's job, so update/finish only stamp + pass text through. opts:
    // { persona, bodyEmoji, replyTo }.
    startStream(chat, init, opts = {}) {
      // EVERY frame of the stream — placeholder, each intermediate edit, the settled final —
      // renders through the ONE wrap (operator 2026-07-26: "bridge must sign. always.
      // structurally."; on the placeholder specifically: "it should also sign 'thinking… 💸|🌉'").
      // Each frame is built from the RAW core, never from the previous frame, so replacing a
      // signed frame with the next one cannot accumulate signatures.
      const frame = (t) => wrapPersona(opts, t);
      // THE showThink PROGRESS MARKER (operator 2026-08-31, on the mesh living mirror in the
      // "perrito traducciones" group): "'done' is printed off the signature, which is kind of
      // strange" / "Done should replace the thinking hour-clock for when it is streaming a reply.
      // instead of 'done' please use an emoji." The marker used to be beeper.mjs's own final
      // edit — the frame, a blank line, then the words "✅ Done" — appended to an ALREADY-WRAPPED
      // frame, so it landed BELOW bridge_signature_close as detached debris; and it existed ONLY at
      // the end, so a streaming showThink reply carried no in-progress mark at all. It belongs
      // HERE, the one layer that still holds the RAW CORE: stamped on the core, the mark ends up
      // INSIDE the signature frame — exactly where sender.mjs puts ⏳ for the local reply train.
      //
      // ONE marker, two states, one position: ⏳ while it streams, ✅ once it settles. The done
      // state REPLACES the live one for free, because every frame is rebuilt from the core and
      // never from the previous frame (the same idempotence the wrap itself relies on) — so
      // there is never a second marker and never an extra trailing line.
      //
      // showThink is false for every ordinary reply and for the mesh's own plumbing frames
      // (mesh.mjs: the relay's placeholder and done-marker are deliberately not the AI-thinking
      // ones), so that path renders byte-for-byte as before. An EMPTY frame stays empty: the mesh
      // origin mirror opens its stream with '', which must not become a lone marker under a
      // signature with no content (the same rule wrapPersona applies one layer down).
      const mark = (t, m) => (opts.showThink && String(t ?? '').trim() ? `${t} ${m}` : t);
      // The placeholder is the wrapped init — it carries the body_emoji (so a
      // re-ingested copy is caught by the persona-marker echo-suppression). No nonce:
      // numeric newest-wins + monotonic per-chat ids + the spine's serialized turns
      // already resolve an identical-text match to THIS turn's message (see the
      // module-top note). Id resolution is unaffected by the wrap: beeper.mjs matches on the
      // very bytes it posted (sendMessage → postAndConfirm(…, String(text))).
      const placeholder = frame(mark(init, LIVE_FRAME_MARK));
      // existingMsgId passes through for the mesh living-mirror (Phase 4b): the ORIGIN edits an
      // ALREADY-posted placeholder (post_id) in place instead of posting a fresh one. Default
      // null → every existing caller (the reply train) is unaffected. showThink is NOT forwarded:
      // it is consumed HERE (see mark above) because only this layer holds the raw core.
      const h = real.startStreamMessage(placeholder, { chatId: chat, persona: opts.persona, replyToMessageID: opts.replyTo ?? null, existingMsgId: opts.existingMsgId ?? null });
      return {
        update: (t) => h.update(frame(mark(t, LIVE_FRAME_MARK))),
        finish: (t) => h.finish(frame(mark(t, DONE_MARK))),
        get delivered() { return h.delivered; },
        get lastError() { return h.lastError; },
        get confirmedId() { return h.confirmedId; },
        fail: (e) => h.fail?.(e),
      };
    },

    // A — the knee-jerk status message: post it (returns the confirmed id), edit
    // it, or delete it (the train deletes it once the reply starts streaming).
    //
    // SIGNED like every other send (operator 2026-07-25, "period"; fixed 2026-07-26, HANDOFF C12).
    // This was the one outbound here that skipped the wrap, and its other caller is the ADVICE
    // channel post (src/spine/advice.mjs) — a terminal message a human reads, which therefore went
    // out with no node signature on a two-node account. There is no persona to stamp on a status
    // line (no bodyEmoji/label), so only the bridge layer lands; with the slots empty the text is
    // byte-identical to before. The mesh's origin placeholder is signed too and is then EDITED in
    // place by the living-mirror stream, whose own final wrap replaces this text outright.
    async postStatus(chat, text) { return real.sendAndGetId ? real.sendAndGetId(wrapPersona({}, text), { chatId: chat }) : null; },
    // The edit REPLACES the text of a status line that postStatus signed — an unsigned edit strips
    // the node signature back off it, so it renders through the same wrap (C13, 2026-07-26).
    editStatus(chat, msgId, text) { return real.editMessage?.(chat, msgId, wrapPersona({}, text)); },
    deleteStatus(chat, msgId) { return real.deleteMessage?.(chat, msgId); },

    // Conversation-E LIMBS (ROADMAP §3). react/sendMedia are OUTBOUND sends; editOwn
    // mutate an existing message (no new send). A media caption + an edit are E speaking →
    // persona-stamped, exactly like send(). react carries no persona text.
    // No deleteOwn: there is no delete limb (operator 2026-08-24).
    react(chat, msgId, emoji) {
      return real.sendReaction?.(chat, msgId, emoji);
    },
    // A caption and an edit are E speaking to a surface, so they carry the node signature like
    // every other outbound (C13, 2026-07-26 — both used to stamp without wrapping).
    sendMedia(chat, filePath, opts = {}) {
      const caption = opts.caption != null ? wrapPersona(opts, opts.caption) : null;
      return real.sendMedia?.(chat, filePath, { caption, replyTo: opts.replyTo ?? null });
    },
    editOwn(chat, msgId, text, opts = {}) { return real.editMessage?.(chat, msgId, wrapPersona(opts, text)); },
    wasSentByUs(chat, msgId) { return real.wasSentByUs?.(chat, msgId); },
    // MEMBERSHIP (operator 2026-08-31) — "is <identity> a participant of this chat?", the ONE
    // question a `fallback_handle:` asks before waking (src/spine/router.mjs fallbackWake). Not an
    // outbound: a READ of this account's own copy of the roster, cached and TTL'd in the bridge.
    // A bridge without it (a test fake) answers null = UNKNOWN, which the router treats as "the
    // token stays its owner's" — never as absence.
    async chatHasParticipant(chat, identity) {
      return real.chatHasParticipant ? await real.chatHasParticipant(chat, identity) : null;
    },

    // NAME->ID (operator 2026-08-31) — `/members add group <chat name>` shipped in c63cdd6 and
    // has been INERT ever since, because this port exposed only the loop's Bridge interface and
    // the command's resolver seam therefore resolved to null: every name was refused with "give
    // the chat id instead". This forwards it.
    //
    // IT ALSO SWITCHES ON mesh.mjs's canonRoute + chatResolves, which BOTH guard on
    // `bridge.resolveChatId` and have consequently never run in production. Deliberate, not a
    // side effect: canonRoute resolves a relay_channel NAME to the canonical chat id before
    // sending, which is what sendMessage already did internally (chatIdOrName), so the delivered
    // outcome is unchanged for a channel that resolves — verified live, the do->kg relay answers
    // through egpt-mesh-do-kg today. What changes is the FAILURE path: an unresolvable channel
    // now falls back to the Self chat with a one-time notice instead of being dropped silently
    // ("send DROPPED … resolved=null"), and chatResolves starts verifying rather than assuming.
    // Both still fail safe on a throw.
    async resolveChatId(nameOrId, opts) {
      return real.resolveChatId ? await real.resolveChatId(nameOrId, opts) : null;
    },

    // THE CHAT LIST (operator 2026-08-31) — the same cached, paginated walk resolveChatId
    // above already reads, forwarded for MESSAGES only. Its one consumer is commands.mjs's
    // /members error wording: `add group`'s "no chat named" offers name near-misses off it,
    // and the "no member" roster uses it to put a NAME beside a wa-group member whose stored
    // chat id is all there is on disk. It resolves nothing — no argument becomes a member id
    // through this — so forwarding it switches on no routing, unlike resolveChatId above.
    async listChats(opts) {
      return real.listChats ? await real.listChats(opts) : [];
    },

    isAlive: () => real.isAlive(),
    stop: () => real.stop(),
  };
}
