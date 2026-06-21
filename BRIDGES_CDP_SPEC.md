# CDP / content-script WhatsApp / Telegram bridges — spec

> **REMOVED 2026-06-21.** The extension's WhatsApp feature (the
> `web.whatsapp.com` content script, the background relay, the WA-CDP
> bridge/routing/commands, and the `whatsapp_cdp` config) was deleted —
> beeper (in the daemon/spine) is the only WhatsApp transport now. This
> spec is kept for historical context only; nothing below is wired up.

> **Note (post-v1)**: The WhatsApp bridge ships as a **content script**
> declared in the manifest (`https://web.whatsapp.com/*`), not via CDP.
> Content scripts auto-load when the matching page opens — no Chrome
> launch flags, no `--remote-allow-origins=*`, no CDP attach. They talk
> to the extension's background via `chrome.runtime` ports; background
> republishes incoming messages as `room-utterance` events on the bus,
> so peers (shell, other extensions) see them through their existing
> bus subscription. Sections below describing CDP attach are kept for
> Telegram-Web (which may use either approach) and as historical
> context for the architecture decision.

# CDP-driven WhatsApp / Telegram bridges — spec

Goal: enable extension-only operation by adding bridges that drive
`web.whatsapp.com` and `web.telegram.org` via CDP (the same mechanism the
existing `cdp_chat` / `cdp_claude` brains use to drive ChatGPT and
Claude.ai). When these exist, an extension installed in Chrome with the
target accounts already logged in is fully self-sufficient — no
`node egpt-daemon.mjs` required, no baileys, no Bot API token.

This spec captures the contract, behavior, and known pitfalls so the
implementation can be done in one focused pass without rediscovery.

---

## 1. Architectural placement

The Node bridges live at `bridges/whatsapp.mjs` and `bridges/telegram.mjs`
and are imported by `egpt.mjs`. Their CDP counterparts live alongside
the extension code:

```
extension/src/bridges/
  whatsapp-cdp.js     # drives web.whatsapp.com via Runtime.evaluate
  telegram-cdp.js     # drives web.telegram.org (Web K) via Runtime.evaluate
```

Both are imported by `extension/src/tab/App.jsx`. The host-side wiring
in App.jsx mirrors what egpt.mjs does for the Node bridges — just
swapping the import.

**Crucially: the bridges expose the same contract** as the Node
bridges, so the rest of the system (chat classification, persona
dispatch, items-mirror, /egpt command) stays untouched.

---

## 2. Contract (must match Node bridges)

### Factory signature

```js
// extension/src/bridges/whatsapp-cdp.js
export async function startWhatsAppCdpBridge({
  targetId,                     // CDP target id of the web.whatsapp.com tab
  allowedUsers   = [],
  awareness      = {},          // self_chat / personal / groups rules
  debug          = false,
  bypassAwareness= false,
  maxBacklogSeconds = 0,
  onIncoming,                   // (text, fromInfo) => Promise
  onLog,
  onError,
  onChatId,                     // first self-DM seen — host persists chat_id
}) -> {
  send(text, { chatId } = {}),
  startStreamMessage(initialText, { chatId } = {}) -> { update, finish },
  stop(),
  get myJid(),                  // user's primary identity (e.g. phone JID)
  get myNumber(),               // bare-number form
  get myLid(),                  // LID privacy-format JID, if any
  get myLidNumber(),            // bare-number portion of myLid
  get selfDmJid(),              // JID for "Message Yourself"
  get chatId(),                 // currently-known canonical egpt chat
}
```

`telegram-cdp.js` exposes the same shape minus the LID-related getters
(Telegram has no LID concept). It exposes `get myUserId()` instead of
phone-related getters.

### Behavior contract

- `onIncoming(text, fromInfo)` fires for each new message after subscribe,
  filtered by awareness rules (see §4) and allowedUsers gating. fromInfo
  shape: `{ chatId, userId, username, firstName, lastChat, fromMe }`.
- `send(text, { chatId })` sends to `chatId` if given, else to `lastChat`
  (the most recently-seen chat, mirroring Node bridge behavior).
- `startStreamMessage(initial, { chatId })` returns `{ update, finish }`.
  `update(text)` is debounced (~2.5s for WA, ~1.5s for TG) and edits the
  in-place message; `finish(text)` flushes the last edit and clears any
  presence indicator.
- `stop()` is idempotent and clears all listeners + intervals.
- `onChatId(id)` fires **once**, **only for self-DMs** (see §5 pitfall).

---

## 3. CDP plumbing

