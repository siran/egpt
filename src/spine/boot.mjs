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
import { createShellPort } from '../bridges/shell-port.mjs';
import { createWarmPool } from '../warm-sessions.mjs';
import { createWarmCliSession } from '../warm-cli-session.mjs';
import { readConfigSync } from '../tools/config-io.mjs';
import { reapPort } from '../tools/reap-port.mjs';
import * as cdp from '../tools/cdp.mjs';
import { Room } from '../room-core.mjs';
import { loadAdapterModule } from '../adapters/registry.mjs';
import {
  CONV_YAML_PATH, parse as parseConvState, serialize as serializeConvState, emptyState, slugDir, getContact, LOBBY_SLUG,
} from '../conversations-state.mjs';
import { createStopGuard, STOP_FILE, stopFilePresent, writeStopFile } from '../stop-guard.mjs';
import { createLasso } from '../lasso.mjs';
import { CLEAN_EXIT_CODE } from '../daemon-runtime.mjs';

import { createIdentity, surfaceOf } from './identity.mjs';
import { echoRank } from './echo-priority.mjs';
import { shortChatId } from '../bridges/chat-id.mjs';
import { createContacts } from './contacts.mjs';
import { createGating } from './gating.mjs';
// createRouter + THE wake vocabulary. wakeTokens is the ONE rule for "which @tokens address this
// agent" (declared `handles:`, else the map key) — imported, not re-implemented, so the persona
// wake set boot hands the ports and the router's own @token scan can never disagree again.
import { createRouter, wakeTokens, voiceWakeTokens } from './router.mjs';
import { createTranscript } from './transcript.mjs';
import { createSender } from './sender.mjs';
import { createBrainPool } from './brainpool.mjs';
import { createRoomRelay } from './room-relay.mjs';
import { createIngest, lifecycleExit, isShellConnectMarker } from './ingest.mjs';
import { createCommands } from './commands.mjs';
import { ownNodeNames } from './node-names.mjs';
import { createReplyActions } from './reply-actions.mjs';
import { createAdvice } from './advice.mjs';
import { createMedia } from './media.mjs';
import { createTranscription } from './transcription.mjs';
import { createVoiceSynthesis } from './synthesis.mjs';
import { uploadNote, radioNoteFilename, pickSpeaker } from '../radio-relay.mjs';
import { extFromMeta } from '../media-save.mjs';
import { createTranscriptorWorker } from './transcriptor-worker.mjs';
import { startWhisperServer } from '../tools/whisper-server.mjs';
import { startTranscriptorServer } from '../tools/transcriptor.mjs';
import { createSynthesizerWorker } from './synthesizer-worker.mjs';
import { startSynthesizerServer } from '../tools/synthesizer.mjs';
import { createBrains } from './brains.mjs';
import { createMeshService } from './mesh.mjs';
import { createCompaction } from './compaction.mjs';
import { createHeartbeats } from './heartbeats.mjs';
import { createHeartbeatLoader, parseFrequency, resolveTimeZone } from './heartbeat-loader.mjs';
import { createConfigResolver, parseEntityConfig } from './config-resolver.mjs';
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

// Make a STREAMING sender shell-aware. createSender renders through its injected `bridge`
// (`bridge.send` / `bridge.startStream`); handed the raw beeper bridge, a streamed @e /
// brain-member reply on a shell-owned chat streamed to Beeper and never reached the editor
// (the command `send` closure was the only shell-aware path — why /status showed in the shell
// but a streamed reply did not). This facade delegates the methods createSender + the mesh
// service call to shellPort for shell-owned chat ids and to the real bridge otherwise; every other bridge
// method passes through unchanged (spread first). Pure so the routing is testable directly
// (mirrors the other top-level boot helpers). The beeper path for non-shell chats is untouched.
// Redirect a shell-surface inbound event to its CURRENT joined room, if any — "entering a
// room is like typing in another chat" (operator): once `/room join acim` sets the shell's
// current room, a plain or `@e`-addressed message typed at the shell must dispatch as
// surface 'room' chatId 'acim', not surface 'shell' chatId 'main', so it reaches the SAME
// (surface, chatId)-keyed resolution/confinement a room-native message already gets (the
// room refactor's own principle — room-core.mjs). currentRoomOf is commands.mjs's ONE reader
// onto its ONE currentRoom map (written only by roomJoin/roomLeave) — no second map here.
// 'lobby' (or no room joined) means the shell's own native identity: there is no room/lobby
// folder, so the event is left untouched, same as before this redirect existed.
// A reply goes out to ev.chatId (spine.mjs's sender.open), which is now the room slug — so
// the redirect also `claim`s it on shellPort (the SAME ownership signal `owns()` already
// keys outbound routing on for 'main'), or the reply would be handed to the beeper bridge
// instead of pushed back over this socket. Pure aside from that one registration call, so
// the redirect decision itself is testable directly (mirrors makeShellAwareBridge below).
export function redirectShellToRoom(msg, { currentRoomOf, claim } = {}) {
  const room = currentRoomOf?.('shell');
  if (!room || room === 'lobby') return msg;
  claim?.(room);
  return { ...msg, from: { ...(msg?.from ?? {}), network: 'room', chatId: room } };
}

export function makeShellAwareBridge(bridge, shellPort) {
  return {
    ...bridge,
    send: (c, t, o) => (shellPort.owns(c) ? shellPort.send(c, t, o) : bridge.send(c, t, o)),
    startStream: (c, i, tag) => (shellPort.owns(c) ? shellPort.startStream(c, i, tag) : bridge.startStream(c, i, tag)),
    // The mesh posts its origin placeholder ("🤔 thinking…") via postStatus, so a shell-origin
    // relay (`@don` typed in the shell) must land that placeholder on the editor — not stream it
    // to Beeper and drop it — the same reason send/startStream are wrapped, extended to the mesh
    // return path (operator 2026-07-25). shellPort.postStatus returns null (no editable shell msg
    // id), so the mesh's later edit/delete of the placeholder is a guarded no-op.
    postStatus: (c, t) => (shellPort.owns(c) ? shellPort.postStatus(c, t) : bridge.postStatus(c, t)),
  };
}

