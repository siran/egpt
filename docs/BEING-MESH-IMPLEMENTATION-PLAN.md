# BEING-MESH IMPLEMENTATION PLAN

Status: **PLAN - not implemented yet.**

This distills `docs/BEING-MESH.md` into implementation slices. The goal is to
prove mesh relay over visible Rooms without depending on platform-specific bot
features.

## Decisions

- eGPT is the virtual bot. Platform bots/accounts are limbs.
- Beeper is the preferred first limb because it exposes many networks as Rooms.
- Signal does not need a bot model. Use Signal through Beeper first; fall back to
  signal-cli as account-as-limb.
- No full path trace in v1. Use request ids, quote/reply correlation, replay
  caches, and hop budget.
- Sign canonical payloads, not rendered chat formatting.
- UTF text can be signed. Normalize text to NFC, encode canonical JSON as UTF-8,
  and sign those bytes.

## 0. Vocabulary And Boundaries

Define these concepts before touching dispatch:

- `NodeId`: local spine name, e.g. `reve`, `morgan`.
- `BeingId`: fully-qualified name, e.g. `don.morgan`.
- `RoomAddress`: `{ limb, roomId, label? }`.
- `RoomMessage`: normalized inbound message from any limb.
- `RoomReplyRef`: stable reference to a message if the limb provides one.
- `RoomCapabilities`: stable ids, quote/reply support, hidden metadata support,
  edit support, media support.
- `MeshRequest`: derived view over a Room message.
- `MeshReply`: derived view over a reply Room message.

Acceptance:

- Pure unit tests for name parsing, fully-qualified ids, and address validation.
- No bridge/network dependency.

## 1. Room Capability Surface

Add a small capability layer above limbs. It should not replace existing bridges;
it should describe what each bridge can prove or preserve.

Minimum shape:

```js
{
  limb: 'beeper',
  stableMessageId: true,
  quoteReply: true,
  hiddenMetadata: false,
  senderStableId: true,
}
```

First targets:

- fake limb for tests
- Beeper
- Telegram bridge

Acceptance:

- Fake limb can send, receive, quote-reply, and expose stable ids.
- Beeper and Telegram adapters report conservative capabilities.
- Tests prove fallback when quote-reply is unavailable.

## 2. Mesh Envelope View

Implement envelope construction/parsing as a view over Room messages.

Co-present case:

- Human writes `@don.morgan here?`.
- Target spine observes the same Room.
- The Room message itself supplies sender, room, text, and message id.
- Reply quotes the request when the limb supports quote/reply.

Routed case:

- Origin sends to a route Room shared with the target node.
- Message must carry return address and request id because the route Room is not
  the origin Room.

V1 request fields:

```yaml
kind: mesh.request
version: 1
id: "<uuid>"
to: "don.morgan"
from: "an.reve"
origin_room: { node: reve, limb: beeper, room_id: "<id>" }
ttl: 2
body: "here?"
```

V1 reply fields:

```yaml
kind: mesh.reply
version: 1
in_reply_to: "<request-id-or-room-message-id>"
from: "don.morgan"
to_room: { node: reve, limb: beeper, room_id: "<id>" }
body: "yes, here"
```

Do not require a full trace.

Loop/replay controls:

- `ttl` for routed relays.
- seen cache keyed by `{limb, roomId, messageId}` when available.
- seen cache keyed by `request.id` when message ids are unavailable.
- seen cache keyed by signature as a last resort.

Acceptance:

- Parser recognizes `@name.node` and derives a request from a fake RoomMessage.
- Routed request serialization includes return address.
- Replay cache drops repeated request ids.
- TTL decrement/drop is covered by tests.

## 3. Machine Tail And Metadata

Prefer limb metadata if available, but assume most messaging apps do not preserve
arbitrary hidden metadata.

V1 should support two encodings:

1. **Derived-only:** no visible tail. Used when target is co-present and the limb
   provides stable sender/message/reply data.
2. **Compact tail:** a short visible final line for routed or signed relays.

Example tail:

```text
@don.morgan here?

[egpt-mesh:v1:<base64url-json>:<base64url-sig>]
```

The human-visible body is still the first part. The tail is machine-readable and
can be hidden later for limbs that support metadata.

Do not use invisible Unicode control characters in v1. Many clients strip,
normalize, or copy them unpredictably.

Acceptance:

- Tail parser ignores ordinary messages.
- Tail parser rejects malformed base64/json.
- Tail can round-trip UTF text.
- Human body extraction removes the tail before dispatching to a being.

## 4. Signing

Signatures answer: "did this machine envelope come from a trusted node, and was it
tampered with?"

They do not replace limb identity. Human-authored co-present messages can rely on
the limb sender identity and grants. Machine-routed messages should be signed.

Use asymmetric node signatures for mesh. HMAC is fine for local/internal bus
events, but cross-owner mesh should not require sharing a secret with every peer.

Canonical payload rules:

- Remove `sig` before signing.
- Sort object keys recursively.
- Normalize all strings to Unicode NFC.
- JSON stringify the canonical object.
- Encode with UTF-8.
- Sign the bytes.
- Store signatures as base64url.

UTF characters can be signed safely under this rule. Emojis, accents, CJK, and
mixed-language text are just UTF-8 bytes after normalization.

Implementation targets:

