<!--
  feature-test.x.md — a TEXTECUTABLE that checks the room / browser / CDP-over-mesh
  feature set and writes down what it found. Run it:

      node src/tools/textecute.mjs plans/feature-test.x.md

  Every run appends to feature-test.x.md.log beside this file.

  WHAT THIS CAN AND CANNOT DO — read before trusting a green run.
  A textecutable is one Claude turn with tools. It can drive Chrome over CDP,
  read and write files, and run node. It has NO way to type into the egpt shell
  or to post to Beeper, so it cannot exercise /chrome, /room, /members, @chatgpt,
  a bare handle or `r` itself. Those are OPERATOR steps and are listed in section B
  for a human to run; the script checks the ARTIFACTS they leave behind.

  READ-ONLY on the profile: section A only READS under EGPT_HOME. Nothing here
  writes there, launches Chrome, restarts the node, or touches git.

  Report honestly. A step you could not perform is NOT a pass — say "could not
  verify" and why. Never infer a result you did not observe.

  ── THREE PREREQUISITES, so the run doesn't discover them as failures ──

  1. A BROWSER IS A PER-NODE SETUP STEP, and it is DONE on both nodes as of
     2026-07-27 (`egpt-chrome` scheduled task registered on kg and do; do's fired
     live at 12:08 and bound port 9221 in Session 1). Everything in the /chrome
     /tabs /open /tab /close family drives the LOCAL Chrome of whichever node
     executes it, over plain CDP at `localhost:9221` (override: $EGPT_CDP_HOST —
     src/tools/cdp.mjs). The spine runs in Session 0 and cannot open a visible
     window itself; it fires the Session-1 task instead. To re-register on a node:
     double-click `setup/register-chrome-task.cmd` (it prints a status readback and
     pauses). It deliberately does NOT elevate — the task is registered for the user
     who runs it.

  2. THE LASSO TRIPS, IT DOES NOT SLOW DOWN. 18 outbound MESSAGES or 4000 EDITS
     per 10s window and the node writes EGPT_HOME/STOP (with a `reason:` naming
     the flood) and exits clean — the daemon does NOT respawn. A runaway ends in
     a STOPPED node, not a sluggish one, and only `setup/start-egpt.cmd` (after
     deleting STOP) brings it back. Do not test this deliberately.

  3. DEPLOY IS ONE COMMAND, and the operator should use it rather than hand-rolling
     the ingest drop: `setup\upgrade.cmd` (double-clickable) or
     `powershell -File setup\upgrade.ps1 -Peer an@192.168.1.102` to do BOTH nodes in
     one invocation. It refuses on a STOP file, fails loudly if STOP appears
     mid-deploy, and proves the bounce by the HEARTBEAT advancing rather than by the
     sha (an already-current tree legitimately keeps its sha while rebuilding).
     `setup/deploy.ps1` is the OTHER, heavier path — UAC + full service restart —
     only for a change that alters what the SUPERVISOR spawns.
     ⚠ The EDITOR is a separate process. A deploy bounces the SPINE; to pick up a
     change under `src/shell/` you must quit `egpt.mjs` and relaunch it.
-->

# A. Steps this script performs itself

1. Read `~/.egpt/state/spine.pid` and `~/.egpt/state/alive.txt`. Report the pid and
   how many seconds old the heartbeat is. The daemon itself calls it wedged past
   150s (`aliveStaleMs`, src/daemon-runtime.mjs).
2. Report whether `~/.egpt/STOP` exists. If it does, READ IT — it explains itself,
   and its `reason:` says whether a human pulled the safe word or the lasso tripped.
   Say so loudly and stop; the node is deliberately halted and nothing below is live.
3. Run `git -C ~/bin/egpt log --oneline -1` and `git -C ~/src/egpt log --oneline -1`.
   Report both. If they differ, the running node is not the code in the working tree.
4. Check Chrome over CDP on this node: is a debuggable Chrome listening, and on which
   port? List the open tabs (id, title, url). Report the SESSION of the owning process
   — a Session-0 Chrome is the invisible-window failure the task hop exists to prevent.
   If none is running, say so — do NOT launch one; that is what `/chrome` is for.