// COMMAND REPLIES BELONG IN THE TRANSCRIPT TOO (operator 2026-08-05, live: "transcript.md is not
// being updated with the command and error back messages from it" — an operator's two typos got
// usage/error replies and neither left a trace). Every command handler in src/spine/commands.mjs
// replies with `send?.(ev.chatId, text)`, and commands.mjs's OWN internal chokepoint funnels
// every one of those (the no-self-parsing guard) through the single `send` function THIS module
// injects at construction — so wrapping that one function, here, records every command reply by
// construction. No per-handler change, and no future command added to commands.mjs can forget.
// This mirrors what spine.mjs already does for a being's turn (transcript.log(ev, {...reply})) —
// commands just have no `reply` value to hand back, only the side-effecting send() calls.
//
// THE MISSING PIECE IS `ev`: a handler only ever has `send?.(ev.chatId, text)` — the chatId, not
// the InboundEvent transcript.log needs (ev.surface, ev.chatName for the slug resolve). `run`
// below wraps createCommands's own `run(ev)` to remember ev BY CHAT ID for exactly the span of
// that call — one in-flight command per chat, the same assumption commands.mjs's own capture-sink
// Map already relies on (its comment: "concurrent runs never cross") — so `send` can read it back.
//
// A MESH-CAPTURED command (mesh.mjs's runCaptured) never reaches this `send` at all: commands.mjs
// diverts it into a private sink instead (the whole point — that reply rides home INSIDE an
// envelope). So a relayed command is correctly excluded: it was never posted into a room, and the
// operator ruling ("everything that is typed or received in a ROOM") only covers what was.
//
// LABEL: 'system' — a command reply is the NODE speaking, not a persona (src/shell/app.mjs
// already uses author 'system' for this identical class of message: spine-generated, not a
// being's turn). Node-qualified like any other reply — createTranscript renders <being>.<node_name>
// — so the record shows e.g. `[@system.kg (18:07)]:`.
//
// Pure/DI'd so it's testable directly (mirrors the other top-level boot helpers): `send` and
// `transcript.log` are both injected, nothing here touches fs or config.
export function wrapCommandsForTranscript({ send, transcript, being = 'system', onLog = () => {} }) {
  const pendingEv = new Map();   // chatId -> the ev commands.run(ev) is currently processing
  const wrappedSend = async (chatId, text) => {
    const result = await send(chatId, text);
    const ev = pendingEv.get(chatId);
    if (ev) await transcript.log(ev, { text, being }).catch((e) => onLog(`command reply ${chatId}: ${e?.message ?? e}`));
    return result;
  };
  const wrapRun = (run) => async (ev) => {
    pendingEv.set(ev.chatId, ev);
    try { await run(ev); } finally { pendingEv.delete(ev.chatId); }
  };
  return { send: wrappedSend, wrapRun };
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

// Where does this agent ROUTE? No `to:` anywhere → LOCAL, keyed by this node's own nodeName.
// A top-level `to: <being>.<node>` → the part after the last dot. carol-shaped agents carry
// their route inside a `paths:` LIST instead (each entry a single-key wrapper object
// `{ path1: { relay_channel, network, to } }`) — read the FIRST entry's `to:` the same way.
// No special-casing an agent whose paths point to two different nodes (documented
// simplification): only the first path entry is ever consulted.
function shellHeaderGroupOf(agent, nodeName) {
  if (typeof agent.to === 'string' && agent.to) return agent.to.split('.').pop();
  if (Array.isArray(agent.paths) && agent.paths.length) {
    const wrapper = agent.paths[0];
    const entry = (wrapper && typeof wrapper === 'object') ? Object.values(wrapper)[0] : null;
    if (entry && typeof entry === 'object' && typeof entry.to === 'string' && entry.to) return entry.to.split('.').pop();
  }
  return nodeName;
}

// THE PERMANENT SHELL HEADER (operator 2026-07-27): the operator's terminal editor needs a
// fixed status line — persona + LOBBY_SLUG + a roster of this node's OWN `agents:`, grouped by
// where each one routes — and a FUTURE browser-extension surface will need the identical
// string but cannot read config.yaml at all. So the derivation lives HERE, spine-side, pure
// (mirrors buildNodeIdentity), and boot hands the computed STRING to the shell limb over the
// frame the two already share (src/bridges/shell-port.mjs `header`) — the editor never reads
// config. Never a peer node's roster: only this node's own `agents:` map, grouped by route.
//   personaName = labelOf(defaultKey) — NOT re-derived here (no second scan for default:true).
//   nodeName    = cfg.node_name — the LOCAL group's key when an agent has no `to:`/`paths:`.
//   agents      = cfg.agents — absent/empty tolerated (no throw; just no trailing groups segment).
//   defaultNode = raw `dispatch.default_node` (string|undefined/null; normalized in here, trim+lowercase).
//                 Renders ` → <default_node>` right after LOBBY_SLUG, UNLESS it's unset/empty OR
//                 equals nodeName itself (bare commands run locally either way — no arrow implying
//                 a route that isn't happening).
// Groups render in agents-map insertion order (JS object order already preserves it); handles
// render within a group in agent-declaration order. SHORT HANDLE = the shortest string in the
// agent's `handles:` array, else its map key.
export function computeShellHeader({ nodeName, personaName, agents, defaultNode } = {}) {
  const normDefaultNode = String(defaultNode ?? '').trim().toLowerCase();
  const normNodeName = String(nodeName ?? '').trim().toLowerCase();
  const arrow = (normDefaultNode && normDefaultNode !== normNodeName) ? ` → ${normDefaultNode}` : '';
  const base = `🟢 ${personaName} ${LOBBY_SLUG}${arrow} — ? for help · ctrl-d = send`;
  const map = (agents && typeof agents === 'object' && !Array.isArray(agents)) ? agents : {};
  const groups = new Map();   // groupKey → [ '@handle', ... ], insertion order = first agent encountered
  for (const [key, a] of Object.entries(map)) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) continue;
    const handles = (Array.isArray(a.handles) && a.handles.length) ? a.handles : [key];
    const shortest = handles.reduce((s, h) => (String(h).length < String(s).length ? h : s), handles[0]);
    const groupKey = shellHeaderGroupOf(a, nodeName);
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(`@${shortest}`);
  }
  if (groups.size === 0) return base;
  const seg = [...groups.entries()].map(([g, hs]) => `${g}: ${hs.join(' ')}`).join(' · ');
  return `${base} — ${seg}`;
}

