# Bridge-routing unification plan

Status: PROPOSED (2026-06-24). No code yet — review before executing on a branch.

## The drift (problem)

WhatsApp and Telegram each grew their **own config dialect** for the same three
questions about a chat:

1. **Who is in it?** (which beings are residents)
2. **Who replies, and in what mode?** (on / mention / off / …)
3. Is it muted / paused?

A lean machine answers these **once**, bridge-agnostically, from the
**per-conversation config** (`conversations/<surface>/<slug>/config.yaml`) + the
siblings registry. Instead, the answers are scattered across top-level
`whatsapp.auto_e_*` and `telegram.*` keys.

## What already exists (the seams — ~half the work is done)

- **Surface-agnostic mode model**: `src/auto-mode.mjs` —
  `AUTO_MODES = ['on','accum','mute','mention-direct','mention','off']`,
  `resolveBeingMode({ auto_modes[chat][being], chatId, being, defaultMode })`.
  Telegram **already** resolves through it (egpt-spine.mjs:3072 — `autoModes: EGPT_CONFIG.auto_modes`).
- **Per-conversation config** already holds `personality`, `members[]`, `mute`,
  `threadId`, `jids[]` (conversations-state.mjs). And `members[]` **already wins**
  over `whatsapp.residents_per_chat` (egpt-spine.mjs:3851).

So the target structures exist; the work is **convergence + data migration + deletion**,
not a new subsystem.

## The two dialects → their unified home

| Dialect key (where read) | Controls | Unified home |
|---|---|---|
| `whatsapp.auto_e_modes[chat]` (legacy, E-only) | E's reply mode per chat | conv `modes.e` (via `auto_modes[chat].e`) |
| `whatsapp.auto_e_default_mode` | global default reply mode | top-level `defaults.mode` |
| `whatsapp.auto_e_paused` | global kill-switch | top-level `defaults.paused` |
| `whatsapp.auto_e_chats` (write-whitelist → 'on') | which chats E posts freely in | conv `modes.e: on` |
| `whatsapp.residents_per_chat[chat]` | who's in the chat | conv `members[]` |
| `telegram.agent` (default → 'wren') | which being answers on TG | conv `members` / default being |
| `telegram.mirror` (none/all/allowed) | does a group route to the bot | conv `modes['*']` (off/mention/on) |
| `telegram.show_think_chats` | show the 💭 think stream | conv `show_think: true` (or DROP — legacy) |

Note: `auto_modes[chat][being]` (the new surface-agnostic map) is itself still a
**flat top-level** map keyed by chatId. The lean end-state moves that per-chat data
**into each conversation's own config file** (`modes:` block), so there is exactly
one place per chat.

## Target per-conversation model

`~/.egpt/conversations/<surface>/<slug>/config.yaml`:
```yaml
personality: default          # or system
members: [e]                  # residents — replaces residents_per_chat + telegram.agent
modes:                        # per-being reply mode — replaces auto_e_modes + telegram.mirror
  e: mention
  "*": off                    # everyone else (the tg-group "mirror" gate)
mute: false
show_think: false             # optional; replaces telegram.show_think_chats
threadId: …
jids: [ … ]
```
Top-level (bridge-agnostic globals), replacing `whatsapp.auto_e_default_mode` / `auto_e_paused`:
```yaml
defaults:
  mode: mention
  paused: false
```

## One resolver, both bridges

Add `resolveConversationRouting(surface, chatId) -> { members, modeFor(being), mute, showThink }`
in auto-mode.mjs (or a new `src/conversation-routing.mjs`). It reads the per-conversation
config + `defaults`, and **both** bridge dispatch paths call it:
- WhatsApp: egpt-spine.mjs ~2017 / ~3668-3725 (mode gate + residents).
- Telegram: egpt-spine.mjs ~3044 (`mirror`) / ~3063 (`agent`) / ~3072 (already partial).

## Phases (each = branch commit + deploy + verify)

**Phase 1 — reader convergence (no data move; fallbacks keep behavior identical).**
Both bridges resolve `(members, mode, mute)` through the one resolver. The resolver
reads per-conv config + `defaults`, **falling back** to the legacy flat keys
(`auto_e_modes`, `auto_e_default_mode`, `auto_e_paused`, `residents_per_chat`,
`telegram.agent`, `telegram.mirror`). WhatsApp adopts `resolveBeingMode`/`auto_modes`.
Verify: every existing chat behaves **exactly** as before (tests below).

**Phase 2 — writer convergence.** `/e auto`, `/e residents` (slash/e.mjs:851-1090) and
the telegram equivalents write the per-conversation `modes`/`members` instead of
`whatsapp.auto_e_*` / `telegram.*`.

**Phase 3 — one-time migration.** Fold existing `whatsapp.auto_e_modes` /
`auto_e_chats` / `residents_per_chat` and `telegram.agent` / `telegram.mirror` into the
matching `conversations/<surface>/<slug>/config.yaml` files. `auto_e_default_mode` /
`auto_e_paused` → top-level `defaults`. (Both nodes.)

**Phase 4 — deletion (the payoff).** Remove the flat keys, the legacy fallbacks, and the
schema entries. The bridges carry **zero** per-bridge routing config — only `enabled`,
`chat_id`, `allowed_users`, and secrets remain bridge-scoped.

## Files touched
- `src/auto-mode.mjs` — the resolver (+ `modeFor`/`members` resolution).
- `egpt-spine.mjs` — WA dispatch (~2017, ~3668-3725) + TG dispatch (~3044-3072) call the resolver.
- `conversations-state.mjs` — add `modes` (+ optional `show_think`) to the entry schema.
- `slash/e.mjs` — writers target per-conv config.
- `config/config-schema.mjs` — drop the dialect entries (Phase 4); add `defaults`.

## Risk + test strategy
- **Highest risk:** the reply gate. A wrong resolution makes a silent chat start
  replying (noise into real groups) or a live chat go quiet.
- **Mitigation:** Phase 1's fallback ⇒ byte-identical behavior. Lock it with tests
  asserting `resolveConversationRouting(...)` equals the OLD resolution for each legacy
  shape (auto_e_chats-only, auto_e_modes per-being, residents_per_chat, telegram
  mirror/agent) **before** Phase 4 deletes anything.
- Branch `bridge-routing-unification`; per-phase deploy to REVE, then DOLLY.

## Open decisions (operator)
1. `defaults` as a top-level block, or under a `routing:` block?
2. `telegram.show_think_chats` — migrate to conv `show_think`, or **drop** (it's the
   legacy show-think we already flagged)?
3. Keep a global default `members` (e.g. `[e]`) or require each conversation to list its own?
4. Telegram is currently `enabled: false` and "abandoned" — do we unify it at all, or
   just strip its config and leave the bridge dormant? (If stripped, this plan is
   WhatsApp-only convergence onto the per-conversation model.)
