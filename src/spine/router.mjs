// router.mjs — the §2c router service: resolve an InboundEvent to the beings that
// should answer. E (the persona) is the default voice.
//
// The `agents:` config block is the ONE registry (operator 2026-07-02, new-config-only):
// resolve() runs the ONE mention matcher (`addressed`, below) over the node's whole
// addressable set — every agent's WAKE TOKENS (its declared `handles:`, else its map key,
// see wakeTokens below; plus, since 2026-08-31, the CONDITIONAL `fallback_handle:` token — see
// fallbackWake) — and resolves EVERY agent the
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
import { surfaceOf, SHELL_SURFACE } from './identity.mjs';

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

// THE CONDITIONAL counterpart to wakeTokens, above — ONE MORE handle this agent wakes on, but
// ONLY in a chat where a named OTHER identity is not a participant (operator 2026-08-31: "it's
// one line to specify the handles that i expect to be answered by some other account (like
// rodz); if that account is not present in the chat, fallback_handle can be used").
//
//   fallback_handle: { handle: e, unless_present: "+13472576794" }
//
// THE ARRANGEMENT it exists for: kg and do stopped sharing ONE Beeper account (2026-08-31). `do`
// now runs on a SECOND account (+1 347…, "Rodz") and carries a relay agent `e` that forwards to
// ekg.kg — so `@e` is ANSWERED by kg's brain but POSTED from a visibly different account, which is
// the whole point of the arrangement. The COST is that `e` became a handle on `do` ONLY: in every
// chat the 347 account is not a member of — most of the operator's chats, and EVERY room, since a
// `~/.egpt/rooms/<name>` conversation is not a Beeper chat at all and has no participants — `@e`
// reached nobody and he had to type `@ekg` instead.
//
// WHY MEMBERSHIP AND NOT LIVENESS: "did do answer?" is unusable — do may simply be slow, so every
// message would carry a timeout. Membership is STATIC and knowable LOCALLY: kg looks at its own
// copy of the chat and asks whether the peer account is in it. Where that identity IS present the
// token belongs to the OTHER account's agent and this node stays silent — which is what keeps one
// `@e` from waking two spines (THE LIVE BUG wakeTokens documents above: "both spines answered ONE
// @egpt, kg stamped egpt, DOLLY stamped don").
//
// SELF-CONTAINED, per agent: kg declares only what IT needs to know — a handle and the identity
// that pre-empts it. Nothing here reads, mirrors or validates do's config; the two nodes stay
// independently editable, which is why this is one line and not a shared peer table.
//
// BOTH fields are REQUIRED; a declaration missing either is IGNORED (null), never half-honoured. A
// `handle` with no `unless_present` would be an UNCONDITIONAL extra wake token — that is exactly
// what `handles:` is for, and silently promoting a half-written fallback into one is precisely how
// a second spine starts answering. Fail closed.
export function fallbackWake(agent) {
  const fb = agent?.fallback_handle;
  if (!fb || typeof fb !== 'object' || Array.isArray(fb)) return null;
  const handle = String(fb.handle ?? '').trim().toLowerCase();
  const unlessPresent = String(fb.unless_present ?? '').trim();
  return (handle && unlessPresent) ? { handle, unlessPresent } : null;
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
//
// `withFallback` (DEFAULT false, operator 2026-08-31): admit each agent's `fallback_handle` token
// (fallbackWake, above) into the SAME vocabulary, so the CONDITIONAL handle goes through THE ONE
// mention matcher like every other token — no parallel scan, no fourth mention system (this repo
// has already accumulated three and evicted two). A hit won that way carries `unlessPresent`, the
// identity whose PRESENCE in the chat silences it; the caller that admitted the token owes the
// membership answer. It is OPT-IN precisely because a guarded token nobody can evaluate must not
// exist: mesh.mjs (resolving an envelope's `<being>.<node>`) and heartbeat-loader.mjs (resolving a
// configured handle) both name an agent with NO chat in hand, so their vocabulary is unchanged —
// and so is resolve()'s on a node that wired no membership seam.
export function addressed(text, agents, { addressWithoutAt = true, isVoice = false, withFallback = false } = {}) {
  const byToken = new Map();                       // WAKE TOKEN -> { name, agent }; first agent wins a shared handle
  const byVoiceToken = new Map();                   // VOICE TOKEN -> { name, agent }; same convention, voice-only
  const guardOf = new Map();                        // FALLBACK TOKEN -> the identity whose PRESENCE silences it
  for (const [name, agent] of Object.entries(agents ?? {})) {
    if (!agent || typeof agent !== 'object' || name.startsWith('_')) continue;
    const hit = { name: name.toLowerCase(), agent };
    for (const id of wakeTokens(name, agent)) if (!byToken.has(id)) byToken.set(id, hit);
    if (isVoice) for (const id of voiceWakeTokens(agent)) if (!byVoiceToken.has(id)) byVoiceToken.set(id, hit);
  }
  // A SECOND pass, deliberately: a token some agent DECLARES as a real handle always beats another
  // agent's fallback for it (the first-agent-wins rule above, extended by precedence — a declared
  // handle is unconditional, a fallback is a courtesy that yields to it).
  if (withFallback) {
    for (const [name, agent] of Object.entries(agents ?? {})) {
      if (!agent || typeof agent !== 'object' || name.startsWith('_')) continue;
      const fb = fallbackWake(agent);
      if (!fb || byToken.has(fb.handle)) continue;
      byToken.set(fb.handle, { name: name.toLowerCase(), agent });
      guardOf.set(fb.handle, fb.unlessPresent);
    }
  }
  const out = [];
  const seen = new Set();
  for (const { token, atStart } of mentionHits(text, [...byToken.keys()], { addressWithoutAt })) {
    const hit = byToken.get(token);
    if (!hit || seen.has(hit.name)) continue;
    seen.add(hit.name);
    // The guard rides ALONG, it is not applied here: answering it needs the chat's roster (IO),
    // and this function is sync + pure. The key is ABSENT on an ordinary hit, so an unguarded
    // hit is the same object it always was.
    out.push({ name: hit.name, agent: hit.agent, atStart, anywhere: true, ...(guardOf.has(token) ? { unlessPresent: guardOf.get(token) } : {}) });
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
// `isPresent` (operator 2026-08-31, fallback_handle) — async (identity, ev) => true | false | null
// ("unknown"), THE membership question, injected exactly the way loadState is: the router never
// opens a socket of its own, it ASKS. boot binds it to the node's own Beeper bridge, which answers
// it from the chat info GET the arrival path already makes (src/bridges/beeper.mjs
// chatHasParticipant — cached, and free for a 1:1). ABSENT (tests, a caller with no bridge) → no
// agent's fallback_handle token enters the vocabulary at all, so resolve() is byte-identical to
// today: a guarded token nobody can evaluate must not be addressable.
// `onLog` — the router's diagnostic sink; the ONLY thing it says is the fallback membership
// failure below, which must never be silent.
export function createRouter({ getAgents = () => ({}), defaultBeing = 'e', addressWithoutAt = true, loadState = null, isPresent = null, onLog = () => {} } = {}) {
  // ONE addressed agent → the routing target it resolves to. Per-kind semantics are
  // UNCHANGED; only the caller changed (every hit, not just the first).
  function targetFor({ name, agent, atStart, unlessPresent }, ev) {
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
    //
    // WHY ev.mention AND NOT the synthetic `mention` above: for the PERSONA the bridge's is the
    // richer one. It is the only mention carrying `replyToBot` (the synthetic hardcodes false),
    // so replacing it would break the quote-reply-without-@e path. E keeps ev.mention.
    //
    // …EXCEPT for a hit won by this agent's `fallback_handle` (operator 2026-08-31), which is the
    // one thing ev.mention CANNOT know about: the bridge computes atE from `wakeWords` (boot.mjs,
    // via wakeTokens — DECLARED handles only, see its header). On kg — `handles: [ekg, egptkg]`,
    // `fallback_handle: { handle: e, unless_present: +1347… }` — a live `@e estás?` in a 1:1 logged
    // `(atE=false)` and got NOTHING, while `@ekg estás?` in the SAME chat was answered. The
    // membership guard below had ALREADY run and ALREADY said the peer was absent; this branch
    // then handed the gate the bridge's atE=false and threw that YES away. The feature was a
    // no-op for the persona, and INVISIBLY so: a guard-DROPPED hit falls through to the identical
    // `{ being: defaultBeing, mention: ev.mention }` at the bottom of resolve(), so passing and
    // dropping produced the same object and the log stayed silent either way.
    //
    // OR, NEVER REPLACE: the fallback match ADDS the matcher's own per-agent findings (same flags,
    // same convention as `mention` above) onto whatever the bridge already found, so `replyToBot`
    // and an atEStart the bridge saw on some OTHER handle both survive. `unlessPresent` is set on
    // this hit ONLY after it passed the guard — resolve() never pushes a dropped hit — so the guard
    // stays the SINGLE authority on whether this node answers, and an ordinary persona hit returns
    // the very same object it always did (identity, not a copy).
    //
    // AND THIS IS WHY `wakeWords` IS LEFT ALONE. Widening the BRIDGE's vocabulary to `e` would set
    // atE=true before any guard exists to say otherwise, and resolve()'s "nobody addressed"
    // fall-through would then hand that atE=true to the persona in precisely the chats the guard
    // REJECTED — reviving the live two-spines-answer-one-mention bug (wakeTokens' header), loudly,
    // in a group, from two visibly different accounts. Silence under the guard has to stay the
    // default that costs no code, not a second suppression kept in sync with this one.
    if (name === defaultBeing || agent.default === true) {
      if (unlessPresent == null) return { being: defaultBeing, mention: ev?.mention };
      return { being: defaultBeing, mention: { replyToBot: false, ...(ev?.mention ?? {}), atEStart: !!ev?.mention?.atEStart || atStart, atEAnywhere: true } };
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
      // WHERE THIS MESSAGE ARRIVED (operator 2026-08-31), which is not always where it is being
      // dispatched. Since 8227b99 a wa-group's message re-enters the room it was invited to as a
      // turn addressed `{network:'room', chatId:<room>}`; that address is the turn's IDENTITY and
      // must not move (a569ada — the room's thread, warm process, queue, access_level). But the
      // two gates BELOW that ask about the CONVERSATION were then asking about the wrong one:
      //   · the SURFACE PIN matched a `surface: shell` agent against a message that arrived on
      //     WhatsApp, because the tunnel re-addressed it onto surface `room`;
      //   · the ROSTER gate asked a ROOM whether the peer account is a participant. A room has no
      //     roster, so the answer is a definite absence — and `@e` in "perrito traducciones",
      //     which kg correctly declines because Rodz IS in that group, woke kg's E a second time
      //     through the tunnel. One message, two turns, from two visibly different accounts.
      // `ev.origin` (identity.mjs, ridden across by room-relay's tunnelOf) is that conversation.
      // ABSENT on every genuine inbound and every older caller → this IS `ev`, so both gates read
      // the identical object they always read.
      //
      // DELIBERATELY NOT the allowed_users gate below: that one asks "may this sender reach this
      // being HERE", which is REACHABILITY, not arrival — its per-conversation override is written
      // against the conversation the turn runs in, and moving it would silently re-scope who may
      // wake a being. Same line f70edce drew for the mesh responder's own allowed_users.
      const org = ev?.origin ?? ev;
      // ONE membership answer per identity per resolve() call (never per hit) — same discipline as
      // the conv-state read above. Only ever consulted for a hit that actually carries a guard, so
      // a message addressing nobody, or addressing an ordinary handle, costs nothing.
      const presence = new Map();                  // identity -> Promise<true|false|null>
      const presentInChat = (identity) => {
        if (!presence.has(identity)) presence.set(identity, (async () => {
          // A ROOM IS NOT A BEEPER CHAT (operator 2026-08-31). A `~/.egpt/rooms/<name>`
          // conversation lives on the shell/room surface: it has no Beeper chat id and no
          // participant list — there is nothing to query and nothing that COULD answer. That is a
          // DEFINITE absence, not an unknown: a Beeper account provably is not in the operator's
          // local console. So the fallback applies, decided HERE with no network call and without
          // touching the failure path below — as cheap and as certain as the 1:1 shortcut. This
          // is the case that matters most: the operator's room transcripts are full of
          // `@e can you please…`, and those lines have reached nobody since `e` moved off kg.
          // SHELL_SURFACE (identity.mjs) is read, never re-derived — see its header.
          // …asked of the conversation the message ARRIVED in (`org`, above), never the one it is
          // dispatched into: a tunnelled group message is a room event by address and would take
          // this shortcut on the room's behalf, throwing away the group's real roster.
          if (String(org?.surface ?? '').toLowerCase() === SHELL_SURFACE) return false;
          try { const v = await isPresent(identity, org); return v == null ? null : !!v; }
          catch (e) { onLog(`fallback_handle: membership lookup for ${identity} in ${org?.surface}/${org?.chatId} threw — ${e?.message ?? e}`); return null; }
        })());
        return presence.get(identity);
      };
      if (agents && typeof agents === 'object') {
        // isVoice rides off the SAME ev already in scope (spine.mjs sets it; identity.mjs stamps
        // it from the bridge's isTranscriptFromVoice) — no new field, the one this node already
        // carries for a voice-note turn. Absent/false → addressed() runs its @/bare-only path,
        // byte-identical to before.
        // withFallback rides off the membership seam being WIRED (operator 2026-08-31): the
        // conditional token exists exactly where its condition can be evaluated, so a node/test
        // with no `isPresent` resolves precisely as it did before this feature existed.
        for (const hit of addressed(ev?.body ?? '', agents, { addressWithoutAt, isVoice: ev?.isVoice, withFallback: !!isPresent })) {
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
          // …and it is compared against the ARRIVAL surface (`org`, above), not the dispatch one:
          // kg pins `don` to `surface: shell` precisely because on Beeper `do` hears @don himself,
          // so a WhatsApp line tunnelled into a room must not start matching that pin the moment
          // the tunnel re-addresses it onto surface `room`.
          if (hit.agent.surface != null
              && surfaceOf(String(hit.agent.surface).toLowerCase()) !== String(org?.surface ?? '').toLowerCase()) continue;
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
          // FALLBACK-HANDLE GUARD (operator 2026-08-31) — the THIRD post-match filter here, and
          // deliberately shaped like the two above (surface pin, allowed_users): the ONE matcher
          // decided the token was addressed, this decides whether THIS node is the one to answer
          // it, and a drop falls through exactly as if the @token had never matched. LAST, so the
          // only lookup that ever happens is for a hit that already survived everything else.
          //
          // FAILURE MODE — UNKNOWN MEANS SILENT, and the choice is not symmetric:
          //   · A fallback token is not this agent's own handle. It BELONGS to the other account's
          //     agent (`e` on do) and is borrowed only where its owner cannot hear it. With no
          //     evidence, it goes back to its owner.
          //   · Waking on unknown re-creates the exact live bug this whole vocabulary exists to
          //     prevent — two spines answering ONE mention — and does it LOUDLY, in a group, in
          //     front of other people, with two different accounts posting the same answer.
          //   · The opposite failure is bounded and recoverable: the agent's DECLARED handles
          //     (@ekg, @egptkg) are unconditional and always work, so a miss costs one retyped
          //     token, never a lost message. And it can only ever bite in a GROUP whose roster GET
          //     is failing — a 1:1 is answered from cache without a round trip, and a room is a
          //     definite absence decided above, so neither can reach this branch.
          // Loud on the way out (never silent): this is a node choosing not to answer something
          // that was addressed to it, which is otherwise indistinguishable from a hung spine.
          if (hit.unlessPresent != null) {
            const present = await presentInChat(hit.unlessPresent);
            if (present == null) onLog(`fallback_handle: @${hit.name} NOT woken by its fallback handle in ${ev?.surface}/${ev?.chatId} — could not establish whether ${hit.unlessPresent} is in the chat (unknown ⇒ the token stays its owner's; use a declared handle)`);
            if (present !== false) continue;
          }
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
