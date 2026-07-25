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
// makeWrapPersona — wrap a persona reply concentrically: outer bridge layer (per-node,
// bridgeSignatureOpen/Close, above), inner agent layer (per-being, from o.agentSig*), around
// the stamped core. Gated on a full persona header so a plain/auto send passes through
// unstamped + unwrapped (byte-identical to a bare send). This is the exact composition
// beeper-port carried before the extraction — its regression tests are the byte-identical lock.
import { applyLayers } from './signature-layers.mjs';

const _escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function personaStamp(bodyEmoji, label, text) {
  if (!bodyEmoji) return text;
  if (!label) return `${bodyEmoji} ${text}`;   // body_emoji only (system/echo sends) → inline, no header line
  const clean = String(text).replace(new RegExp(`^\\s*${_escapeRe(label)}\\s*[:：]\\s*`, 'i'), '');
  return `${bodyEmoji} ${label}\n${clean}`;      // persona header line: "🐶 egpt" then the reply
}

/**
 * @param {{ bridgeSignatureOpen?: string, bridgeSignatureClose?: string }} [cfg]
 *   the per-NODE outer layer (which spine posted). Default empty → byte-identical to a bare stamp.
 * @returns {(o: object, text: string) => string}  wrapPersona(o, text): stamps the core, then
 *   (only on a full persona header) wraps [bridge, agent] concentrically. `o` carries bodyEmoji,
 *   label, and the per-being agentSigOpen/agentSigClose.
 */
export function makeWrapPersona({ bridgeSignatureOpen = '', bridgeSignatureClose = '' } = {}) {
  return (o, text) => {
    const core = personaStamp(o.bodyEmoji, o.label, text);
    if (!(o.bodyEmoji && o.label)) return core;   // plain/auto → no header → no layers
    return applyLayers(core, [
      { open: bridgeSignatureOpen, close: bridgeSignatureClose },
      { open: o.agentSigOpen ?? '', close: o.agentSigClose ?? '' },
    ]);
  };
}
