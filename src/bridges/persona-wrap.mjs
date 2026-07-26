// persona-wrap.mjs — the ONE definition of the persona stamp + concentric signature wrap,
// shared by every surface port (beeper-port, shell-port). Extracted from beeper-port
// (operator 2026-07-25: "the bridge must have ONE path") so the operator SHELL renders a
// persona reply through the EXACT same machinery Beeper does — no shell-specific copy.
//
// personaStamp — the bridge-ENFORCED persona identifier: body_emoji + the agent's name as
// the FIRST LINE, then the reply below — "🐶 egpt\n<reply>". A leading model-written
// self-label ("egpt:") is stripped first so the identifier is the bridge's, not the model's.
// No body_emoji (system sends) → text passes through untouched; body_emoji with no label
// (echo sends) → inline emoji only, no header line.
//
// makeWrapPersona — wrap what a spine emits concentrically: outer bridge layer (per-node,
// bridgeSignatureOpen/Close, above), inner layer (per-message: the being's agent signature on a
// persona reply, the transcription frame on a 👂 echo — from o.agentSig*), around the stamped
// core. The bridge layer is UNCONDITIONAL (operator 2026-07-25: "all messages coming out from a
// spine to any surface are signed. period."). SIGNING IS A PROPERTY OF THE SEND, not of whether
// this module wrote an identity line: the old `bodyEmoji && label` gate made "sign it" and
// "stamp it" one switch, so a node could not sign a body it had not stamped — exactly the mesh
// nugget case (a remote being's reply, relayed home) and exactly the 👂 echo case (which had to
// grow its OWN copy of the wrap in beeper.mjs to get signed at all). The persona STAMP stays
// conditional (there is an identity to stamp, or there isn't); with every slot empty the wrap is
// still byte-identical to the bare core, so a node that configures no signature is unchanged.
//
// It is a property of the SEND, therefore of EVERY frame — including the transient ones (operator
// 2026-07-26: "bridge must sign. always. structurally." / "it should also sign 'thinking... 💸|🌉'").
// A stream's ⏳ placeholder and its intermediate edits are real messages, live on the surface and
// ingestible by a co-account peer for the whole duration of a turn; both ports used to send them
// bare-stamped and wrap only the settled frame, so "a bridge always signs" was false for exactly
// as long as anyone was watching. Every port now renders EVERY outbound text through this one
// function. Signing is IDEMPOTENT by construction, not by inspection: each frame is built from the
// raw core, never from the previous frame, so replacing a signed frame with the next one can never
// stack "💸 💸 💸".
import { applyLayers } from './signature-layers.mjs';
// parseMesh — the SAME envelope test the spine applies inbound (mesh.isEnvelope), reused here so
// there is one definition of "this is relay traffic, not chat". See isMeshEnvelope below.
import { parseMesh } from '../mesh/relay.mjs';

const _escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function personaStamp(bodyEmoji, label, text) {
  if (!bodyEmoji) return text;
  if (!label) return `${bodyEmoji} ${text}`;   // body_emoji only (system/echo sends) → inline, no header line
  const clean = String(text).replace(new RegExp(`^\\s*${_escapeRe(label)}\\s*[:：]\\s*`, 'i'), '');
  return `${bodyEmoji} ${label}\n${clean}`;      // persona header line: "🐶 egpt" then the reply
}

// A mesh ENVELOPE is TRANSPORT, not a message to a surface — the one thing the "period" does not
// cover. Its signature already travels INSIDE the fence (the responder renders the nugget through
// THIS wrap before encodeMesh, mesh.mjs renderReply), and signing the envelope again on the way out
// would break the wire format outright: parseMesh trusts the TRAILING run of provenance lines, so a
// close line appended below the tail makes the envelope unrecognisable and the mesh goes deaf.
// Recognition is the spine's own inbound rule (mesh.isEnvelope = parseMesh != null), narrowed to the
// intact fenced form encodeMesh emits so ordinary prose that happens to end in "by: …" is still signed.
const isMeshEnvelope = (t) => {
  const s = String(t ?? '').trim();
  return s.startsWith('```') && s.endsWith('```') && parseMesh(s) != null;
};

/**
 * @param {{ bridgeSignatureOpen?: string, bridgeSignatureClose?: string }} [cfg]
 *   the per-NODE outer layer (which spine posted). Default empty → byte-identical to a bare stamp.
 * @returns {(o: object, text: string) => string}  wrapPersona(o, text): stamps the core (when there
 *   is an identity to stamp), then wraps [bridge, inner] concentrically — ALWAYS, except around a
 *   mesh envelope. `o` carries bodyEmoji, label, and the inner agentSigOpen/agentSigClose.
 */
export function makeWrapPersona({ bridgeSignatureOpen = '', bridgeSignatureClose = '' } = {}) {
  return (o, text) => {
    // Nothing to sign is not a message: an empty body (the mesh origin mirror opens its stream
    // with '') must stay empty, never become a signature with no content under it.
    if (!String(text ?? '').trim()) return text;
    const core = personaStamp(o.bodyEmoji, o.label, text);
    if (isMeshEnvelope(core)) return core;        // transport, not a surface send → never signed
    return applyLayers(core, [
      { open: bridgeSignatureOpen, close: bridgeSignatureClose },
      { open: o.agentSigOpen ?? '', close: o.agentSigClose ?? '' },
    ]);
  };
}
