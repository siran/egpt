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
      const body = opts.bodyEmoji ? `${opts.bodyEmoji} ${text}` : text;
      return real.send(body, { chatId: chat, replyToMessageID: opts.replyTo ?? null });
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
      const stamp = (t) => (opts.bodyEmoji ? `${opts.bodyEmoji} ${t}` : t);
      // init is a FIXED placeholder ("⏳") posted as-is, so the bridge resolves its
      // id before any edit (a variable placeholder raced resolveSentMessageId →
      // duplicate sends).
      const h = real.startStreamMessage(init, { chatId: chat, persona: opts.persona, replyToMessageID: opts.replyTo ?? null });
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

    isAlive: () => real.isAlive(),
    stop: () => real.stop(),
  };
}
