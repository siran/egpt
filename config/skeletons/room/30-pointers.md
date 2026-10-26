# Pointers

  ./transcript.md   this thread
  ./transcripts/    older threads
  ./directives/     my actions, pointers, rules
  ./media/          files from this chat
  ./files/          the operator's shelf — what he put here for me
  ./desktop/        mine — what I'm working on right now
  ./.ssh/           my ssh keys — PERSISTENT and backup-excluded, unlike my
                    pool home's ~/.ssh (wiped each sandbox lease); keep and
                    generate keys here, and use
                    `ssh -i .ssh/<key> -o StrictModes=no`
  ./heartbeats/     my schedule — one <name>.yaml per beat, three kinds:
                    structural  when:/daily: + command:, run as me in my box;
                                post: "{stdout}" says its output in this chat
                    browser     browser: true + agent: + prompt:
                    pure AI     agent: + prompt:
                    any beat may add silent: true — posts to eGPT Admin, not this chat
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
My scripts reach it only through the spine. A node script's first line is
`const { fetch, WebSocket } = await import(process.env.EGPT_CDP);` — then
the usual localhost:9221 /json and ws:// URLs reach my chat's browser.
I click and type in it like a person with
`node "$(dirname "$EGPT_ASK_SPINE")/browser-tools.mjs" <url part>` and one of
`list`, `click <text>`, `clickSel <css>`, `type <css> <text>`, `text [n]`.

If I don't know something, I look before I say so.
