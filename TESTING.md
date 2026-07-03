# eGPT — testing

## The suite

```bash
npx vitest run          # the whole suite (hermetic — no live node, no network)
npx vitest run <file>   # one file
npm run test:coverage   # whole-project coverage report
```

Every test is hermetic: pure libs, injected fs/clock, and fixtures — nothing
touches a live Beeper, a real profile, or the network. A green suite is the bar
for any change.

## Tiers worth knowing

- **Unit / behavior tests** (`tests/*.test.mjs`) — the bulk. Each recovered
  CONTRACTS.md invariant earns a behavior test that locks it; `tests/integrity.test.mjs`
  fails if a config key is read without being registered in
  `config/config-schema.mjs`.
- **Boot-profile contract** (`tests/boot-profile-contract.test.mjs`) — boots the
  REAL spine against an on-disk fixture in the canonical profile layout with NO
  path overrides, asserting the code's own constants find everything (registry +
  thread resume, flat identity seeding, `state/ingest` consume, `config/logs`,
  transcript write, media/transcription roots). This is the tripwire for the
  class of failure that a relayout can slip past the green unit suite.
- **Install verify** (`node setup/verify-install.mjs [service] [egptHome]`) —
  read-only, NOT part of `vitest`. Probes the LIVE node: NSSM service-log paths,
  profile shape, `state/spine.pid` + `state/alive.txt` liveness, `claude` on
  PATH. The drift no vitest can see. Exit 0 = healthy.

Ad-hoc live probes (real Beeper / CDP / audio) live in `tests-manual/` — run by
hand, never in CI.

## Known flakes

Two tests can fail only under full-suite port/timing contention; both pass in
isolation:

- `tests/transcriptor.test.mjs`
- `tests/beeper-bridge.test.mjs` — the "newest isSender match" case (real retry
  timers)

If one is the sole red, re-run it alone (`npx vitest run tests/<file>`) to
confirm it's the flake, not a regression. The real fix (fake timers / serialized
port binding) is on the backlog.
