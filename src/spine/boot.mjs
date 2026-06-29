// boot.mjs — wire the ports + services and start the loop (SPINE-REWRITE-PLAN.md
// §2a boot()). This is the ONE place dependencies are assembled; the loop and
// every service stay ignorant of how they were constructed. The discipline holds
// here too: boot wires each service with an explicit dependency list and hands
// the bundle to createSpine — no service reaches into another.
//
// Every external edge is an injection seam (readConfig, the bridge transport,
// the claude session factory, conv-state IO), so boot() itself is testable
// end-to-end against fakes — the real services + real warm pool, fakes only at
// the transport + process boundary (tests/spine-boot.test.mjs).
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createSpine } from '../../spine.mjs';
import { EGPT_HOME } from '../egpt-home.mjs';
import { createBeeperBridgePort } from '../bridges/beeper-port.mjs';
import { createWarmPool } from '../warm-sessions.mjs';
import { createWarmCliSession } from '../warm-cli-session.mjs';
import { readConfigSync } from '../tools/config-io.mjs';
import {
  CONV_YAML_PATH, parse as parseConvState, serialize as serializeConvState, emptyState,
} from '../../conversations-state.mjs';

import { createIdentity } from './identity.mjs';
import { createGating } from './gating.mjs';
import { createRouter } from './router.mjs';
import { createTranscript } from './transcript.mjs';
import { createSender } from './sender.mjs';
import { createBrainPool } from './brainpool.mjs';

export async function boot({
  readConfig = readConfigSync,
  startBridge = null,                 // createBeeperBridgePort's `start` seam (null = real beeper)
  makeSession = createWarmCliSession, // the warm-session factory (null-safe for tests)
  loadState = null, writeState = null,// conv-state IO (null = real CONV_YAML_PATH)
  log = { line: (s) => { try { console.error(s); } catch {} } },
  now = () => Date.now(),
  tickMs = 5 * 60_000,
} = {}) {
  const cfg = readConfig() ?? {};
  const getConfig = () => cfg;

  // conv-state YAML IO — default to the real file, missing = empty state.
  const _loadState = loadState ?? (async () => {
    try { return parseConvState(await readFile(CONV_YAML_PATH, 'utf8')); }
    catch { return emptyState(); }
  });
  const _writeState = writeState ?? (async (s) => { await writeFile(CONV_YAML_PATH, serializeConvState(s), 'utf8'); });

  // --- ports ---
  const bridge = await createBeeperBridgePort({
    beeperToken: cfg.beeper_token ?? cfg.whatsapp?.beeper_token ?? process.env.BEEPER_ACCESS_TOKEN,
    userName: cfg.whatsapp?.user_name ?? cfg.user_name ?? null,
    isAllowedUser: (id) => (cfg.whatsapp?.allowed_users ?? []).includes(id),
    media: cfg.whatsapp?.media ?? {},
    stateDir: join(EGPT_HOME, 'state'),   // beeper-seen.jsonl etc. → this profile's state
    onLog: (m) => log.line?.(`[bridge] ${m}`),
  }, startBridge ? { start: startBridge } : {});

  const pool = createWarmPool({
    makeSession,
    max: cfg.warm?.max ?? 6,
    idleTtlMs: cfg.warm?.idle_ttl_ms ?? 180_000,
    onLog: (m) => log.line?.(`[warm] ${m}`),
  });

  // --- services (each DI-wired; none closes over another) ---
  const services = {
    identity: createIdentity({ now }),
    gating: createGating({ getConfig }),
    router: createRouter(),
    transcript: createTranscript({ loadState: _loadState, writeState: _writeState, persona: cfg.persona ?? null, onLog: (m) => log.line?.(`[transcript] ${m}`) }),
    sender: createSender({ bridge }),
    heartbeats: { runDue() {} },   // v1 stub — §11 decision 4 hook (auto-compact lands here)
  };
  const brain = createBrainPool({ pool, getConfig, loadState: _loadState, writeState: _writeState, onLog: (m) => log.line?.(`[brain] ${m}`) });

  const spine = createSpine({ bridge, brain, ...services, clock: { now }, log, tickMs });
  spine.start();
  return { spine, bridge, pool, cfg, stop: () => spine.stop() };
}
