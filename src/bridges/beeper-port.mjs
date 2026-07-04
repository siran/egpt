// beeper-port.mjs — the real Bridge behind the §2b port (SPINE-REWRITE-PLAN.md
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
import { createFloodGuard } from '../flood-guard.mjs';

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

// The bridge-ENFORCED persona identifier: body_emoji + persona name as the FIRST
// LINE, then the reply. A leading model-written self-label ("egpt:") is stripped so
// the identifier is the bridge's, not the model's. No body_emoji (system sends) →
// text passes through untouched.
const _escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function personaStamp(bodyEmoji, label, text) {
  if (!bodyEmoji) return text;
  if (!label) return `${bodyEmoji} ${text}`;   // body_emoji only (system/echo sends) → inline, no header line
  const clean = String(text).replace(new RegExp(`^\\s*${_escapeRe(label)}\\s*[:：]\\s*`, 'i'), '');
  return `${bodyEmoji} ${label}\n${clean}`;      // persona line: "🐶 egpt" then the reply
}

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

  // Flood guard — the LAST line of defense against a send flood (a reply loop, a
  // backlog replay, an echo-suppression miss). Every outbound (send + stream open)
  // passes through it; > `limit` to one chat within `windowMs` PAUSES that chat for
  // `cooldownMs`. This is port-level, so it is not forwarded to startBeeperBridge.
  const { flood = {}, ...rest } = opts;
  const onLog = opts.onLog ?? (() => {});
  const floodGuard = createFloodGuard({
    limit: Number(flood.limit ?? 10) || 10,
    windowMs: Number(flood.window_ms ?? 3_000) || 3_000,
    cooldownMs: Number(flood.cooldown_ms ?? 60_000) || 60_000,
    onTrip: (chat, n, win) => onLog(`flood-guard: ⛔ FLOOD on ${chat} — ${n} sends in ${win / 1000}s; sends PAUSED (cooldown)`),
  });
  const NOOP_STREAM = { update() {}, finish() {}, delete() {}, get delivered() { return false; }, get lastError() { return 'flood-paused'; }, fail() {} };

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
      if (!floodGuard.allow(chat)) { onLog(`flood-guard: send to ${chat} BLOCKED (flood pause)`); return { blocked: true }; }
      return real.send(personaStamp(opts.bodyEmoji, opts.label, text), { chatId: chat, replyToMessageID: opts.replyTo ?? null });
    },

    // In-place edit-stream. Returns the §2b { update, finish, delete } plus
    // delivered / lastError passthrough: the sender's fallback-send must send fresh
    // ONLY when the stream did not deliver in place (§7 invariant — "the host
    // skips its fallback send only when the stream reports delivered").
    //
    // B — the streaming REPLY (the reply train, operator 2026-06-30). Replies to
    // the question (replyTo). This layer ENFORCES the body_emoji prefix + threads
    // the reply-to; the train markers (⏳ / ∎ / "… ❌ Sending failed.") are the
    // sender's job, so update/finish only stamp + pass text through. opts:
    // { persona, bodyEmoji, replyTo }.
    startStream(chat, init, opts = {}) {
      // A stream OPEN counts as a send for the flood guard (a reply loop = many
      // opens); a flood-paused chat gets an inert handle so the sender no-ops.
      if (!floodGuard.allow(chat)) { onLog(`flood-guard: stream to ${chat} BLOCKED (flood pause)`); return NOOP_STREAM; }
      const stamp = (t) => personaStamp(opts.bodyEmoji, opts.label, t);
      // The placeholder is just the stamped init — it carries the body_emoji (so a
      // re-ingested copy is caught by the persona-marker echo-suppression). No nonce:
      // numeric newest-wins + monotonic per-chat ids + the spine's serialized turns
      // already resolve an identical-text match to THIS turn's message (see the
      // module-top note).
      const placeholder = stamp(init);
      // existingMsgId + showThink pass through for the mesh living-mirror (Phase 4b):
      // the ORIGIN edits an ALREADY-posted placeholder (post_id) in place instead of
      // posting a fresh one, and showThink appends "✅ Done" on the final frame. Default
      // null/false → every existing caller (the reply train) is unaffected.
      const h = real.startStreamMessage(placeholder, { chatId: chat, persona: opts.persona, replyToMessageID: opts.replyTo ?? null, existingMsgId: opts.existingMsgId ?? null, showThink: opts.showThink ?? false });
      return {
        update: (t) => h.update(stamp(t)),
        finish: (t) => h.finish(stamp(t)),
        delete: () => h.delete?.(),
        get delivered() { return h.delivered; },
        get lastError() { return h.lastError; },
        fail: (e) => h.fail?.(e),
      };
    },

    // A — the knee-jerk status message: post it (returns the confirmed id), edit
    // it, or delete it (the train deletes it once the reply starts streaming).
    async postStatus(chat, text) { return real.sendAndGetId ? real.sendAndGetId(text, { chatId: chat }) : null; },
    editStatus(chat, msgId, text) { return real.editMessage?.(chat, msgId, text); },
    deleteStatus(chat, msgId) { return real.deleteMessage?.(chat, msgId); },

    // Conversation-E LIMBS (ROADMAP §3). react/sendMedia are OUTBOUND sends → flood-
    // guarded (a limb loop = many sends); editOwn/deleteOwn mutate an existing message
    // (no new send) so they skip the guard. A media caption + an edit are E speaking →
    // persona-stamped, exactly like send(). react/delete carry no persona text.
    react(chat, msgId, emoji) {
      if (!floodGuard.allow(chat)) { onLog(`flood-guard: react to ${chat} BLOCKED (flood pause)`); return false; }
      return real.sendReaction?.(chat, msgId, emoji);
    },
    sendMedia(chat, filePath, opts = {}) {
      if (!floodGuard.allow(chat)) { onLog(`flood-guard: media to ${chat} BLOCKED (flood pause)`); return false; }
      const caption = opts.caption != null ? personaStamp(opts.bodyEmoji, opts.label, opts.caption) : null;
      return real.sendMedia?.(chat, filePath, { caption });
    },
    editOwn(chat, msgId, text, opts = {}) { return real.editMessage?.(chat, msgId, personaStamp(opts.bodyEmoji, opts.label, text)); },
    deleteOwn(chat, msgId) { return real.deleteMessage?.(chat, msgId); },
    wasSentByUs(chat, msgId) { return real.wasSentByUs?.(chat, msgId); },

    isAlive: () => real.isAlive(),
    stop: () => real.stop(),
  };
}
