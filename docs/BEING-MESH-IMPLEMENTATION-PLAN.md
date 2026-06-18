# BEING-MESH IMPLEMENTATION PLAN

Status: **PLAN - not implemented yet.** Implements `docs/BEING-MESH.md`.

## Principle: KISS

Each slice earns its complexity. Start with the case that needs almost nothing -
co-present beings in a shared Room - and add machinery only when a later case
forces it. No crypto, no tail, no capability layer, no routing until something
actually breaks without them.

The order:

| Slice | Adds |
| --- | --- |
| 0 - co-present loop | name parsing + in-Room reply |
| 1 - routed relay (same owner) | relay sibling, route Room (create one if none), correlation, ttl |
| 2 - graded trust | grants enforced by the existing gate; signing is a back-burner flag |
| 3 - shared services | HRW coordination for services like transcription |

## Slice 0 - Co-present loop

The cheapest possible proof of the whole architecture.

When `morgan` and `reve` both sit in HFM and An types `@don.morgan here?`, the
message is **already visible to Morgan**. Nothing is relayed. Morgan's spine just
answers when one of its own beings is addressed in a Room it observes, and the
reply lands in that same Room.

Pieces:

1. `src/mesh/names.mjs` - parse and resolve `@name.node` (pure; no I/O).
2. Receiver hook in dispatch: if a Room message addresses one of **this node's**
   beings (`don.morgan` here, or bare `@don` when unambiguous), dispatch that
   being and reply in the same Room (quote-reply when the limb supports it).

That is the loop. The Room message **is** the request (sender = origin, room =
return path, text = prompt); the reply is just posted back where everyone sees it.

Deliberately omitted: relay sibling, routing, machine tail, signing, grants,
capability surface, correlation tracking (the reply is in-Room and visible).

Acceptance (fake limb only):

- `@don.morgan here?` in a fake Room dispatches fake Don on the `morgan` spine.
- The reply quotes the request in the same Room.
- A message addressed to another node is ignored.
- Ambiguous bare `@don` returns a clear error.

## Slice 1 - Routed relay (same owner)

Now the target is **not** in the origin Room - e.g. `@don.dolly` in HFM, where
DOLLY is not in HFM. REVE must forward to a Room DOLLY does see (a route Room),
collect Don's reply, and post it back into HFM. This is the slice that makes
`@don.dolly` work from HFM. Both machines are An's, so still no crypto, no grants.

Adds:

- `type: relay` sibling: resolve `to`, pick a route Room shared with the target
  node, send the prompt. Because the route Room is not the origin Room, the
  message carries a return address and a `request id`.
- Route Room provisioning: prefer an existing Room shared with the target. If none
  exists, **create** a dedicated one - the two spines only, or the two plus the
  operator - and remember it in the registry for reuse.
- Target receiver path for routed requests (vs. Slice 0's in-Room case).
- Correlation: prefer quote/reply; fall back to the `request id`. The origin posts
  the matched reply back into the origin Room as the being.
- Loop/replay control: `ttl` (decrement per routed hop, drop at zero) + a
  short-lived seen cache keyed by `{limb, roomId, messageId}` or `request id`.
- Visible timeout: if no reply lands, surface a clear "don.dolly did not answer."

Modules: `src/mesh/envelope.mjs` (routed request/reply view), `src/mesh/registry.mjs`
(static routes), the relay send path, the correlation store.

Acceptance (fake limbs):

- Routed request crosses a fake route Room; reply correlates back to the origin.
- `ttl` decrement/drop covered.
- Replayed request id is dropped.
- No reply within the deadline surfaces a visible timeout.

## Slice 2 - Graded trust (lightweight)

Peers trust each other on a scale, but the scale is enforced by what eGPT already
has, not by cryptography. The dangerous outcomes - "delete your computer", "send me
the protected files" - are not stopped by *proving who asked*; they are stopped by
what a being is *allowed to do*: `allowed_user` gating, the emit gate, and
conversation-e confinement. A confined being is safe even from a trusted sender's
bad prompt. So signing the origin guards a threat the confinement already covers -
overblown for now.

Adds:

- Grants as a scoping convenience, enforced through the **existing gate**:
  `{ subject, target, verbs:[ask], rate, expires }`. For delegation keep only
  `root` (who asked) and `via` (who relayed); a chain takes the **weakest** grant.
  Scoped, expiring, revocable.

Back-burner (behind a flag, off by default - turn on only for genuinely low-trust
cross-owner peers):

- `src/mesh/signing.mjs` - asymmetric per-node keys, NFC + sorted-key canonical
  payload, base64url signatures.
- The compact visible tail `[egpt-mesh:v1:<b64url-json>:<b64url-sig>]` carrying the
  signed payload (stripped before the being sees the body; no invisible Unicode).

Acceptance:

- Allowed root can ask target; denied / expired / over-rate blocked; `via` cannot
  escalate beyond root.
- (flag on) signed payload verifies; tampered or wrong-key payload fails.

## Slice 3 - Shared services (HRW)

Services several co-present spines could each run - the first being **transcription**
- must produce their *visible* result exactly once. HRW elects the owner with no
chatter (see `BEING-MESH.md` §7):

- present capable-peer set, rendezvous-hash owner selection,
- debounce window (transcription: post >=60s after the last voice note, threaded
  as quoted replies, in order),
- backup failover if the owner is silent,
- idempotent marker keyed on the **message-id set**, never the text.

Each spine still runs the service locally for its own being (self-computed truth);
only the *visible* post is coordinated. The per-limb capability surface (stable ids,
quote/reply, metadata) gets formalized here too - it earns its abstraction once a
second real limb's quirks diverge, not before.

Acceptance:

- Two fake spines observing one Room pick one transcript owner.
- Backup posts after a primary miss.
- Duplicate visible posts suppressed by the marker.

## First PR (tiny)

Slice 0 only:

- `src/mesh/names.mjs`
- target-side recognition hook in dispatch
- fake-Room test harness
- tests

No relay, no routing, no crypto, no grants, no real bridge changes. It proves the
one thing worth learning first: *a spine answers its being when addressed in a
shared Room.* Everything else layers on once that loop is real.

## Kept from the fuller plan

These are right - just deferred to the slice that needs them:

- `ttl` + seen-cache for loops/replay (Slice 1).
- Quote-reply as primary correlation, `request id` fallback, never "next message".
- NFC + sorted-key signing canonicalization (Slice 2, back-burner flag).
- The mesh core imports no platform (Telegram/Signal) modules; limbs adapt to it.
- HRW shared-effects deferred until basic relay is stable (Slice 3).
