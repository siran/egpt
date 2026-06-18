# BEING-MESH - federated eGPT beings over visible Rooms

Status: **DESIGN - spec only, no implementation yet.** Captures the An/e7
design session of 2026-06-18, revised after the Room/limb framing became
clearer.

Read alongside GENOME (I6, I8), the emit gate, the transcription-service code,
and the Room abstraction.

## 0. What This Is

Being Mesh lets eGPT beings on different spines address each other by name.

The transport is not the point. A spine can see Rooms through limbs:

- Beeper rooms
- Telegram bot chats
- WhatsApp rooms
- Signal rooms through Beeper
- Signal rooms through signal-cli
- future Gmail, Matrix, Slack, Discord, etc.

The actual primitive is:

```text
origin spine -> visible Room message -> target spine observes it -> local being runs
```

eGPT is the virtual bot. Platform bots are only one possible limb shape.

Telegram bot-to-bot is one option, not a dependency: Beeper already exposes
Telegram, Signal, WhatsApp, and other networks as rooms eGPT reads and writes.

The mesh has no central server. Each spine owns its local beings, identities,
trust decisions, and limbs. Peers learn about one another through shared Rooms
or configured registries.

## 1. Transport Model

Being Mesh is Room-visible, not bot-specific.

| Limb | Native Shape | Mesh Meaning |
| --- | --- | --- |
| Beeper | normalized multi-network rooms | preferred general limb |
| Telegram Bot API | bot account/chats | useful direct relay, bot-to-bot optional |
| Signal via Beeper | normal Signal account rooms | account-as-limb |
| Signal via signal-cli | linked/account client | fallback account-as-limb |
| WhatsApp via Beeper/CDP | normal account rooms | account-as-limb |
| Matrix/Slack/Discord | accounts/apps/bots | room/app-as-limb |

Requirement: the target spine must be able to observe a visible Room message
addressed to it, and the origin spine must have a return Room or correlation
path.

This keeps the mesh independent of each platform's bot semantics.

## 2. Addressing: `<name>.<node>`

Everything - human, being, or service - can be named `<name>.<node>`.

- `don.morgan` means being `don` hosted by node `morgan`.
- `an.reve` means human An as known by node `reve`.
- `@don` is origin-local shorthand. If two known peers expose `don`, the node is
  required.

The node is the authority for the local name. It is like the domain half of an
email address.

Handles are local conveniences; envelopes carry resolved identities. If REVE
resolves `@don` to `don.morgan`, the wire message carries `don.morgan`, not the
bare alias.

## 3. Relay Envelope

A mesh message is an envelope, not just a mention. The envelope provides routing,
authorization, correlation, and loop control.

```yaml
version: 1
kind: mesh.request
to:       { kind: being, id: don.morgan }
handle:   don
id:       "<uuid>"
origin:
  who:    { kind: human|being, id: an.reve }
  room:   { node: reve, id: "!6ljZ...", label: HFM }
via:
  node:   reve
  limb:   beeper
ttl:      2
prompt:   "here?"
```

Rules:

- `to` is resolved before sending.
- `origin.who` is the auth subject. It must be stable and provable enough for
  the limb, never a display name.
- `origin.room` is the return address.
- `id` is mandatory when quote/reply metadata is unavailable or when the request
  crosses a route Room.
- `ttl` is mandatory for routed relays. Decrement at each routed hop; drop at
  zero.
- Receivers keep a short-lived seen cache keyed by message id / request id /
  signature to stop loops and replay.

Replies use quote/reply metadata where available, otherwise the same request id:

```yaml
version: 1
kind: mesh.reply
to:       { kind: room, node: reve, id: "!6ljZ..." }
from:     { kind: being, id: don.morgan }
origin:   { kind: human|being, id: an.reve }
in_reply_to: "<uuid-or-room-message-id>"
body:     "yes, here"
```

### Envelope as a view, not a blob

Most of the envelope is already implicit in an ordinary Room message, so it is
never dumped as visible YAML (which would turn a chat into protocol noise):

- correlation   the quote-reply relationship (the reply quotes the request)
- `origin.who`  the message sender (provable by the limb)
- `origin.room` the room it was sent in
- `prompt`      the text

Only fields the limb cannot derive need an explicit machine tail or limb metadata:
usually `kind`, `version`, `id`, `ttl`, and a signature. The human sees
"@don.morgan here?" and Don's reply; the protocol rides the message's natural
structure. Correlation is trivial when quote-reply survives the limb.

There is no full path `trace` in v1. Loops are handled with `ttl` plus the seen
cache. Delegated authorization uses `root` / `via` provenance when needed, not a
complete hop list.

## 4. Relay Flow

Example: An is in HFM on REVE and invokes `@don.morgan`.

```text
HFM on REVE:
  An: @don.morgan here?

REVE:
  resolve don.morgan
  choose a limb and target Room visible to MORGAN
  send mesh.request with a request id, or rely on quote-reply if co-present

MORGAN:
  observes request in that Room
  validates identity, replay guard, ttl, and grant
  dispatches local being don
  sends mesh.reply quoting or referencing the request

REVE:
  matches the quote or request id
  posts Don's answer into HFM
```

Two cases hide in "a Room visible to MORGAN":

- Target co-present in the origin Room (Morgan is also in HFM): request and reply
  happen in HFM, visibly - no separate relay Room. The default; needs almost no
  machinery.
- Target not present: route via a Room both nodes share (a registry route), then
  carry the reply back to the origin Room. The harder path.

