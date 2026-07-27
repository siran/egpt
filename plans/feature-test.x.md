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

  ── TWO PREREQUISITES, so the run doesn't discover them as failures ──

  1. A BROWSER IS A PER-NODE SETUP STEP. Everything in the /chrome /tabs /open
     /tab /close family drives the LOCAL Chrome of whichever node executes it,
     over plain CDP at `localhost:9221` (override: $EGPT_CDP_HOST — src/tools/
     cdp.mjs). The transport across the mesh works: `/chrome do` typed at kg's
     shell DOES travel and DOLLY DOES execute it (verified live 2026-07-27). It
     comes back empty when no Chrome is listening in that node's own Windows
     session — the spine runs in Session 0 and cannot open a visible window. The
     reply names the fix itself: run `setup/register-chrome-task.ps1` ONCE on
     that node (it registers the Session-1 launch task /chrome triggers), or
     paste the command line /chrome prints into a shell in your own session.
     Do that on BOTH nodes before section B, or the browser half tests nothing.

  2. THE LASSO TRIPS, IT DOES NOT SLOW DOWN. 18 outbound MESSAGES or 4000 EDITS
     per 10s window and the node writes EGPT_HOME/STOP (with a `reason:` naming
     the flood) and exits clean — the daemon does NOT respawn. A runaway ends in
     a STOPPED node, not a sluggish one, and only `setup/start-egpt.cmd` (after
     deleting STOP) brings it back. Do not test this deliberately.
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
   port? List the open tabs (id, title, url). If none is running, say so — do NOT launch
   one; launching is what `/chrome` is for and section B tests it.
5. List the conversation folders under `~/.egpt/conversations/shell/` and, for each,
   report which of the room tree exists: `config.yaml`, `transcript.md`, `media/`,
   `files/`, `identity.d/`, `scripts/`, `transcripts/` (Room.treeDirs — a conversation
   and a NamedRoom get the identical tree). Report the `identity.d/` contents; expect
   the numbered layers `00-identity.md 10-actions.md 30-pointers.md 40-rules.md`.
6. For ONE busy conversation, read the head of `transcript.md` and report its front
   matter — especially `thread_id`. Then list its `transcripts/`: each file there is a
   FINISHED thread, archived as `<old-thread-id>.md` when the thread changed.
7. In that same `transcript.md`, search for the rendered node signature `<kg>` / `<do>`.
   Every frame a spine commits to a surface carries an invisible node id, and the
   transcript renders it into that visible marker. Report how many lines carry one and
   which nodes are named. NONE on a chat only this node speaks in is normal — the marker
   is what a CO-ACCOUNT PEER's line looks like on this node's record.
8. Read `~/.egpt/config/conversations.yaml` and report how many conversation entries it
   has, and whether any entry carries a `guard:` or `agents:` block.
9. Read the `dispatch:` block of `~/.egpt/config/config.yaml` and report the four values
   section B depends on: `auto_default_mode`, `address_without_at`, plus top-level
   `quick_reply_string` (default `r`) and `lasso:` (default 18 messages / 4000 edits /
   10000ms when the block is absent). Also report `node_name` and `account_peers`.
10. If `~/.egpt/state/lasso.json` exists, report its contents. It is written ONLY on a
    trip, so ABSENT is the healthy answer — say "absent (never tripped)", not "missing".

# B. Steps a human runs at the egpt shell — then re-run this script

These cannot be done from here. Run them yourself, then run this script again so
section A picks up the artifacts.

**The node gate is now ONE gate for the whole family.** `/chrome /status /tabs /tab
/open /close /members` are the node-addressable allowlist (`NODE_ADDRESSABLE`,
src/spine/commands.mjs). Lifecycle (`/restart /upgrade /rewind`) and the STOP safe
word are deliberately OUTSIDE it, at both ends, so nothing arriving over the mesh can
take a node down. `/chrome`'s whole argument is the node; for the other six the node
is a TRAILING token (`/tab 3 do`, `/members do`) and counts only when it NAMES a known
node — so `/open https://x.com` is untouched and runs wherever it was heard.

11. `/chrome` (bare) — the discovery path. Each node answers a short usage line naming
    itself. This is the one form that is NOT silent on a non-match.
12. `/chrome kg` — expect ONLY kg to answer.
13. `/chrome do` — expect ONLY do to answer. Typed at the SHELL this TRAVELS the mesh
    (the shell is node-local, so do could never have heard it); typed in a shared Beeper
    chat, do heard it directly and kg stays silent. Either way exactly one answer. If
    BOTH answer, the gate is broken. If the reply is the launch hint naming
    `setup/register-chrome-task.ps1`, that is prerequisite 1, not a gate failure.
