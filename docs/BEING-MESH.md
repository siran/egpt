# BEING-MESH — a federated network of egpt beings over Telegram

Status: **DESIGN — spec only, no implementation yet.** Captures the An ↔ e7 design
session of 2026-06-18. Read alongside GENOME (I6, I8, the Telegram-channel
decision) and the emit-gate / transcription-service code.

## 0. What this is

A way for egpt beings living on **different spines** (different machines, possibly
different owners) to address and invoke one another by name, over a transport they
already share — Telegram (and any network a bridge exposes).

Each spine puts a bot on Telegram (`egpt_reve_bot`, `egpt_dolly_bot`,
`egpt_<node>_bot`). A `@handle` becomes a **location-transparent address**: `@don`
works identically whether Don is in the next room or on another continent. The
origin spine resolves the handle to the target's bot and relays; the target's home
spine picks it up and runs the being. No central server, no discovery service, no
custom transport — Telegram is the bus.

The whole thing is **visible by construction**: every cross-being message is a real
Telegram message a human can read, so egpt's "no invisible bot↔bot backchannel"
rule (GENOME I8 / C8.3) is not a constraint we enforce — it is how the transport
works.

Why federated, not centralized:
- **Location transparency** — the handle is the address; the bot is the resolver.
- **Zero infra** — Telegram already gives global reach, auth, presence, history,
  media, groups.
- **Decentralized** — each spine is autonomous; the network is just bots in shared
  chats. Add a machine → add a bot → it is on the mesh.
- **Humans and beings share one address space** — `an.reve` and `don.morgan` are
  the same kind of name.

## 1. Addressing: `<name>.<node>`

Everything — human or being — is named `<name>.<node>`. The **node is the
home/authority** that vouches for that name (like a domain in email).

- `don.morgan` → being `don` hosted on node `morgan`.
- `an.reve` → the human An, rooted at node `reve`.
- Bare `@don` → resolved in the **origin spine's local registry** (its own beings +
  gossiped peers). If ambiguous (two `don`s known), the surname is **required**.

**Resolution.** Split on the node. `don.morgan` → `registry[morgan].bot`
(= `egpt_morgan_bot`) → relay there → Morgan's spine resolves the bare `don`
against its OWN local beings. The surname is both the **disambiguator** (no handle
collisions) and the **router** (it names the bot to hit).

**Handles are origin-local; the wire carries the resolved identity.** `@don` means
`egpt_dolly_bot` *to REVE*; on a third spine it may be unknown or mean something
else. Resolution happens in the origin's registry, and the envelope ships the
resolved target — never the bare alias — so the mesh has no global-handle-collision
problem.

## 2. The relay envelope

`@don` on the wire is not a handle — it is an envelope carrying provenance. One
structure serves loop-prevention, authorization, and return-routing at once:

```yaml
to:     { being: don, node: morgan }   # RESOLVED target → egpt_morgan_bot
handle: don                            # as typed (display / logging only)
origin:
  who:  { kind: human|being, id: an.reve }          # provable, stable; never a display name
  chat: { spine: reve, id: "!6ljZ…", label: HFM }   # the RETURN ADDRESS
trace:  ["an.reve:HFM", "don.morgan"]  # hop chain
corr:   <uuid>                         # request ↔ reply correlation
prompt: "here?"
```

- **`trace`** → loop detection: drop if a hop would revisit, or if depth > N.
- **`origin.who`** → the auth subject: the target spine's gate decides "may this
  originator command me?" — keyed on the provable id, never the label.
- **`origin.chat`** → the return address: the reply rides `corr` back to
  `(reve, HFM)`.

Identity and provenance are the same field — the keystone: *"@don" is the handle
**and** its origin.*

## 3. The relay flow

```
@don in HFM (on REVE)
  → REVE resolves don → egpt_dolly_bot
  → REVE sends the prompt to egpt_dolly_bot via its Telegram bridge
  → DOLLY's spine picks it up (an inbound TG message to its own bot) → Don
  → Don replies → egpt_dolly_bot
  → REVE's Telegram bridge receives it, matches `corr`
  → REVE posts it into HFM as `🤝 don`
```

A new sibling **kind** — a `relay` (bot-proxy), not a local brain:

```yaml
don:
  type: relay
  to:   egpt_dolly_bot        # or the target node / chat
  body_emoji: 🤝
```

On `@don`, the dispatcher does NOT spawn a local brain; it emits the envelope to
`to` and awaits the correlated reply.

## 4. Registry & peering (gossip)

**Each spine owns its own registry** — `@handle → @bot → peer-spine`. There is no
central source of truth.

**Peering is mutual auto-config.** When two spines meet in a shared Telegram chat,
they exchange identities + beings:

> "I'm `reve`, my beings are `e`, `wren` via `egpt_reve_bot`" ↔
> "I'm `dolly`, `don` via `egpt_dolly_bot`."

Each adds the other. A new machine **teaches** its peers and **learns** from them.
The mesh is eventually-consistent via gossip, not a server.

## 5. Trust

Identity says **who**; the trust grant says **what they may do here**. They are
separate.

**Provable identity.** Humans = Telegram user id. Beings = bot username + node.
Never the display name (egpt I6, extended across nodes).

Two layers:
- **Peering** sets a baseline node↔node trust (the nodes exist and vouch for each
  other).
- **Grants** scope it per entity: e.g. `morgan` lets `an.reve` *ask* its `don`,
  where the grant carries **what** (which beings; ask-only vs tool-use vs spend),
  **how much** (rate), and **how long** (expiry). The grant rides egpt's existing
  per-being emit gate — the gate just also consults the cross-node grant.

