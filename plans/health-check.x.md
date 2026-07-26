<!--
  health-check.x.md — a TEXTECUTABLE E can carry out with its OWN tools.
  Ask for it in plain words: "run the health check" / "do the health check".

  E has Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, Task — and NO Bash.
  So every step below is a file read or a file write, confined to this folder.
  Nothing here shells out, drives Chrome, or touches another node.
-->

1. Read ./transcript.md and report: how many lines, the timestamp of the last
   entry, and who spoke last (the operator, or an agent).
2. List ./identity.d/ and report which numbered layers are present. Expect
   00-identity.md, 10-actions.md, 30-pointers.md, 40-rules.md.
3. Read ./identity.d/30-pointers.md and check every ./<path> it names. Report
   for each whether it exists in this folder. Any path that does not exist is a
   FAULT — the card is lying to me and I should say so plainly.
4. Report whether ./config.yaml exists and, if it does, what it configures.
5. List ./scripts/ and name the other textecutables available here.
6. Write your findings to ./scripts/health-check.x.md.log, appending a dated
   section. Record the OBSERVED VALUE for each step, not "OK" — the line count,
   the actual filenames, the real timestamps. A bare PASS proves nothing.
7. Reply in the chat with a two-line summary: what is healthy, and anything in
   step 3 that was a fault.
