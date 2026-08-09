# Welcome to egpt

You are joining a live system, not a codebase at rest. Two nodes are running right now, on one
shared Beeper account, talking to real people in real group chats. Anything you deploy is in
front of them within a minute. That is the whole character of this project: the tests are the
floor, not the ceiling, and "it passed CI" is never the same claim as "it works."

## What this is

**egpt** is a two-node AI presence. Each node is a *spine* — a long-lived process that watches
Beeper (WhatsApp, etc.), decides whether a message is for it, and wakes a warm Claude CLI
session to answer as a persona.

| node | machine | persona | node marker |
|---|---|---|---|
| `kg` | REVE (this box) | `egpt` 🐶 | 🌉 |
| `do` | DOLLY, `192.168.1.102` | `don` 🤝 | 💸 |

`do` is also the GPU box: it runs the whisper transcription worker that `kg` calls, and it
hosts the internet radio station as a Windows service. `dolly` is the Windows hostname; the
**node name is `do`** — they are not the same thing, and confusing them breaks node addressing
silently.

Both nodes hear every message on the shared account. Almost every subtle bug in this repo's
history is a consequence of that one fact: two listeners, one room, and the constant risk of
answering twice or not at all.

## Read these, in this order

1. **`CLAUDE.md`** — how to work here. It is already in your context. It overrides your default
   instincts, including about dispatching agents. Believe it.
2. **`HANDOFF.*.disposable.md`** (newest date) — the live worklist, current node state, the
   traps, and what is verified versus merely tested. Gitignored, so it is candid.
3. **`ROADMAP.md`** — §0b for what landed and when, §3 for the standing rulings.

There is no useful project memory outside the repo. `MEMORY.md` is deliberately near-empty
because two auto-saved memories once went silently wrong and cost a session each. Durable
state lives in files that can be diffed and reverted.

## How work happens here

**You are the orchestrator. You dispatch; you do not write the source.** Your hands are for
scoping, briefing, reading diffs, running the suite, committing, deploying, and ops. This is
not a style preference — it is what keeps your context long enough to hold the direction of
the work, which is the one thing an agent cannot do for you.

A brief that works names the existing thing to route into, states the expected *shape* ("this
should be a net deletion"), forbids the escape hatches explicitly, and gives a STOP rule. An
agent that comes back with *"I cannot do this without changing shared code, here is the line
and the reason"* has done the job correctly, even though it shipped nothing. That happened
twice on 2026-08-09 and both times the agent was right to stop.

The failure mode this repo keeps hitting is not bad code. It is **a second path added beside
the one that already exists**, because an agent could not see the first one. That is how there
came to be three mention systems and eleven transcript-ingestion call sites. Supplying the
missing context is your job, not the agent's.

## Four rules that were paid for

1. **Verify, never relay.** Re-run the suite yourself, read the diff hunks, probe the live
   thing. Agents have reported "all green" against a tree that then failed.
2. **Mark inference as inference.** The expensive mistake is not a wrong fact — it is a
   plausible story told in the voice of a finding. If you meet something you cannot explain,
   that is a stop signal, not a footnote.
3. **Never write to `~/.egpt` without asking, every time.** That is the operator's live
   profile, and it holds credentials.
4. **A node's prod SHA is not what its process is executing.** A long-lived spine keeps the
   code it loaded while `git pull` moves the checkout underneath it.

## Orient yourself in one minute

```sh
git log --oneline -5 && git status --porcelain     # a SECOND ENGINEER also pushes to main
git rev-list --left-right --count HEAD...origin/main
npx vitest run                                     # the real baseline; see the handoff for known flakes
git -C ~/bin/egpt rev-parse --short HEAD           # what kg is actually running
ssh -p 2222 an@192.168.1.102 "cd /c/Users/an/bin/egpt && git rev-parse --short HEAD"
```

Port 22 on `do` gives a Windows shell; **port 2222 gives MSYS2 bash** — use it for anything
POSIX. Deploy with `powershell -File setup\upgrade.ps1 -Peer an@192.168.1.102`, which does both
nodes and is safe to re-run.

When a node's behaviour and its config disagree, read `~/.egpt/config.readonly.yaml` first: the
spine writes it on every boot with the config exactly as loaded. It settles in one read what
can otherwise cost an hour.

## A note on tone

The operator will tell you plainly when you are wrong, and he is usually right. Correct it in a
sentence and carry on — no ceremony, no re-litigating. He is also the one who noticed that a
room without a chatId was unaddressable, which no amount of reading the code had surfaced.
Take the pushback and the insight with equal seriousness.

Welcome. Read the handoff, check the two nodes, and ask before you touch the live profile.
