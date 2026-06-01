// src/nucleus.mjs — the single egpt backend ("nucleus").
//
// Background: egpt used to let every UI be a full process that competed for
// the WhatsApp pairing via a takeover/helm/defer dance (egpt.mjs
// takeoverIfRunning). That is the tangle that produced the daemon thrash loop
// and the silent /restart-from-WhatsApp. The nucleus replaces it with ONE
// backend that owns the interpreter + the WA/TG transports; every other UI
// (TTY shell, browser extension) attaches as a thin client.
//
// This file is framework-free (no React) so it can run headless under the
// daemon and be unit-tested directly.
//
// ── Surfaces ──────────────────────────────────────────────────────────────
// A "surface" is anything that can (a) feed input into the nucleus and (b)
// receive rendered output from it. The nucleus does not care where a surface
// lives — in-process (WhatsApp / Telegram bridges) or attached over TCP
// (shell, extension). The uniform shape:
//
//   Surface = {
//     id,                       // unique: 'wa' | 'tg' | 'shell:<n>' | 'ext:<n>'
//     kind,                     // 'wa' | 'tg' | 'shell' | 'ext'
//     send(envelope),           // nucleus → surface: deliver one output item
//     startStream?(initial),    // optional; returns { push(chunk), finish(text) }
//     stop?(),                  // tear down (close socket / bridge)
//   }
//
// Inbound is uniform too: a surface produces nucleus.submit({ surfaceId,
// chatId, text, meta }). 'shell'/'ext' are CLIENT surfaces (a human watching a
// UI); 'wa'/'tg' are TRANSPORT surfaces (a remote chat). The distinction
// drives mirroring: transport traffic and one shell's commands are mirrored to
// every other CLIENT surface so any attached operator sees the whole room.

import { startAttachServer } from './attach/server.mjs';
import { writeNucleusInfo, clearNucleusInfo } from './attach/discovery.mjs';

// NOTE: the spine's periodic discovery re-assert timer was removed here. It
// existed only to self-heal a /restart race where a dying predecessor deleted
// the live successor's nucleus.json. In the one-engine model (no takeover, no
// thrash) there is no predecessor to race — the sidecar is written once at boot
// and cleared on close. Per ENGINE-SURFACE-SEPARATION.md: no liveness band-aids.

export const CLIENT_KINDS = Object.freeze(['shell', 'ext']);
export const TRANSPORT_KINDS = Object.freeze(['wa', 'tg']);

