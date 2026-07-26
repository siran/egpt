// router.mjs — the §2c router service: resolve an InboundEvent to the beings that
// should answer. E (the persona) is the default voice.
//
// The `agents:` config block is the ONE registry (operator 2026-07-02, new-config-only):
// resolve() runs the ONE mention matcher (`addressed`, below) over the node's whole
// addressable set — every agent's map key + its handles — and resolves EVERY agent the
// message addressed, in text order. A LOCAL agent (configuration ≠ 'relay') routes like a
// being (being = agent name); a RELAY agent (configuration: relay) routes to a mesh target
// whose ROUTE is the agent's relay_channel; the DEFAULT (persona) agent — the one carrying
// `default: true`, whose KEY boot injects as `defaultBeing` — routes to its own key (operator
// 2026-07-10: the being-id IS the map key, no hardcoded 'e'/'egpt'). An unknown / disabled
// @token, or a message addressing nobody, falls through to the persona (defaultBeing).
//
// resolve() returns { being, mesh?, mention, targets } — `targets` is the FULL list (the spine
// fans out over it: every local being takes a turn, every mesh target is forwarded), with the
// first target mirrored at the top level for a single-target caller. The mention RIDE-ALONG
// matters because ev.mention is @e-specific (the bridge computes it for the persona wake-word):
// an agent picked by its OWN @name would otherwise look un-mentioned to its gate, so it carries
// its own { atEStart, atEAnywhere } — the matcher's REAL per-agent flags, so the existing mode
// vocabulary keeps its meaning (mention-direct ≠ mention). E keeps ev.mention unchanged.
//
// Cross-node reach is AGENT-BASED (operator 2026-07-25): the ONLY way to leave this machine is
// a RELAY agent, whose relay_channel is the route — resolve() returns { being: null, mesh:
// <target>, mention } and the spine forwards it (mesh.forward). The old bare `@being.node`
// scheme was evicted with its `config.mesh.nodes` routing table: it minted a target carrying no
// route, so nothing could ever carry it. `@don.do` still works when `don` is a relay agent —
// the @token match below stops at the dot and finds the agent.
import { agentPaths } from '../mesh/relay.mjs';
import { mentionHits } from '../auto-mode.mjs';

// QUICK REPLY (operator 2026-07-25: "a lo mejor empezar la respuesta con 'r', tipo 'r ok pero que
// no sea tan común' … si el ultimo mensaje fue de don o de E, el bridge routes and dispatches" —
// "no sé el msgid como tú … solo quiero responder fácilmente al ultimo prompt"). `r <body>` is an
// ADDRESSEE, not a second dispatch mechanism: it resolves through `addressed` below like any
// @token, so the mode gate, the fan-out and mesh forwarding stay exactly as they are.
// `<qr> <body>` → the body with the token stripped, or null when this text is not a quick reply.
// Case-insensitive; REQUIRES whitespace + a non-empty body, so `really?` and a bare `r` are
// ordinary text. An empty/blank token disables the feature.
function quickReplyBody(text, token) {
  const t = String(token ?? '').trim();
  if (!t) return null;
  const s = String(text ?? '').replace(/^\s+/, '');
  if (s.slice(0, t.length).toLowerCase() !== t.toLowerCase()) return null;
  const rest = s.slice(t.length);
  if (!/^\s/.test(rest)) return null;
  return rest.trim() || null;
}

// An agent's routable identity tokens: its map KEY plus any `handles:` aliases, all
// lowercased. Used to match an @token and to spot the persona agent.
function agentIds(name, agent) {
  const hs = Array.isArray(agent?.handles) ? agent.handles : [];
  return [name, ...hs].map((h) => String(h).toLowerCase());
}

