# egpt — the Session 0 → Session 1 handover

**Status:** design, decisions taken 2026-09-06 — nothing implemented. Written to be chopped into dispatchable
chunks; every chunk below carries its own verification.

---

## The idea

After a forced restart, this node runs **two Session 0 spines**: `an` and `rodz`.
When the operator logs in, `an`'s spine **moves to Session 1** — same profile
directory, same threads, same transcripts — and moves back to Session 0 when the
session ends.

The reason is not tidiness. A spine in Session 1 can **spawn and supervise a
browser as an ordinary child process**. Today it cannot, because a service's
child inherits Session 0's isolated desktop, and the workaround is
`spawnSync('schtasks', ['/run', '/tn', CHROME_LAUNCH_TASK])` — which this repo's
own integrity scan already files under `KNOWN_PLATFORM_DEBT`
(`tests/integrity.test.mjs:224`), noting *"it is the launch SEAM that is
Windows-shaped."*

Task Scheduler is a poor seam for a second reason the note does not mention:
`schtasks /run` is fire-and-forget. No return value, no error, **no arguments** —
the command line is frozen at registration, so a different port or profile means
re-registering the task — and no supervision, so the spine can never learn
whether the browser came up, on which port, or whether it died. Meanwhile this
node already has an authenticated, streaming, orphan-settling inter-spine channel
on loopback. Running Task Scheduler beside it is two mechanisms for "make
something happen in another session," and the worse one is in the runtime path.

## The constraint that shapes everything

The two spines **share one `EGPT_HOME`**. That is the point — it is what makes
the handover seamless rather than a migration. It is also what makes overlap
fatal:

| shared | what two live spines would do to it |
|---|---|
| the Beeper token | two WS connections, every message ingested twice, two answers |
| `config/conversations.yaml` | both writing state, last-writer-wins |
| console port 23375 | the second to start cannot bind |
| `state/ingest/` | both consume, one wins the race |

So: **exactly one spine holds the profile at any moment.** This rules out the
other muting design already in the tree — `unless_peer_alive`, which keeps both
alive and silences one — because that assumes two *separate* profiles, which is
what `kg` (`.egpt`) and `kg2` (`.egpt-secondary`) are today.

## Detection is the wrong problem

The obvious framing is "how does the Session 0 spine detect a logon" — and every
answer to that is a Windows API or a polling loop
(`WTSGetActiveConsoleSessionId`, `qwinsta`, watching for `explorer.exe`), which
is the same platform-shaped debt in a new place.

It does not need to detect a logon. **The logon is already a trigger**, delivered
by the thing that runs at logon anyway. `ROADMAP.md:1378` records that Beeper
itself starts this way — *"Beeper starts at LOGON via the HKCU Run key."* The
Session 1 spine starts the same way. Nothing in `src/` calls it, it needs no
privilege, and it has a first-class equivalent on every platform: a `launchd`
LaunchAgent, a `systemd --user` unit.

What the Session 0 spine needs to know is not *"has someone logged in"* but
*"has my successor taken the profile"* — and this repo already answers that class
of question. `src/spine/peer-liveness.mjs`, written 2026-09-02 for exactly this
topology, says it plainly:

> *"'is my peer alive?' is a LOCAL OBSERVATION, not a protocol. One spine probes
> the other's console port. No messages, no election, no split-brain algorithm to
> get wrong."*

and its asymmetric hysteresis is already the right way round: believing the peer
is alive when it is dead costs silence; believing it dead when alive costs a
double answer.

## The sequence

```
forced restart
    Session 0: an-spine (holds .egpt)   +   rodz-spine (holds .egpt-secondary)
    no browser is possible — nobody is logged in, so nothing is lost

logon
    HKCU Run  →  starts the Session 1 spine
    it writes a STAND-DOWN token into the shared state/ingest/
      then waits on 23375, which shell-port already retries with backoff
    the Session 0 an-spine (already polling that box every 1s) reads it and marks
      the stand-down PENDING — it does not exit yet
      · stops accepting new turns
      · finishes the turns it is already writing
      · then releases the port and exits with the new lifecycle code
    its daemon does NOT respawn; it begins probing 23375
    the Session 1 spine's next retry binds, and it holds the profile

logoff / crash   (NOT lock — the operator is still there)
    the Session 1 spine dies with the session
    23375 goes quiet
    the daemon observes that and respawns the Session 0 an-spine
```

`an` is the only thing that moves. `rodz` never leaves Session 0, and the
inter-spine channel means the node keeps a foot in each world throughout —
a browser and a desktop on one side, something that survives a reboot on the
other.

## What already exists

- `src/spine/peer-liveness.mjs` — the probe, the hysteresis, the reasoning.
- `src/spine/ingest.mjs` — a polled box, write-temp-then-rename, consumed once.
- `src/daemon-runtime.mjs` — a supervisor with a lifecycle vocabulary
  (`42` upgrade, `43` restart, `44` rewind) and a backoff ladder.
- `src/bridges/shell-port.mjs` — holds the console port from boot, backs off and
  retries when the bind fails, so the arriving spine waits rather than dying.
- The HKCU Run key, already the logon mechanism for Beeper on this machine.

## What is new, and it is small

**1. One lifecycle verb.** `ingest.mjs` knows exactly three tokens today
(`:73-79`). Add a fourth — a stand-down — carrying the port to watch.

**2. One daemon branch.** The existing codes all respawn;
`CLEAN_EXIT_CODE = 0` is not reusable, because `daemon-runtime.mjs:514` treats it
as *"user wanted out"* and stops the daemon entirely. The new code means: **do
not respawn, poll port P, respawn when P goes quiet.** The polling is
`peer-liveness`'s, not a new implementation.

