// tests/setup-egpt-home.mjs — vitest setupFile (runs before EVERY test file loads).
//
// 2026-07-08 INCIDENT: a `vitest` run POLLUTED the LIVE profile log at
// ~/.egpt/config/logs/beeper.log with test-fixture lines (chat-1, Bea, "fake
// transcript", pic.png) and CORRUPTED a live diagnosis — the fixtures were mistaken
// for real traffic. ROOT CAUSE: startBeeperBridge's internal onLog ALWAYS
// appendFileSync's to _BEEPER_LOG = join(EGPT_HOME, 'config', 'logs', 'beeper.log')
// (src/bridges/beeper.mjs:224), and EGPT_HOME resolves to the REAL ~/.egpt when the
// env var is UNSET (src/egpt-home.mjs) — which it was for the whole suite. Every test
// that constructs the bridge (tests/beeper-bridge.test.mjs) leaked: onLog fires on
// ENTRY and on every incoming/media/👂.
//
// STRUCTURAL TRIPWIRE (class-wide, not just the bridge): force EGPT_HOME to a throwaway
// profile for the suite UNLESS the process already set one. So NO module can derive a
// path into the live profile during tests. Guarded by ||= (fills only an ABSENT value):
//   - an `EGPT_HOME=… vitest` invocation is preserved (explicit value wins);
//   - per-file / per-test overrides still win — boot-profile-contract, spine-v1-boot,
//     tool-profile-paths, beeper-log-path etc. assign process.env.EGPT_HOME directly and
//     (re)import egpt-home fresh AFTER this runs, so this default is already superseded.
//
// Rooted UNDER the user's home (a sibling of ~/.egpt), NOT os.tmpdir(): every REAL
// profile (~/.egpt, ~/.egpt2) lives under home, so home-relative derivations
// (conversations-state.conversationPathOf) resolve the same way they do in production.
// Not created on disk — the bridge's log append harmlessly no-ops on the missing
// config/logs dir, so nothing accumulates here; tests that need dirs create their own.
import { homedir } from 'node:os';
import { join } from 'node:path';

process.env.EGPT_HOME ||= join(homedir(), '.egpt-test-home');
