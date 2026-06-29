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

  const real = await start({
    ...opts,
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
    send(chat, text) { return real.send(text, { chatId: chat }); },

    // In-place edit-stream. Returns the §2b { update, finish } plus delivered /
    // lastError passthrough: the sender's fallback-send (Phase 3) must send fresh
    // ONLY when the stream did not deliver in place (§7 invariant — "the host
    // skips its fallback send only when the stream reports delivered").
    startStream(chat, init) {
      const h = real.startStreamMessage(init, { chatId: chat });
      return {
        update: (t) => h.update(t),
        finish: (t) => h.finish(t),
        get delivered() { return h.delivered; },
        get lastError() { return h.lastError; },
      };
    },

    isAlive: () => real.isAlive(),
    stop: () => real.stop(),
  };
}
