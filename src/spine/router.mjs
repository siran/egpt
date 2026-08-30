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
import { mentionHits, mentionHitsAnywhere } from '../auto-mode.mjs';
import { getBeing, allowedUsersPermits } from '../conversations-state.mjs';
import { surfaceOf } from './identity.mjs';

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
// THERE IS NO QUICK REPLY ANY MORE (operator 2026-08-28: "so we evict r. it was a bad idea, you
// can just use 'e'"). `r <body>` used to resolve HERE to whichever agent spoke last, read off the
// transcript — a second addressing scheme beside the @token, with its own config key, its own
// grammar and its own reader in transcript-log.mjs. All of it is gone; an @handle is the only way
// to address an agent, and this function's whole job is again the mention scan below.
//
// Returns EVERY addressed agent in TEXT ORDER, deduped by agent, each carrying its OWN
// { atStart, anywhere } — real per-agent flags, never a blanket constant, because the auto-modes
// rest on exactly that distinction (`mention-direct` wakes on atStart, `mention` on anywhere).
// @returns {{name: string, agent: object, atStart: boolean, anywhere: boolean}[]}
//
// `addressWithoutAt` (DEFAULT true) is the node's `dispatch.address_without_at` — THE switch for
// the bare form, handed straight to the matcher. It arrives the SAME way the wake list does:
// boot → createRouter → here, never read from a config inside this function. It touches ONLY the
// matcher's bare scan; the '@' form is untouched in both states.
//
// `isVoice` (DEFAULT false, operator 2026-08-30): the ONLY per-being voice-wake path — before
// this, voice-wake was wired in exactly ONE place (boot.mjs's persona-only voiceWakeWords, gating
// only the bridge's own mentionStatus call), so a non-persona agent's voice_handles never reached
// this function and could never wake it. When true, EVERY candidate agent's OWN voiceWakeTokens
// (declared `voice_handles:`, no map-key fallback) are ALSO run through mentionHitsAnywhere — the
// SAME matcher the persona's own voice case already uses via mentionStatus' alsoAnywhere — and
// merged into the SAME { name, agent, atStart, anywhere } shape, mirroring mentionStatus' own
// convention: a voice-only hit ORs into `anywhere` and never sets `atStart` (an anywhere match has
// no "start"). Default false → byte-identical to before for every caller that doesn't pass it.
export function addressed(text, agents, { addressWithoutAt = true, isVoice = false } = {}) {
  const byToken = new Map();                       // WAKE TOKEN -> { name, agent }; first agent wins a shared handle
  const byVoiceToken = new Map();                   // VOICE TOKEN -> { name, agent }; same convention, voice-only
  for (const [name, agent] of Object.entries(agents ?? {})) {
    if (!agent || typeof agent !== 'object' || name.startsWith('_')) continue;
    const hit = { name: name.toLowerCase(), agent };
    for (const id of wakeTokens(name, agent)) if (!byToken.has(id)) byToken.set(id, hit);
    if (isVoice) for (const id of voiceWakeTokens(agent)) if (!byVoiceToken.has(id)) byVoiceToken.set(id, hit);
  }
  const out = [];
  const seen = new Set();
  for (const { token, atStart } of mentionHits(text, [...byToken.keys()], { addressWithoutAt })) {
    const hit = byToken.get(token);
    if (!hit || seen.has(hit.name)) continue;
    seen.add(hit.name);
    out.push({ name: hit.name, agent: hit.agent, atStart, anywhere: true });
  }
  if (isVoice) {
    for (const { token } of mentionHitsAnywhere(text, [...byVoiceToken.keys()])) {
      const hit = byVoiceToken.get(token);
      if (!hit || seen.has(hit.name)) continue;
      seen.add(hit.name);
      out.push({ name: hit.name, agent: hit.agent, atStart: false, anywhere: true });
    }
  }
  return out;
}