// RADIO RELAY — the hook that makes radio_service + /radio join|leave (617148a, 48a6ee8) do
// something: air a WhatsApp voice note on the internet radio station a room is joined to.
// src/radio-relay.mjs is the uploader (uploadNote/radioNoteFilename/pickSpeaker); this is the
// orchestration around it.
//
// REUSES THE EXISTING AUDIO PATH, no second download: the transcription service already
// receives every voice note's downloaded bytes via bridge.onMedia (wired below, `noteMedia`).
// That callback has the bytes but NOT the raw WhatsApp sender id (only a display name) and NOT
// the human/node-provenance signals isHumanTurn decides on; the spine's ev (built moments later
// from the SAME message) has both of THOSE but never the bytes. The two are correlated by
// `${chatId}:${msgId}` — the SAME per-note key beeper.mjs's own 👂 debounce already uses — in a
// small bounded (FIFO-evicting) in-memory cache. `noteMedia` fires for every persisted
// attachment; `relay(ev)` fires once per genuine inbound voice note (spine.mjs gates
// ev.isVoice + humanTurn(ev) BEFORE calling — this function does not re-derive that notion, it
// is handed only what already passed it).
//
// NO DEDUPE-BY-MESSAGE-ID (operator ruling 2026-08-08, reversing an earlier draft of this
// module that kept one): "it must not relay backlogs, by design." Only the joined node relays,
// and it relays a genuine human turn once — a replay/edit/backfill of an OLD note arrives with
// ev.backlog true, which humanTurn(ev) already reads as non-human (stop-guard.mjs), so
// spine.mjs's gate never calls relay() for it. Refusing the backlog IS the guard against airing
// an old note twice; a second bookkeeping Set here would be a second, unnecessary path doing
// the same job.
//
// THE UPLOAD IS AN OUTBOUND MESSAGE (operator ruling 2026-08-08): "the event of a note going out
// MUST BE the same as any message ... it must increase the output counter as any message
// currently does." So it is routed through `gate` — boot always hands in the SAME node-wide
// lasso (src/lasso.mjs) every limb's send already goes through (the exact precedent: the shell
// port and the 👂 echo are both wrapped by "the SAME lasso ... never a second one"). Never a
// radio-specific throttle on top: one ceiling, node-wide. A busy room can trip it — the node
// stops, which is the guard working, not a bug.
export function createRadioNoteRelay({
  resolveConvRoom,             // (surface, chatId) -> Room|null — the ONE conversation-room resolver
  cfg,                          // live config object — radio_service map lives at cfg.radio_service
  uploadNote: uploadNoteFn = uploadNote,
  readFile: readFileFn = readFile,
  // THE OUTBOUND CEILING (src/lasso.mjs) — boot always passes lasso.gate, the SAME seam the 👂
  // echo (an in-limb emit that also isn't a port method) uses. Default is a bare passthrough so
  // a caller that isn't testing the lasso integration is unaffected — never a second ceiling.
  gate: gateFn = (fn) => fn(),
  cacheMax = 200,               // bounded — an unmatched cache entry (e.g. download policy excludes audio) self-evicts, never grows unbounded
  onLog = () => {},
} = {}) {
  const audioCache = new Map();   // `${chatId}:${msgId}` -> { localPath, mime, fileName }

  return {
    // bridge.onMedia's meta (beeper.mjs persistMedia) — stash only the audio attachment's
    // already-downloaded local path; every other kind is irrelevant here.
    noteMedia(meta) {
      if (!meta || meta.kind !== 'audio' || !meta.localPath || !meta.chatID || meta.msgId == null) return;
      const key = `${meta.chatID}:${meta.msgId}`;
      if (!audioCache.has(key) && audioCache.size >= cacheMax) audioCache.delete(audioCache.keys().next().value);
      audioCache.set(key, { localPath: meta.localPath, mime: meta.mime, fileName: meta.fileName });
    },

    // The hook itself. Every early return is a silent no-op — side effect only, never
    // throws; the caller (spine.mjs) also wraps this in .catch as the belt.
    async relay(ev) {
      const key = `${ev.chatId}:${ev.msgId}`;
      const audio = audioCache.get(key);
      if (!audio) { onLog(`no cached audio for ${key} — download policy may exclude audio, or this wasn't the voice attachment`); return; }
      audioCache.delete(key);   // one-shot: the ONE call this note will ever get (no replay — see the header)
      const room = await resolveConvRoom(ev.surface, ev.chatId);
      if (!room) return;
      const doc = await room.loadConfig();
      const radioName = doc.radio?.join;
      if (!radioName) return;                              // room not joined to a radio
      const radio = cfg.radio_service?.[radioName];
      if (!radio || radio.enabled !== true) return;         // not configured on THIS node, or disabled
      const blocked = Array.isArray(cfg.radio_blocked_senders) ? cfg.radio_blocked_senders : [];
      if (blocked.includes(ev.senderId)) { onLog(`radio relay blocked sender ${ev.senderId}`); return; }
      const speaker = pickSpeaker(doc.radio?.hosts, ev.senderId, radio.default_speaker);
      if (!speaker) { onLog(`no speaker for ${ev.senderId} on ${radioName} — no default_speaker configured either`); return; }
      const ext = extFromMeta({ fileName: audio.fileName, mime: audio.mime, kind: 'audio' });
      const filename = radioNoteFilename(ev.ts, ext);
      let bytes;
      try { bytes = await readFileFn(audio.localPath); }
      catch (e) { onLog(`could not read ${audio.localPath}: ${e?.message ?? e}`); return; }
      // gate() returns null when the ceiling has ALREADY tripped (or trips on this very call) —
      // that is not a failure to report here: the node is on its way down and explains itself
      // via the STOP file, exactly as it would for a refused send.
      const result = await gateFn(() => uploadNoteFn({ radio, speaker, filename, bytes, onLog }));
      if (result == null) return;
      onLog(result.ok ? `aired [${radioName}/${speaker}] ${filename}` : `upload FAILED [${radioName}/${speaker}] ${filename}`);
    },
  };
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
  // synthesizer WORKER-role process-boundary seam — the :23391 endpoint (piper/ffmpeg spawn
  // per-request inside it) binds through here. Defaults to the real spawner; tests inject a
  // fake so a boot with synthesizer.enabled NEVER binds a real port (see below).
  startSynthesizerServer: startSynthesizerServerFn = startSynthesizerServer,

  ingest = true,                      // watch EGPT_HOME/state/ingest for /restart, /upgrade, /rewind (tests pass false)
  exit = (code) => process.exit(code),// how a lifecycle command leaves (the daemon respawns on 42/43/44)
  setInterval: setIntervalFn = globalThis.setInterval,       // the spine tick-timer seam; injected so a test can observe the effective cadence
  clearInterval: clearIntervalFn = globalThis.clearInterval,
  setTimeout: setTimeoutFn = globalThis.setTimeout,          // the KILL SWITCH warning's cap seam (below); injected so a test can drive the 3s timer instead of waiting for it
} = {}) {
  // === THE KILL SWITCH (operator 2026-07-25) — THE FIRST THING boot DOES ===============
  // "if a file named STOP exists in .egpt it *also* stops". Checked before the config is
  // even read, so it wins over a broken config too, and long before the bridge dials
  // Beeper, before spine.pid is written, before a heartbeat can beat — nothing can emit.
  // Leaves through the SAME `exit` seam every lifecycle command uses, with CLEAN_EXIT_CODE:
  // src/daemon-runtime.mjs reads 0 as "clean exit — egpt-daemon stopping (user wanted out)"
  // and does NOT respawn (unlike 43/42/44), so the whole SERVICE stays down. That is also
  // why the daemon needs no STOP check of its own: it spawns the spine once, the spine
  // refuses, and the daemon stops — a respawn loop is impossible, and a second copy of the
  // switch would be a second thing to get wrong.
  if (stopFilePresent(STOP_FILE)) {
    log.line?.(`[boot] ${STOP_FILE} exists — egpt refuses to start. Delete the file to start again:  rm ${STOP_FILE}`);
    exit(CLEAN_EXIT_CODE);
    return null;
  }
  // The switch itself, handed to the spine: ONE object, two call sites (its tick, for an
  // operator `touch`ing the file from a terminal, and the chat safe word in classify).
  // Writing is best-effort — a write we cannot do must never PREVENT the stop — but it is
  // never silent: the failure is logged and the node stops regardless.
  //
  // ONCE-ONLY: the warning post below is awaited, and the spine's own tick can fire during
  // that window — without this latch a tick that sees the freshly-written file would pull a
  // second time (a duplicate warning and a second exit).
  let stopping = false;
  const stopSwitch = {
    present: () => stopFilePresent(STOP_FILE),
    pull: async (why = {}) => {
      if (stopping) return;
      stopping = true;
      // WARN IN THE CHAT IT CAME FROM (operator 2026-07-26: "STOP on any chat created the
      // file and emits warning in the chat that action was taken") — the operator must SEE
      // that it landed instead of wondering whether it registered. Routed through
      // shellAwareBridge so a STOP typed at the operator console is answered on the console,
      // not posted to Beeper. Declared far below but only READ here at call time (post-boot,
      // from the spine) — the same call-time-safe forward reference as readTranscript's
      // resolveConvDir.
      //
      // ⚠ CAPPED, exactly like announceAndExit's going-down line: the send races a 3s timer,
      // so a slow or wedged POST can never wedge the stop. If it fails or times out the node
      // still stops — the FILE is the durable record, this line is only courtesy.
      //
      // ⚠ bypassLasso: the outbound rate regulator (src/lasso.mjs) must NEVER hold the stop.
      // A kill switch that queues behind the very flood it exists to end is not a kill switch,
      // so this one send skips the gate outright (operator 2026-07-26).
      if (why.chatId) {
        try {
          await Promise.race([
            shellAwareBridge.send(why.chatId, `🛑 STOP received — egpt is stopping (the service will not respawn).\nTo start it again:  rm ${STOP_FILE}`, { bypassLasso: true }),
            new Promise((r) => setTimeoutFn(r, 3000)),
          ]);
        } catch (e) { log.line?.(`[stop] could not post the warning (${e?.message ?? e}) — stopping anyway`); }
      }
      try { writeStopFile({ ...why, at: new Date(now()).toISOString() }, STOP_FILE); }
      catch (e) { log.line?.(`[stop] could NOT write ${STOP_FILE} (${e?.message ?? e}) — stopping anyway, but this node will start again`); }
      log.line?.(`[stop] egpt stopping — ${STOP_FILE}. Delete the file to start again:  rm ${STOP_FILE}`);
      exit(CLEAN_EXIT_CODE);
    },
  };

  const cfg = readConfig() ?? {};
  const getConfig = () => cfg;

  // THE TRANSCRIPT CLOCK'S ZONE (operator 2026-07-26: "timestamps should be rendered as per
  // the configuration key"). ONE zone mechanism for the whole node: the same config key and
  // the same resolver the heartbeat loader already uses — no second lookup, no new dep. Only
  // resolved when the key is actually set, so a node without it keeps rendering UTC exactly
  // as before (resolveTimeZone's own fallback is the MACHINE's zone, which is not what an
  // absent key should mean for a record that was UTC yesterday).
  const transcriptTimeZone = cfg.default_time_zone
    ? resolveTimeZone(cfg.default_time_zone, { onLog: (m) => log.line?.(`[boot] ${m}`) })
    : null;

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

  // === THE STRUCTURAL NODE SIGNATURE (operator 2026-07-26) ==============================
  // "spine doesn't boot without the invisible ones. the visible one are prescindable, there are
  // only for human purviews." The invisible, machine-readable layer every outbound frame carries
  // is `node_name` TAG-ENCODED (src/node-signature.mjs) — so requiring the marker and requiring
  // the name are ONE requirement, not two. A separate `node_signature:` key could only ever hold
  // a redundant copy of node_name and a second chance to get it wrong; this is that ruling made
  // executable. Same shape as the persona-agent throw above: a node that cannot say WHICH node it
  // is has no business posting to an account two spines share.
  // The VISIBLE bridge_signature_open/close stay optional and are NOT checked here — empty is a
  // legitimate configuration and must never block boot.
  const node_name = String(cfg.node_name ?? '').trim();
  if (!node_name) {
    throw new Error(`boot: no node_name — every frame a spine commits to a surface carries an invisible structural signature encoded from it, and a node that cannot identify itself must not post (${CONFIG_FILE}). Set \`node_name: <short node id>\` (e.g. \`node_name: kg\`). See config/skeletons/config.yaml.`);
  }

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

  // Enumerate the entity folders (conversations/<surface>/<slug>/).
  // An operator-named room is one of THESE, on surface `room` — it lives at
  // EGPT_HOME/conversations/room/<slug>/ (2026-08-09), so the surfaces loop below
  // walks it with no branch of its own. Missing dirs are tolerated (a fresh
  // profile has none).
  //
  // THIS IS THE WALK — the only one. It feeds the config RESOLVER below, which layers
  // the three rungs and serves EVERY per-entity reader (heartbeats, warm, transcription);
  // adding a second enumeration anywhere is the bug this replaced.
  async function listEntityDirs() {
    const out = [];
    const convRoot = join(EGPT_HOME, 'conversations');
    // Surfaces are OPEN (operator ruling: any network Beeper bridges is its own
    // surface) — driven by real disk contents, not a fixed list, so a new surface's
    // folder is walked with zero code change.
    let surfaces = [];
    try { surfaces = await readdir(convRoot, { withFileTypes: true }); } catch { surfaces = []; }
    for (const surfaceEnt of surfaces) {
      if (!surfaceEnt.isDirectory()) continue;
      const surface = surfaceEnt.name;
      let ents = [];
      try { ents = await readdir(join(convRoot, surface), { withFileTypes: true }); } catch { continue; }
      for (const ent of ents) if (ent.isDirectory()) out.push({ dir: join(convRoot, surface, ent.name), ns: `${surface}/${ent.name}` });
    }
    return out;
  }
  // An entity's WHOLE config.yaml doc — the resolver picks the blocks apart, so this
  // reads the file ONCE for every concern that used to open it separately (heartbeats,
  // warm, transcription). Tolerant: absent / unreadable / malformed → {}.
  const readEntityConfig = async (dir) => {
    try { return parseEntityConfig(await readFile(join(dir, 'config.yaml'), 'utf8')); }
    catch { return {}; }
  };

  // THE config resolver — ONE namespace, THREE rungs, nearest the room wins
  // (config/config.yaml < config/conversations.yaml < <entity>/config.yaml). It owns the
  // walk above and holds the resolved set in memory; warm (brainpool), transcription and
  // the heartbeat loader all read IT instead of each opening <entity>/config.yaml. Wired
  // here, before the loader, because the loader's collect() drives its scan.
  const configResolver = createConfigResolver({
    getConfig, loadRegistry: _loadState, listEntityDirs, readEntityConfig,
    egptHome: EGPT_HOME, io: { writeFile, mkdir },
    onLog: (m) => log.line?.(`[config] ${m}`),
  });


  // The ONE shared contact-resolver: every service that needs a chat's slug goes
  // through here, so the pushedName refresh + rename self-heal (move the slug dir
  // old→new + write renames.log) run for KNOWN chats too, not just new ones.
  const contacts = createContacts({ loadState: _loadState, writeState: _writeState, io, onLog: (m) => log.line?.(`[contacts] ${m}`) });

  // The ONE conversation-room resolver (bug fix 2026-07-23): contacts.resolve (the shared,
  // self-healing slug lookup) → the conversation's Room. BOTH the phase-4 relay's resolveMembers
  // (READ the roster) and the /members command family (WRITE the roster, via createCommands) go
  // through this SAME function, so a member added by /members lands in the EXACT
  // conversations/<surface>/<slug>/config.yaml the relay reads → an @<brain> on that conversation
  // fires the relay. One resolver = write-here and read-there can never diverge (was two: /members
  // wrote a NamedRoom, the relay read the ConversationRoom, so @chatgpt silently no-op'd).
  // An operator-named room resolves through this SAME function — surface `room`, chatId =
  // the name — and needs nothing added for it: fixedSlugFor makes a room's slug a pure
  // function of its name, so ensureContact derives it without a title (2026-08-09).
  const resolveConvRoom = async (surface, chatId) => {
    const slug = await contacts.resolve(surface, chatId);
    return slug ? Room.forChat(surface, slug) : null;
  };

  // Voice/video transcription: the fallback CHAIN (remote node → local whisper-
  // server → cli), driven by config.transcription_service. One transcriber feeds
  // the bridge (voice notes) and the media service (a video's audio).
  const tx = createTranscription({ getConfig, resolveConfig: configResolver.configFor, onLog: (m) => log.line?.(`[transcribe] ${m}`) });
  const vx = createVoiceSynthesis({ getConfig, onLog: (m) => log.line?.(`[synthesize] ${m}`) });

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

  // WORKER ROLE: synthesizer (operator 2026-08-09) — the TTS counterpart to transcriptor
  // above. A node whose config declares `synthesizer.enabled: true` (e.g. DOLLY) serves the
  // signed POST /v1/synthesize endpoint for the main spine's voice replies: piper renders
  // the text, ffmpeg transcodes to Opus/ogg. INGEST-GATED and FIRE-AND-FORGET for the same
  // reasons as transcriptorWorker above.
  const synthesizerWorker = createSynthesizerWorker({
    getConfig,
    startSynthesizerServer: startSynthesizerServerFn,
    onLog: (m) => log.line?.(`[synthesizer] ${m}`),
  });
  if (ingest) synthesizerWorker.start();

  // The persona wake-word set (operator 2026-07-09: SYMMETRIC nodes — each wakes on its OWN
  // configured handles only, NOTHING is injected network-wide). ONE source of truth (the agents
  // block, through the ONE rule — router.mjs wakeTokens): the persona agent's declared `handles:`,
  // lowercased, or its map KEY when it declares none. So @e wakes only a node whose persona
  // configures `e`; a node with handles [ed, egptd] wakes on @ed, NOT @e. (Reverted the 2026-07-08
  // network-wide e/egpt injection — that overlap was self-inflicted and the whole suppression
  // apparatus it needed is gone.)
  //
  // THE KEY IS NOT A WAKE TOKEN (operator 2026-07-26: "don must not wake or respond with 'egpt'").
  // It stays the BEING-ID — defaultKey above, which keys warm sessions and the per-conversation
  // entry[<being>] thread blocks — but it stopped being an address. The live bug: DOLLY's persona
  // is KEYED `egpt` and DISPLAYS as "don" (handles [d, don]), so one `@egpt` in a group woke BOTH
  // spines and the human got two replies, one stamped `egpt` and one stamped `don`.
  const wakeWords = (() => { const pa = personaAgent(); return [...new Set(wakeTokens(pa.name, pa.agent))]; })();
  // THE SPOKEN counterpart (operator 2026-08-09): voice_handles, the persona agent's own list —
  // NO map-key fallback (voiceWakeTokens, router.mjs), so an unconfigured persona wakes on NO
  // spoken alias. Gates a voice note's whisper transcript, anywhere in the sentence, never `@`.
  const voiceWakeWords = (() => { const pa = personaAgent(); return [...new Set(voiceWakeTokens(pa.agent))]; })();
  // THE BARE-HANDLE SWITCH (operator 2026-07-27: "this addressing without the '@' must be an
  // option, easy to turn on/off globally") — dispatch.address_without_at, DEFAULT true, so a node
  // that configures nothing keeps the live behaviour. Read ONCE here and handed by the SAME route
  // the wake list travels, to all THREE call sites of the ONE matcher: the beeper limb and the
  // shell limb (which pass it to mentionStatus beside `wakeWords`, below) and the router (which
  // passes it to `addressed` beside the agents registry). One value, one rung — the persona gate
  // and the agent registry can never disagree about whether `d hola` is an address.
  const addressWithoutAt = cfg.dispatch?.address_without_at !== false;
  // 👂 ECHO AGE BOUND (operator 2026-07-09, Zohykar incident; renamed from transcribe_ack_max_age_ms):
  // never echo a note whose OWN timestamp is older than this — a Beeper resync's ancient backlog
  // notes are still transcribed + logged, just never echoed into the live chat. Default 1h.
  const echoMaxAgeMs = Number.isFinite(cfg.echo_max_age_ms) ? cfg.echo_max_age_ms : 3_600_000;
  // account_peers (operator 2026-07-09): node identities sharing THIS Beeper account (incl self).
  // Still carried for the persona node-identity line (buildNodeIdentity) + the boot return; the 👂
  // echo priority reads echo_priority (below), falling back to account_peers.
  const accountPeers = Array.isArray(cfg.account_peers) ? cfg.account_peers : [];

  // 👂 ECHO — REAL HRW ON A NODE-STABLE AUDIO HASH + ORDERED FAILOVER (operator 2026-07-24; revives
  // HRW over the static-priority stopgap; plans/2607101713-HRW-ECHO-PLAN.md). NOT dedup. Two co-account
  // spines (REVE `kg`, DOLLY `do`) both see each voice note; without a pick BOTH would post its 👂 →
  // double. HRW picks the poster PER NOTE by rendezvous-hashing the co-account peer set for the note's
  // key. The key is the sha256 of the DOWNLOADED AUDIO BYTES (computed in the bridge, passed to
  // echoPlan) — byte-identical on both nodes, so both compute the SAME ordering and AGREE on the
  // winner. This is why the revival is safe where the deleted HRW was not: the old one hashed the
  // note's Beeper message id, which is NODE-LOCAL, so the nodes diverged (~1/4 double-👂). rank 1 posts
  // now; a lower rank promotes only if the higher ranks are OFFLINE/silent (the bridge posts at rank 1,
  // ARMS a promotion at (rank-1)*echoTimeoutMs for rank>1, and stands down when it OBSERVES the note's
  // 👂 from a higher rank — echo-priority.mjs + incoming-media.mjs). HARD OPT-OUT preserved: echo:false
  // → { rank: 0 }, which the bridge treats as never post / never promote — the note is still
  // transcribed + logged.
  // (`node_name` is bound + asserted non-empty at the fatal check above — it is the structural
  // node signature now, so it can no longer be null here.)
  // WINNER-SELECTION config, relocated under transcription_service.echo (operator 2026-07-24):
  //   echo: { method: hrw, participants, peer_priority: [do, kg], timeout_ms: 20000 }
  // BACK-COMPAT read-fallbacks keep a not-yet-migrated live config booting through the deploy→migrate
  // window: the HRW candidate set (also the hash-collision tiebreak order) is echoCfg.peer_priority,
  // else the legacy top-level echo_priority, else account_peers, else [self] (a solo node is always
  // rank 1); all lowercased so config casing never splits the order.
  const echoCfg = cfg.transcription_service?.echo ?? {};
  const echoPeers = (
    Array.isArray(echoCfg.peer_priority) ? echoCfg.peer_priority
    : Array.isArray(cfg.echo_priority) ? cfg.echo_priority
    : Array.isArray(cfg.account_peers) ? cfg.account_peers
    : [node_name]
  ).map((p) => String(p).toLowerCase());
  // `method`/`participants` are descriptive for now (no behavior branches on them): assert the method,
  // if present, is the one we implement, else warn — never hard-fail, so a config naming a future
  // method still boots on HRW.
  if (echoCfg.method != null && String(echoCfg.method).toLowerCase() !== 'hrw') {
    log.line?.(`[echo] transcription_service.echo.method "${echoCfg.method}" not recognized — using hrw`);
  }
  // Per-rank promotion step (operator 2026-07-11). GENEROUS default (20s) ON PURPOSE: a waiter can't
  // tell "rank-1 DOWN" from "rank-1 SLOW", so too-short pre-empts a merely-slow winner → DOUBLE 👂
  // (the one real hazard); too-long = slow failover. Tunable via transcription_service.echo.timeout_ms
  // (back-compat: the legacy top-level echo_timeout_ms).
  const echoTimeoutMs = Number.isFinite(echoCfg.timeout_ms) ? echoCfg.timeout_ms
    : Number.isFinite(cfg.echo_timeout_ms) ? cfg.echo_timeout_ms : 20_000;
  // 👂 COVERAGE THRESHOLD (operator 2026-07-12): word-token overlap fraction above which a reply to a
  // note counts as already-covering it, so this node stands down instead of double-echoing (the bridge's
  // noteCovered query; replaced the observed-set + arrival-lag scaffold). Default 0.6.
  const coverageThreshold = Number.isFinite(cfg.echo_coverage_similarity) ? cfg.echo_coverage_similarity : 0.6;
  // BOOT ASSERTION (operator 2026-07-11, adapted 2026-07-24): a node that echoes MUST appear in its own
  // candidate set. echoRank returns the rank-0 never-post sentinel (note-independent) when node_name
  // isn't in the set, so this node would SILENTLY never echo (and if the peer is likewise misconfigured,
  // no node echoes — or both do). Fail loudly so the operator fixes the config — this makes the
  // silent-divergence class impossible. echo:false opts out entirely, so the check is skipped there.
  if (cfg.echo !== false && echoRank(node_name, echoPeers, '') === 0) {
    throw new Error(`boot: node_name "${node_name}" is not in the 👂 echo peer set [${echoPeers.join(', ')}] — a node that echoes must appear in transcription_service.echo.peer_priority (or the legacy echo_priority / account_peers), else it would never echo (${CONFIG_FILE}). Add "${node_name}" to the list, or set echo:false to opt out.`);
  }
  // Per-note HRW plan: rendezvous-hash the peer set for the note's key (the audio-hash the bridge feeds)
  // and read off this node's rank. echo:false is the hard opt-out (rank 0, never post/promote).
  const echoPlan = cfg.echo === false
    ? () => ({ rank: 0, winner: false })
    : (noteKey) => { const rank = echoRank(node_name, echoPeers, noteKey); return { rank, winner: rank === 1 }; };

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
  // === THE SELF CHAT — ONE definition, three readers ===================================
  // The operator's own command channel: networks.whatsapp.chat_ids[0] (the live config
  // annotates that entry "Self-DM = operator command channel"). It was already THE Self
  // notion in two places — announceAndExit's restart-announce target and the mesh's
  // fallback transport — spelled out inline in both. The KILL SWITCH now needs the same
  // answer (below), so it is named ONCE here rather than copied a third time: three
  // copies of "which chat is Self" is three chances to drift.
  const selfChatId = () => surfaceCfg('whatsapp').chat_ids[0] ?? null;
  // Is THIS message in Self? The ONLY place the "stop" safe word is honoured since
  // 2026-07-26 ("is must be a single word message in Self"). Two conditions:
  //   - the SURFACE is whatsapp — the surface Self is defined on. Ids are per-surface
  //     namespaces, and without this a SHELL frame (which sets its own chatId, and is
  //     hardcoded authorized:true) could name the Self room and pull the switch.
  //   - the CHAT ID matches, compared in SHORT space (shortChatId is a no-op on an id
  //     that is already short) so a full-form config entry matches the short id the
  //     bridge delivers — the same normalization isAllowedUser and commands.mjs use.
  // No Self chat configured → false: the chat safe word is simply unavailable, and
  // `touch EGPT_HOME/STOP` (or setup/stop-egpt.cmd) is the way out. Fail-closed is the
  // right direction for a word that takes the service down.
  const isSelfChat = (ev) => {
    const self = selfChatId();
    if (!self || ev?.surface !== 'whatsapp') return false;
    return shortChatId(ev?.chatId) === shortChatId(self);
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
  // THE LASSO (operator 2026-07-26): "a major loop that counts how many messages in a time
  // window has been sent out to any limb ... a big lasso that sandboxes egpt" / "under no
  // reason must the bridge exceed a normal sending rate". ONE ceiling for the whole node,
  // built HERE — before any port exists — because every limb is wrapped by it below, so the
  // budget is node-wide and no limb has its own. See src/lasso.mjs for the two counters
  // (messages vs edits) and what counts as each. Config-controlled so the operator can
  // loosen it without a deploy.
  //
  // OVER THE CEILING ⇒ THE NODE STOPS (operator 2026-07-26: "by throttle i did actually mean
  // stop. there is probably a bug if there is flooding"), through the SAME stopSwitch the
  // STOP safe word pulls — the STOP file explains itself with the lasso's reason, the daemon
  // does not respawn, and only a human restart clears it. Never a second halt mechanism.
  // The trip is fire-and-forget from the send path: pull() is already once-only (`stopping`)
  // and never throws, and a send must not wait on the stop it just caused.
  // 18/10000ms, not 20/5000ms (operator 2026-07-26): a mesh reply-mirror over-bills as a
  // message, and the fix is headroom, not a classification branch — see src/lasso.mjs for the
  // full reasoning (it is a LOWER sustained rate, not a loosening).
  const lassoCfg = (cfg.lasso && typeof cfg.lasso === 'object') ? cfg.lasso : {};
  const lasso = createLasso({
    messages: Number.isFinite(lassoCfg.messages) ? lassoCfg.messages : 18,
    windowMs: Number.isFinite(lassoCfg.window_ms) ? lassoCfg.window_ms : 10_000,
    edits: Number.isFinite(lassoCfg.edits) ? lassoCfg.edits : 4_000,
    onLog: (m) => log.line?.(`[lasso] ${m}`),
    writeState: (s) => { writeFile(join(EGPT_HOME, 'state', 'lasso.json'), `${JSON.stringify(s, null, 2)}\n`, 'utf8').catch(() => {}); },
    onTrip: (t) => { Promise.resolve(stopSwitch.pull({ reason: `lasso: ${t.reason}`, who: 'lasso', where: 'outbound' })).catch(() => {}); },
  });
  // THE EAR PROBE (operator 2026-07-07, redesigned 2026-07-26; ROADMAP §3) — the DEAF-BRIDGE
  // detector. It injects a message with TELEGRAM'S OWN API (out of band, sharing no machinery
  // with Beeper) and requires it to come back through the Beeper WS; it does not arrive → drop
  // the socket and let the existing reconnect dial a fresh session. FAIL CLOSED: no bot token
  // or no chat id → the probe is simply OFF, never a boot error and never a fallback to some
  // other transport. Cadence/timeout are parsed HERE with the SAME parseFrequency the heartbeats
  // use ("30m" / "45s" / a number of ms), so the limb takes plain ms like every other time
  // option it has. Full rationale + the noise/latency tradeoff: CONFIG_SCHEMA.ear_probe.
  const earRaw = cfg.ear_probe;
  const earCfg = (earRaw && typeof earRaw === 'object') ? earRaw : {};
  const earOff = earRaw === false || earCfg.every === false || earCfg.every === 0;
  const earTg = (earCfg.telegram && typeof earCfg.telegram === 'object') ? earCfg.telegram : {};

  // TRANSCRIPT READ SEAM (operator 2026-07-20, voice notes; extended 2026-07-26, mode:accum).
  // ONE reader for every consumer that needs a conversation's transcript.md back:
  //   - the beeper bridge: a bare @e reply to a voice note REUSES the note's already-made
  //     arrival transcription (unbounded lookback, ZERO re-transcription);
  //   - the spine: `mode: accum` prompts a turn with everything said since the being's own
  //     last reply (src/transcript-log.mjs contextSinceLastTurn).
  // Neither can resolve chatID → transcript.md itself, and BOTH must land on the same file, so
  // this goes through the SAME resolveConvDir the reply-actions / transcript writer use — never
  // a duplicated/guessed path, which could pull a DIFFERENT chat's file. resolveConvDir is
  // declared below but only read at message-dispatch time (long post-boot), and neither consumer
  // invokes this during setup — so the forward reference is call-time safe (no TDZ).
  // io.readFile ?? readFile keeps it on the same fs seam as the transcript writer (tests
  // intercept via memIo).
  const readTranscript = async (chatID, { chatName, network } = {}) => {
    const dir = await resolveConvDir({ surface: surfaceOf(network), chatId: chatID, chatName });
    if (!dir) return null;
    return await (io.readFile ?? readFile)(join(dir, 'transcript.md'), 'utf8').catch(() => null);
  };

  const bridge = lasso.wrap(await createBeeperBridgePort({
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
    personaEmoji: bodyEmojiOf(defaultKey),// 🐶 — the marker the bridge uses to suppress E's own re-ingested messages
    // Per-NODE infra WRAP layers (operator 2026-07-12): bridge_signature_open/close bracket persona
    // replies + 👂 echoes (which SPINE posted: REVE kg vs DOLLY do); transcription_open/close is the
    // 👂 echo's own inner frame. All default '' → nothing added (byte-identical to today). The port
    // uses bridge_* for persona replies + forwards bridge_* + transcription_* to the 👂 echo. Agent
    // layers are per-being (agentSignature*Of), resolved in the sender, not here. ⚠️ *_open lifts the
    // 👂 off the leading edge → breaks observe-cancel on a >1-peer node (warned above).
    bridgeSignatureOpen: cfg.bridge_signature_open ?? '',
    bridgeSignatureClose: cfg.bridge_signature_close ?? '',
    nodeName: node_name,                  // the STRUCTURAL layer — invisible, mandatory, asserted above
    transcriptionOpen: cfg.transcription_open ?? '',
    transcriptionClose: cfg.transcription_close ?? '',
    wakeWords,                            // the persona agent's OWN name + handles only — nothing injected (operator 2026-07-09)
    voiceWakeWords,                       // the persona agent's OWN voice_handles only — no map-key fallback, empty by default (operator 2026-08-09)
    synthesize: vx.synthesize,            // TTS for the bare-@wakeword-reply-to-TEXT mirror (operator 2026-08-10) — same fn createSpine gets below; null on a node with no voice_service (e.g. `do`), where the branch simply no-ops.
    voice: vx.voice,                      // the persona's own voice name, paired with synthesize above.
    addressWithoutAt,                     // dispatch.address_without_at (default true): may a BARE leading handle address, or is '@' required? Same value the shell limb + the router get.
    echoPlan,                             // 👂 echo PLAN: (audioHash) => { rank, winner } — PER-NOTE HRW over the co-account peer set, keyed on the note's node-stable audio hash (operator 2026-07-24; revives HRW). rank 1 posts now; rank>1 arms a promotion at (rank-1)*echoTimeoutMs that re-checks coverage at fire; rank 0 (echo:false opt-out) never posts/promotes.
    echoTimeoutMs,                        // 👂 per-rank promotion step (ms); GENEROUS default so a SLOW rank-1 isn't mistaken for a DOWN one (double-👂 hazard).
    coverageThreshold,                    // 👂 word-token overlap fraction for the on-demand noteCovered query (operator 2026-07-12) — replaced the observed-set + arrival-lag/reconnect scaffold
    echoMaxAgeMs,                         // 👂 only echoes a note within this age of its own timestamp (operator 2026-07-09)
    readTranscript,                       // the ONE transcript reader (hoisted above) — voice-note reuse here, mode:accum in the spine
    stateDir: join(EGPT_HOME, 'state'),   // beeper-seen.jsonl etc. → this profile's state
    // THE ONE EMIT BELOW THE PORT (the 👂 echo, src/bridges/beeper.mjs): the transcript ack is
    // posted by the LIMB itself, from inside the voice-note path, so wrapping the port here
    // would miss it — a regulator with a hole exactly where a burst of notes lands. Hand the
    // limb the SAME lasso so the echo spends from the SAME node-wide budget. Forwarded
    // verbatim through beeper-port's `rest`.
    echoGate: lasso.gate,
    // THE EAR PROBE (above). Both telegram fields are required; either missing → the limb
    // builds no injector and the probe never runs.
    earProbeTelegram: (earTg.token && earTg.chat_id != null) ? { token: earTg.token, chatId: earTg.chat_id } : null,
    earProbeEveryMs: earOff ? 0 : (parseFrequency(earCfg.every) ?? 30 * 60_000),
    earProbeTimeoutMs: parseFrequency(earCfg.timeout) ?? 45_000,
    onLog: (m) => log.line?.(`[bridge] ${m}`),
  }, startBridge ? { start: startBridge } : {}));

  // Persist incoming attachments into the chat's media/ folder + surface them to E.
  // For a video: keyframes (ffmpeg) + audio transcript (via the same chain) — Route A.
  const media = createMedia({ contacts, io, transcribe: tx.transcribe, transcribeCfg: tx.cliCfg, onLog: (m) => log.line?.(`[media] ${m}`) });
  // radio relay (createRadioNoteRelay, above) piggybacks on the SAME onMedia callback to stash
  // a voice note's already-downloaded local path — see that function's header for why it needs
  // both this AND the spine's ev, and how the two are correlated. gate: lasso.gate — the SAME
  // node-wide outbound ceiling the echo (echoGate, above) and every port send already go
  // through; a note reaching the station counts as an outbound message, never a second budget.
  const radioRelay = createRadioNoteRelay({ resolveConvRoom, cfg, gate: lasso.gate, onLog: (m) => log.line?.(`[radio] ${m}`) });
  bridge.onMedia((m) => { radioRelay.noteMedia(m); return media.save(m); });

  // The operator-console LIMB (plans/2607191835-SHELL-LIMB-S1-PLAN.md Phase 1): a second
  // SURFACE dialing OUT to an external editor at ws://127.0.0.1:23375, exactly as the
  // beeper limb dials Beeper Desktop. Its inbound feeds the SAME pipeline (wired below,
  // after the spine exists) and its command replies route back over its own socket (see
  // the routed `send` handed to createCommands). A dumb pipe — no command logic here.
  // The SAME per-NODE bridge-signature layers the beeper bridge received (above) — so a persona
  // reply rendered to the operator console is wrapped byte-identically to one rendered to Beeper
  // (ONE path, operator 2026-07-25). Default '' → nothing added, exactly like the beeper side.
  // Wrapped by the SAME lasso as the beeper limb (never a second one): a shell-owned chat
  // routes to this port and would otherwise leave the node unregulated — "any limb", operator
  // 2026-07-26. The wrap is a Proxy precisely so this port's `isConnected` GETTER stays live.
  // THE PERMANENT SHELL HEADER (operator 2026-07-27, computeShellHeader above): computed HERE,
  // the ONE place config is read for this feature — the editor never touches config.yaml.
  const shellHeader = computeShellHeader({ nodeName: node_name, personaName: labelOf(defaultKey), agents: cfg.agents, defaultNode: cfg.dispatch?.default_node });
  const shellPort = lasso.wrap(createShellPort({
    wakeWords,
    addressWithoutAt,                     // same switch, same route — the shell gate and the beeper gate move together
    bridgeSignatureOpen: cfg.bridge_signature_open ?? '',
    bridgeSignatureClose: cfg.bridge_signature_close ?? '',
    nodeName: node_name,                  // same structural layer — a shell frame is a surface send too
    header: shellHeader,
    onLog: (m) => log.line?.(`[shell] ${m}`),
  }));

  // Shell-aware bridge facade (makeShellAwareBridge, top of file): the STREAMING senders
  // (E's persona sender + the brain-member relay sender) render through their injected
  // `bridge`, which was the raw beeper bridge — so a streamed @e / @member reply on a
  // shell-owned chat streamed to Beeper and never reached the editor. Handed as `bridge` to
  // BOTH createSender calls below; the beeper path for non-shell chats is untouched.
  const shellAwareBridge = makeShellAwareBridge(bridge, shellPort);

  // --- lifecycle announce: "restarting…" to Self before exit, "back up! <commit>"
  //     on the next boot. The bounce is otherwise invisible to the operator. ---
  const sidecar = join(EGPT_HOME, 'state', 'restart-announce.json');
  const KIND_OF = { 43: '/restart', 42: '/upgrade', 44: '/rewind' };
  const gitOut = (args) => { try { return spawnSync('git', args, { cwd: process.cwd() }).stdout?.toString().trim() || ''; } catch { return ''; } };
  const shortSha = () => gitOut(['rev-parse', '--short', 'HEAD']) || '?';
  async function announceAndExit(code) {
    const selfDm = selfChatId();   // the Self chat (above) = the Self-DM announce target
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
    // before a class is evicted; -1 = never idle-evict (0 = always evict), bounded only by `max` LRU.
    // E's chats are 'conversation'.
    //
    // CONVERSATION DEFAULT = 15m (operator 2026-07-02, verbatim: "keep any
    // conversation as a background agent 15m after the last message, configurable.
    // i like that you can keep a number or all agents warm. probably we should
    // honor override per configuration"). This SUPERSEDES the earlier never-evict
    // default (commit 4eaceaf "E is a persistent background agent — never idle-evict
    // conversations", which set conversation: 0 — never-evict under the OLD dialect): a conversation now goes cold 15m
    // after its last turn, and the transcript + `--resume` make the next turn
    // correct, just colder. system/resident stay NEVER-EVICT, and so does `sibling` — the
    // operator only ruled on conversations. Those three read `-1` since the 2026-07-26 dialect
    // flip (-1 never, 0 ALWAYS evict); they were written `0` when 0 meant never.
    //
    // `warm.max` is the "keep a number — or, with a high max, all — agents warm"
    // knob the operator likes: the LRU cap bounds how many warm sessions live at
    // once, independent of the idle TTL. Per-conversation override: a conversation
    // folder's own config.yaml `warm: { idle_ttl }` beats the class TTL (resolved in
    // brainpool, passed per-run to the pool); a negative there = keep THAT conversation warm.
    idleTtlMs: cfg.warm?.idle_ttl_ms ?? 1_800_000,   // fallback for any unlisted class
    idleTtlByClass: cfg.warm?.idle_ttl_by_class ?? { system: -1, resident: -1, conversation: 900_000, sibling: -1 },
    onLog: (m) => log.line?.(`[warm] ${m}`),
  });

  // --- services (each DI-wired; none closes over another) ---
  const services = {
    identity: createIdentity({ now, timeZone: transcriptTimeZone }),
    gating: createGating({ getConfig, loadState: _loadState, defaultKey }),
    // Router resolves an @token against the unified `agents:` block (operator 2026-07-02) —
    // the ONE registry, and since 2026-07-25 the ONLY source of off-node reach (a relay agent's
    // relay_channel). defaultBeing = defaultKey: the persona-route + the un-@mentioned
    // fall-through both yield the persona's KEY (operator 2026-07-10 — no hardcoded 'e'/'egpt').
    // quick_reply_string: the token that addresses whoever spoke last (default 'r', '' disables).
    // resolveType (operator 2026-08 meta-engineer): `brains.resolve(name)` — DELIBERATELY no
    // convDir — is the dangerous-type GATE's resolution (built-in + profile layers only, never a
    // conversation's own brains/ override). `brains` is declared a few lines below; this closure
    // only reads it once resolve() actually runs a turn, long after boot() finishes, so the
    // forward reference is safe. The runtime resolution brainpool.mjs uses for an ALREADY-gated
    // turn is separate and DOES pass {convDir} — only this gate check is restricted.
    // isSelfChat (operator 2026-08: "disable wren other than in Self") — the SAME Self-chat
    // predicate defined once above for the "stop" safe word; reused here so the dangerous-type
    // gate and the kill switch can never disagree about which chat is Self.
    router: createRouter({ getAgents: () => cfg.agents ?? {}, defaultBeing: defaultKey, getQuickReply: () => cfg.quick_reply_string, addressWithoutAt, resolveType: (name) => brains.resolve(name), isSelfChat }),
    transcript: createTranscript({ contacts, persona: labelOf(defaultKey), defaultKey, node_name, timeZone: transcriptTimeZone, io, onLog: (m) => log.line?.(`[transcript] ${m}`) }),
    sender: createSender({ bridge: shellAwareBridge, bodyEmojiOf, labelOf, agentSignatureOpenOf, agentSignatureCloseOf, defaultKey }),
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
  const brain = createBrainPool({ pool, getConfig, contacts, loadState: _loadState, writeState: _writeState, brains, defaultKey, nodeIdentity, afterTurn: compaction.afterTurn, resolveConfig: configResolver.configFor, io, onLog: (m) => log.line?.(`[brain] ${m}`) });

  // operator slash commands (Self DM / authorized) — lifecycle wired now; reuses
  // the same exit codes the daemon respawns on. Constructed BEFORE the mesh: a
  // node-addressed command can arrive as an envelope and is executed through THIS
  // service on the far side (operator 2026-07-26 — egpt as a remote control).
  // COMMAND REPLIES → transcript.md too (see wrapCommandsForTranscript above): the send below
  // is wrapped so every command reply is recorded under the 'system' label, node-qualified like
  // any other line, and `commands.run` is wrapped right after construction so `send` can find the
  // ev it doesn't otherwise receive.
  const commandTranscript = wrapCommandsForTranscript({
    // Surface-routed reply: a command that arrived on the shell surface answers back over
    // the shell socket (shellPort.owns the chat id it saw inbound); everything else is a
    // beeper chat and rides the beeper bridge. This is the one seam that lets `/status`,
    // `/chrome kg`, … round-trip on the shell with ZERO duplicated dispatch — the same
    // commands service, two surfaces.
    send: (chatId, text) => (shellPort.owns(chatId) ? shellPort.send(chatId, text) : bridge.send(chatId, text)),
    transcript: services.transcript,
    onLog: (m) => log.line?.(`[transcript] ${m}`),
  });
  const commands = createCommands({
    getConfig,
    send: commandTranscript.send,
    exit: announceAndExit,
    writeRewindTarget: (ref) => writeFile(join(EGPT_HOME, 'rewind-target.txt'), ref, 'utf8'),
    loadState: _loadState, writeState: _writeState,   // /e auto <mode> + the /e wizard persist into conversations.yaml
    resolveConvRoom,                                  // (surface, chatId) → the conversation's Room — the SAME resolver the phase-4 relay reads members from, so /members writes where the relay reads (bug fix 2026-07-23)
    brains,                                           // the /e wizard resolves a picked agent type through the registry
    defaultKey,                                       // the persona being-id (its map key) — /e auto + /status + wizard key their per-conversation reads/writes/evictions off this, never 'e' (operator 2026-07-10)
    evictWarm: (key) => pool.evict(key),              // drop a re-pointed conversation's warm session so it respawns fresh
    warmStats: () => pool.stats(),                    // /status `warm:` field — { size, max, keys }
    shellConnected: () => shellPort.isConnected,       // /status `shell:` field — is the operator's editor dialed in
    gate: lasso.gate,                                  // /radio say's upload — the SAME node-wide lasso instance the beeper bridge, echo and shell port already spend from (never a second one)
    listEntityDirs,                                    // bare /radio's joined-rooms report + /radio leave all|<slug> — THE walk (above), never a second entity enumeration
    onLog: (m) => log.line?.(`[command] ${m}`),
  });
  commands.run = commandTranscript.wrapRun(commands.run);

  // Cross-node being relay (Phase 4b). Supplies the mesh engine's host callbacks from
  // v2 services: bridge (send/postStatus/startStream), brain (the responder's turn),
  // config (node_name/agents relay_channel routes). onEdit is registered here (its ONE
  // consumer) so a responder's in-place stream edits mirror to the origin placeholder.
  // SHELL-AWARE bridge (operator 2026-07-25): a relay whose ORIGIN is the shell (`@don` typed
  // in the operator console — origin chat_id 'main') must stream its placeholder + living-mirror
  // reply back to the EDITOR, not to Beeper (where the shell can't see it). The raw bridge dropped
  // it; the shell-aware facade routes the origin-side send/startStream/postStatus to shellPort for
  // shell-owned chats. The relay-channel envelope (a Beeper chat) is not shell-owned → still Beeper.
  // getSelfChatId: the Self chat (same first command channel announceAndExit posts to) — the mesh
  // relays through it when a relay_channel doesn't resolve, so a missing group degrades to a
  // working link + a notice instead of a silently dropped envelope.
  // commands: a node-addressed command arriving as an envelope is EXECUTED on this node through
  // the command service above, instead of being handed to a being (operator 2026-07-26).
  // resolveType: the SAME base-layers-only resolution the router uses (point 3 above) — one
  // definition, threaded to both DI call sites, never re-derived.
  const mesh = createMeshService({ bridge: shellAwareBridge, brain, commands, getConfig, bodyEmojiOf, getSelfChatId: selfChatId, resolveType: (name) => brains.resolve(name), onLog: (m) => log.line?.(`[mesh] ${m}`) });
  bridge.onEdit((e) => mesh.onEdit({ msgId: e.msgId, newText: e.newText }));

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
  // them from the node config.heartbeats block + every conversation/room entity's
  // own heartbeats: block, materializes heartbeats.readonly.yaml,
  // and registers each onto services.heartbeats. The alive-file writer is no
  // longer special-cased here — it is the loader's default `alive` command
  // (echo beat > state/alive.txt), visible in the readonly view like any other.
  //
  // The default alive beat is a shell one-liner, visible in config and in
  // heartbeats.readonly.yaml: `echo beat > state/alive.txt`. Liveness is the
  // file's MTIME (any command that writes it is a valid beat; the "beat" content
  // is freeform, for humans), so the old parsed-line contract + the 82-line script
  // are gone. The loader runs it with cwd = EGPT_HOME so the relative state/ lands
  // in the profile. Verified on Windows cmd + POSIX sh (spawn shell:true).
  const aliveCommand = 'echo beat > state/alive.txt';

  const heartbeatLoader = createHeartbeatLoader({
    resolver: configResolver, aliveMs, aliveCommand, now,
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
  // the in-memory heartbeat set, it first asks the resolver whether any of the three
  // *.readonly.yaml aggregates is missing — an ABSENCE means that set is stale (operator 2026-07-02:
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

  // The SINGLE guard (C7.7, plans/260722-COMMAND-SURFACE-ROADMAP.md phase 3): N consecutive
  // NON-HUMAN turns pause a channel; a genuine human message resets it (provenance, not display
  // name — a mesh envelope posted AS the operator counts). Replaces the flood-guard + mesh
  // breaker. Config `guard: { turns, window }` (turns -1 = off, window minutes -1 = pure
  // consecutive). guardOverride reads the conversation's own `guard:` block (conversations.yaml)
  // so a busy relay room can loosen/disable it — else the node defaults apply.
  const guard = createStopGuard({
    turns: Number.isFinite(cfg.guard?.turns) ? cfg.guard.turns : 6,
    window: Number.isFinite(cfg.guard?.window) ? cfg.guard.window : -1,
    onLog: (m) => log.line?.(`[guard] ${m}`),
  });
  const guardOverride = async (surface, chatId) => {
    try { const g = getContact(await _loadState(), surface, chatId)?.entry?.guard; return (g && typeof g === 'object') ? g : null; }
    catch { return null; }
  };

  // PHASE 4 — room brain-member relay (design B: re-entry). Deliver a received room message to
  // each brain member (config.yaml members[]) whose mode admits it; each reply streams into the
  // room and re-enters the pipe as a synthetic non-human turn. chatgpt ONLY for now — adapterOf
  // dynamic-imports config/brains/<adapter>.mjs (memoized). A member reply is NOT an agent, so it
  // is stamped with the member id + a robot glyph via a dedicated member-scoped sender. The CDP
  // engine is the real cdp.streamFromTab (tests inject a fake). resolveMembers reads the room's
  // roster through resolveConvRoom — the SAME resolver /members WRITES through (createCommands
  // above), so the roster the relay reads is exactly the one the operator edited on this
  // conversation (bug fix 2026-07-23: previously the two resolved to different config.yaml files).
  const memberSender = createSender({ bridge: shellAwareBridge, bodyEmojiOf: () => '🤖', labelOf: (id) => id, defaultKey });
  const _adapterMods = new Map();
  const roomRelay = createRoomRelay({
    resolveMembers: async (surface, chatId) => {
      try { const room = await resolveConvRoom(surface, chatId); return room ? await room.members() : []; }
      catch { return []; }
    },
    adapterOf: async (name) => {
      if (!name) return null;
      if (!_adapterMods.has(name)) _adapterMods.set(name, await loadAdapterModule(name));
      return _adapterMods.get(name);
    },
    streamFromTab: cdp.streamFromTab,
    activateTarget: cdp.activateTarget,
    openStream: (memberId, chatId, opts = {}) => memberSender.open(chatId, { being: memberId, replyTo: opts.replyTo ?? null }),
    onLog: (m) => log.line?.(`[relay] ${m}`),
  });

  const spine = createSpine({ bridge, brain, ...services, commands, mesh, actions, advice, guard, guardOverride, stopSwitch, isSelfChat, roomRelay, readTranscript, radioRelay: radioRelay.relay, synthesize: vx.synthesize, voice: vx.voice, defaultBeing: defaultKey, node_name, timeZone: transcriptTimeZone, clock: { now }, log, tickMs: effectiveTickMs, setInterval: setIntervalFn, clearInterval: clearIntervalFn });
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

  // Feed the shell surface into the SAME dispatch (handleInbound is the spine's documented
  // direct-caller seam — the identical path bridge.onMessage/enqueue runs). Registered
  // before start() so an editor already up on boot is caught. start() dials out; it is
  // gated on the real-node flag like every other real-node side effect (whisper-reap,
  // transcriptor, ingest) so a test's boot() never opens a real editor socket — an absent
  // editor just backs off, never crashing the boot path.
  shellPort.onMessage((msg) => spine.handleInbound(redirectShellToRoom(msg, { currentRoomOf: commands.currentRoomOf, claim: shellPort.claim })));
  if (ingest) shellPort.start();

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
        // The shell editor's self-announce — poke the shell-port limb to dial in NOW
        // instead of waiting out its reconnect backoff. Not a lifecycle command.
        if (isShellConnectMarker(line)) { shellPort.poke(); return; }
        const code = lifecycleExit(line, { writeRewindTarget: (ref) => writeFile(join(EGPT_HOME, 'rewind-target.txt'), ref, 'utf8') });
        if (code != null) { log.line?.(`[ingest] ${line} -> exit ${code}`); await announceAndExit(code); }
        else log.line?.(`[ingest] ignored: ${JSON.stringify(line)}`);
      },
    });
    await ingestWatcher.start();
  }

  return {
    spine, bridge, shellPort, pool, cfg, accountPeers,   // shellPort: the second LIMB — exposed so its regulation is assertable, like bridge's
    stop: () => {
      // No alive-timer teardown: the beat is a heartbeat now, riding the spine's
      // tick timer, which spine.stop() clears.
      ingestWatcher?.stop();
      compaction.stop();
      transcriptorWorker.stop();   // stops BOTH the resident whisper-server + the :23390 endpoint
      synthesizerWorker.stop();    // stops the :23391 endpoint
      shellPort.stop();            // close the editor socket + cancel any pending reconnect
      spine.stop();
    },
  };
}
