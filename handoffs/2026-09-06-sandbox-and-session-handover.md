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

**A second correction, now itself corrected: `src/tools/s0-driver` DOES exist.**
I reported it missing and committed that. It lives under the operator's own src
tree (`src/tools/s0-driver`: `s0-driver.cmd`, `s0-driver.html`, `serve.mjs`) --
I searched only the egpt repo's own `src/tools/` and resolved the setup scripts'
path against the wrong tree. The four scripts naming it were right all along.
The lesson is the one the operator named twice tonight: a path in a comment is a
claim to verify, and "I could not find it" is not "it does not exist".

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

---

# Later the same day — the sandbox actually went live

Everything above was written mid-session. What follows landed after it and
changes the picture, so read this half second.

## 7. The mouth: chat type leads the cross-account key (`be8535e`)

King Ken answered from An's own account in the WhatsApp group `An y Dando`. The
peer link did not fail — it **refused**, and correctly: membership alone cannot
separate a group from the 1:1 nested inside it, so the key floor was two, and
the smallest real group there is (both accounts plus one person) could not be
keyed at all. Adding the second account is precisely what broke it.

Folding the chat `type` in fixes it: measured on both endpoints, An sees the
group as `!JwvpZvGK8H8DLDuPa89w`/`498` and Rodz as `!lHZ44tI32W0eEtbwMutM`/`18`
— ids are per-account and useless — but both independently report `type=group`.
Beeper exposes no WhatsApp group JID anywhere on the payload, checked field by
field, so there is no truer key. Verified live after deploy: both accounts now
derive `group,#34658515045`, the 1:1 still refuses.

**The presence gate was never the problem.** `route()` in `boot.mjs` hands the
reply to the peer the moment `chatHasParticipant` says it is in the chat. Rodz
in the chat means Rodz answers, unconditionally. Only the addressing under it
was broken.

## 8. Sandbox everywhere except wren — live, on 38 conversations

`egpt` and `pi` now carry `access_level: sandbox` at the agent default, and the
27 per-conversation overrides were **removed** rather than rewritten, so future
changes to the default propagate instead of needing another sweep.
(`conversations.yaml` backed up to `conversations.yaml.bak-160007` first.)

Two agents could not move, and neither is a policy call:

- **`llama` (L)** — `sandbox-cli-session.mjs:64` throws on any engine but
  `ccode`/`codex`/`pi`. L is HTTP: no process to confine, and the tier is fatal.
- **`codex` (C)** — authenticates from `CODEX_HOME`, which a pool account cannot
  read, and `-SetEnv` carries exactly one credential (`CLAUDE_CODE_OAUTH_TOKEN`).
  C needs its own credential first; then it is a one-line change.

`carol`/`cara`/`don` are relays with no local brain. **wren stays `all` and
unsandboxed** — the deliberate exception.

**The cost, stated:** E no longer reaches the operator's own files anywhere,
Self included. That was the other half of the old `sandboxed: false`.

## 9. Brain power aligned (both nodes)

`kg` was opus/medium and `kg2` was **sonnet**/high — so one being thought
differently depending on which mouth spoke, which became visible inside a single
conversation once Rodz started answering. Both are now **opus/high**; wren keeps
xhigh. The superseded 2026-08-26 ruling is preserved in `egpt.yaml`: `high` costs
extended thinking on every ordinary turn and measured ~1 min per reply in a busy
thread. If latency becomes the complaint, move the effort line, not the model.

## 10. The "/login x16" — diagnosed, and it was already fixed

The operator was logging in repeatedly. Sixteen times, one per pool account.

Cause, from the config backups: `bak-guard-0905` (Sep 5 16:27) has **no**
`sandbox_oauth_token`; `bak-king-0906` (Sep 6 00:31) has it. Before that token
existed a sandboxed turn had no credential at all — fresh account, wiped profile,
nothing to authenticate with. The relief was invisible because until 16:01 only
3 conversations were sandboxed, so almost no pool account had ever run a turn
*with* it. Proven on a virgin profile: `CLAUDE_CODE_OAUTH_TOKEN` set, `claude -p`
returns `OK`, exit 0, no prompt.

