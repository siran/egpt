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

## De-special-casing (implementation scope)

Remove hardcoded `'e'`/`'egpt'` + `defaultBeing='e'`; resolve persona/default via `default: true`:

- **src/spine/boot.mjs** — `personaAgent()` = the `default:true` agent (fatal if none, or
  if more than one). `bodyEmojiOf` / `wakeWords` / persona-configuration derive from it;
  the being-id it resolves to is its KEY (not `'e'`).
- **src/spine/router.mjs** — `defaultBeing` = the default agent's key; the persona-route
  branch matches the default agent, not `'e'`/`'egpt'`.
- **src/spine/mesh.mjs** — `isPersonaAgent` / `resolveLocalBeing` / `isLocalBeing` use
  `default:true` + the key, not `'e'`/`'egpt'`.
- **src/spine/brainpool.mjs** — `personaAgentConfiguration()` reads the default agent.
- **src/bridges/beeper-port.mjs** — the enforced stamp uses agent `name` + `signature`;
  the `∎` end-marker becomes the signature.
- **config/config-schema.mjs** + **config/skeletons/config.yaml** — document `name`,
  `default`, `signature` (agent + node-level).

## Compat / migration

- Live persona agents are keyed `egpt` with handles `[e,egpt]` (REVE) / `[ed,egptd]`
  (DOLLY). Add `default: true` to each. Being-id shifts `'e'` -> key `egpt` -> each
  persona's warm session/threads reset ONCE (acceptable; transcript.md history preserved).
- Boot rule (DECIDE at implementation): require exactly one `default: true` (fatal
  otherwise) — cleanest — OR, for one release, fall back to "handles include e/egpt" +
  warn. Lean: require it, and migrate the two live configs in the same deploy.

## Open / not here

- Signature CONTENT is free-text the operator sets per node/agent.
- Relay stamping: `@don`-via-relay answered-as-`ed` should now read cleanly because the
  terminal agent has a declared `name`/`signature`; verify the relay reply carries the
  RUNNING agent's name, not the relay hop's.
- Order: this lands BEFORE Phase 3 (HRW echo), which reuses the same identity/stamp layer.
