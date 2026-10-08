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
import { isAutoMode, AUTO_MODES, DEFAULT_AUTO_MODE, isDeliberateSilence, superModeOf } from '../auto-mode.mjs';
import { patchBeing, patchContact, deleteBeing, getContact, getBeing, ensureContact, recordThread, findThreadJsonl, aliasContact, dropContact, aliasTargetOf, superChannelFor, residentsOf, slugDir, statsPath, conversationPathOf, seedIdentityLayers, skeletonIdentityFiles, slugSuffix, rollTranscript, DETERMINISTIC_MODEL, DETERMINISTIC_EFFORT, DEFAULT_ALLOWED_TOOLS, LOBBY_SLUG } from '../conversations-state.mjs';
import { stripFrontMatter } from '../transcript-meta.mjs';
// WHERE A SANDBOXED BEING'S CLI STORE LIVES — the ONE formula, taken from the module that
// CREATES it (src/sandbox-cli-session.mjs) rather than rebuilt here, so the two verbs that retire
// a thread can move the store instead of orphaning it. See moveCliStore below.
import { jsonlStoreDirOf } from '../sandbox-cli-session.mjs';
import { coerceAllowedTools, resolveDefaultBrainDef, resolveBeingDef } from './brainpool.mjs';
import { loadPermissionLevel, ACCESS_LEVELS, isAccessLevel } from './permission-levels.mjs';
// THE wake vocabulary (router.mjs) — `/agents <verb> <handle>` takes a HANDLE, so it resolves
// through the SAME scan a typed @mention goes through, never a matcher of its own. `addressed`
// over a single already-extracted token is the house single-token lookup (src/spine/mesh.mjs's
// findAgentByToken, src/spine/heartbeat-loader.mjs's `agent:`); `addressableTokens` LISTS the
// valid handles in the refusal. See agentsCmd's HANDLE → KEY block.
import { addressed, addressableTokens } from './router.mjs';
import { stat as fsStat, readFile as fsReadFile, writeFile as fsWriteFile, mkdir as fsMkdir, readdir as fsReaddir, rm as fsRm, rename as fsRename } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, basename } from 'node:path';
import * as YAML from 'yaml';
import { EGPT_HOME } from '../egpt-home.mjs';
import { shortChatId } from '../bridges/chat-id.mjs';
// "did you mean …?" for the two /members misses that used to be dead ends (operator
// 2026-08-31) — the scorer lives in src/text-similarity.mjs beside the echo one, so
// this module never grows a fuzzy-match of its own.
import { closestNames } from '../text-similarity.mjs';
import { ownNodeNamesOf, knownNodeNames } from './node-names.mjs';
import { Room, ROOMS_ROOT } from '../room-core.mjs';
import { SHELL_SURFACE } from './identity.mjs';
// The room slug rule (fixedSlugFor, surface `room`) applied to a READ, which must not mint —
// see roomOnDisk. NOT for the /rooms verbs: they pass the operator's raw string through.
import { sanitizeName, sanitizeSlug } from '../sanitize.mjs';
import { loadAdapters as defaultLoadAdapters, matchAdapter } from '../adapters/registry.mjs';
import { agentPaths } from '../mesh/relay.mjs';
import { compactionTargets, dueForCompaction, windowForModel, compactionPolicy, compactionOverrideOf } from '../tools/compact-being.mjs';
import { compactionRatio } from './compaction.mjs';
import { NODE_FILE, REGISTRY_FILE, parseEntityConfig } from './config-resolver.mjs';
import { CONFIG_YAML_PATH, writeConfigKey } from '../tools/config-io.mjs';
import { resolveConfigKey } from '../../config/config-schema.mjs';
import { isRunning as cdpIsRunning, listTabs as cdpListTabs, cdpHost as cdpHostOf, openTab as cdpOpenTab, activateTarget as cdpActivateTarget, closeTab as cdpCloseTab } from '../tools/cdp.mjs';
import { findChromeExecutable, chromeArgs, chromeCommandLine, resolveBrainProfile, spawnChrome } from '../tools/chrome-launcher.mjs';
import { helpText } from '../interpreter.mjs';
import { uploadNote, radioNoteFilename, pickSpeaker } from '../radio-relay.mjs';
import { stripNodeSignature, stripRenderedNodeSignature } from '../node-signature.mjs';
import { bodyForMessageId } from '../transcript-log.mjs';
import { readRoomConfig } from '../rooms-file.mjs';
import { hhmm, dayBoundary } from '../dispatch-line.mjs';

// Where a manually-launched Chrome should keep its profile. v1's shell hardcoded
// ~/.egpt/chrome/profiles/brain — a usually-BLANK fresh dir. resolveBrainProfile() instead
// SEARCHES the v2 default + the operator's v1 browser profiles and picks the one actually
// logged in to an AI site, falling back to the v2 default when none qualify. Memoized once at
// module load (a read-only fs scan); still derives from EGPT_HOME so a second node follows its
// own root. See src/tools/chrome-launcher.mjs.
export const CHROME_BRAIN_PROFILE = resolveBrainProfile();

// The scheduled task a SESSION 0 spine fires to put Chrome on the operator's visible desktop (see
// the banner over the chrome() dispatch for which spine takes which path, and why).
// setup/register-chrome-task.ps1 registers it; the Session-0 spine triggers it with
// `schtasks /run /tn egpt-chrome`.
export const CHROME_LAUNCH_TASK = 'egpt-chrome';
const CHROME_LAUNCH_TIMEOUT_MS = 20000;   // how long to wait for a cold Chrome to bind its CDP port
const CHROME_LAUNCH_POLL_MS = 500;

// Default launch seam: fire the scheduled task and report whether schtasks accepted it. A
// non-zero exit (the task isn't registered) or a spawn error both surface as { ok: false },
// which drives /chrome's graceful fallback. Tests inject a fake so no real schtasks runs.
// It IGNORES its arguments, and that is not sloppiness — it is the seam's defining limitation:
// the task's command line was frozen when the task was registered (port 9221 and one profile),
// so a port or a profile handed in here has nowhere to go. Half of why chunk 6 exists.
function defaultLaunchChromeTask() {
  try {
    const r = spawnSync('schtasks', ['/run', '/tn', CHROME_LAUNCH_TASK], { windowsHide: true });
    return { ok: r.status === 0 };
  } catch { return { ok: false }; }
}

// The CDP port out of the host this node will ATTACH to — ONE formula, shared by the launch hint
// and the direct launcher, so "launch on the port I will attach to" can never become two answers.
const chromePortOf = (host) => String(host).split(':')[1] ?? '9221';

// The --user-data-dir a launch should use: config `chrome.profile_dir` when the operator set one,
// else the discovered brain profile. CONFIGURATION BEATS DISCOVERY, and the schema says why in its
// own words — profile_dir names "a REAL, already-logged-in profile kept for the purpose", and it is
// the same path a being is TOLD to drive CDP on (30-pointers.md). A spine that launched Chrome into
// some other directory would hand its beings a browser logged in to nothing they were promised.
// resolveBrainProfile() is the fallback precisely because it is a HEURISTIC: it scans for a profile
// that has been used on an AI site. Unset ⇒ CHROME_BRAIN_PROFILE ⇒ byte-identical to before.
const chromeProfileOf = (c) => c?.chrome?.profile_dir || CHROME_BRAIN_PROFILE;
// The executable: config `chrome.bin`, else null — which lets chrome-launcher run its own
// per-platform CHROME_PATHS search. Never a second locator here.
const chromeBinOf = (c) => c?.chrome?.bin || null;

/**
 * THE SESSION 1 LAUNCH SEAM: spawn Chrome as an ordinary child of this spine. boot.mjs injects it
 * over `launchChrome` for a Session 1 successor and for nobody else (chunk 6,
 * plans/2609061200-SESSION-0-TO-1-HANDOVER-PLAN.md); the banner over the chrome() dispatch carries
 * the session argument.
 *
 * NOT A SECOND SPAWNER. The executable search, the flag set, the profile mkdir and the spawn itself
 * are all chrome-launcher's spawnChrome — the very file chromeLaunchHint already renders its
 * command line from, which is what keeps "what I would run" and "what I tell you to run" one thing.
 * What this wrapper adds is the two things a scheduled task could never give: ARGUMENTS (a port and
 * a profile resolved per call, instead of frozen at registration) and SUPERVISION.
 *
 * SUPERVISION IS OBSERVATION, NOT OWNERSHIP — a decision, not an omission. The spine now learns
 * three facts `schtasks /run` cannot return: that the spawn was accepted, and the pid; that CDP
 * came up on the port it will attach to (chromeReport's existing poll); and that the browser died,
 * at the moment it died. It does NOT restart it. The ordinary reason a browser exits is that the
 * operator closed it, and relaunching would be arguing with them; /chrome is already the relaunch
 * verb, one word long and idempotent (isRunning() is the launch decision). A restart POLICY — how
 * many, how fast, whether a crash-looping Chrome is retried at all — is a ruling nobody has made,
 * and inventing one would put an unattended respawn loop in the runtime path.
 *
 * Returns the seam's shape, WIDENED but compatible: `ok` is all /chrome's fallback reads, and
 * `direct` / `pid` / `detail` are additive. The task hop returns none of them, so its path — every
 * node in Session 0, and every injected fake in the suite — is untouched.
 */
export async function launchChromeDirect({ port, userDataDir, bin = null, spawn: spawnFn = spawnChrome, onLog = () => {} } = {}) {
  try {
    const { pid, command } = await spawnFn({
      port,
      userDataDir,
      bin,
      // The death notice. Logged, never acted on — see SUPERVISION above.
      onExit: ({ code, signal, error }) => onLog(error
        ? `the browser this spine launched on :${port} never started — ${error?.message ?? error}`
        : `the browser this spine launched on :${port} exited (${signal ? `signal ${signal}` : `code ${code}`}) — nothing is being restarted; /chrome launches another`),
    });
    // NO PID MEANS NOTHING STARTED — Node sets pid synchronously on a successful spawn and leaves
    // it undefined when the spawn failed (a chrome.bin that is not there). Reporting ok:true here
    // would make /chrome sit out the whole CDP timeout and then blame the PORT instead of the
    // binary. The child's 'error' event still arrives through onExit a tick later.
    if (!pid) return { ok: false, direct: true, detail: `nothing started — the spawn returned no pid for ${command}` };
    onLog(`launched pid ${pid} on :${port} — ${command}`);
    return { ok: true, direct: true, pid, detail: command };
  } catch (e) {
    // The same graceful shape the task hop uses for "not registered": /chrome degrades to the hint.
    // `direct` still true — the hint needs to know WHICH seam failed so it does not tell a Session 1
    // operator to go register a scheduled task that would not help them.
    const detail = String(e?.message ?? e);
    onLog(`direct launch failed — ${detail}`);
    return { ok: false, direct: true, detail };
  }
}

// A fresh room's config.yaml — a commented placeholder (like the seeded templates,
// seed.mjs). Pure comments → parses to null, so the heartbeat/transcription loaders read
// it as an empty {}. Members are later work — no roster block yet. (The room's directives/
// layers are a SEPARATE seeding step in roomCreate below, beside ensureTree — the same
// shared config/skeletons/room/ template a conversation seeds, copied per-room.)
// A created room gets NO config file of its own: the ROOM RUNG lives in
// config/rooms.yaml, keyed `<surface>/<slug>`, and a room with no row simply
// resolves to {} (operator 2026-08-24 — a conversation folder is the being's).

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

