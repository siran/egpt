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
import { lifecycleExit, lifecycleForce } from './ingest.mjs';
import { isAutoMode, AUTO_MODES, DEFAULT_AUTO_MODE } from '../auto-mode.mjs';
import { patchBeing, patchContact, deleteBeing, getContact, getBeing, ensureContact, recordThread, findThreadJsonl, aliasContact, dropContact, aliasTargetOf, residentsOf, defaultBeingOf, allowedUsersPermits, setAliasMouthChat, slugDir, statsPath, conversationPathOf, seedIdentityLayers, skeletonIdentityFiles, slugSuffix, rollTranscript, fixedSlugFor, mutateState, DETERMINISTIC_MODEL, DETERMINISTIC_EFFORT, DEFAULT_ALLOWED_TOOLS, LOBBY_SLUG } from '../conversations-state.mjs';
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
// valid handles in the not-hosted log line. See agentsCmd's HANDLE → KEY block.
import { addressed, addressableTokens, fallbackWake, isKnownSender, wakeTokens, voiceWakeTokens } from './router.mjs';
import { superChannelAlive, resolveMode } from './gating.mjs';
import { stat as fsStat, readFile as fsReadFile, writeFile as fsWriteFile, mkdir as fsMkdir, readdir as fsReaddir, rm as fsRm, rename as fsRename } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID, randomInt } from 'node:crypto';
import { join, basename, dirname } from 'node:path';
import * as YAML from 'yaml';
import { EGPT_HOME } from '../egpt-home.mjs';
import { shortChatId } from '../bridges/chat-id.mjs';
// "did you mean …?" for the two /members misses that used to be dead ends (operator
// 2026-08-31) — the scorer lives in src/text-similarity.mjs beside the echo one, so
// this module never grows a fuzzy-match of its own.
import { closestNames } from '../text-similarity.mjs';
import { ownNodeNamesOf, knownNodeNames } from './node-names.mjs';
import { Room, ROOMS_ROOT } from '../room-core.mjs';
import { SHELL_SURFACE, surfaceOf as surfaceOfNetwork } from './identity.mjs';
// The room slug rule (fixedSlugFor, surface `room`) applied to a READ, which must not mint —
// see roomOnDisk. NOT for the /rooms verbs: they pass the operator's raw string through.
import { sanitizeName, sanitizeSlug } from '../sanitize.mjs';
import { loadAdapters as defaultLoadAdapters, matchAdapter } from '../adapters/registry.mjs';
import { agentPaths } from '../mesh/relay.mjs';
import { compactionTargets, dueForCompaction, windowForModel, compactionPolicy, compactionOverrideOf } from '../tools/compact-being.mjs';
import { fill } from '../tools/template.mjs';
import { compactionRatio } from './compaction.mjs';
import { NODE_FILE, REGISTRY_FILE, parseEntityConfig } from './config-resolver.mjs';
import { CONFIG_YAML_PATH, writeConfigKey } from '../tools/config-io.mjs';
import { isRestartKey } from './config-swap.mjs';
import { resolveConfigKey } from '../../config/config-schema.mjs';
import { createCdpClient, createChannelTransport } from '../tools/cdp.mjs';
import { resolveBrainProfile, chromePipeArgs, stampGroupProfile, profileHolder as defaultProfileHolder } from '../tools/chrome-launcher.mjs';
import { connectChromeHost } from '../chrome-host.mjs';
import { admitLaunch, estimateChromeBytes, BRAIN_GROUP, SHARED_GROUP, isSafeGroupName, chromeConversationOf } from './chrome-pool.mjs';
import { freemem } from 'node:os';
import { helpText, COMMAND_SET, parseBeingCommand } from '../interpreter.mjs';
import { uploadNote, radioNoteFilename, pickSpeaker } from '../radio-relay.mjs';
import { stripNodeSignature, stripRenderedNodeSignature, decodeChatCanary } from '../node-signature.mjs';
import { bodyForMessageId } from '../transcript-log.mjs';
import { htmlToMarkdown } from '../html-to-markdown.mjs';
import { readRoomConfig, readBrowserGroups, readBrowserColors } from '../rooms-file.mjs';
import { hhmm, dayBoundary } from '../dispatch-line.mjs';
import { statCache } from '../stat-cache.mjs';

// Where a manually-launched Chrome should keep its profile. v1's shell hardcoded
// ~/.egpt/chrome/profiles/brain — a usually-BLANK fresh dir. resolveBrainProfile() instead
// SEARCHES the v2 default + the operator's v1 browser profiles and picks the one actually
// logged in to an AI site, falling back to the v2 default when none qualify. Memoized once at
// module load (a read-only fs scan); still derives from EGPT_HOME so a second node follows its
// own root. See src/tools/chrome-launcher.mjs.
export const CHROME_BRAIN_PROFILE = resolveBrainProfile();

// Group-Chrome memory-admission defaults; overridable via config chrome.launch_estimate_mb
// (per-Chrome cost floor) and chrome.memory_margin_mb (free-memory margin a launch must leave).
const CHROME_LAUNCH_ESTIMATE_MB = 500;
const CHROME_MEMORY_MARGIN_MB = 1024;
const MB = 1024 * 1024;

// Default per-pid RSS reader (injected seam; faked in tests). Best-effort working set in bytes, or
// null when unreadable — a null sample is DROPPED by estimateChromeBytes, never counted as 0.
function defaultRssOf(pid) {
  if (!pid) return null;
  try {
    if (process.platform === 'win32') {
      const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true }).stdout || '';
      const m = out.match(/"([\d.,]+)\s*K"\s*$/m);
      return m ? Number(m[1].replace(/[.,]/g, '')) * 1024 : null;
    }
    const out = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).stdout || '';
    const kb = Number(String(out).trim());
    return Number.isFinite(kb) && kb > 0 ? kb * 1024 : null;
  } catch { return null; }
}

// The --user-data-dir a launch should use. THE ONE PLACE THE PROFILE IS DECIDED (see ensureChrome's
// banner) — no caller resolves its own.
//
// LEGACY (one arg, the no-conversation path every caller still takes in chunk 1): config
// `chrome.profile_dir` when the operator set one, else the discovered brain profile. CONFIGURATION
// BEATS DISCOVERY, and the schema says why in its own words — profile_dir names "a REAL,
// already-logged-in profile kept for the purpose", and it is the same path a being is TOLD to drive
// CDP on (30-pointers.md). A spine that launched Chrome into some other directory would hand its
// beings a browser logged in to nothing they were promised. resolveBrainProfile() is the fallback
// precisely because it is a HEURISTIC: it scans for a profile that has been used on an AI site.
// No conversation ⇒ CHROME_BRAIN_PROFILE ⇒ byte-identical to before.
//
// BROWSER GROUPS (plans/2610091931 rev 2026-10-11). `conversation` is chrome-pool.chromeConversationOf's
// { key, name, group }; group name = profile dir name. Group `brain` → the legacy value above (where
// Gmail / ClassDojo / AWS are signed in). Any other group → <profiles-root>/<group>, profiles-root
// being the parent of CHROME_BRAIN_PROFILE (.egpt/chrome/profiles/). No group, or one that is not a
// safe path segment → null: no browser, never a fallback to brain.
export const chromeProfileOf = (c, conversation) => {
  const legacy = c?.chrome?.profile_dir || CHROME_BRAIN_PROFILE;
  if (!conversation || conversation.group === BRAIN_GROUP) return legacy;
  return isSafeGroupName(conversation.group) ? join(dirname(CHROME_BRAIN_PROFILE), conversation.group) : null;
};
// The profile /login reads a saved password from: the conversation's group profile. The
// login.chrome_profile_path override is the BRAIN's only; no group → null, nothing read.
export const loginProfilePathOf = (c, conversation) =>
  ((!conversation || conversation.group === BRAIN_GROUP) && c?.login?.chrome_profile_path) || chromeProfileOf(c, conversation);
// The executable: config `chrome.bin`, else null — which lets chrome-launcher run its own
// per-platform CHROME_PATHS search. Never a second locator here.
const chromeBinOf = (c) => c?.chrome?.bin || null;

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

// The commands anyone in a chat may run (operator 2026-10-19): config.yaml public_commands, or the
// chat's own conversations.yaml list, which replaces it. Everything else is the node's allowed users'.
const PUBLIC_COMMANDS_DEFAULT = ['join', 'split', 'send', 'end'];
// Bare /agents: a non-operator gets agentsPublic where public_commands lists agents.
const AGENTS_BARE_CMD = /^\/agents\s*$/i;
// The public list's words for a reply mode; 'off' has none (that being is not listed).
const PUBLIC_MODE_WORDS = {
  on: 'answers everything', auto: 'answers everything',
  mention: 'answers only when called', accum: 'answers only when called',
  'mention-direct': 'answers only when called at the start of a message',
  mute: 'only logs the chat, never answers',
};

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
//   /agents <handle>|force all [<conv>]                       status
//   /agents refresh|rethread|reset|compact|stop <handle>|force all [<conv>]
//   /agents mode <mode> <handle>|force all [<conv>]           (`auto` is a deprecated alias of `mode`)
//   /agents access_level <level> <handle>|force all [<conv>]  (level: see ACCESS_LEVELS)
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
export const AGENT_SUB_ARITY = { refresh: 0, rethread: 0, reset: 0, compact: 0, stop: 0, mode: 1, access_level: 1, restart: 0 };
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
export const AGENTS_USAGE = `usage: /<handle> agents [<verb>] [<value>] [<handle>|force all [<conversation>]] — verbs: refresh | rethread | reset | compact | stop | mode <${AUTO_MODES.join('|')}> | access_level <${ACCESS_LEVELS.join('|')}>. A verb with no target acts on the being the command was typed to. \`/<handle> agents <handle>|force all\` shows status; bare \`all\` is refused. <conversation> is the rest of the line, spaces and all: \`/e agents refresh e eGPT Rodz Lulu An\`.`;

// args (already whitespace-split) -> what agentsCmd wants: { args: [handle, verb, value],
// slug }, or { retired } for the old order. Pure; exported for tests.
//
// The conversation is EVERYTHING after the handle, joined with single spaces (operator
// 2026-09-28: "please enable: /agent refresh <agent> <channel slug> so i can fire from eGPT
// Admin"). It was one token, and chat names and slugs carry spaces (`eGPT Rodz Lulu An-
// 2609201419`), so `refresh e eGPT Rodz Lulu An` resolved "eGPT" and answered `don't know
// where to put "Rodz Lulu An"`. With nothing left over in any shape, that reply went too.
// `force all` is ONE target (operator 2026-10-11); the conversation starts after it.
const FORCE_ALL = 'force all';
const targetAt = (args, i) => (args[i]?.toLowerCase() === 'force' && args[i + 1]?.toLowerCase() === 'all'
  ? { handle: FORCE_ALL, slug: args.slice(i + 2).join(' ') || null }
  : { handle: args[i], slug: args.slice(i + 1).join(' ') || null });
export function normalizeAgentsArgs(args) {
  // Alias → live verb BEFORE the arity lookup, and the canonical verb is what downstream reads:
  // `auto` is resolved to `mode` here so the dispatch, confirmations and help all speak one verb.
  const verb = canonicalAgentSub(args[0]?.toLowerCase());
  if (verb && Object.hasOwn(AGENT_SUB_ARITY, verb)) {
    const takesValue = AGENT_SUB_ARITY[verb] === 1;
    const value = takesValue ? args[1] : undefined;
    const { handle, slug } = targetAt(args, takesValue ? 2 : 1);
    return { args: [handle, verb, value], slug };
  }
  // No leading verb: either the bare status form (`<handle> [<conv>]`) or the retired
  // object-first order, which is recognisable exactly — and worth recognising, to say so. The
  // second token is canonicalized too, so `e auto mention` is still caught as the old order.
  const second = canonicalAgentSub(args[1]?.toLowerCase());
  if (second && Object.hasOwn(AGENT_SUB_ARITY, second)) {
    return { retired: { handle: args[0], verb: args[1], rest: args.slice(2) } };
  }
  const { handle, slug } = targetAt(args, 0);
  return { args: [handle], slug };
}