5. List the conversation folders under `~/.egpt/conversations/` — note this is now
   ONE LEVEL PER SURFACE and the surface list is OPEN (2026-07-28): whatever network
   Beeper reports becomes its own directory, so expect `whatsapp/`, `telegram/`,
   `shell/` and possibly `googlevoice/`, `instagram/`, … Report which surfaces exist.
   For each conversation report which of the room tree exists: `config.yaml`,
   `transcript.md`, `media/`, `files/`, `identity.d/`, `scripts/`, `transcripts/`
   (Room.treeDirs). Report `identity.d/` contents; expect the numbered layers
   `00-identity.md 10-actions.md 30-pointers.md 40-rules.md`.
6. For ONE busy conversation, read the head of `transcript.md` and report its front
   matter — especially `thread_id`. Then list its `transcripts/`: each file there is a
   FINISHED thread, archived as `<old-thread-id>.md` when the thread changed.
7. In that same `transcript.md`, search for the rendered node signature `<kg>` / `<do>`.
   Every frame a spine commits to a surface carries an invisible node id, and the
   transcript renders it into that visible marker. Report how many lines carry one and
   which nodes are named. NONE on a chat only this node speaks in is normal.
8. Read `~/.egpt/config/conversations.yaml` and report how many conversation entries it
   has, and whether any entry carries a `guard:` or `agents:` block. ALSO grep it for
   `#cmd` — a mesh-delivered command used to register its private per-command chat id
   as a real contact, minting junk `contact-<timestamp>` rooms. Fixed 2026-07-27, and
   the existing junk was swept, so the healthy answer is ZERO matches. Any match means
   the regression is back.
9. Read the `dispatch:` block of `~/.egpt/config/config.yaml` and report:
   `auto_default_mode`, `address_without_at`, `default_node`, `send_to_egpt`, plus
   top-level `quick_reply_string` (default `r`) and `lasso:` (default 18 messages /
   4000 edits / 10000ms when absent). Also report `node_name` and `account_peers`.
   ⚠ Do NOT paste tokens: config.yaml holds the live Beeper API token.
10. If `~/.egpt/state/lasso.json` exists, report its contents. It is written ONLY on a
    trip, so ABSENT is the healthy answer — say "absent (never tripped)", not "missing".
11. Confirm the comment formatting of `~/.egpt/config/config.yaml` is intact — aligned
    trailing comments, multi-line comment blocks still indented under their key. A
    `/config set` used to REFLOW the whole file; fixed 2026-07-28 (writes are now a
    single-line edit). A reflowed file means that regression is back.

# B. Steps a human runs at the egpt shell or in a Beeper chat

These cannot be done from here. Run them yourself, then run this script again so
section A picks up the artifacts.

**⚠ WHERE YOU TYPE DECIDES WHETHER IT WORKS.** The shell is node-local, so a command
for another node TRAVELS the mesh. A shared Beeper chat is heard by BOTH nodes
directly, so nothing travels (`remoteNode` returns null for a co-account peer on a
non-node-local surface). Room-scoped commands behave differently on the two routes —
see 23.

**THE NODE BINDS TO THE COMMAND TOKEN** (2026-07-27, replacing the older trailing
token and the short-lived `node=` form, both gone). `/chrome /status /tabs /tab /open
/close /members /config` are the node-addressable allowlist (`NODE_ADDRESSABLE`,
src/spine/commands.mjs). Lifecycle (`/restart /upgrade /rewind`) and the STOP safe
word are deliberately OUTSIDE it, at both ends, so nothing arriving over the mesh can
take a node down.

## The command-bound node syntax

12. `/chrome` (bare) — the discovery path when `default_node` is UNSET. Each node
    answers a short usage line naming itself. The one form that is NOT silent on a
    non-match.
13. `/chrome=kg` — expect ONLY kg. `/chrome kg` (positional) must work identically:
    /chrome's whole argument IS a node, so it kept its bare form.
14. `/chrome=do` — expect ONLY do. At the SHELL this travels the mesh; in a shared
    Beeper chat do heard it directly and kg stays silent. Either way exactly ONE
    answer. If BOTH answer, the gate is broken.
15. `/tabs=do`, `/open=do <url>`, `/tab=do <n>`, `/close=do <n>` — same gate. Expect
    ONLY do to act, and note which node's Chrome moved. Then drop the `=do`:
    `/open <url>` runs wherever it was heard (or on `default_node`, see 17).
16. `/open=do https://x.com/?a=b` — a `=` inside an ARGUMENT must never read as a
    node. Binding to the command token makes this structurally safe; confirm the URL
    arrives intact.

## default_node