The extension already has a CDP layer (`extension/src/tools/cdp.mjs` and
the existing brain modules). New bridges can reuse:

- `Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true })`
  — execute JS in the target tab's context.
- `Runtime.consoleAPICalled` subscription via the bus pattern — already
  proven in `tools/bus.mjs` / `bus.js`.
- `Page.attachToTarget` not needed; we attach to the web.whatsapp.com tab
  directly the same way `cdp_chat` does to chatgpt.com.

For receiving messages, two transport choices per bridge — pick by
robustness:

1. **DOM-mutation observation**: `MutationObserver` over the message list
   container. Selectors will drift; pin them in one place and version
   the bridge.
2. **Internal-store hook**: WhatsApp Web exposes `window.Store` (modulebound;
   needs to be reflectively rebound after WA bundle changes). Telegram
   Web K exposes `window.appWebpack` modules. More resilient long-term
   but requires bundle reverse-engineering each time the target updates.

For sending: `document.execCommand('insertText', ...)` + click the send
button. This is the same approach used by `brains/chatgpt-cdp.mjs`.
Edits use the same primitive — locate the message, click "Edit", replace
text, submit.

---

## 4. Reused, surface-agnostic modules

These are already pure and used by the Node bridge — both CDP bridges
must import them rather than reimplementing:

- **`bridges/whatsapp-classify.mjs`** — `classifyWhatsAppChat({chatId, bridgeInfo, waConfig})`.
  Self-DM / observed-chat / egpt_chats classification. LID-aware.
  16 tests pin every regression we've already hit. The CDP bridge passes
  the same `bridgeInfo` (including `myLid`, `myLidNumber`) and gets the
  same `{ isSelfDM, isEgptChat, observeOnly, shouldCaptureChatId }` back.
- **`author-emoji.mjs`** — `emojiForAuthor(author, sessions, opts)`.
  Cross-surface emoji mapping. Not bridge-specific.
- **`persona-state.mjs`** — `recordSession`, `startNew`, `rewind`, etc.
  Persona session-history. Not bridge-specific.
- **`interpreter.mjs`** + **`room.mjs`** — parse/route. Surface-agnostic.

A CDP bridge therefore implements *only* the transport — connect, send,
receive, edit, presence — and delegates classification + dispatch to the
existing host code.

---

## 5. Pitfalls already paid for (DON'T re-introduce)

These are real regressions we hit on the Node bridges. The CDP bridges
must handle the same shapes from day one:

### chat_id auto-capture must be self-DM-only

Capturing the *first message ever seen* poisons the persisted `chat_id`
when that message is a group or contact message. Classifier already
returns `shouldCaptureChatId` correctly — bridge just has to gate
`onChatId(...)` on it.

### Self-DM detection needs LID + phone matching

WhatsApp's "Message Yourself" arrives as `<lidNumber>@lid` in privacy
mode, where the LID number does NOT match the phone number. The bridge
must capture both `myJid` (phone) and `myLid` and pass `myLidNumber` in
`bridgeInfo` to the classifier.

### Awareness rules

Three knobs from `EGPT_CONFIG.whatsapp.awareness`:
- `self_chat`: 'both' | 'incoming' | 'outgoing' | 'off'
- `personal`:  'both' | 'incoming' | 'outgoing' | 'off'   (default 'incoming')
- `groups`:    'mentions' | 'all' | 'off'                 (default 'mentions')

Telegram's awareness keys are simpler (no group "mentions" mode by
default; bot-context handles that). Mirror the Node bridge's rules.

### Wake-word bypass

`@egpt` and `@e` (case-insensitive) bypass awareness and allowed-users
gates. Both must reach `onIncoming` even from observed chats — the host
runs the persona and sends the reply back to the originating chat only.

### Observed-vs-egpt distinction

`onIncoming` always fires (subject to awareness); the *host* decides
whether to mirror or just observe. Bridge does not gate this.

### Streaming aesthetics

- Debounce: 2.5s for WA (Edited badge appears after 1st edit; don't
  spam), 1.5s for TG (silent edits, debounce can be tighter).
- Presence: WA bridge keeps `composing` typing indicator alive every 8s
  during stream; clears on `finish()`. TG has no equivalent; the
  in-place editing message itself is the indicator.

### Handle/client/node tagging

Cross-surface author tags carry `<handle>@<client>[.<node>]`. Bridge
config: `client_name` (default 'wa-cdp', 'tg-cdp' to distinguish from
'wa', 'tg'). User can override via `/config whatsapp.client_name moto`
(when typed *from* the bridge, bare key auto-scopes to that bridge's
namespace).

### Pre-connect backlog

