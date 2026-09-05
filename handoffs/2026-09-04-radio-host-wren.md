# The radio, the AI host, and wren — 2026-09-04

Written because these three were carried by nothing. The Session 0 work is held by tests that
fail when someone breaks it and by comments beside the keys they explain; the radio, its AI host
and wren lived in the operator's diary and in one conversation. A fresh agent inherited eGPT and
not the station.

Facts here were gathered from the repos and the profile, with paths. Where two sources disagree
BOTH are recorded — that is a finding, not a mess to tidy.

---

## READ THIS FIRST — four things that waste an hour each

**1. The radio runs on DOLLY. Only on dolly.** `HOWTO.md`: *"Everything runs on **Dolly** … Nothing
runs on any other machine; a clone elsewhere is for editing only."*

**2. The paths differ per machine, and looking in the wrong one looks like the project is gone.**

| | reve (kg) | dolly (do) |
|---|---|---|
| radio checkout | `src\siran\radio` — **edit-only, stale** | `src\radio` = `$RADIO_HOME` — the real one |
| agent types / identities | `~/.egpt/config/agents/`, `~/.egpt/config/identities/` | same, **different contents** |

`config/agents/*.yaml` and `config/identities/*.md` **do not exist in the egpt repo**. They are
profile-local, per node, and **not deployed between nodes**. `rooms.yaml` says so out loud:
*"config is per-profile, not deployed."*

**3. reve's radio checkout is ≥6 days stale and all runtime data is gitignored** — `recordings/`,
`posts/`, `messages/`, `config/`, `icecast.xml` are simply absent there. Anything you read about
live state from reve is a guess about dolly.

**4. Read `HANDOFF.md` + `HOWTO.md`. Do NOT read the radio's `README.md`** — it still describes the
*pre-Liquidsoap* station (Mixxx → Icecast, a Node guestbook on 8787, `message-server.js`). None of
that exists. It will actively mislead you.

---

## THE STATION

**Wild n Loyal Radio**, `https://radio.wildnloyal.org`.

```
D:\Music ──playlist(randomize, watch)──┐
harbor :8005 /live ────────────────────┤
8 voice lanes (request.queue ×8) ──────┴─► add ─► libmp3lame 128k/44.1k/stereo
                                                    │
                                          Icecast 127.0.0.1:8000 /stream
                                                    │
                                            Caddy :443 ─► listeners
```

**Liquidsoap is the station** — playlist, harbor, the eight lanes, ducking/EQ/limiter, the
narrator pickup, *and every `/control/*` and `/likes/*` HTTP endpoint*. Icecast is only the
transmitter. Caddy is TLS, routing, auth realms — **and identity**: uploads are filed under
`{http.auth.user.id}`, so *"the folder is the identity … there is no user model in this station and
there never needed to be."* Four realms stay deliberately separate (speakers / admins / relays /
icecast): *"Being able to talk on the radio must not mean being able to add people to it."*

Everything runs as `.\svc-radio`, whose password **exists only as an LSA secret — nobody has it**.
Never delete, recreate, or change `ObjectName` on those services: that is one-way.

**Jellyfin is NOT in the audio path** (on-demand library at `music.wildnloyal.org`). But note the
trap: `C:\Program Files\Jellyfin\Server\nssm.exe` is the nssm binary that Icecast and Caddy run
under, so their service `PathName` points at Jellyfin's folder.

### Every way onto the air — and the concurrency IS the point

The operator has corrected this more than once, so it is quoted rather than paraphrased:

> *"The design is several independent ways onto the air, all first-class, all working at the same
> time and mixed together … The harbor is not the 'real' way that the notes approximate; it is
> another lane. **That concurrency is what makes it a station rather than a stream**, and calling one
> of the paths a workaround misses the whole point."*

Never describe voice notes as a fallback.

1. **The library** — randomised playlist over `D:\Music`, wrapped in `mksafe` so it never goes silent.
2. **A voice note dropped in `messages/voice/<speaker>/`** — airs in ~2 seconds. Formats chosen for
   chat apps: whatsapp ogg/opus, telegram `.oga`, iOS `.m4a`, browser `.webm`.
