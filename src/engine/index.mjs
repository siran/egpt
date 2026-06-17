// src/engine/index.mjs — the egpt ENGINE module (ENGINE-SURFACE-SEPARATION.md).
//
// Goal: a central engine that owns transports (WhatsApp/Telegram), state
// (conversation files, rooms, sessions), and brain dispatch — with thin
// SURFACES (the Ink shell, the extension) attaching to it. Most engine logic
// still lives in the legacy spine entry (egpt-spine.mjs); this module is where
// it gets carved out of the component-shaped lifecycle, ONE SEAM AT A TIME, so
// nothing breaks at once (Phase C).
//
// ── The Engine interface (contract we are growing into) ─────────────────────
//
//   const engine = createEngine({ logger, loadBusKey });
//
//   engine.emit(item)                 // engine → surfaces (the output chokepoint)
//   engine.subscribe(listener)        // a surface renders emitted items
//   engine.submit(text, meta)         // a surface's input → the dispatch entry
//   engine.setSubmit(fn)              // register the dispatch entry (the App's submit)
//   engine.startAttach()              // boot the attach HOST (limbs connect here)
//   engine.stop()
//
// Carved out so far:
//   - OUTPUT chokepoint (createOutputChannel): every rendered item flows through
//     one channel; surfaces subscribe and render.
//   - the engine↔surface BOUNDARY: the attach HOST (limbs attach over loopback
//     TCP) — was an App useEffect, now owned by the engine. INPUT from a limb is
//     routed to the registered input handler (the dispatch entry); OUTPUT is
//     fanned to every attached limb.
//
// Still in the App (later seams): submit/dispatch, the emit gate, transport
// ownership (WA/TG), rooms, sessions, the interpreter. Framework-free — no Ink,
// no React — so the engine runs headless and is unit-testable.

import { createOutputChannel } from './output.mjs';
import { startAttachHost as _defaultStartAttachHost } from '../nucleus.mjs';

let _seq = 0;
const _itemId = () => `eng-${Date.now()}-${(_seq = (_seq + 1) % 1_000_000)}`;

export function createEngine({ logger = console, loadBusKey, startAttachHost = _defaultStartAttachHost } = {}) {
  const output = createOutputChannel({ logger });
  let submitHandler = null;
  let host = null;
  let unsubOutput = null;
  let stopped = false;

  const emit = (item) => output.emit(item);
  const subscribe = (listener) => output.subscribe(listener);

  // The INPUT boundary (mirror of emit/subscribe on the output side): a surface
  // hands one line to submit(); it reaches the registered dispatch entry. Today
  // the App registers its legacy submit; later seams move dispatch itself here.
  const setSubmit = (fn) => { submitHandler = fn; };
  const submit = (text, meta) => {
    try { return submitHandler?.(String(text ?? ''), meta); }
    catch (e) { logger?.error?.(`engine.submit: ${e?.message ?? e}`); }
  };

  const _sys = (body, extra = {}) =>
    emit({ id: _itemId(), author: 'system', body, _localOnly: true, ...extra });

  // Boot the attach HOST — limbs (the Ink shell, the extension) connect over
  // loopback TCP. OUTPUT: every emitted item is fanned to attached limbs. INPUT:
  // a limb's typed line is handed to the registered handler (the dispatch entry),
  // exactly like local shell input. Advertises its port in state/nucleus.json.
  async function startAttach() {
    if (host || stopped) return host;
    if (typeof loadBusKey !== 'function') {
      throw new Error('createEngine: loadBusKey is required to start the attach host');
    }
    try {
      const keyB64 = await loadBusKey();
      const h = await startAttachHost({
        keyB64,
        onInput: ({ text, meta }) => submit(text, meta),
        logger: { error: (m) => logger?.error?.(String(m)) },
      });
      if (stopped) { try { await h.close(); } catch { /* race: stopped mid-start */ } return null; }
      host = h;
      // A wedged limb must never block emit to the others (same isolation as the
      // output channel's own fan-out).
      unsubOutput = output.subscribe((item) => { try { h.pushItem(item); } catch { /* drop to one limb */ } });
      _sys(`attach host on 127.0.0.1:${h.port} — limbs may attach`);
      return h;
    } catch (e) {
      logger?.error?.(`attach host failed to start: ${e?.message ?? e}`);
      _sys(`!! attach host failed to start: ${e?.message ?? e}`, { _bright: true });
      return null;
    }
  }

  async function stop() {
    stopped = true;
    try { unsubOutput?.(); } catch { /* best effort */ }
    try { await host?.close?.(); } catch { /* best effort */ }
    host = null;
  }

  return {
    emit,
    subscribe,
    submit,
    setSubmit,
    startAttach,
    stop,
    get attachPort() { return host?.port ?? null; },
    // exposed for the few module-scope subscribers that predate the seam
    output,
  };
}

export { createOutputChannel } from './output.mjs';
