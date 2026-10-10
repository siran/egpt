# Per-conversation Chrome profiles

**Operator go: 2026-10-09.** Each conversation gets its own Chrome profile + process.
Whatever is signed into one conversation's Chrome (Gmail, ClassDojo, …) is invisible to
every other, because each has its own `--user-data-dir`. Ends "my Gmail is shared with all
my conversations." A conversation launches its own Chrome, and that Chrome is tied to it.

## Decisions (operator-approved 2026-10-09)

1. **Profile permanent, process pooled.** `chrome/profiles/<conversation-slug>` persists on
   disk (sessions / cookies / saved passwords survive). The `chrome.exe` is a warm-pooled
   resource: lazy-launched on first browser need, evicted under memory pressure (relaunch comes
   up still-logged-in from the persisted dir). "Tied to the conversation" = the *profile* is
   permanent; the *process* comes and goes.
2. **Sharing is the default; dedicated is opt-in (operator refinement 2026-10-09).** MOST
   conversations share ONE Chrome (the `brain`/shared profile) — one `chrome.exe`, many
   conversations. Only a FEW conversations are flagged **dedicated** and get their own `<slug>`
   profile + their own Chrome. The policy lives in the CALLER: a dedicated conversation calls
   `chromeProfileOf(cfg, conversation)` (own slug); every other calls `chromeProfileOf(cfg)` (no
   conversation → shared/`brain`). ⇒ Chunk 1's resolver is already correct and is NOT changed.
3. **No fixed cap — MEMORY is the limit (operator 2026-10-09).** Launch as many Chromes as are
   needed, bounded only by memory. Before launching a new one the spine makes a **deterministic**
   estimate — "if I launch one more Chrome, does it fit in available memory?" — and launches only
   if it does; otherwise it evicts the idlest managed Chrome and retries, or declines. One Chrome
   per *profile* (the shared profile is one Chrome for all its conversations). **Any free port**,
   agreed at launch — no reserved range.
4. **`brain` stays the admin / shared profile.** The existing `brain` profile (holds Gmail /
   ClassDojo / AWS today) is the shared default and the admin conversation's profile — reuse the
   existing `admin_channel: eGPT Admin`, no new key. A dedicated conversation starts clean: no
   Gmail until it is signed in there.
5. **Login follows the conversation.** `/login` and the credential read use the CONVERSATION's
   resolved profile (shared `brain` for most, own `<slug>` for a dedicated one), so a dedicated
   conversation can only log into sites whose creds are saved in its own Chrome.
6. **CDP transport = `--remote-debugging-pipe`, NOT a port (operator nod 2026-10-09).** A dedicated
   Chrome exposes NO socket: CDP rides a private pair of fds (3 & 4) that only the SPINE holds, so
   the spine is the sole driver and one conversation has no address by which to reach another's
   Chrome (closes the cross-conversation hole without a port or per-conversation token — nothing
   to secure because nothing listens). Verified: neither `-port` nor `-pipe` triggers Chrome's
   warning banner (that comes from `--no-sandbox` / `--enable-automation` / `--disable-blink-
   features=…`, none of which our launcher sets; it also sets `--silent-debugger-extension-api`).
   Chrome 136+ ignores both switches unless paired with a NON-default `--user-data-dir` — satisfied,
   every profile dir is non-default. **Pipe REQUIRES the spine to direct-spawn Chrome** so the child
   inherits the spine's fds — the Session-0 frozen-task hop cannot hand over fds, so dedicated-pipe
   Chromes are a **Session-1 direct-spawn** feature (confirm reve/dolly session). The existing
   SHARED `brain` Chrome stays on `:9221` for now; migrating it off the port to pipe (and retiring
   the cdp-proxy/extension-bus that assume a port) is a SEPARATE, larger follow-up — ask first.

## Where this routes (the code already reserves the spot — reconfigure, don't add beside)

- `chromeProfileOf(cfg)` — `src/spine/commands.mjs:101` — is "the ONE place the profile is
  decided." Its own comment (`commands.mjs:1342-1343`) says the per-group/per-conversation
  profile "belongs there, not in a caller." Chunk 1 fulfils that intent.
- `ensureChrome()` — `commands.mjs:1326-1354` — is THE launch path: single-flight `_ensuring`,
  one launch at a time, `launchChrome({ port: chromePortOf(host), userDataDir:
  chromeProfileOf(cfg()), bin })`. Per-conversation makes profile, port, and single-flight all
  keyed by conversation.
- **Session split** (`commands.mjs:1259-1295`): a **Session 1** spine SPAWNS Chrome directly
  with port+profile ARGS (the path per-conversation needs); a **Session 0** spine hops a
  scheduled task FROZEN at port 9221 + one profile (cannot pass per-conversation args).
  `EGPT_SESSION1` is set by `session1-logon-launcher.vbs` (`boot.mjs:983-986`). ⇒
  **Per-conversation is a Session-1 (direct-spawn) feature.** Confirm each node's session.
- `cdp.mjs` host default `localhost:9221`, override `EGPT_CDP_HOST`; `cdp-proxy.mjs` fronts ONE
  chrome port (`9221→9222`+token). Per-conversation = N ports ⇒ routing work (chunk 3).
