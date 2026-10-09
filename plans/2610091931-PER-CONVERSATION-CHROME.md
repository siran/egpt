# Per-conversation Chrome profiles

**Operator go: 2026-10-09.** Each conversation gets its own Chrome profile + process.
Whatever is signed into one conversation's Chrome (Gmail, ClassDojo, …) is invisible to
every other, because each has its own `--user-data-dir`. Ends "my Gmail is shared with all
my conversations." A conversation launches its own Chrome, and that Chrome is tied to it.

## Decisions (operator-approved 2026-10-09)

1. **Profile permanent, process pooled.** `chrome/profiles/<conversation-slug>` persists on
   disk (sessions / cookies / saved passwords survive). The `chrome.exe` is a warm-pooled
   resource: lazy-launched on first browser need, idle-evicted after a TTL (relaunch comes up
   still-logged-in from the persisted dir), capped at a max concurrent. "Tied to the
   conversation" = the *profile* is permanent; the *process* comes and goes.
2. **`brain` stays the admin profile.** The existing `brain` profile (holds Gmail / ClassDojo /
   AWS today) is assigned to the ONE designated admin conversation — reuse the existing
   `admin_channel: eGPT Admin`, no new key. Every other conversation starts clean: no Gmail
   until it is signed in there.
3. **Login follows the conversation.** `/login` and the credential read use the CONVERSATION's
   profile, so a conversation can only log into sites whose creds are saved in its own Chrome.

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
2. **Per-conversation launch + warm-Chrome pool** [BIG].
   `ensureChrome` keyed by conversation: per-conversation single-flight, port allocator (a
   range), per-port running-check, lazy launch (direct-spawn seam with that port+profile),
   idle-evict the *process* after a TTL (profile dir persists), max concurrent (LRU). Mirror
   `warm-sessions.mjs`. Never launch a profile already up (single-instance per `--user-data-dir`).
3. **CDP routing per conversation.** Resolve the being's `cdp` host/port for ITS conversation
   (`EGPT_CDP_HOST` per being process, or `cdp-proxy` routing by conversation).
4. **Login + browser tools follow the conversation profile.** `loginProfilePath` /
   `readCredential` (`boot.mjs:2992-2996`) and `browser-tools.mjs` keyed by conversation.
   Depends on chunk 1.
5. **Session coexistence + the frozen task.** Per-conversation needs direct-spawn; keep the
   frozen `:9221` task for the admin/`brain` profile, or document the Session-0 limitation.
   Confirm reve / dolly session at deploy time.

## Risks / constraints

- **RAM**: N Chromes (~hundreds of MB each). Pool cap + idle-evict bound it — start at **max 3–4
  live**, idle TTL **~10–15 min**.
- **Single-instance per `--user-data-dir`**: a profile opens in only one `chrome.exe`; the pool
  must never relaunch a profile already up (the per-profile running-check handles it).
- **Session-0 frozen task** can't do per-conversation (no args) — Session-1 only.
- **User-context wrinkle** (`being.mjs:7`): a Chrome started in the wrong user context comes up
  logged-out — the per-conversation launch must use the same user context as today's `brain`.
- **Migration**: existing conversations share `brain` today; after chunk 1 each resolves to its
  own (empty) profile on next launch. The admin conversation keeps `brain`. No auto-migration of
  other creds — you sign in per-profile as needed.

## Not in scope (yet)

- Being-autonomous profile-creation policy; per-conversation proxy security (per-conv LAN token)
  beyond what chunk 3 needs.
