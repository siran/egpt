# Plan — messages as first-class, id-addressable units (+ member actions + contacts)

Spec source: operator 2026-06-16 (the SPOILER/HFM debugging thread). Sibling of
GENOME §2.5 (E is a member) and C7.6/C7.6b (one dispatch-line formatter). This is
the implementation roadmap for the next epic.

**The principle.** A message is a first-class, addressable unit. Every line in a
transcript carries its source id, so any member (E included) can act ON a specific
message — react, reply, quote — and meta-events (reactions, edits, deletes) are
recorded as **bracketed stage-directions** that reference that id. Contacts become
a real, enriched dataset, not just slugs. Beings are full group members: they can
@mention and reply, not only emit prose.

Conventions (theater-play model, extends C7.6b):
- **Utterance** (a message / a being's reply): `Name@[chat].{node} (HH:MM) #<id>: <body>` — no outer brackets.
- **Stage-direction** (reaction/edit/delete/…): `[ Name@[chat].{node} (HH:MM): reacted 👍 to #<id> "…snippet…" ]` — outer brackets.

What Beeper hands us (verified 2026-06-16, the live Desktop API):
- per message: `id, chatID, accountID, senderID, senderName, timestamp, sortKey, type, text, isSender, isDeleted, linkedMessageID (reply/reaction target), mentions, seen, attachments`.
- per chat/contact: `id, localChatID, accountID, network, title, type, participants[] (id, phoneNumber, fullName, imgURL, isSelf, isAdmin, isNetworkBot, isPending), lastActivity, unread*, isMuted/Pinned/Archived, messageExpirySeconds, capabilities (reply/edit/delete/reaction, formatting, attachments+sizes, readReceipts, typingNotifications, disappearingTimer), preview`.
- NOT available: the sender's **device/client** (WA-Web vs phone vs Beeper). Beeper abstracts it and syncs own-sends to every instance. We can record the **processing node** (spine+surface, the `{node}` tag) — not the input device.

---

## Phase 1 — message ids in the transcript (the keystone)
**Goal:** every inbound line carries `#<id>` (the Beeper `msg.id`), so the model can
reference a specific message; nothing else changes yet.
- `src/dispatch-line.mjs` `formatDispatchLine`: add an optional `msgId` →
  `Name@[chat].{node} (HH:MM) #<id>: body` (omitted when absent → back-compat).
- Thread `from.msgKey` (= `msg.id`, already on `from`) into the inbound format
  call(s). Start with the LIVE single-message path; batched paths (accum/backlog
  piles) carry no single id — leave them id-less for now.
- E's own reply line: id added when the send returns a `pendingMessageID`/id
  (optional; declines have none) — a later refinement.
- **Tests:** dispatch-line renders `#<id>` when present, unchanged when absent;
  the live WA inbound line carries the msg id.
- **Risk:** low (additive optional field). Rollback = drop the param.

## Phase 2 — reactions ingested + surfaced (depends on P1)
**Goal:** a 👍 reaches E as a stage-direction; E can react back.
- Beeper delivers reactions as `message.upserted` events (type reaction; `text`=
  emoji, `senderID`=reactor, `linkedMessageID`=target). The bridge currently
  hardcodes `isReaction:false` + dedups them — detect them instead.
- Emit a stage-direction line referencing the target id + a resolved snippet:
  `[ An@[chat].wa (HH:MM): reacted 👍 to #<id> "…snippet…" ]`. LOGGED (I3); the
  emit gate decides surfacing; E **may** respond (I5 revised 2026-06-16: a
  reaction is a fed-for-context event, not a hard "ignore").
- `/react <emoji> <id>` already exists; wire E's allowlist so it can use it.
- **Tests:** a reaction event → bracketed line w/ id+snippet, logged-not-replied
  by default; dedup still holds.

## Phase 3 — member actions for E (depends on P1)
**Goal:** E acts as a real group member.
- `/reply #<id> <text>` — sends via Beeper `replyToMessageID` (the `linkedMessageID`
  hook); transcript shows the reply linked to the target.
- `@mention <user>` in E's reply — resolve a participant; Beeper `mentions`.
- Add to E's `e_commands` allowlist; gate as today.
- **Tests:** /reply links to the target; @mention resolves a participant.

## Phase 4 — contacts/ dataset (the GENOME §5 collector)
**Goal:** a real per-contact dataset, engine-owned, refreshed from Beeper.
- `~/.egpt/contacts/<surface>/<slug>.yaml` (or fold into the conversation folder):
  `phoneNumber, fullName, network, type, participants (members+phones+admin),
  avatar, muted/pinned/archived, lastActivity, capabilities, disappearingTimer`.
- Populate from the chat objects (GET /v1/chats) on first-contact + refresh; also
  enrich the transcript front-matter (`network`/`phone`/`type`/`participants`).
- Ties into the back-burner **stats module**.
- **Tests:** collector writes the dataset; front-matter enriched; idempotent.

## Phase 5 — per-surface user_name + processing-node provenance
- `whatsapp.user_name` / `telegram.user_name` (default the global `user_name`,
  itself default — operator set to "An"). Self-sent → the per-surface name.
- Record the processing node (spine+surface) on own-messages — the recoverable
  part of "where was it sent from" (the input device is NOT available, see above).

---

## Cross-cutting
- **GENOME first:** amend §2.5 / C7.6b with the id-line + stage-direction
  conventions before Phase 2, then contract, then test (anti-drift §10).
- **Reversibility:** each phase a self-contained, green, revertable commit.
- **Coverage:** every phase ADDS behavior tests (not just unit).
