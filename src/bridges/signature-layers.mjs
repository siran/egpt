// signature-layers.mjs — concentric signature WRAP (operator 2026-07-12).
//
// A posted message is a CORE wrapped by ordered LAYERS, each with an `open`
// (prepended, ABOVE the core) and a `close` (appended, BELOW it). Layers are
// listed OUTER→INNER, so the opens render top-down in order, then the core, then
// the closes bottom-up (reversed) — a symmetric onion:
//
//   layer0.open          (outermost, e.g. bridge_signature_open)
//   layer1.open          (inner, e.g. agent_signature_open | transcription_open)
//   <CORE>
//   layer1.close
//   layer0.close         (outermost, e.g. bridge_signature_close)
//
// EMPTY members (absent / '' / whitespace-only) contribute NOTHING — a layer with
// an empty open+close is invisible, so the all-empty default is byte-identical to
// the bare core. This is the ONE mechanism behind every signature slot (persona
// reply wraps [bridge, agent]; the 👂 echo wraps [bridge, transcription]).

/**
 * @param {string} core            the message body being wrapped
 * @param {{open?: any, close?: any}[]} [layers]  ordered OUTER→INNER
 * @returns {string}  opens (in order) + core + closes (reversed), empties skipped, joined by '\n'
 */
export function applyLayers(core, layers = []) {
  return [
    ...layers.map((l) => l?.open),
    core,
    ...layers.slice().reverse().map((l) => l?.close),
  ]
    .map((s) => String(s ?? ''))
    .filter((s) => s.trim() !== '')
    .join('\n');
}