// A registry of live surfaces with fan-out primitives. Deliberately dumb: it
// stores surfaces and delivers envelopes; routing decisions (which chat → which
// surface) belong to the nucleus's submit/dispatch path, not here.
export function createSurfaceRegistry({ logger = console } = {}) {
  const _surfaces = new Map();   // id -> surface

  function add(surface) {
    if (!surface || typeof surface !== 'object') {
      throw new Error('surface registry: surface must be an object');
    }
    const { id, kind, send } = surface;
    if (!id || typeof id !== 'string') throw new Error('surface registry: surface.id (string) required');
    if (!kind || typeof kind !== 'string') throw new Error('surface registry: surface.kind (string) required');
    if (typeof send !== 'function') throw new Error(`surface registry: surface.send (function) required for ${id}`);
    _surfaces.set(id, surface);
    return () => remove(id);   // unsubscribe handle
  }

  function remove(id) {
    const s = _surfaces.get(id);
    if (!s) return false;
    _surfaces.delete(id);
    // stop() is best-effort: a surface tearing down (closing a socket, stopping
    // a bridge) must not throw into the caller removing it.
    try { s.stop?.(); } catch (e) { logger?.error?.(`surface ${id} stop() threw: ${e?.message ?? e}`); }
    return true;
  }

  function get(id) { return _surfaces.get(id) ?? null; }
  function has(id) { return _surfaces.has(id); }
  function list(kind) {
    const all = [..._surfaces.values()];
    return kind ? all.filter(s => s.kind === kind) : all;
  }

  // Deliver one envelope to every surface matching the filter. Per-surface
  // send() errors are isolated and logged — one wedged client must never break
  // the fan-out to the others (the exact failure mode the shared-file mirror
  // had, where a single bad reader could stall everyone). Returns the count of
  // surfaces that received it without throwing.
  function broadcast(envelope, { kinds = null, exceptId = null } = {}) {
    let delivered = 0;
    for (const s of _surfaces.values()) {
      if (exceptId && s.id === exceptId) continue;
      if (kinds && !kinds.includes(s.kind)) continue;
      try { s.send(envelope); delivered++; }
      catch (e) { logger?.error?.(`surface ${s.id} send() threw: ${e?.message ?? e}`); }
    }
    return delivered;
  }

  // Deliver to exactly one surface by id. Returns true iff the surface exists
  // and its send() did not throw.
  function deliverTo(id, envelope) {
    const s = _surfaces.get(id);
    if (!s) return false;
    try { s.send(envelope); return true; }
    catch (e) { logger?.error?.(`surface ${id} send() threw: ${e?.message ?? e}`); return false; }
  }

  // Mirror an envelope to all CLIENT surfaces (the humans watching a TTY / the
  // extension). Used so an operator on any shell sees transport traffic (WA/TG)
  // and the other shells' commands. This is the live-push replacement for the
  // polled shell-mirror.jsonl tail.
  function mirrorToClients(envelope, { exceptId = null } = {}) {
    return broadcast(envelope, { kinds: CLIENT_KINDS, exceptId });
  }

  return {
    add, remove, get, has, list,
    broadcast, deliverTo, mirrorToClients,
    get size() { return _surfaces.size; },
  };
}

// startAttachHost — the nucleus's attach endpoint. Composes the loopback-TCP
// server (one CLIENT surface per authenticated connection) with a registry and
// an item-push fan-out, and advertises the port via ~/.egpt/state/nucleus.json.
// The nucleus calls this once at boot and then:
//   - feeds attached-client input into the interpreter via `onInput`
//   - calls host.pushItem(item) for every shell-visible item so all attached
//     clients see the same room (the live-push replacement for shell-mirror).
export async function startAttachHost({
  keyB64,
  version = null,
  host = '127.0.0.1',
  port = 0,
  onInput,                  // ({ surfaceId, chatId, text, meta }) => void
  onAttach = null,          // (surface, meta) => void  — e.g. send a backlog/welcome
  onDetach = null,          // (surfaceId) => void
  logger = console,
} = {}) {
  if (!keyB64) throw new Error('startAttachHost: keyB64 required');
  if (typeof onInput !== 'function') throw new Error('startAttachHost: onInput required');
  const registry = createSurfaceRegistry({ logger });

  const server = await startAttachServer({
    host, port, keyB64, logger, onInput,
    onAttach: (surface, meta) => {
      registry.add(surface);
      try { onAttach?.(surface, meta); } catch (e) { logger?.error?.(`attach host: onAttach hook threw: ${e?.message ?? e}`); }
    },
    onDetach: (id) => {
      registry.remove(id);
      try { onDetach?.(id); } catch (e) { logger?.error?.(`attach host: onDetach hook threw: ${e?.message ?? e}`); }
    },
  });

  try {
    await writeNucleusInfo({ host: server.host, port: server.port, version });
  } catch (e) {
    logger?.error?.(`attach host: writeNucleusInfo failed: ${e?.message ?? e}`);
  }

  return {
    host: server.host,
    port: server.port,
    registry,
    connections: () => server.connections(),
    // Fan one shell-visible item to every attached client. The client renders by
    // id, so re-pushing the same id with a changed body streams an update.
    pushItem: (item) => registry.broadcast(item),
    broadcastBye: (reason = 'restart') => server.broadcastBye(reason),
    close: async () => {
      try { await clearNucleusInfo(); } catch {}
      await server.close();
    },
  };
}