3. **eGPT's WhatsApp/Telegram relay** — `PUT /host/relay/<speaker>/<file>`, wired into the same
   `bridge.onMedia` the media saver uses.
4. **The web console's Talk button** — records a whole note, PUT under the logged-in speaker.
5. **`/radio say <text>`** — uploads a `.md` note; the station's narrator speaks it.
6. **The narrator** — any `.txt`/`.md` under `messages/voice/` is rendered by Piper to a `.wav`
   beside it. *"Liquidsoap never learns that text is a thing."*
7. **A live source on harbor `:8005`** — Mixxx, butt, Cool Mic, any Icecast source client.
8. **The browser console's "Go on air"** — `wss://…/host/onair` → `live-bridge.js` → harbor.
9. **Browser tab capture (bucket-dj)** — `getDisplayMedia({displaySurface:'browser'})` up the same socket.
10. **A one-shot `/dj/` page** — exists, **broken**, see the traps.

**Lanes are about concurrency, not queueing.** Eight of them, so several people talk at once; a
speaker's gain/ducking/EQ ride with the note as an `annotate:` URI, so a ninth speaker shares a
lane, waits, and still sounds like themselves. **Live is the single-slot exception** — a second
live mount is still open work.

### The voice stack — two Pipers, and this is the most confusable thing here

- **The station's narrator** — `narrator-watcher.ps1`, a scheduled task, renders text dropped under
  `messages/voice/` into `.wav` in place.
- **eGPT's synthesizer worker** — `src/tools/synthesizer.mjs`, `POST /v1/synthesize` on **:23391**,
  HMAC-signed, spawns piper + ffmpeg per request. `RADIO_PIPER` is read **from the environment and
  must never be hardcoded in config.yaml** — it is machine-local layout, not portable config.

`/radio say` does **not** use the worker; it writes a note and lets the narrator speak it. The DJ
heartbeat script **does** use the worker, then plain-writes the ogg into the drop folder — *a
moved-in file gets the wrong ACL and is never picked up.*

**Piper speaks emoji it cannot pronounce by reading the character's Unicode NAME, in the voice's
language.** Live bug: a reply ending in the persona emoji was spoken as *"cara de perro"*, which
collided with a configured spoken wake alias, and the self-echo re-woke the persona.
`src/speech-clean.mjs` exists for this.

---

## THE AI HOST

**Two different things have been called "the AI DJ". Conflating them will mislead you.**