// `addressWithoutAt` is the node's dispatch.address_without_at (boot reads it once; DEFAULT true)
// — the ONE switch for the bare-handle form, forwarded to `addressed` above.
// `loadState` (operator 2026-08-15, allowed_users) — () => Promise<conv state>, the SAME
// conversations-state IO gating.mjs's createGating takes, injected the same way (mirrored, not
// duplicated). Absent (tests, a caller that doesn't need per-conversation overrides) → resolve()
// simply never reads any per-conversation allowed_users, and every being's reachability falls
// straight to its global `agents:` default (or unrestricted, when neither is set) — today's
// behaviour for a caller that supplies nothing.
export function createRouter({ getAgents = () => ({}), defaultBeing = 'e', addressWithoutAt = true, loadState = null } = {}) {
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
    if (name === defaultBeing || agent.default === true) {
      return { being: defaultBeing, mention: ev?.mention };
    }
    // Any other LOCAL agent → being = its name, gated on its own mention.
    return { being: name, mention };
  }

  return {
    /** @param {import('./spine.mjs').InboundEvent} ev
     *  @returns {Promise<{ being: string|null, mesh?: object, mention: object|undefined, targets: object[] }>}
     *  `targets` is EVERY addressed agent in text order (the spine fans out over it); the
     *  first target's fields are mirrored at the top level so a single-target caller reads
     *  exactly what resolve() always returned.
     *  ASYNC (operator 2026-08-15, allowed_users): a per-conversation allowed_users override
     *  lives in conversations.yaml, which nothing caches (re-read per lookup) — resolving it
     *  needs one state read, done ONCE here, not once per hit. */
    async resolve(ev) {
      const agents = getAgents() ?? {};
      const targets = [];
      // ONE conv-state read for the whole call (never per-hit) — mirrors gating.mjs's own
      // beingView seam/failure mode: no loadState injected, or a read that throws → null, and
      // every hit below falls straight to its GLOBAL allowed_users (or unrestricted).
      const state = loadState ? await loadState().catch(() => null) : null;
      if (agents && typeof agents === 'object') {
        // isVoice rides off the SAME ev already in scope (spine.mjs sets it; identity.mjs stamps
        // it from the bridge's isTranscriptFromVoice) — no new field, the one this node already
        // carries for a voice-note turn. Absent/false → addressed() runs its @/bare-only path,
        // byte-identical to before.
        for (const hit of addressed(ev?.body ?? '', agents, { addressWithoutAt, isVoice: ev?.isVoice })) {
          // SURFACE PIN (operator 2026-07-25): an agent may carry `surface: <name>` so it is an
          // agent ONLY on that surface; on any OTHER surface the @mention falls through (as if
          // unmatched). Co-account CORRECTNESS, not convenience: `do` and `kg` share ONE Beeper
          // account, so on Beeper `do` hears `@don` DIRECTLY and answers it — kg must NOT also
          // relay it. kg relays `don` ONLY from the shell (which `do` can't hear), so kg pins its
          // `don` relay agent `surface: shell`. A surface-mismatched agent is dropped from the
          // target list (the OTHER agents this message addressed are unaffected). A MULTIPATH
          // agent is an ordinary map since 2026-07-26, so it can be pinned like any other.
          // The pin names a NETWORK the operator types (`surface: shell`), so it is resolved
          // through THE network→surface map before comparing — the same map identity.build used
          // to stamp ev.surface. Without that, kg's live `don: surface: shell` stopped matching
          // the moment the shell became surface `room` (2026-08-28) and the relay went silent.
          if (hit.agent.surface != null
              && surfaceOf(String(hit.agent.surface).toLowerCase()) !== String(ev?.surface ?? '').toLowerCase()) continue;
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
          targets.push(targetFor(hit, ev));
        }
      }
      // Nobody addressed (or every hit was surface-pinned/allowed-users away): an @token that
      // matched no agent is the persona's, and so is a bare message.
      if (!targets.length) targets.push({ being: defaultBeing, mention: ev?.mention });
      return { ...targets[0], targets };
    },
  };
}
