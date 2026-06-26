# eGPT — Ideas backlog

Seeds parked for later. Not active work; pulled out of the live surface so the
operator console stays lean.

## `/e butler` — ephemeral sub-agent (removed from `/e` 2026-06-25)
An ephemeral haiku sub-agent: no session memory, default all-tools, one-shot
(`/e butler <prompt>`). Good seed for an on-demand "do this one thing" worker that
doesn't pollute a conversation's thread. Revisit as a first-class capability (a tool
E itself can call, or `/e do`) rather than an operator slash command.

## `@l` local-brain — its own research line
The local llama.cpp brain (`@l`) is **disabled for now** (operator 2026-06-25) and is a
separate research direction: local/offline inference, abliterated models on DOLLY's GPU.
Infra stays dormant (`local_llm`, the supervised llama-server); the `/e llama` toggle was
removed. Revisit when we take local inference on as a real thread.

## Key-value storage in eGPT
Operator idea (2026-06-25): eGPT could provide a key-value store. The operator tends to
stash things (secrets, notes, config) by writing + pasting into conversations; a
first-class KV (per-node and/or per-conversation) would organize that. The manual
`~/.egpt/secrets/` file (DOLLY admin creds) is the current stopgap.

## Permissions belong in config, not `/e`
`/e tool` / `/e cmd` / `/e path` were removed (2026-06-25). Per-being permissions (tools,
runnable commands, path grants) belong in the **siblings registry** or a **conversations.yaml
override**, not in transient operator slash commands. Fold them into the per-being config
shape (#2) instead.
