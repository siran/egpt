// commands.mjs — the §2c command intercept: an operator's slash command (typed
// in the Self DM, or from any authorized sender) is handled HERE, not routed to
// the brain. v2's loop otherwise sends every inbound to E — so "/restart" went to
// the persona instead of bouncing the node.
//
// v1 wires the LIFECYCLE commands (the operator's standing need: control the node
// from Self) via the same exit-code path as ingest. The other ~50 slash/*.mjs
// commands need a richer ctx (sessions, bridge, channels) and land as that ctx is
// built (Phase 4c); until then they are RECOGNIZED (not leaked to E) and answered
// with a short note.
import { lifecycleExit } from './ingest.mjs';
import { isAutoMode, AUTO_MODES, DEFAULT_AUTO_MODE } from '../auto-mode.mjs';
import { patchBeing, deleteBeing, getContact, getBeing, residentsOf, slugDir, statsPath, conversationPathOf, seedIdentityLayers, skeletonIdentityFiles, slugSuffix, DETERMINISTIC_MODEL, DETERMINISTIC_EFFORT, DEFAULT_ALLOWED_TOOLS, LOBBY_SLUG } from '../conversations-state.mjs';
import { stripFrontMatter } from '../transcript-meta.mjs';
import { coerceAllowedTools, resolveDefaultBrainDef, resolveBeingDef } from './brainpool.mjs';
import { loadPermissionLevel } from './permission-levels.mjs';
import { stat as fsStat, readFile as fsReadFile, writeFile as fsWriteFile, mkdir as fsMkdir, readdir as fsReaddir, rm as fsRm, rename as fsRename } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, basename } from 'node:path';
import * as YAML from 'yaml';
import { EGPT_HOME } from '../egpt-home.mjs';
import { shortChatId } from '../bridges/chat-id.mjs';
import { ownNodeNamesOf, knownNodeNames } from './node-names.mjs';
import { Room } from '../room-core.mjs';
// The room slug rule (fixedSlugFor, surface `room`) applied to a READ, which must not mint —
// see roomOnDisk. NOT for the /room verbs: they pass the operator's raw string through.
import { sanitizeName } from '../sanitize.mjs';
import { loadAdapters as defaultLoadAdapters, matchAdapter } from '../adapters/registry.mjs';
import { agentPaths } from '../mesh/relay.mjs';
import { compactionTargets, dueForCompaction, windowForModel } from '../tools/compact-being.mjs';
import { compactionRatio } from './compaction.mjs';
import { NODE_FILE, REGISTRY_FILE, parseEntityConfig } from './config-resolver.mjs';
import { CONFIG_YAML_PATH, writeConfigKey } from '../tools/config-io.mjs';
import { resolveConfigKey } from '../../config/config-schema.mjs';
import { isRunning as cdpIsRunning, listTabs as cdpListTabs, cdpHost as cdpHostOf, openTab as cdpOpenTab, activateTarget as cdpActivateTarget, closeTab as cdpCloseTab } from '../tools/cdp.mjs';
import { findChromeExecutable, chromeArgs, chromeCommandLine, resolveBrainProfile } from '../tools/chrome-launcher.mjs';
import { helpText } from '../interpreter.mjs';
import { uploadNote, radioNoteFilename, pickSpeaker } from '../radio-relay.mjs';
import { stripNodeSignature, stripRenderedNodeSignature } from '../node-signature.mjs';
import { bodyForMessageId } from '../transcript-log.mjs';

// Where a manually-launched Chrome should keep its profile. v1's shell hardcoded
// ~/.egpt/chrome/profiles/brain — a usually-BLANK fresh dir. resolveBrainProfile() instead
// SEARCHES the v2 default + the operator's v1 browser profiles and picks the one actually
// logged in to an AI site, falling back to the v2 default when none qualify. Memoized once at
// module load (a read-only fs scan); still derives from EGPT_HOME so a second node follows its
// own root. See src/tools/chrome-launcher.mjs.
export const CHROME_BRAIN_PROFILE = resolveBrainProfile();

// The Session-1 launch task /chrome fires to open Chrome on the operator's desktop (see the
// chrome() dispatch for the session-hop rationale). setup/register-chrome-task.ps1 registers
// it; the Session-0 spine triggers it with `schtasks /run /tn egpt-chrome`.
export const CHROME_LAUNCH_TASK = 'egpt-chrome';
const CHROME_LAUNCH_TIMEOUT_MS = 20000;   // how long to wait for a cold Chrome to bind its CDP port
const CHROME_LAUNCH_POLL_MS = 500;

// Default launch seam: fire the scheduled task and report whether schtasks accepted it. A
// non-zero exit (the task isn't registered) or a spawn error both surface as { ok: false },
// which drives /chrome's graceful fallback. Tests inject a fake so no real schtasks runs.
function defaultLaunchChromeTask() {
  try {
    const r = spawnSync('schtasks', ['/run', '/tn', CHROME_LAUNCH_TASK], { windowsHide: true });
    return { ok: r.status === 0 };
  } catch { return { ok: false }; }
}

// A fresh room's config.yaml — a commented placeholder (like the seeded templates,
// seed.mjs). Pure comments → parses to null, so the heartbeat/transcription loaders read
// it as an empty {}. Members are later work — no roster block yet. (The room's identity.d/
// layers are a SEPARATE seeding step in roomCreate below, beside ensureTree — the same
// shared config/skeletons/room/ template a conversation seeds, copied per-room.)
const roomConfigFile = (name) => `# room ${name} — an operator-created room (the folder IS the room).
# Feed layers come from the shared config/skeletons/room/ template, copied into identity.d/ at creation.
# Add heartbeats:, transcription_service:, or members: blocks here to wire behavior.
# This file is the NEAREST rung: it beats config/config.yaml for any key it sets.
`;

// The friendly member-mode words (the command surface) ↔ the existing room-core state
// tokens (what's stored). The design speaks disable/mention/all; room-core stores the
// full 6-state auto-mode enum. We accept the friendly words, persist the existing token
// — NO parallel state machine. Other stored tokens (off, mention-direct, accum) render
// as themselves and just aren't settable through the disable|mention|all command word.
const MODE_TO_STATE = { disable: 'muted', mention: 'mention', all: 'active' };
const STATE_TO_MODE = { muted: 'disable', mention: 'mention', active: 'all' };
// A one-line gloss for the mode-change confirmation (flagship parity).
const MODE_GLOSS = { disable: 'receives nothing', mention: 'reached only when @mentioned', all: 'receives every message' };
// A brain member's short, addressable id is its adapter name minus the -cdp suffix
// (chatgpt-cdp → chatgpt), so the operator types /members chatgpt … not chatgpt-cdp.
const shortAdapterId = (name) => String(name).replace(/-cdp$/i, '');
// The host of a tab URL for the "no adapter matches <host>" refusal — best-effort.
const hostOf = (url) => { try { return new URL(String(url)).host; } catch { return String(url ?? ''); } };

