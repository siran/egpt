---
name: egpt-ops
description: Deploy eGPT to the live nodes, get an elevated shell, or recover a deploy that died partway. Use when asked to deploy, upgrade, restart, or stop a node; when a command needs administrator and UAC is in the way; or when reve/dolly addresses, ssh ports, service names or live state paths are needed.
---

# eGPT operations

Read `OPERATIONS.md` at the repo root **before acting**. It is the single source
of truth for this skill; nothing operational is restated here, because a second
copy is a second thing to keep correct and the one that drifts is always the copy.

```
Read OPERATIONS.md
```

It covers: the two nodes and their addresses, the everyday deploy
(`setup/upgrade.ps1 -Peer`) versus the supervisor deploy (`setup/deploy.ps1`),
the ssh hop that yields an administrator shell without a UAC prompt, which ssh
port to use and what breaks on each, recovering a half-applied deploy, stopping a
node, and where the live state lives on disk.

## Before you deploy

1. **Commit and push first.** A deploy pulls `origin/main`. Unpushed work does
   not ship, and the node will quietly come back on the old code.
2. **Check whether anyone else is deploying.** More than one agent commits to
   this repo — on 2026-09-14 a commit appeared on both nodes that this session
   had not made. `git log --oneline -1` in `~/bin/egpt` on each node tells you
   what is actually running, which is not always what you last pushed.
3. **Run the full suite.** `npx vitest run` — it is ~35s and it has caught real
   breakage in the deploy path itself.

## After you deploy

Prove it landed rather than assuming it did. For each node: prod HEAD equals the
commit you pushed, the tracked tree is clean (`git status --porcelain -uno`), and
the heartbeat has advanced **since the deploy** — remembering it only beats once
a minute.

## Rules that are not negotiable

- **Never put a token in a file, a commit, or a chat.** Report a secret by
  presence, length and `sha256[:12]` and nothing more. The shell and
  transcription tokens live in `config.yaml` and belong nowhere else.
- **Never pipe a native executable through `2>&1` in PowerShell 5.1** unless
  `$ErrorActionPreference` has been dropped around the call. `OPERATIONS.md`
  explains why; `tests/integrity.test.mjs` enforces it.
- **Do not restart onto a half-applied tree.** If prod HEAD and `origin/main`
  disagree, or a tracked file differs, fix that first.
- A deploy restarts beings that are mid-conversation with real people. It is
  quick, but it is not invisible — if the operator is actively chatting, say so
  before you run it.
