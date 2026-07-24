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
import { patchContact, getContact, getBeing, slugDir, statsPath, conversationPathOf, listIdentityLayers as defaultListIdentityLayers, DETERMINISTIC_MODEL, DETERMINISTIC_EFFORT, DEFAULT_ALLOWED_TOOLS, READONLY_ALLOWED_TOOLS, KNOWN_SURFACES } from '../conversations-state.mjs';
import { stripFrontMatter } from '../transcript-meta.mjs';
import { initWizard, wizardStep, wizardPrompt } from '../agent-wizard.mjs';
import { BUILTIN_BRAINS_DIR, PROFILE_AGENTS_DIR } from './brains.mjs';
import { coerceAllowedTools } from './brainpool.mjs';
import { stat as fsStat, readFile as fsReadFile, writeFile as fsWriteFile, mkdir as fsMkdir } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import * as YAML from 'yaml';
import { EGPT_HOME } from '../egpt-home.mjs';
import { shortChatId } from '../bridges/chat-id.mjs';
import { ownNodeNamesOf } from './node-names.mjs';
import { Room } from '../room-core.mjs';
import { sanitizeName } from '../sanitize.mjs';
import { loadAdapters as defaultLoadAdapters, matchAdapter } from '../adapters/registry.mjs';
import { isRunning as cdpIsRunning, listTabs as cdpListTabs, cdpHost as cdpHostOf, openTab as cdpOpenTab, activateTarget as cdpActivateTarget, closeTab as cdpCloseTab } from '../tools/cdp.mjs';
import { findChromeExecutable, chromeArgs, chromeCommandLine, resolveBrainProfile } from '../tools/chrome-launcher.mjs';

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

// Where the `custom` wizard branch AUTHORS its new files (injectable in tests): the
// agent-type YAML lands in config/agents/, a free-text identity layer as a FLAT
// config/identities/<name>.md file (operator 2026-07-03).
export const PROFILE_IDENTITIES_DIR = join(EGPT_HOME, 'config', 'identities');

// The new agent-type file (house comment style, brief). Writes the explicit
// DEFAULT_ALLOWED_TOOLS list (a LIST = CONFINED; the readonly freeze below matches).
// `personality` names the identity layer a fresh conversation of this type boots from.
function customTypeFile(name, model, effort, personality) {
  const toolLines = DEFAULT_ALLOWED_TOOLS.map((t) => `  - ${t}`).join('\n');
  return `# ${name} — custom agent type created via the /e wizard. A brain def (engine config);
# edit freely. Resolution layers (most-specific wins): src/brains < config/agents < <slug>/brains.
type: ${CCODE}
model: ${model}
effort: ${effort}
allowed_tools:        # list tools explicitly (CONFINED); 'all' is accepted but discouraged (never grants bare Bash/Agent)
${toolLines}
personality: ${personality}
`;
}

// A free-text identity layer: JUST the operator's instructions (no comment header — the
// whole file is concatenated into the kickoff feed, so a housekeeping comment would leak
// into the persona). Matches the default layer's plain-markdown convention.
const identityLayerFile = (text) => `${String(text).trim()}\n`;

