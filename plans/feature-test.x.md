<!--
  feature-test.x.md — a TEXTECUTABLE that checks the browser/room/member feature
  set and writes down what it found. Run it:

      node src/tools/textecute.mjs plans/feature-test.x.md

  Every run appends to feature-test.x.md.log beside this file.

  WHAT THIS CAN AND CANNOT DO — read before trusting a green run.
  A textecutable is one Claude turn with tools. It can drive Chrome over CDP,
  read and write files, and run node. It has NO way to type into the egpt shell
  or to post to Beeper, so it cannot exercise /chrome, /room, /members or @chatgpt
  itself. Those are OPERATOR steps and are listed in section B for a human to run;
  the script checks the ARTIFACTS they leave behind.

  Report honestly. A step you could not perform is NOT a pass — say "could not
  verify" and why. Never infer a result you did not observe.
-->

# A. Steps this script performs itself

1. Read `~/.egpt/state/spine.pid` and `~/.egpt/state/alive.txt`. Report the pid and
   how many seconds old the heartbeat is. Older than 120s means the node is not beating.
2. Report whether `~/.egpt/STOP` exists. If it does, say so loudly and stop — the node
   is deliberately halted and nothing below is meaningful.
3. Run `git -C ~/bin/egpt log --oneline -1` and `git -C ~/src/egpt log --oneline -1`.
   Report both. If they differ, the running node is not the code in the working tree.
4. Check Chrome over CDP on this node: is a debuggable Chrome listening, and on which
   port? List the open tabs (id, title, url). If none is running, say so — do NOT launch
   one; launching is what `/chrome` is for and section B tests it.
5. List the conversation folders under `~/.egpt/conversations/shell/` and, for each,
   report which of these exist: `transcript.md`, `config.yaml`, `identity.d/`, `media/`.
   Report the `identity.d/` contents when present.
6. Read `~/.egpt/config/conversations.yaml` and report how many conversation entries it
   has, and whether any entry carries a `guard:` or `agents:` block.
7. If `~/.egpt/state/lasso.json` exists, report its contents — the outbound rate
   regulator's state (idle / throttling / dropping, and the counters).

# B. Steps a human runs at the egpt shell — then re-run this script

These cannot be done from here. Run them yourself, then run this script again so
section A picks up the artifacts.

8.  `/chrome kg`  — expect ONLY kg to answer. `/chrome` is node-gated; a non-match is
    silent on purpose.
9.  `/chrome do`  — expect ONLY do to answer. If BOTH answer, the gate is broken.
10. `/room create res1` — expect `rooms/res1/` with config.yaml, media, files,
    identity.d. Note that identity.d is created EMPTY; conversations get their layers
    seeded on the first persona turn, NamedRooms do not.
11. `/open <url>` — ⚠️ NOT node-gated today, so expect BOTH nodes to act. Note which
    one actually opened the tab. Same for `/tabs`, `/tab`, `/close`, `/members`.
12. `/members add tab <n>` then `/members` — expect the tab listed as
    `<id>  brain  active  mode:<m>` with its url and title indented beneath.
13. `@chatgpt <prompt>` — expect a reply stamped 🤖 with the member id. If it stays
    silent, check its mode: `/members chatgpt mode mention`.
14. `r <a follow-up>` — the quick reply. Expect it to reach whoever answered last,
    without naming them. Only fires when an AGENT spoke last.

# C. Known-missing — do not report these as failures

15. A tab opened on do CANNOT be added to a room on kg. A brain member is driven by
    `cdp.streamFromTab` against the LOCAL Chrome, and the mesh resolves agents, not room
    members. Run 11-13 on ONE node.
16. There is no command to save a conversation, name a conversation for a chat_id, or
    save/append the last reply. The save cases work as PROSE to E instead — it has
    Read/Write/Edit confined to its own conversation folder. Try:
    "write our conversation since <marker> to ./research-notes.md" and verify the file.

# D. Write the result

17. Append a dated section to `feature-test.x.md.log` beside this file: one line per
    numbered step, each `PASS` / `FAIL` / `COULD NOT VERIFY`, with the observed value —
    the pid, the tab count, the actual folder contents. A bare PASS with no observation
    is worthless; record what you saw, not that you looked.
18. End with a short list of anything that surprised you or contradicted this script's
    own description. That list is the most valuable part of the run: this file is a
    snapshot of what was believed true on 2026-07-26, and the code moves.