- `src/mesh/signing.mjs`
- `canonicalizeMeshPayload(value)`
- `signMeshPayload(payload, privateKey)`
- `verifyMeshPayload(payload, publicKey)`

Key model:

- node has a private signing key
- registry stores peer public keys
- signed payload carries `node`, `key_id`, `sig_v`, `sig`

Acceptance:

- UTF payloads sign/verify after JSON round-trip.
- Tampered text fails verification.
- Added/removed keys fail verification.
- Different key fails verification.
- Signature tail round-trips through fake limb text.

## 5. Static Registry And Resolver

Start with static config. No gossip yet.

Example:

```yaml
mesh:
  node: reve
  keys:
    active: reve-2026-06
  nodes:
    morgan:
      public_keys:
        morgan-2026-06: "<public-key>"
      beings: [don]
      routes:
        - limb: beeper
          room_id: "<route-room>"
```

Resolver behavior:

- `don.morgan` resolves directly.
- bare `don` resolves only if unambiguous.
- local beings resolve before peers unless explicitly qualified.
- ambiguous bare names return a clear error.

Acceptance:

- Unit tests for direct, bare, local, ambiguous, missing, and malformed names.

## 6. Relay Sibling Type

Add `type: relay` sibling handling.

Example:

```yaml
siblings:
  don:
    type: relay
    to: don.morgan
    preferred_limb: beeper
```

Dispatch behavior:

- A relay sibling does not start a local brain.
- It resolves `to`.
- It chooses a route.
- It sends a mesh request through a Room-capable limb.
- It records pending request state if the reply will return asynchronously.
- It times out visibly.

Acceptance:

- Fake dispatch of `@don` emits one mesh request.
- Timeout emits a clear system message.
- Unsupported route/capability reports a clear error.
- No real Beeper/Telegram/network in tests.

## 7. Target-Side Receiver

Target-side receiver converts inbound Room messages into local dispatches.

Steps:

1. Ignore messages without mesh addressing/tail.
2. Parse request.
3. Drop if replayed.
4. Drop if ttl expired.
5. Verify signature when present/required.
6. Resolve target local being.
7. Check grant.
8. Dispatch local being or fake handler in first slice.
9. Reply by quote when possible, otherwise by request id.

Acceptance:

- Fake Room request to `don.morgan` dispatches fake Don.
- Wrong target is ignored.
- Replay is ignored.
- Missing required signature is rejected for routed machine messages.
- Unauthorized origin is rejected visibly or logged according to gate policy.

## 8. Reply Correlation

Correlation should prefer Room-native structure.

Priority:

1. quote/reply ref points to original request
2. explicit `in_reply_to` request id in tail/metadata
3. short pending window fallback only for manual testing

Avoid "next message from peer" as a core protocol. It is too easy to misattribute
in busy rooms.

Acceptance:

- Quote reply resolves pending request.
- Explicit `in_reply_to` resolves pending request without quote support.
- Unknown reply id is logged and ignored.
- Duplicate reply is ignored.

## 9. Grants And Attenuation

Do this after a fake end-to-end relay works.

Grant input:

- root subject: original human/being identity
- via subject: relay node/being if delegated
- target: local being
- verb: `ask` initially
- expiry/rate

No full path trace is required. For attenuation, retain only the identities that
matter:

- `root`: who ultimately asked
- `via`: who is relaying or delegating
- optional `delegation_id` if we later need signed delegation chains

Acceptance:

- Allowed root can ask target.
- Denied root is blocked.
- Expired grant is blocked.
- Via cannot escalate beyond root grant.
- Rate limit is enforced.

## 10. Beeper First End-To-End Harness

After fake limbs pass, add a Beeper-shaped harness without contacting real
Beeper:

- fake Beeper room ids
- fake sender ids
- fake quote/reply metadata
- fake room send API

Acceptance:

- REVE fake Beeper room -> MORGAN fake receiver -> fake Don -> REVE reply.
- UTF body survives the full route.
- Signature verifies over the routed payload.

## 11. Native Telegram And Signal Paths

Only after Beeper-shaped relay works:

- Telegram Bot API can use bot chats and bot-to-bot where convenient.
- Signal should be account-as-limb through Beeper first.
- signal-cli fallback should be a limb adapter, not special mesh logic.

Acceptance:

- The mesh core does not import Telegram or Signal modules directly.
- Native adapters conform to the Room capability interface.

## 12. Shared Visible Effects

Defer until basic relay is stable.

Implement:

- present capable peer set
- rendezvous hash owner selection
- debounce window
- backup failover
- idempotent visible post marker

Acceptance:

- Two fake spines observing one Room choose one owner for a transcript post.
- Backup posts after primary miss.
- Duplicate visible posts are suppressed by message-id-set marker.

## Suggested Order

1. `src/mesh/names.mjs`
2. `src/mesh/envelope.mjs`
3. `src/mesh/signing.mjs`
4. `src/mesh/registry.mjs`
5. fake Room limb test harness
6. relay sibling send path
7. target receiver with fake local handler
8. reply correlation
9. static grants
10. Beeper-shaped harness
11. real Beeper adapter
12. HRW shared effects

## First PR Scope

Keep the first implementation PR small:

- names
- envelope view
- signing canonicalization
- fake Room harness
- static resolver
- no real bridge changes
- no gossip
- no grants beyond stubs

This gives a testable base before wiring into dispatch.
