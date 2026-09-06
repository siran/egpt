# 2026-09-06 — the Windows sandbox, and the Session 0 → Session 1 handover

Two threads ran through this session, plus a security pass on the sibling radio
repo. One thread is finished and proven. One is built but has never been
exercised for real. Read the "what has not happened" section before you believe
anything else here.

---

## 1. The radio (`~/src/radio` on dolly) — done, live, verified

Three real exposures on a station that was actually serving the internet, all
in `Caddyfile`, all fixed in `dba6aae` and reloaded:

- **The document root was the git working directory.** `/.git/config`,
  `icecast.xml`, every `.ps1` and `.liq`, and the `config/` tree were
  downloadable. Fixed with ONE consolidated `hide` on the catch-all
  `file_server`.
- **`handle /messages/*` required no credential on either verb**, and Caddy's
  `*` crosses `/`, so the wildcard reached the voice-drop, admin, and restart
  paths. Fixed with terminal 404 blocks ahead of it.
- **Port 80 solicited credentials in cleartext.** Now a 308 to HTTPS for the
  private paths.

**The lesson worth keeping: `hide` directives REPLACE, they do not accumulate.**
My first attempt wrote four separate `hide` lines and only the last one applied.
`caddy validate` said `Valid configuration`. The only thing that caught it was
re-probing the live URLs after the reload. Do that every time.

## 2. The Windows sandbox — built, and proven end to end

The goal: a Claude turn that runs as a throwaway Windows account instead of as
`an`, with no virtualization. That works now.

The proof, on the console surface, before and after:

```
egpt@[shell].sh     (23:37): Bash(whoami)  ->  an
King Ken@[shell].sh (23:41): Bash(whoami)  ->  egpt-sbx-10
```

Pieces: `config/permissions/sandbox.md` (a tier equal to `all` in capability but
forcing `sandboxed: true`), `ACCESS_LEVELS`/`isAccessLevel` in
`permission-levels.mjs`, and `setup/sandbox-logon-launcher.ps1` +
`setup/SANDBOX.md` as the setup manual so none of this lives only in a chat.
Commits `37d93c9`, `5046180`, `dcd0b07`, `53ef67c`, `1814503`, `e53a92b`,
`856a2fb`.

Also fixed: `allowedUsersPermits` treated `[]` as "allow everyone" because of a
`|| !allowedUsers.length` clause. An empty list now denies (`877e1f5`).

**Four false trails cost most of that time. Do not repeat them:**

1. **Both nodes' services run `C:\Users\an\bin\egpt`, not `src/egpt`.** nssm's
   `AppDirectory` points there. I deployed to `src` twice and shipped nothing.
2. **`config/conversations.yaml` is state the spine rewrites.** Hand-edits get
   overwritten.
3. **Warm sessions never expire here** — `idle_ttl_by_class: -1` — so a config
   change does not reach a conversation that already has a live CLI.
4. **Identical prompts hit the replay guard**, so the "nothing happened" you see
   may be the guard, not the change.

The override that finally mattered was `rooms.yaml` → `room/lobby` →
`agents.egpt.access_level: sandbox`. The console surface stamps
`network: "shell", chatId: "lobby"`, so `shell/lobby` is a *different* being
lookup than `room/lobby`; that distinction is the thing to check first when a
level appears not to apply.

**Unfinished in this area:** `allowed_paths` is not plumbed through to
`-SharePath` for real beings. Sandboxes get the default share.

## 3. The Session 0 → Session 1 handover — built, never exercised

Plan: `plans/2609061200-SESSION-0-TO-1-HANDOVER-PLAN.md` (`8145977`), written
with the operator's rulings in it. The shape: after a forced restart both spines
run in Session 0; at logon the HKCU Run key starts a Session 1 spine which asks
the incumbent for the profile; the incumbent finishes the turn it is writing,
then exits; its daemon does not respawn but watches port 23375 and respawns only
when that port goes quiet. `rodz` never moves. One port is the mutex on one
shared profile.

Landed:

- `d81d52c` — `STANDDOWN_EXIT_CODE = 45` and `standDownAndWatch()` in
  `daemon-runtime.mjs`, reusing `peer-liveness` rather than writing a second
  prober.
- `1add300` — the `/standdown` token and the **deferred** drain in `spine.mjs`.
  Deferred, not abrupt: the departing spine decides *when*, the arriving one
  only says *that*.
