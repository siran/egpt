dangerously_skip_permissions: true

# config/permissions/sandbox.md — the THIRD access level (operator 2026-09-05),
# `access_level: sandbox`. Same shape and same reader as its two siblings:
# src/spine/permission-levels.mjs parses this file FRESH on every turn (no caching,
# no freeze), so editing it changes behavior immediately for every conversation
# currently pointing at 'sandbox', with no re-run needed.
#
# WHAT IT IS: `all`'s CAPABILITY, but only ever inside the OS sandbox. The tool
# list below is all.md's, byte for byte, and the flag above is all.md's too — a
# 'sandbox' being is exactly as unconfined at the CLI-flag level as an 'all' one.
# The difference is not in this file: brainpool.mjs forces `sandboxed: true` for
# this level, ahead of the two-tier `??` walk, so no config rung can run a
# 'sandbox' being unboxed. The being's warm CLI process therefore always runs
# under the dedicated Windows logon session + per-conversation ACE
# (setup/sandbox-logon-launcher.ps1).
#
# WHY THE CLI-LEVEL BOUNDARY IS DELIBERATELY DROPPED: there are two independent
# confinement mechanisms in this repo — the CLI-level one (`access_level`'s tool
# coercion + confinementFor's path confinement, enforced by the agent process
# itself, on its honour) and the OS-level one (`sandboxed`, enforced by the
# Windows kernel against an unprivileged account that simply has no ACE on
# anything else). 'sandbox' is the ruling that when the kernel is holding the
# boundary, a second overlapping boundary inside the process buys nothing but
# friction: ONE boundary, the one that is actually enforced. That is why this
# file grants everything and skips permissions — the box, not the flag list, is
# what says no here.
#
# NO allowed_users REQUIREMENT: brainpool.mjs's structural gate refuses an 'all'
# being with no allowed_users, because unconfined capability + reachable by
# anyone is the dangerous pair. 'sandbox' is exempt (operator's ruling): the
# blast radius of a turn is one ACL'd folder, so a 'sandbox' being may be left
# reachable by anyone with no list set. Do not "fix" that by adding 'sandbox' to
# that condition — the exemption is the point of the tier.
#
# Bash and Agent are BARE below, not scoped `Bash(<bin>:*)`, for all.md's exact
# reason: scoping Bash exists to deny a CONFINED being a shell escape hatch, and
# a being that is unconfined by design has nothing to escape from. Here it is
# even less meaningful — the escape a scoped Bash would prevent is one the OS
# account cannot make anyway.

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
