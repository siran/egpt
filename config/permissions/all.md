dangerous: true

# config/permissions/all.md — the unconfined access level `/agents <handle>|all
# access_level all` points a being at (was `/e access all`, retired 2026-08-15).
# src/spine/permission-levels.mjs parses this file FRESH on every turn (no caching,
# no freeze) — editing it changes behavior immediately for every conversation
# currently pointing at 'all', with no re-run needed. src/spine/commands.mjs's
# agentsAccessLevel only ever writes `access_level: 'all'` into the target being's
# override block; it never copies this file's contents anywhere.
#
# Mirrors the tier src/brains/meta-engineer.yaml ships: `dangerous: true` skips
# BOTH tool coercion and confinement in brainpool.mjs (coerceAllowedTools +
# confinementFor) — the tool list below runs VERBATIM, full filesystem, no
# sandbox, exactly like an interactive `claude` session. Reachability — who may
# even flip a conversation to this level — is the operator's own judgment call;
# `/agents … access_level` is a plain toggle with no extra gate, the same trust
# model as `/room delete force`.
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
