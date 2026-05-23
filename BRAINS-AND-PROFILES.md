# Brains, Personas, Siblings, Profiles — how @-routing works

A guide for agents (and humans) working on egpt. Read this before
touching `default_brain`, `meta_brain`, `siblings`, or `main_engineer`
in `~/.egpt/config.yaml`. Mis-wiring these conflates identities or
silently breaks `@me` routing.

---

## The vocabulary

- **Brain** — a configured way to talk to a model: a `{ type, session_id,
  model, cwd, allowed_tools, ... }` block. `type` is one of
  `claude-sdk` | `claude-code` | `codex` | `chatgpt-cdp` | `claude-cdp`.
  A brain's `model` MUST be coherent with its `type`:
  - `claude-sdk` / `claude-code` → a Claude model (`haiku`, `sonnet`, `opus`)
  - `codex` → an OpenAI/Codex model (`gpt-5.4-mini`, `gpt-5.5`, …)
  Mixing them (e.g. `type: claude-code` + `model: gpt-5.4-mini`) is
  the #1 corruption to watch for — it's self-contradictory and the
  CLI will misbehave.

- **Profile** — a brain that can be *mentioned* by name. In practice a
  profile is an entry in the `siblings:` registry, addressable as
  `@<name>`. "Profiles are brains that can be mentioned." (operator,
  2026-05-23)

- **Persona** vs **Sibling** — every siblings entry has a `kind`:
  - `kind: persona` — runs `runDefaultBrainTurn`: item-mirror to the
    feed, streaming reply, `/rules` awareness. This is a *participant*
    that talks in chats (e.g. `@e` / `@egpt`).
  - `kind: sibling` — runs `runMetaBrainTurn`: silent, tool-driven
    side-effects. This is an *engineer* that does work, not a chat
    participant (e.g. `@wren`, `@jay`, `@mira`).

- **Pronoun** — a fixed token that *maps to* a profile, rather than
  being a profile itself. `@me` is the pronoun. It is NOT a profile
  and must never be a profile's alias (see below).

---

## The three identity slots

1. **`default_brain`** — the public persona `@e` / `@egpt`. Its own
   brain, its own `session_id`, separate from any engineer. This is
   what talks to contacts in WhatsApp/Telegram. Today: `claude-sdk` /
   `haiku` / its own session. NEVER point this at an engineer's
   session — that conflates the public persona with the builder, which
   the per-ledger design forbids (each surface/identity keeps its own
   ledger; see LEDGER_PROTOCOL.md).

2. **`siblings:`** — the registry of engineer profiles + the persona.
   Each `@<name>` resolves here. Canonical names first, then `aliases`.

3. **`main_engineer`** — names which profile the `@me` pronoun maps to.
   `main_engineer: wren` means `@me → @wren`.

---

## The `@me` pronoun rule (important)

`@me` resolves via `main_engineer`, NOT via a per-sibling
`aliases: [me]`. Concretely:

```yaml
main_engineer: wren        # @me maps DOWN to the wren profile
siblings:
  wren:  { kind: sibling, aliases: [] }   # reachable as @wren AND (via main_engineer) @me
  mira:  { kind: sibling, aliases: [] }   # reachable as @mira
  jay:   { kind: sibling, aliases: [] }   # reachable as @jay
```

To reassign who `@me` is, change ONE line: `main_engineer: <name>`.
Every profile stays reachable by its own `@<name>` regardless.

**Anti-pattern — do not do this:**

```yaml
siblings:
  mira: { aliases: [me] }   # WRONG
  wren: { aliases: [me] }   # WRONG — collision: who is @me now?
```

Putting `me` in a profile's `aliases` invites collision (two profiles
both claiming the pronoun) and scatters the "who is @me" decision
across entries instead of one top-level line. The routing code
(`src/room.mjs` `resolveRoute`) maps `me → siblings[mainEngineer]`
*before* the registry lookup, so `aliases: [me]` is unnecessary and
wrong. Reserve `aliases` for genuine alternate names of the SAME
profile (e.g. a profile reachable as both `@cgpt` and `@chatgpt`).

---

## Common mistakes (seen in the wild, 2026-05-23)

- **Conflating `default_brain` with an engineer session.** Pointing
  `@e`'s `session_id` at the engineer's session merges the public
  persona's memory into the builder's. Keep them separate.
- **Incoherent type/model.** `type: claude-code` + `model: gpt-5.4-mini`.
  Pick a lane.
- **Seizing `@me` via `aliases:[me]`.** Use `main_engineer:` instead.
- **Doing more than asked.** A "rename this profile" request is a
  one-line change. It is not license to reassign `main_engineer`,
  swap the default persona's brain, or restructure the registry.

---

## Where the code lives

- `src/room.mjs` `resolveRoute` — `@<token>` → decision. Maps the `me`
  pronoun to `ctx.mainEngineer` before the registry lookup.
- `egpt.mjs` — builds the routing ctx (`siblings`, `mainEngineer`) and
  the brain-config lookup that reads the resolved profile's brain.
- `config/config-schema.mjs` — documents every config key.
- `src/persona-state.mjs` — `default_brain` state machine (history,
  rewind, session pinning).