// Who does this message address? The node's WHOLE addressable set — every agent's map KEY plus
// its `handles:` — run through THE mention matcher (auto-mode.mjs `mentionHits`), the same scan
// the persona's wake words go through. That is the whole fix (operator 2026-07-25): there were
// TWO mention systems, the bridge's persona-only one and this file's own leading-@token-on-RAW-
// text regex, so `@e and @don you here?` woke only e and an `@agent` mid-sentence was invisible.
// Now there is one, and an agent inherits every protection E has (code fences since 47caf19,
// the glued-token rule, longest-token-first).
//
// `_`-prefixed comment keys and `enabled: false` agents are not addressable — they fall through,
// exactly as findAgent used to skip them. An ARRAY-shaped agent is a MULTI-PATH relay (operator
// 2026-07-06: an agent is a list of paths) — it has no handles, so it is addressed by its map KEY
// alone; agentIds tolerates that shape (agent.handles undefined → just the name).
//
// A QUICK REPLY (`quickReply` + `lastSpeaker`) is resolved HERE too, and to ONE addressee: the
// agent that spoke last in this conversation, ATSTART (it was directly addressed, so a
// mention-direct chat answers it), carrying the `body` the token was stripped from. The gate is
// `lastSpeaker` — the caller passes it only when an AGENT spoke last, so after a human line (or
// in a chat where nothing was said) `r …` matches nobody and stays ordinary text.
//
// Returns EVERY addressed agent in TEXT ORDER, deduped by agent, each carrying its OWN
// { atStart, anywhere } — real per-agent flags, never a blanket constant, because the auto-modes
// rest on exactly that distinction (`mention-direct` wakes on atStart, `mention` on anywhere).
// @returns {{name: string, agent: object, atStart: boolean, anywhere: boolean, body?: string}[]}
export function addressed(text, agents, { quickReply = '', lastSpeaker = null } = {}) {
  const byToken = new Map();                       // token -> { name, agent }; first agent wins a shared handle
  for (const [name, agent] of Object.entries(agents ?? {})) {
    if (!agent || typeof agent !== 'object' || name.startsWith('_')) continue;
    if (agent.enabled === false) continue;
    const hit = { name: name.toLowerCase(), agent };
    for (const id of agentIds(name, agent)) if (!byToken.has(id)) byToken.set(id, hit);
  }
  const body = lastSpeaker ? quickReplyBody(text, quickReply) : null;
  if (body != null) {
    const hit = byToken.get(String(lastSpeaker).toLowerCase());
    if (hit) return [{ name: hit.name, agent: hit.agent, atStart: true, anywhere: true, body }];
  }
  const out = [];
  const seen = new Set();
  for (const { token, atStart } of mentionHits(text, [...byToken.keys()])) {
    const hit = byToken.get(token);
    if (!hit || seen.has(hit.name)) continue;
    seen.add(hit.name);
    out.push({ name: hit.name, agent: hit.agent, atStart, anywhere: true });
  }
  return out;
}

