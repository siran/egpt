// router.mjs — the §2c router service: resolve an InboundEvent to the beings that
// should answer. E (the persona) is the default voice.
//
// The `agents:` config block is the ONE registry (operator 2026-07-02, new-config-only):
// resolve() runs the ONE mention matcher (`addressed`, below) over the node's whole
// addressable set — every agent's WAKE TOKENS (its declared `handles:`, else its map key,
// see wakeTokens below) — and resolves EVERY agent the
// message addressed, in text order. A LOCAL agent (configuration ≠ 'relay') routes like a
// being (being = agent name); a RELAY agent (configuration: relay) routes to a mesh target
// whose ROUTE is the agent's relay_channel; the DEFAULT (persona) agent — the one carrying
// `default: true`, whose KEY boot injects as `defaultBeing` — routes to its own key (operator
// 2026-07-10: the being-id IS the map key, no hardcoded 'e'/'egpt'). An unknown @token, or a
// message addressing nobody, falls through to the persona (defaultBeing).
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
import { getBeing, allowedUsersPermits } from '../conversations-state.mjs';

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

// THE wake vocabulary — the ONE definition of "which @tokens address this agent", lowercased
// (operator 2026-07-26: "don must not wake or respond with 'egpt'" … "the key has no bearing …
// the yaml key can be discarded, an agent reacts if its handle is invoked").
//
//   `handles:` DECLARED  →  it is the COMPLETE wake list; the map KEY is NOT a token.
//   `handles:` ABSENT    →  the key serves as the handle.
//
// THE LIVE BUG this rule fixes: both spines answered ONE `@egpt` in a WhatsApp group — kg stamped
// `egpt`, DOLLY stamped `don`. DOLLY's persona DISPLAYS as "don" but is still KEYED `egpt`, and the
// key used to be a wake token alongside [d, don], so `@egpt` woke both nodes.
//
// The KEY IS STILL THE BEING-ID and nothing here touches that: it keys warm sessions and the
// per-conversation entry[<being>] thread blocks, and renaming it is a NEW identity (config-schema).
// This function answers only "who is addressed", never "who runs" — the callers below map a matched
// token back to the agent's key, which is what runs.
//
// THE FALLBACK IS FOR AGENTS THAT SIMPLY DON'T DECLARE HANDLES, and nothing else. It used to be
// load-bearing for MULTIPATH too — that shape was a bare Array of path maps with nowhere to hang
// an agent-level `handles:` key, so kg's `carol` was the last agent on the node addressable only
// by its map key. Since 2026-07-26 a multipath agent is an ordinary map whose `paths:` holds the
// list (see agentPaths in src/mesh/relay.mjs), so it declares handles like everyone else.
//
// `handles: []` (explicitly empty) is a complete list that happens to be empty → the agent is
// addressable by NOTHING. Falling back to the key on empty would make `handles: []` mean the same
// as `handles: [<key>]`, reviving the very bug above, and would leave no way to say "no @address".
//
// THE ONE definition: src/spine/boot.mjs (the persona wake set it hands the ports) and
// src/spine/mesh.mjs (an envelope's `<being>.<node>` token) import it from here. There used to be
// three copies of this rule in those three files.
export function wakeTokens(name, agent) {
  const hs = Array.isArray(agent?.handles) ? agent.handles : [name];
  return hs.map((h) => String(h ?? '').toLowerCase()).filter(Boolean);
}

// THE SPOKEN counterpart to wakeTokens, above — voice_handles is a SEPARATE, opt-in list (a
// whisper transcript never carries '@'; it gates auto-mode.mjs's ANYWHERE bare match, not this
// file's own @token matcher). UNLIKE handles, there is NO map-key fallback: ABSENT or `[]` both
// mean no spoken alias reaches this agent — silence-by-default, since an unconfigured agent has
// no business waking on a guessed spoken word the way it inherits its own key as an @handle.
export function voiceWakeTokens(agent) {
  const hs = Array.isArray(agent?.voice_handles) ? agent.voice_handles : [];
  return hs.map((h) => String(h ?? '').toLowerCase()).filter(Boolean);
}

