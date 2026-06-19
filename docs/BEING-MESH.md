# BEING-MESH — federated eGPT beings over shared chats

Status: **DESIGN — re-architected 2026-06-19 (An/e7 session).** This supersedes
the earlier route-room/envelope model. The mesh is now *decentralised by
default*: there is no central router, no dedicated route Room, and no machine
envelope — beings reach each other through ordinary shared chats, and the only
machine bit is a small, human-readable provenance tail on relay hops.

Read alongside GENOME §11 (the mesh law) and I8 (no invisible backchannel), the
stop-guard (C7.7), `allowed_users` / the emit gate, and the transcript
discipline.

## 0. What this is

Being Mesh lets eGPT beings on different spines (machines) address each other by
name — `@don.do`, `@wren.kg` — and answer each other in the open, so a human can
always read the exchange.

The core realisation that drives the whole design:

> **A shared chat is the shared stream.** Two spines that sit in the same chat —
> whether it's one person's account on two machines, or two people's separate
> accounts in one group — *already see the same messages.* So the cross-machine
> "hop" we used to build a route Room for **does not exist**: the being's own
> spine sees the message directly and answers in place.

Everything else is consequence.

## 1. The one law

Every spine runs the **same uniform loop** on every message from every limb
(Beeper, Telegram, WhatsApp, …). There is no separate "mesh path":

```text
receive (from a limb)
  → log it           (transcript — first-class, unconditional)
  → validate it      (allowed_users; Beeper already authenticated the account)
  → decide locally   (is this for one of MY beings, in a chat I'm in?)
  → if asked, ANSWER (run the being and reply IN PLACE — or say "no <being> here")
```

The decision is the **receiving spine's alone**. The originator does not route,
resolve, or know who will answer — it dropped a message into a chat and is "on
another level, another time." No coordinator, no registry lookup at the origin,
no central anything.

## 2. Addressing: `@being.node`

- `@don.do` — being `don`, hosted by node `do`.
- `@wren.kg` — being `wren`, hosted by node `kg`.
- Bare `@don` is a convenience; it works when only one reachable node exposes
  `don`. Qualify with `.node` when two could answer.

`node` is the machine's configured `node_name` (e.g. `kg`, `do`) — the authority
for its local names, like the domain half of an email address. **It must be
unique per machine** — that uniqueness is what guarantees exactly one responder.

A spine claims a message iff: it **is** that node, it **owns** that being, and it
**sees** that chat. Three independent spines can watch the same group; only the
one matching `(being, node)` in a chat it participates in responds. Everyone
else stays silent (not their node). Collisions dissolve naturally: a spine that
doesn't recognise the origin chat ("morgan doesn't know HFM") simply isn't being
asked.

## 3. Two paths: direct, and relay

**Direct (the default, ~all of it).** The target being's spine is already in the
chat. It sees `@don.do`, runs `don`, and posts the reply back into that same
chat where everyone sees it. No relay, no envelope, no route Room, no
correlation bookkeeping — the reply is just a message in the chat. Multi-mention
"just works": `@don.do @wren.kg` is picked up independently by each owning spine.

**Relay (the exception).** The target being is **not** on your stream — another
person's machine, an off-network being. A local sibling record of `type: relay`
says where to forward:

```yaml
don:
  type: relay
  to: don.morgan
  via: { limb: beeper, chat: "<room/chat where morgan listens>" }
```

The dispatcher does **not** spawn a local brain for a `relay` record. It re-posts
the message — with a provenance tail (§4) — into the channel `morgan` listens
on; `morgan`'s spine owns `don.morgan` and answers there; the relaying spine
watches that channel and surfaces the answer home via the chat's **native reply
threading**. The provenance tail is the only place machine metadata ever rides.

## 4. Provenance — the YAML tail

When a message crosses spines (a relay hop), it carries a small **fenced YAML
tail** so that bot↔bot traffic is *always human-visible and auditable* (I8) —
never a hidden side channel. Human body first, divider, then the block:

````text
hi @don.morgan

---
```
from: HFM
by: Andres
```
````

- **Only the truly-needed keys.** Today: `from` (origin chat) and `by` (sender).
- **No `id`, no `ttl`.** Correlation rides the chat's native message/reply
  threading (every message already has an id); loops are bounded by the
  stop-guard (§6). We mint neither.