14. `/tabs do`, `/open <url> do`, `/tab <n> do`, `/close <n> do` — the same gate with a
    TRAILING node token. Expect ONLY do to act, and note which node's Chrome moved.
    Now drop the token: `/open <url>` runs on whichever node heard it — at the shell,
    only this one. Confirm both readings.
15. `/room create res1` — expect `rooms/res1/` with `config.yaml`, `media/`, `files/`,
    `identity.d/`, `scripts/`, `transcripts/`. `identity.d/` must be SEEDED, not empty
    (fixed 7e91869: `/room create` calls the same `seedIdentityLayers` a persona turn
    calls). Re-run it: an existing room is never clobbered — expect "already exists".
16. `/members` (bare) — the CURRENT CONVERSATION's roster; a conversation IS a room. In
    the shell lobby it also lists this node's local beings as synthetic rows.
17. `/members add tab <n>` then `/members` — expect the tab listed as
    `<id>  brain  active  mode:disable` with its url and title indented beneath. A NEW
    member starts DISABLED on purpose ("no chatter reaches it yet"); `/members <id> mode
    all` (or `mention`) opens it. Adding the SAME url twice refreshes in place — one
    member, not two.
18. `@chatgpt <prompt>` — expect a reply stamped 🤖 with the member id. Silence means
    its mode: `/members chatgpt mode mention` or `mode all`.

**Then the four things that landed after the last version of this file:**

19. `mode: accum` — the node default is `accum` on kg (`dispatch.auto_default_mode`;
    confirm do's own config on do). It gates EXACTLY like `mention` — it changes the
    PROMPT, never WHEN a turn runs. To see it: say something UNMENTIONED, then `@e`
    something that only makes sense given it. E should answer having seen the gap. The
    turn is prompted with everything recorded since that being's own last turn, capped
    at 8000 chars, under the literal header `THIS LINE IS THE PROMPT — answer THIS:`.
20. Bare handles — `e hola`, `d mirá`: a leading handle addresses without `@`. Only at
    the START, and only a handle the agent actually declares (its `handles:`, else its
    map key). The '@' form is unchanged in both states. Switch:
    `dispatch.address_without_at` (default true, node-wide, no per-chat rung).
21. `r <a follow-up>` — the quick reply. It targets the last AGENT that spoke by READING
    `transcript.md`, so it survives a restart and human lines in between are irrelevant.
    Expect it to reach whoever answered last, without naming them. It fires only when an
    agent spoke last AND that agent is ONE OF THIS NODE'S — if a co-account peer's signed
    line is more recent, this node stays silent and the peer answers, so one `r` gets one
    answer. A withheld ("not surfaced") reply does not count as a bot message.
22. Thread reset — delete the being's `threadId` from its block in
    `~/.egpt/config/conversations.yaml`, then say anything in that chat. On the next turn
    expect ALL THREE: the agent config is re-read (a changed model/effort/type takes
    effect, not the stale frozen snapshot), `transcript.md` is archived to
    `transcripts/<old-thread-id>.md` and replaced by a fresh one carrying the same header
    minus its thread, and `identity.d/` is re-copied WITH OVERWRITE (so an edited
    `config/skeletons/room/` template finally reaches an old conversation).

**Do NOT run:** anything that deliberately floods. See prerequisite 2.

# C. Known-missing — do not report these as failures

23. A tab opened on `do` still CANNOT be added to a room on `kg`, and the reason is now
    two-layered — check BOTH before calling it fixed:
    (a) a brain member is driven by `cdp.streamFromTab` against the LOCAL Chrome
        (src/spine/room-relay.mjs), and the mesh resolves AGENTS, not room members;
    (b) `/members` IS node-addressable now, but a remote `/members do add tab 3` executes
        on do against a SYNTHETIC chat id (`<relay-channel>#cmd<n>`, src/spine/mesh.mjs
        commandReply), so it resolves DO's room for that synthetic chat — not the room
        you are looking at on kg. The member row lands on do's disk, driven by do's
        Chrome. Run 16-18 on ONE node.
24. There is no command to save a conversation, name a conversation for a chat_id, or
    save/append the last reply. The save cases work as PROSE to E instead — it has
    Read/Write/Edit/Glob/Grep confined to its own conversation folder (and no Bash). Try:
    "write our conversation since <marker> to ./research-notes.md" and verify the file.

# D. Write the result

25. Append a dated section to `feature-test.x.md.log` beside this file: one line per
    numbered step, each `PASS` / `FAIL` / `COULD NOT VERIFY`, with the observed value —
    the pid, the tab count, the actual folder contents, the archived thread filename. A
    bare PASS with no observation is worthless; record what you saw, not that you looked.
26. End with a short list of anything that surprised you or contradicted this script's
    own description. That list is the most valuable part of the run: this file is a
    snapshot of what was verified true against `src/` on 2026-07-27, and the code moves.
