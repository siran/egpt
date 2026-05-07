# egpt — manual feature testing

Step-by-step walkthrough for verifying egpt features end to end. The
`vitest` suite covers parsing, routing, and registry integrity — this
doc covers the surface behaviors a human has to eyeball: Chrome
spawn, bridge integration, multi-surface coordination, transcripts.

Run through the relevant section after any non-trivial change.

## 0. Prerequisites

- Node 18+ on PATH
- Chrome installed in a standard location
- Repo cloned at `~/src/egpt` (or adapt paths)
- One-time setup:
  ```
  cd ~/src/egpt
  npm install
  npm run build:ext
  npm test                 # 101 tests should pass
  ```
- Conventions in this doc:
  - "shell A" = a terminal running `node egpt.mjs`
  - "extension UI" = the egpt extension's tab inside the brain Chrome
  - "tg" = Telegram (the bot the shell node owns)
  - "✅" = expected pass; if you see something else, that's a regression

## 1. Solo shell, no Chrome

**Setup**: kill any running Chrome on `:9221` and any egpt processes.

### 1.1 — empty-room hint

1. In shell A: `node egpt.mjs`
2. Wait ~5 seconds.

✅ See: `Chrome not running — type /chrome to launch it…` (system row,
appears once, doesn't spam).

### 1.2 — slash commands work without Chrome

In shell A, type:

1. `/help`

✅ Help text renders locally with section headers; **does not** appear
in Telegram (verify if bot is configured); does not error.

2. `/sessions`

✅ Empty list, no peer block. No errors.

3. `/file`

✅ Prints the current `conversation.md` path.

### 1.3 — empty-room behavior on plain text

In shell A, type: `hello`

✅ "An: hello" shows in shell. After it, system row reads
`the room is empty — /attach to bring in CDP tabs, /open <brain> to
register a participant, or /help for slash commands…`. No crash.

### 1.4 — local operator brain works without Chrome

In shell A, type: `/open codex codex1`

✅ System row: `session "codex1" -> 🦊 codex (auto-opened…)` or
`session "codex1" -> 🦊 codex`. `/sessions` now shows codex1.

Type: `@codex1 echo hello from codex`

✅ codex1 streams a reply; final body appears as a `🦊 codex1` row.

Leave shell A running for §2.

## 2. /chrome (explicit Chrome spawn)

### 2.1 — first launch

In shell A, type: `/chrome`

✅ Sequence:
- `starting Chrome with extension…`
- A new Chrome window opens, profile = `~/.egpt/chrome/profiles/brain`. The egpt
  extension icon appears in the toolbar.
- After ~2-5s: `Chrome ready — proxy will auto-attach within 5s`
- Within 5s: `CDP proxy auto-started (:9221 → :9222)` and
  `bus tab opened (http://localhost:9222/bus.html)`

### 2.2 — /chrome is idempotent

In shell A, type: `/chrome` again.

✅ `Chrome already running on :9221` (or `…via proxy on :9222`). No
second window.

### 2.3 — log into a brain (one-time per profile)

In the brain Chrome window:
1. Open chatgpt.com, log in.
2. Open claude.ai, log in.

✅ Profile persists at `~/.egpt/chrome/profiles/brain`. Future `/chrome` runs
skip login.

### 2.4 — auto-attach existing tabs

In shell A, type: `/attach`

✅ If matching chatgpt.com / claude.ai tabs are open, system row reads
`auto-attached N tab(s): cgpt1 (chatgpt-cdp), …`. `/sessions` shows
them.

### 2.5 — /open chatgpt-cdp opens a fresh tab

In shell A: `/open chatgpt-cdp cdp1`

✅ A new chatgpt.com tab opens in the brain Chrome. After load:
`session "cdp1" -> 🐻 chatgpt-cdp (target: …)`.

### 2.6 — brain turn end-to-end

In shell A: `@cdp1 say hi`

✅ Streaming reply appears in shell as `🐻 cdp1` row. Same reply
visible in the chatgpt.com tab. `conversation.md` has both lines
appended.

## 3. Shell + extension (cross-surface)

**Setup**: §2 done. Brain Chrome up with extension. Shell A still
running.

### 3.1 — extension joins the bus

Click the egpt extension icon in the brain Chrome's toolbar.

✅ The egpt UI opens in a new tab. After ~1s, shell A shows
`bus: peer online chrome-XXXX (chrome)`. Extension UI shows
`bus tab attached` and `bus: peer online <shell-id> (shell) [polling]`.

### 3.2 — room-utterance mirroring

Type `hello from extension` in the extension UI.

✅ Shell A shows `human@chrome-XXXX: hello from extension`.

In shell A, type `hello from shell`.

✅ Extension UI shows `An@<shell-id>: hello from shell`.

### 3.3 — /sessions sees peer (zombie) sessions

In extension UI: `/sessions`

✅ Local list (cgpt1 / cdp1 if attached on the extension; codex1 isn't
local to extension), then a peer block:
```
~ <shell-id> (shell) [polling]
    codex1   codex
    cdp1     chatgpt-cdp
    …
```

### 3.4 — /attach codex forwards to shell

In extension UI: `/attach codex codex2`

✅ Extension UI: `/attach -> <shell-id> via bus`. Shell A:
`bus: running /attach codex codex2 for chrome-XXXX (human)` then
`session "codex2" -> 🦊 codex`.

`/sessions` on extension after ~1s shows codex2 as a peer (zombie)
session.

### 3.5 — @codex1 (peer mention) routes to shell

In extension UI: `@codex1 exec: pwd`

✅ Extension UI: `@codex1 -> <shell-id> via bus`. Shell A runs the
codex turn, posts a `mention-reply`. Extension UI receives:
`codex1@<shell-id>: $ pwd\n<path>`.

### 3.6 — @<unknown> error reads truthful

In extension UI: `@nobody hello`

✅ `!! no participant @nobody has joined the room — /sessions to see
who's here`. NOT "/open <brain>" suggestion.

### 3.7 — local commands stay local (shell side)

In shell A, type: `/help`

✅ Help renders in shell. Does NOT push help text to extension UI or
Telegram. (Extension UI may still see `An@<shell-id>: /help` as a
mirrored utterance, but not the help body.)

### 3.8 — peer brain reply tag

In extension UI: `@cdp1 from extension`

If cdp1 is on shell:

✅ Reply renders as `cdp1@<shell-id>: <reply>` (with @-tag indicating
which node ran it).

### 3.9 — room-reply broadcast (local brain reply mirrors to peers)

In shell A: `@cdp1 say something`

✅ Shell A renders `🐻 cdp1` row with the reply (local).
Within ~1s, extension UI shows `cdp1@<shell-id>: <reply>` (broadcast
via room-reply). Same line, both surfaces, no extra command needed.

In extension UI: `@cgpt2 hi` (assuming cgpt2 is local to extension)

✅ Extension UI renders cgpt2's reply locally. Shell A shows
`cgpt2@chrome-XXXX: <reply>` (room-reply broadcast). Symmetric.

## 4. Telegram bridge

**Setup**: bot token configured in `~/.egpt/config.json` under the
`telegram` key with `bot_token`, `allowed_users` (your Telegram user
id), and optionally `chat_id`.

### 4.1 — bridge starts

Restart shell A.

✅ See `telegram: telegram: starting as "egpt-shell"` and
`telegram bridge enabled`. If no `chat_id`: warning that shell-side
messages won't reach Telegram until the bot receives one.

### 4.2 — first inbound message

Send any text to the bot from your Telegram client.

✅ Shell A shows a system row `(telegram message from @<you>) -> <text>`.
If your text is plain (no command, no mention), the bot doesn't reply
unless a brain is configured to mirror Telegram.

### 4.3 — /help in Telegram returns to Telegram, not to shell broadcast

In Telegram: `/help`

✅ Bot replies in Telegram with the formatted help (HTML rendered:
section headers in **bold**, usage in `<code>`, etc.). Help text does
NOT appear as a system row in shell A.

### 4.4 — addressing a session from Telegram

In Telegram: `@codex1 hola desde telegram`

✅ Shell A shows `(telegram message from @<you>) -> @codex1 hola…`,
runs the codex turn, posts the reply back to Telegram as
`🦊 <b>codex1@<shell-id></b>\n<reply>`. Reply is visible bold in
Telegram client.

### 4.5 — Telegram-via-bridge tag in extension UI

While doing 4.4, watch the extension UI.

✅ Extension UI shows `<your-tg-name>@telegram[<chatId>]: @codex1 hola…`
(the room-utterance mirror, with `via:` showing telegram chat id).

### 4.6 — Telegram replicates plain text to peers (no mirror policy needed)

In Telegram, send plain text (no `/`, no `@`): `hello from telegram`

✅ Shell A shows the system note `(telegram message from <you>) -> hello…`.
Extension UI shows `<your-tg-name>@telegram[<chatId>]: hello from telegram`.

This works regardless of `cfg.telegram.mirror` — replication is
unconditional. The mirror policy only controls whether plain text
ALSO triggers a brain call (broadcast to local sessions). With
`mirror: 'none'` (default), peers see the text but no brain runs.

### 4.7 — peer typing reaches Telegram

In extension UI, type plain text: `hello from extension`

✅ Telegram chat receives `❓ <b>human@chrome-XXXX</b>\nhello from
extension` (forwarded by the shell node owning the bot, since the
`room-utterance` it received from the extension has no `via:` field).

### 4.8 — 409 yield + auto-claim handoff

**Setup**: same `bot_token` configured on BOTH shell (`~/.egpt/config.json`)
and extension (`chrome.storage.sync.telegram.bot_token`).

1. Start shell A. It claims polling.

✅ Shell A: `telegram bridge enabled`, no 409.

2. Open the extension tab (extension also tries to claim).

✅ Extension UI: `telegram: yielded — another node holds the polling
slot. Will auto-resume when they release; /telegram <self> to
force-reclaim.` Status bar shows `yielded — another node is polling`.
**No 409 noise loop.**

3. In shell A: `/telegram disconnect`

✅ Shell A: `telegram bridge stopped`. Within ~2s, extension
auto-claims and shows `telegram bridge enabled` (no manual action
needed; the dispatcher's auto-claim fired on `telegram-status:false`
from shell).

4. Quit shell A entirely (Ctrl+C). Wait ~2s.

✅ If extension was the holder, no change. If extension had
yielded earlier and a new shell B started: when the previous
holder went offline (`node-offline`), the auto-claim picks it up
in the surviving node.

5. `/telegram` (no args) on either surface

✅ Shows polling state across the room — one node `polling`, others
`idle`. The room is consistent without manual handoff.

### 4.6 — non-allowed users are gated for commands

(Optional, requires a second Telegram account.)

From an account NOT in `allowed_users`, send `/help` to the bot.

✅ Bot replies `<who> (<userId>) is not authorized to emit commands or
mentions`. /help does not run.

## 5. Custom node names

### 5.1 — set node_name

In shell A: `/config node_name home`

✅ `config: node_name = "home"  →  .egpt/config.json` (or the global
~/.egpt/config.json depending on what your /config writes to).

### 5.2 — restart picks up the new name

Quit shell A (Ctrl+C). Restart: `node egpt.mjs`.

✅ When the bus tab attaches, peers see `bus: peer online home (shell)`.
Tags now read `An@home` instead of `An@shell-<pid>`.

### 5.3 — extension picks its own name

In extension UI: `/config node_name chr1`

Reload the extension UI tab.

✅ After reload, peer announces as `chr1`. Shell A's `/sessions` shows
peer `~ chr1 (chrome)`. Tags read `An@chr1`.

## 6. Edge cases

### 6.1 — missing extension build

Delete `extension/dist/`. In shell A: `/chrome`.

✅ `!! extension/dist not built — run: npm run build:ext`. No spawn.

Restore: `npm run build:ext`. `/chrome` works again.

### 6.2 — Chrome killed mid-session

With shell A connected, force-quit the brain Chrome window.

✅ Shell A loses bus connection. Within ~5s, polling notices and
prints either `bus: not joined yet (…)` or `Chrome not running…`.
Restart Chrome (`/chrome` or manually) — shell auto-attaches again,
peer comes back online.

### 6.3 — stale peer cleanup

In a multi-surface session, force-quit one peer (extension tab or
shell). The other surfaces should:

✅ Receive `node-offline` (when graceful) or eventually drop the peer
on their own when no further events arrive. `/sessions` no longer
lists the dead peer.

### 6.4 — bus-tab survives shell restart

With both surfaces connected, quit shell A (Ctrl+C). Restart.

✅ Chrome stays open (shell never closes it). On restart, shell
re-attaches to the existing bus tab, sees the extension still online,
no duplicate bus tab opened.

### 6.5 — concurrent submits don't crash

Type fast in shell A while a brain turn is streaming.

✅ No crash. Either the second submit queues or interleaves with the
first; either way, no React error, no malformed transcript.

## 7. Reset / cleanup

After a test session:

- Quit shell A (Ctrl+C).
- Close the brain Chrome window manually (egpt does not close it for
  you — by design, so you don't lose tabs on restart).
- Optional: `git status` should be clean (the test session may have
  written to `conversation.md`).

## What this doesn't cover

- Performance / latency (CDP poll cadence, bridge edit cadence).
- Localized brain UIs (selectors are matched in en/es/fr/de/sv/pt;
  other locales are out of scope here).
- Markdown edge cases in brain output crashing Telegram HTML mode
  (we escape, but pathological output could still trip).

If a test fails, capture the shell log + extension console (right-click
the extension tab → Inspect → Console) and open a regression report.
