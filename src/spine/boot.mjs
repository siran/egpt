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
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

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
import { createIngest, lifecycleExit } from './ingest.mjs';
import { createCommands } from './commands.mjs';
import { createMedia } from './media.mjs';
import { createTranscription } from './transcription.mjs';

export async function boot({
  readConfig = readConfigSync,
  startBridge = null,                 // createBeeperBridgePort's `start` seam (null = real beeper)
  makeSession = createWarmCliSession, // the warm-session factory (null-safe for tests)
  loadState = null, writeState = null,// conv-state IO (null = real CONV_YAML_PATH)
  io = {},                            // fs seam for transcript + brainpool ({appendFile,mkdir,existsSync}); real fs by default. Tests inject in-memory so they never touch the profile.
  log = { line: (s) => { try { console.error(s); } catch {} } },
  now = () => Date.now(),
  tickMs = 5 * 60_000,
  aliveMs = 0,                        // >0: beat EGPT_HOME/state/alive.txt so the daemon's wedge check sees liveness
  ingest = true,                      // watch EGPT_HOME/ingest for /restart, /upgrade, /rewind (tests pass false)
  exit = (code) => process.exit(code),// how a lifecycle command leaves (the daemon respawns on 42/43/44)
} = {}) {
  const cfg = readConfig() ?? {};
  const getConfig = () => cfg;

  // The being's body_emoji (the bridge enforces it on outbound). E/persona →
  // emojis.persona (default 🐶); siblings → their body_emoji.
  const personaName = String(cfg.persona ?? 'e').toLowerCase();
  const bodyEmojiOf = (being) => {
    const b = String(being ?? '').toLowerCase();
    if (b === 'e' || b === 'egpt' || b === personaName) return cfg.emojis?.persona ?? cfg.siblings?.e?.body_emoji ?? '🐶';
    return cfg.siblings?.[b]?.body_emoji ?? cfg.emojis?.persona ?? '🐶';
  };

  // conv-state YAML IO — default to the real file, missing = empty state.
  const _loadState = loadState ?? (async () => {
    try { return parseConvState(await readFile(CONV_YAML_PATH, 'utf8')); }
    catch { return emptyState(); }
  });
  const _writeState = writeState ?? (async (s) => { await writeFile(CONV_YAML_PATH, serializeConvState(s), 'utf8'); });

  // Voice/video transcription: the fallback CHAIN (remote node → local whisper-
  // server → cli), driven by config.transcription_service. One transcriber feeds
  // the bridge (voice notes) and the media service (a video's audio).
  const tx = createTranscription({ getConfig, onLog: (m) => log.line?.(`[transcribe] ${m}`) });

  // --- ports ---
  const bridge = await createBeeperBridgePort({
    beeperToken: cfg.beeper_token ?? cfg.whatsapp?.beeper_token ?? process.env.BEEPER_ACCESS_TOKEN,
    userName: cfg.whatsapp?.user_name ?? cfg.user_name ?? null,
    isAllowedUser: (id) => (cfg.whatsapp?.allowed_users ?? []).includes(id),
    media: cfg.whatsapp?.media ?? {},
    transcribe: tx.transcribe,                                  // the fallback-chain transcriber
    transcribeCfg: tx.cliCfg,
    resolveTranscriptionService: tx.resolveTranscriptionService,// { enabled, postsBack } per chat
    postsBackDelayMs: tx.postsBackDelayMs,                      // how fast the 👂 transcript echoes back
    stateDir: join(EGPT_HOME, 'state'),   // beeper-seen.jsonl etc. → this profile's state
    onLog: (m) => log.line?.(`[bridge] ${m}`),
  }, startBridge ? { start: startBridge } : {});

  // Persist incoming attachments into the chat's media/ folder + surface them to E.
  // For a video: keyframes (ffmpeg) + audio transcript (via the same chain) — Route A.
  const media = createMedia({ loadState: _loadState, writeState: _writeState, io, transcribe: tx.transcribe, transcribeCfg: tx.cliCfg, onLog: (m) => log.line?.(`[media] ${m}`) });
  bridge.onMedia((m) => media.save(m));

  // --- lifecycle announce: "restarting…" to Self before exit, "back up! <commit>"
  //     on the next boot. The bounce is otherwise invisible to the operator. ---
  const sidecar = join(EGPT_HOME, 'state', 'restart-announce.json');
  const KIND_OF = { 43: '/restart', 42: '/upgrade', 44: '/rewind' };
  const gitOut = (args) => { try { return spawnSync('git', args, { cwd: process.cwd() }).stdout?.toString().trim() || ''; } catch { return ''; } };
  const shortSha = () => gitOut(['rev-parse', '--short', 'HEAD']) || '?';
  async function announceAndExit(code) {
    const selfDm = cfg.whatsapp?.chat_id;
    try { await mkdir(join(EGPT_HOME, 'state'), { recursive: true }); await writeFile(sidecar, JSON.stringify({ chatId: selfDm, kind: KIND_OF[code] ?? '?', preSha: shortSha() })); } catch {}
    // best-effort going-down (capped so a slow POST can't wedge the exit)
    try { if (selfDm) await Promise.race([bridge.send(selfDm, `↻ ${KIND_OF[code] ?? 'restart'}…`), new Promise((r) => setTimeout(r, 3000))]); } catch {}
    exit(code);
  }

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
    transcript: createTranscript({ loadState: _loadState, writeState: _writeState, persona: cfg.persona ?? null, io, onLog: (m) => log.line?.(`[transcript] ${m}`) }),
    sender: createSender({ bridge, bodyEmojiOf }),
    heartbeats: { runDue() {} },   // v1 stub — §11 decision 4 hook (auto-compact lands here)
  };
  const brain = createBrainPool({ pool, getConfig, loadState: _loadState, writeState: _writeState, io, onLog: (m) => log.line?.(`[brain] ${m}`) });

  // operator slash commands (Self DM / authorized) — lifecycle wired now; reuses
  // the same exit codes the daemon respawns on.
  const commands = createCommands({
    getConfig,
    send: (chatId, text) => bridge.send(chatId, text),
    exit: announceAndExit,
    writeRewindTarget: (ref) => writeFile(join(EGPT_HOME, 'rewind-target.txt'), ref, 'utf8'),
    onLog: (m) => log.line?.(`[command] ${m}`),
  });

  const spine = createSpine({ bridge, brain, ...services, commands, clock: { now }, log, tickMs });
  spine.start();

  // Back-up announce: if we respawned from a lifecycle command, tell Self (with
  // the commit we came up on). Fire-and-forget — a cold boot has no sidecar.
  // Gated on the real-node flag so tests don't read/send through it.
  if (ingest) (async () => {
    let sc; try { sc = JSON.parse(await readFile(sidecar, 'utf8')); } catch { return; }
    try { await unlink(sidecar); } catch {}
    if (!sc?.chatId) return;
    const nowSha = shortSha();
    const head = (sc.preSha && sc.preSha !== nowSha) ? `${sc.preSha} → ${nowSha}` : nowSha;
    const subject = gitOut(['log', '-1', '--format=%s']);
    try { await bridge.send(sc.chatId, `✅ egpt back up! (${head})${subject ? `\n\n${subject}` : ''}`); }
    catch (e) { log.line?.(`[announce] ${e?.message ?? e}`); }
  })();

  // Liveness beat: "<tic|toc> <iso> <pid>" to EGPT_HOME/state/alive.txt, the
  // contract daemon-singleton/daemon-runtime read. The alternating tic/toc lets
  // a reader confirm the file is actually being rewritten, not just timestamped.
  let aliveTimer = null, beat = 0;
  const alivePath = join(EGPT_HOME, 'state', 'alive.txt');
  async function writeAlive() {
    try {
      await mkdir(join(EGPT_HOME, 'state'), { recursive: true });
      await writeFile(alivePath, `${beat++ % 2 ? 'toc' : 'tic'} ${new Date(now()).toISOString()} ${process.pid}\n`);
    } catch (e) { log.line?.(`[alive] ${e?.message ?? e}`); }
  }
  if (aliveMs > 0) { await writeAlive(); aliveTimer = setInterval(writeAlive, aliveMs); aliveTimer.unref?.(); }

  // Command ingest: drop /restart, /upgrade, or /rewind <ref> into EGPT_HOME/ingest.
  let ingestWatcher = null;
  if (ingest) {
    ingestWatcher = createIngest({
      dir: join(EGPT_HOME, 'ingest'),
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
      if (aliveTimer) { clearInterval(aliveTimer); aliveTimer = null; }
      ingestWatcher?.stop();
      spine.stop();
    },
  };
}