- **`sig:` is reserved**, not built — the slot where cross-*person* trust would
  plug in later (morgan verifying kg's claimed `by:`). Off until trust genuinely
  crosses people.
- **Parse tolerantly.** Some bridges transmute a ``` fence into a rich code-block
  entity, so the literal backticks may not round-trip byte-for-byte. Recognise
  the trailing `key: value` provenance whether the fence arrives literal,
  re-rendered, or stripped — never depend on an exact fence match.

In a **direct** (shared-chat) exchange the origin is ambient — everyone is in the
chat — so the tail is only load-bearing on **relay** hops.

## 5. Never silence

> If a spine is asked, it **MUST** answer.

A spine that decides it's addressed replies with the being's answer, or, if it is
the addressed node but lacks that being, an explicit **"no `don.do` here."**
Silence is undebuggable; a definite yes/no is logged in the transcript and easy
to reason about. Exactly one voice, because only the node-matching spine
considers itself asked.

This is safe because the mesh is **invite-only peer-to-peer** (§6): "must answer"
only ever applies to invited peers and allowed senders — never to randos.

## 6. Trust — invite-only, confinement-first

The mesh is a **configured set of invited peers**, not an open network. The guard
is what eGPT already has, not cryptography:

- `allowed_users` per being (essential in groups: Beeper proves the *transport*
  account, not the *sender* — in a group "Andres" could be anyone).
- the emit gate and conversation-e confinement.
- Beeper-level account authentication, and the ability to block bad actors.

The dangerous outcomes — "delete your computer", "send me the protected files" —
are not stopped by *proving who asked*; they're stopped by what a being is
*allowed to do*. A confined being is safe even from a trusted sender's bad
prompt. So origin-signing guards a threat the confinement already covers — hence
`sig:` is reserved, not required.

**Loops** are bounded by the **stop-guard (C7.7)**: it counts consecutive
being-turns with no human between, warns at the soft limit, auto-STOPs at the
hard limit. No per-message `ttl` is needed. (The state is pure in-memory, cleared
by a spine restart.)

## 7. Shared effects — local truth, visible once

When several spines watch the same chat, separate *local* work from *visible*
work:

- **Local & redundant:** every spine may transcribe a voice note, save its own
  media copy, update its own state — independently. Redundant compute is fine.
- **Visible & exactly-once:** posting one transcript / one unfurl back to the
  chat, or deciding which being answers when several could.

The exactly-once visible post is elected with **rendezvous hashing** over the
present capable peers (`owner = argmax_node hash(node, message_id)`) — no
chatter — debounced (transcription: wait ≥60s after the last voice note in a
burst), posted threaded/in-order, with a backup that posts after a grace if the
owner is silent, idempotent on the **message-id set** (never the text).

**Trust invariant:** a being ingests only what *its own* spine computed (or what
is attested). A peer's posted transcript is logged as an ordinary chat message —
display, not truth. If I also transcribed locally, I keep my own record.

(This is a later slice — the direct/relay loop comes first.)

## 8. Invariants

1. A being is reached only through a chat message a human could read — never a
   hidden RPC (I8). The YAML provenance keeps even bot↔bot legible.
2. Every spine decides **locally**. No central router, no origin resolution.
3. Addressing is `@being.node`; `node_name` is unique per machine ⇒ **exactly one
   responder**.
4. Asked ⇒ a definite answer (the being, or "no `<being>.<node>` here"). **Never
   silence.**
5. The mesh is **invite-only**; the guard is `allowed_users` + the gate +
   confinement + Beeper + block — **confinement, not crypto.**
6. Local truth is self-computed; a peer's artifact is **display unless attested.**
7. Loops bounded by the **stop-guard**; correlation by **native threading** — no
   minted `id`/`ttl`, no envelope bookkeeping.
8. Direct (shared-chat) is the default; **relay** records are only for beings off
   your stream, and only there does the YAML tail ride.

## 9. What the re-architecture removed

This design is mostly **subtraction** from the route-room model:

| Removed | Replaced by |
| --- | --- |
| dedicated **route Room** | shared chat = shared stream; owner answers in place |
| cryptic `[egpt-mesh:req:id:ttl:target]` tail | legible fenced YAML provenance (`from`/`by`) |
| minted request **`id`** + **`ttl`** | native chat threading + the stop-guard |
| outbound **dedup hack** | node-authoritative single responder + unique `node_name` |
| **grants / signing** as a built layer | invite-only + `allowed_users` + confinement; `sig:` reserved |
| central **resolver/router** at the origin | each spine decides locally |

Kept: the `@being.node` resolver (`src/mesh/names.mjs`), the transcript
discipline, the stop-guard, the emit gate / `allowed_users`, and the `type:
relay` sibling — now scoped to the genuine off-stream case.

## 10. Current state

Present: Room/limb abstraction, Beeper bridge (multi-network), Telegram bridge,
WhatsApp via Beeper/CDP, per-node runtime, `siblings` registry, emit gate,
per-chat transcription, stop-guard (C7.7), `@being.node` resolver.

Not yet built to this design: the uniform per-spine decide-and-answer loop over
shared chats (replacing the route-room dispatch), the YAML provenance tail (in
place of the bracket tag), `type: relay` forwarding with native-threading
surface-back, and the HRW shared-effects layer.

The empirical prerequisite — two spines on separate accounts sharing one chat
(`kg` on the main number, `do` on an alternate number, in one group) — is the
topology to build against.
