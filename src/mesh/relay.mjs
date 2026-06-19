// Human-first mesh relay: the carrier is a VISIBLE Room message, never a hidden
// bus/RPC hop. A request is posted as a normal chat message into a Room both
// nodes share (the route Room), the target spine observes it there, runs its
// local being, and posts the reply back into the SAME Room. The origin spine
// observes that reply and surfaces it into the chat the human asked from.
//
// Everything a human could watch is a real Room message. The only machine bit
// is a single compact tail line appended in the inter-spine route Room (so the
// request/reply can be correlated). The human's own chat (the origin Room) only
// ever sees the clean body — surface() strips the protocol.
//
// A target being may take minutes (it can read files, reason, run tools — we
// once watched a "what do you think?" turn read a whole source file and write a
// critique in ~110s). So the origin NEVER fails a request on a timer and NEVER
// drops a late reply: it surfaces a one-time "thinking…" notice so the human can
// SEE it working, then delivers the answer whenever it lands.
//
// This module is carrier-agnostic: send/surface/runBeing/resolveRoute are
// injected, so the whole loop is unit-testable with fake Rooms and never
// touches a real network.

import {
  makeMeshRequestId,
  normalizeMeshTtl,
  createMeshSeenCache,
  DEFAULT_MESH_TTL,
} from './envelope.mjs';

// Compact, visible tail carried only in the route Room. Human body stays first;
// this single line rides after it. No invisible Unicode — a plain bracket tag.
// The tail carries the routing target EXPLICITLY: a limb may strip a leading
// @handle from the body (Telegram strips @<agentHandle>, e.g. @don), so the body
// @mention is not reliable for routing — the tail is.
const TAIL_RE = /\[egpt-mesh:(req|rep):([a-z0-9._-]+):(\d+)(?::([a-z0-9._-]*))?\]\s*$/i;
// Leading address remnant to strip from the prompt ("@don.dolly" or just ".dolly").
const LEAD_ADDR_RE = /^\s*@?[a-z0-9_-]*\.[a-z0-9_-]+\b\s*/i;

export function encodeMeshTail({ kind, id, ttl, target = '' }) {
  const k = kind === 'reply' ? 'rep' : 'req';
  const t = String(target ?? '').toLowerCase().replace(/[^a-z0-9._-]/g, '');
  return `[egpt-mesh:${k}:${id}:${normalizeMeshTtl(ttl)}:${t}]`;
}

export function parseMeshTail(text) {
  const raw = String(text ?? '');
  const m = TAIL_RE.exec(raw);
  if (!m) return null;
  return {
    kind: m[1].toLowerCase() === 'rep' ? 'reply' : 'request',
    id: m[2],
    ttl: normalizeMeshTtl(m[3]),
    target: (m[4] ?? '').toLowerCase(),
    body: raw.replace(TAIL_RE, '').trimEnd(),
  };
}

// Strip ANY mesh tail tag(s) from a body — defensively, before re-relaying. The
// 2026-06-19 retry storm was one self-test re-relaying its OWN growing body ~30×
// in 3s, each pass appending another [egpt-mesh:req:…] (parseMeshTail only reads
// the LAST tail, so earlier ones survived and piled up). Stripping here keeps a
// re-relayed body clean so tails can never accumulate.
const ANY_TAIL_RE = /\s*\[egpt-mesh:(?:req|rep):[a-z0-9._-]+:\d+(?::[a-z0-9._-]*)?\]/gi;
export function stripMeshTails(text) {
  return String(text ?? '').replace(ANY_TAIL_RE, '').trim();
}

