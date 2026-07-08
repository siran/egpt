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
import { readFile, writeFile, mkdir, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';

import { createSpine } from '../../spine.mjs';
import { EGPT_HOME } from '../egpt-home.mjs';
import { createBeeperBridgePort } from '../bridges/beeper-port.mjs';
import { createWarmPool } from '../warm-sessions.mjs';
import { createWarmCliSession } from '../warm-cli-session.mjs';
import { readConfigSync } from '../tools/config-io.mjs';
import {
  CONV_YAML_PATH, parse as parseConvState, serialize as serializeConvState, emptyState, KNOWN_SURFACES, slugDir,
} from '../../conversations-state.mjs';

import { createIdentity, surfaceOf } from './identity.mjs';
import { shortChatId } from '../bridges/chat-id.mjs';
import { createContacts } from './contacts.mjs';
import { createGating } from './gating.mjs';
import { createRouter } from './router.mjs';
import { createTranscript } from './transcript.mjs';
import { createSender } from './sender.mjs';
import { createBrainPool } from './brainpool.mjs';
import { createIngest, lifecycleExit } from './ingest.mjs';
import { createCommands } from './commands.mjs';
import { createReplyActions } from './reply-actions.mjs';
import { createAdvice } from './advice.mjs';
import { createMedia } from './media.mjs';
import { createTranscription } from './transcription.mjs';
import { createBrains } from './brains.mjs';
import { createMeshService } from './mesh.mjs';
import { createCompaction } from './compaction.mjs';
import { createHeartbeats } from './heartbeats.mjs';
import { createHeartbeatLoader, parseHeartbeatsBlock } from './heartbeat-loader.mjs';
import { seedSkeletons } from './seed.mjs';

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
  // persona identity + local beings + mesh addressing all live here. It is REQUIRED — a
  // node without an agents block, or without a persona entry (an agent whose name/handles
  // include e/egpt), is a fatal misconfiguration, not a silent fallback to a guessed
  // default. Fail loudly so the operator fixes it (the skeleton ships the block uncommented).
  const agents = () => cfg.agents ?? {};
  const agentIds = (name, a) => [name, ...(Array.isArray(a?.handles) ? a.handles : [])].map((h) => String(h).toLowerCase());
  const personaAgent = () => {
    for (const [name, a] of Object.entries(agents())) {
      if (!a || typeof a !== 'object' || Array.isArray(a)) continue;
      if (agentIds(name, a).some((h) => h === 'e' || h === 'egpt')) return { name, agent: a };
    }
    return null;
  };
  if (!cfg.agents || typeof cfg.agents !== 'object' || Array.isArray(cfg.agents) || !personaAgent()) {
    throw new Error('boot: config.agents must declare a persona agent (an entry whose name or handles include "e"/"egpt"). No agents block / no persona entry is a fatal misconfiguration — see config/skeletons/config.yaml.');
  }

  // The being's body_emoji + display label (the bridge enforces the emoji on outbound; the
  // label rides the persona's first line "🐶 <label>"), resolved purely from the agents
  // registry: the PERSONA agent supplies E's emoji/label, a LOCAL agent keyed by being name
  // supplies its own.
  const bodyEmojiOf = (being) => {
    const b = String(being ?? '').toLowerCase();
    if (b === 'e' || b === 'egpt') return personaAgent()?.agent?.body_emoji ?? '🐶';
    const a = agents()[b];
    return (a && typeof a === 'object' && a.body_emoji) ? a.body_emoji : '🐶';
  };
  const labelOf = (being) => {
    const b = String(being ?? '').toLowerCase();
    if (b === 'e' || b === 'egpt') {
      const pa = personaAgent();
      return pa ? (pa.agent.name ?? pa.name) : 'egpt';
    }
    const a = agents()[b];
    return (a && typeof a === 'object') ? (a.name ?? b) : b;
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

  // The persona wake-word set (operator 2026-07-07: the bridge gate must honor configured
  // handles) — the network-wide default e/egpt PLUS the persona agent's name + every handle,
  // ONE source of truth (the agents block). agentIds already lowercases name+handles. On a
  // DOLLY-shaped config (agents.egpt.handles: [ed, egptd]) this is [e, egpt, ed, egptd], so
  // the live @ed that logged atE=false now wakes the node.
  const wakeWords = (() => { const pa = personaAgent(); return [...new Set(['e', 'egpt', ...agentIds(pa.name, pa.agent)])]; })();
  // Peer node reply stamps (operator 2026-07-08, trusted network): the OTHER node(s)'
  // body_emoji, read like any other config block. Absent → [] (no peers → no guard, today's
  // behavior). A message starting with one is peer output: transcript-only, never dispatched.
  const peerStamps = Array.isArray(cfg.network?.peer_stamps) ? cfg.network.peer_stamps : [];
  // 👂 ack role-gate (operator 2026-07-08): only false silences this node's 👂 acks (live +
  // backlog); absent/true = today's behavior. Lets one node in a mesh own the transcription ack.
  const transcribeAck = cfg.network?.transcribe_ack !== false;
  // TRANSCRIPTION PRIMARY/STANDBY (operator 2026-07-08: one 👂 per note). SEPARATE from
  // network.role — a node can be responder-standby yet transcription-primary (DOLLY). standby
  // holds its 👂 an extra transcribe_takeover_ms, then skips if the primary already acked.
  const transcribeRole = cfg.network?.transcribe_role === 'standby' ? 'standby' : 'primary';
  const transcribeTakeoverMs = Number.isFinite(cfg.network?.transcribe_takeover_ms) ? cfg.network.transcribe_takeover_ms : 60_000;

  // --- ports ---
  const bridge = await createBeeperBridgePort({
    beeperToken: cfg.beeper_token ?? process.env.BEEPER_ACCESS_TOKEN,
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
    isAllowedUser: (id, network) => ((cfg[surfaceOf(network)]?.allowed_users) ?? []).map(shortChatId).includes(shortChatId(id)),
    media: cfg.whatsapp?.media ?? {},
    transcribe: tx.transcribe,                                  // the fallback-chain transcriber
    transcribeCfg: tx.cliCfg,
    resolveTranscriptionService: tx.resolveTranscriptionService,// { enabled, postsBack } per chat
    postsBackDelayMs: tx.postsBackDelayMs,                      // how fast the 👂 transcript echoes back
    flood: cfg.flood ?? {},               // send-flood guard (limit / window_ms / cooldown_ms) per chat
    personaEmoji: bodyEmojiOf('e'),       // 🐶 — the marker the bridge uses to suppress E's own re-ingested messages
    wakeWords,                            // e/egpt + the persona agent's name + handles (honors @ed, operator 2026-07-07)
    peerStamps,                           // peer node reply stamps → sibling-output guard (operator 2026-07-08)
    transcribeAck,                        // 👂 ack role-gate: false = transcribe+log but never post the 👂 (operator 2026-07-08)
    transcribeRole,                       // transcription primary|standby: standby holds+skips a duplicate 👂 (operator 2026-07-08)
    transcribeTakeoverMs,                 // standby's extra 👂 hold beyond the debounce (operator 2026-07-08)
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
    const selfDm = cfg.whatsapp?.chat_id;
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
    gating: createGating({ getConfig, loadState: _loadState }),
    // Router resolves an @token against the unified `agents:` block (operator 2026-07-02),
    // then cross-node @being.node mesh targets (Phase 4b, inert unless cfg.mesh is configured).
    router: createRouter({ getAgents: () => cfg.agents ?? {}, getNode: () => cfg.node_name ?? null, getAliases: () => cfg.node_alias ?? [], meshEnabled: () => !!cfg.mesh }),
    transcript: createTranscript({ contacts, persona: labelOf('e'), io, onLog: (m) => log.line?.(`[transcript] ${m}`) }),
    sender: createSender({ bridge, bodyEmojiOf, labelOf }),
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
  const brain = createBrainPool({ pool, getConfig, contacts, loadState: _loadState, writeState: _writeState, brains, afterTurn: compaction.afterTurn, io, onLog: (m) => log.line?.(`[brain] ${m}`) });

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
  const actions = createReplyActions({ bridge, bodyEmojiOf, labelOf, resolveConvDir, askAdvice: (a) => advice.ask(a), onLog: (m) => log.line?.(`[actions] ${m}`) });

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

  const spine = createSpine({ bridge, brain, ...services, commands, mesh, actions, advice, network: cfg.network ?? {}, clock: { now }, log, tickMs: effectiveTickMs, setInterval: setIntervalFn, clearInterval: clearIntervalFn });
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
    spine, bridge, pool, cfg,
    stop: () => {
      // No alive-timer teardown: the beat is a heartbeat now, riding the spine's
      // tick timer, which spine.stop() clears.
      ingestWatcher?.stop();
      compaction.stop();
      spine.stop();
    },
  };
}
