dangerously_skip_permissions: false

# config/permissions/reader.md — the desk-only level (plans/2610261726-CHATBOXES.md, operator
# 2026-10-26: "the desk is the boundary"): a public chatbox being reads the files on its own
# conversation folder and nothing else. Parsed fresh every turn (src/spine/permission-levels.mjs).
#
# What this file cannot say, src/spine/brainpool.mjs enforces for the level by name (isDeskOnly):
# unboxed and CLI-confined to the conversation folder; no allowed_paths from the type, the node or
# the conversation; this list sent as --tools (nothing unlisted exists) with --strict-mcp-config;
# no browser link; no pointers card (src/conversations-state.mjs PUBLIC_LAYERS); no config card.

## Tools

- Read
- Glob
- Grep