`maxBacklogSeconds` config drops messages older than N seconds at
subscribe time. CDP bridges see backlog as pre-existing DOM rows —
filter by message timestamp on first scan.

### Echo suppression

When the bridge sends, the WA/TG client may echo the same message back
to the receiver (especially in self-DM). The bridge must remember the
ids of messages it sent and filter them on the way back, same as
`bridges/whatsapp.mjs` does with its `sentIds` set.

---

## 6. Auth + tab lifecycle

The CDP bridges depend on the user being **logged into web.whatsapp.com /
web.telegram.org in the brain Chrome session** (the same Chrome the
extension is loaded in, or a separate "brain Chrome" launched with
`--remote-debugging-port=9221`).

- First-time setup: user opens the WA Web tab, scans QR with phone, lets
  it persist. After that, the session lives in Chrome's IndexedDB and
  the bridge can attach via CDP.
- The bridge does not handle login. If the tab shows a QR / login
  screen, `onError('not logged in — open web.whatsapp.com manually and pair')`
  and bail.
- Tab lifecycle: bridge attaches to a target by URL match
  (`*web.whatsapp.com/*`). Same auto-rebind logic as `cdp_chat` brain —
  if the tab moves/closes, find a fresh one or surface an error.

---

## 7. Configuration

New `EGPT_CONFIG` blocks (registered in `config-schema.mjs`):

```
whatsapp_cdp: 'CDP-driven WhatsApp Web bridge: { enabled, awareness {...},
                allowed_users [...], chat_id (auto-captured), egpt_chats [...],
                client_name (default "wa-cdp"), max_backlog_seconds }'
telegram_cdp: 'CDP-driven Telegram Web bridge: { enabled, allowed_users [...],
                chat_id (auto-captured), client_name (default "tg-cdp") }'
```