Two hard edges, designed in from day one:
- **Attenuation on chains.** When `don.morgan` (acting for `an.reve`) pulls
  `wren.reve`, Wren sees `root = an.reve`, `via = don.morgan`, and grants the
  **weaker** of the chain — never more than the root could have asked directly.
  Stops privilege escalation by proxy.
- **Revocation + expiry.** Grants are time-boxed and droppable; a peer can be
  de-trusted. Without this, trust only accumulates — which is how meshes rot.

Once beings invoke beings **across owners**, the emit gate stops being spam-control
and becomes a **security boundary**.

## 6. Shared-effect coordination — exactly-once *visible* side-effects

When several spines sit in a common channel, they all observe the same events.
Anything **purely local** is fine to do redundantly; anything **visible in the
channel** must happen exactly once. Transcription is the first instance; the same
pattern covers link-unfurl, media-save, and eventually *which being replies* when
several share a room.

### Local vs shared
- **Local effect** (transcribe-for-myself, feed my own being): **every** spine does
  it, always, self-computed. No coordination.
- **Shared effect** (post the transcript to the channel, for the humans):
  **exactly-once** across spines.

### The protocol (no claim flag, no election traffic)

1. **Deterministic primary — HRW.** Each capable spine independently computes the
   same owner via rendezvous hashing:
   `owner = argmax_node hash(node_id, message_id)` over the **present, capable**
   spines. Same inputs → same answer everywhere → exactly one primary, nothing
   exchanged, no race. (HRW load-balances across messages and barely reshuffles
   when a peer joins/leaves.)
2. **Debounce-post.** Do not post until **≥ 60s after the last voice note** in a
   burst (each new voice resets the timer) — so a run of voice notes plays in a
   single tap. This window is so long it **doubles as the coordination window**,
   which is why no explicit claim flag (👂) is needed.
3. **Threaded, in order.** Each voice note's transcript is posted as a **quoted
   reply to that original message, in order** — not concatenated into one blob.
   The 60s rule governs *when* the batch starts posting, not *how* it is shaped.
4. **Failover.** Backups need no flag — they watch the channel: the transcript
   appears → stand down. If the primary is asleep (cf. deep-sleep), rank-`k` posts
   at `+ k·grace` (`grace` > channel propagation, a few seconds). HRW gives the
   ranking for free.
5. **Idempotent marker.** The post's dedup key is the **set of message-ids** it
   covers, **not the text** — different spines transcribe slightly differently, so
   never dedup on content.

### Trust invariant (the keystone)

**A being ingests only what it computed itself (or what is cryptographically
attested); a peer's posted artifact is *display*, never *truth*.**

- The **local** transcript feeds *my* being (self-computed → trusted).
- The **posted** transcript is a courtesy for the *humans* in the channel — no
  being ingests it as input.
- The peer's posted transcript still lands in the channel `transcript.md` **as any
  other message** (a faithful record of what the channel saw), **and** we
  separately log **our own local transcript**. Two records, possibly differing,
  both kept.
- Redundant compute across spines is not waste — it is the price of not trusting
  the mesh. Cheap insurance.

## 7. Invariants (load-bearing)

1. **Visible by construction** — cross-being traffic is real channel messages; no
   invisible bot↔bot backchannel (GENOME I8 / C8.3).
2. **Provable, stable identity — never the display name** (I6), across nodes.
3. **Self-computed truth; peer posts are display** — never ingest a peer's computed
   artifact as ground truth.
4. **Every relay carries a trace** — drop on revisit or depth > N.
5. **Trust is granted, graded, attenuating on chains, and revocable / expiring.**
6. **Handles resolve in the origin's registry; the wire carries the resolved
   identity.**
7. **Exactly-once for visible side-effects; redundant-and-independent for local
   ones.**

## 8. Current state vs. what this needs

Already present:
- Per-node bots + Telegram bridges (`egpt_reve_bot`, `egpt_dolly_bot`); a being's
  spine already picks up its own inbound bot messages.
- The `siblings` registry, the emit gate, the transcription-service per-chat
  verdict, the 👂 ack, the stable-id discipline.

Not built — the work this doc scopes:
- A `relay` sibling kind (bot-proxy). Today every sibling `type` resolves to a
  **local** brain (`chatgpt-cdp`, `claude-cdp`, `claude-code`, `codex`, `llama`).
  The old LAN agent endpoint that did cross-spine routing was removed in the
  2026-06-13 "Telegram-only" call; `agent_token` + the `agent` config block are
  leftovers.
- The `<name>.<node>` resolver + the relay envelope + `corr` correlation + the
  return path.
- The peering / gossip handshake + the per-spine registry of peers.
- The graded trust grants + attenuation + revocation.
- HRW shared-effect coordination + debounce / threaded posting + idempotent marker.
- Presence (which capable peers are live in a channel) — partially covered by
  heartbeats.

## 9. Open questions

- Peering/gossip wire format: a structured Telegram message in the shared chat, or
  a pinned/edited registry message both sides maintain?
- Grant authoring UX: how does an operator express "morgan trusts an.reve to ask
  don, ask-only, 20/min, 30 days"?
- Presence freshness: how stale can the HRW membership view be before failover
  misfires (double-post or no-post)?
- Correlation when the target being does NOT quote-reply: fall back to "next message
  from the bot within a window," or require quoting?
- Identity proof strength: is the Telegram user-id / bot-username enough, or do we
  want a per-node signing key so attestations are verifiable offline?
