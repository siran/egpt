// src/engine/index.mjs — the egpt ENGINE module (Phase B seam).
//
// Goal (ENGINE-SURFACE-SEPARATION.md): a central engine that owns transports
// (WhatsApp/Telegram), state (conversation files, rooms, sessions), and brain
// dispatch — with thin SURFACES (the Ink shell, the extension) attaching to it.
// Today most engine logic still lives in the legacy spine entry
// (egpt-spine.mjs); this module is where it gets carved out, one seam at a
// time, so nothing breaks at once.
//
// ── The Engine interface (contract we are growing into) ─────────────────────
//
//   const engine = createEngine({ config, home, file, logger });
//
//   engine.submit({ surfaceId, chatId, text, meta })   // feed one input line
//   engine.subscribe(listener)                          // output items → surfaces
//   engine.attachSurface(surface) / detachSurface(id)   // wa/tg owned; shell/ext attach
//   engine.rooms.list() / get(name) / ...               // queries /room etc. use
//   engine.sessions.list() / ...
//   engine.start() / engine.stop()
//
// Implemented so far:
//   - the OUTPUT chokepoint (createOutputChannel): the engine→surface boundary
//     every rendered item flows through. The App subscribes its renderer to it
//     and emits items instead of calling setItems directly.
//
// Planned (later phases):
//   - Phase C: submit/dispatch/rooms/transports extracted out of the Ink App
//     behind this interface (the App becomes a consumer).
//   - Phase D: the attach transport (salvaged src/attach/*) lets the Ink shell
//     and extension subscribe as remote surfaces; the shell stops importing the
//     engine entirely.

export { createOutputChannel } from './output.mjs';
