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
import { createShellPort, shellPortFrom } from '../bridges/shell-port.mjs';
import { shellTokenFrom } from '../shell/auth.mjs';
// THE MOUTH LINK (operator 2026-09-05): the peer spine holding the OTHER Beeper account, the
// receiving half this node offers on its own console, and the speaking half the reply path uses.
import { peerSpineFrom, createMouthReceiver, speakThroughPeer, startPeerStream, reactThroughPeer } from '../shell/peer-mouth.mjs';
import { createWarmPool } from '../warm-sessions.mjs';
import { createBrainSession } from '../brain-session.mjs';
import { createSandboxCliSession } from '../sandbox-cli-session.mjs';
import { readConfigSync } from '../tools/config-io.mjs';
import { reapPort } from '../tools/reap-port.mjs';
// THE liveness question for a Beeper install, already written and already tested
// (tests/beeper-whoami.test.mjs): GET /v1/accounts with a candidate's OWN token. Imported, never
// re-implemented — a second probe here would be a second thing to get wrong about what a 401 means.
import { probe as probeBeeperEndpoint } from '../tools/beeper-whoami.mjs';
import * as cdp from '../tools/cdp.mjs';
import { Room, CONVERSATIONS_ROOT, ROOMS_ROOT, AGENTS_ROOT } from '../room-core.mjs';
import { loadAdapterModule } from '../adapters/registry.mjs';
import {
  CONV_YAML_PATH, readState as readConvState, writeState as writeConvState, slugDir, getContact, LOBBY_SLUG, fixedSlugFor,
} from '../conversations-state.mjs';
import { createStopGuard, STOP_FILE, stopFilePresent, writeStopFile } from '../stop-guard.mjs';
import { createLasso } from '../lasso.mjs';
import { CLEAN_EXIT_CODE } from '../daemon-runtime.mjs';

