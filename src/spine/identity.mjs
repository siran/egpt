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

// THE network→surface map, exported so identity (transcript/brain cwd) and the
// media service (media/ folder) can't drift — a Telegram photo must bucket under
// the SAME surface as the chat's transcript, not silently fall into 'whatsapp'
// (they did diverge: media hardcoded 'whatsapp', so a TG photo's media/<file> was
// announced under a path the brain's telegram cwd never had). Returns a
// KNOWN_SURFACES member; anything unrecognized falls back to 'whatsapp' for v1
// (slugDir rejects non-members).
export function surfaceOf(network) {
  const key = netKey(network);
  return KNOWN_SURFACES.includes(key) ? key : 'whatsapp';
}

export function createIdentity({ formatLine = formatDispatchLine, now = () => Date.now() } = {}) {
  return {
    /** @param {{ body: string, from: object }} payload @returns {import('../../spine.mjs').InboundEvent} */
    build({ body, from } = {}) {
      const f = from ?? {};
      const key = netKey(f.network);
      const node = NODE_OF[key] ?? key;
      const surface = surfaceOf(f.network);
      const kind = f.isReaction ? 'reaction' : f.isStageDirection ? 'edit' : 'text';
      const ts = f.ts ?? now();
      const senderName = f.senderName ?? f.firstName ?? null;
      const ev = {
        surface, node,
        chatId: f.chatId, chatName: f.chatName,
        senderId: f.userId, senderName,
        msgId: f.msgKey ?? null,
        replyToId: f.replyToId ?? null,   // the quoted message id (→ `↩#<id>`), null when not a reply
        ts, body, kind,
        // mention status the bridge already computed — the gating service's input.
        mention: { atEStart: !!f.atEStart, atEAnywhere: !!f.atEAnywhere, replyToBot: !!f.replyToBot },
        // Backlog: older than bridge start (a woken node's replay, flagged by the bridge).
        // The spine transcript-logs it (backfill) but NEVER dispatches it (operator
        // 2026-07-08: a waking node backfills, never re-answers stale traffic).
        backlog: !!f.backlog,
        authorized: !!f.authorized, isSender: !!f.isSender, isVoice: !!f.isTranscriptFromVoice,
        raw: from,
      };
      // The one dispatch line, built once (C7.6e). A reaction/edit is a
      // stage-direction (bracket-wrapped, no #id tag — the body references its own).
      ev.line = formatLine({
        senderName, chatName: f.chatName, node, body, ts, msgId: ev.msgId,
        // a reply reference rides only a real message line (a reaction/edit stage-
        // direction references its own target in the body, no `↩#` tag)
        replyToId: kind === 'text' ? ev.replyToId : null,
        stageDirection: kind !== 'text',
      });
      return ev;
    },
  };
}