// `getQuickReply` reads config.quick_reply_string (unset → the 'r' default below; '' disables).
export function createRouter({ getAgents = () => ({}), defaultBeing = 'e', getQuickReply = () => undefined } = {}) {
  // ONE addressed agent → the routing target it resolves to. Per-kind semantics are
  // UNCHANGED; only the caller changed (every hit, not just the first).
  function targetFor({ name, agent, atStart, body }, ev) {
    // The mention an addressed agent hands its own gate. NOT a constant: the flags are the
    // matcher's REAL per-agent findings (operator 2026-07-25: "respect the mode, if it's
    // mention-direct not the same as mention … nothing has changed"). replyAllowed() already
    // knows what they mean — `mention` wakes on anywhere, `mention-direct` only on atStart — so
    // an agent named mid-sentence in a mention-direct chat correctly stays silent. A LEADING
    // @name still yields { atEStart: true, atEAnywhere: true }, exactly the old constant.
    const mention = { atEStart: atStart, atEAnywhere: true, replyToBot: false };
    // MULTIPATH (operator 2026-07-06: multipath is configuration — an agent is a list of
    // paths, every message through every path). A LIST-shaped agent is a relay whose every
    // element posts the SAME message into its own relay_channel with its own network pin.
    // Return the mesh target carrying ALL paths; mesh.forward posts one envelope per path
    // (one 🤔 placeholder for the human, same re:/post_id). Handled BEFORE the scalar check
    // (a list has no top-level relay_channel). Each path: { route:{room_id,network?}, to?, label }.
    if (Array.isArray(agent)) {
      const paths = agentPaths(agent).map((p) => ({
        route: { room_id: p.relay_channel, ...(p.network ? { network: String(p.network).toLowerCase() } : {}) },
        ...(String(p.to ?? '').trim() ? { to: String(p.to).trim() } : {}),
        label: p.label,
      }));
      return { being: null, mesh: { being: name, paths }, mention };
    }
    // A RELAY agent is one carrying a `relay_channel:` (or the legacy explicit
    // `configuration: relay`). It forwards rather than answers: the message goes
    // into the relay_channel as a mesh envelope. An optional `to: <being>.<node>`
    // names the NEXT hop (a declarative relay chain — the next node re-addresses
    // onward via its own agent entry); no `to` = open-channel (the owner of this
    // being on the far end answers). mesh.forward uses the route directly.
    if (agent.relay_channel || String(agent.configuration ?? '').toLowerCase() === 'relay') {
      const to = String(agent.to ?? '').trim();
      // NETWORK PIN (operator 2026-07-06: multi-network mesh) — the same chat name
      // can exist on several networks under one Beeper account; carry an optional
      // `network:` beside room_id so the bridge resolves the name to the pinned one.
      const mesh = { being: name, route: { room_id: agent.relay_channel, ...(agent.network ? { network: String(agent.network).toLowerCase() } : {}) }, ...(to ? { to } : {}) };
      return { being: null, mesh, mention };
    }
    // The DEFAULT (persona) agent routes to its own key (= defaultBeing), keeping
    // the bridge-computed ev.mention. Matched by key OR the `default: true` marker —
    // no 'e'/'egpt' literals (operator 2026-07-10).
    // A QUICK REPLY (`body` set) carries no @token, so the bridge computed no mention for the
    // persona: hand it the matcher's own — exactly what a leading `@e` would have produced.
    if (name === defaultBeing || agent.default === true) {
      return { being: defaultBeing, mention: body != null ? mention : ev?.mention };
    }
    // Any other LOCAL agent → being = its name, gated on its own mention.
    return { being: name, mention };
  }

  return {
    /** @param {import('./spine.mjs').InboundEvent} ev
     *  @param {string|null} lastSpeaker  the AGENT that spoke last in this conversation (the
     *    spine's per-(surface,chatId) record), or null when a human did / nobody has — the
     *    quick-reply gate.
     *  @returns {{ being: string|null, mesh?: object, mention: object|undefined, targets: object[], body?: string }}
     *  `targets` is EVERY addressed agent in text order (the spine fans out over it); the
     *  first target's fields are mirrored at the top level so a single-target caller reads
     *  exactly what resolve() always returned. `body` is present ONLY for a quick reply: the
     *  message minus its token, what the agent should be handed. */
    resolve(ev, lastSpeaker = null) {
      const agents = getAgents() ?? {};
      const targets = [];
      let body;
      if (agents && typeof agents === 'object') {
        for (const hit of addressed(ev?.body ?? '', agents, { quickReply: getQuickReply() ?? 'r', lastSpeaker })) {
          // SURFACE PIN (operator 2026-07-25): an agent may carry `surface: <name>` so it is an
          // agent ONLY on that surface; on any OTHER surface the @mention falls through (as if
          // unmatched). Co-account CORRECTNESS, not convenience: `do` and `kg` share ONE Beeper
          // account, so on Beeper `do` hears `@don` DIRECTLY and answers it — kg must NOT also
          // relay it. kg relays `don` ONLY from the shell (which `do` can't hear), so kg pins its
          // `don` relay agent `surface: shell`. A surface-mismatched agent is dropped from the
          // target list (the OTHER agents this message addressed are unaffected). A LIST-shaped
          // (multipath) agent is an Array with no `.surface`, so it is never pinned.
          if (!Array.isArray(hit.agent) && hit.agent.surface != null
              && String(hit.agent.surface).toLowerCase() !== String(ev?.surface ?? '').toLowerCase()) continue;
          if (hit.body != null) body = hit.body;
          targets.push(targetFor(hit, ev));
        }
      }
      // Nobody addressed (or every hit was surface-pinned away): an @token that matched no
      // agent is the persona's, and so is a bare message.
      if (!targets.length) targets.push({ being: defaultBeing, mention: ev?.mention });
      return { ...targets[0], targets, ...(body != null ? { body } : {}) };
    },
  };
}