// The rooms on disk: the immediate subdirectories of EGPT_HOME/conversations/room/ (each
// folder IS a room — a room is a conversation on surface `room`, 2026-08-09). Never throws
// — a missing dir yields []. Injected in tests.
function defaultListRoomNames() {
  try {
    return readdirSync(join(EGPT_HOME, 'conversations', 'room'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch { return []; }
}

const CCODE = 'ccode';

// How many of Chrome's tabs /chrome lists before it collapses the rest into a
// "+N more" — this report lands in a chat window, not a terminal.
const CHROME_TAB_LIMIT = 5;
const trunc = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// Compact uptime: "2h13m" / "13m05s" / "42s". Whole seconds; drops the finest
// unit once hours are in play so /status stays a terse ops line.
function humanizeUptime(sec) {
  const t = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

// Resolve a target chat for `/agents=<slug> …`/`/status <fragment>` (so the operator can name
// a remote chat from the Self DM — was /e auto <mode> <target>'s resolver before /e's whole
// family retired 2026-08-15; /agents' `=<slug>` binding reuses this SAME function verbatim).
// A verbatim @jid / room-id is used as-is;
// otherwise a fuzzy slug/name fragment is matched against contacts. The command's
// OWN surface is searched first (unchanged behavior on a hit there — same-surface
// always wins, even when other surfaces also match); only when the own surface has
// ZERO hits does this fall through to every OTHER known surface (operator 2026-07-05:
// naming a telegram chat from the whatsapp Self DM used to report "no chat matches" —
// resolveTarget never looked past its own surface). The returned object always
// carries the MATCHED `surface`, which may differ from the `surface` param, so
// callers act on the right conversation instead of assuming their own ev.surface.
// Conv-state only: the chat you'd set a mode for is one E has already seen, so it
// is a contact.
function fuzzyHits(state, surface, term) {
  const bucket = state?.contacts?.[surface] ?? {};
  const needle = term.toLowerCase();
  const hits = [];
  for (const [jid, entry] of Object.entries(bucket)) {
    if (!entry || entry.aliasOf || !entry.slug) continue;
    const name = String(entry.pushedName ?? entry.slug);
    if (name.toLowerCase().includes(needle) || String(entry.slug).toLowerCase().includes(needle)) hits.push({ jid, name });
  }
  return hits;
}

function resolveTarget(state, term, surface) {
  if (/[@!]|:beeper/.test(term)) {
    // A verbatim jid must still be a chat E has seen — else patchContact silently
    // no-ops (returns state unchanged) and we'd report a false "✅" for a typo'd or
    // never-seen id. Resolve it through getContact so a bad id fails loudly here.
    // Own surface first, then every other known surface in turn — first found wins
    // (jids are surface-namespaced, so a cross-surface collision isn't a practical
    // concern; no ambiguity handling needed here).
    const c = getContact(state, surface, term);
    if (c) return { jid: c.jid, name: c.slug, surface };
    for (const s of Object.keys(state?.contacts ?? {})) {
      if (s === surface) continue;
      const oc = getContact(state, s, term);
      if (oc) return { jid: oc.jid, name: oc.slug, surface: s };
    }
    return { error: `no chat matches "${term}" — E hasn't seen that chat id` };
  }
  const ownHits = fuzzyHits(state, surface, term);
  if (ownHits.length === 1) return { ...ownHits[0], surface };
  if (ownHits.length > 1) return { error: `"${term}" matches ${ownHits.length}: ${ownHits.slice(0, 6).map((h) => h.name).join(', ')} — be more specific` };
  const crossHits = [];
  for (const s of Object.keys(state?.contacts ?? {})) {
    if (s === surface) continue;
    for (const h of fuzzyHits(state, s, term)) crossHits.push({ ...h, surface: s });
  }
  if (!crossHits.length) return { error: `no chat matches "${term}" — try the exact name or its @jid` };
  if (crossHits.length > 1) return { error: `"${term}" matches ${crossHits.length}: ${crossHits.slice(0, 6).map((h) => `${h.name} (${h.surface})`).join(', ')} — be more specific` };
  return crossHits[0];
}

// A command reply must NEVER itself parse as a command (live incident 2026-07-25). isCommand
// admits ANY operator line that starts with '/', and most replies here open with the command
// they answer ("/status: no chat matches …"). On a shared Beeper account the sibling node sees
// that reply as ordinary operator inbound, answers it through the catch-all — which echoes the
// token and appends a colon — and the two nodes traded hundreds of messages, one colon per hop,
// until the service was killed.
//
// ONE convention, enforced at the ONE reply chokepoint below rather than per message: a reply's
// LEADING command token is wrapped in backticks — `/status`: no chat matches … — so nothing this
// module emits can begin with '/'. Wording is otherwise untouched, and a reply that never started
// with a slash is passed through byte-identically. The class is [a-z0-9_-]*, so trailing
// punctuation stays OUTSIDE the quotes (`/status`: …, not `/status:` …) and a bare '/' still
// gets wrapped — the invariant "a reply never begins with '/'" holds for every input.
const quoteLeadingCommand = (text) => String(text ?? '').replace(/^\/([a-z0-9_-]*)/i, '`/$1`');

// ── NODE-ADDRESSED COMMANDS ─────────────────────────────────────────────────────────────────
// (operator 2026-07-26: "i open a local shell, type '/chrome mo' and a chrome in mo's spine, a
// friend in germany, opens. i can drive it by typing commands on the egpt shell.")
//
// A command may name the NODE it is for. THE SET IS AN ALLOWLIST — the browser family that IS
// the remote control, plus /status and /members:
//
//   /chrome  /tabs  /open  /tab  /close  /status  /members  /config
//
// and nothing outside it is node-addressable, which is the lock: LIFECYCLE (/restart, /upgrade,
// /rewind) and the STOP safe word are deliberately absent, so no envelope arriving from another
// machine can restart, upgrade, rewind or kill this node. The responder reads the SAME allowlist
// before it executes anything, so the lock holds at both ends.
//
// `/members` joined the set 2026-07-26 (HANDOFF C3). It was the one operator command left
// outside, so on a shared Beeper account BOTH co-account nodes answered it — the same
// double-answer the gate exists to end.
//
// `/config` joined the set 2026-07-27 — a config dump/set is node-scoped exactly like /status,
// so the same allowlist keeps it from being answered by every co-account peer instead of just
// the one addressed.
//
// NAMING THE NODE (operator ruling 2026-07-27, revised same day after a live miss): `=<name>`
// binds directly to the COMMAND TOKEN ITSELF — `/tabs=do`, `/status=do`, `/members=do add tab
// 3 cgpt3`, `/open=do https://x.com` — and is the ONE way to name a node for every member of
// the set except /chrome, whose whole argument IS the node (never ambiguous), so `/chrome do`
// keeps its bare positional form AND `/chrome=do` works too. The FIRST cut of this ruling let
// `node=<name>` float anywhere in a command's arguments; typing `/tabs=do` live fell through
// to the catch-all (a `\b` word boundary matched right before the `=`, so the command token
// parsed as plain "tabs" and nothing downstream ever saw a node), which is why it was replaced
// same-day with binding to the token: there is now nowhere for a node marker to float, so
// there is nothing for a URL's own `=` (a query string, `?a=b`) to collide with either. The
// bound `=<name>` is stripped (or, for /chrome, normalized to the bare positional form) before
// the sub-grammar parses. dispatch.default_node (config/config-schema.mjs), UNSET by default,
// is the one exception: a BARE command (no `=<name>`, and for /chrome no positional node
// either) operates on that node instead of "wherever it was heard" when the operator has set
// one; UNSET, every bare form is a strict no-op — today's behaviour, byte for byte.
const NODE_ADDRESSABLE = /^\/(chrome|status|tabs|tab|open|close|members?|config|radio)\b(?:=(\S+))?(?:[ \t]*(.*))?$/i;

// /radio say's PAYLOAD ALONE may contain embedded newlines (operator ruling 2026-08-08: the
// text to read aloud is genuinely free-form prose, unlike every other argument this whole
// command surface takes). NODE_ADDRESSABLE above stays exactly as it was — `[ \t]*(.*)` still
// matches ONE line only, so the 4004d6f smuggling guard (`\s*` would have let a second line
// read as an addressed command's arguments) is untouched for chrome/tabs/tab/open/close/
// members/config/status, AND for /radio's own join/leave/disable. This is a SEPARATE, narrower
// pattern that nodeAddressed only tries once NODE_ADDRESSABLE has already failed to match (i.e.
// only when there IS an embedded newline) — it reads the command token, `=<node>` and the "say"
// verb from the first line exactly like NODE_ADDRESSABLE does, and never touches what follows.
const RADIO_SAY_MULTILINE = /^\/radio(?:=(\S+))?[ \t]+say\b[ \t]*([\s\S]*)$/i;

// The ONE parse both nodeAddressed and makeNodeExplicit build on. `token` is the exact matched
// command word (case preserved, for makeNodeExplicit's wire reconstruction); `cmd` is its
// lowercased form; `rest` is the trailing text — used only by /chrome's positional node form and
// by makeNodeExplicit's rebuild. Returns null when neither pattern matches at all.
function parseNodeAddressable(text) {
  const raw = String(text ?? '').trim();
  const m = NODE_ADDRESSABLE.exec(raw);
  if (m) return { token: m[1], cmd: m[1].toLowerCase(), node: m[2] ?? null, rest: (m[3] ?? '').trim() };
  const rm = RADIO_SAY_MULTILINE.exec(raw);
  if (!rm) return null;
  return { token: 'radio', cmd: 'radio', node: rm[1] ?? null, rest: rm[2] ?? '' };
}

// The SHELL is node-local: the spine dials the operator's editor on 127.0.0.1:23375, so no other
// node ever sees a shell message. NOTE what that does and does not buy (corrected 2026-08-21):
// node-locality is a ROUTING fact, not a security one — loopback is bindable by any local
// account, so the limb AUTHENTICATES the editor (a nonce/HMAC handshake under the node's
// shell.token, src/shell/auth.mjs) before treating its frames as the operator's. What matters
// here is only the routing half. Everywhere else this node speaks is a chat on the shared Beeper
// account, where a co-account peer heard the very same message and answers through its own gate —
// which is exactly why a peer addressed THERE must not also be sent an envelope.
const NODE_LOCAL_SURFACES = new Set(['shell']);

export function createCommands({
  getConfig = () => ({}),
  send: rawSend,                         // (chatId, text) -> deliver a plain system reply
  exit = (code) => process.exit(code),
  writeRewindTarget,
  loadState = null, writeState = null,   // conv-state IO — lets /agents auto persist a mode
  brains = null,                         // the brain registry (createBrains) — /agents' status + access_level, and /status's own preview, resolve a being's live def through it (brainpool.mjs's resolveBeingDef / resolveDefaultBrainDef)
  defaultKey = 'e',                      // the persona being-id (its map key), injected by boot from the single `default:true` agent — the persona's per-conversation mode/state reads+writes and its warm-key prefix all key off this, never a hardcoded 'e' (operator 2026-07-10)
  evictWarm = () => {},                  // (warmKey) -> drop that conversation's warm session so /agents access_level's re-point respawns fresh
  configPath = CONFIG_YAML_PATH,         // where /config <key>=<value> writes — the real profile config.yaml by default (injected in tests, so no test ever touches the real profile)
  io = {},                               // { stat, readFile, writeFile, mkdir, readdir, rm } — real fs by default; /status probes files + the custom branch authors through here
  // CDP seam for /chrome, /tabs, /open, /tab, /close — the real localhost probe by
  // default; tests inject fakes so the suite never needs a live Chrome or a real socket.
  cdp = { isRunning: cdpIsRunning, listTabs: cdpListTabs, cdpHost: cdpHostOf, openTab: cdpOpenTab, activateTarget: cdpActivateTarget, closeTab: cdpCloseTab },
  // Room/member seams (Phase 2). listRoomNames enumerates the saved rooms; loadAdapters
  // yields the web-brain adapters (config/brains/*-cdp.mjs). Both are injected in tests so
  // /rooms + /members run against temp-dir rooms and a fake adapter list — no live profile,
  // no live Chrome, no dynamic import. (A room by NAME is resolved through resolveConvRoom
  // below — surface `room`, chatId = the name — not through a seam of its own.)
  listRoomNames = defaultListRoomNames,
  loadAdapters = defaultLoadAdapters,
  // The conversation-room resolver (bug fix 2026-07-23): (surface, chatId) → the SAME Room the
  // phase-4 relay reads its members from. BOOT INJECTS the shared resolver (contacts.resolve →
  // Room.forChat — the IDENTICAL function boot's roomRelay.resolveMembers uses), so a member
  // added via /members lands in the exact conversations/<surface>/<slug>/config.yaml the relay
  // reads → an @<brain> on that conversation drives the relay. The default here is a read-only
  // fallback (getContact → the known chat's slug) for standalone construction; boot's injected
  // resolver is authoritative and is what guarantees write-here == read-there.
  // THIS is also how an operator-named room is CREATED: surface `room`, chatId = the name —
  // the one room path that mints a contact. Room READS never come here (roomOnDisk resolves
  // the slug purely instead), so a named room needs nothing added to this seam.
  resolveConvRoom = async (surface, chatId) => {
    if (!loadState) return null;
    try { const slug = getContact(await loadState(), surface, chatId)?.slug; return slug ? Room.forChat(surface, slug) : null; }
    catch { return null; }
  },
  // Launch seam for /chrome — fires the Session-1 `egpt-chrome` scheduled task (default:
  // `schtasks /run /tn egpt-chrome`, see defaultLaunchChromeTask). Returns { ok } — false
  // when the task isn't registered (schtasks non-zero) or the spawn errored. Tests inject a
  // fake so no real schtasks runs. This is NOT a direct spawn: a Chrome the spine spawned
  // itself would render on its own Session 0 (see the chrome() dispatch); the task hops to
  // the operator's Session 1 instead, which is the whole point.
  launchChromeTask = defaultLaunchChromeTask,
  // Clock seam for /chrome's post-launch CDP poll — real timers by default; tests inject an
  // advancing fake clock so the ~20s wait is instant and deterministic.
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  // git probe for /status (short sha + subject). Mirrors boot's gitOut so it's
  // fakeable in tests without threading spawnSync through createCommands.
  gitOut = (args) => { try { return spawnSync('git', args, { cwd: process.cwd() }).stdout?.toString().trim() || ''; } catch { return ''; } },
  // /status seams (operator-requested enrichment): warmStats reads the warm-session
  // pool's { size, max, keys } (boot injects pool.stats); shellConnected reports whether
  // the operator's editor is dialed into the shell-port limb (boot injects
  // shellPort.isConnected). Safe no-op defaults so a standalone/test createCommands
  // never touches a real pool or socket.
  warmStats = () => null,
  shellConnected = () => false,
  // The per-target compaction probe (src/tools/compact-being.mjs dueForCompaction) —
  // imported, never re-derived, and injected so a test never reads ~/.claude/projects.
  // /status is the only READER: the compacting itself lives in src/spine/compaction.mjs.
  dueFor = dueForCompaction,
  // /radio say seams — the SAME uploader/gate convention createRadioNoteRelay uses (real
  // uploader by default; gate defaults to a bare passthrough so a standalone/test
  // createCommands that doesn't inject the lasso is unaffected — never a second ceiling).
  uploadNote: uploadNoteFn = uploadNote,
  gate: gateFn = (fn) => fn(),
  // Bare /radio's node-wide report seams. listEntityDirs enumerates every conversation/room
  // entity on this node (THE walk boot.mjs owns, src/spine/boot.mjs ~line 561 — safe no-op
  // default so a standalone/test createCommands never touches real disk); fetch probes a
  // station's status-json.xsl for a live listener count (real global fetch by default — no
  // test may exercise it; tests always inject a fake).
  listEntityDirs = async () => [],
  fetch: fetchFn = globalThis.fetch,
  // Live status-line room reflection (operator 2026-08-16): fired (surface, slug|null) any
  // time currentRoom changes — roomJoin, roomLeave, and roomDelete's bulk clear below. `null`
  // means "no current room" (roomLeave / roomDelete's clear); a slug means "now current"
  // (roomJoin). Safe no-op default so a standalone/test createCommands never needs it — boot
  // injects the real one (recompute computeShellHeader → shellPort.setHeader) for surface 'shell' only.
  onRoomChange = () => {},
  onLog = () => {},
} = {}) {
  const cfg = () => getConfig() ?? {};
  // THE reply chokepoint: every reply this module emits goes out through here, so the
  // no-self-parsing convention (quoteLeadingCommand, above) cannot be missed by a new
  // message — including one added later. Call sites stay `send?.(chatId, text)`.
  // A CAPTURED run diverts this chat's replies into a sink instead of sending them (the mesh
  // responder: the reply must ride home INSIDE the envelope, not be posted raw into the relay
  // chat). Keyed by chatId, and runCaptured's caller supplies an id nothing else uses, so
  // concurrent runs never cross. quoteLeadingCommand still applies — the captured text becomes
  // the body the ORIGIN posts into its own chat, so it must not parse as a command there either.
  const sinks = new Map();   // chatId -> (text) => void
  const send = (chatId, text) => {
    const t = quoteLeadingCommand(text);
    const sink = sinks.get(chatId);
    return sink ? sink(t) : rawSend?.(chatId, t);
  };
  const stat = io.stat ?? fsStat;
  const readFile = io.readFile ?? fsReadFile;
  const writeFile = io.writeFile ?? fsWriteFile;
  const mkdir = io.mkdir ?? fsMkdir;
  const readdir = io.readdir ?? fsReaddir;
  const rm = io.rm ?? fsRm;
  const rename = io.rename ?? fsRename;

  // The current named room, per surface (the shell, a Beeper Self-DM) — NAVIGATION
  // only now: /rooms marks it "(current)", /room <slug> leave clears it. It NO LONGER gates
  // /members (bug fix 2026-07-23: /members operates on the CURRENT CONVERSATION's room, the
  // room the relay reads — see resolveConvRoom). Kept in-memory; a fresh boot starts with none.
  const currentRoom = new Map();   // surface -> room slug
  const surfaceOf = (ev) => ev?.surface ?? 'whatsapp';
  const curRoomName = (ev) => currentRoom.get(surfaceOf(ev)) ?? null;
  // The ONE reader onto the ONE currentRoom map, keyed by surface directly (not an ev) — so
  // boot.mjs's shell-limb wiring can ask "is this surface currently in a named room?" before
  // handing an inbound event to the shared dispatch, without a second current-room map. Still
  // written ONLY by roomJoin/roomLeave below.
  const currentRoomOf = (surface) => currentRoom.get(surface) ?? null;

  // A room-scoped command (/members, /activate, /radio join|leave|say, the r-quickreply) resolves
  // its Room here — the ONE place that reads the mesh mark (bug #23 half A, 2026-07-27,
  // mesh.mjs commandReply). A mesh-delivered command's ev.chatId is a private per-command id
  // (`<chat>#cmd<n>`) that is DIFFERENT on every call — resolving through it mints a fresh
  // contact-<ts> room each time, so an add and a list land in two different rooms and disagree.
  // ev.mesh routes it to THIS node's own lobby instead (surface 'shell', jid 'main' —
  // fixedSlugFor's fixed mapping), through the SAME resolveConvRoom seam every other room
  // resolution uses. Mesh is unconditional and unaffected by anything below.
  //
  // The JOINED-ROOM default (operator 2026-08-17, generalizing the 2026-08-16 /agents-only fix):
  // "this conversation" means the room currently /room join'd on this surface, when one is
  // joined — exactly what redirectShellToRoom (boot.mjs) does for PROSE fan-out and what
  // /agents' own bare-target resolution already did for itself. currentRoomOf's stored value is
  // always a room SLUG (roomJoin: `currentRoom.set(surfaceOf(ev), slug)`, the same slug
  // /room create/join addresses on surface 'room' — see redirectShellToRoom's `network: 'room',
  // chatId: room`), so the fallback resolves it there, never through the caller's own surface.
  // No room joined → currentRoomOf returns null → falls through to today's behavior
  // (surfaceOf(ev), ev.chatId) byte-for-byte, unchanged. This is the ONE choke point every
  // room-scoped command funnels through, so fixing it here fixes all of them at once.
  const convRoomOf = (ev) => {
    if (ev?.mesh) return resolveConvRoom('shell', 'main');
    const joined = currentRoomOf(surfaceOf(ev));
    return resolveConvRoom(joined ? 'room' : surfaceOf(ev), joined ?? ev.chatId);
  };

  // The web-brain adapter list, loaded once (dynamic import of config/brains/*-cdp.mjs)
  // and memoized. adapterFor() resolves a tab URL → its adapter, or null (→ can't add).
  let _adapters = null;
  async function adapterFor(url) {
    if (!_adapters) _adapters = await loadAdapters();
    return matchAdapter(url, _adapters);
  }

  // Beeper accounts REGISTRY (operator 2026-07-08, trusted-network chunk c): a NAMED map
  // of this trusted network's Beeper accounts — which account each node fronts + its own
  // API token. v1 is REGISTRY + OBSERVABILITY ONLY: parsed here once (this runs at
  // construction, i.e. once per boot, not once per /status call) and surfaced by /status
  // as name + ACCOUNT ONLY — the token is discarded right here and never held past this
  // block, so it can't leak into /status, a log line, or an error. PHYSICAL FACT: a token
  // only answers on ITS OWN machine's local API, so acting on a sibling's token is future
  // work, not v1. An entry missing `account` is skipped + logged by name; never crashes.
  const beeperAccounts = (() => {
    const raw = cfg().beeper;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    for (const [name, entry] of Object.entries(raw)) {
      if (name === 'use') continue;   // selector naming the active account, not an entry — never warn
      if (!entry || typeof entry !== 'object' || !entry.account) { onLog(`beeper registry: "${name}" missing account — skipped`); continue; }
      out[name] = entry.account;
    }
    return out;
  })();

  // Per-surface self-DM command channels (operator 2026-07-09): the NEW shape lists them under
  // networks:.<surface>.chat_ids (plural); the OLD shape has <surface>.chat_id (singular). Read
  // BOTH, preferring networks:, always yielding a LIST — a command typed in ANY of the surface's
  // command channels is the operator (a singular chat_id normalizes to a 1-element list).
  function commandChatIds(surface) {
    const c = cfg() ?? {};
    const raw = (c.networks?.[surface] && typeof c.networks[surface] === 'object') ? c.networks[surface]
              : (c[surface] && typeof c[surface] === 'object') ? c[surface] : {};
    return Array.isArray(raw.chat_ids) ? raw.chat_ids : (raw.chat_id != null ? [raw.chat_id] : []);
  }
  // The operator gate — reused by isCommand and every command handler. Same
  // authorization every slash command uses: the origin surface's own Self DM (ids
  // are per-surface namespaces), an authorized sender, or the account owner (isSender).
  function isOperator(ev) {
    // Compare in short space (shortChatId is a no-op on an id that's already short) so a config
    // chat_id in either form still matches the bridge's now-always-short ev.chatId.
    const here = shortChatId(ev?.chatId);
    const inSelfDm = commandChatIds(ev?.surface ?? 'whatsapp').some((id) => shortChatId(id) === here);
    return inSelfDm || !!ev?.authorized || !!ev?.isSender;
  }

  // Which NODE does this line address? The ONE parse behind every node reading below — the
  // origin's "must this travel?", the responder's "is this for me?", and the dispatch gate.
  // Returns { node, cmd, raw } or null. `raw` is the exact substring (immediately trailing the
  // command token) that named the node — run() strips it (or, for /chrome, normalizes it to
  // the bare form) once the gate has passed, so each handler parses exactly what it always did.
  //
  //   /<cmd>=<node>             — bound to the COMMAND TOKEN ITSELF (ruling 2026-07-27): the
  //                               ONE way to name a node, for every member of the set. A `=` in
  //                               an ARGUMENT (a URL's query string, `?a=b`) can never be read
  //                               as a node — it isn't adjacent to the command token, so
  //                               NODE_ADDRESSABLE's own `(?:=(\S+))?` never sees it.
  //   /chrome <node>            — its whole argument IS a node too (never ambiguous), known or
  //                               not: an unknown one is a routing error, never silence.
  //                               `/chrome=<node>` names the same thing.
  //   no node named on the      — no `=<node>`, and (for /chrome) no positional node either —
  //   command token itself        resolves through dispatch.default_node when the operator has
  //                               set one (`raw: ''`, nothing to strip), REGARDLESS of whether the
  //                               command carries arguments (ruling 2026-07-27: default_node
  //                               applies to `/open <url>`, `/members <args>`, etc. just as much
  //                               as to a bare command); UNSET, this is null, byte-identical to
  //                               before.
  function nodeAddressed(text) {
    const hit = parseNodeAddressable(text);
    if (!hit) return null;
    const { cmd, node, rest } = hit;
    if (node) return { node: node.toLowerCase(), cmd, raw: `=${node}` };
    if (cmd === 'chrome' && rest) return { node: rest.toLowerCase(), cmd, raw: rest };
    const dn = String(cfg().dispatch?.default_node ?? '').trim().toLowerCase();
    return dn ? { node: dn, cmd, raw: '' } : null;
  }

  // ORIGIN reading: the node this command must TRAVEL to in order to be answered — null when it
  // stays here. Null for a command outside the allowlist, a command with no node, a node that is
  // one of OURS, and a node that shares this Beeper account and heard the message anyway (that
  // one is the unchanged broadcast + gate: the sibling answers, we say nothing).
  function remoteNode(ev) {
    const hit = nodeAddressed(ev?.body);
    if (!hit) return null;
    if (ownNodeNamesOf(cfg()).has(hit.node)) return null;
    const peers = cfg().account_peers;
    const isPeer = Array.isArray(peers) && peers.some((p) => String(p ?? '').trim().toLowerCase() === hit.node);
    if (isPeer && !NODE_LOCAL_SURFACES.has(String(ev?.surface ?? '').toLowerCase())) return null;
    return hit.node;
  }

  // RESPONDER reading of the SAME parse: an envelope-delivered line is a node-addressable
  // command for THIS node. Same allowlist, so lifecycle can never arrive over the mesh.
  function nodeCommandForMe(text) {
    const hit = nodeAddressed(text);
    return !!hit && ownNodeNamesOf(cfg()).has(hit.node);
  }

  // ORIGIN rewrite, used by the mesh forwarder ONLY (operator 2026-07-27, live miss): a command
  // resolved through THIS node's dispatch.default_node (nodeAddressed's `raw: ''` — nothing was
  // typed to name the node) must travel with the node bound EXPLICITLY to the command token,
  // because the RESPONDER re-parses the SAME wire body through its OWN nodeCommandForMe — and its
  // own default_node may be unset or point elsewhere. Without this, a bare `/tabs` forwarded
  // verbatim resolved to no node at the responder and fell through to the being (CLAUDE Code's
  // own `/stats` answered instead of egpt). An ALREADY-explicit command (`/tabs=do`, `/chrome do`)
  // is returned byte-identical — remoteNode resolved it without consulting default_node, so
  // nothing about the wire form needs to change. Only the command TOKEN is rewritten; arguments
  // (a URL's own `=`, `?a=b`) are never touched.
  function makeNodeExplicit(text, node) {
    const hit = nodeAddressed(text);
    if (!hit || hit.raw) return text;                 // not addressable here, or already explicit
    const parsed = parseNodeAddressable(text);
    if (!parsed) return text;
    return `/${parsed.token}=${node}${parsed.rest ? ` ${parsed.rest}` : ''}`;
  }

  // rs — the RADIO quick reply (operator 2026-08-08): configured the SAME way `r` is
  // (quick_reply_string) — a single top-level string, DEFAULT "rs", "" disables — but its OWN
  // key, not derived from quick_reply_string: `r` addresses whichever AGENT spoke last
  // (router.mjs, no isOperator gate, any sender may use it); `rs` triggers an upload through the
  // SAME isOperator-gated path /radio say does (see radioQuickReply below), so the two need to
  // be nameable/disableable independently.
  const RADIO_QUICK_REPLY_DEFAULT = 'rs';
  function radioQuickReplyToken() {
    const t = cfg().radio_quick_reply_string;
    return t == null ? RADIO_QUICK_REPLY_DEFAULT : String(t).trim();
  }
  function isRadioQuickReply(ev) {
    const t = radioQuickReplyToken();
    return !!t && String(ev?.body ?? '').trim().toLowerCase() === t.toLowerCase();
  }

  // Same id in any form counts as the Self DM (lid vs phone-form — a /restart
  // often arrives as the @lid self-jid). The Self DM is PER-SURFACE now (operator
  // 2026-07-02): a /restart typed in the telegram surface's own chat_id is checked
  // against cfg.telegram.chat_id, not whatsapp's — ids are per-surface namespaces.
  // Fall back to the whatsapp block when ev.surface is absent (safety). Authorized
  // senders (per-surface allowed_users / isSender) can command from anywhere.
  function isCommand(ev) {
    const body = String(ev?.body ?? '').trim();
    if (isOperator(ev) && isRadioQuickReply(ev)) return true;
    if (!body.startsWith('/')) return false;
    return isOperator(ev);
  }

  // Run a command and CAPTURE its reply instead of sending it. Routes through the ONE run()
  // below — same dispatch, same gates, same no-self-parsing chokepoint — so the mesh responder
  // executes exactly what a typed command executes. Returns the joined reply text.
  async function runCaptured(ev) {
    const lines = [];
    sinks.set(ev.chatId, (t) => lines.push(t));
    try { await run(ev); } finally { sinks.delete(ev.chatId); }
    return lines.join('\n\n');
  }

  async function run(ev) {
    let line = String(ev.body ?? '').trim();

    // rs — THE RADIO QUICK REPLY: the one non-slash message isCommand ever routes here for
    // (see isCommand above) — every other non-slash line never reaches run() at all.
    if (isRadioQuickReply(ev)) { await radioQuickReply(ev); return; }

    const code = lifecycleExit(line, { writeRewindTarget });
    if (code != null) {
      onLog(`${line} -> exit ${code}`);
      await exit(code);                    // process leaves (after the bridge's "restarting…" announce); the daemon respawns
      return;
    }

    // THE NODE GATE, once, for the whole node-addressable set — the SAME ownNodeNamesOf
    // /chrome's and /status's own gates already matched, now shared by all six instead of
    // reimplemented per command. A line naming a node that is NOT ours only reaches here
    // because that node shares this Beeper account and heard the message too (the spine
    // forwards every other case, see remoteNode): it answers, we say NOTHING AT ALL — the
    // same deliberate silence, so exactly one node answers on a shared account. Bare forms
    // and everything outside the set fall through untouched.
    const addressed = nodeAddressed(line);
    if (addressed && !ownNodeNamesOf(cfg()).has(addressed.node)) return;
    // `=<name>` bound to the command token (or the bare dispatch.default_node stand-in, raw:
    // '') has done its job — drop it so each command's own grammar is unchanged (`/tab=do 3`
    // parses as `/tab 3`). Bound to the token, stripping is just cutting the `=<name>` back out
    // of the command word — the arguments after it are never touched. /chrome is the one
    // exception (ruling 2026-07-27): its whole argument IS the node, so an explicit `=<name>`
    // normalizes to the bare positional form instead of vanishing, and its own positional form
    // (raw === the whole argument, no leading "=") needs no stripping at all.
    if (addressed?.raw) {
      const named = addressed.raw.startsWith('=');
      if (addressed.cmd === 'chrome' && named) line = line.replace(addressed.raw, ` ${addressed.node}`);
      else if (named) line = line.replace(addressed.raw, '');
    }

    // /agents[=<slug>] <handle>|all [reset|restart|auto <mode>|access_level <all|regular>] —
    // the general per-being command surface (operator 2026-08-15, retires /e + /egpt entirely).
    // /e's whole family was hardcoded to defaultKey (the persona's own map key) — "a failure
    // in design" now that every resident being (the persona AND a sibling like wren) is
    // configured identically under agents.<being> with no per-conversation freeze (phase 1/2):
    // `/e reset` wiped ONLY agents.<defaultKey>, so a sibling resident on the very same
    // conversation survived untouched by a reset meant to cover "this conversation". /agents
    // fixes that by taking the being explicitly, never assuming defaultKey.
    //
    //   /agents[=<slug>] <handle>|all                        → status (bare, see agentsStatus)
    //   /agents[=<slug>] <handle>|all reset                  → archive + wipe + reseed
    //   /agents[=<slug>] <handle>|all restart                → clear ONLY threadId, everything else survives
    //   /agents[=<slug>] <handle>|all auto <mode>             → was /e auto <mode>
    //   /agents[=<slug>] <handle>|all access_level <all|regular>  → was /e access all|regular
    //
    // `=<slug>` is a PRIVATE convention parsed by THIS regex alone — it is bound directly to
    // the command token exactly like NODE_ADDRESSABLE's `=<name>` (`/chrome=kg`, `/tab=do 3`,
    // see the § NODE-ADDRESSED COMMANDS block above), which is what it's modeled on, but it is
    // NOT that system: NODE_ADDRESSABLE's allowlist (chrome|status|tabs|tab|open|close|
    // members?|config|radio) deliberately excludes /agents, so nodeAddressed(line) returns
    // null for any `/agents...` line and never touches it — no interference either way.
    // Omitted = the CURRENT conversation (ev.surface/ev.chatId), exactly like today's bare
    // /e reset/auto/access. Given = resolved through resolveTarget — the SAME fuzzy/jid
    // resolver /e auto <mode> <target> and /e reset <target> already used, reused verbatim
    // (same error/ambiguity semantics). `<handle>` is a being's agents.<being> map key
    // (`e`, `wren`, …); `all` applies the subcommand to every being residentsOf() finds on
    // that conversation's entry. See agentsCmd() for the full dispatch.
    const agentsMatch = /^\/agents(?:=(\S+))?(?:\s+(.+?))?\s*$/i.exec(line);
    if (agentsMatch) {
      const args = (agentsMatch[2] ?? '').trim().split(/\s+/).filter(Boolean);
      await agentsCmd(ev, agentsMatch[1] || null, args);
      return;
    }

    // /status [<target>] — bare: one compact ops line with live node health (unchanged
    // byte-for-byte; BOTH co-account nodes answer, on purpose). `/status <fragment>`
    // targets a SPECIFIC conversation instead — resolved through the same resolveTarget
    // /agents' `=<slug>` binding uses — and reports that conversation's operator-facing
    // facts (§ statusTarget). Every probe in both forms is wrapped: any failure degrades
    // to '?' so /status NEVER throws.
    //
    // NODE-FIRST (operator ruling 2026-07-25): a <target> naming a NODE is a node
    // question, resolved through the SAME wake-word gate /chrome <node> uses — this
    // node's own names win, a sibling's name is silent. See § statusNodeGate.
    const statusMatch = /^\/status(?:\s+(.+))?\s*$/i.exec(line);
    if (statusMatch) {
      const target = statusMatch[1]?.trim() || null;
      if (target) {
        const gate = statusNodeGate(target);
        if (gate === 'silent') return;                                     // a sibling node was addressed, not us
        if (gate === 'mine') { await send?.(ev.chatId, await status(ev)); return; }
      }
      await send?.(ev.chatId, target ? await statusTarget(ev, target) : await status(ev));
      return;
    }

    // /chrome [<node>] — ATTACH-ONLY status of the local Chrome, answered ONLY by the
    // addressed node. Must stay BEFORE the catch-all at the end of this dispatch (it
    // answers ANY /token, so a fall-through would silently swallow /chrome) — that
    // ordering IS test-enforced: the /chrome tests assert its real reply, and they fail
    // the moment it reaches the catch-all instead. It does NOT interact with /agents' own
    // dispatch above: /agents' match is ANCHORED at ^/agents, so it can never match /chrome.
    const chromeMatch = /^\/chrome(?:\s+(.+?))?\s*$/i.exec(line);
    // dispatch.default_node resolves a truly bare `/chrome` to a node (addressed.raw === '')
    // without leaving anything in `line` to capture — fall back to the gate's own resolution
    // (already verified OURS, above) so the report is sent instead of the discovery hint.
    if (chromeMatch) { await chrome(ev, chromeMatch[1]?.trim() || addressed?.node || null); return; }

    // /tabs, /open <url>, /tab <n>, /close <n> — Phase 1 browser command wrappers, thin
    // dispatch over cdp.mjs's listTabs/openTab/activateTarget/closeTab (no CDP knowledge
    // lives here). Same slot as /chrome: matched BEFORE the catch-all so none of the four
    // leak to E. /tab and /close address a tab by the 1-based number /tabs prints —
    // resolved fresh against listTabs() on every call, never a stale index carried over
    // from an earlier /tabs (Chrome's own tab order can shift between commands).
    const tabsMatch = /^\/tabs\s*$/i.exec(line);
    if (tabsMatch) { await send?.(ev.chatId, await tabsReport()); return; }
    const openMatch = /^\/open\s+(\S+)\s*$/i.exec(line);
    if (openMatch) { await send?.(ev.chatId, await openTabCmd(openMatch[1])); return; }
    const tabMatch = /^\/tab\s+(\d+)\s*$/i.exec(line);
    if (tabMatch) { await send?.(ev.chatId, await activateTabCmd(Number(tabMatch[1]))); return; }
    const closeMatch = /^\/close\s+(\d+)\s*$/i.exec(line);
    if (closeMatch) { await send?.(ev.chatId, await closeTabCmd(Number(closeMatch[1]))); return; }

    // /rooms — Phase 2: list the saved rooms (bare), or an ALIAS of /room <verb>
    // <room> (`/rooms join devwork` == `/room join devwork`). Matched BEFORE /room: the
    // /room regex can't match "/rooms" (the trailing 's' is neither whitespace nor end),
    // but keeping /rooms first makes the alias intent explicit. Same pre-catch-all slot.
    const roomsMatch = /^\/rooms(?:\s+(\S+))?(?:\s+(.+?))?\s*$/i.exec(line);
    if (roomsMatch) {
      const verb = roomsMatch[1]?.toLowerCase() || null;
      if (!verb) { await send?.(ev.chatId, await roomsList(ev)); return; }
      await room(ev, verb, roomsMatch[2]?.trim() || null);   // alias: /rooms <verb> <room>
      return;
    }

    // /room <verb> [<room>] — Phase 2 rooms & members, verb-first (bug fix 2026-08-07: the
    // old slug-first grammar let an unrecognized first token default to a room lookup — see
    // the room() comment below). Slots in exactly like /chrome: a dispatch match BEFORE the
    // final generic catch-all.
    const roomMatch = /^\/room(?:\s+(\S+))?(?:\s+(.+?))?\s*$/i.exec(line);
    if (roomMatch) { await room(ev, roomMatch[1]?.toLowerCase() || null, roomMatch[2]?.trim() || null); return; }

    // /members … — the CURRENT room's roster. Bare: list. `add tab <n>`: adapter-match a
    // Chrome tab and add it as a disabled brain. `<id> mode <disable|mention|all>`: flip a
    // member's mode. Pre-catch-all so none leak to E. `/member` (singular) is accepted too
    // (operators type both) — same handler.
    const membersMatch = /^\/members?(?:\s+(.+?))?\s*$/i.exec(line);
    if (membersMatch) { await members(ev, membersMatch[1]?.trim() || null); return; }

    // /radio [join|leave] — WHICH node relays the CURRENT CONVERSATION's room to the
    // internet radio station (config + command only, see radio() below). Pre-catch-all,
    // node-addressable like /status/members/config (see NODE_ADDRESSABLE above).
    //
    // "say" is matched FIRST, separately, with a payload group that spans lines ([\s\S]*) — the
    // text to read aloud is the one argument in this whole command surface that is genuinely
    // free-form prose (operator ruling 2026-08-08). join/leave/disable fall through to the
    // ORIGINAL single-line grammar below, unchanged — their arguments are always one token.
    const radioSayMatch = /^\/radio\s+say\b[ \t]*([\s\S]*)$/i.exec(line);
    if (radioSayMatch) { await radio(ev, 'say', radioSayMatch[1]?.trim() || null, addressed); return; }
    const radioMatch = /^\/radio(?:\s+(\S+))?(?:\s+(.+?))?\s*$/i.exec(line);
    if (radioMatch) { await radio(ev, radioMatch[1]?.toLowerCase() || null, radioMatch[2]?.trim() || null, addressed); return; }

    // /config [<key>[=<value>]] — bare: a redacted dump of the live config. `<key>` alone: a
    // GET. `<key>=<value>`: resolve <key> through config-schema.mjs (dotted path or bare leaf),
    // parse <value> like the extension prototype does, write it, and confirm the RESOLVED path.
    // Pre-catch-all, node-addressable like /status/members (see NODE_ADDRESSABLE above).
    const configMatch = /^\/config(?:\s+(.+?))?\s*$/i.exec(line);
    if (configMatch) { await send?.(ev.chatId, await configCmd(configMatch[1]?.trim() || null)); return; }

    // /help — the interpreter's registry + helpText renderer own the command list and its
    // 'wired' honesty marker (src/interpreter.mjs); this just resolves the surface and
    // sends it. Every command reaching this node's operator does so through the spine, so
    // there is only one surface to resolve here: 'shell' — the extension reads the
    // registry directly (App.jsx), never through this dispatcher. Pre-catch-all, same slot
    // as /config/status/room.
    const helpMatch = /^\/help\b/i.exec(line);
    if (helpMatch) { await send?.(ev.chatId, helpText([], 'shell')); return; }

    // /activate <id> — reopen a brain member whose Chrome tab was closed (its saved
    // targetId is no longer live), refreshing its targetId. A no-op when already live.
    const activateMatch = /^\/activate\s+(\S+)\s*$/i.exec(line);
    if (activateMatch) { await activate(ev, activateMatch[1]); return; }

    // /e and /egpt carry NO special meaning any more (retired 2026-08-15 — see § /agents
    // above, which replaces the whole family). A bare `/e` or `/e <anything>` no longer gets
    // its own usage reply; it falls straight through to the generic catch-all below, exactly
    // like any other unrecognized token.
    const tok = line.split(/\s+/)[0];
    await send?.(ev.chatId, `${tok}: recognized — lifecycle (/restart, /upgrade, /rewind) + /agents + /status are wired in v2 so far.`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // /chrome [<node>] — Chrome status from the addressed node; LAUNCHES one when none
  // is listening, then attaches.
  //
  // ⚠️ THE SPINE STILL MUST NOT SPAWN CHROME DIRECTLY. DO NOT REPLACE THE TASK HOP
  //    BELOW WITH A bare spawn()/spawnChrome(). ⚠️
  //
  // The spine runs as a Windows SERVICE, which means Session 0. The operator's desktop
  // is Session 1. (Verified live 2026-07-15: spine pid 19696 SessionId 0, explorer.exe
  // SessionId 1.) A child process INHERITS its parent's session, so a Chrome the spine
  // spawned itself would render on Session 0's isolated, headless-in-practice desktop —
  // the operator would never see the window, and the only symptom would be a browser
  // that "starts" and is invisible.
  //
  // The HOP around that is a scheduled task registered with LogonType Interactive: it runs
  // in the operator's Session 1, and the Session-0 spine triggers it with `schtasks /run /tn
  // egpt-chrome` (the injected launchChromeTask seam). This is exactly the proven pattern of
  // the egpt-lock-on-logon task (rundll32 LockWorkStation, Interactive) fired from Session 0.
  // setup/register-chrome-task.ps1 registers it once per node; until then the launch seam
  // reports { ok:false } and /chrome falls back to handing over the command line, as before.
  //
  // ATTACHING is fine across sessions: CDP is plain localhost HTTP, and the session boundary
  // isolates window stations/desktops, not the loopback network. This is exactly how the
  // bridge already reaches Beeper Desktop at 127.0.0.1:23373 from Session 0.
  //
  // NODE GATE: `<node>` is matched against this node's own names (node_name ∪ node_alias,
  // via the shared ownNodeNamesOf). A non-match replies NOTHING AT ALL — the same
  // wake-word principle the mesh uses, so on the shared Beeper account exactly one node
  // answers. An UNKNOWN node name is a non-match too, and therefore also silent: if every
  // node answered "unknown node" the operator would get the double-answer the gate exists
  // to prevent. Bare /chrome is the one exception — it's the discovery path, so each node
  // answers with a short usage line naming itself (never the status payload).
  async function chrome(ev, arg) {
    const own = ownNodeNamesOf(cfg());
    if (!arg) { await send?.(ev.chatId, `/chrome <node> — Chrome status from a node. This node answers to: ${[...own].join(', ') || '(no node_name set)'}`); return; }
    if (!own.has(arg.toLowerCase())) return;   // not addressed → silent, on purpose (BEFORE any launch)
    await send?.(ev.chatId, await chromeReport());
  }

  // The report body. Every probe is wrapped: an unreachable Chrome is the NORMAL resting
  // state, not an error. When none is listening we fire the Session-1 launch task and poll
  // CDP until it comes up, then attach; a task that isn't registered, or a Chrome that never
  // binds its port, degrades to the launch hint. Never throws.
  async function chromeReport() {
    let host = '?';
    try { host = await cdp.cdpHost(); } catch { host = '?'; }

    // Is Chrome already up? (isRunning is the launch decision — NOT whether listTabs works.)
    let running = false;
    try { running = await cdp.isRunning(); } catch { running = false; }

    // Not listening → fire the Session-1 launch task, then poll for it to bind its CDP port.
    // A task that isn't registered (launch seam → { ok:false }) or a Chrome that never comes
    // up within the timeout both fall back to the hint + a one-line setup note.
    if (!running) {
      let ok = false;
      try { ok = !!launchChromeTask()?.ok; } catch { ok = false; }
      if (ok) running = await waitForChromeUp();
      if (!running) return chromeLaunchHint(host, { setupNote: true });
    }

    // Reachable (already, or after a successful launch) → attach + report tabs. A tab-list
    // hiccup on a live Chrome degrades to the hint WITHOUT the launch note (Chrome is up).
    let tabs = null;
    try { tabs = await cdp.listTabs(); } catch { tabs = null; }
    if (!tabs) return chromeLaunchHint(host);

    const lines = [`attached: ${host}`, `tabs: ${tabs.length}`];
    // A few tabs only, each truncated — this lands in a chat, not a terminal.
    for (const t of tabs.slice(0, CHROME_TAB_LIMIT)) {
      lines.push(`  · ${trunc(t?.title ?? '(untitled)', 48)}`);
      lines.push(`    ${trunc(t?.url ?? '', 72)}`);
    }
    if (tabs.length > CHROME_TAB_LIMIT) lines.push(`  … +${tabs.length - CHROME_TAB_LIMIT} more`);
    return '```yaml\n' + lines.join('\n') + '\n```';
  }

  // Poll cdp.isRunning() until Chrome binds its port or the timeout elapses. The clock is
  // injected (now/sleep), so tests advance a fake clock and never wait real time. A probe
  // that throws mid-poll counts as "not up yet", never aborts.
  async function waitForChromeUp() {
    const deadline = now() + CHROME_LAUNCH_TIMEOUT_MS;
    while (now() < deadline) {
      let up = false;
      try { up = await cdp.isRunning(); } catch { up = false; }
      if (up) return true;
      await sleep(CHROME_LAUNCH_POLL_MS);
    }
    return false;
  }

  // No Chrome listening → tell the operator exactly what to run, in their own session. The
  // command line is built from chrome-launcher's OWN flag set (chromeArgs), so it can never
  // drift from what the repo would actually spawn; the port is derived from the CDP host the
  // node will attach to, so the two always agree. `setupNote` appends the one-liner to enable
  // one-command launch (registering the Session-1 task) — shown only on the launch-fallback
  // paths, not when Chrome is up but tab-listing hiccupped.
  function chromeLaunchHint(host, { setupNote = false } = {}) {
    const port = String(host).split(':')[1] ?? '9221';
    const exe = findChromeExecutable() ?? 'chrome';
    const args = chromeArgs({ port, userDataDir: CHROME_BRAIN_PROFILE });
    const lines = [
      `no Chrome is listening on ${host}.`,
      `I can't open it myself — I run as a service in another Windows session, so any Chrome I start would be invisible to you.`,
      `Run this in your own session and I'll attach:`,
      '```\n' + chromeCommandLine(exe, args) + '\n```',
    ];
    if (setupNote) lines.push(`(run setup/register-chrome-task.ps1 on this node once to enable launch)`);
    return lines.join('\n');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // /tabs — same fenced-yaml shape as /chrome's tab list, but WITH the 1-based index
  // /tab and /close address. A listTabs() failure (no Chrome reachable) degrades to a
  // one-line note, same "never throw" ethos as chromeReport.
  async function tabsReport() {
    let tabs;
    try { tabs = await cdp.listTabs(); } catch { return 'no Chrome to list tabs from — try /chrome first'; }
    const lines = [`tabs: ${tabs.length}`];
    tabs.forEach((t, i) => {
      lines.push(`  ${i + 1} · ${trunc(t?.title ?? '(untitled)', 48)}`);
      lines.push(`      ${trunc(t?.url ?? '', 72)}`);
    });
    return '```yaml\n' + lines.join('\n') + '\n```';
  }

  // /open <url> — open a new tab at url. The tab hasn't loaded yet the instant it opens
  // (nothing to title it by), so the reply names it by the url just opened.
  async function openTabCmd(url) {
    try { await cdp.openTab(url); return `opened: ${url}`; }
    catch (e) { return `/open: failed — ${e?.message ?? e}`; }
  }

  // Resolve the operator's 1-based /tab or /close index against a FRESH listTabs() call
  // (see the dispatch comment above for why: never a stale index). Returns { tab } or
  // { error } — callers never throw on a bad index.
  async function nthTab(n) {
    let tabs;
    try { tabs = await cdp.listTabs(); } catch { return { error: 'no Chrome to list tabs from — try /chrome first' }; }
    const tab = tabs[n - 1];
    if (!tab) return { error: `no tab ${n} — ${tabs.length} open` };
    return { tab };
  }

  // /tab <n> — activate (focus) the nth listed tab.
  async function activateTabCmd(n) {
    const { tab, error } = await nthTab(n);
    if (error) return `/tab: ${error}`;
    try { await cdp.activateTarget(tab.id); return `activated ${n} · ${trunc(tab?.title ?? '(untitled)', 48)}`; }
    catch (e) { return `/tab: failed — ${e?.message ?? e}`; }
  }

  // /close <n> — close the nth listed tab.
  async function closeTabCmd(n) {
    const { tab, error } = await nthTab(n);
    if (error) return `/close: ${error}`;
    try { await cdp.closeTab(tab.id); return `closed ${n} · ${trunc(tab?.title ?? '(untitled)', 48)}`; }
    catch (e) { return `/close: failed — ${e?.message ?? e}`; }
  }

  const ROOM_USAGE = 'usage: /room create <name> | /room join|leave|members <room> | /room delete [force] <room>';
  // A slug with no folder on disk — the members path and the delete path both need to say
  // this instead of acting as though it exists (bug fix 2026-08-07: "/room help" rendered
  // "help (0 members)", a roster fabricated for a room that was never created — 'help' just
  // happened to parse as a slug under the OLD slug-first grammar, like any typo would).
  const noRoomMsg = (slug) => `no room '${slug}' — /rooms lists them, /room create ${slug} makes it`;

  // ─────────────────────────────────────────────────────────────────────────────
  // /room — the named-room router (Phase 2). VERB-first: the first token is always matched
  // against the fixed verb set {create, join, leave, members, delete, help} and the room
  // name comes from `rest`. This replaced a slug-first grammar (first token = room, second
  // = sub-verb) after a live bug: an unrecognized first token silently defaulted to
  // sub==='members' and was looked up as a room name, so "/room help" rendered a fabricated
  // "help (0 members)" roster. Under this grammar an unrecognized first token NEVER touches
  // a room — it just gets the usage/unknown-verb reply. `/rooms` (list) and `/rooms <verb>
  // <room>` (alias) route through here too. `first === 'help'` is special-cased to the
  // usage line, same slot as a falsy first token.
  async function room(ev, first, rest) {
    if (!first || first === 'help') { await send?.(ev.chatId, ROOM_USAGE); return; }
    if (first === 'create') { await roomCreate(ev, rest); return; }
    if (first === 'join') {
      if (!rest) { await send?.(ev.chatId, ROOM_USAGE); return; }
      await roomJoin(ev, rest); return;
    }
    if (first === 'leave') {
      if (!rest) {
        const current = curRoomName(ev);
        if (!current) { await send?.(ev.chatId, 'not in any room'); return; }
        await roomLeave(ev, current); return;
      }
      await roomLeave(ev, rest); return;
    }
    if (first === 'members') {
      if (!rest) { await send?.(ev.chatId, ROOM_USAGE); return; }
      // Render a roster ONLY for a room that actually exists — the fabricated-empty-room
      // bug this guards against (see noRoomMsg above).
      const room = await roomOnDisk(rest);
      if (!room) { await send?.(ev.chatId, noRoomMsg(rest)); return; }
      // Labelled by the room's OWN slug, not the raw token — `/room members FOO` is the
      // room `foo`, and the roster should say which room it actually read.
      await send?.(ev.chatId, await renderMembers(ev, room, room.slug)); return;
    }
    if (first === 'delete') {
      const forceMatch = /^force\s+(.+)$/i.exec(rest || '');
      const force = !!forceMatch;
      const name = forceMatch ? forceMatch[1] : rest;
      if (!name) { await send?.(ev.chatId, ROOM_USAGE); return; }
      await roomDelete(ev, name, force); return;
    }
    // Any other first token is an unrecognized verb — NEVER a room lookup (the property the
    // slug-first bug violated): no roomOnDisk/stat call, nothing room-shaped touched.
    await send?.(ev.chatId, `/room: unknown verb "${first}" — create|join|leave|members|delete`);
  }

  // /agents[=<slug>] <handle>|all [reset|restart|auto <mode>|access_level <all|regular>] — THE
  // dispatcher (operator 2026-08-15, retires the whole /e/egpt family — see its own comment
  // at the dispatch site above for the "failure in design" this closes). Parses the already-
  // tokenized args ([handle-or-'all', subcommand?, value?] — the regex above split them),
  // validates the subcommand + its value up front, resolves the target conversation through
  // slugArg (bare = HERE, given = resolveTarget — identical to /e auto/reset's <target>), then
  // resolves the handle set (a single being, or every residentsOf() entry for `all`, ordered
  // defaultKey-first when resident so the persona reads first in a multi-being reply/status),
  // and routes to the per-subcommand handler. Every handler below takes the ALREADY-resolved
  // (surface, jid, where, handles[, state]) — none of them re-parse or re-resolve.
  async function agentsCmd(ev, slugArg, args) {
    const [handleArg, subRaw, valueRaw] = args;
    if (!handleArg) { await send?.(ev.chatId, 'usage: /agents[=<slug>] <handle>|all [reset|restart|auto <mode>|access_level <all|regular>]'); return; }
    if (!loadState || !writeState) { await send?.(ev.chatId, '/agents: conversation state not wired'); return; }
    const sub = subRaw?.toLowerCase() || null;
    if (sub && !['reset', 'restart', 'auto', 'access_level'].includes(sub)) {
      await send?.(ev.chatId, `/agents: unknown subcommand "${subRaw}" — reset|restart|auto <mode>|access_level <all|regular>`);
      return;
    }
    if (sub === 'auto') {
      const mode = valueRaw?.toLowerCase() || null;
      if (!mode) { await send?.(ev.chatId, `/agents: auto needs a mode — one of: ${AUTO_MODES.join(', ')}`); return; }
      if (!isAutoMode(mode)) { await send?.(ev.chatId, `/agents: unknown mode "${mode}" — use one of: ${AUTO_MODES.join(', ')}`); return; }
    }
    if (sub === 'access_level' && valueRaw?.toLowerCase() !== 'all' && valueRaw?.toLowerCase() !== 'regular') {
      await send?.(ev.chatId, 'usage: /agents <handle>|all access_level all|regular');
      return;
    }

    let state;
    try { state = await loadState(); } catch (e) { await send?.(ev.chatId, `/agents: failed — ${e?.message ?? e}`); return; }

    // `=<slug>` resolution (see the dispatch-site comment for why this is NOT
    // NODE_ADDRESSABLE): bare = the CURRENT conversation, given = resolveTarget, byte-for-byte
    // the same fuzzy/jid resolver + error/ambiguity shapes /e auto <mode> <target> and /e
    // reset <target> already used.
    //
    // Bug fix (operator 2026-08-16): a bare invocation used to mean "this chat" even when the
    // operator had /room join'd a room — silently writing to the shell's own lobby instead of
    // the joined room. roomLeave already treats currentRoom as the natural bare-invocation
    // default; /agents now follows the same precedent, resolving the joined room through the
    // SAME resolveTarget the explicit `=<slug>` branch uses above, so an explicit slug still
    // wins outright and only the no-slug case picks up the room default.
    let surface = ev.surface, jid = ev.chatId, where = 'here';
    if (slugArg) {
      const r = resolveTarget(state, slugArg, ev.surface);
      if (r.error) { await send?.(ev.chatId, `/agents: ${r.error}`); return; }
      surface = r.surface; jid = r.jid; where = `for ${r.name}`;
    } else {
      const room = currentRoomOf(ev.surface);
      if (room) {
        const r = resolveTarget(state, room, ev.surface);
        if (r.error) { await send?.(ev.chatId, `/agents: ${r.error}`); return; }
        surface = r.surface; jid = r.jid; where = `for ${r.name}`;
      }
    }

    // `all` = every being residentsOf() finds on that conversation's entry — the exact
    // registry-block owner /room's members roster is silent on (residentsOf reads
    // entry.agents.<being> blocks, conversations-state.mjs). Ordered defaultKey-first (when
    // resident) so the persona is always the first block/reply in a multi-being result; the
    // rest keep residentsOf()'s own order.
    let handles;
    if (handleArg === 'all') {
      const entry = getContact(state, surface, jid)?.entry;
      handles = residentsOf(entry);
      if (handles.includes(defaultKey)) handles = [defaultKey, ...handles.filter((h) => h !== defaultKey)];
      if (!handles.length) { await send?.(ev.chatId, `/agents: no resident beings ${where}`); return; }
    } else {
      handles = [handleArg];
    }

    if (sub === 'reset') { await agentsReset(ev, surface, jid, where, handles, state); return; }
    if (sub === 'restart') { await agentsRestart(ev, surface, jid, where, handles, state); return; }
    if (sub === 'auto') { await agentsAuto(ev, surface, jid, where, handles, valueRaw.toLowerCase(), state); return; }
    if (sub === 'access_level') { await agentsAccessLevel(ev, surface, jid, where, handles, valueRaw.toLowerCase(), state); return; }
    await send?.(ev.chatId, agentsStatus(surface, jid, handles, state));
  }

  // /agents[=<slug>] <handle>|all reset — was /e reset, generalized to any being (or every
  // resident): restart a conversation from scratch — archive its whole folder aside (never
  // delete), wipe the TARGET being(s)' registry state, reseed a pristine tree at the SAME
  // path. Operator framing (unchanged from /e reset): "restarting a conversation needs some
  // steps... like when creating a conversation from scratch. archive old folder, receive a
  // pristine new (can be synthetic) message" — and "it works the same for rooms and
  // conversations alike", so this is still the ONE path both a room and an ordinary
  // conversation take, via convRoomOf for the bare (HERE) case or resolveConvRoom(surface,
  // jid) once a <slug> has been resolved (the same resolver /members uses). No synthetic
  // Claude turn is spawned here — once state is wiped, the next real inbound message gets
  // fresh-thread treatment automatically (brainpool.mjs: `if (!sessionId) await
  // rollTranscript(...)`).
  //
  // THE SCOPING FIX (operator 2026-08-15, "a failure in design"): /e reset always wiped ONLY
  // `agents.<defaultKey>`, so a sibling being (e.g. wren) resident on the very same
  // conversation survived untouched by a reset the operator meant to cover "this
  // conversation". deleteBeing is looped over the CALLER-resolved `handles` (one handle, or
  // every residentsOf() entry for `all`) instead of a hardcoded defaultKey — a being NOT
  // named by this call keeps its own agents.<sibling> block byte-for-byte untouched.
  //
  // access_level/allowed_users SURVIVE (operator ruling 2026-08-17): they are durable
  // operator-set GRANTS, not session state — "reset should reset the thread-id, transcript,
  // etc, not the access_level, nor allowed_users". Captured per handle via getBeing BEFORE the
  // wipe, reapplied via patchBeing AFTER deleteBeing + reseed. A being with neither set has
  // nothing to reapply and is wiped exactly as before.
  async function agentsReset(ev, surface, jid, where, handles, state) {
    const room = (where === 'here') ? await convRoomOf(ev) : await resolveConvRoom(surface, jid);
    if (!room) { await send?.(ev.chatId, "can't resolve this conversation's room"); return; }

    // Archive location (operator 2026-08-15 ruling): a FLAT conversations/archive/ subtree
    // directly under EGPT_HOME — `conversations/archive/<slug>-archived-<slugSuffix>/` — NOT
    // nested under the surface (a room's and a whatsapp conversation's archived folders land
    // in the same flat directory, not archive/room/... vs archive/whatsapp/...). Was
    // `<baseDir>-archived-<slugSuffix>` (sibling of the live folder, same parent) — moved so
    // an operator browsing conversations/<surface>/ never sees a dead reset folder mixed in
    // with live ones. mkdir the archive root first: rename() needs its destination's parent
    // to already exist, and this is the first path under conversations/ that needs one made
    // on demand.
    const archiveRoot = join(EGPT_HOME, 'conversations', 'archive');
    const archivedDir = join(archiveRoot, `${room.slug}-archived-${slugSuffix()}`);
    const base = room.baseDir();
    // A contact with no folder ever created (edge case: no turn has run yet) has nothing to
    // archive — tolerate a missing source and proceed to reseed rather than crash.
    try { await mkdir(archiveRoot, { recursive: true }); await rename(base, archivedDir); } catch { /* nothing to archive yet */ }

    // Wipe EACH target being's registry state OUTRIGHT (deleteBeing, not a merge) — the WHOLE
    // `agents.<handle>` block (mode, threadId, threadCreatedAt, identityInjectedAt,
    // send_to_egpt, …) is gone per handle, so getBeing(...).present reads back false for it,
    // matching a never-instanced contact — EXCEPT access_level/allowed_users, which are
    // preserved-then-reapplied below (operator ruling 2026-08-17: "reset should reset the
    // thread-id, transcript, etc, not the access_level, nor allowed_users" — durable
    // operator-set GRANTS, not session state; access_level in particular is now mandatory for
    // brainpool.mjs's turn() to run a being at all, so silently downgrading it here previously
    // could strand a being with no access). A resident being NOT in `handles` is untouched
    // (see the scoping-fix comment above).
    const preserved = handles.map((h) => {
      const b = getBeing(state, surface, jid, h);
      const fields = {};
      if (b?.accessLevel != null) fields.access_level = b.accessLevel;
      if (b?.allowedUsers != null) fields.allowed_users = b.allowedUsers;
      return [h, fields];
    });
    let next = state;
    for (const h of handles) next = deleteBeing(next, room.surface, room.slug, h);
    for (const [h, fields] of preserved) {
      if (Object.keys(fields).length) next = patchBeing(next, surface, jid, h, fields);
    }
    try { await writeState(next); } catch (e) { onLog(`/agents reset ${ev.chatId}: ${e?.message ?? e}`); }

    // Reseed a pristine tree at the ORIGINAL path — the same two calls /room create makes
    // for a brand-new room. No config.yaml write: neither call writes one, matching what a
    // genuinely first-contact conversation has.
    await room.ensureTree({ io: { mkdir } });
    await seedIdentityLayers(room, 'egpt', { io: { mkdir, readFile, writeFile } });

    // Operator ruling (2026-08-15): "if you moved the folder the operation was successful or
    // not" — the confirmation reports success/failure ONLY, never the archive destination
    // (dropped the old `archiveNote`/`archived` plumbing that used to build a path string
    // into this reply).
    await send?.(ev.chatId, `✅ ${room.slug} reset ${where === 'here' ? '' : where + ' '}— ${handles.join(', ')} state cleared (access_level/allowed_users preserved), next message starts fresh.`);
  }

  // /agents[=<slug>] <handle>|all restart — NARROWER than reset (operator 2026-08-15 ruling,
  // decided directly against `reset`'s big archive-and-wipe): clears ONLY the target
  // being(s)' `threadId` via patchBeing (a merge, NOT deleteBeing) — `mode`, `access_level`,
  // and every other field on the being's block survive byte-for-byte. The conversation
  // folder (transcript.md, media/, files/, identity.d/) is never archived or otherwise
  // touched — no rename, no mkdir, no folder IO at all. This matches exactly what already
  // happens today when an operator manually clears `threadId` by hand.
  //
  // Nothing else is done synchronously: transcript rolling and identity reseeding are NOT
  // triggered here. They already happen automatically, lazily, on the NEXT real inbound
  // message via brainpool.mjs's own `fresh = !sessionId` gate (`if (fresh) await
  // rollTranscript(...)`, `seedLayers(..., { overwrite: fresh })` — see turn()) — duplicating
  // that here would just race the proven path.
  //
  // No evictWarm() call either (unlike access_level, which needs one): warm-sessions.mjs's
  // run() already carries a SESSION-IDENTITY GUARD (its own comment names this exact case —
  // "`/agents <handle> reset` nulling the thread ... would otherwise be silently ignored")
  // that compares the `sessionId` brainpool.mjs passes every turn (`sessionId: threadId ??
  // null`, always an explicit key so the guard's hasOwnProperty check fires) against the warm
  // entry's own bound session id, and self-evicts + reopens fresh on a mismatch. Nulling
  // `threadId` here is exactly what ARMS that guard on the next turn — the same mechanism
  // that already makes `reset` work with no explicit evict, despite `reset` never calling
  // evictWarm either.
  async function agentsRestart(ev, surface, jid, where, handles, state) {
    try {
      let next = state;
      for (const h of handles) next = patchBeing(next, surface, jid, h, { threadId: null });
      await writeState(next);
      await send?.(ev.chatId, `✅ ${handles.join(', ')} restart ${where} — threadId cleared, next message starts a fresh session (mode/access_level unchanged; transcript + identity refresh happen automatically on that next message).`);
    } catch (e) { onLog(`/agents restart ${ev.chatId}: ${e?.message ?? e}`); await send?.(ev.chatId, `/agents: restart failed — ${e?.message ?? e}`); }
  }

  // /agents[=<slug>] <handle>|all auto <mode> — was /e auto <mode> [<target>], generalized:
  // sets EACH target being's own conversation mode (modes live in conversations.yaml,
  // `agents.<being>.mode`, merged over the block's existing fields via patchBeing — siblings
  // survive). Bare (`where === 'here'`): this chat. `=<slug>`-resolved: a DIFFERENT known
  // chat, same resolveTarget reach /e auto's <target> already had.
  async function agentsAuto(ev, surface, jid, where, handles, mode, state) {
    try {
      let next = state;
      for (const h of handles) next = patchBeing(next, surface, jid, h, { mode });
      await writeState(next);
      await send?.(ev.chatId, `✅ ${handles.join(', ')} mode ${where} → ${mode}`);
    } catch (e) { onLog(`/agents auto ${ev.chatId}: ${e?.message ?? e}`); await send?.(ev.chatId, `/agents: auto failed — ${e?.message ?? e}`); }
  }

  // /agents[=<slug>] <handle>|all access_level <all|regular> — was /e access all|regular
  // (renamed subcommand keyword, operator's own example: `/agents wren access_level all`),
  // generalized to any being (or every resident). Points EACH target being's own
  // `access_level` at config/permissions/all.md or regular.md. NOT a freeze: writes ONLY
  // `access_level: target` into the being's block, merged over its existing fields
  // (patchBeing) — brainpool.mjs's turn() reads the matching permissions file FRESH every
  // turn (permission-levels.mjs — no caching) and overrides that turn's allowed_tools/
  // dangerously_skip_permissions, so editing either file changes behavior immediately with
  // no re-run needed.
  // Agent/model/effort/engine are never touched.
  async function agentsAccessLevel(ev, surface, jid, where, handles, target, state) {
    const perm = loadPermissionLevel(target);
    if (!perm) { await send?.(ev.chatId, `/agents: permissions file for "${target}" not found or unparseable`); return; }
    try {
      let next = state;
      const slug = getContact(next, surface, jid)?.slug ?? jid;
      let convDir = null;
      try { convDir = slugDir(surface, slug); } catch { /* non-default surface */ }
      for (const h of handles) {
        next = patchBeing(next, surface, jid, h, { access_level: target });
        // The engine the LIVE warm session is keyed under, PER HANDLE (a sibling can run a
        // different engine than the persona) — resolveBeingDef is the SAME resolver
        // brainpool.mjs's turn() itself calls for this being (name-the-existing-thing).
        const engine = resolveBeingDef(h, convDir, { getConfig: cfg, brains, brainType: CCODE })?.type ?? CCODE;
        // Evict the warm session: a warm `claude` process bakes its allowedTools/confinement
        // into its spawn args ONCE, at open, and never re-reads brainOptions on later turns of
        // the same warm session — so a live warm session must be closed for the new
        // access_level to actually take effect on the NEXT turn, even though nothing here is
        // frozen.
        evictWarm(`${h}:${engine}:${surface}:${slug}`);
      }
      await writeState(next);
    } catch (e) { onLog(`/agents access_level ${ev.chatId}: ${e?.message ?? e}`); await send?.(ev.chatId, `/agents: access_level failed — ${e?.message ?? e}`); return; }
    const msg = target === 'all'
      ? `✅ ${handles.join(', ')} access ${where} → all (unconfined: full filesystem, bare Bash)`
      : `✅ ${handles.join(', ')} access ${where} → regular (confined default tools)`;
    await send?.(ev.chatId, msg);
  }

  // /agents[=<slug>] <handle>|all (bare) — the LIVE status view (never a stale snapshot; see
  // agentsBeingBlock). Fenced-yaml, one block per handle, joined with a `---` document
  // separator when `all` covers more than one resident being. Never throws (every probe
  // degrades to '?'/'unknown', matching statusTarget's own convention).
  function agentsStatus(surface, jid, handles, state) {
    const blocks = handles.map((h) => agentsBeingBlock(surface, jid, h, state));
    return '```yaml\n' + blocks.join('\n---\n') + '\n```';
  }

  // ONE being's status block — statusTarget's own preview is PERSONA-ONLY (resolveDefaultBrainDef,
  // which reads the single `default: true` agent); this generalizes it to ANY being via
  // resolveBeingDef(handle, convDir, …) — the SAME resolver brainpool.mjs's turn() itself
  // calls for this being on its NEXT turn (name-the-existing-thing, not a second derivation)
  // — PLUS the ACCESS-LEVEL OVERRIDE block turn() applies right after it (loadPermissionLevel,
  // when the being's own accessLevel is 'all'/'regular' — a live override statusTarget's own
  // preview never applied, a real gap this closes for the new command) PLUS the
  // `dangerouslySkipPermissions ? raw : coerceAllowedTools(raw)` coercion statusTarget already
  // applies to its own preview. Resolved FRESH on every call (no caching anywhere in this chain), so editing
  // config between two calls changes the NEXT call's tools/model/effort with nothing to evict.
  function agentsBeingBlock(surface, jid, handle, state) {
    try {
      const c = getContact(state, surface, jid);
      const slug = c?.slug ?? jid;
      let convDir = null;
      try { convDir = slugDir(surface, slug); } catch { /* non-default surface */ }

      const b = getBeing(state, surface, jid, handle);

      let def = null;
      try { def = resolveBeingDef(handle, convDir, { getConfig: cfg, brains, brainType: CCODE }); } catch { def = null; }
      if (def && (b?.accessLevel === 'all' || b?.accessLevel === 'regular')) {
        const perm = loadPermissionLevel(b.accessLevel);
        if (perm) def = { ...def, dangerously_skip_permissions: perm.dangerouslySkipPermissions, allowed_tools: perm.allowedTools };
      }
      const previewDef = def ? (def.dangerously_skip_permissions === true ? def : coerceAllowedTools(def)) : null;

      // Determinism parity with turn(): the PERSONA's run always carries a concrete
      // model/effort (DETERMINISTIC_MODEL/EFFORT fallback); a sibling may legitimately have
      // neither set (inherits the CLI login default) — reported as such rather than a
      // fabricated persona default.
      const isDefault = handle === defaultKey;
      const modelVal = previewDef?.model ?? (isDefault ? DETERMINISTIC_MODEL : null);
      const effortVal = previewDef?.effort ?? (isDefault ? DETERMINISTIC_EFFORT : null);
      const toolsRaw = previewDef?.allowed_tools ?? DEFAULT_ALLOWED_TOOLS;
      const toolsVal = Array.isArray(toolsRaw) ? `[${toolsRaw.join(', ')}]` : (toolsRaw ?? '?');
      // def.cwd ?? convDir — the SAME derivation turn() uses for the being's actual run cwd.
      const homeDir = previewDef?.cwd ?? convDir ?? '?';

      return [
        `being: ${handle}`,
        `name: ${previewDef?.name ?? handle}`,
        `surface: ${surface}`,
        `slug: ${slug}`,
        `mode: ${b?.mode ?? 'default'}`,
        `access_level: ${b?.accessLevel ?? 'unset'}`,
        `engine: ${previewDef?.type ?? CCODE}`,
        `model: ${modelVal ?? 'inherit (CLI default)'}`,
        `effort: ${effortVal ?? 'inherit (CLI default)'}`,
        `allowed_tools: ${toolsVal}`,
        `thread_id: ${b?.threadId ?? 'not started'}`,
        `conversation_dir: ${convDir ?? '?'}`,
        `home_dir: ${homeDir}`,
      ].join('\n');
    } catch (e) { return `being: ${handle}\nerror: ${e?.message ?? e}`; }
  }

  // The room called <name>, iff its folder exists on disk — the same stat-probe /room create
  // uses for its own idempotency check, reused here so "does this room exist" has ONE
  // answer across create/members/delete. Returns the Room, or null.
  //
  // A READ NEVER MINTS. A room's slug is a pure function of its name (fixedSlugFor, surface
  // `room`), so this needs no conv-state at all: it applies that identical rule and stats the
  // folder. Going through resolveConvRoom here would call ensureContact, so `/room members
  // <typo>` would leave a contact entry behind for a room that does not exist. Same
  // constructor roomsList and roomFromNs use for a name that came off disk.
  async function roomOnDisk(name) {
    const room = Room.forChat('room', sanitizeName(name));
    try { await stat(room.baseDir()); return room; } catch { return null; }
  }

  // /room create <name> — CREATE a room. A Room IS a folder (room-core.mjs), and a room is
  // a CONVERSATION on surface `room` whose chatId is the name itself: resolveConvRoom mints
  // the contact (the SAME ensureContact a first Beeper message goes through — that is the
  // whole reason a named room is now addressable) and ensureTree makes the folder, which the
  // heartbeat + transcription loaders (boot.mjs listEntityDirs) enumerate from then on.
  // This is the ONE room path that mints; every read resolves the slug purely (roomOnDisk).
  // Tree paths come from the Room abstraction and fs from the io seam, so tests capture it
  // in-memory and it never touches a real profile.
  async function roomCreate(ev, name) {
    // A room NAME is operator-chosen; reject an empty/punctuation-only one before touching fs.
    if (!name || !/[a-z0-9]/i.test(name)) { await send?.(ev.chatId, 'usage: /room create <name>'); return; }
    const r = await resolveConvRoom('room', name);
    if (!r) { await send?.(ev.chatId, `can't resolve room '${name}'`); return; }
    const slug = r.slug;
    const rel = `conversations/room/${slug}/`;
    // Idempotent: an existing room folder is NEVER clobbered.
    try { await stat(r.baseDir()); await send?.(ev.chatId, `room ${slug} already exists at ${rel}`); return; }
    catch { /* absent → create below */ }
    // The folder IS the room: ensure the standard tree + a minimal config.yaml. The dir
    // list belongs to the ABSTRACTION (Room.ensureTree), not to this command — a
    // conversation seeds the identical tree through the same call.
    // No member roster — that's later work.
    await r.ensureTree({ io: { mkdir } });
    // Seed identity.d/ beside the tree (operator 2026-07-26: "why an empty identity.d in
    // namedrooms? fix, please.") — the SAME seedIdentityLayers the persona turn calls,
    // re-keyed on the Room instance it already abstracts both shapes for. 'egpt' (no
    // per-room personality concept exists yet) is exactly the default a conversation falls
    // back to (def.personality ?? 'egpt'). No overwrite: a brand-new room's identity.d is
    // already empty, so copy-if-missing is a plain seed here — and it's the same
    // never-clobber default every other seed path uses. Never throws by its own contract, so
    // a seed failure still leaves a created room rather than an error the operator can't act
    // on — an empty identity.d is a smaller problem than a /room create that fails outright.
    await seedIdentityLayers(r, 'egpt', { io: { mkdir, readFile, writeFile } });
    await writeFile(r.configPath, roomConfigFile(slug), 'utf8');
    await send?.(ev.chatId, `room ${slug} created at ${rel}`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // /rooms — the saved rooms, each with its member count, the current one marked.
  // Never throws (a missing conversations/room/ dir → "no rooms yet"; a per-room count that
  // can't be read degrades to 0). listRoomNames yields FOLDER names (i.e. slugs), so each
  // one is a Room via the same (surface, slug) constructor resolveConvRoom ends in and
  // roomFromNs uses for the disk walk — resolving these through resolveConvRoom would treat
  // a slug as a chatId and mint a contact for every listed room on every /rooms.
  async function roomsList(ev) {
    const names = listRoomNames();
    if (!names.length) return 'no rooms yet — /room create <name> to make one';
    const cur = curRoomName(ev);
    const lines = ['rooms:'];
    for (const name of names) {
      let n = 0;
      try { n = (await Room.forChat('room', name).members()).length; } catch { n = 0; }
      lines.push(`  · ${name}   ${n} members${name === cur ? '   (current)' : ''}`);
    }
    return lines.join('\n');
  }

  // /room <slug> join — make <slug> the current room for this surface (what bare /members
  // targets). In-memory for Phase 2; a room folder materializes when its first member is
  // added (setMember mkdir's it) or via /room create.
  async function roomJoin(ev, slug) {
    currentRoom.set(surfaceOf(ev), slug);
    onRoomChange(surfaceOf(ev), slug);
    await send?.(ev.chatId, `joined '${slug}' — now current.`);
  }

  // /room <slug> leave — clear the current room for this surface iff it IS <slug>.
  async function roomLeave(ev, slug) {
    if (curRoomName(ev) === slug) { currentRoom.delete(surfaceOf(ev)); onRoomChange(surfaceOf(ev), null); await send?.(ev.chatId, `left '${slug}' — no current room.`); return; }
    await send?.(ev.chatId, `not in '${slug}' — current room is ${curRoomName(ev) ? `'${curRoomName(ev)}'` : 'none'}`);
  }

  // /room <slug> delete [force] — remove a room folder outright. Irreversible: a room
  // folder holds transcript.md, media/, files/, identity.d/, scripts/, transcripts/ — real
  // content an operator (or a brain) put there. A room that is STILL JUST the seeded
  // skeleton (what /room create + seedIdentityLayers leave behind: the empty tree plus
  // identity.d/'s seeded layers, nothing else) is removed outright; a room holding anything
  // more requires the explicit `force` token so the operator has to mean it.
  async function roomDelete(ev, slug, force) {
    // The contact ENTRY for this room stays in conv-state (there is no path to remove one,
    // and a stale entry pointing at a removed tree is exactly what a deleted conversation
    // folder leaves behind today).
    const room = await roomOnDisk(slug);
    if (!room) { await send?.(ev.chatId, noRoomMsg(slug)); return; }
    if (!force) {
      const contents = await roomContents(room);
      if (contents.length) {
        await send?.(ev.chatId, `room ${slug} has content — ${contents.join(', ')} — /room ${slug} delete force to remove anyway`);
        return;
      }
    }
    await rm(room.baseDir(), { recursive: true, force: true });
    for (const [surface, cur] of currentRoom) if (cur === slug) { currentRoom.delete(surface); onRoomChange(surface, null); }
    await send?.(ev.chatId, `room ${slug} deleted`);
  }

  // What roomDelete refuses to discard silently: everything a Room can hold BEYOND the
  // seeded skeleton — read through Room's OWN getters (transcriptPath/mediaDir/filesDir/
  // scriptsDir/transcriptsDir/identityDir), never a filename list re-derived here, so a
  // room-core change can't drift this out of sync. identity.d/ is ALWAYS non-empty in a
  // freshly-created room (seedIdentityLayers' copied-in layers) — only names beyond that
  // seeded set (skeletonIdentityFiles, the SAME source seedIdentityLayers itself reads)
  // count as content someone added.
  async function roomContents(room) {
    const parts = [];
    try { await stat(room.transcriptPath); parts.push('transcript.md'); } catch { /* none */ }
    for (const dir of [room.mediaDir, room.filesDir, room.scriptsDir, room.transcriptsDir]) {
      let names = [];
      try { names = await readdir(dir); } catch { names = []; }
      if (names.length) parts.push(`${names.length} file${names.length === 1 ? '' : 's'} in ${basename(dir)}/`);
    }
    let idNames = [];
    try { idNames = await readdir(room.identityDir); } catch { idNames = []; }
    const skeleton = await skeletonIdentityFiles('egpt');
    const extra = idNames.filter((n) => !skeleton.has(n));
    if (extra.length) parts.push(`${extra.length} extra file${extra.length === 1 ? '' : 's'} in identity.d/`);
    return parts;
  }

  // The roster of `room` (a Room object) as a fenced yaml block, labelled by `label`: each
  // member's id, kind, live presence, and friendly mode. Presence for a brain member = its
  // saved targetId is a LIVE tab (from listTabs); a listTabs hiccup degrades every brain to
  // "inactive", never throws. Non-brain members read as "active" (a surface/chat member is
  // present as such). Shared by /members (the conversation room) and /room <slug> members (a
  // named room) — the caller passes the Room + its display label.
  // The lobby's DEFAULT members: this node's local beings, read from the agents
  // registry (E = the persona, plus every configured being like @d / @l). DISPLAY
  // ONLY — they're reachable via @e/@d/@l in ANY conversation (router + wake-words),
  // and are NEVER written to the lobby's config.yaml (which the phase-4 relay reads;
  // these are synthetic present-and-active rows). Scoped to the shell lobby so every
  // other conversation's roster is unchanged. `_` comment keys are skipped, mirroring
  // the router's own filter (an agent-level `enabled:` key is not consulted — operator
  // 2026-07-26, "disabling is just commenting the config").
  function lobbyBeings(ev, room) {
    if (surfaceOf(ev) !== 'shell' || room?.slug !== LOBBY_SLUG) return [];
    const agents = cfg().agents;
    if (!agents || typeof agents !== 'object') return [];
    return Object.entries(agents)
      .filter(([name, a]) => !name.startsWith('_') && a && typeof a === 'object')
      .map(([name]) => ({ kind: 'being', id: name, state: 'active', local: true }));
  }

  async function renderMembers(ev, room, label, extra = []) {
    let ms = [];
    try { ms = await room.members(); } catch { ms = []; }
    // Prepend synthetic/local rows (e.g. the lobby's E/D/L) that don't live in
    // config.yaml, deduping by id so a stored member never lists twice.
    if (extra.length) {
      const stored = new Set(ms.map((m) => m.id));
      ms = [...extra.filter((m) => !stored.has(m.id)), ...ms];
    }
    let liveIds = new Set();
    try { liveIds = new Set((await cdp.listTabs()).map((t) => t.id)); } catch { /* no Chrome → all brains inactive */ }
    const lines = [`${label} (${ms.length} members):`];
    for (const m of ms) {
      const mode = STATE_TO_MODE[m.state] ?? m.state;
      const presence = m.kind === 'brain' ? ((m.targetId && liveIds.has(m.targetId)) ? 'active' : 'inactive') : 'active';
      lines.push(`  · ${m.id}   ${m.kind}   ${presence}   mode:${mode}`);
      // A brain member carries the tab it drives — surface its url + title (captured at add
      // time) on their own indented lines so /members shows WHICH tab, not just its id.
      if (m.kind === 'brain') {
        if (m.url) lines.push(`      url:   ${m.url}`);
        if (m.title) lines.push(`      title: ${m.title}`);
      }
    }
    if (!ms.length) lines.push('  (no members yet)');
    return '```yaml\n' + lines.join('\n') + '\n```';
  }

  // /members … — operate on the CURRENT CONVERSATION's room (bare = list; `add tab <n>`;
  // `<id> mode <m>`). A conversation IS a room (the model): resolveConvRoom yields the SAME Room
  // the phase-4 relay reads, so a member added here lands in the exact config.yaml resolveMembers
  // reads → an @<brain> on this conversation drives the relay. NO "/room <slug> join" gate — the
  // conversation you're in IS the room. (An operator-named room is addressed EXPLICITLY — /rooms
  // + /room <slug> members inspect/manage it — but it is the same kind of Room on surface `room`,
  // so the relay reads its roster through the identical resolver.)
  async function members(ev, rest) {
    const room = await convRoomOf(ev);
    if (!room) { await send?.(ev.chatId, "can't resolve this conversation's room"); return; }
    const label = room.slug ?? 'this conversation';
    if (!rest) { await send?.(ev.chatId, await renderMembers(ev, room, label, lobbyBeings(ev, room))); return; }
    // `add tab <n> [alias=<name> | <name>]` — an explicit alias, either form, is ONE optional
    // trailing token (operator ruling 2026-07-27).
    const add = /^add\s+tab\s+(\d+)(?:\s+(\S+))?$/i.exec(rest);
    if (add) { await membersAddTab(ev, room, Number(add[1]), add[2] ?? null); return; }
    const remove = /^remove\s+(\S+)$/i.exec(rest);
    if (remove) { await membersRemove(ev, room, remove[1]); return; }
    const mode = /^(\S+)\s+mode\s+(\S+)$/i.exec(rest);
    if (mode) { await membersSetMode(ev, room, mode[1], mode[2]); return; }
    await send?.(ev.chatId, 'usage: /members | /members add tab <n> [alias=<name>|<name>] | /members remove <id> | /members <id> mode <disable|mention|all>');
  }

  // /members add tab <n> — add the nth /tabs tab as a brain member of the conversation's room,
  // IF an adapter drives its URL. No adapter (a random site) → refuse with the host, the
  // flagship message. The adapter name only gives a BASE id (chatgpt-cdp → chatgpt) — it is NOT
  // unique by itself (two chatgpt.com tabs share the same adapter). So: if a brain member with
  // this tab's exact url already exists, this is the SAME conversation reopened — refresh its
  // targetId in place (id/state/adapter/url untouched), never a second member. Otherwise it's a
  // genuinely new tab: mint a unique id (base, else base-2, base-3, … lowest free integer) so
  // distinct tabs on the same adapter get distinct @mention-able ids. New members start
  // kind:brain, state:muted (mode:disable — "no chatter reaches it yet").
  async function membersAddTab(ev, room, n, aliasArg) {
    let tabs;
    try { tabs = await cdp.listTabs(); } catch { await send?.(ev.chatId, 'no Chrome to list tabs from — try /chrome first'); return; }
    const tab = tabs[n - 1];
    if (!tab) { await send?.(ev.chatId, `no tab ${n} — ${tabs.length} open`); return; }
    const adapter = await adapterFor(tab.url);
    if (!adapter) {
      await send?.(ev.chatId, `can't add tab ${n} — no adapter matches ${hostOf(tab.url)}.\nadapters are per-site drivers (chatgpt, claude, grok…); add one to support it.`);
      return;
    }
    const base = shortAdapterId(adapter.name);
    const existing = await room.members();
    const same = existing.find((m) => m.kind === 'brain' && m.url === tab.url);
    // An explicit alias (`alias=<name>` or a bare trailing word — operator ruling 2026-07-27)
    // is resolved once, up front — both the refresh branch (below) and the no-collision branch
    // (further down) need it.
    const named = aliasArg ? /^alias=(.+)$/i.exec(aliasArg) : null;
    const alias = aliasArg ? (named ? named[1] : aliasArg) : null;
    if (same) {
      // An explicit alias that DISAGREES with the already-existing member's id is a
      // request to rename it — refused. A member id is @mention-able and appears in
      // transcript history, so silently renaming it would break existing references
      // (live bug 2026-07-27: `/members add tab 1 c1` renamed nothing and just said
      // "refreshed 'chatgpt'", giving zero indication the alias was ignored).
      if (alias && alias !== same.id) {
        const modeWord = STATE_TO_MODE[same.state] ?? same.state;
        await send?.(ev.chatId, `can't add tab ${n} as '${alias}' — tab is already member '${same.id}' (mode:${modeWord}); /members remove ${same.id} first if you want to replace it`);
        return;
      }
      await room.setMember({ ...same, targetId: tab.id, title: tab.title });
      const modeWord = STATE_TO_MODE[same.state] ?? same.state;
      await send?.(ev.chatId, `refreshed '${same.id}' (tab ${n}) — mode:${modeWord}`);
      return;
    }
    const taken = new Set(existing.map((m) => m.id));
    // REFUSES on alias collision, no auto-suffix. No alias → the existing lowest-free-integer suffix.
    let id;
    if (alias) {
      if (taken.has(alias)) { await send?.(ev.chatId, `can't add tab ${n} — alias '${alias}' is already taken in this room`); return; }
      id = alias;
    } else {
      id = base;
      let i = 2;
      while (taken.has(id)) id = `${base}-${i++}`;
    }
    await room.setMember({ kind: 'brain', id, state: 'muted', adapter: adapter.name, url: tab.url, targetId: tab.id, title: tab.title });
    await send?.(ev.chatId, `added '${id}' (tab ${n} · adapter:${base}) — mode:disable (no chatter reaches it yet)`);
  }

  // /members remove <id> — drop a member from the roster. room.removeMember owns the
  // actual removal (a full filter of the members[] array in config.yaml — nothing else
  // in room-core/commands.mjs is keyed by member id, so this is a complete removal); this
  // is wiring only.
  async function membersRemove(ev, room, id) {
    const removed = await room.removeMember(id);
    if (!removed) { await send?.(ev.chatId, `no member '${id}' in this conversation`); return; }
    await send?.(ev.chatId, `removed '${id}'`);
  }

  // /members <id> mode <disable|mention|all> — flip a member's mode. The friendly word
  // maps to the stored room-core token (setMemberState preserves adapter/url/targetId).
  async function membersSetMode(ev, room, id, word) {
    const w = word.toLowerCase();
    const token = MODE_TO_STATE[w];
    if (!token) { await send?.(ev.chatId, `/members mode: unknown mode "${word}" — use disable|mention|all`); return; }
    if (!(await room.members()).some((m) => m.id === id)) { await send?.(ev.chatId, `no member '${id}' in this conversation`); return; }
    await room.setMemberState(id, token);
    await send?.(ev.chatId, `${id} → mode:${w} (${MODE_GLOSS[w]})`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // /radio [join [<radio>]|leave [all|<slug>]|say <text>|disable [<radio>|<node>|<person>]]
  // — config + command only for now (no uploader/HTTP for the note relay path lives here;
  // see radio_service in config/config-schema.mjs). `radio.join` in a room's config.yaml
  // (beside `members:`) names a RADIO — a key in THIS node's radio_service map — never a
  // node. Room configs are per-node (each machine has its own conversation config.yaml),
  // so "/radio=<node> join <name>" already partitions the state: the addressed spine
  // checks its OWN radio_service map and writes its own room file; the other node never
  // hears about it. There is no cross-node ownership to guard, so joining a room already
  // joined to a different radio just switches it — the refusal that matters is a radio
  // this node does NOT have configured.
  //
  // BARE `/radio` is a NODE-WIDE status report (works from Self or any channel — it
  // resolves NO current room at all, see radioStatusReport below): one YAML block per
  // configured radio, its live listener count and every room on this node relaying to it.
  // The other verbs act on a room: `join`/bare `leave`/`say` on THIS conversation's room
  // (resolved through convRoomOf, the SAME room /members reads/writes); `leave all` /
  // `leave <slug>` act on OTHER rooms too, found through the same listEntityDirs
  // enumeration the status report uses (radioJoinedEntities below) — never a second walk.
  //
  // THE SILENCE RULE IS GENERAL, NOT JOIN-SPECIFIC (operator ruling 2026-08-08, widening
  // the 2026-08-08 join-only rule above): "'not relaying' as a response to a '/radio say'
  // command is not necessary if the spine has no radio configuration enabled. it only
  // replies if it has, and matches." For EVERY verb — join, leave, say, and bare status —
  // a BARE `/radio <verb>` (not `=<node>`, and not a bare command resolved through this
  // node's own dispatch.default_node, whose `raw` is `''`) replies ONLY if THIS node can
  // act on it; a node with no configured/enabled radio, or that the command doesn't
  // match, says NOTHING. `/radio=<node> <verb>` was SPECIFICALLY addressed, so it always
  // replies, success or refusal. The ONE exception, for every verb: "can't resolve this
  // conversation's room" always replies — that's a broken invocation, not a mismatch.
  // The distinction reuses the node gate's own answer (`explicit`, below,
  // `addressed.raw.startsWith('=')`) rather than a second "was I addressed" test.
  //
  // Verb-first (the /room 2026-08-07 lesson): an unrecognized verb NEVER touches a room,
  // it just gets the usage line.
  const RADIO_USAGE = 'usage: /radio | /radio join [<radio>] | /radio leave [all|<slug>] | /radio say <text> | /radio disable [<radio>|<node>|<person>]';

  // Which radio each entity on THIS node is joined to, per listEntityDirs (THE walk,
  // owned by boot.mjs — never a second entity enumeration), computed ONCE per /radio
  // call. `display` is the human name shown in replies — ns's part after the first '/'
  // ("Reencuentro amigos" for "whatsapp/Reencuentro amigos", "lab" for "room/lab"). Feeds
  // both the bare status report (grouped by radio) and /radio leave all|<slug> (matched by
  // display, any radio) — one pass, two readers.
  async function radioJoinedEntities() {
    let dirs = [];
    try { dirs = await listEntityDirs(); } catch { dirs = []; }
    const out = [];
    for (const { dir, ns } of dirs) {
      let doc = {};
      try { doc = parseEntityConfig(await readFile(join(dir, 'config.yaml'), 'utf8')); } catch { doc = {}; }
      const joinKey = doc.radio?.join || null;
      if (!joinKey) continue;
      out.push({ ns, joinKey, display: ns.slice(ns.indexOf('/') + 1) });
    }
    return out;
  }

  // Reconstruct the Room a listEntityDirs entry names. An ns is always <surface>/<slug>
  // — including `room/<slug>`, since a room is a conversation on surface `room` — so this
  // is the ONE constructor with no special case; never a second room-resolution path.
  function roomFromNs(ns) {
    const i = ns.indexOf('/');
    return Room.forChat(ns.slice(0, i), ns.slice(i + 1));
  }

  // Every `radio.hosts` entry (sender-id -> station-speaker name) across every entity on
  // this node — the SAME listEntityDirs walk radioJoinedEntities uses, never a second
  // enumeration, just reading a different field of the same config. Feeds /radio disable's
  // "a speaker name" resolution step (config/config-schema.mjs radio_service KEYS).
  async function radioHostEntries() {
    let dirs = [];
    try { dirs = await listEntityDirs(); } catch { dirs = []; }
    const out = [];
    for (const { dir } of dirs) {
      let doc = {};
      try { doc = parseEntityConfig(await readFile(join(dir, 'config.yaml'), 'utf8')); } catch { doc = {}; }
      const hosts = (doc.radio?.hosts && typeof doc.radio.hosts === 'object') ? doc.radio.hosts : {};
      for (const [senderId, speakerName] of Object.entries(hosts)) out.push({ senderId, speakerName: String(speakerName ?? '') });
    }
    return out;
  }

  // /radio disable's "a contact name" resolution step: scan every per-contact stats file
  // (state/stats/<surface>/*.yaml — the SAME sender_id+name shape statsPath/contactStatsPath
  // read/write, src/conversations-state.mjs) for an exact case-insensitive name match, across
  // every surface this node has ever seen. Returns every hit — 0 = no match, 1 = resolved,
  // 2+ = ambiguous (the caller refuses and lists them).
  async function contactCandidates(needle) {
    const out = [];
    let surfaces = [];
    try { surfaces = await readdir(join(EGPT_HOME, 'state', 'stats')); } catch { surfaces = []; }
    for (const surface of surfaces) {
      let files = [];
      try { files = await readdir(join(EGPT_HOME, 'state', 'stats', surface)); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.yaml')) continue;
        let body;
        try { body = YAML.parse(await readFile(join(EGPT_HOME, 'state', 'stats', surface, f), 'utf8')); } catch { continue; }
        if (!body?.sender_id || !body?.name) continue;
        if (String(body.name).toLowerCase() === needle) out.push({ senderId: body.sender_id, name: body.name, surface });
      }
    }
    return out;
  }

  // /radio disable <slug> — the resolution order (operator ruling 2026-08-08): "'/radio
  // disable <slug>' matches my contact names, userid, radioname... if <slug> is empty it
  // disables the radio". Smallest, most explicit namespaces first (a radio name, a node
  // name — the operator types both himself), then the softer identity layers (a speaker
  // name, a contact name), a raw sender id last. A raw id is recognized by the SAME shape
  // resolveTarget already uses for a verbatim jid (`/[@!]|:beeper/`) — so a plain word that
  // matches nothing above has nothing to act on, and bare /radio disable stays silent on it
  // rather than blocking garbage as if it were a sender id.
  //   { kind: 'radio', name }         a radio THIS node has configured
  //   { kind: 'node-self' }           names THIS node — disable every radio here
  //   { kind: 'node-other' }          names a DIFFERENT known node — nothing to do here
  //   { kind: 'sender', id, label }   a speaker/contact/raw id to block
  //   { kind: 'ambiguous', candidates }
  //   { kind: 'none' }                nothing matched, and it isn't id-shaped either
  async function resolveDisableSlug(rest) {
    const needle = rest.toLowerCase();
    const radios = (cfg().radio_service && typeof cfg().radio_service === 'object') ? cfg().radio_service : {};
    const radioName = Object.keys(radios).find((n) => n.toLowerCase() === needle);
    if (radioName) return { kind: 'radio', name: radioName };
    if (knownNodeNames(cfg()).has(needle)) return ownNodeNamesOf(cfg()).has(needle) ? { kind: 'node-self' } : { kind: 'node-other' };
    for (const h of await radioHostEntries()) {
      if (h.speakerName.toLowerCase() === needle) return { kind: 'sender', id: h.senderId, label: h.speakerName };
    }
    const contacts = await contactCandidates(needle);
    if (contacts.length === 1) return { kind: 'sender', id: contacts[0].senderId, label: contacts[0].name };
    if (contacts.length > 1) return { kind: 'ambiguous', candidates: contacts.map((c) => `${c.name} (${c.surface})`) };
    if (/[@!]|:beeper/.test(rest)) return { kind: 'sender', id: rest, label: rest };
    return { kind: 'none' };
  }

  // Flip `enabled: false` on one or more of THIS node's radios — BOTH persisted
  // (writeConfigKey, comment-preserving) AND live immediately: `cfg()` is the SAME object
  // reference boot handed to createRadioNoteRelay (boot.mjs `const cfg = readConfig()`,
  // `getConfig = () => cfg`), so mutating radios[name].enabled here is visible to the very
  // next relay/say attempt with no restart — a blocking feature that only blocks after a
  // reboot would be worse than none (operator ruling 2026-08-08).
  async function disableRadiosOnThisNode(names) {
    const radios = cfg().radio_service;
    for (const name of names) {
      if (radios?.[name] && typeof radios[name] === 'object') radios[name].enabled = false;
      await writeConfigKey(configPath, `radio_service.${name}.enabled`, false);
    }
  }

  // Block one sender id from every radio on THIS node — same live+persisted contract as
  // disableRadiosOnThisNode. radio_blocked_senders is registered in config/config-schema.mjs
  // and read by both the voice-note relay (boot.mjs createRadioNoteRelay) and /radio say.
  async function blockSenderOnThisNode(id) {
    const live = cfg();
    const list = Array.isArray(live.radio_blocked_senders) ? live.radio_blocked_senders : [];
    if (list.includes(id)) return;
    const updated = [...list, id];
    live.radio_blocked_senders = updated;
    await writeConfigKey(configPath, 'radio_blocked_senders', updated);
  }

  // Bare /radio's report: one fenced yaml reply, one block per configured radio —
  // `listeners` (a single unauthenticated status-json.xsl probe, no retry; "unknown" on
  // ANY failure so a station hiccup never blanks the whole reply) and `joined` (every room
  // on this node relaying to it). No hosts-count, no disabled/not-configured note — those
  // stay in /radio join's reply only; this report's shape is exactly listeners + joined.
  async function radioStatusReport() {
    const radios = (cfg().radio_service && typeof cfg().radio_service === 'object') ? cfg().radio_service : {};
    const configuredNames = Object.keys(radios);
    if (!configuredNames.length) return `no radio configured on ${cfg().node_name}`;
    const joinedByRadio = new Map();
    for (const e of await radioJoinedEntities()) {
      if (!joinedByRadio.has(e.joinKey)) joinedByRadio.set(e.joinKey, []);
      joinedByRadio.get(e.joinKey).push(e.display);
    }
    const lines = [];
    for (const name of configuredNames) {
      const r = radios[name];
      const base = r.listen_url || r.endpoint;
      let listeners = 'unknown';
      if (base) {
        try {
          const res = await fetchFn(`${String(base).replace(/\/+$/, '')}/status-json.xsl`);
          if (res?.ok) {
            const body = await res.json();
            const src = body?.icestats?.source;
            if (src) {
              const arr = Array.isArray(src) ? src : [src];
              listeners = String(arr.reduce((sum, s) => sum + (Number(s?.listeners) || 0), 0));
            }
          }
        } catch { /* stays 'unknown' — a station hiccup must never blank the whole reply */ }
      }
      const joined = joinedByRadio.get(name) ?? [];
      lines.push(`${name}:`);
      lines.push(`  listeners: ${listeners}`);
      lines.push(joined.length ? '  joined:' : '  joined: []');
      for (const j of joined) lines.push(`    - ${j}`);
    }
    return '```yaml\n' + lines.join('\n') + '\n```';
  }

  async function radio(ev, first, rest, addressed) {
    if (first && first !== 'join' && first !== 'leave' && first !== 'say' && first !== 'disable') { await send?.(ev.chatId, RADIO_USAGE); return; }
    const explicit = !!addressed?.raw && addressed.raw.startsWith('=');
    const radios = (cfg().radio_service && typeof cfg().radio_service === 'object') ? cfg().radio_service : {};
    const configuredNames = Object.keys(radios);
    const thisNode = cfg().node_name;
    const radioNote = (name) => {
      const r = radios[name];
      if (!r) return ' — not configured on this node';
      return r.enabled === true ? '' : ' — disabled in config';
    };

    // Bare status (no verb): a node with nothing configured has nothing to report and
    // stays silent unless explicitly addressed (silence rule, above); a node WITH radios
    // always reports.
    if (!first) {
      if (!configuredNames.length) { if (explicit) await send?.(ev.chatId, `no radio configured on ${thisNode}`); return; }
      await send?.(ev.chatId, await radioStatusReport());
      return;
    }

    if (first === 'join') {
      const room = await convRoomOf(ev);
      if (!room) { await send?.(ev.chatId, "can't resolve this conversation's room"); return; }
      let target = rest ? rest.toLowerCase() : null;
      if (!target) {
        if (configuredNames.length === 0) {
          if (explicit) await send?.(ev.chatId, `no radio configured on ${thisNode}`);
          return;
        }
        if (configuredNames.length > 1) {
          if (explicit) await send?.(ev.chatId, `which radio? configured: ${configuredNames.join(', ')}`);
          return;
        }
        [target] = configuredNames;
      }
      if (!configuredNames.includes(target)) {
        if (explicit) await send?.(ev.chatId, `no radio '${target}' on ${thisNode} — configured: ${configuredNames.length ? configuredNames.join(', ') : 'none'}`);
        return;
      }
      const doc = await room.loadConfig();
      const joinedRadio = doc.radio?.join || null;
      await room.setRadioJoin(target);   // hosts: survives untouched — setRadioJoin never writes it
      const name = radios[target].name || target;
      const sentence = radios[target].listen_url
        ? `relaying to ${name}. you can listen in ${radios[target].listen_url}. voice notes are broadcasted to the radio's listeners.`
        : `relaying to ${name}. voice notes are broadcasted to the radio's listeners.`;
      const switchPrefix = (joinedRadio && joinedRadio !== target) ? `switched from ${radios[joinedRadio]?.name || joinedRadio} — ` : '';
      await send?.(ev.chatId, `${switchPrefix}${sentence}${radioNote(target)}`);
      return;
    }

    if (first === 'leave') {
      if (!rest) {
        const room = await convRoomOf(ev);
        if (!room) { await send?.(ev.chatId, "can't resolve this conversation's room"); return; }   // exception — always
        const doc = await room.loadConfig();
        const joinedRadio = doc.radio?.join || null;
        if (!joinedRadio) { if (explicit) await send?.(ev.chatId, 'not relaying — nothing to leave'); return; }
        await room.setRadioJoin(null);   // hosts: survives untouched — setRadioJoin never writes it
        await send?.(ev.chatId, `left ${joinedRadio} — relaying stopped`);
        return;
      }
      if (rest.toLowerCase() === 'all') {
        const entries = await radioJoinedEntities();
        if (!entries.length) { if (explicit) await send?.(ev.chatId, 'not relaying anywhere on this node — nothing to leave'); return; }
        for (const e of entries) await roomFromNs(e.ns).setRadioJoin(null);   // hosts: survives untouched — setRadioJoin never writes it
        await send?.(ev.chatId, `left ${entries.length} room${entries.length === 1 ? '' : 's'}`);
        return;
      }
      const entries = await radioJoinedEntities();
      const hit = entries.find((e) => e.display.toLowerCase() === rest.toLowerCase());
      if (!hit) { if (explicit) await send?.(ev.chatId, `'${rest}' is not joined to a radio on this node`); return; }
      await roomFromNs(hit.ns).setRadioJoin(null);   // hosts: survives untouched — setRadioJoin never writes it
      await send?.(ev.chatId, `left ${hit.display}`);
      return;
    }

    if (first === 'disable') {
      const summary = (names) => `disabled ${names.length} radio${names.length === 1 ? '' : 's'} on ${thisNode}: ${names.join(', ')}`;
      if (!rest) {
        // ABSOLUTE: every radio on THIS node — one node's own map, executed independently
        // by every node that hears the bare broadcast (operator ruling 2026-08-08).
        if (!configuredNames.length) { if (explicit) await send?.(ev.chatId, `no radio configured on ${thisNode} — nothing to disable`); return; }
        await disableRadiosOnThisNode(configuredNames);
        await send?.(ev.chatId, summary(configuredNames));
        return;
      }
      const resolved = await resolveDisableSlug(rest);
      if (resolved.kind === 'radio') {
        await disableRadiosOnThisNode([resolved.name]);
        await send?.(ev.chatId, `disabled ${resolved.name} on ${thisNode}`);
        return;
      }
      if (resolved.kind === 'node-self') {
        if (!configuredNames.length) { await send?.(ev.chatId, `no radio configured on ${thisNode} — nothing to disable`); return; }
        await disableRadiosOnThisNode(configuredNames);
        await send?.(ev.chatId, summary(configuredNames));
        return;
      }
      if (resolved.kind === 'node-other') return;   // named a different node — silent, whether bare or explicit
      if (resolved.kind === 'ambiguous') { await send?.(ev.chatId, `'${rest}' matches ${resolved.candidates.length}: ${resolved.candidates.join(', ')} — be more specific`); return; }
      if (resolved.kind === 'sender') {
        await blockSenderOnThisNode(resolved.id);
        await send?.(ev.chatId, `blocked ${resolved.label} on ${thisNode}`);
        return;
      }
      // kind === 'none' — nothing matched at all on this node (not even id-shaped): the
      // same silence a bare, unmatched broadcast gets everywhere else in this command.
      if (explicit) await send?.(ev.chatId, `'${rest}' doesn't match a radio, node, speaker or contact on ${thisNode}`);
      return;
    }

    // first === 'say' — upload <text> as a .md note through the SAME uploader/gate the
    // voice-note relay uses (src/radio-relay.mjs, src/spine/boot.mjs createRadioNoteRelay).
    const room = await convRoomOf(ev);
    if (!room) { await send?.(ev.chatId, "can't resolve this conversation's room"); return; }   // exception — always
    if (!rest) { await send?.(ev.chatId, RADIO_USAGE); return; }
    const doc = await room.loadConfig();
    const joinedRadio = doc.radio?.join || null;
    if (!joinedRadio) { if (explicit) await send?.(ev.chatId, 'not relaying — /radio join <radio> first'); return; }
    if (!radios[joinedRadio] || radios[joinedRadio].enabled !== true) {
      if (explicit) await send?.(ev.chatId, `radio '${joinedRadio}' not configured or disabled on ${thisNode}`);
      return;
    }
    // A blocked sender is a deliberate, fully-matched policy refusal (not an address
    // mismatch), so — unlike the mismatch branches above — it always replies.
    const blockedSenders = Array.isArray(cfg().radio_blocked_senders) ? cfg().radio_blocked_senders : [];
    if (blockedSenders.includes(ev.senderId)) { await send?.(ev.chatId, 'blocked — relaying disabled for you'); return; }
    const speaker = pickSpeaker(doc.radio?.hosts, ev.senderId, radios[joinedRadio].default_speaker);
    if (!speaker) { if (explicit) await send?.(ev.chatId, `no speaker for you on ${joinedRadio} — no default_speaker configured either`); return; }
    const filename = radioNoteFilename(now(), 'md');
    const bytes = Buffer.from(rest, 'utf8');
    const result = await gateFn(() => uploadNoteFn({ radio: radios[joinedRadio], speaker, filename, bytes, onLog }));
    if (result == null) return;   // gate refused — silent, per the lasso ruling
    if (!result.ok) {
      await send?.(ev.chatId, `radio say failed — ${result.error}${result.status ? ` (${result.status})` : ''}`);
      return;
    }
    await send?.(ev.chatId, rest.length > 500
      ? `said as ${speaker} — ${rest.length} chars, will take a while to air`
      : `said as ${speaker}`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // rs — reply to any message with just this token and it airs, through the SAME /radio say
  // path above (room must be joined, radio enabled, sender not blocked, speaker resolved,
  // uploaded through the SAME gate) — never a second uploader. `addressed` is always null here
  // (rs carries no `=<node>` syntax), so `radio()`'s `explicit` is always false: rs behaves like
  // a BARE /radio say throughout — silent on an unjoined/disabled room, but a blocked sender and
  // "can't resolve this conversation's room" still always reply (radio()'s own unconditional
  // branches, unchanged).
  //
  // "nothing to read" (no reply-to, or the quote is empty once stripped) does NOT reuse radio()'s
  // `!rest` branch — that one always replies (a real `/radio say` with no text is a mistyped
  // command, always worth a usage line) — rs instead follows the general /radio silence rule
  // (operator 2026-08-08): reply only if this node COULD have said something, else say nothing.
  const RS_NOTHING_TO_READ = 'nothing to read';

  // The same room+joined+enabled gate radio()'s say branch checks, standalone, WITHOUT a text
  // payload — rs's silence rule needs the answer before it has anything to strip. radio() itself
  // is untouched (still checks the identical three things inline, in its own order) so the
  // locked /radio say behaviour can never drift from this.
  async function radioCanActIn(room) {
    const doc = await room.loadConfig();
    const joinedRadio = doc.radio?.join || null;
    if (!joinedRadio) return false;
    const radios = (cfg().radio_service && typeof cfg().radio_service === 'object') ? cfg().radio_service : {};
    return radios[joinedRadio]?.enabled === true;
  }

  // Pop a trailing bridge_signature_close (config, never hardcoded — operator 2026-07-12) off a
  // quoted body. `close` may itself be multi-line (the config key allows it); only a COMPLETE
  // match at the very tail is removed — anything else leaves the text untouched rather than risk
  // mangling real content that happens to share a line with the marker.
  function stripBridgeClose(text, close) {
    const closeLines = String(close ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    if (!closeLines.length) return text;
    const lines = String(text).split('\n');
    let i = lines.length, j = closeLines.length;
    while (i > 0 && j > 0 && lines[i - 1].trim() === closeLines[j - 1]) { i--; j--; }
    return j === 0 ? lines.slice(0, i).join('\n') : text;
  }

  // Remove the persona stamp header line personaStamp (src/bridges/persona-wrap.mjs) prepends —
  // "<body_emoji> <label>" as its OWN line — by checking against every agent's ACTUAL configured
  // emoji+label rather than pattern-guessing at "some emoji on the first line". Matches any line
  // exactly equal to a configured stamp, wherever the earlier strips left it.
  function stripPersonaStampHeader(text) {
    const stamps = new Set();
    for (const [name, agent] of Object.entries(cfg().agents ?? {})) {
      if (!agent || typeof agent !== 'object') continue;
      stamps.add(`${agent.body_emoji || '🐶'} ${agent.name || name}`);
    }
    if (!stamps.size) return text;
    return String(text).split('\n').filter((l) => !stamps.has(l)).join('\n');
  }

  // A quoted message may be the operator's/a human's own words, or it may instead be another
  // spine's own SENT reply round-tripping back as ordinary inbound text on a shared Beeper
  // account — that text carries every wrap layer that node's persona-wrap applied, so it must be
  // read cleanly either way. Strip all three, outermost to innermost: the structural node
  // signature (raw, then rendered — see stripNodeSignature/stripRenderedNodeSignature), the
  // visible bridge close, the persona stamp header. Null when nothing legible remains.
  function cleanQuotedBody(body) {
    let t = stripNodeSignature(body);
    t = stripRenderedNodeSignature(t);
    t = stripBridgeClose(t, cfg().bridge_signature_close);
    t = stripPersonaStampHeader(t);
    t = t.trim();
    return t || null;
  }

  async function radioQuickReply(ev) {
    const room = await convRoomOf(ev);
    const nothingToRead = async () => { if (room && await radioCanActIn(room)) await send?.(ev.chatId, RS_NOTHING_TO_READ); };
    if (ev.replyToId == null) { await nothingToRead(); return; }
    let text = null;
    if (room) { try { text = await readFile(room.transcriptPath, 'utf8'); } catch { text = null; } }
    const body = text ? bodyForMessageId(text, ev.replyToId) : null;
    const cleaned = body ? cleanQuotedBody(body) : null;
    if (!cleaned) { await nothingToRead(); return; }
    await radio(ev, 'say', cleaned, null);
  }

  // /config [<key>[=<value>]] — the `=` idiom the node binding already uses (`/config=kg`),
  // applied to the pair (operator ruling 2026-07-28, replacing the one-day-old `set`/`get`
  // sub-verbs — no legacy alias kept). Bare: a redacted dump. `<key>` alone: a GET. `<key>=<value>`:
  // a SET. Both may appear together (`/config=kg default_node=do`) — the node binding is stripped
  // by the gate before configCmd ever sees `rest`, so this needs no special handling here.
  // <key> resolves through resolveConfigKey (config/config-schema.mjs — a dotted path used as-is,
  // or a bare leaf looked up in the KEYS: index); <value> is JSON.parse'd, falling back to the raw
  // string on a parse failure (same coercion the extension used), then written via writeConfigKey
  // — the comment-preserving single-key writer, never the whole-file writeConfig. Config is read
  // at boot, so the reply always says the write takes effect on the NEXT restart; nothing here
  // triggers one.
  // Matched against KEY NAMES, recursively. Credentials AND personal identifiers: a dump goes
  // to whatever surface asked, which is usually a real Beeper chat, permanently. `account` and
  // `allowed_users` are the operator's email and phone numbers — not secrets, but a config dump
  // exists to check values like default_node, not to post a contact list into a group.
  // `account` is ANCHORED so `account_peers` ([kg, do] — not sensitive, and worth seeing) stays.
  const CONFIG_REDACT_RE = /token|key|secret|password|^account$|allowed_users/i;
  function redactConfigValue(value) {
    if (Array.isArray(value)) return value.map(redactConfigValue);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = CONFIG_REDACT_RE.test(k) ? '<redacted>' : redactConfigValue(v);
      return out;
    }
    return value;
  }
  const CONFIG_USAGE = 'usage: /config | /config <key> | /config <key>=<value>';
  async function configCmd(rest) {
    if (!rest) return '```json\n' + JSON.stringify(redactConfigValue(cfg()), null, 2) + '\n```';
    const eq = rest.indexOf('=');
    if (eq === -1) {
      // GET: a bare key, no '='.
      const resolved = resolveConfigKey(rest);
      if (resolved.error) return `/config: ${resolved.message}`;
      const segments = resolved.path.split('.');
      const value = segments.reduce((o, k) => o?.[k], cfg());
      if (value === undefined) return `${resolved.path} is unset`;
      // Wrap in the leaf's own key so redactConfigValue's key-name check (which only inspects
      // an OBJECT's entries) also covers the value AT resolved.path itself, not just its children.
      const leaf = segments[segments.length - 1];
      const redacted = redactConfigValue({ [leaf]: value })[leaf];
      return `${resolved.path} = ${JSON.stringify(redacted)}`;
    }
    // SET: `<key>=<value>`, split on the FIRST '=' only — a value may itself contain one (a
    // token, a URL's query string) and must arrive intact. Strict: no spaces adjacent to the
    // '=' (one unambiguous form) — called out explicitly rather than falling through to a
    // generic "not a registered key" on the mangled key that whitespace would produce.
    if (rest[eq - 1] === ' ' || rest[eq + 1] === ' ') return `${CONFIG_USAGE} — no spaces around '='`;
    const keyArg = rest.slice(0, eq);
    const valueRaw = rest.slice(eq + 1);
    const resolved = resolveConfigKey(keyArg);
    if (resolved.error) return `/config: ${resolved.message}`;
    let val = valueRaw;
    try { val = JSON.parse(valueRaw); } catch { /* keep the raw string, exactly like the extension */ }
    await writeConfigKey(configPath, resolved.path, val);
    // "restart" alone misled the operator once: he relaunched the EDITOR, which reconnects to
    // the same long-running spine that read its config at boot. Name the command instead.
    // REDACT THE ECHO, exactly as the dump and GET do. `beeper_token` and
    // `beeper.<acct>.token` are legitimate resolveConfigKey targets, so a bare echo would
    // print a live credential — and since every reply is now recorded (operator: "everything
    // that is typed or received in a room has to be in transcript"), it would land durably in
    // transcript.md rather than merely flashing past.
    const echoLeaf = resolved.path.split('.').pop();
    const shown = redactConfigValue({ [echoLeaf]: val })[echoLeaf];
    return `set ${resolved.path} = ${JSON.stringify(shown)} — run /restart to apply (the spine, not the editor)`;
  }

  // /activate <id> — a brain member is ACTIVE while its Chrome tab is open (a live
  // targetId). If Chrome closed it, reopen the saved url and refresh the targetId. A no-op
  // when the tab is already live. Presence is separate from mode: activating does NOT
  // change the member's mode.
  async function activate(ev, id) {
    const room = await convRoomOf(ev);
    if (!room) { await send?.(ev.chatId, "can't resolve this conversation's room"); return; }
    const m = (await room.members()).find((x) => x.id === id);
    if (!m) { await send?.(ev.chatId, `no member '${id}' in this conversation`); return; }
    if (m.kind !== 'brain') { await send?.(ev.chatId, `'${id}' is not a tab/brain member`); return; }
    let liveIds = new Set();
    try { liveIds = new Set((await cdp.listTabs()).map((t) => t.id)); } catch { /* no Chrome → treat as closed */ }
    if (m.targetId && liveIds.has(m.targetId)) { await send?.(ev.chatId, `${id} already active · tab ${m.targetId}`); return; }
    let newId;
    try { newId = await cdp.openTab(m.url); } catch (e) { await send?.(ev.chatId, `/activate: failed — ${e?.message ?? e}`); return; }
    await room.setMember({ ...m, targetId: newId });   // spread keeps state/adapter/url; targetId refreshed
    await send?.(ev.chatId, `reopened ${m.url} · tab ${newId ?? '?'} · active`);
  }

  // `/status <target>` NODE GATE (operator ruling 2026-07-25) — classify <target> BEFORE
  // the conversation-fragment search runs. Bare /status is untouched: both co-account
  // nodes answer it, as designed. Named, exactly one node answers:
  //
  //   'mine'   — <target> is one of THIS node's own names (node_name ∪ node_alias, via
  //              the SHARED ownNodeNamesOf — the same set /chrome's gate matches). This
  //              node replies with the bare-/status node-health payload.
  //   'silent' — <target> is a node on this Beeper account that is NOT us (cfg.account_peers,
  //              the roster /status already surfaces as `peers:`). Reply NOTHING AT ALL —
  //              the same deliberate silence /chrome uses. It must NOT fall through to the
  //              fragment search: on 2026-07-25 `/status do` typed on kg did exactly that,
  //              matched 9 conversations, and the "be more specific" reply seeded the
  //              two-node message flood. A bare "unknown node" would be just as wrong —
  //              every node answering that IS the double-answer the gate prevents.
  //   null     — an ordinary fragment (or a node with no identity configured): fall through
  //              to statusTarget, byte-identical to before.
  //
  // Precedence is node-first: a conversation slug colliding with a node name loses, and
  // renaming the slug is the operator's call — no disambiguation, no warning machinery.
  function statusNodeGate(target) {
    const t = String(target).toLowerCase();
    if (ownNodeNamesOf(cfg()).has(t)) return 'mine';
    const peers = cfg().account_peers;
    if (Array.isArray(peers) && peers.some((p) => String(p ?? '').trim().toLowerCase() === t)) return 'silent';
    return null;
  }

  // Assemble the /status report as a fenced YAML block (operator 2026-07-02: the
  // old prose line inlined the full git subject and rendered as a wall of text —
  // fences render as monospace in WhatsApp/Beeper). Runs IN the spine process, so
  // it reads process-local liveness (pid/uptime) + this profile's state files.
  // Each probe is independently guarded; a degraded probe shows '?', never aborts.
  async function status(ev) {
    let sha = '?', subject = '';
    try { sha = gitOut(['rev-parse', '--short', 'HEAD']) || '?'; } catch { sha = '?'; }
    try { subject = gitOut(['log', '-1', '--format=%s']) || ''; } catch { subject = ''; }

    const pid = process.pid;
    let up = '?';
    try { up = humanizeUptime(process.uptime()); } catch { up = '?'; }

    // Liveness = the alive.txt MTIME age (boot's alive heartbeat rewrites it each tick).
    let beat = '?';
    try {
      const s = await stat(join(EGPT_HOME, 'state', 'alive.txt'));
      beat = `${Math.max(0, Math.round((Date.now() - s.mtimeMs) / 1000))}s`;
    } catch { beat = '?'; }

    // Heartbeat count = entries in the spine-written aggregate. It lives at the PROFILE
    // ROOT now, beside the other two (operator 2026-07-26: "state/ hides too much").
    let hb = '?';
    try {
      const doc = YAML.parse(await readFile(join(EGPT_HOME, 'heartbeats.readonly.yaml'), 'utf8'));
      if (Array.isArray(doc?.heartbeats)) hb = String(doc.heartbeats.length);
    } catch { hb = '?'; }

    // Conversations = non-alias, slugged contacts across every surface. Reuse the
    // same loaded state for THIS chat's E mode (cheap; omitted if unresolvable).
    let convs = '?', mode = null;
    try {
      const st = loadState ? await loadState() : null;
      if (st) {   // null = state unresolvable → leave convs '?', not a false 0
        let n = 0;
        for (const bucket of Object.values(st.contacts ?? {})) {
          for (const entry of Object.values(bucket ?? {})) {
            if (entry && !entry.aliasOf && entry.slug) n++;
          }
        }
        convs = String(n);
        try { mode = getBeing(st, ev.surface, ev.chatId, defaultKey)?.mode ?? null; } catch { mode = null; }
      }
    } catch { convs = '?'; }

    // First line "egpt: <sha> · <subject>" with the WHOLE line truncated to 60
    // chars + '…' (the untruncated subject was the wall the operator flagged).
    // No subject → "egpt: <sha>"; a failed sha probe → "egpt: ?".
    const val = sha === '?' ? '?' : (subject ? `${sha} · ${subject}` : sha);
    let egptLine = `egpt: ${val}`;
    if (egptLine.length > 60) egptLine = `${egptLine.slice(0, 60)}…`;

    const lines = [
      egptLine,
      `pid: ${pid}`,
      `up: ${up}`,
      `beat: ${beat} ago`,
      `heartbeats: ${hb}`,
      `conversations: ${convs}`,
      // RUNG ATTRIBUTION (operator 2026-07-26). Every value the config resolver hands out
      // carries `source:` — the profile-relative file it was read from — and /status
      // already filtered on it without ever SHOWING it. Bare /status is the node report:
      // essentially every field below is the node rung, so it says so ONCE here rather
      // than suffixing twenty lines. `/status <fragment>` attributes per conversation,
      // where the answer actually varies by rung.
      `config: ${NODE_FILE}`,
    ];
    if (mode) lines.push(`mode: ${mode} (${REGISTRY_FILE})`);
    // Registry + OBSERVABILITY only (never acted on) — name + account, NEVER the token.
    const beeperNames = Object.keys(beeperAccounts);
    if (beeperNames.length) {
      lines.push('beeper_accounts:');
      for (const name of beeperNames) lines.push(`  ${name}: ${beeperAccounts[name]}`);
    }

    // node_name / peers — this node's identity + its account-sharing siblings. Omitted
    // (not '?') when unset, same optional-field pattern as `mode` above.
    try { const nn = cfg().node_name; if (nn) lines.push(`node_name: ${nn}`); } catch { /* omit */ }
    try {
      const peers = cfg().account_peers;
      if (Array.isArray(peers) && peers.length) lines.push(`peers: [${peers.join(', ')}]`);
    } catch { /* omit */ }

    // transcription — cherry-picks enabled/use_config, then RESOLVES use_config so the
    // block is self-contained (operator 2026-07-25: `use_config: reve` named a profile
    // whose fallback_order/engines were invisible, forcing a config.yaml read). For each
    // engine named in fallback_order, shows only its type + WHERE it runs (endpoint origin,
    // or a cli command's basename) — NEVER reads .token (a SECRET, same rule as
    // beeper_accounts above). Every resolution step degrades to an honest '?'/'[]' rather
    // than throwing or silently omitting. Absent/disabled → one line, no sub-block.
    try {
      const txSvc = cfg().transcription_service;
      const txEnabled = !!txSvc && txSvc.enabled !== false;
      if (txEnabled) {
        const useConfig = txSvc.use_config;
        const profile = useConfig ? txSvc[useConfig] : null;
        lines.push('transcription:', '  enabled: true', `  use_config: ${useConfig ?? '?'}`);
        if (useConfig) {
          if (profile && typeof profile === 'object') {
            const fallbackOrder = Array.isArray(profile.fallback_order) ? profile.fallback_order : [];
            lines.push(`  fallback_order: [${fallbackOrder.join(', ')}]`);
            for (const name of fallbackOrder) {
              const engine = profile[name];
              const type = engine?.type ?? '?';
              let where = '?';
              if (engine?.endpoint) {
                where = engine.endpoint;
                try { where = new URL(engine.endpoint).origin; } catch { /* keep the raw string */ }
              } else if (engine?.command) {
                where = basename(String(engine.command));
              }
              lines.push(`  ${name}: ${type} @ ${where}`);
            }
          } else {
            lines.push('  fallback_order: ?');   // use_config named a profile that isn't defined
          }
        }
      } else {
        lines.push('transcription: off');
      }
    } catch { lines.push('transcription: off'); }

    // agents — local agents from cfg().agents. The persona (default:true) shows its
    // handles; a relay agent (scalar or multipath, agentPaths normalizes both) shows
    // its `to` once. Omitted entirely when cfg().agents is absent/empty.
    try {
      const agentsCfg = cfg().agents;
      if (agentsCfg && typeof agentsCfg === 'object' && !Array.isArray(agentsCfg)) {
        const agentLines = [];
        for (const [name, agent] of Object.entries(agentsCfg)) {
          try {
            if (agent && agent.default) {
              const handles = Array.isArray(agent.handles) ? agent.handles.join(', ') : '';
              agentLines.push(`  ${name} (${handles})`);
            } else {
              const to = agentPaths(agent).find((p) => p.to)?.to;
              if (to) agentLines.push(`  ${name} → ${to}`);
            }
          } catch { /* skip this one malformed agent entry */ }
        }
        if (agentLines.length) lines.push('agents:', ...agentLines);
      }
    } catch { /* omit the whole block */ }

    // chrome — reuses the cdp seam + this module's own adapterFor (already memoized
    // loadAdapters). Never blocks/throws on a down Chrome.
    try {
      const running = await cdp.isRunning();
      if (running) {
        let tabs = [];
        try { tabs = await cdp.listTabs(); } catch { tabs = []; }
        let n = 0;
        for (const t of tabs) {
          try { if (await adapterFor(t?.url)) n++; } catch { /* skip this tab */ }
        }
        lines.push(`chrome: up · ${n} brain tabs`);
      } else {
        lines.push('chrome: off');
      }
    } catch { lines.push('chrome: off'); }

    // warm — THE ACTIVE THREADS KEPT WARM (operator 2026-07-26: "must show active threads
    // kept warm, info about them, size from total"). pool.stats() already exposed
    // { size, max, keys }; this shows the roster instead of just the count.
    //
    // `size/max` is the headline because it is the thing that is easy not to know: max
    // defaults to 6 (src/warm-sessions.mjs) and the live config leaves it unset, so with
    // ~100 conversations in the registry the pool LRU-evicts constantly. Per entry:
    // the warm key (it already encodes <being>:<engine>:<surface>:<slug>), the live
    // context size, and what that size is OUT OF — the compaction threshold the SPINE
    // applies (src/spine/compaction.mjs compactionRatio, not compact-being's own 0.25
    // default parameter). This is a VIEW: nothing here evicts, compacts, or re-keys.
    //
    // The sessionId behind a key is not in the key, so it comes from compactionTargets —
    // whose whole contract is that its keys MATCH the warm-pool keys. A key with no
    // target (or no measurable session) still LISTS, marked, rather than vanishing.
    try {
      const s = warmStats();
      if (s && typeof s.size === 'number' && typeof s.max === 'number') {
        lines.push(`warm: ${s.size}/${s.max}`);
        const keys = Array.isArray(s.keys) ? s.keys : [];
        if (keys.length) {
          let targets = [];
          try {
            const st = loadState ? await loadState() : null;
            targets = compactionTargets({ config: cfg(), convState: st ?? {}, slugDir });
          } catch { targets = []; }
          const byKey = new Map(targets.map((t) => [t.key, t]));
          const ratio = compactionRatio(cfg());
          for (const key of keys) {
            const t = byKey.get(key);
            let detail = 'no session';
            if (t) {
              try {
                const { tokens, threshold } = dueFor(t, { ratio });
                const limit = threshold ?? Math.round((t.window || windowForModel(t.model)) * ratio);
                detail = tokens == null ? 'no session file' : `${tokens}/${limit} tok (${Math.round((tokens / limit) * 100)}% of compact)`;
              } catch { detail = '?'; }
            }
            lines.push(`  ${key}: ${detail}`);
          }
        }
      }
    } catch { /* omit */ }

    // shell — whether the operator's editor is dialed into the shell-port limb.
    try { lines.push(shellConnected() ? 'shell: connected' : 'shell: none'); }
    catch { lines.push('shell: none'); }

    return '```yaml\n' + lines.join('\n') + '\n```';
  }

  // Distinct participants seen in a transcript's tail: human senders (the
  // dispatch-line "Sender@[chat]…" shape, incl. its stage-direction "[ Sender@…" wrap)
  // and being replies ("[@being (HH:MM)]: …"), being names reported as "@<being>". No
  // member-roster store exists yet — conversation-members.mjs seeds a BRAIN roster from
  // config (residents_per_chat + auto-mode), not who actually spoke, so it doesn't answer
  // "who's in this conversation"; this reads the honest signal that already exists on
  // disk. Pure; `text` is front-matter-stripped first so `name:`/`---` lines never match.
  const _HUMAN_SENDER_RE = /^\[?\s*([^@\s][^@]*?)@\[/;
  const _BEING_REPLY_RE = /^\[@(\S+)\s\(\d{1,2}:\d{2}\)\]:/;
  function membersFromTranscript(text, { tailLines = 200 } = {}) {
    const lines = stripFrontMatter(String(text ?? '')).split('\n').slice(-tailLines);
    const seen = new Set();
    for (const line of lines) {
      const h = _HUMAN_SENDER_RE.exec(line);
      if (h) { seen.add(h[1].trim()); continue; }
      const b = _BEING_REPLY_RE.exec(line);
      if (b) seen.add(`@${b[1]}`);
    }
    return [...seen];
  }

  // /status <fragment> — the operator's per-conversation minimum: target resolved
  // through resolveTarget (the same resolver /agents' `=<slug>` binding uses), one fenced
  // yaml block reporting that conversation's name/path/mode/agent/personality/thread/members.
  // Every probe is
  // independently guarded; a degraded probe shows '?' (or 'unknown'/'not started'
  // where that reads clearer) — this never throws, matching bare /status.
  async function statusTarget(ev, term) {
    if (!loadState) return '/status: conversation state not wired';
    const surface = ev.surface ?? 'whatsapp';   // search origin only; downstream uses r.surface, the resolved TARGET (may differ, 2026-07-05)
    let state, r;
    try {
      state = await loadState();
      r = resolveTarget(state, term, surface);
    } catch (e) { return `/status: failed — ${e?.message ?? e}`; }
    if (r.error) return `/status: ${r.error}`;

    const c = getContact(state, r.surface, r.jid);
    const slug = c?.slug ?? r.name;
    const displayName = c?.entry?.pushedName ?? r.name;

    let convDir = null;
    try { convDir = slugDir(r.surface, slug); } catch { /* non-default surface */ }

    let convPath = c?.entry?.conversation_path;
    if (!convPath) { try { convPath = conversationPathOf(r.surface, slug); } catch { convPath = '?'; } }

    const b = getBeing(state, r.surface, r.jid, defaultKey);
    const mode = b?.mode ?? `${DEFAULT_AUTO_MODE} (default)`;

    // The persona's LIVE brain def (phase 1, operator 2026-08-14): there is no more
    // per-conversation freeze to read — every conversation's engine/model/effort/tools
    // resolve fresh from config every turn, so /status previews the SAME def brainpool.mjs's
    // turn() would actually run, via the SAME function (resolveDefaultBrainDef —
    // name-the-existing-thing, not a second derivation).
    let previewDef = null;
    try {
      const raw = resolveDefaultBrainDef({ getConfig: cfg, brains, convDir, brainType: CCODE });
      previewDef = raw?.dangerously_skip_permissions === true ? raw : coerceAllowedTools(raw);
    } catch { previewDef = null; }

    // Personality: the resolved type file's `personality:` field, else 'egpt' (the shipped
    // default) — exactly what brainpool.mjs's turn() feeds a fresh thread's kickoff.
    const personality = previewDef?.personality ?? 'egpt';

    let members = 'unknown';
    if (convDir) {
      try { members = membersFromTranscript(await readFile(join(convDir, 'transcript.md'), 'utf8')).join(', ') || 'unknown'; }
      catch { members = 'unknown'; }
    }

    // Prefer the per-chat stats file's per-message counters (count + last_seen) when present,
    // each id resolved to a friendly label through the aliases map; degrade to the
    // transcript-derived name list above when the file is missing/unreadable or carries no
    // members (never throws). The stats file now lives OUTSIDE the conversation dir, under
    // state/stats/<surface>/<chatId>.yaml — read it via the module's own path helper (keyed
    // by the chat id r.jid) so this call site can't drift from where the spine writes it.
    if (convDir) {
      try {
        const statsFp = await statsPath(r.surface, r.jid, { name: displayName, io, rename: false });
        const m = YAML.parse(await readFile(statsFp, 'utf8'))?.members;
        if (m && typeof m === 'object' && Object.keys(m).length) {
          const aliases = cfg().aliases ?? {};
          // Label preference: operator-chosen alias > the entry's own name (the sender's push
          // name, written by the collector) > the raw id.
          members = Object.entries(m)
            .map(([id, v]) => `${aliases[id] ?? v?.name ?? id}: ${v?.count ?? 0} (last ${v?.last_seen ?? '?'})`)
            .join(', ');
        }
      } catch { /* no stats file / unreadable → keep the transcript derivation */ }
    }

    // Optional: this conversation's own heartbeat count (source/cwd pinned to convDir),
    // omitted when it can't be resolved (matches bare /status's optional `mode`).
    let hb = null;
    try {
      const doc = YAML.parse(await readFile(join(EGPT_HOME, 'heartbeats.readonly.yaml'), 'utf8'));
      // `source` is the profile-relative RUNG FILE now, so the match is on `cwd` (the
      // entity folder, which is what an entity beat runs in).
      if (Array.isArray(doc?.heartbeats) && convDir) hb = doc.heartbeats.filter((h) => h?.cwd === convDir).length;
    } catch { hb = null; }

    // THREAD SIZE (operator 2026-07-26): the live context size of this thread and the
    // threshold it is compacted at. Both come from compact-being — latestContextTokens via
    // dueForCompaction — never re-derived here, and the ratio is the one the SPINE applies.
    // Omitted entirely when no thread has started: there is nothing to measure, and a
    // fabricated 0 would read as "empty" rather than "not yet".
    let context = null;
    if (b?.threadId) {
      try {
        const model = previewDef?.model ?? cfg().default_brain?.model ?? 'haiku';
        const ratio = compactionRatio(cfg());
        const { tokens, threshold } = dueFor({ sessionId: b.threadId, model, window: windowForModel(model) }, { ratio });
        const limit = threshold ?? Math.round(windowForModel(model) * ratio);
        if (tokens != null) context = `${tokens}/${limit} tok (compact at ${Math.round(ratio * 100)}% of ${windowForModel(model)})`;
      } catch { context = null; }
    }

    // Always the LIVE resolved def now (phase 1) — the same fields every turn actually runs
    // with, not a frozen snapshot.
    const agentVal = previewDef?.name ?? 'egpt';
    const engineVal = previewDef?.type ?? CCODE;
    const modelVal = previewDef?.model ?? DETERMINISTIC_MODEL;
    const effortVal = previewDef?.effort ?? DETERMINISTIC_EFFORT;
    const toolsRaw = previewDef?.allowed_tools ?? DEFAULT_ALLOWED_TOOLS;
    const toolsVal = Array.isArray(toolsRaw) ? `[${toolsRaw.join(', ')}]` : (toolsRaw ?? '?');

    const lines = [
      `name: ${displayName}`,
      `surface: ${r.surface}`,
      `slug: ${slug}`,
      `conversation_path: ${convPath}`,
      `mode: ${mode}`,
      `agent: ${agentVal}`,
      `engine: ${engineVal}`,
      `model: ${modelVal}`,
      `effort: ${effortVal}`,
      `allowed_tools: ${toolsVal}`,
      `personality: ${personality}`,
      `thread_id: ${b?.threadId ?? 'not started'}`,
      ...(context ? [`context: ${context}`] : []),
      `members: ${members}`,
    ];
    if (hb != null) lines.push(`heartbeats: ${hb}`);
    // RUNG ATTRIBUTION (operator 2026-07-26). This is the CONVERSATION report, so it names
    // the three files that could have supplied any value above, nearest last — the order
    // src/spine/config-resolver.mjs layers them in. ~/.egpt/conversations.readonly.yaml is
    // where the per-value answer lives; a fenced ops line points at it rather than
    // reprinting it.
    lines.push(
      'config_rungs:',
      `  1: ${NODE_FILE}`,
      `  2: ${REGISTRY_FILE}`,
      `  3: ${convPath ? `${String(convPath).replace(/\/?$/, '/')}config.yaml` : '?'}`,
      '  resolved: conversations.readonly.yaml',
    );
    return '```yaml\n' + lines.join('\n') + '\n```';
  }

  // RETIRED (operator 2026-08-14, phase 1): armWizard/stepWizard/applyWizard/
  // applyCustomWizard/applyToolsWizard used to freeze a picked agent-type/model/effort/
  // tools into the target conversation's `readonly` block. There is no more `readonly` to
  // freeze — engine/model/effort/tools now always resolve fresh from config.yaml every
  // turn (brainpool.mjs's resolveDefaultBrainDef) — so the whole mechanism had nothing
  // left to do and was deleted, not left inert.
  //
  // RETIRED AGAIN (operator 2026-08-15): the ENTIRE /e / /egpt command family (auto/reset/
  // access, and the bare-/e usage reply that followed) is gone too — replaced by /agents,
  // which reaches any resident being in any conversation instead of only defaultKey (see the
  // § /agents dispatch + agentsCmd/agentsReset/agentsAuto/agentsAccessLevel/agentsStatus
  // above). `/e`/`/egpt` now carry no special meaning at all and fall through to the generic
  // catch-all like any other unrecognized token.

  return { isCommand, run, runCaptured, remoteNode, nodeCommandForMe, makeNodeExplicit, currentRoomOf };
}
