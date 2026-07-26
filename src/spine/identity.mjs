// identity.mjs — the §2c identity service: classify a raw bridge payload and
// build the InboundEvent ONCE (plans/2606291226-SPINE-REWRITE-PLAN.md §3, contract C7.6/C7.6e).
// Every downstream path (gating, transcript, brain) consumes this single
// envelope; the dispatch `line` every brain sees is built here and nowhere else.
//
// Input is the bridge port's `{ body, from }` (beeper-port.mjs). `from` already
// carries the bridge's classification (chat, sender, mention status, network,
// kind flags); identity normalizes it into the loop's surface-agnostic shape.
import { formatDispatchLine } from '../dispatch-line.mjs';
// THE DECODE (operator 2026-07-26: "the transcript must decode the signature into a <node>").
// It belongs HERE, not in dispatch-line.mjs or transcript-log.mjs: those are pure byte-builders
// handed a body that has already been decided, whereas this is the ONE place inbound text is
// INTERPRETED (C7.6e — "the InboundEvent built once, consumed by all paths"). Decoding here fixes
// ev.body and ev.line together; decoding in the formatter alone would leave them disagreeing, and
// spine.mjs's quick-reply patch tests `line.endsWith(ev.body)` — it would silently stop stripping
// the routed token from the line the brain reads.
//
// It is also the SMUGGLING GUARD. Invisible characters in a prompt are an injection vector and we
// must not feed them to ourselves: after this call no path downstream — the dispatch line, the
// transcript file and therefore the @l tail and the voice-note transcript reuse, the kickoff feed,
// the burst/cycle join, a quoted reply snippet — can carry a raw tag byte, because every one of
// them is built from ev.body / ev.line. Rendering rather than stripping keeps the FACT (which node
// spoke) while removing the invisibility.
// PROVENANCE, read at the ONE moment the raw text still has it. Rendering is LOSSY on purpose —
// after it, no downstream reader can tell `aquí<do>` written by DOLLY's bridge from `aquí<do>`
// typed by a person — so the FACT has to be lifted off the raw body here and carried on the
// envelope beside fromBrain. Anything else would mean re-ordering the pipeline so a guard runs
// before the envelope is built, and "the InboundEvent is built ONCE and consumed by all paths"
// (C7.6e, spine.mjs:50) is the contract that keeps ev.body and ev.line from disagreeing.
import { decodeNodeSignature, hasNodeSignature, renderNodeSignature } from '../node-signature.mjs';

// Beeper tags each message with its origin NETWORK; map it to the conversation
// SURFACE (the slugDir bucket) and the dispatch-line NODE (the entry-point tag).
// Account-instance ids ('whatsappgo_2') prefix-match. slugDir rejects anything
// not in KNOWN_SURFACES, so an unknown network falls back to 'whatsapp' for v1.
const KNOWN_SURFACES = ['whatsapp', 'telegram', 'shell', 'signal'];
// Every value here is a TRANSPORT tag (the entry point the human used), never a node
// name: `shell` mapped to 'kg' — THIS machine's node name — so on any other node every
// shell line read `.kg` and claimed REVE had spoken it. Per-line node provenance is a
// constant anyway (a transcript lives in exactly one node's profile) and belongs on the
// reply label, which already carries it.
const NODE_OF = { whatsapp: 'wa', telegram: 'tg', signal: 'sig', shell: 'sh' };
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

// `timeZone`: the node's config default_time_zone (boot-resolved via the heartbeat loader's
// resolveTimeZone) — the zone the dispatch line's HH:MM renders in. null → UTC, unchanged.
export function createIdentity({ formatLine = formatDispatchLine, now = () => Date.now(), timeZone = null } = {}) {
  return {
    /** @param {{ body: string, from: object }} payload @returns {import('./spine.mjs').InboundEvent} */
    build({ body: rawBody, from } = {}) {
      // Decode the structural node signature ONCE, before anything reads the text: `…hola` +
      // <invisible kg> becomes `…hola<kg>`. Absence is ORDINARY (every message already in the
      // wild has no marker) → unchanged.
      // (typeof-guarded so a null/undefined body stays null/undefined — the envelope's shape is
      // unchanged for every non-string caller.)
      // Read the PROVENANCE off the raw text BEFORE the render erases it (see the import note).
      const signed = typeof rawBody === 'string' && hasNodeSignature(rawBody);
      const body = typeof rawBody === 'string' ? renderNodeSignature(rawBody) : rawBody;
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
        // Provenance for a web-brain member's re-entered reply (design B, phase 4): the room
        // relay re-feeds a member's reply as a synthetic inbound with from.fromBrain = the
        // producing member id. Carried onto the ev so isHumanTurn classifies it NON-human (it
        // is our own output) and the relay never feeds a reply back to its own author. Absent
        // on every genuine inbound → undefined → no effect.
        fromBrain: f.fromBrain ?? null,
        // Which NODE's spine committed this text to the surface — the structural signature the
        // render above just turned into a legible `<node>`. Carried exactly as fromBrain is, and
        // read the same way: isHumanTurn treats a NON-NULL fromNode as non-human, whoever the
        // display sender is (a peer node on a shared Beeper account arrives isSender:true with an
        // id we never sent and no envelope — every other signal calls it the operator).
        // NULL vs '' IS THE DISTINCTION, so callers must test `!= null`, never truthiness: null
        // means UNSIGNED (a human, the ordinary case), '' means SIGNED BY A NODE WE CANNOT NAME
        // (an empty or garbled frame). PRESENCE is the provenance test; the name is only
        // attribution, and an unnamed node is still not a person.
        fromNode: signed ? (decodeNodeSignature(rawBody) ?? '') : null,
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
        timeZone,
      });
      return ev;
    },
  };
}
