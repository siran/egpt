# EGPT-MESH-PROTOCOL — the cross-spine relay wire format

Status: **live** — `src/mesh/relay.mjs` (`encodeMesh` / `parseMesh` /
`createMeshRelay`; streaming living-mirror, 2026-06-21).

This is the concrete **wire format** — the bytes a relayed message is made of.
Companion docs: [`docs/BEING-MESH.md`](docs/BEING-MESH.md) is the *routing /
topology design* (decentralised, `@being.node`, direct-vs-relay, invite-only);
[`GENOME.md`](GENOME.md) §11 is the mesh law; [`CONTRACTS.md`](CONTRACTS.md)
C8.4/C8.5 is the behavior list. When this format changes, amend THIS file + the
C8.5 contract + a round-trip test.

## What it is

A relayed message is an **ordinary, visible chat message**. The only machine bit
is a **trailing, human-readable provenance tail**; the human body rides as a
base64 block above it. A human — and any spine watching — can always read where a
message came from and who sent it. No cryptic tags, no minted ids, no ttl.

## Envelope

````text
```
<base64(body)>

---
from: HFM
from_node: kg
by: An
to: do
re: HFM.kg
mid: mesh-kg-<stamp>-<nonce>
post_id: <origin placeholder msgId>
done: true
enc: b64
```
````