17. `/config=kg set default_node do` then `/restart`. **"Restart" means the SPINE.**
    Relaunching the editor changes nothing — it reconnects to the same long-running
    spine, which read its config at boot. This caught the operator out once.
18. With it set, a BARE command operates on that node — including bare `/chrome`
    (which stops being the discovery form) and commands WITH arguments:
    `/tabs`, `/members add tab 3 c1`, `/status`. To reach kg you now type `=kg`.
19. The resolution TRAVELS. A bare `/tabs` resolved to do is rewritten to `/tabs=do`
    on the wire, so do recognises it without knowing kg's config. Before this fix
    (2026-07-27) the bare form reached do's persona BRAIN, and Claude Code replied
    *"Unknown command: /tabs. Did you mean /stats?"* — if you ever see that again,
    this regressed.
20. Unset it (`/config=kg set default_node ""`, `/restart`) and confirm every bare
    form is exactly as before — an unset `default_node` is a strict no-op.

## /config

21. `/config` (bare) — a REDACTED dump. Verify the Beeper token, the transcription
    token, `account` and `allowed_users` all read `<redacted>`, while `node_name`,
    `account_peers` and the `dispatch:` block are visible. A dump goes to whatever
    chat you typed it in, permanently.
22. `/config get default_node` — resolves the bare leaf, names the full path
    (`dispatch.default_node`), and redacts a secret-ish key just as the dump does.
    An unregistered key is refused; an ambiguous bare leaf is refused WITH candidates.
23. `/config set <key> <value>` — then LOOK AT THE FILE. It must change exactly the
    one line, leaving alignment, trailing comments and multi-line comment blocks
    untouched. It says "run /restart to apply".
24. `/config=do set …` vs bare `/config set …` — both nodes hear a chat command, so
    the bare form applies it TWICE. Name the node for a per-node key.

## The shell editor

25. Launch `node egpt.mjs` and confirm the PERMANENT header, which never scrolls away:
    `🟢 egpt lobby — ? for help · ctrl-d = send — kg: @e · do: @carol @wren @cara @don`
    The agent list is derived from this node's `agents:` map — the SHORTEST handle per
    agent, grouped by where each ROUTES (`to: <being>.<node>`; carol's routes live
    inside a `paths:` list). It never claims to know a peer's roster. The spine
    computes it and pushes it over the existing frame; the editor reads no config.
26. Kill the spine and let it come back (or `/restart`) — the header must RE-APPEAR.
    It is resent on every reconnect; a header sent once would go blank forever after
    the first drop.
27. Compose a MULTILINE message (Enter inserts a newline; ctrl-d sends). Continuation
    lines must have NO `| ` gutter.
28. Type `h`, `help`, or `?` alone — should reach `/help`. **KNOWN BROKEN as of
    2026-07-28: the spine does not implement `/help`, so this hits the catch-all.**
    Then type `help me write this email` and confirm it is forwarded as an ORDINARY
    MESSAGE — the whole-line-only rule is what keeps that working.

## Rooms, members, and a brain

29. `/room create res1` — expect `rooms/res1/` with `config.yaml`, `media/`, `files/`,
    `identity.d/`, `scripts/`, `transcripts/`. `identity.d/` must be SEEDED, not empty.
    Re-run it: an existing room is never clobbered — expect "already exists".
30. `/members` (bare) — the CURRENT CONVERSATION's roster; a conversation IS a room.
    In the shell lobby it also lists this node's local beings as synthetic rows.
31. `/members add tab <n> [alias]` — the alias is optional and may be given bare
    (`c1`) or keyed (`alias=c1`). An EXPLICIT alias that is already taken REFUSES;
    with no alias you get the auto-suffix (`chatgpt`, `chatgpt-2`, …). A new member
    starts `mode:disable` on purpose.
32. `/members` again — expect the row as `<id>  brain  active  mode:disable` with url
    and title indented beneath. **Watch the id**: getting a bare `chatgpt` where the
    roster already had one means you are looking at a DIFFERENT room (see 23 in C).
33. `/members <id> mode mention` (or `all`) to open it, then `@<id> <prompt>` — expect
    a reply stamped 🤖 with the member id.

## Addressing and modes

34. `mode: accum` — gates EXACTLY like `mention`; it changes the PROMPT, never WHEN a
    turn runs. Say something UNMENTIONED, then `@e` something that only makes sense
    given it. E should answer having seen the gap. Capped at 8000 chars under the
    header `THIS LINE IS THE PROMPT — answer THIS:`.
