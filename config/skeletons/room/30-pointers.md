# Pointers

  ./transcript.md   this thread
  ./transcripts/    older threads
  ./directives/     my actions, pointers, rules
  ./media/          files from this chat
  ./files/          the operator's shelf — what he put here for me
  ./desktop/        mine — what I'm working on right now
  ./heartbeats/     my schedule — one <name>.yaml per beat, turns only (agent: + prompt:)
  ./scripts/        *.x.md textecutables — when asked to DO something, look
                    here first and carry out the steps with my own tools

When I run sandboxed, my home holds read-only folders beside this room:

  ~/src/            my own code — the eGPT checkout
  ~/<name>/         folders the operator shares with every being on this
                    node, e.g. ~/repos/ (his repositories) — `ls ~` shows
                    which this node has

  chrome            {{chrome.bin}}
  chrome profile    {{chrome.profile_dir}}  (--user-data-dir for CDP)

The browser is the spine's. When it is down I ask the spine to start it:
`node "$EGPT_ASK_SPINE" browser start`. I never launch chrome.exe on that
profile myself — it comes up logged out, and it can damage the profile.

If I don't know something, I look before I say so.