// Who does this message address? The node's WHOLE addressable set — every agent's WAKE TOKENS
// (wakeTokens above: its declared `handles:`, else its map KEY) — run through THE mention matcher
// (auto-mode.mjs `mentionHits`), the same scan the persona's wake words go through. That is the
// whole fix (operator 2026-07-25): there were TWO mention systems, the bridge's persona-only one
// and this file's own leading-@token-on-RAW-text regex, so `@e and @don you here?` woke only e and
// an `@agent` mid-sentence was invisible. Now there is one, and an agent inherits every protection
// E has (code fences since 47caf19, the glued-token rule, longest-token-first).
//
// `_`-prefixed comment keys are not addressable — they fall through, exactly as findAgent used to
// skip them. (An agent-level `enabled:` key is NOT consulted: operator 2026-07-26, "disabling is
// just commenting the config. no need to have or check an enabled key in this case.")
//
// A QUICK REPLY (`quickReply` + `lastSpeaker`) is resolved HERE too, and to ONE addressee: the
// last AGENT that spoke in this conversation, ATSTART (it was directly addressed, so a
// mention-direct chat answers it), carrying the `body` the token was stripped from. The gate is
// `lastSpeaker` — null in a conversation where no agent has spoken, and there `r …` matches
// nobody and stays ordinary text. It is a STATIC LOOKUP the spine performs on the RECORD
// (transcript-log.lastSurfacedBeing — operator 2026-07-27: "r is static, it searches the
// transcript"); nothing here reads a file, and nothing anywhere remembers who spoke. HUMAN LINES
// IN BETWEEN ARE IRRELEVANT (operator 2026-07-26: "'r' should reply to last bot message") — for
// free now, since the walk asks for the last AGENT line and skips everything else.
// lastSpeaker is a BEING-ID (the record labels the agent's map key, never a handle), so it is
// looked up BY KEY — not through the wake-token map, which since 2026-07-26 need not contain the
// key at all (DOLLY's persona is keyed `egpt` and wakes on [d, don]).
//
// Returns EVERY addressed agent in TEXT ORDER, deduped by agent, each carrying its OWN
// { atStart, anywhere } — real per-agent flags, never a blanket constant, because the auto-modes
// rest on exactly that distinction (`mention-direct` wakes on atStart, `mention` on anywhere).
// @returns {{name: string, agent: object, atStart: boolean, anywhere: boolean, body?: string}[]}
//
// `addressWithoutAt` (DEFAULT true) is the node's `dispatch.address_without_at` — THE switch for
// the bare form, handed straight to the matcher. It arrives the SAME way the wake list does:
// boot → createRouter → here, never read from a config inside this function. It touches ONLY the
// matcher's bare scan: the '@' path and the QUICK REPLY above are resolved before/around it and
// are unaffected (`r ok` is not a bare handle — it is the last speaker, looked up by lastSpeaker).
export function addressed(text, agents, { quickReply = '', lastSpeaker = null, addressWithoutAt = true } = {}) {
  const byToken = new Map();                       // WAKE TOKEN -> { name, agent }; first agent wins a shared handle
  const byBeing = new Map();                       // BEING-ID (the map key) -> { name, agent }
  for (const [name, agent] of Object.entries(agents ?? {})) {
    if (!agent || typeof agent !== 'object' || name.startsWith('_')) continue;
    const hit = { name: name.toLowerCase(), agent };
    byBeing.set(hit.name, hit);
    for (const id of wakeTokens(name, agent)) if (!byToken.has(id)) byToken.set(id, hit);
  }
  const body = lastSpeaker ? quickReplyBody(text, quickReply) : null;
  if (body != null) {
    const hit = byBeing.get(String(lastSpeaker).toLowerCase());
    if (hit) return [{ name: hit.name, agent: hit.agent, atStart: true, anywhere: true, body }];
  }
  const out = [];
  const seen = new Set();
  for (const { token, atStart } of mentionHits(text, [...byToken.keys()], { addressWithoutAt })) {
    const hit = byToken.get(token);
    if (!hit || seen.has(hit.name)) continue;
    seen.add(hit.name);
    out.push({ name: hit.name, agent: hit.agent, atStart, anywhere: true });
  }
  return out;
}