import { createIdentity, surfaceOf, SHELL_SURFACE } from './identity.mjs';
import { echoRank } from './echo-priority.mjs';
import { shortChatId } from '../bridges/chat-id.mjs';
import { createContacts } from './contacts.mjs';
import { createGating } from './gating.mjs';
// createRouter + THE wake vocabulary. wakeTokens is the ONE rule for "which @tokens address this
// agent" (declared `handles:`, else the map key) — imported, not re-implemented, so the persona
// wake set boot hands the ports and the router's own @token scan can never disagree again.
import { createRouter, wakeTokens, voiceWakeTokens, fallbackWake } from './router.mjs';
import { createTranscript } from './transcript.mjs';
// createSender: the reply path. makeOutbound: the ONE answer to "which connection does this
// outbound go out on" (sender.mjs's header), asked by makePeerMouth below rather than copied.
import { createSender, makeOutbound } from './sender.mjs';
import { createBrainPool } from './brainpool.mjs';
import { createRoomRelay } from './room-relay.mjs';
import { createIdentityScope } from './identity-scope.mjs';
import { createPeerLiveness, tcpProbe } from './peer-liveness.mjs';
import { fanoutInbound } from './bridge-fanout.mjs';
// THE routing table's own two readings (operator 2026-08-31): which chats are TRANSIT (a
// relay_channel, so not a conversation at all) and whether a frame was committed by ANOTHER
// node's spine. Both derive from the SAME agents block / node identity every other gate reads.
import { isRelayChannelChat, ownNodeNamesOf } from './node-names.mjs';
import { createIngest, lifecycleExit, isShellConnectMarker } from './ingest.mjs';
// THE SESSION 1 SUCCESSOR'S ANNOUNCE (chunk 3 of plans/2609061200-SESSION-0-TO-1-HANDOVER-PLAN.md).
// Absent EGPT_SESSION1 this is one `false` and nothing else runs — every Session 0 spine, every
// test and every other node take the identical path they took before it existed.
import { isSession1Successor, announceStanddown, SESSION1_ENV } from './successor-announce.mjs';
import { createCommands, launchChromeDirect } from './commands.mjs';
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
// THE TURN MACHINERY (operator 2026-08-31) — built ONCE below and injected into BOTH the mesh
// service and the spine. It used to be private to createSpine, which is why a RELAYED turn got
// no FIFO, no queued placeholder and no allow_new_input steer; two instances would be worse than
// none, because a relayed turn and a local turn in one conversation derive the SAME key and must
// meet on the SAME queue.
import { createTurns } from './turns.mjs';
import { createCompaction } from './compaction.mjs';
import { createHeartbeats } from './heartbeats.mjs';
import { createHeartbeatLoader, parseFrequency, resolveTimeZone } from './heartbeat-loader.mjs';
import { createConfigResolver, parseEntityConfig } from './config-resolver.mjs';
import { seedSkeletons } from './seed.mjs';
import { readRoomConfig, readRoomsFile } from '../rooms-file.mjs';

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
// Redirect a shell inbound event to its CURRENT joined room, if any — "entering a
// room is like typing in another chat" (operator): once `/rooms join acim` sets the shell's
// current room, a plain or `@e`-addressed message typed at the shell must dispatch as
// chatId 'acim' rather than the console's own seat, so it reaches the SAME
// (surface, chatId)-keyed resolution/confinement a room-native message already gets (the
// room refactor's own principle — room-core.mjs). currentRoomOf is commands.mjs's ONE reader
// onto its ONE currentRoom map (written only by roomJoin/roomLeave) — no second map here.
// The shell IS surface `room` now (identity.SHELL_SURFACE), so the map key on both sides is
// that one surface: nothing here re-decides it.
// The LOBBY (or no room joined) means the console's own home conversation — rooms/lobby/,
// a room like any other — so the event is left untouched and files there, same as before
// this redirect existed. /rooms lobby join is therefore "go home", not a redirect into a
// second folder.
// A reply goes out to ev.chatId (spine.mjs's sender.open), which is now the room slug — so
// the redirect also `claim`s it on shellPort (the SAME ownership signal `owns()` already
// keys outbound routing on for the console seat), or the reply would be handed to the beeper
// bridge instead of pushed back over this socket. Pure aside from that one registration call,
// so the redirect decision itself is testable directly (mirrors makeShellAwareBridge below).
export function redirectShellToRoom(msg, { currentRoomOf, claim } = {}) {
  // Commands (anything slash-prefixed) are never part of the room fan-out — this feature is
  // "prose fan-out to the current room", not "commands run against the room". Without this
  // guard, `/rooms leave acim` itself got redirected before commands.mjs ever saw it, so it
  // dispatched on the room instead of the console's own seat and the shell got wedged in the
  // room permanently (confirmed live, 2026-08-09). This is the same primitive signal
  // commands.mjs's isCommand() checks first (body.startsWith('/')) — the full check also
  // needs a built `ev` (identity.build), which doesn't exist yet at this point in the pipeline.
  if (String(msg?.body ?? '').trim().startsWith('/')) return msg;
  const room = currentRoomOf?.(SHELL_SURFACE);
  if (!room || room === LOBBY_SLUG) return msg;
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

// ── WHICH MOUTH SAYS A REPLY (operator 2026-09-05, the peer-spine mouth link) ──────────────────
// The SPEAKING half's two questions, in one object, handed to createSender — which is where the
// decision is actually made (src/spine/sender.mjs header). Split out here for the same reason
// makeShellAwareBridge and redirectShellToRoom are: it is the routing rule, it is pure but for
// the injected bridge reads, and it is worth testing directly rather than through a whole boot.
//
// `route(chatId)` answers "should the PEER say this reply?" and, when it should, hands back the
// RAW chat payload the cross-account key is computed from (never a chatId: the two accounts see
// one real group as two different Matrix rooms and nothing in the payloads is shared).
// `startStream(chat, init, { fallback })` then opens the reply there — the placeholder, its
// in-place edits and its settled text, all on the other account (src/shell/peer-mouth.mjs).
//
// WHICH OF THE TWO IDENTITIES IS THE PEER'S is not configured and does not need to be: it is
// whichever one is IN THIS ACCOUNT'S OWN ROSTER. An account's own entry in its own roster carries
// no phone number at all (measured — see beeper.crossAccountChatKey), so this node's own identity
// can never match here, and the one that does is the co-account's. `peer_spine.accounts` names
// both symmetrically on both nodes, which is exactly what makes that work without a third key.
//
// UNKNOWN MEMBERSHIP POSTS LOCALLY. chatHasParticipant answers true | false | null, and null means
// the roster could not be read. Routing on a guess would risk handing the line to a peer that is
// not in the chat, which then finds no match and costs a round trip before falling back anyway;
// posting locally is guaranteed to arrive. So null is treated exactly like false — no dial at all.
// This is NOT the router's "UNKNOWN MEANS SILENT" trade inverted: silence there protects against
// two spines answering one @handle, while here the reply is going out either way and the only
// question is out of which mouth.
//
// THE CONSOLE IS NEVER ROUTED. A shell/room chat id is not a Beeper chat, so asking Beeper about
// its roster is a wasted (and failing) GET on every reply typed at the editor. `owns` is the SAME
// ownership signal the shell-aware bridge already routes outbound on — no second rule.
//
// …AND BOTH READS ASK THE CONNECTION THAT HOLDS THE CHAT (operator 2026-09-11). *"self doesn't
// have mouth. if mouth is available always use mouth."* This object held ONE frozen bridge — the
// fan-out facade, which delegates everything but its three inbound registrations to the node's
// DEFAULT MOUTH. The facade fans `chatHasParticipant` (per-account, bridge-fanout.mjs) and does
// NOT fan `chatRaw`, so on a two-account node the two reads answered about two different
// accounts: the membership came from the connection that HAS the chat, and the payload was then
// demanded of one that does not. chatRaw came back empty, route() gave up, and the peer link was
// dead for every chat heard on the ear — quietly, because "the payload came back empty" reads
// like a Beeper hiccup rather than a question asked of the wrong install.
//
// `bridgeOf(being, chatId)` is the SAME per-chat resolver the reply path already asks
// (outboundConnectionFor, below): the mouth wherever the mouth can reach the chat, the connection
// the chat lives on where it cannot. ONE bridge is resolved per route() and BOTH reads go to it,
// because they are two halves of one question about one room. No being — routing is a question
// about a CHAT, not about who is speaking — so `null` is passed, as every node-level send does.
//
// NOTHING IS LOST BY UN-FANNING chatHasParticipant here. Where the resolver has no answer (a chat
// this node never heard) it hands back the mouth, which is the bridge the facade delegated
// chatRaw to anyway — so the fan could see one connection further than the very next line could
// act on, and route() refused either way. Where it does have an answer, asking the one connection
// that holds the room is strictly more precise than a vote (bridge-fanout's own words: "at most
// one connection ever holds a definite answer").
//
// SPEAKING IS UNTOUCHED. startStream and react go over the PEER CONSOLE (startPeerStream /
// reactThroughPeer) and never over a bridge on this node — that is the whole point of the link,
// and no bridge, resolved or frozen, appears in either.
export function makePeerMouth({ peer, bridge, bridgeOf = null, owns = () => false, speak = speakThroughPeer, stream = startPeerStream, reactor = reactThroughPeer, onLog = () => {} } = {}) {
  if (!peer) return null;                     // no peer_spine ⇒ no mouth ⇒ createSender is handed none ⇒ nothing changes
  // THE ONE RESOLVER (sender.mjs makeOutbound), built once. No peerMouth is handed to it, so its
  // own route thunk is inert — this IS the peer mouth, and all that is wanted here is which of
  // THIS node's connections holds the room. Absent bridgeOf (a one-connection node, and every
  // unit test) ⇒ the injected bridge, byte-identical to before.
  const outbound = makeOutbound({ bridge, bridgeOf });
  return {
    async route(chatId) {
      if (owns(chatId)) return null;
      // The connection this chat lives on, asked ONCE and read twice (header).
      const on = outbound(null, chatId).bridge;
      for (const account of peer.accounts) {
        let present = null;
        try { present = await on?.chatHasParticipant?.(chatId, account); }
        catch (e) { onLog(`could not read the roster of ${chatId} — this node will say the reply itself: ${e?.message ?? e}`); return null; }
        if (present !== true) continue;       // false = the peer is not here; null = UNKNOWN → local (above)
        let raw = null;
        try { raw = await on?.chatRaw?.(chatId); }
        catch (e) { onLog(`the peer's account is in ${chatId} but its chat payload could not be read — this node will say the reply itself: ${e?.message ?? e}`); return null; }
        if (!raw) { onLog(`the peer's account is in ${chatId} but its chat payload came back empty — this node will say the reply itself`); return null; }
        return raw;
      }
      return null;
    },
    // THE REPLY THROUGH THE PEER, and the only way to make one: a stream object with the SAME
    // surface a local one has, so the sender's whole decision is which factory to call
    // (src/spine/sender.mjs). `fallback` is the sender's own local stream factory — the last of
    // the three tiers startPeerStream walks — handed in rather than built here because only the
    // sender knows the chat, the tag and the placeholder text. `speak` is the SECOND tier, the
    // finished-line path this file used to expose separately as say(): it is not a different
    // feature, it is what a reply train degrades INTO, so it is injected here and nowhere else.
    //
    // `render` is the sender's too, and for the same reason: it is the BRAIN's persona wrap bound
    // to the being being replied as, and only the sender knows which being that is. Passed
    // straight through — this object decides nothing about it. Absent (undefined) ⇒ startPeerStream's
    // identity default ⇒ the frames cross the wire raw, which is what they did before it existed.
    startStream(chat, init, { fallback = null, render } = {}) { return stream({ peer, chat, init, render, fallback, say: speak, onLog }); },
    // THE 👀 THROUGH THE PEER (operator 2026-09-07), and it takes the SAME `chat` payload route()
    // handed back — the one this object's other method already takes — because a reaction is
    // keyed to a chat exactly like a reply and then to a message inside it. The message is named
    // by the cross-account key the bridge minted on the inbound (`ev.msgHash`) plus its own
    // timestamp; no id crosses, here as everywhere else on this link.
    //
    // NO FALLBACK, unlike startStream's three tiers. A reply must arrive somewhere; a read receipt
    // from the account that is NOT answering is the fault this exists to fix, so a refusal means
    // no reaction at all and the caller says so in the log (src/spine/turns.mjs).
    react(chat, { msgKey, timestamp = 0, emoji } = {}) { return reactor({ peer, chat, msgKey, timestamp, emoji, onLog }); },
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
// being's turn). Named like any other reply — createTranscript renders labelOf('system'), which
// matches no agent and so stays 'system' — so the record shows `system@[fam].wa (18:07): …`.
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

// A heartbeat entity's NAMESPACE (`<surface>/<slug>` — what the config resolver's walk hands
// the loader) → the (surface, chatId) a turn dispatches on, which is what brainpool.turn and
// every gate under it are keyed by. The registry is JID-keyed and the walk is SLUG-keyed, so
// this is the one reverse lookup: find the surface's non-alias entry whose slug matches.
// A fixed-slug surface needs no registry at all — a room's chatId IS its name (fixedSlugFor,
// 2026-08-09), so a room folder the registry has not seen yet still resolves, and
// contacts.resolve registers it on the turn. Unknown → null (the beat logs and fires nothing).
// Pure so the mapping is testable directly (mirrors the other top-level boot helpers).
export function chatIdForEntity(state, ns) {
  const i = String(ns ?? '').indexOf('/');
  if (i < 0) return null;
  const surface = String(ns).slice(0, i);
  const slug = String(ns).slice(i + 1);
  if (!surface || !slug) return null;
  for (const [jid, entry] of Object.entries(state?.contacts?.[surface] ?? {})) {
    if (!entry || entry.aliasOf || entry.slug !== slug) continue;
    return { surface, chatId: jid };
  }
  if (fixedSlugFor(surface, slug) === slug) return { surface, chatId: slug };
  return null;
}

// Enumerate the entity folders: conversations/<surface>/<slug>/, rooms/<slug>/ and
// agents/<name>/.
// An operator-named room is not a second KIND — it is a conversation on surface `room`
// (2026-08-09, chatId and all) — but conversations/ is the BEEPER tree, and a room does not
// arrive through Beeper, so its folder sits at EGPT_HOME/rooms/<slug>/ (operator 2026-08-28).
// An agent's own conversation is the same story on surface `agent`, rooted at
// EGPT_HOME/agents/<name>/ (operator 2026-09-01).
// Hence ONE walk over THREE roots, all from room-core's surface→root map, and the ns it emits
// is still `room/<slug>` / `agent/<name>` — byte-identical to ConversationRoom.ns(), which is
// what keys config/rooms.yaml. Missing dirs are tolerated (a fresh profile has none).
//
// THIS IS THE WALK — the only one. It feeds the config RESOLVER, which layers the three rungs
// and serves EVERY per-entity reader (heartbeats, warm, transcription); adding a second
// enumeration anywhere is the bug this replaced. Module-scope + exported so it is testable
// directly (tests/list-entity-dirs.test.mjs) — it closes over nothing.
export async function listEntityDirs() {
  const out = [];
  // Surfaces are OPEN (operator ruling: any network Beeper bridges is its own
  // surface) — driven by real disk contents, not a fixed list, so a new surface's
  // folder is walked with zero code change.
  let surfaces = [];
  try { surfaces = await readdir(CONVERSATIONS_ROOT, { withFileTypes: true }); } catch { surfaces = []; }
  for (const surfaceEnt of surfaces) {
    if (!surfaceEnt.isDirectory()) continue;
    const surface = surfaceEnt.name;
    let ents = [];
    try { ents = await readdir(join(CONVERSATIONS_ROOT, surface), { withFileTypes: true }); } catch { continue; }
    for (const ent of ents) if (ent.isDirectory()) out.push({ dir: join(CONVERSATIONS_ROOT, surface, ent.name), ns: `${surface}/${ent.name}` });
  }
  let rooms = [];
  try { rooms = await readdir(ROOMS_ROOT, { withFileTypes: true }); } catch { rooms = []; }
  for (const ent of rooms) if (ent.isDirectory()) out.push({ dir: join(ROOMS_ROOT, ent.name), ns: `room/${ent.name}` });
  let agents = [];
  try { agents = await readdir(AGENTS_ROOT, { withFileTypes: true }); } catch { agents = []; }
  for (const ent of agents) if (ent.isDirectory()) out.push({ dir: join(AGENTS_ROOT, ent.name), ns: `agent/${ent.name}` });
  return out;
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
// fixed status line — a `room:` segment + a roster of this node's OWN `agents:`, grouped by
// where each one routes — and a FUTURE browser-extension surface will need the identical
// string but cannot read config.yaml at all. So the derivation lives HERE, spine-side, pure
// (mirrors shouldReapStrayWhisper), and boot hands the computed STRING to the shell limb over the
// frame the two already share (src/bridges/shell-port.mjs `header`) — the editor never reads
// config. Never a peer node's roster: only this node's own `agents:` map, grouped by route.
//   No standalone persona label (operator 2026-08-17, dropped): the default persona is already
//   IN the groups segment below (its own shortest handle, e.g. `@e`) — reachability is a
//   per-conversation property (config.yaml + conversations.yaml overrides), not one being with
//   special billing, so singling it out up front was redundant and implied a status it doesn't
//   have.
//   nodeName    = cfg.node_name — the LOCAL group's key when an agent has no `to:`/`paths:`.
//   agents      = cfg.agents — absent/empty tolerated (no throw; just no trailing groups segment).
//   currentRoom = commands.mjs's currentRoomOf(SHELL_SURFACE) (operator 2026-08-16: live status-line
//                 join reflection; operator 2026-08-17: rendered as `room: <slug>`, not a
//                 `lobby → X` arrow — the shell's fixed home conversation is LOBBY_SLUG itself,
//                 so with nothing joined the segment reads `room: lobby` (honest, not "→ nothing"),
//                 and with a room joined it reads `room: <that room>`).
//   defaultNode = raw `dispatch.default_node` (string|undefined/null; normalized in here, trim+lowercase).
//                 Renders ` → <default_node>` right after the room segment's value, UNLESS it's
//                 unset/empty OR equals nodeName itself (bare commands run locally either way —
//                 no arrow implying a route that isn't happening). Kept as the ONLY arrow in the
//                 string now that room-join no longer uses one, so `room: acim → do` reads
//                 unambiguously as "cross-node default routing", not room-to-room navigation.
// Groups render in agents-map insertion order (JS object order already preserves it); handles
// render within a group in agent-declaration order. SHORT HANDLE = the shortest string in the
// agent's `handles:` array, else its map key.
export function computeShellHeader({ nodeName, agents, defaultNode, currentRoom } = {}) {
  const normDefaultNode = String(defaultNode ?? '').trim().toLowerCase();
  const normNodeName = String(nodeName ?? '').trim().toLowerCase();
  const arrow = (normDefaultNode && normDefaultNode !== normNodeName) ? ` → ${normDefaultNode}` : '';
  const room = String(currentRoom ?? '').trim();
  const roomLabel = (room && room !== LOBBY_SLUG) ? room : LOBBY_SLUG;
  const base = `🟢 room: ${roomLabel}${arrow} — ? for help · ctrl-d = send`;
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

// THE ROSTER a fan-out resolves for one conversation — the room-relay's `resolveMembers` seam.
// A conversation IS a Room, and its members[] is what /members writes through resolveConvRoom:
// that own-room lookup is the whole roster, exactly as in the original phase-4 wiring. Never
// throws — a fan-out with no roster is a no-op.
//
// `roster.tunnelRooms` — WHICH ROOMS INVITED THIS CHAT IN, by the REVERSE lookup: `/members add
// group <chatId>` stores a `wa-group` member whose id IS a chat id, so scanning config/rooms.yaml
// for this chatId finds every room this conversation tunnels into (operator 2026-08-29: "many and
// different groups to join a room … a room works as a communication tunnel between groups").
// room-relay.mjs's fanOut re-enters the message into each of those rooms as a TURN of its own, so
// the room records it, wakes its agents, and fans out to the other groups + brains from THERE
// (operator 2026-08-31 — see that module's header). A plain array with no property is a valid
// roster shape too (every existing caller/test), so this stays additive.
//
// THOSE ROOMS' MEMBERS ARE NOT CONCATENATED IN (2026-08-31, a net deletion). They used to be: the
// group's own fan-out delivered to the room's members directly, and the room itself only got a
// transcript line. With the message re-entered into the room, the room's own fan-out reaches them
// — so concatenating here would deliver every line TWICE, once from each end.
//
// AND THE REVERSE LOOKUP DOES NOT RUN FOR SURFACE `room` — the ONE-HOP lock. A tunnel starts at a
// surface chat and ends in a room: a wa-group member names a chat on a messaging surface, while a
// room's own conversation lives on surface `room`, so a room turn has nothing it could match. That
// is structural rather than a counter — without it, two rooms each listing the other's name would
// re-enter into each other forever.
export function createMemberResolver({ resolveConvRoom, readRooms = readRoomsFile } = {}) {
  return async (surface, chatId) => {
    try {
      const tunnelRooms = [];
      if (surface !== SHELL_SURFACE) {
        for (const [ns, row] of Object.entries(await readRooms())) {
          const listed = Array.isArray(row?.members) ? row.members : [];
          if (!listed.some((m) => m && m.kind === 'wa-group' && String(m.id) === String(chatId))) continue;
          // The row KEY is the room's ns — `<surface>/<slug>`, the same string Room.ns() emits —
          // so the SLUG it names is the chatId the re-entry addresses the room by (a room is a
          // contact on surface `room` whose chatId IS its name). A key with no surface prefix is
          // not a room address; skip it.
          const cut = String(ns).indexOf('/');
          if (cut > 0) tunnelRooms.push(String(ns).slice(cut + 1));
        }
      }
      const own = await resolveConvRoom(surface, chatId);
      const roster = own ? await own.members() : [];
      // Non-enumerable: an existing caller that deep-equals the roster against a plain array
      // (every test today, e.g. `toEqual([])`) must see no difference — only a reader that
      // knows to ask for `.tunnelRooms` by name (room-relay.mjs fanOut) ever sees it.
      Object.defineProperty(roster, 'tunnelRooms', { value: tunnelRooms, enumerable: false });
      return roster;
    } catch { return []; }
  };
}

// EVERY EMITTED LINE CARRIES THE CLOCK (operator 2026-09-11) ────────────────────────────────
//
// config/logs/service-stderr.log had NO timestamp on any line — 112,000 lines of `[heartbeat]
// alive: ok in 18ms` and `[bridge] beeper: incoming …` that could not be placed on a clock. So
// "E stops responding when the screensaver is on" could not be investigated AT ALL: not one line
// in the file could be lined up against a Windows wake timer, an event-log entry, or the
// operator's own recollection of when he wrote.
//
// THIS IS THE ONE PLACE. boot builds ONE `log` object and threads `log.line` into every service's
// onLog (bridge, heartbeat, warm, mouth, transcribe, brain, actions, lasso, mesh, spine…), so
// every line in that file arrives here. Nothing stamps at a call site, and there is no second
// logger: a caller that injects its own `log` (every test, the shell) still gets exactly what it
// asked for, unstamped.
//
// THE SHAPE — `2026-09-11 13:25:07-04:00 ` then the line, unchanged:
//   · LOCAL time, because it is read beside Windows Event Viewer and Task Scheduler, which are
//     local, and beside the operator's memory of his own evening.
//   · WITH THE UTC OFFSET (6 chars). Local alone is ambiguous for one hour every autumn — the
//     hour repeats and `sort` misorders it — and says nothing about which machine's zone wrote
//     it. It also buys the correlation across the two files: egpt-daemon.mjs stamps
//     service-stdout.log in UTC (`[egpt-daemon <ISO>]`), so pairing a respawn with the spine
//     lines around it needs the offset in the file rather than in someone's head.
//   · WITH THE DATE, because the file is append-only across service restarts and NSSM rotations
//     (10 MB) and spans days; a time-only stamp repeats every midnight, which is precisely the
//     part of the night this was added to investigate.
//   · FIRST, fixed width, one space: `sort` orders the file, the eye reads a column, and
//     `grep '^2026-09-11 03:'` selects an hour.
// `Date.parse()` reads it back as written.
//
// THE WALL CLOCK, not boot's `now` seam: this records when the line was WRITTEN. A caller that
// freezes `now` to replay a fixture day must never make a live log claim that day.
const pad2 = (n) => String(n).padStart(2, '0');
export function logStamp(d = new Date()) {
  const off = -d.getTimezoneOffset();                      // minutes EAST of UTC
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} `
       + `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
       + `${off < 0 ? '-' : '+'}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}
// THE SINK. Exported so a test can drive the real one rather than a copy of it. The catch is the
// pre-existing one and stays empty on purpose: this IS the reporting channel, so a console that
// throws leaves nowhere to report it to.
export function stderrLine(s) { try { console.error(`${logStamp()} ${s}`); } catch { /* stderr is gone */ } }

export async function boot({
  readConfig = readConfigSync,
  startBridge = null,                 // createBeeperBridgePort's `start` seam (null = real beeper)
  makeSession = (opts) => (opts.sandboxed ? createSandboxCliSession(opts) : createBrainSession(opts)),   // engine-dispatching session factory (ccode remains default); sandboxed:true wraps the ccode session in setup/sandbox-logon-launcher.ps1's OS-level isolation
  loadState = null, writeState = null,// conv-state IO (null = real CONV_YAML_PATH)
  io = {},                            // fs seam for transcript + brainpool + contacts ({appendFile,mkdir,existsSync,rename}); real fs by default. Tests inject in-memory so they never touch the profile.
  log = { line: stderrLine },         // THE stderr sink — it STAMPS every line (see stderrLine above). A caller that injects its own log is untouched.
  now = () => Date.now(),
  // The tick is the loop's PULSE now — every registered heartbeat's cadence rides
  // on it, so tickMs must be finer than the finest cadence. 30s lets the 60s alive
  // beat be honored (a 5-min tick never could).
  tickMs = 30_000,
  aliveMs = 0,                        // >0: register the alive-file writer as a heartbeat so the daemon's wedge check sees liveness
  spawn: spawnFn = spawn,             // child_process.spawn seam — heartbeat command beats (incl. the alive script) spawn through here; tests inject a fake to observe the beat WITHOUT a real process
  reapPort: reapPortFn = reapPort,    // port-killer seam — the boot-time stray-whisper reap goes through here; tests inject a fake so the real netstat/taskkill NEVER runs against a live server
  // Beeper endpoint-liveness seam — the ONLY network call boot makes before the bridge exists.
  // It is how a connection carrying just account+token finds WHICH port its install is on (the
  // discovery pass below), and it still resolves the deprecated `endpoints:` list too. Tests
  // inject a fake so resolution is observable without a real Desktop on a real port.
  probeEndpoint: probeEndpointFn = probeBeeperEndpoint,
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
  // THE SUCCESSOR FLAG, read from the environment ONCE, here, like every other config-fed option
  // — the announce module never reads process.env at a call site. setup/session1-logon-launcher.vbs
  // sets EGPT_SESSION1=1 for the spine it starts at logon; it cannot be a config key because both
  // spines read the SAME config file. Injected in tests so no test has to mutate process.env.
  session1 = isSession1Successor(),
  // The dial itself, injected the same way probeEndpoint / reapPort / startWhisperServer are, so a
  // test can observe the announce WITHOUT opening a real socket. Only ever called when session1.
  announceStanddown: announceStanddownFn = announceStanddown,
  // /chrome's direct launcher (chunk 6), injected for the same reason and only ever reached when
  // session1: a test asserts the wiring without spawning a real browser onto a real desktop.
  launchChromeDirect: launchChromeDirectFn = launchChromeDirect,
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
      // shellAwareBridgeOf so a STOP typed at the operator console is answered on the console,
      // not posted to Beeper. Declared far below but only READ here at call time (post-boot,
      // from the spine) — the same call-time-safe forward reference as readTranscript's
      // resolveConvDir.
      //
      // …and it asks WHICH CONNECTION REACHES THIS CHAT (outboundConnectionFor, operator
      // 2026-09-11) rather than riding the default mouth: STOP is typed in a chat this node
      // HEARD, and on a node whose mouth is another Beeper account that chat id does not exist
      // there. `null` for the being because there is none — the resolver then reads this node's
      // default mouth, which is exactly what `shellAwareBridge` was.
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
            shellAwareBridgeOf(null, why.chatId).send(why.chatId, `🛑 STOP received — egpt is stopping (the service will not respawn).\nTo start it again:  rm ${STOP_FILE}`, { bypassLasso: true }),
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

  // === THE SUCCESSOR'S ANNOUNCE (chunk 3, plans/2609061200-SESSION-0-TO-1-HANDOVER-PLAN.md) ====
  // A spine started with EGPT_SESSION1=1 is the arriving Session 1 spine and the profile it wants is
  // already held. It says so HERE — before the first line below writes state/spine.pid, and long
  // before the Beeper bridge dials — because everything under this EGPT_HOME is shared, and the
  // sooner the incumbent knows, the shorter the window in which both are awake on one profile.
  //
  // IT SAYS ONLY *THAT*, NEVER *WHEN*. The departing spine owns the timing (the operator's ruling):
  // it stops admitting turns, drains the one it is writing, and leaves with 45. So this is one
  // sentence and no wait — the waiting is shell-port's own re-listen backoff, below, which already
  // exists and already backs off on a failed bind.
  //
  // NO INCUMBENT IS AN ORDINARY STARTUP, not an error: nothing answers the dial, nothing was
  // written anywhere, and the bind below simply succeeds. Ingest-gated like every other real-node
  // side effect (whisper-reap, seedSkeletons, the port bind itself) — with ingest:false no spine
  // binds the console port at all, so there is nothing to contend for and nothing to announce.
  if (session1 && ingest) {
    const { outcome, detail } = await announceStanddownFn({
      port: shellPortFrom(cfg),
      token: shellTokenFrom(cfg),
      onLog: (m) => log.line?.(`[standdown] ${m}`),
    });
    log.line?.(`[standdown] successor (${SESSION1_ENV}=1): ${outcome} — ${detail}`);
  }

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
  // THE DISPLAY NAME COMES FROM `name:`, NEVER FROM THE MAP KEY (operator 2026-09-01: "please
  // don't use the yaml array key as name... that is why agents have name"). The key is an
  // IDENTIFIER -- it keys warm sessions, threads and transcripts -- and conflating the two is
  // exactly how do's persona, KEYED `egpt` and NAMED `don`, stamped `🤝 egpt:` on a relayed
  // reply while stamping `don:` on a local one. Falling back to the key made that wrong answer
  // look like a right one.
  //
  // An agent with no `name` therefore renders EMPTY rather than leaking its key. That is a
  // visible gap, and the boot check below names it once at startup so it is fixed in config
  // rather than papered over here. Every agent that runs turns declares one today; the three
  // that do not (carol, cara, don on kg) are relays, which never stamp anything.
  const labelOf = (being) => {
    const a = agents()[String(being ?? '').toLowerCase()];
    return (a && typeof a === 'object' && a.name) ? String(a.name) : '';
  };
  // Named once at boot, not per turn: an agent that can take a turn (it names a `configuration`)
  // but declares no `name` will stamp blank, and silence about that is what let the key stand in.
  for (const [k, a] of Object.entries(agents())) {
    if (a && typeof a === 'object' && a.configuration && !a.name) {
      log.line?.(`[boot] agent '${k}' runs turns but declares no name: -- its replies will stamp blank. Add name: to config.yaml.`);
    }
  }
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
  // Every CONNECTION declared under `beeper:`, in declaration order — the keys whose value is a
  // BLOCK, so the `use:` selector (a bare string) is never one of them. Same predicate
  // connectionBlock (below) uses to look one up, so any name this list yields is guaranteed to
  // resolve to a block there.
  const declaredConnections = (() => {
    const b = cfg.beeper;
    if (!b || typeof b !== 'object' || Array.isArray(b)) return [];
    return Object.keys(b).filter((k) => b[k] && typeof b[k] === 'object');
  })();
  // THE NODE'S DEFAULT OUTBOUND CONNECTION — which connection an agent that names none of its own
  // SPEAKS on. THE CONNECTION NAMES CARRY THE MEANING NOW (operator 2026-09-10): *"we dropped the
  // `use:`, defaulting to primary for ingest and secondary for output when available"*, which
  // encodes his older standing rule, *"primary doesn't speak if secondary is present. simple
  // rule."* Until then this was `cfg.beeper?.use ?? null` and nothing else, so a `beeper:` block
  // that declared connections but named none of them with `use:` resolved to NOTHING and fell
  // through to the legacy beeper_token/env path — on a profile that sets neither (both live ones
  // do not) that is a bridge with no token: deaf and mute, with only the limb's own generic "NO
  // TOKEN" line to say why. Precedence, highest first:
  //
  //   (2) `beeper.use`  — BACK-COMPAT and returned VERBATIM, so a node that ships it (~/.egpt2,
  //       node kg2) is byte-identical to before, right down to a `use:` naming a block that does
  //       not exist still landing on the legacy path. An explicit operator statement also has to
  //       beat an inferred default, or the inference could never be overridden.
  //   (3) `secondary` — the mouth when it exists.
  //   (4) `primary`   — which therefore speaks only when there is no secondary.
  //   (5) the ONE connection, if exactly one is declared, WHATEVER it is named. Not a
  //       convenience: INTENT.md requires a fresh clone to work on one account with no ceremony,
  //       so a lone connection is unambiguous and must need neither a selector nor a blessed name.
  //   (6) null ⇒ the legacy beeper_token / BEEPER_ACCESS_TOKEN path, unchanged.
  //
  // (1) is the per-agent pin below, which still beats all of this. Computed ONCE: the `beeper:`
  // block cannot change while the process runs (there is no config watcher), and this is asked
  // once per being on the bridge-construction path.
  // Split out of defaultConnection so the `use:`-less answer can be NAMED — the boot line beside
  // inboundConnections below tells the operator what removing an explicit `use:` would do, and it
  // can only do that if the inferred answer is computable separately.
  const nameDerivedConnection = (() => {
    if (declaredConnections.includes('secondary')) return 'secondary';
    if (declaredConnections.includes('primary')) return 'primary';
    if (declaredConnections.length === 1) return declaredConnections[0];
    return null;
  })();
  const defaultConnection = (() => {
    const b = cfg.beeper;
    if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
    if (b.use != null) return b.use;
    return nameDerivedConnection;
  })();
  // ── THE MOUTH, PER AGENT ──────────────────────────────────────────────────────────────────
  // Per-agent Beeper CONNECTION selection (operator 2026-08-30): names which connection (a key
  // under beeper:, resolved below by tokenFor) this agent's own outbound sends ride. Same
  // resolver shape as bodyEmojiOf/labelOf/agentSignature*Of above. ABSENT ⇒ this node's default
  // connection, resolved just above.
  //
  // SPELLED `use:` NOW (operator 2026-09-10): *"agent could `use:` a configuration for it's
  // output"*. `beeper_connection` is the older spelling of the identical thing, it is in both live
  // configs and in the tests, and it stays an ALIAS — but `use:` is the name going forward, so it
  // WINS when an agent carries both: a newer explicit statement must not be overruled by a legacy
  // one it was written to replace.
  //
  // OUTPUT ONLY. This is HALF of what used to be one `connectionOf` — see inboundConnections
  // below for the other half and for why the two had to come apart. NOTHING an agent declares
  // here can move this node's ear; that is the whole point of the split.
  const outboundOf = (being) => {
    const a = agents()[String(being ?? '').toLowerCase()];
    if (!a || typeof a !== 'object') return defaultConnection;
    return a.use || a.beeper_connection || defaultConnection;
  };

  // conv-state YAML IO — default to the real file, missing = empty state.
  // Routed through conversations-state's OWN readState/writeState (was an inline
  // parse/serialize pair here): those are where the surface routing lives — a `room`'s
  // per-being `agents:` block is backed by config/rooms.yaml, every other surface by
  // config/conversations.yaml (operator 2026-08-26). This is the ONE pair every service
  // below is handed, so the decision is made once, here, and nowhere else.
  const _loadState = loadState ?? (() => readConvState(CONV_YAML_PATH));
  const _writeState = writeState ?? ((s) => writeConvState(CONV_YAML_PATH, s));

  // An entity's WHOLE config.yaml doc — the resolver picks the blocks apart, so this
  // reads the file ONCE for every concern that used to open it separately (heartbeats,
  // warm, transcription). Tolerant: absent / unreadable / malformed → {}.
  // The ROOM RUNG lives in config/rooms.yaml keyed by `<surface>/<slug>`, not in
  // the room's own folder (operator 2026-08-24). The resolver hands us the ns it
  // already computed; same one-read-per-entity contract as before.
  const readEntityConfig = async (_dir, ns) => {
    try { return (await readRoomConfig(ns)) ?? {}; } catch { return {}; }
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

  // THE roster resolver — the ONE reverse lookup over config/rooms.yaml (createMemberResolver,
  // above). TWO readers now, and deliberately the same instance of it: room-relay's fan-out asks
  // WHICH ROOMS this message tunnels into, and the identity scope below asks WHOSE INSTANCE this
  // conversation is. Both answers come off the same `roster.tunnelRooms`, so the tunnel and the
  // identity can never disagree about a membership — a group whose message re-enters room/acim is
  // by construction the same group whose turn runs on room/acim's thread (operator 2026-08-31).
  // Hoisted here, above the brainpool, only because the brainpool is constructed first; the relay
  // further down takes this same value instead of building a second one.
  const memberResolver = createMemberResolver({ resolveConvRoom });

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
  // spoken alias. Gates a voice note's whisper transcript at the START of it, never `@` — the
  // SAME rule as a bare @handle since 2026-09-09 (it used to match anywhere in the sentence,
  // which is how `perro` woke E out of "tengo un perro grande").
  const voiceWakeWords = (() => { const pa = personaAgent(); return [...new Set(voiceWakeTokens(pa.agent))]; })();
  // THE BARE-REPLY GATE'S OWN LIST (operator 2026-09-01) — wakeWords ∪ the persona's OWN
  // fallback_handle tokens (fallbackWake, router.mjs: the same fail-closed rule, so a
  // half-written declaration contributes nothing here either).
  //
  // A DIFFERENT CONSUMER, deliberately. `wakeWords` above is the MENTION vocabulary: the bridge
  // stamps atE from it BEFORE any membership guard exists to say otherwise, so widening it would
  // make this node claim a mention that belongs to the peer account's agent — resolve()'s
  // nobody-addressed fall-through would then hand that atE=true straight to the persona in exactly
  // the chats the guard REJECTED, which is the two-spines-answer-one-mention bug the whole
  // fallback vocabulary exists to prevent (router.mjs, "AND THIS IS WHY `wakeWords` IS LEFT
  // ALONE"). The bare-reply gate (src/bridges/beeper.mjs) asks a NARROWER question — the WHOLE
  // reply must be nothing but the token, and the answer is "read this message back", not "take a
  // turn" — so it can safely see the wider list.
  //
  // THE LIVE GAP: once `e` moved from kg's `handles:` to its `fallback_handle:` (2026-08-31) it
  // left wakeWords, and with it this gate — replying `e` to a voice note silently did nothing and
  // only `ekg`/`egptkg` read a note back. A persona that declares no fallback hands the two lists
  // identical, so this is a no-op everywhere else.
  const replyWakeWords = (() => {
    const pa = personaAgent();
    return [...new Set([...wakeWords, ...(fallbackWake(pa.agent)?.handles ?? [])])];
  })();
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
  // peer_nodes (operator 2026-07-09): node identities sharing THIS Beeper account (incl self).
  // Still carried for the boot return; the 👂 echo priority reads echo_priority (below), falling
  // back to peer_nodes.
  const peerNodes = Array.isArray(cfg.peer_nodes) ? cfg.peer_nodes : [];

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
  // else the legacy top-level echo_priority, else peer_nodes, else [self] (a solo node is always
  // rank 1); all lowercased so config casing never splits the order.
  const echoCfg = cfg.transcription_service?.echo ?? {};
  const echoPeers = (
    Array.isArray(echoCfg.peer_priority) ? echoCfg.peer_priority
    : Array.isArray(cfg.echo_priority) ? cfg.echo_priority
    : Array.isArray(cfg.peer_nodes) ? cfg.peer_nodes
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
    throw new Error(`boot: node_name "${node_name}" is not in the 👂 echo peer set [${echoPeers.join(', ')}] — a node that echoes must appear in transcription_service.echo.peer_priority (or the legacy echo_priority / peer_nodes), else it would never echo (${CONFIG_FILE}). Add "${node_name}" to the list, or set echo:false to opt out.`);
  }
  // Per-note HRW plan: rendezvous-hash the peer set for the note's key (the audio-hash the bridge feeds)
  // and read off this node's rank. echo:false is the hard opt-out (rank 0, never post/promote).
  const echoPlan = cfg.echo === false
    ? () => ({ rank: 0, winner: false })
    : (noteKey) => { const rank = echoRank(node_name, echoPeers, noteKey); return { rank, winner: rank === 1 }; };

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
  // Beeper token resolution — GENERALIZED (operator 2026-08-30) from the old single-connection
  // lookup (operator 2026-07-09, `beeper[beeper.use].token`) into a per-CONNECTION-NAME one, so
  // more than one Beeper account can be wired into this node — outboundOf (above) picks the name
  // per agent for OUTPUT and inboundConnections (below) picks the node's EARS; `name` may be null
  // (no beeper: block / no per-agent field / no `use`), which falls straight through to
  // back-compat. BYTE-IDENTICAL to the old resolution when called as tokenFor(cfg.beeper?.use ??
  // null).
  // A connection's ENDPOINT — its token, WHERE that Beeper Desktop is, and WHO wakes on it.
  // GENERALIZED from the token-only lookup (operator 2026-09-02) because a node now hosts TWO
  // Beeper Desktops at once: the agent's, in Session 0 under its own Windows account, and the
  // operator's, in Session 1. Beeper takes the NEXT free port when one is held, so the second
  // Desktop answers on 23374 while the first has 23373 — measured, not assumed. A connection
  // carrying only a token can therefore address exactly ONE of them. `base_url` names the
  // Desktop; `ws_url` is DERIVED from it unless given outright, so the operator sets one field.
  //
  // `owner_node` is the WAKE half of the same split, and it exists because the presence test
  // stops working: `fallback_handle`'s `unless_present` asks whether the account is IN the chat,
  // which distinguished the nodes only while ONE of them held that account. With the same
  // account live in Session 0 on BOTH nodes it is true for both, and both answer — the exact
  // double-answer the account split was built to end. A connection names its owner; every other
  // node still SENDS on it and never WAKES on it. ABSENT ⇒ every node wakes, today's behaviour,
  // so a node that declares no owner anywhere is byte-identical to before.
  const wsFromBase = (base) => {
    if (!base) return undefined;
    // Same host/port, ws(s) scheme, the bridge's own /v1/ws path — the one place that mapping
    // is written, so base_url alone is a complete answer. Unparseable ⇒ undefined, which falls
    // through to startBeeperBridge's default rather than inventing a wrong URL.
    try { const u = new URL(base); u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'; u.pathname = '/v1/ws'; u.search = ''; u.hash = ''; return u.toString(); }
    catch { return undefined; }
  };
  // ── THE PORT IS NOT AN IDENTITY (operator 2026-09-07, after a 90-minute deaf window) ──────
  // Beeper Desktop's local API binds the FIRST FREE PORT starting at 23373, so which install
  // holds which port follows START ORDER, not identity. On a machine running several installs
  // (three Session 0 services plus the Session 1 GUI here) the numbering RESHUFFLES whenever
  // they come back in a different order — measured three times in one evening, with 23373
  // moving from one install to another inside the hour. A pinned base_url is therefore a guess
  // with a shelf life: on 2026-09-06 it named the wrong install, every request 401'd, the bridge
  // redialled every 60s, and this node was DEAF FOR ~90 MINUTES with nothing in the log naming
  // the cause — a 401 is indistinguishable from "you are talking to the wrong install".
  //
  // A TOKEN, THOUGH, BELONGS TO AN INSTALL, not to an account: only the install a token was
  // minted on answers 200, and every other install answers 401. So the token already IS the
  // address, and the port can simply be LOOKED UP — probe the range with the token and the 401s
  // do the work. That is what makes ACCOUNT + TOKEN a complete connection, with no port in the
  // config at all:
  //
  //   main:
  //     account: you@example.com
  //     token: bdapi_…
  //
  // `base_url` stays an OPTIONAL OVERRIDE for a Desktop on a non-default host or port, and
  // setting it SKIPS discovery entirely — a connection that pins one behaves exactly as before.
  //
  // DEPRECATED, still read: `endpoints:` — several (base_url, token) candidates for ONE
  // connection, tried IN ORDER, first 200 wins (operator 2026-09-03, for the Session 0 Desktop
  // that FLIPS IDENTITY at logon). Discovery answers that case without a port list at all, and
  // both live profiles' lists repeat ONE token across four ports, so each collapses to plain
  // account+token — but they still carry `endpoints:` today, so this branch stays until they
  // are migrated. `owner_node` is NOT per-candidate: a connection has ONE owner regardless of
  // which install answers, so it sits on the connection beside `account`.
  const candidatesOf = (acct) => (Array.isArray(acct?.endpoints) && acct.endpoints.length ? acct.endpoints : null);
  const connectionBlock = (name) => {
    const b = cfg.beeper;
    return name && b && typeof b === 'object' && b[name] && typeof b[name] === 'object' ? b[name] : null;
  };
  // One candidate (or the connection block itself, which is the SAME shape minus `endpoints`)
  // read as an endpoint. `owner_node` is taken from the CONNECTION, never from the candidate.
  const endpointOf = (src, acct) => {
    const baseUrl = src?.base_url ?? undefined;
    return {
      token: src?.token ?? cfg.beeper_token ?? process.env.BEEPER_ACCESS_TOKEN,
      baseUrl,
      wsUrl: src?.ws_url ?? wsFromBase(baseUrl),
      ownerNode: acct?.owner_node ?? null,
    };
  };
  // Filled by the resolution pass immediately below, BEFORE anything asks for an endpoint. It
  // stays EMPTY on every node that declares no `endpoints:`, which is every node today — so
  // endpointFor remains the pure, synchronous, network-free lookup it has always been and every
  // consumer downstream (endpointKey, wakesOn, bridgeForEndpoint, rawBridgeOf, the shell-aware
  // map) keeps calling it unchanged. That is also why this is a resolve-once cache rather than an
  // async endpointFor: those consumers are synchronous per-being lookups on the hot path.
  const resolvedByConnection = new Map();
  const endpointFor = (name) => {
    if (resolvedByConnection.has(name)) return resolvedByConnection.get(name);
    const acct = connectionBlock(name);
    // Candidates not yet resolved (or none declared) ⇒ the FIRST candidate, so this is never
    // endpoint-less and a plain base_url/token connection is byte-identical to before.
    return endpointOf(candidatesOf(acct)?.[0] ?? acct, acct);
  };
  // The token ALONE, for callers that only need the identity and not the address.
  const tokenFor = (name) => endpointFor(name).token;

  // ── THE EAR, PER NODE (operator 2026-09-10) ───────────────────────────────────────────────
  // *"do not use `use:`, instead `primary` is the one to 'use' and `secondary` is the one to use
  // as output"*. INGEST and OUTPUT are two different answers, and until now ONE binding gave
  // both: boot dialled a bridge per connection an agent SPEAKS on, and router.mjs's connection
  // gate compared an arrival against that same speaking binding. So the moment the default output
  // became `secondary` (60ff004 — the connection names carry the meaning), this node stopped
  // dialling `primary` at all and went DEAF on the operator's own account, the Self-DM command
  // channel included. The live config has been carrying a hand-added `use: primary`, marked
  // TEMPORARY, for no reason other than to hold that ear open.
  //
  // TWO MEASURED FACTS this rule is shaped around, both on the operator's own machine:
  //   · `primary` and `primary_gui` are the SAME ACCOUNT (anrodz42) on two different Beeper
  //     installs, so they carry two DIFFERENT tokens and nothing downstream collapses them.
  //     Dialling both as ears would ingest every message on that account TWICE.
  //   · `~/.egpt`'s `secondary` token is BYTE-IDENTICAL to `~/.egpt2`'s `main` token — one
  //     install, held by two nodes. If kg both heard and spoke there, kg and kg2 would both wake
  //     on it and double-answer wherever An's number is absent.
  //
  // PRECEDENCE, highest first. This is a NODE-level answer and no agent can move it (an agent's
  // `use:` is its MOUTH, above) — which is exactly what makes the two directions independent.
  //
  //   (1) every connection whose `owner_node` names THIS node — the EXPLICIT claim, made with
  //       the key that already asks this question ("which node WAKES on this connection"; every
  //       other node still SENDS on it). SEVERAL may be claimed: that is how a node deliberately
  //       holds two ears, and holding two has to be SAID rather than inferred, because the cost
  //       of inferring it wrongly is one typed line answered twice from two visible numbers.
  //   (2) `primary` — the operator's rule, and the reason this split exists at all.
  //   (3) the ONE connection, if exactly one is declared, whatever it is named. INTENT.md's
  //       baseline: a fresh clone on one account needs no naming convention and no selector.
  //   (4) the node's DEFAULT OUTPUT connection — BACK-COMPAT, and the old coupling in its last
  //       honest form: before this split the ear always followed the mouth, so where the names
  //       give no answer it still does and a node that worked yesterday works today. This is the
  //       branch that carries `beeper: { use: main, main: …, alt: … }`.
  //   (5) nothing — said OUT LOUD below, because a node that hears nothing looks exactly like a
  //       quiet day from the outside.
  //
  // EXCLUDED FROM EVERY BRANCH:
  //   · `primary_gui`, BY NAME. It is the operator's own Beeper WINDOW — a second install of an
  //     account another connection already is. A node ingesting through the operator's GUI is
  //     never what was meant, and a config that does want that install as the ear can call it
  //     `primary`. The general form of this rule is the account/token dedup below; the name rule
  //     exists because the two installs carry different TOKENS, so the dedup alone cannot see
  //     that they are one account when `account:` is absent.
  //   · a connection whose `owner_node` names ANOTHER node. Already true at bridge construction
  //     (wakesOn, below, wraps such a bridge outbound-only); applied HERE too so the ear list
  //     never claims something the bridge will refuse to listen on, and so "this node has no ear"
  //     is computable before a single bridge exists.
  //   · a connection whose ACCOUNT, or whose TOKEN, already belongs to a claimed ear.
  //     Declaration order decides, matching the bridge map's own first-name-wins collapse.
  const INGEST_NEVER_BY_NAME = new Set(['primary_gui']);
  const isOwnNode = (owner) => !owner || ownNodeNamesOf(cfg).has(String(owner).trim().toLowerCase());
  const inboundConnections = (() => {
    // No `beeper:` connections at all ⇒ the ONE unnamed legacy bridge (beeper_token /
    // BEEPER_ACCESS_TOKEN) is the ear, exactly as it always was. `null` is the same name every
    // other resolver in this file already uses for it, so nothing downstream learns a special case.
    if (!declaredConnections.length) return [null];
    const claimed = declaredConnections.filter((n) => connectionBlock(n)?.owner_node && isOwnNode(connectionBlock(n).owner_node));
    const pool = claimed.length ? claimed
      : declaredConnections.includes('primary') ? ['primary']
      : declaredConnections.length === 1 ? declaredConnections
      : connectionBlock(defaultConnection) ? [defaultConnection]
      : [];
    const seenAccount = new Set();
    const seenToken = new Set();
    const ears = [];
    for (const n of pool) {
      const acct = connectionBlock(n);
      if (INGEST_NEVER_BY_NAME.has(n)) {
        // Never silent: a config that put this connection in the pool asked for something it is
        // not going to get, and the remedy is one word.
        log.line?.(`[bridge] connection '${n}' is NEVER an ear — that name means the operator's own Beeper window, a second install of an account another connection already is, and ingesting there would hear every message twice. It is still dialled if an agent speaks on it. To make this install the ear, name it 'primary'.`);
        continue;
      }
      if (!isOwnNode(acct?.owner_node)) continue;
      const account = String(acct?.account ?? '').trim().toLowerCase();
      const token = String(endpointFor(n).token ?? '');
      if ((account && seenAccount.has(account)) || (token && seenToken.has(token))) {
        log.line?.(`[bridge] connection '${n}' is the same Beeper account as an ear this node already claimed — dialling it as a second ear would hear every message twice, so it is held for outbound only`);
        continue;
      }
      if (account) seenAccount.add(account);
      if (token) seenToken.add(token);
      ears.push(n);
    }
    return ears;
  })();
  // HALF-ALIVE IS WORSE THAN DOWN (INTENT.md). A node with no ear hears NOTHING and looks from
  // the outside exactly like a node nobody happened to address. It BOOTS anyway — for the same
  // reason the dead-endpoint fallback below does: refusing to start would take the node down over
  // a config the operator can fix while it is running — but it says so, once, naming what it
  // looked for and the two ways to answer it.
  if (declaredConnections.length && !inboundConnections.length) {
    log.line?.(`[bridge] beeper: declares ${declaredConnections.map((n) => `'${n}'`).join(', ')} but this node resolves no INGEST connection — nothing survives the ear rules (owner_node naming this node, then 'primary', then a lone connection, then the default output connection). THIS NODE HEARS NOTHING: every bridge it opens is outbound-only. Name one connection 'primary', or put owner_node: ${node_name || '<this node>'} on the one this node should wake on.`);
  }
  // `beeper.use` IS NOW A THIRD OF WHAT IT WAS. (2026-09-10) it stopped deciding the ear, which is
  // resolved above and which no `use:` — node-level or per-agent — can move. (2026-09-11) it
  // stopped deciding where an outbound actually goes: it names this node's DEFAULT MOUTH, and the
  // mouth speaks only where it can REACH the chat (outboundConnectionFor, below); a chat on
  // another Beeper account is answered on the connection that holds it, node-level announces
  // included. What is left is an OPTIONAL override of the name-derived default, and it stays
  // supported precisely as an override (~/.egpt-secondary carries `use: primary`).
  //
  // Said out loud ONLY when it is actually overriding the name-derived answer, because that is the
  // only case where removing the key would change anything at all — and the line has to be honest
  // about how little that now is, or an operator reads it as "removing this moves my traffic to a
  // Desktop that has never seen these chats", which was true yesterday and is not true today.
  // Silent on a lone-connection node, which resolves to the same answer with the key or without it.
  if (cfg.beeper?.use != null && nameDerivedConnection && nameDerivedConnection !== cfg.beeper.use) {
    log.line?.(`[bridge] beeper.use names '${cfg.beeper.use}' — it selects this node's DEFAULT MOUTH and nothing else: ingest (${inboundConnections.map((n) => `'${n}'`).join(', ') || 'NOTHING'}) is decided without it, and so is any chat that mouth cannot reach. Remove it and the default mouth becomes '${nameDerivedConnection}', this node hears on exactly the same connection it hears on now, and every chat only ${inboundConnections.map((n) => `'${n}'`).join(' / ') || 'the ear'} can reach — the Self-DM included — is still answered there.`);
  }
  // The per-agent half of the ear, and the ONLY thing the router's connection gate asks. An agent
  // does not CHOOSE its ear — the node does — but on a node holding SEVERAL ears the gate still
  // has to decide which arrival wakes it, or one line typed into a chat both accounts are in
  // wakes it twice, from two visibly different numbers (the live bug tests/multi-connection-wake
  // exists for). The rule is the OLD coupling, kept precisely where it is still the only answer
  // available: if the agent's MOUTH is itself one of this node's ears, that is its ear; otherwise
  // the node's first ear. On a one-ear node — every node the operator runs — it is that one ear
  // for everybody, and the gate is inert anyway (the fan-out stamps no connection).
  const inboundOf = (being) => {
    const mouth = outboundOf(being);
    return inboundConnections.includes(mouth) ? mouth : (inboundConnections[0] ?? null);
  };

  // THE RANGE. 23373 is Beeper's documented base and it walks UP to the first free port, so the
  // highest an install can be pushed to is that base plus however many listeners already squat
  // the range — six on this machine (four Beeper installs, plus the egpt shell/console on 23375
  // and 23377, which answer HTTP 426 and are simply not a match). Ten leaves that much headroom
  // again and costs nothing to widen: the scan is CONCURRENT, so the whole range is ONE timeout,
  // and a full sweep of these ten measured 48ms live (three 401s, two 426s, five ECONNREFUSED —
  // a loopback refusal comes back in ~10ms).
  const DISCOVERY_PORTS = Array.from({ length: 10 }, (_, i) => 23373 + i);
  // ~15x the slowest answer measured (46ms), so a Desktop under load still answers in time, and
  // it bounds the WHOLE scan rather than each port, because they run together. Boot never
  // stalls: a black-holed port costs 750ms once, not 750ms per port.
  const DISCOVERY_TIMEOUT_MS = 750;

  // WHERE IS THE INSTALL THIS TOKEN WAS MINTED ON? Every port at once, then the LOWEST that
  // answered 200 — deterministic, where "whichever replied first" would not be. 401, HTTP 426
  // and ECONNREFUSED are all the same answer here (not a match), which is why a non-Beeper
  // listener inside the range is not an error. Returns a base_url or null; it never throws, and
  // it never logs a token VALUE — length only, because a token in a log is a token in a paste.
  const discoverBaseUrl = async (name, token) => {
    const urls = DISCOVERY_PORTS.map((p) => `http://127.0.0.1:${p}`);
    const results = await Promise.all(urls.map(async (url) => {
      try { return { url, r: await probeEndpointFn(url, token, { timeoutMs: DISCOVERY_TIMEOUT_MS }) }; }
      catch (e) { return { url, r: { ok: false, status: 0, error: e?.message ?? String(e) } }; }
    }));
    const hits = results.filter(({ r }) => r?.ok);   // Promise.all preserves ORDER ⇒ hits[0] is the lowest port
    if (!hits.length) {
      log.line?.(`[bridge] connection '${name}': NO install on 127.0.0.1:${DISCOVERY_PORTS[0]}-${DISCOVERY_PORTS[DISCOVERY_PORTS.length - 1]} answers this connection's token (${String(token).length} chars) — the install it was minted on is not running, or the token was revoked. Falling back to the bridge default; every reconnect asks again.`);
      return null;
    }
    // Cannot happen while a token belongs to exactly ONE install — so if it does, the assumption
    // this whole mechanism rests on is wrong and the operator has to SEE that, not catch an
    // exception. Take the lowest and say out loud that it happened.
    if (hits.length > 1) log.line?.(`[bridge] connection '${name}': ${hits.length} installs answered 200 to the SAME token (${hits.map((h) => h.url).join(', ')}) — a token is supposed to belong to exactly one install; taking the lowest port`);
    log.line?.(`[bridge] connection '${name}' → ${hits[0].url} — 200, this install answers to this connection's token`);
    return hits[0].url;
  };

  // NOTHING RESOLVED, SAID OUT LOUD. A `beeper:` block that declares connections but selects none
  // of them leaves this node on the legacy beeper_token / BEEPER_ACCESS_TOKEN path — which the
  // live profiles do not set, so the bridge comes up INERT: it hears nothing, says nothing, and
  // the only word about it is the limb's own "NO TOKEN" line, which names env vars rather than the
  // config that actually decided it. Half-alive is worse than down (INTENT.md), so the reason is
  // named here, once, before the first bridge is built. It BOOTS anyway, for the same reason the
  // dead-endpoint fallback below does: refusing to start would take the node down over a config
  // the operator can fix while it is running.
  if ((declaredConnections.length || cfg.beeper?.use != null) && !connectionBlock(defaultConnection)) {
    log.line?.(cfg.beeper?.use != null
      ? `[bridge] beeper.use names '${cfg.beeper.use}' but there is no '${cfg.beeper.use}:' block under beeper: — NO connection resolved, so this node has no outbound of its own; falling back to beeper_token / BEEPER_ACCESS_TOKEN, and the bridge is inert if neither is set`
      : `[bridge] beeper: declares ${declaredConnections.map((n) => `'${n}'`).join(', ')} but none is named 'secondary' or 'primary' and no 'use:' picks one — NO connection resolved, so this node has no outbound of its own; falling back to beeper_token / BEEPER_ACCESS_TOKEN, and the bridge is inert if neither is set`);
  }

  // THE OBSERVATION. Runs ONCE per connection an agent actually rides, here, before any endpoint
  // is asked for.
  //
  // 401 IS A POSITIVE RESULT, not an error: a token belongs to one install, so a 401 PROVES a
  // different install is serving that port — exactly the reading src/tools/beeper-whoami.mjs was
  // written for. The winning port is logged because that line is the operator's proof of which
  // install this node is bound to; without it he has to run a tool to find out.
  //
  // NOTHING alive ⇒ the endpoint we already had, loudly. Booting against a dead endpoint is
  // already what a misconfigured node does; refusing to boot would take the whole node down
  // because Beeper was merely slow to start.
  // EARS FIRST, then every connection an agent SPEAKS on — the same union the bridge loop below
  // dials, so every endpoint this node will hold is probed exactly once and none is probed that
  // it will not hold. Before the ingest/output split this was the speaking set alone, which is
  // why a `primary` nobody spoke on was never even looked for.
  for (const name of new Set([...inboundConnections, ...Object.keys(agents()).map((being) => outboundOf(being))])) {
    const acct = connectionBlock(name);
    const candidates = candidatesOf(acct);
    if (candidates) {
      log.line?.(`[bridge] connection '${name}' declares endpoints: — DEPRECATED, replace the whole list with the account + token it repeats and the port is discovered`);
      let won = null;
      for (const c of candidates) {
        const ep = endpointOf(c, acct);
        const r = await probeEndpointFn(ep.baseUrl, ep.token, { timeoutMs: 2000 });
        if (r?.ok) {
          log.line?.(`[bridge] connection '${name}' → ${ep.baseUrl} — 200, this install answers to this candidate's token`);
          won = ep;
          break;
        }
        if (r?.status === 401) log.line?.(`[bridge] connection '${name}': ${ep.baseUrl} answered 401 — a DIFFERENT install is serving that port, trying the next candidate`);
        else log.line?.(`[bridge] connection '${name}': ${ep.baseUrl} did not answer (${r?.status || r?.error || 'nothing there'}) — trying the next candidate`);
      }
      if (!won) {
        won = endpointOf(candidates[0], acct);
        log.line?.(`[bridge] no live endpoint for connection '${name}' — falling back to ${won.baseUrl}`);
      }
      resolvedByConnection.set(name, won);
      continue;
    }
    // DISCOVERY, for the shape the skeleton ships. Only a NAMED connection block discovers: the
    // legacy top-level beeper_token / BEEPER_ACCESS_TOKEN fallback has always meant "the bridge
    // default" and keeps meaning exactly that.
    if (!acct) continue;
    const ep = endpointOf(acct, acct);
    if (ep.baseUrl || !ep.token) continue;   // pinned ⇒ no discovery, byte-identical to before; tokenless ⇒ nothing to ask with
    // THE SAME LOOKUP, HANDED TO THE BRIDGE. The install can move while this node is running —
    // that IS the failure — and the moment it moves is the moment the socket drops, so the
    // bridge's existing redial (src/bridges/beeper.mjs, the WS 'close' handler backing off
    // 3s→60s) asks this again before it dials. No second reconnect path, and a pinned connection
    // hands over no rediscover at all, so its redial is unchanged.
    const rediscover = async () => {
      const url = await discoverBaseUrl(name, ep.token);
      return url ? { baseUrl: url, wsUrl: ep.wsUrl ?? wsFromBase(url) } : null;
    };
    const found = await discoverBaseUrl(name, ep.token);
    resolvedByConnection.set(name, { ...ep, ...(found ? { baseUrl: found, wsUrl: ep.wsUrl ?? wsFromBase(found) } : {}), rediscover });
  }

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

  // Bridge construction — one instance per DISTINCT RESOLVED TOKEN, not per connection NAME
  // (operator 2026-08-30): dedup by the token VALUE is what collapses "no second connection
  // declared anywhere" to exactly one instance, byte-identical to before, with no special-casing
  // for the back-compat shape (beeper_token/env, or a beeper: block with no per-agent field).
  // Every option below is NODE-LEVEL and shared across every connection — ONLY beeperToken
  // legitimately varies per instance (userName, media, transcribe*, wakeWords, … are one node's
  // settings, not one account's).
  const sharedBridgeOpts = {
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
    replyWakeWords,                       // …∪ the persona's fallback_handle tokens — the BARE-REPLY gate's vocabulary ONLY, never the mention path's (operator 2026-09-01; see the computation above)
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
  };
  // Bridge instances, keyed by ENDPOINT — the (base_url, token) pair, not the token alone
  // (operator 2026-09-02). The token was a sufficient key only while every connection reached
  // the SAME Beeper Desktop; two Desktops on one node are two different addresses, and keying
  // by token would collapse them into one bridge pointed at whichever was built first. A node
  // that declares no base_url anywhere keys on ('' , token) and still collapses to exactly one
  // instance, byte-identical to before.
  const bridgeByEndpoint = new Map();
  // …of which THESE are the ones this node WAKES on. An outbound-only connection cannot deliver a
  // message here at all, so it can never be half of a double answer — which is why the warning
  // below counts this set and not bridgeByEndpoint.
  const inboundOwned = new Set();
  // JSON, not a delimiter character. The obvious separator (NUL) puts a literal 0x00 in this
  // file, which makes ripgrep treat the whole thing as binary and silently truncate every
  // future audit of it — tests/integrity.test.mjs exists for exactly that failure. A two-
  // element array is unambiguous and needs no such reasoning.
  const endpointKey = (ep) => JSON.stringify([ep.baseUrl ?? '', ep.token ?? '']);
  // OWNERSHIP, decided HERE and nowhere else, so no call site downstream has to remember it.
  // A connection this node does not own is OUTBOUND-ONLY: it still sends, and its three inbound
  // registrations become no-ops, so nothing this node can do will wake on it. Same Proxy shape
  // lasso.wrap uses — the bridge's whole surface passes through untouched except those three.
  const wakesOn = (ep) => !ep.ownerNode || ownNodeNamesOf(cfg).has(String(ep.ownerNode).trim().toLowerCase());
  const outboundOnly = (port) => new Proxy(port, {
    get: (t, k) => ((k === 'onMessage' || k === 'onEdit' || k === 'onMedia') ? (() => {}) : Reflect.get(t, k, t)),
  });
  // ── AN EAR REMEMBERS WHAT IT HEARD (operator 2026-09-11) ──────────────────────────────────
  // *"inter-spine messaging chat-group matching is first done by name and members. if rodz is not
  // in, reply flows back from primary."* A reply the peer mouth cannot place must go back out on
  // the connection the message ARRIVED on — and that is a hard requirement, not a preference about
  // voices: one real chat is a DIFFERENT Matrix room per Beeper account (beeper.crossAccountChatKey's
  // header, measured live), so a chatId heard on `primary` names a room the `secondary` install is
  // not in. Posting it there is a room that does not exist, and it is exactly what removing kg's
  // TEMPORARY `beeper: { use: primary }` exposes: the names alone resolve OUTPUT to `secondary`
  // while INGEST stays on `primary`.
  //
  // WHERE THE FACT IS TAKEN, and why it is not re-derived. bridge-fanout already stamps
  // `from.connection` on every arrival — the one registration that still has the delivering bridge
  // in hand — but that stamp lives on the EVENT, and the reply path is handed a chatId and nothing
  // else (sender.open). So the SAME stamp is read here and kept per CHAT, which is the granularity
  // the reply actually needs: a chatId belongs to exactly one account, permanently.
  //
  // BOUNDED, FIFO, NEVER PERSISTED, and honest about all three: an evicted or never-heard chat
  // reads as UNKNOWN and the being's own outbound connection answers, which is precisely today's
  // behaviour. A fresh boot knows nothing until the first arrival — and a reply always follows one.
  const ARRIVAL_MAX = 500;
  const arrivalConnection = new Map();   // chatId -> the CONNECTION NAME the arrival was stamped with
  const rememberArrival = (chatId, name) => {
    const c = String(chatId ?? '');
    if (!c || !name) return;
    if (arrivalConnection.has(c)) arrivalConnection.delete(c);                                          // …re-insert so the busiest chats are the last evicted
    else if (arrivalConnection.size >= ARRIVAL_MAX) arrivalConnection.delete(arrivalConnection.keys().next().value);
    arrivalConnection.set(c, name);
  };
  // The recorder itself, over the FAN-OUT FACADE and never over a bare bridge — which is what
  // keeps a single-connection node not merely equivalent but IDENTICAL (bridge-fanout's own
  // promise, locked in tests/single-account-node.test.mjs). It is applied below only where the
  // facade actually exists, i.e. only where there is more than one connection to choose between;
  // with one, there is nothing to remember and nothing is wrapped. Same Proxy shape outboundOnly
  // uses, and its mirror image: that one takes the three inbound registrations AWAY, this one lets
  // onMessage through and notes what came past it.
  const remembering = (facade) => new Proxy(facade, {
    get: (t, k) => (k === 'onMessage'
      ? (cb) => Reflect.get(t, k, t)((msg) => { rememberArrival(msg?.from?.chatId, msg?.from?.connection); return cb(msg); })
      : Reflect.get(t, k, t)),
  });
  // `ear` (operator 2026-09-10) is the INGEST half of the binding, decided by inboundConnections
  // above and passed in rather than re-derived: a bridge is cached by ENDPOINT, so this decision
  // is made ONCE per endpoint and the dial loop below is what guarantees the ear asks first.
  // Everything else this node holds is a MOUTH — it sends and its three inbound registrations are
  // no-ops, the same shape `owner_node` already produced.
  const bridgeForEndpoint = async (ep, { ear = false, name = null } = {}) => {
    const key = endpointKey(ep);
    if (!bridgeByEndpoint.has(key)) {
      // baseUrl/wsUrl are spread in ONLY when set: absent must leave startBeeperBridge's own
      // defaults standing, never an explicit undefined that would override them.
      const opts = { ...sharedBridgeOpts, beeperToken: ep.token, ...(ep.baseUrl ? { baseUrl: ep.baseUrl } : {}), ...(ep.wsUrl ? { wsUrl: ep.wsUrl } : {}), ...(ep.rediscover ? { rediscover: ep.rediscover } : {}) };
      const port = lasso.wrap(await createBeeperBridgePort(opts, startBridge ? { start: startBridge } : {}));
      const owned = ear && wakesOn(ep);
      // Named at the ONE moment it is decided. Silent on a single-connection node, because there
      // the sole connection is the ear and this branch is never taken. The owner_node wording is
      // the line that has always been printed for that case and is left exactly as it was — it
      // says something more specific than "not an ear": another node IS the ear.
      if (!owned) log.line?.(!wakesOn(ep)
        ? `[bridge] connection is owned by node '${ep.ownerNode}' — this node sends on it, never wakes on it`
        : `[bridge] connection ${name ? `'${name}' ` : ''}is a MOUTH on this node, not an ear — it sends, and nothing arriving on it can wake anything`);
      if (owned) inboundOwned.add(key);
      bridgeByEndpoint.set(key, owned ? port : outboundOnly(port));
    }
    return bridgeByEndpoint.get(key);
  };
  // Construct exactly one bridge per ENDPOINT this node actually holds — the EARS it wakes on,
  // and every connection an agent SPEAKS on. On a node where no agent names a `use:` and the ear
  // is the mouth (every single-account node, and kg while it still carries `use: primary`) all of
  // these resolve to the SAME endpoint, so this constructs exactly one bridge, exactly as before.
  // defaultKey is always among agents() (personaAgent(), above, guarantees it).
  // …and remember WHICH CONNECTION each bridge was dialled for (operator 2026-09-08). The bridge
  // map is keyed by ENDPOINT (base_url + TOKEN) precisely so two connection names pointing at one
  // Desktop collapse to one instance — which also means the endpoint key cannot serve as the
  // connection's name downstream, and it carries a token, which must never reach an event or a
  // log. FIRST name wins, matching the collapse: two names on one endpoint are one ear.
  const connectionOfBridge = new Map();   // bridge instance -> the CONNECTION NAME it was dialled for
  // EARS FIRST, and the ordering is load-bearing twice over: bridgeForEndpoint decides
  // outbound-only ONCE per endpoint, and connectionOfBridge's first-name-wins must stamp an
  // arrival with the EAR's name rather than an outbound alias that happens to share the endpoint.
  // This loop is also the whole reason a declared `primary` no agent speaks on is now DIALLED —
  // before the split, an unspoken-on connection was never opened and therefore never heard.
  for (const name of inboundConnections) {
    const b = await bridgeForEndpoint(endpointFor(name), { ear: true, name });
    if (!connectionOfBridge.has(b)) connectionOfBridge.set(b, name);
  }
  // …then the MOUTHS. Each adds a bridge only if its endpoint is not already open.
  for (const being of Object.keys(agents())) {
    const name = outboundOf(being);
    const b = await bridgeForEndpoint(endpointFor(name), { ear: false, name });
    if (!connectionOfBridge.has(b)) connectionOfBridge.set(b, name);
  }
  const defaultBridge = bridgeByEndpoint.get(endpointKey(endpointFor(outboundOf(defaultKey))));   // the default/persona connection's bridge — this node's DEFAULT MOUTH, and what outboundConnectionFor(null, …) resolves to whenever that mouth can reach the chat
  // INBOUND ON EVERY CONNECTION (operator 2026-09-02), closing the gap the multi-connection work
  // left open: outbound has been per-connection since 2026-08-30, but the spine registered
  // onMessage/onEdit/onMedia on the DEFAULT bridge alone, so a message arriving on any other
  // connection woke nothing. With two Beeper Desktops on one machine that is the difference
  // between "E hears on Rodz and replies as Rodz, locally" and a cross-node relay round trip.
  //
  // Outbound is untouched — the facade delegates everything that is not an inbound registration
  // to defaultBridge — and a node with ONE connection gets that bridge back identically, not a
  // wrapper. See bridge-fanout.mjs for why wasSentByUs must ask every connection (it is the echo
  // gate, and it is per-ACCOUNT) and why nothing here deduplicates.
  // …and WHICH CONNECTION HEARD WHICH CHAT is read off that same stamp (rememberArrival, above),
  // so a reply the peer mouth cannot place goes back out the ear it came in on. Only where there
  // is a choice: with one connection the facade IS the bridge and nothing wraps it.
  const fanned = fanoutInbound(defaultBridge, [...bridgeByEndpoint.values()], connectionOfBridge);
  const bridge = bridgeByEndpoint.size > 1 ? remembering(fanned) : fanned;
  // ── WHICH CONNECTION AN OUTBOUND INTO *THIS CHAT* RIDES (operator 2026-09-11) ─────────────
  // *"self doesn't have mouth. if mouth is available always use mouth."* ONE rule for every
  // outbound this node places, with no exception for the node's own announces: the being's mouth
  // (outboundOf) speaks whenever it CAN REACH the chat; when it cannot, the connection the chat
  // actually LIVES ON does. The reachability test is not a guess: a chatId is a Matrix room on an
  // ACCOUNT, so two connection names declaring the same `account:` see the same rooms under the
  // same ids (the operator's `primary` and `primary_gui` — one account, two Desktop installs —
  // which is exactly why the ear dedup above refuses to claim both), while a DIFFERENT account
  // cannot address the chat at all: posting there is not the wrong voice, it is a room that does
  // not exist.
  //
  // FAIL TOWARD THE CHAT'S OWN CONNECTION. Not provably the same account (either side undeclared)
  // ⇒ the chat's connection wins, because that one is guaranteed to reach it and the mouth is not.
  //
  // A NODE-LEVEL SEND ASKS THE SAME QUESTION and gets it the same way — it carries no being, so
  // outboundOf hands back this node's DEFAULT mouth and the rest of the rule runs unchanged. There
  // is no second path and no special case for it; see goDown / the boot announce / the STOP
  // confirmation below, which pass `null` where a reply passes a being.
  //
  // AND THE MOUTH IS STILL THE MOUTH. An agent's `use:` still names it, still decides which
  // bridges are dialled, and is still what the peer mouth is offered against — the peer link is
  // how a reply reaches the OTHER account's view of a chat (by name and members,
  // src/shell/peer-mouth.mjs), and it is untouched by this.
  const accountOf = (name) => String(connectionBlock(name)?.account ?? '').trim().toLowerCase();
  const reachesTheSameChats = (a, b) => a === b || (!!accountOf(a) && accountOf(a) === accountOf(b));
  // WHICH CONNECTION A CHAT LIVES ON — THREE SOURCES FOR ONE FACT, none of them a guess:
  //   · the ARRIVAL stamp (rememberArrival, above): a chat this node HEARD is a room on the
  //     connection that heard it, permanently — a chatId belongs to exactly one account.
  //   · THE SELF CHAT (selfChatId, above — `networks.<surface>.chat_ids[0]`), declared in this
  //     node's OWN config as the operator command channel. A command channel is by definition a
  //     chat this node HEARS, so that id was minted by the install this node's EAR is: it is a
  //     room on the ear whether or not anything has arrived yet.
  //   · THE ADVICE CHANNEL (`advice_channel`, config/config-schema.mjs), declared in this node's
  //     own config as the chat E's /ask posts to AND the operator answers in (operator
  //     2026-09-11). The same kind of fact as the Self chat, and true for a sharper reason:
  //     src/spine/advice.mjs routes the answer home by matching the operator's quote-reply
  //     against the message id postStatus handed back, and an inbound only ever arrives on an EAR
  //     (every other connection boot opens is outbound-only, its onMessage a no-op). An ask
  //     posted anywhere else is unanswerable by construction — the ids belong to another account,
  //     in another Matrix room. It is matched AS CONFIGURED, because the schema allows a chat
  //     NAME as well as a raw room id and a name is not something the arrival map could ever
  //     hold: the declaration is the only thing that can answer for that form.
  // The second source is what makes the BOOT ANNOUNCE resolvable. It fires before the first
  // message of the process, so the arrival map is necessarily empty and no fallback that waits for
  // an arrival could ever fire for it — but reachability is answered from the account a connection
  // DECLARES, not from history, so nothing has to have happened yet.
  // Several ears ⇒ the first, the same tie-break inboundOf makes. A legacy node whose one ear is
  // the unnamed `null` connection reads as UNKNOWN here and answers with its mouth, which is that
  // same single bridge.
  //
  // ANYTHING ELSE IS UNKNOWN and the mouth answers, exactly as before: a synthesized turn, a
  // heartbeat, the shell surface, a chat only the mouth's account is in (a mouth-only connection
  // is deaf, so its chats never reach the arrival map and must not be dragged onto the ear).

  // The declared advice channel, read the SAME way src/spine/advice.mjs reads it (getConfig() →
  // `advice_channel`, trimmed, empty ⇒ unset) so the two can never disagree about what the
  // channel IS while agreeing about where it lives.
  const adviceChannelDeclared = () => { const c = getConfig()?.advice_channel; const s = c == null ? '' : String(c).trim(); return s || null; };
  // …and it hands back the PROVENANCE with the name, because the log line below has to say which
  // of the three facts answered — one is measured and two are read off the config, and an
  // operator chasing a line that came out of an unpinned account needs to know which.
  const connectionHolding = (chatId) => {
    const c = String(chatId ?? '');
    if (!c) return null;
    const heard = arrivalConnection.get(c);
    if (heard != null) return { name: heard, why: 'it arrived there' };
    const ear = inboundConnections[0] ?? null;
    const self = selfChatId();
    if (self && shortChatId(c) === shortChatId(self)) return { name: ear, why: `it is this node's Self chat, declared in config, and '${ear}' is the ear` };
    const advice = adviceChannelDeclared();
    if (advice && shortChatId(c) === shortChatId(advice)) return { name: ear, why: `it is this node's advice channel, declared in config, and '${ear}' is the ear` };
    return null;
  };
  const toldAboutHome = new Set();
  const outboundConnectionFor = (being, chatId) => {
    const mouth = outboundOf(being);
    const holder = connectionHolding(chatId);
    const home = holder?.name ?? null;
    if (home == null || reachesTheSameChats(home, mouth)) return mouth;
    // Never silent: an operator reading a line that came out of an account they did not pin has
    // to be able to find out why — and WHICH of the three facts above answered it, because one is
    // measured and the other two are read off the config. Once per chat: this fires on every
    // frame otherwise.
    const told = `${chatId}→${mouth}`;
    if (!toldAboutHome.has(told)) {
      if (toldAboutHome.size >= ARRIVAL_MAX) toldAboutHome.clear();
      toldAboutHome.add(told);
      log.line?.(`[bridge] ${shortChatId(chatId)} is a chat on '${home}' (${holder.why}) and '${mouth}' is a different Beeper account — sends this node places locally go out on '${home}', because that chat id does not exist on '${mouth}'. The peer mouth is what reaches the other account's view of this chat.`);
    }
    return home;
  };
  // rawBridgeOf(being, chatId): the RAW (non-shell-aware) bridge that outbound rides. The second
  // argument arrives from sender.mjs's makeOutbound, the ONE outbound resolver; a caller with no
  // chat in hand (reply-actions' limbs, spine's media attach) passes none and gets the being's own
  // connection exactly as before. Fallback to the default `bridge` is defensive only — every being
  // in agents() was already enumerated above, so this should never miss.
  const rawBridgeOf = (being, chatId = null) => bridgeByEndpoint.get(endpointKey(endpointFor(outboundConnectionFor(being, chatId)))) ?? defaultBridge;

  // ── ONE MENTION, TWO ANSWERS (operator 2026-09-07) ────────────────────────────────────────
  // A node that wakes on more than one connection hears a chat BOTH its accounts are in twice —
  // one real group is a different room per account, and nothing deduplicates them (deliberately;
  // see bridge-fanout.mjs). A DECLARED handle is unconditional, so both arrivals resolve to the
  // same agent and the chat gets two answers from two visibly different numbers. That is the same
  // live bug wakeTokens' header records across two SPINES, now reachable inside one.
  //
  // `fallback_handle`'s `unless_present` is what makes exactly one arrival answer, and it does NOT
  // cover an agent's declared handles: a token in `handles:` beats a fallback for the same token
  // (router.mjs's second pass), which is precisely what a naive merge of two nodes' configs
  // produces — the guarded handle becomes an unconditional one and the guard goes quiet.
  //
  // A WARNING, NEVER A REFUSAL. Two accounts that never share a chat is a legitimate node and this
  // must not stop it booting; nor can boot know which chats they share. It names the agent and its
  // handles so the line is actionable without opening the config. No token value is logged —
  // connection COUNT only, never a token, and the remedy names a phone number the operator already
  // has rather than any secret.
  if (inboundOwned.size > 1) {
    for (const [name, agent] of Object.entries(agents())) {
      if (!agent || typeof agent !== 'object' || name.startsWith('_')) continue;
      // The agent's UNCONDITIONAL vocabulary, through THE one rule. `handles: []` yields nothing —
      // an agent addressable by nothing cannot double-answer — and a purely guarded agent (every
      // token under fallback_handle) never appears here either, which is the shape being advised.
      const unconditional = wakeTokens(name, agent);
      if (!unconditional.length) continue;
      log.line?.(`[router] '${name}' wakes on ${unconditional.map((h) => `@${h}`).join(' ')} unconditionally and this node wakes on ${inboundOwned.size} connections — in any chat two of its accounts are both in, ONE mention wakes it TWICE and the chat gets two answers. To make exactly one answer, move those handles into fallback_handle: { handle: [...], unless_present: <one of this node's own account numbers> } — the account whose number you name is the one that answers, and the other stays silent wherever the two share a chat.`);
    }
  }

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

  // The operator-console LIMB (plans/2607191835-SHELL-LIMB-S1-PLAN.md Phase 1, direction
  // inverted 2026-08-26): a second SURFACE, SERVING ws://127.0.0.1:23375 and holding it from
  // boot, into which the external editor dials as a client. Its inbound feeds the SAME pipeline
  // (wired below, after the spine exists) and its command replies route back over the seated
  // editor's socket (see the routed `send` handed to createCommands). A dumb pipe — no command
  // logic here.
  // The SAME per-NODE bridge-signature layers the beeper bridge received (above) — so a persona
  // reply rendered to the operator console is wrapped byte-identically to one rendered to Beeper
  // (ONE path, operator 2026-07-25). Default '' → nothing added, exactly like the beeper side.
  // Wrapped by the SAME lasso as the beeper limb (never a second one): a shell-owned chat
  // routes to this port and would otherwise leave the node unregulated — "any limb", operator
  // 2026-07-26. The wrap is a Proxy precisely so this port's `isConnected` GETTER stays live.
  // THE PERMANENT SHELL HEADER (operator 2026-07-27, computeShellHeader above): computed HERE,
  // the ONE place config is read for this feature — the editor never touches config.yaml.
  const shellHeader = computeShellHeader({ nodeName: node_name, agents: cfg.agents, defaultNode: cfg.dispatch?.default_node });
  // The watchers, built before the router that consults them. Ports come from the agents block
  // and nowhere else, so a node declaring no unless_peer_alive builds none and probes nothing.
  const peerLiveness = new Map();
  for (const agent of Object.values(cfg.agents ?? {})) {
    const raw = Number(agent?.fallback_handle?.unless_peer_alive);
    if (!Number.isInteger(raw) || raw <= 0 || raw >= 65536 || peerLiveness.has(raw)) continue;
    const watcher = createPeerLiveness({
      probe: tcpProbe({ port: raw }),
      onLog: (m) => log.line?.(`[peer] :${raw} ${m}`),
    });
    watcher.start();
    peerLiveness.set(raw, watcher);
    log.line?.(`[peer] watching the peer spine on :${raw} — its fallback handle is assumed only while it is absent`);
  }

  // THE MOUTH LINK (operator 2026-09-05), read ONCE, here, like every other config-fed option —
  // the limb and the sender never read config themselves. ABSENT (every ordinary single-account
  // node) ⇒ null ⇒ no receiver is constructed, a /peer dial to this node's console is refused on
  // the spot, and the reply path is handed no mouth at all: not one line of this feature runs.
  const mouthLog = (m) => log.line?.(`[mouth] ${m}`);
  const peerSpine = peerSpineFrom(cfg, mouthLog);
  // THE RECEIVING HALF: the handler the console limb calls for a `say: post` frame off an
  // AUTHENTICATED peer connection. It resolves the cross-account chat key against THIS account's
  // own chats and posts the text VERBATIM — postVerbatim, not send, because the line arrived from
  // the other spine already wrapped and signed by the brain that wrote it (beeper-port.mjs).
  const mouthReceiver = peerSpine ? createMouthReceiver({
    listChats: (o) => bridge.listChatsRaw(o),
    post: (chatId, text) => bridge.postVerbatim(chatId, text),
    // THE REPLY TRAIN's target on this account: the UNWRAPPED stream, for exactly the reason
    // postVerbatim above is unwrapped — every frame of it was written and signed by the peer.
    // Lasso-gated like any other stream this node opens (one 'message' for the placeholder, the
    // edits on the 'edit' budget), because `bridge` here is the wrapped port.
    startStream: (chatId, init) => bridge.startStreamVerbatim(chatId, init),
    // THE REACTION VERB's two reads on this account (operator 2026-09-07): its own copies of the
    // chat's recent messages — the peer names one by CONTENT, because no id crosses the link — and
    // the same `react` primitive the /react limb and the steer ack already use. Ungated by the
    // lasso on purpose, exactly as every other reaction is (src/lasso.mjs: a reaction carries no
    // text and is not a line in a chat).
    listMessages: (chatId) => bridge.listMessagesRaw(chatId),
    react: (chatId, msgId, emoji) => bridge.react(chatId, msgId, emoji),
    accounts: peerSpine.accounts,
    onLog: mouthLog,
  }) : null;
  if (peerSpine) mouthLog(`offering the mouth link on this node's console — a peer spine on :${peerSpine.consolePort} may speak through it, and replies in chats its account is in will be said by it`);

  const shellPort = lasso.wrap(createShellPort({
    wakeWords,
    addressWithoutAt,                     // same switch, same route — the shell gate and the beeper gate move together
    bridgeSignatureOpen: cfg.bridge_signature_open ?? '',
    bridgeSignatureClose: cfg.bridge_signature_close ?? '',
    nodeName: node_name,                  // same structural layer — a shell frame is a surface send too
    // The SHELL TOKEN (config `shell.token`), read HERE like every other config-fed option and
    // handed in — the limb never reads config itself. Without it the limb refuses to SERVE at
    // all: an unauthenticated 127.0.0.1:23375 is dialable by any local account (the sandboxed
    // CLI accounts included) and a frame from it would be dispatched as the AUTHORIZED operator
    // — `/upgrade` and all (src/shell/auth.mjs). Fail closed, never auto-generate.
    token: shellTokenFrom(cfg),
    // The console PORT (config `shell.port`), read here for the same reason the token is:
    // the limb never reads config. Absent ⇒ 23375, so a node that sets nothing is unchanged.
    // It exists so a SECOND spine can run on this machine — Session 0 and Session 1 cannot
    // both bind one port, and that collision was the only thing making two spines impossible.
    port: shellPortFrom(cfg),
    // THE ONE GUARD (chunk 3). start() REAPS the port before binding it — netstat + `taskkill /F /T`
    // (src/tools/reap-port.mjs) — which is right for a Session 0 spine clearing its own orphan or a
    // squatter, and catastrophic for the successor: the thing holding this port is the INCUMBENT,
    // mid-turn, and killing it is precisely the abrupt death the deferred stand-down exists to
    // prevent (`interrupted — the link to the spine writing this reply dropped`, observed live
    // 2026-09-05). Worse, the reap would SUCCEED, so the bind would succeed too and the plan's
    // "wait for the port" would never happen. Suppressed, the failed bind takes shell-port's own
    // re-listen backoff and the successor waits — which is the whole sequencing this chunk is.
    // STATED COST: a successor therefore never clears a genuine ORPHAN on this port either; it
    // waits, and the Session 0 spine (which still reaps) is what clears one on its next boot.
    // Spread, so a non-successor's options object is byte-for-byte the one it was before.
    ...(session1 ? { reapPort: (p, onLog) => { onLog(`shell: the Session 1 successor does NOT reap :${p} — whatever holds it is the incumbent, and it is draining, not stale`); return 0; } } : {}),
    header: shellHeader,
    // THE MOUTH HANDLER (above). Null on every node with no peer_spine, which is what makes the
    // limb refuse a /peer dial outright — exactly as it did before this feature existed.
    onPeerSay: mouthReceiver,
    onLog: (m) => log.line?.(`[shell] ${m}`),
  }));

  // THE SPEAKING HALF, built after the limb because it asks the limb which chat ids are the
  // console's (a shell/room id is not a Beeper chat and is never routed). Handed to createSender
  // below — the ONE place the mouth decision is made.
  // rawBridgeOf, not the frozen `bridge` (operator 2026-09-11): route()'s two roster reads are
  // about ONE room, and a room lives on one account (see makePeerMouth's header). The RAW
  // resolver, not the shell-aware one, because these are reads and the shell-aware facade only
  // wraps send/startStream/postStatus — and route() refuses a console-owned chat before it asks
  // anything at all.
  const peerMouth = makePeerMouth({ peer: peerSpine, bridge, bridgeOf: rawBridgeOf, owns: (c) => shellPort.owns(c), onLog: mouthLog });

  // Shell-aware bridge facade (makeShellAwareBridge, top of file): the STREAMING senders
  // (E's persona sender + the brain-member relay sender) render through their injected
  // `bridge`, which was the raw beeper bridge — so a streamed @e / @member reply on a
  // shell-owned chat streamed to Beeper and never reached the editor. Handed as `bridge` to
  // BOTH createSender calls below; the beeper path for non-shell chats is untouched.
  // ONE facade per distinct bridge (operator 2026-08-30): a being on ANY connection must still
  // redirect to a shell-owned chat, not just the default one. shellAwareBridge (the default
  // connection's facade — the same object mesh/memberSender rode before this change) is this
  // map's defaultKey entry; shellAwareBridgeOf mirrors rawBridgeOf's per-being lookup.
  const shellAwareBridgeByEndpoint = new Map([...bridgeByEndpoint].map(([key, b]) => [key, makeShellAwareBridge(b, shellPort)]));
  const shellAwareBridge = shellAwareBridgeByEndpoint.get(endpointKey(endpointFor(outboundOf(defaultKey))));
  // …and it asks the SAME question rawBridgeOf does (outboundConnectionFor, operator 2026-09-11):
  // the reply path asks this one, so this is the resolver that actually puts a locally placed
  // reply back out the connection the chat lives on. The STOP confirmation (stopSwitch.pull, far
  // above) asks it too, with `null` for the being — it is a node-level send and there is no second
  // rule for those. A shell-owned chat is neither in the arrival map nor the Self chat (the
  // console does not arrive on a Beeper connection), so it resolves UNKNOWN, rides the default
  // mouth's facade, and is redirected to the console by that facade exactly as before.
  const shellAwareBridgeOf = (being, chatId = null) => shellAwareBridgeByEndpoint.get(endpointKey(endpointFor(outboundConnectionFor(being, chatId)))) ?? shellAwareBridge;

  // --- lifecycle announce: "restarting…" to Self before exit, "back up! <commit>"
  //     on the next boot. The bounce is otherwise invisible to the operator. ---
  const sidecar = join(EGPT_HOME, 'state', 'restart-announce.json');
  const KIND_OF = { 43: '/restart', 42: '/upgrade', 44: '/rewind', 45: '/standdown' };
  const gitOut = (args) => { try { return spawnSync('git', args, { cwd: process.cwd() }).stdout?.toString().trim() || ''; } catch { return ''; } };
  const shortSha = () => gitOut(['rev-parse', '--short', 'HEAD']) || '?';
  // The going-down half, unchanged: the sidecar the NEXT boot reads back, the capped "↻ …" line,
  // then the exit itself.
  async function goDown(code) {
    const selfDm = selfChatId();   // the Self chat (above) = the Self-DM announce target
    try { await mkdir(join(EGPT_HOME, 'state'), { recursive: true }); await writeFile(sidecar, JSON.stringify({ chatId: selfDm, kind: KIND_OF[code] ?? '?', preSha: shortSha(), pid: process.pid })); } catch {}
    // best-effort going-down — names the PID going down (capped so a slow POST can't wedge the
    // exit). rawBridgeOf, not the default `bridge`: the Self-DM is a room on this node's EAR, and
    // where the mouth is another Beeper account that id does not exist there (operator
    // 2026-09-11). No being, so the resolver reads the node's default mouth — what this was.
    // The failure is SAID rather than swallowed: a restart line that never landed leaves the
    // operator watching a silent chat, and this is the last thing the process does.
    try { if (selfDm) await Promise.race([rawBridgeOf(null, selfDm).send(selfDm, `↻ ${KIND_OF[code] ?? 'restart'}… (pid ${process.pid})`), new Promise((r) => setTimeout(r, 3000))]); }
    catch (e) { log.line?.(`[announce] could not post the going-down line (${e?.message ?? e}) — leaving anyway`); }
    exit(code);
  }
  // THE STAND-DOWN IS DEFERRED, NEVER ABRUPT (operator's ruling, plans/2609061200-SESSION-0-TO-1-
  // HANDOVER-PLAN.md): 43/42/44 leave the moment they are read, but 45 (daemon-runtime.mjs's
  // STANDDOWN_EXIT_CODE) hands the decision to the spine — which stops admitting turns, drains
  // the ones already in flight, and calls back. goDown then runs exactly as it does for every
  // other code, so "↻ /standdown… (pid …)" is truthful about the moment it is posted.
  //
  // ONE BRANCH, HERE, because this is where BOTH ways a lifecycle command arrives converge: the
  // ingest box below, and a /standdown typed in Self (commands.mjs dispatches on the same
  // lifecycleExit and leaves through this same injected `exit` seam).
  async function announceAndExit(code) {
    if (code === 45) { spine.standdown(() => { goDown(code).catch((e) => log.line?.(`[standdown] ${e?.message ?? e}`)); }); return; }
    await goDown(code);
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
    // loadState (operator 2026-08-15, allowed_users): the SAME conversations-state reader
    // gating.mjs's createGating takes (`_loadState`, declared above) — resolve()'s per-
    // conversation allowed_users override reads through it, one state load per resolve() call.
    // isPresent (operator 2026-08-31, fallback_handle): THE membership question — "is this identity
    // a participant of this chat?" — answered by the node's OWN Beeper account (the persona
    // connection's `bridge`), which is the right vantage precisely because the question is "should
    // THIS node answer here". Cached, TTL'd, and free for a 1:1 inside the bridge; null = UNKNOWN,
    // and the router stays silent on null. A room/shell conversation never gets this far — it has
    // no Beeper chat and no roster, so resolve() decides absence itself (see its comment).
    // PEER LIVENESS (operator 2026-09-02) — one watcher per DISTINCT port any agent's
    // `fallback_handle.unless_peer_alive` names. Two spines fit on one machine now (Session 0
    // holds the agent's Beeper, Session 1 the operator's) and on a forced restart only S0
    // exists, because S1 needs a login. A spine whose peer is absent assumes the peer's handle.
    //
    // Nothing is negotiated: the watcher OBSERVES the peer's console port. Deduped by port so
    // several agents naming one peer share a single probe, and empty on a node that declares
    // none — in which case isPeerAlive is never consulted and resolution is unchanged.
    router: createRouter({
      getAgents: () => cfg.agents ?? {}, defaultBeing: defaultKey, addressWithoutAt, loadState: _loadState,
      isPresent: (identity, ev) => bridge.chatHasParticipant?.(ev?.chatId, identity) ?? null,
      // true | false | null(unknown). A port with no watcher returns null rather than a
      // guess, and the router reads anything but a definite false as "stay silent".
      isPeerAlive: (port) => peerLiveness.get(Number(port))?.isAlive() ?? null,
      // WHICH CONNECTION AN AGENT WAKES ON (operator 2026-09-08; split from output 2026-09-10) —
      // inboundOf, above. It is the INGEST half of the one resolver that also decides which
      // bridges boot opens as ears, so the router asks it and does not learn a second rule. It is
      // deliberately NOT the output half: an agent's `use:` moves its mouth and must never move
      // what it can hear, which is the entire point of the split.
      inboundOf,
      onLog: (m) => log.line?.(`[router] ${m}`),
    }),
    // currentRoomOf: a lazy thunk, not `commands.currentRoomOf` directly — `commands` (below)
    // isn't constructed until after `services` (it takes `services.transcript` itself as one of
    // its own options, via commandTranscript below), so a direct reference would be undefined
    // here. Safe forward reference: this callback only ever fires later, on an actual write,
    // by which time `commands` is assigned (mirrors createSpine's own construction site further
    // down, which passes commands.currentRoomOf directly because by THAT point commands exists).
    transcript: createTranscript({ contacts, persona: labelOf(defaultKey), defaultKey, labelOf, timeZone: transcriptTimeZone, io, currentRoomOf: (surface) => commands.currentRoomOf(surface), onLog: (m) => log.line?.(`[transcript] ${m}`) }),
    // peerMouth (operator 2026-09-05): THE reply path, so THE place the mouth decision is made —
    // null on a node with no peer_spine, and the sender is then byte-identical to before.
    sender: createSender({ bridge: shellAwareBridge, bridgeOf: shellAwareBridgeOf, bodyEmojiOf, labelOf, agentSignatureOpenOf, agentSignatureCloseOf, defaultKey, peerMouth, onLog: mouthLog }),
    // The real cadence registry the spine's tick() drives. The heartbeat LOADER
    // (below) collects every declarative heartbeat and registers it here, so each
    // beat rides the loop's own tick instead of a side timer (operator 2026-07-01).
    // Boot then hands this same registry to the loader (wrapRegistry) so its reload()
    // — driven by refreshConfig on message arrival, see below — can register/clear onto it.
    heartbeats: createHeartbeats({ onLog: (m) => log.line?.(`[heartbeat] ${m}`) }),
  };
  // Brain registry: resolves the agent-type file (YAML defs in src/brains ← ~/.egpt2/config
  // /agents ← <slug>/brains) a fresh conversation is instanced from, named by the persona
  // agent's `configuration`.
  const brains = createBrains({ onLog: (m) => log.line?.(`[brains] ${m}`) });

  // Auto-compaction: keep each conversation's warm session thin (native /compact a
  // cooling period after the last reply, once it's over ratio of the window).
  const compaction = createCompaction({ pool, getConfig, onLog: (m) => log.line?.(`[compact] ${m}`) });
  // resolveScope (operator 2026-08-31): WHICH conversation a being's instance lives in, resolved
  // before the thread / warm key / conv dir / run config are derived from it. A chat invited into
  // exactly one room as a `wa-group` member resolves to THAT ROOM — so room/acim's E and the
  // "perrito traducciones" group's E are one being: one thread, one warm CLI, one queue, one
  // access_level. Every other conversation resolves to itself and is unchanged.
  // labelOf rides along (operator 2026-09-01): the kickoff feed hands the card THIS being's own
  // display name as {{agent_name}}, so one shipped 00-identity template reads correctly for every
  // agent on every node. Same resolver the sender/transcript/mesh already take — one definition.
  const brain = createBrainPool({ pool, getConfig, contacts, loadState: _loadState, writeState: _writeState, brains, defaultKey, labelOf, afterTurn: compaction.afterTurn, resolveConfig: configResolver.configFor, resolveScope: createIdentityScope({ resolveMembers: memberResolver, getConfig, onLog: (m) => log.line?.(`[scope] ${m}`) }), io, onLog: (m) => log.line?.(`[brain] ${m}`) });

  // ONE turn machinery for the whole node (see the import note). Built here because it needs
  // `brain` (its scopeOf/allowNewInput/steer seams) and the bridge pair the steer-ack rides —
  // all three exist by now — and because BOTH consumers below take this same instance.
  // …and the MOUTH, for the same reason (operator 2026-09-07): the steer 👀 is an outbound like
  // any other, so it resolves through the ONE resolver the reply does (sender.mjs makeOutbound).
  // Without it the ack went out on this account while the reply came out of the peer's.
  const turns = createTurns({ brain, bridge, bridgeOf: rawBridgeOf, peerMouth, log });

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
    //
    // WHICH beeper bridge is the SAME question every other outbound asks (outboundConnectionFor,
    // operator 2026-09-11) and it is asked here for the same reason: a command reply lands in the
    // chat the command was TYPED in — overwhelmingly the Self-DM — and on a node whose default
    // mouth is another Beeper account that chat id does not exist there, so `/status` would answer
    // into a room that is not real. No being: a command reply is the NODE speaking, so the
    // resolver reads the default mouth, which is exactly what plain `bridge` was.
    send: (chatId, text) => (shellPort.owns(chatId) ? shellPort.send(chatId, text) : rawBridgeOf(null, chatId).send(chatId, text)),
    transcript: services.transcript,
    onLog: (m) => log.line?.(`[transcript] ${m}`),
  });
  const commands = createCommands({
    getConfig,
    send: commandTranscript.send,
    exit: announceAndExit,
    writeRewindTarget: (ref) => writeFile(join(EGPT_HOME, 'rewind-target.txt'), ref, 'utf8'),
    // The SAME writer the ingest handle passes below (:1945) — `/standdown <port>` reaches this
    // node by TWO doors, the ingest box and a line typed at the console or in Self, and the port
    // argument has to survive both. Without it commands.mjs parsed the port and dropped it, and
    // the daemon fell back to this profile's own console port; harmless while the two agree, wrong
    // the moment they do not. It is also the door the successor's announce comes in through.
    writeStanddownTarget: (port) => writeFile(join(EGPT_HOME, 'standdown-target.txt'), port, 'utf8'),
    loadState: _loadState, writeState: _writeState,   // /agents … auto/reset/access_level persist into conversations.yaml
    logTranscript: (ev, reply) => services.transcript.log(ev, reply),   // THE reply writer — the same service commandTranscript wraps above; /agents rethread's accum boundary rides it instead of assembling a line of its own
    resolveConvRoom,                                  // (surface, chatId) → the conversation's Room — the SAME resolver the phase-4 relay reads members from, so /members writes where the relay reads (bug fix 2026-07-23)
    // `/members add group <chat name>` — THE bridge's name→id resolver, the same one
    // mesh.mjs's canonRoute takes off this bridge (`bridge.resolveChatId`), so a chat NAME
    // resolves to the id the relay actually delivers under. LIVE since c84deac, which forwards
    // it through the §2b port (src/bridges/beeper-port.mjs) — the note that used to stand here
    // said this was `null` and the verb inert, and that stopped being true on 2026-08-31. Same
    // degrade convention as canonRoute: no resolver → the name is refused, never guessed at.
    resolveChatId: bridge.resolveChatId ?? null,
    // The chat LIST off the same bridge — MESSAGES only (see the seam in commands.mjs).
    // /members' two dead-end errors read it: "no chat named" offers near-misses off the very
    // list resolveChatId just walked, and "no member" names a wa-group member beside its id
    // (operator 2026-08-31, after a one-letter group-name typo cost four attempts).
    listChats: bridge.listChats ? ((opts) => bridge.listChats(opts)) : null,
    brains,                                           // /agents' status + access_level resolve a being's agent type through the registry
    defaultKey,                                       // the persona being-id (its map key) — /agents + /status key their per-conversation reads/writes/evictions off this, never 'e' (operator 2026-07-10)
    evictWarm: (key) => pool.evict(key),              // drop a re-pointed conversation's warm session so it respawns fresh
    warmStats: () => pool.stats(),                    // /status `warm:` field — { size, max, keys }
    shellConnected: () => shellPort.isConnected,       // /status `shell:` field — is the operator's editor dialed in
    gate: lasso.gate,                                  // /radio say's upload — the SAME node-wide lasso instance the beeper bridge, echo and shell port already spend from (never a second one)
    listEntityDirs,                                    // bare /radio's joined-rooms report + /radio leave all|<slug> — THE walk (above), never a second entity enumeration
    // Live status-line room reflection (operator 2026-08-16): /rooms join|leave (or any other
    // currentRoom clear) on the shell surface recomputes the SAME computeShellHeader (above)
    // with the new currentRoom and pushes it down the shell-port limb — the ONE other caller
    // of computeShellHeader besides this file's own initial boot-time push (shellHeader,
    // above). Every other surface is a no-op: only the shell has a status line to update.
    onRoomChange: (surface, slug) => {
      if (surface !== SHELL_SURFACE) return;
      shellPort.setHeader(computeShellHeader({ nodeName: node_name, agents: cfg.agents, defaultNode: cfg.dispatch?.default_node, currentRoom: slug }));
    },
    // ── WHICH SPINE MAY SPAWN CHROME (chunk 6, plans/2609061200-SESSION-0-TO-1-HANDOVER-PLAN.md).
    // THE DEFAULT STAYS THE TASK HOP for every node, and this is the only place that is decided.
    // A Session 0 spine's child inherits Session 0, and while a browser there runs and serves CDP
    // perfectly well (measured on reve 2026-09-06: chrome.exe pid 2388 on :9224, SessionId 0), it
    // renders on a desktop the operator cannot see, click, or log in to — so /chrome, whose whole
    // job is to hand the OPERATOR a browser, hops through `schtasks /run /tn egpt-chrome` there.
    // A SESSION 1 SUCCESSOR ALREADY HAS THAT DESKTOP, so it spawns Chrome as an ordinary child
    // instead, which is the only way the spine gets to pass arguments (the port it will attach to,
    // the profile config names) and to hear that the browser died. Same flag, same spread, same
    // reason as the reap guard above: a non-successor's options object is byte-for-byte the one it
    // was before. onLog is this file's, so a death notice lands in the node's log like any other.
    ...(session1 ? { launchChrome: (o) => launchChromeDirectFn({ ...o, onLog: (m) => log.line?.(`[chrome] ${m}`) }) } : {}),
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
  // loadState: the SAME conversations-state IO the router/gating DI already share (operator
  // 2026-08-15, allowed_users) — one reference, threaded to every call site that needs a
  // per-conversation override, never re-derived.
  // bridgeOf (operator 2026-09-11) — the LAST constructor in this file holding one frozen bridge.
  // Every line the mesh places asks the same question every other outbound asks
  // (outboundConnectionFor): the mouth wherever the mouth can reach the chat, the connection the
  // chat lives on when it cannot. It matters most for the two chats the mesh cannot choose — the
  // ORIGIN chat a human typed in, and the room an envelope ARRIVED in — both of which are rooms
  // on this node's EAR, and neither of which exists on the mouth's account when the two are
  // different Beeper accounts. shellAwareBridgeOf, not rawBridgeOf, to match the `bridge` above:
  // a mesh reply into a shell-owned chat must still reach the console.
  const mesh = createMeshService({ bridge: shellAwareBridge, bridgeOf: shellAwareBridgeOf, brain, commands, getConfig, bodyEmojiOf, labelOf, getSelfChatId: selfChatId, loadState: _loadState, turns, onLog: (m) => log.line?.(`[mesh] ${m}`) });
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
  // bridgeOf (operator 2026-09-11), the last outbound in this file that held one frozen bridge:
  // the ask rode the default mouth, and the advice channel MUST be a channel this node HEARS or
  // the operator's answer can never be matched back to it (src/spine/advice.mjs's header, and
  // connectionHolding's third source above, which is what makes a NAMED channel resolvable).
  const advice = createAdvice({ bridge, bridgeOf: rawBridgeOf, getConfig, onLog: (m) => log.line?.(`[advice] ${m}`) });
  const actions = createReplyActions({ bridge, bridgeOf: rawBridgeOf, bodyEmojiOf, labelOf, resolveConvDir, askAdvice: (a) => advice.ask(a), defaultKey, onLog: (m) => log.line?.(`[actions] ${m}`) });

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

  // AN `agent:` HEARTBEAT RUNS AS A BEING (operator 2026-08-22). A bare `script_path:` spawns
  // textecute.mjs, whose own CLI session sits OUTSIDE the being system — no persona, no
  // transcript, and no access_level / allowed_users / sandboxed, so a scheduled agent ran
  // unconfined however config.yaml confined it. An entry that names `agent: <being-id>`
  // dispatches through THE turn path instead — brainpool.turn, the same one an inbound
  // message runs — so every one of those gates applies unchanged. The loader hands over the
  // being, the entity ns and the framed prompt; this closure does the ns → conversation
  // lookup and nothing else. Deliberately NOT routed through spine.handleInbound: a beat is
  // not an inbound message, and gating.mjs (mode: mention et al) decides who may answer
  // MESSAGES — a scheduled turn has no sender to be addressed by and never touches it.
  // The reply is logged, not posted: the script says what to do with its own output. It is
  // the LOADER that logs it, in the run's one outcome line (with elapsed, next to the fire
  // line) — this closure just hands the turn result back so there is a single place that
  // formats + truncates a beat's outcome, for both action kinds.
  const dispatchHeartbeatTurn = async ({ being, ns, prompt }) => {
    const target = chatIdForEntity(await _loadState(), ns);
    if (!target) throw new Error(`no conversation for ${ns} — not registered in conversations.yaml`);
    return brain.turn(being, { surface: target.surface, chatId: target.chatId, line: prompt, body: prompt });
  };

  const heartbeatLoader = createHeartbeatLoader({
    resolver: configResolver, aliveMs, aliveCommand, now, dispatchTurn: dispatchHeartbeatTurn,
    // Command beats inherit process.env + EGPT_HOME + the queue-stats vars (the
    // loader adds those). The spine pid is no longer an env var — identity lives in
    // state/spine.pid now, and liveness is the alive.txt mtime, so a custom beat
    // needs neither to arm the deadman.
    spawn: spawnFn, env: process.env, egptHome: EGPT_HOME, procCwd: process.cwd(),
    io: { writeFile, mkdir, readFile },   // readFile: an `agent:` beat reads its own *.x.md fresh on each run
    onLog: (m) => log.line?.(`[heartbeat] ${m}`),
  });

  // Hand the loader the real registry the spine ticks, so its reload() (called via
  // refreshConfig below, from spine.mjs's handleFast on every inbound message) can
  // register/clear beats onto it. No decoration of runDue any more — the reload TRIGGER
  // is message arrival now, not the tick (2026-08, replacing the 2026-07-02 tick-based
  // hot reload). services.heartbeats keeps the exact same shape.
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
  // conversation (bug fix 2026-07-23: previously the two resolved to different config.yaml files)
  // — plus, on `.tunnelRooms`, the name of any room that INVITED this chat in as a `wa-group`
  // member, which the relay re-enters the message into as a turn (see createMemberResolver's
  // header and room-relay.mjs's).
  // bridgeOf, like the persona sender's (32aa5c1). Without it this sender held ONE bridge --
  // the node's default mouth -- so a @member reply into a chat heard on the ear posted on the
  // mouth, naming a room that account does not have. The persona sender got the per-chat
  // resolver; this one was missed, and the defect stayed live for members only.
  const memberSender = createSender({ bridge: shellAwareBridge, bridgeOf: shellAwareBridgeOf, bodyEmojiOf: () => '🤖', labelOf: (id) => id, defaultKey });
  const _adapterMods = new Map();
  const roomRelay = createRoomRelay({
    resolveMembers: memberResolver,
    adapterOf: async (name) => {
      if (!name) return null;
      if (!_adapterMods.has(name)) _adapterMods.set(name, await loadAdapterModule(name));
      return _adapterMods.get(name);
    },
    streamFromTab: cdp.streamFromTab,
    activateTarget: cdp.activateTarget,
    openStream: (memberId, chatId, opts = {}) => memberSender.open(chatId, { being: memberId, replyTo: opts.replyTo ?? null }),
    // NO logRoomTranscript SEAM ANY MORE (operator 2026-08-31, a net deletion): a wa-group message
    // is RE-ENTERED into the room it tunnels into now, so the room's own ingestion writes its ONE
    // transcript record at the same chokepoint every other message goes through — and wakes the
    // room's agents while it is there. A second writer here would double that record.
    onLog: (m) => log.line?.(`[relay] ${m}`),
  });

  // The two provenance seams (operator 2026-08-31), both read through getConfig() so a hot
  // config reload changes them the same message it changes everything else: a chat that is some
  // agent's relay_channel is TRANSIT (no record, no chat dispatch — the messages live in Beeper),
  // and a frame carrying ANOTHER node's signature wakes nobody here. Own-node frames are
  // untouched: the room relay's tunnel carries this node's own fromNode across deliberately.
  const spine = createSpine({ bridge, bridgeOf: rawBridgeOf, brain, turns, ...services, commands, mesh, actions, advice, guard, guardOverride, stopSwitch, isSelfChat, isTransit: (ev) => isRelayChannelChat(getConfig(), ev), roomRelay, readTranscript, refreshConfig: heartbeatLoader.reload, radioRelay: radioRelay.relay, synthesize: vx.synthesize, voice: vx.voice, defaultBeing: defaultKey, labelOf, timeZone: transcriptTimeZone, clock: { now }, log, tickMs: effectiveTickMs, setInterval: setIntervalFn, clearInterval: clearIntervalFn });
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
  // before start() so an editor that dials in immediately is caught. start() BINDS the console
  // port (and holds it, which is the whole point — an unbound 23375 is squattable); it is
  // gated on the real-node flag like every other real-node side effect (whisper-reap,
  // transcriptor, ingest) so a test's boot() never binds a real port — an absent editor just
  // means the listener sits with no client, never crashing the boot path.
  shellPort.onMessage((msg) => spine.handleInbound(redirectShellToRoom(msg, { currentRoomOf: commands.currentRoomOf, claim: shellPort.claim })));
  if (ingest) shellPort.start();

  // Back-up announce: if we respawned from a lifecycle command (or a crash/wedge the daemon
  // caught — src/daemon-runtime.mjs writes the same fallback sidecar for those), tell Self
  // with the commit we came up on. A cold boot with NO sidecar at all (first-ever start, or
  // either gap the fallback couldn't resolve a chat id for either) still gets a plain
  // "started" line below — the operator must never be silently in the dark about a restart.
  // Gated on the real-node flag so tests don't read/send through it.
  //
  // BOTH LINES RIDE rawBridgeOf, NOT THE DEFAULT `bridge` (operator 2026-09-11). This is the
  // earliest outbound of the process — nothing has arrived yet — but it does not need an arrival:
  // the target is this node's Self chat, declared in its own config, therefore a room on its EAR
  // (outboundConnectionFor / connectionHolding, above). Where the mouth is a different Beeper
  // account, "back up!" posted on the mouth is a room that does not exist. No being to pass, so
  // the resolver reads this node's default mouth — byte-identical wherever the mouth can reach.
  if (ingest) (async () => {
    let sc; try { sc = JSON.parse(await readFile(sidecar, 'utf8')); } catch { sc = null; }
    if (sc) {
      try { await unlink(sidecar); } catch {}
      if (!sc?.chatId) return;
      const nowSha = shortSha();
      const head = (sc.preSha && sc.preSha !== nowSha) ? `${sc.preSha} → ${nowSha}` : nowSha;
      const pids = (sc.pid && sc.pid !== process.pid) ? `pid ${sc.pid} → ${process.pid}` : `pid ${process.pid}`;
      const subject = gitOut(['log', '-1', '--format=%s']);
      // `note` (daemon-runtime.mjs's boot-failure ladder, operator 2026-08-30) is the only
      // way the recovery reaches a human: it names what the daemon did on its own and, for a
      // dirty-tree rescue, which rescue/<ts> branch the operator's uncommitted work is on.
      // Absent on every other sidecar, which therefore renders byte-for-byte as before.
      try { await rawBridgeOf(null, sc.chatId).send(sc.chatId, `✅ egpt back up! (${head}) ${pids}${sc.note ? `\n\n⚠️ ${sc.note}` : ''}${subject ? `\n\n${subject}` : ''}`); }
      catch (e) { log.line?.(`[announce] ${e?.message ?? e}`); }
      return;
    }
    const selfDm = selfChatId();
    if (!selfDm) return;
    const nowSha = shortSha();
    const subject = gitOut(['log', '-1', '--format=%s']);
    try { await rawBridgeOf(null, selfDm).send(selfDm, `✅ egpt started (${nowSha}) pid ${process.pid}${subject ? `\n\n${subject}` : ''}`); }
    catch (e) { log.line?.(`[announce] ${e?.message ?? e}`); }
  })();

  // Command ingest: drop /restart, /upgrade, /rewind <ref> or /standdown [port] into
  // EGPT_HOME/state/ingest (operator 2026-07-03: the ingest box lives under state/ now).
  let ingestWatcher = null;
  if (ingest) {
    ingestWatcher = createIngest({
      dir: join(EGPT_HOME, 'state', 'ingest'),
      io,
      onLog: (m) => log.line?.(`[ingest] ${m}`),
      handle: async (line) => {
        // The shell editor's self-announce — poke the shell-port limb. Normally a no-op (the
        // limb has held the console port since boot); it matters when the BIND failed and the
        // limb is backing off, where this makes it re-listen NOW so the editor has something
        // to dial. Not a lifecycle command.
        if (isShellConnectMarker(line)) { shellPort.poke(); return; }
        const code = lifecycleExit(line, {
          writeRewindTarget: (ref) => writeFile(join(EGPT_HOME, 'rewind-target.txt'), ref, 'utf8'),
          // The stand-down's port, written the SAME way and read the same way — daemon-runtime's
          // standdownPort() consumes it on exit 45 and falls back to this profile's own console
          // port when it is absent, which is why no port means nothing is written.
          writeStanddownTarget: (port) => writeFile(join(EGPT_HOME, 'standdown-target.txt'), port, 'utf8'),
        });
        if (code != null) { log.line?.(`[ingest] ${line} -> exit ${code}`); await announceAndExit(code); }
        else log.line?.(`[ingest] ignored: ${JSON.stringify(line)}`);
      },
    });
    await ingestWatcher.start();
  }

  return {
    spine, bridge, shellPort, pool, cfg, peerNodes,      // shellPort: the second LIMB — exposed so its regulation is assertable, like bridge's
    peerMouth,                                           // null on a node with no peer_spine — exposed for the same reason: "absent means absent" is assertable

    stop: () => {
      // No alive-timer teardown: the beat is a heartbeat now, riding the spine's
      // tick timer, which spine.stop() clears.
      ingestWatcher?.stop();
      compaction.stop();
      transcriptorWorker.stop();   // stops BOTH the resident whisper-server + the :23390 endpoint
      synthesizerWorker.stop();    // stops the :23391 endpoint
      shellPort.stop();            // close the console listener + the seated editor's socket
      for (const w of peerLiveness.values()) w.stop();   // stop probing the peer spines
      spine.stop();
    },
  };
}