**3. One autostart entry**, registered by `setup/` and Windows-only there, never
in `src/`.

**4. Config.** The Session 1 spine needs to know it is the successor and which
port to claim; the Session 0 spine needs to know which port means "stood aside."

## Chunks

Each is independently dispatchable, testable without a live spine, and ordered so
nothing depends on a later one.

**Chunk 1 — the lifecycle verb.** `ingest.mjs` + its tests. Pure parsing: a new
token returns a new code and a target port; malformed input still returns `null`
rather than a code. No daemon changes, no behaviour change to the existing three.
*Verify:* unit tests for the new token, and regression locks that `/restart`,
`/upgrade`, `/rewind` and unknown input are byte-for-byte unchanged.

**Chunk 1b — deferring it.** The other three tokens exit immediately; this one
must not. Add the pending-stand-down state: stop admitting turns, drain the ones
in flight, then exit. This is the chunk that decides whether a logon costs
somebody a dropped reply, so it is worth its own tests rather than riding along
with the parser.
*Verify:* a spine with a turn in flight receives the token and does **not** exit
until that turn completes; a spine with nothing in flight exits promptly; a turn
that starts after the token is refused rather than admitted and then orphaned.

**Chunk 2 — the daemon's stand-down branch.** Consume the new code: skip respawn,
start a probe loop against the port, respawn on silence. Reuse `peer-liveness`'s
predicate and hysteresis; do not write a second probe.
*Verify:* drive the exit handler with a fake clock and a fake prober — assert no
respawn while the port answers, exactly one respawn after it goes quiet, and that
the backoff ladder is untouched for every other code.

**Chunk 3 — the successor's announce.** On boot, a spine configured as the
Session 1 successor writes the stand-down token before it tries to bind, then
waits for the port. `shell-port` already backs off on a failed bind, so this is
sequencing, not new transport.
*Verify:* two spines against one temp `EGPT_HOME`, asserting the second never
serves while the first still holds the port, and that only one ever writes
`conversations.yaml`.

**Chunk 4 — the autostart.** A `setup/` script registering the HKCU Run entry,
idempotent, with an uninstall. Windows-only, in `setup/`, so
`tests/integrity.test.mjs` stays green.
*Verify:* register, read the key back, unregister, confirm gone. No logon
required.

**Chunk 5 — config + schema.** The successor flag and the port each side watches,
registered in `config/config-schema.mjs` (its key set is enforced by
`integrity` and `skeletons`).
*Verify:* those two suites, plus a resolution test that a node with neither key
set behaves exactly as today.

**Chunk 6 — retire the `schtasks` seam on this node.** Once a Session 1 spine
exists, `/chrome` spawns Chrome as a supervised child. Keep the scheduled-task
path as the Session 0 fallback rather than deleting it — a node with no Session 1
spine still needs it.
*Verify:* `/chrome` from a Session 1 spine brings a browser up on the configured
CDP port and reports it; from Session 0 it still falls back. Remove the
`KNOWN_PLATFORM_DEBT` entry only if the seam actually leaves `src/`.

## Risks, stated rather than discovered later

- **Overlap is the only real hazard.** Everything else is recoverable; two spines
  on one profile is not. Chunk 3's test is the one that matters most.
- **A crash between stand-down and bind** leaves the profile unheld. The daemon's
  probe loop covers it — silence on the port is exactly the resume condition —
  but the window should be measured, not assumed.
- **Warm sessions do not survive the handover.** They are in-process, and
  `idle_ttl_by_class` is `-1` here, so today they never expire. After a handover
  the first turn in each conversation re-spawns its CLI. Acceptable; worth
  knowing.
- **The Session 1 spine dies on lock, not just logoff** — depending on how the
  autostart is registered. Which of those should trigger a handback is a ruling,
  not a detail: locking the screen probably should *not* hand the profile back.
- **A browser still requires a logged-in session.** Nothing here changes that.
  Session 0's "runs with nobody logged in" property does not extend to CDP, and
  the Session 1 spine is therefore a conditional enhancement, exactly like
  everything else in `setup/`.

## Decisions (operator, 2026-09-06)

**Locking does not hand back.** The operator is still there; only the session
ending does. This falls out of the mechanism rather than needing code: an HKCU
Run process survives a lock and dies with the session, so "lock" is not an event
this design ever sees.

**The Session 1 spine serves 23375**, inheriting the profile's identity. The
probe is then trivial — one port means one holder — and the two can never
coexist, not even for a handshake. That is the intended property, not a cost:
the port IS the mutex on a shared profile.

**The stand-down is deferred, never abrupt.** The spine finishes the turn it is
writing, then stands down. This is the operator's ruling and it is the right way
round — the departing spine decides *when*, the arriving one only says *that*.
Tonight's `interrupted — the link to the spine writing this reply dropped` is
exactly what the abrupt version looks like from the other end of a chat, and this
design must not reproduce it on every logon.

Concretely: the token sets a **pending** stand-down. The spine acknowledges it,
stops accepting new turns, drains the ones in flight, and only then exits. The
successor is already waiting on the port with backoff, so the wait costs nothing
but the drain.

**`rodz` stays in Session 0 permanently** — one profile, one session, never part
of a handover. Only `an` moves. The inter-spine channel is what makes that
sensible rather than lopsided: with `an` in Session 1 and `rodz` in Session 0,
the node keeps **a foot in each world** — a browser and a desktop on one side, an
unattended service that survives a reboot on the other — and the existing socket
already lets either speak through the other.