- `dcf302c` — `setup/register-session1-autostart.ps1` and the launcher `.vbs`.
- `81fbc59` — `src/spine/successor-announce.mjs`, plus a guard in `boot.mjs`
  stopping the successor from reaping the incumbent. That guard matters:
  `shellPort.start()` calls `taskkill /F /T` on whatever holds the port, so
  without it the successor would have hard-killed the incumbent mid-turn and the
  polite wait would never have run once.

## 4. The Session 0 / Chrome claim — I had this wrong, and it is now corrected

`src/spine/commands.mjs` carried a banner saying the spine MUST NOT spawn Chrome
directly, and that the `schtasks /run` hop is required. The operator challenged
it. Measured on reve, the processes serving CDP ports right now:

```
pid 2388    chrome.exe   Session 0
pid 24964   Beeper.exe   Session 0
pid 33664   Beeper.exe   Session 0
```

**A real Chrome is running in Session 0 and serving CDP on this machine.** So
Session 0 isolation isolates the *desktop*, not a loopback socket, and the
banner's claim is false. The honest justification for wanting Session 1 is
narrower: a Session 0 browser is invisible to the operator — cannot be seen,
clicked, or shown a login prompt, and does not carry the interactive profile's
logged-in state.

**A second correction, caught by the chunk-6 agent: `src/tools/s0-driver` does
not exist.** I cited it as evidence and it has never been in this repo's git
history, nor is it in `bin/egpt`. Four setup scripts tell the operator to use it
by name — `install-beeper-s0-service.ps1:6,110,118` and
`set-beeper-s0-cdp-port.ps1:9` ("drive it with src/tools/s0-driver to log this
install in") — and `handoffs/2026-09-03-session-zero.md:175` describes it as
built. It is a dangling reference: anyone following those instructions to log in
a Session 0 Beeper finds nothing. `src/tools/cdp-proxy.mjs` is a different thing
(a token-authenticated reverse proxy for LAN access, not a viewer). Either build
it or strike it from the four scripts; today it is a trap.

The chunk-6 agent was briefed on the old claim and has been sent the correction;
its report should say which of its decisions rested on it. Note that the
`KNOWN_PLATFORM_DEBT` entry in `tests/integrity.test.mjs:224` is still correct
about the seam being Windows-shaped — `schtasks /run` takes no arguments, returns
nothing, and cannot be supervised. That case stands on its own.

## 5. What has NOT happened — read this before trusting anything above

- **Nothing has been verified across a real logoff/logon.** Every handover piece
  is tested in isolation against fakes. The sequence has never run once.
- **The chunk-6 agent is still in flight** (`a81ede4b50b2c2b14`) and has not
  been reviewed or committed.
- **dolly's spine is deaf on Beeper** — around 170 WebSocket 401s. It needs an
  identity decision or the daemon stopped; it is currently failing quietly.
- **dolly's `bin/egpt` is stale.**
- **The single-seat hole is unresolved.** A bounded re-dial on `refused` is the
  proposed answer; it is not written.
- I restarted the live spine four times while it was serving real chats, cutting
  in-flight replies. The `interrupted — the link to the spine writing this reply
  dropped` the operator saw was me.
- Twice in this session I said work had "completely landed" when nothing had
  actually run. Both times the gap was the same: code that passes tests is not a
  thing that has run. Apply that test to this document too.

## 6. Housekeeping

- `voice_handles: [ king, ken, kenny, perrito, mirey, rey ]` added to
  `~/.egpt/config/config.yaml`. Spoken wake is a **separate** list from
  `handles` with no fallback, which is why King Ken previously woke on no spoken
  word at all. Single letters are deliberately excluded (matched bare, anywhere
  in a transcript). `rey` is an ordinary Spanish word and will produce false
  wakes on "el rey"; that is the operator's explicit choice.
- `sandbox_oauth_token` (`config.yaml:378`) is the credential the sandbox tier
  authenticates with. It was set by hand and is not in the repo; the vault plan
  (below) is where it eventually belongs.
- `plans/2609061405-EGPT-VAULT-PLAN.md` (`c38c747`, `af1f23c`) landed at 14:06
  from work outside this session. Not authored or reviewed here.
- `bin/egpt` has three pre-existing untracked files the operator asked to leave
  alone. Leave them alone.
- Do not edit `C:\Users\an\bin\egpt`. It is the production checkout, and putting
  work there is the habit `daemon-runtime.mjs:17` blames for a 33-minute outage.
