# Single-channel restructure (Beeper is the one channel)

Status: PROPOSED (2026-06-24). Core restructure — review before executing on a branch.
Supersedes the earlier "routing dialects" framing: that was a symptom; this is the cause.

## Principle (operator 2026-06-24)

> There is only **Beeper** serving messages to the spine — the spine uses Beeper as a
> throughput channel. WhatsApp / Telegram / Signal / whatever is just the **network a
> message arrived on**: metadata, not architecture. The code must honor that single
> path. `network` is a field on the message and a conversation's identity — never a
> branch in the dispatch, gate, or render logic, and never a config namespace.

## The code already proves the principle

- `src/bridges/beeper.mjs` IS the single multi-network channel: the WS subscribes to
  `'*'` (every chat, every network) and tags each message with `accountID` (the
  network). egpt then **clamps** it: `networks = ['whatsapp']` is a "v1 SAFE SCOPE"
  filter that drops every other network. The single channel exists; it's narrowed,
  and the network is discarded instead of carried.
- `src/bridges/telegram.mjs` is a **redundant second transport** — direct Telegram
  Bot API (`api.telegram.org`, polling, `bot_token`). It bypasses Beeper. The literal
  violation.
- The dichotomy has spread: **~94** `fromWhatsApp`/`fromTelegram` branch-points across
  egpt-spine.mjs + dispatch.mjs + src/, and `KNOWN_SURFACES = ['whatsapp','telegram',
  'shell','signal']` models network as a code *surface*.

## The three collapses

### 1. Transport — one ingress
- **Delete** `src/bridges/telegram.mjs` + `startTelegramBridge` + the telegram bridge
  startup/ref in egpt-spine + the `telegram:` config block + its schema entries.
- Beeper carries `network` (`accountID`) per message. Widen the `networks` scope from
  `['whatsapp']` to the set the operator has connected in Beeper (config:
  `beeper.networks: ['whatsapp', …]`, default `['whatsapp']` to stay fail-closed).
- Telegram, *if ever wanted*, arrives **through Beeper** (connect it in Beeper),
  tagged `network: telegram` — no egpt code change.

### 2. Code paths — network-agnostic dispatch
- Replace the `meta.fromWhatsApp` / `meta.fromTelegram` booleans with a single
  `meta.network` string (+ `meta.fromChannel` true for any Beeper message vs shell).
- Audit the ~94 branches: each is one of
  - **render/format** (e.g. TG HTML vs WA text) → a per-network *formatter* picked by
    `network`, not an `if` in the dispatch core;
  - **identity/storage** (slug dir, jids) → keep `network` as the key, no branch;
  - **genuinely dead** (telegram-only paths) → delete with collapse #1.
- Goal: dispatch, the reply gate, silence policy, mention resolution, streaming —
  **zero** `network` branches. Network appears only in formatters + storage keys.

### 3. Config — one channel block + per-conversation model
- `whatsapp:` → `beeper:` (or `channel:`) — the channel config: `enabled`, `networks`,
  `allowed_users`, `chat_id` (operator self), `media`, `beeper_token`. Nothing
  network-specific.
- The routing dialects (`auto_e_*`, `telegram.agent`, `telegram.mirror`,
  `residents_per_chat`) fold into the **per-conversation config**
  (`conversations/<network>/<slug>/config.yaml`: `members`, `modes{being:mode}`,
  `mute`) + top-level `defaults: {mode, paused}`. (Beeper already has the
  surface-agnostic `auto_modes[chat][being]` + `resolveBeingMode` — WhatsApp just
  hasn't adopted it; Telegram already calls it at egpt-spine.mjs:3072.)
- One `resolveConversationRouting(network, chatId) -> { members, modeFor(being), mute }`
  that the (single) dispatch path calls.

## Phases (each = branch commit → deploy REVE → verify → DOLLY)

- **Phase 0 — kill the redundant transport.** Remove the Telegram-bot bridge + config
  (it's `enabled:false`, abandoned). Smallest, clearest embodiment of the principle;
  also removes a chunk of the 94 branches (the telegram-only ones). LOW risk.
- **Phase 1 — carry the network.** beeper.mjs already has `accountID`; thread it as
  `meta.network`. Add `beeper.networks` scope. Keep behavior identical (still
  whatsapp-only by default).
- **Phase 2 — collapse the branches.** Convert the surviving `fromWhatsApp` checks to
  network-agnostic logic + per-network formatters. This is the bulk; do it in slices
  (render, gate, storage) with tests pinning identical output.
- **Phase 3 — config convergence + per-conversation routing.** `whatsapp:`→`beeper:`;
  WhatsApp adopts `auto_modes`/per-conversation `modes`; writers (`/e auto`,
  `/e residents`) target the conversation config. Fallbacks keep old configs working.
- **Phase 4 — migrate data + delete.** Move flat per-chat keys into conversation
  files (both nodes); delete the dialect keys, fallbacks, and schema. The spine has
  ONE channel, ONE dispatch, network-as-data.

## Risk + tests
- Highest risk: the reply gate (a wrong network-agnostic resolution makes a silent
  chat reply or a live chat go quiet). Mitigation: per-phase fallbacks ⇒ byte-identical
  behavior; pin with tests asserting the new path == old per legacy shape **before**
  deleting. Phase 2 is the delicate one — slice it, test each slice.
- Branch `single-channel`; REVE first, then DOLLY (independent node, same code).

## Open decisions (operator)
1. **Telegram**: confirm DELETE the bot bridge entirely (Phase 0). If ever needed, it
   returns via Beeper. (Recommended — you've called it abandoned twice.)
2. **Config name**: `whatsapp:` → `beeper:` or `channel:`?
3. **Storage**: conversations stay keyed by `<network>/<slug>` (network = identity), or
   flatten? (Recommend keep `<network>/<slug>` — a WA chat ≠ a TG chat.)
4. **Scope rollout**: keep `networks: ['whatsapp']` fail-closed for now, widen later
   per-network deliberately? (Recommend yes — don't auto-act on every Beeper network.)
