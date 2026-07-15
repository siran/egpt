// boot.mjs — wire the ports + services and start the loop (plans/2606291226-SPINE-REWRITE-PLAN.md
// §2a boot()). This is the ONE place dependencies are assembled; the loop and
// every service stay ignorant of how they were constructed. The discipline holds
// here too: boot wires each service with an explicit dependency list and hands
// the bundle to createSpine — no service reaches into another.
//
// Every external edge is an injection seam (readConfig, the bridge transport,
// the claude session factory, conv-state IO), so boot() itself is testable
// end-to-end against fakes — the real services + real warm pool, fakes only at
// the transport + process boundary (tests/spine-boot.test.mjs).
import { readFile, writeFile, mkdir, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';

import { createSpine } from './spine.mjs';
import { EGPT_HOME } from '../egpt-home.mjs';
import { createBeeperBridgePort } from '../bridges/beeper-port.mjs';
import { createWarmPool } from '../warm-sessions.mjs';
import { createWarmCliSession } from '../warm-cli-session.mjs';
import { readConfigSync } from '../tools/config-io.mjs';
import { reapPort } from '../tools/reap-port.mjs';
import {
  CONV_YAML_PATH, parse as parseConvState, serialize as serializeConvState, emptyState, KNOWN_SURFACES, slugDir,
} from '../conversations-state.mjs';

import { createIdentity, surfaceOf } from './identity.mjs';
import { echoRank } from './echo-priority.mjs';
import { shortChatId } from '../bridges/chat-id.mjs';
import { createContacts } from './contacts.mjs';
import { createGating } from './gating.mjs';
import { createRouter } from './router.mjs';
import { createTranscript } from './transcript.mjs';
import { createSender } from './sender.mjs';
import { createBrainPool } from './brainpool.mjs';
import { createIngest, lifecycleExit } from './ingest.mjs';
import { createCommands } from './commands.mjs';
import { ownNodeNames } from './node-names.mjs';
import { createReplyActions } from './reply-actions.mjs';
import { createAdvice } from './advice.mjs';
import { createMedia } from './media.mjs';
import { createTranscription } from './transcription.mjs';
import { createTranscriptorWorker } from './transcriptor-worker.mjs';
import { startWhisperServer } from '../tools/whisper-server.mjs';
import { startTranscriptorServer } from '../tools/transcriptor.mjs';
import { createBrains } from './brains.mjs';
import { createMeshService } from './mesh.mjs';
import { createCompaction } from './compaction.mjs';
import { createHeartbeats } from './heartbeats.mjs';
import { createHeartbeatLoader, parseHeartbeatsBlock } from './heartbeat-loader.mjs';
import { seedSkeletons } from './seed.mjs';

// STRAY WHISPER-SERVER REAP (operator 2026-07-10): dropping `local` from a
// transcription profile's fallback_order (e.g. → [remote, cli] so this node leans on
// another node's GPU worker) ORPHANS the resident whisper-server the old chain spawned
// (~3.4GB with large-v3). The pipeline only reapPorts on the NEXT local spawn
// (src/tools/whisper-server.mjs), which now never happens — so the stray lingers holding
// the port + RAM. On boot we reap it, but ONLY when THIS node does not legitimately run a
// resident whisper-server. FAIL-SAFE: err toward NOT reaping — a lingering stray is far less
// bad than killing a live worker's server. Configs that legitimately run one, and MUST be
// left alone (operator 2026-07-10, DOLLY-shape correction):
//   1. the WORKER (GPU box e.g. DOLLY) runs a resident whisper-server under
//      whatsapp.media.audio_transcribe.server.enabled (the definitive DOLLY flag), and/or
//      the newer transcriptor.server.enabled; transcriptor.enabled (worker role) also implies
//      a worker box that runs one — treat any of these as "keep it";
//   2. a spine whose ACTIVE transcription profile still lists a whisper-server-local engine
//      in fallback_order — that engine lazily spawns + supervises its own.
const WHISPER_DEFAULT_PORT = 8089;   // mirrors src/tools/whisper-server.mjs (port = 8089)

// The active transcription_service profile (transcription_service[use_config]) — the same
// resolution src/spine/transcription.mjs uses; {} when unset.
function activeTxProfile(cfg) {
  const txSvc = cfg?.transcription_service;
  const profile = txSvc?.[txSvc?.use_config];
  return (profile && typeof profile === 'object') ? profile : {};
}

// Only an engine that is actually IN fallback_order gets spawned + supervised, so the
// DECISION reads fallback_order (a merely-defined-but-dropped engine does NOT count).
function hasActiveLocalWhisper(cfg) {
  const profile = activeTxProfile(cfg);
  const order = Array.isArray(profile.fallback_order) ? profile.fallback_order : [];
  return order.some((name) => profile?.[name]?.type === 'whisper-server-local');
}

// This node legitimately runs a resident whisper-server iff it is a WORKER box (DOLLY's
// audio_transcribe.server, the newer transcriptor.server, or the transcriptor worker role)
// or its active transcription chain owns a local one → reap ONLY when NONE hold (fail-safe).
export function shouldReapStrayWhisper(cfg) {
  if (cfg?.whatsapp?.media?.audio_transcribe?.server?.enabled === true) return false;   // DOLLY's resident server (the definitive worker flag)
  if (cfg?.transcriptor?.server?.enabled === true) return false;                        // newer worker resident-server shape
  if (cfg?.transcriptor?.enabled === true) return false;                                // worker role → conservatively assume it runs one
  if (hasActiveLocalWhisper(cfg)) return false;
  return true;
}

// The port a stray whisper-server would hold: prefer a whisper-server-local engine's
// configured port — a DROPPED engine's definition (removed from fallback_order but still in
// the profile) still carries the port of the orphan we must kill — else the worker
// resident-server port (transcriptor.server.port, then DOLLY's audio_transcribe.server.port),
// else the whisper-server default.
export function whisperPortOf(cfg) {
  const profile = activeTxProfile(cfg);
  for (const [name, eng] of Object.entries(profile)) {
    if (name === 'fallback_order') continue;
    if (eng && typeof eng === 'object' && eng.type === 'whisper-server-local' && eng.port != null) return Number(eng.port);
  }
  const tport = cfg?.transcriptor?.server?.port ?? cfg?.whatsapp?.media?.audio_transcribe?.server?.port;
  if (tport != null) return Number(tport);
  return WHISPER_DEFAULT_PORT;
}

// READABLE NODE-IDENTITY (operator 2026-07-10): two co-account spines (REVE `kg`, DOLLY `do`)
// share ONE Beeper account, so on the wire every line looks "from the account owner" and the
// persona itself couldn't say which node it is. Assemble a concise, FACTUAL who/where-am-I line
// the persona always carries in its system prompt (brainpool appends it to the PERSONA turn
// only), so identity survives RESUMED threads — the first-turn kickoff feed only lands on a
// FRESH thread. NOT a signature, NOT invisible encoding: the visible in-chat node marker stays
// the per-node body_emoji. Pure so it is testable directly (mirrors shouldReapStrayWhisper).
//   address  = <name>.<node_name> lowercased (don.do, egpt.kg)
//   handles  = the persona agent's handles as `@d @don`
//   peers    = account_peers MINUS this node's own names (node_name ∪ node_alias); the "Other
//              nodes" sentence is OMITTED when that leaves nothing (a solo node).
export function buildNodeIdentity({
  name,                 // persona display name (labelOf(defaultKey))
  nodeName,             // cfg.node_name
  userName,             // cfg.user_name (whatsapp.user_name wins, mirroring the bridge)
  handles = [],         // the persona agent's `handles`
  emoji,                // bodyEmojiOf(defaultKey) — this node's reply stamp
  accountPeers = [],    // node identities sharing this Beeper account (incl. self)
  nodeAlias = [],       // this node's extra self-names (cfg.node_alias)
} = {}) {
  const address = `${String(name).toLowerCase()}.${String(nodeName).toLowerCase()}`;
  const handleStr = handles.map((h) => `@${h}`).join(' ');
  const own = ownNodeNames({ nodeName, nodeAlias });
  const peers = accountPeers.filter((p) => !own.has(String(p).toLowerCase()));
  let s = `You are the eGPT persona "${name}" running as ${address} — node "${nodeName}", ${userName}'s account. You answer to ${handleStr}; your reply stamp is ${emoji}.`;
  if (peers.length) s += ` Other nodes on this account: ${peers.join(', ')}.`;
  return s;
}

export async function boot({
  readConfig = readConfigSync,
  startBridge = null,                 // createBeeperBridgePort's `start` seam (null = real beeper)
  makeSession = createWarmCliSession, // the warm-session factory (null-safe for tests)
  loadState = null, writeState = null,// conv-state IO (null = real CONV_YAML_PATH)
  io = {},                            // fs seam for transcript + brainpool + contacts ({appendFile,mkdir,existsSync,rename}); real fs by default. Tests inject in-memory so they never touch the profile.
  log = { line: (s) => { try { console.error(s); } catch {} } },
  now = () => Date.now(),
  // The tick is the loop's PULSE now — every registered heartbeat's cadence rides
  // on it, so tickMs must be finer than the finest cadence. 30s lets the 60s alive
  // beat be honored (a 5-min tick never could).
  tickMs = 30_000,
  aliveMs = 0,                        // >0: register the alive-file writer as a heartbeat so the daemon's wedge check sees liveness
  spawn: spawnFn = spawn,             // child_process.spawn seam — heartbeat command beats (incl. the alive script) spawn through here; tests inject a fake to observe the beat WITHOUT a real process
  reapPort: reapPortFn = reapPort,    // port-killer seam — the boot-time stray-whisper reap goes through here; tests inject a fake so the real netstat/taskkill NEVER runs against a live server
  // transcriptor WORKER-role process-boundary seams — the resident whisper-server + the :23390
  // endpoint spawn through here. Default to the real spawners; tests inject fakes so a boot with
  // transcriptor.enabled NEVER spawns a real whisper-server or binds a real port (see below).
  startWhisperServer: startWhisperServerFn = startWhisperServer,
  startTranscriptorServer: startTranscriptorServerFn = startTranscriptorServer,

  ingest = true,                      // watch EGPT_HOME/state/ingest for /restart, /upgrade, /rewind (tests pass false)
  exit = (code) => process.exit(code),// how a lifecycle command leaves (the daemon respawns on 42/43/44)
  setInterval: setIntervalFn = globalThis.setInterval,       // the spine tick-timer seam; injected so a test can observe the effective cadence
  clearInterval: clearIntervalFn = globalThis.clearInterval,
} = {}) {
  const cfg = readConfig() ?? {};
  const getConfig = () => cfg;

  // Identity vs liveness are SEPARATE files now (operator 2026-07-02): state/
  // spine.pid holds the long-lived spine pid — written ONCE here because it never
  // changes; the second-daemon guard (src/daemon-singleton.mjs) reads it. Liveness
  // is a different file, state/alive.txt, whose MTIME the alive heartbeat beats
  // every tick. The pid needs no heartbeat.
  try {
    await mkdir(join(EGPT_HOME, 'state'), { recursive: true });
    await writeFile(join(EGPT_HOME, 'state', 'spine.pid'), String(process.pid), 'utf8');
  } catch (e) { log.line?.(`[boot] spine.pid write failed: ${e?.message ?? e}`); }

  // Seed the profile's paste-ready templates (config/skeletons/*) + a commented example
  // agent-type file (config/agents/sonnet-high.yaml) — COPY-IF-MISSING, so operator edits
  // are never touched. Real-node only (ingest-gated, like the other boot side effects) so
  // tests don't write into a profile. Never fatal.
  if (ingest) { try { seedSkeletons({ onLog: (m) => log.line?.(`[seed] ${m}`) }); } catch (e) { log.line?.(`[boot] seed failed: ${e?.message ?? e}`); } }

  // The `agents:` block is the ONE registry (operator 2026-07-02, new-config-only): the
  // persona identity + local beings + mesh addressing all live here. It is REQUIRED, and
  // exactly ONE agent must carry `default: true` — that agent IS the persona (it answers
  // un-@mentioned messages and terminates relay chains that resolve to it). No agents block,
  // no default agent, or MORE THAN ONE default agent is a fatal misconfiguration, not a
  // silent fallback to a guessed default. Fail loudly so the operator fixes it — the
  // agent-identity refactor (operator 2026-07-10) removed the hardcoded e/egpt persona test:
  // the persona is `default: true`, its being-id is its MAP KEY, nothing about the key
  // string is magic anywhere below.
  const agents = () => cfg.agents ?? {};
  const agentIds = (name, a) => [name, ...(Array.isArray(a?.handles) ? a.handles : [])].map((h) => String(h).toLowerCase());
  const CONFIG_FILE = 'config/config.yaml';   // named in the fatal message so the operator knows where to fix it
  const personaAgent = () => {
    const found = [];
    for (const [name, a] of Object.entries(agents())) {
      if (!a || typeof a !== 'object' || Array.isArray(a)) continue;
      if (a.default === true) found.push({ name, agent: a });
    }
    if (found.length === 1) return found[0];
    if (found.length === 0) {
      throw new Error(`boot: no persona agent — config.agents must declare exactly one agent with \`default: true\` (${CONFIG_FILE}). See config/skeletons/config.yaml.`);
    }
    throw new Error(`boot: ${found.length} agents carry \`default: true\` (${found.map((f) => f.name).join(', ')}) — exactly one is allowed (${CONFIG_FILE}).`);
  };
  if (!cfg.agents || typeof cfg.agents !== 'object' || Array.isArray(cfg.agents)) {
    throw new Error(`boot: config.agents must be a map declaring exactly one persona agent (\`default: true\`) — no agents block is a fatal misconfiguration (${CONFIG_FILE}). See config/skeletons/config.yaml.`);
  }
  // The persona's being-id: the lowercased MAP KEY of the single default agent, resolved
  // ONCE here and injected into the pure modules (router/gating/brainpool) that can't read
  // config. Every persona check downstream compares against this, never against 'e'/'egpt'.
  const defaultKey = personaAgent().name.toLowerCase();

  // A being's body_emoji + display label, resolved purely from the agents registry BY KEY
  // (the being IS the key now — no e/egpt special case). body_emoji falls back to the dog;
  // name falls back to the key.
  const bodyEmojiOf = (being) => {
    const a = agents()[String(being ?? '').toLowerCase()];
    return (a && typeof a === 'object' && a.body_emoji) ? a.body_emoji : '🐶';
  };
  const labelOf = (being) => {
    const a = agents()[String(being ?? '').toLowerCase()];
    return (a && typeof a === 'object' && a.name) ? a.name : String(being ?? '');
  };
  // Per-AGENT signature WRAP (operator 2026-07-12): agent_signature_open/close bracket a persona/being
  // reply as the INNER concentric layer (bridge_signature_* is the outer, per-node layer — resolved at
  // the bridge). These fall back agent → node → ''. The sender resolves them per-being and hands them to
  // the port, which does the wrap. Default '' → nothing added (a reply renders with NO end-marker).
  // agent_signature_close is the SOLE agent close now — the historical inline signature end-marker
  // was removed 2026-07-12.
  const agentSignatureOpenOf = (being) => {
    const a = agents()[String(being ?? '').toLowerCase()];
    return (a && typeof a === 'object' && a.agent_signature_open != null) ? a.agent_signature_open : (cfg.agent_signature_open ?? '');
  };
  const agentSignatureCloseOf = (being) => {
    const a = agents()[String(being ?? '').toLowerCase()];
    return (a && typeof a === 'object' && a.agent_signature_close != null) ? a.agent_signature_close : (cfg.agent_signature_close ?? '');
  };

  // conv-state YAML IO — default to the real file, missing = empty state.
  const _loadState = loadState ?? (async () => {
    try { return parseConvState(await readFile(CONV_YAML_PATH, 'utf8')); }
    catch { return emptyState(); }
  });
  const _writeState = writeState ?? (async (s) => { await writeFile(CONV_YAML_PATH, serializeConvState(s), 'utf8'); });

  // The ONE shared contact-resolver: every service that needs a chat's slug goes
  // through here, so the pushedName refresh + rename self-heal (move the slug dir
  // old→new + write renames.log) run for KNOWN chats too, not just new ones.
  const contacts = createContacts({ loadState: _loadState, writeState: _writeState, io, onLog: (m) => log.line?.(`[contacts] ${m}`) });

  // Voice/video transcription: the fallback CHAIN (remote node → local whisper-
  // server → cli), driven by config.transcription_service. One transcriber feeds
  // the bridge (voice notes) and the media service (a video's audio).
  const tx = createTranscription({ getConfig, onLog: (m) => log.line?.(`[transcribe] ${m}`) });

  // Reap a stray resident whisper-server this node no longer runs (operator 2026-07-10):
  // when `local` was dropped from the active profile's fallback_order, the old chain's
  // whisper-server is orphaned — reap it (see shouldReapStrayWhisper). Real-node only
  // (ingest-gated) so tests never invoke the real killer; best-effort (reapPort never throws).
  if (ingest) {
    const wport = whisperPortOf(cfg);
    if (shouldReapStrayWhisper(cfg)) {
      const killed = reapPortFn(wport, (m) => log.line?.(`[whisper-reap] ${m}`));
      log.line?.(`[whisper-reap] no resident whisper-server on this node — reaped stray on :${wport} (killed ${killed})`);
    } else {
      log.line?.(`[whisper-reap] this node runs a resident whisper-server — leaving :${wport} untouched`);
    }
  }

  // WORKER ROLE: transcriptor (operator 2026-06-10, ported from v1 egpt-spine.mjs to v2 boot
  // 2026-07-10). A node whose config declares `transcriptor.enabled: true` (e.g. DOLLY, the GPU
  // box) serves the signed POST /v1/transcribe endpoint for the MAIN spine's voice notes, and —
  // when transcriptor.server (legacy: whatsapp.media.audio_transcribe.server) is enabled — runs a
  // resident whisper-server so it answers in ~encode+decode time. INGEST-GATED like the other
  // real-node side effects (whisper-reap, seedSkeletons): start() spawns/binds only on a real node
  // (tests pass ingest:false → never called → no real port). FIRE-AND-FORGET (not awaited): the
  // resident whisper-server's model-load readiness wait (up to 120s) must NOT stall the spine's
  // tick + alive heartbeat. Reconciles with the whisper-reap above: a transcriptor.enabled node
  // makes shouldReapStrayWhisper() false, so boot never reaps the very port the worker is about to
  // bind (whisper-server.mjs reaps its OWN orphan just-in-time before its spawn).
  const transcriptorWorker = createTranscriptorWorker({
    getConfig,
    startWhisperServer: startWhisperServerFn,
    startTranscriptorServer: startTranscriptorServerFn,
    onLog: (m) => log.line?.(`[transcriptor] ${m}`),
  });
  if (ingest) transcriptorWorker.start();

  // The persona wake-word set (operator 2026-07-09: SYMMETRIC nodes — each wakes on its OWN
  // configured handles only, NOTHING is injected network-wide). ONE source of truth (the agents
  // block): the persona agent's name + every configured handle, lowercased (agentIds does that).
  // So @e wakes only a node whose persona configures `e`; a node with handles [ed, egptd] wakes
  // on @ed, NOT @e. (Reverted the 2026-07-08 network-wide e/egpt injection — that overlap was
  // self-inflicted and the whole suppression apparatus it needed is gone.)
  const wakeWords = (() => { const pa = personaAgent(); return [...new Set(agentIds(pa.name, pa.agent))]; })();
  // 👂 ECHO AGE BOUND (operator 2026-07-09, Zohykar incident; renamed from transcribe_ack_max_age_ms):
  // never echo a note whose OWN timestamp is older than this — a Beeper resync's ancient backlog
  // notes are still transcribed + logged, just never echoed into the live chat. Default 1h.
  const echoMaxAgeMs = Number.isFinite(cfg.echo_max_age_ms) ? cfg.echo_max_age_ms : 3_600_000;
  // account_peers (operator 2026-07-09): node identities sharing THIS Beeper account (incl self).
  // Still carried for the persona node-identity line (buildNodeIdentity) + the boot return; the 👂
  // echo priority reads echo_priority (below), falling back to account_peers.
  const accountPeers = Array.isArray(cfg.account_peers) ? cfg.account_peers : [];

  // 👂 ECHO — STATIC PRIORITY + ORDERED FAILOVER (operator 2026-07-11, Phase 3b; plans/2607101713-HRW-ECHO-PLAN.md).
  // NOT dedup. Two co-account spines (REVE `kg`, DOLLY `do`) both see each voice note; without a pick
  // BOTH would post its 👂 → double. We DROP the earlier per-note HRW hash: it keyed on the note's
  // Beeper message id ASSUMING that id is identical on both nodes, but Beeper ids are NODE-LOCAL, so
  // the nodes hashed different strings and ~1/4 of notes had both compute rank-1 → double 👂. Instead
  // a STATIC priority order (echo_priority, IDENTICAL in both configs) fixes each node's rank ONCE:
  // rank 1 (the primary, e.g. DOLLY) posts every note; a lower rank promotes only if the higher ranks
  // are OFFLINE/silent (the bridge posts at rank 1, ARMS a promotion at (rank-1)*echoTimeoutMs for
  // rank>1, and stands down when it OBSERVES the note's 👂 from a higher rank — echo-priority.mjs +
  // incoming-media.mjs). echoPlan IGNORES its noteId arg (kept ONLY so the bridge call site is
  // unchanged): the rank is note-INDEPENDENT, which is the whole point — the two nodes can never
  // disagree on who is rank 1. HARD OPT-OUT preserved: echo:false → { rank: 0 }, which the bridge
  // treats as never post / never promote — the note is still transcribed + logged.
  const node_name = cfg.node_name ?? null;
  // The priority order, resolved ONCE (never per note), all lowercased: echo_priority wins, else
  // account_peers, else [self] (a solo node is always rank 1).
  const echoPriority = (
    Array.isArray(cfg.echo_priority) ? cfg.echo_priority
    : Array.isArray(cfg.account_peers) ? cfg.account_peers
    : [node_name]
  ).map((p) => String(p).toLowerCase());
  const staticEchoRank = echoRank(node_name, echoPriority);
  // Per-rank promotion step (operator 2026-07-11). GENEROUS default (20s) ON PURPOSE: a waiter can't
  // tell "rank-1 DOWN" from "rank-1 SLOW", so too-short pre-empts a merely-slow primary → DOUBLE 👂
  // (the one real hazard); too-long = slow failover. Tunable per node (config echo_timeout_ms).
  const echoTimeoutMs = Number.isFinite(cfg.echo_timeout_ms) ? cfg.echo_timeout_ms : 20_000;
  // 👂 COVERAGE THRESHOLD (operator 2026-07-12): word-token overlap fraction above which a reply to a
  // note counts as already-covering it, so this node stands down instead of double-echoing (the bridge's
  // noteCovered query; replaced the observed-set + arrival-lag scaffold). Default 0.6.
  const coverageThreshold = Number.isFinite(cfg.echo_coverage_similarity) ? cfg.echo_coverage_similarity : 0.6;
  // BOOT ASSERTION (operator 2026-07-11): a node that echoes MUST appear in its own priority list. A
  // staticEchoRank of 0 means node_name isn't in echo_priority, so this node would SILENTLY never
  // echo (and if the peer is likewise misconfigured, no node echoes — or both do). Fail loudly so the
  // operator fixes the config — this makes the silent-divergence class impossible. Mirrors the
  // persona `default:true` fatal above. echo:false opts out entirely, so the check is skipped there.
  if (cfg.echo !== false && staticEchoRank === 0) {
    throw new Error(`boot: node_name "${node_name}" is not in the 👂 echo priority [${echoPriority.join(', ')}] — a node that echoes must appear in echo_priority (or account_peers), else it would never echo (${CONFIG_FILE}). Add "${node_name}" to the list, or set echo:false to opt out.`);
  }
  const echoPlan = cfg.echo === false
    ? () => ({ rank: 0, winner: false })
    : () => ({ rank: staticEchoRank, winner: staticEchoRank === 1 });

  // The persona's node-identity addendum (operator 2026-07-10): assembled ONCE from the pieces
  // already resolved above + the persona agent's handles, and handed to the brain pool, which
  // appends it to the PERSONA turn's system prompt (siblings are engineers, out of scope). Only
  // when this node has a node_name — without one the "who/where" is meaningless, so we omit it
  // (brainpool's filter(Boolean) leaves the def's own system_prompt untouched).
  const nodeIdentity = node_name
    ? buildNodeIdentity({
        name: labelOf(defaultKey),
        nodeName: node_name,
        userName: cfg.whatsapp?.user_name ?? cfg.user_name ?? null,
        handles: (() => { const a = personaAgent().agent; return Array.isArray(a?.handles) ? a.handles : []; })(),
        emoji: bodyEmojiOf(defaultKey),
        accountPeers,
        nodeAlias: Array.isArray(cfg.node_alias) ? cfg.node_alias : [],
      })
    : null;

  // Per-surface config resolver (operator 2026-07-09): the NEW shape wraps the per-surface
  // blocks under `networks:` and lists command channels as `chat_ids` (plural); the OLD shape
  // has top-level whatsapp:/telegram:/signal: blocks with a singular `chat_id`. ONE resolver
  // reads BOTH, PREFERS `networks:`, and always yields a `chat_ids` LIST so every reader below
  // is shape-agnostic (a singular chat_id normalizes to a 1-element list).
  const surfaceCfg = (surface) => {
    const raw = (cfg.networks?.[surface] && typeof cfg.networks[surface] === 'object') ? cfg.networks[surface]
              : (cfg[surface] && typeof cfg[surface] === 'object') ? cfg[surface]
              : {};
    const chat_ids = Array.isArray(raw.chat_ids) ? raw.chat_ids : (raw.chat_id != null ? [raw.chat_id] : []);
    const allowed_users = Array.isArray(raw.allowed_users) ? raw.allowed_users : [];
    return { ...raw, chat_ids, allowed_users };
  };
  // Active Beeper token (operator 2026-07-09): the new `beeper:` block selects an account with
  // `use` → beeper[use].token. BACK-COMPAT: no block / no `use` → the top-level beeper_token key,
  // then the BEEPER_ACCESS_TOKEN env var (unchanged).
  const beeperToken = (() => {
    const b = cfg.beeper;
    const sel = b && typeof b === 'object' ? b.use : null;
    const acct = sel && b[sel] && typeof b[sel] === 'object' ? b[sel] : null;
    return acct?.token ?? cfg.beeper_token ?? process.env.BEEPER_ACCESS_TOKEN;
  })();

  // (The old pre-👂 OPEN vs observe-cancel warning was removed 2026-07-12: co-account de-dup is now the
  // on-demand coverage query (src/bridges/beeper.mjs noteCovered), which matches on normalized WORD TOKENS
  // — position- and marker-independent — so a bridge_signature_open / transcription_open that lifts the 👂
  // off the leading edge no longer breaks dedup. The opens are safe on a multi-peer node.)

  // --- ports ---
  const bridge = await createBeeperBridgePort({
    beeperToken,
    userName: cfg.whatsapp?.user_name ?? cfg.user_name ?? null,
    // Per-surface authorization (operator 2026-07-02): ids are per-surface
    // NAMESPACES — a WhatsApp jid authorizes nothing on Telegram — so the sender
    // is checked against the origin network's OWN allowed_users (surfaceOf maps
    // the network → whatsapp|telegram|signal block). Empty list = deny
    // (fail-closed). isSender (the account owner) still authorizes globally — that
    // flag is orthogonal, set by the bridge, not here. BACK-COMPAT: a whatsapp
    // message resolves to cfg.whatsapp.allowed_users exactly as before; other
    // surfaces move from borrowing whatsapp's list to fail-closed deny, the
    // operator-intended tightening. allowed_users entries are USUALLY sender
    // ids (a network jid / phone number / '@user:beeper.com') but the schema
    // also allows a Beeper ROOM id there; normalize BOTH sides through
    // shortChatId (a no-op on anything that isn't a '!...:beeper.local' room
    // id — sender ids/phone numbers pass through untouched) so a short OR
    // legacy full-form entry compares equal to the delivered id either way.
    isAllowedUser: (id, network) => surfaceCfg(surfaceOf(network)).allowed_users.map(shortChatId).includes(shortChatId(id)),
    media: cfg.whatsapp?.media ?? {},
    transcribe: tx.transcribe,                                  // the fallback-chain transcriber
    transcribeCfg: tx.cliCfg,
    resolveTranscriptionService: tx.resolveTranscriptionService,// { enabled, postsBack } per chat
    postsBackDelayMs: tx.postsBackDelayMs,                      // how fast the 👂 transcript echoes back
    flood: cfg.flood ?? {},               // send-flood guard (limit / window_ms / cooldown_ms) per chat
    personaEmoji: bodyEmojiOf(defaultKey),// 🐶 — the marker the bridge uses to suppress E's own re-ingested messages
    // Per-NODE infra WRAP layers (operator 2026-07-12): bridge_signature_open/close bracket persona
    // replies + 👂 echoes (which SPINE posted: REVE kg vs DOLLY do); transcription_open/close is the
    // 👂 echo's own inner frame. All default '' → nothing added (byte-identical to today). The port
    // uses bridge_* for persona replies + forwards bridge_* + transcription_* to the 👂 echo. Agent
    // layers are per-being (agentSignature*Of), resolved in the sender, not here. ⚠️ *_open lifts the
    // 👂 off the leading edge → breaks observe-cancel on a >1-peer node (warned above).
    bridgeSignatureOpen: cfg.bridge_signature_open ?? '',
    bridgeSignatureClose: cfg.bridge_signature_close ?? '',
    transcriptionOpen: cfg.transcription_open ?? '',
    transcriptionClose: cfg.transcription_close ?? '',
    wakeWords,                            // the persona agent's OWN name + handles only — nothing injected (operator 2026-07-09)
    echoPlan,                             // 👂 echo PLAN: () => { rank, winner } — STATIC priority rank + ordered failover (operator 2026-07-11, Phase 3b; note-INDEPENDENT, the noteId arg is ignored). rank 1 posts now; rank>1 arms a promotion at (rank-1)*echoTimeoutMs that re-checks coverage at fire; rank 0 (echo:false opt-out) never posts/promotes.
    echoTimeoutMs,                        // 👂 per-rank promotion step (ms); GENEROUS default so a SLOW rank-1 isn't mistaken for a DOWN one (double-👂 hazard).
    coverageThreshold,                    // 👂 word-token overlap fraction for the on-demand noteCovered query (operator 2026-07-12) — replaced the observed-set + arrival-lag/reconnect scaffold
    echoMaxAgeMs,                         // 👂 only echoes a note within this age of its own timestamp (operator 2026-07-09)
    stateDir: join(EGPT_HOME, 'state'),   // beeper-seen.jsonl etc. → this profile's state
    onLog: (m) => log.line?.(`[bridge] ${m}`),
  }, startBridge ? { start: startBridge } : {});

  // Persist incoming attachments into the chat's media/ folder + surface them to E.
  // For a video: keyframes (ffmpeg) + audio transcript (via the same chain) — Route A.
  const media = createMedia({ contacts, io, transcribe: tx.transcribe, transcribeCfg: tx.cliCfg, onLog: (m) => log.line?.(`[media] ${m}`) });
  bridge.onMedia((m) => media.save(m));

  // --- lifecycle announce: "restarting…" to Self before exit, "back up! <commit>"
  //     on the next boot. The bounce is otherwise invisible to the operator. ---
  const sidecar = join(EGPT_HOME, 'state', 'restart-announce.json');
  const KIND_OF = { 43: '/restart', 42: '/upgrade', 44: '/rewind' };
  const gitOut = (args) => { try { return spawnSync('git', args, { cwd: process.cwd() }).stdout?.toString().trim() || ''; } catch { return ''; } };
  const shortSha = () => gitOut(['rev-parse', '--short', 'HEAD']) || '?';
  async function announceAndExit(code) {
    const selfDm = surfaceCfg('whatsapp').chat_ids[0];   // first command channel = the Self-DM announce target
    try { await mkdir(join(EGPT_HOME, 'state'), { recursive: true }); await writeFile(sidecar, JSON.stringify({ chatId: selfDm, kind: KIND_OF[code] ?? '?', preSha: shortSha(), pid: process.pid })); } catch {}
    // best-effort going-down — names the PID going down (capped so a slow POST can't wedge the exit)
    try { if (selfDm) await Promise.race([bridge.send(selfDm, `↻ ${KIND_OF[code] ?? 'restart'}… (pid ${process.pid})`), new Promise((r) => setTimeout(r, 3000))]); } catch {}
    exit(code);
  }

  const pool = createWarmPool({
    makeSession,
    max: cfg.warm?.max ?? 6,
    // E runs as a PERSISTENT background agent: the claude process stays resident
    // (context in memory) instead of re-spawning + `--resume`-ing (which reloads
    // the whole thread — the slow part) per message. idle_ttl_by_class: ms-of-idle
    // before a class is evicted; 0 = never idle-evict, bounded only by `max` LRU.
    // E's chats are 'conversation'.
    //
    // CONVERSATION DEFAULT = 15m (operator 2026-07-02, verbatim: "keep any
    // conversation as a background agent 15m after the last message, configurable.
    // i like that you can keep a number or all agents warm. probably we should
    // honor override per configuration"). This SUPERSEDES the earlier never-evict
    // default (commit 4eaceaf "E is a persistent background agent — never idle-evict
    // conversations", which set conversation: 0): a conversation now goes cold 15m
    // after its last turn, and the transcript + `--resume` make the next turn
    // correct, just colder. system/resident stay 0 (truly persistent). `sibling`
    // stays 0 — the operator only ruled on conversations, so it is left untouched.
    //
    // `warm.max` is the "keep a number — or, with a high max, all — agents warm"
    // knob the operator likes: the LRU cap bounds how many warm sessions live at
    // once, independent of the idle TTL. Per-conversation override: a conversation
    // folder's own config.yaml `warm: { idle_ttl }` beats the class TTL (resolved in
    // brainpool, passed per-run to the pool); 0 there = keep THAT conversation warm.
    idleTtlMs: cfg.warm?.idle_ttl_ms ?? 1_800_000,   // fallback for any unlisted class
    idleTtlByClass: cfg.warm?.idle_ttl_by_class ?? { system: 0, resident: 0, conversation: 900_000, sibling: 0 },
    onLog: (m) => log.line?.(`[warm] ${m}`),
  });

  // --- services (each DI-wired; none closes over another) ---
  const services = {
    identity: createIdentity({ now }),
    gating: createGating({ getConfig, loadState: _loadState, defaultKey }),
    // Router resolves an @token against the unified `agents:` block (operator 2026-07-02),
    // then cross-node @being.node mesh targets (Phase 4b, inert unless cfg.mesh is configured).
    // defaultBeing = defaultKey: the persona-route + the un-@mentioned fall-through both yield
    // the persona's KEY (operator 2026-07-10 — no hardcoded 'e'/'egpt').
    router: createRouter({ getAgents: () => cfg.agents ?? {}, defaultBeing: defaultKey, getNode: () => cfg.node_name ?? null, getAliases: () => cfg.node_alias ?? [], meshEnabled: () => !!cfg.mesh }),
    transcript: createTranscript({ contacts, persona: labelOf(defaultKey), defaultKey, node_name, io, onLog: (m) => log.line?.(`[transcript] ${m}`) }),
    sender: createSender({ bridge, bodyEmojiOf, labelOf, agentSignatureOpenOf, agentSignatureCloseOf, defaultKey }),
    // The real cadence registry the spine's tick() drives. The heartbeat LOADER
    // (below) collects every declarative heartbeat and registers it here, so each
    // beat rides the loop's own tick instead of a side timer (operator 2026-07-01).
    // Boot then REPLACES this slot with the loader's decorated wrapper (wrapRegistry)
    // so the reload staleness check rides runDue — see below.
    heartbeats: createHeartbeats({ onLog: (m) => log.line?.(`[heartbeat] ${m}`) }),
  };
  // Brain registry: resolves the agent-type file (YAML defs in src/brains ← ~/.egpt2/config
  // /agents ← <slug>/brains) a fresh conversation is instanced from, named by the persona
  // agent's `configuration`.
  const brains = createBrains({ onLog: (m) => log.line?.(`[brains] ${m}`) });

  // Auto-compaction: keep each conversation's warm session thin (native /compact a
  // cooling period after the last reply, once it's over ratio of the window).
  const compaction = createCompaction({ pool, getConfig, onLog: (m) => log.line?.(`[compact] ${m}`) });
  const brain = createBrainPool({ pool, getConfig, contacts, loadState: _loadState, writeState: _writeState, brains, defaultKey, nodeIdentity, afterTurn: compaction.afterTurn, io, onLog: (m) => log.line?.(`[brain] ${m}`) });

  // Cross-node being relay (Phase 4b). Supplies the mesh engine's host callbacks from
  // v2 services: bridge (send/postStatus/startStream), brain (the responder's turn),
  // config (node_name/agents/mesh.nodes routes). onEdit is registered here (its ONE
  // consumer) so a responder's in-place stream edits mirror to the origin placeholder.
  const mesh = createMeshService({ bridge, brain, getConfig, bodyEmojiOf, onLog: (m) => log.line?.(`[mesh] ${m}`) });
  bridge.onEdit((e) => mesh.onEdit({ msgId: e.msgId, newText: e.newText }));

  // operator slash commands (Self DM / authorized) — lifecycle wired now; reuses
  // the same exit codes the daemon respawns on.
  const commands = createCommands({
    getConfig,
    send: (chatId, text) => bridge.send(chatId, text),
    exit: announceAndExit,
    writeRewindTarget: (ref) => writeFile(join(EGPT_HOME, 'rewind-target.txt'), ref, 'utf8'),
    loadState: _loadState, writeState: _writeState,   // /e auto <mode> + the /e wizard persist into conversations.yaml
    brains,                                           // the /e wizard resolves a picked agent type through the registry
    defaultKey,                                       // the persona being-id (its map key) — /e auto + /status + wizard key their per-conversation reads/writes/evictions off this, never 'e' (operator 2026-07-10)
    evictWarm: (key) => pool.evict(key),              // drop a re-pointed conversation's warm session so it respawns fresh
    onLog: (m) => log.line?.(`[command] ${m}`),
  });

  // Conversation-E LIMBS (ROADMAP §3): a reply may carry own-line action commands
  // (react/reply/media/edit/delete) which the spine strips from the surfaced prose and
  // executes AFTER recording, confined to the reply's OWN conversation. /media paths
  // resolve against the conversation's own folder (E's confined cwd) — the SAME slug
  // resolver the transcript/brain use, so a file E created in its cwd is reachable and
  // nothing outside it is.
  const resolveConvDir = async (ev) => {
    try { const slug = await contacts.resolve(ev.surface, ev.chatId, { chatName: ev.chatName }); return slug ? slugDir(ev.surface, slug) : null; }
    catch { return null; }
  };

  // Advice channel (mode: auto): the ONE sanctioned cross-chat path. E's /ask limb posts
  // to config.advice_channel through this service, which also routes the operator's
  // quote-reply answer back into the origin conversation (dispatch bound after the spine
  // exists). Fail-closed when advice_channel is unset.
  const advice = createAdvice({ bridge, getConfig, onLog: (m) => log.line?.(`[advice] ${m}`) });
  const actions = createReplyActions({ bridge, bodyEmojiOf, labelOf, resolveConvDir, askAdvice: (a) => advice.ask(a), defaultKey, onLog: (m) => log.line?.(`[actions] ${m}`) });

  // Heartbeats are DECLARATIVE now (operator 2026-07-01): the loader collects
  // them from the node config.heartbeats block + every conversation/room folder's
  // config.yaml heartbeats: block, materializes state/heartbeats.readonly.yaml,
  // and registers each onto services.heartbeats. The alive-file writer is no
  // longer special-cased here — it is the loader's default `alive` command
  // (echo beat > state/alive.txt), visible in the readonly view like any other.
  //
  // Enumerate the entity folders (conversations/<surface>/<slug>/ + rooms/<name>/).
  // Rooms live at EGPT_HOME/rooms/<name>/ (Room.named → NamedRoom.baseDir, src/
  // room-core.mjs); the sibling rooms/config.yaml roster FILE is skipped (dirs
  // only). Missing dirs are tolerated (a fresh profile has none).
  async function listEntityDirs() {
    const out = [];
    const convRoot = join(EGPT_HOME, 'conversations');
    for (const surface of KNOWN_SURFACES) {
      let ents = [];
      try { ents = await readdir(join(convRoot, surface), { withFileTypes: true }); } catch { continue; }
      for (const ent of ents) if (ent.isDirectory()) out.push({ dir: join(convRoot, surface, ent.name), ns: `${surface}/${ent.name}` });
    }
    let rooms = [];
    try { rooms = await readdir(join(EGPT_HOME, 'rooms'), { withFileTypes: true }); } catch { rooms = []; }
    for (const ent of rooms) if (ent.isDirectory()) out.push({ dir: join(EGPT_HOME, 'rooms', ent.name), ns: `room/${ent.name}` });
    return out;
  }
  const readEntityConfig = async (dir) => {
    try { return parseHeartbeatsBlock(await readFile(join(dir, 'config.yaml'), 'utf8')); }
    catch { return {}; }
  };

  // The default alive beat is a shell one-liner, visible in config and in
  // state/heartbeats.readonly.yaml: `echo beat > state/alive.txt`. Liveness is the
  // file's MTIME (any command that writes it is a valid beat; the "beat" content
  // is freeform, for humans), so the old parsed-line contract + the 82-line script
  // are gone. The loader runs it with cwd = EGPT_HOME so the relative state/ lands
  // in the profile. Verified on Windows cmd + POSIX sh (spawn shell:true).
  const aliveCommand = 'echo beat > state/alive.txt';

  const heartbeatLoader = createHeartbeatLoader({
    getConfig, aliveMs, aliveCommand, now,
    listEntityDirs, readEntityConfig,
    // Command beats inherit process.env + EGPT_HOME + the queue-stats vars (the
    // loader adds those). The spine pid is no longer an env var — identity lives in
    // state/spine.pid now, and liveness is the alive.txt mtime, so a custom beat
    // needs neither to arm the deadman.
    spawn: spawnFn, env: process.env, egptHome: EGPT_HOME, procCwd: process.cwd(),
    io: { writeFile, mkdir },
    onLog: (m) => log.line?.(`[heartbeat] ${m}`),
  });

  // Decorate the real registry into the heartbeats object the spine ticks. The
  // decoration puts the hot-reload TRIGGER on runDue itself: when the loop consults
  // the in-memory heartbeat set, it first checks whether state/heartbeats.readonly
  // .yaml is present — its ABSENCE means that set is stale (operator 2026-07-02:
  // "if the file is not present, the in-memory heartbeat is stale, so regenerate the
  // readonly file and load it into memory"). The check belongs to CONSULTING the
  // set, not to a beat listed inside it. Wired here (before createSpine) but inert
  // until activate() flips it live. Spine.mjs stays untouched — it just gets a
  // heartbeats object with the same shape.
  services.heartbeats = heartbeatLoader.wrapRegistry(services.heartbeats);

  // PHASE 1 — collect + parse BEFORE createSpine so the tick can be sized to the
  // finest cadence. The tick is the loop's pulse; every cadence rides it, so a
  // cadence finer than the tick can't be honored. Tighten tickMs down to finestMs
  // (floored at 500ms — the registry can't beat finer than the tick anyway).
  // tickMs<=0 (tests drive tick() by hand) stays 0 = no auto-timer.
  const { finestMs } = await heartbeatLoader.collect();
  const effectiveTickMs = tickMs > 0 ? Math.max(500, Math.min(tickMs, finestMs ?? tickMs)) : tickMs;

  const spine = createSpine({ bridge, brain, ...services, commands, mesh, actions, advice, defaultBeing: defaultKey, clock: { now }, log, tickMs: effectiveTickMs, setInterval: setIntervalFn, clearInterval: clearIntervalFn });
  // Bind the advice service's answer-routing dispatch now that the spine exists: an
  // operator answer in the advice channel re-enters the pipe as a turn in the origin chat.
  advice.useDispatch(spine.handleInbound);

  // PHASE 2 — bind each command action + register every heartbeat onto the
  // registry the spine ticks + write the readonly.yaml. The alive beat is a
  // spawned command now (echo beat > state/alive.txt), not an in-process closure.
  // Liveness is the alive.txt MTIME, so respawn is never coupled to turn duration
  // (a legit long brain turn must never get the node guillotined). Pump depth/age
  // still ride every command beat's env (spine.stats() → EGPT_QUEUE_*) for custom
  // beats that want them.
  await heartbeatLoader.activate({ stats: spine.stats, tickMs: effectiveTickMs });

  spine.start();
  spine.tick();   // fire the first beat immediately so alive.txt exists at once

  // Back-up announce: if we respawned from a lifecycle command, tell Self (with
  // the commit we came up on). Fire-and-forget — a cold boot has no sidecar.
  // Gated on the real-node flag so tests don't read/send through it.
  if (ingest) (async () => {
    let sc; try { sc = JSON.parse(await readFile(sidecar, 'utf8')); } catch { return; }
    try { await unlink(sidecar); } catch {}
    if (!sc?.chatId) return;
    const nowSha = shortSha();
    const head = (sc.preSha && sc.preSha !== nowSha) ? `${sc.preSha} → ${nowSha}` : nowSha;
    const pids = (sc.pid && sc.pid !== process.pid) ? `pid ${sc.pid} → ${process.pid}` : `pid ${process.pid}`;
    const subject = gitOut(['log', '-1', '--format=%s']);
    try { await bridge.send(sc.chatId, `✅ egpt back up! (${head}) ${pids}${subject ? `\n\n${subject}` : ''}`); }
    catch (e) { log.line?.(`[announce] ${e?.message ?? e}`); }
  })();

  // Command ingest: drop /restart, /upgrade, or /rewind <ref> into EGPT_HOME/state/ingest
  // (operator 2026-07-03: the ingest box lives under state/ now).
  let ingestWatcher = null;
  if (ingest) {
    ingestWatcher = createIngest({
      dir: join(EGPT_HOME, 'state', 'ingest'),
      io,
      onLog: (m) => log.line?.(`[ingest] ${m}`),
      handle: async (line) => {
        const code = lifecycleExit(line, { writeRewindTarget: (ref) => writeFile(join(EGPT_HOME, 'rewind-target.txt'), ref, 'utf8') });
        if (code != null) { log.line?.(`[ingest] ${line} -> exit ${code}`); await announceAndExit(code); }
        else log.line?.(`[ingest] ignored: ${JSON.stringify(line)}`);
      },
    });
    await ingestWatcher.start();
  }

  return {
    spine, bridge, pool, cfg, accountPeers,
    stop: () => {
      // No alive-timer teardown: the beat is a heartbeat now, riding the spine's
      // tick timer, which spine.stop() clears.
      ingestWatcher?.stop();
      compaction.stop();
      transcriptorWorker.stop();   // stops BOTH the resident whisper-server + the :23390 endpoint
      spine.stop();
    },
  };
}
