# attic/ — archived code

Code that was built, then retired by a later architectural decision.
Kept in-tree (not deleted) so the design rationale is greppable and
re-resurrection doesn't require a git-archaeology dig.

## egpt-keeper.mjs (retired 2026-05-23)

The keeper was the supervisor-half of a planned process duo:
  - keeper.mjs: long-lived, owns baileys + outbox watcher, survives
    daemon restarts so WA stays connected through code reloads
  - egpt.mjs (daemon): stateful brain/handler, reads inbox events
    from keeper, can restart freely

Phase 2c plan (88fa2da, then later commits):
  - step 1: keeper scaffold — PID, log, signals, idle heartbeat
  - step 2: keeper OPTIONALLY owns baileys (gated by env var
    EGPT_KEEPER_OWNS_BAILEYS=1)
  - step 3: handler-side inbox watcher (passive — logs, doesn't
    dispatch) so we could observe the wire without double-dispatch
  - step 4 (never built): handler stops calling startBaileysBridge;
    daemon-wrap.ps1 spawns keeper alongside.

Retired because:
  - WA reconnect-on-restart works fine today; we lose seconds, not
    hours, of inbound (WA's server-side backlog covers ~hours).
  - 440 fight-loop risk: operator-confirmed overblown
    ("recovery is one `/whatsapp pair` from operator's shell").
  - The duo doubled the number of processes to monitor — when the
    supervisor (Task Scheduler) was broken, two dead processes is
    twice as confusing, not twice as good.
  - The single-process architecture + working supervisor + heartbeat-
    to-file alive watchdog (setup/watchdog.ps1) provides the
    aliveness guarantee the keeper was supposed to deliver, without
    a separate process.

When the keeper might be needed (revisit then):
  - egpt-bot account joins as a separate WA presence (currently
    deferred per memory) — that's a genuine second-process case
    because the two accounts can't share one baileys session.
  - Real distributed deployment (GPU laptop as a 2nd node — see
    IDEAS.md "Live mic capture" + transcribe-remote scaffold).