**The two credentials are separate and must stay separate.** The console's
`~/.claude/.credentials.json` holds a refresh token and rotates itself ~12h; the
service accounts get a static token injected per-turn as an env var. They cannot
be one, because the pool accounts are denied `~/.claude` by the very ACLs that
make the sandbox a sandbox. They do not fight — the sandbox token still returned
200 after the operator's own `/login`.

**THE CLIFF, and it is the real argument for the vault plan:** the sandbox token
**cannot refresh itself**. When it expires all 16 accounts fail at the same
moment, with no warning, and it will look exactly like the x16 night.

## 11. Chrome logins were dying for a different reason — DPAPI

Not the profile wipe. The brain profile is at `.egpt/chrome/profiles/brain`,
outside every wiped location, and its ACL grants only SYSTEM, `an` and
Administrators — no pool account has any access at all.

It is **DPAPI**: `Local State` -> `os_crypt.encrypted_key` is a 293-byte blob that
`ProtectedData.Unprotect(CurrentUser)` decrypts as `an` **and as nobody else**.
Any Chrome launched by a pool account against that profile sees undecryptable
cookies: silently logged out, no error. E's browsing works today only because it
**attaches over CDP** to a Chrome that `an` already owns — loopback crosses
account boundaries freely, the same property `auth.mjs` exists to warn about.

**This makes chunk 6 (`bc81267`) dangerous as written.** A Session 1 spine
spawning Chrome as an ordinary child spawns it as the *pool account*, which can
neither read the brain profile nor decrypt its cookies. It is committed but has
never run. **Guard it before it does.** The shape that works is the one running
now: one stable account owns the browser, sandboxed beings attach over CDP.

## 12. Sticky pool leases (`25e0dab`) — deployed, and confirmed on first use

The launcher took the first free pool account, so a conversation drew a different
Windows account every turn. That is fatal for per-conversation browser profiles,
per section 11. Now the account the conversation's folder hashes to is tried
first, the rest follow shuffled, and a busy preferred account falls through
normally — one stuck lease must never wedge a conversation out of running.

Only the walk ORDER changed; `CreateNew`, the stale-lock exclusive reclaim, and
the handle-that-is-the-lease are byte-identical.

Verified: same folder -> same account across three processes and three path
spellings; 398 live folders spread over all 16 accounts (14-39 each); fallback
takes five different accounts when the preferred one is held. vitest 3857/175,
Pester 14/0. **Confirmed live:** `egpt-sbx-00.lock` at 19:26, after the 19:16
deploy, which is exactly the account HFM hashes to.

## 13. What is STILL not done

- **The S0 to S1 handover has still never run across a real logoff/logon.**
  Unchanged from section 5. Do it when dolly is healthy.
- **Guard chunk 6** so a sandboxed spine cannot spawn Chrome onto the brain
  profile (section 11). This is the highest-value next task.
- **Per-conversation Chrome profiles + per-conversation CDP ports** — the operator
  wants both. Sticky leases were the precondition and are now in. Note that the
  profile split is NOT a security boundary: the CDP port has no auth
  (`cdp.mjs:6`) and loopback is not an authenticator, so any sandbox can reach
  any other conversation's browser. Contention and cookies-at-rest are the real
  wins; write that down rather than implying isolation.
- **`CLAUDE_CONFIG_DIR` per conversation** — would make a resumable thread belong
  to the conversation instead of an account, surviving wipes and account
  rotation. The string exists in the installed `claude.exe`; behaviour unverified.
- **dolly**: still deaf on Beeper (~170 WS-401s), `bin/egpt` still stale.
- **`codex` needs its own sandbox credential** before it can join the tier.
- **`src/tools/s0-driver` still does not exist**, and four setup scripts still
  send the operator to it.
