# Pre-Phase-3: Agent Identity & Bridge Signature

> Design doc, operator 2026-07-10. Write-first; implement after. Lands BEFORE
> Phase 3 (HRW echo) because both touch the same identity/stamp layer.

## Problem

The persona ("E") is identified across the spine by HARDCODED handles `'e'`/`'egpt'`
(src/spine/router.mjs, mesh.mjs, boot.mjs, brainpool.mjs) plus a hardcoded canonical
being-id `defaultBeing = 'e'` (warm sessions, threads, transcripts all key off it).
Consequences the operator hit live:

- `agents.egpt` reads as "special": rename the key/handles and persona resolution +
  the relay chain's terminal-being lookup break. (Operator renamed the key and `@don`
  stopped replying.)
- Relay identity confusion: `@don` relays to the persona `ed` on DOLLY; the terminal
  agent answered but got confused reading its own transcript ("his name was ed"),
  because it has no CLEARLY DECLARED name — identity is inferred from hardcoded strings.

An agent should be a PLAIN identifier with declared traits. Nothing about the key
string should be magic.

## Decisions (operator 2026-07-10)

1. **Default agent = `default: true`** on exactly ONE agent. That agent is the persona:
   it answers un-@mentioned messages, and relay chains that resolve to it run it. No
   hardcoded `'e'`/`'egpt'` anywhere.
2. **Per-agent signature.** The bridge signs a reply with the ANSWERING AGENT's signature.
3. **Being-id = the agent's KEY.** Warm sessions / threads / transcripts key off the key.
   Renaming a key = a new identity (expected + honest — that agent's warm session/threads
   reset; transcript.md history stays on disk).
4. **Signature ends the reply train** (replaces the hardcoded `∎`). Precedence: the
   agent's `signature`, else a node-level `signature` fallback.

## The agent model (config)

```yaml
agents:
  <key>:                     # plain identifier; ALSO the stable being-id
    name: "..."              # display name the bridge stamps; falls back to <key>
    handles: [...]           # @tokens that invoke this agent
    body_emoji: "..."        # reply stamp; falls back to the node default
    configuration: <type>    # brain (config/agents/<type>.yaml)
    default: true            # ONE agent only: the persona (unmentioned + relay terminus)
    signature: "..."         # bridge signature / train end-marker; falls back to node signature
  # relay agents keep relay_channel / to / network as today (no default, no brain)
```

Node-level (config.yaml top level):

```yaml
signature: "..."             # fallback signature when an agent declares none
```

## Bridge stamp format

- Was: `<body_emoji> <persona-name>` first line, then `<text>`, ending in `∎`.
- Now: `<body_emoji> <name>: <text> <signature>`
  - `name`      = agent.name ?? key
  - `signature` = agent.signature ?? node.signature (the train end-marker; replaces `∎`)

## De-special-casing (implementation scope — FULL blast radius, verified by grep 2026-07-10)

Remove hardcoded `'e'`/`'egpt'` + `defaultBeing='e'`; resolve persona/default via `default: true`.
`boot` computes the default agent's KEY once (`defaultKey`) and INJECTS it into the pure
modules (router/mesh/brainpool/gating/conversations-state) — those can't read config.

- **src/spine/boot.mjs** — `personaAgent()` = the `default:true` agent. Fatal if none OR
  more than one (`throw`, not fallback). `bodyEmojiOf` / `labelOf` / `wakeWords` /
  `personaEmoji` / transcript `persona` all resolve via `defaultKey`, not `'e'`/`'egpt'`.
  The being-id it resolves to is `defaultKey` (its map key).
- **src/spine/router.mjs** — `defaultBeing` (injected = `defaultKey`); the persona-route
  branch matches the default agent (its key), not the `'e'`/`'egpt'` literals.
- **src/spine/mesh.mjs** — `isPersonaAgent` (agent.default===true), `isLocalBeing`,
  `resolveLocalBeing` (persona handle → `defaultKey`, not `'e'`); drop the `'e'`/`'egpt'`
  shortcuts (findAgentByToken already resolves a handle like `ed` to the key).
