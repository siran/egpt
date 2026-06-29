// identity.mjs — the §2c identity service: classify a raw bridge payload and
// build the InboundEvent ONCE (SPINE-REWRITE-PLAN.md §3, contract C7.6/C7.6e).
// Every downstream path (gating, transcript, brain) consumes this single
// envelope; the dispatch `line` every brain sees is built here and nowhere else.
//
// Input is the bridge port's `{ body, from }` (beeper-port.mjs). `from` already
// carries the bridge's classification (chat, sender, mention status, network,
// kind flags); identity normalizes it into the loop's surface-agnostic shape.
import { formatDispatchLine } from '../dispatch-line.mjs';

// Beeper tags each message with its origin NETWORK; map it to the conversation
// SURFACE (the slugDir bucket) and the dispatch-line NODE (the entry-point tag).
// Account-instance ids ('whatsappgo_2') prefix-match. slugDir rejects anything
// not in KNOWN_SURFACES, so an unknown network falls back to 'whatsapp' for v1.
const KNOWN_SURFACES = ['whatsapp', 'telegram', 'shell', 'signal'];
const NODE_OF = { whatsapp: 'wa', telegram: 'tg', signal: 'sig', shell: 'kg' };
function netKey(network) {
  const n = String(network ?? 'whatsapp').toLowerCase();
  for (const k of KNOWN_SURFACES) if (n.startsWith(k)) return k;
  return n;
}

export function createIdentity({ formatLine = formatDispatchLine, now = () => Date.now() } = {}) {
  return {
    /** @param {{ body: string, from: object }} payload @returns {import('../../spine.mjs').InboundEvent} */
    build({ body, from } = {}) {
      const f = from ?? {};
      const key = netKey(f.network);
      const node = NODE_OF[key] ?? key;
      const surface = KNOWN_SURFACES.includes(key) ? key : 'whatsapp';
      const kind = f.isReaction ? 'reaction' : f.isStageDirection ? 'edit' : 'text';
      const ts = f.ts ?? now();
      const senderName = f.senderName ?? f.firstName ?? null;
      const ev = {
        surface, node,
        chatId: f.chatId, chatName: f.chatName,
        senderId: f.userId, senderName,
        msgId: f.msgKey ?? null,
        ts, body, kind,
        // mention status the bridge already computed — the gating service's input.
        mention: { atEStart: !!f.atEStart, atEAnywhere: !!f.atEAnywhere, replyToBot: !!f.replyToBot },
        authorized: !!f.authorized, isSender: !!f.isSender, isVoice: !!f.isTranscriptFromVoice,
        raw: from,
      };
      // The one dispatch line, built once (C7.6e). A reaction/edit is a
      // stage-direction (bracket-wrapped, no #id tag — the body references its own).
      ev.line = formatLine({
        senderName, chatName: f.chatName, node, body, ts, msgId: ev.msgId,
        stageDirection: kind !== 'text',
      });
      return ev;
    },
  };
}