export function createMeshRelay({
  node,                                   // this spine's node name
  send,                                   // (route, text) => Promise — post into a Room (the carrier)
  surface = async () => {},               // (returnTo, text) => Promise — deliver to the origin chat
  runBeing = async () => '',              // (name, prompt) => Promise<string> — dispatch a local being
  resolveRoute = () => null,              // (node) => route | null — registry: how to reach a node
  isLocalBeing = () => false,             // (name) => bool
  seen = createMeshSeenCache(),
  ttl = DEFAULT_MESH_TTL,
  noticeMs = 12_000,           // after this, tell the human the target is "thinking…" (once); 0 disables
  reapMs = 30 * 60_000,        // silent leak-guard for a request that is NEVER answered; never reports failure; 0 = never reap
  log = () => {},
  now = Date.now,
  random = Math.random,
} = {}) {
  const pending = new Map();   // request_id -> { returnTo, target, noticeTimer, reapTimer }

  // ── ORIGIN: relay an outbound @name.node that targets another node ──
  async function relayOut({ name, toNode, body = '', returnTo = null, target = null } = {}) {
    body = stripMeshTails(body);   // never let a re-relayed body accumulate mesh tails (storm guard)
    const label = target ?? `${name}.${toNode}`;
    const route = resolveRoute(toNode);
    if (!route) { await surface(returnTo, `!! mesh: no route to ${toNode} (set mesh.nodes.${toNode}.routes)`); return null; }

    const id = makeMeshRequestId({ node, now, random });
    const fqTarget = `${name}.${toNode}`;
    const text = `@${fqTarget} ${body}`.trimEnd() + `\n${encodeMeshTail({ kind: 'request', id, ttl, target: fqTarget })}`;

    const entry = { returnTo, target: label, noticeTimer: null, reapTimer: null };
    // "See it think": a being may legitimately take minutes. We never fail and
    // never drop — but if the answer hasn't landed within the grace, tell the
    // human it's working, once, so silence never reads as a dead request.
    if (noticeMs > 0) {
      entry.noticeTimer = setTimeout(() => {
        if (pending.has(id)) surface(returnTo, `🧠 ${label} is thinking…`).catch(() => {});
      }, noticeMs);
      entry.noticeTimer.unref?.();
    }
    // The ONLY timer that clears state: a generous, SILENT leak-guard for a
    // request that is never answered (e.g. the target is offline). It reports
    // nothing and is long enough that no real reply is ever lost.
    if (reapMs > 0) {
      entry.reapTimer = setTimeout(() => { pending.delete(id); }, reapMs);
      entry.reapTimer.unref?.();
    }
    pending.set(id, entry);

    try {
      await send(route, text);
    } catch (e) {
      clearTimeout(entry.noticeTimer);
      clearTimeout(entry.reapTimer);
      pending.delete(id);
      await surface(returnTo, `!! mesh relay failed for ${label}: ${e?.message ?? e}`);
      return null;
    }
    return id;
  }

  // ── INBOUND: a message observed in a route Room. Returns true iff it was a
  //    mesh message this relay consumed (caller should then skip normal handling). ──
  async function onRoomMessage({ route, text } = {}) {
    const tail = parseMeshTail(text);
    if (!tail) return false;

    // Replies dedupe via the pending map (deleted on first match), so they need
    // no seen-cache — and must NOT share the request's seen entry (same id).
    if (tail.kind === 'reply') {
      const p = pending.get(tail.id);
      if (!p) { log(`mesh: reply for unknown/handled request ${tail.id}`); return true; }
      clearTimeout(p.noticeTimer);
      clearTimeout(p.reapTimer);
      pending.delete(tail.id);
      await surface(p.returnTo, tail.body);
      return true;
    }

    // kind === 'request' — route by the TAIL target (a limb may have stripped the
    // body @mention). Ignore, without polluting our seen-cache, anything not for
    // this node; the origin sees its own request fly by here.
    const [tName, tNode] = String(tail.target ?? '').split('.');
    const name = String(tName ?? '').toLowerCase();
    const toNode = String(tNode ?? '').toLowerCase();
    if (!name || toNode !== String(node).toLowerCase()) return true;

    if (seen.checkAndMark(tail.id)) { log(`mesh: replay dropped ${tail.id}`); return true; }
    if (tail.ttl <= 0) { log(`mesh: ttl expired before ${node} (${tail.id})`); return true; }

    const replyTtl = tail.ttl - 1;
    if (!isLocalBeing(name)) {
      await send(route, `@${name}.${node} is not here\n${encodeMeshTail({ kind: 'reply', id: tail.id, ttl: replyTtl, target: tail.target })}`);
      return true;
    }

    const prompt = tail.body.replace(LEAD_ADDR_RE, '').trim() || tail.body.trim();
    let reply;
    try { reply = await runBeing(name, prompt); }
    catch (e) { reply = `(@${name}.${node} error: ${e?.message ?? e})`; }
    await send(route, `${String(reply ?? '').trim()}\n${encodeMeshTail({ kind: 'reply', id: tail.id, ttl: replyTtl, target: tail.target })}`);
    return true;
  }

  return { relayOut, onRoomMessage, pending };
}
