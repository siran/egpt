# WhatsApp-Web-over-CDP DOM-control glove — scope (2026-06-08)

## Context
Pivot WhatsApp off **baileys** (forged protocol, ban-risk) to driving the
**official WhatsApp Web client** in egpt's already-CDP-controlled Chrome (same
Chrome as the chatgpt/claude-cdp brains). Validated 2026-06-08 against bundle
`2.3000.1041108452`: the WA-internal **Store path is dead** (wa-js 4.3.0 won't
bind; operator: forget the Store), but **DOM-control works end-to-end** keyed on
durable human/semantic anchors. v1 is **inert** — same gated behavior as today.

See memory `egpt-wa-cdp-pivot` for the full findings.

## Ontology
**Spine** = living core (intelligence, memory, gate). **Limbs** = I/O surfaces
(Telegram, WhatsApp, shell, extension), each a **glove** over one surface,
fitting ONE clean **limb contract**. Intelligence stays in the spine; baileys'
fault was leaking WA anatomy (jid/LID/upsert) into the spine (~10 files). The
glove must fit the contract, not baileys' shape.

## Branch strategy — DECISION NEEDED
- **Recommended: branch from `main`** as `beta-1.15-wa-cdp`; archive current main
  as `archive/baileys-era`. Rationale: the hardest-won durable value — the
  provable-`_personaReplyIds` emit gate (today), the NSSM service (beta-19),
  rooms (beta-14), e-path grants — is all CURRENT. Then **excise baileys behind
  the limb interface** (replace baileys message-shapes with limb events in the
  ~10 leaking files) and drop the baileys recovery machinery / power-saga.
- **Alternative (operator's earlier instinct): rewind to `beta-15-e-path-grants`**
  and forward-port. Costs re-porting beta-16..19 + today's gate fix. Only better
  if in-place excision proves messier than expected.
- Decide before cutting. Either way: **keep** auto-mode/gate + provable-emit,
  rooms, e-path grants, daemon-singleton, NSSM service, whisper+verbose_json,
  slash architecture+tests. **Drop** nic-poke/cooldown/reconnect, work-lock
  power-saga, LID-map, reuploadRequest, the upsert notify/append/prepend model.

## The limb contract (the hand every glove fits)
- **Afferent event:** `{ identity(sender, resolved name), chatHandle(opaque),
  body, msgId, kind(message|reaction|edit), mentionStatus(atEStart/atEAnywhere),
  replyToPersona(provable) }`. No jid/LID.
- **Efferent:** `send(text|media|quotedReply)`, `presence(typing)`.
- **Health (proprioception):** `isAlive()` — uniform across limbs.
- **Capabilities:** the limb declares what it supports; the spine asks.

## The WA-CDP-DOM glove — implementation
All WA-specific selectors/anchors/CDP calls live in **ONE adapter module**
(`src/bridges/whatsapp-cdp.mjs` + a `wa-web-dom.mjs` anchor layer); the rest of
egpt sees only the limb contract. Bundle drift = one-file fix.

1. **Chrome lifecycle:** the service launches Chrome with remote-debugging
   (reuse `src/tools/chrome-launcher.mjs`); WA Web tab logged in (one-time QR in
   the brain profile). Attach via `src/tools/cdp.mjs` + nucleus discovery.
2. **Afferent (sense) — notification-driven, not polling:**
   - Inject (`Page.addScriptToEvaluateOnNewDocument`, document-start) a hook that
     wraps `window.Notification` → captures `{title=sender, body=preview, tag}`
     for every new-message notification, queued to a global the glove polls/reads
     over CDP. *This is the "a message arrived" trigger* — no chat-list polling.
   - On a trigger: `Page.bringToFront` + open that chat (click its
     `[data-testid="cell-frame-title"]`/`span[title=...]`) so it **renders**
     (WA Web virtualizes — only the open chat is in the DOM).
   - Read full message(s) via the durable anchors: `[data-pre-plain-text]`
     (sender + timestamp), `[data-id]` (msg id), the text node. Normalize → limb
     event → spine's existing dispatch/gate.
   - Backup signals: `[data-testid="icon-unread-count"]`, `last-msg-status`.
3. **Efferent (act):** select chat (click `cell-frame-title`/`title`) → focus
   `footer div[contenteditable="true"]` → `Input.insertText(text)` → **click**
   `[data-icon="send"]` (Enter is ignored by WA's Lexical composer). Confirm via
   composer-clear + the new outgoing `[data-pre-plain-text]`.
4. **Gate signals (feed the UNCHANGED auto-mode gate):** explicit `@e` parsed
   from the body; `replyToPersona` = quoted target is a msg the glove itself sent
   (track our sent `[data-id]`s → the provable-`_personaReplyIds` model carries
   over verbatim). Reactions never trigger.
5. **Health:** tab attached + `#pane-side` present (logged in) + Notification
   hook installed. Recovery = re-attach / re-open tab / surface QR if logged out
   — generic per-limb, not baileys' bespoke nic-poke.

## v1 behavior — INERT, held constant
Reply only on `mention`/`mention-direct`/`on`; silent otherwise. The
provable-emit gate (auto-mode.mjs + `_personaReplyIds`) is reused unchanged.
Agency is spine policy — autoresponse/proactive come later with ZERO glove
rework (the glove just exposes `send()`).

## Deferred
WA-internal Store (forgotten), drafts-by-default, reactions-as-control, status
digests, autoresponse/proactive, multi-account tabs.

## Risks / notes
- **Bundle drift** is the recurring cost — fully quarantined in the anchor layer.
- WA Web **notification permission** must be granted in the brain profile.
- **Background-tab throttling** can delay JS — `bringToFront` on trigger; the
  Notification hook fires regardless.
- ToS-gray: drive **human-like** (paced, real UI gestures = lowest detection
  risk). The DOM-control path already looks like a person using WhatsApp.

## Verification ladder
1. ✅ select / read / send proven (`attic/tests-manual/wa-dom-*.mjs`).
2. ✅ afferent proven (`attic/tests-manual/wa-notif-spike.mjs`, 2026-06-08): real inbound
   fired PAGE-level `window.Notification` `{title=chat, body="Sender: preview",
   tag=chat JID}` (NOT the SW), + MutationObserver unread backup. Full loop green.
3. NEXT (build): branch `beta-1.15-wa-cdp` from main; wire the glove to the limb
   contract; run the inert loop against a `mention`-mode test chat (reply only
   when `@e`'d).

## First build milestone (proposed)
On the new branch, the thin slice that proves the architecture:
- `src/bridges/whatsapp-cdp.mjs` (limb) + `wa-web-dom.mjs` (anchor layer) +
  the injected `window.Notification` hook installed at attach.
- Loop: notification → open chat by JID → read latest via anchors → emit a
  normalized limb event into the EXISTING dispatch/gate → on a permitted reply,
  type + click-send. Inert (mention/mention-direct/on only).
- Leave baileys in place initially; switch the host to the CDP limb behind the
  limb contract, then excise baileys-isms from the ~10 leaking files.