// A fresh NamedRoom's config.yaml — a commented placeholder (like the seeded templates,
// seed.mjs). Pure comments → parses to null, so the heartbeat/transcription loaders read
// it as an empty {}. A new room needs NO per-room identity files: its feed layers are the
// SHARED profile-root skeletons (config/skeletons/room/, seeded once at the profile root),
// not per-room copies. Members are later work — no roster block yet.
const roomConfigFile = (name) => `# room ${name} — an operator-created NamedRoom (the folder IS the room).
# Feed layers come from the shared config/skeletons/room/ template, not per-room copies.
# Add heartbeats:, transcription:, or members: blocks here to wire behavior.
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

// The NamedRooms on disk: the immediate subdirectories of EGPT_HOME/rooms/ (each folder
// IS a room). Never throws — a missing rooms/ dir yields []. Injected in tests.
function defaultListRoomNames() {
  try {
    return readdirSync(join(EGPT_HOME, 'rooms'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch { return []; }
}

// The `/e` wizard's model/effort menus (operator 2026-07-02: v1's `/e` supplied
// these same fixed lists — there is no canonical model/effort registry in v2, and
// the agent TYPE file pins concrete values anyway). The agent-type list (step 1) is
// discovered from disk. TTL matches v1's armed-wizard window.
const WIZARD_MODELS = ['haiku', 'sonnet', 'opus', 'fable'];
const WIZARD_EFFORTS = ['low', 'medium', 'high'];
const WIZARD_TTL_MS = 5 * 60 * 1000;
const CCODE = 'ccode';

// Agent-type names for the wizard's first pick: the built-in defs (src/brains/*.yaml)
// plus the profile's own type files (EGPT_HOME/config/agents/*.yaml), deduped
// (case-insensitively; a profile override of a built-in shows once) and sorted. Same
// two layers the brain registry resolves against — a conversation-only brains/ layer
// is not offered (it's not a reusable type). Never throws (a missing dir is skipped).
function defaultListAgentTypes() {
  const seen = new Set();
  const out = [];
  for (const dir of [BUILTIN_BRAINS_DIR, PROFILE_AGENTS_DIR]) {
    let ents = [];
    try { ents = readdirSync(dir); } catch { continue; }
    for (const f of ents) {
      if (!f.endsWith('.yaml')) continue;
      const name = f.slice(0, -5);
      const k = name.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(name);
    }
  }
  return out.sort();
}

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

// Resolve a target chat for `/e auto <mode> <target>` (so the operator can set a
// remote chat's mode from the Self DM). A verbatim @jid / room-id is used as-is;
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
    for (const s of KNOWN_SURFACES) {
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
  for (const s of KNOWN_SURFACES) {
    if (s === surface) continue;
    for (const h of fuzzyHits(state, s, term)) crossHits.push({ ...h, surface: s });
  }
  if (!crossHits.length) return { error: `no chat matches "${term}" — try the exact name or its @jid` };
  if (crossHits.length > 1) return { error: `"${term}" matches ${crossHits.length}: ${crossHits.slice(0, 6).map((h) => `${h.name} (${h.surface})`).join(', ')} — be more specific` };
  return crossHits[0];
}

export function createCommands({
  getConfig = () => ({}),
  send,                                  // (chatId, text) -> deliver a plain system reply
  exit = (code) => process.exit(code),
  writeRewindTarget,
  loadState = null, writeState = null,   // conv-state IO — lets /e auto persist a mode
  brains = null,                         // the brain registry (createBrains) — the /e wizard resolves a picked agent type through it
  defaultKey = 'e',                      // the persona being-id (its map key), injected by boot from the single `default:true` agent — the persona's per-conversation mode/readonly reads+writes and its warm-key prefix all key off this, never a hardcoded 'e' (operator 2026-07-10)
  evictWarm = () => {},                  // (warmKey) -> drop that conversation's warm session so a re-point respawns fresh
  listAgentTypes = defaultListAgentTypes,// () -> string[] agent-type names for the wizard's first pick (injected in tests)
  listIdentityLayers = defaultListIdentityLayers, // () -> string[] identity-layer names for the custom branch's personality pick
  agentsDir = PROFILE_AGENTS_DIR,        // where the custom branch writes <name>.yaml (injected in tests)
  identitiesDir = PROFILE_IDENTITIES_DIR,// where the custom branch writes a free-text identity layer (injected in tests)
  io = {},                               // { stat, readFile, writeFile, mkdir } — real fs by default; /status probes files + the custom branch authors through here
  // CDP seam for /chrome, /tabs, /open, /tab, /close — the real localhost probe by
  // default; tests inject fakes so the suite never needs a live Chrome or a real socket.
  cdp = { isRunning: cdpIsRunning, listTabs: cdpListTabs, cdpHost: cdpHostOf, openTab: cdpOpenTab, activateTarget: cdpActivateTarget, closeTab: cdpCloseTab },
  // Room/member seams (Phase 2). roomForName builds a Room for a NamedRoom by name
  // (the real EGPT_HOME-rooted one by default); listRoomNames enumerates the saved
  // rooms; loadAdapters yields the web-brain adapters (config/brains/*-cdp.mjs). All
  // three are injected in tests so /rooms + /members run against temp-dir rooms and a
  // fake adapter list — no live profile, no live Chrome, no dynamic import.
  roomForName = (name) => Room.named(name),
  listRoomNames = defaultListRoomNames,
  loadAdapters = defaultLoadAdapters,
  // The conversation-room resolver (bug fix 2026-07-23): (surface, chatId) → the SAME Room the
  // phase-4 relay reads its members from. BOOT INJECTS the shared resolver (contacts.resolve →
  // Room.forChat — the IDENTICAL function boot's roomRelay.resolveMembers uses), so a member
  // added via /members lands in the exact conversations/<surface>/<slug>/config.yaml the relay
  // reads → an @<brain> on that conversation drives the relay. The default here is a read-only
  // fallback (getContact → the known chat's slug) for standalone construction; boot's injected
  // resolver is authoritative and is what guarantees write-here == read-there.
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
  onLog = () => {},
} = {}) {
  const cfg = () => getConfig() ?? {};
  const stat = io.stat ?? fsStat;
  const readFile = io.readFile ?? fsReadFile;
  const writeFile = io.writeFile ?? fsWriteFile;
  const mkdir = io.mkdir ?? fsMkdir;

  // The current NamedRoom, per surface (the shell, a Beeper Self-DM) — NamedRoom NAVIGATION
  // only now: /rooms marks it "(current)", /room <slug> leave clears it. It NO LONGER gates
  // /members (bug fix 2026-07-23: /members operates on the CURRENT CONVERSATION's room, the
  // room the relay reads — see resolveConvRoom). Kept in-memory; a fresh boot starts with none.
  const currentRoom = new Map();   // surface -> room slug
  const surfaceOf = (ev) => ev?.surface ?? 'whatsapp';
  const curRoomName = (ev) => currentRoom.get(surfaceOf(ev)) ?? null;

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
      if (!entry || typeof entry !== 'object' || !entry.account) { onLog(`beeper registry: "${name}" missing account — skipped`); continue; }
      out[name] = entry.account;
    }
    return out;
  })();

  // Armed `/e` wizards, keyed by the OPERATOR's chat (where they type the answers) —
  // NOT the target chat (bare `/e` targets here; `/e <slug>` targets elsewhere). Each
  // entry carries the resolved target + the engine its live warm session runs under
  // (for eviction on done) + the arming timestamp (TTL). See armWizard/stepWizard.
  const wizards = new Map();   // chatKey -> { state, surface, chatId, oldEngine, ts }
  const chatKey = (ev) => `${ev?.surface ?? 'whatsapp'}:${ev?.chatId}`;

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
  // The operator gate — reused by isCommand AND the wizard's first-refusal. Same
  // authorization every slash command uses: the origin surface's own Self DM (ids
  // are per-surface namespaces), an authorized sender, or the account owner (isSender).
  function isOperator(ev) {
    // Compare in short space (shortChatId is a no-op on an id that's already short) so a config
    // chat_id in either form still matches the bridge's now-always-short ev.chatId.
    const here = shortChatId(ev?.chatId);
    const inSelfDm = commandChatIds(ev?.surface ?? 'whatsapp').some((id) => shortChatId(id) === here);
    return inSelfDm || !!ev?.authorized || !!ev?.isSender;
  }

  // Is an un-expired `/e` wizard armed for this chat? Prunes an expired one (so an
  // abandoned wizard never lingers past its 5-min window).
  function wizardActive(ev) {
    const wm = wizards.get(chatKey(ev));
    if (!wm) return false;
    if (Date.now() - wm.ts > WIZARD_TTL_MS) { wizards.delete(chatKey(ev)); return false; }
    return true;
  }

  // Same id in any form counts as the Self DM (lid vs phone-form — a /restart
  // often arrives as the @lid self-jid). The Self DM is PER-SURFACE now (operator
  // 2026-07-02): a /restart typed in the telegram surface's own chat_id is checked
  // against cfg.telegram.chat_id, not whatsapp's — ids are per-surface namespaces.
  // Fall back to the whatsapp block when ev.surface is absent (safety). Authorized
  // senders (per-surface allowed_users / isSender) can command from anywhere.
  //
  // An ARMED `/e` wizard gets FIRST REFUSAL on the operator's next message (even a
  // plain, non-slash one — a numbered pick), so it doesn't fall through to E's brain
  // turn. A non-operator message never counts (it routes normally, never touching
  // the wizard). Slash commands while armed still count as commands and route through
  // run() (v1 lets a slash bypass the wizard without cancelling it — matched below).
  function isCommand(ev) {
    const body = String(ev?.body ?? '').trim();
    if (isOperator(ev) && wizardActive(ev)) return true;
    if (!body.startsWith('/')) return false;
    return isOperator(ev);
  }

  async function run(ev) {
    const line = String(ev.body ?? '').trim();

    // Armed `/e` wizard, first refusal: a PLAIN (non-slash) operator message is a
    // numbered/typed answer — step the wizard and stop (never reach E's brain). A
    // slash command falls through to normal dispatch (v1 bypass: the wizard stays
    // armed until answered, cancelled, or TTL-expired). isCommand only routes a plain
    // message here when a wizard is armed, so a bare return after stepping is safe.
    if (!line.startsWith('/')) { await stepWizard(ev, line); return; }

    const code = lifecycleExit(line, { writeRewindTarget });
    if (code != null) {
      onLog(`${line} -> exit ${code}`);
      await exit(code);                    // process leaves (after the bridge's "restarting…" announce); the daemon respawns
      return;
    }

    // /e auto <mode> [<target>] — set a conversation's E reply-mode (modes live in
    // conversations.yaml now). In a chat: omit <target> to set THIS chat. From the
    // Self DM: name the target chat (slug/name fragment, or its @jid / room-id).
    const auto = /^\/(?:e|egpt)\s+auto\s+(\S+)(?:\s+(.+?))?\s*$/i.exec(line);
    if (auto) {
      const mode = auto[1].toLowerCase();
      const targetTerm = auto[2]?.trim() || null;
      if (!isAutoMode(mode)) { await send?.(ev.chatId, `/e auto: unknown mode "${mode}" — use one of: ${AUTO_MODES.join(', ')}`); return; }
      if (!loadState || !writeState) { await send?.(ev.chatId, '/e auto: conversation state not wired'); return; }
      try {
        const state = await loadState();
        let jid = ev.chatId, where = 'here', targetSurface = ev.surface;
        if (targetTerm) {
          const r = resolveTarget(state, targetTerm, ev.surface);
          if (r.error) { await send?.(ev.chatId, `/e auto: ${r.error}`); return; }
          jid = r.jid; where = `for ${r.name}`; targetSurface = r.surface;
        }
        // The persona is a NESTED being keyed by defaultKey now (operator 2026-07-10) — write
        // its mode into that block (merged over the existing one), NOT a flat entry.mode, so
        // gating reads it back via getBeing(defaultKey).
        const prior = getContact(state, targetSurface, jid)?.entry?.[defaultKey] ?? {};
        await writeState(patchContact(state, targetSurface, jid, { [defaultKey]: { ...prior, mode } }));
        await send?.(ev.chatId, `✅ E mode ${where} → ${mode}`);
      } catch (e) { onLog(`/e auto ${ev.chatId}: ${e?.message ?? e}`); await send?.(ev.chatId, `/e auto: failed — ${e?.message ?? e}`); }
      return;
    }

    // /status [<target>] — bare: one compact ops line with live node health (unchanged
    // byte-for-byte). `/status <fragment>` targets a SPECIFIC conversation instead —
    // resolved EXACTLY like `/e auto <mode> <target>` (same resolveTarget) — and reports
    // that conversation's operator-facing facts (§ statusTarget). Every probe in both
    // forms is wrapped: any failure degrades to '?' so /status NEVER throws.
    const statusMatch = /^\/status(?:\s+(.+))?\s*$/i.exec(line);
    if (statusMatch) {
      const target = statusMatch[1]?.trim() || null;
      await send?.(ev.chatId, target ? await statusTarget(ev, target) : await status(ev));
      return;
    }

    // /chrome [<node>] — ATTACH-ONLY status of the local Chrome, answered ONLY by the
    // addressed node. Must stay BEFORE the catch-all at the end of this dispatch (it
    // answers ANY /token, so a fall-through would silently swallow /chrome) — that
    // ordering IS test-enforced: the /chrome tests assert its real reply, and they fail
    // the moment it reaches the catch-all instead. It does NOT interact with the /e
    // wizard below: /e's match is ANCHORED at ^/(e|egpt), so it can never match /chrome
    // (verified 2026-07-15 — an earlier comment here wrongly called /e "greedy").
    const chromeMatch = /^\/chrome(?:\s+(.+?))?\s*$/i.exec(line);
    if (chromeMatch) { await chrome(ev, chromeMatch[1]?.trim() || null); return; }

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

    // /rooms — Phase 2: list the saved NamedRooms (bare), or an ALIAS of /room <slug>
    // <sub> (`/rooms devwork join` == `/room devwork join`). Matched BEFORE /room: the
    // /room regex can't match "/rooms" (the trailing 's' is neither whitespace nor end),
    // but keeping /rooms first makes the alias intent explicit. Same pre-catch-all slot.
    const roomsMatch = /^\/rooms(?:\s+(\S+))?(?:\s+(.+?))?\s*$/i.exec(line);
    if (roomsMatch) {
      const slug = roomsMatch[1]?.toLowerCase() || null;
      if (!slug) { await send?.(ev.chatId, await roomsList(ev)); return; }
      await room(ev, slug, roomsMatch[2]?.trim() || null);   // alias: /rooms <slug> <sub>
      return;
    }

    // /room <sub> [<name>] — Phase 2 rooms & members. `create <name>` is the verb-first
    // create path (unchanged); every OTHER first token is a room SLUG and the second is
    // the sub-verb: `/room <slug> join|leave|members` (design grammar). Slots in exactly
    // like /chrome: a dispatch match BEFORE the anchored /e wizard and the catch-all.
    const roomMatch = /^\/room(?:\s+(\S+))?(?:\s+(.+?))?\s*$/i.exec(line);
    if (roomMatch) { await room(ev, roomMatch[1]?.toLowerCase() || null, roomMatch[2]?.trim() || null); return; }

    // /members … — the CURRENT room's roster. Bare: list. `add tab <n>`: adapter-match a
    // Chrome tab and add it as a disabled brain. `<id> mode <disable|mention|all>`: flip a
    // member's mode. Pre-catch-all so none leak to E. `/member` (singular) is accepted too
    // (operators type both) — same handler.
    const membersMatch = /^\/members?(?:\s+(.+?))?\s*$/i.exec(line);
    if (membersMatch) { await members(ev, membersMatch[1]?.trim() || null); return; }

    // /activate <id> — reopen a brain member whose Chrome tab was closed (its saved
    // targetId is no longer live), refreshing its targetId. A no-op when already live.
    const activateMatch = /^\/activate\s+(\S+)\s*$/i.exec(line);
    if (activateMatch) { await activate(ev, activateMatch[1]); return; }

    // /e (bare) or /e <fragment> — ARM the re-point wizard (v1 parity: a guided
    // agent-type/model/effort pick, not a flag command). Bare targets THIS chat; a
    // fragment resolves the target like /e auto does. `/e auto …` is matched above, so
    // it never reaches here. Must stay AFTER /e auto + /status in the dispatch order.
    const eWiz = /^\/(?:e|egpt)(?:\s+(.+?))?\s*$/i.exec(line);
    if (eWiz) { await armWizard(ev, eWiz[1]?.trim() || null); return; }

    const tok = line.split(/\s+/)[0];
    await send?.(ev.chatId, `${tok}: recognized — lifecycle (/restart, /upgrade, /rewind) + /e auto <mode> + /status are wired in v2 so far.`);
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

  // ─────────────────────────────────────────────────────────────────────────────
  // /room — the NamedRoom router (Phase 2). Two grammars share the verb: `create <name>`
  // is verb-first (create IS the first token); every OTHER first token is a room SLUG and
  // the second token is the sub-verb — `/room <slug> join|leave|members`. `/rooms` (list)
  // and `/rooms <slug> <sub>` (alias) route through here too.
  async function room(ev, first, rest) {
    if (!first) { await send?.(ev.chatId, 'usage: /room create <name> | /room <slug> join|leave|members'); return; }
    // Verb-first: `create <name>` keeps its original grammar (create IS the first token).
    if (first === 'create') { await roomCreate(ev, rest); return; }
    // Slug-first: `/room <slug> <sub>` — the first token is a room, the second a verb.
    // Bare `/room <slug>` (no verb) defaults to listing that room's members.
    const slug = sanitizeName(first);
    const sub = (rest || 'members').toLowerCase();
    if (sub === 'join') { await roomJoin(ev, slug); return; }
    if (sub === 'leave') { await roomLeave(ev, slug); return; }
    if (sub === 'members') { await send?.(ev.chatId, await renderMembers(ev, roomForName(slug), slug)); return; }
    await send?.(ev.chatId, `/room ${slug}: unknown subcommand "${sub}" — join|leave|members`);
  }

  // /room create <name> — CREATE a NamedRoom. A Room IS a folder (room-core.mjs): making
  // the folder tree at EGPT_HOME/rooms/<name>/ IS creating the room — the heartbeat +
  // transcription loaders (boot.mjs listEntityDirs) enumerate it from then on. Uses the
  // Room abstraction for the tree paths and the io seam for fs, so tests capture it
  // in-memory and it never touches a real profile.
  async function roomCreate(ev, name) {
    // A room NAME is operator-chosen; reject an empty/punctuation-only one (sanitizeName's
    // 'room' fallback would otherwise silently create a generic folder) before touching fs.
    if (!name || !/[a-z0-9]/i.test(name)) { await send?.(ev.chatId, 'usage: /room create <name>'); return; }
    const slug = sanitizeName(name);
    const r = Room.named(name);
    const rel = `rooms/${slug}/`;
    // Idempotent: an existing room folder is NEVER clobbered.
    try { await stat(r.baseDir()); await send?.(ev.chatId, `room ${slug} already exists at ${rel}`); return; }
    catch { /* absent → create below */ }
    // The folder IS the room: mkdir the standard tree (baseDir + the dir getters) + a
    // minimal config.yaml. No member roster — that's later work.
    for (const dir of [r.baseDir(), r.mediaDir, r.filesDir, r.identityDir]) await mkdir(dir, { recursive: true });
    await writeFile(r.configPath, roomConfigFile(slug), 'utf8');
    await send?.(ev.chatId, `room ${slug} created at ${rel}`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // /rooms — the saved NamedRooms, each with its member count, the current one marked.
  // Never throws (a missing rooms/ dir → "no rooms yet"; a per-room count that can't be
  // read degrades to 0).
  async function roomsList(ev) {
    const names = listRoomNames();
    if (!names.length) return 'no rooms yet — /room create <name> to make one';
    const cur = curRoomName(ev);
    const lines = ['rooms:'];
    for (const name of names) {
      let n = 0;
      try { n = (await roomForName(name).members()).length; } catch { n = 0; }
      lines.push(`  · ${name}   ${n} members${name === cur ? '   (current)' : ''}`);
    }
    return lines.join('\n');
  }

  // /room <slug> join — make <slug> the current room for this surface (what bare /members
  // targets). In-memory for Phase 2; a room folder materializes when its first member is
  // added (setMember mkdir's it) or via /room create.
  async function roomJoin(ev, slug) {
    currentRoom.set(surfaceOf(ev), slug);
    await send?.(ev.chatId, `joined '${slug}' — now current.`);
  }

  // /room <slug> leave — clear the current room for this surface iff it IS <slug>.
  async function roomLeave(ev, slug) {
    if (curRoomName(ev) === slug) { currentRoom.delete(surfaceOf(ev)); await send?.(ev.chatId, `left '${slug}' — no current room.`); return; }
    await send?.(ev.chatId, `not in '${slug}' — current room is ${curRoomName(ev) ? `'${curRoomName(ev)}'` : 'none'}`);
  }

  // The roster of `room` (a Room object) as a fenced yaml block, labelled by `label`: each
  // member's id, kind, live presence, and friendly mode. Presence for a brain member = its
  // saved targetId is a LIVE tab (from listTabs); a listTabs hiccup degrades every brain to
  // "inactive", never throws. Non-brain members read as "active" (a surface/chat member is
  // present as such). Shared by /members (the conversation room) and /room <slug> members (a
  // NamedRoom) — the caller passes the Room + its display label.
  async function renderMembers(ev, room, label) {
    let ms = [];
    try { ms = await room.members(); } catch { ms = []; }
    let liveIds = new Set();
    try { liveIds = new Set((await cdp.listTabs()).map((t) => t.id)); } catch { /* no Chrome → all brains inactive */ }
    const lines = [`${label} (${ms.length} members):`];
    for (const m of ms) {
      const mode = STATE_TO_MODE[m.state] ?? m.state;
      const presence = m.kind === 'brain' ? ((m.targetId && liveIds.has(m.targetId)) ? 'active' : 'inactive') : 'active';
      lines.push(`  · ${m.id}   ${m.kind}   ${presence}   mode:${mode}`);
    }
    if (!ms.length) lines.push('  (no members yet)');
    return '```yaml\n' + lines.join('\n') + '\n```';
  }

  // /members … — operate on the CURRENT CONVERSATION's room (bare = list; `add tab <n>`;
  // `<id> mode <m>`). A conversation IS a room (the model): resolveConvRoom yields the SAME Room
  // the phase-4 relay reads, so a member added here lands in the exact config.yaml resolveMembers
  // reads → an @<brain> on this conversation drives the relay. NO "/room <slug> join" gate — the
  // conversation you're in IS the room. (NamedRooms stay a separate explicit construct: /rooms +
  // /room <slug> members inspect/manage them; relay-wiring NamedRooms is a later phase.)
  async function members(ev, rest) {
    const room = await resolveConvRoom(surfaceOf(ev), ev.chatId);
    if (!room) { await send?.(ev.chatId, "can't resolve this conversation's room"); return; }
    const label = room.slug ?? 'this conversation';
    if (!rest) { await send?.(ev.chatId, await renderMembers(ev, room, label)); return; }
    const add = /^add\s+tab\s+(\d+)$/i.exec(rest);
    if (add) { await membersAddTab(ev, room, Number(add[1])); return; }
    const mode = /^(\S+)\s+mode\s+(\S+)$/i.exec(rest);
    if (mode) { await membersSetMode(ev, room, mode[1], mode[2]); return; }
    await send?.(ev.chatId, 'usage: /members | /members add tab <n> | /members <id> mode <disable|mention|all>');
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
  async function membersAddTab(ev, room, n) {
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
    if (same) {
      await room.setMember({ ...same, targetId: tab.id });
      const modeWord = STATE_TO_MODE[same.state] ?? same.state;
      await send?.(ev.chatId, `refreshed '${same.id}' (tab ${n}) — mode:${modeWord}`);
      return;
    }
    const taken = new Set(existing.map((m) => m.id));
    let id = base, i = 2;
    while (taken.has(id)) id = `${base}-${i++}`;
    await room.setMember({ kind: 'brain', id, state: 'muted', adapter: adapter.name, url: tab.url, targetId: tab.id });
    await send?.(ev.chatId, `added '${id}' (tab ${n} · adapter:${base}) — mode:disable (no chatter reaches it yet)`);
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

  // /activate <id> — a brain member is ACTIVE while its Chrome tab is open (a live
  // targetId). If Chrome closed it, reopen the saved url and refresh the targetId. A no-op
  // when the tab is already live. Presence is separate from mode: activating does NOT
  // change the member's mode.
  async function activate(ev, id) {
    const room = await resolveConvRoom(surfaceOf(ev), ev.chatId);
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

    // Heartbeat count = entries in the spine-written readonly view (tolerate absence).
    let hb = '?';
    try {
      const doc = YAML.parse(await readFile(join(EGPT_HOME, 'state', 'heartbeats.readonly.yaml'), 'utf8'));
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
    ];
    if (mode) lines.push(`mode: ${mode}`);
    // Registry + OBSERVABILITY only (never acted on) — name + account, NEVER the token.
    const beeperNames = Object.keys(beeperAccounts);
    if (beeperNames.length) {
      lines.push('beeper_accounts:');
      for (const name of beeperNames) lines.push(`  ${name}: ${beeperAccounts[name]}`);
    }
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
  // exactly like /e auto's (resolveTarget), one fenced yaml block reporting that
  // conversation's name/path/mode/agent/personality/thread/members. Every probe is
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

    // Instanced = this being took a first turn and froze a readonly brain (getBeing's
    // brainType is null until then, matching brainpool's own instanced check). Uninstanced:
    // preview what a first turn would actually pin, composed the same way brainpool's
    // fresh-turn path does — brains.resolve('egpt', …) + coerceAllowedTools + the
    // DETERMINISTIC_MODEL/EFFORT fallbacks — reusing exactly the exports commands.mjs
    // already reaches (brains, coerceAllowedTools, DETERMINISTIC_MODEL/EFFORT,
    // DEFAULT_ALLOWED_TOOLS). This does NOT replicate brainpool's private
    // persona-agent-configuration override lookup (agents.<e/egpt>.configuration is not
    // exported) — it previews the shipped 'egpt' type, which matches the skeleton default
    // and any profile that hasn't repointed the persona; an operator who HAS repointed it
    // sees the shipped default here until the first turn actually pins their override.
    const instanced = !!b?.brainType;
    let previewDef = null;
    if (!instanced) {
      try { previewDef = coerceAllowedTools(brains?.resolve?.('egpt', { convDir })); } catch { previewDef = null; }
    }

    // Personality: resolved the way the brainpool does — the agent TYPE file's
    // `personality:` field, else 'egpt' (brains registry, same layered resolution the
    // /e wizard's preview uses). Uninstanced: resolved from the same default preview above.
    let personality = '?';
    if (b?.agent) {
      try { const def = brains?.resolve?.(b.agent, { convDir }); personality = def ? (def.personality ?? 'egpt') : '?'; }
      catch { personality = '?'; }
    } else if (!instanced) {
      personality = previewDef?.personality ?? 'egpt';
    }

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
    // omitted when the readonly view is absent (matches bare /status's optional `mode`).
    let hb = null;
    try {
      const doc = YAML.parse(await readFile(join(EGPT_HOME, 'state', 'heartbeats.readonly.yaml'), 'utf8'));
      if (Array.isArray(doc?.heartbeats) && convDir) hb = doc.heartbeats.filter((h) => h?.source === convDir || h?.cwd === convDir).length;
    } catch { hb = null; }

    // Uninstanced fields fall back to the default preview computed above; instanced
    // fields are the exact expressions this rendered before (regression-lock: an
    // instanced conversation's output is unchanged byte-for-byte).
    const agentVal = instanced ? (b?.agent ?? '?') : (previewDef?.name ?? 'egpt');
    const engineVal = instanced ? (b?.brainType ?? '?') : (previewDef?.type ?? CCODE);
    const modelVal = instanced ? (b?.model ?? '?') : (previewDef?.model ?? DETERMINISTIC_MODEL);
    const effortVal = instanced ? (b?.effort ?? '?') : (previewDef?.effort ?? DETERMINISTIC_EFFORT);
    const toolsRaw = instanced ? b?.allowedTools : (previewDef?.allowed_tools ?? DEFAULT_ALLOWED_TOOLS);
    const toolsVal = Array.isArray(toolsRaw) ? `[${toolsRaw.join(', ')}]` : (toolsRaw ?? '?');

    const lines = [
      `name: ${displayName}`,
      `surface: ${r.surface}`,
      `slug: ${slug}`,
      `conversation_path: ${convPath}`,
      `mode: ${mode}`,
      // Marker: a single line rather than suffixing all six fields below — reads cleaner
      // in the fenced yaml and stays machine-checkable. Omitted when instanced (regression-lock).
      ...(instanced ? [] : ['instanced: false']),
      `agent: ${agentVal}`,
      `engine: ${engineVal}`,
      `model: ${modelVal}`,
      `effort: ${effortVal}`,
      `allowed_tools: ${toolsVal}`,
      `personality: ${personality}`,
      `thread_id: ${b?.threadId ?? 'not started'}`,
      `members: ${members}`,
    ];
    if (hb != null) lines.push(`heartbeats: ${hb}`);
    return '```yaml\n' + lines.join('\n') + '\n```';
  }

  // Arm the `/e` re-point wizard for the operator's chat. `targetTerm` null = THIS
  // chat; otherwise resolve it like /e auto's target (fuzzy slug/name, or a verbatim
  // @jid). Records the target's slug/jid + the engine its live warm session runs
  // under (so `done` can evict exactly that entry). Posts the first numbered prompt.
  async function armWizard(ev, targetTerm) {
    if (!loadState || !writeState) { await send?.(ev.chatId, '/e: conversation state not wired'); return; }
    const surface = ev.surface ?? 'whatsapp';   // search origin only; targetSurface (below) is the resolved TARGET (may differ, 2026-07-05)
    let state, jid, slug, displayName, targetSurface = surface;
    try {
      state = await loadState();
      if (targetTerm) {
        const r = resolveTarget(state, targetTerm, surface);
        if (r.error) { await send?.(ev.chatId, `/e: ${r.error}`); return; }
        jid = r.jid; targetSurface = r.surface;
      } else {
        jid = ev.chatId;
      }
      const c = getContact(state, targetSurface, jid);
      if (!c) { await send?.(ev.chatId, `/e: no chat matches "${targetTerm ?? 'this chat'}" — send a message there first`); return; }
      slug = c.slug; jid = c.jid;
      displayName = c.entry?.pushedName ?? slug;   // operator-facing label (slug carries a date suffix)
    } catch (e) { onLog(`/e arm ${ev.chatId}: ${e?.message ?? e}`); await send?.(ev.chatId, `/e: failed — ${e?.message ?? e}`); return; }

    // Offer only agent types that actually RESOLVE, each carrying its COMPOSITION
    // (model/effort/personality) so step 1 renders a structured-yaml preview. The
    // seeded example file (config/agents/sonnet-high.yaml) is all-comments → parses to
    // null, and a pickable option that then errors on `done` is a poor UX. Keep the raw
    // names only if resolution surprisingly drops everything (misconfig) so the operator
    // isn't stuck.
    let convDir = null; try { convDir = slugDir(targetSurface, slug); } catch { /* non-default surface */ }
    const names = listAgentTypes();
    let configurations = names.map((n) => ({ name: n }));   // fallback: bare names, no preview
    if (brains?.resolve) {
      const resolved = [];
      for (const n of names) {
        let def = null; try { def = brains.resolve(n, { convDir }); } catch { def = null; }
        if (def) resolved.push({ name: n, model: def.model ?? null, effort: def.effort ?? null, personality: def.personality ?? null });
      }
      if (resolved.length) configurations = resolved;
    }
    if (!configurations.length) { await send?.(ev.chatId, '/e: no agent types found (config/agents or src/brains)'); return; }
    // The custom branch's personality pick lists every identity layer (profile + repo);
    // a name colliding with any existing agent type re-prompts (takenNames).
    let personalities = [];
    try { personalities = listIdentityLayers(); } catch { personalities = []; }
    const takenNames = names.map((n) => String(n).toLowerCase());
    // The conversation's CURRENT instanced def marks the matching option `(current)`
    // and its frozen engine keys the warm entry to evict on done (null = never
    // instanced → fall back to the new def's engine at apply time).
    const cur = getBeing(state, targetSurface, jid, defaultKey);
    // The tools-branch "keep current" display: the live frozen list, coerced (a legacy
    // 'all' shows — and later freezes — as the explicit list, never perpetuated).
    const curTools = coerceAllowedTools({ allowed_tools: cur?.allowedTools ?? null })?.allowed_tools ?? null;
    const options = { configurations, models: WIZARD_MODELS, efforts: WIZARD_EFFORTS, personalities, takenNames };
    const current = { configurations: cur?.agent ?? null, models: cur?.model ?? null, efforts: cur?.effort ?? null, tools: curTools };
    const wstate = initWizard({ slug, jid, surface: targetSurface, options, current });
    wizards.set(chatKey(ev), { state: wstate, surface: targetSurface, chatId: ev.chatId, oldEngine: cur?.brainType ?? null, ts: Date.now() });
    await send?.(ev.chatId, `🧩 reconfigure «${displayName}»\n${wizardPrompt(wstate)}`);
  }

  // Feed a plain operator message into the armed wizard. Returns true when consumed
  // (cancel/back/step/done), false when nothing was armed (or it just expired). Only
  // reached for a non-slash operator message that isCommand already gated on.
  async function stepWizard(ev, text) {
    const key = chatKey(ev);
    const wm = wizards.get(key);
    if (!wm) return false;
    if (Date.now() - wm.ts > WIZARD_TTL_MS) { wizards.delete(key); return false; }
    const r = wizardStep(wm.state, text);
    if (r.cancelled) { wizards.delete(key); await send?.(ev.chatId, '(wizard cancelled)'); return true; }
    if (r.done) { wizards.delete(key); await applyWizard(wm, r.result); return true; }
    wm.state = r.state; wm.ts = Date.now();
    await send?.(ev.chatId, r.prompt);
    return true;
  }

  // On done: freeze the picked agent type/model/effort into the TARGET conversation's
  // readonly block (same shape the brainpool instances — keeps the existing threadId,
  // so context survives the re-point), then evict its warm session so the next turn
  // respawns with the new def. Reply terse + factual, /status house style. The `custom`
  // branch first AUTHORS the new type (+ any free-text identity layer), then applies it.
  async function applyWizard(wm, result) {
    if (result.custom) return applyCustomWizard(wm, result);
    if (result.toolsOnly) return applyToolsWizard(wm, result);
    const { surface, jid } = result;
    try {
      const state = await loadState();
      const c = getContact(state, surface, jid);
      const slug = c?.slug ?? result.slug;
      const displayName = c?.entry?.pushedName ?? slug;
      let convDir = null;
      try { convDir = slugDir(surface, slug); } catch { /* non-default surface — resolve without a conv layer */ }
      // 'all'/'*' is REJECTED (operator 2026-07-03) — a hand-written type file that
      // still says it is coerced to the explicit default list before freezing, same as
      // the brainpool's own turn (never a duplicate check — the one chokepoint).
      const def = coerceAllowedTools(brains?.resolve?.(result.configuration, { convDir }));
      if (!def) { await send?.(wm.chatId, `/e: agent type "${result.configuration}" not found`); return; }
      const engine = def.type ?? CCODE;
      // Picking an existing type IS the answer (operator 2026-07-03): apply with the type's
      // PINNED model/effort — no separate model/effort steps — falling back to the
      // deterministic floor when the type omits them (matching the brainpool's freeze).
      const model = result.model ?? def.model ?? DETERMINISTIC_MODEL;
      const effort = result.effort ?? def.effort ?? DETERMINISTIC_EFFORT;
      // Freeze into the persona's NESTED block (operator 2026-07-10 — keyed by defaultKey,
      // merged over the existing block so threadId/mode survive the re-point).
      const prior = c?.entry?.[defaultKey] ?? {};
      await writeState(patchContact(state, surface, jid, {
        [defaultKey]: { ...prior, readonly: { agent: def.name ?? result.configuration, type: engine, model, effort, allowed_tools: def.allowed_tools ?? DEFAULT_ALLOWED_TOOLS } },
      }));
      // The live warm session runs under the OLD engine (or the new one on a never-instanced
      // conversation); the pool keys it `<defaultKey>:<engine>:<surface>:<slug>`.
      evictWarm(`${defaultKey}:${wm.oldEngine ?? engine}:${surface}:${slug}`);
      await send?.(wm.chatId, `✅ «${displayName}» → ${def.name ?? result.configuration} · ${model}/${effort} (respawns next turn)`);
    } catch (e) { onLog(`/e wizard ${wm.chatId}: ${e?.message ?? e}`); await send?.(wm.chatId, `/e: failed — ${e?.message ?? e}`); }
  }

  // The `custom` branch: BUILD a new agent type. Write a free-text identity layer (when
  // the operator described one — named after the type), then the agent-type file, then
  // apply it to the conversation EXACTLY like an existing-type pick (freeze readonly,
  // keep threadId, evict warm). result.name is already sanitized by the wizard.
  async function applyCustomWizard(wm, result) {
    const { surface, jid } = result;
    try {
      const name = result.name;
      if (!name) { await send?.(wm.chatId, '/e: invalid type name'); return; }
      // Personality: a chosen existing layer, or a new layer authored from free text
      // (named after the type so it travels with it).
      let personality = result.personalityLayer || 'egpt';
      if (result.personalityText) {
        personality = name;
        const layerFile = join(identitiesDir, `${name}.md`);   // FLAT identity file (operator 2026-07-03)
        await mkdir(dirname(layerFile), { recursive: true });
        await writeFile(layerFile, identityLayerFile(result.personalityText), 'utf8');
      }
      const typeFile = join(agentsDir, `${name}.yaml`);
      await mkdir(dirname(typeFile), { recursive: true });
      await writeFile(typeFile, customTypeFile(name, result.model, result.effort, personality), 'utf8');

      const state = await loadState();
      const c = getContact(state, surface, jid);
      const slug = c?.slug ?? result.slug;
      const displayName = c?.entry?.pushedName ?? slug;
      const prior = c?.entry?.[defaultKey] ?? {};
      await writeState(patchContact(state, surface, jid, {
        [defaultKey]: { ...prior, readonly: { agent: name, type: CCODE, model: result.model, effort: result.effort, allowed_tools: DEFAULT_ALLOWED_TOOLS } },
      }));
      evictWarm(`${defaultKey}:${wm.oldEngine ?? CCODE}:${surface}:${slug}`);
      await send?.(wm.chatId, `✅ «${displayName}» → ${name} · ${result.model}/${result.effort} (new type created, respawns next turn)`);
    } catch (e) { onLog(`/e wizard custom ${wm.chatId}: ${e?.message ?? e}`); await send?.(wm.chatId, `/e: failed — ${e?.message ?? e}`); }
  }

  // The `tools` branch: edit ONLY allowed_tools, keeping the conversation's current
  // agent/type/model/effort exactly as they are (readonly is written WHOLE — patchContact
  // replaces the key — so every other field is re-read fresh here, not the arm-time
  // snapshot, and carried forward unchanged). 'current' is resolved fresh + coerced, so a
  // legacy frozen 'all' is never re-frozen — it self-heals to the explicit list here too.
  async function applyToolsWizard(wm, result) {
    const { surface, jid } = result;
    try {
      const state = await loadState();
      const c = getContact(state, surface, jid);
      const slug = c?.slug ?? result.slug;
      const displayName = c?.entry?.pushedName ?? slug;
      const cur = getBeing(state, surface, jid, defaultKey);
      let tools;
      if (result.tools === 'default') tools = DEFAULT_ALLOWED_TOOLS;
      else if (result.tools === 'readonly') tools = READONLY_ALLOWED_TOOLS;
      else if (result.tools === 'custom') tools = result.toolsCustom?.length ? result.toolsCustom : DEFAULT_ALLOWED_TOOLS;
      else tools = coerceAllowedTools({ allowed_tools: cur?.allowedTools ?? null })?.allowed_tools ?? DEFAULT_ALLOWED_TOOLS;   // 'current'
      const engine = cur?.brainType ?? wm.oldEngine ?? CCODE;
      const prior = c?.entry?.[defaultKey] ?? {};
      await writeState(patchContact(state, surface, jid, {
        [defaultKey]: {
          ...prior,
          readonly: {
            agent: cur?.agent ?? 'egpt',
            type: engine,
            model: cur?.model ?? DETERMINISTIC_MODEL,
            effort: cur?.effort ?? DETERMINISTIC_EFFORT,
            allowed_tools: tools,
          },
        },
      }));
      evictWarm(`${defaultKey}:${wm.oldEngine ?? engine}:${surface}:${slug}`);
      await send?.(wm.chatId, `✅ «${displayName}» tools → [${tools.join(', ')}] (respawns next turn)`);
    } catch (e) { onLog(`/e wizard tools ${wm.chatId}: ${e?.message ?? e}`); await send?.(wm.chatId, `/e: failed — ${e?.message ?? e}`); }
  }

  return { isCommand, run };
}