// The rooms on disk: the immediate subdirectories of the ROOMS root (each folder IS a room —
// a room is a conversation on surface `room`, 2026-08-09, whose folder sits outside the Beeper
// tree, operator 2026-08-28). The root comes from room-core's surface→root map, never a
// second formula here. Never throws — a missing dir yields []. Injected in tests.
function defaultListRoomNames() {
  try {
    return readdirSync(ROOMS_ROOT, { withFileTypes: true })
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

// /recap (operator 2026-09-27) — THE ONE COMMAND ANYBODY MAY TYPE ("anybody can type /recap"):
// isCommand admits it from any sender, because all it does is read a chat's own backlog back to that
// same chat. One pattern, read by that gate and by run()'s dispatch, so the two cannot disagree.
const RECAP_CMD = /^\/recap\b/i;

// /recap's listing: one line per message the chat sent while the node slept — sender, local time,
// the first ~100 characters — in stamp order, whitespace folded so a message is one line. The clock
// is transcript.md's (hhmm, the node's zone), and the day is said ONCE where it changes, the
// transcript's own convention (dayBoundary): a night's sleep spans two dates, and HH:MM alone would
// not say which. Never called with an empty list — see the dispatch.
const RECAP_BODY_CHARS = 100;
function recapText(messages, timeZone) {
  const lines = [`${messages.length} message${messages.length === 1 ? '' : 's'} in the backlog:`];
  let day = null;
  for (const m of [...messages].sort((a, b) => a.ts - b.ts)) {
    const d = dayBoundary(m.ts, timeZone);
    if (d !== day) { lines.push(d); day = d; }
    const body = String(m.body ?? '').replace(/\s+/g, ' ').trim();
    lines.push(`${m.sender} (${hhmm(m.ts, timeZone)}): ${body.length > RECAP_BODY_CHARS ? `${body.slice(0, RECAP_BODY_CHARS)}…` : body}`);
  }
  return lines.join('\n');
}

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

// § COMMAND GRAMMAR — one shape for the whole surface (operator 2026-08-28 / 2026-08-29).
//
//     /<commands> <verb> [<value>] <target> [<scope>]
//
// Plural command word, verb second, and the thing being acted on LAST — so on /agents the
// being and the conversation end up adjacent (`auto mention p spoiler`) instead of with the
// value wedged between them. Deliberate cost, chosen by the operator over the alternative:
// the target's slot moves with the verb's arity (slot 2 in `rethread p`, slot 3 in `auto
// mention p`). That is the price of keeping the scope chain contiguous, and it is only
// payable because every verb's arity is FIXED and its value comes from a closed set.
//
//   /agents <handle>|all [<conv>]                             status
//   /agents refresh|rethread|reset <handle>|all [<conv>]
//   /agents mode <mode> <handle>|all [<conv>]                 (`auto` is a deprecated alias of `mode`)
//   /agents access_level <level> <handle>|all [<conv>]        (level: see ACCESS_LEVELS)
//
// The object-first order (`/agents e rethread`) is GONE — operator 2026-08-29, "remove legacy
// ways". It is DETECTED and named rather than left to misparse: a line that silently does the
// wrong thing is worse than one that tells you what to type. `=<slug>` still says the same
// thing as the trailing <conv>; saying it both ways is an error, not a precedence rule.
//
// THE THREE CONVERSATION-LIFECYCLE VERBS (operator 2026-09-10). They were two, and the two
// conflated three distinct things:
//
//   refresh   re-feed identity + directives INTO THE RUNNING THREAD. Context untouched,
//             nothing moved, no new thread.
//   rethread  mint a NEW thread. transcript.md moves to transcripts/. The folder stays put.
//   reset     UNCHANGED. The whole folder moves to conversations/archive/, pristine one minted.
//
// `restart` PARSES but never ACTS (RETIRED_AGENT_SUBS below). It was this verb's name from
// 2026-08-15 until 2026-09-10, and the operator ruled the word off precisely because the
// spine's own lifecycle exit code 43 already means RESTART THE PROCESS — one word cannot mean
// both "restart this node" and "give this conversation a new thread". Keeping the token
// parseable is what lets it be REFUSED BY NAME instead of falling through to be misread as a
// handle; it is the same treatment the retired object-first order gets, for the same reason.
export const AGENT_SUB_ARITY = { refresh: 0, rethread: 0, reset: 0, mode: 1, access_level: 1, restart: 0 };
// Parsed, named, and refused — never executed. verb -> the verb that replaced it.
export const RETIRED_AGENT_SUBS = { restart: 'rethread' };
// DEPRECATED-BUT-STILL-WORKING verb aliases: the old spelling keeps ACTING (unlike a RETIRED sub,
// which is refused by name), resolved to its live verb before anything downstream reads it.
// `auto` was this verb's name until 2026-10-08 and is ALSO an auto-mode VALUE (`/agents auto auto
// e`) — the exact confusion the rename to `mode` removes — so it stays live for habit and for
// configs/scripts that already type it, while `mode` is the one the surface teaches.
export const AGENT_SUB_ALIASES = { auto: 'mode' };
// Canonicalize an alias to its live verb; identity for a non-alias (and for null). ONE definition,
// used by the parser below and the retired-order rebuild, so the alias can never resolve two ways.
const canonicalAgentSub = (verb) => AGENT_SUB_ALIASES[verb] ?? verb;
// The verbs that actually DO something, derived so a retired token can never leak into an
// operator-facing list by being forgotten in a hand-kept literal.
const LIVE_AGENT_SUBS = Object.keys(AGENT_SUB_ARITY).filter((v) => !Object.hasOwn(RETIRED_AGENT_SUBS, v));
// Every level name in the operator-facing text comes from ACCESS_LEVELS (permission-levels.mjs),
// never a literal: the tier list is spelled out in ONE place, and a new tier updates this line,
// the refusals below and /help together or not at all. Same rule now holds for the verb list.
export const AGENTS_USAGE = `usage: /agents [<verb>] [<value>] <handle>|all [<conversation>] — verbs: refresh | rethread | reset | mode <${AUTO_MODES.join('|')}> | access_level <${ACCESS_LEVELS.join('|')}>. Bare \`/agents <handle>|all\` shows status. <conversation> is the rest of the line, spaces and all: \`/agents refresh e eGPT Rodz Lulu An\`.`;

// args (already whitespace-split) -> what agentsCmd wants: { args: [handle, verb, value],
// slug }, or { retired } for the old order. Pure; exported for tests.
//
// The conversation is EVERYTHING after the handle, joined with single spaces (operator
// 2026-09-28: "please enable: /agent refresh <agent> <channel slug> so i can fire from eGPT
// Admin"). It was one token, and chat names and slugs carry spaces (`eGPT Rodz Lulu An-
// 2609201419`), so `refresh e eGPT Rodz Lulu An` resolved "eGPT" and answered `don't know
// where to put "Rodz Lulu An"`. With nothing left over in any shape, that reply went too.
export function normalizeAgentsArgs(args) {
  // Alias → live verb BEFORE the arity lookup, and the canonical verb is what downstream reads:
  // `auto` is resolved to `mode` here so the dispatch, confirmations and help all speak one verb.
  const verb = canonicalAgentSub(args[0]?.toLowerCase());
  if (verb && Object.hasOwn(AGENT_SUB_ARITY, verb)) {
    const takesValue = AGENT_SUB_ARITY[verb] === 1;
    const value = takesValue ? args[1] : undefined;
    const handle = takesValue ? args[2] : args[1];
    return { args: [handle, verb, value], slug: args.slice(takesValue ? 3 : 2).join(' ') || null };
  }
  // No leading verb: either the bare status form (`<handle> [<conv>]`) or the retired
  // object-first order, which is recognisable exactly — and worth recognising, to say so. The
  // second token is canonicalized too, so `e auto mention` is still caught as the old order.
  const second = canonicalAgentSub(args[1]?.toLowerCase());
  if (second && Object.hasOwn(AGENT_SUB_ARITY, second)) {
    return { retired: { handle: args[0], verb: args[1], rest: args.slice(2) } };
  }
  return { args: [args[0]], slug: args.slice(1).join(' ') || null };
}

// The whole surface is PLURAL (operator 2026-08-29: "we should keep only '/agents', '/rooms',
// and the singular asking you means plural?"). The singular is NOT silently aliased — it asks.
// An alias would work forever and teach nothing; a question is answered once.
export const PLURAL_OF = { agent: 'agents', room: 'rooms', member: 'members' };
export const SINGULAR_CMD = /^\/(agent|room|member)(?:=\S+)?(?:\s+[\s\S]*)?$/i;

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

// The SHELL is node-local: the spine SERVES 127.0.0.1:23375 and the operator's editor dials in
// (direction inverted 2026-08-26 — src/bridges/shell-port.mjs header), so no other node ever
// sees a shell message. NOTE what that does and does not buy (corrected 2026-08-21):
// node-locality is a ROUTING fact, not a security one — loopback is dialable by any local
// account, so the limb AUTHENTICATES the editor (a nonce/HMAC handshake under the node's
// shell.token, src/shell/auth.mjs) before treating its frames as the operator's. What matters
// here is only the routing half. Everywhere else this node speaks is a chat on the shared Beeper
// account, where a co-account peer heard the very same message and answers through its own gate —
// which is exactly why a peer addressed THERE must not also be sent an envelope.
// SHELL_SURFACE (identity.mjs) is that surface — `room`, the console's own home and the
// operator-named rooms beside it. Every one of them is node-local for the same reason: a room
// has no transport at all, so no co-account peer can have heard it either.
const NODE_LOCAL_SURFACES = new Set([SHELL_SURFACE]);

// ── /join + /split + /send + /end (operator 2026-10-03) ─────────────────────────────────────────
// A "fork" was always TWO things; they are split into two commands.
//   /join  — SUPERPOSITION. Spin a private side-group (operator + Rodz) whose chatId is ALIASED to
//            this chat's on-disk conversation (conversations-state aliasOf), so the being keeps
//            writing its ONE thread and the group is just a second surface. No thread copy, no new
//            folder — two chats, one conversation. This is a VIEW, not a branch.
//   /split — REAL FORK. Spin a side-group backed by a NEW conversation (its own folder/entry, NOT an
//            alias) whose resident beings' threads are COPIED from the original so it DIVERGES.
//   /send  — relay a chosen (replied-to) message back to the ORIGINAL chat. Repeatable; works in a
//            /join group (alias target) OR a /split group (its recorded parent_chat).
//   /end   — archive the group (both kinds) and drop its mapping.
// The user-facing TEXTS live in config (operator: "all goes in config.yaml") — config.join.placeholder
// / config.split.placeholder (what the /join | /split message is edited into) and config.group_title
// (the new group's name, a {group}+{name} template). These are the small built-in FALLBACKS so a
// command never edits to an empty string or makes an untitled group when a key is unset; the real
// text is set in config.yaml on each node. Exported so tests assert the fallback without
// re-hardcoding the strings.
export const JOIN_PLACEHOLDER_DEFAULT = '🤖↔️🤔 ...';
export const SPLIT_PLACEHOLDER_DEFAULT = '🍴🤖 ...';
export const GROUP_TITLE_DEFAULT = 'egpt {name} {group}';
// /send's posting account when config.send.post_back_from is unset or invalid: the operator's OWN
// account (primary) — /send relays as the operator, who typed it (operator 2026-10-04). The config
// override config.send.post_back_from='secondary' still routes via the mouth when set.
export const SEND_POST_BACK_FROM_DEFAULT = 'primary';
// config.join.opener / config.split.opener (a {group}=parent-chat-title template) — the one message
// posted into the freshly-created side-group FROM RODZ so the otherwise-empty group SURFACES in Beeper
// (Beeper hides a chat with no messages — verified live). These are the small built-in fallbacks when
// the key is unset; the real text is set in config.yaml. Exported so tests assert the fallback.
export const JOIN_OPENER_DEFAULT = '🔗 Side-room of {group} — same agents, same conversation. Reply /send to a message to copy it back to the original chat; /end to close.';
export const SPLIT_OPENER_DEFAULT = '🍴 Fork of {group} — a diverging copy: same agents, its own thread from here. Reply /send to a message to copy it back to the original chat; /end to close.';
// ── super channel (operator 2026-10-08, CHUNK 1) ────────────────────────────────────────────────
// A per-conversation SIDE CHANNEL where the Mouth will (a later chunk) speak, so its replies stop
// polluting the main chat. It is the SAME KIND of thing as a /join side-room — an ALIAS of the
// original conversation (shares its folder/thread/transcript, "one transcript per group"), NOT a
// /split-style diverging copy. Created + aliased by REUSING /join's create+alias path
// (createAliasedSideGroup below), summoned by an inbound "…"/"..." (deliberate-silence) from ANY
// participant. These are the small built-in fallbacks when config.super.* is unset; the real values
// live in config.yaml. Exported so tests assert the fallback without re-hardcoding the strings.
export const SUPER_SUFFIX_DEFAULT = '-super';
export const SUPER_MODE_DEFAULT = 'on';
export const SUPER_OPENER_DEFAULT = '🌟 Super channel of {chat} — same agents, same conversation. The bot speaks here so {chat} stays clear. Reply /send to a message to copy it back to the original chat; /end to close.';
// The side-group opener poll (operator 2026-10-03): Beeper creates the group on the SECONDARY account
// ASYNCHRONOUSLY, so its own room id for the new group may take a moment to list. Poll a few times,
// short delay, through the injectable sleep seam — the same shape createGroup's async-create wait uses.
const OPENER_POLL_ATTEMPTS = 5;
const OPENER_POLL_MS = 500;

// claude's projects/<dir> naming rule — the FORWARD of conversations-state.reverseSanitizeCwd: a cwd
// becomes a project-dir by replacing \ / : . _ with '-'. /split copies the forked jsonl into the dir
// matching the SPLIT conversation's cwd so a cwd-scoped `--resume` finds it under the split's box store.
const sanitizeCwdDir = (p) => String(p).replace(/[\\/:._]/g, '-');

// THE SPLIT COPY IS A TRANSFORM, not a byte copy (coordinator 2026-10-01, verified against a real
// boxed session file; resurrected from the pre-alias fork, commit 86daf94). Every claude-code jsonl
// record carries `sessionId: "<the filename id>"`, and user records carry `cwd: "<that conversation's
// folder>"`. A raw copy to `<newThreadId>.jsonl` would leave every record disclaiming its own id and
// pointing at the ORIGINAL folder, so `--resume <newThreadId>` loads a session that denies it is that
// session — the "silently blank fork". So rewrite, per line, `sessionId` → the new thread id and `cwd`
// → the SPLIT conversation's own folder, on every record that has each field; leave every other field
// (uuid/parentUuid/message/timestamp/type) untouched. A line that does not parse as JSON passes through
// VERBATIM (never dropped). Exported so the rewrite is unit-testable with no fs; the caller does the
// read/write through the injectable io seam.
export function rewriteForkSessionJsonl(raw, { sessionId, cwd }) {
  return String(raw).split('\n').map((line) => {
    if (!line) return line;                 // blank line (incl. the trailing one) stays blank
    let rec;
    try { rec = JSON.parse(line); } catch { return line; }   // non-JSON → verbatim
    if (rec && typeof rec === 'object' && !Array.isArray(rec)) {
      if ('sessionId' in rec) rec.sessionId = sessionId;
      if ('cwd' in rec) rec.cwd = cwd;
    }
    return JSON.stringify(rec);
  }).join('\n');
}

// The one id form that addresses the SECONDARY account (Rodz) from the PRIMARY account's roster is
// the PHONE NUMBER (idKey in src/bridges/beeper.mjs; @dolly-egpt:beeper.com is the secondary's
// OWN-account id and does NOT reach it from here — investigation 2026-10-01). phoneDigitsOf returns
// the bare digits of a phone-shaped id, or null for anything else (a matrix/@user id, a slug, a name).
function phoneDigitsOf(v) {
  const s = String(v ?? '').trim();
  const d = s.replace(/\D/g, '');
  return (/^\+?[\d\s().-]+$/.test(s) && d.length >= 7) ? d : null;
}

// Resolve the SECONDARY account's (Rodz's) participant id for /fork, from config ALONE (operator
// correction 2026-10-01: the two accounts are named by `config.beeper.primary.phone` and
// `config.beeper.secondary.phone`, not the old peer_spine construct). Rodz is whichever of the two
// is NOT this install's own number (selfIds). Fewer than two phones, or no unique partner after
// exclusion => null => the caller STOPS rather than create a group with a wrong/missing member.
// Pure + exported so the rule is unit-tested, and so boot can swap it.
export function resolveSecondaryParticipantId(config, selfIds = []) {
  const phones = [...new Set([config?.beeper?.primary?.phone, config?.beeper?.secondary?.phone].map(phoneDigitsOf).filter(Boolean))];
  if (phones.length < 2) return null;
  const selfSet = new Set((Array.isArray(selfIds) ? selfIds : []).map(phoneDigitsOf).filter(Boolean));
  const others = phones.filter((d) => !selfSet.has(d));
  return others.length === 1 ? `+${others[0]}` : null;
}

export function createCommands({
  getConfig = () => ({}),
  send: rawSend,                         // (chatId, text) -> deliver a plain system reply
  exit = (code) => process.exit(code),
  writeRewindTarget,
  // /standdown's port, the same shape writeRewindTarget has and injected by the same call in
  // boot.mjs. It was MISSING here while the ingest box already had it, so a `/standdown <port>`
  // typed at the console or in Self parsed its port and then dropped it on the floor: the exit
  // code was right, the sidecar was never written, and the daemon silently fell back to this
  // profile's own console port. Harmless while the two agree — wrong the moment they do not, and
  // this is the door the Session 1 successor's announce comes in through (successor-announce.mjs).
  writeStanddownTarget,
  loadState = null, writeState = null,   // conv-state IO — lets /agents mode persist a mode
  brains = null,                         // the brain registry (createBrains) — /agents' status + access_level, and /status's own preview, resolve a being's live def through it (brainpool.mjs's resolveBeingDef / resolveDefaultBrainDef)
  defaultKey = 'e',                      // the persona being-id (its map key), injected by boot from the single `default:true` agent — the persona's per-conversation mode/state reads+writes and its warm-key prefix all key off this, never a hardcoded 'e' (operator 2026-07-10)
  // ── THE BRAIN'S OWN TWO SEAMS (brainpool.mjs `scopeOf` / `evict`) ─────────────────────────
  // Injected from boot as the SAME brain instance createTurns takes, so a command can never
  // resolve a being's address — or its warm entry — differently from the turn that will run it.
  // Both are OPTIONAL: absent (standalone construction, a test that needs neither) a conversation
  // is its own scope and nothing is evicted, byte-identical to an unscoped node.
  scopeOf = null,                        // (being, ev) -> { surface, chatId } — WHERE this being's instance lives; a chat invited into a room as a `wa-group` member resolves to THAT ROOM
  evictWarm = () => {},                  // (being, ev) -> drop that being+conversation's warm session so /agents access_level's re-point respawns fresh. brain.evict: a lastKeyByConv LOOKUP of the last warm key this pair actually ran — never a key string rebuilt here
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
  // (surface, chatId) → { slug, room, path } — the per-surface transcript FILE helper
  // (contacts.transcriptTarget, boot-injected), the SAME write==read resolver the transcript
  // service files through. The quoted-message readers (/send + /read) key on its `.path` so a
  // message quoted inside a /join side-room resolves against the side-room's own transcript-<key>.md,
  // never the shared transcript.md. Absent (standalone/tests) → the readers fall back to
  // room.transcriptPath, byte-identical to before.
  transcriptTarget = null,
  // Chat NAME → canonical chat id, for `/members add group <name>` (operator 2026-08-29: the
  // operator types the chat's NAME, not the id they'd have to go dig up). THE bridge's own
  // resolver (src/bridges/beeper.mjs resolveChatId — name-or-slug match, cached, walks EVERY
  // chat page before giving up), injected by boot, exactly as src/spine/mesh.mjs's canonRoute
  // takes it. Same degrade convention as there: a null resolver (standalone/tests that don't
  // need one) is not an error — but `add group <name>` then REFUSES rather than adding the
  // raw string as an id, because a bogus member id fails silently at relay time.
  resolveChatId = null,
  // The bridge's chat LIST (src/bridges/beeper.mjs listChats — the same cached, paginated
  // walk resolveChatId itself reads), injected by boot. NOT a second resolver and never
  // consulted for one: no code path here turns an operator argument into a member id
  // through this. It exists for exactly two MESSAGES that were dead ends (operator
  // 2026-08-31) — `add group`'s "no chat named" now offers name near-misses off the very
  // list the resolver just walked, and the "no member" roster now NAMES a wa-group member
  // whose stored id is the only thing on disk about it. Same degrade convention as
  // resolveChatId: absent (or throwing) simply makes those two messages shorter.
  listChats = null,
  // The root the sandboxed CLI stores sit under (~/.egpt-jsonl). Injectable purely for tests, the
  // SAME DI convention — and the same resolver — src/sandbox-cli-session.mjs uses for the write
  // side, so the mover and the writer can never disagree about the path. Nothing in production
  // overrides it. Only /agents rethread + /agents reset read it, through moveCliStore.
  jsonlStoreRoot = null,
  // THE LAUNCH SEAM for /chrome, and WHICH ONE a spine gets is decided by its Windows session —
  // in boot.mjs, once, never here (see the banner over the chrome() dispatch). The DEFAULT is the
  // Session 0 task hop: `schtasks /run /tn egpt-chrome`, defaultLaunchChromeTask. A SESSION 1
  // successor gets launchChromeDirect instead, which spawns Chrome as an ordinary child.
  // Called with { port, userDataDir, bin } — the task hop ignores all three because its command
  // line was frozen when the task was registered, which is exactly the limitation the direct
  // launcher exists to lift. Returns { ok } — false when the task isn't registered (schtasks
  // non-zero), when the spawn errored, or when the direct launcher could not start a browser —
  // and that false is what drives /chrome's graceful fallback to the hint. MAY BE ASYNC: the call
  // site awaits, so a synchronous { ok } (the task hop, and every fake in the suite) is unchanged.
  // Tests inject a fake, so no test ever runs schtasks or spawns a real browser.
  launchChrome = defaultLaunchChromeTask,
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
  // THE transcript reply writer (src/spine/transcript.mjs createTranscript.log) — boot injects
  // `services.transcript.log`, the SAME function every being's reply and every command reply
  // (via wrapCommandsForTranscript) already goes through. /agents rethread's accum boundary is
  // its one caller: no command hand-assembles a transcript line. No-op default so a standalone
  // /test-constructed createCommands never writes to disk.
  logTranscript = async () => {},
  // Live status-line room reflection (operator 2026-08-16): fired (surface, slug|null) any
  // time currentRoom changes — roomJoin, roomLeave, and roomDelete's bulk clear below. `null`
  // means "no current room" (roomLeave / roomDelete's clear); a slug means "now current"
  // (roomJoin). Safe no-op default so a standalone/test createCommands never needs it — boot
  // injects the real one (recompute computeShellHeader → shellPort.setHeader) for surface 'shell' only.
  onRoomChange = () => {},
  // /recap's two seams (operator 2026-09-27). backlogOf(ev) is THE SPINE's list of the messages this
  // chat received while the node slept (src/spine/spine.mjs backlogOf: [{ sender, ts, body }], kept
  // per chat, replaced at every wake) — boot late-binds it, the spine being built after this. The
  // zone is the transcript clock's (boot's transcriptTimeZone), so a time here reads like the same
  // message's line in transcript.md. Defaults: no backlog, UTC.
  backlogOf = () => [],
  timeZone = null,
  // ── /join + /split + /send + /end seams (operator 2026-10-03) ────────────────────────────
  // /join aliases a new side-group to this chat's conversation; /split backs the group with a NEW
  // conversation diverged from this one; /send relays a chosen message back to the original chat;
  // /end archives the group. forkBridge groups the beeper facade methods the verbs need — all off
  // the SAME bridge the chat lives on (boot wires them off the ear's PORT, which forwards each of
  // these to the raw beeper bridge where they are defined; resolveChatId/listChats already come off
  // it). editMessage edits the operator's /join|/split message in place (raw, no persona — a marker,
  // not E speaking). postReply posts text into a chat; its 4th arg `{ via }` names the posting
  // account ('primary' = the operator's own, 'secondary' = the mouth — config.send.post_back_from),
  // which boot resolves to the matching connection's bridge. chatAccountId/chatTitle resolve the
  // original chat's account + display name for the group create. Safe no-op defaults so a
  // standalone/test createCommands never touches a real bridge.
  forkBridge = {
    editMessage:   async () => false,   // (chatId, msgId, text) -> bool
    createGroup:   async () => null,    // ({accountID, participantIDs, type, title, messageText}) -> { success, chatID } | null
    postReply:     async () => false,   // (chatId, text, replyToMessageID, { via }) -> truthy on success
    archiveChat:   async () => false,   // (chatId) -> bool
    chatAccountId: async () => null,    // (chatId) -> the accountID the chat lives on
    chatTitle:     async () => null,    // (chatId) -> the chat's display title
    resolveUserIdByPhone: async () => null,   // (phoneDigits, { accountID }) -> "@whatsapp_lid-…:beeper.local" | null
    resolveSecondaryChatIdByTitle: async () => null,   // (title, { accountID }) -> the SECONDARY account's own room id for the group titled `title` | null
  },
  // Per-command audit sink (operator 2026-10-08): (text) => Promise<bool>, posts ONE metadata-only line
  // to config.log_to_group through boot's fail-closed resolver+poster (noticeToChannel). Safe no-op
  // default so a standalone/test createCommands audits nowhere; a failed/absent post never affects a
  // command (the chokepoint swallows it).
  logToGroup = async () => false,
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
  // only now: /rooms marks it "(current)", /rooms <slug> leave clears it. It NO LONGER gates
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
  // ev.mesh routes it to THIS node's own lobby instead (SHELL_SURFACE + LOBBY_SLUG — the
  // console's home room, whose chatId IS its name, fixedSlugFor's fixed mapping), through the
  // SAME resolveConvRoom seam every other room resolution uses. Mesh is unconditional and
  // unaffected by anything below.
  //
  // The JOINED-ROOM default (operator 2026-08-17, generalizing the 2026-08-16 /agents-only fix):
  // "this conversation" means the room currently /rooms join'd on this surface, when one is
  // joined — exactly what redirectShellToRoom (boot.mjs) does for PROSE fan-out and what
  // /agents' own bare-target resolution already did for itself. currentRoomOf's stored value is
  // always a room SLUG (roomJoin: `currentRoom.set(surfaceOf(ev), slug)`, the same slug
  // /rooms create/join addresses on surface 'room' — see redirectShellToRoom's `network: 'room',
  // chatId: room`), so the fallback resolves it there, never through the caller's own surface.
  // No room joined → currentRoomOf returns null → falls through to today's behavior
  // (surfaceOf(ev), ev.chatId) byte-for-byte, unchanged. This is the ONE choke point every
  // room-scoped command funnels through, so fixing it here fixes all of them at once.
  // The (surface, chatId) a room-scoped command is acting in — extracted so the Room (convRoomOf)
  // and the per-surface transcript FILE (radioQuickReply) resolve from ONE selector and can never
  // disagree about which conversation a command targets.
  const convScopeOf = (ev) => {
    if (ev?.mesh) return { surface: SHELL_SURFACE, chatId: LOBBY_SLUG };
    const joined = currentRoomOf(surfaceOf(ev));
    return { surface: joined ? 'room' : surfaceOf(ev), chatId: joined ?? ev.chatId };
  };
  const convRoomOf = (ev) => { const s = convScopeOf(ev); return resolveConvRoom(s.surface, s.chatId); };

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
    const peers = cfg().peer_nodes;
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

  // rs — the RADIO quick reply (operator 2026-08-08): a single top-level string of its own,
  // radio_quick_reply_string, DEFAULT "rs", "" disables. It reads a QUOTED message aloud through
  // the SAME isOperator-gated path /radio say does (see radioQuickReply below). It once shared a
  // paragraph with the `r` agent quick reply, which was evicted root and branch (operator
  // 2026-08-28: "so we evict r. it was a bad idea, you can just use 'e'"); this key is unrelated
  // to that one and unaffected by its removal.
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
  // …EXCEPT /recap, which anybody may type (RECAP_CMD, above — operator 2026-09-27). It is the ONLY
  // exception: every other command, lifecycle included, still needs the operator.
  function isCommand(ev) {
    const body = String(ev?.body ?? '').trim();
    if (isOperator(ev) && isRadioQuickReply(ev)) return true;
    if (!body.startsWith('/')) return false;
    return isOperator(ev) || RECAP_CMD.test(body);
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

  // ── PER-COMMAND AUDIT → log_to_group (operator 2026-10-08) ─────────────────────────────────────
  // run() is THE dispatch chokepoint, so the audit is emitted here ONCE for every slash command,
  // never sprinkled into the handlers. The line is METADATA ONLY — "/<cmd> in <chat> by <sender> →
  // <outcome?>" — and NEVER carries any part of the command's reply body, so a /config dump, a /recap
  // listing or a contact list can never leak into the log group. <outcome> is appended only where a
  // silent/side-effecting handler returns one (today: /end — "archived <chat>" or the no-op reason).
  // Posting is fail-closed and swallowed here, so whether the audit lands never changes a command's
  // own behavior or reply. logToGroup is boot's wired sink (unset log_to_group → OFF, silently).
  const NO_AUDIT = Symbol('no-audit');   // runDispatch returns this when nothing auditable ran on THIS node
  const auditCommand = async (ev, cmd, outcome = null) => {
    const chat = ev?.chatName || ev?.chatId || '?';
    const who = ev?.senderName || ev?.senderId || 'someone';
    // ev.msgHash (bridges/beeper.crossAccountMsgKey) is carried IDENTICALLY on both co-account nodes
    // for the same inbound command, so the sink uses it to converge the two nodes' lines onto ONE
    // message (boot's logToGroup → audit-merge.mjs). It is a content hash, never any reply body, so
    // the audit stays metadata-only. A sink that ignores the 2nd arg (the standalone default) is
    // unaffected.
    try { await logToGroup(`/${cmd} in ${chat} by ${who}${outcome ? ` → ${outcome}` : ''}`, { key: ev?.msgHash ?? null }); }
    catch { /* fail-closed: a broken audit never breaks the command */ }
  };
  // THE WRAPPER around the dispatch: run the command, then emit the ONE audit line. A '/'-command the
  // dispatch handled on THIS node is audited (outcome inline when the handler returned one); NO_AUDIT
  // (a command addressed to ANOTHER node — it audits there) and a non-'/'-message (the rs radio quick
  // reply) are not. The token is read from ev.body so an `=<node>` binding (/tab=do) still audits as /tab.
  async function run(ev) {
    const outcome = await runDispatch(ev);
    if (outcome === NO_AUDIT) return;
    const m = /^\/(\w+)/.exec(String(ev?.body ?? '').trim());
    if (!m) return;
    await auditCommand(ev, m[1], typeof outcome === 'string' ? outcome : null);
  }

  async function runDispatch(ev) {
    let line = String(ev.body ?? '').trim();

    // rs — THE RADIO QUICK REPLY: the one non-slash message isCommand ever routes here for
    // (see isCommand above) — every other non-slash line never reaches run() at all.
    if (isRadioQuickReply(ev)) { await radioQuickReply(ev); return; }

    const code = lifecycleExit(line, { writeRewindTarget, writeStanddownTarget });
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
    if (addressed && !ownNodeNamesOf(cfg()).has(addressed.node)) return NO_AUDIT;   // another node owns it — it audits there, not here
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

    // The singular of a plural command ASKS (operator 2026-08-29: "the singular asking you
    // means plural?"). Deliberately not an alias: an alias works forever and teaches nothing,
    // a question is answered once. Placed ahead of every plural dispatch — none of them can
    // match a singular anyway (`/agents` needs the s, `/rooms` needs it, `/members` needs it),
    // so this only ever claims lines that would otherwise have fallen through to the brain.
    const singular = SINGULAR_CMD.exec(line);
    if (singular) {
      const one = singular[1].toLowerCase();
      await send?.(ev.chatId, `/${one} → did you mean \`/${PLURAL_OF[one]}\`? the commands are plural.`);
      return;
    }

    // /agents[=<slug>] <handle>|all [refresh|rethread|reset|mode <mode>|access_level <level>] —
    // the general per-being command surface (operator 2026-08-15, retires /e + /egpt entirely).
    // /e's whole family was hardcoded to defaultKey (the persona's own map key) — "a failure
    // in design" now that every resident being (the persona AND a sibling like wren) is
    // configured identically under agents.<being> with no per-conversation freeze (phase 1/2):
    // `/e reset` wiped ONLY agents.<defaultKey>, so a sibling resident on the very same
    // conversation survived untouched by a reset meant to cover "this conversation". /agents
    // fixes that by taking the being explicitly, never assuming defaultKey.
    //
    //   /agents <handle>|all [<conv>]                             → status (bare, see agentsStatus)
    //   /agents refresh <handle>|all [<conv>]                     → re-feed identity + directives into the RUNNING thread
    //   /agents rethread <handle>|all [<conv>]                    → clear threadId + roll transcript.md; everything else survives
    //   /agents reset <handle>|all [<conv>]                       → archive + wipe + reseed
    //   /agents mode <mode> <handle>|all [<conv>]                 → was /agents auto <mode> (alias kept), and /e auto <mode>
    //   /agents access_level <level> <handle>|all [<conv>]        → was /e access all|regular
    //
    // See § COMMAND GRAMMAR at module scope for the shape and why the target trails.
    // `[<conv>]` and `=<slug>` are the same thing said two ways.
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
      const raw = (agentsMatch[2] ?? '').trim().split(/\s+/).filter(Boolean);
      const { args, slug, retired } = normalizeAgentsArgs(raw);
      // The retired object-first order gets its own line back, rebuilt into the new one —
      // naming the exact replacement, not just the rule.
      if (retired) {
        // A verb that was ALSO renamed (restart -> rethread) or ALIASED (auto -> mode) is rebuilt
        // under its LIVE name, so one reply fixes both mistakes instead of sending the operator
        // round a second refusal for the old word.
        const vraw = retired.verb.toLowerCase();
        const verb = RETIRED_AGENT_SUBS[vraw] ?? canonicalAgentSub(vraw);
        const fixed = AGENT_SUB_ARITY[canonicalAgentSub(vraw)] === 1
          ? `/agents ${verb} ${retired.rest[0] ?? '<value>'} ${retired.handle}`
          : `/agents ${verb} ${retired.handle}`;
        await send?.(ev.chatId, `/agents: the verb comes first now — \`${fixed}\``);
        return;
      }
      if (slug && agentsMatch[1]) { await send?.(ev.chatId, `/agents: conversation named twice (=${agentsMatch[1]} and ${slug}) — name it once`); return; }
      await agentsCmd(ev, agentsMatch[1] || slug || null, args);
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

    // /rooms — bare: list the saved rooms. Otherwise `/rooms <verb> [<room>]`, routed to the
    // same room() the singular /rooms used to reach. /rooms itself is retired (operator
    // 2026-08-29: "keep only '/agents', '/rooms'") and now answers the plural question below.
    const roomsMatch = /^\/rooms(?:\s+(\S+))?(?:\s+(.+?))?\s*$/i.exec(line);
    if (roomsMatch) {
      const verb = roomsMatch[1]?.toLowerCase() || null;
      if (!verb) { await send?.(ev.chatId, await roomsList(ev)); return; }
      await room(ev, verb, roomsMatch[2]?.trim() || null);
      return;
    }

    // /members … — the CURRENT room's roster. Bare: list. `add tab <n>`: adapter-match a
    // Chrome tab and add it as a disabled brain. `mode <disable|mention|all> <id>`: flip a
    // member's mode. Pre-catch-all so none leak to E. Plural only — /member asks below.
    const membersMatch = /^\/members(?:\s+(.+?))?\s*$/i.exec(line);
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

    // /recap — what THIS chat said while the node slept (operator 2026-09-27), the answer to the
    // wake notice "N messages in the backlog. type /recap to list them". Read out in the chat it was
    // typed in, and only that chat's own messages. Pre-catch-all, same slot as /help.
    // NOTHING TO LIST ⇒ SILENT (operator "ok", 2026-09-27): on a shared account every co-account
    // node hears the same /recap, and the one that never slept must not answer beside the one that did.
    const recapMatch = RECAP_CMD.exec(line);
    if (recapMatch) {
      const backlog = backlogOf(ev);
      if (backlog.length) await send?.(ev.chatId, recapText(backlog, timeZone));
      return;
    }

    // /activate <id> — reopen a brain member whose Chrome tab was closed (its saved
    // targetId is no longer live), refreshing its targetId. A no-op when already live.
    const activateMatch = /^\/activate\s+(\S+)\s*$/i.exec(line);
    if (activateMatch) { await activate(ev, activateMatch[1]); return; }

    // /join — type /join [<name>|<node>] to spin a private side-group that is a VIEW (alias) of this
    // chat's conversation (one shared thread, two chats); /split — /split [<name>|<node>] spins a
    // side-group backed by a NEW, DIVERGING conversation (its beings' threads are copied); /send —
    // reply /send to a message in either group to relay it back to the original chat; /end — reply
    // /end in either group to archive it and drop its mapping (operator 2026-10-03). They sit
    // pre-catch-all like the rest. Operator-only automatically: isCommand gates every '/'-verb except
    // /recap behind isOperator, so no handler re-checks it (same as chrome/radio). NOT in
    // NODE_ADDRESSABLE: a /join/split node override is parsed by the handler itself (`/join do` or
    // `/join=do`). Each handler STANDS DOWN SILENTLY on the node that is not the right one (not the
    // node_role=primary / addressed node for /join+/split; no alias-or-parent for /send+/end), so a
    // shared Beeper account never double-answers. Written as `<name>Match = /^\/word…` so the /help
    // drift guard (tests/spine-commands.test.mjs) sees them.
    const joinMatch = /^\/join\b[\s\S]*$/i.exec(line);
    if (joinMatch) { await joinGroup(ev); return; }
    const splitMatch = /^\/split\b[\s\S]*$/i.exec(line);
    if (splitMatch) { await splitGroup(ev); return; }
    const sendMatch = /^\/send\b[\s\S]*$/i.exec(line);
    if (sendMatch) { await sendToOriginal(ev); return; }
    const endMatch = /^\/end\b[\s\S]*$/i.exec(line);
    if (endMatch) { return await end(ev); }   // end() returns its outcome string (archived / no-op) for the audit line

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
  // ⚠️ WHICH SPINE MAY SPAWN CHROME DIRECTLY IS DECIDED BY ITS WINDOWS SESSION, AND THE
  //    DECISION IS MADE ONCE IN boot.mjs — NOT HERE. A SESSION 1 SPINE SPAWNS. A SESSION 0
  //    SPINE HOPS THROUGH THE SCHEDULED TASK. DO NOT COLLAPSE THE TWO INTO EITHER ONE. ⚠️
  //
  // WHAT SESSION 0 ACTUALLY COSTS — corrected 2026-09-06, because the note that stood here
  // overstated it and the overstatement is worth naming. Session 0 isolation removed the ability
  // to SEE a service's windows. It never removed the ability to RUN there: Session 0 has a window
  // station, a desktop and a compositor, so a browser started in it launches, renders and serves
  // CDP perfectly well. MEASURED ON reve THAT DAY, read-only, off the listening ports:
  // chrome.exe pid 2388 answering CDP on :9224 — SessionId 0 — beside two Chromium-based Beeper
  // Desktops on :9223 / :9225, all three in Session 0. setup/install-beeper-s0-service.ps1 has
  // said so in its own header all along, and those Session 0 Desktops are the feature built on it.
  //
  // So the reason a Session 0 spine does not spawn its own browser is not CAPABILITY, it is
  // VISIBILITY AND INTERACTION. A child inherits its parent's session (verified live 2026-07-15:
  // spine pid 19696 SessionId 0, explorer.exe SessionId 1), so a Chrome that spine started would
  // render on a desktop nobody can look at: the operator cannot see it, cannot click it, and
  // cannot answer the login prompt it puts up — and since Chrome single-instances per
  // --user-data-dir, an unseen one squatting the brain profile is also a browser the operator can
  // no longer open in their own session. /chrome exists to give the OPERATOR a browser, so on that
  // spine the launch has to LEAVE the session: a scheduled task registered with LogonType
  // Interactive runs in Session 1, and `schtasks /run /tn egpt-chrome` fires it (the seam's
  // default, defaultLaunchChromeTask) — the same proven pattern as the egpt-lock-on-logon task.
  // setup/register-chrome-task.ps1 registers it once per node; until then the seam reports
  // { ok:false } and /chrome falls back to handing over the command line, as before. (A browser
  // deliberately driven in Session 0 with nobody watching is a DIFFERENT feature, and it does not
  // come in through /chrome.)
  //
  // A SESSION 1 SPINE IS ALREADY ON THE OPERATOR'S DESKTOP, so for it the hop buys nothing and
  // costs everything the plan lists: `schtasks /run` is fire-and-forget, takes NO ARGUMENTS (the
  // task's command line was frozen at registration — port 9221 and one profile), and returns
  // nothing but "accepted", so the spine can never learn whether the browser came up, on which
  // port, or that it died. It spawns instead, through the ONE launcher (chrome-launcher's
  // spawnChrome — the same file the hint below renders its command line from), with the port it
  // will attach to and the profile config names, and it watches the child. boot.mjs makes that
  // swap for EGPT_SESSION1=1 alone, by overriding the launchChrome seam; every other node keeps
  // the default, and this dispatch does not branch at all.
  //
  // ATTACHING is fine across sessions either way: CDP is plain localhost HTTP, and the session
  // boundary isolates window stations/desktops, not the loopback network. This is exactly how the
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

  // THE ONE LAUNCH PATH — /chrome's, and since 2026-09-26 a boxed being's `browser start` too
  // (startBrowser below; operator: "for now only the browser"). Two callers, one function, so the
  // browser a being asks for is exactly the browser /chrome would have opened: same seam (the
  // Session 0 task hop or a Session 1 spine's direct spawn, whichever boot injected), same port,
  // same profile, same wait. Every probe is wrapped: an unreachable Chrome is the NORMAL resting
  // state, not an error. Never throws. Resolves { host, running, launched, pid, direct, why }.
  //
  // ONE LAUNCH AT A TIME. Two beings asking at once — or a being and the operator's /chrome — must
  // not fire two launches at one profile, so a call that arrives while a launch is in flight JOINS
  // it and gets the same answer. Nothing is queued: the next call after it settles probes afresh,
  // and finds the browser up.
  let _ensuring = null;
  function ensureChrome() {
    if (_ensuring) return _ensuring;
    _ensuring = (async () => {
      let host = '?';
      try { host = await cdp.cdpHost(); } catch { host = '?'; }

      // Is Chrome already up? (isRunning is the launch decision — NOT whether listTabs works.)
      let running = false;
      try { running = await cdp.isRunning(); } catch { running = false; }
      if (running) return { host, running: true, launched: false, pid: null, direct: false, why: '' };

      // Not listening → fire the launch seam, then poll for it to bind its CDP port. THE ARGUMENTS
      // ARE THE POINT of the Session 1 path: the port is the one this node will ATTACH to (never the
      // task's frozen 9221) and the profile is the one config names, so the browser that comes up is
      // the browser /chrome then talks to. The task hop ignores both, exactly as it always has.
      // chromeProfileOf is the ONE place the profile is decided (today config's chrome.profile_dir;
      // the per-group profile of the operator's 2026-09-22 design belongs there, not in a caller).
      let ok = false, direct = false, why = '', pid = null;
      try {
        const r = await launchChrome({ port: chromePortOf(host), userDataDir: chromeProfileOf(cfg()), bin: chromeBinOf(cfg()) });
        ok = !!r?.ok;
        direct = !!r?.direct;          // which seam answered — the hint's remedy differs (below)
        pid = r?.pid ?? null;
        if (!ok) why = r?.detail ?? '';
      } catch { ok = false; }
      if (ok) running = await waitForChromeUp();
      return { host, running, launched: running, pid, direct, why };
    })().finally(() => { _ensuring = null; });
    return _ensuring;
  }

  // What a failed launch says, for both callers: the direct spawn's own detail (or that it never
  // bound the port), and nothing for the task hop — whose remedy, registering the task, is the
  // hint's setup note, not a sentence of its own.
  const triedOf = (r) => (r.direct ? (r.why || `it never bound :${chromePortOf(r.host)} within ${Math.round(CHROME_LAUNCH_TIMEOUT_MS / 1000)}s`) : null);

  // A BOXED BEING'S `browser start` (src/spine/being-link.mjs): the launch path above and nothing
  // else — no arguments reach it from the being, and it lists no tabs (that is the operator's
  // report). Idempotent: when CDP already answers it launches nothing and says so.
  async function startBrowser() {
    const r = await ensureChrome();
    if (r.running && !r.launched) return { ok: true, alreadyRunning: true, detail: `the browser is already answering on ${r.host} — nothing was launched` };
    if (r.running) return { ok: true, launched: true, detail: `the browser is up on ${r.host}${r.pid ? ` (pid ${r.pid})` : ''}` };
    return {
      ok: false,
      reason: 'launch-failed',
      detail: triedOf(r) ?? `the launch task did not bring a browser up on ${r.host} — it may not be registered on this node (setup/register-chrome-task.ps1)`,
    };
  }

  // The report body. When none is listening the launch path above fires the seam and waits; a
  // task that isn't registered, a direct launch that failed, or a Chrome that never binds its port
  // all degrade to the launch hint. Never throws.
  async function chromeReport() {
    const r = await ensureChrome();
    const host = r.host;
    const launchedPid = r.launched ? r.pid : null;
    if (!r.running) {
      return chromeLaunchHint(host, {
        // The setup note tells the operator to register the scheduled task. That is the remedy on
        // the Session 0 path and NOT on the Session 1 one, where this spine tried to spawn the
        // browser itself — so a direct failure reports what it tried instead of misdirecting.
        setupNote: !r.direct,
        tried: triedOf(r),
      });
    }

    // Reachable (already, or after a successful launch) → attach + report tabs. A tab-list
    // hiccup on a live Chrome degrades to the hint WITHOUT the launch note (Chrome is up).
    let tabs = null;
    try { tabs = await cdp.listTabs(); } catch { tabs = null; }
    if (!tabs) return chromeLaunchHint(host);

    const lines = [`attached: ${host}`];
    // The pid is the one fact `schtasks /run` could never hand back, so when this spine launched
    // the browser itself it says so. The task hop returns no pid, so its report is unchanged.
    if (launchedPid) lines.push(`launched: pid ${launchedPid}`);
    lines.push(`tabs: ${tabs.length}`);
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
  // paths, not when Chrome is up but tab-listing hiccupped. `tried` replaces the "I can't open
  // it myself" line on a SESSION 1 spine, which can and did try: saying it cannot would be a lie,
  // and it is the one sentence in this reply an operator acts on.
  function chromeLaunchHint(host, { setupNote = false, tried = null } = {}) {
    const port = chromePortOf(host);
    const exe = findChromeExecutable() ?? 'chrome';
    const args = chromeArgs({ port, userDataDir: CHROME_BRAIN_PROFILE });
    const lines = [
      `no Chrome is listening on ${host}.`,
      tried
        ? `I tried to open one myself and it didn't come up — ${tried}.`
        : `I can't open it myself — I run as a service in another Windows session, so any Chrome I start would be invisible to you.`,
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

  const ROOM_USAGE = 'usage: /rooms | /rooms create <name> | /rooms join|leave|members <room> | /rooms delete [force] <room>';
  // remove/mode take `<id|name>` for the same reason add group does (operator 2026-08-31):
  // all three now run the SAME argument through the SAME resolver, so the usage line stops
  // implying that only one of them knows what a chat name is.
  const MEMBERS_USAGE = 'usage: /members | /members add tab <n> [alias=<name>|<name>] | /members add group <chat name|id> | /members remove <id|name> | /members mode <disable|mention|all> <id|name>';
  // A slug with no folder on disk — the members path and the delete path both need to say
  // this instead of acting as though it exists (bug fix 2026-08-07: "/rooms help" rendered
  // "help (0 members)", a roster fabricated for a room that was never created — 'help' just
  // happened to parse as a slug under the OLD slug-first grammar, like any typo would).
  const noRoomMsg = (slug) => `no room '${slug}' — /rooms lists them, /rooms create ${slug} makes it`;

  // ─────────────────────────────────────────────────────────────────────────────
  // /rooms — the named-room router (Phase 2). VERB-first: the first token is always matched
  // against the fixed verb set {create, join, leave, members, delete, help} and the room
  // name comes from `rest`. This replaced a slug-first grammar (first token = room, second
  // = sub-verb) after a live bug: an unrecognized first token silently defaulted to
  // sub==='members' and was looked up as a room name, so "/rooms help" rendered a fabricated
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
      // Labelled by the room's OWN slug, not the raw token — `/rooms members FOO` is the
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
    await send?.(ev.chatId, `/rooms: unknown verb "${first}" — create|join|leave|members|delete`);
  }

  // /agents[=<slug>] <handle>|all [refresh|rethread|reset|mode <mode>|access_level <level>] — THE
  // dispatcher (operator 2026-08-15, retires the whole /e/egpt family — see its own comment
  // at the dispatch site above for the "failure in design" this closes). Parses the already-
  // tokenized args ([handle-or-'all', subcommand?, value?] — the regex above split them),
  // validates the subcommand + its value up front, resolves the target conversation through
  // slugArg (bare = HERE, given = resolveTarget — identical to /e auto/reset's <target>), then
  // resolves the handle set — a typed HANDLE resolved to its being KEY through the wake
  // vocabulary (see the HANDLE → KEY block below), or every residentsOf() entry for `all`,
  // ordered defaultKey-first when resident so the persona reads first in a multi-being
  // reply/status — and routes to the per-subcommand handler. Every handler below takes the
  // ALREADY-resolved (surface, jid, where, handles[, …, state, named]) — none of them re-parse
  // or re-resolve. `named` is the reply's word for the being(s): the keys for `all`, and for a
  // single target the operator's own token plus the key when the two differ.
  async function agentsCmd(ev, slugArg, args) {
    const [handleArg, subRaw, valueRaw] = args;
    if (!handleArg) { await send?.(ev.chatId, AGENTS_USAGE); return; }
    if (!loadState || !writeState) { await send?.(ev.chatId, '/agents: conversation state not wired'); return; }
    const sub = subRaw?.toLowerCase() || null;
    // A RETIRED verb is refused BY NAME, before anything is resolved or written — never
    // silently aliased onto its replacement. `restart` in particular reads as a lifecycle verb
    // (exit 43 restarts the NODE), so quietly giving one conversation a new thread because the
    // operator typed it would be the exact class of "did something adjacent to what you meant"
    // this surface refuses elsewhere.
    if (sub && Object.hasOwn(RETIRED_AGENT_SUBS, sub)) {
      await send?.(ev.chatId, `/agents: "${subRaw}" is not a verb here any more — did you mean \`/agents ${RETIRED_AGENT_SUBS[sub]} ${handleArg}\`? (/restart is the NODE's lifecycle; ${RETIRED_AGENT_SUBS[sub]} gives this conversation a new thread). Nothing was changed.`);
      return;
    }
    if (sub && !LIVE_AGENT_SUBS.includes(sub)) {
      await send?.(ev.chatId, `/agents: unknown subcommand "${subRaw}" — ${LIVE_AGENT_SUBS.join('|')} (mode <${AUTO_MODES.join('|')}>, access_level <${ACCESS_LEVELS.join('|')}>). Verb first: /agents <sub> <handle>.`);
      return;
    }
    if (sub === 'mode') {
      const mode = valueRaw?.toLowerCase() || null;
      if (!mode) { await send?.(ev.chatId, `/agents: mode needs a value — one of: ${AUTO_MODES.join(', ')}`); return; }
      if (!isAutoMode(mode)) { await send?.(ev.chatId, `/agents: unknown mode "${mode}" — use one of: ${AUTO_MODES.join(', ')}`); return; }
    }
    // The level set is permission-levels.mjs's (isAccessLevel), so this validator can never
    // again lag a tier that module already resolves — which is exactly what happened to
    // 'sandbox': it worked everywhere except here, leaving a hand edit of conversations.yaml
    // as the only way in.
    if (sub === 'access_level' && !isAccessLevel(valueRaw?.toLowerCase())) {
      await send?.(ev.chatId, `usage: /agents access_level ${ACCESS_LEVELS.join('|')} <handle>|all`);
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
    // operator had /rooms join'd a room — silently writing to the shell's own lobby instead of
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
    // registry-block owner /rooms's members roster is silent on (residentsOf reads
    // entry.agents.<being> blocks, conversations-state.mjs). Ordered defaultKey-first (when
    // resident) so the persona is always the first block/reply in a multi-being result; the
    // rest keep residentsOf()'s own order.
    // ── THE ARGUMENT IS A HANDLE, THE RECORD IS KEYED BY THE KEY (operator 2026-09-17: "for
    // rethread the handles work to identify agent, so e and egpt are the same") ──────────────
    // It used to be `handles = [handleArg]` — whatever the operator typed became the being KEY
    // every verb below writes. On kg, where E is KEYED `egpt` and declares
    // `handles: [e, egpt, ekg, egptkg]`, `/agents rethread e` therefore cleared `threadId` on a
    // record named `e` that patchBeing invented on the spot, rolled the chat's transcript.md into
    // transcripts/ and answered ✅ — while E kept its thread. The chat lost its transcript and
    // gained nothing. Same for refresh/reset/auto/access_level and for the bare status view. The
    // fingerprint was live in kg's rooms.yaml: a stray `e:` block under room/lobby.agents holding
    // only `threadId: null` (migrations/0010-stray-handle-records.mjs removes it).
    //
    // Resolved through THE wake vocabulary, never a matcher of our own: `addressed` over the one
    // already-extracted token — the house single-token lookup (mesh.mjs's findAgentByToken,
    // heartbeat-loader's `agent:`), case-insensitive like every @mention, and a token TWO agents
    // claim is decided exactly the way the ROUTER decides it (first agent in map order wins — see
    // `byToken` in router.mjs's addressed), so /agents can never name a different being than the
    // one that same token would wake. `addressWithoutAt` is passed EXPLICITLY, as mesh.mjs and
    // heartbeat-loader do: a typed argument is bare, so the node's `dispatch.address_without_at`
    // switch (about chat prose) never governs it.
    //
    // THREE more arms, each a target that IS real but which the wake vocabulary deliberately does
    // not cover — none of them a second handle matcher:
    //   · the KEY itself. wakeTokens drops the key once `handles:` is declared, and that rule is
    //     about who a MESSAGE wakes; here the key is the RECORD NAME the verbs write, so it works.
    //   · defaultKey — the persona is real by definition, even with an empty agents: map (the same
    //     exemption agentsBeingBlock already makes).
    //   · a RESIDENT record — a being seeded by an earlier turn with no config.yaml entry is real,
    //     just unconfigured on this node (agentsBeingBlock says exactly that).
    // Order matters and this is the order: a CLAIMED handle beats residency, so kg's stray `e:`
    // record can never win `e` back from egpt and re-create the very bug above.
    //
    // Anything else is not a being here: REFUSED by name, with what IS addressable, and returned
    // before a single write or transcript roll. `named` is what the REPLY calls the being — as
    // typed, plus the key when they differ, because "✅ e rethread" while the record says `egpt`
    // is how this went unnoticed.
    let handles, named;
    if (handleArg === 'all') {
      // `all` = every being residentsOf() finds on that conversation's entry — the exact
      // registry-block owner /rooms's members roster is silent on (residentsOf reads
      // entry.agents.<being> blocks, conversations-state.mjs). Ordered defaultKey-first (when
      // resident) so the persona is always the first block/reply in a multi-being result; the
      // rest keep residentsOf()'s own order. These are KEYS already — nothing to resolve.
      const entry = getContact(state, surface, jid)?.entry;
      handles = residentsOf(entry);
      if (handles.includes(defaultKey)) handles = [defaultKey, ...handles.filter((h) => h !== defaultKey)];
      if (!handles.length) { await send?.(ev.chatId, `/agents: no resident beings ${where}`); return; }
      named = handles.join(', ');
    } else {
      const typed = handleArg.toLowerCase();
      const agentsMap = (cfg() ?? {}).agents ?? {};
      const residents = residentsOf(getContact(state, surface, jid)?.entry);
      // A HANDLE, NEVER A KEY (operator 2026-09-17: "it's not the key, is the handle, we said").
      // `addressed` IS the resolution — the router's own lookup over each agent's wake vocabulary,
      // which already falls back to the map key for an agent that declares no `handles:`. Nothing
      // else resolves: a key that its own agent does not answer to belongs to ANOTHER NODE's being
      // of the same name (both nodes key their persona `egpt`; kg's answers to `e`, do's to `d`),
      // and both nodes hear every operator command — so `/agents rethread egpt` answered TWICE
      // live on 2026-09-17, each node rethreading a different being.
      // ...and the one thing a handle cannot name: a being with NO config.yaml entry, seeded into
      // this conversation by a turn. It has no handles to declare, so its record name is the only
      // name it has. A being config DOES declare is never reachable this way — it is addressed by
      // the handles it answers to, which is what keeps another node's `egpt` out of this.
      const configKey = (n) => Object.keys(agentsMap).some((k) => !k.startsWith('_') && k.toLowerCase() === n);
      const key = addressed(typed, agentsMap, { addressWithoutAt: true })[0]?.name
        ?? (!configKey(typed) ? residents.find((h) => String(h).toLowerCase() === typed) : null)
        ?? null;
      if (!key) {
        // NOT MINE, SO NOT MY ANSWER: the word names a being that exists here only as a key (or as
        // a record some turn seeded), so the node that answers to it is another one. It stays
        // silent rather than talking over the node that is doing the work.
        const elsewhere = configKey(typed) || String(defaultKey).toLowerCase() === typed;
        if (elsewhere) { onLog(`/agents: "${handleArg}" is a being KEY here, not a handle this node answers to — left for the node whose being answers to it`); return; }
        await send?.(ev.chatId, `/agents: no being ${where} answers to "${handleArg}" — nothing was changed. addressable: ${[...new Set(addressableTokens(agentsMap))].join(', ')}, all`);
        return;
      }
      handles = [key];
      named = typed === String(key).toLowerCase() ? key : `${handleArg} (${key})`;
    }

    if (sub === 'refresh') { await agentsRefresh(ev, surface, jid, where, handles, state, named); return; }
    if (sub === 'reset') { await agentsReset(ev, surface, jid, where, handles, state, named); return; }
    if (sub === 'rethread') { await agentsRethread(ev, surface, jid, where, handles, state, named); return; }
    if (sub === 'mode') { await agentsMode(ev, surface, jid, where, handles, valueRaw.toLowerCase(), state, named); return; }
    if (sub === 'access_level') { await agentsAccessLevel(ev, surface, jid, where, handles, valueRaw.toLowerCase(), state, named); return; }
    await send?.(ev.chatId, await agentsStatus(ev, surface, jid, handles, state, named));
  }

  // ── A BEING'S STATE LIVES AT ITS SCOPE, NOT AT THE CHAT THE COMMAND WAS TYPED IN ──────────
  // (operator 2026-09-22, measured live.) `/agents access_level all e` typed in the WhatsApp
  // group "perrito traduciones" answered `✅ e (egpt) access here → all` AND DID NOTHING: that
  // group is a `wa-group` member of room/acim, so — by identity-scope.mjs's whole reason for
  // existing — room/acim's E and the group's E are ONE being: one thread, one warm CLI, one
  // queue, one access_level. The write went into the group's own `agents.egpt` block, a record
  // the being never reads, and the eviction named a key (`egpt:ccode:whatsapp:perrito…`) that
  // was never open — the live one was `egpt:ccode:room:acim`.
  //
  // THE ADDRESS IS ASKED FOR, NEVER DERIVED. `scopeOf` is the brain's own seam (brainpool.mjs),
  // the SAME one createTurns asks for the turn key, so a command and the turn it is about can
  // never disagree. No scopeOf injected → the conversation IS its scope, `moved:false`, and
  // every verb below behaves exactly as it did before this existed.
  //
  // NEVER THROWS, and a scope that will not resolve falls back to the conversation itself — the
  // same safe direction identity-scope.mjs and brainpool's own scopeAddr take: being your own
  // instance is never WRONG, only narrower than the operator asked for.
  async function scopeAt(being, ev, surface, jid) {
    let s = null;
    try { s = await scopeOf?.(being, { ...ev, surface, chatId: jid }); }
    catch (e) { onLog(`/agents: scope ${being} ${surface}/${jid}: ${e?.message ?? e}`); }
    const moved = !!s?.surface && s.chatId != null && !(s.surface === surface && String(s.chatId) === String(jid));
    return moved ? { surface: s.surface, chatId: s.chatId, moved: true } : { surface, chatId: jid, moved: false };
  }

  // THE CONVERSATION-LEVEL VERBS (refresh/rethread/reset) act on ONE folder — they archive it,
  // roll its transcript.md, move CLI stores into its transcripts/. So they need ONE scope, and
  // `all` can in principle straddle two: a scope is per BEING as well as per chat (a node-wide
  // `agents.<being>.scope:` PIN, identity-scope.mjs's first rule). A split is REFUSED by name,
  // before a single write or transcript roll, rather than half-done across two folders.
  async function oneScope(handles, ev, surface, jid) {
    const scopes = [];
    for (const h of handles) scopes.push([h, await scopeAt(h, ev, surface, jid)]);
    const addrs = new Set(scopes.map(([, s]) => `${s.surface}/${s.chatId}`));
    if (addrs.size > 1) return { error: `${scopes.map(([h, s]) => `${h} lives in ${s.surface}/${s.chatId}`).join(', ')} — name them one at a time` };
    return scopes[0][1];
  }

  // WHAT THE CONFIRMATION CALLS THE PLACE. `here` after a write that landed on room/acim is the
  // very lie this fix is about, one layer up — so the moment ANY scope differs from the chat the
  // command was typed in, the reply names the address(es) it actually wrote instead. Unmoved (the
  // only possible answer on an unscoped node) it is the caller's own `where`, byte-for-byte.
  const whereWrote = (scopes, where) => (scopes.some((s) => s.moved)
    ? `on ${[...new Set(scopes.map((s) => `${s.surface}/${s.chatId}`))].join(', ')}`
    : where);

  // ── A RETIRING THREAD'S CLI STORE MOVES WITH ITS RECORD (operator 2026-09-11) ─────────────
  // 1087b63 put every sandboxed being's CLI session store at ~/.egpt-jsonl/<threadId> (see
  // src/sandbox-cli-session.mjs's CONFIG_DIR_ENV note for why it had to leave the scrubbed pool
  // profile). Nothing then ever moved it, so the two verbs that RETIRE a thread each left a bare
  // UUID behind with no link back to any conversation: the directory grew monotonically, and —
  // the real defect — an operator looking at one could not tell whose memory it was.
  //
  // MOVED, NEVER DELETED. `reset` archives and never deletes, and this file is not a copy of
  // transcript.md: it is the MODEL's own memory of the thread, the transcript a resumed turn
  // would have read. Nothing is destroyed here; if the disk is ever reclaimed that becomes one
  // retention decision about conversations/archive/, not a deletion hidden inside a verb.
  //
  // ONE MOVER, TWO DESTINATIONS, and both are the room's own transcripts/ — the folder that
  // already holds retired threads, so the store sits beside the transcript of the very same
  // thread and is findable by the same id:
  //   · rethread → <room>/transcripts/<threadId>.cli/   (beside the <threadId>.md it just rolled)
  //   · reset    → <archived folder>/transcripts/<threadId>.cli/   (the same place, carried off
  //     with the folder — an operator finds it in the same spot either way)
  //
  // AFTER THE VERB'S REAL WORK, ALWAYS, and that ORDER is the whole reason it can never break a
  // verb: rolling the transcript and archiving the folder both complete BEFORE this is called, so
  // a store that cannot be moved costs the operator a store, never the verb. It also makes both
  // destinations real by the time they are used — rollTranscript's ensureTree has just made
  // transcripts/, and reset's rename has just put the archived folder where it belongs.
  //
  // IT NEVER THROWS AND IT NEVER LIES. An ABSENT store is not a failure — a non-sandboxed being,
  // or a thread that never spawned a turn, simply has none — and says nothing, because a line
  // about a store that never existed on every rethread is noise. A store that IS there and could
  // NOT be moved says so, in the reply AND in the log, naming where it was left so it can be
  // found by hand.
  //
  // Returns null (nothing to move), { dest } or { error }; the CALLER words the reply, because
  // only it knows which verb and which being the operator is looking at.
  async function moveCliStore(threadId, destDir) {
    const src = jsonlStoreDirOf(threadId, { jsonlStoreRoot });
    if (!src) return null;                                    // no thread id → no store was ever minted
    try { await stat(src); } catch { return null; }           // nothing on disk → not a sandboxed being, or it never ran
    if (!destDir) {
      const detail = `${src} — the conversation folder was not archived, so there is nowhere beside it to put the store`;
      onLog(`/agents: CLI store NOT moved — ${detail}`);
      return { error: detail };
    }
    // basename, not the raw id: it is the id in every real case, and it cannot climb out of
    // destDir in the one where the id is not a bare path segment.
    const dest = join(destDir, `${basename(src)}.cli`);
    try {
      await mkdir(destDir, { recursive: true });
      await rename(src, dest);
      return { dest };
    } catch (e) {
      const detail = `${src} → ${dest}: ${e?.message ?? e}`;
      onLog(`/agents: CLI store NOT moved — ${detail}`);
      return { error: detail };
    }
  }

  // The one sentence both verbs append when — and ONLY when — there is something to say about a
  // store. Built here so the two replies word it identically. `where` names WHOSE transcripts/ it
  // is, because the two verbs mean different folders by the same relative path and the reply must
  // not leave the operator looking in the live tree for a store that went into the archived one —
  // it is a QUALIFIER, not the archive path (operator 2026-08-15: reset's confirmation never
  // renders that).
  const cliStoreNote = (results, where = '') => (results.length
    ? ` ${results.map(([h, r]) => (r.error
      ? `⚠️ ${h}'s CLI store was NOT moved (${r.error}) — it is still where it was`
      : `${h}'s CLI store moved to ${where}transcripts/${basename(r.dest)}`)).join('; ')}.`
    : '');

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
  //
  // …AND IT RESETS THE CONVERSATION THE BEING ACTUALLY LIVES IN (operator 2026-09-22, see
  // scopeAt): typed in a group invited into room/acim, this archives room/acim's folder and
  // wipes room/acim's `agents.<handle>` — the record holding the thread, the access_level and
  // the identity stamp. Wiping the group's own block instead cleared nothing the being reads
  // and left the live thread running. Unmoved (every unscoped conversation) the room resolution
  // and every write below are byte-for-byte what they were.
  async function agentsReset(ev, surface, jid, where, handles, state, named = handles.join(', ')) {
    const sc = await oneScope(handles, ev, surface, jid);
    if (sc.error) { await send?.(ev.chatId, `/agents: reset — ${sc.error}`); return; }
    const room = sc.moved ? await resolveConvRoom(sc.surface, sc.chatId)
      : (where === 'here') ? await convRoomOf(ev) : await resolveConvRoom(surface, jid);
    if (!room) { await send?.(ev.chatId, "can't resolve this conversation's room"); return; }
    where = whereWrote([sc], where);

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
    // WHETHER IT MOVED IS NOW REMEMBERED (operator 2026-09-11): the retiring beings' CLI stores go
    // INTO that archived folder (moveCliStore, above), so there is somewhere to put them only if
    // this succeeded. A store held with nowhere to go is reported rather than dropped.
    let archived = false;
    try { await mkdir(archiveRoot, { recursive: true }); await rename(base, archivedDir); archived = true; } catch { /* nothing to archive yet */ }

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
    // …and the RETIRING THREAD per handle, read here for exactly the reason access_level is:
    // deleteBeing below throws the whole block away, and ~/.egpt-jsonl/<threadId> is keyed by
    // that id and by nothing else. Read before the wipe or it is unrecoverable.
    const retiring = handles.map((h) => [h, getBeing(state, sc.surface, sc.chatId, h)?.threadId ?? null]);
    const preserved = handles.map((h) => {
      const b = getBeing(state, sc.surface, sc.chatId, h);
      const fields = {};
      if (b?.accessLevel != null) fields.access_level = b.accessLevel;
      if (b?.allowedUsers != null) fields.allowed_users = b.allowedUsers;
      return [h, fields];
    });
    let next = state;
    for (const h of handles) next = deleteBeing(next, room.surface, room.slug, h);
    for (const [h, fields] of preserved) {
      if (Object.keys(fields).length) next = patchBeing(next, sc.surface, sc.chatId, h, fields);
    }
    try { await writeState(next); } catch (e) { onLog(`/agents reset ${ev.chatId}: ${e?.message ?? e}`); }

    // Reseed a pristine tree at the ORIGINAL path — the same two calls /rooms create makes
    // for a brand-new room. No config.yaml write: neither call writes one, matching what a
    // genuinely first-contact conversation has.
    await room.ensureTree({ io: { mkdir } });
    await seedIdentityLayers(room, 'egpt', { io: { mkdir, readFile, writeFile } });

    // EACH RETIRING BEING'S CLI STORE GOES IN WITH THE FOLDER (operator 2026-09-11) — LAST, after
    // the archive rename and the reseed, so the verb's own work is already done and complete
    // whatever this manages. Into the ARCHIVED folder's transcripts/, never the pristine one just
    // reseeded at the original path: the store belongs to the thread that just ended.
    const stores = [];
    for (const [h, tid] of retiring) {
      const r = await moveCliStore(tid, archived ? join(archivedDir, 'transcripts') : null);
      if (r) stores.push([h, r]);
    }

    // Operator ruling (2026-08-15): "if you moved the folder the operation was successful or
    // not" — the confirmation reports success/failure ONLY, never the archive destination
    // (dropped the old `archiveNote`/`archived` plumbing that used to build a path string
    // into this reply). The store clause is not that path: it appears only when a store was
    // actually there, and a store left behind has to be findable by hand.
    await send?.(ev.chatId, `✅ ${room.slug} reset ${where === 'here' ? '' : where + ' '}— ${named} state cleared (access_level/allowed_users preserved), next message starts fresh.${cliStoreNote(stores, 'the archived folder\'s ')}`);
  }

  // /agents[=<slug>] <handle>|all refresh — the verb that changes NO lifecycle at all
  // (operator 2026-09-10): "re-feed identity + directives into the RUNNING thread. Context
  // untouched, nothing moved, no new thread." It is the middle rung the surface was missing —
  // rethread throws the thread away to get a current template, reset throws the whole folder
  // away, and until now there was no way to hand a live conversation an edited card without
  // losing what it was in the middle of.
  //
  // TWO HALVES, and the reply below is careful to say which is which, because they land at
  // different times:
  //
  //   ON DISK, NOW — <room>/directives/ is re-copied with `overwrite: true`, the SAME call
  //   /agents reset makes to mint a pristine tree and the same one brainpool.mjs makes on a
  //   thread instanced anew. That is the capabilities refresher: an edited 10-actions.md
  //   reaches a conversation seeded months ago. THE IDENTITY IS NOT WRITTEN — seedIdentityLayers
  //   files only the SHARED layers (_sharedLayers, operator 2026-09-10), which is the whole
  //   reason that folder is no longer called identity.d.
  //
  //   IN CONTEXT, NEXT TURN — clearing `identityInjectedAt` is the arming gesture. brainpool.mjs
  //   reads it (see turn(): a RESUMED thread with no injected-at stamp re-wraps with the feed
  //   and stamps it back). It cannot happen sooner and this reply must not pretend otherwise:
  //   an idle CLI session has nothing to push a message into, so the feed rides the next real
  //   turn — the same way `mode: auto`'s one-time preamble already does.
  //
  // NO NEW FIELD for the arming: `identityInjectedAt` has recorded when the identity was last
  // fed since recordThread was written; it was simply never read. Nulling it states something
  // TRUE about the block — this thread is running without its identity in context — rather
  // than parking a flag beside it.
  //
  // 'egpt' as the personality, exactly as agentsReset passes it, and for a reason that is not
  // laziness: the argument selects only the 00-identity SLOT, which _sharedLayers filters out
  // before anything is written. What lands on disk is identical for every persona, so there is
  // no per-being def to resolve here and no second resolution path to keep in step.
  //
  // BOTH HALVES BELONG TO THE SCOPE (operator 2026-09-22, see scopeAt). brainpool.mjs seeds the
  // layers into `Room.forChat(scope.surface, slug)` and reads `identityRefreshArmed` off
  // `getBeing(state, scope.surface, scope.chatId, being)` — so a refresh filed against the chat
  // the command was typed in re-copied a folder the being never runs out of and armed a flag it
  // never reads. Unmoved, this is byte-for-byte what it was.
  async function agentsRefresh(ev, surface, jid, where, handles, state, named = handles.join(', ')) {
    const sc = await oneScope(handles, ev, surface, jid);
    if (sc.error) { await send?.(ev.chatId, `/agents: refresh — ${sc.error}`); return; }
    const room = sc.moved ? await resolveConvRoom(sc.surface, sc.chatId)
      : (where === 'here') ? await convRoomOf(ev) : await resolveConvRoom(surface, jid);
    if (!room) { await send?.(ev.chatId, "can't resolve this conversation's room"); return; }
    where = whereWrote([sc], where);
    let wrote = [];
    try {
      // Best-effort by contract (seedIdentityLayers never throws); it RETURNS what it wrote,
      // which is what the reply reports rather than a claim assembled here.
      wrote = await seedIdentityLayers(room, 'egpt', { io: { mkdir, readFile, writeFile }, overwrite: true });
      let next = state;
      for (const h of handles) next = patchBeing(next, sc.surface, sc.chatId, h, { identityInjectedAt: null });
      await writeState(next);
    } catch (e) { onLog(`/agents refresh ${ev.chatId}: ${e?.message ?? e}`); await send?.(ev.chatId, `/agents: refresh failed — ${e?.message ?? e}`); return; }
    // Names the two halves separately, and never claims a thread was minted. An empty `wrote`
    // is reported as such — a refresh that copied nothing must not read like one that did.
    const copied = wrote.length ? `directives/ re-copied (${wrote.join(', ')})` : 'directives/ re-copied: NOTHING was written (no layer had content to copy)';
    await send?.(ev.chatId, `✅ ${named} refresh ${where} — ${copied}; identity re-feeds into the RUNNING thread on its next turn (threadId unchanged, nothing moved, context kept).`);
  }

  // /agents[=<slug>] <handle>|all rethread — NARROWER than reset (operator 2026-08-15 ruling,
  // decided directly against `reset`'s big archive-and-wipe): clears ONLY the target
  // being(s)' `threadId` via patchBeing (a merge, NOT deleteBeing) — `mode`, `access_level`,
  // and every other field on the being's block survive byte-for-byte. The conversation
  // FOLDER is never archived, moved or wiped — no folder rename, no reseed — plus the ONE
  // line rethreadBoundary appends to transcript.md (below) so `mode: accum`'s window starts
  // here too.
  //
  // SHIPPED AS `restart`, RENAMED 2026-09-10 (operator): the spine's lifecycle exit code 43
  // already means RESTART THE PROCESS, and the same word meaning both "restart the node" and
  // "new thread for this conversation" is how an operator ends up restarting the wrong thing.
  // The old token is refused by name in agentsCmd above, never aliased.
  //
  // AND THE TRANSCRIPT MOVES, NOW (operator 2026-09-10: "mint a NEW thread. The current
  // transcript.md moves to transcripts/"). rollTranscript is THE mover — the same function
  // brainpool.mjs calls on a thread instanced anew, not a second copy of the logic — so the
  // file lands under its RETIRING thread's own id and a blank, un-stamped transcript.md is
  // left in its place. Calling it here does not race brainpool's lazy roll: that one keys on
  // the transcript's own `thread_id` front matter, which this call has just cleared, so the
  // next turn's roll finds nothing to do and returns null.
  //
  // IT CAN FAIL, AND THEN IT SAYS SO. rollTranscript never throws and returns null for every
  // reason it did not move the file (nothing there yet, un-stamped, the destination taken 99
  // times over, an fs error it logged). The reply below reports that null as a NOT MOVED
  // rather than folding it into the ✅ — the thread half genuinely did happen, and claiming
  // the transcript went with it when it did not is the kind of lie this surface does not tell.
  //
  // No evictWarm() call (unlike access_level, which needs one): warm-sessions.mjs's
  // run() already carries a SESSION-IDENTITY GUARD (its own comment names this exact case —
  // "`/agents reset <handle>` nulling the thread ... would otherwise be silently ignored")
  // that compares the `sessionId` brainpool.mjs passes every turn (`sessionId: threadId ??
  // null`, always an explicit key so the guard's hasOwnProperty check fires) against the warm
  // entry's own bound session id, and self-evicts + reopens fresh on a mismatch. Nulling
  // `threadId` here is exactly what ARMS that guard on the next turn — the same mechanism
  // that already makes `reset` work with no explicit evict, despite `reset` never calling
  // evictWarm either.
  //
  // Identity reseeding is still NOT done here: brainpool.mjs's own `fresh = !sessionId` gate
  // re-copies the layers with `overwrite: fresh` on the next real turn, and duplicating that
  // would just race the proven path. The transcript move is different precisely because it is
  // the operator's stated definition of the verb, not a side effect of the next turn.
  //
  // THE THREAD IT RETIRES IS THE SCOPE'S (operator 2026-09-22, see scopeAt), and so is the
  // transcript it rolls: brainpool.mjs reads `threadId` off `getBeing(state, scope.surface,
  // scope.chatId, …)` and rolls `rollTranscript(scope.surface, slug)` on a fresh thread. Filed
  // against the chat the command was typed in, an invited group's rethread nulled a threadId
  // nothing reads and rolled the GROUP's transcript.md while the room's live thread ran on —
  // the wrong transcript for the wrong thread. Unmoved, byte-for-byte what it was.
  // The accum boundary below is the one thing that stays with the TYPED chat: spine.mjs reads
  // `readTranscript(ev.chatId)` for the accum window, so that line has to land where it reads.
  async function agentsRethread(ev, surface, jid, where, handles, state, named = handles.join(', ')) {
    const sc = await oneScope(handles, ev, surface, jid);
    if (sc.error) { await send?.(ev.chatId, `/agents: rethread — ${sc.error}`); return; }
    const room = sc.moved ? await resolveConvRoom(sc.surface, sc.chatId)
      : (where === 'here') ? await convRoomOf(ev) : await resolveConvRoom(surface, jid);
    if (!room) { await send?.(ev.chatId, "can't resolve this conversation's room"); return; }
    where = whereWrote([sc], where);
    try {
      // THE RETIRING THREADS, read BEFORE patchBeing nulls them: ~/.egpt-jsonl/<threadId> is keyed
      // by that id, so once the block says null the store's own name is the only thing left that
      // knows which conversation it belonged to — which is the orphan this fixes.
      const retiring = handles.map((h) => [h, getBeing(state, sc.surface, sc.chatId, h)?.threadId ?? null]);
      let next = state;
      for (const h of handles) next = patchBeing(next, sc.surface, sc.chatId, h, { threadId: null });
      await writeState(next);
      // THE ROLL, through the shared mover. Reported by its result, never assumed.
      const dest = await rollTranscript(room.surface, room.slug, { io: { readFile, writeFile, rename, mkdir, readdir } });
      // …AND THE CLI STORE GOES BESIDE IT (operator 2026-09-11) — <threadId>.cli/ next to the
      // <threadId>.md the roll just filed. AFTER the roll, so the transcript half is already done
      // and transcripts/ already exists (rollTranscript's ensureTree made it), and so a store that
      // cannot be moved costs a store and not the rethread.
      const stores = [];
      for (const [h, tid] of retiring) {
        const r = await moveCliStore(tid, room.transcriptsDir);
        if (r) stores.push([h, r]);
      }
      // The roll's outcome leads its own clause and is never folded into the ✅: "but ... was
      // NOT moved" has to be readable at a glance, because the operator's next move depends on
      // it. The ✅ says the command ran; this says what it managed.
      const rolled = dest
        ? `and transcript.md moved to transcripts/${basename(dest)}`
        : 'but transcript.md was NOT moved (nothing written there yet, or it names no thread to file it under)';
      await send?.(ev.chatId, `✅ ${named} rethread ${where} — threadId cleared, ${rolled}.${cliStoreNote(stores)} An accum boundary is marked in transcript.md, so nothing said before now is fed back; the next message starts a fresh session (mode/access_level unchanged, the conversation folder stays where it is — /agents reset is what archives).`);
      await rethreadBoundary(ev, surface, jid, handles, state);
    } catch (e) { onLog(`/agents rethread ${ev.chatId}: ${e?.message ?? e}`); await send?.(ev.chatId, `/agents: rethread failed — ${e?.message ?? e}`); }
  }

  // THE ACCUM BOUNDARY (operator ruling 2026-08-29: "the reset should clean next accum, so
  // that the model really starts fresh"). Nulling threadId above starts a fresh SESSION, but
  // `mode: accum` reads the gap since the being's last turn straight out of transcript.md
  // (transcript-log.contextSinceLastTurn), so a rethreaded being was still handed up to
  // RECENT_CONTEXT_MAX_CHARS of pre-rethread history on turn one — the live incident where E,
  // asked "sin revisar el historial, recuerdas de qué estábamos hablando?", answered correctly
  // without reading anything.
  //
  // STILL LOAD-BEARING NOW THAT THE TRANSCRIPT ALSO MOVES (2026-09-10): the roll leaves a
  // BLANK transcript.md behind, which would seem to make a boundary line redundant — but the
  // roll can legitimately do nothing (an un-stamped or absent file, the case the reply above
  // reports as NOT moved), and in that case this line is the only thing closing the window.
  // Belt and braces, on purpose: the cost is one withheld line, the failure is a "fresh"
  // being reading yesterday.
  //
  // NO NEW MECHANISM: contextSinceLastTurn already treats a WITHHELD reply line as a valid
  // boundary (its own docblock: "`(not surfaced) ` opens the BODY, past the head, so it
  // matches"), so one such line per rethreaded being re-anchors the window at that point
  // — no new field, no timestamp comparison (that module deliberately parses none), and the
  // shared record every OTHER being and every human relies on is left whole. That is the whole
  // difference from reset, which archives the folder.
  //
  // Written through logTranscript — createTranscript.log, THE reply writer — never assembled
  // here. SINGLE BLOCK, deliberately: a multi-paragraph marker would be split on its blank
  // lines and its headerless tail would leak back into the very window this closes.
  //
  // LAST, after the confirmation: boot records a command's reply through the same transcript
  // (wrapCommandsForTranscript), so a boundary written first would leave the ✅ line — and the
  // `/agents … rethread` line above it — sitting in the "fresh" being's first window.
  //
  // The ev is the CALLER-RESOLVED conversation's, not the one the command was typed in: a
  // `/agents=<slug> … rethread` from Self must re-anchor the named chat. Only where the write is
  // filed changes; chatName follows it so the line names the chat it lands in.
  async function rethreadBoundary(ev, surface, jid, handles, state) {
    const contact = getContact(state, surface, jid);
    const chatName = contact?.entry?.pushedName ?? contact?.slug ?? ev.chatName;
    const at = { ...ev, surface, chatId: jid, chatName };
    for (const h of handles) {
      await logTranscript(at, { text: 'rethreaded — fresh session from here; nothing above this line is in context', being: h, surfaced: false });
    }
  }

  // /agents mode <mode> <handle>|all — was `/agents auto <mode>` (renamed 2026-10-08; `auto` is
  // still accepted as a deprecated alias) and before that /e auto <mode> [<target>], generalized:
  // sets EACH target being's own conversation mode (modes live in conversations.yaml,
  // `agents.<being>.mode`, merged over the block's existing fields via patchBeing — siblings
  // survive). Bare (`where === 'here'`): this chat. `=<slug>`-resolved: a DIFFERENT known
  // chat, same resolveTarget reach /e auto's <target> already had.
  //
  // THE ONE VERB THAT IS NOT SCOPED, AND DELIBERATELY (audited 2026-09-22 against scopeAt
  // above, which moved every other write onto the being's scope). `mode` is the single field
  // brainpool.mjs's resolveConv reads back at the ORIGIN and not at the scope — its own words:
  // "MODE STAYS WITH THE CHAT, alone among the fields read here", because gating.decide resolves
  // the very same field for the very same message on the origin conversation, and two readings
  // of one field would have a group dwelling per the origin while its kickoff layer was chosen
  // per the room. So `surface, jid` here is the RIGHT address, not an oversight: a group invited
  // into room/acim gets its OWN mode, exactly as it is read. It also evicts nothing, and needs
  // to: a mode change does not alter a warm process's spawn args.
  async function agentsMode(ev, surface, jid, where, handles, mode, state, named = handles.join(', ')) {
    try {
      let next = state;
      for (const h of handles) next = patchBeing(next, surface, jid, h, { mode });
      await writeState(next);
      await send?.(ev.chatId, `✅ ${named} mode ${where} → ${mode}`);
    } catch (e) { onLog(`/agents mode ${ev.chatId}: ${e?.message ?? e}`); await send?.(ev.chatId, `/agents: mode failed — ${e?.message ?? e}`); }
  }

  // /agents access_level <level> <handle>|all — was /e access all|regular
  // (renamed subcommand keyword, operator's own example: `/agents access_level all wren`),
  // generalized to any being (or every resident). Points EACH target being's own
  // `access_level` at config/permissions/<level>.md, for any level in ACCESS_LEVELS.
  // NOT a freeze: writes ONLY `access_level: target` into the being's block, merged
  // over its existing fields
  // (patchBeing) — brainpool.mjs's turn() reads the matching permissions file FRESH every
  // turn (permission-levels.mjs — no caching) and overrides that turn's allowed_tools/
  // dangerously_skip_permissions, so editing either file changes behavior immediately with
  // no re-run needed.
  // Agent/model/effort/engine are never touched.
  async function agentsAccessLevel(ev, surface, jid, where, handles, target, state, named = handles.join(', ')) {
    const perm = loadPermissionLevel(target);
    if (!perm) { await send?.(ev.chatId, `/agents: permissions file for "${target}" not found or unparseable`); return; }
    const scopes = [];
    try {
      let next = state;
      for (const h of handles) {
        // WHERE THIS BEING'S access_level IS READ FROM (see scopeAt above) — brainpool.mjs's
        // resolveConv reads it off `getBeing(state, scope.surface, scope.chatId, being)`, so
        // this is the one record that matters. PER HANDLE, because a node-wide `scope:` pin is
        // declared per being.
        const sc = await scopeAt(h, ev, surface, jid);
        scopes.push(sc);
        next = patchBeing(next, sc.surface, sc.chatId, h, { access_level: target });
        // Evict the warm session: a warm `claude` process bakes its allowedTools/confinement
        // into its spawn args ONCE, at open, and never re-reads brainOptions on later turns of
        // the same warm session — so a live warm session must be closed for the new
        // access_level to actually take effect on the NEXT turn, even though nothing here is
        // frozen.
        // THROUGH THE BRAIN'S OWN evict, by ADDRESS (operator 2026-09-22): it looks up the last
        // warm key this being+conversation actually ran (lastKeyByConv, registered under BOTH
        // the origin's and the scope's address) instead of rebuilding one here. The rebuilt
        // string — `<handle>:<engine>:<typed surface>:<typed slug>` — was the defect: for an
        // invited group it named `egpt:ccode:whatsapp:perrito…` while the live entry was
        // `egpt:ccode:room:acim`, so nothing closed and the old permissions ran on. It also
        // retires the per-handle resolveBeingDef lookup that existed ONLY to guess the engine
        // half of that string.
        await evictWarm(h, { ...ev, surface: sc.surface, chatId: sc.chatId });
      }
      await writeState(next);
    } catch (e) { onLog(`/agents access_level ${ev.chatId}: ${e?.message ?? e}`); await send?.(ev.chatId, `/agents: access_level failed — ${e?.message ?? e}`); return; }
    // What each tier MEANS, in one line — NOT a second list of what is valid (isAccessLevel
    // already ruled on that, above). A level with no line here still confirms honestly by
    // naming its own file rather than borrowing another tier's description.
    const blurb = {
      regular: 'confined default tools',
      all: 'unconfined: full filesystem, bare Bash',
      sandbox: "all's capability, but only ever inside the OS sandbox",
    }[target] ?? `see config/permissions/${target}.md`;
    await send?.(ev.chatId, `✅ ${named} access ${whereWrote(scopes, where)} → ${target} (${blurb})`);
  }

  // /agents[=<slug>] <handle>|all (bare) — the LIVE status view (never a stale snapshot; see
  // agentsBeingBlock). Fenced-yaml, one block per handle, joined with a `---` document
  // separator when `all` covers more than one resident being. Never throws (every probe
  // degrades to '?'/'unknown', matching statusTarget's own convention).
  //
  // One line ABOVE the fence when the operator's word is not the being's key (`e (egpt)`) — the
  // block itself is keyed `being: egpt`, and without this the answer to `/agents e` silently
  // looks like it is about some other being. Absent when the two agree, so the bare form is
  // byte-identical to what it always was.
  //
  // AND IT READS THE RECORD THE BEING READS (operator 2026-09-22, the same defect as the write
  // verbs, in the other direction): asked in a group invited into room/acim, this used to render
  // the GROUP's own `agents.egpt` block — reporting `access_level: unset` and `thread_id: not
  // started` for a being that has had both on room/acim for weeks. Scoped per handle, like
  // access_level, because a node-wide `scope:` pin is declared per being.
  async function agentsStatus(ev, surface, jid, handles, state, named = handles.join(', ')) {
    const blocks = [];
    for (const h of handles) blocks.push(agentsBeingBlock(await scopeAt(h, ev, surface, jid), surface, jid, h, state));
    const head = (handles.length === 1 && named !== handles[0]) ? `${named}\n` : '';
    return head + '```yaml\n' + blocks.join('\n---\n') + '\n```';
  }

  // ONE being's status block — statusTarget's own preview is PERSONA-ONLY (resolveDefaultBrainDef,
  // which reads the single `default: true` agent); this generalizes it to ANY being via
  // resolveBeingDef(handle, convDir, …) — the SAME resolver brainpool.mjs's turn() itself
  // calls for this being on its NEXT turn (name-the-existing-thing, not a second derivation)
  // — PLUS the ACCESS-LEVEL OVERRIDE block turn() applies right after it (loadPermissionLevel,
  // when the being's own accessLevel is one of ACCESS_LEVELS — a live override
  // statusTarget's own preview never applied, a real gap this closes for the new command) PLUS the
  // `dangerouslySkipPermissions ? raw : coerceAllowedTools(raw)` coercion statusTarget already
  // applies to its own preview. Resolved FRESH on every call (no caching anywhere in this chain), so editing
  // config between two calls changes the NEXT call's tools/model/effort with nothing to evict.
  //
  // `sc` is THE ADDRESS this being's instance lives at (agentsStatus resolved it through
  // scopeAt). Every field below reads from it — record, slug, conv dir, thread — for the same
  // reason brainpool.mjs derives all of them from `scope`. The ONE exception is `mode`, read
  // back at the TYPED chat, because that is the one field resolveConv itself reads at the
  // origin ("MODE STAYS WITH THE CHAT, alone among the fields read here").
  function agentsBeingBlock(sc, surface, jid, handle, state) {
    try {
      // NOT configured on THIS node (operator 2026-08-29: dolly answered `/agents wren` with a
      // plausible-looking status even though wren exists nowhere in dolly's config — every node
      // parses every command it hears, independent of which node the named being actually lives
      // on). resolveBeingDef below is DELIBERATELY total — "No agent entry ... -> a bare ccode
      // def keyed by the being name (keeps it runnable)", its own header says so, and turn()
      // relies on exactly that to let an unregistered handle still run. The status VIEW must not
      // dress that bare fallback up as a real being, though: check membership in THIS node's
      // agents: map first, and say so plainly when there is none, rather than falling through
      // resolveBeingDef's every `??` and rendering a config-shaped answer for a being that is
      // not here.
      const b = getBeing(state, sc.surface, sc.chatId, handle);
      // defaultKey is exempt: the persona is real by definition even with an empty agents:
      // map (resolveDefaultBrainDef's own shipped-'egpt'-type fallback). Any OTHER handle is
      // real here iff it is either configured at the node level (agents: in config.yaml) or
      // already RESIDENT in this conversation — getBeing ALWAYS returns a truthy object
      // (jid/slug/surface/being are set unconditionally), so its OWN `present` flag is what
      // actually says whether a per-conversation `agents.<handle>` block exists, not the
      // object's truthiness. Neither true means resolveBeingDef below would still hand back
      // its DELIBERATELY total fallback ("No agent entry ... -> a bare ccode def keyed by the
      // being name (keeps it runnable)", its own header) — fine for turn(), which that
      // total-ness exists to serve, but the status VIEW must not dress that bare fallback up
      // as a real being.
      if (handle !== defaultKey && !((cfg() ?? {}).agents ?? {})[handle] && !b?.present) {
        return `being: ${handle}\nnot configured on this node`;
      }
      const c = getContact(state, sc.surface, sc.chatId);
      const slug = c?.slug ?? sc.chatId;
      let convDir = null;
      try { convDir = slugDir(sc.surface, slug); } catch { /* non-default surface */ }

      let def = null;
      // `configuration` — THIS conversation's own (conversations.yaml, operator 2026-09-17), the
      // same value brainpool's resolveConv hands this resolver on the being's next turn.
      try { def = resolveBeingDef(handle, convDir, { getConfig: cfg, brains, brainType: CCODE, configuration: b?.configuration, onLog }); } catch { def = null; }
      // isAccessLevel, not a copy of the level list: this preview claims to show what the
      // being's NEXT turn will run with, so it must recognise exactly the levels brainpool's
      // own override recognises. While it did not, a 'sandbox' being previewed its type file's
      // tools and the status block quietly contradicted the run.
      if (def && isAccessLevel(b?.accessLevel)) {
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
      // WHERE the def came from: this conversation's `configuration:` when it states one, else
      // config.yaml's. Raw as written (an inline map as a JSON flow map, which is valid YAML); the
      // model/effort lines below are what it resolved to.
      const confOf = (c) => (c && typeof c === 'object' ? JSON.stringify(c) : String(c));
      const confVal = b?.configuration != null
        ? `${confOf(b.configuration)} (this conversation)`
        : `${confOf(((cfg() ?? {}).agents ?? {})[handle]?.configuration ?? 'none')} (config.yaml)`;

      return [
        `being: ${handle}`,
        `name: ${previewDef?.name ?? handle}`,
        `surface: ${sc.surface}`,
        `slug: ${slug}`,
        // MODE IS THE TYPED CHAT'S — see the docblock. getBeing is pure over state already in
        // hand, so this second view costs no second read (resolveConv's own `b0` reasoning).
        `mode: ${getBeing(state, surface, jid, handle)?.mode ?? 'default'}`,
        `access_level: ${b?.accessLevel ?? 'unset'}`,
        `configuration: ${confVal}`,
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

  // The room called <name>, iff its folder exists on disk — the same stat-probe /rooms create
  // uses for its own idempotency check, reused here so "does this room exist" has ONE
  // answer across create/members/delete. Returns the Room, or null.
  //
  // A READ NEVER MINTS. A room's slug is a pure function of its name (fixedSlugFor, surface
  // `room`), so this needs no conv-state at all: it applies that identical rule and stats the
  // folder. Going through resolveConvRoom here would call ensureContact, so `/rooms members
  // <typo>` would leave a contact entry behind for a room that does not exist. Same
  // constructor roomsList and roomFromNs use for a name that came off disk.
  async function roomOnDisk(name) {
    const room = Room.forChat('room', sanitizeName(name));
    try { await stat(room.baseDir()); return room; } catch { return null; }
  }

  // /rooms create <name> — CREATE a room. A Room IS a folder (room-core.mjs), and a room is
  // a CONVERSATION on surface `room` whose chatId is the name itself: resolveConvRoom mints
  // the contact (the SAME ensureContact a first Beeper message goes through — that is the
  // whole reason a named room is now addressable) and ensureTree makes the folder, which the
  // heartbeat + transcription loaders (boot.mjs listEntityDirs) enumerate from then on.
  // This is the ONE room path that mints; every read resolves the slug purely (roomOnDisk).
  // Tree paths come from the Room abstraction and fs from the io seam, so tests capture it
  // in-memory and it never touches a real profile.
  async function roomCreate(ev, name) {
    // A room NAME is operator-chosen; reject an empty/punctuation-only one before touching fs.
    if (!name || !/[a-z0-9]/i.test(name)) { await send?.(ev.chatId, 'usage: /rooms create <name>'); return; }
    const r = await resolveConvRoom('room', name);
    if (!r) { await send?.(ev.chatId, `can't resolve room '${name}'`); return; }
    const slug = r.slug;
    const rel = `rooms/${slug}/`;
    // Idempotent: an existing room folder is NEVER clobbered.
    try { await stat(r.baseDir()); await send?.(ev.chatId, `room ${slug} already exists at ${rel}`); return; }
    catch { /* absent → create below */ }
    // The folder IS the room: ensure the standard tree + a minimal config.yaml. The dir
    // list belongs to the ABSTRACTION (Room.ensureTree), not to this command — a
    // conversation seeds the identical tree through the same call.
    // No member roster — that's later work.
    await r.ensureTree({ io: { mkdir } });
    // Seed directives/ beside the tree (operator 2026-07-26: "why an empty identity.d in
    // namedrooms? fix, please.") — the SAME seedIdentityLayers the persona turn calls,
    // re-keyed on the Room instance it already abstracts both shapes for. 'egpt' (no
    // per-room personality concept exists yet) is exactly the default a conversation falls
    // back to (def.personality ?? 'egpt'). No overwrite: a brand-new room's directives/ is
    // already empty, so copy-if-missing is a plain seed here — and it's the same
    // never-clobber default every other seed path uses. Never throws by its own contract, so
    // a seed failure still leaves a created room rather than an error the operator can't act
    // on — an empty directives/ is a smaller problem than a /rooms create that fails outright.
    await seedIdentityLayers(r, 'egpt', { io: { mkdir, readFile, writeFile } });
    await send?.(ev.chatId, `room ${slug} created at ${rel}`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // /rooms — the saved rooms, each with its member count, the current one marked.
  // Never throws (a missing rooms/ dir → "no rooms yet"; a per-room count that
  // can't be read degrades to 0). listRoomNames yields FOLDER names (i.e. slugs), so each
  // one is a Room via the same (surface, slug) constructor resolveConvRoom ends in and
  // roomFromNs uses for the disk walk — resolving these through resolveConvRoom would treat
  // a slug as a chatId and mint a contact for every listed room on every /rooms.
  async function roomsList(ev) {
    const names = listRoomNames();
    if (!names.length) return 'no rooms yet — /rooms create <name> to make one';
    const cur = curRoomName(ev);
    const lines = ['rooms:'];
    for (const name of names) {
      let n = 0;
      try { n = (await Room.forChat('room', name).members()).length; } catch { n = 0; }
      lines.push(`  · ${name}   ${n} members${name === cur ? '   (current)' : ''}`);
    }
    return lines.join('\n');
  }

  // /rooms <slug> join — make <slug> the current room for this surface (what bare /members
  // targets). In-memory for Phase 2; a room folder materializes when its first member is
  // added (setMember mkdir's it) or via /rooms create.
  async function roomJoin(ev, slug) {
    currentRoom.set(surfaceOf(ev), slug);
    onRoomChange(surfaceOf(ev), slug);
    await send?.(ev.chatId, `joined '${slug}' — now current.`);
  }

  // /rooms <slug> leave — clear the current room for this surface iff it IS <slug>.
  async function roomLeave(ev, slug) {
    if (curRoomName(ev) === slug) { currentRoom.delete(surfaceOf(ev)); onRoomChange(surfaceOf(ev), null); await send?.(ev.chatId, `left '${slug}' — no current room.`); return; }
    await send?.(ev.chatId, `not in '${slug}' — current room is ${curRoomName(ev) ? `'${curRoomName(ev)}'` : 'none'}`);
  }

  // /rooms <slug> delete [force] — remove a room folder outright. Irreversible: a room
  // folder holds transcript.md, media/, files/, directives/, scripts/, transcripts/ — real
  // content an operator (or a brain) put there. A room that is STILL JUST the seeded
  // skeleton (what /rooms create + seedIdentityLayers leave behind: the empty tree plus
  // directives/'s seeded layers, nothing else) is removed outright; a room holding anything
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
        await send?.(ev.chatId, `room ${slug} has content — ${contents.join(', ')} — /rooms ${slug} delete force to remove anyway`);
        return;
      }
    }
    await rm(room.baseDir(), { recursive: true, force: true });
    for (const [surface, cur] of currentRoom) if (cur === slug) { currentRoom.delete(surface); onRoomChange(surface, null); }
    await send?.(ev.chatId, `room ${slug} deleted`);
  }

  // What roomDelete refuses to discard silently: everything a Room can hold BEYOND the
  // seeded skeleton — read through Room's OWN getters (transcriptPath/mediaDir/filesDir/
  // scriptsDir/transcriptsDir/directivesDir), never a filename list re-derived here, so a
  // room-core change can't drift this out of sync. directives/ is ALWAYS non-empty in a
  // freshly-created room (seedIdentityLayers' copied-in shared layers) — only names beyond
  // that seeded set (skeletonIdentityFiles, the SAME source seedIdentityLayers itself reads)
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
    try { idNames = await readdir(room.directivesDir); } catch { idNames = []; }
    const skeleton = await skeletonIdentityFiles('egpt');
    const extra = idNames.filter((n) => !skeleton.has(n));
    if (extra.length) parts.push(`${extra.length} extra file${extra.length === 1 ? '' : 's'} in directives/`);
    return parts;
  }

  // The roster of `room` (a Room object) as a fenced yaml block, labelled by `label`: each
  // member's id, kind, live presence, and friendly mode. Presence for a brain member = its
  // saved targetId is a LIVE tab (from listTabs); a listTabs hiccup degrades every brain to
  // "inactive", never throws. Non-brain members read as "active" (a surface/chat member is
  // present as such). Shared by /members (the conversation room) and /rooms <slug> members (a
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
    if (surfaceOf(ev) !== SHELL_SURFACE || room?.slug !== LOBBY_SLUG) return [];
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
  // reads → an @<brain> on this conversation drives the relay. NO "/rooms <slug> join" gate — the
  // conversation you're in IS the room. (An operator-named room is addressed EXPLICITLY — /rooms
  // + /rooms <slug> members inspect/manage it — but it is the same kind of Room on surface `room`,
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
    // `add group <chat name|id>` — the argument runs to END OF LINE, because a chat NAME has
    // spaces in it ("Radio WnL"). A single-token capture could only ever take an id.
    const addGroup = /^add\s+group\s+(\S.*)$/i.exec(rest);
    if (addGroup) { await membersAddGroup(ev, room, addGroup[1].trim()); return; }
    // remove/mode take their target to END OF LINE for the SAME reason add group does —
    // a chat NAME has spaces in it. Live console 2026-08-31: `/members mode all perrito
    // traduciones` fell through to the usage line because `(\S+)` could not span the
    // space, which is what made the operator's third attempt look like a syntax error
    // rather than the near-miss it actually was. The target is still LAST, so running it
    // to end of line is unambiguous — nothing follows it.
    const remove = /^remove\s+(\S.*)$/i.exec(rest);
    if (remove) { await membersRemove(ev, room, remove[1].trim()); return; }
    // VERB FIRST, target last (operator 2026-08-29) — was `<id> mode <value>`, the last
    // object-first form on this surface.
    const mode = /^mode\s+(\S+)\s+(\S.*)$/i.exec(rest);
    if (mode) { await membersSetMode(ev, room, mode[2].trim(), mode[1]); return; }
    await send?.(ev.chatId, MEMBERS_USAGE);
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

  // ── ONE chat-argument resolution path, shared by add group / remove / mode ────────────
  // (Operator console, 2026-08-31 — three symptoms, one cause. `add group` grew a chat
  // resolver in c63cdd6 + c84deac and its siblings did not:
  //   /members add group perrito traduciones
  //     → added group 'perrito traduciones' → '0MP97ovrD6XvVovMVx6v' — mode:disable
  //   /members mode all !0MP97ovrD6XvVovMVx6v:beeper.local
  //     → no member '!0MP97ovrD6XvVovMVx6v:beeper.local' in this conversation
  //   /members mode all perrito traduciones
  //     → usage: /members | /members add tab … | /members mode <disable|mention|all> <id>
  // …i.e. the system printed a chat id in its OWN error message that its OWN next command
  // would not accept, and refused the name it had itself just resolved. Four attempts.)
  //
  // THIS is that resolver, lifted out of membersAddGroup unchanged so the other two verbs
  // reach it rather than growing copies of it:
  //   · a `!`-prefixed argument IS a canonical id — taken as-is, never looked up (the same
  //     short-circuit the bridge's own resolveChatId takes on a '!' prefix, beeper.mjs)
  //   · anything else goes through THE injected resolveChatId seam, the one mesh.mjs's
  //     canonRoute already takes off this bridge
  //   · NO FALLBACK to the raw string: an unresolvable name is an ERROR with an unchanged
  //     roster, never a member id that silently never delivers at relay time
  // Returns { id } or { error }. The CALLER words the failure, because "no chat goes by
  // that name" and "that chat is not a member here" are different facts and only the
  // caller knows which one the operator is actually asking about.
  async function resolveChatArg(arg) {
    if (arg.startsWith('!')) return { id: arg };
    if (!resolveChatId) return { error: `can't resolve '${arg}' — this node has no chat resolver; give the chat id instead (it looks like !xxxx:beeper.local)` };
    let found = null;
    try { found = await resolveChatId(arg); } catch { found = null; }
    if (found) return { id: found };
    // The wording is `add group`'s, because it is the only verb that SURFACES this error:
    // remove/mode answer a resolution miss with the roster instead (noMemberHere below),
    // which is the more useful fact when the operator is naming a member, not a chat.
    return { error: `no chat named '${arg}' — nothing added; check the name, or give the chat id instead (it looks like !xxxx:beeper.local)${await didYouMeanChat(arg)}` };
  }

  // THE id comparison, in SHORT space (operator 2026-08-31). The two id forms on this node
  // are not a mistake to be migrated away, they are both real: resolveChatId NORMALIZES to
  // the short form and returns it (beeper.mjs — a '!' argument is passed through
  // shortChatId), so `add group <name>` stores '0MP97ovrD6XvVovMVx6v'; `add group !<id>:
  // beeper.local` stores the full form verbatim; and the FULL form is what /members
  // listings, Beeper's own UI, and this module's own error messages show the operator.
  // Comparing raw strings therefore made the printed form unusable. Folding BOTH sides
  // through shortChatId — the same normalizer every other id comparison on this node
  // already uses (boot.isAllowedUser, inSelfDm above) — makes the two forms ONE key at the
  // point of comparison, with NOTHING rewritten on disk and no migration: a member seated
  // before this change is reachable by both forms from the very next command. shortChatId
  // is the identity function on anything that isn't a '!…:beeper.local' room id, so a brain
  // member ('chatgpt') compares exactly as it always did.
  const sameChat = (a, b) => shortChatId(String(a ?? '')) === shortChatId(String(b ?? ''));

  // chat id (short) -> its NAME, from the bridge's own cached chat list. MESSAGES ONLY —
  // see the listChats seam. No seam, or a throwing one, degrades to an empty map so an
  // error path can never become a second error.
  async function chatNames() {
    if (!listChats) return new Map();
    try {
      const out = new Map();
      for (const c of (await listChats()) ?? []) if (c?.id && c?.name) out.set(shortChatId(c.id), String(c.name));
      return out;
    } catch { return new Map(); }
  }

  // "did you mean …?" off the very chat list resolveChatId just walked. The operator's real
  // failure was a ONE-LETTER difference ('traduciones' vs 'traducciones') in a group name he
  // did not choose; naming the near-miss would have ended it on the first attempt instead of
  // the fourth. Empty string when nothing is close enough — a wrong guess costs an attempt.
  async function didYouMeanChat(arg) {
    const near = closestNames(arg, [...(await chatNames()).values()]);
    return near.length ? `\ndid you mean: ${near.map((n) => `'${n}'`).join(' · ')}` : '';
  }

  // The operator's argument -> the member it names, through the ONE path above. ORDER IS
  // THE FIX: a STORED id wins first and with no lookup at all — in EITHER form, via
  // sameChat — so `/members mode all chatgpt` and remove/mode given the exact stored id
  // behave byte-for-byte as they did and never touch the bridge. Only an argument that
  // names no member at all is then offered to the resolver as a chat NAME, and what it
  // resolves to is matched in the same short space. Returns { member, roster }; member is
  // undefined when nothing matched, and roster is what the error message renders.
  async function memberFor(room, arg) {
    const roster = await room.members();
    const stored = roster.find((m) => sameChat(m.id, arg));
    if (stored) return { member: stored, roster };
    const { id } = await resolveChatArg(arg);
    return { member: id ? roster.find((m) => sameChat(m.id, id)) : undefined, roster };
  }

  // At most this many roster rows in a "no member" reply — a handful of candidates, not a
  // dump of a room that has collected twenty tabs.
  const ROSTER_HINT_MAX = 6;

  // The "no member" reply, which used to be `no member '<x>' in this conversation` and
  // nothing else — true, and useless: it holds the entire roster and named none of it
  // (operator 2026-08-31). Now it answers the question the operator actually has, "well,
  // what IS in here?", with id + kind + the chat's name where the bridge knows one — that
  // last column being the whole point for a wa-group member, whose stored id is the only
  // thing about it on disk. NEAREST-FIRST (the same scorer as didYouMeanChat, over the ids
  // AND the names) so a one-letter miss floats to the top rather than being cut by the cap.
  async function noMemberHere(arg, roster) {
    const head = `no member '${arg}' in this conversation`;
    if (!roster.length) return `${head} — the roster is empty; /members add tab <n> or /members add group <chat name|id> seats one`;
    const names = await chatNames();
    const nameOf = (m) => names.get(shortChatId(m.id)) ?? m.title ?? null;
    // Every string the operator could plausibly have been aiming at, mapped back to its
    // member; ranked; then anything the scorer found too far off, in roster order.
    const byKey = new Map();
    for (const m of roster) { if (!byKey.has(m.id)) byKey.set(m.id, m); const n = nameOf(m); if (n && !byKey.has(n)) byKey.set(n, m); }
    const ranked = [], seen = new Set();
    for (const k of closestNames(arg, [...byKey.keys()], { limit: byKey.size })) {
      const m = byKey.get(k);
      if (m && !seen.has(m.id)) { seen.add(m.id); ranked.push(m); }
    }
    for (const m of roster) if (!seen.has(m.id)) ranked.push(m);
    const shown = ranked.slice(0, ROSTER_HINT_MAX);
    // A 20-char chat id and a 7-char tab alias in one list read as noise unaligned — and the
    // whole point of this reply is that the operator can SCAN it for the row he meant.
    const wId = Math.max(...shown.map((m) => m.id.length));
    const wKind = Math.max(...shown.map((m) => m.kind.length));
    const lines = shown.map((m) => `  · ${m.id.padEnd(wId)}   ${m.kind.padEnd(wKind)}${nameOf(m) ? `   ${nameOf(m)}` : ''}`.trimEnd());
    const more = ranked.length - lines.length;
    if (more > 0) lines.push(`  … and ${more} more — /members lists them all`);
    return `${head}. members here:\n${lines.join('\n')}`;
  }

  // /members add group <chat name|id> — invite a WhatsApp GROUP into this room as a member
  // (operator 2026-08-29: "that even allows for many and different groups to join a room. a room
  // works as a communication tunnel between groups"). The member id IS the group's chat id: that
  // is what the relay SENDS to, and what the reverse lookup (boot.createMemberResolver) keys on to
  // turn an inbound in that group into a fan-out over this room's roster. Same roster, same
  // setMember resolver as `add tab`, and — like a tab — it starts muted, so nothing crosses until
  // the operator flips its mode. The ARGUMENT goes through resolveChatArg above (operator
  // 2026-08-29: `/members add group radio` came back with the usage line because only a raw id
  // parsed) — that function IS this verb's old body, now shared.
  async function membersAddGroup(ev, room, arg) {
    const { id, error } = await resolveChatArg(arg);
    if (!id) { await send?.(ev.chatId, error); return; }
    // The duplicate check folds through sameChat too: a group already seated under one id
    // form must NOT be seated a second time under the other. Storing both forms is exactly
    // the split this chunk closes at comparison time — re-opening it on disk would defeat it.
    if ((await room.members()).some((m) => sameChat(m.id, id))) { await send?.(ev.chatId, `'${id}' is already a member here`); return; }
    await room.setMember({ kind: 'wa-group', id, state: 'muted' });
    // The RESOLVED id is named in the reply either way — it is what /members mode <m> <id> takes.
    const what = id === arg ? `'${id}'` : `'${arg}' → '${id}'`;
    await send?.(ev.chatId, `added group ${what} — mode:disable (no chatter reaches it yet)`);
  }

  // /members remove <id|name> — drop a member from the roster. room.removeMember owns the
  // actual removal (a full filter of the members[] array in config.yaml — nothing else
  // in room-core/commands.mjs is keyed by member id, so this is a complete removal); this
  // is wiring only. The STORED id is what gets removed, never the operator's spelling of
  // it — room-core stays keyed on the raw string it wrote, so nothing there had to change.
  async function membersRemove(ev, room, arg) {
    const { member, roster } = await memberFor(room, arg);
    if (!member) { await send?.(ev.chatId, await noMemberHere(arg, roster)); return; }
    await room.removeMember(member.id);
    const what = sameChat(member.id, arg) ? `'${member.id}'` : `'${arg}' (${member.id})`;
    await send?.(ev.chatId, `removed ${what}`);
  }

  // /members mode <disable|mention|all> <id|name> — flip a member's mode. The friendly word
  // maps to the stored room-core token (setMemberState preserves adapter/url/targetId).
  // The mode WORD is validated before the target is resolved, so a typo'd mode never pays
  // for a chat-list walk and its error is unchanged.
  async function membersSetMode(ev, room, arg, word) {
    const w = word.toLowerCase();
    const token = MODE_TO_STATE[w];
    if (!token) { await send?.(ev.chatId, `/members mode: unknown mode "${word}" — use disable|mention|all`); return; }
    const { member, roster } = await memberFor(room, arg);
    if (!member) { await send?.(ev.chatId, await noMemberHere(arg, roster)); return; }
    await room.setMemberState(member.id, token);
    // A name gets echoed back beside the id it resolved to, so the operator learns the key
    // this room is actually filed under; an id (either form) just names the stored one.
    const what = sameChat(member.id, arg) ? `${member.id}` : `'${arg}' (${member.id})`;
    await send?.(ev.chatId, `${what} → mode:${w} (${MODE_GLOSS[w]})`);
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
  // Verb-first (the /rooms 2026-08-07 lesson): an unrecognized verb NEVER touches a room,
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
      try { doc = await readRoomConfig(ns); } catch { doc = {}; }
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
    for (const { ns } of dirs) {
      let doc = {};
      try { doc = await readRoomConfig(ns); } catch { doc = {}; }
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
    if (j === 0) return lines.slice(0, i).join('\n');
    // A SINGLE-LINE close that round-tripped INLINE on the tail: applyLayers space-joins the close
    // onto a one-line reply (src/bridges/signature-layers.mjs), and dispatch-line.editAction collapses
    // a multi-line reply to one line before it round-trips, so the close ends up ON the last line and
    // the whole-line match above never sees it. Strip the EXACT configured close token off the end of
    // the last line — only when real content precedes it (a line that is JUST the close is the
    // whole-line case already handled above), never a guess at "any trailing emoji".
    if (closeLines.length === 1) {
      const tok = closeLines[0];
      const last = lines[lines.length - 1].replace(/\s+$/, '');
      if (last.length > tok.length && last.endsWith(tok)) {
        lines[lines.length - 1] = last.slice(0, -tok.length).replace(/\s+$/, '');
        return lines.join('\n');
      }
    }
    return text;
  }

  // Remove the persona stamp personaStamp (src/bridges/persona-wrap.mjs) prepends, checking against
  // every agent's ACTUAL configured emoji+label rather than pattern-guessing at "some emoji on the
  // first line". The stamp lands in TWO shapes and both come off here:
  //   - a whole LINE exactly equal to a stamp ("<body_emoji> <label>"), wherever the earlier strips
  //     left it;
  //   - a LEADING INLINE "<stamp>: " prefix — personaStamp's one-line form is "🐶 E: <reply>"
  //     (body + reply on ONE line), so a single-line reply (or a reply collapsed to one line by
  //     dispatch-line.editAction before it round-tripped through the transcript) carries the stamp
  //     inline and the whole-line filter never sees it. ONLY an EXACT configured stamp followed by
  //     ": " is removed — never a guess at "emoji + word + colon".
  function stripPersonaStampHeader(text) {
    const stamps = new Set();
    for (const [name, agent] of Object.entries(cfg().agents ?? {})) {
      if (!agent || typeof agent !== 'object') continue;
      stamps.add(`${agent.body_emoji || '🐶'} ${agent.name || name}`);
    }
    if (!stamps.size) return text;
    let out = String(text).split('\n').filter((l) => !stamps.has(l)).join('\n');
    for (const s of stamps) {
      if (out.startsWith(`${s}: `)) { out = out.slice(s.length + 2); break; }   // +2 for the ": "
    }
    return out;
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
    const scope = convScopeOf(ev);
    const room = await resolveConvRoom(scope.surface, scope.chatId);
    const nothingToRead = async () => { if (room && await radioCanActIn(room)) await send?.(ev.chatId, RS_NOTHING_TO_READ); };
    if (ev.replyToId == null) { await nothingToRead(); return; }
    let text = null;
    if (room) {
      // The quoted message was logged on THIS surface — read the per-surface file (a /join
      // side-room's transcript-<key>.md, else transcript.md), via the SAME write==read helper the
      // transcript writer files through; absent (tests) → room.transcriptPath.
      const path = (transcriptTarget && (await transcriptTarget(scope.surface, scope.chatId, { chatName: ev.chatName }))?.path) || room.transcriptPath;
      try { text = await readFile(path, 'utf8'); } catch { text = null; }
    }
    const body = text ? bodyForMessageId(text, ev.replyToId) : null;
    const cleaned = body ? cleanQuotedBody(body) : null;
    if (!cleaned) { await nothingToRead(); return; }
    await radio(ev, 'say', cleaned, null);
  }

  // ── /join + /split + /send + /end (operator 2026-10-03) ─────────────────────────────────────
  // A "fork" was always TWO things; here they are two commands sharing one structure.
  //   /join  — SUPERPOSITION. Create a side-group (operator + Rodz) and ALIAS its chatId to THIS
  //            chat's on-disk conversation (aliasOf). The being keeps writing its ONE thread; the
  //            group is just a second surface — no ACL (same folder), no context split (same thread),
  //            nothing told to the model. A VIEW.
  //   /split — REAL FORK. Create a side-group backed by a NEW conversation (its own slug/folder/entry,
  //            NOT an alias) whose resident beings' threads are COPIED so it DIVERGES. The parent
  //            chatId is recorded on the new entry (parent_chat) so /send+/end find the original.
  //   /send  — relay a replied-to message back to the original chat (the alias target for /join, the
  //            recorded parent_chat for /split). Repeatable; honours config.send.post_back_from.
  //   /end   — archive the group (both kinds) and drop its mapping. Posts nothing.
  //
  // THE NODE GATE (replaces the old config.fork.lead_node). On a shared primary account BOTH nodes
  // hear the command and the being resides on each, so neither the message nor the being can pick one.
  // DEFAULT: act only on the node whose own name plays the `primary` role — i.e. cfg().node_role ===
  // 'primary'. OVERRIDE: `/join <node>` / `/join=<node>` names a node directly; a trailing token that
  // matches a KNOWN node name (knownNodeNames) is the override, otherwise it is the `<name>` title
  // arg. On an addressed node, act only if ownNodeNamesOf has it. Every non-selected node stands down
  // SILENTLY. A being must still RESIDE here (residesHere), which is also the "is there a thread to
  // carry/copy" check. /send+/end gate instead on the alias-or-parent existing on this node — only the
  // node that created the group wrote it — so the co-account peer is silent there too.
  const residesHere = (state, surface, chatId) => {
    const agents = getContact(state, surface, chatId)?.entry?.agents ?? {};
    return Object.values(agents).some((b) => b && typeof b === 'object' && b.threadId != null);
  };

  // Parse `/join`/`/split`'s optional trailing token into a { node, name }. A KNOWN node name is the
  // `<node>` override (both the space form `/join do` and the `=do` form); anything else is the
  // `<name>` arg that fills {name} in the group title. node lowercased or null; name the raw token (or
  // null → the caller defaults it to the verb word).
  const parseForkArgs = (body) => {
    const m = /^\/(?:join|split)\b(?:=(\S+))?[ \t]*(.*)$/i.exec(String(body ?? '').trim());
    if (!m) return { node: null, name: null };
    const tok = (m[1] ?? m[2] ?? '').trim();
    if (!tok) return { node: null, name: null };
    const first = tok.split(/\s+/)[0].toLowerCase();
    if (knownNodeNames(cfg()).has(first)) return { node: first, name: null };
    return { node: null, name: tok };
  };

  // The shared node gate for /join + /split: true to PROCEED on this node, false to stand down
  // silently. node == null → proceed only when this node plays the primary role; a named node →
  // proceed only when it is one of ours.
  const forkNodeSelected = (node) => node
    ? ownNodeNamesOf(cfg()).has(node)
    : String(cfg().node_role ?? '').trim().toLowerCase() === 'primary';

  // A short, unguessable token for a DISCREET group's name (a phrase-triggered /join|/split carries no
  // <name>, and a predictable one — "join"/"split" — would advertise that a command ran). 5 hex chars
  // off randomUUID (already imported): enough to disambiguate, short enough to read in a title.
  const randomGroupToken = () => randomUUID().replace(/-/g, '').slice(0, 5);

  // config.join.placeholder / config.split.placeholder, with the built-in fallback so a command never
  // edits to an empty string.
  const placeholderOf = (block, dflt) => (block && typeof block.placeholder === 'string' && block.placeholder.trim()) ? block.placeholder : dflt;
  // config.group_title ({group}=parent chat name, {name}=the <name> arg), with the built-in fallback.
  const groupTitleOf = (groupName, name) =>
    ((typeof cfg().group_title === 'string' && cfg().group_title.trim()) ? cfg().group_title : GROUP_TITLE_DEFAULT)
      .replaceAll('{group}', String(groupName ?? '')).replaceAll('{name}', String(name ?? ''));
  // config.join.opener / config.split.opener ({group}=parent chat title), with the built-in fallback —
  // the message posted into the new side-group so it surfaces in Beeper (see postOpener below).
  const openerOf = (block, dflt, groupName) =>
    ((block && typeof block.opener === 'string' && block.opener.trim()) ? block.opener : dflt)
      .replaceAll('{group}', String(groupName ?? ''));
  // config.join.default_name / config.split.default_name — the {name} used when /join|/split carries NO
  // <name> (was the hard-coded verb word "join"/"split", which made every nameless /join on one chat an
  // IDENTICAL title; see uniqueTitle below), with the built-in fallback. Same shape as placeholderOf.
  const defaultNameOf = (block, dflt) => (block && typeof block.default_name === 'string' && block.default_name.trim()) ? block.default_name : dflt;
  // config.super.suffix — the super channel's title is <chat title> + suffix. Same non-empty-string
  // guard shape as placeholderOf; unset → the built-in '-super'.
  const superSuffix = () => { const s = cfg().super?.suffix; return (typeof s === 'string' && s.trim()) ? s : SUPER_SUFFIX_DEFAULT; };
  // config.super.mode — the auto-mode the super channel runs under. The coercion (quoted string vs
  // YAML boolean, invalid → default+log) is the SHARED auto-mode.superModeOf (operator 2026-10-08,
  // CHUNK 2): ONE definition, reused by the per-surface gate in gating.mjs so the gate and the
  // channel agree. CHUNK 2 moved the LIVE read to the gate — summoning stores NO mode any more — so
  // this wrapper has no in-module caller now; retained per the operator's instruction (the mode
  // resolution survives, the gate is its reader).
  const superMode = () => superModeOf(cfg().super?.mode, { onInvalid: (raw) => onLog(`super: invalid mode ${JSON.stringify(raw)} — using '${SUPER_MODE_DEFAULT}'`), fallback: SUPER_MODE_DEFAULT });
  // config.super.opener ({chat}/{group} both = the parent chat's title) — the bridge-voice intro
  // posted FROM RODZ once on creation (same postOpener path /join uses), with the built-in fallback.
  const superOpenerText = (chatTitle) =>
    ((typeof cfg().super?.opener === 'string' && cfg().super.opener.trim()) ? cfg().super.opener : SUPER_OPENER_DEFAULT)
      .replaceAll('{chat}', String(chatTitle ?? '')).replaceAll('{group}', String(chatTitle ?? ''));
  // RODZ's Beeper user id (@whatsapp_lid-…) — the one member the group must carry besides the creating
  // account. WhatsApp's create REFUSES a `+phone` member; the bridge resolves the id from
  // config.beeper.secondary.phone's digits. Null => STOP (log only, no chat reply). Shared by both verbs.
  const resolveRodz = async (chatId, verb) => {
    const accountID = await forkBridge.chatAccountId(chatId);
    const rodzDigits = phoneDigitsOf(cfg().beeper?.secondary?.phone);
    const rodzUserId = rodzDigits ? await forkBridge.resolveUserIdByPhone(rodzDigits, { accountID }) : null;
    if (!rodzUserId) { onLog(`${verb}: could not resolve Rodz's Beeper user id from config.beeper.secondary.phone — refusing, nothing created.`); return null; }
    return { accountID, rodzUserId };
  };

  // HHMM-MMDDYYYY from a LOCAL Date (10:48 on 2026-10-04 → "1048-10042026") — the minute-granular suffix
  // that makes a colliding side-room title unique (uniqueTitle below). Pure; the clock is the injected
  // `now` seam, so a test pins the suffix deterministically.
  const forkTimestamp = (d) => {
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}${p(d.getMinutes())}-${p(d.getMonth() + 1)}${p(d.getDate())}${d.getFullYear()}`;
  };
  // GUARANTEE A UNIQUE side-room title before the group is created. postOpener finds Rodz's room for the
  // new group BY TITLE (resolveSecondaryChatIdByTitle), so two side-rooms that share a title make that
  // lookup land in a STALE group while the fresh one stays empty (the 2026-10-04 nameless-/join bug). If a
  // group by this EXACT title already exists on the PRIMARY account, append " HHMM-MMDDYYYY" (local,
  // minute-granular — effectively unique, no loop). Covers the defaulted AND the explicitly-named case.
  // A probe that is unavailable (standalone/tests) returns the title untouched; a probe that THROWS is
  // treated as "does not exist" and logged — creation is NEVER blocked on a probe. Shared by /join + /split.
  const uniqueTitle = async (verb, title, accountID) => {
    if (typeof forkBridge.resolvePrimaryChatIdByTitle !== 'function') return title;
    let exists = false;
    try { exists = !!(await forkBridge.resolvePrimaryChatIdByTitle(title, { accountID })); }
    catch (e) { onLog(`${verb}: title-collision probe failed for "${title}" — ${e?.message ?? e} (treating as unique)`); return title; }
    if (!exists) return title;
    const unique = `${title} ${forkTimestamp(new Date(now()))}`;
    onLog(`${verb}: "${title}" already exists on the primary — using "${unique}" so the side-room title is unique`);
    return unique;
  };

  // POST THE OPENER into the freshly-created side-group so it SURFACES in Beeper (Beeper hides a chat
  // with no messages — verified live), shared by /join + /split. The group is created on the PRIMARY
  // account, but the opener must come FROM RODZ (the secondary): the secondary is a member and sees the
  // SAME group under its OWN room id, which Beeper surfaces ASYNCHRONOUSLY — so resolve that id BY TITLE
  // and POLL past the first misses (createGroup's async-create wait, through the injected sleep seam).
  // FALLBACK — the opener must ALWAYS appear: if the secondary never surfaces the group (or the post
  // there fails), post from the PRIMARY account to the new chatId. A failed opener NEVER fails the
  // command (the group + alias/copy already succeeded): log the path used and move on.
  const postOpener = async ({ verb, newChatId, title, openerText, accountID }) => {
    try {
      let secondaryRoomId = null;
      for (let i = 1; i <= OPENER_POLL_ATTEMPTS; i++) {
        secondaryRoomId = await forkBridge.resolveSecondaryChatIdByTitle(title, { accountID });
        if (secondaryRoomId) break;
        if (i < OPENER_POLL_ATTEMPTS) await sleep(OPENER_POLL_MS);
      }
      if (secondaryRoomId && await forkBridge.postReply(secondaryRoomId, openerText, null, { via: 'secondary' })) {
        onLog(`${verb}: opener posted FROM RODZ into ${secondaryRoomId} (secondary's room for "${title}")`);
        return;
      }
      const why = secondaryRoomId ? 'secondary post failed' : `secondary never surfaced "${title}" after ${OPENER_POLL_ATTEMPTS} polls`;
      await forkBridge.postReply(newChatId, openerText, null, { via: 'primary' });
      onLog(`${verb}: ${why} — opener posted via the PRIMARY into ${newChatId}`);
    } catch (e) {
      onLog(`${verb}: opener post failed — ${e?.message ?? e} (group + alias/copy already succeeded; moving on)`);
    }
  };

  // THE create+alias CORE shared by /join and the super channel (operator 2026-10-08) — §5.1: ONE
  // create-group + ONE alias-registration path, not two. Create the side-group (operator + Rodz +
  // any extra members), normalize createGroup's FULL matrix id to the SHORT chatId the spine keys by
  // (shortChatId — or an incoming short-form arrival spawns a separate folder+thread, the 2026-10-04
  // "side-room has no context" bug), and ALIAS it onto ev's conversation (aliasContact — so the being
  // keeps writing its ONE thread; two chat surfaces, one on-disk conversation). The side-room's
  // sanitized title is stored as the alias's per-surface transcript key, exactly as /join does.
  // Returns { chatId, primaryJid } (SHORT chatId), or null on a create failure — the caller then
  // edits/posts nothing. The caller owns everything that DIFFERS between /join and super: the
  // (already-unique'd) title, the trigger-message edit, the opener post, and `extra` — the fields
  // stored BESIDE `transcript` on the alias entry (super passes `{ super: true }`, its routing/gate
  // marker; /join passes nothing, so a /join side-room is never mistaken for a super channel).
  async function createAliasedSideGroup(ev, surface, title, accountID, participantIDs, verb, extra = {}) {
    const created = await forkBridge.createGroup({ accountID, participantIDs, type: 'group', title });
    const raw = created?.chatID ?? created?.chatId ?? null;
    const chatId = raw ? shortChatId(raw) : null;
    if (!chatId) { onLog(`${verb}: createGroup returned no chatID (${JSON.stringify(created)}) — aborted, nothing edited/posted`); return null; }
    // Reload fresh before the write (createGroup is async). Alias the new group's chatId to ev's
    // canonical (primary) entry — both ids now resolve to the SAME folder/agents/threads.
    const state = await loadState();
    const primaryJid = getContact(state, surface, ev.chatId)?.jid ?? ev.chatId;
    await writeState(aliasContact(state, surface, chatId, primaryJid, { transcript: sanitizeSlug(title), ...extra }));
    return { chatId, primaryJid };
  }

  // /join (operator types /join [<name>|<node>] in chat C): create the side-group and ALIAS it to C.
  // Every precondition resolves BEFORE any bridge/state mutation (an unresolvable Rodz STOPS, nothing
  // created).
  async function joinGroup(ev, { discreet = false } = {}) {
    const surface = surfaceOf(ev);
    if (!loadState || !writeState) return;                   // state not wired → silent
    const { node, name } = parseForkArgs(ev.body);
    if (!forkNodeSelected(node)) return;                     // not the selected node → silent
    const state0 = await loadState();
    // /join only ALIASES this chat's conversation onto the new side-group, so it needs a KNOWN
    // conversation to alias — NOT an existing being thread. A chat the being never answered in (an
    // ingested 1:1 transcript, no agents block) is still joinable: a fresh E invocation in the
    // group starts the first thread there, letting the operator work with this chat's context
    // without polluting the 1:1 (operator 2026-10-06). NB /split keeps residesHere — it COPIES
    // resident threads, so a thread-less split is meaningless. The chat where /join was typed is
    // always a known contact; this guard only trips on a genuinely-unknown chat.
    if (!getContact(state0, surface, ev.chatId)) {
      onLog(`/join: ${ev.chatId} is not a known conversation — nothing to alias, refusing.`);
      await send?.(ev.chatId, '/join: I don\'t know this conversation yet — send a message here first, then /join.');
      return;
    }
    const rodz = await resolveRodz(ev.chatId, '/join');
    if (!rodz) return;
    const cTitle = ev.chatName || (await forkBridge.chatTitle(ev.chatId)) || ev.chatId;
    const placeholder = placeholderOf(cfg().join, JOIN_PLACEHOLDER_DEFAULT);
    // DISCREET (a phrase trigger): a RANDOM group name instead of the parsed <name>, and the
    // operator's message is left UNEDITED below — so nothing in the chat shows a command ran.
    let title = groupTitleOf(cTitle, discreet ? randomGroupToken() : (name ?? defaultNameOf(cfg().join, 'egpt super')));
    // …then make it unique (suffix the title if the primary already has a group by that exact name, so the
    // opener's by-title lookup lands in THIS group, not a stale same-named one — the 2026-10-04 bug).
    title = await uniqueTitle('/join', title, rodz.accountID);

    // ── mutations begin ──
    // (a+b) CREATE the group (operator + Rodz, forced to a group; no inline opener — the group
    //       inherits C's whole thread by the alias) and ALIAS its SHORT chatId to C's canonical
    //       entry, via the create+alias core shared with the super channel (createAliasedSideGroup,
    //       which also stores the sanitized title as the alias's per-surface transcript key).
    //       null → createGroup gave no chatId: abort, placeholder NOT edited, nothing posted.
    const aliased = await createAliasedSideGroup(ev, surface, title, rodz.accountID, [rodz.rodzUserId], '/join');
    if (!aliased) return;
    const { chatId: joinChatId, primaryJid } = aliased;
    // (c) EDIT the operator's /join message into the placeholder marker (raw, no persona) — SKIPPED
    //     when discreet, so a phrase-triggered /join leaves the operator's natural words in the chat.
    if (!discreet) await forkBridge.editMessage(ev.chatId, ev.msgId, placeholder);
    onLog(`/join${discreet ? ' (discreet)' : ''}: ${cTitle} -> group ${joinChatId} aliased to ${primaryJid} (member ${rodz.rodzUserId})`);
    // (d) POST THE OPENER so the new (otherwise-empty) group surfaces in Beeper — added step AFTER the
    //     success path; a failure here never undoes the alias/placeholder above.
    await postOpener({ verb: '/join', newChatId: joinChatId, title, openerText: openerOf(cfg().join, JOIN_OPENER_DEFAULT, cTitle), accountID: rodz.accountID });
  }

  // Does THIS conversation already have its super channel? Delegates to the SHARED resolver
  // (conversations-state.superChannelFor) — the SAME one the reply path uses — keyed off the
  // `super: true` marker on the alias (set at creation), NOT a title heuristic (which missed a
  // renamed chat and could duplicate the channel). Pure state scan: survives a restart, no bridge
  // round-trip. Returns the existing super chatId or null. (operator 2026-10-08, CHUNK 2)
  const existingSuperChannel = (state, surface, chatId) => superChannelFor(state, surface, chatId);

  // ensureSuperChannel(ev, participantToInvite) (operator 2026-10-08, CHUNK 1) — summon this chat's
  // SUPER CHANNEL: a per-conversation side channel aliased to the original conversation (one shared
  // thread/transcript), where the Mouth will LATER speak so its replies stop polluting the main chat.
  // It REUSES /join's create+alias+opener path (createAliasedSideGroup + postOpener) — never a parallel
  // one. Summoned by an inbound "…" from ANY participant; config.super.enabled is gated at the trigger
  // (phraseCommand), not here.
  //   not existing → create it (operator + Rodz + the summoner), alias it (carrying the `super: true`
  //                  routing/gate marker), post config.super.opener once. It sets NO stored mode.
  //   existing     → reuse it (no re-create, no duplicate opener).
  // NODE GATE: like a nameless /join, only the primary-role node acts — on a shared account both
  // co-account nodes hear the "…" and only one must create the channel. THE MODE IS INTRINSIC, NOT
  // STORED (operator 2026-10-08, CHUNK 2): a super channel is an ALIAS, so a stored per-being mode
  // would resolve THROUGH aliasOf to the origin and mutate IT (and never revert on /end — the chunk-1
  // bug). Instead config.super.mode is read LIVE at the reply gate (gating.mjs, via the per-surface
  // super override), so summoning mutates nothing and /end reverts everything for free. Reply-routing
  // is chunk 2 (the marker + gating.decide); respect-exit / mention-reinvite is chunk 3 — the invite
  // here is a plain create-time one.
  async function ensureSuperChannel(ev, participantToInvite) {
    const surface = surfaceOf(ev);
    if (!loadState || !writeState) return;                   // state not wired → silent
    if (!forkNodeSelected(null)) return;                     // shared account: only the primary-role node creates it
    const state0 = await loadState();
    const contact = getContact(state0, surface, ev.chatId);
    if (!contact) { onLog(`super: ${ev.chatId} is not a known conversation — nothing to alias, refusing.`); return; }
    const primaryJid = contact.jid;
    const cTitle = ev.chatName || (await forkBridge.chatTitle(ev.chatId)) || ev.chatId;
    const title = `${cTitle}${superSuffix()}`;
    // EXISTING? reuse — no re-create, no duplicate opener (the SHARED marker-based resolver, above).
    const existing = existingSuperChannel(state0, surface, ev.chatId);
    if (existing) { onLog(`super: channel ${existing} already exists for ${ev.chatId} — reusing (no re-create, no opener)`); return; }
    const rodz = await resolveRodz(ev.chatId, 'super');
    if (!rodz) return;
    // ── mutations begin ──
    // CREATE + ALIAS (the SAME core /join uses), carrying `{ super: true }` so the gate + reply
    // routing can find this channel from the reply path. NO mode is stored — the channel's mode is
    // intrinsic (read live at the gate, see the header). operator + Rodz + the summoner (a plain
    // create-time invite — chunk 3 owns respect-exit / re-invite). null → createGroup gave no chatId.
    const participantIDs = [rodz.rodzUserId, ...(participantToInvite ? [participantToInvite] : [])];
    const aliased = await createAliasedSideGroup(ev, surface, title, rodz.accountID, participantIDs, 'super', { super: true });
    if (!aliased) return;
    const { chatId: superChatId } = aliased;
    onLog(`super: ${cTitle} -> channel ${superChatId} aliased to ${primaryJid}, invited ${participantToInvite ?? '(none)'}`);
    // POST THE OPENER (bridge voice, FROM RODZ) so the new group surfaces in Beeper — same postOpener
    // path /join uses; a failure here never undoes the alias above.
    await postOpener({ verb: 'super', newChatId: superChatId, title, openerText: superOpenerText(cTitle), accountID: rodz.accountID });
  }

  // /split (operator types /split [<name>|<node>] in chat C): create a side-group backed by a NEW
  // conversation that DIVERGES from C — each resident being's thread is COPIED under a new thread id.
  // Same preconditions/gate as /join; the difference is a NEW entry + per-being thread copy instead of
  // an alias.
  async function splitGroup(ev, { discreet = false } = {}) {
    const surface = surfaceOf(ev);
    if (!loadState || !writeState) return;                   // state not wired → silent
    const { node, name } = parseForkArgs(ev.body);
    if (!forkNodeSelected(node)) return;                     // not the selected node → silent
    let state = await loadState();
    if (!residesHere(state, surface, ev.chatId)) return;     // no being with a thread to copy → silent
    const rodz = await resolveRodz(ev.chatId, '/split');
    if (!rodz) return;
    const cTitle = ev.chatName || (await forkBridge.chatTitle(ev.chatId)) || ev.chatId;
    const placeholder = placeholderOf(cfg().split, SPLIT_PLACEHOLDER_DEFAULT);
    // DISCREET (a phrase trigger): random group name + message left unedited (same as /join above).
    let title = groupTitleOf(cTitle, discreet ? randomGroupToken() : (name ?? defaultNameOf(cfg().split, 'egpt split')));
    // …then make it unique (same reason as /join — see uniqueTitle); rodz.accountID resolved just above.
    title = await uniqueTitle('/split', title, rodz.accountID);

    // ── mutations begin ──
    // (a) CREATE the group.
    const created = await forkBridge.createGroup({ accountID: rodz.accountID, participantIDs: [rodz.rodzUserId], type: 'group', title });
    // SHORT id, same reason as /join above: the new entry + parent_chat must key by the form the
    // spine resolves incoming messages under, or a short-form arrival spawns a second entry.
    const rawSplitId = created?.chatID ?? created?.chatId ?? null;
    const splitChatId = rawSplitId ? shortChatId(rawSplitId) : null;
    if (!splitChatId) {
      onLog(`/split: createGroup returned no chatID (${JSON.stringify(created)}) — aborted, placeholder NOT edited`);
      return;
    }
    // (b) REGISTER the new group as its OWN conversation (ensureContact FIRST — recordThread/patch
    //     below no-op on an unknown contact), and record the parent chat so /send+/end find the
    //     original (a split group is NOT an alias).
    state = await loadState();
    const cSlug = getContact(state, surface, ev.chatId)?.slug ?? 'conv';
    const ensured = ensureContact(state, surface, splitChatId, { pushedName: title, slugHint: `egpt-split-${cSlug}` });
    state = ensured.state;
    const splitConvDir = slugDir(surface, ensured.slug);
    state = patchContact(state, surface, splitChatId, { parent_chat: ev.chatId });
    // (c) COPY each resident being's thread into the split conversation as a NEW, DIVERGING thread.
    //     The residents + their source thread ids come off the ORIGINAL entry (read fresh). For each:
    //     mint a newThreadId, TRANSFORM-copy the source jsonl into the new thread's store at the
    //     project dir matching the SPLIT conversation's cwd (sessionId→newThreadId, cwd→splitConvDir),
    //     and record the new thread on the split entry's agents.<being> block. `flag:'wx'` never
    //     clobbers an existing dest (EEXIST → refuse that one copy, log, still record the thread id).
    const origEntry = getContact(state, surface, ev.chatId)?.entry;
    const residents = residentsOf(origEntry)
      .map((being) => [being, getBeing(state, surface, ev.chatId, being)?.threadId ?? null])
      .filter(([, threadId]) => threadId);
    const copied = [];
    for (const [being, srcThreadId] of residents) {
      const newThreadId = randomUUID();
      const srcStore = jsonlStoreDirOf(srcThreadId, { jsonlStoreRoot });
      const srcFound = (srcStore ? findThreadJsonl(srcThreadId, [], { projectsRoot: join(srcStore, 'projects') }) : null)
        ?? findThreadJsonl(srcThreadId, []);
      if (srcFound) {
        const projDir = join(jsonlStoreDirOf(newThreadId, { jsonlStoreRoot }), 'projects', sanitizeCwdDir(splitConvDir));
        const destJsonl = join(projDir, `${newThreadId}.jsonl`);
        try {
          await mkdir(projDir, { recursive: true });
          const srcRaw = await readFile(srcFound.jsonlPath, 'utf8');
          await writeFile(destJsonl, rewriteForkSessionJsonl(srcRaw, { sessionId: newThreadId, cwd: splitConvDir }), { flag: 'wx' });
          copied.push(being);
        } catch (e) {
          onLog(`/split: thread copy for ${being} ${srcFound.jsonlPath} -> ${destJsonl} failed — ${e?.message ?? e}`);
        }
      } else {
        onLog(`/split: can't find ${being}'s thread store for #${srcThreadId} — recording the new thread id without a copy`);
      }
      state = recordThread(state, surface, splitChatId, newThreadId, undefined, being);
    }
    await writeState(state);
    // (d) EDIT the operator's /split message into the placeholder marker — SKIPPED when discreet
    //     (a phrase-triggered /split leaves the operator's natural words in the chat).
    if (!discreet) await forkBridge.editMessage(ev.chatId, ev.msgId, placeholder);
    onLog(`/split${discreet ? ' (discreet)' : ''}: ${cTitle} -> NEW conv ${splitChatId} (${ensured.slug}); copied threads for ${copied.join(', ') || '(none)'} (parent ${ev.chatId})`);
    // (e) POST THE OPENER so the new group surfaces in Beeper — added step AFTER the copy + placeholder;
    //     a failure here never undoes the conversation/threads already written.
    await postOpener({ verb: '/split', newChatId: splitChatId, title, openerText: openerOf(cfg().split, SPLIT_OPENER_DEFAULT, cTitle), accountID: rodz.accountID });
  }

  // /send (the operator REPLIES /send to a message M in a join/split group): relay M's text into the
  // ORIGINAL chat. Repeatable — no placeholder edit, no close. The original is the alias target (join)
  // or the recorded parent_chat (split); silent when neither. Reads M's text out of the transcript the
  // SAME way /radio say's quick-reply does, then strips the node/bridge/persona wrap. Posts via the
  // account named by config.send.post_back_from ('primary' = the operator's own account, the DEFAULT;
  // 'secondary' = the mouth) — boot routes { via } to that connection's bridge.
  async function sendToOriginal(ev) {
    const surface = surfaceOf(ev);
    if (!loadState) return;                                // state not wired → silent
    const state = await loadState();
    const originalChatId = aliasTargetOf(state, surface, ev.chatId)
      ?? getContact(state, surface, ev.chatId)?.entry?.parent_chat ?? null;
    if (!originalChatId) return;                           // not a join/split group → silent
    if (!residesHere(state, surface, ev.chatId)) return;   // gate (defensive — a group implies it)
    if (ev.replyToId == null) { await send?.(ev.chatId, 'reply to a message with /send to send it to the original chat'); return; }
    // The quoted message was logged on THIS surface, so read it from THIS surface's own transcript:
    // for a /join side-room that is transcript-<its id>.md beside the shared transcript.md (same
    // folder), for a /split its own conversation's transcript.md. transcriptTarget is the SAME
    // write==read helper the transcript writer files through; absent (tests) → room.transcriptPath.
    const tt = transcriptTarget ? await transcriptTarget(surface, ev.chatId, { chatName: ev.chatName }) : null;
    const path = tt?.path ?? (await resolveConvRoom(surface, ev.chatId))?.transcriptPath ?? null;
    let text = null;
    if (path) { try { text = await readFile(path, 'utf8'); } catch { text = null; } }
    const body = text ? bodyForMessageId(text, ev.replyToId) : null;
    const cleaned = body ? cleanQuotedBody(body) : null;
    if (!cleaned) { await send?.(ev.chatId, '/send: nothing to send — reply to a message that has text'); return; }
    const pbf = String(cfg().send?.post_back_from ?? '').trim().toLowerCase();
    let via = (pbf === 'primary' || pbf === 'secondary') ? pbf : SEND_POST_BACK_FROM_DEFAULT;
    // Rodz (the secondary) has its OWN room id for the ORIGINAL chat — a group is a different Matrix
    // room per account — so posting the original's PRIMARY id on the secondary bridge FAILS ("could
    // not post", the 2026-10-04 bug). When posting FROM RODZ, resolve the secondary's room for the
    // original by title first (like the opener); if it can't be found, fall back to posting from the
    // PRIMARY (the operator's own account), which always has the original's room and lands.
    let targetChatId = originalChatId;
    if (via === 'secondary') {
      const origTitle = (await forkBridge.chatTitle(originalChatId)) || getContact(state, surface, originalChatId)?.slug || null;
      const accountID = await forkBridge.chatAccountId(originalChatId);
      const secRoom = origTitle ? await forkBridge.resolveSecondaryChatIdByTitle(origTitle, { accountID }) : null;
      if (secRoom) targetChatId = secRoom;
      else via = 'primary';
    }
    // UNSIGNED (operator 2026-10-04): /send posts back AS THE OPERATOR — no node signature (no visible
    // 🏰 bridge close, no invisible node tag). Routed into the SAME .send via skipSignature, so the
    // relay's sent id is still tracked for echo-dedup (beeper.mjs _sentIds) and this node won't re-ingest it.
    const posted = await forkBridge.postReply(targetChatId, cleaned, null, { via, unsigned: true });
    if (!posted) { await send?.(ev.chatId, '/send: could not post to the original chat'); return; }
    onLog(`/send: ${ev.chatId} -> original ${originalChatId} via ${via}${targetChatId !== originalChatId ? ` (Rodz's room ${targetChatId})` : ''} (message ${ev.replyToId})`);
  }

  // /end (the operator REPLIES /end in a join/split group): archive the group and drop its mapping so
  // it is closed. For /join that is the alias; for /split it is the group's OWN conversation entry (its
  // parent_chat marks it) — dropContact retires the mapping (the diverged folder/jsonl stay on disk).
  // Posts NOTHING. Silent outside a join/split group (no alias and no parent on this node).
  async function end(ev) {
    const surface = surfaceOf(ev);
    if (!loadState || !writeState) return;                 // state not wired → silent
    const state = await loadState();
    const aliasTarget = aliasTargetOf(state, surface, ev.chatId);
    const parent = getContact(state, surface, ev.chatId)?.entry?.parent_chat ?? null;
    if (!aliasTarget && !parent) return 'no-op — not a /join or /split side channel';   // silent to the chat; the audit says why nothing happened
    await forkBridge.archiveChat(ev.chatId);
    await writeState(dropContact(await loadState(), surface, ev.chatId));
    onLog(`/end: ${aliasTarget ? 'join' : 'split'} group ${ev.chatId} archived + ${aliasTarget ? `alias to ${aliasTarget}` : `split conv mapping (parent ${parent})`} dropped`);
    return `archived ${ev.chatName || ev.chatId}`;         // the audit's <outcome> for a successful archive
  }

  // ── PHRASE TRIGGERS for the fork commands (operator 2026-10-04) ──────────────────────────────────
  // Each of /join /split /send /end may be invoked by extra natural phrases set in config.<cmd>.triggers
  // (a list of strings), so a command can run WITHOUT typing its '/'-word — and, for /join + /split,
  // DISCREETLY: a random group name and the operator's message left unedited, so the chat reads as
  // ordinary conversation. The '/'-word path is UNCHANGED; this is a second, separate entry point the
  // inbound dispatcher (spine.mjs classify) consults for a NON-slash message.
  //
  // SECURITY. phraseCommand is the ONLY new entry point and it is gated on the SAME isOperator the
  // '/'-commands sit behind (isCommand → isOperator) — no new auth path. A non-operator saying the exact
  // phrase is NOT a trigger (it falls through to an ordinary message), and matching is EXACT ONLY — the
  // WHOLE trimmed, lower-cased message must EQUAL a configured phrase; never prefix/contains — so an
  // everyday sentence can never fire one. Returns the command name to run (join|split|send|end), or null.
  const PHRASE_TRIGGER_CMDS = ['join', 'split', 'send', 'end'];
  function phraseCommand(ev) {
    // SUPER CHANNEL SUMMON (operator 2026-10-08, CHUNK 1) — the ONE phrase trigger that is NOT
    // operator-gated: an inbound message whose whole trimmed body is the deliberate-silence shape
    // ("…"/"...") from ANY participant summons the super channel, so a counterparty can read the
    // bot's reply there. CHECKED BEFORE the isOperator gate the other triggers sit behind — the
    // any-sender scope is the whole point. Gated only on config.super.enabled (unset/false ⇒ the
    // "…" falls through exactly as today). INBOUND ONLY: the model's reply-"…" is OUTBOUND and never
    // reaches this (inbound-dispatch) path — it is echo-deduped before classify, so it cannot
    // self-summon. isDeliberateSilence is the ONE ellipsis-shape predicate (auto-mode.mjs), reused.
    if (cfg()?.super?.enabled && isDeliberateSilence(ev?.body)) return 'super';
    if (!isOperator(ev)) return null;                        // same gate the '/'-commands sit behind
    const body = String(ev?.body ?? '').trim().toLowerCase();
    if (!body) return null;
    for (const cmd of PHRASE_TRIGGER_CMDS) {
      const triggers = cfg()?.[cmd]?.triggers;
      if (!Array.isArray(triggers)) continue;
      if (triggers.some((t) => String(t ?? '').trim().toLowerCase() === body)) return cmd;   // EXACT only
    }
    return null;
  }

  // Run a fork command from a PHRASE trigger. /join + /split run DISCREETLY (random name, no edit); the
  // same residesHere/node_role gates inside the handler still apply — a phrase can only run what its
  // '/'-word would run on this node. /send + /end take no name and edit nothing, so a phrase just runs
  // them (they are typed in the private side-room anyway).
  async function runPhrase(ev, cmd) {
    // 'super' (operator 2026-10-08): the inbound "…" summons this chat's super channel, invited to
    // its SENDER (the summoner) — any participant, so they can read the reply there. No discreet
    // concept and no message edit (the "…" IS the user's message, not a command to hide).
    if (cmd === 'super') return ensureSuperChannel(ev, ev.senderId ?? null);
    if (cmd === 'join') return joinGroup(ev, { discreet: true });
    if (cmd === 'split') return splitGroup(ev, { discreet: true });
    if (cmd === 'send') return sendToOriginal(ev);
    if (cmd === 'end') return end(ev);
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
  // `account` is ANCHORED so `peer_nodes` ([kg, do] — not sensitive, and worth seeing) stays.
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
  //   'silent' — <target> is a node on this Beeper account that is NOT us (cfg.peer_nodes,
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
    const peers = cfg().peer_nodes;
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
      const peers = cfg().peer_nodes;
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
            // EACH BEING'S OWN MODEL (2026-09-24): resolved through resolveBeingDef, the resolver
            // turn() uses and the one /agents status calls just above, so a target carries the
            // window and ratio the spine compacts THIS being at (compact-being's compactionPolicy),
            // not the node default brain's. Was: every conversation read haiku's 200k, and an opus
            // being showed 160k while the spine compacted it at 800k.
            const modelOf = ({ being, surface, slug, beingView }) => resolveBeingDef(being, slugDir(surface, slug), { getConfig: cfg, brains, brainType: CCODE, configuration: beingView?.configuration, onLog })?.model ?? null;
            targets = compactionTargets({ config: cfg(), convState: st ?? {}, slugDir, modelOf });
          } catch { targets = []; }
          const byKey = new Map(targets.map((t) => [t.key, t]));
          const ratio = compactionRatio(cfg());
          for (const key of keys) {
            const t = byKey.get(key);
            let detail = 'no session';
            if (t) {
              try {
                const r = t.ratio ?? ratio;
                const { tokens, threshold } = dueFor(t, { ratio: r });
                const limit = threshold ?? Math.round((t.window || windowForModel(t.model)) * r);
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

  // Distinct participants seen in a transcript's tail. ONE SHAPE, ONE KIND OF NAME (operator
  // 2026-08-28: "no sigil, no distinction, an agent is just another participant in a room") —
  // so ONE regex over the dispatch-line "Sender@[chat]…" head, incl. its stage-direction
  // "[ Sender@…" wrap. Lines written before that ruling carry the being's `@` sigil and a
  // `.<node>` qualifier ("@egpt.kg@[chat].wa (HH:MM): …"), and older ones still the reply-only
  // "[@being (HH:MM)]: …" template; both are matched here and both are reported BARE, so one
  // agent that spoke on either side of the change is one roster entry, not two. The sigil and
  // the qualifier are stripped TOGETHER (the first alternative), never the qualifier alone — a
  // person's display name may legitimately contain a dot and must survive whole. No
  // member-roster store exists yet — conversation-members.mjs seeds a BRAIN roster from
  // config (residents_per_chat + auto-mode), not who actually spoke, so it doesn't answer
  // "who's in this conversation"; this reads the honest signal that already exists on
  // disk. Pure; `text` is front-matter-stripped first so `name:`/`---` lines never match.
  const _SENDER_RE = /^\[?\s*(?:@([^\s@]+?)(?:\.[^\s.@]+)?|([^@\s][^@]*?))@\[|^\[@([^\s@]+?)(?:\.[^\s.@]+)?\s\(\d{1,2}:\d{2}\)\]:/;
  function membersFromTranscript(text, { tailLines = 200 } = {}) {
    const lines = stripFrontMatter(String(text ?? '')).split('\n').slice(-tailLines);
    const seen = new Set();
    for (const line of lines) {
      const m = _SENDER_RE.exec(line);
      if (m) seen.add((m[1] ?? m[2] ?? m[3]).trim());
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
        // The ratio AND window the spine applies to this being here, override included
        // (compact-being's compactionPolicy, 2026-09-24) - not the node ratio over the model's
        // table window, which ignored a conversation's own `compaction:` and `context_window`.
        const p = compactionPolicy(cfg(), model, compactionOverrideOf(b, cfg(), defaultKey));
        const { tokens, threshold } = dueFor({ sessionId: b.threadId, model, window: p.window }, { ratio: p.ratio });
        const limit = threshold ?? p.threshold;
        if (tokens != null) context = `${tokens}/${limit} tok (compact at ${Math.round(p.ratio * 100)}% of ${p.window})`;
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
  // § /agents dispatch + agentsCmd/agentsReset/agentsMode/agentsAccessLevel/agentsStatus
  // above). `/e`/`/egpt` now carry no special meaning at all and fall through to the generic
  // catch-all like any other unrecognized token.

  return { isCommand, phraseCommand, runPhrase, run, runCaptured, remoteNode, nodeCommandForMe, makeNodeExplicit, currentRoomOf, startBrowser };
}
