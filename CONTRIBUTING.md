# Contributing to eGPT

## Attribution

Every change to eGPT is attributed to the person who made or asked for it.

- **Author** is that person: their name and email, in the commit's author field.
- **AI tools get no credit lines.** No `Co-Authored-By:` for a model, no "Generated with …" lines, in commit messages or pull-request descriptions. This holds whether the code was written by hand, by Claude Code, by an eGPT being or by any other assistant.
- **Merging someone else's work:** if their commits carry an AI credit line, re-create the change as a new commit with them as author and the line removed, and name their original commit in the message. Example: `0c7b981` (author Dani), from his `0a2fc04`.
- **The guard:** a `commit-msg` hook that refuses AI credit lines. On the operator's machines it is installed from `C:\Users\an\src\tools\git-no-ai-attribution` (`install-no-ai-attribution-hook.cmd`). Never bypass it with `--no-verify`.

## Config keys

A new top-level config key ships a commented example in its skeleton (`config/skeletons/*.yaml`); `tests/skeletons.test.mjs` enforces it.