// `getQuickReply` reads config.quick_reply_string (unset → the 'r' default below; '' disables).
// `addressWithoutAt` is the node's dispatch.address_without_at (boot reads it once; DEFAULT true)
// — the ONE switch for the bare-handle form, forwarded to `addressed` above.
// `loadState` (operator 2026-08-15, allowed_users) — () => Promise<conv state>, the SAME
// conversations-state IO gating.mjs's createGating takes, injected the same way (mirrored, not
// duplicated). Absent (tests, a caller that doesn't need per-conversation overrides) → resolve()
// simply never reads any per-conversation allowed_users, and every being's reachability falls
// straight to its global `agents:` default (or unrestricted, when neither is set) — today's
// behaviour for a caller that supplies nothing.
export function createRouter({ getAgents = () => ({}), defaultBeing = 'e', getQuickReply = () => undefined, addressWithoutAt = true, loadState = null } = {}) {
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
    // MULTIPATH (operator 2026-07-06: multipath is configuration — an agent declares a list of
    // paths, every message through every path). An agent carrying `paths:` is a relay whose every
    // element posts the SAME message into its own relay_channel with its own network pin.
    // Return the mesh target carrying ALL paths; mesh.forward posts one envelope per path
    // (one 🤔 placeholder for the human, same re:/post_id). Handled BEFORE the scalar check
    // (a multipath agent has no top-level relay_channel). Each path: { route:{room_id,network?}, to?, label }.
    if (Array.isArray(agent.paths)) {
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
     *  @returns {Promise<{ being: string|null, mesh?: object, mention: object|undefined, targets: object[], body?: string }>}
     *  `targets` is EVERY addressed agent in text order (the spine fans out over it); the
     *  first target's fields are mirrored at the top level so a single-target caller reads
     *  exactly what resolve() always returned. `body` is present ONLY for a quick reply: the
     *  message minus its token, what the agent should be handed.
     *  ASYNC (operator 2026-08-15, allowed_users): a per-conversation allowed_users override
     *  lives in conversations.yaml, which nothing caches (re-read per lookup) — resolving it
     *  needs one state read, done ONCE here, not once per hit. */
    async resolve(ev, lastSpeaker = null) {
      const agents = getAgents() ?? {};
      const targets = [];
      let body;
      // ONE conv-state read for the whole call (never per-hit) — mirrors gating.mjs's own
      // beingView seam/failure mode: no loadState injected, or a read that throws → null, and
      // every hit below falls straight to its GLOBAL allowed_users (or unrestricted).
      const state = loadState ? await loadState().catch(() => null) : null;
      if (agents && typeof agents === 'object') {
        for (const hit of addressed(ev?.body ?? '', agents, { quickReply: getQuickReply() ?? 'r', lastSpeaker, addressWithoutAt })) {
          // SURFACE PIN (operator 2026-07-25): an agent may carry `surface: <name>` so it is an
          // agent ONLY on that surface; on any OTHER surface the @mention falls through (as if
          // unmatched). Co-account CORRECTNESS, not convenience: `do` and `kg` share ONE Beeper
          // account, so on Beeper `do` hears `@don` DIRECTLY and answers it — kg must NOT also
          // relay it. kg relays `don` ONLY from the shell (which `do` can't hear), so kg pins its
          // `don` relay agent `surface: shell`. A surface-mismatched agent is dropped from the
          // target list (the OTHER agents this message addressed are unaffected). A MULTIPATH
          // agent is an ordinary map since 2026-07-26, so it can be pinned like any other.
          if (hit.agent.surface != null
              && String(hit.agent.surface).toLowerCase() !== String(ev?.surface ?? '').toLowerCase()) continue;
          // ALLOWED_USERS GATE (operator 2026-08-15): "we should control by access_level and who
          // is able to trigger the agent … i think the 'dangerous' key is mistake" — replaces the
          // evicted TYPE-FILE `dangerous:true` reachability mechanism (meta-engineer.yaml, gone;
          // see brainpool.mjs's confinementFor for what `dangerously_skip_permissions` still
          // means — a CAPABILITY tier only, never a reachability gate any more). Two-tier, the SAME override pattern
          // access_level already uses: a per-conversation `allowedUsers` (conversations.yaml
          // agents.<being>.allowed_users, read via getBeing off the ONE state read above,
          // FLAT — that block is already scoped to one being in one conversation) REPLACES —
          // never merges with — the node's global default, which lives NESTED under
          // agents.<handle>.conversation_defaults.allowed_users in config.yaml: the nesting IS
          // the allowlist of which agent fields get this two-tier treatment (a registry/
          // structural field like handles/configuration/relay_channel, sitting as a direct
          // sibling, is never eligible — no code-side allowlist to keep in sync). UNSET at both
          // tiers = no restriction, today's default (reachable by anyone who could normally
          // address this being). When the resolved list is non-empty, gate on the SENDER's id via
          // the shared allowedUsersPermits predicate (conversations-state.mjs, alongside getBeing
          // — the SAME two-tier shape it documents) — a literal "*" entry permits any sender
          // (operator 2026-08-16), otherwise shortChatId normalizes both sides (src/bridges/
          // chat-id.mjs) — the SAME normalizer boot.mjs's OWN (separate, network-level)
          // allowed_users check uses — so a short OR legacy full-form entry matches either way.
          // Deliberately INDEPENDENT of ev.authorized/ev.isSender (the existing NETWORK-level
          // allowed_users/isSender concept) — a being's own allowed_users is a narrower, different
          // check and never reuses that field. A hit failing it is dropped SILENTLY, same
          // convention as the surface-pin mismatch above: it falls through exactly as if the
          // @token had never matched (to another target, the persona, or "nobody addressed").
          const conv = state ? (() => { try { return getBeing(state, ev.surface, ev.chatId, hit.name); } catch { return null; } })() : null;
          const convAllowed = Array.isArray(conv?.allowedUsers) ? conv.allowedUsers : null;
          const globalAllowed = Array.isArray(hit.agent.conversation_defaults?.allowed_users) ? hit.agent.conversation_defaults.allowed_users : null;
          const allowedUsers = convAllowed ?? globalAllowed;
          if (!allowedUsersPermits(allowedUsers, ev?.senderId)) continue;
          if (hit.body != null) body = hit.body;
          targets.push(targetFor(hit, ev));
        }
      }
      // Nobody addressed (or every hit was surface-pinned/allowed-users away): an @token that
      // matched no agent is the persona's, and so is a bare message.
      if (!targets.length) targets.push({ being: defaultBeing, mention: ev?.mention });
      return { ...targets[0], targets, ...(body != null ? { body } : {}) };
    },

    /** Is this text a QUICK REPLY — and if so, what is its body? THE grammar (quickReplyBody
     *  above) applied to THIS node's configured token, exposed as one function so the spine can
     *  ask the question without owning a copy of either half. The spine asks it to decide whether
     *  a message is worth a transcript read at all (resolve() applies it again on the answer):
     *  `r …` is rare, so ordinary traffic must not pay for a file read.
     *  @returns {string|null} the body minus the token, or null when this is not a quick reply */
    quickReplyOf: (text) => quickReplyBody(text, getQuickReply() ?? 'r'),
  };
}