35. Bare handles — `e hola`, `d mirá`: a leading handle addresses without `@`, START
    only, and only a handle the agent declares. Switch: `dispatch.address_without_at`.
36. `r <follow-up>` — targets the last AGENT that spoke by READING `transcript.md`, so
    it survives a restart. It fires only when that agent is one of THIS node's; if a
    co-account peer's signed line is more recent, this node stays silent.
37. Thread reset — delete the being's `threadId` from `~/.egpt/config/conversations.yaml`,
    then say anything in that chat. Expect ALL THREE: agent config re-read,
    `transcript.md` archived to `transcripts/<old-thread-id>.md`, and `identity.d/`
    re-copied WITH OVERWRITE.

## The mesh, seen from outside

38. Run a node-addressed COMMAND from the shell (`/tabs=do`) and watch the indicator.
    It must read `🔗 relaying…` — structural tubing, no AI involved — and finish to
    just the reply, with NO "✅ Done".
39. Run a BEING prompt over the mesh (`@don hola`) and confirm it still reads
    `🤔 thinking…`, streams, and ends with `✅ Done`. The two must not look alike.
40. Note the signatures: `🌉` is kg's `bridge_signature_close`, `💸` is do's. A relayed
    reply carries both — the responder's and the relayer's. If a lifecycle reply only
    ever shows `🌉`, that is do's `chat_ids: []` (see D).

**Do NOT run:** anything that deliberately floods. See prerequisite 2.

# C. Known-missing — do not report these as failures

41. **A tab opened on `do` still cannot be added to a room on `kg`.** This was
    two-layered; ONE layer is now fixed:
    - (a) STILL OPEN: a brain member is driven by `cdp.streamFromTab` against the
      LOCAL Chrome (src/spine/room-relay.mjs), and the mesh resolves AGENTS, not room
      members. Membership does not cross the node boundary.
    - (b) FIXED 2026-07-27: a mesh-delivered command used to resolve its room from the
      private per-command chat id (`<relay>#cmd<n>`), so consecutive commands landed in
      DIFFERENT throwaway `contact-<timestamp>` rooms — an add would report success and
      the next `/members` would show nothing. A mesh-delivered room command now acts on
      the RESPONDER'S LOBBY, so add and list agree. Run 30-33 on ONE node.
42. There is no command to save a conversation, name a conversation for a chat_id, or
    save/append the last reply. The save cases work as PROSE to E instead — it has
    Read/Write/Edit/Glob/Grep confined to its own conversation folder (and no Bash).
43. `/help` is not implemented in the spine. `src/interpreter.mjs` holds the registry
    (61 commands, ~a dozen actually wired) and `helpText`; nothing calls it. The v1
    implementations are recoverable at `git show 2517624^:slash/<name>.mjs` (50 files),
    but they were written against the old spine's ctx and several are SUPERSEDED
    (`/chrome`, `/tabs`, `/open`, `/e`, `/status` are richer in v2).

# D. Live configuration notes

44. **do's `networks.whatsapp.chat_ids` is `[]`.** `selfChatId()` is therefore null on
    do, so `announceAndExit` skips its post: do executes lifecycle commands SILENTLY.
    Every `↻ /upgrade…` you see is kg's. Authorization is unaffected — it comes from
    `allowed_users` and from `isSender`, not from `chat_ids`.
45. **Surfaces are OPEN** (2026-07-28). A network Beeper bridges files itself under its
    own name; Google Voice logs to `googlevoice/`, not `whatsapp/`. Consequences:
    history SPLITS (older Google Voice threads stay under `whatsapp/`), and a new
    surface has no `allowed_users` so OTHER people's messages on it are denied until
    you add a block. Your own messages are authorized by `isSender` regardless, and
    agents reply either way — `authorized` gates the COMMAND path only.

# E. Write the result

46. Append a dated section to `feature-test.x.md.log` beside this file: one line per
    numbered step, each `PASS` / `FAIL` / `COULD NOT VERIFY`, with the observed value —
    the pid, the tab count, the actual folder contents, the archived thread filename. A
    bare PASS with no observation is worthless; record what you saw, not that you looked.
47. End with a short list of anything that surprised you or contradicted this script's
    own description. That list is the most valuable part of the run: this file is a
    snapshot of what was verified true against `src/` on 2026-07-28, and the code moves.
