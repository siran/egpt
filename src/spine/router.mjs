// router.mjs — the §2c router service: resolve an InboundEvent to the beings that
// should answer. There is NO default being (operator 2026-10-22/23).
//
// The `agents:` config block is the ONE registry (operator 2026-07-02, new-config-only):
// resolve() runs the ONE mention matcher (`addressed`, below) over the node's whole
// addressable set — every agent's WAKE TOKENS (its declared `handles:`, else its map key,
// see wakeTokens below; plus, since 2026-08-31, the CONDITIONAL `fallback_handle:` token — see
// fallbackWake) — and resolves EVERY agent the
// message addressed, in text order. A LOCAL agent (configuration ≠ 'relay') routes like a
// being (being = agent name); a RELAY agent (configuration: relay) routes to a mesh target
// whose ROUTE is the agent's relay_channel. Then EVERY local being whose mode in this chat is
// on/auto (gating.resolveMode) takes the line too, named or not — each being once. Nobody
// named and nobody on → no target; `receives` says whether the line is recorded at all.
//
// resolve() returns { being, mesh?, mention, targets, receives } — `targets` is the FULL list (the
// spine runs every one through its per-target path), with the first target mirrored at the top
// level. Each target carries its OWN mention — the matcher's real per-agent { atEStart,
// atEAnywhere, replyToBot } — so the mode vocabulary keeps its meaning (mention-direct ≠ mention).
//
// Cross-node reach is AGENT-BASED (operator 2026-07-25): the ONLY way to leave this machine is
// a RELAY agent, whose relay_channel is the route — resolve() returns { being: null, mesh:
// <target>, mention } and the spine forwards it (mesh.forward). The old bare `@being.node`
// scheme was evicted with its `config.mesh.nodes` routing table: it minted a target carrying no
// route, so nothing could ever carry it. `@don.do` still works when `don` is a relay agent —
// the @token match below stops at the dot and finds the agent.
import { agentPaths } from '../mesh/relay.mjs';
import { mentionHits } from '../auto-mode.mjs';
// The `(voice transcription, Ns) ` marker a voice note's body carries — READ from the module that
// WRITES it (incoming-media.voiceTranscriptBody), never re-spelled here. addressed() takes it off
// before the spoken-wake scan so "the start" means the start of the TRANSCRIPT, not of the marker.
import { VOICE_MARK } from '../incoming-media.mjs';
import { getBeing, getContact, allowedUsersPermits, defaultBeingOf } from '../conversations-state.mjs';
import { surfaceOf, SHELL_SURFACE } from './identity.mjs';
import { fromOtherNode } from './node-names.mjs';
import { resolveMode } from './gating.mjs';

// Is this agents-map entry a LOCAL being (not a relay, not a `_` comment key)?
export const isLocalAgent = (k, a) => !k.startsWith('_') && !!a && typeof a === 'object' && !Array.isArray(a)
  && !a.relay_channel && !Array.isArray(a.paths) && String(a.configuration ?? '').toLowerCase() !== 'relay';

// A local (non-relay) agent's map key, matched case-insensitively; null when there is none.
function localAgentKey(agents, name) {
  const want = String(name ?? '').trim().toLowerCase();
  if (!want) return null;
  const hit = Object.entries(agents ?? {}).find(([k, a]) => k.toLowerCase() === want && isLocalAgent(k, a));
  return hit ? hit[0] : null;
}

// Is this sender on ANY allowed_users list (networks.*, agents.*.conversation_defaults)? "*" names nobody.
export function isKnownSender(senderId, config = {}) {
  const lists = [
    ...Object.values(config.networks ?? {}).map((n) => n?.allowed_users),
    ...Object.values(config.agents ?? {}).map((a) => a?.conversation_defaults?.allowed_users),
  ].filter(Array.isArray).flat().filter((u) => u !== '*');
  return allowedUsersPermits(lists, senderId);
}