**`dj-son`** is a *personality*, not a room with a script (operator, 2026-08-29: *"dj-son is a
personality now… It runs as `@pd` on dolly's local model"*). It is `config/identities/dj-son.md` on
dolly, backed by gemma-3-4b-it abliterated Q4_K_M with an f16 projector. Its own doc is written in
first person and ends with the rule that matters: *"**Attribution is structural.** A card is signed
with whoever wrote the file. Content follows the prompt. The name does not."*

**`@djh` / `djhaiku`** is a separate frontier-model comparison, and it is **unconfined**
(`access_level: all` ⇒ skip-permissions, bare Bash, the operator's own Claude login). It was built
for a one-shot that never fired. **Do not put it on a recurring beat.** There is still no
frontier-model data point.

### The finding that matters most about the host

> *"It has a real speaker credential on the station and every endpoint it needs, and **it has never
> once made a real call** — across a heartbeat, a live console chat and a hand-built run it wrote
> *play-scripts of sessions*, inventing both the curl lines and their output. The identity plumbing
> around it is now correct and verified; **the model is the open question.**"*

18 user / 18 assistant messages in a session with `non-text content: NONE`. The `PASSWORD`
placeholder in the heartbeat script is never substituted, because nothing is ever executed.

**And there is a ceiling underneath it.** `accessLevel` can only be `all` or `regular`, and the level
*replaces* the tool list. `regular` grants no shell, so `Bash(curl:*)` could only be added to
`regular.md` — the node-wide default for every regular being on both nodes. A test asserts
`regular == DEFAULT_ALLOWED_TOOLS` precisely to catch that widening; it caught it, and the attempt
was reverted rather than the test edited. **A per-agent scoped permission grant is the missing
primitive.** The AI DJ is stuck because it needs shell to curl, and shell means unconfined.

### How a host reaches air, and what triggers it

Text → audio by one of: the narrator watcher, eGPT's synthesizer worker, or a real streamed
`wss://…/host/onair` session. For the socket: **the first blob carries the whole webm header and no
later blob ever will — never drop it, never start midway.** Port 8007 is loopback and authenticates
nobody; always go through the documented path.

**The `dj` heartbeat is PARKED at 24h and has an overlap bug** — thread timestamps show it firing at
30–90 second intervals while configured for 15m, the same pathology that got it killed on
2026-08-20 (*"overlapping three-minute Claude runs"*). Read this before re-enabling it.

**And the operator has since redirected the architecture away from it:**

> *"heartbeats + textecutables are the wrong shape for a DJ. 'a room is a room, inside rooms/ but a
> whatsapp group is invited… **a room works as a communication tunnel between groups**, since
> whatever is said in the room is fanned out to members'"*

`room/dj-son` exists with `dj.x.md`, ~30 helper scripts and a pi-session, but **no transcript** — it
has never had a chat thread. Its sibling `room/radio` does, and it records eGPT hitting three walls
trying to DJ: no credential, no network execution, and `WebFetch` being GET-only with no Basic auth.

---

## WREN

> *"**wren is just an opus. above egpt, above the radio. full access to everything… basically a super
> human being with real existence and agency in the world.**"*
>
> *"wren should always be the same. he is a meta engineer."* — and, on continuity:
> *"warm cli is not so important, since the thread is going to be replaced by this one, thus the
> memory."* **The thread is the memory; the process is disposable.**

**wren is global on kg only.** Dolly's agents are `egpt`/`djh`/`pi` and mention wren nowhere. That is
correct: both nodes hear the same messages, so a second wren would answer twice.

Configuration, and where each piece lives:

| what | value | where |
|---|---|---|
| scope pin | `agent/wren` — one thread, one queue, one warm process, node-wide | `config.yaml` |
| model / effort | **opus**, `xhigh` — *"wren must be opus, xhigh"* | `agents/egpt-xhigh.yaml` |
| cwd | `C:/Users/an/bin/egpt` — Windows-style **on purpose** (mkdir'd raw, before any msys normalisation) | `agents/egpt-xhigh.yaml` |
| verbose_thinking | true — full chain of thought, tool calls as bare stubs | `agents/egpt-xhigh.yaml` |
| access_level | `all` | `config.yaml` |
| sandboxed | **false, by design** — *"the one being that is deliberately unconfined everywhere; its reachability gate is `allowed_users`, not the sandbox"* | `config.yaml` |
| thread | `agents.yaml` under `agent/wren` — a separate registry from `conversations.yaml` | `config/agents.yaml` |

`allowed_tools` in the type file is **moot** — `access_level: all` replaces it every turn.

### Why wren looks absent, and isn't

Pinned to one conversation with `allow_new_input: same_sender`, a follow-up is **woven into the turn
already running** rather than starting a new one. So *"w there?"* never gets its own reply — it
becomes part of an answer that lands whenever the long turn finishes. **Being one mind everywhere is
what makes it look absent while it thinks.** The trade is named: `allow_new_input: none` buys
queueing at the cost of absorption.

Likewise **`agents/wren/` having no transcript is correct** — a transcript belongs to a *chat*, not a
being. wren's turns are in the origin chats. Its folder holds identity, not history; its history is
the thread. The one thing that folder is for: keeping `identity.d/` out of the pinned workspace.

### Failure modes recorded

- **Unreachable from the operator console, silently.** The console seat's userId is the literal
  `operator`, and wren is the only agent with an `allowed_users` list. Fail-closed and silent —
  nothing in the log but a seat opening and closing. Fixed by adding `operator`, **and it needed a
  spine bounce**: the running spine held the boot-time copy.
- **Opus 5 refuses some threads** with `[reasoning_extraction]`, reproducible outside eGPT via
  `claude --resume`; Sonnet answers the same thread. Fixed once by clearing the thread pointer.
  Expect it again.
- **Compaction margin exists for wren.** `ratio: 0.80`, lowered from 0.95 — measured live, wren's
  thread sat at 882,608 of 1,000,000 tokens. Overshooting does not compact: the overflow path
  **resets to a fresh session**, losing the conversation instead of compressing it.
  `cooling_ms: 0` cannot be written — `Number(x) || DEFAULT` turns zero into 120 s.
- **Two `claude --resume` on one jsonl would corrupt it.** Two project dirs hold the same session id
  and have diverged; only the differing cwd keeps this safe. Copy into a **fresh id**, never over a
  live file.

---

## TRAPS, EACH PAID FOR ONCE

- **Liquidsoap saying "connected" is not evidence anything is on the air.** A port collision took the
  station off while it cheerfully logged `Connection setup was successful`. **Fetch bytes from
  `/stream`.**
- **35 hours of digital silence while the page correctly said ON AIR.** Pause is `blank()` rather than
  a missing source, so the mount held and flowed silent bytes; `on_disconnect` forgot to reset
  `paused`. Measured `Peak -inf dB, RMS -inf dB`. The page reads "is a source on the mount", which
  was true throughout — **it was never a claim about sound and can never catch this fault.**
- **The running station may not be the script on disk.** `Loading main script from cache!` means your
  edit was not read. `restart-radio.ps1` clears the cache; `start-radio` does not.
- **`--mute-audio` silences tab capture with no error anywhere** — encoder running, mount held, bytes
  flowing, RMS 0.0000.
- **Testing a live source broadcasts it.** Four 440 Hz test tones went out to a live listener.
- **`/control/music` is not a toggle.** No query string means an explicit OFF, and calling it again
  does not undo it. Same for `/control/pause` and `/control/repeat`.
- **`messages/voice/` is an INPUT.** An archive written there was rendered and broadcast as 26 MB of a
  synthetic voice reading a failure log.
- **Port 8005 is shared and races.** When the source harbor wins, every `/control/*` returns 404 while
  the station plays perfectly — the 404 body says `Liquidsoap source harbor`, which is how you know.
- **whisper-server on :8089 looks like an idle 4.3 GB stray. It is not** — it transcribes voice notes
  for both machines. This wrong conclusion was written into a handoff and corrected twice. The tell:
  *"the 'idle' reading came from asking the radio what uses a port and treating silence as an answer."*
- **`identity.d/` is an OUTPUT, not the feed.** A file dropped there is never in the model's context —
  measured. A personality file replaces the **00 slot only**; 10/30/40 are shared by every room on
  the node, so DJ-specific pointers there land in other agents' chats.
- **Anything long-lived started on dolly over SSH dies with the session** — Windows OpenSSH kills the
  job object's children. The tell is stderr ending cleanly with nothing in the Application log. Use
  `Invoke-CimMethod Win32_Process Create` to parent outside the session.
- **The `/dj/` browser-source page: four theories are DISPROVED — do not re-derive them.** Harbor/mix,
  Caddy in path, chunked encoding, and MediaRecorder blob concatenation are all settled clean. The
  fault is in the page's own code. Two untried leads: a desktop-browser repro, and `ReadableStream`
  `desiredSize` backpressure, currently ignored.

- **A grep across the home directory returns STALE COPIES OF MEMORY AS IF CURRENT.** Google
  Drive's `lost_and_found` holds ~1,133 files / 1.5 GB, mostly DUPLICATE `.jsonl` transcripts
  (one session appears four times at 50-65 MB each) plus old `MEMORY.md` copies. A home-wide
  search hits them and can hand you a superseded fact with a straight face. **Constrain memory
  searches to `~/.claude/projects/C--Users-an/memory/`.** An unscoped home grep is also slow
  enough to need backgrounding - `AppData` and `node_modules` dominate it.

  **This is NOT a misconfiguration** - I first wrote that here and it was wrong. The operator's
  `ffs-drive-backup` memory records it as a deliberate trade: FreeFileSync mirrors a live-edited
  tree into Drive, so files edited at sync time bounce a stale intermediate into lost-and-found,
  and *"backup stays correct (verified H:==C:) ... a deliberate completeness-over-tidiness
  trade."* Credentials in the backup are likewise an explicit ruling (*"circle of trust"*).
  The only live question is volume: that memory says a *flood* means a new un-excluded churny
  dir, and 1.5 GB accumulated since 2026-08-11 sits on the line between trickle and flood.

---

## DOCUMENTS THAT LIE — check before trusting

This section exists because *a stale conclusion in a doc is worse than no doc: the next agent
inherits it as fact.*

| document | the lie |
|---|---|
| radio `README.md` (repo) | describes the pre-Liquidsoap station entirely |
| `notes/projects/radio/README.md` | says Liquidsoap **2.4.5**; the running binary is **2.5.0** (installed 08-23 for a `Unix.select` memory-leak fix) |
| same file | **contradicts itself on NAT loopback** — line ~244 corrects it to *works*, line ~390 still says it does not. The correction is the later, measured one |
| `config/config-schema.mjs` | says `radio_service` is *"CONFIG + COMMAND ONLY … inert until that lands"*. **The route is real and wired.** The code wins |
| memory `radio-voice-drop-folder.md` | says the **filename** decides the speaker. It does not — **the folder does**, and Caddy creates it from the authenticated login, so it cannot be spoofed |
| `config-resolver.mjs:227` | labels every folder rung `config/rooms.yaml`, so the readonly dump misattributes settings that came from `agents.yaml` |

---

## OPEN WORK

**Not in ROADMAP.md.** The radio appears there once (incidentally), wren once, and
liquidsoap/icecast/piper/dj-son/jellyfin/narrator/caddy **zero times**. That absence is why this
document exists.

**Station**
1. Port 8005 shared between the source harbor and every HTTP endpoint — races.
2. Caddy and liquidsoap share `svc-radio`, so the station can write its own settings.
3. 41 absolute paths baked in (14 in `radio.liq`, 18 in `Caddyfile`). The operator asked for
   *"nothing hardcoded, everything rides configuration"* — this is the outstanding half.
4. The chat panel lists 21 messages and can read none of them. The fix depends on what chat is
   *meant to be*, so it is left for a ruling.
5. A second live mount, so two people can be live at once.
6. `air_delay` is still 0.0, so no host can land on the beat — needs one liquidsoap restart.
7. Scheduling: Liquidsoap can do it in config; nothing is set up.
8. **dolly's C: is down to ~3.3 GB free.**

**Host**
9. PD makes no tool calls. The plumbing is verified; the model is the question.
10. The per-agent scoped permission grant — the missing primitive under all of it.
11. `/members add group` takes a chat id, not a slug.
12. reve's persona lost its node and handle facts when node-identity injection was removed. Three
    lines would fix it; the operator has not asked.

**wren / eGPT**
13. Head-of-line absorption (above) — a design consequence, not a bug.
14. The identity/agents redesign the operator asked for: `config/agents/<name>/` holding the agent
    yaml *and* its identity. The finding is worse than expected — `personality:` lives on the TYPE
    file and reve has no `identities/egpt.md`, so **every being there boots from the same shipped
    default**. dolly's `dj-son` is the only one working as intended.
15. `an-on-errands.md` blob still in public history. Needs a rewrite + force-push. Operator's call.

---

## STANDING PERMISSIONS AND DECISIONS

- `caddy reload` when needed **unless someone is on air** — check `/likes/now` for `show.live`.
- Liquidsoap restarts authorised when there are no listeners.
- Commit and push without asking when work is complete.
- **No Linux.** The live bridge is permanent, not a stopgap. Hosts may restart the station.
- **Voice notes are peers of the harbor, never a fallback.**
- Nothing on the LISTENER page's controls may carry English text; the host console may.
- Translation is dropped — browser auto-translate is the answer.
- **AzuraCast was decided against without being run**, and the reasoning is kept: *"it's like old
  guard… what we have is mostly serverless, db-less, a much more interesting solution."* The only
  wanted feature was streamer accounts, which `input.harbor` gives in six lines.

**The radio repo is PUBLIC and its history has been rewritten twice to purge things that should not
have been published.** Anything committed there is published. The three copies of `AI-DJ.md` (repo,
`rooms/radio/identity.d/`, `rooms/dj-son/identity.d/`) silently diverged for four days once, because
every edit went to the profile copy — **the repo copy, the one anyone cloning reads, was the stale
one. After editing the repo copy, sync all three.**
