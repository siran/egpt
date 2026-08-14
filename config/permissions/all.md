dangerous: true

# config/permissions/all.md — the unconfined access level `/e access all` points a
# conversation at. src/spine/permission-levels.mjs parses this file FRESH on every
# turn (no caching, no freeze) — editing it changes behavior immediately for every
# conversation currently pointing at 'all', with no `/e access` re-run needed.
# src/spine/commands.mjs's eAccess only ever writes `access_level: 'all'` into the
# conversation's override block; it never copies this file's contents anywhere.
#
# Mirrors the tier src/brains/meta-engineer.yaml ships: `dangerous: true` skips
# BOTH tool coercion and confinement in brainpool.mjs (coerceAllowedTools +
# confinementFor) — the tool list below runs VERBATIM, full filesystem, no
# sandbox, exactly like an interactive `claude` session. Reachability — who may
# even flip a conversation to this level — is the operator's own judgment call;
# `/e access` is a plain toggle with no extra gate, the same trust model as
# `/room delete force`.
#
# Bash and Agent are BARE below, not scoped `Bash(<bin>:*)`: the house rule that
# scopes Bash exists to stop a CONFINED being from getting a shell escape hatch,
# and that concern simply doesn't apply once a being is already unconfined — an
# interactive `claude` session's own Bash isn't scoped either, so scoping it here
# would only be theater.

## Tools

- Read
- Write
- Edit
- Glob
- Grep
- Bash
- Agent
- WebSearch
- WebFetch
