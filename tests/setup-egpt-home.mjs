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
// profile (~/.egpt, ~/.egpt-secondary) lives under home, so home-relative derivations
// (conversations-state.conversationPathOf) resolve the same way they do in production.
// Not created on disk — the bridge's log append harmlessly no-ops on the missing
// config/logs dir, so nothing accumulates here; tests that need dirs create their own.
//
// 2026-10-24 INCIDENT (node EDW): a coding agent ran `npx vitest run` from a being's
// shell, which INHERITS the spine's EGPT_HOME — the LIVE profile. The ||= kept it (an
// explicit value wins), so the suite ran AGAINST the live profile: stray dirs in ~/.egpt,
// and spine-brainpool's failure output printed the profile's real OAuth token in plain
// text. So an inherited EGPT_HOME that is a REAL profile (marker: config/config.yaml —
// the throwaway home above is never created, so it has none) is REFUSED: this throws,
// every test file fails loudly, and the message names the rerun. Never a silent redirect.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

if (process.env.EGPT_HOME && existsSync(join(process.env.EGPT_HOME, 'config', 'config.yaml'))) {
  throw new Error(`refusing to run the test suite against a LIVE eGPT profile: EGPT_HOME=${process.env.EGPT_HOME} has config/config.yaml. Rerun with it unset:  env -u EGPT_HOME npx vitest run`);
}

process.env.EGPT_HOME ||= join(homedir(), '.egpt-test-home');
