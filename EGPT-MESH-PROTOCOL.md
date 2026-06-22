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
| `sig` | **reserved** — parsed but never emitted; the slot where cross-*person* origin-signing would plug in later. Off until trust crosses people |

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

## Not yet

- **Live transit** is proven by unit tests (`kg→do→mo`); the running mesh is 2
  nodes (REVE↔DOLLY = direct hop), so transit hasn't been exercised live yet.
- **`sig`** cross-person origin-signing (reserved above) — NOT in the code.
- **"who has xxx?" flood-discovery** — builds on the same `mid` forward-once.

## Source of truth

`src/mesh/relay.mjs` — `encodeMesh({ from, from_node, by, to, re, post_id, mid, done })`,
`parseMesh(text)`, `createMeshRelay(...)` (transit: `forwardToward` + `openRelayStream`).