- Outer **fence** (` ``` `) keeps the structure delivered verbatim.
- **Body** = `base64(utf8(body.trim()))`, then a blank line, then a `---`
  divider, then the tail.
- **Tail** = a run of `key: value` lines; empty keys are omitted.

## Keys

Protocol keys: `from`, `from_node`, `by`, `to`, `re`, `post_id`, `mid`, `done`,
`enc`, `sig` (reserved).

| key | meaning |
|---|---|
| `from` | origin chat label (e.g. `HFM`) |
| `from_node` | origin node — lets the responder build the return address `re: ${from}.${from_node}` |
| `by` | sender (a human, or `being.node`) |
| `to` | target **node** — only that node answers (or says "no `<being>.<node>` here"); every other spine stays quiet |
| `re` | return address (e.g. `HFM.kg`) — the reply echoes it so the relaying spine surfaces it home, correlated without a minted id |
| `post_id` | the origin placeholder's msgId — echoed in every reply frame so the origin edits the right message as the mirrored reply streams |
| `mid` | minted request id (origin), preserved across forwards — a spine forwards a given `mid` at most ONCE, so multi-hop transit is loop-safe and self-terminating (no ttl) |
| `done` | `true` on the FINAL frame — a display finish marker (origin appends "✅ Done"), NOT a teardown; non-`done` frames keep flowing |
| `enc` | body codec; `b64` ⇒ base64 (current). Untagged ⇒ legacy raw |
| `sig` | **reserved** — parsed but never emitted; the slot for **per-hop** signing where a hop crosses *people* (see Status & reserved). Off for now |

## Why base64

Beeper renders ` ``` ` → `<pre><code>`, and a code-bearing reply (a being that
writes code) collides with the fence → the mirror edit breaks. base64 is
markdown-inert (no backticks / `---` / `<>`) so the body is delivered verbatim
while the tail stays readable. Bonus: the body is opaque in the relay channel — a
light privacy gain.

## Parsing (tolerant)

A bridge may re-render the message as HTML or strip the fence, so `parseMesh`:

1. strips HTML/markup (`stripRender`),
2. scans **up from the end**, taking the trailing run of `key: value` lines whose
   key is recognised (tolerant of leading `> * _ ~ \` -` and whitespace),
3. takes everything above as the body, trimming fence/divider/blank edges,
4. if `enc: b64`, base64-decodes the body.

A message that carries a provenance block **is relay traffic** ⇒ consume it.
Recognising our own tail (divider or not) is what stops infinite re-relay.

## Semantics (today)

- **Multi-hop transit, loop-safe.** `to` picks the answering node; a spine that
  isn't it forwards the message one hop toward it (`resolveRoute`), and the reply
  comes back hop by hop. Loop-safety is structural: a spine forwards a given `mid`
  **at most once**, so the message reaches every reachable node ~once and
  self-terminates — no ttl. `from_node` builds the return route; the reply echoes
  `re:`.
- **Streaming living-mirror, chained.** The responder edit-streams ONE message;
  each edit is an atomic, rate-free event. The origin mirrors edits onto its
  `post_id` placeholder; a **transit** node re-mirrors — it edits its own
  forwarded copy as the upstream streams, chaining the stream one hop on. `done:
  true` finalizes. Only the FIRST forward of a message is loop-guarded; the edits
  that follow can't loop.

## Relay-records & N-hop chaining

A **relay-record** is a *local* being that isn't run — it re-resolves to another
node's being and forwards there. Configured per node:
`mesh.relay_records[<being>] = "<being>.<node>"`. The trick is the `to:` field —
each relay rewrites `to:` to the *next* hop's target, so one message chains across
as many hops as there are relay-records: **N hops on as few as two machines** (it
can bounce `kg→do→kg→…`).

- **Transit** *(built)* — a spine that owns `to:`'s node but finds the being is a
  local relay-record (`resolveBeingRelay`) rewrites `to:` to the mapped
  `being.node` and forwards via its configured route (`resolveRoute`); loop-safe
  via the same `mid` (forward-once).
- **Terminal** *(built)* — the being is a *real* local sibling → run it → reply.
- **Origin** *(design — not built)* — today the origin only relays an explicit
  foreign `@being.node`. To chain from a bare `@wren2` (a local relay-record), the
  origin must resolve relay-records too and post `to: don.do` (the record's target).

**Return path *(built — mid-linked)*.** A node that *forwarded* a request
re-mirrors the reply (matched by the same `mid`) back into the channel — so the
upstream hop / origin sees a **different** node's copy. That's exactly what gets a
2-box `kg→do→kg` bounce home past a node mirroring its **own** edit (edit
suppression). Loop-safe: each node re-mirrors a given `mid` once. *(An explicit
`path:` breadcrumb — `don.do`, `wren.kg` — for precise/branching routing is
reserved; the mid-linked retrace already covers linear chains.)*

## Reactions *(design — not built)*

A **reaction is an edit** to the message. A reaction on a *relayed* reply must be
relayed **back to the model** that produced it — it rides the return `path:` like
any other edit and surfaces to the being as a stage-direction
(`[ … reacted 👍 to … ]`, CONTRACTS C7.8), so the being can answer it.

## Status & reserved

- **Built + unit-tested:** the wire format, transit forward (`forwardToward`,
  forward-once per `mid`), transit relay-records, the streaming edit-mirror, and
  the **reply return-via-forwarder** (a forwarder re-mirrors the reply, mid-linked).
  N-hop is proven by `tests/mesh-relay.test.mjs`.
- **Design (not built):** origin-side relay-records, reaction relaying.
- **Reserved / future:**
  - *Explicit `path:` routing* — a `don.do,wren.kg` breadcrumb for precise/branching
    return paths (the mid-linked retrace already covers linear chains).
  - *Multi-relay / multipath* — the same packet MAY route through multiple channels
    or relay routes at once; `mid` dedups, forward-once stops loops, a future `seq`
    reorders. The protocol allows it; it isn't wired.
  - *Per-hop `sig`* — one signature per hop (each relay signs what it adds), for
    hops that cross *people* (not every hop — a signature is fixed-size regardless
    of the tiny hop it signs). NOT built; reserved.
  - *"who has xxx?" flood-discovery* — builds on the same `mid` forward-once.

## Source of truth

`src/mesh/relay.mjs` — `encodeMesh({ from, from_node, by, to, re, post_id, mid, done })`,
`parseMesh(text)`, `createMeshRelay(...)` (transit: `forwardToward` + `openRelayStream`).