A local config entry should make this a sibling kind:

```yaml
don:
  type: relay
  to: don.morgan
  preferred_limb: beeper
```

The dispatcher does not spawn a local brain for `type: relay`; it emits an
envelope and awaits the correlated reply.

## 5. Registry And Peering

Each spine owns its own registry. There is no global source of truth.

Minimal registry shape:

```yaml
nodes:
  morgan:
    beings: [don]
    routes:
      - limb: beeper
        room_id: "<beeper-room-or-chat-id>"
      - limb: telegram
        username: egpt_morgan_bot
```

Peering can start manually. Gossip can come later.

When gossip exists, it should be visible and auditable:

```text
reve announces: node=reve beings=e,wren routes=...
morgan announces: node=morgan beings=don routes=...
```

No spine should blindly accept a gossiped peer as trusted. Discovery tells us
where a node claims to be; grants decide what it may do.

## 6. Trust

Identity says who. Grants say what they may do.

Stable identity is limb-specific:

- Telegram: user id, bot username/id, chat id.
- Beeper: stable network/account/chat/message identifiers exposed by the bridge.
- Signal: Signal account/contact/group identity as exposed by Beeper or
  signal-cli.
- WhatsApp: JID/lid/group id as exposed by the limb.

Never authorize on a display name.

Grant examples:

```yaml
grants:
  - subject: an.reve
    target: don.morgan
    verbs: [ask]
    rate: 20/min
    expires: 2026-07-18T00:00:00Z

  - subject: don.morgan
    target: wren.reve
    verbs: [ask]
    via_required: an.reve
    expires: 2026-06-25T00:00:00Z
```

Hard requirements:

- Grants are scoped.
- Grants expire.
- Grants can be revoked.
- Chains attenuate. If `don.morgan` invokes `wren.reve` on behalf of `an.reve`,
  Wren sees both `root=an.reve` and `via=don.morgan`, then applies the weakest
  grant in the chain.

Once beings invoke beings across spines, the emit gate is a security boundary,
not just spam control.

## 7. Shared Effects

When several spines observe the same Room, local work and visible work must be
separated.

Local effects:

- transcribe for my own being
- save my own media copy
- update my own local state

Every spine can do these independently.

Visible shared effects:

- post one transcript back to the Room
- post one link unfurl
- decide which being answers publicly when several could

These must happen exactly once.

Protocol for shared visible effects:

1. Compute a deterministic owner with rendezvous hashing:
   `owner = argmax_node hash(node_id, message_id)` over present capable peers.
2. Debounce bursts before posting. For voice notes, wait at least 60 seconds
   after the last note in a burst.
3. Post threaded/in-reply-to the original messages, in order.
4. Backups watch the Room. If the primary does not post, rank `k` posts after
   `k * grace`.
5. Dedup by message id set, not transcript text.

Trust invariant:

A being ingests only what its own spine computed, or what is cryptographically
attested. A peer's posted artifact is display, not truth.

So:

- My local transcript can feed my being.
- A peer's posted transcript is logged as a Room message.
- If I also transcribed locally, I keep that record too.

Redundant compute is acceptable. Trusting another spine's AI output silently is
not.

## 8. Invariants

1. A relay is a visible Room event or a logged limb event, not hidden process RPC.
2. eGPT is the virtual bot; platform bots are just limbs.
3. Bot-to-bot support is optional transport capability, not a mesh dependency.
4. Stable identity only; never authorize on display names.
5. The wire carries resolved identity, not only a local alias.
6. Every routed relay carries a correlation strategy, replay guard, and hop
   budget. A full path trace is not required.
7. Grants are scoped, expiring, revocable, and attenuating across chains.
8. Local truth is self-computed; peer output is display unless attested.
9. Visible shared effects are exactly-once; local effects are redundant and
   independent.

## 9. Current State

Already present:

- Room abstraction.
- Beeper bridge covering multiple networks.
- Telegram bridge.
- WhatsApp paths via Beeper/CDP.
- Per-node/spine runtime direction.
- `siblings` registry shape.
- emit gate.
- transcription-service per-chat verdicts.
- stable-id discipline in several limbs.

Partially present:

- Presence/heartbeat concepts.
- per-chat service decisions.
- file IPC and limb separation.

Not built:

- `type: relay` siblings.
- `<name>.<node>` resolver.
- mesh request/reply envelope.
- request id / quote-reply correlation and timeout/retry handling.
- route selection across limbs.
- peer registry/gossip.
- cross-node grants and attenuation.
- HRW ownership for shared visible effects.
- optional cryptographic node signatures.

## 10. First Implementation Slice

Do not start with gossip or grants.

Start with one narrow path:

1. Add `type: relay` sibling config.
2. Resolve `don.morgan` from a static registry.
3. Emit a `mesh.request` into a chosen Room via Beeper or Telegram.
4. Have the target spine recognize the envelope and dispatch a fake local
   handler.
5. Send `mesh.reply` quoting or referencing the request.
6. Origin posts the reply back into the original Room.
7. Add tests with fake limbs and fake Rooms.

This proves the architecture without depending on any platform-specific bot
feature.

## 11. Open Questions

- What is the minimal stable identity shape Beeper exposes for each network?
- What is the operator UX for grants?
- What is the timeout/retry policy for pending request ids?
- How fresh must presence be before HRW failover risks duplicate posts?
- Which peer artifacts deserve cryptographic attestation?