// THE STRANGER RULE (operator 2026-10-15): dispatch.stranger_agent maps a CONNECTION to the agent
// that answers a 1:1 from a sender on no allowed_users list. Pure; the "new conversation" half is
// the caller's (router: no entry yet; ensureContact: a brand-new entry).
export function strangerAgentFor(ev, config = {}) {
  const map = config?.dispatch?.stranger_agent;
  if (!map || typeof map !== 'object' || Array.isArray(map) || !ev?.connection) return null;
  if (ev.isSender || ev.raw?.chatType !== 'private') return null;
  const key = localAgentKey(config.agents, map[ev.connection]);
  return key && !isKnownSender(ev.senderId, config) ? key : null;
}
// The block a stranger's new conversation is seeded with for its agent: its owner, answering every line.
export const STRANGER_SEED = Object.freeze({ default: true, mode: 'on' });

// What boot logs (and verify-install warns) about a config under the no-default-agent rule
// (operator 2026-10-22/23): `default:` is ignored, and an on/auto mode set for a being or for the
// node applies in EVERY chat the node hears. Pure; one line per finding.
export function configWarnings(config = {}) {
  const out = [];
  for (const [name, a] of Object.entries(config.agents ?? {})) {
    if (a && typeof a === 'object' && Object.hasOwn(a, 'default')) out.push(`agents.${name}.default is ignored — there is no default agent (2026-10-22). Remove the line.`);
    if (isLocalAgent(name, a) && (a.mode === 'on' || a.mode === 'auto')) out.push(`WARNING agents.${name}.mode: ${a.mode} — ${name} answers EVERY line in EVERY chat this node hears. Set the mode per conversation instead.`);
  }
  const node = resolveMode(null, '', { dispatch: config.dispatch, whatsapp: config.whatsapp }).mode;
  if (node === 'on' || node === 'auto') out.push(`WARNING dispatch.auto_default_mode: ${node} — EVERY being without a mode of its own answers every line in every chat this node hears.`);
  return out;
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
// THE ONE definition: src/spine/boot.mjs (the node's wake set it hands the ports) and
// src/spine/mesh.mjs (an envelope's `<being>.<node>` token) import it from here. There used to be
// three copies of this rule in those three files.
//
// IN ONE CHAT a being's handles may differ: agentsInChat, below, is the registry as that chat sees it.
export function wakeTokens(name, agent) {
  const hs = Array.isArray(agent?.handles) ? agent.handles : [name];
  return hs.map((h) => String(h ?? '').toLowerCase()).filter(Boolean);
}

// THE agents registry AS ONE CHAT SEES IT (operator 2026-10-24) — the one per-chat handle lookup.
// A being whose block in that chat's conversations.yaml entry sets `handles:` answers there to
// that list and nothing else (its fallback_handle is dropped too); `[]` = nothing names it there.
// voice_handles stay node-wide. No override (or no state) → the SAME map object, so a caller
// with no per-chat key is unchanged.
export function agentsInChat(agents, state, surface, chatId) {
  let out = agents;
  if (!state) return out;
  for (const [name, agent] of Object.entries(agents ?? {})) {
    if (!agent || typeof agent !== 'object' || name.startsWith('_')) continue;
    const hs = getBeing(state, surface, chatId, name)?.handles;
    if (!Array.isArray(hs)) continue;
    const { fallback_handle: _dropped, ...rest } = agent;
    if (out === agents) out = { ...agents };
    out[name] = { ...rest, handles: hs };
  }
  return out;
}

// EVERY token the node's AGENTS block answers to — wakeTokens above run over the whole map, for
// the REFUSAL MESSAGES that have to tell an operator what they could have typed instead. It
// applies `addressed`'s OWN two guards (`_`-prefixed comment keys and non-map values are not
// agents), so it can never advertise a token that would not actually resolve. Deduped, in map
// order. Two callers: heartbeat-loader.mjs's unknown-`agent:` skip line and commands.mjs's
// unknown-`/agents <handle>` refusal — it lived privately in the former until the latter needed
// the same sentence.
export function addressableTokens(agents) {
  return [...new Set(Object.entries(agents ?? {})
    .filter(([n, a]) => a && typeof a === 'object' && !n.startsWith('_'))
    .flatMap(([n, a]) => wakeTokens(n, a)))];
}

// THE SPOKEN counterpart to wakeTokens, above — voice_handles is a SEPARATE, opt-in list (a
// whisper transcript never carries '@', so these are matched as a BARE token — and since
// 2026-09-09 only at the START, the same rule a bare @handle follows; see addressed()).
// UNLIKE handles, there is NO map-key fallback: ABSENT or `[]` both
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
//   fallback_handle: { handle: e,          unless_present: "+13472576794" }
//   fallback_handle: { handle: [d, don],   unless_present: "+13472576794" }   ← since 2026-09-01
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
//
// `handle:` IS A STRING **OR A LIST** (operator 2026-09-01) — the same shape `handles:` has, for
// the same reason: a persona answers to more than one name. Each node reaches the other's persona
// through a relay agent gated by this token, so the fallback carries that peer persona's WHOLE
// address set — do's answers to `d` AND `don`, kg's to `e` AND `egpt`. With ONE token per fallback
// the operator got `@don` working in 1:1s while `@d` reached nobody ("'d' is not enabled as wake
// word on 1:1s"), because String(['d','don']) is the single token 'd,don', which nothing can type.
//
// EVERY token in the list carries the SAME `unless_present`: the list is one peer agent's
// ADDRESSES, not several independent policies, so one identity in the chat pre-empts the whole set
// — which is exactly the guarantee that keeps one mention from waking two spines. A plain string
// is a one-element list (the live config on both nodes today, byte-identical to before). Blank
// entries are dropped and an all-blank list is the same as no fallback: `handle: []` cannot both
// mean "wake on nothing" and mean something, so it takes the fail-closed reading, like a missing
// field. (Contrast `handles: []`, which IS a meaningful empty list — there it is the COMPLETE wake
// set, and saying "addressable by nothing" is a thing an operator may want; a fallback that wakes
// on nothing is indistinguishable from not declaring one.)
export function fallbackWake(agent) {
  const fb = agent?.fallback_handle;
  if (!fb || typeof fb !== 'object' || Array.isArray(fb)) return null;
  const handles = [...new Set((Array.isArray(fb.handle) ? fb.handle : [fb.handle])
    .map((h) => String(h ?? '').trim().toLowerCase()).filter(Boolean))];
  const unlessPresent = String(fb.unless_present ?? '').trim();
  // `unless_peer_alive: <port>` — silent while the PEER SPINE on this machine is up (operator
  // 2026-09-02). Two spines now fit on one box, Session 0 holding the agent's Beeper and Session
  // 1 the operator's, and on a forced restart only S0 exists because S1 needs a login. So S0
  // assumes the peer's handle while the peer is absent and gives it back when it returns.
  //
  // It is the SAME RULE as unless_present with a different predicate: one asks "is that identity
  // in this chat", the other "is my peer serving its console port". In the operator's topology
  // they name one fact — S1 is always `an`, S0 is always Rodz — so a fallback would carry one or
  // the other, never both. Both are accepted anyway and, if both appear, BOTH must permit (see
  // the drop in resolve): silence is the cheap direction, a double answer is not.
  //
  // A port, validated here, because the caller that evaluates it needs one and a malformed value
  // must disarm the fallback rather than arm it against a port nobody serves.
  const peerPort = Number(fb.unless_peer_alive);
  const unlessPeerAlive = Number.isInteger(peerPort) && peerPort > 0 && peerPort < 65536 ? peerPort : null;
  if (!handles.length || (!unlessPresent && unlessPeerAlive == null)) return null;
  // Each key is present ONLY when declared, so a fallback carrying only unless_present returns
  // exactly the object it always did — an unconfigured predicate adds no field to compare.
  return {
    handles,
    ...(unlessPresent ? { unlessPresent } : {}),
    ...(unlessPeerAlive != null ? { unlessPeerAlive } : {}),
  };
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
//
// …and `token`, THE HANDLE THAT WON THE HIT (operator 2026-09-11). An agent's handles are not its
// name (`e` is woken by `ekg`, `egptkg`, `perro`), so "which token addressed it" is knowledge only
// this scan has — and the prompt path needs it: a handle at the START is ADDRESSING, and must come
// off the trigger the model is asked to answer (auto-mode.withoutAddress, applied by the spine
// through targetFor's `address` below). Carrying the token out is what keeps that ONE matcher the
// only thing that ever decides what a handle is; re-scanning the body downstream would be the
// fourth mention system this file exists to prevent.
// @returns {{name: string, agent: object, token: string, atStart: boolean, anywhere: boolean}[]}
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
// (declared `voice_handles:`, no map-key fallback) are ALSO run through the scan below.
//
// START ONLY, THE SAME RULE AS AN @HANDLE (operator 2026-09-09). It used to be mentionHitsAnywhere
// — a spoken name matched ANYWHERE in the sentence, while the @handle's bare form has always been
// start-only. That asymmetry was live and biting: `rey` ("king") is one of ken's spoken names and
// `perro` ("dog") is one of E's, so "el rey de españa" and "tengo un perro grande" woke a being
// mid-sentence. There is now ONE rule — the spoken list goes through mentionHits, the SAME matcher
// on line ~250, and only its `atStart` hits count.
//
// SO A VOICE HIT IS A START HIT: it carries { atStart: true, anywhere: true }, the identical shape
// a leading @handle yields, and the old "ORs into anywhere, never sets atStart" convention is gone
// with the anywhere-match that motivated it. That distinction is what the auto-modes rest on
// (`mention-direct` wakes on atStart, `mention` on anywhere), and both readings are now correct:
// a spoken name at the start IS a direct address, and mid-sentence it is no address at all.
//
// AND "THE START" IS THE TRANSCRIPT'S: a voice note arrives with its body already marked
// `(voice transcription, Ns) …` (incoming-media.voiceTranscriptBody), so VOICE_MARK comes off
// first. Without that, no spoken alias could ever sit at position 0 and this would have killed
// voice wake outright rather than narrowing it. Only the spoken scan sees the stripped text — the
// @handle scan above reads the raw body exactly as it always has.
//
// Default false → byte-identical to before for every caller that doesn't pass it.
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
//
// `replyToBeing` (DEFAULT null, operator 2026-09-16): the being whose post this message QUOTES, as
// the bridge read it off that post's invisible frame (ev.replyToBeing, src/bridges/beeper.mjs) —
// never off prose. When it names an agent it is ONE MORE HIT in this same list, so resolve() puts it
// through every post-match filter a handle hit passes. Deduplicated like any two hits; when the
// being was also named, that one hit carries `reply` too, so its gate sees the reply either way.
export function addressed(text, agents, { addressWithoutAt = true, isVoice = false, withFallback = false, replyToBeing = null } = {}) {
  const byToken = new Map();                       // WAKE TOKEN -> { name, agent }; first agent wins a shared handle
  const byVoiceToken = new Map();                   // VOICE TOKEN -> { name, agent }; same convention, voice-only
  const guardOf = new Map();                        // FALLBACK TOKEN -> the GUARD that silences it ({ unlessPresent, unlessPeerAlive })
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
      if (!fb) continue;
      // PER TOKEN (operator 2026-09-01, `handle:` is a list now): the yield-to-a-declared-handle
      // rule is decided one alias at a time, so another agent owning `d` outright never disarms
      // this agent's `don`. Each token lands in guardOf carrying the SAME unlessPresent — that
      // shared guard is what makes the list ONE peer's address set rather than several handles.
      for (const handle of fb.handles) {
        if (byToken.has(handle)) continue;
        byToken.set(handle, { name: name.toLowerCase(), agent });
        guardOf.set(handle, {
          ...(fb.unlessPresent != null ? { unlessPresent: fb.unlessPresent } : {}),
          ...(fb.unlessPeerAlive != null ? { unlessPeerAlive: fb.unlessPeerAlive } : {}),
        });
      }
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
    out.push({ name: hit.name, agent: hit.agent, token, atStart, anywhere: true, ...(guardOf.has(token) ? guardOf.get(token) : {}) });
  }
  if (isVoice) {
    // The transcript, marker off (see the isVoice header) — then THE matcher, start hits only.
    const spoken = String(text ?? '').replace(VOICE_MARK, '');
    for (const { token, atStart } of mentionHits(spoken, [...byVoiceToken.keys()], { addressWithoutAt })) {
      if (!atStart) continue;
      const hit = byVoiceToken.get(token);
      if (!hit || seen.has(hit.name)) continue;
      seen.add(hit.name);
      out.push({ name: hit.name, agent: hit.agent, token, atStart: true, anywhere: true });
    }
  }
  if (replyToBeing != null) {
    const want = String(replyToBeing).toLowerCase();
    const named = out.find((h) => h.name === want);
    const entry = Object.entries(agents ?? {}).find(([name, agent]) => agent && typeof agent === 'object' && !name.startsWith('_') && name.toLowerCase() === want);
    if (named) named.reply = true;
    else if (entry) out.push({ name: want, agent: entry[1], token: null, atStart: false, anywhere: false, reply: true });
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
// `getConfig` — the node config, read for dispatch.stranger_agent and the allowed_users lists.
export function createRouter({ getAgents = () => ({}), getConfig = () => ({}), addressWithoutAt = true, loadState = null, isPresent = null, isPeerAlive = null, inboundOf = null, onLog = () => {} } = {}) {
  // ONE addressed agent → the routing target it resolves to. Per-kind semantics are
  // UNCHANGED; only the caller changed (every hit, not just the first).
  function targetFor({ name, agent, token, atStart, reply }) {
    // The mention an addressed agent hands its own gate. NOT a constant: the flags are the
    // matcher's REAL per-agent findings (operator 2026-07-25: "respect the mode, if it's
    // mention-direct not the same as mention … nothing has changed"). replyAllowed() already
    // knows what they mean — `mention` wakes on anywhere, `mention-direct` only on atStart — so
    // an agent named mid-sentence in a mention-direct chat correctly stays silent. A LEADING
    // @name still yields { atEStart: true, atEAnywhere: true }, exactly the old constant.
    // `replyToBot` is the matcher's finding too: true for a hit won by quoting this being's own
    // post (addressed() `replyToBeing`), so a mention-mode chat admits the reply without a handle.
    const mention = { atEStart: atStart, atEAnywhere: true, replyToBot: !!reply };
    // THE ADDRESSING HANDLE, or null (operator 2026-09-11). The token that OPENED the message is
    // how the sender addressed this agent, not something the sender said to it — so the spine
    // takes it off the trigger it hands the model (auto-mode.withoutAddress). POSITION is the
    // whole test, the same one `atStart` already answers for the gate: mid-sentence, a handle is
    // content and this stays null. Every kind of target carries it uniformly, and every kind
    // CONSUMES it, at the origin — a target that means one thing on one branch and nothing on
    // another is how fields rot.
    //
    // THIS COMMENT USED TO SAY THE OPPOSITE about the mesh — *"a mesh forward does not consume
    // it (the far node's own router addresses the envelope and strips there)"* — and that was
    // never true of the code (operator 2026-09-11). NO ROUTER EVER SEES A RELAYED BODY: the
    // responder resolves which being answers from the envelope's own `to:` tail and hands
    // relayDispatch's `prompt` straight to brain.turn, so `@don.mo hola` reached `don` with the
    // handle on. Nor COULD the far node strip it — the token is the ORIGIN's relay-agent handle,
    // in the origin's vocabulary, resolved by the one matcher here. So the origin takes it off
    // the body it puts on the wire (spine.dispatchChat → addressedBody).
    const address = atStart ? (token ?? null) : null;
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
      return { being: null, mesh: { being: name, paths }, mention, address };
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
      return { being: null, mesh, mention, address };
    }
    // A LOCAL agent → being = its name, gated on its own mention.
    return { being: name, mention, address };
  }

  return {
    // The registry as this event's ARRIVAL chat sees it (agentsInChat) — for the command parser,
    // so `/<handle> …` resolves exactly as resolve() does. No loadState → the node-wide map.
    async agentsIn(ev) {
      const state = loadState ? await loadState().catch(() => null) : null;
      const org = ev?.origin ?? ev;
      return agentsInChat(getAgents() ?? {}, state, org?.surface, org?.chatId);
    },
    /** @param {import('./spine.mjs').InboundEvent} ev
     *  @returns {Promise<{ being: string|null, mesh?: object, mention: object|undefined, targets: object[], receives: boolean }>}
     *  `targets` is EVERY addressed agent in text order, then every being taken by its on/auto mode
     *  (the spine runs each one); the first target's fields are mirrored at the top level. Empty =
     *  nobody takes the line; `receives` false = no being here receives it (not recorded).
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
      // THE CONVERSATION'S OWN AGENT (operator 2026-10-15): the entry's `agents.<being>.default: true`,
      // else, for a chat with no entry yet, the stranger rule. A stranger in its conversation reaches it
      // and nobody else. No state read → none (unchanged).
      const cfg = { ...(getConfig() ?? {}), agents };
      const contact = state ? getContact(state, ev?.surface, ev?.chatId) : null;
      const owner = !state ? null
        : (localAgentKey(agents, defaultBeingOf(contact?.entry)) ?? (contact ? null : strangerAgentFor(ev, cfg)));
      const ownerOnly = !!owner && !ev?.isSender && !isKnownSender(ev?.senderId, cfg);
      // THE allowed_users test for one being here (see the ALLOWED_USERS GATE below). Every target
      // that can wake a being passes it, one taken by its mode included (operator 2026-10-16: "no
      // mode is above allowed_users").
      const permits = (name, agent) => {
        const conv = state ? (() => { try { return getBeing(state, ev.surface, ev.chatId, name); } catch { return null; } })() : null;
        const convAllowed = Array.isArray(conv?.allowedUsers) ? conv.allowedUsers : null;
        const globalAllowed = Array.isArray(agent?.conversation_defaults?.allowed_users) ? agent.conversation_defaults.allowed_users : null;
        return allowedUsersPermits(convAllowed ?? globalAllowed, ev?.senderId);
      };
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
      // THE POST-MATCH FILTERS — one set, for a named hit and for a being taken by its mode alike:
      // false drops that being from this line (it is still recorded). `anyArrival` = exempt from the
      // connection gate: a hit won by a fallback_handle token (its own guard below decides), or a
      // being taken by its mode (as the old default fall-through was: it never arbitrated arrivals).
      const admits = (name, agent, anyArrival = false) => {
        if (ownerOnly && name.toLowerCase() !== owner.toLowerCase()) return false;
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
        if (agent.surface != null
            && surfaceOf(String(agent.surface).toLowerCase()) !== String(org?.surface ?? '').toLowerCase()) return false;
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
        // @token had never matched.
        if (!permits(name, agent)) return false;
        // THE CONNECTION GATE (operator 2026-09-08) — another post-match filter, same shape as
        // the two above and placed before the fallback guard so that guard keeps being the last
        // thing to run and the only one that can cost a lookup. The ONE matcher decided the
        // token was addressed; this decides whether THIS ARRIVAL is the one that answers it, and
        // a drop falls through exactly as if the @token had never matched (the message is still
        // received, still recorded, still read as back-context — only the wake is withheld).
        //
        // WHY. One spine can hold BOTH accounts as two EARS, and one real WhatsApp group is a
        // DIFFERENT room per account, so the spine hears one typed line TWICE — deliberately
        // undeduplicated (bridge-fanout.mjs). The operator's ruling is that the binding decides:
        // "received by primary, logs, recognized agent, produces reply … received by secondary,
        // logs, K is not an agent. continue."
        //
        // THE INGEST HALF, AND ONLY THAT (operator 2026-09-10). This asks boot's `inboundOf`,
        // never its `outboundOf`: an agent's `use:` names where it SPEAKS, and letting that move
        // what it can HEAR is exactly the coupling that took the live node deaf on the
        // operator's own account. On a node with ONE ear inboundOf answers that ear for every
        // agent, so nothing here can withhold a wake that the single ear delivered.
        //
        // `ev.connection` is stamped at the fan-out registration and is NULL on a one-bridge
        // node (fanoutInbound hands back the bridge itself there), so this whole gate is inert
        // for every node that holds one Beeper endpoint.
        //
        // A GUARDED HIT IS EXEMPT, and that is the CONDITIONAL, not an escape hatch. The gate
        // can only compare two connection NAMES; it cannot ask "is my own connection in this
        // chat at all", because one real group is a different chatId per account and the owning
        // connection has never seen the arriving one's id. So on its own the gate would also
        // silence the case the operator requires to work — `k hi` in a group only the OTHER
        // account is in, where the owning connection is not present and the arrival that exists
        // is the only one there will ever be. `fallback_handle` asks exactly that question
        // (`unless_present`, answered from the ARRIVING chat's roster, fanned out since
        // 32eb862): a hit won by a guarded token has already been decided by the one filter that
        // can see membership, so the gate must not overrule it. Unconditional tokens — which are
        // the ones that double-answer, and the ones boot warns about — are what this gate is
        // for.
        //
        // WHAT IS STILL MISSING, said out loud so the next reader does not look for it: the
        // guard names the owning connection by a HAND-PASTED phone number. Deriving it — asking
        // literally "is my OWNING CONNECTION in this chat" — needs that connection's own account
        // identity, and a `beeper:` block records only a label, a token and an optional
        // base_url. Until one exists, an UNCONDITIONAL handle bound to a connection reaches
        // nobody in a chat only the OTHER connection is in (locked as a gap in
        // tests/multi-connection-wake.test.mjs).
        //
        // AND IT ARBITRATES BETWEEN TWO ARRIVALS, NOTHING ELSE (operator 2026-09-13, "secondary
        // only hears if primary is not present"). Ear-ness is a PER-CHAT fact now: a connection
        // this node holds that is not one of its ears still wakes in the chats the ear's account
        // is NOT in, and boot's bridge gate drops everything else before the spine ever sees it
        // (src/spine/boot.mjs perChatEars / theEarIsAbsentFrom). Such an arrival is therefore the
        // ONLY one this node will get for that message — there is no second arrival to choose
        // between, and dropping it here would silence every agent in exactly the chats only that
        // connection can hear. So the arrival's own connection is handed to `inboundOf`, which is the one place that
        // knows whether it is a per-chat ear; a caller with no arrival in hand still asks the
        // node-level question, unchanged. AGENTS ARE PER SPINE, not per connection — this gate
        // may decide WHICH ARRIVAL wakes an agent, never which connections an agent may hear.
        if (ev?.connection && typeof inboundOf === 'function'
            && !anyArrival) {
          const own = inboundOf(name, ev.connection);
          if (own && own !== ev.connection) return false;
        }
        return true;
      };
      if (agents && typeof agents === 'object') {
        // isVoice rides off the SAME ev already in scope — no new field, the one this node already
        // carries for a voice-note turn. STAMPED IN EXACTLY ONE PLACE: identity.build (identity.mjs),
        // off the bridge's `from.isTranscriptFromVoice`. spine.mjs only ever READS it (the radio
        // relay, and whether the reply is spoken) and this comment used to claim spine.mjs SET it —
        // a false lead that cost a whole session's trace, so it is named precisely here. The one
        // payload that is not a bridge's own, room-relay.mjs's tunnelOf, re-mints that same key off
        // ev.isVoice, so an invited wa-group's voice note is still a voice note in the room it
        // tunnels into. Absent/false → addressed() runs its @/bare-only path, byte-identical to
        // before.
        // withFallback rides off the membership seam being WIRED (operator 2026-08-31): the
        // conditional token exists exactly where its condition can be evaluated, so a node/test
        // with no `isPresent` resolves precisely as it did before this feature existed.
        // replyToBeing likewise rides off ev (identity.build, from the bridge): a quote-reply to a
        // being's own post is one more hit in this loop, filtered exactly like a handle hit.
        // A REACTION's body quotes its target's words, not the reactor's: it addresses only by
        // replyToBeing, as a text reply to that message would (operator 2026-10-18).
        // The handles are the ARRIVAL chat's (`org`): where the line was typed is whose names it uses.
        const here = agentsInChat(agents, state, org?.surface, org?.chatId);
        for (const hit of addressed(ev?.kind === 'reaction' ? '' : (ev?.body ?? ''), here, { addressWithoutAt, isVoice: ev?.isVoice, withFallback: !!isPresent || !!isPeerAlive, replyToBeing: ev?.replyToBeing })) {
          if (!admits(hit.name, hit.agent, hit.unlessPresent != null || hit.unlessPeerAlive != null)) continue;
          // FALLBACK-HANDLE GUARD (operator 2026-08-31) — the LAST post-match filter here, and
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
          // PEER LIVENESS, first because it is the cheaper question — a local observation with
          // no network call and no roster. `isPeerAlive` returns true | false | null(unknown);
          // anything but a definite false leaves the handle with its owner. Unwired seam ⇒ the
          // same refusal: a guard nobody can evaluate must never wake anything (the fail-closed
          // rule the membership guard below already follows).
          if (hit.unlessPeerAlive != null) {
            if (typeof isPeerAlive !== 'function') {
              onLog(`fallback_handle: @${hit.name} NOT woken — unless_peer_alive is declared but this node wired no liveness seam`);
              continue;
            }
            let alive = null;
            try { alive = isPeerAlive(hit.unlessPeerAlive); }
            catch (e) { onLog(`fallback_handle: @${hit.name} liveness probe for port ${hit.unlessPeerAlive} threw — ${e?.message ?? e}`); alive = null; }
            if (alive !== false) {
              onLog(`fallback_handle: @${hit.name} NOT woken — the peer spine on port ${hit.unlessPeerAlive} is ${alive == null ? 'of unknown liveness' : 'alive'}, so the handle stays its owner's`);
              continue;
            }
          }
          if (hit.unlessPresent != null) {
            const present = await presentInChat(hit.unlessPresent);
            if (present == null) onLog(`fallback_handle: @${hit.name} NOT woken by its fallback handle in ${ev?.surface}/${ev?.chatId} — could not establish whether ${hit.unlessPresent} is in the chat (unknown ⇒ the token stays its owner's; use a declared handle)`);
            if (present !== false) continue;
          }
          targets.push(targetFor(hit));
        }
      }
      // EVERY BEING WHOSE MODE HERE IS on/auto TAKES THE LINE TOO (operator 2026-10-22/23: no default
      // being; an "on" being answers every line, named or not) — each being once, a named one keeping
      // its named target, through the same filters as a hit. `fallthrough: true` = taken by its mode,
      // not addressed: the spine's signed-line gate never wakes it on a being's own output.
      // `address: null`: nothing addressed it, so there is no handle to take off the prompt.
      // A reply to another node's signed post is addressed to its signer (operator 2026-10-18):
      // recorded, and no being takes it by mode here. A stranger's chat with no entry yet runs its
      // owner on the mode its seed will write (STRANGER_SEED).
      // `receives`: does any being here receive the line at all — every one 'off' → not recorded (C4).
      const elsewhere = fromOtherNode(cfg, { fromNode: ev?.replyToNode ?? null });
      if (elsewhere) onLog(`reply: ${ev?.surface}/${ev?.chatId} quotes node <${ev.replyToNode}>'s post — addressed there; recorded, prompts nobody by mode`);
      const local = Object.entries(agents).filter(([k, a]) => isLocalAgent(k, a));
      let receives = !local.length;
      for (const [key, agent] of local) {
        const name = key.toLowerCase();
        const bv = state ? (() => { try { return getBeing(state, ev.surface, ev.chatId, key); } catch { return null; } })() : null;
        const mode = (!contact && owner === key) ? STRANGER_SEED.mode : resolveMode(bv, key, cfg).mode;
        if (mode !== 'off') receives = true;
        if (elsewhere || (mode !== 'on' && mode !== 'auto')) continue;
        if (targets.some((t) => t.being === name) || !admits(key, agent, true)) continue;
        targets.push({ being: name, mention: {}, address: null, fallthrough: true });
      }
      return targets.length ? { ...targets[0], targets, receives } : { being: null, mention: undefined, targets, receives };
    },
  };
}
