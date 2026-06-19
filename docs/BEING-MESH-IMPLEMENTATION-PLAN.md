# BEING-MESH IMPLEMENTATION PLAN — re-architecture

Status: **RE-ARCHITECTING (2026-06-19).** This replaces the route-room/envelope
plan. The shipped route-room relay (`src/mesh/relay.mjs` + the spine's
outbound/inbound mesh hooks) was scaffolding for a cross-machine hop that the
new model deletes. See `BEING-MESH.md` for the philosophy; this is the path to
get the code there.

## Principle: subtraction

The new mesh is *mostly less code*. A spine already receives, logs, validates,
and dispatches messages; the mesh is just **"answer my being when it's addressed
in a chat I'm in, and say so plainly when it isn't here."** We are removing a
router, a route Room, a machine envelope, and a dedup hack — and adding one small
legible provenance tail for the relay case.

What we are deleting (or demoting to the relay-only path):

- the dedicated **route Room** and its provisioning,
- the cryptic `[egpt-mesh:req:id:ttl:target]` tail,
- minted request **`id`** and **`ttl`** (loops → stop-guard; correlation →
  native threading),
- the **outbound dedup** added to compensate for double-dispatch,
- **grants / signing** as a built layer (reserved behind `sig:`).

What we keep: `src/mesh/names.mjs` (`@being.node` parse/resolve), the stop-guard
(C7.7), the transcript discipline, `allowed_users` / the emit gate, and the
`type: relay` sibling — re-scoped to genuinely off-stream beings.

## Prerequisite topology (build against something real)

Two spines, separate accounts, one shared chat:

- `kg` — REVE, the main number.
- `do` — DOLLY, an alternate number.
- Both Beepers in **one shared group** (the canonical multi-person case; the
  single-user/multi-device case is its degenerate form).

Do not build against the old `-5136707031` route group; that artefact retires
with the route Room.

## Slice A — the uniform loop (direct, in-place)

The whole architecture, proven. On **every** incoming message, the spine:

1. logs it (transcript — already done),
2. validates the sender (`allowed_users`),
3. parses any `@being.node` (or bare `@being`) via `src/mesh/names.mjs`,
4. **decides locally**: am I `node`, do I own `being`, am I in this chat?
   - **yes** → dispatch the local being, reply **in place** (the normal sibling
     dispatch path),
   - **I am `node` but lack the being** → reply `no <being>.<node> here`,
   - **not my node / not addressed** → ignore (observe + log only).

This is where we **flip the foreign branch**: today the spine, seeing a foreign
`@don.do`, *relays into the route Room*. New behaviour: a foreign mention is
**ignored** (the owning spine, which shares the chat, will answer) — unless a
`type: relay` record exists (Slice C).

Delete as part of this slice: the route-Room outbound relay for the direct case,
and the outbound dedup hack (the node-authoritative single-responder + unique
`node_name` make it unnecessary).

Acceptance (fake limb + two fake spines on one shared Room):

- `@don.do` → only the `do` spine dispatches `don`; it replies in the same Room.
- `@don.do` to a spine that is node `do` but has no `don` → replies "no don.do
  here".
- `@don.do @wren.kg` → `do` answers its mention, `kg` answers its mention,
  independently; neither drops the other.
- a non-owning spine ignores (logs, no reply, no relay).
- bare `@don` dispatches iff unambiguous; otherwise a clear "qualify it" reply.

## Slice B — the provenance tail

The legible carrier for any message that crosses spines. Human body first, `---`
divider, fenced YAML:

````text
hi @don.morgan

---
```
from: HFM
by: Andres
```
````

- `encode({from, by})` / `parseProvenance(text)` in `src/mesh/relay.mjs` (the
  module survives, gutted to this + the relay forward).
- **Only required keys** (`from`, `by`); `sig:` reserved, unused.
- **Tolerant parse:** match the trailing `key: value` block whether the ```
  fence arrives literal, re-rendered as a code-block entity, or stripped. Never
  require an exact fence.
- Strip the tail before the being sees the prompt; surface it to the being as
  context ("from Andres, in HFM"), not as part of the question.

Replaces `encodeMeshTail` / `parseMeshTail`. The bracket tag, `kind`, `id`,
`ttl`, and `target` all go.

Acceptance: round-trips `{from, by}`; parses when the fence is mangled; strips
cleanly from the prompt; ignores ordinary messages.

## Slice C — relay records (off-stream beings)

Only now does forwarding return — scoped to beings **not** on your stream.

```yaml
don:
  type: relay
  to: don.morgan
  via: { limb: beeper, chat: "<where morgan listens>" }
```

- The dispatcher recognises `type: relay`, does **not** spawn a brain, and
  re-posts `<body>` + the §B provenance tail into `via.chat`.
- `morgan`'s spine owns `don.morgan` (Slice A on its side) and answers there.
- The relaying spine watches `via.chat`, correlates the answer via the chat's
  **native reply threading** (it remembers the platform message-id it posted on
  behalf of which origin chat — no minted id), and surfaces the answer back to
  the origin chat as the being.
- If the relay target can't field it → it replies "no don.morgan here"; if the
  relayer holds no usable route → it says so. **Never silence.**

Acceptance (fake limbs): a relayed request reaches the off-stream spine, its
answer surfaces back to the origin chat correlated by native threading; a
relay-with-no-owner yields an explicit "not here", not silence.

## Slice D — shared effects (HRW), later

Unchanged in spirit from the prior plan, and a clean fit for "many spines, one
chat": local transcription is redundant-and-independent; the **visible** post is
elected by rendezvous hashing over present peers, debounced (≥60s after the last
voice note), threaded in order, with backup-after-grace, idempotent on the
message-id set. A peer's posted transcript is display, not truth — a being
ingests only what its own spine computed.

Acceptance: two fake spines on one Room elect one transcript owner; backup posts
after a primary miss; duplicate visible posts suppressed by the marker.

## Migration from the shipped route-room code

- `src/mesh/relay.mjs`: gut `createMeshRelay` (route-Room send/correlate/notice/
  dedup/timeout) down to provenance encode/parse + the Slice-C forward. The
  no-timeout/never-drop/thinking-notice logic was an origin-side patch for the
  route Room and largely disappears with it.
- `egpt-spine.mjs`: the **outbound** mesh hook flips from "foreign → relay into
  route Room" to "foreign → ignore unless a `type: relay` record exists"; the
  **inbound** route-Room hook is replaced by the uniform Slice-A decision (which
  already runs on every message).
- `src/mesh/names.mjs`: keep; it is the resolver.
- Config: drop `mesh.nodes.*.routes` (the route-Room registry) for direct peers;
  keep only `type: relay` records for off-stream beings. `node_name` stays the
  identity.
- Retire the `-5136707031` route group and the `mesh.notice_ms` / `reap_ms` /
  `dedup_ms` knobs.

## First PR (tiny)

Slice A only, against two fake spines sharing one fake Room:

- the uniform decide-and-answer hook (foreign → ignore; own → dispatch in place;
  my-node-but-missing → "not here"),
- deletion of the route-Room outbound relay + dedup for the direct case,
- the fake-Room two-spine test harness + tests.

No provenance tail, no relay record, no real bridge change. It proves the one
thing worth learning first: *a spine answers its being when addressed in a chat
it shares, and says "not here" plainly when it can't* — with no router in sight.
