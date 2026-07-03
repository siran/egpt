# EGPT-MESH-PROTOCOL — a transport protocol over chat

Status: **live** — `src/mesh/relay.mjs`. This is the wire format: the bytes a
relayed message is made of. Routing/topology design is `docs/BEING-MESH.md`; the
mesh law is [`GENOME.md`](GENOME.md) §11; the behavior list is
[`CONTRACTS.md`](CONTRACTS.md) §15.


## The analogy: TCP over Beeper

The mesh is a transport protocol running OVER a chat channel, the way TCP runs
over IP. Line up the pieces:

- **The wire** = a shared chat both spines watch. Whatever one posts, the other sees.
- **A segment** = one envelope: a base64 body + a plaintext provenance tail.
- **The header** = the tail's `key: value` lines (`to` = address, `mid` = sequence/dedup id, `re` = return address).
- **A router** = a relay agent: it reads `to`, forwards one hop toward that node, never terminates the packet itself.
- **Dedup / loop-control** = `mid`: a spine forwards a given `mid` at most once, so a packet reaches every reachable node ~once and self-terminates. No ttl, no ack storm.

A human reading the chat sees an ordinary, if oddly-encoded, message — never a
cryptic protocol frame. That is the point: bot↔bot traffic stays human-visible.


## The envelope

`encodeMesh(...)` produces exactly this — an outer fence, a base64 body, a `---`
divider, then the tail:

````text
```
<base64(utf8(body.trim()))>

---
from: HFM
from_node: kg
by: An
to: don.do
mid: mesh-kg-1719000000000-4f2a
post_id: $abc123
enc: b64
```
````

- **Fence** (` ``` `) keeps the structure delivered verbatim.
- **Body** is base64 — markdown-inert (no backticks / `---` / `<>`), so a code-bearing reply can't collide with the fence and the transport can't mangle it. `enc: b64` marks it; untagged ⇒ legacy raw.
- **Tail** is a run of `key: value` lines; empty keys are omitted.


## The keys

| key | meaning |
|---|---|
| `from` | origin chat label (e.g. `HFM`) |
| `from_node` | origin node — lets the responder build the return address `re: <from>.<from_node>` |
| `by` | sender — a human (`An`) or a being (`don.do`) |
| `to` | target `being.node` — only that node answers (or says "no `<being>.<node>` here"); every other spine stays quiet. Empty ⇒ open-channel (the owner of `@being` answers) |
| `re` | return address (e.g. `HFM.kg`) — the reply echoes it so the origin surfaces it home, correlated without a minted id |
| `post_id` | the origin placeholder's msgId — echoed in every reply frame so the origin edits the right message as the reply streams |
| `mid` | request id minted at the origin, preserved across forwards — a spine forwards a given `mid` at most ONCE (loop-safe, self-terminating, no ttl) |
| `done` | `true` on the FINAL frame — a display finish marker (origin appends "✅ Done"), not a teardown; non-`done` frames keep flowing |
| `enc` | body codec; `b64` ⇒ base64 |
| `sig` | **reserved** — parsed, never emitted; the slot for per-hop signing where a hop crosses *people* |


## Example 1 — a request: An asks @don from the HFM chat

Operator types `hi @don` in the HFM chat on node `kg`. The local spine owns no
`don`, so it relays into the channel where `do` listens:

````text
```
aGkgQGRvbg==

---
from: HFM
from_node: kg
by: An
to: don.do
mid: mesh-kg-1719000000000-4f2a
post_id: $abc123
enc: b64
```
````

`aGkgQGRvbg==` decodes to `hi @don`. The origin first posts a `🤔 thinking…`
placeholder (its msgId becomes `post_id`), so the streamed reply edits that one
message in place.


## Example 2 — the reply mirrors home

Node `do` owns `don`, runs the turn, and edit-streams ONE relay-room message
wrapped in the tail (`by: don.do`, `re: HFM.kg`, the same `mid` + `post_id`). The
final frame carries `done: true`:

````text
```
<base64("🐶 on it — patch pushed")>

---
by: don.do
re: HFM.kg
mid: mesh-kg-1719000000000-4f2a
post_id: $abc123
done: true
enc: b64
```
````

The origin sees `re: HFM.kg`, matches it to the awaiting `$abc123` placeholder,
and mirrors each edit onto it. `parseMesh` scans UP from the end for the trailing
run of known keys, tolerant of a bridge that re-renders the fence as HTML or
strips the divider — so the origin always recognises the reply (and never
re-relays it).


## Example 3 — one hop through a relay-record (`@don` chains to `don.do`)

A node can carry `don` as a *relay-record* — a local name that re-resolves to
another node's being. On seeing `to: don.<self>`, the spine finds `don` is a
relay-record (`resolveBeingRelay`), rewrites `to:` to the mapped `don.do`, and
forwards toward it via its configured route (`resolveRoute`). The rewrite reuses
the same `mid`, so forward-once still guards the chain:

````text
… to: don.do          # was don.<self>; the relay-record rewrote it, mid unchanged
````

The reply returns hop by hop: a node that *forwarded* a request re-mirrors the
matching `mid` back into the channel, so the upstream hop sees a **different**
node's copy — which is what gets a `kg → do → kg` bounce home past a node's own
edit-suppression. N hops chain across as few as two machines.


## Semantics, in one breath

- **Multi-hop transit, loop-safe** — `to` picks the answering node; a spine that isn't it forwards one hop toward it; forward-once per `mid` terminates the flood.
- **Streaming living-mirror** — the responder edit-streams one message; origin and transit nodes mirror the edits onto their own copies; `done: true` finalizes.
- **Consume, never re-relay** — recognising our own provenance tail is what stops infinite re-relay.
- **Circuit breaker** — a hard mesh-local cap on sends per channel per window, the fail-safe the prompt-path loop-guard can't provide (mesh posts AS the operator, so the guard never sees it).


## Not built yet

- **Origin-side relay-records** — today the origin only relays an explicit foreign `@being.node`; chaining from a bare local relay-record name is transit-only.
- **Reaction relaying** — a reaction is an edit; relaying one back to the model that produced it rides the same return path (design, not built).
- **Reserved:** explicit `path:` breadcrumb routing, multipath (`mid` dedups, a future `seq` reorders), per-hop `sig`, `"who has X?"` flood-discovery — all build on the same `mid` forward-once primitive.


## Source of truth

`src/mesh/relay.mjs` — `encodeMesh({ by, body, from, from_node, to, re, post_id, mid, done })`,
`parseMesh(text)`, `createMeshRelay(...)`. When the format changes, amend this file
+ the CONTRACTS §15 lines + `tests/mesh-relay.test.mjs`.