When both Node and CDP variants are configured, the host prefers Node
(it's been more stable). To force CDP-only, set `whatsapp.enabled: false`
+ `whatsapp_cdp.enabled: true`.

---

## 8. Tests

### Pure logic — already covered

- `bridges/whatsapp-classify.mjs` (16 tests) — works for either bridge.
- `author-emoji.mjs` (17 tests) — surface-agnostic.
- `persona-state.mjs` (25 tests) — surface-agnostic.

### Bridge-contract tests (new — mock CDP layer)

- `tests/whatsapp-cdp-bridge.test.mjs`
- `tests/telegram-cdp-bridge.test.mjs`

Each mocks the CDP `Runtime.evaluate` interface and asserts:
- `startStreamMessage(...).update(text)` debounces and only edits once
  per debounce window.
- `onChatId` fires only on self-DM.
- `onIncoming` filters by awareness rules.
- Wake-word bypass works.
- Echo of own messages is suppressed.
- LID self-DM is detected.

### Live integration (manual, gated)

A `npm run test:cdp:wa` script that:
- Launches a brain Chrome on `--remote-debugging-port=9221`.
- Asserts a logged-in `web.whatsapp.com` tab exists (skip otherwise).
- Sends a message to self via the bridge.
- Verifies it appears via the bridge's `onIncoming` (echo-or-confirm).
- Tests one edit-streaming round trip.

Skipped in CI; useful for pre-release smoke testing.

---

## 9. Out of scope

- Multi-device support beyond what WA Web / TG Web already handles.
- Voice notes, media (images/video/files). v1 is text-only.
- Group admin actions (kick/ban/promote).
- Reactions, replies-as-thread (message-quoting context). Possibly v2.
- E2E encryption guarantees beyond what the web client itself provides
  (this is a UI driver, not a protocol implementation).

---

## 10. Migration / coexistence

- Existing setups with the Node bridges keep working. The CDP bridges
  are purely additive.
- If both are configured for the same account, only run one (otherwise
  every message is processed twice). The host enforces this — first
  bridge to register `onIncoming` for a chat wins.
- The `bridges/whatsapp-classify.mjs` rules are identical for both;
  `chat_id` and `egpt_chats[]` apply to whichever bridge is active.

---

## 11. Done-when

Acceptance criteria for the v1 ship:

1. Extension-only setup (no `node egpt-daemon.mjs` running) can:
   - Receive a WhatsApp message and surface it in the extension UI.
   - Receive a `@egpt` mention from WhatsApp and reply via a CDP brain
     (`cdp_claude` / `cdp_chat`) back to the originating chat.
   - Same for Telegram.
2. Streaming reply is visible (edit-based) on both surfaces.
3. Self-DM mirroring (typing in extension shows up in WA self-DM and
   vice versa) works without echo loops.
4. All 200+ existing tests still pass; new bridge-contract tests pass.
5. Documented manual smoke-test passes on a logged-in browser.

---

## 12. v1 manual smoke-test (current state — content-script architecture)

The WhatsApp bridge is shipped as v1 (single-chat, no streaming) using
a content script declared in the manifest (`https://web.whatsapp.com/*`).
**Tab presence is the on/off switch** — open `web.whatsapp.com`, the
content script auto-loads and the bridge attaches; close it, the bridge
detaches. No config required, no Chrome launch flags.

To use it:

1. Reload the extension at `chrome://extensions` → click reload (so
   Chrome picks up the new content script declaration in the manifest).
2. Open `https://web.whatsapp.com/` in that Chrome and link with your
   phone. Wait for chats to load (the QR screen should be gone).
3. Open the egpt extension UI tab. You should see:
   `whatsapp-cdp: subscribed (waiting for a web.whatsapp.com tab)` then
   `whatsapp-cdp: bridge ready (content script in WA Web tab is connected)`
   (the second line appears within ~1 second of the WA Web page settling).
4. Open a chat in WA Web. Send a message from another device to that
   chat — the egpt extension UI should `appendMsg` it. **And** the
   background republishes it as a `room-utterance` event on the bus,
   so any other peer (shell, another extension) sees it through their
   existing bus subscription.
5. Type a message in the egpt extension input — the bridge `send()`
   posts it to background. Background uses **chrome.debugger** to
   attach to the WA tab and dispatch real Input.insertText + Enter
   events (synthetic DOM events from the content script can't trigger
   WA Web's send button — WA checks event.isTrusted=true). The
   "egpt started debugging this browser" banner flickers during the
   attach window for each send (we attach right before, detach right
   after, to keep the banner exposure minimal).
6. Close the WA Web tab when done — the bridge logs
   `whatsapp-cdp: WA Web tab closed (content script disconnected)` and
   stops touching WhatsApp.

To opt out entirely (rare): set `whatsapp_cdp.enabled: false` in
`chrome.storage.sync`. The default (absent) is auto-attach when a
WA Web tab is open.

### Send path: shell-aware fallback (no banner when shell is on the bus)

| Condition | Receive (WA → bus) | Send (bus → WA) | "egpt started debugging" banner? |
|-----------|--------------------|------------------|-----------------------------------|
| Shell peer present on the bus | content script + bg republish | shell sees the bus event, sends via baileys | none |
| No shell (extension-only)     | content script + bg republish | extension's bridge fires `chrome.debugger Input.*` | brief flicker per send |

Receive direction always uses the content script — no debugger needed.
Send-via-debugger is the **fallback path** that activates only when no
shell peer is on the bus to do the solid baileys send.

The gate lives in `extension/src/tab/App.jsx`'s `room-utterance` bus
event handler:

```js
const fromWhatsApp = String(ev.via ?? '').startsWith('whatsapp');
const hasShellPeer = [...peerNodesRef.current.values()].some(p => p.role === 'shell');
if (waCdpBridgeRef.current && !fromWhatsApp && !hasShellPeer) {
  waCdpBridgeRef.current.send(ev.body ?? '');
}
```

When the shell joins the bus mid-session, the next `room-utterance`
flips to the shell branch automatically — no reconfiguration needed.
When the shell drops off, the extension takes over again on the next
event.

### Why content script (not CDP)

CDP attach from a `chrome-extension://<id>` origin requires Chrome to
have been launched with `--remote-allow-origins=*` (or the extension's
specific origin in the allow-list). Manual launches without that flag
silently fail the WS connect. Content scripts run in the page's isolated
world by default — declared in the manifest, no flags needed, no CDP
attach, no `"started debugging"` banner. This is the standard extension
mechanism for "manipulate this page's DOM"; the CDP route was overkill.

### v1 limitations to keep in mind during testing

- **Single chat only**: the bridge listens to whatever chat is open. If you
  switch to a different chat, the bridge starts listening to *that* one.
  Background chats are not observed yet.
- **No edit-streaming**: when @egpt replies, the message arrives whole;
  no "typing…" indicator yet (that's v1.5).
- **No command/mention routing**: typing `@egpt hi` in WA Web with this
  bridge does **not** yet wake the persona. v1 just mirrors text. Use
  the Node WA bridge if you need persona dispatch from a WA chat today.
- **Selectors**: WA Web ships UI changes occasionally; if send or receive
  stops working, the heuristics in `extension/src/bridges/whatsapp-cdp.js`
  (the OBSERVE_SCRIPT and buildSendScript) are where to update.