- **src/spine/brainpool.mjs** — `personaAgentConfiguration()` reads the default agent;
  `isSibling = being !== defaultKey` (was `!== 'e'`).
- **src/spine/gating.mjs** — `defaultMode`/`sendToEgpt` key off `being === defaultKey`
  (injected), not `'e'`. (NOT in the original plan list — found by grep.)
- **conversations-state.mjs** — `getBeing` / `recordThread` / `residentsOf` must not
  hardcode `'e'`. CLEAN design (accepted reset, operator 2026-07-10): the default being is
  a NORMAL nested being keyed by `defaultKey` — its being-level fields (threadId, mode,
  send_to_egpt, readonly, personality, thread*) live in `nested[defaultKey]`, NOT the flat
  entry. NO flat fallback for being-level fields (that fallback is what made `'e'` special).
  Contact-level fields (slug, pushedName, firstSeenAt, jids, aliasOf, conversation_path,
  transcribe) STAY flat. `residentsOf` must not synthesize an implicit `'e'`: thread the
  default key from config at each call site (verify callers) rather than a hardcoded return.
  Consequence (accepted): existing flat persona state is abandoned on deploy → per-conv
  thread + mode + instanced-brain reset once; transcript.md preserved. (NOT in the original
  plan list — found by grep; this is the delicate part.)
- **src/bridges/beeper-port.mjs** — the enforced stamp becomes `<body_emoji> <name>: <text>`
  (name = agent.name ?? key; inline colon replaces the old two-line `<emoji> <label>\n`).
  Keep the leading model-self-label strip.
- **src/spine/sender.mjs** — the `∎` END_MARK becomes the SIGNATURE (train end-marker),
  resolved per-being via an injected `signatureOf(being)` = agent.signature ?? node
  signature ?? `'∎'` (so behavior is unchanged until a signature is configured).
- **config/config-schema.mjs** + **config/skeletons/config.yaml** — document `name`,
  `default`, `signature` (agent-level) + top-level node `signature`.
- **Verify-if-live-in-v2 (grep hits; fix or explicitly rule out):** `src/dispatch-helpers.mjs`,
  `src/item-format.mjs`, `src/auto-mode.mjs`, `src/room.mjs` each still carry `'e'`/`'egpt'`
  literals. Confirm whether the v2 spine path reaches them; de-magic the ones it does.
- **Tests:** boot's exactly-one-`default:true` rule will break every fixture that builds an
  agents block without it — update fixtures + add a test asserting boot throws on 0 or >1
  default agents. Router/mesh/brainpool tests asserting being `'e'` move to the key.

## Compat / migration — FINAL DECISION (operator 2026-07-10)

**Option 3 accepted: clean, key-as-being, NO special treatment of the key anywhere.**
`default: true` is the SOLE persona marker. Renaming a key resets that agent's warm
session + thread on its next message (fresh key → fresh session; the old warm entry
idle-evicts in ≤15m or via LRU — the warm pool is the manager, there is no thread GC for
persisted threads, they simply orphan). NO flat back-compat read, NO hidden stable being
(those were rejected as fudges that reintroduce the specialness).

- Boot rule: **require exactly one `default: true` (fatal otherwise).** No handles-based
  fallback. The two live configs get `default: true` added in the SAME deploy as the code
  (else boot fatals) — operator-gated `~/.egpt` edit, key-diff validated.
- First-deploy reset is ACCEPTED: switching the persona being `'e'` → `defaultKey` (`egpt`
  on both live nodes) abandons the flat persona state, so each persona conversation resets
  its thread + mode + instanced brain once. Operator confirmed: default mode is `mention`,
  so mode reversion is a non-issue; transcript.md history is preserved on disk.

## Open / not here

- Signature CONTENT is free-text the operator sets per node/agent.
- Relay stamping: `@don`-via-relay answered-as-`ed` should now read cleanly because the
  terminal agent has a declared `name`/`signature`; verify the relay reply carries the
  RUNNING agent's name, not the relay hop's.
- Order: this lands BEFORE Phase 3 (HRW echo), which reuses the same identity/stamp layer.