// The whole surface is PLURAL (operator 2026-08-29: "we should keep only '/agents', '/rooms',
// and the singular asking you means plural?"). The singular is NOT silently aliased — it asks.
// An alias would work forever and teach nothing; a question is answered once.
export const PLURAL_OF = { agent: 'agents', room: 'rooms', member: 'members' };
export const SINGULAR_CMD = /^\/(agent|room|member)(?:=\S+)?(?:\s+[\s\S]*)?$/i;

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
// config.join.placeholder is a template ({name} {title} {group} {by}); config.join.exists answers a
// /join whose name is already a live side-room the sender is not in (operator 2026-10-16).
export const JOIN_PLACEHOLDER_DEFAULT = '🔗 joined group {name}. You can join too: send /{handle} join {name}';
export const JOIN_EXISTS_DEFAULT = '🔗 group {name} already exists. Ask {by} to add you.';
// config.join.limit: the answer when config.join.member_cap (live side-rooms per non-operator per
// chat; -1/unset = unlimited) is reached. {name} lists that member's rooms.
export const JOIN_LIMIT_DEFAULT = '🔗 you already have group {name} here.';
export const SPLIT_PLACEHOLDER_DEFAULT = '🍴🤖 ...';
export const GROUP_TITLE_DEFAULT = '{group}-{name}';
// Every side group's title starts with it: "SI+<group>-<name>" (/join, /split), "SI+<group>" (automatic,
// unless reply_in_side_group names the title).
export const SIDE_GROUP_PREFIX = 'SI+';
// /send's posting account when config.send.post_back_from is unset or invalid: the operator's OWN
// account (primary) — /send relays as the operator, who typed it (operator 2026-10-04). The config
// override config.send.post_back_from='secondary' still routes via the mouth when set.
export const SEND_POST_BACK_FROM_DEFAULT = 'primary';
// config.send.origin (auto | always | never) and config.send.origin_template ({group} = side group title).
export const SEND_ORIGIN_DEFAULT = 'auto';
export const SEND_ORIGIN_TEMPLATE_DEFAULT = '↪ from {group}:\n';
// config.join.opener / config.split.opener (a {group}=parent-chat-title, {handle} template) — the one message
// posted into the freshly-created side-group by the primary so the otherwise-empty group SURFACES in Beeper
// (Beeper hides a chat with no messages — verified live). These are the small built-in fallbacks when
// the key is unset; the real text is set in config.yaml. Exported so tests assert the fallback.
export const JOIN_OPENER_DEFAULT = '🔗 Side-room of {group} — same agents, same conversation. Reply /{handle} send to a message to copy it back to the original chat; /{handle} end to close.';
export const SPLIT_OPENER_DEFAULT = '🍴 Fork of {group} — a diverging copy: same agents, its own thread from here. Reply /{handle} send to a message to copy it back to the original chat; /{handle} end to close.';
// The automatic group's opener: /end is off there (operator 2026-10-18 ~21:00).
export const AUTO_OPENER = '🔗 Side-room of {group} — same agents, same conversation. Reply /{handle} send to a message to copy it back to the original chat.';
// How long Rodz's copy of the opener may take to arrive: the new group reaches its account asynchronously.
const OPENER_COPY_MS = 5000;

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
  floodBan = null,                       // the media-flood auto-ban (src/flood-ban.mjs) — /unban clears, /bans lists; the SAME instance the bridges observe into. Null (standalone) → both commands say it isn't wired.
  background = null,                     // the node's background-work registry (src/spine/background.mjs) — the operator's bare /agents lists it
  beeperUpdate = null,                   // /update beeper (src/tools/beeper-update.mjs createBeeperUpdate); null → not wired here
  send: rawSend,                         // (chatId, text) -> deliver a plain system reply
  exit = (code) => process.exit(code),
  writeRewindTarget,
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
  // /agents compact|stop (boot: compaction.compactNow over brain.warmKey; brain.stop).
  compactBeing = () => ({ ok: false, reason: 'compaction is not wired on this node' }),   // (being, ev, { sessionId }) -> { ok, reason } | { ok, inFlight, done }
  stopBeing = async () => ({ stopped: false, reason: 'not wired on this node' }),         // (being, ev) -> { stopped: false|'interrupt'|'evict' }
  configPath = CONFIG_YAML_PATH,         // where /config <key>=<value> writes — the real profile config.yaml by default (injected in tests, so no test ever touches the real profile)
  io = {},                               // { stat, readFile, writeFile, mkdir, readdir, rm } — real fs by default; /status probes files + the custom branch authors through here
  // /login <site> → the auto-login limb (src/spine/login.mjs), injected by boot. Returns an
  // OUTCOME token (logged-in | needs-2fa | captcha-posted | failed | no-credential) — NEVER a
  // credential. Absent (standalone construction / a test that doesn't need it) → /login replies
  // that the limb isn't wired, never throwing.
  requestLogin = null,
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
  // Clock seam — real timers by default; tests inject a fake clock.
  now = () => Date.now(),
  // Group-Chrome pool seams — a FAKE host + injected memory in tests, never a real spawn or a real
  // OS probe. chromeHost is the S1 daemon that launches and holds every pipe Chrome (src/chrome-host.mjs;
  // null → no browser); profileHolder says whether another Chrome already holds a profile; freeMem/rssOf
  // feed the pure admission (chrome-pool.mjs); onChromeLog reports launches / evictions / deaths /
  // refusals. Boot injects onChromeLog only (real host + probes).
  chromeHost = connectChromeHost(),
  profileHolder = defaultProfileHolder,
  freeMem = () => freemem(),
  rssOf = defaultRssOf,
  onChromeLog = () => {},
  browserGroups = readBrowserGroups,     // config/browsers.yaml's groups, read fresh (rooms-file.readBrowserGroups)
  browserColors = readBrowserColors,     // its optional colors: map, read at each launch
  commandAliasesPath = join(EGPT_HOME, 'config', 'commands_alias.yaml'),   // alias → command line (aliased, below)
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
  // createCommands that doesn't inject the send guard is unaffected — never a second ceiling).
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
    chatRaw:       async () => null,    // (chatId) -> the GET /v1/chats/{id} payload (roster) | null when gone
    resolveUserIdByPhone: async () => null,   // (phoneDigits, { accountID }) -> "@whatsapp_lid-…:beeper.local" | null
    awaitMouthMessage: async () => null,   // (test, ms) -> the next raw message Rodz's account receives, in any chat, passing test | null
  },
  // Per-command audit sink (operator 2026-10-08): (text) => Promise<bool>, posts ONE metadata-only line
  // to config.log_to_group through boot's fail-closed resolver+poster (noticeToChannel). Safe no-op
  // default so a standalone/test createCommands audits nowhere; a failed/absent post never affects a
  // command (the chokepoint swallows it).
  logToGroup = async () => false,
  // ({ what, chatId, why? }) => Promise — boot's one log_to_group line for a lost opener/reply/limb.
  reportUndelivered = async () => false,
  onLog = () => {},
} = {}) {
  const cfg = () => getConfig() ?? {};
  // THE reply chokepoint: every reply this module emits goes out through here, so the
  // no-self-parsing convention (quoteLeadingCommand, above) cannot be missed by a new
  // message — including one added later. Call sites stay `send?.(chatId, text)`.
  const send = (chatId, text) => rawSend?.(chatId, quoteLeadingCommand(text));
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
  // its Room here.
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
      if (name === 'use' || name === 'auto_update') continue;   // a selector / Beeper's own update setting, not an entry — never warn
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

  // ── A COMMAND NAMES ITS BEING (operator 2026-10-19: "make the handle of an agent act itself a
  // command … now we can know who executes the command") ──
  // `/<handle> <command> [args]` runs on the node of the being that handle wakes. commandOf reads a
  // line (or an alias's expansion) into that: a being here → the command line without the handle, the
  // being attached (commandBeing = its key, commandHandle = as typed); a handle no being here answers
  // to → commandElsewhere, recorded and prompting nobody, as for a peer being. A bare `/<command>` is
  // no command, except on the console (SHELL_SURFACE: node-local, nobody else hears it). The handle
  // resolves as /agents' argument does (the router's own lookup), local beings only.
  const isRelayAgent = (a) => !!a?.relay_channel || Array.isArray(a?.paths) || String(a?.configuration ?? '').toLowerCase() === 'relay';
  function beingOfHandle(handle) {
    const agents = cfg().agents ?? {};
    const hit = addressed(handle, agents, { addressWithoutAt: true })[0];
    if (hit) return hit.token === handle && !isRelayAgent(hit.agent) ? hit.name : null;
    const personaListed = Object.keys(agents).some((k) => k.toLowerCase() === String(defaultKey).toLowerCase());
    return !personaListed && handle === String(defaultKey).toLowerCase() ? defaultKey : null;   // the persona is real even with no agents: map
  }
  function commandOf(ev) {
    let body = String(ev?.body ?? '').trim();
    let alias = null;
    if (!body.startsWith('/')) {
      const hit = aliasOf(ev, body);
      if (!hit) return null;
      ({ body, alias } = hit);
    }
    const p = parseBeingCommand(body);
    if (!p) return null;
    const tag = alias ? { alias } : {};
    const being = beingOfHandle(p.handle);
    if (!being) return { ...ev, commandElsewhere: p.handle, ...tag };
    return { ...ev, body: p.rest ? `${p.cmd} ${p.rest}` : p.cmd, commandBeing: being, commandHandle: p.handle, ...tag };
  }
  // The handle a reply tells a person to type: the one they typed, else the persona's first.
  const handleOf = (ev) => ev?.commandHandle ?? wakeTokens(defaultKey, cfg().agents?.[defaultKey])[0] ?? defaultKey;
  const hintOf = (cmd, ev = null) => `/${handleOf(ev)} ${cmd}`;

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
  // Anyone else runs only the chat's public commands (publicCommandsOf), never from a node-signed line.
  // The ev is commandOf's: a command names its being (commandBeing), except a registered command on
  // the console.
  async function isCommand(ev) {
    const body = String(ev?.body ?? '').trim();
    if (isOperator(ev) && isRadioQuickReply(ev)) return true;
    if (!body.startsWith('/')) return false;
    const onConsole = surfaceOf(ev) === SHELL_SURFACE && COMMAND_SET.has(body.split(/\s/)[0].toLowerCase());
    if (ev?.commandBeing == null && !onConsole) return false;
    if (isOperator(ev)) return true;
    if (ev?.fromNode != null) return false;
    const word = body.slice(1).split(/[\s=]/)[0].toLowerCase();
    // A public agents is its bare list (agentsPublic); every /agents verb stays the allowed users'.
    return (await publicCommandsOf(ev)).includes(word) && (word !== 'agents' || AGENTS_BARE_CMD.test(body));
  }
  // The chat's own conversations.yaml list, else config.yaml's, else the default; words without '/'.
  async function publicCommandsOf(ev) {
    const own = loadState ? (await loadState()).contacts?.[surfaceOf(ev)]?.[ev.chatId]?.public_commands : undefined;
    const global = cfg().public_commands;
    const list = Array.isArray(own) ? own : Array.isArray(global) ? global : PUBLIC_COMMANDS_DEFAULT;
    return list.map((w) => String(w).trim().replace(/^\//, '').toLowerCase());
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
    const what = ev?.alias ? `alias '${ev.alias}' → /${cmd}` : `/${cmd}`;   // never the arguments
    try { await logToGroup(`${what} in ${chat} by ${who}${outcome ? ` → ${outcome}` : ''}`, { key: ev?.msgHash ?? null }); }
    catch { /* fail-closed: a broken audit never breaks the command */ }
  };
  // THE WRAPPER around the dispatch: run the command, then emit the ONE audit line. A '/'-command the
  // dispatch handled on THIS node is audited (outcome inline when the handler returned one); NO_AUDIT
  // (an ignored public /agents list) and a non-'/'-message (the rs radio quick reply) are not.
  async function run(ev) {
    const outcome = await runDispatch(ev);
    if (outcome === NO_AUDIT) return;
    const m = /^\/(\w+)/.exec(String(ev?.body ?? '').trim());
    if (!m) return;
    await auditCommand(ev, m[1], typeof outcome === 'string' ? outcome : null);
  }

  async function runDispatch(ev) {
    const line = String(ev.body ?? '').trim();

    // rs — THE RADIO QUICK REPLY: the one non-slash message isCommand ever routes here for
    // (see isCommand above) — every other non-slash line never reaches run() at all.
    if (isRadioQuickReply(ev)) { await radioQuickReply(ev); return; }

    const code = lifecycleExit(line, { writeRewindTarget });
    if (code != null) {
      onLog(`${line} -> exit ${code}`);
      await exit(code, { force: lifecycleForce(line) });   // process leaves (after the bridge's "restarting…" announce); the daemon respawns
      return;
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
    //   /agents <handle>|force all [<conv>]                       → status (bare, see agentsStatus)
    //   /agents refresh <handle>|force all [<conv>]               → re-feed identity + directives into the RUNNING thread
    //   /agents rethread <handle>|force all [<conv>]              → clear threadId + roll transcript.md; everything else survives
    //   /agents reset <handle>|force all [<conv>]                 → archive + wipe + reseed
    //   /agents compact <handle>|force all [<conv>]               → handoff + native /compact now, same thread
    //   /agents stop <handle>|force all [<conv>]                  → abort the turn in flight, same thread
    //   /agents mode <mode> <handle>|force all [<conv>]           → was /agents auto <mode> (alias kept), and /e auto <mode>
    //   /agents access_level <level> <handle>|force all [<conv>]  → was /e access all|regular
    //
    // See § COMMAND GRAMMAR at module scope for the shape and why the target trails.
    // `[<conv>]` and `=<slug>` are the same thing said two ways.
    //
    // `=<slug>` is a PRIVATE convention parsed by THIS regex alone, bound directly to the
    // command token (`/e agents=palma refresh e`).
    // Omitted = the CURRENT conversation (ev.surface/ev.chatId), exactly like today's bare
    // /e reset/auto/access. Given = resolved through resolveTarget — the SAME fuzzy/jid
    // resolver /e auto <mode> <target> and /e reset <target> already used, reused verbatim
    // (same error/ambiguity semantics). `<handle>` is a being's agents.<being> map key
    // (`e`, `wren`, …); `force all` applies the subcommand to every being residentsOf() finds on
    // that conversation's entry (bare `all` is refused). See agentsCmd() for the full dispatch.
    const agentsMatch = /^\/agents(?:=(\S+))?(?:\s+(.+?))?\s*$/i.exec(line);
    if (agentsMatch) {
      if (!isOperator(ev) && AGENTS_BARE_CMD.test(line)) return await agentsPublic(ev);
      const handling = AGENTS_BARE_CMD.test(line) ? background?.status() : '';
      if (handling) { await send?.(ev.chatId, `${handling}\n\n${AGENTS_USAGE}`); return; }
      const raw = (agentsMatch[2] ?? '').trim().split(/\s+/).filter(Boolean);
      const { args, slug, retired } = normalizeAgentsArgs(raw);
      // A verb with no target names the being the command was typed to (`/e agents compact`).
      if (args?.[1] && args[0] == null && ev.commandHandle) args[0] = ev.commandHandle;
      // The retired object-first order gets its own line back, rebuilt into the new one —
      // naming the exact replacement, not just the rule.
      if (retired) {
        // A verb that was ALSO renamed (restart -> rethread) or ALIASED (auto -> mode) is rebuilt
        // under its LIVE name, so one reply fixes both mistakes instead of sending the operator
        // round a second refusal for the old word.
        const vraw = retired.verb.toLowerCase();
        const verb = RETIRED_AGENT_SUBS[vraw] ?? canonicalAgentSub(vraw);
        const fixed = AGENT_SUB_ARITY[canonicalAgentSub(vraw)] === 1
          ? `${hintOf('agents', ev)} ${verb} ${retired.rest[0] ?? '<value>'} ${retired.handle}`
          : `${hintOf('agents', ev)} ${verb} ${retired.handle}`;
        await send?.(ev.chatId, `/agents: the verb comes first now — \`${fixed}\``);
        return;
      }
      if (slug && agentsMatch[1]) { await send?.(ev.chatId, `/agents: conversation named twice (=${agentsMatch[1]} and ${slug}) — name it once`); return; }
      return await agentsCmd(ev, agentsMatch[1] || slug || null, args);   // an outcome for the audit line when this node does not host the being
    }

    // /status [<target>] — bare: one compact ops line with live node health (unchanged
    // byte-for-byte). `/status <fragment>`
    // targets a SPECIFIC conversation instead — resolved through the same resolveTarget
    // /agents' `=<slug>` binding uses — and reports that conversation's operator-facing
    // facts (§ statusTarget). Every probe in both forms is wrapped: any failure degrades
    // to '?' so /status NEVER throws.
    const statusMatch = /^\/status(?:\s+(.+))?\s*$/i.exec(line);
    if (statusMatch) {
      const target = statusMatch[1]?.trim() || null;
      await send?.(ev.chatId, target ? await statusTarget(ev, target) : await status(ev));
      return;
    }

    // /chrome — this chat's browser-group Chrome on this node. Must stay BEFORE the catch-all
    // at the end of this dispatch (it answers ANY /token, so a fall-through would silently
    // swallow /chrome) — that ordering IS test-enforced: the /chrome tests assert its real reply.
    const chromeMatch = /^\/chrome\b/i.exec(line);
    if (chromeMatch) { await chrome(ev); return; }

    // /tabs, /open <url>, /tab <n>, /close <n> — Phase 1 browser command wrappers, thin
    // dispatch over cdp.mjs's listTabs/openTab/activateTarget/closeTab (no CDP knowledge
    // lives here). Same slot as /chrome: matched BEFORE the catch-all so none of the four
    // leak to E. /tab and /close address a tab by the 1-based number /tabs prints —
    // resolved fresh against listTabs() on every call, never a stale index carried over
    // from an earlier /tabs (Chrome's own tab order can shift between commands).
    const tabsMatch = /^\/tabs\s*$/i.exec(line);
    if (tabsMatch) { await send?.(ev.chatId, await tabsReport(await chatClientOf(ev))); return; }
    const openMatch = /^\/open\s+(\S+)\s*$/i.exec(line);
    if (openMatch) { await send?.(ev.chatId, await openTabCmd(await chatClientOf(ev), openMatch[1])); return; }
    const tabMatch = /^\/tab\s+(\d+)\s*$/i.exec(line);
    if (tabMatch) { await send?.(ev.chatId, await activateTabCmd(await chatClientOf(ev), Number(tabMatch[1]))); return; }
    const closeMatch = /^\/close\s+(\d+)\s*$/i.exec(line);
    if (closeMatch) { await send?.(ev.chatId, await closeTabCmd(await chatClientOf(ev), Number(closeMatch[1]))); return; }

    // /login <site> — drive Chrome's OWN saved password into <site>'s login form on THIS chat's
    // browser-group profile (src/spine/login.mjs). Same slot as /chrome: matched BEFORE the catch-all so it
    // never leaks to E. isCommand already gated it operator-only. The reply is the OUTCOME token —
    // never a credential (the limb never reads one).
    const loginMatch = /^\/login\s+(\S+)\s*$/i.exec(line);
    if (loginMatch) { await send?.(ev.chatId, await loginCmd(ev, loginMatch[1])); return; }

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
    // internet radio station (config + command only, see radio() below). Pre-catch-all.
    //
    // "say" is matched FIRST, separately, with a payload group that spans lines ([\s\S]*) — the
    // text to read aloud is the one argument in this whole command surface that is genuinely
    // free-form prose (operator ruling 2026-08-08). join/leave/disable fall through to the
    // ORIGINAL single-line grammar below, unchanged — their arguments are always one token.
    const radioSayMatch = /^\/radio\s+say\b[ \t]*([\s\S]*)$/i.exec(line);
    if (radioSayMatch) { await radio(ev, 'say', radioSayMatch[1]?.trim() || null, true); return; }
    const radioMatch = /^\/radio(?:\s+(\S+))?(?:\s+(.+?))?\s*$/i.exec(line);
    if (radioMatch) { await radio(ev, radioMatch[1]?.toLowerCase() || null, radioMatch[2]?.trim() || null, true); return; }

    // /config [<key>[=<value>]] — bare: a redacted dump of the live config. `<key>` alone: a
    // GET. `<key>=<value>`: resolve <key> through config-schema.mjs (dotted path or bare leaf),
    // parse <value> like the extension prototype does, write it, and confirm the RESOLVED path.
    // Pre-catch-all.
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
    const recapMatch = /^\/recap\b/i.exec(line);
    if (recapMatch) {
      const backlog = backlogOf(ev);
      if (backlog.length) await send?.(ev.chatId, recapText(backlog, timeZone));
      return;
    }

    // /activate <id> — reopen a brain member whose Chrome tab was closed (its saved
    // targetId is no longer live), refreshing its targetId. A no-op when already live.
    const activateMatch = /^\/activate\s+(\S+)\s*$/i.exec(line);
    if (activateMatch) { await activate(ev, activateMatch[1]); return; }

    // /bans — list the media-flood auto-bans currently active (src/flood-ban.mjs). /unban [name]
    // — clear the active ban(s) in THIS chat (optional name = a banned sender's display name or
    // id); the bans are in-memory, so this is a live clear, not a config write. Pre-catch-all,
    // the same slot as /recap/activate; written as `<name>Match = /^\/word` for the help drift guard.
    const bansMatch = /^\/bans\b/i.exec(line);
    if (bansMatch) { await send?.(ev.chatId, bansReport()); return; }
    const unbanMatch = /^\/unban\b[ \t]*(.*)$/i.exec(line);
    if (unbanMatch) { await send?.(ev.chatId, unbanHere(ev, unbanMatch[1]?.trim() || null)); return; }

    // /update beeper — install the Beeper update this node downloaded (a controlled Beeper restart;
    // the spine stays up), or the one-line Beeper state when there is nothing to do. Not /upgrade.
    const updateMatch = /^\/update\b[ \t]*(.*)$/i.exec(line);
    if (updateMatch) {
      const target = updateMatch[1].trim().toLowerCase();
      const usage = `usage: ${hintOf('update beeper', ev)} — install the Beeper update this node downloaded (eGPT itself: ${hintOf('upgrade', ev)})`;
      await send?.(ev.chatId, target !== 'beeper' ? usage : beeperUpdate ? await beeperUpdate.update() : 'Beeper updates are not wired on this node');
      return;
    }

    // /join — type /<handle> join [<name>] to spin a private side-group that is a VIEW (alias) of this
    // chat's conversation (one shared thread, two chats); /split — /<handle> split [<name>] spins a
    // side-group backed by a NEW, DIVERGING conversation (its beings' threads are copied); /send —
    // reply /send to a message in either group to relay it back to the original chat; /end — reply
    // /end in either group to archive it and drop its mapping (operator 2026-10-03). They sit
    // pre-catch-all like the rest. Public by default (PUBLIC_COMMANDS_DEFAULT); /join and
    // /split refuse a member outside a group, /send and /end act only in a side group (operator
    // 2026-10-18); /send and /end stand down silently where this node holds no alias or parent.
    // Written as `<name>Match = /^\/word…` so the /help drift guard (tests/spine-commands.test.mjs) sees them.
    const joinMatch = /^\/join\b[\s\S]*$/i.exec(line);
    if (joinMatch) { return await joinGroup(ev); }   // returns an outcome for the audit on its member paths
    const splitMatch = /^\/split\b[\s\S]*$/i.exec(line);
    if (splitMatch) { await splitGroup(ev); return; }
    const sendMatch = /^\/send\b[\s\S]*$/i.exec(line);
    if (sendMatch) { await sendToOriginal(ev); return; }
    const endMatch = /^\/end\b[\s\S]*$/i.exec(line);
    if (endMatch) { return await end(ev); }   // end() returns its outcome string (archived / no-op) for the audit line

    // A registered command no branch above dispatches.
    const tok = line.split(/\s+/)[0];
    await send?.(ev.chatId, `${tok}: recognized, not wired yet — ${hintOf('help', ev)} lists what is.`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // /chrome — the chat's browser-group Chrome: launched over the pipe when it is not up,
  // then its tabs. The Session 1 daemon spawns and holds every Chrome (src/chrome-host.mjs), and a child
  // inherits its parent's session (measured 2026-07-15: spine SessionId 0, explorer.exe SessionId 1),
  // so the window lands on the operator's desktop; a spine with no such daemon has no browser.
  // The node is the handle's (`/e chrome`); nothing else names it.
  async function chrome(ev) {
    await send?.(ev.chatId, await chromeReport(await browserConversationOf(surfaceOf(ev), ev.chatId)));
  }

  // ── GROUP CHROME POOL (plans/2610091931 rev 2026-10-11) ──────────────────────────────────────
  // One pipe-driven chrome.exe per browser-group profile dir, brain included; no Chrome listens on
  // a port. brain and shared serve many chats: never evicted, and brain is never memory-gated.
  // The daemon holds each Chrome (chromeHost); every decision is here, and ships with /upgrade.
  const _groups = new Map();     // profileDir → { group, channel, client, pid, lastUsedAt, busy }
  const _ensuring = new Map();   // profileDir → in-flight launch (per-profile single-flight)
  const chromeAlive = (e) => !!e && !e.channel.closed;
  const evictable = (e) => !e.busy && chromeAlive(e) && e.group !== BRAIN_GROUP && e.group !== SHARED_GROUP;
  const launchEstimateBytes = () => (Number(cfg()?.chrome?.launch_estimate_mb) || CHROME_LAUNCH_ESTIMATE_MB) * MB;
  const memoryMarginBytes = () => (Number(cfg()?.chrome?.memory_margin_mb) || CHROME_MEMORY_MARGIN_MB) * MB;

  // Evict the idlest evictable Chrome (lowest lastUsedAt); profile dir persists → relaunch comes up
  // still-logged-in.
  function evictIdlest() {
    let victim = null;
    for (const [dir, e] of _groups) {
      if (!evictable(e)) continue;
      if (!victim || e.lastUsedAt < victim.e.lastUsedAt) victim = { dir, e };
    }
    if (!victim) return false;
    try { chromeHost.kill(victim.e.group); } catch {}
    _groups.delete(victim.dir);
    onChromeLog(`evicted group Chrome ${victim.dir} (pid ${victim.e.pid ?? '?'}) under memory pressure`);
    return true;
  }

  const track = (group, profileDir, { pid, channel }) => {
    const e = { group, channel, client: createCdpClient(createChannelTransport(channel)), pid, lastUsedAt: now(), busy: false };
    _groups.set(profileDir, e);
    return e;
  };
  // A restarted spine joins the Chromes the daemon still holds, before any launch — never over one.
  const _reattached = (async () => {
    if (!chromeHost) return;
    chromeHost.onExit(({ group, pid, code, signal }) => {
      for (const [dir, e] of _groups) if (e.pid === pid) _groups.delete(dir);
      onChromeLog(`"${group}" Chrome (pid ${pid}) exited (${signal ? `signal ${signal}` : `code ${code}`}) — nothing restarted; it relaunches on next need`);
    });
    try {
      for (const g of await chromeHost.list()) {
        track(g.group, g.profileDir, g);
        onChromeLog(`re-attached "${g.group}" Chrome ${g.profileDir} (pid ${g.pid}), held by the daemon`);
      }
    } catch (e) { onChromeLog(`could not list the daemon's Chromes — ${e?.message ?? e}`); }
  })();
  const NO_CHROME_HOST = 'this spine has no daemon chrome-host (run by hand, or not the Session 1 daemon) — it launches no browser';

  // THE ONE LAUNCH PATH — /chrome, a being's `browser start` / `browser cdp`, /tabs…, /members,
  // /login, the relay, a browser beat. No conversation → brain. Registry keyed by profile dir; a live
  // profile is never relaunched; single-flight per profile. `launch: false` only reports a live one.
  // FAIL CLOSED: a refused chat, a non-brain group on the brain's dir, or a profile another Chrome
  // already holds → no browser + one log line. Never throws.
  // Resolves { group, profileDir, client, pid, launched, running, declined?, why? }.
  function ensureChrome(conversation, opts) { return _reattached.then(() => ensureGroupChrome(conversation, opts)); }
  function ensureGroupChrome(conversation, { launch = true } = {}) {
    conversation ??= { key: '', name: '', group: BRAIN_GROUP };
    const { group } = conversation;
    const profileDir = chromeProfileOf(cfg(), conversation);
    if (!profileDir || (group !== BRAIN_GROUP && profileDir === chromeProfileOf(cfg()))) {
      const why = conversation.why || `browser group "${group}" ${profileDir ? 'is the brain profile dir' : 'is unusable'}`;
      onChromeLog(`no browser for "${conversation.name ?? ''}": ${why}`);
      return Promise.resolve({ group, profileDir: null, client: null, launched: false, running: false, why });
    }
    const live = _groups.get(profileDir);
    if (chromeAlive(live)) { live.lastUsedAt = now(); return Promise.resolve({ group, profileDir, client: live.client, pid: live.pid, launched: false, running: true }); }
    if (!launch) return Promise.resolve({ group, profileDir, client: null, launched: false, running: false, why: `the "${group}" browser is not running` });
    if (_ensuring.has(profileDir)) return _ensuring.get(profileDir);
    const p = (async () => {
      if (!chromeHost) {
        onChromeLog(`no browser for "${conversation.name ?? ''}": ${NO_CHROME_HOST}`);
        return { group, profileDir, client: null, launched: false, running: false, why: NO_CHROME_HOST };
      }
      const holder = profileHolder(profileDir);
      if (holder) {
        onChromeLog(`not launching "${group}" Chrome ${profileDir}: another Chrome holds it (${holder})`);
        return { group, profileDir, client: null, launched: false, running: false, why: `the "${group}" browser is open in a normal window; close it to hand it back to the spine` };
      }
      if (group !== BRAIN_GROUP) {
        const estimateBytes = estimateChromeBytes({
          runningRssBytes: [..._groups.values()].filter(chromeAlive).map((e) => rssOf(e.pid)),
          floorBytes: launchEstimateBytes(),
        });
        const marginBytes = memoryMarginBytes();
        for (;;) {
          const d = admitLaunch({ availableBytes: freeMem(), estimateBytes, marginBytes, canEvict: [..._groups.values()].some(evictable) });
          if (d.action === 'launch') break;
          if (d.action === 'evict' && evictIdlest()) continue;
          onChromeLog(`declined group Chrome ${profileDir}: ${d.reason}`);
          return { group, profileDir, client: null, launched: false, running: false, declined: true, why: d.reason };
        }
      }
      stampGroupProfile({ userDataDir: profileDir, group, colors: await browserColors(), log: onChromeLog });   // no Chrome holds it (above)
      let spawned;
      try {
        spawned = await chromeHost.launch({ group, profileDir, bin: chromeBinOf(cfg()), argv: chromePipeArgs({ userDataDir: profileDir, windowName: group }) });
      } catch (e) {
        onChromeLog(`group Chrome ${profileDir} launch failed — ${e?.message ?? e}`);
        return { group, profileDir, client: null, launched: false, running: false, why: String(e?.message ?? e) };
      }
      const { client } = track(group, profileDir, spawned);
      onChromeLog(`launched "${group}" Chrome ${profileDir} (pid ${spawned.pid ?? '?'}) over --remote-debugging-pipe, held by the daemon`);
      return { group, profileDir, client, pid: spawned.pid, launched: true, running: true };
    })().finally(() => { _ensuring.delete(profileDir); });
    _ensuring.set(profileDir, p);
    return p;
  }

  // THE BROWSER-GROUP RESOLVER (every spine-side browser caller): chat → registry row (none → fixed slug; a room's
  // id IS its slug) → chromeConversationOf over browsers.yaml, fresh; an unlisted /split → its parent_chat's group.
  // No registry → null (brain); failed read → group null.
  async function browserConversationOf(surface, chatId) {
    if (!loadState) return null;
    try {
      const state = await loadState();
      const entry = getContact(state, surface, chatId)?.entry ?? { slug: fixedSlugFor(surface, chatId) };
      return chromeConversationOf(entry, await browserGroups(), (e) => getContact(state, surface, e.parent_chat)?.entry);
    } catch (e) { return { key: '', name: '', group: null, why: `browser group lookup failed — ${e?.message ?? e}` }; }
  }

  // A chat's group + the client that drives it — /tabs…, /members, /activate, /status, /login, the room relay.
  async function chatChromeOf(surface, chatId, opts) {
    const conversation = await browserConversationOf(surface, chatId);
    const { client, why } = await ensureChrome(conversation, opts);
    return { conversation, client, why };
  }
  const chatClientOf = async (ev, opts) => (await chatChromeOf(surfaceOf(ev), ev.chatId, opts)).client;

  // A BOXED BEING'S `browser start` (src/spine/being-link.mjs): the launch path above and nothing
  // else — no arguments reach it from the being, and it lists no tabs (that is the operator's
  // report). Idempotent: a running Chrome is reported, not relaunched.
  async function startBrowser(conversation) {
    const r = await ensureChrome(conversation);
    if (!r.client) return { ok: false, reason: r.declined ? 'declined' : 'no-browser', detail: r.why };
    return { ok: true, ...(r.launched ? { launched: true } : { alreadyRunning: true }), detail: `the "${r.group}" browser is ${r.launched ? 'up' : 'already running'}${r.pid ? ` (pid ${r.pid})` : ''}` };
  }

  // The /chrome report body: the group's Chrome (launched when needed) and its tabs. Never throws.
  async function chromeReport(conversation) {
    const r = await ensureChrome(conversation);
    if (!r.client) return `no browser for this chat — ${r.why}`;
    const host = `the "${r.group}" browser (pipe)`;
    let tabs = null;
    try { tabs = await r.client.listTabs(); } catch { tabs = null; }
    if (!tabs) return `${host}: its tab list failed`;

    const lines = [`attached: ${host}`];
    if (r.launched && r.pid) lines.push(`launched: pid ${r.pid}`);
    lines.push(`tabs: ${tabs.length}`);
    // A few tabs only, each truncated — this lands in a chat, not a terminal.
    for (const t of tabs.slice(0, CHROME_TAB_LIMIT)) {
      lines.push(`  · ${trunc(t?.title ?? '(untitled)', 48)}`);
      lines.push(`    ${trunc(t?.url ?? '', 72)}`);
    }
    if (tabs.length > CHROME_TAB_LIMIT) lines.push(`  … +${tabs.length - CHROME_TAB_LIMIT} more`);
    return '```yaml\n' + lines.join('\n') + '\n```';
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // /tabs — same fenced-yaml shape as /chrome's tab list, but WITH the 1-based index
  // /tab and /close address. A listTabs() failure (no Chrome reachable) degrades to a
  // one-line note, same "never throw" ethos as chromeReport.
  async function tabsReport(c) {
    let tabs;
    try { tabs = await c.listTabs(); } catch { return 'no Chrome to list tabs from — try /<handle> chrome first'; }
    const lines = [`tabs: ${tabs.length}`];
    tabs.forEach((t, i) => {
      lines.push(`  ${i + 1} · ${trunc(t?.title ?? '(untitled)', 48)}`);
      lines.push(`      ${trunc(t?.url ?? '', 72)}`);
    });
    return '```yaml\n' + lines.join('\n') + '\n```';
  }

  // /open <url> — open a new tab at url. The tab hasn't loaded yet the instant it opens
  // (nothing to title it by), so the reply names it by the url just opened.
  async function openTabCmd(c, url) {
    if (!c) return '/open: no browser for this chat';
    try { await c.openTab(url); return `opened: ${url}`; }
    catch (e) { return `/open: failed — ${e?.message ?? e}`; }
  }

  // Resolve the operator's 1-based /tab or /close index against a FRESH listTabs() call
  // (see the dispatch comment above for why: never a stale index). Returns { tab } or
  // { error } — callers never throw on a bad index.
  async function nthTab(c, n) {
    let tabs;
    try { tabs = await c.listTabs(); } catch { return { error: 'no Chrome to list tabs from — try /<handle> chrome first' }; }
    const tab = tabs[n - 1];
    if (!tab) return { error: `no tab ${n} — ${tabs.length} open` };
    return { tab };
  }

  // /tab <n> — activate (focus) the nth listed tab.
  async function activateTabCmd(c, n) {
    const { tab, error } = await nthTab(c, n);
    if (error) return `/tab: ${error}`;
    try { await c.activateTarget(tab.id); return `activated ${n} · ${trunc(tab?.title ?? '(untitled)', 48)}`; }
    catch (e) { return `/tab: failed — ${e?.message ?? e}`; }
  }

  // /close <n> — close the nth listed tab.
  async function closeTabCmd(c, n) {
    const { tab, error } = await nthTab(c, n);
    if (error) return `/close: ${error}`;
    try { await c.closeTab(tab.id); return `closed ${n} · ${trunc(tab?.title ?? '(untitled)', 48)}`; }
    catch (e) { return `/close: failed — ${e?.message ?? e}`; }
  }

  // /login <site> — ask the auto-login limb to sign in using Chrome's own saved password. The
  // whole reply is the limb's outcome token; the limb owns the flow (detect → autofill → trusted
  // click → classify, with the 2FA / CAPTCHA branches) and the secret boundary. Absent seam → say so.
  async function loginCmd(ev, site) {
    if (typeof requestLogin !== 'function') return `/login: the auto-login limb isn't wired on this node`;
    const { conversation, client, why } = await chatChromeOf(surfaceOf(ev), ev.chatId);
    if (!client) return `/login: no browser for this chat${why ? ` — ${why}` : ''}`;
    try { return `/login ${site} → ${await requestLogin(site, { conversation, client })}`; }
    catch (e) { return `/login: failed — ${e?.message ?? e}`; }
  }

  const ROOM_USAGE = 'usage: /<handle> rooms | /<handle> rooms create <name> | /<handle> rooms join|leave|members <room> | /<handle> rooms delete [force] <room>';
  // remove/mode take `<id|name>` for the same reason add group does (operator 2026-08-31):
  // all three now run the SAME argument through the SAME resolver, so the usage line stops
  // implying that only one of them knows what a chat name is.
  const MEMBERS_USAGE = 'usage: /<handle> members | /<handle> members add tab <n> [alias=<name>|<name>] | /<handle> members add group <chat name|id> | /<handle> members remove <id|name> | /<handle> members mode <disable|mention|all> <id|name>';
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
  // or re-resolve. `named` is the reply's word for the being(s): the keys for `force all`, and for a
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
      await send?.(ev.chatId, `/agents: "${subRaw}" is not a verb here any more — did you mean \`${hintOf('agents', ev)} ${RETIRED_AGENT_SUBS[sub]} ${handleArg}\`? (${hintOf('restart', ev)} is the NODE's lifecycle; ${RETIRED_AGENT_SUBS[sub]} gives this conversation a new thread). Nothing was changed.`);
      return;
    }
    if (sub && !LIVE_AGENT_SUBS.includes(sub)) {
      await send?.(ev.chatId, `/agents: unknown subcommand "${subRaw}" — ${LIVE_AGENT_SUBS.join('|')} (mode <${AUTO_MODES.join('|')}>, access_level <${ACCESS_LEVELS.join('|')}>). Verb first: ${hintOf('agents', ev)} <sub> <handle>.`);
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
      await send?.(ev.chatId, `usage: ${hintOf('agents', ev)} access_level ${ACCESS_LEVELS.join('|')} [<handle>|force all]`);
      return;
    }
    // `all` is REFUSED (operator 2026-10-11).
    if (handleArg.toLowerCase() === 'all') {
      const forced = [hintOf('agents', ev), subRaw, valueRaw, FORCE_ALL, slugArg].filter(Boolean).join(' ');
      await send?.(ev.chatId, `/agents: \`all\` changes every being at once — say \`${forced}\` to mean it. Nothing was changed.`);
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
    // Anything else is not a being here: SILENT on this node (logged), returned before a single
    // write or transcript roll. `named` is what the REPLY calls the being — as
    // typed, plus the key when they differ, because "✅ e rethread" while the record says `egpt`
    // is how this went unnoticed.
    let handles, named;
    if (handleArg === FORCE_ALL) {
      // `force all` = every being residentsOf() finds on that conversation's entry — the exact
      // registry-block owner /rooms's members roster is silent on (residentsOf reads
      // entry.agents.<being> blocks, conversations-state.mjs). Ordered defaultKey-first (when
      // resident) so the persona is always the first block/reply in a multi-being result; the
      // rest keep residentsOf()'s own order. These are KEYS already — nothing to resolve.
      // Each node reads its OWN state, so it changes and reports only its own residents.
      const entry = getContact(state, surface, jid)?.entry;
      handles = residentsOf(entry);
      if (handles.includes(defaultKey)) handles = [defaultKey, ...handles.filter((h) => h !== defaultKey)];
      if (!handles.length) { onLog(`/agents: force all — no resident beings ${where} on this node`); return; }
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
        // NOT MINE, SO NOT MY ANSWER (operator 2026-10-11: "if agent doesn't reside on a node, it
        // says nothing"): the host node answers; a name no node hosts gets no chat reply at all.
        // Each other node says so on the logging group, as its audit outcome (operator 2026-10-17).
        onLog(`/agents: no being on this node answers to "${handleArg}" — silent (addressable here: ${[...new Set(addressableTokens(agentsMap))].join(', ')})`);
        return `no ${handleArg} in node ${cfg()?.node_name ?? '?'}`;
      }
      handles = [key];
      named = typed === String(key).toLowerCase() ? key : `${handleArg} (${key})`;
    }

    if (sub === 'refresh') { await agentsRefresh(ev, surface, jid, where, handles, state, named); return; }
    if (sub === 'reset') { await agentsReset(ev, surface, jid, where, handles, state, named); return; }
    if (sub === 'rethread') { await agentsRethread(ev, surface, jid, where, handles, state, named); return; }
    if (sub === 'compact') { await agentsCompact(ev, surface, jid, where, handles, state, named); return; }
    if (sub === 'stop') { await agentsStop(ev, surface, jid, where, handles, named); return; }
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

  // /agents compact <handle>|force all (operator 2026-10-15) — the compaction service's own
  // sequence (handoff, warn notice, native /compact, identity re-feed + welcome) NOW, at the
  // being's scope, same thread. It can wait minutes behind a live turn, and a command holds the
  // inbound pump while it runs, so this answers at once and reports again when it is done.
  async function agentsCompact(ev, surface, jid, where, handles, state, named = handles.join(', ')) {
    const scopes = [], parts = [], started = [];
    for (const h of handles) {
      const sc = await scopeAt(h, ev, surface, jid);
      scopes.push(sc);
      const sessionId = getBeing(state, sc.surface, sc.chatId, h)?.threadId ?? null;
      let r = null;
      if (sessionId) {
        try { r = await compactBeing(h, { ...ev, surface: sc.surface, chatId: sc.chatId }, { sessionId }); }
        catch (e) { r = { ok: false, reason: e?.message ?? String(e) }; }
      }
      const said = !sessionId ? 'no thread, nothing to compact'
        : !r?.ok ? `nothing to compact — ${r?.reason ?? 'no answer'}`
        : `${r.inFlight ? 'queued behind the turn in flight' : 'started'}: handoff, then /compact (same thread)`;
      parts.push(handles.length > 1 ? `${h}: ${said}` : said);
      if (r?.ok) started.push([handles.length > 1 ? h : named, r.done]);
    }
    where = whereWrote(scopes, where);
    await send?.(ev.chatId, `${started.length ? '🗜️ ' : ''}${named} compact ${where} — ${parts.join('; ')}.`);
    for (const [who, done] of started) {
      Promise.resolve(done)
        .then((r) => send?.(ev.chatId, compactedLine(who, where, r)), (e) => send?.(ev.chatId, `⚠️ ${who} compact ${where} failed: ${e?.message ?? e}`))
        .catch((e) => onLog(`/agents compact ${ev.chatId}: ${e?.message ?? e}`));
    }
  }
  const kTok = (n) => `${Math.round(n / 1000)}k`;
  function compactedLine(who, where, r) {
    if (!r?.compacted) return `⚠️ ${who} compact ${where} failed: ${r?.reason ?? 'nothing was compacted'}`;
    const size = Number.isFinite(r.tokens) && r.window > 0
      ? `was ${kTok(r.tokens)} tokens (${Math.round((r.tokens / r.window) * 100)}% of ${kTok(r.window)})` : 'done';
    const handoff = r.handoff === true ? '; handoff written first' : r.handoff === false ? '; ⚠️ the handoff turn FAILED (compacted anyway)' : '';
    return `✅ ${who} compacted ${where} — ${size}${handoff}; same thread, identity re-feeds on its next turn.`;
  }

  // /agents stop <handle>|force all (operator 2026-10-15) — abort the being's turn in flight: the
  // CLI's own interrupt, else its process is ended. Thread, record and transcript untouched; the
  // conversation's queued messages run next.
  async function agentsStop(ev, surface, jid, where, handles, named = handles.join(', ')) {
    const scopes = [], parts = [];
    let any = false;
    for (const h of handles) {
      const sc = await scopeAt(h, ev, surface, jid);
      scopes.push(sc);
      let r;
      try { r = await stopBeing(h, { ...ev, surface: sc.surface, chatId: sc.chatId }); }
      catch (e) { r = { stopped: false, reason: e?.message ?? String(e) }; }
      if (r?.stopped) any = true;
      const said = r?.stopped === 'interrupt' ? 'interrupted the turn in flight'
        : r?.stopped === 'evict' ? 'ended its process mid-turn (no interrupt took)'
        : `nothing in flight${r?.reason ? ` (${r.reason})` : ''}`;
      parts.push(handles.length > 1 ? `${h}: ${said}` : said);
    }
    const tail = any ? ' — same thread, transcript untouched; queued messages run next' : '';
    await send?.(ev.chatId, `${any ? '⏹️ ' : ''}${named} stop ${whereWrote(scopes, where)} — ${parts.join('; ')}${tail}.`);
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
      // An ALIAS room (/join, the automatic group) keeps its mode on its OWN entry: patchBeing resolves through
      // aliasOf and would write the origin (operator 2026-10-11). getBeing reads it back.
      for (const h of handles) {
        const { aliasOf, ...room } = next.contacts?.[surface]?.[jid] ?? {};
        next = aliasOf
          ? aliasContact(next, surface, jid, aliasOf, { ...room, agents: { ...room.agents, [h]: { ...room.agents?.[h], mode } } })
          : patchBeing(next, surface, jid, h, { mode });
      }
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
      // Live context size: the probe /status reads (compact-being's dueForCompaction), same window.
      let contextVal = 'no thread';
      if (b?.threadId) {
        try {
          const p = compactionPolicy(cfg(), modelVal, compactionOverrideOf(b, cfg(), handle));
          const { tokens } = dueFor({ sessionId: b.threadId, model: modelVal, window: p.window }, { ratio: p.ratio });
          contextVal = Number.isFinite(tokens) ? `${tokens} tok (${Math.round((tokens / p.window) * 100)}% of ${p.window})` : 'no session file';
        } catch { contextVal = '?'; }
      }

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
        `context: ${contextVal}`,
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
    if (!name || !/[a-z0-9]/i.test(name)) { await send?.(ev.chatId, 'usage: /<handle> rooms create <name>'); return; }
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
        await send?.(ev.chatId, `room ${slug} has content — ${contents.join(', ')} — ${hintOf('rooms', ev)} ${slug} delete force to remove anyway`);
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
    try { liveIds = new Set((await (await chatClientOf(ev, { launch: false })).listTabs()).map((t) => t.id)); } catch { /* no Chrome → all brains inactive */ }
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
    try { tabs = await (await chatClientOf(ev)).listTabs(); } catch { await send?.(ev.chatId, `no Chrome to list tabs from — try ${hintOf('chrome', ev)} first`); return; }
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
        await send?.(ev.chatId, `can't add tab ${n} as '${alias}' — tab is already member '${same.id}' (mode:${modeWord}); ${hintOf('members', ev)} remove ${same.id} first if you want to replace it`);
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
  // an unaddressed call (the rs quick reply) replies ONLY if THIS node can act on it; a node
  // with no configured/enabled radio, or that the command doesn't match, says NOTHING. A
  // command (`/<handle> radio …`, or the console's) is addressed to this node (`explicit`), so
  // it always replies, success or refusal. The ONE exception, for every verb: "can't resolve
  // this conversation's room" always replies — that's a broken invocation, not a mismatch.
  //
  // Verb-first (the /rooms 2026-08-07 lesson): an unrecognized verb NEVER touches a room,
  // it just gets the usage line.
  const RADIO_USAGE = 'usage: /<handle> radio | /<handle> radio join [<radio>] | /<handle> radio leave [all|<slug>] | /<handle> radio say <text> | /<handle> radio disable [<radio>|<node>|<person>]';

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
  // createRadioNoteRelay reads through boot's getConfig (until the spine swaps in the re-read
  // file, which carries the same write), so mutating radios[name].enabled here is visible to the very
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

  async function radio(ev, first, rest, explicit) {
    if (first && first !== 'join' && first !== 'leave' && first !== 'say' && first !== 'disable') { await send?.(ev.chatId, RADIO_USAGE); return; }
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
    if (!joinedRadio) { if (explicit) await send?.(ev.chatId, `not relaying — ${hintOf('radio', ev)} join <radio> first`); return; }
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
    if (result == null) return;   // gate refused — silent, per the send-guard ruling
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
  // uploaded through the SAME gate) — never a second uploader. rs names no node, so
  // `radio()`'s `explicit` is false: rs behaves like
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
    await radio(ev, 'say', cleaned, false);
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
  // WHICH NODE: the handle's (commandOf) — `/e join` runs on E's node, and only there; that node creates
  // the group on its own primary account. A being must still RESIDE here (residesHere), which is also
  // the "is there a thread to carry/copy" check. /send+/end act only where this node holds the group (an
  // alias or a parent); both nodes do once the other links it (linkSideGroup).
  const residesHere = (state, surface, chatId) => {
    const agents = getContact(state, surface, chatId)?.entry?.agents ?? {};
    return Object.values(agents).some((b) => b && typeof b === 'object' && b.threadId != null);
  };

  // `/join`/`/split`'s <name> (the rest of the line, it fills {name} in the group title); none → a
  // random one (randomName).
  const forkNameOf = (body) => /^\/(?:join|split)\b[ \t]*(.*)$/i.exec(String(body ?? '').trim())?.[1].trim() || randomName();

  // config.join.placeholder / config.split.placeholder, with the built-in fallback so a command never
  // edits to an empty string.
  const placeholderOf = (block, dflt) => (block && typeof block.placeholder === 'string' && block.placeholder.trim()) ? block.placeholder : dflt;
  // SIDE_GROUP_PREFIX + config.group_title ({group}=parent chat name, {name}=the <name> arg).
  const groupTitleTpl = () => ((typeof cfg().group_title === 'string' && cfg().group_title.trim()) ? cfg().group_title : GROUP_TITLE_DEFAULT);
  // The prefix once: a title already starting with it (any case, e.g. a /join inside "SI+EduWeb") keeps its own.
  const sidePrefixed = (title) => (String(title).toLowerCase().startsWith(SIDE_GROUP_PREFIX.toLowerCase()) ? String(title) : SIDE_GROUP_PREFIX + title);
  const groupTitleOf = (groupName, name) =>
    sidePrefixed(fill(groupTitleTpl(), { group: groupName, name }));
  // A discreet side group from the retired phrase triggers, made before the `discreet` flag: its title's
  // {name} slot holds a random 5-hex token (plus the " HHMM-MMDDYYYY" suffix older titles carry). A typed 5-hex name also matches; that only drops the prefix.
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const titleLooksDiscreet = (title) => {
    const tpl = groupTitleTpl();
    if (!title || !tpl.includes('{name}')) return false;
    const body = tpl.split('{name}').map((p) => p.split('{group}').map(esc).join('.*')).join('[0-9a-f]{5}');
    return new RegExp(`^(?:${esc(SIDE_GROUP_PREFIX)})?${body}( \\d{4}-\\d{8})?$`).test(String(title));
  };
  // config.join.opener / config.split.opener ({group}=parent chat title, {handle}=the being's), with the
  // built-in fallback — the message posted into the new side-group so it surfaces in Beeper (postOpener).
  const openerOf = (block, dflt, groupName, ev = null) =>
    fill((block && typeof block.opener === 'string' && block.opener.trim()) ? block.opener : dflt, { group: groupName, handle: handleOf(ev) });
  // A nameless /join or /split's {name} (operator 2026-10-19): 5 random lowercase letters/digits. Never
  // all hex: that is a retired discreet group's shape (titleLooksDiscreet).
  const randomName = () => {
    let s;
    do s = Array.from({ length: 5 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[randomInt(36)]).join('');
    while (/^[0-9a-f]{5}$/.test(s));
    return s;
  };
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

  // RODZ'S COPY of a side group's opener — already arrived, or within OPENER_COPY_MS — in Rodz's OWN room
  // for the group, named by the canary; null with no mouth. The creator (postOpener) and the other node
  // (linkSideGroup) both take the group's mouth_chat from it.
  const mouthCopyOf = (group) => (hasMouth() ? forkBridge.awaitMouthMessage?.((m) => decodeChatCanary(m?.text)?.group === group, OPENER_COPY_MS) ?? null : null);
  // POST THE OPENER from the PRIMARY (the creator) into the new group so it SURFACES in Beeper (Beeper
  // hides a chat with no messages). Its canary names the group, its origin, its kind and (join/automatic)
  // the transcript key: all the other node needs to hold the same group (linkSideGroup). Rodz's copy of
  // it gives the group's mouth_chat — by id, never by title (operator 2026-10-18).
  // A failed opener never fails the command, but it is never called posted: only a confirmed id is.
  // Refused → logged + reported once; unconfirmed → the same, and Rodz's copy is still awaited.
  const postOpener = async ({ verb, newChatId, openerText, origin, kind, transcript = null }) => {
    try {
      const copy = mouthCopyOf(newChatId);
      const sent = await forkBridge.postReply(newChatId, openerText, null, { via: 'primary', canary: { group: newChatId, origin, kind, transcript } });
      const id = sent ? await sent.confirmedId : null;
      if (id) onLog(`${verb}: opener posted by the primary into ${newChatId} (#${id})`);
      else {
        const why = sent ? 'the send went out but its id was never confirmed' : null;
        onLog(sent ? `${verb}: opener sent into ${newChatId} but its id was never confirmed — not counted as posted` : `${verb}: opener NOT posted into ${newChatId} — the send was refused`);
        await reportUndelivered({ what: 'opener', chatId: newChatId, why });
        if (!sent) return;
      }
      if (!copy) return;
      const room = (await copy)?.chatID ?? null;
      if (!room) { onLog(`${verb}: Rodz's copy of the opener did not arrive within ${OPENER_COPY_MS}ms — replies in ${newChatId} come from the primary until the mouth finds its room`); return; }
      await mutateState(writeState, async () => {
        const s = await loadState();
        const next = setAliasMouthChat(s, newChatId, room);
        if (next !== s) await writeState(next);
      });
      onLog(`${verb}: ${newChatId} is ${room} on Rodz's account (its copy of the opener) — stored as the mouth room`);
    } catch (e) {
      onLog(`${verb}: opener post failed — ${e?.message ?? e} (the group already succeeded; moving on)`);
    }
  };

  // WHO MAKES A SIDE GROUP AND WHOM IT INVITES (operator 2026-10-18 ~21:00): the PRIMARY, which has
  // every contact, makes all of them. /join and /split invite Rodz + the requester (the operator's own
  // request: Rodz alone); the automatic group (`everyone`) Rodz + every member of the chat. No mouth →
  // the members alone. → { accountID, participantIDs } or null (logged).
  const hasMouth = () => !!phoneDigitsOf(cfg().beeper?.secondary?.phone);
  const invitableOf = (ev) => (String(ev?.senderId ?? '').endsWith(':beeper.local') ? ev.senderId : null);
  async function sideGroupPlan(ev, verb, { everyone = false } = {}) {
    const rodz = hasMouth() ? await resolveRodz(ev.chatId, verb) : null;
    if (hasMouth() && !rodz) return null;
    const accountID = rodz?.accountID ?? await forkBridge.chatAccountId(ev.chatId);
    if (!accountID) { onLog(`${verb}: could not resolve the account of ${ev.chatId} — nothing created.`); return null; }
    const members = everyone ? await membersOf(ev.chatId, verb) : [ev.isSender ? null : invitableOf(ev)];
    if (!members) return null;
    const participantIDs = [...new Set([rodz?.rodzUserId, ...members].filter(Boolean))];
    if (!participantIDs.length) { onLog(`${verb}: nobody to invite — nothing created.`); return null; }
    return { accountID, participantIDs };
  }
  // The chat's members as the primary sees them, minus our own accounts (self, any config.beeper phone).
  // null (logged) when the roster cannot be read.
  async function membersOf(chatId, verb) {
    const items = (await forkBridge.chatRaw?.(chatId))?.participants?.items;
    if (!Array.isArray(items)) { onLog(`${verb}: could not read the members of ${chatId} — nothing created.`); return null; }
    const ours = new Set(Object.values(cfg().beeper ?? {}).map((a) => phoneDigitsOf(a?.phone)).filter(Boolean));
    return items.filter((p) => !p?.isSelf && !ours.has(phoneDigitsOf(p?.phoneNumber))).map((p) => invitableOf({ senderId: p?.id })).filter(Boolean);
  }
  // createGroup on the primary → the SHORT chat id, or null (logged).
  async function createSideGroup(plan, title, verb) {
    const created = await forkBridge.createGroup({ accountID: plan.accountID, participantIDs: plan.participantIDs, type: 'group', title }, { via: 'primary' });
    const raw = created?.chatID ?? created?.chatId ?? null;
    if (!raw) onLog(`${verb}: createGroup returned no chatID (${JSON.stringify(created)}) — aborted, nothing edited/posted`);
    return raw ? shortChatId(raw) : null;
  }

  // THE create+alias CORE shared by /join and the automatic group (operator 2026-10-08) — §5.1: ONE
  // create-group + ONE alias-registration path, not two. Create the side-group (sideGroupPlan),
  // normalize createGroup's FULL matrix id to the SHORT chatId the spine keys by
  // (shortChatId — or an incoming short-form arrival spawns a separate folder+thread, the 2026-10-04
  // "side-room has no context" bug), and ALIAS it onto ev's conversation (aliasContact — so the being
  // keeps writing its ONE thread; two chat surfaces, one on-disk conversation). The side-room's
  // sanitized title is stored as the alias's per-surface transcript key, exactly as /join does.
  // Returns { chatId, primaryJid, transcript } (SHORT chatId), or null on a create failure — the caller then
  // edits/posts nothing. The caller owns the (already-unique'd) title, the trigger-message edit, the
  // opener post, and `extra` — the fields stored on the alias entry (/join: join_name/join_by;
  // automatic: automatic: true).
  async function createAliasedSideGroup(ev, surface, title, plan, verb, extra = {}) {
    const chatId = await createSideGroup(plan, title, verb);
    if (!chatId) return null;
    // Reload fresh before the write (createGroup is async). Alias the new group's chatId to ev's
    // canonical (primary) entry — both ids now resolve to the SAME folder/agents/threads.
    return mutateState(writeState, async () => {
      const state = await loadState();
      const primaryJid = getContact(state, surface, ev.chatId)?.jid ?? ev.chatId;
      const transcript = sanitizeSlug(title);
      await writeState(aliasContact(state, surface, chatId, primaryJid, { transcript, ...extra }));
      return { chatId, primaryJid, transcript };
    });
  }

  // ── /join shared by C's members (operator 2026-10-16) ──
  // The name key is case- and space-insensitive, so `/join Emely` finds `/join emely`'s room.
  const joinNameKey = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  const joinExistsOf = (block) => (block && typeof block.exists === 'string' && block.exists.trim()) ? block.exists : JOIN_EXISTS_DEFAULT;
  const joinLimitOf = (block) => (block && typeof block.limit === 'string' && block.limit.trim()) ? block.limit : JOIN_LIMIT_DEFAULT;
  // C's live /join room for a name: an alias of C (never a legacy `super: true` one) carrying join_name, or,
  // for a room made before join_name existed, the transcript key its title gives.
  const joinRoomOf = (state, surface, primaryJid, key, legacyKey) => {
    for (const [chatId, e] of Object.entries(state?.contacts?.[surface] ?? {})) {
      if (e?.aliasOf !== primaryJid || e.super === true) continue;
      if (e.join_name != null ? e.join_name === key : e.transcript === legacyKey) return { chatId, entry: e };
    }
    return null;
  };
  const rosterHas = (raw, senderId) => !!senderId && Array.isArray(raw?.participants?.items)
    && raw.participants.items.some((p) => String(p?.id) === String(senderId));
  // A sender's live side-rooms in C: ones they made (join_by_id) or are in. Gone (404) rooms do not count.
  const sendersRoomsOf = async (state, surface, primaryJid, senderId) => {
    const out = [];
    for (const [chatId, e] of Object.entries(state?.contacts?.[surface] ?? {})) {
      if (e?.aliasOf !== primaryJid || e.super === true) continue;
      const raw = await forkBridge.chatRaw?.(chatId);
      if (raw !== false && (e.join_by_id === senderId || rosterHas(raw, senderId))) out.push({ chatId, entry: e });
    }
    return out;
  };
  // Whom a being would wake for this sender here, by router.resolve's allowed_users test (the
  // conversation's block, else the agent's conversation_defaults; a stranger reaches only the
  // conversation's own agent). Bare /agents' public list reads it.
  const senderMayWake = (state, surface, chatId, ev, being) => {
    const owner = defaultBeingOf(getContact(state, surface, chatId)?.entry);
    if (owner && being !== owner && !isKnownSender(ev?.senderId, cfg())) return false;
    const conv = getBeing(state, surface, chatId, being)?.allowedUsers;
    const global = cfg().agents?.[being]?.conversation_defaults?.allowed_users;
    return allowedUsersPermits(Array.isArray(conv) ? conv : (Array.isArray(global) ? global : null), ev?.senderId);
  };
  // Who besides the operator may /join or /split (operator 2026-10-18): anyone in a GROUP this node
  // hears. Refused here → a log line and the audit outcome, nothing in the chat.
  const memberRefusal = (ev, verb) => {
    if (isOperator(ev) || ev?.raw?.chatType === 'group') return null;
    onLog(`${verb}: ${ev.senderName ?? ev.senderId ?? '?'} is not in a group here — refused.`);
    return 'refused — a member may run it only in a group';
  };

  // ── bare /agents from a non-operator (operator 2026-10-16) ──
  // One public list per chat per agents_list.every_ms; calls inside the window are ignored, and a
  // sender with ban_after ignored calls inside ban_window_ms is muted through floodBan.
  const agentsListAt = new Map();        // surface\0chatId -> when the last list was allowed
  const agentsListIgnored = new Map();   // surface\0chatId\0senderId -> times of ignored calls
  const msOr = (v, d) => (Number.isFinite(v) && v >= 0 ? v : d);
  async function agentsPublic(ev) {
    const o = cfg().agents_list ?? {};
    const t = now();
    const chat = `${surfaceOf(ev)}\u0000${ev.chatId}`;
    const last = agentsListAt.get(chat);
    if (last != null && t - last < msOr(o.every_ms, 60_000)) {
      const who = `${chat}\u0000${ev.senderId}`;
      const recent = [...(agentsListIgnored.get(who) ?? []).filter((x) => t - x < msOr(o.ban_window_ms, 600_000)), t];
      const banAfter = o.ban_after ?? 5;
      if (Number.isInteger(banAfter) && banAfter >= 1 && recent.length >= banAfter
          && floodBan?.ban(surfaceOf(ev), ev.chatId, ev.senderId, { reason: '/agents flood', senderName: ev.senderName, chatName: ev.chatName })) {
        agentsListIgnored.delete(who);
        return 'banned — /agents flood';
      }
      agentsListIgnored.set(who, recent);
      return NO_AUDIT;
    }
    agentsListAt.set(chat, t);
    const text = await agentsPublicText(ev);
    if (text) await send?.(ev.chatId, text);
  }

  // This node's local agents (any of them can be woken in any chat; the persona first) that read
  // this chat: emoji + name, handles, voice handles, the mode in plain
  // words, and whether THIS sender can call them (senderMayWake). Left out: relays (another node's
  // being), public beings (shown without eGPT machinery), surface-pinned elsewhere, mode 'off'. A
  // conversation whose own agent is public gets nothing. null = nothing to say.
  async function agentsPublicText(ev) {
    if (!loadState) return null;
    let state;
    try { state = await loadState(); } catch { return null; }
    const c = cfg();
    const surface = surfaceOf(ev);
    const entry = getContact(state, surface, ev.chatId)?.entry;
    const agentOf = (b) => {
      const k = Object.keys(c.agents ?? {}).find((n) => !n.startsWith('_') && n.toLowerCase() === String(b).toLowerCase());
      const a = k ? c.agents[k] : (b === defaultKey ? {} : null);
      return a && typeof a === 'object' && !Array.isArray(a) ? a : null;
    };
    if (agentOf(defaultBeingOf(entry))?.public === true) return null;
    const arrived = String((ev.origin ?? ev).surface ?? '').toLowerCase();
    const bare = c.dispatch?.address_without_at !== false;
    const beings = [defaultKey, ...Object.keys(c.agents ?? {}).filter((n) => !n.startsWith('_') && n.toLowerCase() !== defaultKey)];
    const lines = [];
    for (const b of beings) {
      const a = agentOf(b);
      if (!a || a.public === true || a.relay_channel || Array.isArray(a.paths) || String(a.configuration ?? '').toLowerCase() === 'relay') continue;
      if (a.surface != null && surfaceOfNetwork(String(a.surface).toLowerCase()) !== arrived) continue;
      const { mode } = resolveMode(getBeing(state, surface, ev.chatId, b), b, c);
      if (!PUBLIC_MODE_WORDS[mode]) continue;
      const hs = wakeTokens(b, a);
      const voice = voiceWakeTokens(a);
      lines.push([
        `${a.body_emoji || '🐶'} ${a.name || hs[0] || b} — ${hs.length ? `call: ${hs.map((h) => `@${h}`).join(', ')}${bare ? ` (or start a message with "${hs[0]}")` : ''}` : 'no handle'}`,
        ...(voice.length ? [`voice: ${voice.map((v) => `"${v}"`).join(', ')}`] : []),
        PUBLIC_MODE_WORDS[mode],
        `you can call it: ${mode !== 'mute' && senderMayWake(state, surface, ev.chatId, ev, b) ? 'yes' : 'no'}`,
      ].join(' · '));
    }
    return lines.length ? ['Agents in this chat:', ...lines].join('\n') : null;
  }

  // /join (anyone types /<handle> join [<name>] in chat C): create the side-group and ALIAS it to C.
  // Every precondition resolves BEFORE any bridge/state mutation (an unresolvable Rodz STOPS, nothing
  // created).
  async function joinGroup(ev) {
    const surface = surfaceOf(ev);
    if (!loadState || !writeState) return;                   // state not wired → silent
    const refused = memberRefusal(ev, '/join');
    if (refused) return refused;
    const state0 = await loadState();
    const contact = getContact(state0, surface, ev.chatId);
    const operator = isOperator(ev);
    // /join only ALIASES this chat's conversation onto the new side-group, so it needs a KNOWN
    // conversation to alias — NOT an existing being thread. A chat the being never answered in (an
    // ingested 1:1 transcript, no agents block) is still joinable: a fresh E invocation in the
    // group starts the first thread there, letting the operator work with this chat's context
    // without polluting the 1:1 (operator 2026-10-06). NB /split keeps residesHere — it COPIES
    // resident threads, so a thread-less split is meaningless. The chat where /join was typed is
    // always a known contact; this guard only trips on a genuinely-unknown chat.
    if (!contact) {
      onLog(`/join: ${ev.chatId} is not a known conversation — nothing to alias, refusing.`);
      await send?.(ev.chatId, `/join: I don't know this conversation yet — send a message here first, then ${hintOf('join', ev)}.`);
      return;
    }
    // A sender other than the account itself goes into the new group; only a bridged id can be invited.
    const invitee = ev.isSender ? null : invitableOf(ev);
    if (!ev.isSender && !invitee) {
      await send?.(ev.chatId, '/join: I can\'t add you to a group from this account.');
      return 'refused — the sender id cannot be invited';
    }
    const cTitle = ev.chatName || (await forkBridge.chatTitle(ev.chatId)) || ev.chatId;
    const joinName = forkNameOf(ev.body);
    const baseTitle = groupTitleOf(cTitle, joinName);
    const vars = (title) => ({ name: joinName, title, group: cTitle, by: ev.senderName ?? '', handle: handleOf(ev) });
    const placeholder = (title) => fill(placeholderOf(cfg().join, JOIN_PLACEHOLDER_DEFAULT), vars(title));
    // Our own message is edited in place; anyone else's is not ours to edit, so it gets a reply.
    const announce = (text) => (ev.isSender ? forkBridge.editMessage(ev.chatId, ev.msgId, text) : send?.(ev.chatId, text));

    // SAME NAME, LIVE ROOM → no second group (operator 2026-10-16). A room the bridge reports gone
    // is dropped and replaced. The Desktop API has no add-member endpoint, so a sender not already in
    // the room is told whom to ask.
    const key = joinNameKey(joinName);
    // A room made before join_name was titled before the SI+ prefix too.
    const hit = joinRoomOf(state0, surface, contact.jid, key, sanitizeSlug(baseTitle.slice(SIDE_GROUP_PREFIX.length)));
    if (hit) {
      const alive = forkBridge.chatRaw ? await superChannelAlive(hit.chatId, { chatRaw: forkBridge.chatRaw, config: cfg() }) : null;
      if (alive === false) {
        await writeState(dropContact(await loadState(), surface, hit.chatId));
        onLog(`/join: side-room ${hit.chatId} ("${joinName}") is gone — alias dropped, creating a new one`);
      } else {
        if (ev.isSender || rosterHas(await forkBridge.chatRaw?.(hit.chatId), ev.senderId)) {
          await announce(placeholder(baseTitle));
          return `already in ${hit.chatId} ("${joinName}")`;
        }
        await send?.(ev.chatId, fill(joinExistsOf(cfg().join), { ...vars(baseTitle), by: hit.entry.join_by ?? 'the operator' }));
        return `"${joinName}" exists (${hit.chatId}) — the sender is not in it and cannot be added from here`;
      }
    }
    // THE CAP (operator 2026-10-16): config.join.member_cap live side-rooms per non-operator per chat —
    // every create is An's own WhatsApp account. -1/unset (or anything but an integer >= 1) = unlimited.
    const cap = Number(cfg().join?.member_cap);
    if (!operator && Number.isInteger(cap) && cap >= 1) {
      const mine = await sendersRoomsOf(state0, surface, contact.jid, ev.senderId);
      if (mine.length >= cap) {
        const names = mine.map((r) => r.entry.join_name ?? r.entry.transcript ?? r.chatId).join(', ');
        await send?.(ev.chatId, fill(joinLimitOf(cfg().join), { ...vars(baseTitle), name: names }));
        return `refused — the sender already has ${mine.length} side-room(s) here (member_cap ${cap})`;
      }
    }

    const plan = await sideGroupPlan(ev, '/join');
    if (!plan) return;
    const title = baseTitle;   // duplicate titles are fine: nothing finds a group by its title

    // ── mutations begin ──
    // (a+b) CREATE the group (sideGroupPlan: who creates, whom it invites; no inline opener — the
    //       group inherits C's whole thread by the alias) and ALIAS its SHORT chatId to C's canonical
    //       entry, via the create+alias core (createAliasedSideGroup, which also stores the sanitized
    //       title as the alias's per-surface transcript key; join_name/join_by find this room for the
    //       next /join of the same name). null → no chatId: abort, placeholder NOT edited, nothing posted.
    const aliased = await createAliasedSideGroup(ev, surface, title, plan, '/join', { join_name: key, ...(ev.senderName ? { join_by: ev.senderName } : {}), ...(invitee ? { join_by_id: invitee } : {}) });
    if (!aliased) return;
    const { chatId: joinChatId, primaryJid, transcript } = aliased;
    // (c) EDIT the operator's /join message into the placeholder (raw, no persona; a reply for anyone else).
    await announce(placeholder(title));
    onLog(`/join: ${cTitle} -> group ${joinChatId} aliased to ${primaryJid} (invited ${plan.participantIDs.join(', ')})`);
    // (d) POST THE OPENER so the new (otherwise-empty) group surfaces in Beeper — added step AFTER the
    //     success path; a failure here never undoes the alias/placeholder above.
    await postOpener({ verb: '/join', newChatId: joinChatId, openerText: openerOf(cfg().join, JOIN_OPENER_DEFAULT, cTitle, ev), origin: primaryJid, kind: 'join', transcript });
  }

  // /split (anyone types /<handle> split [<name>] in chat C): create a side-group backed by a NEW
  // conversation that DIVERGES from C — each resident being's thread is COPIED under a new thread id.
  // Same preconditions/gate as /join; the difference is a NEW entry + per-being thread copy instead of
  // an alias.
  async function splitGroup(ev) {
    const surface = surfaceOf(ev);
    if (!loadState || !writeState) return;                   // state not wired → silent
    const refused = memberRefusal(ev, '/split');
    if (refused) return refused;
    let state = await loadState();
    if (!residesHere(state, surface, ev.chatId)) return;     // no being with a thread to copy → silent
    if (!ev.isSender && !invitableOf(ev)) {
      await send?.(ev.chatId, '/split: I can\'t add you to a group from this account.');
      return 'refused — the sender id cannot be invited';
    }
    const plan = await sideGroupPlan(ev, '/split');
    if (!plan) return;
    const cTitle = ev.chatName || (await forkBridge.chatTitle(ev.chatId)) || ev.chatId;
    const placeholder = placeholderOf(cfg().split, SPLIT_PLACEHOLDER_DEFAULT);
    const title = groupTitleOf(cTitle, forkNameOf(ev.body));

    // ── mutations begin ──
    // (a) CREATE the group (sideGroupPlan). SHORT id, same reason as /join above: the new entry +
    // parent_chat must key by the form the spine resolves incoming messages under, or a short-form
    // arrival spawns a second entry. null → aborted, placeholder NOT edited.
    const splitChatId = await createSideGroup(plan, title, '/split');
    if (!splitChatId) return;
    // (b)+(c) its own conversation, each resident's thread copied (registerSplit).
    state = await loadState();
    const split = await registerSplit(state, surface, splitChatId, ev.chatId, { title, verb: '/split' });
    await writeState(split.state);
    // (d) EDIT the operator's /split message into the placeholder marker — not anyone else's message
    //     (not ours to edit; the new group's opener is their answer).
    if (ev.isSender) await forkBridge.editMessage(ev.chatId, ev.msgId, placeholder);
    onLog(`/split: ${cTitle} -> NEW conv ${splitChatId} (${split.slug}, invited ${plan.participantIDs.join(', ')}); copied threads for ${split.copied.join(', ') || '(none)'} (parent ${ev.chatId})`);
    // (e) POST THE OPENER so the new group surfaces in Beeper — added step AFTER the copy + placeholder;
    //     a failure here never undoes the conversation/threads already written.
    await postOpener({ verb: '/split', newChatId: splitChatId, openerText: openerOf(cfg().split, SPLIT_OPENER_DEFAULT, cTitle, ev), origin: ev.chatId, kind: 'split' });
  }

  // A /split group's own conversation, on the creator (/split) and on the other node (linkSideGroup):
  // → { state, slug, copied }; the caller writes the state.
  async function registerSplit(state, surface, splitChatId, parentChatId, { title, verb }) {
    // (b) REGISTER the new group as its OWN conversation (ensureContact FIRST — recordThread/patch
    //     below no-op on an unknown contact), and record the parent chat so /send+/end find the
    //     original (a split group is NOT an alias).
    const cSlug = getContact(state, surface, parentChatId)?.slug ?? 'conv';
    const ensured = ensureContact(state, surface, splitChatId, { pushedName: title, slugHint: `egpt-split-${cSlug}` });
    state = ensured.state;
    const splitConvDir = slugDir(surface, ensured.slug);
    state = patchContact(state, surface, splitChatId, { parent_chat: parentChatId });
    // (c) COPY each resident being's thread into the split conversation as a NEW, DIVERGING thread.
    //     The residents + their source thread ids come off the ORIGINAL entry (read fresh). For each:
    //     mint a newThreadId, TRANSFORM-copy the source jsonl into the new thread's store at the
    //     project dir matching the SPLIT conversation's cwd (sessionId→newThreadId, cwd→splitConvDir),
    //     and record the new thread on the split entry's agents.<being> block. `flag:'wx'` never
    //     clobbers an existing dest (EEXIST → refuse that one copy, log, still record the thread id).
    const origEntry = getContact(state, surface, parentChatId)?.entry;
    const residents = residentsOf(origEntry)
      .map((being) => [being, getBeing(state, surface, parentChatId, being)?.threadId ?? null])
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
          onLog(`${verb}: thread copy for ${being} ${srcFound.jsonlPath} -> ${destJsonl} failed — ${e?.message ?? e}`);
        }
      } else {
        onLog(`${verb}: can't find ${being}'s thread store for #${srcThreadId} — recording the new thread id without a copy`);
      }
      state = recordThread(state, surface, splitChatId, newThreadId, undefined, being);
    }
    return { state, slug: ensured.slug, copied };
  }

  // /send (anyone in a join/split group REPLIES /send to a message M there): relay M's text into the
  // ORIGINAL chat. Repeatable — no placeholder edit, no close. The original is the alias target (join)
  // or the recorded parent_chat (split); silent when neither. Reads M's text off the chat, else the
  // transcript (as /radio say's quick-reply does), then strips the node/bridge/persona wrap. Posts via the
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
    if (ev.replyToId == null) { await send?.(ev.chatId, `reply to a message with ${hintOf('send', ev)} to send it to the original chat`); return; }
    // The quoted message was logged on THIS surface, so read it from THIS surface's own transcript:
    // for a /join side-room that is transcript-<its id>.md beside the shared transcript.md (same
    // folder), for a /split its own conversation's transcript.md. transcriptTarget is the SAME
    // write==read helper the transcript writer files through; absent (tests) → room.transcriptPath.
    const tt = transcriptTarget ? await transcriptTarget(surface, ev.chatId, { chatName: ev.chatName }) : null;
    const path = tt?.path ?? (await resolveConvRoom(surface, ev.chatId))?.transcriptPath ?? null;
    let text = null;
    if (path) { try { text = await readFile(path, 'utf8'); } catch { text = null; } }
    // The chat's own copy first: an edited message (every being reply) is on the record only as
    // editAction's one flattened line, so its line breaks survive nowhere else.
    const live = (await forkBridge.listMessagesRaw?.(ev.chatId, { via: ev.connection ?? null }))?.find((m) => m?.id != null && String(m.id) === String(ev.replyToId));
    const body = htmlToMarkdown(live?.text) || (text ? bodyForMessageId(text, ev.replyToId) : null);
    const cleaned = body ? cleanQuotedBody(body) : null;
    if (!cleaned) { await send?.(ev.chatId, '/send: nothing to send — reply to a message that has text'); return; }
    // ORIGIN (2026-10-16): name the side group, unless send.origin is never, or auto and the group is discreet.
    const om = String(cfg().send?.origin ?? '').trim().toLowerCase();
    const origin = ['auto', 'always', 'never'].includes(om) ? om : SEND_ORIGIN_DEFAULT;
    const originTpl = typeof cfg().send?.origin_template === 'string' ? cfg().send.origin_template : SEND_ORIGIN_TEMPLATE_DEFAULT;
    let prefix = '';
    if (origin !== 'never' && originTpl) {
      const raw = state.contacts?.[surface]?.[ev.chatId];
      const side = raw?.aliasOf ? raw : (getContact(state, surface, ev.chatId)?.entry ?? {});
      const stored = side.aliasOf ? side.transcript : side.pushedName;
      const sideTitle = ev.chatName || (await forkBridge.chatTitle(ev.chatId)) || stored || null;
      const discreet = side.discreet === true || [sideTitle, stored].some(titleLooksDiscreet);
      if (sideTitle && (origin === 'always' || !discreet)) prefix = fill(originTpl, { group: sideTitle });
    }
    const pbf = String(cfg().send?.post_back_from ?? '').trim().toLowerCase();
    // A member's /send (operator 2026-10-18) is said by the mouth, signed: only the operator's posts as him.
    const member = !isOperator(ev);
    const via = member ? (hasMouth() ? 'secondary' : 'primary') : ((pbf === 'primary' || pbf === 'secondary') ? pbf : SEND_POST_BACK_FROM_DEFAULT);
    // 'secondary': Rodz says it in its OWN room for the original — boot's mouth translation (the stored
    // mouth_chat, else routeLocally), else the primary, loudly. Never a lookup by title.
    // UNSIGNED (operator 2026-10-04): /send posts back AS THE OPERATOR — no node signature (no visible
    // 🏰 bridge close, no invisible node tag). Routed into the SAME .send via skipSignature, so the
    // relay's sent id is still tracked for echo-dedup (beeper.mjs _sentIds) and this node won't re-ingest it.
    const posted = await forkBridge.postReply(originalChatId, prefix + cleaned, null, { via, unsigned: !member });
    if (!posted) { await send?.(ev.chatId, '/send: could not post to the original chat'); return; }
    onLog(`/send: ${ev.chatId} -> original ${originalChatId} via ${via} (message ${ev.replyToId}; origin ${prefix ? 'named' : 'omitted'})`);
  }

  // /end (anyone in a join/split group REPLIES /end there): archive the group and drop its mapping so
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
    if (state.contacts?.[surface]?.[ev.chatId]?.automatic === true) {   // operator 2026-10-18 ~21:00: off in the automatic group
      onLog(`/end: ${ev.chatId} is the automatic side group of ${aliasTarget} — /end is off there, nothing done`);
      return 'no-op — /end is off in the automatic side group';
    }
    await forkBridge.archiveChat(ev.chatId, { via: ev.connection ?? null });   // the account the group was heard on
    await writeState(dropContact(await loadState(), surface, ev.chatId));
    onLog(`/end: ${aliasTarget ? 'join' : 'split'} group ${ev.chatId} archived + ${aliasTarget ? `alias to ${aliasTarget}` : `split conv mapping (parent ${parent})`} dropped`);
    return `archived ${ev.chatName || ev.chatId}`;         // the audit's <outcome> for a successful archive
  }

  // ── THE AUTOMATIC SIDE GROUP (operator 2026-10-18) ──
  // `reply_in_side_group` on a chat's OWN conversations.yaml entry: no being replies there, in any mode.
  // gating.decide asks this before a reply → the chat id of its side group (an alias of the chat marked
  // `automatic: true`); with `create` false and no group yet, a function that makes it, called once the
  // reply has something to post (sender.open); false = withhold the reply (the create failed); null =
  // in place. The node whose being replies makes it when it holds none (operator 2026-10-19); both
  // nodes making one at once is fine: two groups, each node links the other's, and each keeps replying
  // in the first one it holds — its own.
  // The value: a truthy word → true ("SI+<group>"), a falsy word / empty / absent → false, any other
  // string → that title.
  const replyInSideGroupOf = (v) => {
    if (v === true || v === 1) return true;
    const s = typeof v === 'string' ? v.trim() : '';
    if (['true', 'yes', 'on', '1'].includes(s.toLowerCase())) return true;
    return ['false', 'no', 'off', '0', ''].includes(s.toLowerCase()) ? false : s;
  };
  const autoCreating = new Map();   // surface+chatId → the create in flight, so one reply makes one group
  async function autoSideGroup(ev, { create = true } = {}) {
    if (!loadState || !writeState) return null;
    const surface = surfaceOf(ev);
    let state;
    try { state = await loadState(); } catch { return null; }
    const own = state?.contacts?.[surface]?.[ev.chatId];
    if (!own || own.aliasOf) return null;
    const setting = replyInSideGroupOf(own.reply_in_side_group);
    if (!setting) return null;
    const room = Object.keys(state.contacts[surface]).find((id) => state.contacts[surface][id]?.aliasOf === ev.chatId && state.contacts[surface][id].automatic === true) ?? null;
    if (room) {
      const alive = forkBridge.chatRaw ? await superChannelAlive(room, { chatRaw: forkBridge.chatRaw, config: cfg() }) : null;
      if (alive !== false) return room;
      await mutateState(writeState, async () => writeState(dropContact(await loadState(), surface, room)));
      onLog(`automatic: ${room} (the SI+ group of ${ev.chatName || ev.chatId}) is gone — alias dropped`);
    }
    if (!create) return () => autoSideGroup(ev);
    const key = `${surface}\u0000${ev.chatId}`;
    if (!autoCreating.has(key)) autoCreating.set(key, openAutoSideGroup(ev, surface, setting).finally(() => autoCreating.delete(key)));
    return (await autoCreating.get(key)) ?? false;
  }
  async function openAutoSideGroup(ev, surface, setting) {
    const plan = await sideGroupPlan(ev, 'automatic', { everyone: true });
    if (!plan) return null;
    const cTitle = ev.chatName || (await forkBridge.chatTitle(ev.chatId)) || ev.chatId;
    const title = setting === true ? sidePrefixed(cTitle) : setting;
    const aliased = await createAliasedSideGroup(ev, surface, title, plan, 'automatic', { automatic: true });
    if (!aliased) return null;
    onLog(`automatic: ${cTitle} -> ${aliased.chatId} "${title}" (invited ${plan.participantIDs.join(', ')})`);
    await postOpener({ verb: 'automatic', newChatId: aliased.chatId, openerText: openerOf(null, AUTO_OPENER, cTitle), origin: aliased.primaryJid, kind: 'automatic', transcript: aliased.transcript });
    return aliased.chatId;
  }
  // The other node's half: a side group's opener names it, its origin and its kind (ev.canary, beside the
  // creator's node frame). Arriving in that group on a node that does not hold it, it is linked as the
  // creator holds it: join/automatic → an alias of the origin (the canary's transcript key), split → its
  // own conversation, this node's residents' threads forked (registerSplit). A chat only seen here is
  // converted in place; one with a being thread of its own is left for the operator (logged).
  // As on the creator, Rodz's copy comes first (mouthCopyOf; it waits on this chat's lane only), so the
  // group is never usable here before its mouth_chat: one write holds both. An automatic group also
  // switches reply_in_side_group on for this node's own entry of the origin when that entry says
  // nothing (operator 2026-10-19: only the creating node is configured), in the same write.
  const SIDE_KINDS = new Set(['join', 'split', 'automatic']);
  async function linkSideGroup(ev) {
    const c = ev?.canary;
    if (!c?.origin || ev.fromNode == null || !loadState || !writeState) return;
    const surface = surfaceOf(ev);
    const chatId = shortChatId(ev.chatId);
    if (shortChatId(c.group) !== chatId) return;
    if (!SIDE_KINDS.has(c.kind)) { onLog(`side group: ${chatId} names an unknown kind "${c.kind}" — not linked`); return; }
    // Why this node does not link it ('' = it already holds it), or null to link.
    const refusal = (state) => {
      const own = state?.contacts?.[surface]?.[chatId];
      if (own?.aliasOf || own?.parent_chat) return '';
      if (residesHere(state, surface, chatId)) return `${chatId} already has its own conversation here, with a being thread — not linked to ${c.origin}; left for the operator`;
      return getContact(state, surface, c.origin) ? null : `${chatId} names ${c.origin} as its chat, which this node does not have — not linked`;
    };
    const why = refusal(await loadState());
    if (why != null) { if (why) onLog(`${c.kind}: ${why}`); return; }
    const copy = mouthCopyOf(chatId);
    const room = copy ? ((await copy)?.chatID ?? null) : null;
    await mutateState(writeState, async () => {
      let state = await loadState();
      if (refusal(state) != null) return;
      const own = state.contacts[surface]?.[chatId];
      let as, switched = null;
      if (c.kind === 'split') {
        const split = await registerSplit(state, surface, chatId, c.origin, { title: ev.chatName || chatId, verb: 'split' });
        state = split.state;
        as = `its own conversation (parent ${c.origin}; copied threads for ${split.copied.join(', ') || '(none)'})`;
      } else {
        const { jid } = getContact(state, surface, c.origin);
        state = aliasContact(state, surface, chatId, jid, { transcript: c.transcript ?? sanitizeSlug(ev.chatName || chatId), ...(c.kind === 'automatic' ? { automatic: true } : {}) });
        as = `an alias of ${jid}`;
        if (c.kind === 'automatic' && getContact(state, surface, jid)?.entry?.reply_in_side_group == null) {
          state = patchContact(state, surface, jid, { reply_in_side_group: 'on' });
          switched = jid;
        }
      }
      await writeState(setAliasMouthChat(state, chatId, room));
      const mouth = room ? `; Rodz's room ${room} (its copy of the opener)` : copy ? `; Rodz's copy of the opener did not arrive within ${OPENER_COPY_MS}ms — replies there come from the primary until the mouth finds its room` : '';
      onLog(`${c.kind}: ${chatId} linked as ${as}${own ? ', converting the entry it had from being seen' : ''}${mouth} — from its opener (made by <${ev.fromNode}>)`);
      if (switched) onLog(`automatic: reply_in_side_group set on for ${switched} here, as on <${ev.fromNode}> (its side group ${chatId})`);
    });
  }

  // ── COMMAND ALIASES (operator 2026-10-19): config/commands_alias.yaml, `<alias>: /<handle> <command> [args]` ──
  // A line that STARTS with an alias (any case, whole words, the longest alias first) is that command
  // line plus the rest of the line, read by commandOf like a typed one, so every gate is the command's
  // own. The handle may be any node's being: that node runs it. Read through the stat cache: an edit
  // applies on the next message.
  const parseAliasFile = (text) => { try { return { map: text == null ? null : YAML.parse(text) }; } catch (e) { return { error: e?.message ?? String(e) }; } };
  let aliasMemo = { key: null, list: [] };
  function aliasList() {
    let file;
    try { file = statCache.readSync(commandAliasesPath, parseAliasFile); } catch (e) { file = { error: e?.message ?? String(e) }; }
    const agents = cfg().agents ?? {};
    const handles = new Set([...addressableTokens(agents), ...Object.values(agents).flatMap((a) => fallbackWake(a)?.handles ?? [])]);
    const key = JSON.stringify([file, [...handles]]);
    if (key === aliasMemo.key) return aliasMemo.list;
    const list = [];
    const { map, error } = file;
    if (error || (map != null && (typeof map !== 'object' || Array.isArray(map)))) onLog(`commands_alias.yaml: ${error ?? 'not a map of <alias>: /<command>'} — no aliases`);
    else for (const [k, v] of Object.entries(map ?? {})) {
      const alias = String(k).trim().toLowerCase().split(/\s+/).join(' ');
      const line = typeof v === 'string' ? v.trim() : '';
      const bare = COMMAND_SET.has(line.split(/[\s=]/)[0].toLowerCase());
      const why = !alias ? 'is empty'
        : alias.startsWith('/') ? 'starts with "/"'
        : handles.has(alias.replace(/^@/, '').split(' ')[0]) ? 'starts with a being handle'
        : bare ? `maps to ${JSON.stringify(v)}, a command with no being — write /<handle> ${line.slice(1)}`
        : !parseBeingCommand(line) ? `maps to ${JSON.stringify(v)}, not /<handle> <known command>` : null;
      if (why) { onLog(`commands_alias.yaml: "${k}" ${why} — refused`); continue; }
      list.push({ alias, line, re: new RegExp(`^${alias.split(' ').map(esc).join('\\s+')}(?![\\p{L}\\p{N}_])`, 'iu') });
    }
    aliasMemo = { key, list: list.sort((a, b) => b.alias.length - a.alias.length) };
    return aliasMemo.list;
  }
  // The command line a line stands for ({ body, alias }), or null — commandOf reads it. A leading
  // , . : ; ! ? of the rest is dropped. A node-signed line never is one: being output is never input.
  function aliasOf(ev, body) {
    if (ev?.fromNode != null || !body) return null;
    for (const { alias, line, re } of aliasList()) {
      const hit = re.exec(body);
      if (!hit) continue;
      const rest = body.slice(hit[0].length).replace(/^[\s,.:;!?]+/, '');
      return { body: rest ? `${line} ${rest}` : line, alias };
    }
    return null;
  }

  // /config [<key>[=<value>]] — the `=` idiom applied to the pair (operator ruling 2026-07-28,
  // replacing the one-day-old `set`/`get` sub-verbs — no legacy alias kept). Bare: a redacted dump.
  // `<key>` alone: a GET. `<key>=<value>`: a SET.
  // <key> resolves through resolveConfigKey (config/config-schema.mjs — a dotted path used as-is,
  // or a bare leaf looked up in the KEYS: index); <value> is JSON.parse'd, falling back to the raw
  // string on a parse failure (same coercion the extension used), then written via writeConfigKey
  // — the comment-preserving single-key writer, never the whole-file writeConfig. The spine picks
  // the change up itself (step B): the reply says whether the key applies live or needs a restart
  // (config-swap.mjs RESTART_KEYS); nothing here triggers one.
  // Matched against KEY NAMES, recursively. Credentials AND personal identifiers: a dump goes
  // to whatever surface asked, which is usually a real Beeper chat, permanently. `account` and
  // `allowed_users` are the operator's email and phone numbers — not secrets, but a config dump
  // exists to check values like node_role, not to post a contact list into a group.
  // `account` is ANCHORED so `peer_nodes` ([kg, do] — not sensitive, and worth seeing) stays.
  const CONFIG_REDACT_RE = /token|key|secret|password|^account$|allowed_users|ics_url/i;   // ics_url: book's secret iCal address
  function redactConfigValue(value) {
    if (Array.isArray(value)) return value.map(redactConfigValue);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = CONFIG_REDACT_RE.test(k) ? '<redacted>' : redactConfigValue(v);
      return out;
    }
    return value;
  }
  const CONFIG_USAGE = 'usage: /<handle> config | /<handle> config <key> | /<handle> config <key>=<value>';
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
    return isRestartKey(resolved.path)
      ? `set ${resolved.path} = ${JSON.stringify(shown)} — a restart-only key: the spine restarts itself if auto_restart_on_config_change is on, else run /restart (the spine, not the editor)`
      : `set ${resolved.path} = ${JSON.stringify(shown)} — applies on the spine's next tick, no restart`;
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
    const { client, why } = await chatChromeOf(surfaceOf(ev), ev.chatId);
    if (!client) { await send?.(ev.chatId, `/activate: no browser for this chat — ${why}`); return; }
    let liveIds = new Set();
    try { liveIds = new Set((await client.listTabs()).map((t) => t.id)); } catch { /* no Chrome → treat as closed */ }
    if (m.targetId && liveIds.has(m.targetId)) { await send?.(ev.chatId, `${id} already active · tab ${m.targetId}`); return; }
    let newId;
    try { newId = await client.openTab(m.url); } catch (e) { await send?.(ev.chatId, `/activate: failed — ${e?.message ?? e}`); return; }
    await room.setMember({ ...m, targetId: newId });   // spread keeps state/adapter/url; targetId refreshed
    await send?.(ev.chatId, `reopened ${m.url} · tab ${newId ?? '?'} · active`);
  }

  // /bans — the media-flood auto-bans currently active across every chat (src/flood-ban.mjs).
  // /unban [name] clears the ban(s) in the chat it was typed in; name = a banned sender's
  // display name or id. Both read the ONE in-memory floodBan boot shares with the bridges, so a
  // clear is live, not a config write; null (standalone) → both say it isn't wired.
  function bansReport() {
    if (!floodBan) return 'flood-ban not wired on this node';
    const bans = floodBan.list();
    if (!bans.length) return 'no active flood bans';
    const now = Date.now();
    const lines = bans.map((b) => `${b.senderName} in ${b.chatName}${b.reason ? ` (${b.reason})` : ''} — ${Math.max(1, Math.ceil((b.until - now) / 60_000))}m left`);
    return [`${bans.length} active flood ban${bans.length === 1 ? '' : 's'}:`, ...lines].join('\n');
  }
  function unbanHere(ev, name) {
    if (!floodBan) return 'flood-ban not wired on this node';
    const n = floodBan.unban(surfaceOf(ev), ev.chatId, name);
    if (n) return `cleared ${n} flood ban${n === 1 ? '' : 's'}${name ? ` matching "${name}"` : ''} here`;
    return name ? `no flood ban matching "${name}" here` : 'no active flood ban here';
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

    // chrome — this chat's group Chrome, only if it is already up (a status read never launches
    // one) + this module's own adapterFor (already memoized loadAdapters). Never throws.
    try {
      const client = await chatClientOf(ev, { launch: false });
      if (client) {
        let tabs = [];
        try { tabs = await client.listTabs(); } catch { tabs = []; }
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

  return { isCommand, commandOf, hintOf, run, currentRoomOf, startBrowser, chromeClientFor: ensureChrome, browserConversationOf, chatChromeOf, autoSideGroup, linkSideGroup };
}
