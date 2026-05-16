# Ideas / Future Milestones

Designs that are intentionally not built yet. Each entry should
explain the shape of the idea, the path that was considered, and
what's pending — so picking one back up doesn't require
re-deriving the whole thing.

---

## Read-receipt-driven personalization for `/movie` (DEFERRED 2026-05-16)

A WhatsApp message that animates *per viewer* via WA read receipts.
The vision: the operator sends `/movie @waN hi` to a group, the
message lands as a static `👋`, and when each member opens the chat
the hand waves and the message rewrites to include their pushName.
After everyone has seen it, the message rests on a line like

```
   👋  hi, Alice, Bob, and Carol!    👁 3 seen · 7 reads
```

— a "doorbell" that knows who's been by.

**Why it's parked.** An end-to-end implementation shipped (see git
log around mid-2026-05; commits `9fe0311`, `5bbf966`, `a788702`,
`737633a`, `3fe1501`) and got close, but reads from real viewers
weren't reliably reaching the bridge's handler. The two leading
hypotheses without a definitive answer:

1. **baileys event shape drift.** The bridge listened on both
   `sock.ev.on('messages.update')` (1:1 chats, status enum `4` =
   READ) and `'message-receipt.update'` (groups, per-participant).
   The latter's payload shape varies by baileys version —
   `receipt.userJid` vs top-level `participant`, `receipt.type ===
   'read'` vs `receipt.readTimestamp != null`. Need a diagnostic
   pass with real events captured to see what the current baileys
   actually emits in the operator's groups.
2. **WA read-receipt privacy off.** A non-trivial fraction of WA
   users disable read receipts entirely. Those reads fire no event
   at all on any device. No bridge-side fix possible; it's a
   feature-coverage limit to document, not a bug to chase.

A secondary issue surfaced: when a preset baked `<username>` into
its default greeting, the regular (non-personalized) `playFrames`
path rendered the placeholder as literal text. That was fixed
(commit `3fe1501`: auto-engage personalization on placeholder
detection), but the rip-out at `2026-05-16` removed that
infrastructure too — rebuilding will need to redo it.

### What was built (now removed — see git history)

All on the `main` branch between `9fe0311` and `3fe1501`,
torn out in a later commit. The shape was:

**slash/movie.mjs**

- New flags on `/movie`: `--template "<text with <username>>"`,
  `--mode append|first`, `--joiner ", "`, `--include-self` (for
  testing without a second device).
- `<username>` / `<viewercount>` / `<readcount>` placeholders
  substituted at frame emit time.
- New `hi` preset — static `👋` until first read, then wave +
  greeting + names. `autoDelete: false`, `placeholderFrames: 1`.
- Preset config field `placeholderFrames` — how many leading
  frames to skip on re-animation so names don't flicker out
  between viewers.

**bridges/whatsapp.mjs**

- `_personalizedMovies` Map keyed by sent msgKey.id, holding per-
  message state: `viewers[]`, `totalReads`, `started`, `finished`,
  `placeholderFrames`, `includeSelf`, etc.
- `_pushNameByJid` Map populated from inbound `messages.upsert`
  events so reader pushNames could be resolved even when
  `sock.contacts` was sparse.
- `_resolvePushName` — pushName-only lookup chain (see
  [memory: pushName only, never the contact book]). Order:
  `msg.pushName → sock.user.name (for self) → _pushNameByJid →
  sock.contacts[jid].notify → friendly fallback ('you', 'friend',
  'mystery reader', ...)` — never `sock.contacts[jid].name`.
- `_renderUsername` — substitutes `<username>` / `<viewercount>` /
  `<readcount>` at every frame emit.
- `_handlePersonalizedRead` — dedup by pushName, skip operator
  self-reads (unless `includeSelf`), start animation on first
  read, re-animate on each subsequent post-finished read (skipping
  placeholder frames so the rest state stays visible between waves).
- Listeners on `sock.ev.on('messages.update')` and
  `'message-receipt.update')` filtered to known personalized keys,
  with verbose diagnostic logs for every event (status enum, raw
  receipt JSON).

### What to do when picking this back up

1. **Diagnose first.** Restore the verbose listeners (or rebuild
   them), send `/movie @waN hi --include-self` to a real group,
   have someone else open the chat, and read the
   `personalized[<id>]: ...` log lines. The mystery is whether
   events arrive at all, and if so what shape — not a code
   design question yet.
2. **Don't reinvent the pushName resolver.** The
   pushName-only-never-address-book rule is in memory and matters
   for privacy. Same with operator self-read skip (auto-mark-as-
   read on send would otherwise consume the first-viewer slot).
3. **Operator's KISS preferences from the design sessions:**
   - Animation continues uninterrupted when new viewers arrive
     mid-anim — just append to the live list.
   - When a viewer arrives after the animation finished, re-run
     the animation (not just edit the final frame) — operator's
     "doorbell" mental model.
   - No `--max_names`, no `--fallback_seconds`, no debounce
     window.
   - Counter visible in the rest frame (`👁 N seen · M reads`).
4. **Friendly-fallback names** — when the resolver falls all the
   way through to bare digits (i.e. a real phone number), swap
   for `'you'`, `'friend'`, `'mystery reader'`, etc. so the
   message never renders someone's raw phone number as their
   "name."

### Related memories

- `feedback-wa-pushname-only` — privacy rule for any WA-side
  display name resolution.
- `feedback-verify-wa-chat-name` — debugging "nothing happened"
  starts with the slash-echo chat name, not the chat the operator
  is staring at.
- `project-egpt-movie-hi-pending` — pointer back to this file.
