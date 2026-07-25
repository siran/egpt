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
import { stripCode, escapeMention } from '../auto-mode.mjs';

// An agent's routable identity tokens: its map KEY plus any `handles:` aliases, all
// lowercased. Used to match an @token and to spot the persona agent.
function agentIds(name, agent) {
  const hs = Array.isArray(agent?.handles) ? agent.handles : [];
  return [name, ...hs].map((h) => String(h).toLowerCase());
}

// THE mention matcher (operator 2026-07-25: "evict that hallucinated distinction between agent
// and persona. they're all agents, agents can have persona-lities"). ONE scan over the node's
// WHOLE addressable set — every agent's map KEY plus its `handles:` — replacing the two systems
// that disagreed: the bridge's `mentionStatus` (scans anywhere, strips code, but knows only the
// PERSONA's wake words) and the router's old leading-@token-on-raw-text match. Both live bugs
// came from that split: `@e and @don you here?` woke only e (leading token, first hit, stop), and
// an `@agent` mid-sentence was invisible.
//
// Rules, deliberately the persona's own (auto-mode.mjs), so an agent gets the SAME protection E
// has had since 47caf19: code regions are stripped FIRST (a fenced ```yaml block quoting "@don"
// is documentation, not an address), and a hit must be a real mention token — preceded by
// start-or-whitespace, so "me@e.com" / "hey@egpt" never match.
//   · TRAILING boundary is `(?![\w-])`, TIGHTER than mentionStatus' `\b`, because agent names may
//     carry hyphens (`don-local`): with a bare `\b` an unregistered `@don-x` would match agent
//     `don`, where the old leading-token match resolved `don-x` and correctly found nobody. A dot
//     is still a boundary, so `@don.do` finds `don` (the qualified form the mesh chain uses).
//   · Longest-token-first alternation so `@egpt` matches 'egpt', not 'e'.
//   · `_`-prefixed comment keys and `enabled: false` agents are not addressable (they fall through).
//   · An ARRAY-shaped agent is a MULTI-PATH relay (operator 2026-07-06: an agent is a list of
//     paths) — no handles, so it is addressed by its map KEY alone; agentIds tolerates that shape.
//
// Returns EVERY addressed agent in TEXT ORDER, deduped by agent, each carrying its OWN
// { atStart, anywhere } — real per-agent flags, never a blanket constant, because the auto-modes
// rest on exactly that distinction (`mention-direct` wakes on atStart, `mention` on anywhere).
// @returns {{name: string, agent: object, atStart: boolean, anywhere: boolean}[]}
export function addressed(text, agents) {
  const t = stripCode(String(text ?? '')).replace(/^\s+/, '');
  if (!t.includes('@')) return [];
  const byToken = new Map();                       // token -> { name, agent }; first agent wins a shared handle
  for (const [name, agent] of Object.entries(agents ?? {})) {
    if (!agent || typeof agent !== 'object' || name.startsWith('_')) continue;
    if (agent.enabled === false) continue;
    const hit = { name: name.toLowerCase(), agent };
    for (const id of agentIds(name, agent)) if (!byToken.has(id)) byToken.set(id, hit);
  }
  if (!byToken.size) return [];
  const alt = [...byToken.keys()].sort((a, b) => b.length - a.length).map(escapeMention).join('|');
  const re = new RegExp(`(?:^|\\s)@(${alt})(?![\\w-])`, 'gi');
  const out = [];
  const seen = new Set();
  for (const m of t.matchAll(re)) {
    const hit = byToken.get(m[1].toLowerCase());
    if (!hit || seen.has(hit.name)) continue;
    seen.add(hit.name);
    out.push({ name: hit.name, agent: hit.agent, atStart: m.index === 0, anywhere: true });
  }
  return out;
}

export function createRouter({ getAgents = () => ({}), defaultBeing = 'e' } = {}) {
  // ONE addressed agent → the routing target it resolves to. Per-kind semantics are
  // UNCHANGED; only the caller changed (every hit, not just the first).
  function targetFor({ name, agent, atStart }, ev) {
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
    if (name === defaultBeing || agent.default === true) {
      return { being: defaultBeing, mention: ev?.mention };
    }
    // Any other LOCAL agent → being = its name, gated on its own mention.
    return { being: name, mention };
  }

  return {
    /** @param {import('./spine.mjs').InboundEvent} ev
     *  @returns {{ being: string|null, mesh?: object, mention: object|undefined, targets: object[] }}
     *  `targets` is EVERY addressed agent in text order (the spine fans out over it); the
     *  first target's fields are mirrored at the top level so a single-target caller reads
     *  exactly what resolve() always returned. */
    resolve(ev) {
      const agents = getAgents() ?? {};
      const targets = [];
      if (agents && typeof agents === 'object') {
        for (const hit of addressed(ev?.body ?? '', agents)) {
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
          targets.push(targetFor(hit, ev));
        }
      }
      // Nobody addressed (or every hit was surface-pinned away): an @token that matched no
      // agent is the persona's, and so is a bare message.
      if (!targets.length) targets.push({ being: defaultBeing, mention: ev?.mention });
      return { ...targets[0], targets };
    },
  };
}