- Mirror `src/spine/warm-sessions.mjs` (lazy open, idle-evict, never-evict-while-busy, cap) for
  the Chrome pool.
- **Conversation slug**: the dir name under `.egpt/conversations/whatsapp/<slug>` (e.g.
  `Reinie Alvino-2607150057`); state already carries `conversation_path`.

## Chunks (ordered; each: dispatch → verify → commit → deploy)

1. **Profile resolver keyed by conversation** [FOUNDATION — safe first step].
   `chromeProfileOf(cfg, conversation)` → `<profiles-root>/<slug>`; the admin conversation
   (matches `admin_channel`) → `brain`; safe fallback to today's behavior when no conversation
   is given. One function + its one caller (`ensureChrome`). Reproduce-first test. NET small.
2. **Per-profile Chrome pool + memory-bound admission** [BIG].
   Pool keyed by **profile** (one Chrome per distinct `--user-data-dir`; the shared `brain`
   serves all non-dedicated conversations, each dedicated profile gets its own). `ensureChrome`
   takes the conversation, resolves the profile (shared vs dedicated per decision 2), and:
   per-profile single-flight, per-profile running-check, lazy launch on **any free port** (ask
   the OS / scan), recorded `profile → {port, pid}`. Never launch a profile already up
   (single-instance per `--user-data-dir`). **Deterministic memory admission** before launching a
   profile not yet up: a PURE decision function over (available physical memory, an estimated
   per-Chrome cost, a safety margin) → launch / evict-idlest-then-retry / decline. The per-Chrome
   estimate is deterministic — the measured working set of an existing managed Chrome if any, else
   a configured constant. Seam the OS-memory probe + the per-process RSS read so the decision is
   unit-testable. Evict the idlest managed Chrome under memory pressure (profile dir persists, so
   a later turn relaunches still-logged-in). Mirror `warm-sessions.mjs`' lazy-open /
   never-evict-while-busy shape. The shared/`brain` Chrome is the default path and should not be
   starved by admission (admission gates the EXTRA, dedicated Chromes).
   **Built (uncommitted) 2026-10-09. The memory-admission (`chrome-pool.mjs`), the dedicated/shared
   policy and the per-profile pool/single-flight are KEPT; its free-*port* launch is SUPERSEDED by
   pipe (3b) and is NOT committed on its own — it lands reworked to pipe together with 3b.**
3a. **Pipe CDP transport** [FOUNDATION for pipe]. Teach the CDP client to speak CDP over a
   `--remote-debugging-pipe` fd pair (delimited JSON on fds 3 & 4), alongside the existing
   HTTP/`/json`+WS-to-port transport. A new transport module + a `cdp.mjs` path that selects it.
   Unit-test against a fake pipe peer (no real Chrome). Standalone — does not touch chunk 2's files.
3b. **Pipe launch for dedicated Chromes + wire the pool.** `chrome-launcher` gains a pipe launch
   (`--remote-debugging-pipe`, spine holds the fds, direct-spawn only); rework chunk 2's
   `_ensureDedicatedChrome` from free-port to pipe; the pool registry records the pipe handle, not a
   port. Commit chunk 2's kept pool/admission + this together (first committed dedicated launch is
   already pipe — no port code enters history).
3c. **Route a being to its conversation's pipe-Chrome.** The being's browser calls reach ITS
   conversation's spine-held pipe (never a port). Beings get no address to another Chrome.
4. **Login + browser tools follow the conversation profile.** `loginProfilePath` /
   `readCredential` (`boot.mjs:2992-2996`) and `browser-tools.mjs` keyed by conversation.
   Depends on chunk 1.
5. **Session confirmation.** Dedicated-pipe Chromes are Session-1 direct-spawn only (fd
   inheritance); confirm reve / dolly session at deploy time. The shared `brain` on `:9221` is
   untouched here; its migration off the port is a separate follow-up (decision 6).

## Risks / constraints

- **RAM**: N Chromes (~hundreds of MB each). No fixed cap — the deterministic memory-admission
  (decision 3) is the bound: launch only while a new one fits, evict the idlest under pressure.
  Most conversations share one Chrome, so the live count is 1 (shared) + the few active dedicated
  ones. Dedicated Chromes have NO port — CDP rides a spine-held pipe (decision 6), so there is no
  listening socket to count, leak, or hijack; that is what makes "one conversation can't drive
  another's Chrome" true by construction.
- **Single-instance per `--user-data-dir`**: a profile opens in only one `chrome.exe`; the pool
  must never relaunch a profile already up (the per-profile running-check handles it).
- **Pipe needs fd inheritance ⇒ Session-1 direct-spawn only.** The spine must spawn the dedicated
  Chrome itself to hand it fds 3 & 4; the Session-0 frozen-task hop cannot. Confirm node session.
- **User-context wrinkle** (`being.mjs:7`): a Chrome started in the wrong user context comes up
  logged-out — the per-conversation launch must use the same user context as today's `brain`.
- **Migration**: existing conversations share `brain` today; after chunk 1 each resolves to its
  own (empty) profile on next launch. The admin conversation keeps `brain`. No auto-migration of
  other creds — you sign in per-profile as needed.

## Not in scope (yet)

- Being-autonomous profile-creation policy; per-conversation proxy security (per-conv LAN token)
  beyond what chunk 3 needs.
