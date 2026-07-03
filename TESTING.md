# eGPT — testing

```bash
npx vitest run          # the whole suite
npx vitest run <file>   # one file
```

Every test is hermetic — pure libs, injected fs/clock, fixtures. Nothing touches
a live Beeper, a real profile, or the network. A green suite is the bar for any change.

## Tiers

- **Unit / behavior** (`tests/*.test.mjs`) — the bulk. Each CONTRACTS invariant earns a test. `tests/integrity.test.mjs` fails if `egpt.mjs` reads a config key not registered in `config/config-schema.mjs`.
- **Boot-profile contract** (`tests/boot-profile-contract.test.mjs`) — boots the REAL spine against an on-disk fixture in the canonical layout with NO path overrides; the tripwire for a relayout that slips past the unit suite.
- **Install verify** (`node setup/verify-install.mjs [service] [egptHome]`) — read-only, NOT in vitest. Probes the LIVE node: NSSM log paths, profile shape, `spine.pid`/`alive.txt` liveness, `claude` on PATH. Exit 0 = healthy.

Ad-hoc live probes (real Beeper / CDP / audio) live in `tests-manual/` — run by hand, never in CI.

## Isolation rule

Set `EGPT_HOME` to a temp dir for anything that touches a profile — never the
production `~/.egpt`.

## Two known flakes

`tests/transcriptor.test.mjs` and `tests/beeper-bridge.test.mjs` ("newest
isSender match") can fail only under full-suite port/timing contention. Both pass
alone. If one is the sole red, re-run it isolated (`npx vitest run tests/<file>`)
to confirm it's the flake, not a regression.
