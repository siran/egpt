dangerous: false

# config/permissions/regular.md — this node's regular confined default,
# `/agents <handle>|all access_level regular` points a being back at (was
# `/e access regular`, retired 2026-08-15). Parsed fresh on every turn by
# src/spine/permission-levels.mjs — no caching, no freeze; editing this file
# changes behavior immediately for every conversation currently pointing at
# 'regular', with no re-run needed.
#
# The list below is exactly DEFAULT_ALLOWED_TOOLS (src/claude-args.mjs) — the
# explicit tool grant an agent type gets when it doesn't say otherwise. It is a
# LIST, so brainpool.mjs's confinementFor confines the file tools to the
# conversation's own directory (plus whatever allowed_paths the instanced agent
# type grants): no bare Bash, no bare Agent, no filesystem access beyond the
# room.

## Tools

- Read
- Write
- Edit
- Glob
- Grep
- WebSearch
- WebFetch
- Task
