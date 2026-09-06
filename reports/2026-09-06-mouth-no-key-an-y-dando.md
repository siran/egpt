# The mouth fell back in "An y Dando" — and the guard that refused it was right

**Reported:** operator, 2026-09-06, over WhatsApp — *"en la conversación 'An y Dando'
Rodz está presente, sin embargo ken respondió desde mi cuenta... en lugar de responder
desde rodz."*
**Node:** kg (reve). **Diagnosed against the LIVE Beeper API**, not from the code alone.
**Status:** root cause CONFIRMED. Fix proposed, not applied.

## Summary

King Ken answered in `An y Dando` from An's own account instead of through Rodz. The
peer-mouth link did not fail — it **refused**, deliberately, and its refusal was correct.
The chat cannot be keyed across the two accounts because after the required exclusions
only ONE identity survives, and `crossAccountChatKey` (`61d1fde`) refuses any key smaller
than two.

The hazard that floor exists to prevent is **live on this exact pair**: `An y Dando` and
the 1:1 `Dando` reduce to the same key. Lowering the threshold would post group replies
into a private chat.

## Evidence

`peer_spine.accounts` — the identities both ends exclude so two views of one chat key
alike (`config.yaml:376`):

```yaml
peer_spine:
  accounts: [ "+16468217865", "+13472576794" ]   # An, Rodz
```

Live rosters, read from the Beeper API on 127.0.0.1:23373:

| chat | id | type | participants |
|---|---|---|---|
| `An y Dando` | `!JwvpZvGK8H8DLDuPa89w` | **group** | Dando `+34658515045`, Rodz `+13472576794`, self (no phone, `isSelf`) |
| `Dando` | `!Tm8oSKev1bfppzyOZIrk` | **single** | Dando `+34658515045`, self (no phone, `isSelf`) |

Key derivation, per `61d1fde` — phone numbers only, digits-normalised, sorted, Matrix ids
dropped, `peer_spine.accounts` excluded:

```
An y Dando : {+34658515045, +13472576794}  →  exclude both accounts  →  {+34658515045}   size 1
Dando      : {+34658515045}                →  exclude both accounts  →  {+34658515045}   size 1
```

Self drops out for free (an account's own entry carries no `phoneNumber` at all). Rodz
drops out by the explicit exclusion. What remains is one number — **below the minimum of
two** — so `crossAccountChatKey` returns `null`, `findChatByKey` answers
`{ ok: false, reason: 'no-key' }`, and the mouth falls back to posting locally. That
fallback is what the operator saw.

## Why the floor is not the bug

The commit that introduced the key anticipated this roster shape exactly:

> *One looks usable and is not — a 1:1 with X keys as {X}, and so does a small group of
> [self, X, co-account] once both are excluded, so a size-1 key can put a group reply
> into a private chat. Two is the smallest set a 1:1 cannot produce.*

`An y Dando` IS `[self, X, co-account]`. And the collision is not hypothetical here: the
1:1 with Dando exists on the same account, and both chats key to `{+34658515045}`.
Relaxing the floor to one would let a reply meant for the group land in the private chat.

**The defect is not the guard. It is the key's resolution.** The key carries only
membership, and membership alone cannot separate a group from the 1:1 nested inside it.

## The cost, stated plainly

This is not an edge case. Any chat of exactly **[An + Rodz + one other person]** is
permanently excluded from the mouth — which is the natural shape of "An adds Rodz to a
small chat". Every such chat silently answers from An's own account, i.e. the operator
talking to himself, which is the precise thing the second account was introduced to stop.
It fails quietly: the reply is correct, only the envelope is wrong.

## Proposed fix — one more axis on the key

`type` is in the raw payload on both accounts and is a property of the REAL chat, not of
an account's view of it. Full key material available and account-agnostic:

```
type        'group' | 'single'     ← the discriminator
network     'WhatsApp'
accountID   'whatsapp'
localChatID per-account — useless
id          per-account — useless
```

1. **Fold `type` into the key.** `{group, +34658515045}` and `{single, +34658515045}` no
   longer collide, and the live collision above disappears.
2. **Then, and only then, relax the floor to one FOR GROUPS ONLY.** A group can never be
   produced by a 1:1, which is the whole reason the two-identity minimum existed. Keep the
   minimum of two for `single` — nothing there distinguishes a 1:1 from itself.

Shape: this is a change to the existing key function, not a new path beside it. If it
cannot be expressed there, stop and report rather than adding a second keying route.

## What is NOT claimed

- The honest limit locked as a test in `61d1fde` still stands and this does not touch it:
  **two different groups with identical membership still key alike.** `type` does not help
  there. A caller needing certainty must confirm another way.
- Not investigated: whether Beeper exposes the underlying WhatsApp group JID anywhere. If
  it does, that is the truest key and would retire this whole derivation. Worth one look
  before implementing the above.
- No reproduce-first test was written yet. The fix should start with one: a failing test
  built from the two rosters in the table above, asserting the group and the 1:1 key
  differently.
